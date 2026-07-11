#!/usr/bin/env python3
"""OpenStill Desktop: local SQLite dashboard and Chrome Native Messaging host.

This module intentionally uses only Python's standard library.  Run it normally
to serve the local dashboard, or run it with ``--native-host`` from Chrome's
native-host manifest.  The two processes share one SQLite database in WAL mode.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import ctypes
import hmac
import json
import os
import secrets
import sqlite3
import sys
import threading
import uuid
import webbrowser
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from ctypes import wintypes


PROTOCOL = "openstill.desktop/v1"
STATE_FORMAT = "openstill-desktop-state"
STATE_SCHEMA_VERSION = 1
HOST_NAME = "com.openstill.desktop"
MAX_FRAME_BYTES = 1_000_000
MAX_HTTP_BYTES = 1_000_000
MIN_INTERVAL_SECONDS = 60 * 60
MAX_INTERVAL_SECONDS = 14 * 24 * 60 * 60
MAX_MONITORS = 1_000
MAX_SELECTORS = 20
MAX_SELECTOR_CHARS = 2_000
MAX_TEXT_CHARS = 10_000
DEFAULT_PROFILE_ID = "default"


class DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]


CRYPTPROTECT_UI_FORBIDDEN = 0x1


def _make_blob(data: bytes) -> tuple[DATA_BLOB, Any]:
    buffer = ctypes.create_string_buffer(data)
    return DATA_BLOB(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte))), buffer


def _dpapi(operation: str, value: bytes) -> bytes:
    """Encrypt/decrypt bytes for the current Windows user with DPAPI."""
    if os.name != "nt":
        raise RuntimeError("OpenStill Desktop requires Windows DPAPI for local data protection")
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    blob_pointer = ctypes.POINTER(DATA_BLOB)
    crypt32.CryptProtectData.argtypes = [blob_pointer, wintypes.LPCWSTR, blob_pointer, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, blob_pointer]
    crypt32.CryptProtectData.restype = wintypes.BOOL
    crypt32.CryptUnprotectData.argtypes = [blob_pointer, ctypes.POINTER(wintypes.LPWSTR), blob_pointer, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, blob_pointer]
    crypt32.CryptUnprotectData.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    input_blob, input_buffer = _make_blob(value)
    output_blob = DATA_BLOB()
    if operation == "protect":
        success = crypt32.CryptProtectData(
            ctypes.byref(input_blob), None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(output_blob)
        )
    else:
        success = crypt32.CryptUnprotectData(
            ctypes.byref(input_blob), None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(output_blob)
        )
    # Keep input_buffer alive through the Windows API call.
    del input_buffer
    if not success:
        raise OSError(ctypes.get_last_error(), f"Windows DPAPI {operation} failed")
    try:
        return ctypes.string_at(output_blob.pbData, output_blob.cbData)
    finally:
        if output_blob.pbData:
            kernel32.LocalFree(output_blob.pbData)


def protect_text(value: str) -> str:
    return "dpapi:" + base64.b64encode(_dpapi("protect", value.encode("utf-8"))).decode("ascii")


def unprotect_text(value: str) -> str:
    if not isinstance(value, str) or not value.startswith("dpapi:"):
        return value
    try:
        return _dpapi("unprotect", base64.b64decode(value[6:], validate=True)).decode("utf-8")
    except Exception as error:
        raise ValidationError("could not decrypt same-user local data") from error


class ValidationError(ValueError):
    """Raised when an untrusted dashboard/native message is not valid."""


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_now() -> str:
    return utc_now().isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_iso(value: Any, fallback: datetime | None = None) -> datetime:
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc)
        except ValueError:
            pass
    return fallback or utc_now()


def iso_from(value: Any, fallback: datetime | None = None) -> str:
    return parse_iso(value, fallback).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def text(value: Any, maximum: int, field: str, *, required: bool = False) -> str:
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ValidationError(f"{field} must be text")
    cleaned = " ".join(value.split()).strip()
    if required and not cleaned:
        raise ValidationError(f"{field} is required")
    if len(cleaned) > maximum:
        raise ValidationError(f"{field} is too long")
    return cleaned


def identifier(value: Any, field: str) -> str:
    candidate = text(value, 100, field, required=True)
    if any(character.isspace() for character in candidate):
        raise ValidationError(f"{field} cannot contain whitespace")
    return candidate


def http_url(value: Any) -> str:
    candidate = text(value, 8_000, "url", required=True)
    parsed = urlparse(candidate)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password:
        raise ValidationError("url must be an HTTP or HTTPS URL without credentials")
    return parsed._replace(fragment="").geturl()


def labels(value: Any) -> list[str]:
    source = value if isinstance(value, list) else str(value or "").split(",")
    result: list[str] = []
    seen: set[str] = set()
    for item in source:
        label = text(item, 48, "label")
        key = label.casefold()
        if label and key not in seen:
            result.append(label)
            seen.add(key)
        if len(result) >= 20:
            break
    return result


def selectors(value: Any) -> list[str]:
    if not isinstance(value, list) or not value or len(value) > MAX_SELECTORS:
        raise ValidationError("selectors must contain between 1 and 20 entries")
    result: list[str] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, str):
            raise ValidationError("selector must be text")
        # CSS attribute values and escaped strings can contain meaningful
        # whitespace, so only trim the outer edge; do not normalize its body.
        selector = item.strip()
        if not selector or len(selector) > MAX_SELECTOR_CHARS:
            raise ValidationError("selector is empty or too long")
        if selector not in seen:
            result.append(selector)
            seen.add(selector)
    if not result:
        raise ValidationError("selectors must contain a value")
    return result


def interval_seconds(value: Any, fallback: int = MIN_INTERVAL_SECONDS) -> int:
    if value is None:
        return fallback
    try:
        numeric = int(value)
    except (TypeError, ValueError) as error:
        raise ValidationError("interval_seconds must be an integer") from error
    if not MIN_INTERVAL_SECONDS <= numeric <= MAX_INTERVAL_SECONDS:
        raise ValidationError("interval_seconds must be between 1 hour and 14 days")
    return numeric


def normalize_snapshot(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValidationError("snapshot must be an object")
    raw_items = value.get("items") if isinstance(value.get("items"), list) else []
    items: list[dict[str, str]] = []
    for raw in raw_items[:200]:
        raw_text = raw if isinstance(raw, str) else raw.get("text", "") if isinstance(raw, dict) else ""
        if not isinstance(raw_text, str):
            raise ValidationError("snapshot text must be text")
        cleaned = raw_text.replace("\r\n", "\n").replace("\r", "\n").strip()[:MAX_TEXT_CHARS]
        if cleaned:
            items.append({"text": cleaned})
    raw_text = value.get("text", "")
    if raw_text is not None and not isinstance(raw_text, str):
        raise ValidationError("snapshot text must be text")
    snapshot_text = raw_text.replace("\r\n", "\n").replace("\r", "\n").strip()[:MAX_TEXT_CHARS] if raw_text is not None else ""
    if not snapshot_text and items:
        snapshot_text = "\n\n".join(item["text"] for item in items)[:MAX_TEXT_CHARS]
    exists = bool(value.get("exists", bool(snapshot_text))) and bool(snapshot_text)
    return {
        "exists": exists,
        "matchCount": int(value.get("matchCount", len(items))) if exists else 0,
        "items": items if exists else [],
        "text": snapshot_text if exists else "",
        "capturedAt": iso_from(value.get("capturedAt")),
    }


def normalize_monitor(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValidationError("monitor must be an object")
    monitor_id = identifier(value.get("id") or str(uuid.uuid4()), "monitor.id")
    url = http_url(value.get("url"))
    return {
        "id": monitor_id,
        "revision": text(value.get("revision") or str(uuid.uuid4()), 100, "monitor.revision", required=True),
        "name": text(value.get("name") or urlparse(url).hostname or url, 120, "monitor.name", required=True),
        "url": url,
        "pageTitle": text(value.get("pageTitle", ""), 180, "monitor.pageTitle"),
        "selectors": selectors(value.get("selectors")),
        "labels": labels(value.get("labels", [])),
        "enabled": value.get("enabled") is not False,
        "createdAt": iso_from(value.get("createdAt")),
        "updatedAt": iso_from(value.get("updatedAt")),
    }


def normalize_schedule(value: Any, monitor_id: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        value = {}
    raw_interval = value.get("interval_seconds")
    if raw_interval is None:
        raw_interval = value.get("intervalSeconds")
    if raw_interval is None and value.get("intervalHours") is not None:
        raw_interval = int(value["intervalHours"]) * 60 * 60
    return {
        "id": identifier(value.get("id") or f"schedule:{monitor_id}", "schedule.id"),
        "monitor_id": monitor_id,
        "interval_seconds": interval_seconds(raw_interval),
        "next_run_at": iso_from(value.get("next_run_at") or value.get("nextRunAt") or value.get("nextCheckAt")),
        "enabled": value.get("enabled") is not False,
        "updated_at": iso_from(value.get("updated_at") or value.get("updatedAt")),
    }


def normalize_result(value: Any, monitor_id: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        value = {}
    last_change = value.get("last_change") or value.get("lastChange")
    if last_change is not None and not isinstance(last_change, dict):
        raise ValidationError("result.last_change must be an object")
    normalized_change = None
    if isinstance(last_change, dict):
        normalized_change = {
            "previous": normalize_snapshot(last_change.get("previous")),
            "current": normalize_snapshot(last_change.get("current")),
            "detectedAt": iso_from(last_change.get("detectedAt")),
        }
    return {
        "monitor_id": monitor_id,
        "snapshot": normalize_snapshot(value.get("snapshot")),
        "last_change": normalized_change,
        "last_checked_at": iso_from(value.get("last_checked_at") or value.get("lastCheckedAt")),
        "last_changed_at": iso_from(value.get("last_changed_at") or value.get("lastChangedAt")),
        "last_review_at": iso_from(value.get("last_review_at") or value.get("lastReviewAt")) if value.get("last_review_at") or value.get("lastReviewAt") else None,
        "status": text(value.get("status", "needs-baseline"), 40, "result.status", required=True),
        "unread": bool(value.get("unread", False)),
        "last_error": text(value.get("last_error") or value.get("lastError") or "", 300, "result.last_error") or None,
    }


def empty_state() -> dict[str, Any]:
    return {
        "format": STATE_FORMAT,
        "schema_version": STATE_SCHEMA_VERSION,
        "monitors": [],
        "schedules": [],
        "results": [],
    }


def state_from_document(document: Any) -> dict[str, Any]:
    """Convert Desktop state, legacy export, or picker draft to Desktop state."""
    if not isinstance(document, dict):
        raise ValidationError("import must be a JSON object")
    if document.get("format") == "openstill-selector-draft" and document.get("schemaVersion") == 1:
        monitor = normalize_monitor({"id": str(uuid.uuid4()), **(document.get("monitor") or {})})
        interval_hours = (document.get("monitor") or {}).get("intervalHours", 1)
        schedule = normalize_schedule({"intervalHours": interval_hours}, monitor["id"])
        return {**empty_state(), "monitors": [monitor], "schedules": [schedule]}

    if document.get("format") == "openstill-export" and document.get("schemaVersion") == 2:
        monitors: list[dict[str, Any]] = []
        schedules: list[dict[str, Any]] = []
        results: list[dict[str, Any]] = []
        for legacy in document.get("monitors", []):
            monitor = normalize_monitor(legacy)
            monitors.append(monitor)
            schedules.append(normalize_schedule(legacy, monitor["id"]))
            results.append(normalize_result(legacy, monitor["id"]))
        return {**empty_state(), "monitors": monitors, "schedules": schedules, "results": results}

    if document.get("format") != STATE_FORMAT or document.get("schema_version") != STATE_SCHEMA_VERSION:
        raise ValidationError("unsupported import format")
    raw_monitors = document.get("monitors")
    if not isinstance(raw_monitors, list) or len(raw_monitors) > MAX_MONITORS:
        raise ValidationError("state.monitors must contain at most 1,000 entries")
    monitors = [normalize_monitor(item) for item in raw_monitors]
    monitor_ids = {monitor["id"] for monitor in monitors}
    if len(monitor_ids) != len(monitors):
        raise ValidationError("monitor IDs must be unique")

    raw_schedules = document.get("schedules", [])
    if not isinstance(raw_schedules, list):
        raise ValidationError("state.schedules must be a list")
    schedules: list[dict[str, Any]] = []
    scheduled_monitor_ids: set[str] = set()
    for item in raw_schedules:
        if not isinstance(item, dict):
            raise ValidationError("schedule must be an object")
        monitor_id = identifier(item.get("monitor_id") or item.get("monitorId"), "schedule.monitor_id")
        if monitor_id not in monitor_ids or monitor_id in scheduled_monitor_ids:
            raise ValidationError("each schedule must belong to one known monitor")
        schedules.append(normalize_schedule(item, monitor_id))
        scheduled_monitor_ids.add(monitor_id)
    for monitor in monitors:
        if monitor["id"] not in scheduled_monitor_ids:
            schedules.append(normalize_schedule({}, monitor["id"]))

    raw_results = document.get("results", [])
    if not isinstance(raw_results, list):
        raise ValidationError("state.results must be a list")
    results: list[dict[str, Any]] = []
    result_monitor_ids: set[str] = set()
    for item in raw_results:
        if not isinstance(item, dict):
            raise ValidationError("result must be an object")
        monitor_id = identifier(item.get("monitor_id") or item.get("monitorId"), "result.monitor_id")
        if monitor_id not in monitor_ids or monitor_id in result_monitor_ids:
            raise ValidationError("each result must belong to one known monitor")
        results.append(normalize_result(item, monitor_id))
        result_monitor_ids.add(monitor_id)
    return {**empty_state(), "monitors": monitors, "schedules": schedules, "results": results}


class Store:
    def __init__(self, database_path: Path):
        database_path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(database_path, check_same_thread=False)
        self.connection.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        with self.connection:
            self.connection.execute("PRAGMA journal_mode=WAL")
            self.connection.execute("PRAGMA foreign_keys=ON")
        self._create_schema()

    def _create_schema(self) -> None:
        with self.connection:
            self.connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS profiles (
                  profile_id TEXT PRIMARY KEY,
                  revision INTEGER NOT NULL DEFAULT 0,
                  updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS monitors (
                  profile_id TEXT NOT NULL,
                  id TEXT NOT NULL,
                  payload TEXT NOT NULL,
                  PRIMARY KEY(profile_id, id),
                  FOREIGN KEY(profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS schedules (
                  profile_id TEXT NOT NULL,
                  id TEXT NOT NULL,
                  monitor_id TEXT NOT NULL,
                  next_run_at TEXT NOT NULL,
                  enabled INTEGER NOT NULL,
                  payload TEXT NOT NULL,
                  PRIMARY KEY(profile_id, id),
                  UNIQUE(profile_id, monitor_id),
                  FOREIGN KEY(profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS results (
                  profile_id TEXT NOT NULL,
                  monitor_id TEXT NOT NULL,
                  payload TEXT NOT NULL,
                  PRIMARY KEY(profile_id, monitor_id),
                  FOREIGN KEY(profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS leases (
                  profile_id TEXT NOT NULL,
                  lease_id TEXT NOT NULL,
                  monitor_id TEXT NOT NULL,
                  schedule_id TEXT NOT NULL,
                  expires_at TEXT NOT NULL,
                  PRIMARY KEY(profile_id, lease_id),
                  UNIQUE(profile_id, monitor_id),
                  FOREIGN KEY(profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
                );
                """
            )

    def _json(self, value: Any) -> str:
        # SQLite keeps indexes such as next_run_at separately for scheduling,
        # but every monitor/result payload (including website content) is bound
        # to the current Windows user with DPAPI before it reaches disk.
        return protect_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")))

    def _decode(self, row: sqlite3.Row, field: str = "payload") -> dict[str, Any]:
        return json.loads(unprotect_text(row[field]))

    def _ensure_profile(self, profile_id: str) -> None:
        self.connection.execute(
            "INSERT OR IGNORE INTO profiles(profile_id, revision, updated_at) VALUES (?, 0, ?)",
            (profile_id, iso_now()),
        )

    def _touch(self, profile_id: str) -> int:
        self.connection.execute(
            "UPDATE profiles SET revision = revision + 1, updated_at = ? WHERE profile_id = ?",
            (iso_now(), profile_id),
        )
        row = self.connection.execute("SELECT revision FROM profiles WHERE profile_id = ?", (profile_id,)).fetchone()
        return int(row["revision"])

    def state(self, profile_id: str = DEFAULT_PROFILE_ID) -> tuple[dict[str, Any], int]:
        profile_id = identifier(profile_id, "profile_id")
        with self.lock, self.connection:
            self._ensure_profile(profile_id)
            profile = self.connection.execute("SELECT revision FROM profiles WHERE profile_id = ?", (profile_id,)).fetchone()
            monitors = [self._decode(row) for row in self.connection.execute(
                "SELECT payload FROM monitors WHERE profile_id = ? ORDER BY id", (profile_id,)
            )]
            schedules = [self._decode(row) for row in self.connection.execute(
                "SELECT payload FROM schedules WHERE profile_id = ? ORDER BY monitor_id", (profile_id,)
            )]
            results = [self._decode(row) for row in self.connection.execute(
                "SELECT payload FROM results WHERE profile_id = ? ORDER BY monitor_id", (profile_id,)
            )]
            return ({**empty_state(), "monitors": monitors, "schedules": schedules, "results": results}, int(profile["revision"]))

    def replace_state(self, profile_id: str, document: Any) -> tuple[dict[str, Any], int]:
        profile_id = identifier(profile_id, "profile_id")
        state = state_from_document(document)
        with self.lock, self.connection:
            self._ensure_profile(profile_id)
            for table in ("leases", "results", "schedules", "monitors"):
                self.connection.execute(f"DELETE FROM {table} WHERE profile_id = ?", (profile_id,))
            for monitor in state["monitors"]:
                self.connection.execute(
                    "INSERT INTO monitors(profile_id, id, payload) VALUES (?, ?, ?)",
                    (profile_id, monitor["id"], self._json(monitor)),
                )
            for schedule in state["schedules"]:
                self.connection.execute(
                    "INSERT INTO schedules(profile_id, id, monitor_id, next_run_at, enabled, payload) VALUES (?, ?, ?, ?, ?, ?)",
                    (profile_id, schedule["id"], schedule["monitor_id"], schedule["next_run_at"], int(schedule["enabled"]), self._json(schedule)),
                )
            for result in state["results"]:
                self.connection.execute(
                    "INSERT INTO results(profile_id, monitor_id, payload) VALUES (?, ?, ?)",
                    (profile_id, result["monitor_id"], self._json(result)),
                )
            revision = self._touch(profile_id)
        return state, revision

    def merge_import(self, profile_id: str, document: Any) -> tuple[dict[str, Any], int]:
        incoming = state_from_document(document)
        current, _ = self.state(profile_id)
        monitors = {monitor["id"]: monitor for monitor in current["monitors"]}
        schedules = {schedule["monitor_id"]: schedule for schedule in current["schedules"]}
        results = {result["monitor_id"]: result for result in current["results"]}
        for monitor in incoming["monitors"]:
            monitors[monitor["id"]] = monitor
        for schedule in incoming["schedules"]:
            schedules[schedule["monitor_id"]] = schedule
        for result in incoming["results"]:
            results[result["monitor_id"]] = result
        combined = {
            **empty_state(),
            "monitors": list(monitors.values())[:MAX_MONITORS],
            "schedules": list(schedules.values()),
            "results": list(results.values()),
        }
        return self.replace_state(profile_id, combined)

    def upsert_monitor(self, profile_id: str, raw_monitor: Any, raw_schedule: Any | None = None) -> tuple[dict[str, Any], dict[str, Any], int]:
        monitor = normalize_monitor(raw_monitor)
        schedule = normalize_schedule(raw_schedule or {}, monitor["id"])
        with self.lock, self.connection:
            self._ensure_profile(profile_id)
            self.connection.execute(
                "INSERT INTO monitors(profile_id, id, payload) VALUES (?, ?, ?) "
                "ON CONFLICT(profile_id, id) DO UPDATE SET payload = excluded.payload",
                (profile_id, monitor["id"], self._json(monitor)),
            )
            self.connection.execute(
                "INSERT INTO schedules(profile_id, id, monitor_id, next_run_at, enabled, payload) VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(profile_id, monitor_id) DO UPDATE SET id = excluded.id, next_run_at = excluded.next_run_at, enabled = excluded.enabled, payload = excluded.payload",
                (profile_id, schedule["id"], monitor["id"], schedule["next_run_at"], int(schedule["enabled"]), self._json(schedule)),
            )
            revision = self._touch(profile_id)
        return monitor, schedule, revision

    def delete_monitor(self, profile_id: str, monitor_id: Any) -> tuple[bool, int]:
        monitor_id = identifier(monitor_id, "monitor_id")
        with self.lock, self.connection:
            self._ensure_profile(profile_id)
            deleted = self.connection.execute(
                "DELETE FROM monitors WHERE profile_id = ? AND id = ?", (profile_id, monitor_id)
            ).rowcount > 0
            self.connection.execute("DELETE FROM schedules WHERE profile_id = ? AND monitor_id = ?", (profile_id, monitor_id))
            self.connection.execute("DELETE FROM results WHERE profile_id = ? AND monitor_id = ?", (profile_id, monitor_id))
            self.connection.execute("DELETE FROM leases WHERE profile_id = ? AND monitor_id = ?", (profile_id, monitor_id))
            revision = self._touch(profile_id) if deleted else self.state(profile_id)[1]
        return deleted, revision

    def due_jobs(self, profile_id: str, *, limit: int = 3, lease_seconds: int = 120, now: Any = None) -> tuple[list[dict[str, Any]], int]:
        limit = min(max(int(limit), 1), 500)
        lease_seconds = min(max(int(lease_seconds), 30), 3600)
        current_time = parse_iso(now)
        now_iso = current_time.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        expires_at = (current_time + timedelta(seconds=lease_seconds)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        with self.lock, self.connection:
            self._ensure_profile(profile_id)
            self.connection.execute("DELETE FROM leases WHERE profile_id = ? AND expires_at <= ?", (profile_id, now_iso))
            rows = self.connection.execute(
                "SELECT schedules.id AS schedule_id, schedules.monitor_id, schedules.payload AS schedule_payload, monitors.payload AS monitor_payload "
                "FROM schedules JOIN monitors ON monitors.profile_id = schedules.profile_id AND monitors.id = schedules.monitor_id "
                "LEFT JOIN leases ON leases.profile_id = schedules.profile_id AND leases.monitor_id = schedules.monitor_id "
                "WHERE schedules.profile_id = ? AND schedules.enabled = 1 AND leases.lease_id IS NULL AND schedules.next_run_at <= ? "
                "ORDER BY schedules.next_run_at LIMIT ?",
                (profile_id, now_iso, limit),
            ).fetchall()
            jobs: list[dict[str, Any]] = []
            for row in rows:
                monitor = json.loads(unprotect_text(row["monitor_payload"]))
                if not monitor.get("enabled", True):
                    continue
                lease_id = str(uuid.uuid4())
                self.connection.execute(
                    "INSERT INTO leases(profile_id, lease_id, monitor_id, schedule_id, expires_at) VALUES (?, ?, ?, ?, ?)",
                    (profile_id, lease_id, row["monitor_id"], row["schedule_id"], expires_at),
                )
                jobs.append({
                    "monitor": monitor,
                    "schedule": json.loads(unprotect_text(row["schedule_payload"])),
                    "lease_id": lease_id,
                })
            revision_row = self.connection.execute("SELECT revision FROM profiles WHERE profile_id = ?", (profile_id,)).fetchone()
        return jobs, int(revision_row["revision"])

    def check_result(self, profile_id: str, payload: Any) -> tuple[dict[str, Any], dict[str, Any], int]:
        if not isinstance(payload, dict):
            raise ValidationError("check-result payload must be an object")
        monitor_id = identifier(payload.get("monitor_id") or payload.get("monitorId"), "monitor_id")
        schedule_id = identifier(payload.get("schedule_id") or payload.get("scheduleId"), "schedule_id")
        lease_id = identifier(payload.get("lease_id") or payload.get("leaseId"), "lease_id")
        raw_result = payload.get("result")
        if not isinstance(raw_result, dict):
            raise ValidationError("result must be an object")
        with self.lock, self.connection:
            lease = self.connection.execute(
                "SELECT * FROM leases WHERE profile_id = ? AND lease_id = ? AND monitor_id = ? AND schedule_id = ? AND expires_at > ?",
                (profile_id, lease_id, monitor_id, schedule_id, iso_now()),
            ).fetchone()
            if not lease:
                raise ValidationError("lease is missing, expired, or no longer belongs to this job")
            schedule_row = self.connection.execute(
                "SELECT payload FROM schedules WHERE profile_id = ? AND id = ? AND monitor_id = ?",
                (profile_id, schedule_id, monitor_id),
            ).fetchone()
            if not schedule_row:
                raise ValidationError("schedule was deleted while the check was running")
            schedule = json.loads(unprotect_text(schedule_row["payload"]))
            result = normalize_result(raw_result, monitor_id)
            checked_at = iso_now()
            result["last_checked_at"] = checked_at
            schedule["next_run_at"] = (utc_now() + timedelta(seconds=schedule["interval_seconds"])).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            schedule["updated_at"] = checked_at
            self.connection.execute(
                "INSERT INTO results(profile_id, monitor_id, payload) VALUES (?, ?, ?) "
                "ON CONFLICT(profile_id, monitor_id) DO UPDATE SET payload = excluded.payload",
                (profile_id, monitor_id, self._json(result)),
            )
            self.connection.execute(
                "UPDATE schedules SET next_run_at = ?, payload = ? WHERE profile_id = ? AND id = ?",
                (schedule["next_run_at"], self._json(schedule), profile_id, schedule_id),
            )
            self.connection.execute("DELETE FROM leases WHERE profile_id = ? AND lease_id = ?", (profile_id, lease_id))
            revision = self._touch(profile_id)
        return result, schedule, revision


class DesktopApplication:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.config_path = self.data_dir / "desktop-config.json"
        self.config = self._load_config()
        self.store = Store(self.data_dir / "openstill-desktop.sqlite3")

    def _load_config(self) -> dict[str, Any]:
        loaded: dict[str, Any] = {}
        if self.config_path.exists():
            try:
                loaded = json.loads(self.config_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                loaded = {}
        protected_token = loaded.get("pairing_token_protected")
        token = unprotect_text(protected_token) if isinstance(protected_token, str) else ""
        # Migrate an early development configuration without leaving its token
        # in plaintext after the next normal Desktop start.
        if not token and isinstance(loaded.get("pairing_token"), str):
            token = loaded["pairing_token"]
        if len(token) < 32:
            token = secrets.token_urlsafe(32)
        loaded["pairing_token"] = token
        self._save_config(loaded)
        return loaded

    def _save_config(self, config: dict[str, Any]) -> None:
        persisted = {key: value for key, value in config.items() if key not in {"pairing_token", "pairing_token_protected"}}
        persisted["pairing_token_protected"] = protect_text(config["pairing_token"])
        self.config_path.write_text(json.dumps(persisted, ensure_ascii=False, indent=2), encoding="utf-8")

    @property
    def pairing_token(self) -> str:
        return self.config["pairing_token"]

    @staticmethod
    def profile_id(payload: Any) -> str:
        if not isinstance(payload, dict):
            return DEFAULT_PROFILE_ID
        return identifier(payload.get("profile_id") or payload.get("profileId") or DEFAULT_PROFILE_ID, "profile_id")

    def paged_state(self, profile_id: str, payload: dict[str, Any]) -> tuple[dict[str, Any], int, str | None]:
        state, revision = self.store.state(profile_id)
        requested_limit = payload.get("limit", 500)
        try:
            limit = min(max(int(requested_limit), 1), 500)
        except (TypeError, ValueError) as error:
            raise ValidationError("limit must be an integer between 1 and 500") from error
        cursor = payload.get("cursor")
        monitor_ids = [monitor["id"] for monitor in state["monitors"]]
        start = 0
        if cursor:
            cursor = identifier(cursor, "cursor")
            with contextlib.suppress(ValueError):
                start = monitor_ids.index(cursor) + 1
        chosen = state["monitors"][start:start + limit]
        chosen_ids = {monitor["id"] for monitor in chosen}
        page = {
            **empty_state(),
            "monitors": chosen,
            "schedules": [item for item in state["schedules"] if item["monitor_id"] in chosen_ids],
            "results": [item for item in state["results"] if item["monitor_id"] in chosen_ids] if payload.get("include_results", True) else [],
        }
        next_cursor = chosen[-1]["id"] if start + len(chosen) < len(monitor_ids) and chosen else None
        return page, revision, next_cursor

    def native_response(self, request: Any) -> dict[str, Any]:
        if not isinstance(request, dict):
            raise ValidationError("native request must be an object")
        allowed = {"protocol", "id", "token", "type", "payload"}
        if set(request) - allowed:
            raise ValidationError("native request has unknown fields")
        if request.get("protocol") != PROTOCOL:
            raise ValidationError("unsupported protocol")
        request_id = identifier(request.get("id"), "id")
        token = request.get("token")
        if not isinstance(token, str) or not hmac.compare_digest(token, self.pairing_token):
            raise ValidationError("pairing token is not valid")
        command = identifier(request.get("type"), "type")
        payload = request.get("payload")
        if not isinstance(payload, dict):
            raise ValidationError("payload must be an object")
        allowed_payload_keys = {
            "hello": {"profile_id", "profileId", "extension_id", "limit", "cursor", "include_results"},
            "get-state": {"profile_id", "profileId", "limit", "cursor", "include_results"},
            "replace-state": {"profile_id", "profileId", "state"},
            "upsert-monitor": {"profile_id", "profileId", "monitor", "schedule"},
            "delete-monitor": {"profile_id", "profileId", "monitor_id", "monitorId"},
            "due-jobs": {"profile_id", "profileId", "limit", "lease_seconds", "leaseSeconds", "now"},
            "check-result": {"profile_id", "profileId", "monitor_id", "monitorId", "schedule_id", "scheduleId", "lease_id", "leaseId", "result"},
            "export": {"profile_id", "profileId"},
            "import": {"profile_id", "profileId", "document"},
        }
        if command not in allowed_payload_keys:
            raise ValidationError("unknown native command")
        if set(payload) - allowed_payload_keys[command]:
            raise ValidationError("native payload has unknown fields")
        expected_extension_id = self.config.get("extension_id")
        if command == "hello" and isinstance(expected_extension_id, str) and expected_extension_id:
            if not hmac.compare_digest(str(payload.get("extension_id", "")), expected_extension_id):
                raise ValidationError("calling extension ID is not allowed")
        profile_id = self.profile_id(payload)

        if command in {"hello", "get-state"}:
            state, revision, next_cursor = self.paged_state(profile_id, payload)
            event = "hello" if command == "hello" else "state"
            body = {"event": event, "profileId": profile_id, "state": state, "revision": revision, "nextCursor": next_cursor}
        elif command == "replace-state":
            state, revision = self.store.replace_state(profile_id, payload.get("state"))
            body = {"event": "state-changed", "profileId": profile_id, "state": state, "revision": revision}
        elif command == "upsert-monitor":
            monitor, schedule, revision = self.store.upsert_monitor(profile_id, payload.get("monitor"), payload.get("schedule"))
            body = {"event": "state-changed", "profileId": profile_id, "monitor": monitor, "schedule": schedule, "revision": revision}
        elif command == "delete-monitor":
            deleted, revision = self.store.delete_monitor(profile_id, payload.get("monitor_id") or payload.get("monitorId"))
            body = {"event": "state-changed", "profileId": profile_id, "deleted": deleted, "revision": revision}
        elif command == "due-jobs":
            jobs, revision = self.store.due_jobs(
                profile_id,
                limit=payload.get("limit", 3),
                lease_seconds=payload.get("lease_seconds") or payload.get("leaseSeconds") or 120,
                now=payload.get("now"),
            )
            body = {"event": "due-jobs", "profileId": profile_id, "revision": revision, "jobs": jobs}
        elif command == "check-result":
            result, schedule, revision = self.store.check_result(profile_id, payload)
            body = {"event": "state-changed", "profileId": profile_id, "result": result, "schedule": schedule, "revision": revision}
        elif command == "export":
            state, revision = self.store.state(profile_id)
            body = {"event": "export", "profileId": profile_id, "state": state, "revision": revision}
        elif command == "import":
            state, revision = self.store.merge_import(profile_id, payload.get("document"))
            body = {"event": "state-changed", "profileId": profile_id, "state": state, "revision": revision}
        return {"protocol": PROTOCOL, "id": request_id, "ok": True, "payload": body}


def native_error(request: Any, error: Exception) -> dict[str, Any]:
    request_id = request.get("id") if isinstance(request, dict) and isinstance(request.get("id"), str) else "invalid-request"
    code = "validation_error" if isinstance(error, ValidationError) else "internal_error"
    return {"protocol": PROTOCOL, "id": request_id, "ok": False, "error": {"code": code, "message": str(error)}}


def read_native_frame(stream: Any) -> dict[str, Any] | None:
    header = stream.read(4)
    if not header:
        return None
    if len(header) != 4:
        raise ValidationError("native frame header is incomplete")
    size = int.from_bytes(header, "little")
    if size <= 0 or size > MAX_FRAME_BYTES:
        raise ValidationError("native frame size is invalid")
    payload = stream.read(size)
    if len(payload) != size:
        raise ValidationError("native frame is incomplete")
    decoded = json.loads(payload.decode("utf-8"))
    if not isinstance(decoded, dict):
        raise ValidationError("native frame must contain an object")
    return decoded


def write_native_frame(stream: Any, value: dict[str, Any]) -> None:
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(payload) > MAX_FRAME_BYTES:
        raise ValidationError("native response exceeds Chrome's message limit")
    stream.write(len(payload).to_bytes(4, "little"))
    stream.write(payload)
    stream.flush()


def native_loop(application: DesktopApplication, caller_origin: str | None = None) -> int:
    expected_extension_id = application.config.get("extension_id")
    if isinstance(expected_extension_id, str) and expected_extension_id:
        expected_origin = f"chrome-extension://{expected_extension_id}"
        actual_origin = caller_origin.rstrip("/") if isinstance(caller_origin, str) else ""
        if not hmac.compare_digest(actual_origin, expected_origin):
            # Do not write a plain-text diagnostic to stdout: Chrome treats it
            # as a malformed Native Messaging frame.
            return 3
    input_stream = sys.stdin.buffer
    output_stream = sys.stdout.buffer
    while True:
        try:
            request = read_native_frame(input_stream)
        except Exception as error:  # keep stdout strictly protocol frames
            write_native_frame(output_stream, native_error({}, error))
            return 2
        if request is None:
            return 0
        try:
            response = application.native_response(request)
        except Exception as error:
            response = native_error(request, error)
        write_native_frame(output_stream, response)


DASHBOARD_HTML = """<!doctype html>
<html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenStill Desktop</title><style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#101a28;color:#eaf2ff}body{max-width:980px;margin:0 auto;padding:32px}h1{margin:0}p,.muted{color:#a8b9d0}.card{margin:18px 0;padding:18px;border:1px solid #314761;border-radius:12px;background:#172538}.row{display:flex;gap:9px;flex-wrap:wrap;align-items:center}button{border:0;border-radius:8px;padding:9px 12px;background:#54d9a5;color:#06261c;font-weight:700;cursor:pointer}button.secondary{background:#2b405a;color:#dce9f8}textarea,input{width:100%;box-sizing:border-box;margin-top:9px;padding:10px;border:1px solid #405a78;border-radius:8px;background:#0e1826;color:#eff6ff;font:12px ui-monospace,monospace}textarea{min-height:170px}table{width:100%;border-collapse:collapse;font-size:12px}th,td{padding:9px;border-bottom:1px solid #2a4059;text-align:left;vertical-align:top;word-break:break-word}.ok{color:#72e8b2}.error{color:#ffaaa2}</style>
<body><h1>OpenStill Desktop</h1><p>이 PC의 SQLite 데이터베이스가 일정과 결과를 보관합니다. Chrome 확장이 연결되어 있을 때만 실제 웹페이지 확인 작업이 실행됩니다.</p>
<section class="card"><h2>Chrome 확장 연결</h2><p class="muted">확장의 <strong>Desktop</strong> 버튼을 열고 아래 토큰을 붙여넣으세요. 이 토큰과 native-host의 고정 확장 ID 검증으로 같은 PC의 OpenStill 확장만 연결됩니다.</p><input id="pairingToken" readonly aria-label="Desktop 연결 토큰"><p id="connectionStatus" class="muted"></p></section>
<section class="card"><div class="row"><strong id="summary">불러오는 중…</strong><button class="secondary" id="refresh">새로고침</button><button class="secondary" id="export">백업 내보내기</button></div><p id="status" class="muted"></p><table><thead><tr><th>이름</th><th>URL</th><th>간격 / 다음 확인</th><th>상태</th></tr></thead><tbody id="list"></tbody></table></section>
<section class="card"><h2>선택 초안 또는 백업 붙여넣기</h2><p class="muted">OpenStill 확장에서 요소를 저장하면 클립보드에 복사되는 <code>openstill-selector-draft</code> JSON과, Desktop/확장 내보내기 JSON을 붙여넣을 수 있습니다.</p><textarea id="importText" placeholder="JSON을 붙여넣으세요"></textarea><div class="row"><button id="import">추가하기</button><span id="importStatus" class="muted"></span></div></section>
<script>
const status=document.querySelector('#status'),list=document.querySelector('#list'),summary=document.querySelector('#summary');
let current=null;
function when(v){return v?new Date(v).toLocaleString('ko-KR'):'아직 없음'}
async function api(path,options){const r=await fetch(path,options);const j=await r.json();if(!r.ok)throw Error(j.error||'요청에 실패했습니다.');return j}
async function refresh(){try{current=await api('/api/state');const results=new Map(current.state.results.map(x=>[x.monitor_id,x]));const schedules=new Map(current.state.schedules.map(x=>[x.monitor_id,x]));summary.textContent=`${current.state.monitors.length}개 추적 · revision ${current.revision}`;list.replaceChildren();for(const m of current.state.monitors){const s=schedules.get(m.id),r=results.get(m.id);const tr=document.createElement('tr');for(const value of [m.name,m.url,`${s?Math.round(s.interval_seconds/3600):1}시간 / ${when(s?.next_run_at)}`,r?.status||'기준값 필요']){const td=document.createElement('td');td.textContent=value;tr.append(td)}list.append(tr)}status.textContent='Desktop 일정은 Chrome과 OpenStill 확장이 연결될 때 실행됩니다.';status.className='muted'}catch(e){status.textContent=e.message;status.className='error'}}
document.querySelector('#refresh').onclick=refresh;document.querySelector('#import').onclick=async()=>{const target=document.querySelector('#importStatus');try{const documentValue=JSON.parse(document.querySelector('#importText').value);const r=await api('/api/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({document:documentValue})});target.textContent=`${r.count}개 추적을 추가했습니다.`;target.className='ok';document.querySelector('#importText').value='';await refresh()}catch(e){target.textContent=e.message;target.className='error'}};document.querySelector('#export').onclick=async()=>{const r=await api('/api/export',{method:'POST'});const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(r.state,null,2)],{type:'application/json'}));a.download='openstill-desktop-backup.json';a.click();URL.revokeObjectURL(a.href)};api('/api/connection').then(r=>{document.querySelector('#pairingToken').value=r.pairing_token;document.querySelector('#connectionStatus').textContent='Native host 이름: '+r.host_name}).catch(e=>{document.querySelector('#connectionStatus').textContent=e.message});refresh();
</script></body></html>"""


class DashboardHandler(BaseHTTPRequestHandler):
    application: DesktopApplication

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def _json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_HTTP_BYTES:
            raise ValidationError("request body size is invalid")
        value = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(value, dict):
            raise ValidationError("request body must be an object")
        return value

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/":
            body = DASHBOARD_HTML.encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/api/state":
            try:
                profile_id = parse_qs(parsed.query).get("profile_id", [DEFAULT_PROFILE_ID])[0]
                state, revision = self.application.store.state(profile_id)
                self._json(HTTPStatus.OK, {"state": state, "revision": revision})
            except Exception as error:
                self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        if parsed.path == "/api/connection":
            self._json(HTTPStatus.OK, {"pairing_token": self.application.pairing_token, "host_name": HOST_NAME})
            return
        self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        try:
            payload = self._read_json()
            profile_id = self.application.profile_id(payload)
            if self.path == "/api/import":
                state, revision = self.application.store.merge_import(profile_id, payload.get("document"))
                self._json(HTTPStatus.OK, {"count": len(state["monitors"]), "revision": revision})
                return
            if self.path == "/api/export":
                state, revision = self.application.store.state(profile_id)
                self._json(HTTPStatus.OK, {"state": state, "revision": revision})
                return
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
        except Exception as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})


