'use strict';

function collectMonitorSnapshotIds(monitor, ids) {
  const snapshots = [monitor.snapshot, monitor.lastErrorSnapshot, monitor.lastChange?.previous, monitor.lastChange?.current];
  for (const snapshot of snapshots) if (snapshot?.$snapshot) ids.add(snapshot.$snapshot);
  if (Array.isArray(monitor.history)) {
    for (const entry of monitor.history) if (entry?.snapshot?.$snapshot) ids.add(entry.snapshot.$snapshot);
  }
}

function collectRecoverySnapshotIds(raw, ids) {
  const remaining = [raw];
  const seen = new WeakSet();
  while (remaining.length) {
    const value = remaining.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) remaining.push(entry);
    } else if (value.record && typeof value.record === 'object' && !Array.isArray(value.record)) {
      collectMonitorSnapshotIds(value.record, ids);
      remaining.push(value.versions);
    } else if (value.kind === 'import-record' && value.monitor) {
      collectMonitorSnapshotIds(value.monitor, ids);
    } else if (value._openStillMonitorRecord) {
      collectMonitorSnapshotIds(value._openStillMonitorRecord, ids);
    } else if (value.kind === 'pending-native' || value._openStillRecovery) {
      remaining.push(value.raw, value._openStillRecovery?.raw);
    } else if (value.url || value.uri) {
      collectMonitorSnapshotIds(value, ids);
    } else {
      for (const key of ['monitors', 'records', 'sieves', 'sieve_backup', 'versions']) {
        if (Array.isArray(value[key])) remaining.push(value[key]);
      }
    }
  }
}
async function startExportSession(message = {}, cloud) {
  const resumeId = cloud?.id || message.resumeId;
  if (resumeId) {
    const session = await OpenStillRecordStore.getAux('staging', 'export:' + resumeId);
    if (session && (session.target === 'koofr') === Boolean(cloud)) {
      exportSessions.set(session.id, session);
      return { ok: true, id: session.id, total: session.records.length, progress: session.progress, resumed: true, ...session.audit };
    }
    if (!cloud || session) return { ok: false, reason: 'missing', error: '보관된 내보내기 작업을 찾지 못했습니다.' };
  }
  // Hydrate one record at a time so broken blobs are repaired from verified
  // copies/versions, or isolated without blocking every healthy export.
  for (const monitor of await getMonitors()) await getMonitorById(monitor.id);
  await persistNormalizedMonitorRepairs();
  const operation = storageQueue.catch(() => undefined).then(async () => {
    const repository = await loadMonitorRepository(); const id = cloud?.id || createId(); const records = []; const snapshotIds = new Set();
    const stage = (key, value) => OpenStillRecordStore.putAux('staging', key, value);
    const recoverySnapshotIds = new Set();
    const envelopesById = new Map((await OpenStillRecordStore.allAux('monitors')).filter((entry) => entry && typeof entry === 'object' && !entry.deleted).map((entry) => [entry.id, entry]));
    for (const monitorId of repository.monitors.keys()) {
      const envelope = envelopesById.get(monitorId);
      if (!envelope?.record || await OpenStillRecordStore.digest(JSON.stringify(envelope.record)) !== envelope.digest) throw new Error('내보내기 원본과 정상 레코드의 수/지문이 일치하지 않습니다. 원본을 복구함에 보관하고 다시 시도해 주세요.');
      const key = 'export:' + id + ':monitor:' + envelope.id;
      const record = exportMonitorRecordForTransfer(envelope.record); collectMonitorSnapshotIds(record, snapshotIds);
      records.push({ kind: 'monitor', key }); await stage(key, { kind: 'export-record', envelope: { ...envelope, record } });
    }
    let originalCount = 0; const exportedOriginalIds = new Set();
    for (const recoveryKey of await OpenStillRecordStore.keysAux('recovery')) {
      const recovery = await OpenStillRecordStore.getAux('recovery', recoveryKey); if (!recovery) continue;
      exportedOriginalIds.add(recoveryKey);
      const sourceOriginalId = recovery.sourceOriginalId || recovery.id;
      if (typeof Blob !== 'undefined' && recovery.raw instanceof Blob) {
        const chunkSize = 2 * 1024 * 1024; const chunkCount = Math.max(1, Math.ceil(recovery.raw.size / chunkSize));
        const key = 'export:' + id + ':file:' + recoveryKey; await stage(key, { recovery: { ...recovery, id: recoveryKey, sourceOriginalId } });
        for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) records.push({ kind: 'file', key, chunkIndex, chunkCount, chunkSize });
        originalCount += 1;
      } else if (sourceOriginalId === 'legacy-container' && Array.isArray(recovery.raw)) {
        const { contentDigest, raw, ...metadata } = recovery;
        for (let index = 0; index < recovery.raw.length; index += 1) {
          const key = 'export:' + id + ':original:' + recoveryKey + ':' + index;
          collectRecoverySnapshotIds(raw[index], recoverySnapshotIds);
          records.push({ kind: 'raw', key }); await stage(key, { value: { _openStillRecovery: {
            ...metadata, id: recoveryKey + ':' + index, sourceOriginalId: sourceOriginalId + ':' + index, raw: raw[index], recordIndex: index
          } } });
          originalCount += 1;
        }
      } else {
        const key = 'export:' + id + ':recovery:' + recoveryKey;
        collectRecoverySnapshotIds(recovery.raw, recoverySnapshotIds);
        records.push({ kind: 'raw', key }); await stage(key, { value: { _openStillRecovery: { ...recovery, id: recoveryKey, sourceOriginalId } } }); originalCount += 1;
      }
    }
    for (const pendingKey of (await OpenStillRecordStore.keysAux('staging', { prefix: 'import:' })).filter((key) => /^import:[^:]+$/.test(key))) {
      const pending = await OpenStillRecordStore.getAux('staging', pendingKey);
      if (!pending || pending.kind !== 'import' || pending.phase === 'committed') continue;
      for (const sourceKey of await OpenStillRecordStore.keysAux('staging', { prefix: 'import-file:' + pending.id + ':' })) {
        if (exportedOriginalIds.has(sourceKey)) continue;
        const file = await OpenStillRecordStore.getAux('staging', sourceKey);
        if (!(file?.raw instanceof Blob) || exportedOriginalIds.has(file.recoveryId)) continue;
        const recovery = { id: sourceKey, sourceOriginalId: 'import-file:' + (file.source || ''), source: file.source, raw: file.raw, error: '중단되거나 복구 대기 중인 불러오기 원본' };
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
        const monitor = exportMonitorRecordForTransfer(source.monitor); collectMonitorSnapshotIds(monitor, recoverySnapshotIds);
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
        collectRecoverySnapshotIds(source, recoverySnapshotIds);
        const key = 'export:' + id + ':pending-native:' + records.length;
        records.push({ kind: 'raw', key }); await stage(key, { value: source.raw }); originalCount += 1;
      }
    }
    const snapshotRecords = [];
    for (const snapshotId of new Set([...snapshotIds, ...recoverySnapshotIds])) {
      const required = snapshotIds.has(snapshotId);
      if (typeof snapshotId !== 'string' || !/^[a-f0-9]{64}$/.test(snapshotId)) {
        if (required) throw new Error('정상 추적이 참조한 스냅샷의 식별 정보가 올바르지 않습니다.');
        continue;
      }
      const primary = await OpenStillRecordStore.getAux('snapshots', snapshotId);
      const primaryValid = typeof primary?.json === 'string' && await OpenStillRecordStore.digest(primary.json) === snapshotId;
      const copy = primaryValid ? primary : await OpenStillRecordStore.getAux('snapshotCopies', snapshotId);
      const verified = primaryValid || (typeof copy?.json === 'string' && await OpenStillRecordStore.digest(copy.json) === snapshotId);
      if (!verified && required) throw new Error('정상 추적이 참조한 스냅샷을 검증하지 못했습니다. 원본을 복구함에서 수리한 뒤 다시 내보내 주세요.');
      if (verified) {
        const key = 'export:' + id + ':snapshot:' + snapshotId;
        snapshotRecords.push({ kind: 'snapshot', key }); await stage(key, { value: { _openStillSnapshot: { id: snapshotId, json: copy.json } } });
      }
      if (!primaryValid) {
        const value = { id: 'export-damaged-snapshot:' + snapshotId, source: 'snapshots', snapshotId, raw: primary ?? null,
          ...(verified ? {} : { copyRaw: copy ?? null }),
          error: verified ? '내보내기 검증 중 손상 원본을 보관하고 정상 사본을 회수했습니다.' : '복구 원본이 참조한 스냅샷이 누락되었거나 지문이 일치하지 않습니다.' };
        const recoveryKey = await OpenStillRecordStore.putRecovery(value);
        if (!exportedOriginalIds.has(recoveryKey)) {
          const rawKey = 'export:' + id + ':snapshot-original:' + snapshotId;
          const recovery = await OpenStillRecordStore.getAux('recovery', recoveryKey);
          records.push({ kind: 'raw', key: rawKey }); await stage(rawKey, { value: { _openStillRecovery: recovery } }); originalCount += 1;
        }
      }
    }
    records.unshift(...snapshotRecords);
    const audit = { normalCount: repository.monitors.size, originalCount, snapshotCount: snapshotRecords.length, repairedCount: repository.diagnostics.repairedCount, generation: repository.generation };
    const settings = normalizeSettings({ ...(await getState()).settings, ...(message.dashboardSort && { dashboardSort: message.dashboardSort }) });
    const settingsKey = 'export:' + id + ':settings'; records.push({ kind: 'raw', key: settingsKey });
    await stage(settingsKey, { value: { _openStillSettings: settings, _backupAudit: { ...audit, totalRecords: records.length } } });
    const createdAt = nowIso();
    const progress = cloud ? { exportId: createId(), exportedAt: createdAt } : undefined;
    const session = { kind: 'export', id, records, audit, phase: 'ready', createdAt, ...(cloud && { target: 'koofr', progress }) };
    await stage('export:' + id, session);
    exportSessions.set(id, session);
    return { ok: true, id, total: records.length, ...(progress && { progress }), ...audit };
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
    const { raw, ...metadata } = recovery;
    return JSON.stringify({ _openStillRecoveryFile: { id: recovery.id, metadata, name: raw.name || recovery.source,
      type: raw.type, lastModified: raw.lastModified, error: recovery.error, chunkIndex: descriptor.chunkIndex,
      chunkCount: descriptor.chunkCount, base64: btoa(binary) } });
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
  if (message.completed === true) {
    const keys = [...await OpenStillRecordStore.keysAux('staging', { prefix: 'export:' + message.id + ':' }),
      ...await OpenStillRecordStore.keysAux('staging', { prefix: 'export-string:' + message.id + ':' })];
    await OpenStillRecordStore.deleteAuxBatch('staging', keys);
  }
  exportSessions.delete(message.id); return { ok: true };
}
async function localExportRequest(id, action) {
  const session = id && (exportSessions.get(id) || await OpenStillRecordStore.getAux('staging', 'export:' + id));
  if (session?.target === 'koofr') return { ok: false, error: 'Koofr 작업은 Koofr 설정에서 관리해 주세요.' };
  return action();
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
