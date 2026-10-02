'use strict';
importScripts('backup-integrity.js', 'record-store.js', 'recovery-json.js');
let pendingAck;
self.addEventListener('message', async (event) => {
  if (event.data?.type === 'ack') { pendingAck?.(event.data); pendingAck = null; return; }
  if (event.data?.type !== 'parse') return;
  const { sessionId, fileIndex, storedFileId } = event.data;
  const recoveryId = storedFileId || 'import-file:' + sessionId + ':' + fileIndex;
  let file = event.data.file;
  try {
    if (storedFileId) {
      const stored = await OpenStillRecordStore.getAux('staging', storedFileId)
        || await OpenStillRecordStore.getAux('recovery', storedFileId);
      if (stored?.raw) file = stored.raw;
      if (file && !file.name) Object.defineProperty(file, 'name', { value: stored.source || storedFileId });
    }
    if (!file || typeof file.stream !== 'function') throw new Error('선택한 파일을 읽을 수 없습니다.');
    await OpenStillRecordStore.putAux('staging', recoveryId, { kind: 'import-file', id: recoveryId, sessionId, fileIndex, raw: file, source: file.name, phase: 'parsing' });
    const checksum = self.OpenStillBackupIntegrity.createChecksumState();
    let monitorCount = 0; let fragmentCount = 0; let logicalMonitorCount = 0;
    const scanner = new self.OpenStillRecordScanner(async (record, kind, source) => {
      self.OpenStillBackupIntegrity.appendSerializedRecord(checksum, kind, JSON.stringify(record));
      if (kind === 'monitor') { monitorCount += 1; logicalMonitorCount += 1; }
      else { fragmentCount += 1; if (record?.fragmentIndex === 0) logicalMonitorCount += 1; }
      const acknowledgment = new Promise((resolve) => { pendingAck = resolve; });
      self.postMessage({ type: 'record', record, kind, source: { ...source, fileName: file.name, exportId: scanner.metadata.exportId, part: scanner.metadata.part } });
      const response = await acknowledgment;
      if (response.error) throw new Error(response.error);
    });
    const reader = file.stream().getReader(); const decoder = new TextDecoder(); let loaded = 0;
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      loaded += value.byteLength; await scanner.write(decoder.decode(value, { stream: true }));
      self.postMessage({ type: 'read-progress', loaded, total: file.size });
    }
    await scanner.write(decoder.decode());
    const parsed = await scanner.finish();
    const payload = { ...parsed.metadata, monitors: [], fragments: [] };
    const inspected = self.OpenStillBackupIntegrity.inspectBackupPart(payload, { monitorCount, fragmentCount, logicalMonitorCount, checksum: self.OpenStillBackupIntegrity.finishChecksum(checksum) });
    const diagnostics = [...parsed.diagnostics];
    if (!parsed.recognized) diagnostics.push({ error: '복원 가능한 독립 레코드 배열이 없습니다.' });
    if (!inspected.ok) diagnostics.push({ error: inspected.error, code: inspected.code });
    if (diagnostics.length) await OpenStillRecordStore.putAux('recovery', recoveryId, { id: recoveryId, raw: file, source: file.name, error: diagnostics[0].error, diagnostics });
    await OpenStillRecordStore.putAux('staging', recoveryId, { kind: 'import-file', id: recoveryId, sessionId, fileIndex, raw: file, source: file.name, phase: 'parsed', backupPart: inspected.part || null, diagnostics });
    self.postMessage({ type: 'parsed', payload, backupPart: inspected.part || null, diagnostics, recoveryId: diagnostics.length ? recoveryId : null, monitorCount, fragmentCount });
  } catch (error) {
    await OpenStillRecordStore.putAux('recovery', recoveryId, { id: recoveryId, raw: file, source: file?.name, error: error?.message }).catch(() => undefined);
    self.postMessage({ type: 'error', error: error?.message || 'JSON 파일을 읽지 못했습니다.', recoveryId });
  }
});
