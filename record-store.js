(function (root) {
  'use strict';
  const DB_NAME = 'openstill-records';
  const STORES = ['meta', 'monitors', 'snapshots', 'snapshotCopies', 'recovery', 'versions', 'staging', 'operations', 'jobs'];
  const PREFIX = 'openStill.record-store.v1.';
  let opening;
  const request = (value) => new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
  function database() {
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    if (!opening) opening = new Promise((resolve, reject) => {
      let abandoned = false;
      const value = indexedDB.open(DB_NAME, 2);
      value.onupgradeneeded = (event) => {
        for (const name of STORES) if (!value.result.objectStoreNames.contains(name)) value.result.createObjectStore(name);
        if (event.oldVersion === 1) {
          const source = value.transaction.objectStore('snapshots');
          const target = value.transaction.objectStore('snapshotCopies');
          const cursor = source.openCursor();
          cursor.onsuccess = () => {
            if (!cursor.result) return;
            target.put(cursor.result.value, cursor.result.key);
            cursor.result.continue();
          };
        }
      };
      value.onsuccess = () => {
        if (abandoned) { value.result.close(); return; }
        value.result.onversionchange = () => { value.result.close(); opening = null; };
        resolve(value.result);
      };
      value.onerror = () => { opening = null; reject(value.error); };
      value.onblocked = () => { abandoned = true; opening = null; reject(new Error('로컬 데이터베이스를 여는 중 다른 창이 잠금을 유지하고 있습니다.')); };
    });
    return opening;
  }
  function done(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('저장 트랜잭션이 중단되었습니다.'));
    });
  }
  async function writeTransaction(db, stores, apply) {
    const tx = db.transaction(stores, 'readwrite');
    const completion = done(tx);
    try { apply(tx); }
    catch (error) {
      // A synchronous DataCloneError or other exception does not abort an IDB
      // transaction automatically. Roll back writes already queued in it.
      try { tx.abort(); } catch { /* The transaction may already be aborted. */ }
      await completion.catch(() => undefined);
      throw error;
    }
    await completion;
  }
  async function getAux(store, key) {
    const db = await database();
    if (!db) return (await chrome.storage.local.get(PREFIX + store + '.' + key))[PREFIX + store + '.' + key];
    return request(db.transaction(store).objectStore(store).get(key));
  }
  async function allAux(store) {
    const db = await database();
    if (!db) {
      const values = await chrome.storage.local.get(null);
      return Object.entries(values).filter(([key]) => key.startsWith(PREFIX + store + '.')).map(([, value]) => value);
    }
    return request(db.transaction(store).objectStore(store).getAll());
  }
  async function keysAux(store, { prefix = '' } = {}) {
    const db = await database();
    const filter = String(prefix);
    if (!db) {
      const storagePrefix = PREFIX + store + '.';
      const keys = typeof chrome.storage.local.getKeys === 'function'
        ? await chrome.storage.local.getKeys() : Object.keys(await chrome.storage.local.get(null));
      return keys.filter((key) => key.startsWith(storagePrefix + filter)).map((key) => key.slice(storagePrefix.length));
    }
    let range;
    if (filter) {
      // Find the exclusive lexicographic successor, including Unicode prefixes.
      let index = filter.length - 1;
      while (index >= 0 && filter.charCodeAt(index) === 0xffff) index -= 1;
      range = index < 0 ? IDBKeyRange.lowerBound(filter)
        : IDBKeyRange.bound(filter, filter.slice(0, index) + String.fromCharCode(filter.charCodeAt(index) + 1), false, true);
    }
    // Key enumeration must never deserialize staged record/file payloads.
    const keys = await request(db.transaction(store).objectStore(store).getAllKeys(range));
    return keys.filter((key) => typeof key === 'string' && key.startsWith(filter));
  }
  async function allAuxEntries(store) {
    const db = await database();
    if (!db) {
      const values = await chrome.storage.local.get(null);
      const prefix = PREFIX + store + '.';
      return Object.entries(values).filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key.slice(prefix.length), value]);
    }
    const table = db.transaction(store).objectStore(store);
    const [keys, values] = await Promise.all([request(table.getAllKeys()), request(table.getAll())]);
    return keys.map((key, index) => [key, values[index]]);
  }
  async function putAux(store, key, value) {
    const db = await database();
    if (!db) return chrome.storage.local.set({ [PREFIX + store + '.' + key]: value });
    await writeTransaction(db, store, (tx) => tx.objectStore(store).put(value, key));
  }
  async function deleteAux(store, key) {
    const db = await database();
    if (!db) return chrome.storage.local.remove(PREFIX + store + '.' + key);
    await writeTransaction(db, store, (tx) => tx.objectStore(store).delete(key));
  }
  async function deleteAuxBatch(store, keys) {
    if (!keys.length) return;
    const db = await database();
    if (!db) return chrome.storage.local.remove(keys.map((key) => PREFIX + store + '.' + key));
    await writeTransaction(db, store, (tx) => { for (const key of keys) tx.objectStore(store).delete(key); });
  }
  async function putAuxBatch(store, entries) {
    const db = await database();
    if (!db) return chrome.storage.local.set(Object.fromEntries(entries.map(([key, value]) => [PREFIX + store + '.' + key, value])));
    await writeTransaction(db, store, (tx) => { for (const [key, value] of entries) tx.objectStore(store).put(value, key); });
  }
  async function digest(value) {
    const bytes = new TextEncoder().encode(value);
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  async function commitAux(patches) {
    if (!patches.length) return;
    const db = await database();
    if (!db) return chrome.storage.local.set(Object.fromEntries(patches.map(([store, key, value]) => [PREFIX + store + '.' + key, value])));
    await writeTransaction(db, [...new Set(patches.map(([store]) => store))], (tx) => {
      for (const [store, key, value] of patches) tx.objectStore(store).put(value, key);
    });
  }
  async function pack(monitor, snapshots, { allowReferences = true } = {}) {
    const refs = new Map();
    async function snapshot(value) {
      if (!value) return value;
      if (allowReferences && typeof value.$snapshot === 'string' && /^[a-f0-9]{64}$/.test(value.$snapshot)) return { ...value };
      if (refs.has(value)) return refs.get(value);
      const { $snapshot, previewVersion, ...payload } = value;
      const serialized = JSON.stringify(payload);
      const ref = { $snapshot: await digest(serialized), previewVersion: 1,
        exists: value.exists, matchCount: value.matchCount, capturedAt: value.capturedAt,
        text: String(value.text ?? '').slice(0, 800), itemCount: Array.isArray(value.items) ? value.items.length : 0,
        ...Object.fromEntries(['textFingerprint', 'compactTextFingerprint', 'tokenTextFingerprint', 'dataFingerprint', 'compactDataFingerprint', 'tokenDataFingerprint',
          'textOriginalLength', 'textStoredLength', 'dataOriginalLength', 'dataStoredLength', 'textTruncated', 'dataTruncated', 'captureVersion', 'contentOmitted']
          .filter((name) => value[name] !== undefined).map((name) => [name, value[name]])) };
      snapshots.set(ref.$snapshot, { json: serialized, digest: ref.$snapshot }); refs.set(value, ref);
      return ref;
    }
    const { _storageRecovery, ...storedMonitor } = monitor;
    return {
      ...storedMonitor,
      snapshot: await snapshot(monitor.snapshot),
      lastErrorSnapshot: await snapshot(monitor.lastErrorSnapshot),
      lastChange: monitor.lastChange ? { ...monitor.lastChange, previous: await snapshot(monitor.lastChange.previous), current: await snapshot(monitor.lastChange.current) } : null,
      history: await Promise.all((monitor.history || []).map(async (entry) => ({ ...entry, snapshot: await snapshot(entry.snapshot) })))
    };
  }
  async function stageMonitor(monitor, { allowReferences = false } = {}) {
    const snapshots = new Map();
    const packed = await pack(monitor, snapshots, { allowReferences });
    const patches = await snapshotPatches(snapshots, 'stage-' + crypto.randomUUID());
    // Body blobs are durable before a compact staged record refers to them.
    // This never changes active monitors or the current generation marker.
    await commitAux(patches);
    return packed;
  }
  async function stageSnapshot(snapshot) {
    if (!snapshot || typeof snapshot.json !== 'string' || typeof snapshot.id !== 'string'
      || !/^[a-f0-9]{64}$/.test(snapshot.id) || await digest(snapshot.json) !== snapshot.id) {
      const error = new Error('스냅샷 원문 지문이 일치하지 않습니다.'); error.snapshotValidation = true; throw error;
    }
    try { JSON.parse(snapshot.json); }
    catch (cause) { const error = new Error('스냅샷 JSON을 해석하지 못했습니다: ' + cause.message); error.snapshotValidation = true; throw error; }
    const value = { json: snapshot.json, digest: snapshot.id };
    // Archive both damaged originals and repair both copies in one transaction.
    await commitAux(await snapshotPatches(new Map([[snapshot.id, value]]), 'import-' + crypto.randomUUID()));
  }
  const damagesByCache = new WeakMap();
  async function unpack(record, cache = new Map()) {
    const storageRecovery = new Map();
    let damages = damagesByCache.get(cache);
    if (!damages) { damages = new Map(); damagesByCache.set(cache, damages); }
    const readVerified = async (value, id) => {
      if (!value || typeof value.json !== 'string' || await digest(value.json) !== id) throw new Error('스냅샷 지문이 일치하지 않습니다.');
      return JSON.parse(value.json);
    };
    async function snapshot(value) {
      if (!value?.$snapshot) return value;
      if (!cache.has(value.$snapshot)) {
        const stored = await getAux('snapshots', value.$snapshot);
        try { cache.set(value.$snapshot, await readVerified(stored, value.$snapshot)); }
        catch (error) {
          const copy = await getAux('snapshotCopies', value.$snapshot);
          try { cache.set(value.$snapshot, await readVerified(copy, value.$snapshot)); }
          catch {
            error.snapshotDamage = { snapshotId: value.$snapshot, raw: stored ?? null, copyRaw: copy ?? null };
            throw error;
          }
          damages.set(value.$snapshot, { id: 'damaged-snapshot-' + value.$snapshot, source: 'snapshots', snapshotId: value.$snapshot,
            raw: stored ?? null, error: error.message, restoredFrom: 'snapshotCopies' });
        }
      }
      if (damages.has(value.$snapshot)) storageRecovery.set(value.$snapshot, damages.get(value.$snapshot));
      return cache.get(value.$snapshot);
    }
    const unpacked = { ...record, snapshot: await snapshot(record.snapshot), lastErrorSnapshot: await snapshot(record.lastErrorSnapshot),
      lastChange: record.lastChange ? { ...record.lastChange, previous: await snapshot(record.lastChange.previous), current: await snapshot(record.lastChange.current) } : null,
      history: await Promise.all((record.history || []).map(async (entry) => ({ ...entry, snapshot: await snapshot(entry.snapshot) }))) };
    if (storageRecovery.size) unpacked._storageRecovery = [...storageRecovery.values()];
    return unpacked;
  }
  async function load({ lazy = false } = {}) {
    const meta = await getAux('meta', 'current');
    const envelopes = await allAuxEntries('monitors');
    if (!meta && !envelopes.length) return null;
    const monitors = []; const recovery = []; const cache = new Map();
    const generation = Number.isSafeInteger(meta?.generation) && meta.generation >= 0 ? meta.generation : 0;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta) || !Number.isSafeInteger(meta.generation) || meta.generation < 0) {
      recovery.push({ id: 'damaged-meta-current', source: 'meta', raw: meta ?? null, error: '현재 세대 메타데이터를 해석하지 못해 독립 레코드를 회수했습니다.' });
    }
    for (const [recordId, envelope] of envelopes) {
      if (envelope?.deleted === true && envelope.id === recordId && !envelope.record) continue;
      try {
        if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
          || !envelope.record || typeof envelope.record !== 'object' || Array.isArray(envelope.record)
          || envelope.id !== recordId || envelope.record.id !== recordId) throw new Error('레코드 컨테이너 또는 ID가 손상되었습니다.');
        if (await digest(JSON.stringify(envelope.record)) !== envelope.digest) throw new Error('레코드 지문이 일치하지 않습니다.');
        if (Number(envelope.record.schemaVersion) > 1) recovery.push({
          id: 'future-record-' + recordId + '-' + envelope.digest, source: 'future-schema', recordId,
          raw: envelope, error: '지원하지 않는 레코드 버전의 원본을 보존했습니다.'
        });
        const monitor = lazy ? envelope.record : await unpack(envelope.record, cache);
        monitors.push(monitor);
        recovery.push(...(monitor._storageRecovery || []).map((entry) => ({ ...entry, recordId })));
      } catch (error) {
        recovery.push({ id: 'damaged-' + recordId + '-' + generation, source: 'records', recordId, raw: envelope, error: error.message });
        if (error.snapshotDamage) recovery.push({ id: 'damaged-snapshot-' + error.snapshotDamage.snapshotId + '-' + generation,
          source: 'snapshots', recordId, snapshotId: error.snapshotDamage.snapshotId, raw: error.snapshotDamage.raw,
          copyRaw: error.snapshotDamage.copyRaw, error: error.message });
        const previous = await getAux('versions', recordId);
        for (const candidate of Array.isArray(previous) ? previous : []) {
          try {
            if (!candidate?.record || candidate.record.id !== recordId) continue;
            if (await digest(JSON.stringify(candidate.record)) !== candidate.digest) continue;
            const monitor = lazy ? candidate.record : await unpack(candidate.record, cache);
            monitors.push(monitor);
            recovery.push(...(monitor._storageRecovery || []).map((entry) => ({ ...entry, recordId }))); break;
          } catch { /* Try an earlier independently verified version. */ }
        }
      }
    }
    return { monitors, generation, recovery: [...new Map(recovery.map((entry) => [entry.id, entry])).values()] };
  }
  async function snapshotPatches(snapshots, generation) {
    const patches = [];
    for (const [id, value] of snapshots) {
      const prior = await getAux('snapshots', id);
      if (prior?.json !== value.json || prior?.digest !== value.digest) {
        if (prior !== undefined) patches.push(['recovery', 'repaired-snapshot-' + generation + '-' + id, {
          id: 'repaired-snapshot-' + generation + '-' + id, source: 'snapshot-repair', snapshotId: id,
          raw: prior, error: '스냅샷 저장값을 검증된 원문으로 수리하기 전에 보관했습니다.'
        }]);
        patches.push(['snapshots', id, value]);
      }
      const copy = await getAux('snapshotCopies', id);
      if (copy?.json !== value.json || copy?.digest !== value.digest) {
        if (copy !== undefined) patches.push(['recovery', 'repaired-copy-' + generation + '-' + id, {
          id: 'repaired-copy-' + generation + '-' + id, source: 'snapshot-copy-repair', snapshotId: id, raw: copy,
          error: '스냅샷 복구 사본을 수리하기 전에 보관했습니다.'
        }]);
        patches.push(['snapshotCopies', id, value]);
      }
    }
    return patches;
  }
  async function commit({ changed, deletedIds = [], deletedMonitors = [], recovery = [], generation, operation, settings }) {
    const snapshots = new Map(); const envelopes = []; const versionRecovery = [];
    for (const monitor of changed) {
      const record = await pack(monitor, snapshots);
      const prior = await getAux('monitors', monitor.id);
      const rawVersions = await getAux('versions', monitor.id);
      const versions = Array.isArray(rawVersions) ? rawVersions : [];
      if (rawVersions !== undefined && !Array.isArray(rawVersions)) versionRecovery.push({
        id: 'damaged-versions-' + generation + '-' + monitor.id, source: 'versions', recordId: monitor.id, raw: rawVersions,
        error: '이전 세대 컨테이너를 해석하지 못해 현재 정상 레코드와 원본을 보존했습니다.'
      });
      envelopes.push({ id: monitor.id, record, digest: await digest(JSON.stringify(record)), versions: prior ? [prior, ...versions].slice(0, 3) : versions });
    }
    const deleted = [];
    const deletedById = new Map(deletedMonitors.map((monitor) => [monitor.id, monitor]));
    for (const id of deletedIds) {
      let prior = await getAux('monitors', id);
      if (!prior && deletedById.has(id)) {
        const record = await pack(deletedById.get(id), snapshots);
        prior = { id, record, digest: await digest(JSON.stringify(record)) };
      }
      if (prior) deleted.push({ id: 'deleted-' + generation + '-' + id, source: 'trash', recordId: id, raw: prior, capturedAt: new Date().toISOString() });
    }
    const patches = await snapshotPatches(snapshots, generation);
    for (const entry of recovery) {
      if (entry.source !== 'snapshots' || entry.restoredFrom !== 'snapshotCopies' || !entry.snapshotId) continue;
      const copy = await getAux('snapshotCopies', entry.snapshotId);
      if (typeof copy?.json === 'string' && await digest(copy.json) === entry.snapshotId) patches.push(['snapshots', entry.snapshotId, copy]);
    }
    for (const envelope of envelopes) {
      const { versions, ...current } = envelope;
      patches.push(['monitors', envelope.id, current], ['versions', envelope.id, versions]);
    }
    for (const value of [...recovery, ...deleted, ...versionRecovery]) patches.push(['recovery', value.id, value]);
    patches.push(['meta', 'current', { generation, schemaVersion: 1, committedAt: new Date().toISOString() }]);
    if (settings !== undefined) patches.push(['meta', 'settings', settings]);
    if (operation) patches.push(['operations', operation.id, operation]);
    const db = await database();
    if (!db) {
      const patch = Object.fromEntries(patches.map(([store, key, value]) => [PREFIX + store + '.' + key, value]));
      // Fallback tombstones participate in the same atomic storage.set call.
      for (const id of deletedIds) patch[PREFIX + 'monitors.' + id] = { deleted: true, id };
      await chrome.storage.local.set(patch);
    } else {
      await writeTransaction(db, STORES, (tx) => {
        for (const [store, key, value] of patches) tx.objectStore(store).put(value, key);
        for (const id of deletedIds) tx.objectStore('monitors').delete(id);
      });
    }
  }
  root.OpenStillRecordStore = Object.freeze({ getAux, putAux, putAuxBatch, deleteAux, deleteAuxBatch, allAux, keysAux, load, commit, commitAux, stageMonitor, stageSnapshot, unpack, digest });
  if (typeof module === 'object' && module.exports) module.exports = root.OpenStillRecordStore;
})(typeof self !== 'undefined' ? self : globalThis);
