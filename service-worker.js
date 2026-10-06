'use strict';

if (typeof importScripts === 'function') importScripts('record-store.js', 'import-session.js', 'export-session.js');

const MONITORS_KEY = 'openStill.monitors.v2';
const SETTINGS_KEY = 'openStill.settings.v1';
const PENDING_PICKERS_KEY = 'openStill.pending-pickers.v1';
const LIVE_CONTROLLED_TABS_KEY = 'openStill.live-controlled-tabs.v1';
const ALARM_NAME = 'openStill.next-check';

const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 14 * 24;
// The local reference scheduler accepts five-second schedules. Chrome alarms
// cannot reliably wake an MV3 worker that often, so short schedules use an
// in-worker precision timer plus a durable alarm fallback (see
// scheduleNextAlarm).
const MIN_SCHEDULE_SECONDS = 5;
const MIN_CHROME_ALARM_DELAY_MS = 30_000;
// The reference scheduler treats a 30-day-or-longer duration as an
// intentionally unscheduled (effectively infinite) interval.  Keep that
// value representable for imports, but never arm an alarm for it.
const INFINITE_SCHEDULE_SECONDS = 30 * 24 * 60 * 60;
const MAX_SCHEDULE_SECONDS = INFINITE_SCHEDULE_SECONDS;
const SCHEDULE_MODE_MANUAL = 'manual';
const SCHEDULE_MODE_INTERVAL = 'interval';
const SCHEDULE_MODE_RANDOM = 'random';
const SCHEDULE_MODE_CRON = 'cron';
const SCHEDULE_MODE_LIVE = 'live';
const SCHEDULE_MODES = new Set([
  SCHEDULE_MODE_MANUAL,
  SCHEDULE_MODE_INTERVAL,
  SCHEDULE_MODE_RANDOM,
  SCHEDULE_MODE_CRON,
  SCHEDULE_MODE_LIVE
]);
// unlimitedStorage prevents a few large snapshots from blocking a legitimate
// import of hundreds of user-configured trackers.
const MAX_MONITORS = 10_000;
const MAX_SELECTORS_PER_MONITOR = 20;
const MAX_COLLECTION_ITEMS = 10_000;
// Storage is explicitly unlimited. Keep the canonical comparison payload much
// larger than the dashboard preview so a change after the first few cards is
// not silently invisible. Presentation code is responsible for clipping what
// it renders, never the comparison engine.
const MAX_SNAPSHOT_CHARS = 1_000_000;
const MAX_CHANGE_HISTORY = 3;
const MAX_RUN_HISTORY = 40;
const PARSE_TIMEOUT_MS = 12_000;
const SOUND_DEBOUNCE_MS = 3_000;
const MAX_CHECKS_PER_SWEEP = 6;
const MAX_BATCH_CHECKS = 10_000;
const MAX_CONCURRENT_BATCH_CHECKS = 3;
const DASHBOARD_LOAD_PAGE_SIZE = 100;
const MAX_DASHBOARD_LOAD_PAGE_SIZE = 199;
const MAX_DASHBOARD_LOAD_PAGE_BYTES = 8 * 1024 * 1024;
const DASHBOARD_SESSION_TTL_MS = 2 * 60 * 1000;
const IMPORT_SESSION_TTL_MS = 5 * 60 * 1000;
// Export parts reserve 64 KiB below 32 MiB, plus a further 64 KiB for the
// v4 file envelope. Large individual monitor records are transferred to the
// dashboard as smaller JSON-string fragments instead of imposing a backup-
// size cap on the monitor itself.
// Every direct record must fit the streaming parser's independent 16 MiB
// budget, including its JSON envelope. Larger values use bounded fragments.
const MAX_EXPORT_DIRECT_RECORD_BYTES = 12 * 1024 * 1024;
const EXPORT_RECORD_FRAGMENT_CHARS = 3 * 1024 * 1024;
const PENDING_PICKER_TTL_MS = 2 * 60 * 60 * 1000;
const RENDER_LOAD_TIMEOUT_MS = 30_000;
// The picker only needs a live DOM to show an element under the cursor. Do not
// hold the user behind a fixed post-load delay; capture retains its own
// explicit settling rules.
const CHECK_EXECUTION_TIMEOUT_MS = 60_000;
const MIN_CHECK_EXECUTION_TIMEOUT_MS = 10_000;
const MAX_CHECK_EXECUTION_TIMEOUT_MS = 300_000;
// Match the reference runner's empty-selection behavior: after the initial
// rendered capture it retries every five seconds through retryCount 5.
const RENDER_EMPTY_RETRY_COUNT = 4;
const RENDER_EMPTY_RETRY_DELAY_MS = 5_000;

const DEFAULT_SETTINGS = Object.freeze({ soundEnabled: true });
const VALID_STATUSES = new Set([
  'ok',
  'changed',
  'needs-review',
  'error',
  'permission-needed',
  'needs-baseline'
]);
const LOCATOR_TYPES = new Set(['css', 'xcss', 'xpath']);
const LOCATOR_OPERATIONS = new Set(['include', 'exclude']);
const LOCATOR_FIELD_TYPES = new Set(['text', 'attribute', 'property']);

const ELEMENT_NOT_FOUND_MESSAGE = '선택한 요소를 찾지 못했습니다. 로그인 상태나 페이지 구성, CSS 선택자를 확인해 주세요.';
const ELEMENT_CONTENT_EMPTY_MESSAGE = '선택한 요소는 찾았지만 추적 내용이 비어 있습니다. 텍스트가 있는 요소나 title·aria-label·href 속성을 선택하고 필터 설정을 확인해 주세요.';

let storageQueue = Promise.resolve();
let offscreenCreation;
let sweepRunning = false;
let lastSoundAt = 0;
const checksInProgress = new Set();
let alarmQueue = Promise.resolve();
let precisionScheduleTimer = null;
// Service-worker memory only tracks active page observer installations. The
// durable monitor configuration remains in storage and is restored on startup.
const liveSessions = new Map();
const liveDirtyByMonitor = new Map();
let liveOwnershipQueue = Promise.resolve();
const dashboardLoadSessions = new Map();
const exportSessions = new Map();
const importSessions = new Map();
const MAX_GLOBAL_CAPTURES = 6;
const MAX_ORIGIN_CAPTURES = 2;
const MAX_RESIDENT_LIVE_TABS = 12;
const RUNTIME_STATE_KEY = 'openStill.runtime.v1';
const RUNTIME_SESSION_KEY = 'openStill.runtime-session.v1';
const RUNTIME_ALARM_NAME = 'openStill.runtime-recovery';
const captureQueue = [];
const captureQueuedAt = new Map();
const captureTasks = new Map();
const captureOrigins = new Map();
let activeCaptures = 0;
let reservedLiveTabs = 0;
let runtimePersistenceQueue = Promise.resolve();
let mutationOperationQueue = Promise.resolve();
let activeMutationOperation = null;
let runtimeSessionPromise;
let initializationPromise;
let initializationPermissionCleanup = false;
const liveLifecycleQueues = new Map();
const storageFailureBackoff = new Map();
const expectedRevisionMaps = new WeakMap();
const pendingSnapshotCommits = new Map();
const MAX_PENDING_CAPTURE_BYTES = 64 * 1024 * 1024;
let pendingCaptureBytes = 0;
let storageUnavailableUntil = 0;
let storageRetryTimer = null;
let runtimeRecoveryPromise;
let recoveringRuntime = false;

function rememberPendingCapture(id, value) {
  const snapshot = value.snapshot;
  const bytes = 2 * (['text', 'html', 'data', 'evidenceHtml'].reduce((sum, field) => sum + String(snapshot?.[field] || '').length, 0)
    + (snapshot?.items || []).reduce((sum, item) => sum + 512 + String(item.text || '').length + String(item.html || '').length + String(item.data || '').length + String(item.permalink || '').length, 0));
  const prior = pendingSnapshotCommits.get(id);
  if (prior) { pendingCaptureBytes -= prior.bytes; pendingSnapshotCommits.delete(id); }
  if (bytes > MAX_PENDING_CAPTURE_BYTES) return;
  while (pendingSnapshotCommits.size >= MAX_GLOBAL_CAPTURES || pendingCaptureBytes + bytes > MAX_PENDING_CAPTURE_BYTES) {
    const oldest = pendingSnapshotCommits.keys().next().value;
    if (!oldest) break;
    pendingCaptureBytes -= pendingSnapshotCommits.get(oldest).bytes;
    pendingSnapshotCommits.delete(oldest);
  }
  pendingSnapshotCommits.set(id, { ...value, bytes }); pendingCaptureBytes += bytes;
}

function forgetPendingCapture(id) {
  const value = pendingSnapshotCommits.get(id);
  if (value) { pendingCaptureBytes -= value.bytes; pendingSnapshotCommits.delete(id); }
}

function pauseQueueForStorage(milliseconds) {
  storageUnavailableUntil = Math.max(storageUnavailableUntil, Date.now() + Math.min(60_000, milliseconds));
  if (storageRetryTimer !== null) return;
  storageRetryTimer = setTimeout(() => {
    storageRetryTimer = null;
    drainCaptureQueue();
    void recoverRuntime().catch(() => { drainCaptureQueue(); });
  }, Math.max(1, storageUnavailableUntil - Date.now()));
  storageRetryTimer?.unref?.();
}

async function getRuntimeAux(namespace, id) {
  if (globalThis.OpenStillRecordStore?.getAux) return OpenStillRecordStore.getAux(namespace === 'runtime' ? 'meta' : namespace, namespace === 'runtime' ? `runtime.${id}` : id);
  const key = `openStill.${namespace}.${id}`;
  return (await chrome.storage.local.get(key))[key] ?? null;
}

async function putRuntimeAux(namespace, id, value) {
  if (globalThis.OpenStillRecordStore?.putAux) return OpenStillRecordStore.putAux(namespace === 'runtime' ? 'meta' : namespace, namespace === 'runtime' ? `runtime.${id}` : id, value);
  return chrome.storage.local.set({ [`openStill.${namespace}.${id}`]: value });
}

async function deleteRuntimeAux(namespace, id) {
  if (globalThis.OpenStillRecordStore?.deleteAux) return OpenStillRecordStore.deleteAux(namespace === 'runtime' ? 'meta' : namespace, namespace === 'runtime' ? `runtime.${id}` : id);
  return chrome.storage.local.remove(`openStill.${namespace}.${id}`);
}

async function captureJobRecords() {
  if (globalThis.OpenStillRecordStore?.allAux) return (await OpenStillRecordStore.allAux('jobs')).filter((job) => job.kind === 'capture');
  const stored = await chrome.storage.local.get(null);
  return Object.entries(stored).filter(([key]) => key.startsWith('openStill.jobs.capture.')).map(([, job]) => job);
}

function mutateRuntimeState(mutator) {
  const work = runtimePersistenceQueue.catch(() => undefined).then(async () => {
    const state = await getRuntimeAux('runtime', 'checkpoint') || { jobs: {}, backoff: {}, liveCursor: 0 };
    const result = await mutator(state);
    await putRuntimeAux('runtime', 'checkpoint', state);
    return result;
  });
  runtimePersistenceQueue = work.catch(() => undefined);
  return work;
}

function runtimeSessionId() {
  if (!runtimeSessionPromise) runtimeSessionPromise = (async () => {
    const area = chrome.storage.session || chrome.storage.local;
    const stored = await area.get(RUNTIME_SESSION_KEY);
    const id = stored[RUNTIME_SESSION_KEY] || createRevision();
    if (!stored[RUNTIME_SESSION_KEY]) await area.set({ [RUNTIME_SESSION_KEY]: id });
    return id;
  })();
  return runtimeSessionPromise;
}

function queueLiveLifecycle(id, action) {
  const prior = liveLifecycleQueues.get(id) || Promise.resolve();
  const work = prior.catch(() => undefined).then(action);
  liveLifecycleQueues.set(id, work);
  work.finally(() => { if (liveLifecycleQueues.get(id) === work) liveLifecycleQueues.delete(id); }).catch(() => undefined);
  return work;
}

function drainCaptureQueue() {
  if (recoveringRuntime) return;
  if (storageUnavailableUntil > Date.now()) { pauseQueueForStorage(0); return; }
  while (activeCaptures < MAX_GLOBAL_CAPTURES) {
    const index = captureQueue.findIndex((entry) => (captureOrigins.get(entry.origin) || 0) < MAX_ORIGIN_CAPTURES);
    if (index < 0) break;
    const entry = captureQueue.splice(index, 1)[0];
    captureQueuedAt.delete(entry.id);
    activeCaptures += 1;
    captureOrigins.set(entry.origin, (captureOrigins.get(entry.origin) || 0) + 1);
    void (async () => {
      try {
        await putRuntimeAux('jobs', `capture.${entry.id}`, { ...entry.checkpoint, stage: 'running' });
        entry.started = true;
        const value = await entry.run(entry.job);
        entry.value = value;
        entry.hasValue = true;
        // A timeout response may finish before Chrome actually finishes an
        // executeScript request. Keep its permit and monitor lock until then.
        if (entry.job.draining) { entry.resolve(value); await entry.job.draining.catch(() => undefined); }
      } catch (error) {
        entry.reject(error);
        if (!entry.started) {
          const prior = storageFailureBackoff.get(entry.id);
          storageFailureBackoff.set(entry.id, { attempts: (prior?.attempts || 0) + 1, retryAt: Date.now() + 30_000 });
          pauseQueueForStorage(30_000);
        }
      }
      finally {
        try {
          if (Number.isInteger(entry.job.ownedTabId)) {
            entry.job.cleanupPending = await tabById(entry.job.ownedTabId) ? !await removeLiveControlledTab(entry.job.ownedTabId) : false;
            if (entry.job.cleanupPending) await putRuntimeAux('jobs', `capture.${entry.id}`, { ...entry.checkpoint, tabId: entry.job.ownedTabId, stage: 'pendingCleanup' }).catch(() => undefined);
          }
          if ((!entry.job.draining || entry.job.finished) && !entry.job.cleanupPending) {
            if (!entry.started || storageFailureBackoff.has(entry.id)) {
              await putRuntimeAux('jobs', `capture.${entry.id}`, { ...entry.checkpoint, stage: 'resumable' }).catch(() => undefined);
            } else await deleteRuntimeAux('jobs', `capture.${entry.id}`).catch(() => undefined);
          }
          if (entry.hasValue) entry.resolve(entry.job.cleanupPending ? { ...entry.value, warnings: [...(entry.value?.warnings || []), { step: 'tab-cleanup', error: '캡처 탭 정리를 다시 시도해야 합니다.' }] } : entry.value);
        } catch (error) {
          if (entry.hasValue) entry.resolve({ ...entry.value, warnings: [...(entry.value?.warnings || []), { step: 'tab-cleanup', error: responseError(error) }] });
        } finally {
          activeCaptures -= 1;
          captureOrigins.set(entry.origin, Math.max(0, (captureOrigins.get(entry.origin) || 1) - 1));
          if (captureTasks.get(entry.id) === entry.promise) captureTasks.delete(entry.id);
          drainCaptureQueue();
        }
      }
    })();
  }
}

async function enqueueCaptureTask(id, url, source, run) {
  if (captureTasks.has(id)) return { ok: false, reason: 'checking', error: '이미 확인 중입니다.' };
  const origin = new URL(url).origin;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const checkpoint = { kind: 'capture', id, url, source, stage: 'queued', createdAt: nowIso(), sessionId: await runtimeSessionId() };
  if (captureTasks.has(id)) return { ok: false, reason: 'checking', error: '이미 확인 중입니다.' };
  const persisted = await getRuntimeAux('jobs', `capture.${id}`);
  if (persisted && ['ownership-unverified', 'pendingCleanup'].includes(persisted.stage)) return { ok: false, reason: 'pending-cleanup', error: '이전 캡처 탭의 소유권 확인 또는 정리가 필요합니다.' };
  if (persisted && ['queued', 'resumable'].includes(persisted.stage) && persisted.url === url && asIso(persisted.createdAt, null)) checkpoint.createdAt = persisted.createdAt;
  if (captureTasks.has(id)) return { ok: false, reason: 'checking', error: '이미 확인 중입니다.' };
  const job = {
    id, cancelled: false, signal: controller?.signal,
    isCancelled() { return this.cancelled; },
    async onTabCreated(tabId) {
      this.ownedTabId = tabId;
      await putRuntimeAux('jobs', `capture.${id}`, { ...checkpoint, stage: 'loading', tabId });
    },
    async cancel() {
      this.cancelled = true;
      controller?.abort();
      const persisted = await getRuntimeAux('jobs', `capture.${id}`).catch(() => null);
      if (persisted) await putRuntimeAux('jobs', `capture.${id}`, { ...persisted, stage: 'cancelling' }).catch(() => undefined);
      if (Number.isInteger(this.ownedTabId)) this.cleanupPending = !await removeLiveControlledTab(this.ownedTabId);
    }
  };
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  captureTasks.set(id, promise);
  try {
    await putRuntimeAux('jobs', `capture.${id}`, checkpoint);
    captureQueuedAt.set(id, checkpoint.createdAt);
    const entry = { id, origin, source, run, job, checkpoint, promise, resolve, reject };
    if (pendingSnapshotCommits.has(id)) captureQueue.unshift(entry);
    else captureQueue.push(entry);
    drainCaptureQueue();
  } catch (error) { captureTasks.delete(id); captureQueuedAt.delete(id); reject(error); }
  return promise;
}

function mutationConflict(monitor, message) {
  let expectedRecord;
  if (Array.isArray(message?.expectedRevisions)) {
    let index = expectedRevisionMaps.get(message);
    if (!index) { index = new Map(message.expectedRevisions.map((entry) => [entry.id, entry])); expectedRevisionMaps.set(message, index); }
    expectedRecord = index.get(monitor?.id);
    if (!expectedRecord || expectedRecord.url && monitor?.url !== expectedRecord.url) return { ok: false, reason: 'conflict', id: monitor?.id, error: '작업 대상 주소 또는 구성이 변경되었습니다.' };
  }
  const expected = message?.expectedRevision ?? expectedRecord?.revision;
  if (expected && monitor?.revision !== expected) return { ok: false, reason: 'conflict', id: monitor?.id, revision: monitor?.revision, error: '다른 작업에서 추적이 변경되었습니다. 최신 내용을 다시 확인해 주세요.' };
  const expectedChange = message?.expectedChangeId ?? message?.expectedChange;
  const currentChange = monitor?.lastChange?.id ?? monitor?.lastChange?.detectedAt ?? null;
  if (expectedChange !== undefined && expectedChange !== currentChange) return { ok: false, reason: 'change-conflict', id: monitor?.id, lastChangeId: currentChange, error: '확인한 뒤 새 변경이 도착했습니다.' };
  return null;
}

function compactMonitor(monitor) {
  if (!monitor) return null;
  return { id: monitor.id, revision: monitor.revision, name: monitor.name, url: monitor.url, enabled: monitor.enabled, status: monitor.status, unread: monitor.unread, lastChangeId: monitor.lastChange?.id ?? monitor.lastChange?.detectedAt ?? null };
}

function compactMutationResult(result) {
  if (!result || typeof result !== 'object') return result;
  return { ...result, ...(result.monitor ? { monitor: compactMonitor(result.monitor) } : {}), ...(Array.isArray(result.monitors) ? { monitors: result.monitors.map(compactMonitor) } : {}) };
}

async function afterMonitorCommit(result, steps = []) {
  if (!result?.ok) return result;
  const warnings = [];
  for (const [step, action] of steps) {
    try { const outcome = await action(); if (outcome?.ok === false) warnings.push({ step, reason: outcome.reason, error: outcome.error || '후속 처리를 완료하지 못했습니다.' }); } catch (error) { warnings.push({ step, error: responseError(error) }); }
  }
  return { ...result, committed: true, ...(result.monitor ? { monitor: compactMonitor(result.monitor) } : {}), ...(warnings.length ? { warnings } : {}) };
}

function runMutationOperation(message, action) {
  const id = cleanShortText(message?.operationId, 120) || createRevision();
  const type = message?.type || 'mutation';
  const work = mutationOperationQueue.catch(() => undefined).then(async () => {
    const prior = await getRuntimeAux('operations', id);
    if (prior) return prior.type && prior.type !== type ? { ok: false, reason: 'operation-conflict', error: '작업 ID가 다른 요청에 이미 사용되었습니다.' } : { ...(prior.result ?? prior), committed: true, operationId: id, replayed: true };
    activeMutationOperation = { id, type };
    try {
      const result = await action();
      const committed = result?.committed === true || activeMutationOperation.committed === true;
      const response = { ...result, operationId: id, ...(committed ? { committed: true } : {}) };
      if (committed) await putRuntimeAux('operations', id, { type, result: response, at: nowIso() }).catch((error) => {
        response.warnings = [...(response.warnings || []), { step: 'operation-receipt', error: responseError(error) }];
      });
      return response;
    } catch (error) {
      if (!activeMutationOperation.committed) throw error;
      return { ...compactMutationResult(activeMutationOperation.result), ok: true, committed: true, operationId: id, warnings: [{ step: 'post-commit', error: responseError(error) }] };
    } finally { activeMutationOperation = null; }
  });
  mutationOperationQueue = work.catch(() => undefined);
  return work;
}

function cleanText(value, maxLength = MAX_SNAPSHOT_CHARS) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

// Snapshot text has a different job from labels and error messages: line boundaries
// give the change view enough structure to show a newly inserted list item without
// highlighting every item that merely shifted down.
function cleanSnapshotText(value, maxLength = MAX_SNAPSHOT_CHARS) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t\f\v ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength);
}

function cleanSnapshotHtml(value, maxLength = MAX_SNAPSHOT_CHARS) {
  return String(value ?? '')
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, maxLength);
}

function utf8ByteLength(value) {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) length += 1;
    else if (code <= 0x7ff) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 4;
        index += 1;
      } else {
        length += 3;
      }
    } else length += 3;
  }
  return length;
}

// A compact deterministic fingerprint lets the monitor detect a change beyond
// the stored dashboard preview cap without silently treating two truncated
// payloads as equal. It is not used as a security primitive.
function snapshotFingerprint(value) {
  const text = String(value ?? '');
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `${text.length.toString(36)}:${first.toString(36)}:${second.toString(36)}`;
}

// The reference comparison does not use literal-string equality when the
// user elects to keep whitespace significant. It separates words and runs of
// whitespace, which preserves punctuation and word boundaries while avoiding
// noisy line-wrap differences from independently rendered pages.
function comparisonTokens(value) {
  return String(value ?? '').split(/\s+|\b/g);
}

function comparisonTokenFingerprint(value) {
  // NUL cannot survive cleanSnapshotHtml and makes an unambiguous separator
  // for the otherwise variable-width tokens.
  return snapshotFingerprint(comparisonTokens(value).join('\u0000'));
}

function comparisonTokensEqual(left, right) {
  const leftTokens = comparisonTokens(left);
  const rightTokens = comparisonTokens(right);
  return leftTokens.length === rightTokens.length
    && leftTokens.every((token, index) => token === rightTokens[index]);
}

function cleanShortText(value, maxLength = 180) {
  return cleanText(value, maxLength);
}

function cleanLabels(value) {
  const values = Array.isArray(value) ? value : String(value ?? '').split(',');
  const labels = [];
  const seen = new Set();

  for (const item of values) {
    const label = cleanText(item, 48);
    const key = label.toLocaleLowerCase('ko-KR');
    if (label && !seen.has(key) && labels.length < 20) {
      labels.push(label);
      seen.add(key);
    }
  }

  return labels;
}

function asIso(value, fallback = null) {
  const timestamp = typeof value === 'number' ? value : Date.parse(value ?? '');
  return Number.isFinite(timestamp) && Math.abs(timestamp) <= 8.64e15 ? new Date(timestamp).toISOString() : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function addHours(iso, hours) {
  const from = Date.parse(iso ?? '') || Date.now();
  return new Date(from + hours * 60 * 60 * 1000).toISOString();
}

function clampInterval(value) {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value)
      : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < MIN_INTERVAL_HOURS || parsed > MAX_INTERVAL_HOURS) {
    return null;
  }
  return parsed;
}

function normalizeScheduleMode(value, fallback = null) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : value;
  // Reference exports use AUTO for a no-op/unscheduled webpage descriptor.
  // OpenStill has no background crawler mode, so retain it as manual rather
  // than dropping the imported HTML monitor or inventing an interval.
  if (mode === 'auto') return SCHEDULE_MODE_MANUAL;
  return SCHEDULE_MODES.has(mode) ? mode : null;
}

function scheduleSeconds(value) {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value)
      : Number.NaN;
  return Number.isInteger(parsed) && parsed >= MIN_SCHEDULE_SECONDS && parsed <= MAX_SCHEDULE_SECONDS
    ? parsed
    : null;
}

function parseScheduleObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function cronNumber(value, names, minimum, maximum) {
  const text = String(value ?? '').trim().toUpperCase();
  const named = names?.[text];
  const numeric = named ?? (/^\d+$/.test(text) ? Number(text) : Number.NaN);
  return Number.isInteger(numeric) && numeric >= minimum && numeric <= maximum ? numeric : null;
}

function parseCronField(value, minimum, maximum, names = null) {
  const source = String(value ?? '').trim();
  if (!source) throw new Error('A cron field is empty.');
  const all = new Set();
  for (let number = minimum; number <= maximum; number += 1) all.add(number);
  // The bundled Reference cron parser is deliberately a five-field dialect:
  // it accepts `*`, ranges, lists, and steps, but not Quartz's `?` marker.
  // Rejecting it here keeps an imported expression from silently changing its
  // DOM/DOW matching semantics.
  if (source === '?') throw new Error('Question-mark cron fields are not supported.');
  if (source === '*') return { values: all, wildcard: true };

  const values = new Set();
  let wildcard = false;
  for (const segment of source.split(',')) {
    const match = segment.trim().match(/^(.+?)(?:\/(\d+))?$/);
    if (!match) throw new Error('Invalid cron field.');
    const range = match[1];
    const step = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isInteger(step) || step <= 0 || step > maximum - minimum + 1) throw new Error('Invalid cron step.');
    let start;
    let end;
    if (range === '?') throw new Error('Question-mark cron fields are not supported.');
    if (range === '*') {
      // Distill's cron parser records a star when any list segment is based
      // on `*`, including `*/n`; that changes DOM/DOW from OR to its wildcard
      // branch. Preserve that less-obvious compatibility rule.
      wildcard = true;
      start = minimum;
      end = maximum;
    } else if (range.includes('-')) {
      const [from, to, ...extra] = range.split('-');
      if (extra.length) throw new Error('Invalid cron range.');
      start = cronNumber(from, names, minimum, maximum);
      end = cronNumber(to, names, minimum, maximum);
      if (start === null || end === null || start > end) throw new Error('Invalid cron range.');
    } else {
      start = cronNumber(range, names, minimum, maximum);
      if (start === null) throw new Error('Invalid cron value.');
      // Cron's scalar-step form (`5/15`, `MON/2`) is a stepped range from
      // that scalar through the field maximum, not a one-value expression.
      // This is distinct from a bare scalar, which remains exact.
      end = match[2] === undefined ? start : maximum;
    }
    for (let number = start; number <= end; number += step) values.add(number);
  }
  if (!values.size) throw new Error('A cron field has no values.');
  return { values, wildcard };
}

function parseCronExpression(value) {
  const fields = String(value ?? '').trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Cron requires five fields: minute hour day month weekday.');
  const months = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
  const weekdays = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
  return {
    minute: parseCronField(fields[0], 0, 59),
    hour: parseCronField(fields[1], 0, 23),
    dayOfMonth: parseCronField(fields[2], 1, 31),
    month: parseCronField(fields[3], 1, 12, months),
    // The reference parser uses Sunday=0 through Saturday=6. It intentionally
    // does not treat `7` as an alias for Sunday.
    dayOfWeek: parseCronField(fields[4], 0, 6, weekdays)
  };
}

function cronDateParts(timestamp, formatter) {
  const values = Object.fromEntries(formatter.formatToParts(new Date(timestamp))
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(values.year),
    month: Number(values.month),
    dayOfMonth: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    dayOfWeek: weekdays[values.weekday]
  };
}

function normalizeCronTimezone(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^[+-]?\d{1,4}$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  // Distill's persisted CRON schedule stores Date#getTimezoneOffset(), for
  // example -540 for Korea.  Accept that wire format as well as an IANA zone
  // name for newly created monitors.
  if (Number.isInteger(numeric)) {
    return numeric >= -14 * 60 && numeric <= 14 * 60 ? numeric : undefined;
  }
  const timezone = String(value).trim();
  if (!timezone || timezone.length > 80) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
    return timezone;
  } catch {
    return undefined;
  }
}

function cronDatePartsForTimezone(timestamp, timezone, formatter) {
  if (Number.isInteger(timezone)) {
    // getTimezoneOffset() is UTC minus local time.  Shift into that local
    // wall-clock time, then read UTC fields to avoid the machine timezone.
    const local = new Date(timestamp - timezone * 60_000);
    return {
      year: local.getUTCFullYear(),
      month: local.getUTCMonth() + 1,
      dayOfMonth: local.getUTCDate(),
      hour: local.getUTCHours(),
      minute: local.getUTCMinutes(),
      dayOfWeek: local.getUTCDay()
    };
  }
  return cronDateParts(timestamp, formatter);
}

function sortedCronValues(field) {
  return [...field.values].sort((left, right) => left - right);
}

// The Reference cron dialect uses JavaScript Date construction for its logical
// month/day candidates. As a result, a syntactically valid but calendar-invalid
// value such as `31 FEB` rolls into March. Calculate those overflow candidates
// separately from the efficient real-calendar scan, then choose whichever is
// earlier. This matters even when a normal candidate exists: `28-31 * *` after
// November 30 reaches logical November 31 (December 1) before December 28.
function nextRolledCalendarCronOccurrence(fields, timezone, afterTimestamp, deadline, formatter) {
  // Reference persistence uses a numeric Date#getTimezoneOffset. Preserve its
  // Date rollover behavior exactly for that format. IANA zones are an OpenStill
  // extension; their DST wall-time conversion is left to the regular scan.
  if (typeof timezone === 'string') return null;

  const afterParts = cronDatePartsForTimezone(afterTimestamp, timezone, formatter);
  if (!Number.isInteger(afterParts.year)) return null;
  const months = sortedCronValues(fields.month);
  const days = sortedCronValues(fields.dayOfMonth);
  const hours = sortedCronValues(fields.hour);
  const minutes = sortedCronValues(fields.minute);
  const cutoff = Number(afterTimestamp);
  let next = Number.POSITIVE_INFINITY;

  // Include the preceding logical year because DEC 32 can roll into the first
  // days of the current year. The absolute deadline retains the normal two-year
  // search bound and prevents malformed imports from causing unbounded work.
  for (let year = afterParts.year - 1; year <= afterParts.year + 2; year += 1) {
    for (const month of months) {
      for (const day of days) {
        const wallMidnight = new Date(Number.isInteger(timezone)
          ? Date.UTC(year, month - 1, day)
          : new Date(year, month - 1, day).valueOf());
        const rolledYear = Number.isInteger(timezone) ? wallMidnight.getUTCFullYear() : wallMidnight.getFullYear();
        const rolledMonth = (Number.isInteger(timezone) ? wallMidnight.getUTCMonth() : wallMidnight.getMonth()) + 1;
        const rolledDay = Number.isInteger(timezone) ? wallMidnight.getUTCDate() : wallMidnight.getDate();
        if (rolledYear === year && rolledMonth === month && rolledDay === day) continue;
        const dayOfWeek = Number.isInteger(timezone) ? wallMidnight.getUTCDay() : wallMidnight.getDay();
        // With a star-based DOM or DOW segment, the reference requires both
        // logical DOM and the rolled calendar weekday. Otherwise a selected DOM
        // candidate is one of the ordinary DOM-or-DOW routes.
        if ((fields.dayOfMonth.wildcard || fields.dayOfWeek.wildcard)
          && !fields.dayOfWeek.values.has(dayOfWeek)) continue;

        for (const hour of hours) {
          for (const minute of minutes) {
            const candidate = Number.isInteger(timezone)
              ? Date.UTC(year, month - 1, day, hour, minute) + timezone * 60_000
              : new Date(year, month - 1, day, hour, minute).valueOf();
            if (candidate > cutoff && candidate <= deadline && candidate < next) next = candidate;
          }
        }
      }
    }
  }
  return Number.isFinite(next) ? next : null;
}

function nextCronOccurrence(expression, timezone, afterTimestamp = Date.now()) {
  const fields = parseCronExpression(expression);
  const normalizedTimezone = normalizeCronTimezone(timezone);
  if (normalizedTimezone === undefined) throw new Error('Invalid cron timezone.');
  // Constructing one formatter validates IANA names before the minute search
  // and avoids allocating hundreds of thousands of formatters for a sparse
  // monthly expression. Fixed UTC offsets intentionally use UTC accessors.
  const formatter = Number.isInteger(normalizedTimezone) ? null : new Intl.DateTimeFormat('en-US', {
    ...(normalizedTimezone ? { timeZone: normalizedTimezone } : {}),
    year: 'numeric',
    weekday: 'short',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23'
  });
  let after = Number(afterTimestamp);
  if (!Number.isFinite(after)) after = Date.now();
  // Preserve the reference's late-minute guard: an execution after :40 must
  // not immediately consume the next nominal cron minute.
  if (new Date(after).getSeconds() > 40) after += 20_000;
  let candidate = Math.floor(after / 60_000) * 60_000 + 60_000;
  const deadline = after + 2 * 366 * 24 * 60 * 60 * 1_000;
  const rolledCalendarCandidate = nextRolledCalendarCronOccurrence(
    fields,
    normalizedTimezone,
    after,
    deadline,
    formatter
  );
  // Do not linearly format every minute of a sparse schedule.  A rejected
  // month/day can advance one UTC day safely (the local date always moves at
  // least one day across normal DST changes); only a matching day needs an
  // hour/minute scan. This keeps yearly and impossible expressions bounded by
  // a few thousand timezone conversions instead of more than one million.
  for (let attempt = 0; candidate <= deadline && attempt < 200_000; attempt += 1) {
    const parts = cronDatePartsForTimezone(candidate, normalizedTimezone, formatter);
    const advanceToNextLocalDate = () => {
      // Re-anchor the daily skip at the next local midnight. Carrying the
      // current wall-clock hour across a month boundary would skip e.g.
      // `0 0 1 * *` when the scan enters day 1 at noon.
      const remainingMinutes = Math.max(1, (24 - parts.hour) * 60 - parts.minute);
      candidate += remainingMinutes * 60_000;
    };
    if (!fields.month.values.has(parts.month)) {
      advanceToNextLocalDate();
      continue;
    }
    const domMatches = fields.dayOfMonth.values.has(parts.dayOfMonth);
    const dowMatches = fields.dayOfWeek.values.has(parts.dayOfWeek);
    // Match the reference parser's Vixie-style split: a star-based segment
    // (`*`, `*/n`, or a list containing one) in either day field makes the
    // two fields conjunctive. With neither star marker, DOM and DOW are an
    // alternative route to the date.
    const dayMatches = fields.dayOfMonth.wildcard || fields.dayOfWeek.wildcard
      ? domMatches && dowMatches
      : domMatches || dowMatches;
    if (!dayMatches) {
      advanceToNextLocalDate();
      continue;
    }
    if (!fields.hour.values.has(parts.hour)) {
      // Keep the minute walk aligned to real local clock candidates. Adding
      // one hour while retaining an arbitrary minute (e.g. :02 after the
      // late-minute guard) skips valid `0 0 * * *` midnight occurrences.
      // Matching days have at most 1,440 minute probes, while nonmatching
      // days still use the fast day skip above.
      candidate += 60_000;
      continue;
    }
    if (!fields.minute.values.has(parts.minute)) {
      candidate += 60_000;
      continue;
    }
    return rolledCalendarCandidate !== null && rolledCalendarCandidate < candidate
      ? rolledCalendarCandidate
      : candidate;
  }
  if (rolledCalendarCandidate !== null) return rolledCalendarCandidate;
  throw new Error('Cron has no occurrence in the next two years.');
}