def serve(application: DesktopApplication, port: int, open_browser: bool) -> int:
    DashboardHandler.application = application
    server = ThreadingHTTPServer(("127.0.0.1", port), DashboardHandler)
    address = f"http://127.0.0.1:{server.server_port}/"
    print(f"OpenStill Desktop is running at {address}")
    print(f"Data directory: {application.data_dir}")
    print(f"Pairing token: {application.pairing_token}")
    if open_browser:
        webbrowser.open(address)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        return 0
    finally:
        server.server_close()


def default_data_dir() -> Path:
    root = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
    return Path(root) / "OpenStill" if root else Path.home() / ".openstill"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="OpenStill local Desktop companion")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--serve", action="store_true", help="serve the local dashboard (default)")
    mode.add_argument("--native-host", action="store_true", help="run Chrome Native Messaging stdio bridge")
    parser.add_argument("--data-dir", type=Path, default=default_data_dir())
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-open", action="store_false", dest="open", help="do not open the local dashboard in a browser")
    parser.set_defaults(open=True)
    parser.add_argument("--print-pairing-token", action="store_true", help="print the token to enter in the extension")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    application = DesktopApplication(args.data_dir)
    if args.print_pairing_token:
        print(application.pairing_token)
        return 0
    if args.native_host:
        return native_loop(application)
    if not 1 <= args.port <= 65535:
        raise SystemExit("--port must be between 1 and 65535")
    return serve(application, args.port, args.open)


if __name__ == "__main__":
    raise SystemExit(main())
