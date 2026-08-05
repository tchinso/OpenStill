'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const integrity = require('../backup-integrity.js');

function verifiedPart({
  exportId = 'export-a',
  exportedAt = '2026-08-05T12:00:00.000Z',
  part = 1,
  monitors = [],
  fragments = [],
  finalPart = true,
  totalParts = part,
  totalMonitors = monitors.length + fragments.filter((fragment) => fragment.fragmentIndex === 0).length
} = {}) {
  const state = integrity.createChecksumState();
  for (const monitor of monitors) {
    integrity.appendSerializedRecord(state, 'monitor', JSON.stringify(monitor));
  }
  for (const fragment of fragments) {
    integrity.appendSerializedRecord(state, 'fragment', JSON.stringify(fragment));
  }
  return {
    format: integrity.FORMAT,
    schemaVersion: integrity.SCHEMA_VERSION,
    exportedAt,
    exportId,
    part,
    integrityRequired: true,
    integrity: integrity.createIntegrityMetadata(state, {
      monitorCount: monitors.length,
      fragmentCount: fragments.length,
      finalPart,
      totalParts,
      totalMonitors
    }),
    monitors,
    fragments
  };
}

function inspect(payload, sourceName = 'backup.json') {
  const result = integrity.inspectBackupPart(payload);
  assert.equal(result.ok, true, result.error);
  return { ...result.part, sourceName };
}

test('a generated one-part backup verifies with Unicode and preserved history', () => {
  const monitor = {
    id: 'monitor-1',
    name: '서울 😀',
    history: [
      { capturedAt: '2026-08-05T01:02:03.000Z', snapshot: { text: '최신 값' } },
      { capturedAt: '2026-08-04T01:02:03.000Z', snapshot: { exists: true } }
    ]
  };
  const payload = verifiedPart({ monitors: [monitor] });
  const part = inspect(payload);

  assert.equal(part.verified, true);
  assert.equal(part.logicalMonitorCount, 1);
  assert.deepEqual(integrity.validateBackupPartSelection([part]), { ok: true });
});

test('a syntactically valid content change is rejected by the checksum', () => {
  const payload = verifiedPart({ monitors: [{ id: 'one', name: 'before' }] });
  payload.monitors[0].name = 'after';

  const result = integrity.inspectBackupPart(payload);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'checksum-mismatch');
});

test('record-count metadata changes are rejected before import', () => {
  const payload = verifiedPart({ monitors: [{ id: 'one' }] });
  payload.integrity.monitorCount = 2;

  const result = integrity.inspectBackupPart(payload);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'count-mismatch');
});

test('monitor and fragment arrival order does not change the serialized checksum', () => {
  const monitor = { id: 'small' };
  const fragment = { recordId: 'large', fragmentIndex: 0, fragmentCount: 1, payload: '{}' };
  const state = integrity.createChecksumState();
  integrity.appendSerializedRecord(state, 'fragment', JSON.stringify(fragment));
  integrity.appendSerializedRecord(state, 'monitor', JSON.stringify(monitor));
  const payload = {
    format: integrity.FORMAT,
    schemaVersion: integrity.SCHEMA_VERSION,
    exportedAt: '2026-08-05T12:00:00.000Z',
    exportId: 'interleaved',
    part: 1,
    integrityRequired: true,
    integrity: integrity.createIntegrityMetadata(state, {
      monitorCount: 1,
      fragmentCount: 1,
      finalPart: true,
      totalParts: 1,
      totalMonitors: 2
    }),
    monitors: [monitor],
    fragments: [fragment]
  };

  assert.equal(integrity.inspectBackupPart(payload).ok, true);
});

test('chunked checksum matches the synchronous checksum across surrogate boundaries', async () => {
  const value = JSON.stringify({ text: `${'가'.repeat(20)}😀${'나'.repeat(20)}` });
  const synchronous = integrity.createChecksumState();
  const chunked = integrity.createChecksumState();
  integrity.appendSerializedRecord(synchronous, 'monitor', value);
  await integrity.appendSerializedRecordChunked(chunked, 'monitor', value, async () => undefined, 1);

  assert.deepEqual(integrity.finishChecksum(chunked), integrity.finishChecksum(synchronous));
});

test('removing required integrity metadata is rejected instead of falling back to legacy', () => {
  const payload = verifiedPart({ monitors: [{ id: 'one' }] });
  delete payload.integrity;

  const result = integrity.inspectBackupPart(payload);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'missing-integrity');
});