function normalizeScheduleDescriptor(input, fallbackMode = SCHEDULE_MODE_MANUAL, fallbackDescriptor = null) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : { scheduleMode: input };
  const embedded = parseScheduleObject(source.schedule);
  const fallback = fallbackDescriptor && typeof fallbackDescriptor === 'object' ? fallbackDescriptor : null;
  const type = normalizeScheduleMode(
    embedded?.type ?? source.scheduleMode,
    fallback?.type ?? fallbackMode
  );
  if (!type) return null;
  const params = embedded?.params && typeof embedded.params === 'object' && !Array.isArray(embedded.params) ? embedded.params : {};
  const fallbackParams = fallback?.type === type && fallback.params && typeof fallback.params === 'object' && !Array.isArray(fallback.params)
    ? fallback.params
    : {};
  const descriptorExtensions = Object.fromEntries(Object.entries({ ...(fallback || {}), ...(embedded || {}) }).filter(([key]) => !['type', 'params'].includes(key)));
  const parameterExtensions = Object.fromEntries(Object.entries({ ...fallbackParams, ...params }).filter(([key]) => !['interval', 'min', 'max', 'expr', 'tz'].includes(key)));
  const descriptor = (parameters) => ({ ...descriptorExtensions, type, params: { ...parameterExtensions, ...parameters } });
  if (type === SCHEDULE_MODE_MANUAL || type === SCHEDULE_MODE_LIVE) return descriptor({});

  if (type === SCHEDULE_MODE_INTERVAL) {
    const fromHours = source.intervalHours === undefined || source.intervalHours === null
      ? null
      : Math.round(Number(source.intervalHours) * 60 * 60);
    const interval = scheduleSeconds(
      params.interval ?? source.intervalSeconds ?? source.interval ?? fromHours ?? fallbackParams.interval
    );
    return interval ? descriptor({ interval }) : null;
  }

  if (type === SCHEDULE_MODE_RANDOM) {
    const min = scheduleSeconds(params.min ?? source.randomMinSeconds ?? source.min ?? fallbackParams.min);
    const max = scheduleSeconds(params.max ?? source.randomMaxSeconds ?? source.max ?? fallbackParams.max);
    return min && max && min <= max ? descriptor({ min, max }) : null;
  }

  const expr = String(params.expr ?? source.cronExpression ?? source.cron ?? source.expr ?? fallbackParams.expr ?? '').trim();
  const rawTimezone = params.tz ?? source.cronTimezone ?? source.timezone ?? fallbackParams.tz;
  const tz = normalizeCronTimezone(rawTimezone);
  if (!expr || expr.length > 160 || tz === undefined) return null;
  // Keep an imported malformed expression as an unscheduled CRON monitor.
  // The reference defers parsing to next-run calculation and simply returns
  // no due time on failure; rejecting it here would drop the monitor while
  // normalizing stored state.
  return descriptor({ expr, ...(tz !== null ? { tz } : {}) });
}

function scheduleDescriptorOf(monitor) {
  return normalizeScheduleDescriptor(monitor, monitor?.scheduleMode ?? SCHEDULE_MODE_MANUAL, monitor?.schedule ?? null);
}

function isAutomaticSchedule(monitor) {
  const schedule = scheduleDescriptorOf(monitor);
  if (!schedule) return false;
  if (schedule.type === SCHEDULE_MODE_INTERVAL) return schedule.params.interval < INFINITE_SCHEDULE_SECONDS;
  if (schedule.type === SCHEDULE_MODE_RANDOM) {
    return schedule.params.min < INFINITE_SCHEDULE_SECONDS && schedule.params.max < INFINITE_SCHEDULE_SECONDS;
  }
  return schedule.type === SCHEDULE_MODE_CRON;
}

function nextCheckForSchedule(scheduleOrMode, lastCheckedAt, intervalHours, requestedNextCheck = null) {
  const descriptor = scheduleOrMode && typeof scheduleOrMode === 'object'
    ? (scheduleOrMode.type ? normalizeScheduleDescriptor({ schedule: scheduleOrMode }) : scheduleDescriptorOf(scheduleOrMode))
    : normalizeScheduleDescriptor({ scheduleMode: scheduleOrMode, intervalHours }, scheduleOrMode ?? SCHEDULE_MODE_MANUAL);
  if (!descriptor || !isAutomaticSchedule({ schedule: descriptor }) || ![SCHEDULE_MODE_INTERVAL, SCHEDULE_MODE_RANDOM, SCHEDULE_MODE_CRON].includes(descriptor.type)) return null;
  const requested = asIso(requestedNextCheck, null);
  if (requested) return requested;

  const now = Date.now();
  const last = Date.parse(lastCheckedAt ?? '');
  let due;
  if (descriptor.type === SCHEDULE_MODE_INTERVAL) {
    due = Number.isFinite(last) ? Math.max(now, last + descriptor.params.interval * 1_000) + 1_000 : now;
  } else if (descriptor.type === SCHEDULE_MODE_RANDOM) {
    const span = descriptor.params.max - descriptor.params.min;
    const delay = descriptor.params.min + Math.random() * span;
    due = Number.isFinite(last) ? Math.max(now, last + delay * 1_000) + 1_000 : now;
  } else {
    // The reference still parses a CRON expression before using its epoch
    // sentinel for a first baseline. A malformed import is therefore
    // unscheduled rather than treated as immediately due.
    try {
      parseCronExpression(descriptor.params.expr);
    } catch {
      return null;
    }
    // With no run history the reference scheduler uses its epoch sentinel,
    // whose calculated cron time is already in the past; establish the first
    // baseline immediately rather than waiting for the next calendar slot.
    if (!Number.isFinite(last)) {
      due = now;
    } else {
      try {
        due = Math.max(now, nextCronOccurrence(descriptor.params.expr, descriptor.params.tz, last));
      } catch {
        // Reference scheduling treats an unresolvable CRON expression as
        // unscheduled. Do not let one imported monitor prevent the entire
        // storage state from normalizing or force a hot immediate-alarm loop.
        return null;
      }
    }
  }
  return new Date(due).toISOString();
}

function createId() {
  return crypto.randomUUID();
}

function createRevision() {
  return crypto.randomUUID();
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return null;
    }
    if (url.username || url.password) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

// Keep document and application route identity intact for embedded pages.
function normalizeFrameUrl(value) {
  const normalized = normalizeUrl(value);
  if (!normalized) return null;
  try {
    // Fragment routes can identify a different SPA document in an embed.
    return new URL(normalized).href;
  } catch {
    return null;
  }
}

// A site-address migration deliberately operates on the URL host rather than
// doing a string replacement. That preserves every monitored path and query
// while ensuring `old.example` cannot accidentally change a path, label, or
// similarly named subdomain.
function normalizeSiteHost(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > 255) {
    return null;
  }

  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    if (
      !['https:', 'http:'].includes(url.protocol)
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
    ) {
      return null;
    }
    return url.host ? url.host.toLowerCase() : null;
  } catch {
    return null;
  }
}

function siteHostOfUrl(value) {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

function replaceUrlHost(urlValue, sourceHost, targetHost) {
  try {
    const url = new URL(urlValue);
    if (url.host.toLowerCase() !== sourceHost) {
      return null;
    }
    url.host = targetHost;
    return normalizeUrl(url.href);
  } catch {
    return null;
  }
}

function originPattern(urlValue) {
  const url = new URL(urlValue);
  return `${url.protocol}//${url.host}/*`;
}

function cleanSelector(value) {
  const selector = String(value ?? '').trim();
  return selector && selector.length <= 2_000 ? selector : null;
}

function cleanSelectors(value) {
  const source = Array.isArray(value) ? value : [value];
  if (!source.length || source.length > MAX_SELECTORS_PER_MONITOR) {
    return null;
  }

  const selectors = [];
  const seen = new Set();
  for (const item of source) {
    const selector = cleanSelector(typeof item === 'string' ? item : item?.selector);
    if (!selector) {
      return null;
    }
    if (!seen.has(selector)) {
      selectors.push(selector);
      seen.add(selector);
    }
  }
  return selectors.length ? selectors : null;
}

function cleanLocatorField(value) {
  const raw = typeof value === 'string'
    ? { type: value === 'text' ? 'text' : 'attribute', name: value }
    : value && typeof value === 'object'
      ? value
      : null;
  if (!raw) return null;
  let type = String(raw.type ?? raw.kind ?? '').trim().toLowerCase();
  let name = String(raw.name ?? raw.value ?? '').trim();
  if (typeof value === 'string') {
    if (value.startsWith('attr:')) {
      type = 'attribute';
      name = value.slice('attr:'.length).trim();
    } else if (value.startsWith('property:')) {
      type = 'property';
      name = value.slice('property:'.length).trim();
    }
  }
  if (type === 'builtin') type = name === 'text' ? 'text' : '';
  if (!LOCATOR_FIELD_TYPES.has(type)) return null;
  const { type: rawType, kind: rawKind, name: rawName, value: rawValue, ...extensions } = raw;
  if (type === 'text') return { ...extensions, type: 'text' };
  // Attributes are surfaced by the reference picker verbatim, including
  // XML/SVG names such as `xlink:href` and non-ASCII names.  Property access
  // is also bracket-based, so it does not require a JavaScript identifier.
  // Retain the user-visible name and only reject control/markup separators
  // that cannot be an attribute/property field selection.
  if (!name || name.length > 256 || /[\u0000-\u001F\u007F\s]/.test(name)) return null;
  if (type === 'attribute' && /["'<>\/=]/.test(name)) return null;
  return { ...extensions, type, name };
}

function cleanLocatorFields(value) {
  const explicitlyConfigured = value !== undefined && value !== null;
  const source = Array.isArray(value) ? value : explicitlyConfigured ? [value] : [];
  const fields = [];
  // Field order is the extraction order.  In particular, text may appear
  // before/between/after several attributes, and a repeated field remains a
  // deliberate separator in the reference field payload.  Do not dedupe it.
  for (const item of source.slice(0, 256)) {
    const field = cleanLocatorField(item);
    if (field) fields.push(field);
  }
  // Omitted fields mean the familiar text monitor. An explicit empty list is
  // different: it keeps filtered HTML/data while deliberately contributing no
  // text, which is useful for a data-mode structural monitor.
  return fields.length || explicitlyConfigured ? fields : [{ type: 'text' }];
}

function cleanFramePath(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 16) return null;
  const path = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null;
    const url = normalizeFrameUrl(entry.url);
    const indexValue = entry.index ?? entry.siblingIndex;
    const index = Number.isInteger(indexValue)
      ? indexValue
      : typeof indexValue === 'string' && /^\d+$/.test(indexValue.trim())
        ? Number(indexValue)
        : Number.NaN;
    if (!url || !Number.isInteger(index) || index < 0 || index > 10_000) return null;
    const element = entry.element && typeof entry.element === 'object'
      && typeof entry.element.attribute === 'string' && typeof entry.element.value === 'string'
      ? { ...entry.element, attribute: entry.element.attribute.slice(0, 256), value: entry.element.value.slice(0, 2_000) }
      : null;
    const { url: rawUrl, index: rawIndex, siblingIndex: rawSiblingIndex, element: rawElement, ...extensions } = entry;
    path.push({ ...extensions, url, index, ...(element ? { element } : {}) });
  }
  return path;
}

function cleanLocator(value, defaults = {}) {
  const raw = typeof value === 'string' ? { expr: value } : value;
  if (!raw || typeof raw !== 'object') return null;
  const typeAlias = String(raw.type ?? defaults.type ?? 'css').trim().toLowerCase();
  const type = typeAlias === 'extended-css' || typeAlias === 'extendedcss' ? 'xcss' : typeAlias;
  if (!LOCATOR_TYPES.has(type)) return null;
  const expr = cleanSelector(raw.expr ?? raw.selector ?? raw.value);
  if (!expr) return null;
  const operationAlias = String(raw.op ?? raw.operation ?? defaults.op ?? 'include').trim().toLowerCase();
  const op = operationAlias === 'exclude' ? 'exclude' : operationAlias === 'include' ? 'include' : '';
  if (!LOCATOR_OPERATIONS.has(op)) return null;
  const frameValue = raw.frameId ?? raw.frame ?? defaults.frameId ?? 0;
  const frameId = Number.isInteger(frameValue)
    ? frameValue
    : typeof frameValue === 'string' && /^\d+$/.test(frameValue.trim())
      ? Number(frameValue)
      : Number.NaN;
  if (!Number.isInteger(frameId) || frameId < 0 || frameId > 1_000_000) return null;
  // Reference frame configurations have a stable `index` used to process
  // innermost/high-index frames first. Chrome frame IDs are reassigned after
  // navigation, so retain a distinct saved ordering key when a locator has
  // one; legacy locators fall back to their originally saved frame ID.
  const frameOrderValue = raw.frameOrder ?? raw.frameIndex ?? defaults.frameOrder;
  const frameOrder = frameOrderValue === undefined || frameOrderValue === null || frameOrderValue === ''
    ? null
    : Number.isInteger(frameOrderValue)
      ? frameOrderValue
      : typeof frameOrderValue === 'string' && /^\d+$/.test(frameOrderValue.trim())
        ? Number(frameOrderValue)
        : Number.NaN;
  if (frameOrder !== null && (!Number.isInteger(frameOrder) || frameOrder < 0 || frameOrder > 1_000_000)) return null;
  const framePath = cleanFramePath(raw.framePath ?? raw.frameDescriptor);
  if (framePath === null) return null;
  // A Reference nested-frame export can carry only a durable frame URL. Keep
  // it as a deferred descriptor; resolution below accepts it only when exactly
  // one current subframe matches, never by flattening into the top document.
  const frameUrlSource = raw.frameUrl ?? raw.frameUri ?? defaults.frameUrl;
  const frameUrl = frameUrlSource === undefined || frameUrlSource === null || frameUrlSource === ''
    ? null
    : normalizeFrameUrl(frameUrlSource);
  if (frameUrlSource !== undefined && frameUrlSource !== null && frameUrlSource !== '' && !frameUrl) return null;
  // The field list and the fact that it was explicitly supplied are distinct
  // capture instructions. `[]` disables inherited text, while an omitted
  // list lets the selected subtree inherit normal text mode. Preserve that
  // bit through storage instead of flattening both into a default text field.
  const rawDefaultTextOnly = Array.isArray(raw.fields)
    && raw.fields.length === 1
    && String(raw.fields[0]?.type ?? '').toLowerCase() === 'text';
  const fieldsSpecified = raw.fieldsSpecified === true
    // `fields: null` is the same as an omitted field configuration in the
    // locator protocol.  It must inherit its parent's text mode instead of
    // silently becoming an explicit empty override after a save/reload.
    || (raw.fieldsSpecified !== false && Object.hasOwn(raw, 'fields') && raw.fields != null && !rawDefaultTextOnly);
  const knownNames = new Set(['type', 'expr', 'selector', 'value', 'op', 'operation', 'frameId', 'frame', 'frameOrder', 'frameIndex', 'framePath', 'frameDescriptor', 'frameUrl', 'frameUri', 'frameVolatileParameters', 'identityAttribute', 'fields', 'fieldsSpecified']);
  const extensions = Object.fromEntries(Object.entries(raw).filter(([name]) => !knownNames.has(name)));
  return {
    ...extensions,
    type,
    expr,
    op,
    frameId,
    framePath,
    ...(frameOrder !== null ? { frameOrder } : {}),
    ...(frameUrl ? { frameUrl } : {}),
    ...(Array.isArray(raw.frameVolatileParameters) ? {
      frameVolatileParameters: raw.frameVolatileParameters.filter((name) => typeof name === 'string' && name.length <= 256).slice(0, 32)
    } : {}),
    ...(typeof raw.identityAttribute === 'string' && /^[^\s"'<>\/=\u0000-\u001F]{1,256}$/.test(raw.identityAttribute)
      ? { identityAttribute: raw.identityAttribute } : {}),
    fields: cleanLocatorFields(raw.fields),
    ...(fieldsSpecified ? { fieldsSpecified: true } : {})
  };
}

function locatorKey(locator) {
  return [
    locator.type,
    locator.op,
    locator.frameId,
    locator.frameOrder ?? '',
    JSON.stringify(locator.framePath ?? []),
    locator.frameUrl ?? '',
    JSON.stringify(locator.frameVolatileParameters ?? []),
    locator.identityAttribute ?? '',
    locator.expr,
    locator.fieldsSpecified === true ? 'fields:explicit' : 'fields:inherited',
    ...locator.fields.map((field) => `${field.type}:${field.name ?? ''}`)
  ].join('\u0001');
}

function cleanLocators(value) {
  const source = Array.isArray(value) ? value : value == null ? [] : [value];
  // A Reference selection with no frames is a full-page capture.  Materialize
  // that implicit frame here so stored/imported records, the picker API, and
  // the editor all execute the same explicit CSS `body` include.
  if (!source.length) {
    return [cleanLocator({ type: 'css', expr: 'body', op: 'include' })];
  }
  if (source.length > MAX_SELECTORS_PER_MONITOR) return null;
  const locators = [];
  const seen = new Set();
  for (const item of source) {
    const locator = cleanLocator(item);
    if (!locator) return null;
    const key = locatorKey(locator);
    if (seen.has(key)) continue;
    seen.add(key);
    locators.push(locator);
  }
  return locators.some((locator) => locator.op === 'include') ? locators : null;
}

function parseReferenceConfig(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function integerFrameValue(value) {
  if (Number.isInteger(value)) return value;
  return typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : null;
}

// Distill Reference records save HTML selection state separately from their
// feed metadata: `config.selections[0].frames[{ index, includes, excludes }]`.
// Its bare nonzero `index` is a transient browser-frame number, not a durable
// frame identity.  Only translate top-frame selections by default; a nested
// frame needs an explicit OpenStill-compatible id *and* stable path. Rejecting
// the whole record in that case is safer than silently running it in frame 0.
function referenceLocatorsFromConfig(config) {
  const selections = config?.selections;
  if (selections === undefined || selections === null || (Array.isArray(selections) && !selections.length)) {
    return { ok: true, locators: [] };
  }
  if (!Array.isArray(selections) || !selections[0] || typeof selections[0] !== 'object') {
    return { ok: false };
  }

  const frames = selections[0].frames;
  if (frames === undefined || frames === null || (Array.isArray(frames) && !frames.length)) {
    return { ok: true, locators: [] };
  }
  if (!Array.isArray(frames)) return { ok: false };

  const locators = [];
  for (const frame of frames) {
    if (!frame || typeof frame !== 'object') return { ok: false };
    const index = integerFrameValue(frame.index ?? 0);
    if (index === null || index < 0) return { ok: false };

    let defaults;
    if (index === 0) {
      defaults = { frameId: 0 };
    } else {
      const frameId = integerFrameValue(frame.frameId ?? frame.id);
      const framePath = frame.framePath ?? frame.frameDescriptor ?? frame.path;
      if (frameId && Array.isArray(framePath) && framePath.length) {
        defaults = { frameId, frameOrder: index, framePath };
      } else {
        const frameUrl = normalizeFrameUrl(frame.uri ?? frame.url);
        if (!frameUrl) return { ok: false };
        // `index` is retained only for Reference frame ordering.  The runtime
        // resolves this descriptor by its unique frame URL and rejects an
        // ambiguous duplicate rather than treating it as frame zero.
        defaults = { frameId: index, frameOrder: index, frameUrl };
      }
    }

    const includes = frame.includes ?? [];
    const excludes = frame.excludes ?? [];
    if (!Array.isArray(includes) || !Array.isArray(excludes)) return { ok: false };
    // A body default applies only when the frame list itself is absent/empty.
    // For a present frame with no includes, the Reference runner still appends
    // its automatic `base` include; represent that narrow, text-empty capture
    // rather than silently promoting it to the full document body.
    const effectiveIncludes = includes.length
      ? includes
      : [{ type: 'css', expr: 'base' }];
    for (const selector of effectiveIncludes) {
      locators.push(typeof selector === 'string'
        ? { ...defaults, type: 'css', expr: selector, op: 'include' }
        : { ...selector, ...defaults, op: 'include' });
    }
    for (const selector of excludes) {
      locators.push(typeof selector === 'string'
        ? { ...defaults, type: 'css', expr: selector, op: 'exclude' }
        : { ...selector, ...defaults, op: 'exclude' });
    }
  }
  return { ok: true, locators };
}

function referenceTrackingFromConfig(config) {
  const selection = Array.isArray(config?.selections) ? config.selections[0] : null;
  return {
    ...(config && typeof config === 'object' ? config : {}),
    ...(selection && typeof selection === 'object' && selection.delay !== undefined
      ? { delay: selection.delay }
      : {})
  };
}

function isReferenceHtmlRecord(value) {
  const contentType = value?.content_type ?? value?.contentType;
  if (contentType === undefined || contentType === null || contentType === '') return true;
  if (contentType === 2) return true; // Reference C.TYPE_HTML
  const normalized = String(contentType).trim().toLowerCase();
  return normalized === '2' || normalized === 'html' || normalized === 'type_html';
}

function referenceSelectionUri(config) {
  const selection = Array.isArray(config?.selections) ? config.selections[0] : null;
  return selection && typeof selection === 'object' ? selection.uri : null;
}

function displaySelectorsForLocators(locators) {
  return locators
    .filter((locator) => locator.op === 'include')
    .map((locator) => locator.expr);
}

function framePathForFrame(frameId, frames) {
  if (frameId === 0) return [];
  const byId = new Map(frames.map((frame) => [frame.frameId, frame]));
  const path = [];
  let current = byId.get(frameId);
  while (current && current.parentFrameId >= 0) {
    const url = normalizeFrameUrl(current.url);
    if (!url) return null;
    const siblings = frames
      .filter((frame) => frame.parentFrameId === current.parentFrameId && normalizeFrameUrl(frame.url) === url)
      .sort((left, right) => left.frameId - right.frameId);
    const index = siblings.findIndex((frame) => frame.frameId === current.frameId);
    if (index < 0) return null;
    // Transient frame IDs cannot distinguish duplicate embeds after reload.
    // Require the parent DOM identity when a document URL is ambiguous.
    if (siblings.length > 1 && !current.elementIdentity) return null;
    path.unshift({ url, index: current.elementIdentity ? 0 : index, ...(siblings.length > 1 ? { ambiguousUrl: true } : {}),
      ...(current.elementIdentity ? { element: current.elementIdentity } : {}) });
    current = byId.get(current.parentFrameId);
  }
  return current ? path : null;
}

function stableFrameLocation(value, volatileParameters = []) {
  const normalized = normalizeFrameUrl(value);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    // Query parameters can identify different documents. Relax only parameters
    // explicitly declared volatile by this locator.
    for (const name of volatileParameters) url.searchParams.delete(name);
    return url.href;
  } catch {
    return null;
  }
}

function sameFramePath(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((part, index) => part.url === right[index]?.url
      && (part.element
        ? part.element.attribute === right[index]?.element?.attribute && part.element.value === right[index]?.element?.value
        : !right[index]?.ambiguousUrl && part.index === right[index]?.index));
}

function sameRelaxedFramePath(left, right, volatileParameters = []) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((part, index) => (
      (part.element
        ? part.element.attribute === right[index]?.element?.attribute && part.element.value === right[index]?.element?.value
        : !right[index]?.ambiguousUrl && part.index === right[index]?.index)
      && stableFrameLocation(part.url, volatileParameters) === stableFrameLocation(right[index]?.url, volatileParameters)
    ));
}

function resolveLocatorFrame(locator, frames) {
  if (locator.framePath?.length) {
    const exact = frames.filter((frame) => sameFramePath(locator.framePath, framePathForFrame(frame.frameId, frames)));
    if (exact.length === 1) return exact[0].frameId;
    const relaxed = frames.filter((frame) => sameRelaxedFramePath(locator.framePath, framePathForFrame(frame.frameId, frames), locator.frameVolatileParameters));
    if (relaxed.length === 1) return relaxed[0].frameId;
    // A saved path is stronger evidence than Chrome's transient frame id.  Do
    // not silently run a selector in a possibly unrelated frame after a
    // reload: callers turn this sentinel into a clear configuration error.
    return -1;
  }
  if (locator.frameUrl) {
    const exact = frames.filter((frame) => frame.frameId !== 0 && normalizeFrameUrl(frame.url) === locator.frameUrl);
    if (exact.length === 1) return exact[0].frameId;
    const stable = stableFrameLocation(locator.frameUrl, locator.frameVolatileParameters);
    const relaxed = frames.filter((frame) => (
      frame.frameId !== 0 && stableFrameLocation(frame.url, locator.frameVolatileParameters) === stable
    ));
    // A URL-only Reference descriptor is safe only if it names exactly one
    // current subframe. Duplicate embeds remain a visible selection failure.
    return relaxed.length === 1 ? relaxed[0].frameId : -1;
  }
  // A saved subframe ID alone cannot survive a document reload. Preserve the
  // record, but require the user to identify that frame again before capture.
  return Number.isInteger(locator.frameId) && locator.frameId !== 0 ? -1 : 0;
}

// Identify the actual parent iframe by Window identity, including cross-origin
// frames. Messages carry a private random token and never change page DOM.
async function collectStableFrameDescriptors(tabId, frames) {
  if (!frames.some((frame) => frame.frameId !== 0)) return frames;
  const token = crypto.randomUUID();
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: (captureToken) => {
      const records = new Map();
      const elements = [...document.querySelectorAll('iframe,frame')];
      const names = ['id', 'name', 'data-frame-id', 'data-testid', 'data-id'];
      const counts = new Map(names.map((attribute) => [attribute, new Map()]));
      for (const element of elements) for (const attribute of names) {
        const value = element.getAttribute(attribute);
        if (value) counts.get(attribute).set(value, (counts.get(attribute).get(value) || 0) + 1);
      }
      const identityByWindow = new Map();
      for (const element of elements) {
        let identity = null;
        for (const attribute of names) {
          const value = element.getAttribute(attribute);
          if (value && counts.get(attribute).get(value) === 1) { identity = { attribute, value }; break; }
        }
        if (element.contentWindow) identityByWindow.set(element.contentWindow, identity);
      }
      const listener = (event) => {
        if (event.data?.openStillFrameToken !== captureToken) return;
        if (identityByWindow.has(event.source)) records.set(event.data.marker, identityByWindow.get(event.source));
      };
      addEventListener('message', listener);
      const registry = globalThis.__openStillFrameDescriptors || (globalThis.__openStillFrameDescriptors = new Map());
      registry.set(captureToken, { records, listener });
      setTimeout(() => { removeEventListener('message', listener); registry.delete(captureToken); }, 5_000);
    }, args: [token] });
    const markers = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: (captureToken) => {
      const marker = crypto.randomUUID();
      if (parent !== window) parent.postMessage({ openStillFrameToken: captureToken, marker }, '*');
      return marker;
    }, args: [token] });
    const descriptors = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: async (captureToken) => {
      // postMessage delivery is queued; give the parent's listener one turn.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const registry = globalThis.__openStillFrameDescriptors;
      const state = registry?.get(captureToken);
      if (!state) return [];
      removeEventListener('message', state.listener);
      registry.delete(captureToken);
      return [...state.records.entries()];
    }, args: [token] });
    const identityByMarker = new Map(descriptors.flatMap((entry) => Array.isArray(entry.result) ? entry.result : []));
    const identityByFrame = new Map(markers.map((entry) => [entry.frameId, identityByMarker.get(entry.result)]));
    return frames.map((frame) => ({ ...frame, ...(identityByFrame.get(frame.frameId)
      ? { elementIdentity: identityByFrame.get(frame.frameId) } : {}) }));
  } catch {
    // A restricted subframe may disallow injection. URL-unique routes remain
    // usable, while duplicate routes fail closed in framePathForFrame().
    return frames;
  }
}

function cleanRegularExpression(value) {
  const source = typeof value === 'string'
    // Legacy string configuration follows the reference default flags rather
    // than silently becoming case-sensitive and single-line only.
    ? { expr: value, flags: 'gim' }
    : value && typeof value === 'object' ? value : null;
  if (!source) return null;
  const expr = String(source.expr ?? source.pattern ?? source.value ?? '').trim();
  const flags = String(source.flags ?? '').trim();
  if (!expr) return null;
  if (expr.length > 1_000 || flags.length > 12 || !/^[dgimsuvy]*$/.test(flags) || new Set(flags).size !== flags.length) {
    return null;
  }
  try {
    // Validate in the same JavaScript regexp engine used for a later capture.
    // `u` and `v` are mutually exclusive even in engines that support both.
    if (flags.includes('u') && flags.includes('v')) return null;
    new RegExp(expr, flags);
    return { expr, flags };
  } catch {
    return null;
  }
}

function hasInvalidConfiguredRegularExpression(value) {
  const source = value && typeof value === 'object' ? value : {};
  const candidate = source.regexp ?? source.regex ?? source.textFilter;
  if (candidate === undefined || candidate === null || candidate === '') return false;
  if (typeof candidate === 'object' && !String(candidate.expr ?? candidate.pattern ?? candidate.value ?? '').trim()) return false;
  return !cleanRegularExpression(candidate);
}

const LEGACY_TRACKING_FIELDS = new Set(['dataAttr', 'compare', 'comparison', 'ignoreWhitespace', 'allowEmpty', 'ignoreEmptyText', 'regexp', 'regex', 'textFilter', 'includeScript', 'includeScripts', 'includeStyle', 'includeStyles', 'keepComments', 'live', 'liveMonitoring', 'delayMilliseconds', 'delay', 'timeoutMilliseconds', 'timeout']);
function legacyTrackingSettings(value) {
  return Object.fromEntries(Object.entries(value && typeof value === 'object' ? value : {}).filter(([name]) => LEGACY_TRACKING_FIELDS.has(name)));
}
function normalizeTracking(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const requestedDataAttr = String(input.dataAttr ?? input.compare ?? input.comparison ?? 'text').toLowerCase();
  const dataAttr = requestedDataAttr === 'data' || requestedDataAttr === 'html' ? 'data' : 'text';
  const delayMilliseconds = Object.hasOwn(input, 'delayMilliseconds')
    ? Number(input.delayMilliseconds)
    : Number(input.delay ?? 0) * 1_000;
  const timeoutMilliseconds = Object.hasOwn(input, 'timeoutMilliseconds')
    ? Number(input.timeoutMilliseconds)
    : Object.hasOwn(input, 'timeout')
      ? Number(input.timeout) * 1_000
      : CHECK_EXECUTION_TIMEOUT_MS;
  return {
    ...input,
    dataAttr,
    ignoreWhitespace: input.ignoreWhitespace !== false,
    allowEmpty: input.allowEmpty === true || input.ignoreEmptyText === false,
    regexp: cleanRegularExpression(input.regexp ?? input.regex ?? input.textFilter),
    includeScript: input.includeScript === true || input.includeScripts === true,
    includeStyle: input.includeStyle === true || input.includeStyles === true,
    keepComments: input.keepComments === true,
    live: input.live === true || input.liveMonitoring === true,
    delayMilliseconds: Number.isFinite(delayMilliseconds)
      ? Math.max(0, Math.min(60_000, Math.round(delayMilliseconds)))
      : 0,
    timeoutMilliseconds: Number.isFinite(timeoutMilliseconds)
      ? Math.max(MIN_CHECK_EXECUTION_TIMEOUT_MS, Math.min(MAX_CHECK_EXECUTION_TIMEOUT_MS, Math.round(timeoutMilliseconds)))
      : CHECK_EXECUTION_TIMEOUT_MS
  };
}

async function filterCapturedText(text, tracking, itemTexts = null) {
  const regexp = normalizeTracking(tracking).regexp;
  const source = String(text ?? '');
  if (!regexp) return itemTexts === null ? source : { text: source, itemTexts };
  await ensureOffscreenDocument();
  const result = await timeout(chrome.runtime.sendMessage({
    type: 'filter-captured-text', text: source, regexp, itemTexts, timeoutMilliseconds: 1_500
  }), 2_500, '정규식 필터 응답 시간이 초과됐습니다. 이전 정상 자료를 유지합니다.');
  if (!result?.ok) throw new Error(result?.error || '정규식 필터를 완료하지 못했습니다.');
  return itemTexts === null ? String(result.text ?? '') : {
    text: String(result.text ?? ''),
    itemTexts: Array.isArray(result.itemTexts) ? result.itemTexts.map((value) => String(value ?? '')) : []
  };
}

function snapshotTextFromItems(items) {
  return items.map((item) => item.text).join('\n\n');
}

function snapshotHtmlFromItems(items) {
  return items.map((item) => item.html).filter(Boolean).join('\n');
}

function normalizeSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  if (Object.hasOwn(value, '$snapshot') || Object.hasOwn(value, 'previewVersion')) {
    const { $snapshot, previewVersion, ...payload } = value;
    value = { ...payload, referenceMarkerIgnored: true };
  }
  if (value.contentOmitted === true) return { ...value, exists: value.exists !== false, contentOmitted: true, items: [], text: '', html: '', data: '', capturedAt: asIso(value.capturedAt) };
  const matchCount = typeof value.matchCount === 'number'
    ? value.matchCount
    : typeof value.matchCount === 'string' && /^\d+$/.test(value.matchCount.trim())
      ? Number(value.matchCount)
      : Number.NaN;
  const rawItems = Array.isArray(value.items) ? value.items.filter((item) => item && typeof item === 'object' && !Array.isArray(item) && (typeof item.text === 'string' || typeof item.html === 'string')) : [];
  const fullItemTexts = rawItems.map((item) => cleanSnapshotText(item?.text, Number.MAX_SAFE_INTEGER));
  const fullText = typeof value.text === 'string'
    ? cleanSnapshotText(value.text, Number.MAX_SAFE_INTEGER)
    : fullItemTexts.join('\n\n');
  const itemCount = Math.min(rawItems.length, MAX_COLLECTION_ITEMS);
  const separatorLength = Math.max(0, itemCount - 1) * 2;
  let remaining = Math.max(0, MAX_SNAPSHOT_CHARS - separatorLength);
  let remainingHtml = MAX_SNAPSHOT_CHARS;
  let itemTruncated = rawItems.length > MAX_COLLECTION_ITEMS;
  const items = rawItems.slice(0, MAX_COLLECTION_ITEMS).map((item, index) => {
    const text = fullItemTexts[index].slice(0, remaining);
    const fullItemHtml = cleanSnapshotHtml(item.html, Number.MAX_SAFE_INTEGER);
    const itemHtml = fullItemHtml.slice(0, remainingHtml); remainingHtml -= itemHtml.length;
    remaining -= text.length;
    if (text.length < fullItemTexts[index].length) itemTruncated = true;
    return { ...item, text, html: itemHtml,
      textFingerprint: item.textTruncated && item.textFingerprint || snapshotFingerprint(fullItemTexts[index]),
      compactTextFingerprint: item.textTruncated && item.compactTextFingerprint || snapshotFingerprint(fullItemTexts[index].replace(/\s/g, '')),
      tokenTextFingerprint: item.textTruncated && item.tokenTextFingerprint || comparisonTokenFingerprint(fullItemTexts[index]),
      htmlFingerprint: item.htmlTruncated && item.htmlFingerprint || snapshotFingerprint(fullItemHtml),
      compactHtmlFingerprint: item.htmlTruncated && item.compactHtmlFingerprint || snapshotFingerprint(fullItemHtml.replace(/\s/g, '')),
      tokenHtmlFingerprint: item.htmlTruncated && item.tokenHtmlFingerprint || comparisonTokenFingerprint(fullItemHtml),
      htmlTruncated: item.htmlTruncated === true || fullItemHtml.length > itemHtml.length,
      textTruncated: item.textTruncated === true || text.length < fullItemTexts[index].length };
  });
  if (!items.length && fullText) items.push({ text: fullText.slice(0, MAX_SNAPSHOT_CHARS) });
  const fullHtml = cleanSnapshotHtml(
    typeof value.html === 'string' ? value.html : snapshotHtmlFromItems(rawItems),
    Number.MAX_SAFE_INTEGER
  );
  const fullData = cleanSnapshotHtml(
    typeof value.data === 'string' ? value.data : fullHtml,
    Number.MAX_SAFE_INTEGER
  );
  const html = fullHtml.slice(0, MAX_SNAPSHOT_CHARS);
  const data = fullData.slice(0, MAX_SNAPSHOT_CHARS);
  const evidenceHtml = cleanSnapshotHtml(value.evidenceHtml, MAX_SNAPSHOT_CHARS);
  const safeMatchCount = Number.isInteger(matchCount) && matchCount >= 0
    ? matchCount
    : items.length;
  // `exists` records whether the extractor found a meaningful selected root;
  // it is deliberately independent from whether there is textual content.
  // An allow-empty monitor must retain its filtered HTML/data even at zero
  // matches so a later structural reappearance can be compared faithfully.
  const exists = typeof value.exists === 'boolean' ? value.exists : Boolean(safeMatchCount || fullText || fullHtml || fullData);
  const retainPayload = exists
    || rawItems.length > 0
    || Boolean(fullText)
    || Boolean(fullHtml)
    || Boolean(fullData);
  // Older OpenStill snapshots used the same digest algorithm before an
  // explicit version field existed. Their original digest is still evidence
  // for a truncated payload; hashing the stored prefix would destroy it.
  const supportedFingerprints = value.fingerprintVersion === 1 || value.fingerprintVersion == null;

  return {
    ...value,
    schemaVersion: 1,
    fingerprintVersion: 1,
    exists,
    matchCount: safeMatchCount,
    text: retainPayload ? fullText.slice(0, MAX_SNAPSHOT_CHARS) : '',
    html: retainPayload ? html : '',
    data: retainPayload ? data : '',
    evidenceHtml,
    items: retainPayload ? items : [],
    textFingerprint: supportedFingerprints && value.textTruncated && value.textFingerprint || snapshotFingerprint(fullText),
    compactTextFingerprint: supportedFingerprints && value.textTruncated && value.compactTextFingerprint || snapshotFingerprint(fullText.replace(/\s/g, '')),
    tokenTextFingerprint: supportedFingerprints && value.textTruncated && value.tokenTextFingerprint || comparisonTokenFingerprint(fullText),
    dataFingerprint: supportedFingerprints && value.dataTruncated && value.dataFingerprint || snapshotFingerprint(fullData),
    compactDataFingerprint: supportedFingerprints && value.dataTruncated && value.compactDataFingerprint || snapshotFingerprint(fullData.replace(/\s/g, '')),
    tokenDataFingerprint: supportedFingerprints && value.dataTruncated && value.tokenDataFingerprint || comparisonTokenFingerprint(fullData),
    textOriginalLength: Math.max(fullText.length, Number(value.textOriginalLength) || 0),
    dataOriginalLength: Math.max(fullData.length, Number(value.dataOriginalLength) || 0),
    textStoredLength: Math.min(fullText.length, MAX_SNAPSHOT_CHARS),
    dataStoredLength: data.length,
    textTruncated: value.textTruncated === true || itemTruncated || fullText.length > MAX_SNAPSHOT_CHARS,
    dataTruncated: value.dataTruncated === true || fullData.length > MAX_SNAPSHOT_CHARS,
    ...(typeof value.exists !== 'boolean' ? { existsInferred: true } : {}),
    capturedAt: asIso(value.capturedAt, null)
  };
}

