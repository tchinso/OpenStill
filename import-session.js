'use strict';
const importSessionQueues = new Map();
function serializeImportSession(message, action) {
  const key = message?.id || '';
  const previous = importSessionQueues.get(key) || Promise.resolve();
  const work = previous.catch(() => undefined).then(() => action(message));
  importSessionQueues.set(key, work);
  work.finally(() => { if (importSessionQueues.get(key) === work) importSessionQueues.delete(key); }).catch(() => undefined);
  return work;
}

async function persistImportSession(session) {
  session.updatedAt = nowIso();
  await OpenStillRecordStore.putAux('staging', 'import:' + session.id, session);
  importSessions.set(session.id, session);
}
async function loadImportSession(id) {
  return importSessions.get(id) || await OpenStillRecordStore.getAux('staging', 'import:' + id);
}
async function startImportSession(message = {}) {
  if (message.resumeId) {
    const session = await loadImportSession(message.resumeId);
    if (!session) return { ok: false, reason: 'missing', error: '보관된 불러오기 작업을 찾지 못했습니다.' };
    importSessions.set(session.id, session);
    return { ok: true, id: session.id, resumed: true, processed: session.sourceCount };
  }
  const session = { kind: 'import', id: createId(), mode: message.mode === 'replace' ? 'replace' : 'merge',
    sourceCount: 0, preparedCount: 0, fragmentRecords: {}, diagnostics: [], sourceFiles: [], rejected: 0,
    repaired: 0, disabledForPermission: 0, duplicates: 0, revision: 0, phase: 'staging', settings: null, explicitEmpty: message.explicitEmpty === true };
  await persistImportSession(session);
  return { ok: true, id: session.id };
}
async function preserveImportRaw(session, raw, source, error, extra = {}) {
  const id = 'import:' + session.id + ':' + session.diagnostics.length;
  const diagnostic = { id, source, error, ...extra, capturedAt: nowIso() };
  await OpenStillRecordStore.putAux('recovery', id, { ...diagnostic, raw });
  session.diagnostics.push(diagnostic);
  return diagnostic;
}
async function importContentDigest(monitor) {
  const record = { ...await OpenStillRecordStore.unpack(monitor) };
  for (const key of ['id', 'revision', 'updatedAt', 'nextCheckAt', 'importDigest', 'importSourceId', '_storageRecovery']) delete record[key];
  return OpenStillRecordStore.digest(JSON.stringify(record));
}
async function prepareImportSessionMonitor(session, raw, source = {}) {
  const summary = { prepared: 0, rejected: 0, repaired: 0, disabledForPermission: 0, duplicates: 0 };
  if (raw?._openStillSnapshot) {
    const snapshot = raw._openStillSnapshot;
    try { await OpenStillRecordStore.stageSnapshot(snapshot); }
    catch (error) {
      if (!error.snapshotValidation) throw error;
      session.rejected += 1; summary.rejected = 1;
      await preserveImportRaw(session, raw, source.fileName || 'snapshot', error.message); return summary;
    }
    return summary;
  }
  if (raw?._openStillMonitorRecord) {
    try { raw = await OpenStillRecordStore.unpack(raw._openStillMonitorRecord); }
    catch (error) {
      const key = 'pending-native:' + session.id + ':' + await OpenStillRecordStore.digest(JSON.stringify(raw));
      const prior = await OpenStillRecordStore.getAux('staging', key);
      if (!prior) {
        await OpenStillRecordStore.putAux('staging', key, { kind: 'pending-native', raw, source });
        session.pendingNativeIds ||= []; session.pendingNativeIds.push(key); session.rejected += 1;
        session.diagnostics.push({ source: source.fileName || 'native-record', recordId: raw._openStillMonitorRecord.id, staging: key, error: '참조한 스냅샷이 누락되거나 손상되어 복구 대기에 보관했습니다.' });
      }
      summary.rejected = 1; return summary;
    }
  }
  if (raw?._openStillImportFragment) {
    await appendImportFragmentsUnlocked({ id: session.id, exportId: raw._openStillImportFragment.exportId, fragments: [raw._openStillImportFragment.fragment] });
    return summary;
  }
  if (raw?._openStillSettings) { session.settings = raw._openStillSettings; return summary; }
  if (raw?._openStillRecovery) {
    const entry = raw._openStillRecovery;
    await OpenStillRecordStore.putAux('recovery', entry.id || createId(), entry);
    return summary;
  }
  if (raw?._openStillRecoveryFile) {
    const piece = raw._openStillRecoveryFile;
    if (typeof piece.id !== 'string' || !Number.isSafeInteger(piece.chunkCount) || piece.chunkCount < 1 || piece.chunkCount > 100000
      || !Number.isSafeInteger(piece.chunkIndex) || piece.chunkIndex < 0 || piece.chunkIndex >= piece.chunkCount || typeof piece.base64 !== 'string') {
      session.rejected += 1; summary.rejected = 1; await preserveImportRaw(session, raw, source.fileName || 'recovery-file', '원문 파일 조각의 식별 정보가 잘못되었습니다.'); return summary;
    }
    const fileKey = 'recovery-file:' + session.id + ':' + piece.id;
    session.recoveryFiles ||= {};
    const file = session.recoveryFiles[fileKey] ||= { id: piece.id, name: piece.name, chunkCount: piece.chunkCount, keys: {}, completed: false };
    const key = fileKey + ':' + piece.chunkIndex;
    const prior = await OpenStillRecordStore.getAux('staging', key);
    if (file.chunkCount !== piece.chunkCount || (prior && prior.base64 !== piece.base64)) {
      session.rejected += 1; summary.rejected = 1; await preserveImportRaw(session, raw, piece.name, '같은 원문 파일 조각의 내용이 충돌하여 두 원본을 보관했습니다.'); return summary;
    }
    await OpenStillRecordStore.putAux('staging', key, piece); file.keys[piece.chunkIndex] = key;
    if (!file.completed && Object.keys(file.keys).length === piece.chunkCount) {
      const blobs = [];
      for (let index = 0; index < piece.chunkCount; index += 1) {
        const part = await OpenStillRecordStore.getAux('staging', file.keys[index]);
        if (!part) return summary;
        blobs.push(Uint8Array.from(atob(part.base64), (character) => character.charCodeAt(0)));
      }
      await OpenStillRecordStore.putAux('recovery', piece.id, { id: piece.id, source: piece.name, error: piece.error, raw: new Blob(blobs) });
      file.completed = true;
    }
    return summary;
  }
  session.sourceCount += 1;
  let monitor;
  try { monitor = normalizeMonitor(raw); } catch { monitor = null; }
  if (!monitor) {
    session.rejected += 1; summary.rejected = 1;
    await preserveImportRaw(session, raw, source.fileName || 'import-record', '레코드를 해석하지 못했습니다.', { recordIndex: source.recordIndex });
    return summary;
  }
  try { await validateLocatorList(monitor.locators); }
  catch (error) {
    monitor.enabled = false;
    monitor.recoveryIssues = [...(monitor.recoveryIssues || []), responseError(error)];
  }
  if (monitor.recoveryIssues?.length || monitor.recoveryRepairs?.length || monitor.snapshot?.existsInferred) {
    summary.repaired = 1; session.repaired += 1;
    await preserveImportRaw(session, raw, source.fileName || 'import-repair', '안전한 필드 수리 후 원본을 보관했습니다.', { recordId: monitor.id, fields: [...(monitor.recoveryRepairs || []), ...(monitor.recoveryIssues || [])] });
  }
  if (!monitor.snapshot && monitor.status === 'ok') monitor.status = 'needs-baseline';
  if (monitor.enabled && !await hasSitePermission(monitor.url)) {
    monitor.enabled = false; monitor.status = 'permission-needed';
    monitor.lastError = '가져온 추적에는 사이트 접근 권한이 필요합니다.';
    session.disabledForPermission += 1; summary.disabledForPermission = 1;
  }
  const digest = await importContentDigest(monitor);
  const key = 'record:' + session.id + ':' + monitor.id + ':' + digest;
  const markerKey = 'prepared-marker:' + session.id + ':' + monitor.id + ':' + digest;
  const prior = await OpenStillRecordStore.getAux('staging', markerKey);
  if (prior) {
    session.preparedCount = Math.max(session.preparedCount || 0, prior.index + 1);
    session.duplicates += 1; summary.duplicates = 1; return summary;
  }
  // Each record is staged independently; a response loss replays this same key.
  const index = session.preparedCount || 0;
  const packedMonitor = await OpenStillRecordStore.stageMonitor(monitor);
  await OpenStillRecordStore.putAuxBatch('staging', [[key, { kind: 'import-record', monitor: packedMonitor, digest, source }],
    ['prepared-index:' + session.id + ':' + index, { kind: 'prepared-index', key, index }], [markerKey, { kind: 'prepared-marker', key, index }]]);
  session.preparedCount = index + 1; summary.prepared = 1;
  return summary;
}
async function appendImportSessionUnlocked(message) {
  const session = await loadImportSession(message?.id);
  if (!session) return { ok: false, reason: 'missing', error: '불러오기 작업을 찾지 못했습니다.' };
  const summary = { prepared: 0, rejected: 0, repaired: 0, disabledForPermission: 0, duplicates: 0 };
  session.revision = (session.revision || 0) + 1;
  if (message.diagnostic) {
    const { raw, ...diagnostic } = message.diagnostic;
    if (raw !== undefined) await preserveImportRaw(session, raw, diagnostic.source || 'import-file', diagnostic.error, diagnostic);
    else session.diagnostics.push(diagnostic);
  }
  for (const raw of Array.isArray(message.monitors) ? message.monitors : []) {
    const result = await prepareImportSessionMonitor(session, raw, message.source || {});
    for (const key of Object.keys(summary)) summary[key] += result[key] || 0;
  }
  await persistImportSession(session);
  return { ok: true, ...summary };
}
function normalizedImportFragment(raw) {
  return raw && typeof raw.recordId === 'string' && raw.recordId && Number.isSafeInteger(raw.fragmentIndex) && raw.fragmentIndex >= 0
    && Number.isSafeInteger(raw.fragmentCount) && raw.fragmentCount > 0 && raw.fragmentCount <= 100_000
    && raw.fragmentIndex < raw.fragmentCount && typeof raw.payload === 'string' ? raw : null;
}
async function appendImportFragmentsUnlocked(message) {
  const session = await loadImportSession(message.id);
  if (!session) return { ok: false, reason: 'missing', error: '불러오기 작업을 찾지 못했습니다.' };
  let received = 0; let rejected = 0;
  session.revision = (session.revision || 0) + 1;
  for (const raw of message.fragments || []) {
    const fragment = normalizedImportFragment(raw);
    if (!fragment) { rejected += 1; session.rejected += 1; await preserveImportRaw(session, raw, 'fragment', '조각 메타데이터가 손상되었습니다.'); continue; }
    const group = (message.exportId || 'legacy') + ':' + fragment.recordId;
    let record = session.fragmentRecords[group];
    if (!record) record = session.fragmentRecords[group] = { fragmentCount: fragment.fragmentCount, keys: {}, invalid: false, completed: false, exportId: message.exportId || null };
    const key = 'fragment:' + session.id + ':' + group + ':' + fragment.fragmentIndex;
    const prior = await OpenStillRecordStore.getAux('staging', key);
    if (record.fragmentCount !== fragment.fragmentCount || prior && prior.payload !== fragment.payload) {
      record.invalid = true; await preserveImportRaw(session, raw, 'fragment-conflict', '같은 조각 번호의 내용 또는 전체 개수가 충돌합니다.'); continue;
    }
    await OpenStillRecordStore.putAux('staging', key, { kind: 'import-fragment', ...fragment });
    record.keys[fragment.fragmentIndex] = key; received += 1;
  }
  await persistImportSession(session);
  return { ok: true, received, rejected };
}
async function touchImportSession(message) {
  const session = await loadImportSession(message.id);
  return session ? { ok: true, phase: session.phase, processed: session.sourceCount } : { ok: false, reason: 'missing' };
}
async function prepareFragmentedImportRecords(session) {
  for (const [recordId, record] of Object.entries(session.fragmentRecords)) {
    if (record.completed) continue;
    const missing = Array.from({ length: record.fragmentCount }, (_, index) => index).filter((index) => !record.keys[index]);
    if (record.invalid || missing.length) {
      if (!record.reported) {
        session.rejected += 1; record.reported = true;
        session.diagnostics.push({ source: 'fragments', recordId, error: record.invalid ? '조각 충돌' : '불완전 조각', missing, staging: record.keys });
      }
      continue;
    }
    let payload = ''; let bytes = 0;
    for (let index = 0; index < record.fragmentCount; index += 1) {
      const piece = (await OpenStillRecordStore.getAux('staging', record.keys[index]))?.payload;
      if (typeof piece !== 'string') { record.invalid = true; break; }
      bytes += utf8ByteLength(piece);
      if (bytes > 64 * 1024 * 1024) {
        record.invalid = true; session.diagnostics.push({ source: 'fragments', recordId, staging: record.keys, error: '조각 조립의 64 MiB 바이트 예산을 넘어 원본 조각을 보관했습니다.' }); break;
      }
      payload += piece;
    }
    if (record.invalid) { if (!record.reported) { record.reported = true; session.rejected += 1; } continue; }
    try {
      await prepareImportSessionMonitor(session, JSON.parse(payload), { recordId }); record.completed = true;
      if (record.reported) { session.rejected = Math.max(0, session.rejected - 1); session.diagnostics = session.diagnostics.filter((item) => item.recordId !== recordId || item.source !== 'fragments'); }
    }
    catch (error) { session.rejected += 1; await preserveImportRaw(session, payload, 'fragment-json', responseError(error), { recordId }); record.completed = true; }
    await persistImportSession(session);
  }
}
async function finishImportSessionUnlocked(message) {
  const session = await loadImportSession(message.id);
  if (!session) return { ok: false, reason: 'missing', error: '보관된 불러오기 작업을 찾지 못했습니다.' };
  if (message.retry === true && session.phase !== 'committed') { session.revision = (session.revision || 0) + 1; await persistImportSession(session); }
  const receiptKey = 'import:' + message.id + ':' + (session.revision || 0);
  const receipt = await OpenStillRecordStore.getAux('operations', receiptKey);
  if (receipt?.committed) return { ...receipt.result, ok: true, committed: true, replayed: true };
  await prepareFragmentedImportRecords(session);
  session.diagnostics = session.diagnostics.filter((entry) => entry.code !== 'recovery-file-missing');
  let missingFiles = 0;
  for (const [key, file] of Object.entries(session.recoveryFiles || {})) if (!file.completed) {
    missingFiles += 1;
    session.diagnostics.push({ code: 'recovery-file-missing', source: file.name, staging: key,
      error: '원문 파일의 일부 조각이 누락되어 준비 영역에 보관했습니다.',
      missing: Array.from({ length: file.chunkCount }, (_, index) => index).filter((index) => !file.keys[index]) });
  }
  for (const key of [...(session.pendingNativeIds || [])]) {
    const pending = await OpenStillRecordStore.getAux('staging', key);
    if (!pending) continue;
    try {
      const restored = await OpenStillRecordStore.unpack(pending.raw._openStillMonitorRecord);
      await prepareImportSessionMonitor(session, restored, pending.source);
      session.pendingNativeIds = session.pendingNativeIds.filter((value) => value !== key);
      session.rejected = Math.max(0, session.rejected - 1); session.diagnostics = session.diagnostics.filter((item) => item.staging !== key);
    } catch { /* The original record and available immutable blobs remain staged. */ }
  }
  const preparedKeys = await preparedImportKeys(session);
  if (session.mode === 'replace' && !preparedKeys.length && !session.explicitEmpty) {
    return { ok: false, reason: 'empty-recovery', error: '복원 가능한 추적이 없어 기존 자료를 유지했습니다.', recoveryPending: session.rejected, diagnostics: session.diagnostics };
  }
  const prepared = [];
  for (const key of preparedKeys) { const value = await OpenStillRecordStore.getAux('staging', key); if (value) prepared.push({ ...value, key }); }
  const replace = session.mode === 'replace' && !session.rejected && !session.diagnostics.length;
  const beforeImport = replace ? await getMonitors() : [];
  session.phase = 'committing'; await persistImportSession(session);
  const result = await mutateMonitors(async (monitors) => {
    if (replace) monitors.splice(0, monitors.length);
    const byId = new Map(monitors.map((monitor) => [monitor.id, monitor]));
    let imported = 0; let duplicates = session.duplicates; let conflicts = 0; let capacityRejected = 0;
    session.pendingCapacityIds = [];
    for (const entry of prepared) {
      let monitor = { ...entry.monitor };
      const existing = byId.get(monitor.id);
      if (existing) {
        if (await importContentDigest(existing) === entry.digest) { duplicates += 1; continue; }
        const sourceId = monitor.id;
        monitor.id = sourceId.slice(0, 70) + '~' + entry.digest.slice(0, 20);
        const conflict = byId.get(monitor.id);
        if (conflict && await importContentDigest(conflict) === entry.digest) { duplicates += 1; continue; }
        if (conflict) monitor.id = createId();
        monitor.importSourceId = sourceId; monitor.revision = createRevision(); conflicts += 1;
      }
      if (monitors.length >= MAX_MONITORS) {
        capacityRejected += 1;
        session.pendingCapacityIds.push({ id: monitor.id, key: entry.key });
        continue;
      }
      monitors.push(monitor); byId.set(monitor.id, monitor); imported += 1;
    }
    return { ok: true, imported, rejected: session.rejected + capacityRejected + missingFiles, recoveryPending: session.rejected + capacityRejected + missingFiles,
      capacityRejected, repaired: session.repaired, duplicates, conflicts, disabledForPermission: session.disabledForPermission,
      diagnostics: [...session.diagnostics, ...session.pendingCapacityIds.map((entry) => ({ source: 'capacity', recordId: entry.id, staging: entry.key, error: '등록 상한에 도달하여 원본을 준비 영역에 보관했습니다.' }))], settings: session.settings, operationId: receiptKey };
  }, { operationId: receiptKey, type: 'finish-import-session', settings: session.settings ? normalizeSettings(session.settings) : undefined });
  session.phase = result.recoveryPending ? 'partial' : 'committed'; session.result = result; session.mode = 'merge'; await persistImportSession(session).catch(() => undefined);
  const finalization = await finalizeImportedMonitors(beforeImport);
  return { ...result, committed: true, finalizationWarnings: finalization.warnings };
}
async function abortImportSessionUnlocked(message) {
  const session = await loadImportSession(message.id);
  if (!session) return { ok: true };
  for (const fileKey of await OpenStillRecordStore.keysAux('staging', { prefix: 'import-file:' + session.id + ':' })) {
    const file = await OpenStillRecordStore.getAux('staging', fileKey); if (!file) continue;
    await OpenStillRecordStore.putAux('recovery', file.id, { id: file.id, source: file.source, raw: file.raw, error: '불러오기 중단 원본', capturedAt: nowIso() });
  }
  if (message.discard === true) {
    // Explicit discard removes staging, while recovery originals stay available.
    const originals = [];
    for (const key of await preparedImportKeys(session)) originals.push([key, 'discarded-prepared']);
    for (const record of Object.values(session.fragmentRecords)) for (const key of Object.values(record.keys)) originals.push([key, 'discarded-fragment']);
    for (const file of Object.values(session.recoveryFiles || {})) for (const key of Object.values(file.keys)) originals.push([key, 'discarded-file-piece']);
    for (const key of session.pendingNativeIds || []) originals.push([key, 'discarded-native']);
    for (const [key, source] of originals) {
      const raw = await OpenStillRecordStore.getAux('staging', key); if (!raw) continue;
      await OpenStillRecordStore.putAux('recovery', 'discard:' + key, { id: 'discard:' + key, source, raw, error: '준비 작업을 폐기하고 원본을 보관했습니다.', capturedAt: nowIso() });
      await OpenStillRecordStore.deleteAux('staging', key);
    }
    await OpenStillRecordStore.deleteAux('staging', 'import:' + session.id); importSessions.delete(session.id);
  } else {
    session.phase = 'paused'; await persistImportSession(session);
  }
  return { ok: true, paused: message.discard !== true, id: session.id };
}
async function importMonitors(message) {
  const started = await startImportSession({ mode: message.mode, explicitEmpty: message.explicitEmpty === true });
  await appendImportSession({ id: started.id, monitors: message.monitors });
  return finishImportSession({ id: started.id });
}
async function preparedImportKeys(session) {
  if (Array.isArray(session.preparedIds)) return session.preparedIds;
  const keys = [];
  // Scan contiguous durable index entries as well as the checkpoint. This
  // recovers the final acknowledged record if termination preceded checkpoint.
  for (let index = 0;; index += 1) {
    const entry = await OpenStillRecordStore.getAux('staging', 'prepared-index:' + session.id + ':' + index);
    if (!entry) break;
    keys.push(entry.key);
  }
  session.preparedCount = keys.length;
  return keys;
}
function appendImportSession(message) { return serializeImportSession(message, appendImportSessionUnlocked); }
function appendImportFragments(message) { return serializeImportSession(message, appendImportFragmentsUnlocked); }
function finishImportSession(message) { return serializeImportSession(message, finishImportSessionUnlocked); }
function abortImportSession(message) { return serializeImportSession(message, abortImportSessionUnlocked); }
