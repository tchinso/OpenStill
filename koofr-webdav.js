(function initializeKoofrWebDav(root) {
  'use strict';

  const ORIGIN = 'https://app.koofr.net';
  const ROOT = ['dav', 'Koofr', 'OpenStill'];
  const DAV = 'DAV:';
  const FORMAT = 'openstill-koofr-complete';
  const MARKER = 'complete.json';
  const JSON_TYPE = 'application/json';
  const MAX_PART_SIZE = 32 * 1024 * 1024 - 1;
  const MAX_METADATA_SIZE = 16 * 1024 * 1024;
  const MAX_PARTS = 100_000;
  const MAX_ATTEMPTS = 3;
  const MAX_RETRY_WAIT = 30_000;
  const REQUEST_TIMEOUT = 10 * 60_000;
  const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>';
  const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
  const SHA256 = /^[a-f0-9]{64}$/;
  const messages = {
    AUTH: 'Koofr 이메일과 앱 비밀번호를 확인해 주세요.',
    FORBIDDEN: 'Koofr가 요청을 허용하지 않았습니다. 앱 비밀번호와 계정의 파일 제한을 확인해 주세요.',
    QUOTA: 'Koofr에 백업을 저장할 여유 공간이 부족합니다.',
    NOT_FOUND: 'Koofr에서 백업 파일 또는 폴더를 찾을 수 없습니다.',
    TRANSIENT: 'Koofr와의 통신이 일시적으로 실패했습니다.',
    INVALID: 'Koofr 백업의 목록, 파일 또는 지문을 확인할 수 없습니다.',
    CONFLICT: 'Koofr의 기존 백업 파일이 다른 내용으로 저장되어 있습니다.',
    REDIRECT: 'Koofr가 다른 주소로 연결을 요청했습니다.',
    CANCELED: 'Koofr 작업을 취소했습니다.',
    HTTP: 'Koofr가 요청을 처리하지 못했습니다.'
  };

  function failure(code, retryAt) {
    const error = new Error(messages[code]);
    error.code = code;
    if (retryAt) error.retryAt = retryAt;
    return error;
  }

  function retryTime(value) {
    if (!value) return undefined;
    const parsed = /^\d+$/.test(value) ? Date.now() + Number(value) * 1000 : Date.parse(value);
    return Number.isSafeInteger(parsed) && parsed > Date.now() ? parsed : undefined;
  }

  function httpFailure(status, retryAfter) {
    if (status === 401) return failure('AUTH');
    if (status === 403) return failure('FORBIDDEN');
    if (status === 404) return failure('NOT_FOUND');
    if (status === 507) return failure('QUOTA');
    if (status === 408 || status === 429 || (status >= 500 && status < 600)) {
      return failure('TRANSIENT', retryTime(retryAfter));
    }
    if (status === 412) return failure('CONFLICT');
    return failure('HTTP');
  }

  function wait(milliseconds, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(failure('CANCELED'));
        return;
      }
      const abort = () => {
        clearTimeout(timer);
        reject(failure('CANCELED'));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve();
      }, milliseconds);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  function discardBody(response) {
    if (response.body && !response.body.locked) void response.body.cancel().catch(() => {});
  }

  async function readBlob(response, limit, expectedSize) {
    const encoding = response.headers.get('Content-Encoding');
    const encodedLength = Number(response.headers.get('Content-Length'));
    if (!response.body || ((!encoding || encoding === 'identity') && encodedLength > limit)) {
      discardBody(response);
      throw failure('INVALID');
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          void reader.cancel().catch(() => {});
          throw failure('INVALID');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    if (expectedSize !== undefined && size !== expectedSize) throw failure('INVALID');
    return new Blob(chunks, { type: JSON_TYPE });
  }

  async function sha256(blob) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function identifier(value) {
    return typeof value === 'string' && IDENTIFIER.test(value);
  }

  function backupPath(deviceId, backupId) {
    if (!identifier(deviceId) || !identifier(backupId)) throw failure('INVALID');
    return [...ROOT, 'devices', deviceId, 'backups', backupId];
  }

  function partName(partNumber) {
    if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS) throw failure('INVALID');
    return 'part-' + String(partNumber).padStart(3, '0') + '.json';
  }

  function readPartInfo(part, partNumber) {
    const name = partName(partNumber);
    if (part?.name !== name || !Number.isSafeInteger(part.size) || part.size < 1 || part.size > MAX_PART_SIZE
      || typeof part.sha256 !== 'string' || !SHA256.test(part.sha256)) throw failure('INVALID');
    return { name, size: part.size, sha256: part.sha256 };
  }

  function readDescriptor(value, deviceId, backupId) {
    if (value?.format !== FORMAT || value.version !== 1 || value.deviceId !== deviceId || value.backupId !== backupId
      || !identifier(value.setId) || typeof value.createdAt !== 'string' || value.createdAt.length !== 24
      || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt
      || !Array.isArray(value.parts) || !value.parts.length || value.parts.length > MAX_PARTS
      || value.partCount !== value.parts.length) throw failure('INVALID');
    const parts = Array.from(value.parts, (part, index) => readPartInfo(part, index + 1));
    const totalBytes = parts.reduce((sum, part) => sum + part.size, 0);
    if (value.totalBytes !== totalBytes) throw failure('INVALID');
    return {
      format: FORMAT, version: 1, deviceId, backupId, setId: value.setId, createdAt: value.createdAt,
      partCount: parts.length, totalBytes, parts
    };
  }

  function davChildren(parent, localName) {
    return Array.from(parent?.children || []).filter((node) => node.namespaceURI === DAV && node.localName === localName);
  }

  function davStatus(node) {
    return Number(/^HTTP\/\d+(?:\.\d+)?\s+([1-5]\d{2})(?:\s|$)/.exec(davChildren(node, 'status')[0]?.textContent.trim())?.[1]);
  }

  function hrefPath(href) {
    if (typeof href !== 'string') return null;
    const value = href.trim();
    const path = value.startsWith(ORIGIN + '/') ? value.slice(ORIGIN.length) : value;
    if (!path.startsWith('/') || path.startsWith('//') || /[?#\\]/.test(path)) return null;
    try {
      const segments = path.slice(1).replace(/\/$/, '').split('/').map(decodeURIComponent);
      return segments.every((part) => part && part !== '.' && part !== '..' && !/[\/\\\p{Cc}]/u.test(part)) ? segments : null;
    } catch {
      return null;
    }
  }

  function readListing(xml, expected, strict) {
    if (/<!DOCTYPE/i.test(xml)) throw failure('INVALID');
    const parsed = new DOMParser().parseFromString(xml, 'application/xml');
    if (parsed.doctype || parsed.getElementsByTagName('parsererror').length
      || parsed.documentElement?.namespaceURI !== DAV || parsed.documentElement.localName !== 'multistatus') {
      throw failure('INVALID');
    }
    const members = new Map();
    let self;
    for (const node of davChildren(parsed.documentElement, 'response')) {
      const path = hrefPath(davChildren(node, 'href')[0]?.textContent);
      if (!path || !expected.every((segment, index) => segment === path[index]) || path.length > expected.length + 1) {
        if (strict) throw failure('INVALID');
        continue;
      }
      const status = davStatus(node);
      const properties = davChildren(node, 'propstat');
      const type = properties
        .filter((property) => {
          const code = davStatus(property);
          return code >= 200 && code < 300;
        })
        .flatMap((property) => davChildren(davChildren(property, 'prop')[0], 'resourcetype'))[0];
      const entry = {
        name: path.at(-1),
        success: Boolean(type) && !(status >= 400),
        collection: davChildren(type, 'collection').length > 0,
        status: status || davStatus(properties[0])
      };
      if (path.length === expected.length) {
        if (self) throw failure('INVALID');
        self = entry;
      } else if (path.length === expected.length + 1) {
        if (members.has(entry.name)) entry.success = false;
        members.set(entry.name, entry);
      }
    }
    if (!self?.success || !self.collection) {
      throw self?.status >= 400 ? httpFailure(self.status) : failure('INVALID');
    }
    return [...members.values()];
  }

  function createClient(credentials, { signal } = {}) {
    const { email, appPassword } = credentials || {};
    if (typeof email !== 'string' || !email.includes('@') || email.length > 254 || /[:\s\p{Cc}]/u.test(email)
      || typeof appPassword !== 'string' || !appPassword || appPassword.length > 512 || /\p{Cc}/u.test(appPassword)) {
      throw failure('AUTH');
    }
    const authorization = 'Basic ' + btoa(String.fromCharCode(...new TextEncoder().encode(email + ':' + appPassword)));

    async function request(method, path, { collection = false, body, headers = {}, allowed, read } = {}) {
      const url = ORIGIN + '/' + path.map(encodeURIComponent).join('/') + (collection ? '/' : '');
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        if (signal?.aborted) throw failure('CANCELED');
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT);
        const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        let error;
        try {
          const response = await fetch(url, {
            method, body, headers: { ...headers, Authorization: authorization },
            cache: 'no-store', credentials: 'omit', redirect: 'manual', signal: requestSignal
          });
          if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
            discardBody(response);
            throw failure('REDIRECT');
          }
          if (allowed.includes(response.status)) {
            if (read) return await read(response);
            discardBody(response);
            return response.status;
          }
          discardBody(response);
          throw httpFailure(response.status, response.headers.get('Retry-After'));
        } catch (cause) {
          if (signal?.aborted) throw failure('CANCELED');
          error = Object.hasOwn(messages, cause?.code) ? cause : failure('TRANSIENT');
        }
        const delay = error.retryAt ? error.retryAt - Date.now() : 750 * 2 ** attempt;
        if (error.code !== 'TRANSIENT' || attempt + 1 === MAX_ATTEMPTS || delay > MAX_RETRY_WAIT) throw error;
        await wait(Math.max(0, delay), signal);
      }
    }

    async function list(path, { depth = 1, strict = false } = {}) {
      return request('PROPFIND', path, {
        collection: true, body: PROPFIND_BODY, headers: { Depth: String(depth), 'Content-Type': 'application/xml' },
        allowed: [207],
        read: async (response) => readListing(await (await readBlob(response, MAX_METADATA_SIZE)).text(), path, strict)
      });
    }

    async function ensureFolders(path) {
      for (let count = ROOT.length; count <= path.length; count += 1) {
        const folder = path.slice(0, count);
        const status = await request('MKCOL', folder, { collection: true, allowed: [201, 405] });
        if (status === 405) await list(folder, { depth: 0 });
      }
    }

    function putImmutable(path, blob) {
      return request('PUT', path, {
        body: blob, headers: { 'Content-Type': JSON_TYPE, 'If-None-Match': '*' },
        allowed: [200, 201, 204, 412]
      });
    }

    async function getVerified(path, { size, sha256: expected }, mismatchCode = 'INVALID') {
      return request('GET', path, {
        allowed: [200],
        read: async (response) => {
          try {
            const blob = await readBlob(response, size, size);
            if (await sha256(blob) !== expected) throw failure('INVALID');
            return blob;
          } catch (error) {
            if (error?.code === 'INVALID') throw failure(mismatchCode);
            throw error;
          }
        }
      });
    }

    async function writeVerified(path, blob) {
      const info = { size: blob.size, sha256: await sha256(blob) };
      // Verify an existing file before PUT as well as using the precondition.
      // This avoids an overwrite if a WebDAV server ignores If-None-Match.
      try {
        await getVerified(path, info, 'CONFLICT');
        return info;
      } catch (error) {
        if (error.code !== 'NOT_FOUND') throw error;
      }
      const status = await putImmutable(path, blob);
      await getVerified(path, info, status === 412 ? 'CONFLICT' : 'INVALID');
      return info;
    }

    async function probe() {
      await ensureFolders(ROOT);
      const nonce = crypto.randomUUID();
      const path = [...ROOT, 'probe-' + nonce + '.json'];
      const blob = new Blob([JSON.stringify({ openStillKoofrProbe: nonce })], { type: JSON_TYPE });
      const info = { size: blob.size, sha256: await sha256(blob) };
      let ownFile = false;
      try {
        const status = await putImmutable(path, blob);
        ownFile = status !== 412;
        await getVerified(path, info, status === 412 ? 'CONFLICT' : 'INVALID');
        ownFile = true;
      } finally {
        if (ownFile) await request('DELETE', path, { allowed: [200, 204, 404] });
      }
    }

    async function ensureBackupFolder(deviceId, backupId) {
      await ensureFolders(backupPath(deviceId, backupId));
    }

    async function putPart(deviceId, backupId, partNumber, blob) {
      const path = backupPath(deviceId, backupId);
      const name = partName(partNumber);
      if (!(blob instanceof Blob) || blob.size < 1 || blob.size > MAX_PART_SIZE) throw failure('INVALID');
      return { name, ...await writeVerified([...path, name], blob) };
    }

    async function publish(deviceId, backupId, { setId, createdAt, parts }) {
      const path = backupPath(deviceId, backupId);
      if (!Array.isArray(parts) || !parts.length || parts.length > MAX_PARTS) throw failure('INVALID');
      const totalBytes = parts.reduce((sum, part, index) => sum + readPartInfo(part, index + 1).size, 0);
      const descriptor = readDescriptor({
        format: FORMAT, version: 1, deviceId, backupId, setId, createdAt, partCount: parts.length, totalBytes, parts
      }, deviceId, backupId);
      const blob = new Blob([JSON.stringify(descriptor)], { type: JSON_TYPE });
      if (blob.size > MAX_METADATA_SIZE) throw failure('INVALID');
      await writeVerified([...path, MARKER], blob);
      return descriptor;
    }

    function readComplete(deviceId, backupId) {
      const path = backupPath(deviceId, backupId);
      return request('GET', [...path, MARKER], {
        allowed: [200],
        read: async (response) => {
          const text = await (await readBlob(response, MAX_METADATA_SIZE)).text();
          let value;
          try { value = JSON.parse(text); } catch { throw failure('INVALID'); }
          return readDescriptor(value, deviceId, backupId);
        }
      });
    }

    function getPart(complete, partNumber) {
      const path = backupPath(complete?.deviceId, complete?.backupId);
      const part = readPartInfo(complete?.parts?.[partNumber - 1], partNumber);
      return getVerified([...path, part.name], part);
    }

    async function listBackups({ deviceId } = {}) {
      if (deviceId !== undefined && !identifier(deviceId)) throw failure('INVALID');
      const devicesPath = [...ROOT, 'devices'];
      async function listExisting(path) {
        try { return await list(path); } catch (error) {
          if (error.code === 'NOT_FOUND') return [];
          throw error;
        }
      }
      const devices = deviceId ? [deviceId] : (await listExisting(devicesPath))
        .filter((item) => item.success && item.collection && identifier(item.name)).map((item) => item.name);
      const backups = [];
      for (const device of devices) {
        for (const item of await listExisting([...devicesPath, device, 'backups'])) {
          if (!item.success || !item.collection || !identifier(item.name)) continue;
          try { backups.push(await readComplete(device, item.name)); } catch (error) {
            if (!['NOT_FOUND', 'FORBIDDEN', 'INVALID'].includes(error.code)) throw error;
          }
        }
      }
      return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.backupId.localeCompare(b.backupId));
    }

    async function deleteBackup(deviceId, backupId) {
      const path = backupPath(deviceId, backupId);
      const complete = await readComplete(deviceId, backupId);
      const expected = new Set([MARKER, ...complete.parts.map((part) => part.name)]);
      const members = await list(path, { strict: true });
      if (members.length !== expected.size || members.some((item) => !item.success || item.collection || !expected.has(item.name))) {
        throw failure('INVALID');
      }
      // Remove the completion marker first. If cleanup is interrupted the
      // remaining files no longer appear as a usable backup. Never recursively
      // delete the directory, which might have acquired another file.
      for (const name of expected) await request('DELETE', [...path, name], { allowed: [200, 204, 404] });
    }

    return Object.freeze({ probe, ensureBackupFolder, putPart, publish, listBackups, readComplete, getPart, deleteBackup });
  }

  const api = Object.freeze({ createClient });
  if (typeof module === 'object' && module?.exports) module.exports = api;
  else root.OpenStillKoofrWebDav = api;
})(globalThis);