test('a complete multipart set verifies in any file-selection order', () => {
  const first = inspect(verifiedPart({
    part: 1,
    monitors: [{ id: 'one' }],
    finalPart: false
  }), 'part-001.json');
  const second = inspect(verifiedPart({
    part: 2,
    monitors: [{ id: 'two' }],
    finalPart: true,
    totalParts: 2,
    totalMonitors: 2
  }), 'part-002.json');

  assert.deepEqual(integrity.validateBackupPartSelection([second, first]), { ok: true });
});

test('missing final, missing middle, and duplicate parts are rejected', () => {
  const first = inspect(verifiedPart({ part: 1, finalPart: false }));
  const second = inspect(verifiedPart({ part: 2, finalPart: false }));
  const third = inspect(verifiedPart({ part: 3, finalPart: true, totalParts: 3 }));

  assert.equal(integrity.validateBackupPartSelection([first, second]).code, 'missing-final-part');
  assert.equal(integrity.validateBackupPartSelection([first, third]).code, 'missing-part');
  assert.equal(integrity.validateBackupPartSelection([first, first, second, third]).code, 'duplicate-part');
});

test('parts with the same export id but different timestamps are rejected', () => {
  const first = inspect(verifiedPart({ part: 1, finalPart: false }));
  const second = inspect(verifiedPart({
    part: 2,
    exportedAt: '2026-08-05T12:01:00.000Z',
    totalParts: 2
  }));

  assert.equal(integrity.validateBackupPartSelection([first, second]).code, 'mixed-backup');
});

test('different complete backup sets and verified/legacy format mixtures are rejected', () => {
  const first = inspect(verifiedPart({ exportId: 'export-a' }));
  const second = inspect(verifiedPart({ exportId: 'export-b' }));
  const legacy = inspect({
    format: integrity.FORMAT,
    schemaVersion: integrity.SCHEMA_VERSION,
    exportedAt: '2025-01-01T00:00:00.000Z',
    exportId: 'legacy-export',
    part: 1,
    monitors: [],
    fragments: []
  });

  assert.equal(integrity.validateBackupPartSelection([first, second]).code, 'multiple-backups');
  assert.equal(integrity.validateBackupPartSelection([first], { totalFiles: 2 }).code, 'mixed-format');
  assert.equal(integrity.validateBackupPartSelection([legacy], { totalFiles: 2 }).code, 'mixed-format');
});

test('fragmented monitor count is checked across parts', () => {
  const fragment0 = { recordId: 'large:1', fragmentIndex: 0, fragmentCount: 2, payload: '{' };
  const fragment1 = { recordId: 'large:1', fragmentIndex: 1, fragmentCount: 2, payload: '}' };
  const first = inspect(verifiedPart({ part: 1, fragments: [fragment0], finalPart: false }));
  const second = inspect(verifiedPart({
    part: 2,
    fragments: [fragment1],
    totalParts: 2,
    totalMonitors: 1
  }));

  assert.deepEqual(integrity.validateBackupPartSelection([first, second]), { ok: true });
  second.totalMonitors = 2;
  assert.equal(integrity.validateBackupPartSelection([first, second]).code, 'total-count-mismatch');
});

test('legacy v4 parts remain accepted while obvious gaps are detected', () => {
  const legacy = (part) => inspect({
    format: integrity.FORMAT,
    schemaVersion: integrity.SCHEMA_VERSION,
    exportedAt: '2025-01-01T00:00:00.000Z',
    exportId: 'legacy-export',
    part,
    monitors: [],
    fragments: []
  });

  assert.deepEqual(integrity.validateBackupPartSelection([legacy(1), legacy(2)]), { ok: true });
  assert.equal(integrity.validateBackupPartSelection([legacy(1), legacy(3)]).code, 'missing-part');
});

test('v2/v3 and Reference payloads remain outside v4 integrity enforcement', () => {
  assert.deepEqual(integrity.inspectBackupPart({
    format: integrity.FORMAT,
    schemaVersion: 3,
    monitors: []
  }), { ok: true, part: null });
  assert.deepEqual(integrity.inspectBackupPart([{ uri: 'https://example.com' }]), { ok: true, part: null });
});

test('integrity-bearing backups cannot downgrade themselves to schema v3', () => {
  const payload = verifiedPart({ monitors: [{ id: 'one' }] });
  payload.schemaVersion = 3;

  const result = integrity.inspectBackupPart(payload);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'schema-downgrade');
});