function snapshotsEqual(left, right, tracking = null) {
  // Match count and individual-root boundaries are presentation metadata, not
  // a change by themselves. The selected representation is explicit, though:
  // `text` preserves the familiar whitespace-insensitive monitor behaviour,
  // while `data` compares the filtered HTML so a changed href/src is visible.
  const options = normalizeTracking(tracking);
  const identityComparison = compareSnapshotIdentities(left, right, options);
  if (identityComparison) return identityComparison.equal;
  const field = options.dataAttr === 'data' ? 'data' : 'text';
  const fingerprintField = field === 'data'
    ? options.ignoreWhitespace ? 'compactDataFingerprint' : 'tokenDataFingerprint'
    : options.ignoreWhitespace ? 'compactTextFingerprint' : 'tokenTextFingerprint';
  const truncatedField = field === 'data' ? 'dataTruncated' : 'textTruncated';
  const fingerprintComparable = left?.[fingerprintField] && right?.[fingerprintField]
    && (left?.[truncatedField] || right?.[truncatedField])
    ? left[fingerprintField] === right[fingerprintField]
    : null;
  const comparable = options.ignoreWhitespace
    ? String(left?.[field] ?? '').replace(/\s/g, '') === String(right?.[field] ?? '').replace(/\s/g, '')
    : comparisonTokensEqual(left?.[field], right?.[field]);
  // `exists` is extraction/control-flow metadata. Once allow-empty mode has
  // admitted an empty result, the reference comparison is still solely the
  // configured text/data payload; a matched empty element and a missing
  // element with the same payload are not a synthetic content change.
  return Boolean(left && right) && (fingerprintComparable ?? comparable);
}
function compareSnapshotIdentities(left, right, tracking = null) {
  const options = normalizeTracking(tracking); const field = options.dataAttr === 'data' ? 'html' : 'text';
  const keyOf = (item) => {
    const explicit = item?.identity?.key ?? item?.identityKey;
    if (!explicit) return null;
    const configured = [item.locator, ...(Array.isArray(item.locators) ? item.locators : [])];
    const volatile = new Set(configured.flatMap((locator) => Array.isArray(locator?.frameVolatileParameters) ? locator.frameVolatileParameters.filter((name) => typeof name === 'string') : []));
    const stableUrl = (value) => {
      if (!volatile.size) return value ?? '';
      try { const url = new URL(value); for (const parameter of volatile) url.searchParams.delete(parameter); return url.href; } catch { return value ?? ''; }
    };
    const frame = item.frame;
    const scope = frame ? JSON.stringify([stableUrl(frame.url), (Array.isArray(frame.path) ? frame.path : []).map((part) => [stableUrl(part.url), part.element?.attribute ?? '', part.element?.value ?? ''])]) : '';
    return `identity:${scope}:${explicit}`;
  };
  const oldItems = left?.items || []; const newItems = right?.items || [];
  if ((!oldItems.length && !newItems.length) || oldItems.some((item) => !keyOf(item)) || newItems.some((item) => !keyOf(item))) return null;
  const valueOf = (item) => options.ignoreWhitespace ? String(item[field] || '').replace(/\s/g, '') : comparisonTokens(item[field]).join('\u0000');
  const entries = (items) => items.map((item) => keyOf(item) + '\u0000' + (item[field + 'Truncated']
    ? item[(options.ignoreWhitespace ? 'compact' : 'token') + (field === 'text' ? 'Text' : 'Html') + 'Fingerprint'] || item[field + 'Fingerprint']
    : snapshotFingerprint(valueOf(item)))).sort();
  const oldValues = entries(oldItems); const newValues = entries(newItems);
  return { equal: oldValues.length === newValues.length && oldValues.every((value, index) => value === newValues[index]),
    orderChanged: oldItems.map(keyOf).join('\u0000') !== newItems.map(keyOf).join('\u0000') };
}

function normalizeMonitor(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const hasExplicitLocators = Object.hasOwn(value, 'locators') || Object.hasOwn(value, 'selectors');
  const rawReferenceConfig = value.config;
  const referenceConfig = parseReferenceConfig(rawReferenceConfig);
  const isReferenceRecord = Object.hasOwn(value, 'uri') && (
    !Object.hasOwn(value, 'url')
    || Object.hasOwn(value, 'config')
    || Object.hasOwn(value, 'content_type')
    || Object.hasOwn(value, 'state')
  );
  const usesReferenceSelection = !hasExplicitLocators && (
    isReferenceRecord
    || Boolean(referenceConfig && Object.hasOwn(referenceConfig, 'selections'))
  );
  const referenceSelection = usesReferenceSelection
    ? (rawReferenceConfig === undefined || rawReferenceConfig === null || rawReferenceConfig === ''
      ? { ok: true, locators: [] }
      : referenceConfig
        ? referenceLocatorsFromConfig(referenceConfig)
        : { ok: false })
    : null;
  if (isReferenceRecord && !isReferenceHtmlRecord(value)) return null;
  const url = isReferenceRecord
    ? normalizeUrl(referenceSelectionUri(referenceConfig)) ?? normalizeUrl(value.uri ?? value.url)
    : normalizeUrl(value.url);
  let locators = usesReferenceSelection
    ? referenceSelection?.ok ? cleanLocators(referenceSelection.locators) : null
    : cleanLocators(value.locators ?? value.selectors);
  const repairIssues = [...(Array.isArray(value.recoveryIssues) ? value.recoveryIssues : [])];
  if (!locators) {
    const source = usesReferenceSelection ? referenceSelection?.locators : value.locators ?? value.selectors;
    locators = (Array.isArray(source) ? source : [source]).map((item) => cleanLocator(item)).filter(Boolean).slice(0, MAX_SELECTORS_PER_MONITOR);
    repairIssues.push('선택자 일부가 손상되어 실행을 일시정지했습니다.');
  }
  const selectors = displaySelectorsForLocators(locators);
  // Pre-manual-mode monitors always used an interval. Newer records retain a
  // reference-style descriptor so RANDOM, CRON, and LIVE survive export and
  // worker restarts without being flattened into an hour count.
  let schedule = normalizeScheduleDescriptor(
    value,
    isReferenceRecord ? SCHEDULE_MODE_MANUAL : SCHEDULE_MODE_INTERVAL
  );
  if (!schedule || schedule.type === SCHEDULE_MODE_CRON && !parseCronExpression(schedule.params.expr)) {
    schedule = normalizeScheduleDescriptor({ schedule: { ...(parseScheduleObject(value.schedule) || {}), type: SCHEDULE_MODE_MANUAL } }, SCHEDULE_MODE_MANUAL);
    repairIssues.push('일정이 손상되어 수동 확인으로 복구했습니다.');
  }
  const scheduleMode = schedule?.type;
  const intervalHours = scheduleMode === SCHEDULE_MODE_INTERVAL
    ? schedule.params.interval / 3_600
    : clampInterval(value.intervalHours) ?? MIN_INTERVAL_HOURS;
  if (!url) {
    return null;
  }
  const createdAt = asIso(value.createdAt ?? (isReferenceRecord ? value.ts : undefined), '1970-01-01T00:00:00.000Z');
  // A Reference backup does not carry its complete run log. `ts_data` is the
  // last persisted data change, so use it as the best durable lower bound for
  // both the comparison/change timestamp and the next scheduler calculation.
  const lastCheckedAt = asIso(value.lastCheckedAt ?? (isReferenceRecord ? value.ts_data : undefined), null);
  const lastChangedAt = asIso(value.lastChangedAt ?? (isReferenceRecord ? value.ts_data : undefined), null);
  const lastViewedAt = asIso(value.lastViewedAt ?? value.lastReadAt ?? (isReferenceRecord ? value.ts_view : undefined), null);
  const status = VALID_STATUSES.has(value.status) ? value.status : 'ok';
  const trackingSource = value.tracking
    ?? (isReferenceRecord && referenceConfig ? referenceTrackingFromConfig(referenceConfig) : legacyTrackingSettings(value));
  const tracking = normalizeTracking(scheduleMode === SCHEDULE_MODE_LIVE
    ? { ...(trackingSource && typeof trackingSource === 'object' ? trackingSource : {}), live: true }
    : trackingSource);
  const normalizedSnapshot = normalizeSnapshot(value.snapshot);
  // A no-match result is never a baseline. Keeping it here would make the
  // next successful render look like an element deletion/reappearance change.
  let snapshot = normalizedSnapshot && !normalizedSnapshot.contentOmitted && (normalizedSnapshot.exists || tracking.allowEmpty)
    ? normalizedSnapshot
    : null;
  const lastChange = value.lastChange && typeof value.lastChange === 'object'
    ? {
        ...value.lastChange,
        previous: normalizeSnapshot(value.lastChange.previous),
        current: normalizeSnapshot(value.lastChange.current),
        id: value.lastChange.id || value.lastChange.detectedAt || null,
        detectedAt: asIso(value.lastChange.detectedAt, null)
      }
    : null;
  const lastErrorSnapshot = normalizeSnapshot(value.lastErrorSnapshot);
  const recoveredHistory = Array.isArray(value.history)
    ? value.history.map((entry) => {
        const snapshot = normalizeSnapshot(entry?.snapshot ?? entry);
        return snapshot && (snapshot.exists || tracking.allowEmpty || snapshot.contentUnavailable)
          ? {
              ...(entry?.snapshot ? entry : {}),
              snapshot,
              capturedAt: asIso(entry?.capturedAt ?? snapshot.capturedAt, null),
              kind: entry?.kind === 'baseline' ? 'baseline' : 'change'
            }
          : null;
      }).filter(Boolean)
    : [];
  const history = recoveredHistory.slice(0, MAX_CHANGE_HISTORY);
  const runs = Array.isArray(value.runs)
    ? value.runs.map((entry) => ({
        ...(entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}),
        at: asIso(entry?.at ?? entry?.checkedAt, null),
        status: VALID_STATUSES.has(entry?.status) ? entry.status : 'error',
        code: cleanShortText(entry?.code, 80) || null,
        message: cleanShortText(entry?.message ?? entry?.error, 300) || null,
        changed: Boolean(entry?.changed),
        matchCount: Number.isInteger(entry?.matchCount) && entry.matchCount >= 0 ? entry.matchCount : null
      })).filter((entry) => entry.at).slice(0, MAX_RUN_HISTORY)
    : [];

  const rawId = value.id ?? value.uuid;
  const stableKey = snapshotFingerprint(JSON.stringify(value));
  const id = (typeof rawId === 'string' || typeof rawId === 'number') && String(rawId).trim()
    ? String(rawId).trim().slice(0, 100)
    : 'recovered-' + stableKey;
  const revision = typeof value.revision === 'string' && value.revision.trim() && value.revision.length <= 100
    ? value.revision.trim()
    : 'recovered-revision-' + stableKey;
  if (!snapshot) {
    const candidate = [lastChange?.current, ...recoveredHistory.map((entry) => entry.snapshot)].find((item) => item && !item.contentOmitted && (item.exists || tracking.allowEmpty));
    if (candidate) { snapshot = candidate; repairIssues.push('최근 정상 변경/이력에서 기준 내용을 회수했습니다.'); }
  }
  const supportedVersion = !(Number(value.schemaVersion) > 1);
  if (!supportedVersion) repairIssues.push('지원하지 않는 레코드 버전이므로 원본을 보존하고 실행을 중지했습니다.');
  const repairedEnabled = isReferenceRecord ? Number(value.state) === 40
    : value.enabled === undefined ? true : value.enabled === true || value.enabled === 'true';
  const safeRepairs = [...(Array.isArray(value.recoveryRepairs) ? value.recoveryRepairs : [])];
  for (const field of ['createdAt', 'updatedAt', 'lastCheckedAt', 'lastChangedAt', 'lastViewedAt', 'lastReadAt', 'nextCheckAt']) {
    if (value[field] != null && asIso(value[field], null) === null) safeRepairs.push(`${field}: 유효하지 않은 날짜를 수리했습니다.`);
  }
  if (typeof value.enabled === 'string' && ['true', 'false'].includes(value.enabled.trim())) safeRepairs.push('enabled: 문자열 boolean을 수리했습니다.');
  if (id !== String(rawId ?? '')) safeRepairs.push('id: 누락되거나 공백이 있는 ID를 안정적으로 수리했습니다.');
  if (!value.revision || revision !== value.revision) safeRepairs.push('revision: 누락되거나 잘못된 값을 안정적으로 수리했습니다.');
  if (normalizedSnapshot?.existsInferred) safeRepairs.push('snapshot.exists: 남은 본문과 일치 수에서 추론했습니다.');
  if (normalizedSnapshot?.referenceMarkerIgnored) safeRepairs.push('snapshot: 외부 레코드의 내부 참조 표식을 제거하고 본문을 보존했습니다.');
  if (Array.isArray(value.snapshot?.items) && value.snapshot.items.some((item) => !item || typeof item !== 'object' || Array.isArray(item) || !(typeof item.text === 'string' || typeof item.html === 'string'))) safeRepairs.push('snapshot.items: 손상 항목을 격리하고 정상 aggregate 본문을 회수했습니다.');

  return {
    ...value,
    schemaVersion: supportedVersion ? 1 : value.schemaVersion,
    ...(!supportedVersion ? { unsupportedOriginal: value.unsupportedOriginal || value } : {}),
    id,
    revision,
    name: cleanText(value.name, 120) || cleanText(value.pageTitle ?? value.title, 120) || new URL(url).hostname,
    url,
    pageTitle: cleanText(value.pageTitle ?? value.title, 180),
    selectors,
    locators,
    tracking,
    labels: cleanLabels(value.labels ?? value.tags),
    schedule,
    scheduleMode,
    intervalHours,
    ...(scheduleMode === SCHEDULE_MODE_INTERVAL ? { intervalSeconds: schedule.params.interval } : {}),
    enabled: repairedEnabled && !repairIssues.length,
    recoveryIssues: [...new Set(repairIssues)],
    recoveryRepairs: [...new Set(safeRepairs)],
    createdAt,
    updatedAt: asIso(value.updatedAt ?? (isReferenceRecord ? value.ts_mod ?? value.ts : undefined), createdAt),
    lastCheckedAt,
    lastChangedAt,
    nextCheckAt: nextCheckForSchedule(schedule, lastCheckedAt, intervalHours, value.nextCheckAt),
    snapshot,
    lastChange,
    lastErrorSnapshot,
    history,
    runs,
    lastReviewAt: asIso(value.lastReviewAt, null),
    lastViewedAt,
    lastError: cleanText(value.lastError, 300) || null,
    status,
    unread: lastChangedAt && (!lastViewedAt || Date.parse(lastViewedAt) < Date.parse(lastChangedAt))
      ? true
      : Boolean(value.unread)
  };
}

function normalizeSettings(value) {
  return {
    ...DEFAULT_SETTINGS,
    ...(value && typeof value === 'object' ? { ...value, soundEnabled: value.soundEnabled !== false } : {})
  };
}

async function getState() {
  const state = await loadMonitorRepository();
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { monitors: [...state.monitors.values()], settings: normalizeSettings(await OpenStillRecordStore.getAux('meta', 'settings') ?? stored[SETTINGS_KEY]), recovery: state.diagnostics };
}

let monitorRepository;
let repositoryLoading;
const RECORDS_CHANGED_KEY = 'openStill.records.changed.v1';
function recordsFromContainer(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    for (const key of ['monitors', 'records', 'sieves', 'sieve_backup']) if (Array.isArray(raw[key])) return raw[key];
    if (raw.url || raw.uri) return [raw];
    return Object.values(raw).filter((value) => value && typeof value === 'object');
  }
  return [];
}
async function loadMonitorRepository() {
  if (monitorRepository) return monitorRepository;
  if (!repositoryLoading) repositoryLoading = (async () => {
    const stored = await OpenStillRecordStore.load({ lazy: true });
    const legacy = stored ? null : (await chrome.storage.local.get(MONITORS_KEY))[MONITORS_KEY];
    const rawRecords = stored ? stored.monitors : recordsFromContainer(legacy);
    const monitors = new Map(); const recovery = [...(stored?.recovery || [])]; let repaired = 0;
    for (let index = 0; index < rawRecords.length; index += 1) {
      const raw = rawRecords[index]; let monitor;
      try { monitor = stored && raw?.schemaVersion === 1 ? raw : normalizeMonitor(raw); } catch { monitor = null; }
      if (!monitor) {
        recovery.push({ id: 'legacy-invalid-' + index, raw, source: 'legacy', recordIndex: index, error: '레코드 해석 실패' });
        continue;
      }
      if (monitors.has(monitor.id)) {
        const originalId = monitor.id;
        monitor = { ...monitor, id: originalId.slice(0, 75) + '-recovered-' + index, recoveredFromId: originalId, enabled: false };
        repaired += 1;
      }
      if (monitor.recoveryIssues?.length || monitor.recoveryRepairs?.length) repaired += 1;
      monitors.set(monitor.id, monitor);
    }
    if (!stored && legacy !== undefined) recovery.unshift({ id: 'legacy-container', source: 'migration-original', raw: legacy, capturedAt: nowIso(), error: Array.isArray(legacy) ? null : '배열이 아닌 원본 컨테이너에서 정상 레코드를 회수했습니다.' });
    const summaries = new Map([...monitors].map(([id, monitor]) => [id, dashboardMonitorSummary(monitor)]));
    monitorRepository = { monitors, summaries, recovery, generation: stored?.generation || 0, migrated: Boolean(stored), diagnostics: { sourceCount: rawRecords.length, normalCount: monitors.size, repairedCount: repaired, recoveryPendingCount: recovery.filter((entry) => entry.source !== 'migration-original').length } };
    return monitorRepository;
  })().catch((error) => { repositoryLoading = null; throw error; });
  return repositoryLoading;
}
const hydratedMonitorIds = new Map();
const hydrationInProgress = new Map();
const repairedMonitorShells = new Map();
const MAX_HYDRATED_MONITOR_BYTES = 32 * 1024 * 1024;
async function getMonitorMetadataById(id) { return (await loadMonitorRepository()).monitors.get(id) || null; }
function monitorBodyBytes(monitor) {
  const snapshots = new Set([monitor.snapshot, monitor.lastErrorSnapshot, monitor.lastChange?.previous, monitor.lastChange?.current, ...(monitor.history || []).map((entry) => entry.snapshot)].filter(Boolean));
  let bytes = 0;
  for (const snapshot of snapshots) {
    bytes += 2 * (String(snapshot.text || '').length + String(snapshot.html || '').length + String(snapshot.data || '').length);
    for (const item of snapshot.items || []) bytes += 2 * (String(item.text || '').length + String(item.html || '').length);
  }
  return bytes;
}
async function trimHydratedMonitors(protectedId) {
  let bytes = [...hydratedMonitorIds.values()].reduce((sum, size) => sum + size, 0);
  const repository = await loadMonitorRepository();
  for (const [id, size] of hydratedMonitorIds) {
    if (bytes <= MAX_HYDRATED_MONITOR_BYTES) break;
    if (id === protectedId || checksInProgress.has(id) || typeof captureTasks !== 'undefined' && captureTasks.has(id)) continue;
    const pendingRepair = repository.recovery.some((entry) => entry.source === 'records' && entry.recordId === id);
    if (pendingRepair && repairedMonitorShells.has(id)) repository.monitors.set(id, repairedMonitorShells.get(id));
    else {
      const envelope = await OpenStillRecordStore.getAux('monitors', id);
      if (envelope?.record) repository.monitors.set(id, envelope.record);
      repairedMonitorShells.delete(id);
    }
    hydratedMonitorIds.delete(id); bytes -= size;
  }
}
// Read each reference independently: an unreadable history entry must not
// discard a verified current baseline or the rest of the change history.
async function hydrateMonitorSnapshotsIndependently(record, { versions = null } = {}) {
  const cache = new Map(); const references = new Map(); const failed = new Map(); const recovery = new Map();
  const damagedFields = [];
  async function read(value, field) {
    if (!value?.$snapshot) return value;
    const snapshotId = value.$snapshot;
    let damage = failed.get(snapshotId);
    if (!damage) {
      try {
        const unpacked = await OpenStillRecordStore.unpack({ snapshot: value }, cache);
        for (const entry of unpacked._storageRecovery || []) recovery.set(entry.id, entry);
        references.set(unpacked.snapshot, value);
        return unpacked.snapshot;
      } catch (error) {
        // A failed storage read is retryable, not evidence of damaged data.
        if (!error.snapshotDamage) throw error;
        damage = { ...error.snapshotDamage, error: responseError(error), fields: [] };
        failed.set(snapshotId, damage);
      }
    }
    damage.fields.push(field); damagedFields.push(field);
    return { exists: Boolean(value.exists), contentOmitted: true, contentUnavailable: true,
      snapshotId, capturedAt: value.capturedAt || null, matchCount: value.matchCount ?? 0 };
  }
  const hydrated = { ...record,
    snapshot: await read(record.snapshot, 'snapshot'),
    lastErrorSnapshot: await read(record.lastErrorSnapshot, 'lastErrorSnapshot'),
    lastChange: record.lastChange ? { ...record.lastChange,
      previous: await read(record.lastChange.previous, 'lastChange.previous'),
      current: await read(record.lastChange.current, 'lastChange.current') } : null,
    history: [] };
  for (let index = 0; index < (record.history || []).length; index += 1) {
    const entry = record.history[index];
    hydrated.history.push({ ...entry, snapshot: await read(entry.snapshot, `history.${index}.snapshot`) });
  }
  if (damagedFields.includes('snapshot')) {
    const usable = (value) => value && !value.contentOmitted && !value.contentUnavailable && (value.exists || normalizeTracking(record.tracking).allowEmpty);
    hydrated.snapshot = [hydrated.lastChange?.current, ...hydrated.history.map((entry) => entry.snapshot), hydrated.lastChange?.previous].find(usable) || null;
    if (!hydrated.snapshot && typeof versions === 'function') {
      for (const envelope of await versions()) {
        if (!envelope?.record || await OpenStillRecordStore.digest(JSON.stringify(envelope.record)) !== envelope.digest) continue;
        const candidate = await read(envelope.record.snapshot, 'older.snapshot');
        if (usable(candidate)) { hydrated.snapshot = candidate; break; }
      }
    }
  }
  for (const damage of failed.values()) recovery.set('damaged-snapshot-' + damage.snapshotId, {
    id: 'damaged-snapshot-' + damage.snapshotId, source: 'snapshots', recordId: record.id,
    snapshotId: damage.snapshotId, raw: damage.raw, copyRaw: damage.copyRaw, fields: damage.fields, error: damage.error });
  if (damagedFields.length) {
    hydrated.enabled = false; hydrated.status = 'needs-review';
    hydrated.lastError = '일부 저장 자료가 손상되어 정상 내용만 회수하고 원본을 복구함에 보관했습니다.';
    hydrated.recoveryIssues = [...new Set([...(record.recoveryIssues || []), '손상된 저장 내용: ' + damagedFields.join(', ')])];
  }
  delete hydrated._storageRecovery;
  const compact = (snapshot) => references.get(snapshot) || snapshot;
  const shell = { ...hydrated, snapshot: compact(hydrated.snapshot), lastErrorSnapshot: compact(hydrated.lastErrorSnapshot),
    lastChange: hydrated.lastChange ? { ...hydrated.lastChange, previous: compact(hydrated.lastChange.previous), current: compact(hydrated.lastChange.current) } : null,
    history: hydrated.history.map((entry) => ({ ...entry, snapshot: compact(entry.snapshot) })) };
  return { monitor: hydrated, shell, recovery: [...recovery.values()], damagedFields };
}
async function getMonitorById(id) {
  const repository = await loadMonitorRepository();
  const monitor = repository.monitors.get(id);
  if (!monitor) return null;
  const referenced = monitor.snapshot?.$snapshot || monitor.lastErrorSnapshot?.$snapshot || monitor.lastChange?.previous?.$snapshot || monitor.lastChange?.current?.$snapshot || (monitor.history || []).some((entry) => entry.snapshot?.$snapshot);
  if (!referenced) return monitor;
  if (hydrationInProgress.has(id)) return hydrationInProgress.get(id);
  const operation = (async () => {
    const restored = await hydrateMonitorSnapshotsIndependently(monitor, { versions: () => OpenStillRecordStore.getAux('versions', id).then((values) => values || []) });
    const hydrated = restored.monitor;
    if (restored.recovery.length) {
      const envelope = await OpenStillRecordStore.getAux('monitors', id);
      const entries = [{ id: 'damaged-' + id + '-' + repository.generation, source: 'records', recordId: id, raw: envelope,
        error: hydrated.lastError || '스냅샷 복사본에서 정상 내용을 회수했습니다.' }, ...restored.recovery];
      for (const entry of entries) {
        const index = repository.recovery.findIndex((existing) => existing.id === entry.id);
        if (index === -1) repository.recovery.push(entry); else repository.recovery[index] = entry;
      }
      repairedMonitorShells.set(id, restored.shell);
    }
    repository.monitors.set(id, hydrated); repository.summaries.set(id, dashboardMonitorSummary(hydrated));
    hydratedMonitorIds.delete(id); hydratedMonitorIds.set(id, monitorBodyBytes(hydrated));
    await trimHydratedMonitors(id);
    return hydrated;
  })().finally(() => hydrationInProgress.delete(id));
  hydrationInProgress.set(id, operation); return operation;
}
async function getMonitorSummaries() { return [...(await loadMonitorRepository()).summaries.values()]; }
async function getMonitorSummaryPage(message) {
  const repository = await loadMonitorRepository();
  return { ok: true, monitors: [...new Set(message.ids || [])].map((id) => repository.summaries.get(id)).filter(Boolean).map((monitor) => ({ ...monitor, runtime: runtimeStatusForMonitor(monitor) })) };
}
async function recoveryStatus() {
  const state = await loadMonitorRepository();
  const records = [...state.recovery];
  for (const key of await OpenStillRecordStore.keysAux('recovery')) {
    const record = await OpenStillRecordStore.getAux('recovery', key);
    if (record) { const { raw, ...metadata } = record; records.push(metadata); }
  }
  const unique = new Map(records.map((record) => [record.id, record]));
  const sessions = []; const files = [];
  for (const key of await OpenStillRecordStore.keysAux('staging')) {
    if (/^(import|export):[^:]+$/.test(key)) {
      const entry = await OpenStillRecordStore.getAux('staging', key);
      if (entry) sessions.push({ id: entry.id, kind: entry.kind, phase: entry.phase, processed: entry.sourceCount,
        pending: entry.preparedCount || entry.preparedIds?.length || 0, progress: entry.progress });
    } else if (key.startsWith('import-file:')) {
      const entry = await OpenStillRecordStore.getAux('staging', key);
      if (entry) files.push({ id: key, sessionId: entry.sessionId || key.split(':')[1], fileIndex: entry.fileIndex ?? Number(key.split(':')[2]), name: entry.source, size: entry.raw?.size, phase: entry.phase });
    }
  }
  return { ok: true, ...state.diagnostics, runtime: await getRuntimeStatus(), records: [...unique.values()].map(({ raw, ...record }) => record),
    sessions: sessions.map((session) => ({ ...session, files: files.filter((file) => file.sessionId === session.id) })) };
}
async function restoreRecoveryRecord(message) {
  const recovery = await OpenStillRecordStore.getAux('recovery', message.id);
  if (!recovery) return { ok: false, error: '보관된 원본을 찾지 못했습니다.' };
  const rawRecords = recovery.raw?.record ? [recovery.raw] : recordsFromContainer(recovery.raw);
  const monitors = [];
  for (const raw of rawRecords) {
    const envelope = raw?.record && typeof raw.record === 'object' ? raw : null;
    const record = envelope?.record || raw;
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    const restored = await hydrateMonitorSnapshotsIndependently(record);
    const monitor = restored.monitor;
    if (envelope?.digest && await OpenStillRecordStore.digest(JSON.stringify(envelope.record)) !== envelope.digest) {
      monitor.enabled = false; monitor.status = 'needs-review';
      monitor.recoveryIssues = [...new Set([...(monitor.recoveryIssues || []), '원본 레코드 지문이 일치하지 않아 실행을 정지한 상태로 회수했습니다.'])];
    }
    monitors.push(monitor);
  }
  if (!monitors.length) return { ok: false, error: '이 원본에는 회수할 수 있는 추적 레코드가 없습니다.' };
  return importMonitors({ monitors, mode: 'merge' });
}

function dashboardSnapshotPreview(snapshot) {
  if (!snapshot) return null;
  return {
    exists: Boolean(snapshot.exists),
    matchCount: Number.isInteger(snapshot.matchCount) ? snapshot.matchCount : 0,
    text: cleanSnapshotText(snapshot.text, 800),
    capturedAt: asIso(snapshot.capturedAt, null)
  };
}

// The dashboard only needs configuration and a short preview for its cards.
// Keeping snapshot/history payloads out of the list response avoids Chrome's
// 64 MiB extension-message ceiling for large local backups.
function dashboardMonitorSummary(monitor) {
  return {
    id: monitor.id,
    revision: monitor.revision,
    name: monitor.name,
    url: monitor.url,
    pageTitle: monitor.pageTitle,
    locators: monitor.locators,
    selectors: monitor.selectors,
    tracking: monitor.tracking,
    labels: monitor.labels,
    schedule: monitor.schedule,
    scheduleMode: monitor.scheduleMode,
    intervalHours: monitor.intervalHours,
    intervalSeconds: monitor.intervalSeconds,
    enabled: monitor.enabled,
    createdAt: monitor.createdAt,
    updatedAt: monitor.updatedAt,
    lastCheckedAt: monitor.lastCheckedAt,
    lastChangedAt: monitor.lastChangedAt,
    nextCheckAt: monitor.nextCheckAt,
    lastReviewAt: monitor.lastReviewAt,
    lastViewedAt: monitor.lastViewedAt,
    lastError: monitor.lastError,
    status: monitor.status,
    unread: monitor.unread,
    snapshot: dashboardSnapshotPreview(monitor.snapshot),
    historyCount: monitor.history.length,
    runCount: monitor.runs.length,
    hasErrorEvidence: Boolean(monitor.lastErrorSnapshot?.evidenceHtml)
  };
}

function pruneTransientSessions() {
  const now = Date.now();
  for (const sessions of [dashboardLoadSessions, exportSessions, importSessions]) {
    for (const [id, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(id);
    }
  }
}

async function startDashboardLoad() {
  pruneTransientSessions();
  const state = await getState();
  const id = createId();
  dashboardLoadSessions.set(id, {
    monitors: await getMonitorSummaries(),
    settings: state.settings,
    expiresAt: Date.now() + DASHBOARD_SESSION_TTL_MS
  });
  return { ok: true, id, total: state.monitors.length, settings: state.settings };
}

function getDashboardLoadPage(message) {
  pruneTransientSessions();
  const session = dashboardLoadSessions.get(message?.id);
  if (!session) return { ok: false, reason: 'expired', error: '대시보드 데이터를 다시 불러와 주세요.' };
  session.expiresAt = Date.now() + DASHBOARD_SESSION_TTL_MS;
  const offset = Math.max(0, Math.floor(Number(message?.offset) || 0));
  const requestedPageSize = Math.floor(Number(message?.pageSize) || DASHBOARD_LOAD_PAGE_SIZE);
  const pageSize = Math.min(MAX_DASHBOARD_LOAD_PAGE_SIZE, Math.max(1, requestedPageSize));
  const monitors = [];
  let responseBytes = 256;
  const end = Math.min(session.monitors.length, offset + pageSize);
  for (let index = offset; index < end; index += 1) {
    const summary = { ...session.monitors[index], runtime: runtimeStatusForMonitor(session.monitors[index]) };
    const summaryBytes = utf8ByteLength(JSON.stringify(summary)) + (monitors.length ? 1 : 0);
    if (monitors.length && responseBytes + summaryBytes > MAX_DASHBOARD_LOAD_PAGE_BYTES) break;
    monitors.push(summary);
    responseBytes += summaryBytes;
  }
  return {
    ok: true,
    monitors,
    offset,
    total: session.monitors.length,
    done: offset + monitors.length >= session.monitors.length
  };
}

function finishDashboardLoad(message) {
  dashboardLoadSessions.delete(message?.id);
  return { ok: true };
}

async function getMonitorDetail(id) {
  const monitor = await getMonitorById(id);
  if (!monitor) return { ok: false, error: '모니터를 찾을 수 없습니다.' };
  const serialized = JSON.stringify(monitor);
  if (utf8ByteLength(serialized) > 8 * 1024 * 1024) {
    const detailToken = createId();
    await OpenStillRecordStore.putAux('staging', 'detail:' + detailToken, { kind: 'detail', id, json: serialized, expiresAt: Date.now() + DASHBOARD_SESSION_TTL_MS });
    return { ok: true, fragmented: true, id, revision: monitor.revision, detailToken, fragmentCount: Math.ceil(serialized.length / EXPORT_RECORD_FRAGMENT_CHARS) };
  }
  return { ok: true, monitor };
}
async function getMonitorDetailFragment(message) {
  const staged = await OpenStillRecordStore.getAux('staging', 'detail:' + message.detailToken);
  if (!staged || staged.id !== message.id || staged.expiresAt < Date.now()) return { ok: false, reason: 'expired', error: '상세 자료를 다시 불러와 주세요.' };
  const serialized = staged.json; const index = Number(message.fragmentIndex);
  if (!Number.isSafeInteger(index) || index < 0 || index * EXPORT_RECORD_FRAGMENT_CHARS >= serialized.length) return { ok: false, error: '조각 번호가 올바르지 않습니다.' };
  return { ok: true, payload: serialized.slice(index * EXPORT_RECORD_FRAGMENT_CHARS, (index + 1) * EXPORT_RECORD_FRAGMENT_CHARS) };
}

async function getPopupState() {
  const monitors = await getMonitorSummaries();
  const needsAttention = (monitor) => (monitor.enabled || monitor.status === 'permission-needed')
    && ['needs-review', 'error', 'permission-needed'].includes(monitor.status);
  const changed = monitors.filter((monitor) => monitor.unread);
  const attention = monitors.filter(needsAttention);
  const recent = [...changed, ...attention.filter((monitor) => !monitor.unread), ...monitors.filter((monitor) => (
    !monitor.unread && !needsAttention(monitor)
  ))]
    .sort((left, right) => Date.parse(right.lastChangedAt ?? right.lastReviewAt ?? right.updatedAt)
      - Date.parse(left.lastChangedAt ?? left.lastReviewAt ?? left.updatedAt))
    .slice(0, 3)
    .map((monitor) => ({
      id: monitor.id,
      name: monitor.name,
      url: monitor.url,
      status: monitor.status,
      enabled: monitor.enabled,
      unread: monitor.unread,
      lastChangedAt: monitor.lastChangedAt
    }));
  return {
    ok: true,
    activeCount: monitors.filter((monitor) => monitor.enabled).length,
    changedCount: changed.length,
    attentionCount: attention.length,
    recent
  };
}

function exportHistoryEntryForTransfer(entry, index) {
  if (index === 0 || !entry || typeof entry !== 'object') return entry;
  return {
    kind: entry.kind === 'baseline' ? 'baseline' : 'change',
    capturedAt: entry.capturedAt ?? entry.snapshot?.capturedAt ?? null,
    snapshot: { exists: entry.snapshot?.exists !== false, contentOmitted: true }
  };
}

function exportMonitorRecordForTransfer(monitor) {
  if (Number(monitor?.schemaVersion) > 1) return monitor.unsupportedOriginal || monitor;
  if (!monitor || typeof monitor !== 'object' || !Array.isArray(monitor.history)) return monitor;
  return {
    ...monitor,
    history: monitor.history.map(exportHistoryEntryForTransfer)
  };
}

function serializedExportRecord(monitor) {
  return JSON.stringify(exportMonitorRecordForTransfer(monitor));
}

async function getMonitors() {
  return [...(await loadMonitorRepository()).monitors.values()];
}

function mutateMonitors(mutator, options = {}) {
  const operation = storageQueue.catch(() => undefined).then(async () => {
    const repository = await loadMonitorRepository();
    const proxies = new WeakMap(); const originals = new WeakMap(); const touched = new Set();
    const monitors = [...repository.monitors.values()].map((monitor) => {
      const copy = { ...monitor };
      const proxy = new Proxy(copy, {
        set(target, key, value) { if (target[key] !== value) touched.add(monitor.id); target[key] = value; return true; },
        deleteProperty(target, key) { touched.add(monitor.id); delete target[key]; return true; }
      });
      proxies.set(proxy, copy); originals.set(proxy, monitor); return proxy;
    });
    const result = await mutator(monitors);
    if (result?.ok === false) return result;
    const next = new Map(); const changed = [];
    const recoveredIds = new Set(repository.recovery.filter((entry) => entry.source === 'records').map((entry) => entry.recordId));
    for (const value of monitors) {
      if (!value || typeof value.id !== 'string' || !value.id.trim() || next.has(value.id)) throw new Error('저장할 추적 ID가 중복되거나 비어 있습니다.');
      const original = originals.get(value);
      const monitor = original && !touched.has(original.id) ? original : { ...(proxies.get(value) || value), schemaVersion: value.schemaVersion ?? 1 };
      if (original && Number(original.schemaVersion) > 1 && touched.has(original.id)) throw new Error('지원하지 않는 버전의 원본은 수정할 수 없습니다.');
      const needsWrite = !repository.migrated || monitor !== repository.monitors.get(monitor.id) || recoveredIds.has(monitor.id);
      const storedMonitor = needsWrite ? await OpenStillRecordStore.stageMonitor(monitor, { allowReferences: true }) : monitor;
      next.set(monitor.id, storedMonitor);
      if (needsWrite) changed.push(storedMonitor);
    }
    const deletedIds = [...new Set([...repository.monitors.keys()].filter((id) => !next.has(id)).concat(repository.recovery.filter((entry) => entry.source === 'records' && !next.has(entry.recordId)).map((entry) => entry.recordId)))];
    if (!changed.length && !deletedIds.length && repository.migrated && !repository.recovery.length && options.settings === undefined && !options.operationId) return result;
    const generation = repository.generation + 1;
    const mutationOperation = options.operationId ? { id: options.operationId, type: options.type } : options.operation === false ? null : typeof activeMutationOperation !== 'undefined' && !activeMutationOperation?.committed ? activeMutationOperation : null;
    await OpenStillRecordStore.commit({ changed, deletedIds, recovery: repository.recovery, generation,
      deletedMonitors: deletedIds.map((id) => repository.monitors.get(id)).filter(Boolean),
      settings: options.settings,
      operation: mutationOperation ? { id: mutationOperation.id, type: mutationOperation.type, committed: true, result: result == null ? { ok: true } : compactMutationResult(result), committedAt: nowIso() } : null });
    repository.monitors = next;
    for (const monitor of changed) {
      repository.summaries.set(monitor.id, dashboardMonitorSummary(monitor));
      const envelope = await OpenStillRecordStore.getAux('monitors', monitor.id);
      if (envelope?.record) repository.monitors.set(monitor.id, envelope.record);
      hydratedMonitorIds.delete(monitor.id);
      repairedMonitorShells.delete(monitor.id);
    }
    for (const id of deletedIds) { repository.summaries.delete(id); repairedMonitorShells.delete(id); }
    repository.generation = generation; repository.migrated = true; repository.recovery = [];
    repository.diagnostics.normalCount = next.size;
    repository.diagnostics.repairedCount = [...next.values()].filter((monitor) => monitor.recoveryIssues?.length || monitor.recoveryRepairs?.length).length;
    if (mutationOperation) { mutationOperation.committed = true; mutationOperation.result = result; }
    if (options.operationId && typeof activeMutationOperation !== 'undefined' && activeMutationOperation) { activeMutationOperation.committed = true; activeMutationOperation.result = result; }
    // The transaction is committed even if the lightweight UI notification fails.
    await chrome.storage.local.set({ [RECORDS_CHANGED_KEY]: { generation, ids: changed.map((monitor) => monitor.id), deletedIds } }).catch(() => undefined);
    return result;
  });

  storageQueue = operation.catch(() => undefined);
  return operation;
}

function migrateLegacyScheduleModes() {
  return persistNormalizedMonitorRepairs();
}

async function updateSettings(settingsPatch) {
  const state = await getState();
  const settings = normalizeSettings({ ...state.settings, ...settingsPatch });
  const currentOperation = activeMutationOperation?.type === 'save-settings' ? activeMutationOperation : null;
  const result = { ok: true, committed: true, settings };
  await OpenStillRecordStore.commitAux([['meta', 'settings', settings], ...(currentOperation ? [['operations', currentOperation.id, { id: currentOperation.id, type: currentOperation.type, committed: true, result }]] : [])]);
  if (currentOperation) { currentOperation.committed = true; currentOperation.result = result; }
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings }).catch(() => undefined);
  return settings;
}

