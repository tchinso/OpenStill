(function initializeBackupTransfer(root, factory) {
  if (typeof module === 'object' && module?.exports) {
    module.exports = factory(require('./backup-integrity.js'));
  } else {
    root.OpenStillBackupTransfer = factory(root.OpenStillBackupIntegrity);
  }
})(typeof self !== 'undefined' ? self : globalThis, (integrity) => {
  'use strict';

  const MAX_FILE_BYTES = 32 * 1024 * 1024 - 64 * 1024;
  const INTEGRITY_METADATA_RESERVE_BYTES = 1024 * 1024;
  const YIELD_BYTE_BUDGET = 4 * 1024 * 1024;
  const YIELD_CHAR_BUDGET = 1024 * 1024;
  const DIVIDER = '],"fragments":[';
  const SUFFIX = ']}';

  // Count UTF-8 bytes without allocating an additional full record buffer.
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
        } else length += 3;
      } else length += 3;
    }
    return length;
  }

  async function utf8ByteLengthYielding(value, yieldControl) {
    if (!yieldControl || value.length <= YIELD_CHAR_BUDGET) return utf8ByteLength(value);
    let length = 0;
    for (let start = 0; start < value.length;) {
      let end = Math.min(value.length, start + YIELD_CHAR_BUDGET);
      const last = value.charCodeAt(end - 1);
      const next = value.charCodeAt(end);
      if (end < value.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
      length += utf8ByteLength(value.slice(start, end));
      start = end;
      if (start < value.length) await yieldControl();
    }
    return length;
  }

  function createPart(exportedAt, exportId, partNumber) {
    const envelope = { format: 'openstill-export', schemaVersion: 5, exportedAt, exportId, part: partNumber };
    const prefix = JSON.stringify(envelope).slice(0, -1) + ',"monitors":[';
    return {
      envelope,
      groups: { monitor: { chunks: [], count: 0 }, fragment: { chunks: [], count: 0 } },
      checksum: integrity.createChecksumState(),
      byteLength: utf8ByteLength(prefix) + DIVIDER.length + SUFFIX.length + INTEGRITY_METADATA_RESERVE_BYTES
    };
  }

  function createPartBlob(part, manifest, finalPart, totalMonitors) {
    const envelope = { ...part.envelope, integrityRequired: true, previousPartDigest: manifest.at(-1) || null,
      ...(finalPart ? { manifest } : {}) };
    const metadata = integrity.createIntegrityMetadata(part.checksum, {
      monitorCount: part.groups.monitor.count,
      fragmentCount: part.groups.fragment.count,
      finalPart, totalParts: envelope.part, totalMonitors, envelope
    });
    const prefix = JSON.stringify({ ...envelope, integrity: metadata }).slice(0, -1) + ',"monitors":[';
    const blob = new Blob([prefix, ...part.groups.monitor.chunks, DIVIDER, ...part.groups.fragment.chunks, SUFFIX], { type: 'application/json' });
    if (blob.size >= MAX_FILE_BYTES) throw new Error('내보내기 파일 한도를 넘는 데이터 묶음을 만들었습니다.');
    return { blob, envelopeDigest: metadata.envelopeDigest };
  }

  async function writeBackup({ session, send, writePart, onProgress, yieldControl, signal }) {
    const saved = session.progress || {};
    if (saved.done) return saved;
    const total = session.total || 0;
    const exportedAt = saved.exportedAt || new Date().toISOString();
    const exportId = saved.exportId || session.id;
    const manifest = [...(saved.manifest || [])];
    let partNumber = saved.partNumber || 1;
    let cursor = { nextIndex: saved.nextIndex || 0, fragmentIndex: saved.fragmentIndex || 0 };
    let part = createPart(exportedAt, exportId, partNumber);
    let bytesSinceYield = 0;

    async function request(type, fields, fallbackError) {
      signal?.throwIfAborted();
      const response = await send({ type, id: session.id, ...fields });
      if (!response?.ok) throw new Error(response?.error || fallbackError);
      return response;
    }

    async function checkpoint(done = false) {
      const progress = { ...cursor, exportId, exportedAt, partNumber, manifest: [...manifest], done };
      await request('checkpoint-export-session', { progress }, '내보내기 재개 위치를 저장하지 못했습니다.');
      return progress;
    }

    async function flush(finalPart) {
      signal?.throwIfAborted();
      const payload = createPartBlob(part, manifest, finalPart, total);
      await writePart({ ...payload, exportedAt, partNumber, exportId, finalPart });
      if (finalPart) return checkpoint(true);
      manifest.push(payload.envelopeDigest);
      partNumber += 1;
      await checkpoint();
      part = createPart(exportedAt, exportId, partNumber);
    }

    async function append(kind, serialized) {
      const bytes = await utf8ByteLengthYielding(serialized, yieldControl);
      let group = part.groups[kind];
      if (part.byteLength + bytes + (group.count ? 1 : 0) >= MAX_FILE_BYTES
        && (part.groups.monitor.count || part.groups.fragment.count)) {
        await flush(false);
        group = part.groups[kind];
      }
      const delimiterBytes = group.count ? 1 : 0;
      if (part.byteLength + bytes + delimiterBytes >= MAX_FILE_BYTES) throw new Error('내보낼 데이터 조각이 32 MB 파일 분할 기준을 넘습니다.');
      if (delimiterBytes) group.chunks.push(',');
      group.chunks.push(serialized);
      group.count += 1;
      part.byteLength += bytes + delimiterBytes;
      if (yieldControl) await integrity.appendSerializedRecordChunked(part.checksum, kind, serialized, yieldControl);
      else integrity.appendSerializedRecord(part.checksum, kind, serialized);
      bytesSinceYield += bytes;
      if (yieldControl && bytesSinceYield >= YIELD_BYTE_BUDGET) {
        await yieldControl();
        bytesSinceYield = 0;
      }
    }

    await checkpoint();
    for (let index = cursor.nextIndex; index < total; index += 1) {
      const record = await request('get-export-monitor', { index }, '내보낼 추적을 불러오지 못했습니다.');
      if (record.fragmented) {
        const { recordId, fragmentCount } = record;
        if (typeof recordId !== 'string' || !Number.isInteger(fragmentCount) || fragmentCount < 1) throw new Error('내보낼 큰 추적 데이터를 나누지 못했습니다.');
        for (let fragmentIndex = cursor.fragmentIndex; fragmentIndex < fragmentCount; fragmentIndex += 1) {
          const { payload } = await request('get-export-monitor-fragment', { index, fragmentIndex }, '내보낼 추적 조각을 불러오지 못했습니다.');
          if (typeof payload !== 'string') throw new Error('내보낼 추적 조각을 불러오지 못했습니다.');
          await append('fragment', JSON.stringify({ recordId, fragmentIndex, fragmentCount, payload }));
          cursor = { nextIndex: index, fragmentIndex: fragmentIndex + 1 };
        }
      } else {
        if (typeof record.record !== 'string') throw new Error('내보낼 추적 데이터를 읽지 못했습니다.');
        await append('monitor', record.record);
      }
      cursor = { nextIndex: index + 1, fragmentIndex: 0 };
      if ((index + 1) % 100 === 0 || index + 1 === total) {
        onProgress?.(index + 1, total);
        if (yieldControl && index + 1 < total) await yieldControl();
      }
    }
    return flush(true);
  }

  return { writeBackup, MAX_FILE_BYTES, utf8ByteLength, utf8ByteLengthYielding };
});
