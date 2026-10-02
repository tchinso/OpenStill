'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const integrity = require('../backup-integrity.js');
let chromium;
try { ({ chromium } = require(process.env.OPENSTILL_PLAYWRIGHT_MODULE || 'playwright')); } catch { /* optional host browser runtime */ }
const scripts = new Map(['import-worker.js', 'backup-integrity.js', 'record-store.js', 'recovery-json.js']
  .map((name) => ['/' + name, fs.readFileSync(path.join(__dirname, '..', name), 'utf8')]));
let browser;
test.before(async () => {
  if (!chromium) return;
  const executablePath = process.env.OPENSTILL_CHROMIUM_EXECUTABLE || [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ].find(fs.existsSync);
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
});
test.after(async () => { await browser?.close(); });

async function initPage(context) {
  const page = await context.newPage();
  await page.goto('https://import-worker.example.test/');
  await page.addScriptTag({ url: '/record-store.js' });
  await page.evaluate(() => {
    globalThis.importWorkerRuns = [];
    globalThis.startTestImportWorker = ({ text, name = 'backup.json', sessionId = 'session', fileIndex = 0, storedFileId, autoAck = false }) => {
      const worker = new Worker('/import-worker.js');
      const run = { worker, events: [] }; const id = importWorkerRuns.push(run) - 1;
      worker.onmessage = ({ data }) => {
        run.events.push(data);
        if (autoAck && data.type === 'record') worker.postMessage({ type: 'ack' });
      };
      worker.onerror = (event) => run.events.push({ type: 'uncaught-error', error: event.message });
      const file = storedFileId ? undefined : new File([text], name, { type: 'application/json', lastModified: 1_760_000_000_000 });
      worker.postMessage({ type: 'parse', sessionId, fileIndex, ...(storedFileId ? { storedFileId } : { file }) });
      return id;
    };
  });
  return page;
}
async function fixture(t) {
  const context = await browser.newContext();
  t.after(() => context.close());
  await context.route('https://import-worker.example.test/**', (route) => {
    const script = scripts.get(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 200, contentType: script ? 'text/javascript' : 'text/html',
      body: script || '<!doctype html><title>real import Worker / IndexedDB regression</title>' });
  });
  return { context, page: await initPage(context) };
}
async function start(page, options) {
  return page.evaluate((value) => startTestImportWorker(value), options);
}
async function waitMessage(page, id, type, count = 1) {
  await page.waitForFunction(({ id, type, count }) => {
    const events = importWorkerRuns[id].events;
    return events.some((event) => event.type === 'uncaught-error') || events.filter((event) => event.type === type).length >= count;
  }, { id, type, count }, { timeout: 15_000 });
  const events = await page.evaluate((id) => importWorkerRuns[id].events, id);
  assert.equal(events.some((event) => event.type === 'uncaught-error'), false, JSON.stringify(events));
  return events.filter((event) => event.type === type)[count - 1];
}
async function records(page, id) {
  return page.evaluate((id) => importWorkerRuns[id].events.filter((event) => event.type === 'record').map((event) => ({
    record: event.record, kind: event.kind, source: event.source
  })), id);
}
async function ack(page, id, error) {
  await page.evaluate(({ id, error }) => importWorkerRuns[id].worker.postMessage({ type: 'ack', ...(error ? { error } : {}) }), { id, error });
}

test('real import Worker waits for each staging acknowledgment across UTF-8 File stream chunks', { skip: !chromium }, async (t) => {
  const { page } = await fixture(t);
  const input = JSON.stringify([{ id: 'first', text: '한글🙂 \\ " [ ], }'.repeat(12_000) }, { id: 'second' }, { id: 'third' }]);
  const id = await start(page, { text: input });
  const first = await waitMessage(page, id, 'record');
  assert.equal(first.record.id, 'first');
  const blocked = await page.evaluate(async (id) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return importWorkerRuns[id].events.map((event) => event.type);
  }, id);
  assert.equal(blocked.filter((type) => type === 'record').length, 1);
  assert.equal(blocked.includes('parsed'), false);
  await ack(page, id); assert.equal((await waitMessage(page, id, 'record', 2)).record.id, 'second');
  assert.equal((await records(page, id)).length, 2);
  await ack(page, id); assert.equal((await waitMessage(page, id, 'record', 3)).record.id, 'third');
  await ack(page, id);
  const parsed = await waitMessage(page, id, 'parsed');
  assert.equal(parsed.monitorCount, 3); assert.deepEqual(parsed.diagnostics, []);
  const progress = await page.evaluate((id) => importWorkerRuns[id].events.filter((event) => event.type === 'read-progress'), id);
  assert.ok(progress.length >= 2, 'large File must be consumed in multiple stream chunks');
  assert.equal(progress.at(-1).loaded, Buffer.byteLength(input));
});