async function hasSitePermission(url) {
  // HTTP/HTTPS host access is a required install-time permission. Keep this
  // guard so every caller still rejects unsupported schemes, but do not make
  // users approve hundreds of imported origins one at a time.
  return Boolean(normalizeUrl(url));
}

async function getPendingPickers() {
  const stored = await chrome.storage.session.get(PENDING_PICKERS_KEY);
  const pending = stored[PENDING_PICKERS_KEY];
  return pending && typeof pending === 'object' ? pending : {};
}

async function rememberPendingPicker(tabId, url) {
  if (!Number.isInteger(tabId)) return;
  const pending = await getPendingPickers();
  pending[String(tabId)] = { origin: originPattern(url), createdAt: nowIso() };
  await chrome.storage.session.set({ [PENDING_PICKERS_KEY]: pending });
}

async function forgetPendingPicker(tabId) {
  if (!Number.isInteger(tabId)) return;
  const pending = await getPendingPickers();
  if (Object.hasOwn(pending, String(tabId))) {
    delete pending[String(tabId)];
    await chrome.storage.session.set({ [PENDING_PICKERS_KEY]: pending });
  }
}

async function releaseUnusedOriginPermission(pattern) {
  // Host access is now declared in manifest.json, so Chrome does not allow it
  // to be removed per origin at runtime. The picker bookkeeping still calls
  // this helper when a user cancels selection; making it a no-op keeps that
  // lifecycle explicit without attempting to mutate required permissions.
  void pattern;
}

async function releaseUnusedSitePermission(url) {
  await releaseUnusedOriginPermission(originPattern(url));
}

async function releasePendingPicker(tabId) {
  if (!Number.isInteger(tabId)) return;
  const pending = await getPendingPickers();
  const entry = pending[String(tabId)];
  if (!entry?.origin) return;
  delete pending[String(tabId)];
  await chrome.storage.session.set({ [PENDING_PICKERS_KEY]: pending });
  await releaseUnusedOriginPermission(entry.origin);
}

async function clearExpiredPendingPickers() {
  const pending = await getPendingPickers();
  const cutoff = Date.now() - PENDING_PICKER_TTL_MS;
  const expiredOrigins = new Set();
  let changed = false;

  for (const [tabId, entry] of Object.entries(pending)) {
    if (!entry?.origin || (Date.parse(entry.createdAt ?? '') || 0) < cutoff) {
      if (entry?.origin) expiredOrigins.add(entry.origin);
      delete pending[tabId];
      changed = true;
    }
  }
  if (changed) {
    await chrome.storage.session.set({ [PENDING_PICKERS_KEY]: pending });
    await Promise.all([...expiredOrigins].map((origin) => releaseUnusedOriginPermission(origin)));
  }
}

async function cleanupUnusedSitePermissions() {
  // See releaseUnusedOriginPermission: broad HTTP/HTTPS access is required at
  // installation time for batch imports and scheduled checks.
}

function responseError(error) {
  return error instanceof Error ? error.message : String(error ?? '알 수 없는 오류');
}

function timeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })
  ]).finally(() => clearTimeout(timer));
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.some((context) => context.documentUrl === offscreenUrl)) {
    return;
  }

  if (!offscreenCreation) {
    offscreenCreation = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_PARSER', 'AUDIO_PLAYBACK', 'WORKERS'],
      justification: 'OpenStill validates selectors, runs interruptible text filters, and plays a local alert tone.'
    }).catch(async (error) => {
      const contextsAfterFailure = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (!contextsAfterFailure.some((context) => context.documentUrl === offscreenUrl)) {
        throw error;
      }
    }).finally(() => {
      offscreenCreation = undefined;
    });
  }

  await offscreenCreation;
}

async function parseMonitoredHtml(html, selector, selectorType = 'css') {
  await ensureOffscreenDocument();
  const result = await timeout(
    chrome.runtime.sendMessage({ type: 'parse-monitor-html', html, selector, selectorType }),
    PARSE_TIMEOUT_MS,
    '페이지 HTML을 분석하는 데 시간이 너무 오래 걸렸습니다.'
  );

  if (!result?.ok) {
    throw new Error(result?.error || '선택자 분석 결과를 받지 못했습니다.');
  }

  return {
    exists: Boolean(result.exists),
    matchCount: Number.isInteger(result.matchCount) ? result.matchCount : 0,
    text: cleanText(result.text),
    capturedAt: nowIso()
  };
}

function waitForRenderedTab(tabId) {
  let cancel = () => undefined;
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      finish(() => reject(new Error('렌더링된 페이지를 여는 데 30초가 넘게 걸렸습니다.')));
    }, RENDER_LOAD_TIMEOUT_MS);
    const finish = (settle) => {
      if (settled) return;
      settled = true;
      cleanup();
      settle();
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'complete') {
        finish(resolve);
      }
    };
    const domContentLoaded = (details) => {
      if (details?.tabId === tabId && details.frameId === 0) finish(resolve);
    };
    const domReadyEvents = chrome.webNavigation?.onDOMContentLoaded;
    const cleanup = () => {
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(listener);
      domReadyEvents?.removeListener?.(domContentLoaded);
    };
    cancel = cleanup;
    chrome.tabs.onUpdated.addListener(listener);
    // Reference loader signals readiness at DOMContentLoaded.  A full-load
    // tab-status event is retained only as a compatibility fallback for
    // browsers/test environments without webNavigation's DOM-ready event.
    domReadyEvents?.addListener?.(domContentLoaded);

    // A fast cached page can finish before the listener above is attached.
    // We only create this tab for the target URL, so an already-complete state
    // is a valid full-load signal as well.
    if (typeof chrome.tabs.get === 'function') {
      void chrome.tabs.get(tabId).then((tab) => {
        if (tab?.status === 'complete') finish(resolve);
      }).catch(() => undefined);
    }
  });
  return { promise, cancel };
}

async function waitForPickerDocumentReady(tabId) {
  const execution = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      if (document.readyState === 'loading') {
        await new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
      }
      return Boolean(document.documentElement);
    }
  });

  if (!execution[0]?.result) {
    throw new Error('페이지가 완전히 로드되기 전에 선택기를 시작할 수 없습니다.');
  }
}

// Typed capture entry point. Its implementation is kept separate from the
// legacy collector below so existing stored CSS-only monitors can migrate
// without a behavior gap while richer locators are introduced.
async function captureReferenceRenderedDocumentCollection(...args) {
  const [rawLocators, minimumWaitMilliseconds, quietMilliseconds, settleTimeoutMilliseconds,
    emptyRetryCount = 4, emptyRetryDelayMilliseconds = 5_000, captureOptions = {}] = args;
  const includeMark = 'data-openstill-capture-include';
  const excludeMark = 'data-openstill-capture-exclude';
  const automaticIncludeMark = 'data-openstill-capture-automatic';
  const includeInlineScripts = captureOptions?.includeScript === true || captureOptions?.includeScripts === true;
  const includeStyles = captureOptions?.includeStyle === true || captureOptions?.includeStyles === true;
  const keepComments = captureOptions?.keepComments === true;
  const liveObserverRecord = (() => {
    if (!captureOptions?.live || typeof captureOptions?.liveMonitorId !== 'string') return null;
    try {
      return globalThis.__openStillLiveMutationObservers?.get(captureOptions.liveMonitorId) || null;
    } catch {
      return null;
    }
  })();
  const adblockerSelectors = () => {
    // The reference locator receives cosmetic-filter rules through a DOM
    // event, stores their selector text, and treats those nodes as ordinary
    // excludes for future captures. Keep that page-local registry in the
    // isolated world without depending on the reference implementation.
    const key = '__openStillCaptureAdblockerSelectors';
    let state = globalThis[key];
    if (!state) {
      const selectors = new Set();
      const addStylesheet = (stylesheet) => {
        if (typeof stylesheet !== 'string' || !stylesheet.trim()) return;
        try {
          const sheet = new CSSStyleSheet();
          sheet.insertRule(stylesheet, 0);
          const selector = String(sheet.cssRules[0]?.selectorText || '').trim();
          if (selector) selectors.add(selector);
        } catch {
          // A malformed cosmetic rule must not break the monitored capture.
        }
      };
      // The locator integration can already have collected rules before this
      // isolated capture entry point first runs.  Reference capture reads the
      // shared cache every time, rather than relying solely on future events.
      const absorbCachedSelectors = () => {
        const cached = globalThis.adblockerStyleSheets;
        if (!Array.isArray(cached)) return;
        for (const entry of cached) {
          if (typeof entry === 'string') {
            addStylesheet(entry);
            continue;
          }
          const selector = String(entry?.selector ?? '').trim();
          if (selector) selectors.add(selector);
        }
      };
      state = { selectors, addStylesheet, absorbCachedSelectors };
      globalThis[key] = state;
      addEventListener('bbx:adblocker:stylesheet-update', (event) => {
        addStylesheet(event?.detail?.stylesheet);
      });
      try {
        dispatchEvent(new CustomEvent('adblocker:locator:cached-stylesheets'));
      } catch {
        // Custom events are optional on restricted/opaque documents.
      }
    }
    state.absorbCachedSelectors?.();
    return [...state.selectors];
  };
  const isIgnoredElement = (node, insideShadow = false) => {
    if (node?.nodeType !== Node.ELEMENT_NODE) return true;
    const localName = String(node.localName || node.tagName || '').toLowerCase();
    // Do not reserve a tag name or generic accessibility state owned by a
    // page. Only the extension's private picker marker denotes internal UI.
    if (String(node.localName || '').toLowerCase() === 'openstill-picker-root'
      && node.getAttribute?.('data-openstill-picker-ui') === 'true') return true;
    // Automatic CSS/XPath exclusions run against the cloned document's
    // light DOM. They do not enter shadow roots, whose retained markup must
    // therefore stay intact unless the user explicitly excludes it.
    if (insideShadow) return false;
    if (['noscript', 'frame', 'iframe'].includes(localName)) return true;
    // When code capture is disabled, scripts and script-preload links are
    // excluded. When it is enabled, inline scripts are added automatically,
    // while an external script remains visible if it belongs to a broader
    // user-selected subtree (the page's own markup is still meaningful data).
    if (localName === 'script') return !includeInlineScripts;
    if (localName === 'link' && String(node.getAttribute('as') || '').toLowerCase() === 'script') return !includeInlineScripts;
    if (localName === 'style') return !includeStyles;
    if (localName === 'link' && String(node.getAttribute('rel') || '').toLowerCase() === 'stylesheet') return !includeStyles;
    return false;
  };
  // Keep these deliberately narrow lists in lockstep with the reference
  // extractor. The clone lives in a detached HTMLDocument, where browser
  // defaults such as P/ASIDE display are not reliably resolved; treating
  // extra semantic elements as blocks here would manufacture line breaks
  // that the reference text payload does not contain.
  const blockTags = new Set([
    'ARTICLE', 'BLOCKQUOTE', 'CAPTION', 'CODE', 'DD', 'DIV', 'FIELDSET', 'FOOTER', 'FORM',
    'HEADER', 'LI', 'OL', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TFOOT', 'THEAD', 'TR',
    'UL', 'IMG', 'BR'
  ]);
  const spacedTags = new Set(['A', 'ABBR', 'ACRONYM', 'ADDRESS', 'BUTTON', 'TD']);

  const fieldOf = (value) => {
    const raw = typeof value === 'string'
      ? { type: value === 'text' ? 'text' : 'attribute', name: value }
      : value && typeof value === 'object' ? value : null;
    if (!raw) return null;
    let type = String(raw.type ?? raw.kind ?? '').toLowerCase();
    let name = String(raw.name ?? raw.value ?? '').trim();
    if (typeof value === 'string' && value.startsWith('attr:')) {
      type = 'attribute';
      name = value.slice(5).trim();
    }
    if (typeof value === 'string' && value.startsWith('property:')) {
      type = 'property';
      name = value.slice(9).trim();
    }
    if (type === 'builtin') type = name === 'text' ? 'text' : '';
    if (type === 'text') return { type: 'text' };
    if (!['attribute', 'property'].includes(type)
      || !name
      || name.length > 256
      || /[\u0000-\u001F\u007F\s]/.test(name)
      || (type === 'attribute' && /["'<>\/=]/.test(name))) return null;
    return { type, name };
  };

  const locatorOf = (value) => {
    const raw = typeof value === 'string' ? { expr: value } : value;
    if (!raw || typeof raw !== 'object') return null;
    const inputType = String(raw.type ?? 'css').trim().toLowerCase();
    const type = inputType === 'extendedcss' || inputType === 'extended-css' ? 'xcss' : inputType;
    const expr = String(raw.expr ?? raw.selector ?? raw.value ?? '').trim();
    const op = String(raw.op ?? raw.operation ?? 'include').trim().toLowerCase();
    if (!['css', 'xcss', 'xpath'].includes(type) || !expr || !['include', 'exclude'].includes(op)) return null;
    const rawDefaultTextOnly = Array.isArray(raw.fields)
      && raw.fields.length === 1
      && String(raw.fields[0]?.type ?? '').toLowerCase() === 'text';
    const hasExplicitFields = raw.fieldsSpecified === true
      || (raw.fieldsSpecified !== false && Object.hasOwn(raw, 'fields') && raw.fields != null && !rawDefaultTextOnly);
    const values = Array.isArray(raw.fields) ? raw.fields : raw.fields == null ? [] : [raw.fields];
    const fields = [];
    for (const value of values.slice(0, 256)) {
      const field = fieldOf(value);
      if (field) fields.push(field);
    }
    return {
      type,
      expr,
      op,
      fields: fields.length || hasExplicitFields ? fields : [{ type: 'text' }],
      fieldsSpecified: hasExplicitFields,
      identityAttribute: typeof raw.identityAttribute === 'string' ? raw.identityAttribute : null,
      legacy: typeof value === 'string'
    };
  };

  const locators = (Array.isArray(rawLocators) ? rawLocators : []).map(locatorOf).filter(Boolean);
  const includeLocators = locators.filter((locator) => locator.op === 'include');
  const usesExtendedCss = locators.some((locator) => locator.type === 'xcss');
  const unique = (items) => [...new Set(items)];
  const shadowFor = (element) => {
    if (element?.nodeType !== Node.ELEMENT_NODE) return null;
    const read = (getter) => {
      try { return getter() || null; } catch { return null; }
    };
    // A page-owned compatibility getter must not abort the complete
    // clone/filter transaction. Continue with another accessible root source,
    // or retain this host's normal light DOM when none is available.
    const usable = (root) => root?.nodeType === Node.DOCUMENT_FRAGMENT_NODE
      && typeof root.querySelectorAll === 'function'
      ? root
      : null;
    return usable(read(() => element.shadowRoot))
      || usable(read(() => element._shadowRoot))
      || usable(read(() => element.__openStillCaptureShadow))
      || usable(read(() => globalThis.chrome?.dom?.openOrClosedShadowRoot?.(element)));
  };
  const isInsidePickerUi = (element) => {
    const visited = new Set();
    for (let current = element; current && !visited.has(current); current = current.parentElement || current.getRootNode?.().host || null) {
      visited.add(current);
      if (String(current.localName || '').toLowerCase() === 'openstill-picker-root'
        && current.getAttribute?.('data-openstill-picker-ui') === 'true') return true;
    }
    return false;
  };

  const splitUnion = (source) => {
    const parts = [];
    let value = '', quote = '', escaped = false, square = 0, round = 0;
    for (const character of String(source || '')) {
      if (escaped) { value += character; escaped = false; continue; }
      if (character === '\\') { value += character; escaped = true; continue; }
      if (quote) { value += character; if (character === quote) quote = ''; continue; }
      if (character === "'" || character === '"') { value += character; quote = character; continue; }
      if (character === '[') square += 1;
      if (character === ']') square = Math.max(0, square - 1);
      if (character === '(') round += 1;
      if (character === ')') round = Math.max(0, round - 1);
      if (character === ',' && !square && !round) { if (value.trim()) parts.push(value.trim()); value = ''; }
      else value += character;
    }
    if (value.trim()) parts.push(value.trim());
    return parts;
  };

  const splitSteps = (source) => {
    const parts = [];
    let value = '', quote = '', escaped = false, escapedHexDigits = 0, square = 0, round = 0;
    const flush = () => { if (value.trim()) parts.push(value.trim()); value = ''; };
    for (const character of String(source || '').trim()) {
      if (escaped) {
        value += character;
        escaped = false;
        escapedHexDigits = /[0-9a-f]/i.test(character) ? 1 : 0;
        continue;
      }
      if (escapedHexDigits) {
        if (/[0-9a-f]/i.test(character) && escapedHexDigits < 6) {
          value += character;
          escapedHexDigits += 1;
          continue;
        }
        if (/\s/.test(character)) {
          value += character;
          escapedHexDigits = 0;
          continue;
        }
        escapedHexDigits = 0;
      }
      if (character === '\\') { value += character; escaped = true; continue; }
      if (quote) { value += character; if (character === quote) quote = ''; continue; }
      if (character === "'" || character === '"') { value += character; quote = character; continue; }
      if (character === '[') square += 1;
      if (character === ']') square = Math.max(0, square - 1);
      if (character === '(') round += 1;
      if (character === ')') round = Math.max(0, round - 1);
      if (/\s/.test(character) && !square && !round) flush(); else value += character;
    }
    flush();
    for (let index = 0; index < parts.length; index += 1) {
      if (/^[>+~]$/.test(parts[index]) && index > 0 && index < parts.length - 1) {
        parts[index - 1] += parts[index] + parts[index + 1];
        parts.splice(index, 2); index -= 1;
      } else if (/[>+~]$/.test(parts[index]) && index < parts.length - 1) {
        parts[index] += parts[index + 1]; parts.splice(index + 1, 1); index -= 1;
      } else if (/^[>+~]/.test(parts[index]) && index > 0) {
        parts[index - 1] += parts[index]; parts.splice(index, 1); index -= 1;
      }
    }
    return parts.filter(Boolean);
  };

  const queryShadowAware = (selector, root) => {
    const matches = [], visited = new Set();
    const visit = (scope) => {
      if (!scope || visited.has(scope) || typeof scope.querySelectorAll !== 'function') return;
      visited.add(scope);
      matches.push(...[...scope.querySelectorAll(selector)].filter((element) => !isInsidePickerUi(element)));
      const descendants = [...scope.querySelectorAll('*')];
      const candidates = scope.nodeType === Node.ELEMENT_NODE ? [scope, ...descendants] : descendants;
      for (const element of candidates) {
        if (isInsidePickerUi(element)) continue;
        const shadow = shadowFor(element);
        if (shadow) visit(shadow);
      }
    };
    visit(root);
    return unique(matches);
  };

  // Non-JavaScript locators are intentionally evaluated against the cloned
  // capture document.  Apart from making filtering self-contained, this keeps
  // transient page state (`:focus`, `:hover`, form validity, etc.) out of a
  // saved monitor result, which is how the reference capture pipeline works.
  const queryXcss = (selector, rootDocument = document) => {
    const result = [];
    for (const branch of splitUnion(selector)) {
      let roots = [rootDocument];
      for (const step of splitSteps(branch)) {
        roots = unique(roots.flatMap((root) => queryShadowAware(step, root)));
        if (!roots.length) break;
      }
      result.push(...roots);
    }
    return unique(result);
  };

  const select = (locator, rootDocument = document) => {
    if (locator.type === 'css') return [...rootDocument.querySelectorAll(locator.expr)]
      .filter((element) => !isInsidePickerUi(element))
      .map((element) => ({ element }));
    if (locator.type === 'xcss') return queryXcss(locator.expr, rootDocument).map((element) => ({ element }));
    // The current Reference locator evaluates XPath relative to the cloned
    // document's first element (<html>), not the Document node itself. This
    // only changes relative expressions such as `.` and `./body`; CSS/XCSS
    // intentionally remain Document-scoped above.
    const xpathContext = rootDocument.firstElementChild || rootDocument;
    const iterator = rootDocument.evaluate(
      locator.expr,
      xpathContext,
      (prefix) => prefix === 'xhtml' ? 'http://www.w3.org/1999/xhtml' : null,
      XPathResult.ORDERED_NODE_ITERATOR_TYPE,
      null
    );
    const matches = [];
    for (let node = iterator.iterateNext(); node; node = iterator.iterateNext()) {
      if (node.nodeType === Node.ATTRIBUTE_NODE && node.ownerElement) {
        matches.push({ element: node.ownerElement, attributeName: node.name, attributeNode: true });
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        matches.push({ element: node });
      } else {
        if (locator.op === 'include') {
          throw new Error('XPath include must select elements or attributes (for example //a or //a/@href); text(), comment(), and document results are unsupported.');
        }
        matches.push({ element: null, selectedNode: node, nonElementNode: true });
      }
    }
    const seen = new Map();
    return matches.filter((match) => {
      if (!match.element) return true;
      if (isInsidePickerUi(match.element)) return false;
      const names = seen.get(match.element) || new Set();
      const key = match.attributeName || '';
      if (names.has(key)) return false;
      names.add(key);
      seen.set(match.element, names);
      return true;
    });
  };

  const parentAcrossShadow = (element) => element.parentElement || element.getRootNode?.().host || null;
  const containsAcrossShadow = (ancestor, element) => {
    for (let current = element; current; current = parentAcrossShadow(current)) if (current === ancestor) return true;
    return false;
  };
  const outerHost = (element) => {
    let current = element;
    for (let root = current.getRootNode?.(); root?.host; root = current.getRootNode?.()) current = root.host;
    return current;
  };
  const compare = (left, right) => {
    if (left === right) return 0;
    if (containsAcrossShadow(left, right)) return -1;
    if (containsAcrossShadow(right, left)) return 1;
    const position = outerHost(left).compareDocumentPosition(outerHost(right));
    return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : position & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
  };

  const originalNodes = new WeakMap();
  const fieldValues = (element, fields) => fields.filter((field) => field.type !== 'text').map((field) => {
    try {
      return field.type === 'attribute'
        ? element.hasAttribute(field.name) ? element.getAttribute(field.name) || '' : 'undefined'
        : (() => {
          const value = (originalNodes.get(element) || element)[field.name];
          return value == null ? '' : ['string', 'number', 'boolean', 'bigint'].includes(typeof value) ? value : '';
        })();
    } catch { return ''; }
  }).map(String);

  const fieldPayloadKey = '__openStillCaptureFieldPayload__';
  const writeText = (root) => {
    const out = [];
    // Text and HTML are both read from the same already-filtered clone. This
    // prevents a removed inline style or excluded subtree from influencing the
    // text-only comparison through the original live DOM.
    const children = (node) => {
      const result = node?.localName === 'template'
        ? [...node.content.childNodes]
        : [...(node?.childNodes || [])];
      if (node?.shadowRoot) result.push(...node.shadowRoot.childNodes);
      if (node?.__openStillCaptureShadow) result.push(...node.__openStillCaptureShadow.childNodes);
      return result;
    };
    const visit = (node, parentTextMode = true) => {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        if (parentTextMode) out.push(node.nodeValue || '');
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const payload = node[fieldPayloadKey] || null;
      // Script/style/noscript content is structural data unless a caller
      // explicitly selected fields on that exact element. Frame elements are
      // normally pruned, but their explicit attribute/property fields remain
      // readable when deliberately included.
      if (['noscript', 'script', 'style'].includes(String(node.localName || node.tagName || '').toLowerCase()) && !payload) return;

      const selectedFields = payload?.fields || [];
      const textMode = payload
        ? selectedFields.some((field) => field.type === 'text')
        : parentTextMode;
      const nonTextValues = payload?.values || [];
      // `getFieldValues()` in the reference always writes its joined value
      // followed by a newline, including an explicit empty/text-only field
      // list. That separator is observable when a field-mode child sits
      // between inherited text runs.
      if (payload) out.push(nonTextValues.join('\n'), '\n');

      if (textMode) {
        // The reference obtains display from its detached cloned document.
        // Do not leak computed styles or inline display values from the live
        // page into this normalized payload: Chromium normally reports an
        // empty display for that detached clone, leaving only the reference's
        // explicit breaking-element list as a stable fallback.
        let computedDisplay = '';
        try { computedDisplay = String(globalThis.getComputedStyle?.(node)?.display || '').toLowerCase(); } catch { /* detached style lookup is optional */ }
        const block = computedDisplay === 'block' || blockTags.has(node.tagName);
        out.push(block ? '\n' : spacedTags.has(node.tagName) ? ' ' : '');
      }
      // The clone writes light DOM children first and serializes shadow trees
      // as an ordinary following template. Do not follow slot assignments:
      // that would turn the filtered document tree into a composed graph and
      // change both ordering and duplication semantics.
      children(node).forEach((child) => visit(child, textMode));
    };
    visit(root, true);
    // Preserve the reference trim/compact order exactly: form-feed and
    // vertical-tab are not silently rewritten before a regexp filter sees
    // the extracted text.
    return out.join('').trim().replace(/\s*\n+(\s*\n+)*/g, '\n').replace(/[ \t]+/g, ' ');
  };

  const cloneCaptureDocument = () => {
    const targetDocument = document.implementation.createHTMLDocument('');
    const copy = (node, insideShadow = false) => {
      if (node.nodeType === Node.TEXT_NODE) return targetDocument.createTextNode(node.nodeValue || '');
      // Keep comments through selector evaluation even for an XCSS capture:
      // XPath predicates can rely on them. Filtering/serialization decides
      // later whether they are retained or emitted.
      if (node.nodeType === Node.COMMENT_NODE) return targetDocument.createComment(node.nodeValue || '');
      if (node.nodeType !== Node.ELEMENT_NODE) return null;
      const clone = targetDocument.importNode(node, false);
      originalNodes.set(clone, node);
      if (insideShadow) clone.__openStillCaptureShadowContext = true;
      const sourceChildren = node.localName === 'template' ? node.content.childNodes : node.childNodes;
      const targetChildren = clone.localName === 'template' ? clone.content : clone;
      [...sourceChildren].forEach((child) => { const next = copy(child, insideShadow); if (next) targetChildren.append(next); });
      // The clone must retain a real, open shadow tree. CSS/XPath never cross
      // it, while XCSS can query it exactly as it would the source's closed or
      // open tree. Serialization decides separately whether to emit it.
      const shadow = shadowFor(node);
      if (shadow?.childNodes) {
        let shadowClone;
        try { shadowClone = clone.shadowRoot || clone.attachShadow({ mode: 'open' }); } catch {
          shadowClone = targetDocument.createDocumentFragment();
          clone.__openStillCaptureShadow = shadowClone;
        }
        Array.from(shadow.childNodes ?? []).forEach((child) => { const next = copy(child, true); if (next) shadowClone.append(next); });
      }
      return clone;
    };
    const rootCopy = copy(document.documentElement);
    if (!rootCopy) return null;
    targetDocument.replaceChild(rootCopy, targetDocument.documentElement);
    // Resource context belongs only to the detached copy. Reading the page's
    // baseURI does not insert nodes or trigger its MutationObservers.
    if (!/^(?:data|about):/i.test(String(document.baseURI || ''))) {
      let base = targetDocument.querySelector('base');
      if (!base) {
        base = targetDocument.createElement('base');
        targetDocument.querySelector('head')?.prepend(base);
      }
      base?.setAttribute('href', String(document.baseURI || ''));
    }
    return { targetDocument, rootCopy };
  };

  const makeHtml = (captureClone, included, excluded, automaticallyIncluded, excludedAttributes, fields = new Map(), structuralContext = new Set()) => {
    const { targetDocument, rootCopy } = captureClone || {};
    if (!targetDocument || !rootCopy) return { html: '', text: '' };
    // The reference filter marks the cloned <html> as structural before
    // removing unmatched descendants. Retain that shell even on data:/about:
    // documents where no automatic <base> can provide a retained child.
    const structuralNodes = new Set(structuralContext);
    structuralNodes.add(rootCopy);
    included.forEach((node) => node?.setAttribute?.(includeMark, '1'));
    excluded.forEach((node) => node?.setAttribute?.(excludeMark, '1'));
    automaticallyIncluded.forEach((node) => node?.setAttribute?.(automaticIncludeMark, '1'));
    const children = (node) => {
      const result = node.localName === 'template' ? [...node.content.childNodes] : [...node.childNodes];
      if (node.shadowRoot) result.push(...node.shadowRoot.childNodes);
      if (node.__openStillCaptureShadow) result.push(...node.__openStillCaptureShadow.childNodes);
      return result;
    };
    const prune = (node, active = false, parentStructural = false) => {
      if (node.nodeType === Node.TEXT_NODE) { if (!active) node.remove(); return active; }
      // `filterDoc` removes text from a has-include context but leaves its
      // direct comments when requested. A true include keeps all descendants;
      // a structural context only keeps comments directly attached to it.
      if (node.nodeType === Node.COMMENT_NODE) {
        const retainComment = keepComments && (active || parentStructural);
        if (!retainComment) node.remove();
        return retainComment;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) { node.remove(); return false; }
      // Explicit and automatic includes both win over the global script/style
      // exclusion. Automatic base/style/script locators are ordinary include
      // rules in the reference pipeline, so a matching exclude must not erase
      // them after they were added for structural context.
      if (isIgnoredElement(node, node.__openStillCaptureShadowContext === true)
        && !node.hasAttribute(includeMark)
        && !node.hasAttribute(automaticIncludeMark)) { node.remove(); return false; }
      let enabled = active;
      if (node.hasAttribute(includeMark) || node.hasAttribute(automaticIncludeMark)) enabled = true;
      else if (node.hasAttribute(excludeMark)) enabled = false;
      const retained = children(node).map((child) => prune(child, enabled, structuralNodes.has(node))).some(Boolean);
      // An XCSS result needs hosts, shadow ancestors, and slot paths as
      // structure, but those nodes are not text inclusions in their own
      // right. Keeping the context lets a slotted include survive without
      // accidentally turning surrounding fallback text into tracked text.
      if (!enabled && !retained && !structuralNodes.has(node)) { node.remove(); return false; }
      return true;
    };
    prune(rootCopy);
    // Attribute excludes are represented as xdel-* markers in the reference
    // pipeline and removed only after element filtering. Removing `as`/`rel`
    // earlier can disguise a script-preload or stylesheet from the automatic
    // exclusion rules and accidentally retain its whole element.
    excludedAttributes.forEach((names, node) => {
      if (!node) return;
      names.forEach((name) => node.removeAttribute(name));
    });
    // Reference excludes only data: documents. An about:blank document can
    // still carry an explicit <base>, whose href/src properties must be made
    // absolute in the captured clone.
    const canNormalizeLinks = !/^data:/i.test(String(location?.protocol || document.baseURI || ''));
    const absolute = (value) => { try { return new URL(value ?? '', document.baseURI).href; } catch { return String(value ?? ''); } };
    const normalizeUrlAttribute = (node, name) => {
      // HTML URL properties return an empty string when the corresponding
      // attribute is absent. Do not invent a page-URL link for `<a>`/`<img>`
      // without href/src; reference normalization serializes that case as an
      // explicit empty attribute.
      const raw = node.getAttribute(name);
      node.setAttribute(name, raw === null ? '' : absolute(raw));
    };
    const sanitize = (node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const insideShadow = node.__openStillCaptureShadowContext === true;
      for (const attribute of [...node.attributes]) {
        const internalMarker = [includeMark, excludeMark, automaticIncludeMark].includes(attribute.name);
        if (internalMarker || (!insideShadow && ((/^on/i.test(attribute.name) && !includeInlineScripts)
          || (attribute.name === 'style' && !includeStyles)))) {
          node.removeAttribute(attribute.name);
        }
      }
      if (!insideShadow && canNormalizeLinks && node.matches('a')) normalizeUrlAttribute(node, 'href');
      if (!insideShadow && canNormalizeLinks && node.matches('img,audio,video')) normalizeUrlAttribute(node, 'src');
      children(node).forEach(sanitize);
    };
    sanitize(rootCopy);
    // Field extraction occurs after the clone has had automatic/user
    // attribute exclusions and URL normalization applied. In particular,
    // `style` and `on*` fields must not leak through when their corresponding
    // structural capture option is disabled.
    fields.forEach((payload, node) => {
      if (!node) return;
      const selectedFields = payload.fields.map((field) => ({ ...field }));
      node[fieldPayloadKey] = {
        fields: selectedFields,
        values: fieldValues(node, selectedFields)
      };
    });
    const text = writeText(rootCopy);
    const serializeWithShadow = (node) => {
      // The declarative-shadow serializer has an element/text-only contract.
      // Comments remain available to CSS/XPath filtering above, but never
      // appear in an XCSS HTML snapshot.
      if (node.nodeType === Node.COMMENT_NODE) return keepComments ? `<!--${node.nodeValue || ''}-->` : '';
      if (node.nodeType !== Node.ELEMENT_NODE) {
        const holder = targetDocument.createElement('div');
        holder.append(node.cloneNode(true));
        return holder.innerHTML;
      }
      // Let the platform serialize the opening/closing tag so namespaces and
      // escaped attributes stay browser-correct, then place a declarative
      // shadow template before the element's light-DOM children. This is the
      // XCSS snapshot order; text keeps its separate light-then-shadow walk.
      const shell = node.cloneNode(false).outerHTML;
      const openingEnd = shell.indexOf('>') + 1;
      const closingStart = shell.lastIndexOf('</');
      if (!openingEnd || closingStart < openingEnd) return shell;
      const shadow = node.shadowRoot || node.__openStillCaptureShadow || null;
      const shadowHtml = shadow
        ? `<template shadowrootmode="open">${[...shadow.childNodes].map(serializeWithShadow).join('')}</template>`
        : '';
      const lightChildren = node.localName === 'template'
        ? [...node.content.childNodes]
        : [...node.childNodes];
      return shell.slice(0, openingEnd)
        + shadowHtml
        + lightChildren.map(serializeWithShadow).join('')
        + shell.slice(closingStart);
    };
    const serialize = (node) => (usesExtendedCss ? serializeWithShadow(node) : node.outerHTML).trim().replace(/\s*\n+(\s*\n+)*/g, '\n');
    return { html: serialize(rootCopy), text, itemHtml: serialize };
  };

  const makeErrorEvidence = () => {
    const targetDocument = document.implementation.createHTMLDocument('');
    const rootCopy = targetDocument.importNode(document.documentElement, true);
    targetDocument.replaceChild(rootCopy, targetDocument.documentElement);
    const selfAndDescendants = (selector) => {
      const nodes = [...rootCopy.querySelectorAll(selector)];
      try { if (rootCopy.matches(selector)) nodes.push(rootCopy); } catch { /* selector is internal and fixed */ }
      return nodes;
    };
    selfAndDescendants('script,noscript').forEach((node) => {
      node.textContent = '';
      node.removeAttribute('src');
    });
    selfAndDescendants('link[as="script"]').forEach((node) => node.removeAttribute('href'));
    selfAndDescendants('[integrity]').forEach((node) => node.removeAttribute('integrity'));
    selfAndDescendants('head iframe,head frame').forEach((node) => {
      node.replaceWith(targetDocument.createElement('script'));
    });
    selfAndDescendants('iframe,frame').forEach((node) => {
      node.setAttribute('src', 'about:blank');
      node.removeAttribute('srcdoc');
    });
    selfAndDescendants('a').forEach((node) => {
      node.removeAttribute('target');
      node.setAttribute('target', '_blank');
    });
    const stripEvents = (node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      [...node.attributes].forEach((attribute) => {
        if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name);
      });
      [...node.childNodes].forEach(stripEvents);
    };
    stripEvents(rootCopy);
    return rootCopy.outerHTML.trim().replace(/\s*\n+(\s*\n+)*/g, '\n');
  };

  const waitForStable = async () => {
    const root = document.documentElement;
    if (!root) return;
    const min = Math.max(0, Number(minimumWaitMilliseconds) || 0);
    const quiet = Math.max(0, Number(quietMilliseconds) || 0);
    const limit = Math.max(min, Number(settleTimeoutMilliseconds) || min);
    if (!min && !quiet && !limit) return;
    await new Promise((resolve) => {
      const started = performance.now(); let changed = started;
      const observer = new MutationObserver(() => { changed = performance.now(); });
      observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
      const check = () => {
        const now = performance.now();
        if ((now - started >= min && now - changed >= quiet) || now - started >= limit) { observer.disconnect(); resolve(); }
        else setTimeout(check, Math.max(25, Math.min(100, quiet || 80)));
      };
      setTimeout(check, Math.max(25, Math.min(100, quiet || 80)));
    });
  };

  const capture = () => {
    const captureClone = cloneCaptureDocument();
    if (!captureClone) return { roots: [], matchCount: 0, items: [], text: '', html: '', selectorMatches: [] };
    const { targetDocument } = captureClone;
    const included = new Set();
    const excluded = new Set();
    const automaticallyIncluded = new Set();
    const excludedAttributes = new Map();
    const fields = new Map();
    const sourcesByElement = new Map();
    const mergeFields = (element, nextFields) => {
      const previous = fields.get(element)?.fields || [];
      const keys = new Set(previous.map((field) => `${field.type}:${field.name || ''}`));
      const combined = [...previous];
      for (const field of nextFields) {
        const key = `${field.type}:${field.name || ''}`;
        if (!keys.has(key)) { keys.add(key); combined.push({ ...field }); }
      }
      fields.set(element, { fields: combined });
    };
    const structuralContext = new Set();
    const markLightStructuralContext = (element) => {
      // CSS/XPath `markInclude()` marks every light-DOM parent with
      // hasinclude__. That marker removes direct text but intentionally keeps
      // direct comments when keepComments is enabled.
      for (let current = element?.parentElement || null; current; current = current.parentElement) {
        structuralContext.add(current);
      }
    };
    const markSlotsForHost = (host) => {
      const shadow = shadowFor(host);
      if (!shadow?.querySelectorAll) return;
      for (const slot of shadow.querySelectorAll('slot')) {
        for (let current = slot; current?.nodeType === Node.ELEMENT_NODE; current = current.parentElement) {
          structuralContext.add(current);
        }
      }
    };
    const markXcssStructuralContext = (element) => {
      let parent = element?.parentNode || null;
      let currentRoot = element?.getRootNode?.() || targetDocument;
      const visited = new Set();
      while (parent && !visited.has(parent)) {
        visited.add(parent);
        if (parent.nodeType === Node.ELEMENT_NODE) {
          structuralContext.add(parent);
          markSlotsForHost(parent);
        }
        if (parent === currentRoot && currentRoot !== targetDocument) {
          const host = currentRoot.host;
          if (host) {
            structuralContext.add(host);
            markSlotsForHost(host);
            parent = host.parentNode;
            currentRoot = host.getRootNode?.() || targetDocument;
            continue;
          }
        }
        parent = parent.parentNode;
      }
    };
    const selectorMatches = [];
    for (const locator of locators) {
      const matches = select(locator, targetDocument);
      selectorMatches.push(locator.legacy
        ? { selector: locator.expr, matchCount: matches.length }
        : { type: locator.type, expr: locator.expr, op: locator.op, matchCount: matches.length });
      matches.forEach(({ element, attributeName, selectedNode }) => {
        if (selectedNode && locator.op === 'exclude') selectedNode.remove();
        if (!element) return;
        if (attributeName) {
          if (locator.op === 'exclude') {
            const names = excludedAttributes.get(element) || new Set();
            names.add(attributeName);
            excludedAttributes.set(element, names);
            return;
          }
          mergeFields(element, [{ type: 'attribute', name: attributeName }]);
        }
        (locator.op === 'include' ? included : excluded).add(element);
        if (locator.op === 'include') {
          const sources = sourcesByElement.get(element) || [];
          sources.push(locator);
          sourcesByElement.set(element, sources);
          if (locator.type === 'xcss') markXcssStructuralContext(element);
          else markLightStructuralContext(element);
        }
        if (locator.op === 'include' && !attributeName) {
          mergeFields(element, locator.fields);
        }
      });
    }
    for (const selector of adblockerSelectors()) {
      try {
        targetDocument.querySelectorAll(selector).forEach((element) => excluded.add(element));
      } catch {
        // Cosmetic filters can use browser-specific selector syntax. Ignore an
        // incompatible rule while preserving the user's explicit locators.
      }
    }
    if (includeInlineScripts) {
      // Reference adds this automatic include with the XPath
      // `//script[not(@src)]`. In an HTML document that selects HTML script
      // elements, not SVG's namesake element. Detached clone documents may
      // expose imported HTML nodes with a nonstandard/null namespace in some
      // Chromium paths, so exclude SVG explicitly rather than requiring the
      // XHTML namespace literal.
      [...targetDocument.querySelectorAll('script:not([src])')]
        .filter((element) => element.namespaceURI !== 'http://www.w3.org/2000/svg')
        .forEach((element) => {
          automaticallyIncluded.add(element);
          markLightStructuralContext(element);
        });
    }
    if (includeStyles) {
      targetDocument.querySelectorAll('style, link[rel="stylesheet"]').forEach((element) => {
        automaticallyIncluded.add(element);
        markLightStructuralContext(element);
      });
    }
    // A captured fragment still needs its document base to keep relative
    // resources and links meaningful when it is rendered later.
    targetDocument.querySelectorAll('base').forEach((element) => {
      automaticallyIncluded.add(element);
      markLightStructuralContext(element);
    });
    const rootsFor = (candidates) => {
      const membership = new Set(candidates);
      return [...membership].filter((element) => {
        for (let parent = parentAcrossShadow(element); parent; parent = parentAcrossShadow(parent)) {
          if (membership.has(parent)) return false;
        }
        return true;
      }).sort(compare);
    };
    const roots = rootsFor([...included, ...automaticallyIncluded]);
    // Automatic base/style/script retention is structural context, not a user
    // selector match. Keep its markup without turning a zero-match locator
    // into a false successful match count.
    const matchedRoots = rootsFor(included);
    // Text is produced by one traversal of the filtered document. Joining
    // per-root strings invents blank boundaries that do not exist in the DOM
    // and turns harmless wrapper/list changes into alerts.
    const filtered = makeHtml(captureClone, included, excluded, automaticallyIncluded, excludedAttributes, fields, structuralContext);
    const text = filtered.text;
    const cardSelector = 'article,li,tr,[role="listitem"]';
    const normalizedIdentityText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const excludedOriginals = new Set([...excluded].map((node) => originalNodes.get(node)).filter(Boolean));
    const excludedOriginalAttributes = new Map([...excludedAttributes]
      .map(([node, names]) => [originalNodes.get(node), names]).filter(([node]) => node));
    const labelledCardLinks = new WeakMap();
    const titlePermalink = (element) => {
      const original = originalNodes.get(element);
      const selectedText = normalizedIdentityText(original?.textContent);
      const card = original?.closest?.(cardSelector);
      if (!card || !selectedText) return null;
      if (!labelledCardLinks.has(card)) {
        const byLabel = new Map();
        for (const anchor of card.querySelectorAll('a[href]')) {
          // A visible title can be a sibling of its card's empty hit surface.
          // Its exact accessible/title label is the only evidence connecting
          // them; text links and links belonging to nested cards cannot help.
          if (anchor.closest(cardSelector) !== card || normalizedIdentityText(anchor.textContent)) continue;
          let excludedLink = false;
          for (let current = anchor; current; current = parentAcrossShadow(current)) {
            if (excludedOriginals.has(current)) { excludedLink = true; break; }
          }
          const excludedNames = excludedOriginalAttributes.get(anchor);
          if (excludedLink || excludedNames?.has('href')) continue;
          const rawHref = anchor.getAttribute('href');
          if (!rawHref?.trim()) continue;
          let url;
          try { url = new URL(rawHref, anchor.baseURI || document.baseURI); } catch { continue; }
          if (!['http:', 'https:'].includes(url.protocol)) continue;
          for (const name of ['aria-label', 'title']) {
            if (excludedNames?.has(name)) continue;
            const label = normalizedIdentityText(anchor.getAttribute(name));
            if (!label) continue;
            const urls = byLabel.get(label) || new Set();
            urls.add(url.href);
            byLabel.set(label, urls);
          }
        }
        labelledCardLinks.set(card, byLabel);
      }
      const urls = labelledCardLinks.get(card).get(selectedText);
      return urls?.size === 1 ? [...urls][0] : null;
    };
    const identityFor = (element, sources) => {
      const custom = sources.map((locator) => locator.identityAttribute).filter(Boolean);
      for (const attribute of [...custom, 'data-post-id', 'data-article-id']) {
        const value = element.getAttribute(attribute);
        if (value) return { kind: 'attribute', attribute, value, key: `attr:${attribute}:${value}` };
      }
      const bookmark = element.matches('a[rel~="bookmark"]') ? element : element.querySelector('a[rel~="bookmark"]');
      const anchors = element.matches('a[href]') ? [element] : [...element.querySelectorAll('a[href]')];
      const urls = [...new Set(anchors.map((anchor) => anchor.getAttribute('href')).filter(Boolean))];
      const value = bookmark?.getAttribute('href') || (urls.length === 1 ? urls[0] : null);
      if (value) return { kind: 'permalink', value, key: `url:${value}` };
      const labelledPermalink = titlePermalink(element);
      if (labelledPermalink) return { kind: 'permalink', value: labelledPermalink, key: `url:${labelledPermalink}` };
      for (const attribute of ['data-id', 'id']) {
        const attributeValue = element.getAttribute(attribute);
        if (attributeValue) return { kind: 'attribute', attribute, value: attributeValue, key: `attr:${attribute}:${attributeValue}` };
      }
      return null;
    };
    const items = matchedRoots.filter((element) => element.parentNode || element === targetDocument.documentElement)
      .map((element, originalIndex) => {
        const sources = sourcesByElement.get(element) || [];
        const identity = identityFor(element, sources);
        return {
          text: writeText(element), html: filtered.itemHtml(element),
          ...(identity ? { identity } : {}), originalIndex,
          locator: sources[0] ? { type: sources[0].type, expr: sources[0].expr, op: sources[0].op } : null,
          locators: sources.map((locator) => ({ type: locator.type, expr: locator.expr, op: locator.op, fields: locator.fields })),
          frame: { url: String(location.href || document.URL || '') }
        };
      });
    const html = filtered.html;
    return { roots, matchCount: matchedRoots.length, items, text, html, selectorMatches };
  };

  // Pause only this observer during extraction; capture never writes page DOM.
  liveObserverRecord?.pause?.();
  try {
    if (!includeLocators.length) return { ok: true, exists: false, matchCount: 0, items: [], html: '', data: '', selectorMatches: [] };
    // Live content checks run immediately on the mutation callback; page
    // settling is a scheduled-render concern only.
    if (!captureOptions?.live) await waitForStable();
    const configuredDelay = Math.max(0, Math.min(60_000, Number(captureOptions?.delayMilliseconds) || 0));
    if (configuredDelay) await new Promise((resolve) => setTimeout(resolve, configuredDelay));
    let result = capture();
    const attempts = [{ matchCount: result.matchCount, textLength: result.text.length }];
    // HTML/data comparison still needs a nonempty selected text result to
    // distinguish a real page from a broken selection, but the reference
    // runner limits that mode to two delayed retries rather than waiting the
    // full text-monitor retry budget.
    const retryLimit = captureOptions?.dataAttr === 'data'
      ? Math.min(1, Math.max(0, Number(emptyRetryCount) || 0))
      : Math.max(0, Number(emptyRetryCount) || 0);
    for (let attempt = 0; !captureOptions?.live && !result.text && attempt < retryLimit; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(emptyRetryDelayMilliseconds) || 0)));
      result = capture();
      attempts.push({ matchCount: result.matchCount, textLength: result.text.length });
    }
    const exists = captureOptions?.allowEmpty ? result.matchCount > 0 : Boolean(result.text);
    // Empty selection evidence must show the whole rendered page, not merely
    // the matched-but-textless fragment. That makes login walls, redirects,
    // and page-layout changes diagnosable without overwriting the baseline.
    // A regexp can turn an otherwise successful selection into an empty
    // tracking result later in the worker. Request the same sanitized page
    // evidence up front for that case, then retain it only if filtering really
    // produces a selection-empty outcome.
    const errorHtml = !exists || captureOptions?.captureErrorEvidence === true ? makeErrorEvidence() : '';
    return {
      ok: true,
      exists,
      matchCount: result.matchCount,
      items: result.items,
      text: result.text,
      html: result.html,
      data: result.html,
      errorHtml,
      selectorMatches: result.selectorMatches,
      captureAttempts: attempts,
      captureQuality: {
        status: includeLocators.length > 1 && result.selectorMatches.some((match) => match.op !== 'exclude' && match.matchCount === 0)
          ? 'partial' : 'complete',
        missingLocators: result.selectorMatches.filter((match) => match.op !== 'exclude' && match.matchCount === 0)
      }
    };
  } catch (error) {
    return { ok: false, error: 'Selector capture could not be evaluated: ' + error.message };
  } finally {
    liveObserverRecord?.resume?.();
  }
}

