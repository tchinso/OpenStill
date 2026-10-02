'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Scanner = require('../recovery-json.js');

async function scan(value, chunkSize = 7, options) {
  const records = [];
  const scanner = new Scanner(async (record, kind, source) => records.push({ record, kind, source }), options);
  const encoded = new TextEncoder().encode(value);
  const decoder = new TextDecoder();
  for (let index = 0; index < encoded.length; index += chunkSize) await scanner.write(decoder.decode(encoded.slice(index, index + chunkSize), { stream: true }));
  await scanner.write(decoder.decode());
  return { records, ...await scanner.finish() };
}

test('streaming recovery preserves escapes, quoted whitespace, nesting and multibyte boundaries', async () => {
  const records = [{ id: '가나다🙂', text: ' whitespace \n line \t \"quoted\" slash\\ ],}{ ', nested: [null, { value: ['second', '한글🙂'] }] }, { id: 'two', value: false }];
  const envelope = { exportId: 'set-한글', part: 2, monitors: records, complete: false };
  for (const chunkSize of [1, 2, 3, 11, 64]) {
    const parsed = await scan(JSON.stringify(envelope), chunkSize);
    assert.deepEqual(parsed.records.map((entry) => entry.record), records);
    assert.equal(parsed.metadata.exportId, envelope.exportId);
    assert.equal(parsed.metadata.part, 2);
    assert.equal(parsed.metadata.complete, false);
    assert.equal(parsed.diagnostics.length, 0);
  }
});

test('a malformed independent sibling leaves both adjacent records recoverable', async () => {
  const parsed = await scan('[{"id":"before"},{"id":"bad",broken:1},{"id":"after"}]', 1);
  assert.deepEqual(parsed.records.map(({ record }) => record.id), ['before', 'after']);
  assert.equal(parsed.diagnostics.length, 1);
  assert.equal(parsed.diagnostics[0].recordIndex, 1);
  assert.ok(parsed.diagnostics[0].offset > 0);
});

test('complete final records survive a missing enclosing bracket while partial records stay excluded', async () => {
  const closed = await scan('{"monitors":[{"id":"one"},{"id":"two","nested":{"a":[1,2]}}');
  assert.deepEqual(closed.records.map(({ record }) => record.id), ['one', 'two']);
  assert.match(closed.diagnostics[0].error, /중간에 끝/);
  const partial = await scan('[{"id":"one"},{"id":"two","text":"unfinished');
  assert.deepEqual(partial.records.map(({ record }) => record.id), ['one']);
  assert.match(partial.diagnostics[0].error, /중간에 끝/);
});

test('oversized independent UTF-8 records are skipped with diagnostics and later records continue', async () => {
  const parsed = await scan(JSON.stringify([{ id: 'large', text: '가'.repeat(30) }, { id: 'good' }]), 1, { maxRecordBytes: 64 });
  assert.deepEqual(parsed.records.map(({ record }) => record.id), ['good']);
  assert.match(parsed.diagnostics[0].error, /예산/);
});

test('record callbacks provide backpressure and propagate staging failures', async () => {
  let release;
  let entered;
  const firstEntered = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const ids = [];
  const scanner = new Scanner(async (record) => { ids.push(record.id); if (ids.length === 1) { entered(); await gate; } });
  const pending = scanner.write('[{"id":"one"},{"id":"two"}]');
  await firstEntered;
  assert.deepEqual(ids, ['one']);
  release();
  await pending;
  await scanner.finish();
  assert.deepEqual(ids, ['one', 'two']);
  const rejected = new Scanner(async () => { throw new Error('disk full'); });
  await assert.rejects(rejected.write('[{"id":"one"}]'), /disk full/);
});

test('fragment arrays and bare legacy lists retain source kind and ordinal', async () => {
  const fragments = [{ recordId: 'r', fragmentIndex: 0, fragmentCount: 1, payload: 'nested \\" []{}' }];
  const parsed = await scan(JSON.stringify({ exportId: 'set', fragments }));
  assert.equal(parsed.records[0].kind, 'fragment');
  assert.equal(parsed.records[0].source.recordIndex, 0);
  assert.deepEqual(parsed.records[0].record, fragments[0]);
  const bare = await scan('[null,"string",12,true, {"id":"normal"}]');
  assert.equal(bare.recognized, true);
  assert.deepEqual(bare.records.map(({ record }) => record), [null, 'string', 12, true, { id: 'normal' }]);
});
