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
    schemaVersion: 4,
    exportedAt: '2025-01-01T00:00:00.000Z',
    exportId: 'legacy-export',
    part,
    monitors: [],
    fragments: []
  });

  assert.deepEqual(integrity.validateBackupPartSelection([legacy(1), legacy(2)]), { ok: true });
  assert.equal(integrity.validateBackupPartSelection([legacy(1), legacy(3)]).code, 'missing-part');
});

test('v2/v3 and Reference payloads remain outside v4/v5 integrity enforcement', () => {
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

function envelopePart(options = {}, chain = {}) {
  const payload = verifiedPart(options);
  Object.assign(payload, chain);
  const state = integrity.createChecksumState();
  for (const monitor of payload.monitors) integrity.appendSerializedRecord(state, 'monitor', JSON.stringify(monitor));
  for (const fragment of payload.fragments) integrity.appendSerializedRecord(state, 'fragment', JSON.stringify(fragment));
  payload.integrity = integrity.createIntegrityMetadata(state, {
    monitorCount: payload.monitors.length, fragmentCount: payload.fragments.length,
    finalPart: payload.integrity.finalPart, totalParts: payload.integrity.totalParts,
    totalMonitors: payload.integrity.totalMonitors, envelope: payload
  });
  return payload;
}

function chainedSet(exportId = 'linked') {
  const firstPayload = envelopePart({ exportId, part: 1, finalPart: false, monitors: [{ id: 'one' }] });
  const first = inspect(firstPayload, 'part-001.json');
  const secondPayload = envelopePart({ exportId, part: 2, finalPart: false, monitors: [{ id: 'two' }] }, { previousPartDigest: first.digest });
  const second = inspect(secondPayload, 'part-002.json');
  const lastPayload = envelopePart({ exportId, part: 3, totalParts: 3, totalMonitors: 3, monitors: [{ id: 'three' }] }, { previousPartDigest: second.digest, manifest: [first.digest, second.digest] });
  return { payloads: [firstPayload, secondPayload, lastPayload], parts: [first, second, inspect(lastPayload, 'part-003.json')] };
}

test('integrity v2 protects envelope identity, timing, schema, order and completion metadata', () => {
  const original = envelopePart({ part: 2, finalPart: false, monitors: [{ id: 'one', text: '한글 😀' }] }, { previousPartDigest: 'previous', manifest: [] });
  assert.equal(inspect(original).envelopeVerified, true);
  const changes = [
    (payload) => { payload.exportId = 'other'; },
    (payload) => { payload.exportedAt = '2026-10-02T00:00:00Z'; },
    (payload) => { payload.schemaVersion = payload.schemaVersion === 4 ? 5 : 4; },
    (payload) => { payload.part = 3; },
    (payload) => { payload.integrityRequired = false; },
    (payload) => { payload.previousPartDigest = 'different'; },
    (payload) => { payload.manifest = ['different']; },
    (payload) => { payload.integrity.finalPart = true; payload.integrity.totalParts = 2; payload.integrity.totalMonitors = 1; }
  ];
  for (const modify of changes) {
    const payload = structuredClone(original); modify(payload);
    assert.equal(payload.integrity.checksum, original.integrity.checksum, 'content CRC remained unchanged');
    const result = integrity.inspectBackupPart(payload);
    assert.equal(result.ok, false); assert.equal(result.code, 'envelope-mismatch');
  }
});

test('streamed record validation enforces the same v2 envelope digest', () => {
  const payload = envelopePart({ monitors: [{ id: 'streamed', text: '조각 경계 😀' }], totalMonitors: 1 }, { manifest: [] });
  const streamed = { monitorCount: 1, fragmentCount: 0, logicalMonitorCount: 1, checksum: integrity.checksumPayload(payload.monitors, []) };
  const metadataOnly = { ...payload, monitors: [], fragments: [] };
  assert.equal(integrity.inspectBackupPart(metadataOnly, streamed).ok, true);
  metadataOnly.exportId = 'wrong-set';
  assert.equal(integrity.inspectBackupPart(metadataOnly, streamed).code, 'envelope-mismatch');
});

test('v2 manifest verifies reordered file selection and rejects broken links or manifests', () => {
  const { payloads, parts } = chainedSet();
  assert.deepEqual(integrity.validateBackupPartSelection([parts[2], parts[0], parts[1]]), { ok: true });
  const changedManifest = structuredClone(payloads[2]);
  changedManifest.manifest.reverse();
  changedManifest.integrity.envelopeDigest = integrity.envelopeDigest(changedManifest, changedManifest.integrity);
  assert.equal(integrity.validateBackupPartSelection([parts[0], parts[1], inspect(changedManifest)]).code, 'manifest-mismatch');
  const changedLink = structuredClone(payloads[1]);
  changedLink.previousPartDigest = 'different';
  changedLink.integrity.envelopeDigest = integrity.envelopeDigest(changedLink, changedLink.integrity);
  assert.equal(integrity.validateBackupPartSelection([parts[0], inspect(changedLink), parts[2]]).code, 'manifest-mismatch');
});

test('tolerant selection retains intact records when final or middle parts are missing', () => {
  const { parts } = chainedSet();
  const noFinal = integrity.recoverBackupPartSelection([parts[1], parts[0]]);
  assert.equal(noFinal.ok, true); assert.equal(noFinal.complete, false);
  assert.deepEqual(noFinal.parts, [parts[1], parts[0]]);
  assert.ok(noFinal.diagnostics.some((entry) => entry.code === 'missing-final-part'));
  const noMiddle = integrity.recoverBackupPartSelection([parts[2], parts[0]]);
  assert.equal(noMiddle.ok, true); assert.equal(noMiddle.complete, false);
  assert.equal(noMiddle.parts.length, 2);
  assert.ok(noMiddle.diagnostics.some((entry) => ['missing-part', 'manifest-mismatch'].includes(entry.code)));
});

test('tolerant selection handles several complete export sets independently', () => {
  const first = inspect(envelopePart({ exportId: 'first', monitors: [{ id: 'first' }] }, { manifest: [] }), 'first.json');
  const second = inspect(envelopePart({ exportId: 'second', monitors: [{ id: 'second' }] }, { manifest: [] }), 'second.json');
  const result = integrity.recoverBackupPartSelection([second, first]);
  assert.equal(result.ok, true); assert.equal(result.complete, true);
  assert.deepEqual(result.parts, [second, first]); assert.deepEqual(result.diagnostics, []);
});

test('tolerant selection merges identical parts but diagnoses conflicting originals without mutation', () => {
  const firstPayload = envelopePart({ monitors: [{ id: 'first' }] }, { manifest: [] });
  const first = inspect(firstPayload, 'original.json');
  const duplicate = inspect(structuredClone(firstPayload), 'same.json');
  const same = integrity.recoverBackupPartSelection([first, duplicate]);
  assert.equal(same.complete, true); assert.deepEqual(same.parts, [first]);
  assert.equal(same.diagnostics[0].code, 'duplicate-identical'); assert.equal(same.diagnostics[0].source, 'same.json');
  const conflictingPayload = envelopePart({ monitors: [{ id: 'other-content' }] }, { manifest: [] });
  const conflicting = inspect(conflictingPayload, 'conflicting.json');
  const before = structuredClone([firstPayload, conflictingPayload]);
  const result = integrity.recoverBackupPartSelection([first, conflicting]);
  assert.equal(result.ok, true); assert.equal(result.complete, false);
  assert.equal(result.diagnostics[0].code, 'duplicate-conflict'); assert.equal(result.diagnostics[0].source, 'conflicting.json');
  assert.deepEqual([firstPayload, conflictingPayload], before);
});

test('one incomplete set does not prevent independent complete sets from recovery', () => {
  const incomplete = inspect(envelopePart({ exportId: 'missing-last', part: 1, finalPart: false, monitors: [{ id: 'recoverable' }] }), 'incomplete.json');
  const complete = inspect(envelopePart({ exportId: 'complete', monitors: [{ id: 'healthy' }] }, { manifest: [] }), 'complete.json');
  const result = integrity.recoverBackupPartSelection([incomplete, complete]);
  assert.equal(result.ok, true); assert.equal(result.complete, false);
  assert.deepEqual(result.parts, [incomplete, complete]);
  assert.ok(result.diagnostics.some((entry) => entry.exportId === 'missing-last' && entry.code === 'missing-final-part'));
  assert.equal(result.diagnostics.some((entry) => entry.exportId === 'complete'), false);
});