// Reference-compatible CSS monitor capture. All scheduled captures use this
// clone/filter/text pipeline rather than the old root-innerText collector.
async function captureLegacyRenderedDocumentCollection(
  selectors,
  minimumWaitMilliseconds,
  quietMilliseconds,
  settleTimeoutMilliseconds,
  emptyRetryCount = 4,
  emptyRetryDelayMilliseconds = 5_000
) {
  const selectorList = Array.isArray(selectors)
    ? selectors.filter((selector) => typeof selector === 'string' && selector.trim())
    : [];
  const root = document.documentElement;
  if (root) {
    await new Promise((resolve) => {
      const startedAt = performance.now();
      let lastMutationAt = startedAt;
      const observer = new MutationObserver(() => {
        lastMutationAt = performance.now();
      });
      observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
      const tick = () => {
        const now = performance.now();
        const elapsed = now - startedAt;
        if ((elapsed >= minimumWaitMilliseconds && now - lastMutationAt >= quietMilliseconds) || elapsed >= settleTimeoutMilliseconds) {
          observer.disconnect();
          resolve();
          return;
        }
        setTimeout(tick, Math.min(100, quietMilliseconds));
      };
      setTimeout(tick, Math.min(100, quietMilliseconds));
    });
  }

  const blockElements = new Set([
    'ARTICLE', 'BLOCKQUOTE', 'CAPTION', 'CODE', 'DD', 'DIV', 'FIELDSET', 'FOOTER', 'FORM',
    'HEADER', 'LI', 'OL', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TFOOT', 'THEAD', 'TR',
    'UL', 'IMG', 'BR'
  ]);
  const spacedElements = new Set(['A', 'ABBR', 'ACRONYM', 'ADDRESS', 'BUTTON', 'TD']);
  const excludedElements = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'FRAME', 'IFRAME']);
  const markerInclude = 'data-openstill-reference-include';
  const markerAncestor = 'data-openstill-reference-ancestor';

  const compareDocumentOrder = (left, right) => {
    if (left === right) return 0;
    const position = left.compareDocumentPosition(right);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  };

  const rootsFor = (elements) => [...elements].filter((element) => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (elements.has(parent)) return false;
    }
    return true;
  }).sort(compareDocumentOrder);

  // This mirrors the reference extractor rather than using innerText:
  // preserve block boundaries, retain CSS-hidden text, and ignore only the
  // same non-content elements filtered by the monitor.
  const textForElement = (element) => {
    const buffer = [];
    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        buffer.push(node.nodeValue || '');
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || excludedElements.has(node.tagName)) return;
      let isBlock = blockElements.has(node.tagName);
      try {
        isBlock = isBlock || getComputedStyle(node).display === 'block';
      } catch {
        // The semantic block list covers detached or transient elements.
      }
      if (isBlock) buffer.push('\n');
      else if (spacedElements.has(node.tagName)) buffer.push(' ');
      for (const child of node.childNodes) visit(child);
    };
    visit(element);
    return buffer.join('')
      .trim()
      .replace(/\s*\n+(\s*\n+)*/g, '\n')
      .replace(/[ \t]+/g, ' ');
  };

  const pathFromDocumentRoot = (element) => {
    const path = [];
    let current = element;
    while (current && current !== document.documentElement) {
      const parent = current.parentNode;
      if (!parent) return null;
      path.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
      current = parent;
    }
    return current === document.documentElement ? path : null;
  };

  const nodeAtPath = (cloneRoot, path) => {
    let current = cloneRoot;
    for (const index of path ?? []) {
      current = current?.childNodes[index];
      if (!current) return null;
    }
    return current;
  };

  const cleanClone = (cloneRoot) => {
    const walker = cloneRoot.ownerDocument.createTreeWalker(cloneRoot, NodeFilter.SHOW_COMMENT);
    const comments = [];
    while (walker.nextNode()) comments.push(walker.currentNode);
    comments.forEach((comment) => comment.remove());
    cloneRoot.querySelectorAll('script, style, noscript, frame, iframe, link[as="script"], link[rel="stylesheet"]').forEach((node) => node.remove());
    cloneRoot.querySelectorAll('*').forEach((node) => {
      for (const attribute of [...node.attributes]) {
        if (/^on/i.test(attribute.name) || attribute.name === 'style' || attribute.name === 'integrity') {
          node.removeAttribute(attribute.name);
        }
      }
    });
    const absoluteUrl = (value) => {
      try {
        return new URL(value, document.baseURI).href;
      } catch {
        return value;
      }
    };
    cloneRoot.querySelectorAll('a[href]').forEach((node) => node.setAttribute('href', absoluteUrl(node.getAttribute('href'))));
    cloneRoot.querySelectorAll('audio[src], img[src], video[src]').forEach((node) => node.setAttribute('src', absoluteUrl(node.getAttribute('src'))));
  };

  // Build the same filtered HTML shape as the reference: retain selected
  // subtrees and the minimum ancestor path, discard all unrelated page churn.
  const filteredHtmlForRoots = (roots) => {
    if (!roots.length || !document.documentElement) return '';
    const clonedDocument = document.implementation.createHTMLDocument('');
    const cloneRoot = document.documentElement.cloneNode(true);
    clonedDocument.replaceChild(cloneRoot, clonedDocument.documentElement);
    for (const rootElement of roots) {
      const clone = nodeAtPath(cloneRoot, pathFromDocumentRoot(rootElement));
      if (!clone || clone.nodeType !== Node.ELEMENT_NODE) continue;
      clone.setAttribute(markerInclude, '1');
      for (let parent = clone.parentElement; parent; parent = parent.parentElement) {
        parent.setAttribute(markerAncestor, '1');
      }
    }
    const prune = (node, insideIncluded = false) => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (!insideIncluded) node.remove();
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) {
        node.remove();
        return;
      }
      if (excludedElements.has(node.tagName)) {
        node.remove();
        return;
      }
      const included = insideIncluded || node.hasAttribute(markerInclude);
      if (!included && !node.hasAttribute(markerAncestor)) {
        node.remove();
        return;
      }
      for (const child of [...node.childNodes]) prune(child, included);
    };
    prune(cloneRoot);
    cleanClone(cloneRoot);
    cloneRoot.removeAttribute(markerInclude);
    cloneRoot.removeAttribute(markerAncestor);
    cloneRoot.querySelectorAll(`[${markerInclude}], [${markerAncestor}]`).forEach((node) => {
      node.removeAttribute(markerInclude);
      node.removeAttribute(markerAncestor);
    });
    return cloneRoot.outerHTML;
  };

  const capture = () => {
    const selected = new Set();
    const selectorMatches = [];
    for (const selector of selectorList) {
      const matches = [...document.querySelectorAll(selector)];
      selectorMatches.push({ selector, matchCount: matches.length });
      matches.forEach((element) => selected.add(element));
    }
    const roots = rootsFor(selected);
    const items = roots.map((element) => ({ text: textForElement(element) }));
    const filteredHtml = filteredHtmlForRoots(roots);
    const text = items.map((item) => item.text).filter(Boolean).join('\n\n');
    return { roots, items, text, html: filteredHtml, selectorMatches };
  };

  try {
    if (!selectorList.length) {
      return { ok: true, exists: false, matchCount: 0, items: [], selectorMatches: [] };
    }
    let result = capture();
    // Reference runner begins at retryCount 0 and retries while it is <= 4,
    // giving six total attempts and five 5-second waits for an empty selection.
    for (let retryCount = 0; !result.text && retryCount <= emptyRetryCount; retryCount += 1) {
      await new Promise((resolve) => setTimeout(resolve, emptyRetryDelayMilliseconds));
      result = capture();
    }
    return {
      ok: true,
      exists: Boolean(result.text),
      matchCount: result.roots.length,
      items: result.items,
      html: result.html,
      selectorMatches: result.selectorMatches
    };
  } catch (error) {
    return { ok: false, error: 'CSS selector could not be evaluated: ' + error.message };
  }
}

async function inspectLegacyRenderedDocumentCollection(selectors, minimumWaitMilliseconds, quietMilliseconds, settleTimeoutMilliseconds) {
  const selectorList = Array.isArray(selectors) ? selectors : [];
  const root = document.documentElement;
  if (root) {
    await new Promise((resolve) => {
      const startedAt = performance.now();
      let lastMutationAt = startedAt;
      const observer = new MutationObserver(() => {
        lastMutationAt = performance.now();
      });
      observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
      const tick = () => {
        const now = performance.now();
        const elapsed = now - startedAt;
        if ((elapsed >= minimumWaitMilliseconds && now - lastMutationAt >= quietMilliseconds) || elapsed >= settleTimeoutMilliseconds) {
          observer.disconnect();
          resolve();
          return;
        }
        setTimeout(tick, Math.min(100, quietMilliseconds));
      };
      setTimeout(tick, Math.min(100, quietMilliseconds));
    });
  }

  try {
    const selected = new Set();
    for (const selector of selectorList) {
      document.querySelectorAll(selector).forEach((element) => selected.add(element));
    }

    const roots = [...selected].filter((element) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (selected.has(parent)) return false;
      }
      return true;
    }).sort((left, right) => {
      if (left === right) return 0;
      const position = left.compareDocumentPosition(right);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    return {
      ok: true,
      exists: roots.length > 0,
      matchCount: roots.length,
      items: roots.map((element) => ({
        text: String(element.innerText || element.textContent || '').slice(0, 10_000)
      }))
    };
  } catch (error) {
    return { ok: false, error: 'CSS 선택자를 해석할 수 없습니다: ' + error.message };
  }
}

// This is intentionally self-contained because chrome.scripting serializes a
// `func` into the target frame without its lexical scope.  It mirrors the
// reference runner's page-level `getSanitizedDoc` call, which is used as
// selection-empty evidence regardless of which configured subframe failed.
function captureSanitizedErrorEvidenceDocument() {
  try {
    const baseURI = String(document.baseURI || '');
    const clonedDocument = document.cloneNode(true);
    if (!/^(?:data:|about:)/.test(baseURI)) {
      let base = clonedDocument.getElementsByTagName('base')[0] || null;
      if (!base) {
        base = clonedDocument.createElement('base');
        const head = clonedDocument.getElementsByTagName('head')[0];
        if (head) head.prepend(base);
      }
      base?.setAttribute('href', baseURI);
    }

    const root = clonedDocument.documentElement;
    if (!root) return { ok: true, html: '' };
    const selfAndDescendants = (selector) => {
      const matches = [...root.querySelectorAll(selector)];
      try { if (root.matches(selector)) matches.push(root); } catch { /* fixed internal selector */ }
      return matches;
    };
    selfAndDescendants('script,noscript').forEach((node) => {
      node.textContent = '';
      node.removeAttribute('src');
    });
    selfAndDescendants('link[as="script"]').forEach((node) => node.removeAttribute('href'));
    selfAndDescendants('[integrity]').forEach((node) => node.removeAttribute('integrity'));
    selfAndDescendants('head iframe,head frame').forEach((node) => {
      node.replaceWith(clonedDocument.createElement('script'));
    });
    selfAndDescendants('iframe,frame').forEach((node) => {
      node.setAttribute('src', 'about:blank');
      node.removeAttribute('srcdoc');
    });
    selfAndDescendants('a').forEach((node) => {
      node.removeAttribute('target');
      node.setAttribute('target', '_blank');
    });
    const stripEventAttributes = (node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      [...node.attributes].forEach((attribute) => {
        if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name);
      });
      [...node.childNodes].forEach(stripEventAttributes);
    };
    stripEventAttributes(root);
    return {
      ok: true,
      html: root.outerHTML.trim().replace(/\s*\n+(\s*\n+)*/g, '\n')
    };
  } catch (error) {
    return { ok: false, error: 'Could not sanitize page evidence: ' + (error?.message || String(error)) };
  }
}

async function captureRenderedSnapshot(monitor, existingTabId = null, { live = false, frameId: liveFrameId = null, job = null } = {}) {
  // Pinned tabs are Chrome's favicon-only, leftmost tab UI. They make a
  // scheduled check visible without taking focus or leaving a titled tab in
  // the strip; a live watcher passes its extension-owned tab, which this
  // function deliberately leaves open after reusing the same capture path.
  const ownsTab = !Number.isInteger(existingTabId);
  const assertActive = () => {
    if (job?.cancelled || job?.signal?.aborted || job?.isCancelled?.()) throw new Error('캡처 작업이 취소됐습니다.');
  };
  assertActive();
  const tab = ownsTab ? await chrome.tabs.create({
    url: monitor.url,
    active: false,
    pinned: true,
    index: 0
  }) : { id: existingTabId };
  if (!Number.isInteger(tab?.id)) {
    throw new Error('Could not create a background tab for checking.');
  }
  let ready;
  try {
    if (ownsTab) {
      if (job) job.ownedTabId = tab.id;
      await job?.onTabCreated?.(tab.id);
    }
    if (ownsTab) {
      ready = waitForRenderedTab(tab.id);
      await ready.promise;
    }
    assertActive();
    let frames = [{ frameId: 0, parentFrameId: -1 }];
    if (monitor.locators.some((locator) => locator.frameId !== 0 || locator.framePath?.length || locator.frameUrl)) {
      if (typeof chrome.webNavigation?.getAllFrames !== 'function') throw new Error('Subframe selector capture is unavailable.');
      frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
      frames = await collectStableFrameDescriptors(tab.id, frames);
    }
    const frameById = new Map(frames.map((frame) => [frame.frameId, frame]));
    const frameGroups = new Map();
    const savedFrameOrder = new Map();
    for (const locator of monitor.locators) {
      const frameId = resolveLocatorFrame(locator, frames);
      if (!frameGroups.has(frameId)) frameGroups.set(frameId, []);
      frameGroups.get(frameId).push(locator);
      // Reference Runner orders selected frame configurations by their saved
      // `frame.index`, descending.  A stored `frameOrder` preserves that key
      // across Chrome frame-ID reassignment; legacy records use the original
      // frameId, which is the closest equivalent ordering key they retained.
      const order = Number.isInteger(locator.frameOrder) ? locator.frameOrder : locator.frameId;
      const prior = savedFrameOrder.get(frameId);
      if (!Number.isInteger(prior) || order > prior) savedFrameOrder.set(frameId, order);
    }
    const requestedFrameIds = [...frameGroups.keys()];
    for (const frameId of requestedFrameIds) {
      if (frameId === -1) throw new Error('저장된 iframe을 명확하게 식별하지 못했습니다. 이전 정상 자료를 유지하며, 선택기로 프레임을 다시 지정해야 합니다.');
      if (!frameById.has(frameId)) throw new Error(`The configured frame (${frameId}) is not available on this page.`);
    }
    const captures = [];
    const orderedFrames = frames
      .filter((frame) => frameGroups.has(frame.frameId))
      .sort((left, right) => (
        (savedFrameOrder.get(right.frameId) ?? right.frameId)
        - (savedFrameOrder.get(left.frameId) ?? left.frameId)
      ) || right.frameId - left.frameId);
    for (let frameIndex = 0; frameIndex < orderedFrames.length; frameIndex += 1) {
      assertActive();
      const frame = orderedFrames[frameIndex];
      // Page settling and a configured delay apply once to the complete
      // capture transaction, before the innermost configured frame. Repeating
      // them for every frame makes a multi-frame monitor wait N times longer
      // and can capture each frame at a different logical page moment.
      const firstFrame = frameIndex === 0;
      let execution;
      try {
        execution = await chrome.scripting.executeScript({
          target: frame.frameId === 0 ? { tabId: tab.id } : { tabId: tab.id, frameIds: [frame.frameId] },
          func: captureReferenceRenderedDocumentCollection,
          args: [frameGroups.get(frame.frameId), firstFrame && !live ? 2_000 : 0, 0, firstFrame && !live ? 2_000 : 0,
            live ? 0 : RENDER_EMPTY_RETRY_COUNT, live ? 0 : RENDER_EMPTY_RETRY_DELAY_MS, {
              allowEmpty: monitor.tracking?.allowEmpty === true,
              delayMilliseconds: firstFrame && !live ? monitor.tracking?.delayMilliseconds ?? 0 : 0,
              includeScript: monitor.tracking?.includeScript === true,
              includeStyle: monitor.tracking?.includeStyle === true,
              keepComments: monitor.tracking?.keepComments === true,
              captureErrorEvidence: Boolean(normalizeTracking(monitor.tracking).regexp),
              dataAttr: monitor.tracking?.dataAttr === 'data' ? 'data' : 'text',
              live: Boolean(live),
              liveMonitorId: live ? monitor.id : null
            }]
        });
      } catch (error) {
        throw new Error(`Could not inspect frame ${frame.frameId}: ${responseError(error)}`);
      }
      const frameResult = execution[0]?.result;
      if (!frameResult?.ok) throw new Error(frameResult?.error || `Could not inspect frame ${frame.frameId}.`);
      captures.push({ frameId: frame.frameId, frame, result: frameResult });
    }
    const frameDescriptor = (frameId, frame = {}) => ({
      url: normalizeFrameUrl(frame.url) || (frameId === 0 ? monitor.url : ''),
      path: framePathForFrame(frameId, frames) || []
    });
    const result = {
      ok: true,
      selectorMatches: captures.flatMap(({ frameId, frame, result }) => (result.selectorMatches || []).map((match) => ({ ...match, frameId, frame: frameDescriptor(frameId, frame) })))
    };
    // The reference runner appends each configured frame's filtered document
    // text in capture order. Keep one aggregate item so snapshot normalization
    // cannot introduce a synthetic separator between frame results.
    const rawText = captures.map(({ result: frameResult }) => {
      // New rendered collectors return their already-normalized aggregate in
      // `text`.  Older persisted/background capture adapters only returned
      // `items`, though, so preserve that real payload instead of converting a
      // successful selection into an empty result during migration.
      if (typeof frameResult.text === 'string') return frameResult.text;
      return Array.isArray(frameResult.items)
        ? frameResult.items.map((item) => String(item?.text ?? '')).join('\n\n')
        : '';
    }).join('');
    result.text = rawText;
    result.items = captures.flatMap(({ frameId, frame, result: frameResult }) => (
      Array.isArray(frameResult.items) ? frameResult.items.map((item) => ({
        ...item, frame: { ...(item.frame || {}), ...frameDescriptor(frameId, frame), frameId }
      })) : []
    ));
    if (!result.items.length && result.text) result.items = [{ text: result.text }];
    // The reference runner appends each filtered frame document directly to
    // `result.data` (`result.data += html`).  Preserve that byte order rather
    // than wrapping nested <html> documents in dashboard-only markup: wrapper
    // nodes become part of a data-mode comparison and make an unchanged page
    // appear different from the reference result.
    const frameHtml = (frameResult) => typeof frameResult.html === 'string'
      ? frameResult.html
      : typeof frameResult.data === 'string' ? frameResult.data : '';
    const frameData = (frameResult) => typeof frameResult.data === 'string'
      ? frameResult.data
      : frameHtml(frameResult);
    result.data = captures.map(({ result: frameResult }) => frameData(frameResult)).join('');
    result.html = result.data;
    result.matchCount = captures.reduce((total, { result: frameResult }) => (
      total + (Number.isInteger(frameResult.matchCount) ? frameResult.matchCount : Array.isArray(frameResult.items) ? frameResult.items.length : 0)
    ), 0);
    const filtered = await filterCapturedText(rawText, monitor.tracking, result.items.map((item) => item.text));
    const filteredText = filtered.text;
    assertActive();
    if (normalizeTracking(monitor.tracking).regexp) {
      // Filter the aggregate and roots in the same disposable worker. Keep
      // root identity while aggregate text remains the comparison payload.
      result.items = result.items.map((item, index) => ({ ...item, text: filtered.itemTexts[index] ?? '' }));
    }
    result.text = filteredText;
    // The reference content observer performs its nonempty gate before the
    // live runner applies regexp filtering. Thus a raw selection with no
    // regexp matches is an ordinary empty comparison, not selector failure.
    result.exists = live
      ? Boolean(rawText)
      : monitor.tracking?.allowEmpty ? result.matchCount > 0 : Boolean(result.text);
    if (result.exists) {
      result.errorHtml = '';
    } else if (live) {
      // Suppressed live-empty observations never generate full-page evidence.
      result.errorHtml = '';
    } else {
      // Selection-empty snapshots always come from the top-level document in
      // the reference runner, even if the configured selector lives only in a
      // nested frame.  Do not combine subframe evidence: it would be a
      // different document and cannot explain the page-level load state.
      try {
        const evidenceExecution = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: captureSanitizedErrorEvidenceDocument
        });
        const evidence = evidenceExecution[0]?.result;
        result.errorHtml = evidence?.ok && typeof evidence.html === 'string'
          ? evidence.html
          : captures.find(({ frameId }) => frameId === 0)?.result?.errorHtml || '';
      } catch {
        // Keep the top-frame collector evidence as a narrow compatibility
        // fallback when an environment forbids a second script injection. A
        // subframe result is deliberately never substituted here.
        result.errorHtml = captures.find(({ frameId }) => frameId === 0)?.result?.errorHtml || '';
      }
    }

    const snapshot = normalizeSnapshot({
      captureVersion: 2,
      exists: Boolean(result.exists),
      matchCount: Number.isInteger(result.matchCount) ? result.matchCount : 0,
      items: result.items,
      text: result.text,
      html: result.html,
      data: result.data ?? result.html,
      evidenceHtml: result.errorHtml,
      selectorMatches: result.selectorMatches,
      captureAttempts: captures.flatMap(({ frameId, result: frameResult }) => (frameResult.captureAttempts || []).map((attempt) => ({ ...attempt, frameId }))),
      captureQuality: {
        status: captures.some(({ result: frameResult }) => frameResult.captureQuality?.status === 'partial')
          || (monitor.locators.filter((locator) => locator.op !== 'exclude').length > 1
            && result.selectorMatches.some((match) => match.op !== 'exclude' && match.matchCount === 0)) ? 'partial' : 'complete',
        missingLocators: result.selectorMatches.filter((match) => match.op !== 'exclude' && match.matchCount === 0)
      },
      capturedAt: nowIso()
    });
    if (!snapshot) {
      throw new Error('선택자 목록 결과를 정리하지 못했습니다.');
    }
    if (live) {
      // The value is deliberately non-enumerable: it is needed to reproduce
      // content-side live dedupe, but it is not part of the persisted
      // comparison snapshot (which contains regexp-filtered `text`).
      Object.defineProperty(snapshot, 'liveRawText', {
        value: rawText,
        enumerable: false,
        configurable: true
      });
    }
    return snapshot;
  } finally {
    ready?.cancel();
    if (ownsTab) {
      await chrome.tabs.remove(tab.id).catch(async () => {
        // A browser can occasionally reject removal while a pinned tab is being
        // animated into the strip. Unpin and make one final best-effort removal.
        await chrome.tabs.update(tab.id, { pinned: false }).catch(() => undefined);
        await chrome.tabs.remove(tab.id).catch(() => undefined);
      });
    }
  }
}

