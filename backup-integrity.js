(function initializeBackupIntegrity(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module?.exports) {
    module.exports = api;
  } else {
    root.OpenStillBackupIntegrity = api;
  }
})(typeof self !== 'undefined' ? self : globalThis, () => {
  'use strict';

  const FORMAT = 'openstill-export';
  const SCHEMA_VERSION = 4;
  const INTEGRITY_VERSION = 1;
  // Two CRC32 groups are used here as an accidental-corruption check, like a
  // ZIP file's CRC. They are incremental, so a 32 MiB backup part does not
  // need a second full-size byte buffer merely to calculate its checksum.
  const ALGORITHM = 'crc32-record-groups-v1';
  const MAX_PARTS = 100_000;

  const CRC32_TABLE = new Uint32Array(256);
  for (let index = 0; index < CRC32_TABLE.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    CRC32_TABLE[index] = value >>> 0;
  }

  function createCrcState() {
    return { crc: 0xffffffff, payloadBytes: 0 };
  }

  function createChecksumState() {
    // The JSON envelope always writes all monitors before all fragments, even
    // if the exporter receives those records interleaved while filling a part.
    // Separate states make the checksum independent of that arrival order.
    return { monitor: createCrcState(), fragment: createCrcState() };
  }

  function appendByte(state, byte) {
    state.crc = (CRC32_TABLE[(state.crc ^ byte) & 0xff] ^ (state.crc >>> 8)) >>> 0;
    state.payloadBytes += 1;
  }

  function appendUtf8(state, value) {
    const text = String(value);
    for (let index = 0; index < text.length; index += 1) {
      const first = text.charCodeAt(index);
      if (first <= 0x7f) {
        appendByte(state, first);
      } else if (first <= 0x7ff) {
        appendByte(state, 0xc0 | (first >>> 6));
        appendByte(state, 0x80 | (first & 0x3f));
      } else if (first >= 0xd800 && first <= 0xdbff && index + 1 < text.length) {
        const second = text.charCodeAt(index + 1);
        if (second >= 0xdc00 && second <= 0xdfff) {
          const point = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
          appendByte(state, 0xf0 | (point >>> 18));
          appendByte(state, 0x80 | ((point >>> 12) & 0x3f));
          appendByte(state, 0x80 | ((point >>> 6) & 0x3f));
          appendByte(state, 0x80 | (point & 0x3f));
          index += 1;
        } else {
          appendByte(state, 0xef);
          appendByte(state, 0xbf);
          appendByte(state, 0xbd);
        }
      } else if (first >= 0xdc00 && first <= 0xdfff) {
        appendByte(state, 0xef);
        appendByte(state, 0xbf);
        appendByte(state, 0xbd);
      } else {
        appendByte(state, 0xe0 | (first >>> 12));
        appendByte(state, 0x80 | ((first >>> 6) & 0x3f));
        appendByte(state, 0x80 | (first & 0x3f));
      }
    }
    return state;
  }

  function appendSerializedRecord(state, kind, serializedRecord) {
    const target = state?.[kind];
    if (!target || !Number.isInteger(target.crc) || typeof serializedRecord !== 'string') {
      throw new TypeError('백업 체크섬 입력이 올바르지 않습니다.');
    }
    const marker = kind === 'fragment' ? 'F' : kind === 'monitor' ? 'M' : '';
    if (!marker) throw new TypeError('알 수 없는 백업 레코드 종류입니다.');
    // Length-prefixing makes record boundaries unambiguous without retaining
    // the complete part in memory.
    appendUtf8(target, `${marker}${serializedRecord.length}:`);
    appendUtf8(target, serializedRecord);
    appendUtf8(target, ';');
    return state;
  }

  async function appendSerializedRecordChunked(
    state,
    kind,
    serializedRecord,
    yieldControl,
    chunkChars = 1024 * 1024
  ) {
    const target = state?.[kind];
    if (!target || !Number.isInteger(target.crc) || typeof serializedRecord !== 'string'
      || typeof yieldControl !== 'function' || !Number.isSafeInteger(chunkChars) || chunkChars < 1) {
      throw new TypeError('백업 체크섬 입력이 올바르지 않습니다.');
    }
    const marker = kind === 'fragment' ? 'F' : kind === 'monitor' ? 'M' : '';
    if (!marker) throw new TypeError('알 수 없는 백업 레코드 종류입니다.');
    appendUtf8(target, `${marker}${serializedRecord.length}:`);
    for (let start = 0; start < serializedRecord.length;) {
      let end = Math.min(serializedRecord.length, start + chunkChars);
      const last = serializedRecord.charCodeAt(end - 1);
      const next = serializedRecord.charCodeAt(end);
      if (end < serializedRecord.length && last >= 0xd800 && last <= 0xdbff
        && next >= 0xdc00 && next <= 0xdfff) {
        end = end - start > 1 ? end - 1 : end + 1;
      }
      appendUtf8(target, serializedRecord.slice(start, end));
      start = end;
      if (start < serializedRecord.length) await yieldControl();
    }
    appendUtf8(target, ';');
    return state;
  }

  function finishCrc(state) {
    return ((state.crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
  }

  function finishChecksum(state) {
    return {
      algorithm: ALGORITHM,
      checksum: `${finishCrc(state.monitor)}${finishCrc(state.fragment)}`,
      payloadBytes: state.monitor.payloadBytes + state.fragment.payloadBytes
    };
  }

  function checksumPayload(monitors, fragments) {
    const state = createChecksumState();
    for (const monitor of monitors) {
      const serialized = JSON.stringify(monitor);
      if (typeof serialized !== 'string') throw new TypeError('추적 레코드를 직렬화할 수 없습니다.');
      appendSerializedRecord(state, 'monitor', serialized);
    }
    for (const fragment of fragments) {
      const serialized = JSON.stringify(fragment);
      if (typeof serialized !== 'string') throw new TypeError('추적 조각을 직렬화할 수 없습니다.');
      appendSerializedRecord(state, 'fragment', serialized);
    }
    return finishChecksum(state);
  }

  function createIntegrityMetadata(state, {
    monitorCount,
    fragmentCount,
    finalPart = false,
    totalParts,
    totalMonitors
  }) {
    if (!Number.isSafeInteger(monitorCount) || monitorCount < 0
      || !Number.isSafeInteger(fragmentCount) || fragmentCount < 0
      || typeof finalPart !== 'boolean') {
      throw new TypeError('백업 part 개수 정보가 올바르지 않습니다.');
    }
    if (finalPart && (!Number.isSafeInteger(totalParts) || totalParts < 1 || totalParts > MAX_PARTS
      || !Number.isSafeInteger(totalMonitors) || totalMonitors < 0)) {
      throw new TypeError('마지막 백업 part의 전체 개수 정보가 올바르지 않습니다.');
    }
    return {
      version: INTEGRITY_VERSION,
      ...finishChecksum(state),
      monitorCount,
      fragmentCount,
      finalPart,
      ...(finalPart ? { totalParts, totalMonitors } : {})
    };
  }

  function invalidPart(error, code = 'invalid-integrity') {
    return { ok: false, code, error };
  }

  function inspectBackupPart(payload) {
    const carriesIntegrity = payload && typeof payload === 'object'
      && (payload.integrityRequired === true || Object.prototype.hasOwnProperty.call(payload, 'integrity'));
    if (carriesIntegrity && (payload.format !== FORMAT || payload.schemaVersion !== SCHEMA_VERSION)) {
      return invalidPart('백업의 형식 또는 스키마 버전이 무결성 정보와 일치하지 않습니다.', 'schema-downgrade');
    }
    if (payload?.format !== FORMAT || payload?.schemaVersion !== SCHEMA_VERSION) {
      return { ok: true, part: null };
    }

    const hasPartIdentity = typeof payload.exportId === 'string' && payload.exportId.length > 0
      && payload.exportId.length <= 200
      && Number.isSafeInteger(payload.part) && payload.part > 0 && payload.part <= MAX_PARTS;
    const hasIntegrity = Object.prototype.hasOwnProperty.call(payload, 'integrity');
    if (!hasIntegrity) {
      if (payload.integrityRequired === true) {
        return invalidPart('백업 part에 필수 무결성 정보가 없습니다.', 'missing-integrity');
      }
      return {
        ok: true,
        part: hasPartIdentity ? {
          verified: false,
          exportId: payload.exportId,
          exportedAt: typeof payload.exportedAt === 'string' ? payload.exportedAt : '',
          part: payload.part
        } : null
      };
    }

    if (!hasPartIdentity || typeof payload.exportedAt !== 'string' || !payload.exportedAt) {
      return invalidPart('백업 part의 식별 정보가 손상되었습니다.');
    }
    if (!Array.isArray(payload.monitors) || !Array.isArray(payload.fragments)) {
      return invalidPart('백업 part의 추적 목록이 손상되었습니다.');
    }

    const integrity = payload.integrity;
    if (!integrity || typeof integrity !== 'object'
      || integrity.version !== INTEGRITY_VERSION
      || integrity.algorithm !== ALGORITHM
      || !/^[0-9a-f]{16}$/i.test(integrity.checksum ?? '')
      || !Number.isSafeInteger(integrity.payloadBytes) || integrity.payloadBytes < 0
      || !Number.isSafeInteger(integrity.monitorCount) || integrity.monitorCount < 0
      || !Number.isSafeInteger(integrity.fragmentCount) || integrity.fragmentCount < 0
      || typeof integrity.finalPart !== 'boolean') {
      return invalidPart('백업 part의 무결성 정보가 손상되었습니다.');
    }
    if (integrity.monitorCount !== payload.monitors.length
      || integrity.fragmentCount !== payload.fragments.length) {
      return invalidPart('백업 part의 레코드 수가 무결성 정보와 일치하지 않습니다.', 'count-mismatch');
    }

    if (integrity.finalPart) {
      if (!Number.isSafeInteger(integrity.totalParts) || integrity.totalParts !== payload.part
        || integrity.totalParts < 1 || integrity.totalParts > MAX_PARTS
        || !Number.isSafeInteger(integrity.totalMonitors) || integrity.totalMonitors < 0) {
        return invalidPart('마지막 백업 part의 전체 개수 정보가 손상되었습니다.', 'invalid-total');
      }
    } else if (integrity.totalParts !== undefined || integrity.totalMonitors !== undefined) {
      return invalidPart('중간 백업 part에 잘못된 완료 정보가 들어 있습니다.', 'invalid-total');
    }

    let actual;
    try {
      actual = checksumPayload(payload.monitors, payload.fragments);
    } catch {
      return invalidPart('백업 part의 체크섬을 계산하지 못했습니다.');
    }
    if (actual.checksum !== integrity.checksum.toLowerCase()
      || actual.payloadBytes !== integrity.payloadBytes) {
      return invalidPart('백업 part의 내용이 손상되었거나 저장 중 변경되었습니다.', 'checksum-mismatch');
    }

    return {
      ok: true,
      part: {
        verified: true,
        exportId: payload.exportId,
        exportedAt: payload.exportedAt,
        part: payload.part,
        finalPart: integrity.finalPart,
        totalParts: integrity.finalPart ? integrity.totalParts : null,
        totalMonitors: integrity.finalPart ? integrity.totalMonitors : null,
        logicalMonitorCount: payload.monitors.length
          + payload.fragments.filter((fragment) => fragment?.fragmentIndex === 0).length
      }
    };
  }

  function failedSelection(code, error, details = {}) {
    return { ok: false, code, error, ...details };
  }

  function validateBackupPartSelection(parts, { totalFiles = parts.length } = {}) {
    if (parts.length && totalFiles !== parts.length) {
      return failedSelection(
        'mixed-format',
        '번호가 붙은 OpenStill 백업 part와 다른 형식의 파일을 한 번에 섞어 불러올 수 없습니다.'
      );
    }
    const groups = new Map();
    for (const part of parts.filter(Boolean)) {
      let group = groups.get(part.exportId);
      if (!group) {
        group = [];
        groups.set(part.exportId, group);
      }
      group.push(part);
    }

    if (groups.size > 1) {
      return failedSelection(
        'multiple-backups',
        '서로 다른 백업 세트가 함께 선택되었습니다. 한 번에 한 백업 세트의 part만 선택해 주세요.'
      );
    }

    for (const [exportId, group] of groups) {
      const exportedAt = group[0].exportedAt;
      if (group.some((part) => part.exportedAt !== exportedAt)) {
        return failedSelection('mixed-backup', '서로 다른 시점의 백업 part가 한 세트로 섞여 있습니다.', { exportId });
      }
      if (group.some((part) => part.verified !== group[0].verified)) {
        return failedSelection('mixed-integrity', '같은 백업 세트에 무결성 정보가 다른 part가 섞여 있습니다.', { exportId });
      }

      const sorted = [...group].sort((left, right) => left.part - right.part);
      for (let index = 1; index < sorted.length; index += 1) {
        if (sorted[index - 1].part === sorted[index].part) {
          return failedSelection('duplicate-part', `같은 백업 part ${sorted[index].part}번이 중복 선택되었습니다.`, {
            exportId,
            part: sorted[index].part
          });
        }
      }

      if (!group[0].verified) {
        if (sorted[0].part !== 1) {
          return failedSelection('missing-part', '예전 형식 백업의 1번 part가 선택되지 않았습니다.', { exportId, part: 1 });
        }
        for (let index = 1; index < sorted.length; index += 1) {
          if (sorted[index].part !== sorted[index - 1].part + 1) {
            return failedSelection('missing-part', `예전 형식 백업의 ${sorted[index - 1].part + 1}번 part가 빠져 있습니다.`, {
              exportId,
              part: sorted[index - 1].part + 1
            });
          }
        }
        continue;
      }

      const finalParts = sorted.filter((part) => part.finalPart);
      if (finalParts.length !== 1) {
        return failedSelection(
          finalParts.length ? 'multiple-final-parts' : 'missing-final-part',
          finalParts.length ? '마지막 백업 part가 둘 이상 선택되었습니다.' : '백업 세트의 마지막 part가 선택되지 않았습니다.',
          { exportId }
        );
      }
      const finalPart = finalParts[0];
      if (sorted.length !== finalPart.totalParts) {
        let expected = 1;
        for (const part of sorted) {
          if (part.part !== expected) break;
          expected += 1;
        }
        return failedSelection('missing-part', `백업 세트의 ${expected}번 part가 빠져 있습니다.`, {
          exportId,
          part: expected,
          totalParts: finalPart.totalParts
        });
      }
      for (let index = 0; index < sorted.length; index += 1) {
        if (sorted[index].part !== index + 1) {
          return failedSelection('missing-part', `백업 세트의 ${index + 1}번 part가 빠져 있습니다.`, {
            exportId,
            part: index + 1,
            totalParts: finalPart.totalParts
          });
        }
      }
      const logicalMonitorCount = sorted.reduce((sum, part) => sum + part.logicalMonitorCount, 0);
      if (logicalMonitorCount !== finalPart.totalMonitors) {
        return failedSelection('total-count-mismatch', '백업 세트의 전체 추적 수가 완료 정보와 일치하지 않습니다.', {
          exportId,
          expected: finalPart.totalMonitors,
          actual: logicalMonitorCount
        });
      }
    }

    return { ok: true };
  }

  return Object.freeze({
    ALGORITHM,
    FORMAT,
    INTEGRITY_VERSION,
    SCHEMA_VERSION,
    appendSerializedRecord,
    appendSerializedRecordChunked,
    checksumPayload,
    createIntegrityMetadata,
    createChecksumState,
    finishChecksum,
    inspectBackupPart,
    validateBackupPartSelection
  });
});