test('real import Worker recovers healthy siblings and preserves the diagnostic File bytes in IndexedDB', { skip: !chromium }, async (t) => {
  const { page } = await fixture(t);
  const before = { id: 'before', text: 'literal }, [, " \\ 한글🙂', nested: [{ value: false }] };
  const after = { id: 'after', text: 'last', nested: { zero: 0 } };
  const input = '[' + JSON.stringify(before) + ',{"id":"damaged","value":INVALID},' + JSON.stringify(after) + ']';
  const id = await start(page, { text: input, name: 'damaged-한글.json', sessionId: 'damaged', autoAck: true });
  const parsed = await waitMessage(page, id, 'parsed');
  assert.deepEqual((await records(page, id)).map((event) => event.record), [before, after]);
  assert.equal(parsed.monitorCount, 2); assert.ok(parsed.diagnostics.length > 0);
  assert.equal(parsed.recoveryId, 'import-file:damaged:0');
  const stored = await page.evaluate(async (key) => {
    const recovery = await OpenStillRecordStore.getAux('recovery', key);
    const stage = await OpenStillRecordStore.getAux('staging', key);
    return { raw: await recovery.raw.text(), size: recovery.raw.size, source: recovery.source,
      phase: stage.phase, stageRaw: await stage.raw.text(), diagnostics: recovery.diagnostics };
  }, parsed.recoveryId);
  assert.equal(stored.raw, input); assert.equal(stored.stageRaw, input); assert.equal(stored.size, Buffer.byteLength(input));
  assert.equal(stored.source, 'damaged-한글.json'); assert.equal(stored.phase, 'parsed');
  assert.deepEqual(stored.diagnostics, parsed.diagnostics);
});

test('a terminated import Worker resumes from the persisted File after the page and Worker restart', { skip: !chromium }, async (t) => {
  const env = await fixture(t);
  const input = JSON.stringify({ monitors: [{ id: 'one', text: '가🙂'.repeat(25_000) }, { id: 'two', text: 'tail' }] });
  const id = await start(env.page, { text: input, name: 'restart.json', sessionId: 'restart', fileIndex: 3 });
  await waitMessage(env.page, id, 'record');
  await env.page.evaluate((id) => importWorkerRuns[id].worker.terminate(), id);
  const key = 'import-file:restart:3';
  const checkpoint = await env.page.evaluate(async (key) => {
    const stored = await OpenStillRecordStore.getAux('staging', key);
    return { phase: stored.phase, raw: await stored.raw.text(), size: stored.raw.size };
  }, key);
  assert.equal(checkpoint.phase, 'parsing'); assert.equal(checkpoint.raw, input);
  await env.page.close(); env.page = await initPage(env.context);
  const restarted = await start(env.page, { storedFileId: key, sessionId: 'restart', fileIndex: 3, autoAck: true });
  const parsed = await waitMessage(env.page, restarted, 'parsed');
  assert.equal(parsed.monitorCount, 2); assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual((await records(env.page, restarted)).map((event) => event.record.id), ['one', 'two']);
  assert.equal((await records(env.page, restarted))[0].source.fileName, 'restart.json');
  assert.equal(await env.page.evaluate(async (key) => (await OpenStillRecordStore.getAux('staging', key)).phase, key), 'parsed');
});