// This function is deliberately self-contained because Chrome serializes it
// into the monitored page.  It observes only; the service worker always makes
// the actual typed-locator capture, so live and scheduled checks share one
// filtering, frame, retry, and comparison implementation.
function installLiveMutationObserver(monitorId, revision, options = {}) {
  const registryKey = '__openStillLiveMutationObservers';
  const registry = globalThis[registryKey] || (globalThis[registryKey] = new Map());
  const existing = registry.get(monitorId);
  if (existing?.revision === revision) {
    return { ok: true, reused: true };
  }
  existing?.observer?.disconnect();
  if (existing?.shadowRescanTimer) clearInterval(existing.shadowRescanTimer);
  if (existing?.propertyTimer) clearInterval(existing.propertyTimer);
  if (existing?.notify) { document.removeEventListener('input', existing.notify, true); document.removeEventListener('change', existing.notify, true); }

  const notify = () => {
    try {
      const sent = chrome.runtime.sendMessage({
        type: 'live-monitor-mutated',
        id: monitorId,
        revision,
        observedAt: Date.now()
      });
      sent?.catch?.(() => undefined);
    } catch {
      // A page can be unloading while the isolated world still has an observer.
    }
  };
  const observedRoots = new Set();
  let paused = false;
  const observerOptions = {
    attributes: true,
    childList: true,
    characterData: true,
    subtree: true
  };
  // The picker is extension UI hosted in a closed shadow tree.  We deliberately
  // pierce page shadow trees for live monitoring, but enrolling our own UI
  // would turn ordinary editor/highlight updates into monitor captures.  A
  // native document observer cannot see into that closed root, so preserve
  // the same boundary when using chrome.dom.openOrClosedShadowRoot().
  const isPickerHost = (element) => String(element?.localName || '').toLowerCase() === 'openstill-picker-root'
    && element.getAttribute?.('data-openstill-picker-ui') === 'true';
  const shadowFor = (element) => {
    const read = (getter) => {
      try { return getter() || null; } catch { return null; }
    };
    const usable = (root) => root?.nodeType === Node.DOCUMENT_FRAGMENT_NODE
      && typeof root.querySelectorAll === 'function'
      ? root
      : null;
    return usable(read(() => element?.shadowRoot))
      || usable(read(() => element?._shadowRoot))
      || usable(read(() => chrome?.dom?.openOrClosedShadowRoot?.(element)));
  };
  const discoverShadowRoots = (node) => {
    if (!(node instanceof Element)) return;
    if (isPickerHost(node)) return;
    const candidates = [node, ...node.querySelectorAll('*')];
    for (const element of candidates) {
      if (!isPickerHost(element)) observeRoot(shadowFor(element));
    }
  };
  const observer = new MutationObserver((records) => {
    if (paused) return;
    for (const record of records) {
      record.addedNodes.forEach(discoverShadowRoots);
    }
    // Reference Live immediately starts its filter for each delivered batch.
    // In-flight worker capture is coalesced separately by requestLiveCapture;
    // delaying here would make a short-lived DOM value invisible.
    notify();
  });
  const observeRoot = (root) => {
    if (!(root instanceof Node) || observedRoots.has(root)) return;
    observedRoots.add(root);
    if (!paused) observer.observe(root, observerOptions);
    if (typeof root.querySelectorAll === 'function') {
      root.querySelectorAll('*').forEach((element) => {
        if (!isPickerHost(element)) observeRoot(shadowFor(element));
      });
    }
  };
  const pause = () => {
    if (paused) return;
    paused = true;
    observer.disconnect();
  };
  const resume = () => {
    if (!paused) return;
    paused = false;
    observedRoots.forEach((observedRoot) => observer.observe(observedRoot, observerOptions));
  };
  const root = document.documentElement;
  if (!root) return { ok: false, error: 'The page has no document root.' };
  observeRoot(root);
  // Attaching a shadow root itself is not a MutationObserver record. Rescan
  // hosts at a modest cadence so a component which creates a *closed* root
  // after live monitoring starts is enrolled before its next internal change.
  const shadowRescanTimer = setInterval(() => {
    let removed = false;
    for (const observed of [...observedRoots]) {
      if (observed.isConnected === false || observed.host?.isConnected === false) { observedRoots.delete(observed); removed = true; }
    }
    if (removed && !paused) { observer.disconnect(); observedRoots.forEach((observed) => observer.observe(observed, observerOptions)); }
    const priorCount = observedRoots.size;
    observeRoot(document.documentElement);
    for (const observed of [...observedRoots]) {
      observed.querySelectorAll?.('*').forEach((element) => { if (!isPickerHost(element)) observeRoot(shadowFor(element)); });
    }
    if (removed || observedRoots.size !== priorCount) notify();
  }, 10_000);
  document.addEventListener('input', notify, true);
  document.addEventListener('change', notify, true);
  const propertyTimer = options.propertyPolling ? setInterval(notify, 15_000) : null;
  const record = {
    revision,
    observer,
    observedRoots,
    shadowRescanTimer,
    propertyTimer,
    notify,
    pause,
    resume
  };
  registry.set(monitorId, record);
  addEventListener('pagehide', () => {
    if (registry.get(monitorId) !== record) return;
    observer.disconnect();
    clearInterval(shadowRescanTimer);
    if (propertyTimer) clearInterval(propertyTimer);
    document.removeEventListener('input', notify, true);
    document.removeEventListener('change', notify, true);
    registry.delete(monitorId);
  }, { once: true });
  return { ok: true, reused: false };
}

function removeLiveMutationObserver(monitorId) {
  const registry = globalThis.__openStillLiveMutationObservers;
  const record = registry?.get(monitorId);
  record?.observer?.disconnect();
  if (record?.timer) clearTimeout(record.timer);
  if (record?.shadowRescanTimer) clearInterval(record.shadowRescanTimer);
  if (record?.propertyTimer) clearInterval(record.propertyTimer);
  if (record?.notify) { document.removeEventListener('input', record.notify, true); document.removeEventListener('change', record.notify, true); }
  registry?.delete(monitorId);
  return { ok: true };
}

function inspectLiveMutationObserver(monitorId, revision) {
  const record = globalThis.__openStillLiveMutationObservers?.get(monitorId);
  return { ok: Boolean(record?.observer && record.revision === revision), revision: record?.revision || null };
}

async function refreshBadge(monitors = null) {
  const list = monitors ?? (typeof getMonitorSummaries === 'function' ? await getMonitorSummaries() : await getMonitors());
  const unreadCount = list.filter((monitor) => monitor.unread).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#EF6A5B' });
  await chrome.action.setBadgeText({ text: unreadCount ? String(unreadCount) : '' });
}

async function playAlertSound() {
  const { settings } = await getState();
  if (!settings.soundEnabled || Date.now() - lastSoundAt < SOUND_DEBOUNCE_MS) {
    return;
  }

  lastSoundAt = Date.now();
  await ensureOffscreenDocument();
  await chrome.runtime.sendMessage({ type: 'play-alert-sound' }).catch(() => undefined);
}

async function announceChange(monitor) {
  const notificationId = `openstill-change:${monitor.id}`;
  try {
    await chrome.notifications.create(notificationId, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'OpenStill · 변경 감지',
      message: `${monitor.name}에서 변경을 확인했습니다.`,
      priority: 1
    });
  } catch (error) {
    console.warn('OpenStill could not show a change notification.', error);
  }
  await playAlertSound().catch((error) => console.warn('OpenStill could not play a change sound.', error));
}

function dueTimestamp(monitor) {
  const timestamp = Date.parse(monitor.nextCheckAt ?? '');
  // A malformed/imported CRON expression can be retained but deliberately
  // unscheduled. Treat its absent due time as infinity rather than "now" so
  // it cannot wake the service worker in a tight loop.
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
}

async function scheduleNextAlarm() {
  const operation = alarmQueue.catch(() => undefined).then(async () => {
    const monitors = typeof getMonitorSummaries === 'function' ? await getMonitorSummaries() : await getMonitors();
    const enabled = monitors
      .filter((monitor) => monitor.enabled && isAutomaticSchedule(monitor))
      .map((monitor) => ({ monitor, due: Math.max(dueTimestamp(monitor), storageFailureBackoff.get(monitor.id)?.retryAt || 0) }))
      .filter(({ due }) => Number.isFinite(due));
    if (precisionScheduleTimer !== null) {
      clearTimeout(precisionScheduleTimer);
      precisionScheduleTimer = null;
    }
    if (!enabled.length) {
      await chrome.alarms.clear(ALARM_NAME);
      return;
    }

    const nextDue = enabled.reduce((earliest, entry) => Math.min(earliest, entry.due), Infinity);
    const now = Date.now();
    const delay = Math.max(0, nextDue - now);
    if (delay < MIN_CHROME_ALARM_DELAY_MS) {
      // Chrome alarms may defer sub-30-second wakeups, but a live service
      // worker can honor the five-second Reference cadence precisely. Keep an
      // alarm at Chrome's reliable floor as a recovery fallback if MV3 tears
      // down this worker before the in-memory timer fires.
      let timer;
      timer = setTimeout(() => {
        if (precisionScheduleTimer !== timer) return;
        precisionScheduleTimer = null;
        void runDueChecks();
      }, delay);
      // Node-based tests should not be held open by a future precision timer;
      // browser timeout ids are numeric and simply do not expose unref().
      timer?.unref?.();
      precisionScheduleTimer = timer;
      await chrome.alarms.create(ALARM_NAME, { when: now + MIN_CHROME_ALARM_DELAY_MS });
      return;
    }
    await chrome.alarms.create(ALARM_NAME, { when: Math.max(now + 1_000, nextDue) });
  });
  alarmQueue = operation.catch(() => undefined);
  return operation;
}

function appendRunHistory(monitor, entry) {
  const prior = Array.isArray(monitor.runs) ? monitor.runs : [];
  monitor.runs = [{
    at: asIso(entry?.at, nowIso()),
    status: VALID_STATUSES.has(entry?.status) ? entry.status : 'error',
    code: cleanShortText(entry?.code, 80) || null,
    message: cleanShortText(entry?.message, 300) || null,
    changed: Boolean(entry?.changed),
    matchCount: Number.isInteger(entry?.matchCount) && entry.matchCount >= 0 ? entry.matchCount : null
  }, ...prior].slice(0, MAX_RUN_HISTORY);
}

function hasSuccessfulRun(monitor, { pendingFailure = false } = {}) {
  // The reference scheduler queries the newest ten work logs *after* the
  // current failed run is recorded.  Failure scheduling here happens just
  // before appendRunHistory(), so reserve one of those ten slots to avoid
  // granting a quick retry based on an eleventh-old success.
  const limit = pendingFailure ? 9 : 10;
  const runs = Array.isArray(monitor?.runs) ? monitor.runs.slice(0, limit) : [];
  if (runs.length) return runs.some((run) => run?.status === 'ok' || run?.status === 'changed');
  // Legacy/imported monitors can have a baseline before run-history support.
  const snapshot = monitor?.snapshot;
  return Boolean(snapshot && (snapshot.exists || normalizeTracking(monitor?.tracking).allowEmpty));
}

function retryDelayForSchedule(monitor) {
  const schedule = scheduleDescriptorOf(monitor);
  if (!schedule) return null;
  if (schedule.type === SCHEDULE_MODE_INTERVAL) return Math.min(120_000, schedule.params.interval * 1_000);
  if (schedule.type === SCHEDULE_MODE_RANDOM) return Math.min(120_000, schedule.params.max * 1_000);
  if (schedule.type === SCHEDULE_MODE_CRON) return 60_000;
  return null;
}

async function setCheckFailure(id, expectedRevision, status, errorMessage, source = 'manual') {
  const checkedAt = nowIso();
  await mutateMonitors((monitors) => {
    const monitor = monitors.find((item) => item.id === id);
    if (!monitor || !monitor.enabled || monitor.revision !== expectedRevision) {
      return null;
    }
    const advancesSchedule = source !== 'live' || scheduleDescriptorOf(monitor)?.type === SCHEDULE_MODE_LIVE;
    if (advancesSchedule) monitor.lastCheckedAt = checkedAt;
    const retryDelay = isAutomaticSchedule(monitor) && hasSuccessfulRun(monitor, { pendingFailure: true })
      ? retryDelayForSchedule(monitor)
      : null;
    if (advancesSchedule) {
      monitor.nextCheckAt = retryDelay
        ? new Date(Date.now() + retryDelay).toISOString()
        : nextCheckForSchedule(monitor.schedule, checkedAt, monitor.intervalHours);
    }
    monitor.status = status;
    monitor.lastReviewAt = null;
    monitor.lastError = cleanText(errorMessage, 300);
    monitor.updatedAt = checkedAt;
    appendRunHistory(monitor, {
      at: checkedAt,
      status,
      code: status,
      message: monitor.lastError,
      changed: false
    });
    return monitor;
  }, { operation: false });
}

function statusForStoredSnapshot(snapshot, tracking = null) {
  if (!snapshot) return 'needs-baseline';
  return snapshot.exists || normalizeTracking(tracking).allowEmpty ? 'ok' : 'needs-review';
}

function appendSnapshotHistory(monitor, snapshot, kind) {
  if (!snapshot) return;
  const entry = {
    snapshot,
    capturedAt: snapshot.capturedAt ?? nowIso(),
    kind: kind === 'baseline' ? 'baseline' : 'change'
  };
  const prior = Array.isArray(monitor.history) ? monitor.history : [];
  monitor.history = [entry, ...prior].slice(0, MAX_CHANGE_HISTORY);
}

function applySnapshotOutcome(monitor, nextSnapshot, checkedAt) {
  // A missing match is deliberately not a comparison result. A session can have
  // expired, the page can be behind a login wall, or a temporary error page can
  // be rendered. Keep the last successful snapshot so a later reappearance is
  // compared against real content instead of producing a false change.
  const tracking = normalizeTracking(monitor.tracking);
  const selectorMatchKey = (entry) => JSON.stringify([entry.frameId || 0, entry.locatorKey || entry.key || entry.expr, entry.type, entry.op]);
  const priorMatches = new Map((monitor.snapshot?.selectorMatches || []).map((entry) => [selectorMatchKey(entry), entry.matchCount]));
  const lostSelection = (nextSnapshot?.selectorMatches || []).some((entry) => entry.op !== 'exclude' && (priorMatches.get(selectorMatchKey(entry)) || 0) > 0 && entry.matchCount === 0);
  if (nextSnapshot?.captureQuality === 'partial' || nextSnapshot?.captureQuality?.status === 'partial' || lostSelection && !(tracking.allowEmpty && (nextSnapshot.selectorMatches || []).filter((entry) => entry.op !== 'exclude').length === 1)) {
    monitor.status = 'needs-review';
    monitor.lastReviewAt = checkedAt;
    monitor.lastError = '일부 선택 영역을 찾지 못했습니다. 이전 정상 기준값을 유지합니다.';
    monitor.lastErrorSnapshot = nextSnapshot;
    return { changed: false, needsReview: true, partial: true, reason: 'selection-partial', message: monitor.lastError };
  }
  if (!nextSnapshot.exists && !tracking.allowEmpty) {
    monitor.status = 'needs-review';
    monitor.lastReviewAt = checkedAt;
    const matched = nextSnapshot.matchCount > 0
      || (nextSnapshot.selectorMatches || []).some((entry) => entry.op !== 'exclude' && entry.matchCount > 0);
    monitor.lastError = matched ? ELEMENT_CONTENT_EMPTY_MESSAGE : ELEMENT_NOT_FOUND_MESSAGE;
    monitor.lastErrorSnapshot = nextSnapshot.evidenceHtml ? nextSnapshot : null;
    return { changed: false, needsReview: true, reason: matched ? 'selection-content-empty' : 'selection-empty', message: monitor.lastError };
  }

  const previous = monitor.snapshot;
  const identityComparison = previous && typeof compareSnapshotIdentities === 'function' ? compareSnapshotIdentities(previous, nextSnapshot, tracking) : null;
  const changed = Boolean(previous) && !snapshotsEqual(previous, nextSnapshot, tracking);
  // The reference runner only persists a baseline on the first successful
  // capture or a real filtered-text change. An equal re-render must not churn
  // the saved HTML/text history merely because its capture timestamp changed.
  if (!previous || changed) {
    monitor.snapshot = nextSnapshot;
    appendSnapshotHistory(monitor, nextSnapshot, previous ? 'change' : 'baseline');
  } else if (Number(nextSnapshot.captureVersion) > Number(previous.captureVersion || 0)) {
    // Upgrade extraction metadata without manufacturing a content change.
    monitor.snapshot = nextSnapshot;
  } else if (identityComparison?.orderChanged) {
    monitor.snapshot = nextSnapshot;
    monitor.lastOrderChangedAt = checkedAt;
  }
  monitor.lastError = null;
  monitor.lastErrorSnapshot = null;
  monitor.lastReviewAt = null;

  if (changed) {
    monitor.lastChangedAt = checkedAt;
    monitor.lastChange = {
      id: createRevision(),
      previous,
      current: nextSnapshot,
      detectedAt: checkedAt
    };
    monitor.unread = true;
    monitor.status = 'changed';
  } else {
    if (!previous) {
      monitor.lastViewedAt = checkedAt;
      monitor.unread = false;
    }
    // An unread change remains actionable after a later successful re-check.
    monitor.status = monitor.unread ? 'changed' : statusForStoredSnapshot(monitor.snapshot, tracking);
  }

  return { changed, needsReview: false, orderChanged: Boolean(identityComparison?.orderChanged) };
}

function liveRawTextOf(snapshot) {
  // Normal live captures place this field on the snapshot as non-enumerable
  // metadata. `rawText` keeps the function useful with older/adapted capture
  // implementations and test doubles.
  return String(snapshot?.liveRawText ?? snapshot?.rawText ?? snapshot?.text ?? '');
}

async function checkMonitorWithCapture(id, capture, {
  reschedule = true,
  source = 'manual',
  liveFrameId = 0,
  liveTabId = null,
  job = null
} = {}) {
  if (checksInProgress.has(id)) {
    return { ok: false, reason: 'checking', error: '이미 확인 중입니다.' };
  }

  checksInProgress.add(id);
  let captureToRetry = null;
  try {
    const monitor = typeof getMonitorById === 'function' ? await getMonitorById(id) : (await getMonitors()).find((item) => item.id === id);
    if (!monitor) {
      return { ok: false, error: '모니터를 찾을 수 없습니다.' };
    }
    if (!monitor.enabled) {
      forgetPendingCapture(id);
      return { ok: false, reason: 'disabled', error: '일시정지된 모니터입니다.' };
    }
    const pendingCapture = pendingSnapshotCommits.get(id);
    if (pendingCapture && pendingCapture.revision !== monitor.revision) forgetPendingCapture(id);
    if (!await hasSitePermission(monitor.url)) {
      await setCheckFailure(id, monitor.revision, 'permission-needed', '이 사이트의 접근 권한이 필요합니다.', source);
      return { ok: false, reason: 'permission', error: '이 사이트의 접근 권한이 필요합니다.' };
    }

    let nextSnapshot;
    try {
      const captureTimeout = monitor.tracking?.timeoutMilliseconds ?? CHECK_EXECUTION_TIMEOUT_MS;
      const retryPending = pendingCapture?.revision === monitor.revision;
      if (retryPending) source = pendingCapture.source;
      const underlying = retryPending ? Promise.resolve(pendingCapture.snapshot) : Promise.resolve().then(() => capture(monitor, job));
      try {
        nextSnapshot = await timeout(underlying, captureTimeout, 'The page capture exceeded its allowed time.');
      } catch (error) {
        if (job) {
          job.draining = underlying.finally(() => { job.finished = true; checksInProgress.delete(id); });
          job.draining.catch(() => undefined);
          await job.cancel().catch(() => undefined);
          if (source === 'live') {
            const liveSession = liveSessions.get(id);
            if (liveSession?.tabId === liveTabId && liveSession.ownedTab) await detachLiveSession(id).catch(() => undefined);
          }
        }
        throw error;
      }
      captureToRetry = { revision: monitor.revision, snapshot: nextSnapshot, checkedAt: retryPending ? pendingCapture.checkedAt : nowIso(), source };
    } catch (error) {
      const message = responseError(error);
      await setCheckFailure(id, monitor.revision, 'error', message, source);
      return { ok: false, error: message };
    }

    let pendingLiveCache = null;
    if (source === 'live') {
      // Dedupe uses the same complete comparison semantics as persisted
      // snapshots, including links, attributes and data-only changes.
      const rawText = JSON.stringify([nextSnapshot?.exists, nextSnapshot?.textFingerprint || snapshotFingerprint(nextSnapshot?.text || ''), nextSnapshot?.dataFingerprint || snapshotFingerprint(nextSnapshot?.data || ''), snapshotFingerprint(JSON.stringify(nextSnapshot?.items?.map((item) => [item.identity, item.permalink]) || []))]);
      const session = liveSessions.get(id);
      const expectedSession = session
        && session.revision === monitor.revision
        && (!Number.isInteger(liveTabId) || session.tabId === liveTabId);
      const frameId = Number.isInteger(liveFrameId) ? liveFrameId : 0;
      if (expectedSession) {
        session.rawTextByFrame || (session.rawTextByFrame = new Map());
        if (session.rawTextByFrame.get(frameId) === rawText) {
          return { ok: true, liveNoop: true, unchanged: true };
        }
        pendingLiveCache = { session, frameId, rawText };
      }
    }

    const checkedAt = captureToRetry?.checkedAt || nowIso();
    const result = await mutateMonitors((monitors) => {
      const current = monitors.find((item) => item.id === id);
      if (!current || !current.enabled || current.revision !== monitor.revision) {
        return { ok: false, reason: 'outdated', error: '확인 중 모니터 설정이 변경되었습니다.' };
      }

      // A live mutation is an additional signal, not a new periodic cadence.
      // Keep interval/random/cron due times intact so busy pages cannot defer
      // their scheduled verification forever. A pure LIVE schedule still
      // records its most recent check because it has no alarm cadence to move.
      const advancesSchedule = source !== 'live' || scheduleDescriptorOf(current)?.type === SCHEDULE_MODE_LIVE;
      if (advancesSchedule) {
        current.lastCheckedAt = checkedAt;
        current.nextCheckAt = nextCheckForSchedule(current.schedule, checkedAt, current.intervalHours);
      }
      const previousStatus = current.status;
      const previousError = current.lastError;
      const previousReviewAt = current.lastReviewAt;
      const hadErrorSnapshot = Boolean(current.lastErrorSnapshot);
      const hadSnapshot = Boolean(current.snapshot);
      const applied = applySnapshotOutcome(current, nextSnapshot, checkedAt);
      // A nonempty baseline followed by an empty selection is an execution
      // error in the reference scheduler. Keep the baseline/evidence, but
      // perform its bounded quick retry instead of waiting a full interval.
      if (applied.needsReview && advancesSchedule) {
        const retryDelay = isAutomaticSchedule(current) && hasSuccessfulRun(current, { pendingFailure: true })
          ? retryDelayForSchedule(current)
          : null;
        if (retryDelay) current.nextCheckAt = new Date(Date.now() + retryDelay).toISOString();
      }
      // The reference live observer emits an initial nonempty result and then
      // only filtered-text changes. Preserve recovery/error evidence, but do
      // not add a run or churn updatedAt for an equal live mutation.
      const recordOutcome = source !== 'live'
        || !hadSnapshot
        || applied.changed
        || applied.orderChanged
        || applied.needsReview
        || previousStatus !== current.status
        || previousError !== current.lastError
        || previousReviewAt !== current.lastReviewAt
        || hadErrorSnapshot !== Boolean(current.lastErrorSnapshot);
      if (recordOutcome) {
        current.updatedAt = checkedAt;
        appendRunHistory(current, {
          at: checkedAt,
          status: applied.needsReview ? 'needs-review' : applied.changed ? 'changed' : 'ok',
          code: applied.needsReview ? applied.reason || 'selection-empty' : applied.orderChanged ? 'order-changed' : null,
          message: applied.needsReview ? current.lastError : null,
          changed: applied.changed,
          matchCount: nextSnapshot.matchCount
        });
      }

      return { ok: true, ...applied, liveNoop: source === 'live' && !recordOutcome, monitor: { ...current } };
    }, { operation: false });

    if (result?.ok) {
      forgetPendingCapture(id);
      const hadBackoff = storageFailureBackoff.delete(id);
      if (pendingLiveCache && liveSessions.get(id) === pendingLiveCache.session) pendingLiveCache.session.rawTextByFrame.set(pendingLiveCache.frameId, pendingLiveCache.rawText);
      if (hadBackoff) await mutateRuntimeState((state) => { delete state.backoff[id]; }).catch(() => undefined);
    } else if (result?.reason === 'outdated') {
      forgetPendingCapture(id);
    } else if (source === 'live' && liveSessions.get(id)?.revision === monitor.revision) {
      queueLiveDirtyFrame(id, liveTabId, monitor.revision, liveFrameId);
    }
    return afterMonitorCommit(result, [
      ...(result?.changed ? [['notification', () => announceChange(result.monitor)]] : []),
      ['badge', () => refreshBadge()]
    ]);
  } catch (error) {
    const prior = storageFailureBackoff.get(id);
    const attempts = Math.min(8, (prior?.attempts || 0) + 1);
    const backoff = { attempts, retryAt: Date.now() + Math.min(15 * 60_000, 5_000 * (2 ** (attempts - 1))) };
    storageFailureBackoff.set(id, backoff);
    pauseQueueForStorage(backoff.retryAt - Date.now());
    if (captureToRetry) rememberPendingCapture(id, captureToRetry);
    const liveSession = liveSessions.get(id);
    if (source === 'live' && liveSession && (!Number.isInteger(liveTabId) || liveSession.tabId === liveTabId)) queueLiveDirtyFrame(id, liveSession.tabId, liveSession.revision, liveFrameId);
    await mutateRuntimeState((state) => { state.backoff[id] = backoff; state.storageRetryAt = storageUnavailableUntil; }).catch(() => undefined);
    return { ok: false, error: responseError(error) };
  } finally {
    if (!job?.draining || job.finished) checksInProgress.delete(id);
    if (reschedule) {
      await scheduleNextAlarm().catch((error) => console.warn('OpenStill could not reschedule checks.', error));
    }
  }
}

async function checkMonitor(id, options = {}) {
  const monitor = typeof getMonitorMetadataById === 'function' ? await getMonitorMetadataById(id) : typeof getMonitorById === 'function' ? await getMonitorById(id) : (await getMonitors()).find((item) => item.id === id);
  if (!monitor) return { ok: false, reason: 'missing', error: '모니터를 찾을 수 없습니다.' };
  return enqueueCaptureTask(id, monitor.url, options.source || 'manual', (job) => checkMonitorWithCapture(id, (current) => captureRenderedSnapshot(current, null, { job }), { ...options, job }));
}

async function checkMonitorInOpenTab(id, tabId, options = {}) {
  const monitor = typeof getMonitorMetadataById === 'function' ? await getMonitorMetadataById(id) : typeof getMonitorById === 'function' ? await getMonitorById(id) : (await getMonitors()).find((item) => item.id === id);
  if (!monitor) return { ok: false, reason: 'missing', error: '모니터를 찾을 수 없습니다.' };
  return enqueueCaptureTask(id, monitor.url, options.source || 'live', (job) => checkMonitorWithCapture(
    id,
    (monitor) => captureRenderedSnapshot(monitor, tabId, {
      live: options.source === 'live',
      job
    }),
    { ...options, liveTabId: tabId, job }
  ));
}

function tabMatchesMonitor(tab, monitor) {
  return Number.isInteger(tab?.id) && normalizeUrl(tab.url) === monitor.url;
}

function normalizeLiveOwnedTabs(value) {
  const source = value && typeof value === 'object' ? value : {};
  const result = {};
  for (const [monitorId, entry] of Object.entries(source)) {
    const id = String(monitorId || '').trim();
    const rawTabId = entry?.tabId;
    const tabId = typeof rawTabId === 'number'
      ? rawTabId
      : typeof rawTabId === 'string' && /^\d+$/.test(rawTabId) ? Number(rawTabId) : Number.NaN;
    const revision = String(entry?.revision || '').trim();
    const url = normalizeUrl(entry?.url);
    if (id && Number.isInteger(tabId) && tabId >= 0 && revision && url) {
      result[id] = { ...entry, tabId, revision, url };
    }
  }
  return result;
}

async function mutateLiveOwnedTabs(mutator) {
  const operation = liveOwnershipQueue.catch(() => undefined).then(async () => {
    const stored = await chrome.storage.local.get(LIVE_CONTROLLED_TABS_KEY);
    const legacy = !stored?.[LIVE_CONTROLLED_TABS_KEY] && chrome.storage.session ? await chrome.storage.session.get(LIVE_CONTROLLED_TABS_KEY) : null;
    const owned = normalizeLiveOwnedTabs(stored?.[LIVE_CONTROLLED_TABS_KEY] || legacy?.[LIVE_CONTROLLED_TABS_KEY]);
    const value = await mutator(owned);
    await chrome.storage.local.set({ [LIVE_CONTROLLED_TABS_KEY]: owned });
    return value;
  });
  liveOwnershipQueue = operation.catch(() => undefined);
  return operation;
}

async function getLiveOwnedTabs() {
  await liveOwnershipQueue.catch(() => undefined);
  const stored = await chrome.storage.local.get(LIVE_CONTROLLED_TABS_KEY);
  return normalizeLiveOwnedTabs(stored?.[LIVE_CONTROLLED_TABS_KEY]);
}

async function rememberLiveControlledTab(monitor, tabId, stage = 'loading') {
  const sessionId = await runtimeSessionId();
  return mutateLiveOwnedTabs((owned) => {
    owned[monitor.id] = { tabId, revision: monitor.revision, url: monitor.url, stage, sessionId, createdAt: nowIso(), ownerToken: createRevision() };
  });
}

async function forgetLiveControlledTab(monitorId, expectedTabId = null) {
  return mutateLiveOwnedTabs((owned) => {
    const entry = owned[monitorId];
    if (entry && (!Number.isInteger(expectedTabId) || entry.tabId === expectedTabId)) {
      delete owned[monitorId];
    }
  });
}

async function forgetLiveControlledTabByTabId(tabId) {
  if (!Number.isInteger(tabId)) return;
  return mutateLiveOwnedTabs((owned) => {
    for (const [monitorId, entry] of Object.entries(owned)) {
      if (entry.tabId === tabId) delete owned[monitorId];
    }
  });
}

async function tabById(tabId) {
  if (!Number.isInteger(tabId)) return null;
  if (typeof chrome.tabs?.get === 'function') return chrome.tabs.get(tabId).catch(() => null);
  if (typeof chrome.tabs?.query === 'function') {
    return (await chrome.tabs.query({})).find((tab) => tab.id === tabId) || null;
  }
  return null;
}

async function adoptLiveControlledSession(monitor) {
  const current = liveSessions.get(monitor.id);
  if (current) return current;
  const owned = await getLiveOwnedTabs();
  const entry = owned[monitor.id];
  if (!entry) return null;

  const tab = await tabById(entry.tabId);
  if (!tab) { await forgetLiveControlledTab(monitor.id, entry.tabId); return null; }
  // Tab identifiers can be reused after a browser restart. A durable record
  // alone is never permission to close or inject into a candidate user tab.
  if (entry.sessionId !== await runtimeSessionId()) {
    await mutateLiveOwnedTabs((all) => { if (all[monitor.id]) all[monitor.id].stage = 'ownership-unverified'; });
    return null;
  }

  // The stored tab id is only a candidate. Require the exact monitor
  // revision and normalized URL before treating it as extension-owned again.
  if (entry.revision !== monitor.revision || entry.url !== monitor.url) {
    if (await removeLiveControlledTab(entry.tabId)) await forgetLiveControlledTab(monitor.id, entry.tabId);
    return null;
  }
  if (!tab || !tabMatchesMonitor(tab, monitor)) {
    if (!tab || await removeLiveControlledTab(entry.tabId)) await forgetLiveControlledTab(monitor.id, entry.tabId);
    return null;
  }
  const session = {
    tabId: entry.tabId,
    revision: entry.revision,
    frameIds: new Set(),
    rawTextByFrame: new Map(),
    ownedTab: true,
    // The old worker's isolated observer may still exist, but this worker has
    // no reliable registration state. Re-run live_init against the verified
    // controlled tab before accepting mutations.
    navigating: true
  };
  liveSessions.set(monitor.id, session);
  return session;
}

async function reconcileLiveControlledTabs(monitors) {
  const byId = new Map(monitors.map((monitor) => [monitor.id, monitor]));
  const owned = await getLiveOwnedTabs();
  let adopted = 0;
  for (const [monitorId, entry] of Object.entries(owned)) {
    if (entry.sessionId !== await runtimeSessionId()) {
      const candidate = await tabById(entry.tabId);
      if (!candidate) await forgetLiveControlledTab(monitorId, entry.tabId);
      else await mutateLiveOwnedTabs((all) => { if (all[monitorId]) all[monitorId].stage = 'ownership-unverified'; });
      continue;
    }
    const monitor = byId.get(monitorId);
    const validMonitor = monitor
      && monitor.enabled
      && isLiveTracking(monitor)
      && monitor.revision === entry.revision
      && monitor.url === entry.url;
    if (!validMonitor) {
      if (await removeLiveControlledTab(entry.tabId)) await forgetLiveControlledTab(monitorId, entry.tabId);
      continue;
    }
    if (!liveSessions.has(monitorId) && await adoptLiveControlledSession(monitor)) adopted += 1;
  }
  return { adopted };
}

async function removeLiveControlledTab(tabId) {
  if (!Number.isInteger(tabId)) return true;
  try { await chrome.tabs.remove(tabId); return true; }
  catch {
    await chrome.tabs.update(tabId, { pinned: false }).catch(() => undefined);
    try { await chrome.tabs.remove(tabId); return true; }
    catch {
      if (!await tabById(tabId)) return true;
      await mutateLiveOwnedTabs((owned) => {
        for (const entry of Object.values(owned)) if (entry.tabId === tabId) { entry.stage = 'pendingCleanup'; entry.cleanupAttemptAt = nowIso(); }
      }).catch(() => undefined);
      return false;
    }
  }
}

