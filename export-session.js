'use strict';
async function startExportSession(message = {}) {
  if (message.resumeId) {
    const session = await OpenStillRecordStore.getAux('staging', 'export:' + message.resumeId);
    if (!session) return { ok: false, reason: 'missing', error: '보관된 내보내기 작업을 찾지 못했습니다.' };
    exportSessions.set(session.id, session); return { ok: true, id: session.id, total: session.records.length, progress: session.progress, resumed: true, ...session.audit };
  }
  // Hydrate one record at a time so broken blobs are repaired from verified
  // copies/versions, or isolated without blocking every healthy export.
  for (const monitor of await getMonitors()) await getMonitorById(monitor.id);
  await persistNormalizedMonitorRepairs();
  const operation = storageQueue.catch(() => undefined).then(async () => {
    const repository = await loadMonitorRepository(); const id = createId(); const records = []; const snapshotIds = new Set();
    const stage = (key, value) => OpenStillRecordStore.putAux('staging', key, value);
    const collectSnapshots = (monitor) => {
      for (const value of [monitor.snapshot, monitor.lastErrorSnapshot, monitor.lastChange?.previous, monitor.lastChange?.current, ...(monitor.history || []).map((entry) => entry.snapshot)]) if (value?.$snapshot) snapshotIds.add(value.$snapshot);
    };
    const envelopesById = new Map((await OpenStillRecordStore.allAux('monitors')).filter((entry) => entry && typeof entry === 'object' && !entry.deleted).map((entry) => [entry.id, entry]));
    for (const monitorId of repository.monitors.keys()) {
      const envelope = envelopesById.get(monitorId);
      if (!envelope?.record || await OpenStillRecordStore.digest(JSON.stringify(envelope.record)) !== envelope.digest) throw new Error('내보내기 원본과 정상 레코드의 수/지문이 일치하지 않습니다. 원본을 복구함에 보관하고 다시 시도해 주세요.');
      const key = 'export:' + id + ':monitor:' + envelope.id;
      const record = exportMonitorRecordForTransfer(envelope.record); collectSnapshots(record);
      records.push({ kind: 'monitor', key }); await stage(key, { kind: 'export-record', envelope: { ...envelope, record } });
    }
    let originalCount = 0; const exportedOriginalIds = new Set();
    for (const recoveryKey of await OpenStillRecordStore.keysAux('recovery')) {
      const recovery = await OpenStillRecordStore.getAux('recovery', recoveryKey); if (!recovery) continue;
      exportedOriginalIds.add(recovery.id);
      if (typeof Blob !== 'undefined' && recovery.raw instanceof Blob) {
        const chunkSize = 2 * 1024 * 1024; const chunkCount = Math.max(1, Math.ceil(recovery.raw.size / chunkSize));
        const key = 'export:' + id + ':file:' + recovery.id; await stage(key, { recovery });
        for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) records.push({ kind: 'file', key, chunkIndex, chunkCount, chunkSize });
        originalCount += 1;
      } else if (recovery.id === 'legacy-container' && Array.isArray(recovery.raw)) {
        for (let index = 0; index < recovery.raw.length; index += 1) {
          const key = 'export:' + id + ':original:' + index;
          records.push({ kind: 'raw', key }); await stage(key, { value: { _openStillRecovery: { ...recovery, id: recovery.id + ':' + index, raw: recovery.raw[index], recordIndex: index } } });
          originalCount += 1;
        }
      } else {
        const key = 'export:' + id + ':recovery:' + recovery.id;
        let raw = recovery.raw;
        if (raw?.record && raw?.digest) {
          try { raw = { ...raw, record: await OpenStillRecordStore.unpack(raw.record) }; } catch { /* Preserve the damaged envelope verbatim. */ }
        }
        records.push({ kind: 'raw', key }); await stage(key, { value: { _openStillRecovery: { ...recovery, raw } } }); originalCount += 1;
      }
    }
    for (const pendingKey of (await OpenStillRecordStore.keysAux('staging', { prefix: 'import:' })).filter((key) => /^import:[^:]+$/.test(key))) {
      const pending = await OpenStillRecordStore.getAux('staging', pendingKey);
      if (!pending || pending.kind !== 'import' || pending.phase === 'committed') continue;
      for (const sourceKey of await OpenStillRecordStore.keysAux('staging', { prefix: 'import-file:' + pending.id + ':' })) {
        if (exportedOriginalIds.has(sourceKey)) continue;
        const file = await OpenStillRecordStore.getAux('staging', sourceKey);
        if (!(file?.raw instanceof Blob)) continue;
        const recovery = { id: sourceKey, source: file.source, raw: file.raw, error: '중단되거나 복구 대기 중인 불러오기 원본' };
        const key = 'export:' + id + ':file:' + sourceKey;
        await stage(key, { recovery });
        const chunkSize = 2 * 1024 * 1024; const chunkCount = Math.max(1, Math.ceil(file.raw.size / chunkSize));
        for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) records.push({ kind: 'file', key, chunkIndex, chunkCount, chunkSize });
        exportedOriginalIds.add(sourceKey); originalCount += 1;
      }
      for (const file of Object.values(pending.recoveryFiles || {})) if (!file.completed) {
        for (const sourceKey of Object.values(file.keys)) {
          const piece = await OpenStillRecordStore.getAux('staging', sourceKey); if (!piece) continue;
          const key = 'export:' + id + ':pending-file:' + records.length;
          records.push({ kind: 'raw', key }); await stage(key, { value: { _openStillRecoveryFile: piece } }); originalCount += 1;
        }
      }
      for (const sourceKey of await preparedImportKeys(pending)) {
        const source = await OpenStillRecordStore.getAux('staging', sourceKey); if (!source?.monitor) continue;
        const key = 'export:' + id + ':pending:' + records.length;
        const monitor = exportMonitorRecordForTransfer(source.monitor); collectSnapshots(monitor);
        records.push({ kind: 'pending', key }); await stage(key, { monitor }); originalCount += 1;
      }
      for (const record of Object.values(pending.fragmentRecords || {})) {
        if (record.completed) continue;
        for (const sourceKey of Object.values(record.keys)) {
          const fragment = await OpenStillRecordStore.getAux('staging', sourceKey); if (!fragment) throw new Error('복구 대기 조각의 원본이 누락되었습니다.');
          const key = 'export:' + id + ':pending-fragment:' + records.length;
          records.push({ kind: 'raw', key }); await stage(key, { value: { _openStillImportFragment: { exportId: record.exportId, fragment } } }); originalCount += 1;
        }
      }
      for (const sourceKey of pending.pendingNativeIds || []) {
        const source = await OpenStillRecordStore.getAux('staging', sourceKey);
        if (!source?.raw) continue;
        const key = 'export:' + id + ':pending-native:' + records.length;
        records.push({ kind: 'raw', key }); await stage(key, { value: source.raw }); originalCount += 1;
      }
    }
    const snapshotRecords = [];
    for (const snapshotId of snapshotIds) {
      const primary = await OpenStillRecordStore.getAux('snapshots', snapshotId);
      const copy = primary?.json && await OpenStillRecordStore.digest(primary.json) === snapshotId ? primary : await OpenStillRecordStore.getAux('snapshotCopies', snapshotId);
      if (!copy?.json || await OpenStillRecordStore.digest(copy.json) !== snapshotId) throw new Error('정상 추적이 참조한 스냅샷을 검증하지 못했습니다. 원본을 복구함에서 수리한 뒤 다시 내보내 주세요.');
      const key = 'export:' + id + ':snapshot:' + snapshotId;
      snapshotRecords.push({ kind: 'snapshot', key }); await stage(key, { value: { _openStillSnapshot: { id: snapshotId, json: copy.json } } });
      if (primary !== copy) {
        const value = { id: 'export-damaged-snapshot:' + id + ':' + snapshotId, source: 'snapshots', snapshotId, raw: primary ?? null, error: '내보내기 검증 중 손상 원본을 보관하고 정상 사본을 회수했습니다.' };
        const rawKey = 'export:' + id + ':snapshot-original:' + snapshotId;
        records.push({ kind: 'raw', key: rawKey }); await stage(rawKey, { value: { _openStillRecovery: value } }); originalCount += 1;
        await OpenStillRecordStore.putAux('recovery', value.id, value);
      }
    }
    records.unshift(...snapshotRecords);
    const audit = { normalCount: repository.monitors.size, originalCount, snapshotCount: snapshotRecords.length, repairedCount: repository.diagnostics.repairedCount, generation: repository.generation };
    const settings = (await getState()).settings;
    const settingsKey = 'export:' + id + ':settings'; records.push({ kind: 'raw', key: settingsKey });
    await stage(settingsKey, { value: { _openStillSettings: { ...settings, ...(message.dashboardSort ? { dashboardSort: message.dashboardSort } : {}) }, _backupAudit: { ...audit, totalRecords: records.length } } });
    const session = { kind: 'export', id, records, audit, phase: 'ready', createdAt: nowIso() };
    await stage('export:' + id, session);
    exportSessions.set(id, session);
    return { ok: true, id, total: records.length, ...audit };
  });
  storageQueue = operation.then(() => undefined, () => undefined); return operation;
}
async function getExportSessionAndIndex(message) {
  const session = exportSessions.get(message.id) || await OpenStillRecordStore.getAux('staging', 'export:' + message.id);
  const index = Number(message.index);
  if (!session) return { error: { ok: false, reason: 'missing', error: '내보내기 작업을 찾지 못했습니다.' } };
  if (!Number.isSafeInteger(index) || index < 0 || index >= session.records.length) return { error: { ok: false, error: '내보낼 레코드를 찾지 못했습니다.' } };
  exportSessions.set(session.id, session); return { session, index };
}
async function serializedSessionRecord(session, index) {
  const descriptor = session.records[index];
  if (descriptor.kind === 'file') {
    const { recovery } = await OpenStillRecordStore.getAux('staging', descriptor.key);
    const bytes = new Uint8Array(await recovery.raw.slice(descriptor.chunkIndex * descriptor.chunkSize, (descriptor.chunkIndex + 1) * descriptor.chunkSize).arrayBuffer());
    let binary = ''; for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
    return JSON.stringify({ _openStillRecoveryFile: { id: recovery.id, name: recovery.source, error: recovery.error, chunkIndex: descriptor.chunkIndex, chunkCount: descriptor.chunkCount, base64: btoa(binary) } });
  }
  const staged = await OpenStillRecordStore.getAux('staging', descriptor.key);
  if (!staged) throw new Error('내보내기 staging 레코드가 누락되었습니다.');
  if (descriptor.kind === 'monitor') {
    return JSON.stringify({ _openStillMonitorRecord: staged.envelope.record });
  }
  if (descriptor.kind === 'pending') return JSON.stringify({ _openStillMonitorRecord: staged.monitor });
  return JSON.stringify(staged.value);
}
async function getExportMonitor(message) {
  const target = await getExportSessionAndIndex(message); if (target.error) return target.error;
  const record = await serializedSessionRecord(target.session, target.index);
  if (utf8ByteLength(record) < MAX_EXPORT_DIRECT_RECORD_BYTES) return { ok: true, record };
  // Cache only the current oversized record on disk, never an entire export.
  await OpenStillRecordStore.putAux('staging', 'export-string:' + message.id + ':' + target.index, { json: record });
  return { ok: true, fragmented: true, recordId: message.id + ':' + target.index, fragmentCount: Math.ceil(record.length / EXPORT_RECORD_FRAGMENT_CHARS) };
}
async function getExportMonitorFragment(message) {
  const target = await getExportSessionAndIndex(message); if (target.error) return target.error;
  const staged = await OpenStillRecordStore.getAux('staging', 'export-string:' + message.id + ':' + target.index);
  const record = staged?.json || await serializedSessionRecord(target.session, target.index);
  const index = Number(message.fragmentIndex); const fragmentCount = Math.ceil(record.length / EXPORT_RECORD_FRAGMENT_CHARS);
  if (!Number.isSafeInteger(index) || index < 0 || index >= fragmentCount) return { ok: false, error: '조각 번호가 올바르지 않습니다.' };
  return { ok: true, payload: record.slice(index * EXPORT_RECORD_FRAGMENT_CHARS, (index + 1) * EXPORT_RECORD_FRAGMENT_CHARS), fragmentIndex: index, fragmentCount };
}
async function finishExportSession(message) {
  const session = exportSessions.get(message.id) || await OpenStillRecordStore.getAux('staging', 'export:' + message.id);
  if (session) { session.phase = message.completed === true ? 'completed' : 'paused'; await OpenStillRecordStore.putAux('staging', 'export:' + message.id, session); }
  if (session && message.completed === true) {
    const keys = [...await OpenStillRecordStore.keysAux('staging', { prefix: 'export:' + message.id + ':' }),
      ...await OpenStillRecordStore.keysAux('staging', { prefix: 'export-string:' + message.id + ':' })];
    await OpenStillRecordStore.deleteAuxBatch('staging', keys);
  }
  exportSessions.delete(message.id); return { ok: true };
}
async function touchExportSession(message) {
  const session = exportSessions.get(message.id) || await OpenStillRecordStore.getAux('staging', 'export:' + message.id);
  return session ? { ok: true, phase: session.phase } : { ok: false, reason: 'missing' };
}
async function checkpointExportSession(message) {
  const session = exportSessions.get(message.id) || await OpenStillRecordStore.getAux('staging', 'export:' + message.id);
  if (!session) return { ok: false, reason: 'missing' };
  const progress = message.progress;
  if (!progress || !Number.isSafeInteger(progress.nextIndex) || progress.nextIndex < 0 || progress.nextIndex > session.records.length
    || !Number.isSafeInteger(progress.partNumber) || progress.partNumber < 1 || !Array.isArray(progress.manifest)) return { ok: false, error: '내보내기 처리 위치가 올바르지 않습니다.' };
  session.progress = progress; session.phase = progress.done ? 'completed' : 'running';
  await OpenStillRecordStore.putAux('staging', 'export:' + session.id, session); exportSessions.set(session.id, session);
  return { ok: true };
}