test('a rejected staging acknowledgment stops parsing and retains the source File for retry', { skip: !chromium }, async (t) => {
  const { page } = await fixture(t);
  const input = JSON.stringify([{ id: 'first' }, { id: 'must-not-forward' }]);
  const id = await start(page, { text: input, sessionId: 'write-failure' });
  await waitMessage(page, id, 'record'); await ack(page, id, 'simulated disk write failure');
  const error = await waitMessage(page, id, 'error');
  assert.match(error.error, /disk write failure/); assert.equal((await records(page, id)).length, 1);
  const recovery = await page.evaluate(async (key) => {
    const value = await OpenStillRecordStore.getAux('recovery', key);
    return { raw: await value.raw.text(), error: value.error };
  }, error.recoveryId);
  assert.equal(recovery.raw, input); assert.match(recovery.error, /disk write failure/);
});

function v5Payload() {
  const json = JSON.stringify({ exists: true, text: 'body 한글🙂', items: [{ text: 'body' }] });
  const snapshotId = createHash('sha256').update(json).digest('hex');
  const monitors = [{ _openStillSnapshot: { id: snapshotId, json } },
    { _openStillMonitorRecord: { id: 'native', schemaVersion: 1, snapshot: { $snapshot: snapshotId }, history: [] } },
    { _openStillSettings: { soundEnabled: false } },
    { _openStillRecovery: { id: 'raw', source: 'legacy', raw: { unknown: 'preserved' } } }];
  const fragment = { recordId: 'large', fragmentIndex: 0, fragmentCount: 1, payload: '{"id":"fragmented"}' };
  const payload = { format: integrity.FORMAT, schemaVersion: 5, exportedAt: '2026-10-02T00:00:00Z', exportId: 'native-export',
    part: 1, previousPartDigest: null, manifest: [], integrityRequired: true, monitors, fragments: [fragment] };
  const checksum = integrity.createChecksumState();
  for (const record of monitors) integrity.appendSerializedRecord(checksum, 'monitor', JSON.stringify(record));
  integrity.appendSerializedRecord(checksum, 'fragment', JSON.stringify(fragment));
  payload.integrity = integrity.createIntegrityMetadata(checksum, { monitorCount: monitors.length, fragmentCount: 1,
    finalPart: true, totalParts: 1, totalMonitors: monitors.length + 1, envelope: payload });
  return payload;
}

test('real import Worker verifies v5 snapshot/control records and the v2 envelope digest', { skip: !chromium }, async (t) => {
  const { page } = await fixture(t);
  const payload = v5Payload();
  const id = await start(page, { text: JSON.stringify(payload), sessionId: 'v5', autoAck: true });
  const parsed = await waitMessage(page, id, 'parsed'); const events = await records(page, id);
  assert.deepEqual(parsed.diagnostics, []); assert.equal(parsed.backupPart.verified, true);
  assert.equal(parsed.backupPart.envelopeVerified, true); assert.equal(parsed.backupPart.exportId, payload.exportId);
  assert.equal(parsed.backupPart.logicalMonitorCount, payload.monitors.length + 1);
  assert.equal(parsed.monitorCount, payload.monitors.length); assert.equal(parsed.fragmentCount, 1);
  assert.deepEqual(events.filter((event) => event.kind === 'monitor').map((event) => event.record), payload.monitors);
  assert.deepEqual(events.filter((event) => event.kind === 'fragment').map((event) => event.record), payload.fragments);
  const restored = await page.evaluate(async (monitors) => {
    await OpenStillRecordStore.stageSnapshot(monitors[0]._openStillSnapshot);
    return OpenStillRecordStore.unpack(monitors[1]._openStillMonitorRecord);
  }, payload.monitors);
  assert.equal(restored.snapshot.text, 'body 한글🙂');
});

test('real import Worker preserves all source bytes when v5 envelope controls are changed', { skip: !chromium }, async (t) => {
  const { page } = await fixture(t);
  const payload = v5Payload(); payload.exportId = 'tampered-export';
  const input = JSON.stringify(payload);
  const id = await start(page, { text: input, sessionId: 'tampered', autoAck: true });
  const parsed = await waitMessage(page, id, 'parsed');
  assert.ok(parsed.diagnostics.some((entry) => entry.code === 'envelope-mismatch'));
  assert.equal(parsed.backupPart, null);
  assert.equal(await page.evaluate(async (key) => (await OpenStillRecordStore.getAux('recovery', key)).raw.text(), parsed.recoveryId), input);
  assert.equal((await records(page, id)).length, payload.monitors.length + payload.fragments.length);
});