async function createLiveControlledTab(monitor) {
  if (typeof chrome.tabs?.create !== 'function') {
    throw new Error('This browser cannot create a controlled live-monitor tab.');
  }
  // LiveRunner always creates its own pinned, background loader. Reusing a
  // user tab would make the extension observe and mutate a page the runner
  // does not own, and differs from the reference lifecycle.
  const tab = await chrome.tabs.create({
    url: monitor.url,
    active: false,
    pinned: true,
    index: 0
  });
  if (!Number.isInteger(tab?.id)) {
    throw new Error('Could not create a controlled tab for live monitoring.');
  }
  try { await rememberLiveControlledTab(monitor, tab.id, 'loading'); }
  catch (error) { await removeLiveControlledTab(tab.id).catch(() => undefined); throw error; }
  const ready = waitForRenderedTab(tab.id);
  try {
    await ready.promise;
    return tab;
  } catch (error) {
    if (await removeLiveControlledTab(tab.id)) await forgetLiveControlledTab(monitor.id, tab.id);
    throw error;
  } finally {
    ready.cancel();
  }
}

async function liveFrameIdsForMonitor(monitor, tabId) {
  const needsFrames = monitor.locators.some((locator) => locator.frameId !== 0 || locator.framePath?.length || locator.frameUrl);
  if (!needsFrames) return [0];
  if (typeof chrome.webNavigation?.getAllFrames !== 'function') {
    throw new Error('Subframe live monitoring is unavailable in this browser.');
  }
  let frames = await chrome.webNavigation.getAllFrames({ tabId });
  if (typeof collectStableFrameDescriptors === 'function') frames = await collectStableFrameDescriptors(tabId, frames);
  const ids = [...new Set(monitor.locators.map((locator) => resolveLocatorFrame(locator, frames)))];
  if (ids.some((frameId) => !Number.isInteger(frameId) || frameId < 0)) {
    throw new Error('A saved live-monitor frame is no longer available on this page.');
  }
  return ids;
}

function liveTarget(tabId, frameIds) {
  // Supplying frameIds (rather than allFrames) keeps unrelated ads/widgets
  // from waking the monitor. Chrome accepts frame 0 in this explicit list.
  return { tabId, frameIds: [...new Set(frameIds)] };
}

async function detachLiveSession(monitorId) {
  const session = liveSessions.get(monitorId);
  if (!session) {
    liveDirtyByMonitor.delete(monitorId);
    const owned = (await getLiveOwnedTabs())[monitorId];
    if (!owned) return { ok: true, stopped: false };
    if (owned.sessionId !== await runtimeSessionId()) return { ok: false, stopped: false, pendingCleanup: true, error: '이전 브라우저 세션의 탭 소유권을 확인해야 합니다.' };
    if (!await removeLiveControlledTab(owned.tabId)) return { ok: false, stopped: false, pendingCleanup: true, tabId: owned.tabId };
    await forgetLiveControlledTab(monitorId, owned.tabId);
    return { ok: true, stopped: true, tabId: owned.tabId };
  }
  const frameIds = [...(session.frameIds || [])];
  const ownsTab = session.ownedTab === true;
  let result;
  try {
    if (frameIds.length) {
      await chrome.scripting.executeScript({
        target: liveTarget(session.tabId, frameIds),
        func: removeLiveMutationObserver,
        args: [monitorId]
      });
    }
    result = { ok: true, stopped: true, tabId: session.tabId };
    return result;
  } catch (error) {
    // A navigated/closed frame can reject an otherwise successful teardown.
    // Always discard the worker-side session so a new revision can recover.
    result = { ok: false, stopped: false, tabId: session.tabId, error: responseError(error) };
    return result;
  } finally {
    liveSessions.delete(monitorId);
    liveDirtyByMonitor.delete(monitorId);
    if (ownsTab) {
      if (await removeLiveControlledTab(session.tabId)) await forgetLiveControlledTab(monitorId, session.tabId);
      else if (result) { result.ok = false; result.stopped = false; result.pendingCleanup = true; }
    }
  }
}

function queueLiveDirtyFrame(monitorId, tabId, revision, frameId) {
  const normalizedFrameId = Number.isInteger(frameId) && frameId >= 0 ? frameId : 0;
  void mutateRuntimeState((state) => {
    state.dirty ||= {};
    const prior = state.dirty[monitorId];
    state.dirty[monitorId] = { tabId, revision, frameIds: [...new Set([...(prior?.revision === revision ? prior.frameIds : []), normalizedFrameId])], at: nowIso() };
  }).catch(() => undefined);
  const existing = liveDirtyByMonitor.get(monitorId);
  if (existing?.revision === revision && existing.tabId === tabId) {
    existing.frameIds.add(normalizedFrameId);
    return existing;
  }
  const dirty = { tabId, revision, frameIds: new Set([normalizedFrameId]) };
  liveDirtyByMonitor.set(monitorId, dirty);
  return dirty;
}

function takeLiveDirtyFrames(monitorId, tabId, revision) {
  const dirty = liveDirtyByMonitor.get(monitorId);
  if (!dirty || dirty.revision !== revision || dirty.tabId !== tabId) return [];
  liveDirtyByMonitor.delete(monitorId);
  void mutateRuntimeState((state) => { if (state.dirty) delete state.dirty[monitorId]; }).catch(() => undefined);
  return [...dirty.frameIds];
}

async function requestLiveCapture(monitor, tabId, frameId = 0) {
  if ((storageFailureBackoff.get(monitor.id)?.retryAt || 0) > Date.now()) {
    queueLiveDirtyFrame(monitor.id, tabId, monitor.revision, frameId);
    return { ok: true, pending: true, reason: 'storage-backoff' };
  }
  if (checksInProgress.has(monitor.id) || captureTasks.has(monitor.id)) {
    queueLiveDirtyFrame(monitor.id, tabId, monitor.revision, frameId);
    return { ok: true, pending: true };
  }

  let result;
  let rounds = 0;
  let frameIds = [Number.isInteger(frameId) ? frameId : 0];
  // Process the full first concurrent batch, rather than retaining only the
  // latest frame event. A busy page can continue to mutate forever, so leave
  // a later batch to the normal asynchronous requeue after two bounded rounds.
  while (frameIds.length && rounds < 2) {
      result = await checkMonitorInOpenTab(monitor.id, tabId, {
        reschedule: false,
        source: 'live',
        liveFrameId: 0
      });
      if (result?.ok === false) return result;
    rounds += 1;
    frameIds = takeLiveDirtyFrames(monitor.id, tabId, monitor.revision);
  }

  // `frameIds` already holds a batch taken at the end of the final bounded
  // round; include it before taking any newer events so it cannot be dropped.
  const remaining = [...new Set([
    ...frameIds,
    ...takeLiveDirtyFrames(monitor.id, tabId, monitor.revision)
  ])];
  if (remaining.length) {
    setTimeout(() => {
      for (const remainingFrameId of remaining) {
        void handleLiveMonitorMutation(
          { id: monitor.id, revision: monitor.revision },
          { tab: { id: tabId, url: monitor.url }, frameId: remainingFrameId }
        );
      }
    }, 0);
  }
  return result;
}


async function initializeLiveSession(monitor, session) {
  const frameIds = await liveFrameIdsForMonitor(monitor, session.tabId);
  session.frameIds = new Set(frameIds);
  session.rawTextByFrame = new Map();

  // Content live_init performs its first filter before attaching its mutation
  // observer. Doing the same prevents capture-owned source writes (notably the
  // capture base element) from scheduling a self-feedback check.
  const initialResults = [];
  initialResults.push(await requestLiveCapture(monitor, session.tabId, frameIds[0]));

  const installed = await chrome.scripting.executeScript({
    target: liveTarget(session.tabId, frameIds),
    func: installLiveMutationObserver,
    args: [monitor.id, monitor.revision, { propertyPolling: monitor.locators.some((locator) => locator.fields?.some((field) => field.type === 'property')) }]
  });
  const failedFrames = frameIds.filter((id) => !installed.some((entry) => entry.frameId === id && entry.result?.ok === true));
  if (failedFrames.length) throw new Error(`실시간 관찰기 설치 실패: frame ${failedFrames.join(', ')}`);
  session.installedAt = Date.now();
  await mutateLiveOwnedTabs((owned) => { if (owned[monitor.id]) owned[monitor.id].stage = 'observing'; });
  return {
    installedFrames: installed.filter((entry) => entry.result?.ok === true).length,
    initial: initialResults.length === 1 ? initialResults[0] : initialResults
  };
}

function startLiveMonitor(message) {
  return queueLiveLifecycle(message?.id, () => startLiveMonitorInternal(message));
}

async function startLiveMonitorInternal(message) {
  const monitor = (await getMonitors()).find((item) => item.id === message?.id);
  if (!monitor) return { ok: false, error: 'Live monitor was not found.' };
  if (!monitor.enabled) return { ok: false, error: 'Live monitor is disabled.' };
  if (!normalizeTracking(monitor.tracking).live) {
    return { ok: false, error: 'Live monitoring is not enabled for this monitor.' };
  }
  if (!await hasSitePermission(monitor.url)) {
    return { ok: false, reason: 'permission', error: 'Site access is required for live monitoring.' };
  }

  let existing = liveSessions.get(monitor.id);
  if (!existing) existing = await adoptLiveControlledSession(monitor);
  if (existing?.revision === monitor.revision && !existing.navigating) {
    return {
      ok: true,
      tabId: existing.tabId,
      reused: true,
      installedFrames: existing.frameIds?.size ?? 0
    };
  }

  let session;
  try {
    if (existing?.revision === monitor.revision && existing.navigating) {
      // A navigation destroys the isolated observer but the controlled tab is
      // still ours. Reuse only that known tab after the new document finishes.
      session = existing;
      session.navigating = false;
    } else {
      if (existing) await detachLiveSession(monitor.id);
      const owned = await getLiveOwnedTabs();
      if (owned[monitor.id]?.stage === 'ownership-unverified' || owned[monitor.id]?.stage === 'pendingCleanup') return { ok: false, reason: 'pending-cleanup', error: '이전 실시간 탭의 소유권 확인 또는 정리가 필요합니다.' };
      if (Object.keys(owned).length + reservedLiveTabs >= MAX_RESIDENT_LIVE_TABS) return { ok: false, reason: 'resident-limit', error: '상주 실시간 탭 한도에 도달했습니다. 대기 중인 추적은 주기적으로 확인합니다.' };
      reservedLiveTabs += 1;
      let tab;
      try { tab = await createLiveControlledTab(monitor); }
      finally { reservedLiveTabs -= 1; }
      session = {
        tabId: tab.id,
        revision: monitor.revision,
        frameIds: new Set(),
        rawTextByFrame: new Map(),
        ownedTab: true,
        navigating: false
      };
      liveSessions.set(monitor.id, session);
    }
    const initialized = await initializeLiveSession(monitor, session);
    return { ok: true, tabId: session.tabId, ...initialized };
  } catch (error) {
    if (session && liveSessions.get(monitor.id) === session) {
      await detachLiveSession(monitor.id).catch(() => undefined);
    }
    return { ok: false, error: responseError(error) };
  }
}

function stopLiveMonitor(message) {
  return queueLiveLifecycle(message?.id, () => stopLiveMonitorInternal(message));
}

async function stopLiveMonitorInternal(message) {
  const monitor = (await getMonitors()).find((item) => item.id === message?.id);
  if (!monitor) return { ok: false, error: 'Live monitor was not found.' };
  // There is intentionally no matching-tab fallback: reference LiveRunner
  // owns the page it observes, so stop must never inject into a user tab.
  if (!liveSessions.has(monitor.id)) await adoptLiveControlledSession(monitor);
  return detachLiveSession(monitor.id);
}

async function handleLiveMonitorMutation(message, sender) {
  const id = typeof message?.id === 'string' ? message.id : '';
  const tabId = sender?.tab?.id;
  if (!id || !Number.isInteger(tabId)) return { ok: false, ignored: true };
  const monitor = (await getMonitors()).find((item) => item.id === id);
  if (!monitor || !monitor.enabled || monitor.revision !== message?.revision || !normalizeTracking(monitor.tracking).live) {
    return { ok: false, ignored: true };
  }
  if (!tabMatchesMonitor(sender.tab, monitor)) return { ok: false, ignored: true };
  const session = liveSessions.get(id);
  if (!session || session.revision !== monitor.revision || session.tabId !== tabId) {
    return { ok: false, ignored: true };
  }
  const frameId = Number.isInteger(sender?.frameId) ? sender.frameId : 0;
  if (!session.frameIds.has(frameId)) return { ok: false, ignored: true };
  return requestLiveCapture(monitor, tabId, frameId);
}

function isLiveTracking(monitor) {
  return normalizeTracking(monitor?.tracking).live || scheduleDescriptorOf(monitor)?.type === SCHEDULE_MODE_LIVE;
}

async function restoreLiveForTab(tabId, knownTab = null) {
  let tab = knownTab;
  if (!tab && typeof chrome.tabs?.get === 'function') {
    tab = await chrome.tabs.get(tabId).catch(() => null);
  }
  if (!tab && typeof chrome.tabs?.query === 'function') {
    tab = (await chrome.tabs.query({})).find((candidate) => candidate.id === tabId) || null;
  }
  if (!tab) return { restored: 0 };
  const monitors = new Map((await getMonitors()).map((monitor) => [monitor.id, monitor]));
  // A tab update must only ever restore a session we already own. Do not turn
  // a user navigating to the same URL into a new live injection.
  const matching = [...liveSessions.entries()].flatMap(([id, session]) => {
    const monitor = monitors.get(id);
    return monitor
      && session.tabId === tabId
      && session.navigating
      && session.revision === monitor.revision
      && monitor.enabled
      && isLiveTracking(monitor)
      && tabMatchesMonitor(tab, monitor)
      ? [monitor]
      : [];
  });
  const outcomes = await Promise.allSettled(matching.map((monitor) => startLiveMonitor({ id: monitor.id })));
  return { restored: outcomes.filter((outcome) => outcome.status === 'fulfilled' && outcome.value?.ok).length };
}

async function restoreLiveMonitoring() {
  const monitors = (await getMonitors()).filter((monitor) => monitor.enabled && isLiveTracking(monitor));
  await reconcileLiveControlledTabs(monitors);
  // Probe the resident set independently of the large registration cursor.
  // Lost isolated worlds and page replacements must not look connected for
  // hours merely because thousands of other monitors are waiting.
  for (const [id, session] of liveSessions) {
    if (session.navigating) continue;
    try {
      const frameIds = [...session.frameIds];
      const inspected = await chrome.scripting.executeScript({ target: liveTarget(session.tabId, frameIds.length ? frameIds : [0]), func: inspectLiveMutationObserver, args: [id, session.revision] });
      if (!frameIds.length || frameIds.some((frameId) => !inspected.some((entry) => entry.frameId === frameId && entry.result?.ok === true))) session.navigating = true;
    } catch { session.navigating = true; }
  }
  const state = await getRuntimeAux('runtime', 'checkpoint') || {};
  const cursor = Number(state.liveCursor) % Math.max(1, monitors.length) || 0;
  const reconnect = monitors.filter((monitor) => liveSessions.get(monitor.id)?.navigating);
  const batch = [...new Map([...reconnect, ...monitors.slice(cursor, cursor + 4), ...monitors.slice(0, Math.max(0, cursor + 4 - monitors.length))].map((monitor) => [monitor.id, monitor])).values()].slice(0, 4);
  let restored = 0;
  let progressed = 0;
  for (const monitor of batch) {
    progressed += 1;
    // Save progress before a tab load can consume its complete timeout.
    await mutateRuntimeState((checkpoint) => { checkpoint.liveCursor = (cursor + progressed) % Math.max(1, monitors.length); });
    const session = liveSessions.get(monitor.id);
    if (session?.revision === monitor.revision && !session.navigating) continue;
    const outcome = await startLiveMonitor({ id: monitor.id }).catch(() => null);
    if (outcome?.ok) restored += 1;
  }
  if (!batch.length) await mutateRuntimeState((checkpoint) => { checkpoint.liveCursor = 0; });
  return { restored, resident: liveSessions.size, pending: Math.max(0, monitors.length - liveSessions.size), residentLimit: MAX_RESIDENT_LIVE_TABS };
}

// Every mutation path (save, import, URL replacement, deletion, enable) can
// change the eligibility or revision of a live monitor. Reconcile the
// in-memory observers centrally so an old isolated-world observer never
// survives merely because its monitor was edited through a different UI.
async function reconcileLiveSessions() {
  const monitors = await getMonitors();
  await reconcileLiveControlledTabs(monitors);
  const byId = new Map(monitors.map((monitor) => [monitor.id, monitor]));
  for (const [id, session] of [...liveSessions]) {
    const monitor = byId.get(id);
    if (!monitor || !monitor.enabled || !isLiveTracking(monitor) || monitor.revision !== session.revision) {
      await detachLiveSession(id);
    }
  }
  return restoreLiveMonitoring();
}

async function reinstallLiveFrame(tabId, frameId) {
  if (!Number.isInteger(tabId) || !Number.isInteger(frameId) || frameId < 0) return { reinstalled: 0 };
  let tab = null;
  if (typeof chrome.tabs?.get === 'function') tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab && typeof chrome.tabs?.query === 'function') {
    tab = (await chrome.tabs.query({})).find((candidate) => candidate.id === tabId) || null;
  }
  if (!tab) return { reinstalled: 0 };
  const monitors = new Map((await getMonitors()).map((monitor) => [monitor.id, monitor]));
  let reinstalled = 0;
  for (const [id, session] of [...liveSessions]) {
    if (session.tabId !== tabId) continue;
    const monitor = monitors.get(id);
    if (!monitor || !monitor.enabled || !isLiveTracking(monitor) || monitor.revision !== session.revision || !tabMatchesMonitor(tab, monitor)) {
      await detachLiveSession(id);
      continue;
    }
    let frameIds;
    try {
      frameIds = await liveFrameIdsForMonitor(monitor, tabId);
    } catch {
      continue;
    }
    session.frameIds = new Set(frameIds);
    if (!session.frameIds.has(frameId)) continue;
    try {
      // A new frame document has no content-side lastResult. Reset only this
      // frame's raw key and perform its live_init-equivalent capture before
      // listening for subsequent mutations.
      session.rawTextByFrame?.delete(frameId);
      await requestLiveCapture(monitor, tabId, frameId);
      const installed = await chrome.scripting.executeScript({
        target: liveTarget(tabId, [frameId]),
        func: installLiveMutationObserver,
        args: [monitor.id, monitor.revision, { propertyPolling: monitor.locators.some((locator) => locator.fields?.some((field) => field.type === 'property')) }]
      });
      if (!installed.some((entry) => entry.frameId === frameId && entry.result?.ok === true)) throw new Error('실시간 관찰기 설치에 실패했습니다.');
      reinstalled += 1;
    } catch {
      // The frame may still be tearing down; its next completed navigation
      // event will attempt installation again.
    }
  }
  return { reinstalled };
}

async function checkPage(urlValue) {
  const url = normalizeUrl(urlValue);
  if (!url) {
    return { ok: false, error: '확인할 페이지 주소가 올바르지 않습니다.' };
  }

  const matching = (await getMonitors()).filter((item) => item.url === url);
  const monitors = matching.filter((item) => item.enabled);
  if (!monitors.length) {
    return matching.length ? { ok: true, requested: matching.length, matched: matching.length, completed: 0, checked: 0, changed: 0, failed: 0, paused: matching.length, pausedIds: matching.map((monitor) => monitor.id), missing: 0, skipped: matching.length } : { ok: false, reason: 'missing', error: '이 페이지의 추적을 찾을 수 없습니다.' };
  }

  const result = await checkMonitors({ ids: monitors.map((monitor) => monitor.id) });
  if (!result?.ok) return result;
  return {
    ...result,
    // Preserve the page-action shape while reporting all independently
    // configured monitors that were actually checked.
    checked: result.completed,
    changedCount: result.changed,
    needsReviewCount: result.needsReview,
    changed: Boolean(result.changed),
    needsReview: Boolean(result.needsReview),
    matched: matching.length,
    skipped: matching.length - monitors.length,
    paused: matching.length - monitors.length + (result.paused || 0),
    pausedIds: matching.filter((monitor) => !monitor.enabled).map((monitor) => monitor.id).concat(result.pausedIds || [])
  };
}

function batchMonitorIds(value) {
  const ids = Array.isArray(value) ? value : [];
  const unique = [];
  const seen = new Set();
  for (const valueId of ids) {
    const id = typeof valueId === 'string' ? valueId.trim().slice(0, 100) : '';
    if (id && !seen.has(id)) {
      seen.add(id);
      unique.push(id);
      if (unique.length >= MAX_BATCH_CHECKS) break;
    }
  }
  return unique;
}

async function checkMonitors(message) {
  const requestedIds = batchMonitorIds(message?.ids);
  if (!requestedIds.length) {
    return { ok: false, error: '확인할 추적을 하나 이상 선택해 주세요.' };
  }

  const knownIds = new Set((await getMonitors()).map((monitor) => monitor.id));
  const ids = requestedIds.filter((id) => knownIds.has(id));
  if (!ids.length) {
    return { ok: false, error: '선택한 추적을 찾을 수 없습니다.' };
  }

  const outcomes = new Array(ids.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < ids.length) {
      const index = cursor;
      cursor += 1;
      const id = ids[index];
      try {
        outcomes[index] = await checkMonitor(id, { reschedule: false });
      } catch (error) {
        outcomes[index] = { ok: false, error: responseError(error) };
      }
    }
  };

  try {
    await Promise.all(Array.from(
      { length: Math.min(MAX_CONCURRENT_BATCH_CHECKS, ids.length) },
      () => worker()
    ));
  } finally {
    await scheduleNextAlarm().catch((error) => console.warn('OpenStill could not reschedule checks.', error));
  }

  const completed = outcomes.filter((outcome) => outcome?.ok).length;
  const changed = outcomes.filter((outcome) => outcome?.ok && outcome.changed).length;
  const needsReview = outcomes.filter((outcome) => outcome?.ok && outcome.needsReview).length;
  const paused = outcomes.filter((outcome) => outcome?.reason === 'disabled').length;
  const failed = outcomes.filter((outcome) => !outcome?.ok && outcome?.reason !== 'disabled').length;
  return {
    ok: true,
    requested: requestedIds.length,
    found: ids.length,
    completed,
    changed,
    needsReview,
    failed,
    paused,
    missing: requestedIds.length - ids.length,
    completedIds: ids.filter((id, index) => outcomes[index]?.ok),
    failedIds: ids.filter((id, index) => !outcomes[index]?.ok && outcomes[index]?.reason !== 'disabled'),
    pausedIds: ids.filter((id, index) => outcomes[index]?.reason === 'disabled'),
    missingIds: requestedIds.filter((id) => !knownIds.has(id)),
    disabled: outcomes.filter((outcome) => outcome?.reason === 'disabled').length,
    outcomes: ids.map((id, index) => ({ id, ok: Boolean(outcomes[index]?.ok), reason: outcomes[index]?.reason, error: outcomes[index]?.error }))
  };
}

async function runDueChecks() {
  if (sweepRunning) {
    return;
  }

  sweepRunning = true;
  try {
    const now = Date.now();
    const due = (typeof getMonitorSummaries === 'function' ? await getMonitorSummaries() : await getMonitors())
      .filter((monitor) => monitor.enabled && (storageFailureBackoff.get(monitor.id)?.retryAt || 0) <= now && !captureTasks.has(monitor.id) && (
        isAutomaticSchedule(monitor) && dueTimestamp(monitor) <= now
        || isLiveTracking(monitor) && !liveSessions.has(monitor.id) && now - Date.parse(monitor.lastCheckedAt || '1970-01-01') >= 60_000
      ))
      .sort((left, right) => dueTimestamp(left) - dueTimestamp(right));

    // Configurations that watch one page remain independent.  In particular,
    // do not collapse due work by URL: they may have different locators,
    // fields, schedules, or comparison filters.
    // The shared queue fills each newly available permit immediately, across
    // scheduled, manual, batch and live requests.
    await Promise.allSettled(due.map((monitor) => checkMonitor(monitor.id, { reschedule: false, source: 'scheduled' })));
  } finally {
    sweepRunning = false;
    await scheduleNextAlarm().catch(() => undefined);
  }
}

function selectorsEqual(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((selector, index) => selector === right[index]);
}

function locatorsEqual(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((locator, index) => locatorKey(locator) === locatorKey(right[index]));
}

function schedulesEqual(left, right) {
  const normalizedLeft = left && typeof left === 'object' ? left : null;
  const normalizedRight = right && typeof right === 'object' ? right : null;
  return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
}

function trackingEqual(left, right) {
  return JSON.stringify(normalizeTracking(left)) === JSON.stringify(normalizeTracking(right));
}

function pickerItemsFromMessage(message, defaultFrameId = 0) {
  const rawItems = Array.isArray(message.items)
    ? message.items
    : Array.isArray(message.locators)
      ? message.locators
      : Array.isArray(message.selectors)
        ? message.selectors.map((selector) => ({ selector }))
        : Object.hasOwn(message, 'selector')
          ? [{ selector: message.selector }]
          : [];

  if (!rawItems.length) {
    return [cleanLocator({
      type: 'css',
      expr: 'body',
      op: 'include'
    }, {
      frameId: defaultFrameId,
      ...(defaultFrameId > 0 ? { frameOrder: defaultFrameId } : {})
    })];
  }
  if (rawItems.length > MAX_SELECTORS_PER_MONITOR) return null;

  const items = [];
  const seenLocators = new Set();
  for (const rawItem of rawItems) {
    const locator = cleanLocator(rawItem, {
      frameId: defaultFrameId,
      ...(defaultFrameId > 0 ? { frameOrder: defaultFrameId } : {})
    });
    if (!locator) return null;
    const key = locatorKey(locator);
    if (seenLocators.has(key)) continue;
    seenLocators.add(key);
    items.push(locator);
  }
  return items.some((item) => item.op === 'include') ? items : null;
}

async function validateLocatorList(locators) {
  await ensureOffscreenDocument();
  const result = await timeout(
    chrome.runtime.sendMessage({
      type: 'validate-locator-list',
      locators: locators.map((locator) => ({ expr: locator.expr, type: locator.type }))
    }),
    PARSE_TIMEOUT_MS,
    '선택자 목록을 분석하는 데 시간이 너무 오래 걸렸습니다.'
  );
  if (!result?.ok) throw new Error(result?.error || '선택자 분석 결과를 받지 못했습니다.');
}

async function createMonitors(message, sender) {
  const url = normalizeUrl(sender?.tab?.url ?? message.url);
  const schedule = normalizeScheduleDescriptor(message, SCHEDULE_MODE_MANUAL);
  const scheduleMode = schedule?.type;
  const intervalHours = scheduleMode === SCHEDULE_MODE_INTERVAL
    ? schedule.params.interval / 3_600
    : MIN_INTERVAL_HOURS;
  const trackingInput = message.tracking ?? legacyTrackingSettings(message);
  const pickerItems = pickerItemsFromMessage(
    message,
    Number.isInteger(sender?.frameId) ? sender.frameId : 0
  );
  if (!url || !schedule || !pickerItems) {
    return { ok: false, error: 'URL, 확인 방식과 간격, 그리고 하나 이상의 CSS 선택자를 확인해 주세요.' };
  }
  if (hasInvalidConfiguredRegularExpression(trackingInput)) {
    return { ok: false, error: '변경 내용을 거를 정규식 또는 플래그가 올바르지 않습니다.' };
  }

  try {
    await validateLocatorList(pickerItems);
  } catch (error) {
    return { ok: false, error: responseError(error) };
  }
  if (pickerItems.some((locator) => locator.frameId !== 0) && Number.isInteger(sender?.tab?.id)) {
    if (typeof chrome.webNavigation?.getAllFrames !== 'function') {
      return { ok: false, error: 'This browser cannot save subframe selections.' };
    }
    let frames;
    try {
      frames = await chrome.webNavigation.getAllFrames({ tabId: sender.tab.id });
      frames = await collectStableFrameDescriptors(sender.tab.id, frames);
    } catch (error) {
      return { ok: false, error: `Could not identify the selected frame: ${responseError(error)}` };
    }
    for (const locator of pickerItems) {
      const framePath = framePathForFrame(locator.frameId, frames);
      if (framePath === null) {
        return { ok: false, error: `The selected frame (${locator.frameId}) cannot be stably identified.` };
      }
      locator.framePath = framePath;
    }
  }
  if (!await hasSitePermission(url)) {
    return { ok: false, error: '저장하기 전에 이 사이트의 접근 권한을 허용해 주세요.' };
  }

  const timestamp = nowIso();
  const pageTitle = cleanText(message.pageTitle, 180);
  const baseName = cleanText(message.name, 120) || pageTitle || new URL(url).hostname;
  const labels = cleanLabels(message.labels);
  const result = await mutateMonitors((monitors) => {
    if (monitors.length >= MAX_MONITORS) {
      throw new Error('추적은 최대 개수에 도달했습니다.');
    }

    // A URL identifies a page, not a monitor. Each save is an independent
    // configuration with its own locators, schedule, filtering, and history.
    const monitor = {
      id: createId(),
      revision: createRevision(),
      name: baseName,
      url,
      pageTitle,
      locators: pickerItems,
      selectors: displaySelectorsForLocators(pickerItems),
      tracking: normalizeTracking(scheduleMode === SCHEDULE_MODE_LIVE
        ? { ...(trackingInput && typeof trackingInput === 'object' ? trackingInput : {}), live: true }
        : trackingInput),
      labels,
      schedule,
      scheduleMode,
      intervalHours,
      ...(scheduleMode === SCHEDULE_MODE_INTERVAL ? { intervalSeconds: schedule.params.interval } : {}),
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastCheckedAt: null,
      lastChangedAt: null,
      // A manual tracker has no due time. Its first baseline is established
      // only by an explicit user check.
      nextCheckAt: nextCheckForSchedule(schedule, null, intervalHours, timestamp),
      snapshot: null,
      lastChange: null,
      history: [],
      runs: [],
      lastReviewAt: null,
      lastViewedAt: null,
      lastError: null,
      lastErrorSnapshot: null,
      status: 'needs-baseline',
      unread: false
    };
    monitors.push(monitor);
    return { ok: true, monitor: { ...monitor }, count: 1, ids: [monitor.id] };
  });

  if (!result?.ok) return result;
  return afterMonitorCommit({ ...result, count: 1, ids: [result.monitor.id] }, [
    ['picker', () => forgetPendingPicker(sender?.tab?.id)],
    ['schedule', () => scheduleNextAlarm()],
    ...(isLiveTracking(result.monitor) ? [['live', async () => { const started = await startLiveMonitor({ id: result.monitor.id }); if (!started.ok) throw new Error(started.error); }]] : [])
  ]);
}

async function createMonitor(message, sender) {
  return createMonitors({
    ...message,
    items: [{
      selector: message.selector
    }]
  }, sender);
}

async function saveMonitor(message) {
  const existing = typeof getMonitorById === 'function' ? await getMonitorById(message.id) : (await getMonitors()).find((item) => item.id === message.id);
  if (!existing) return { ok: false, error: '추적을 찾을 수 없습니다.' };
  const initialConflict = mutationConflict(existing, message);
  if (initialConflict) return initialConflict;
  const url = normalizeUrl(message.url ?? existing.url);
  const locators = cleanLocators(
    Object.hasOwn(message, 'locators')
      ? message.locators
      : Object.hasOwn(message, 'selectors')
        ? message.selectors
        : Object.hasOwn(message, 'selector') ? message.selector : existing.locators
  );
  if (!message.id || !url || !locators) {
    return { ok: false, error: 'URL과 CSS 선택자를 확인해 주세요.' };
  }
  const trackingInput = message.tracking ?? null;
  if (trackingInput && hasInvalidConfiguredRegularExpression(trackingInput)) {
    return { ok: false, error: '변경 내용을 거를 정규식 또는 플래그가 올바르지 않습니다.' };
  }

  const schedule = normalizeScheduleDescriptor(message, existing.scheduleMode, existing.schedule);
  const scheduleMode = schedule?.type;
  const intervalHours = scheduleMode === SCHEDULE_MODE_INTERVAL
    ? schedule.params.interval / 3_600
    : existing.intervalHours ?? MIN_INTERVAL_HOURS;
  if (!schedule) {
    return { ok: false, error: '확인 방식과 간격을 확인해 주세요.' };
  }

  try {
    await validateLocatorList(locators);
  } catch (error) {
    return { ok: false, error: responseError(error) };
  }

  const previousUrl = existing.url;
  const previousTracking = normalizeTracking(existing.tracking);
  const permissionGranted = await hasSitePermission(url);
  const result = await mutateMonitors((monitors) => {
    const monitor = monitors.find((item) => item.id === message.id);
    if (!monitor) {
      return { ok: false, error: '추적을 찾을 수 없습니다.' };
    }
    const conflict = mutationConflict(monitor, message);
    if (conflict) return conflict;
    const nextTracking = normalizeTracking(scheduleMode === SCHEDULE_MODE_LIVE
      ? { ...((trackingInput ?? monitor.tracking) && typeof (trackingInput ?? monitor.tracking) === 'object' ? (trackingInput ?? monitor.tracking) : {}), live: true }
      : trackingInput ?? monitor.tracking);
    monitor.name = cleanText(message.name, 120) || monitor.name;
    monitor.revision = createRevision();
    monitor.url = url;
    monitor.locators = [...locators];
    monitor.selectors = displaySelectorsForLocators(locators);
    monitor.tracking = nextTracking;
    if (Object.hasOwn(message, 'labels')) monitor.labels = cleanLabels(message.labels);
    monitor.schedule = schedule;
    monitor.scheduleMode = scheduleMode;
    monitor.intervalHours = intervalHours;
    if (scheduleMode === SCHEDULE_MODE_INTERVAL) monitor.intervalSeconds = schedule.params.interval;
    else delete monitor.intervalSeconds;
    const requestedEnabled = Object.hasOwn(message, 'enabled') ? message.enabled !== false : monitor.enabled;
    monitor.enabled = requestedEnabled && permissionGranted;
    monitor.updatedAt = nowIso();
    monitor.nextCheckAt = isAutomaticSchedule(monitor)
      ? nextCheckForSchedule(monitor.schedule, monitor.lastCheckedAt, intervalHours)
      : null;

    // A selector/filter edit changes the next extraction, not the identity of
    // the monitored history. Keep the previous successful capture as the
    // comparison baseline, then make an automatic monitor due immediately.
    // Resetting here would silently turn a real post-edit difference into a
    // new baseline rather than reporting it.
    if (requestedEnabled && !permissionGranted) {
      monitor.status = 'permission-needed';
      monitor.lastError = '이 사이트의 접근 권한이 필요합니다.';
    } else if (!requestedEnabled && monitor.status === 'permission-needed') {
      monitor.status = statusForStoredSnapshot(monitor.snapshot, monitor.tracking);
      monitor.lastError = null;
    }

    return { ok: true, monitor: { ...monitor }, permissionGranted };
  });

  return afterMonitorCommit(result, [
    ['live', async () => {
    const updatedTracking = normalizeTracking(result.monitor?.tracking);
    const previousLive = isLiveTracking(existing);
    const updatedLive = isLiveTracking(result.monitor);
    const liveConfigurationChanged = existing.url !== url
      || !locatorsEqual(existing.locators, result.monitor?.locators)
      || !trackingEqual(previousTracking, updatedTracking)
      || !schedulesEqual(existing.schedule, result.monitor?.schedule);
    if (previousLive && (!updatedLive || !result.monitor.enabled || liveConfigurationChanged)) {
      await detachLiveSession(existing.id);
    }
    if (updatedLive && result.monitor.enabled && (!previousLive || liveConfigurationChanged)) {
      // A saved selector or tracking edit creates a new revision. Reinstall on
      // any matching open page so an older isolated-world observer cannot keep
      // sending ignored revision messages forever.
      const started = await startLiveMonitor({ id: existing.id });
      if (!started.ok) throw new Error(started.error);
    }
    await reconcileLiveSessions();
    }],
    ['badge', () => refreshBadge()],
    ['schedule', () => scheduleNextAlarm()],
    ...(previousUrl !== url ? [['permission', () => releaseUnusedSitePermission(previousUrl)]] : [])
  ]);
}

async function setMonitorEnabled(message) {
  const enabled = Boolean(message.enabled);
  const monitor = (await getMonitors()).find((item) => item.id === message.id);
  if (!monitor) {
    return { ok: false, error: '모니터를 찾을 수 없습니다.' };
  }

  const permissionGranted = !enabled || await hasSitePermission(monitor.url);
  if (enabled && !permissionGranted) {
    return { ok: false, reason: 'permission', error: '이 사이트의 접근 권한이 필요합니다.' };
  }
  const result = await mutateMonitors((monitors) => {
    const current = monitors.find((item) => item.id === message.id);
    if (!current) {
      return { ok: false, error: '모니터를 찾을 수 없습니다.' };
    }
    const conflict = mutationConflict(current, message);
    if (conflict) return conflict;
    current.enabled = enabled;
    current.revision = createRevision();
    current.updatedAt = nowIso();
    current.nextCheckAt = isAutomaticSchedule(current) && enabled
      ? nextCheckForSchedule(current.schedule, current.lastCheckedAt, current.intervalHours)
      : null;
    if (enabled && current.status === 'permission-needed') {
      current.status = statusForStoredSnapshot(current.snapshot, current.tracking);
      current.lastError = null;
    } else if (!enabled && current.status === 'permission-needed') {
      current.status = statusForStoredSnapshot(current.snapshot, current.tracking);
      current.lastError = null;
    }
    return { ok: true, id: current.id, revision: current.revision };
  });
  return afterMonitorCommit(result, [['live', () => reconcileLiveSessions()], ['schedule', () => scheduleNextAlarm()]]);
}

async function deleteMonitor(id, message = {}) {
  let deleted;
  const result = await mutateMonitors((monitors) => {
    const index = monitors.findIndex((item) => item.id === id);
    if (index >= 0) {
      const conflict = mutationConflict(monitors[index], message);
      if (conflict) return conflict;
      deleted = monitors.splice(index, 1)[0];
    }
    return deleted ? { ok: true, id, deletedIds: [id] } : { ok: false, error: '모니터를 찾을 수 없습니다.' };
  });
  return afterMonitorCommit(result, [['live', () => detachLiveSession(id)], ['permission', () => releaseUnusedSitePermission(deleted.url)], ['badge', () => refreshBadge()], ['schedule', () => scheduleNextAlarm()]]);
}

async function updateMonitorLabels(message) {
  const mode = message?.mode;
  if (mode !== 'add' && mode !== 'remove') {
    return { ok: false, error: '라벨 작업 방식을 확인할 수 없습니다.' };
  }

  const label = cleanLabels([message?.label])[0];
  if (!label) {
    return { ok: false, error: '라벨을 입력해 주세요.' };
  }

  const requestedIds = batchMonitorIds(message?.ids);
  if (!requestedIds.length) {
    return { ok: false, error: '라벨을 변경할 추적을 하나 이상 선택해 주세요.' };
  }

  const selectedIds = new Set(requestedIds);
  const labelKey = label.toLocaleLowerCase('ko-KR');
  const timestamp = nowIso();
  let found = 0;
  let updated = 0;
  let skipped = 0;
  const processedIds = [];
  const conflictIds = [];
  const result = await mutateMonitors((monitors) => {
    for (const monitor of monitors) {
      if (!selectedIds.has(monitor.id)) continue;
      found += 1;
      if (mutationConflict(monitor, message)) { conflictIds.push(monitor.id); continue; }
      processedIds.push(monitor.id);
      const labels = cleanLabels(monitor.labels);
      const hasLabel = labels.some((item) => item.toLocaleLowerCase('ko-KR') === labelKey);
      if ((mode === 'add' && hasLabel) || (mode === 'remove' && !hasLabel)) {
        skipped += 1;
        continue;
      }

      const nextLabels = mode === 'add'
        ? cleanLabels([...labels, label])
        : labels.filter((item) => item.toLocaleLowerCase('ko-KR') !== labelKey);
      if (mode === 'add' && nextLabels.length === labels.length) {
        // A monitor can keep at most 20 labels. Treat a full label list like
        // an already-present label: leave the existing metadata untouched.
        skipped += 1;
        continue;
      }

      monitor.labels = nextLabels;
      monitor.revision = createRevision();
      monitor.updatedAt = timestamp;
      updated += 1;
    }
    const foundIds = new Set([...processedIds, ...conflictIds]);
    return { ok: true, label, requested: requestedIds.length, found, updated, skipped, missing: requestedIds.length - found, processedIds, conflictIds, failedIds: conflictIds, missingIds: requestedIds.filter((id) => !foundIds.has(id)), unprocessedIds: conflictIds };
  });
  return afterMonitorCommit(result, [['live', () => reconcileLiveSessions()]]);
}

async function deleteMonitors(message) {
  const requestedIds = batchMonitorIds(message?.ids);
  if (!requestedIds.length) {
    return { ok: false, error: '삭제할 추적을 하나 이상 선택해 주세요.' };
  }

  const selectedIds = new Set(requestedIds);
  const deleted = [];
  const conflictIds = [];
  const result = await mutateMonitors((monitors) => {
    const kept = [];
    for (const monitor of monitors) {
      if (selectedIds.has(monitor.id) && !mutationConflict(monitor, message)) deleted.push(monitor);
      else if (selectedIds.has(monitor.id)) { conflictIds.push(monitor.id); kept.push(monitor); }
      else kept.push(monitor);
    }
    monitors.splice(0, monitors.length, ...kept);
    const deletedIds = deleted.map((monitor) => monitor.id);
    const foundIds = new Set([...deletedIds, ...conflictIds]);
    return { ok: true, requested: requestedIds.length, deletedCount: deleted.length, missing: requestedIds.length - foundIds.size, deletedIds, processedIds: deletedIds, conflictIds, failedIds: conflictIds, unprocessedIds: conflictIds, missingIds: requestedIds.filter((id) => !foundIds.has(id)) };
  });
  return afterMonitorCommit(result, [['live', () => reconcileLiveSessions()], ['permission', () => Promise.all([...new Set(deleted.map((monitor) => monitor.url))].map((url) => releaseUnusedSitePermission(url)))], ['badge', () => refreshBadge()], ['schedule', () => scheduleNextAlarm()]]);
}

function resetMonitorForPageUrl(monitor, url, timestamp, { copy = false } = {}) {
  return {
    ...monitor,
    id: copy ? createId() : monitor.id,
    revision: createRevision(),
    url,
    locators: monitor.locators.map((locator) => ({
      ...locator,
      framePath: locator.framePath.map((part) => ({ ...part })),
      fields: locator.fields.map((field) => ({ ...field }))
    })),
    selectors: [...monitor.selectors],
    ...(copy ? { createdAt: timestamp } : {}),
    updatedAt: timestamp,
    addressHistory: [{ previousUrl: monitor.url, url, movedAt: timestamp }, ...(monitor.addressHistory || [])],
    nextCheckAt: nextCheckForSchedule(monitor.schedule, monitor.lastCheckedAt, monitor.intervalHours, timestamp)
  };
}

function readMonitorsForExport() {
  // Make snapshot acquisition part of the same queue as writes. The exported
  // array is therefore wholly before or wholly after an overlapping mutation,
  // never a stale normalization write racing a newer commit.
  const operation = storageQueue.catch(() => undefined).then(() => getMonitors());
  storageQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function persistNormalizedMonitorRepairs() {
  return mutateMonitors(async () => {
    const repository = await loadMonitorRepository();
    return !repository.migrated || repository.recovery.length > 0;
  }, { operation: false });
}

function moveMonitorToSiteHost(monitor, url, timestamp) {
  // A host migration changes only where the existing monitor is fetched. Its
  // baseline, change snapshots, run log, read state, and timestamps remain the
  // user's historical record and must continue into the next comparison.
  return {
    ...monitor,
    revision: createRevision(),
    url,
    locators: monitor.locators.map((locator) => ({
      ...locator,
      framePath: locator.framePath.map((part) => ({ ...part })),
      fields: locator.fields.map((field) => ({ ...field }))
    })),
    selectors: [...monitor.selectors],
    updatedAt: timestamp
  };
}

async function reusePageUrl(message, { copy = false } = {}) {
  const sourceUrl = normalizeUrl(message.sourceUrl);
  const targetUrl = normalizeUrl(message.targetUrl);
  if (!sourceUrl || !targetUrl) {
    return { ok: false, error: '기존 주소와 새 주소를 모두 확인해 주세요.' };
  }
  if (sourceUrl === targetUrl) {
    return { ok: false, error: '새 주소가 기존 주소와 같습니다.' };
  }

  const monitors = await getMonitors();
  const sourceMonitors = monitors.filter((monitor) => monitor.url === sourceUrl);
  if (!sourceMonitors.length) {
    return { ok: false, error: '주소를 재사용할 추적 페이지를 찾을 수 없습니다.' };
  }
  if (copy && monitors.length + sourceMonitors.length > MAX_MONITORS) {
    return { ok: false, error: '추적은 최대 개수에 도달했습니다.' };
  }
  if (sourceMonitors.some((monitor) => monitor.enabled) && !await hasSitePermission(targetUrl)) {
    return { ok: false, reason: 'permission', error: '새 사이트의 접근 권한이 필요합니다.' };
  }

  const timestamp = nowIso();
  const result = await mutateMonitors((currentMonitors) => {
    // Resolve all matching records inside the serialized mutation.  A page
    // action applies to the page group, while each affected monitor preserves
    // its own configuration and reset baseline.
    const currentSources = currentMonitors.filter((monitor) => monitor.url === sourceUrl);
    if (Array.isArray(message.expectedRevisions) && currentSources.some((monitor) => !message.expectedRevisions.some((expected) => expected.id === monitor.id && expected.revision === monitor.revision))) {
      return { ok: false, reason: 'outdated', error: '페이지 추적이 변경되었습니다. 대상 범위를 다시 확인해 주세요.' };
    }
    if (!currentSources.length) {
      return { ok: false, error: '주소를 재사용할 추적 페이지를 찾을 수 없습니다.' };
    }
    if (copy) {
      if (currentMonitors.length + currentSources.length > MAX_MONITORS) {
        return { ok: false, error: '추적은 최대 개수에 도달했습니다.' };
      }
      const affected = currentSources.map((monitor) => resetMonitorForPageUrl(monitor, targetUrl, timestamp, { copy: true }));
      currentMonitors.push(...affected);
      return { ok: true, monitor: { ...affected[0] }, monitors: affected.map((monitor) => ({ ...monitor })), count: affected.length };
    } else {
      const affectedById = new Map(currentSources.map((monitor) => [
        monitor.id,
        resetMonitorForPageUrl(monitor, targetUrl, timestamp)
      ]));
      for (let index = 0; index < currentMonitors.length; index += 1) {
        const affected = affectedById.get(currentMonitors[index].id);
        if (affected) currentMonitors[index] = affected;
      }
      const affected = [...affectedById.values()];
      return { ok: true, monitor: { ...affected[0] }, monitors: affected.map((monitor) => ({ ...monitor })), count: affected.length };
    }
  });

  if (!result?.ok) return result;
  if (!copy) {
    await releaseUnusedSitePermission(sourceUrl);
  }
  await reconcileLiveSessions().catch(() => undefined);
  await refreshBadge();
  await scheduleNextAlarm();
  return result;
}

function planSiteHostReplacement(monitors, sourceHost, targetHost) {
  const replacements = [];

  for (const monitor of monitors) {
    if (siteHostOfUrl(monitor.url) !== sourceHost) {
      continue;
    }

    const targetUrl = replaceUrlHost(monitor.url, sourceHost, targetHost);
    if (!targetUrl) {
      return { ok: false, error: '일괄 변경할 주소를 준비하지 못했습니다.' };
    }
    replacements.push({ id: monitor.id, sourceUrl: monitor.url, targetUrl, enabled: monitor.enabled });
  }

  if (!replacements.length) {
    return { ok: false, error: '기존 사이트 주소에 해당하는 추적을 찾지 못했습니다.' };
  }

  return { ok: true, replacements };
}

async function replaceSiteHost(message) {
  const sourceHost = normalizeSiteHost(message?.sourceHost);
  const targetHost = normalizeSiteHost(message?.targetHost);
  if (!sourceHost || !targetHost) {
    return { ok: false, error: '기존 및 새 사이트 주소에는 도메인(필요하면 포트)만 입력해 주세요.' };
  }
  if (sourceHost === targetHost) {
    return { ok: false, error: '새 사이트 주소가 기존 주소와 같습니다.' };
  }

  const before = await getMonitors();
  const planned = planSiteHostReplacement(before, sourceHost, targetHost);
  if (!planned.ok) {
    return planned;
  }

  const enabledTargetUrls = [...new Set(planned.replacements
    .filter((replacement) => replacement.enabled)
    .map((replacement) => replacement.targetUrl))];
  for (const targetUrl of enabledTargetUrls) {
    if (!await hasSitePermission(targetUrl)) {
      return { ok: false, reason: 'permission', error: '새 사이트의 접근 권한이 필요합니다.' };
    }
  }

  const timestamp = nowIso();
  const result = await mutateMonitors((monitors) => {
    // Recreate the plan inside the serialized mutation. A concurrent edit must
    // not turn a safe preview into a partial host migration.
    if (Array.isArray(message.expectedRevisions)) {
      const currentSources = monitors.filter((monitor) => siteHostOfUrl(monitor.url) === sourceHost);
      const currentIds = new Set(currentSources.map((monitor) => monitor.id));
      const conflictIds = new Set(currentSources.filter((monitor) => mutationConflict(monitor, message)).map((monitor) => monitor.id));
      for (const expected of message.expectedRevisions) {
        if (!currentIds.has(expected.id)) conflictIds.add(expected.id);
      }
      if (conflictIds.size) {
        return { ok: false, reason: 'conflict', conflictIds: [...conflictIds], error: '일괄 변경할 추적이 변경되었습니다. 최신 목록에서 대상 범위를 다시 확인해 주세요.' };
      }
    }
    const currentPlan = planSiteHostReplacement(monitors, sourceHost, targetHost);
    if (!currentPlan.ok) {
      return currentPlan;
    }

    const replacementsById = new Map(currentPlan.replacements.map((replacement) => [replacement.id, replacement]));
    for (let index = 0; index < monitors.length; index += 1) {
      const replacement = replacementsById.get(monitors[index].id);
      if (replacement) {
        monitors[index] = moveMonitorToSiteHost(monitors[index], replacement.targetUrl, timestamp);
      }
    }
    return {
      ok: true,
      count: currentPlan.replacements.length,
      sourceUrls: currentPlan.replacements.map((replacement) => replacement.sourceUrl)
    };
  });

  if (!result?.ok) {
    return result;
  }

  await Promise.all([...new Set(result.sourceUrls)].map((sourceUrl) => releaseUnusedSitePermission(sourceUrl)));
  await reconcileLiveSessions().catch(() => undefined);
  await refreshBadge();
  await scheduleNextAlarm();
  return { ok: true, count: result.count };
}

async function deletePage(urlValue, message = {}) {
  const url = normalizeUrl(urlValue);
  if (!url) return { ok: false, error: '삭제할 페이지 주소가 올바르지 않습니다.' };

  let deleted = [];
  const conflictIds = [];
  const result = await mutateMonitors((monitors) => {
    const kept = [];
    for (const monitor of monitors) {
      if (monitor.url === url && !mutationConflict(monitor, message)) deleted.push(monitor);
      else if (monitor.url === url) { conflictIds.push(monitor.id); kept.push(monitor); }
      else kept.push(monitor);
    }
    monitors.splice(0, monitors.length, ...kept);
    return { ok: true, deletedCount: deleted.length, deletedIds: deleted.map((monitor) => monitor.id), conflictIds, unprocessedIds: conflictIds };
  });
  return afterMonitorCommit(result, [['permission', () => releaseUnusedSitePermission(url)], ['live', () => reconcileLiveSessions()], ['badge', () => refreshBadge()], ['schedule', () => scheduleNextAlarm()]]);
}

async function acknowledgeMonitor(id, message = {}) {
  const viewedAt = nowIso();
  const result = await mutateMonitors((monitors) => {
    const monitor = monitors.find((item) => item.id === id);
    if (!monitor) {
      return { ok: false, reason: 'missing', error: '추적을 찾을 수 없습니다.' };
    }
    const conflict = mutationConflict(monitor, message);
    if (conflict) return conflict;
    monitor.unread = false;
    monitor.lastViewedAt = viewedAt;
    if (monitor.status === 'changed') {
      monitor.status = statusForStoredSnapshot(monitor.snapshot, monitor.tracking);
    }
    monitor.updatedAt = viewedAt;
    return { ok: true, id, lastChangeId: monitor.lastChange?.id ?? monitor.lastChange?.detectedAt ?? null };
  });
  return afterMonitorCommit(result, [['badge', () => refreshBadge()]]);
}

async function openMonitorWindow(id) {
  const monitor = (await getMonitors()).find((item) => item.id === id);
  if (!monitor) {
    return { ok: false, error: '모니터를 찾을 수 없습니다.' };
  }

  await chrome.windows.create({
    url: monitor.url,
    type: 'popup',
    width: 520,
    height: 680,
    focused: true
  });
  await acknowledgeMonitor(id);
  return { ok: true };
}

async function openMonitorTab(id) {
  const monitor = (await getMonitors()).find((item) => item.id === id);
  if (!monitor) {
    return { ok: false, error: '모니터를 찾을 수 없습니다.' };
  }

  await chrome.tabs.create({ url: monitor.url, active: true });
  await acknowledgeMonitor(id);
  return { ok: true };
}

// Dashboard imports can arrive in small messages so structured cloning and
// validation never monopolise the dashboard or the MV3 worker. Keep the
// expensive global follow-up work for the final message in that sequence.
async function finalizeImportedMonitors(beforeImport = []) {
  let warnings = 0;
  const runBestEffort = async (operation) => {
    try {
      await operation();
    } catch {
      warnings += 1;
    }
  };

  // Storage is the commit boundary. These derived UI/scheduler/live states can
  // be rebuilt from storage on the next event, so a failure here must never
  // turn a successful commit into a misleading "import failed" response.
  await runBestEffort(() => reconcileLiveSessions());
  await runBestEffort(() => refreshBadge());
  await runBestEffort(() => scheduleNextAlarm());
  const permissionResults = await Promise.allSettled(
    beforeImport.map((monitor) => releaseUnusedSitePermission(monitor.url))
  );
  warnings += permissionResults.filter((result) => result.status === 'rejected').length;
  return { ok: true, warnings };
}

async function openDashboard() {
  await chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  return { ok: true };
}

async function releaseUnclaimedOrigin(message, sender) {
  const url = normalizeUrl(message.url);
  await releasePendingPicker(message.tabId ?? sender?.tab?.id);
  if (url) {
    await releaseUnusedSitePermission(url);
  }
  return { ok: true };
}

async function startPicker(tabId, url) {
  if (!Number.isInteger(tabId)) {
    return { ok: false, error: '현재 탭을 찾을 수 없습니다.' };
  }
  const normalizedUrl = normalizeUrl(url);
  if (normalizedUrl) {
    await rememberPendingPicker(tabId, normalizedUrl);
  }
  try {
    // The picker does its first geometry read only after a pointer event, so a
    // DOM-ready document is sufficient and avoids a guaranteed 2.5 s wait.
    await waitForPickerDocumentReady(tabId);
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['selector-engine.js', 'picker.js']
    });
  } catch (error) {
    await forgetPendingPicker(tabId);
    throw error;
  }
  return { ok: true };
}

function runtimeStatusForMonitor(monitor) {
  const session = liveSessions.get(monitor.id);
  const backoff = storageFailureBackoff.get(monitor.id);
  return { checking: checksInProgress.has(monitor.id), queued: captureTasks.has(monitor.id) && !checksInProgress.has(monitor.id), queuedAt: captureQueuedAt.get(monitor.id) || null, liveConnection: !isLiveTracking(monitor) ? null : session ? session.navigating ? 'loading' : 'observing' : monitor.enabled ? 'pending' : 'paused', retryAt: backoff ? new Date(backoff.retryAt).toISOString() : null };
}

async function getRuntimeStatus() {
  const owned = await getLiveOwnedTabs();
  const jobs = await captureJobRecords();
  const pending = [...Object.entries(owned).filter(([, entry]) => ['pendingCleanup', 'ownership-unverified'].includes(entry.stage)).map(([id, entry]) => ({ ...entry, id, kind: 'live' })), ...jobs.filter((job) => ['pendingCleanup', 'ownership-unverified'].includes(job.stage)).map((job) => ({ ...job, kind: 'capture' }))];
  const pendingCleanup = await Promise.all(pending.map(async (entry) => {
    const tab = await tabById(entry.tabId);
    const monitor = typeof getMonitorMetadataById === 'function' ? await getMonitorMetadataById(entry.id) : await getMonitorById(entry.id);
    return { id: entry.id, monitorId: entry.id, kind: entry.kind, tabId: entry.tabId, stage: entry.stage, url: entry.url, revision: entry.revision, monitorRevision: monitor?.revision, ownerToken: entry.ownerToken, createdAt: entry.createdAt, candidate: tab ? { id: tab.id, url: tab.url, pinned: tab.pinned === true } : null, canAdopt: entry.kind === 'live' && monitor?.enabled && isLiveTracking(monitor) && normalizeUrl(tab?.url) === entry.url && monitor.url === entry.url && tab?.pinned === true };
  }));
  const oldestQueuedAt = [...captureQueuedAt.values()].sort()[0] || null;
  return { ok: true, activeCaptures, queuedCaptures: captureQueue.length, oldestQueuedAt, oldestQueueWaitMilliseconds: oldestQueuedAt ? Math.max(0, Date.now() - Date.parse(oldestQueuedAt)) : 0, globalLimit: MAX_GLOBAL_CAPTURES, originLimit: MAX_ORIGIN_CAPTURES, residentLiveTabs: liveSessions.size, residentLimit: MAX_RESIDENT_LIVE_TABS, storageRetryAt: storageUnavailableUntil > Date.now() ? new Date(storageUnavailableUntil).toISOString() : null, pendingCaptureCount: pendingSnapshotCommits.size, pendingCaptureBytes, pendingCaptureByteLimit: MAX_PENDING_CAPTURE_BYTES, pendingCleanup, jobs: jobs.map((job) => ({ id: job.id, stage: job.stage, createdAt: job.createdAt })), backoff: [...storageFailureBackoff].map(([id, entry]) => ({ id, ...entry })) };
}

function reconcileRuntimeOwnership(message) {
  const id = cleanShortText(message?.monitorId ?? message?.id, 100);
  return queueLiveLifecycle(id, () => reconcileRuntimeOwnershipInternal(id, message));
}

async function reconcileRuntimeOwnershipInternal(id, message) {
  const action = message?.action;
  if (!id || !['adopt', 'release', 'retry-cleanup', 'cleanup'].includes(action)) return { ok: false, error: '탭 복구 작업을 확인해 주세요.' };
  const owned = await getLiveOwnedTabs();
  const kind = message?.kind === 'capture' ? 'capture' : owned[id] ? 'live' : 'capture';
  const entry = kind === 'live' ? owned[id] : await getRuntimeAux('jobs', `capture.${id}`);
  if (!entry) return { ok: true, committed: true, monitorId: id, alreadyResolved: true };
  if (Number(message.tabId) !== entry.tabId || message.ownerToken && message.ownerToken !== entry.ownerToken) return { ok: false, reason: 'conflict', error: '복구할 탭 정보가 변경되었습니다. 목록을 다시 불러와 주세요.' };
  const tab = await tabById(entry.tabId);
  if (action === 'adopt') {
    const monitor = await getMonitorById(id);
    const conflict = mutationConflict(monitor, message);
    if (conflict) return conflict;
    if (kind !== 'live' || !monitor?.enabled || !isLiveTracking(monitor) || !tab || normalizeUrl(tab.url) !== entry.url || monitor.url !== entry.url || tab.pinned !== true) return { ok: false, reason: 'ownership-mismatch', error: '저장된 주소와 일치하는 고정 탭만 다시 연결할 수 있습니다.' };
    const sessionId = await runtimeSessionId();
    await mutateLiveOwnedTabs((all) => { if (all[id]?.tabId === entry.tabId) all[id] = { ...all[id], revision: monitor.revision, sessionId, stage: 'loading' }; });
    // Already within this monitor's lifecycle queue; do not enqueue recursively.
    return afterMonitorCommit({ ok: true, monitorId: id, tabId: entry.tabId, adopted: true }, [['live', () => startLiveMonitorInternal({ id })]]);
  }
  if (action !== 'release' && tab) {
    // An explicit cleanup click still validates the shown candidate before
    // removing it; a reused tab ID at a different URL is never closed.
    if (normalizeUrl(tab.url) !== entry.url || tab.pinned !== true) return { ok: false, reason: 'ownership-mismatch', error: '탭 주소 또는 고정 상태가 변경되었습니다. 기록 해제만 가능합니다.' };
    if (!await removeLiveControlledTab(entry.tabId)) return { ok: false, reason: 'pending-cleanup', pendingCleanup: true, error: '탭을 닫지 못했습니다. 정리 기록을 유지했습니다.' };
  }
  if (kind === 'live') {
    // release deliberately leaves the candidate tab open and relinquishes all
    // extension ownership. It does not create a replacement until the next
    // normal recovery cycle.
    const session = liveSessions.get(id);
    if (action === 'release' && session?.frameIds?.size) await chrome.scripting.executeScript({ target: liveTarget(session.tabId, [...session.frameIds]), func: removeLiveMutationObserver, args: [id] }).catch(() => undefined);
    liveSessions.delete(id); liveDirtyByMonitor.delete(id);
    await forgetLiveControlledTab(id, entry.tabId);
  } else await deleteRuntimeAux('jobs', `capture.${id}`);
  return { ok: true, committed: true, monitorId: id, tabId: entry.tabId, released: action === 'release', cleaned: action !== 'release' };
}

function recoverRuntime(options = {}) {
  if (runtimeRecoveryPromise) return runtimeRecoveryPromise;
  recoveringRuntime = true;
  runtimeRecoveryPromise = recoverRuntimeInternal(options).finally(() => {
    recoveringRuntime = false;
    runtimeRecoveryPromise = null;
    drainCaptureQueue();
  });
  return runtimeRecoveryPromise;
}

async function recoverRuntimeInternal({ startup = false } = {}) {
  await runtimePersistenceQueue.catch(() => undefined);
  const checkpoint = await getRuntimeAux('runtime', 'checkpoint') || { jobs: {}, backoff: {} };
  if (Number(checkpoint.storageRetryAt) > Date.now()) storageUnavailableUntil = Math.max(storageUnavailableUntil, checkpoint.storageRetryAt);
  for (const [id, entry] of Object.entries(checkpoint.backoff || {})) storageFailureBackoff.set(id, entry);
  const resumed = [];
  for (const job of await captureJobRecords()) {
    const id = job.id;
    if (captureTasks.has(id)) continue;
    // A persisted job absent from this worker's task map was interrupted (or
    // failed before starting), regardless of its wall-clock age.
    if (Number.isInteger(job.tabId)) {
      const tab = await tabById(job.tabId);
      if (tab && job.sessionId !== await runtimeSessionId()) {
        await putRuntimeAux('jobs', `capture.${id}`, { ...job, stage: 'ownership-unverified' });
        continue;
      }
      if (tab && !await removeLiveControlledTab(job.tabId)) {
        await putRuntimeAux('jobs', `capture.${id}`, { ...job, stage: 'pendingCleanup' });
        continue;
      }
    }
    await putRuntimeAux('jobs', `capture.${id}`, { ...job, stage: 'resumable', tabId: null });
    resumed.push(job);
  }
  recoveringRuntime = false;
  drainCaptureQueue();
  await reconcileLiveControlledTabs(await getMonitors());
  await restoreLiveMonitoring();
  for (const job of resumed) {
    const monitor = typeof getMonitorMetadataById === 'function' ? await getMonitorMetadataById(job.id) : await getMonitorById(job.id);
    if (!monitor?.enabled) await deleteRuntimeAux('jobs', `capture.${job.id}`);
    else if ((storageFailureBackoff.get(job.id)?.retryAt || 0) <= Date.now()) void checkMonitor(job.id, { reschedule: false, source: job.source === 'live' ? 'scheduled' : job.source }).catch(() => undefined);
  }
  for (const [id, dirty] of Object.entries(checkpoint.dirty || {})) {
    const monitor = typeof getMonitorMetadataById === 'function' ? await getMonitorMetadataById(id) : await getMonitorById(id);
    const session = liveSessions.get(id);
    if (monitor?.enabled && monitor.revision === dirty.revision && session?.tabId === dirty.tabId) void requestLiveCapture(monitor, session.tabId, dirty.frameIds?.[0] || 0).catch(() => undefined);
  }
  return { resumed: resumed.length };
}

const messageHandlers = {
  'get-state': async () => ({ ok: true, ...(await getState()) }),
  'start-dashboard-load': () => startDashboardLoad(),
  'get-dashboard-load-page': (message) => getDashboardLoadPage(message),
  'finish-dashboard-load': (message) => finishDashboardLoad(message),
  'get-monitor-detail': (message) => getMonitorDetail(message.id),
  'get-monitor-detail-fragment': (message) => getMonitorDetailFragment(message),
  'finish-monitor-detail': async (message) => { await OpenStillRecordStore.deleteAux('staging', 'detail:' + message.detailToken); return { ok: true }; },
  'get-monitor-summaries': (message) => getMonitorSummaryPage(message),
  'get-recovery-status': () => recoveryStatus(),
  'restore-recovery-record': (message) => restoreRecoveryRecord(message),
  'get-popup-state': () => getPopupState(),
  'start-export-session': (message) => startExportSession(message),
  'get-export-monitor': (message) => getExportMonitor(message),
  'get-export-monitor-fragment': (message) => getExportMonitorFragment(message),
  'touch-export-session': (message) => touchExportSession(message),
  'checkpoint-export-session': (message) => checkpointExportSession(message),
  'finish-export-session': (message) => finishExportSession(message),
  'start-picker': (message) => startPicker(message.tabId, message.url),
  'create-monitor': (message, sender) => createMonitor(message, sender),
  'create-monitors': (message, sender) => createMonitors(message, sender),
  'save-monitor': (message) => saveMonitor(message),
  'set-monitor-enabled': (message) => setMonitorEnabled(message),
  'delete-monitor': (message) => deleteMonitor(message.id, message),
  'delete-monitors': (message) => deleteMonitors(message),
  'update-monitor-labels': (message) => updateMonitorLabels(message),
  'check-monitor': (message) => checkMonitor(message.id),
  'start-live-monitor': (message) => startLiveMonitor(message),
  'stop-live-monitor': (message) => stopLiveMonitor(message),
  'live-monitor-mutated': (message, sender) => handleLiveMonitorMutation(message, sender),
  'check-monitors': (message) => checkMonitors(message),
  'check-page': (message) => checkPage(message.url),
  'move-page-url': (message) => reusePageUrl(message),
  'copy-page-url': (message) => reusePageUrl(message, { copy: true }),
  'replace-site-host': (message) => replaceSiteHost(message),
  'delete-page': (message) => deletePage(message.url, message),
  'acknowledge-monitor': (message) => acknowledgeMonitor(message.id, message),
  'open-monitor-window': (message) => openMonitorWindow(message.id),
  'open-monitor-tab': (message) => openMonitorTab(message.id),
  'import-monitors': (message) => importMonitors(message),
  'start-import-session': (message) => startImportSession(message),
  'append-import-session': (message) => appendImportSession(message),
  'append-import-fragments': (message) => appendImportFragments(message),
  'touch-import-session': (message) => touchImportSession(message),
  'finish-import-session': (message) => finishImportSession(message),
  'abort-import-session': (message) => abortImportSession(message),
  'finalize-import': () => finalizeImportedMonitors(),
  'open-dashboard': () => openDashboard(),
  'release-unclaimed-origin': (message, sender) => releaseUnclaimedOrigin(message, sender),
  'save-settings': async (message) => ({ ok: true, committed: true, settings: await updateSettings(message.settings) }),
  'get-operation-result': async (message) => { const receipt = await getRuntimeAux('operations', message.operationId); return receipt ? { ok: true, found: true, ...receipt.result, committed: true, operationId: message.operationId } : { ok: true, found: false }; },
  'get-runtime-status': () => getRuntimeStatus(),
  'reconcile-runtime-ownership': (message) => reconcileRuntimeOwnership(message)
};

const mutationMessageTypes = new Set(['create-monitor', 'create-monitors', 'save-monitor', 'set-monitor-enabled', 'delete-monitor', 'delete-monitors', 'update-monitor-labels', 'move-page-url', 'copy-page-url', 'replace-site-host', 'delete-page', 'acknowledge-monitor', 'import-monitors', 'finish-import-session', 'save-settings', 'reconcile-runtime-ownership']);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = messageHandlers[message?.type];
  if (!handler) {
    return;
  }

  Promise.resolve(mutationMessageTypes.has(message.type) ? runMutationOperation(message, () => handler(message, _sender)) : handler(message, _sender)).then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: responseError(error) });
  });
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    void runDueChecks().catch(() => undefined);
  } else if (alarm.name === RUNTIME_ALARM_NAME) {
    void recoverRuntime().then(() => runDueChecks()).catch(() => undefined);
  }
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId.startsWith('openstill-change:')) {
    void openMonitorWindow(notificationId.slice('openstill-change:'.length));
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void releasePendingPicker(tabId);
  void forgetLiveControlledTabByTabId(tabId);
  for (const [monitorId, session] of liveSessions) {
    if (session.tabId === tabId) {
      liveSessions.delete(monitorId);
      liveDirtyByMonitor.delete(monitorId);
      // onRemoved follows successful extension cleanup as well. Only a
      // still-enabled live configuration is eligible for reconnection.
      void getMonitorById(monitorId).then((monitor) => {
        if (monitor?.enabled && isLiveTracking(monitor)) return startLiveMonitor({ id: monitorId });
      }).catch(() => undefined);
    }
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    void releasePendingPicker(tabId);
    for (const [monitorId, session] of liveSessions) {
      if (session.tabId === tabId) {
        // Keep ownership through a controlled-tab reload. The old isolated
        // observer is destroyed by navigation; completion reuses this exact
        // tab and installs a fresh one without ever falling back to a user tab.
        session.navigating = true;
        session.frameIds = new Set();
        session.rawTextByFrame = new Map();
        liveDirtyByMonitor.delete(monitorId);
      }
    }
  } else if (changeInfo.status === 'complete') {
    void restoreLiveForTab(tabId, changeInfo.url ? { id: tabId, url: changeInfo.url } : null).catch(() => undefined);
  }
  if (changeInfo.url && changeInfo.status !== 'loading') {
    void (async () => {
      const url = normalizeUrl(changeInfo.url);
      if (!url) return;
      const monitors = new Map((await getMonitors()).map((monitor) => [monitor.id, monitor]));
      for (const [monitorId, session] of [...liveSessions]) {
        if (session.tabId !== tabId) continue;
        const monitor = monitors.get(monitorId);
        if (!monitor || monitor.url !== url) await detachLiveSession(monitorId);
      }
      await restoreLiveForTab(tabId, { id: tabId, url });
    })().catch(() => undefined);
  }
});

if (chrome.webNavigation?.onCompleted) {
  chrome.webNavigation.onCompleted.addListener((details) => {
    if (details.frameId === 0) {
      void restoreLiveForTab(details.tabId).catch(() => undefined);
    } else {
      void reinstallLiveFrame(details.tabId, details.frameId).catch(() => undefined);
    }
  });
}

if (chrome.webNavigation?.onHistoryStateUpdated) {
  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId === 0) {
      void restoreLiveForTab(details.tabId).catch(() => undefined);
    } else {
      void reinstallLiveFrame(details.tabId, details.frameId).catch(() => undefined);
    }
  });
}

function initialize({ cleanupPermissions = false } = {}) {
  initializationPermissionCleanup ||= cleanupPermissions;
  if (initializationPromise) return initializationPromise;
  initializationPromise = (async () => {
    const warnings = [];
    const run = async (step, action) => { try { await action(); } catch (error) { warnings.push({ step, error: responseError(error) }); } };
    await run('storage-access', async () => { if (chrome.storage.local.setAccessLevel) await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }); });
    await run('migration', () => migrateLegacyScheduleModes());
    await run('repairs', () => persistNormalizedMonitorRepairs());
    await run('runtime-recovery', () => recoverRuntime({ startup: true }));
    await run('schedule', () => scheduleNextAlarm());
    await run('recovery-wakeup', () => chrome.alarms.create(RUNTIME_ALARM_NAME, { periodInMinutes: 1 }));
    await run('badge', () => refreshBadge());
    await run('pickers', () => clearExpiredPendingPickers());
    if (initializationPermissionCleanup) await run('permissions', () => cleanupUnusedSitePermissions());
    initializationPermissionCleanup = false;
    if (warnings.length) await putRuntimeAux('runtime', 'diagnostics', { at: nowIso(), warnings }).catch(() => undefined);
    return { ok: true, warnings };
  })();
  initializationPromise.finally(() => { initializationPromise = null; }).catch(() => undefined);
  return initializationPromise;
}

chrome.runtime.onInstalled.addListener(() => {
  void initialize({ cleanupPermissions: true });
});

chrome.runtime.onStartup.addListener(() => {
  void initialize({ cleanupPermissions: true });
});

void initialize();
