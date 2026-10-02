'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let chromium;
try { ({ chromium } = require(process.env.OPENSTILL_PLAYWRIGHT_MODULE || 'playwright')); } catch { /* optional */ }
const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const worker = read('service-worker.js');
const source = [read('record-store.js'), worker.slice(0, worker.indexOf('\nconst messageHandlers = {')), read('import-session.js'), read('export-session.js')].join('\n') + `\nglobalThis.storageTest={normalizeMonitor,getState,mutateMonitors,startImportSession,appendImportSession,appendImportFragments,finishImportSession,startExportSession,getExportMonitor,finishExportSession,recoveryStatus};`;
let browser;
test.before(async () => {
  if (!chromium) return;
  const executablePath = process.env.OPENSTILL_CHROMIUM_EXECUTABLE || ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(fs.existsSync);
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
});
test.after(async () => { await browser?.close(); });

async function initPage(context, initial = {}) {
  const page = await context.newPage();
  await page.route('**/*', (route) => route.fulfill({ body: '<!doctype html><title>isolated IndexedDB regression</title>', contentType: 'text/html' }));
  await page.goto('https://storage.example.test/');
  await page.evaluate(({ script, initial }) => {
    globalThis.localValues = initial.local || {}; globalThis.sessionValues = initial.session || {};
    const area = (values) => ({ get: async (keys) => keys == null ? structuredClone(values) : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(values[key])])),
      set: async (patch) => { Object.assign(values, structuredClone(patch)); }, remove: async (keys) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; }, setAccessLevel: async () => {} });
    globalThis.chrome = { storage: { local: area(localValues), session: area(sessionValues) },
      runtime: { getURL: (name) => 'chrome-extension://test/' + name, getContexts: async () => [{ documentUrl: 'chrome-extension://test/offscreen.html' }], sendMessage: async () => ({ ok: true }) },
      offscreen: { createDocument: async () => {} }, action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      alarms: { clear: async () => true, create: async () => {} }, tabs: { query: async () => [], get: async () => null, remove: async () => {}, update: async () => {} },
      scripting: { executeScript: async () => [] }, notifications: { create: async () => {} }, windows: { create: async () => {} }, webNavigation: {} };
    globalThis.importScripts = () => {};
    (0, eval)(script);
    globalThis.makeRecord = (id, text = 'OLD', extra = {}) => ({ id, revision: 'r-' + id, schemaVersion: 1, name: id, url: 'https://example.test/' + id,
      enabled: false, locators: [{ type: 'css', op: 'include', expr: 'body', frameId: 0, framePath: [], fields: [{ type: 'text' }] }], labels: [], tracking: {}, selectors: ['body'],
      scheduleMode: 'manual', schedule: { type: 'manual', params: {} }, createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
      snapshot: { exists: true, text, html: '<p>' + text + '</p>', data: '<p>' + text + '</p>', items: [{ text }], capturedAt: '2026-10-02T00:00:00.000Z' }, history: [], runs: [], status: 'ok', ...extra });
  }, { script: source, initial });
  return page;
}
async function fixture(t, initial) {
  const context = await browser.newContext();
  t.after(() => context.close());
  return { context, page: await initPage(context, initial) };
}
async function restart(env) {
  const initial = await env.page.evaluate(() => ({ local: localValues, session: sessionValues }));
  await env.page.close(); env.page = await initPage(env.context, initial);
}

test('IndexedDB saves roll back synchronous mid-transaction failures including settings and receipts', { skip: !chromium }, async (t) => {
  const { page } = await fixture(t);
  const result = await page.evaluate(async () => {
    const store = OpenStillRecordStore;
    await store.commit({ changed: [makeRecord('a'), makeRecord('b')], generation: 1, settings: { soundEnabled: true } });
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === 'monitors' && key === 'b' && value.record.name === 'NEW') throw new DOMException('simulated mid-write failure', 'DataCloneError');
      return originalPut.call(this, value, key);
    };
    let error;
    try { await store.commit({ changed: [makeRecord('a', 'NEW', { name: 'NEW' }), makeRecord('b', 'NEW', { name: 'NEW' })], generation: 2, settings: { soundEnabled: false }, operation: { id: 'op', committed: true } }); }
    catch (value) { error = value.message; }
    finally { IDBObjectStore.prototype.put = originalPut; }
    const loaded = await store.load();
    const circular = {}; circular.self = circular;
    let beforeFailed = false;
    try { await store.commit({ changed: [makeRecord('a', 'unused', { snapshot: circular })], generation: 3 }); } catch { beforeFailed = true; }
    return { error, names: loaded.monitors.map((monitor) => monitor.name), generation: loaded.generation, snapshots: (await store.allAux('snapshots')).length,
      settings: await store.getAux('meta', 'settings'), receipt: await store.getAux('operations', 'op'), beforeFailed };
  });
  assert.match(result.error, /mid-write failure/);
  assert.deepEqual(result.names.sort(), ['a', 'b']);
  assert.equal(result.generation, 1);
  assert.equal(result.snapshots, 1);
  assert.equal(result.settings.soundEnabled, true);
  assert.equal(result.receipt, undefined);
  assert.equal(result.beforeFailed, true);
});

test('commit response loss leaves durable generation, settings and operation receipt', { skip: !chromium }, async (t) => {
  const env = await fixture(t);
  await env.page.evaluate(async () => { await OpenStillRecordStore.commit({ changed: [makeRecord('a')], generation: 1, operation: { id: 'lost-response', committed: true, result: { imported: 1 } }, settings: { soundEnabled: false } }); });
  await restart(env);
  const result = await env.page.evaluate(async () => ({ loaded: await OpenStillRecordStore.load(), receipt: await OpenStillRecordStore.getAux('operations', 'lost-response'), settings: await OpenStillRecordStore.getAux('meta', 'settings') }));
  assert.equal(result.loaded.monitors.length, 1);
  assert.equal(result.loaded.generation, 1);
  assert.equal(result.receipt.result.imported, 1);
  assert.equal(result.settings.soundEnabled, false);
});

test('corrupt current records fall back independently and retain null/container originals', { skip: !chromium }, async (t) => {
  const { page } = await fixture(t);
  const result = await page.evaluate(async () => {
    const store = OpenStillRecordStore;
    await store.commit({ changed: [makeRecord('a'), makeRecord('b')], generation: 1 });
    await store.commit({ changed: [makeRecord('a', 'NEW'), makeRecord('b', 'NEW')], generation: 2 });
    const damaged = await store.getAux('monitors', 'a'); damaged.record.name = 'CORRUPT';
    await store.putAux('monitors', 'a', damaged); await store.putAux('monitors', 'b', null);
    const loaded = await store.load();
    await store.commit({ changed: [makeRecord('c')], recovery: loaded.recovery, generation: 3 });
    return { texts: loaded.monitors.map((monitor) => monitor.snapshot.text), originals: await store.allAux('recovery') };
  });
  assert.deepEqual(result.texts, ['OLD', 'OLD']);
  assert.equal(result.originals.find((entry) => entry.recordId === 'a').raw.record.name, 'CORRUPT');
  assert.equal(result.originals.find((entry) => entry.recordId === 'b').raw, null);
});

test('corrupt current snapshot bytes and missing generation metadata are preserved while prior content is recovered', { skip: !chromium }, async (t) => {
  const { page } = await fixture(t);
  const result = await page.evaluate(async () => {
    const store = OpenStillRecordStore;
    await store.commit({ changed: [makeRecord('a')], generation: 1 });
    await store.commit({ changed: [makeRecord('a', 'NEW')], generation: 2 });
    const current = await store.getAux('monitors', 'a');
    const raw = { json: '{"text":"손상된 원문', digest: 'broken' };
    await store.putAux('snapshots', current.record.snapshot.$snapshot, raw);
    await store.putAux('snapshotCopies', current.record.snapshot.$snapshot, raw);
    await store.deleteAux('meta', 'current');
    const loaded = await store.load();
    await store.commit({ changed: [], recovery: loaded.recovery, generation: 3 });
    return { loaded, raw, recovery: await store.allAux('recovery') };
  });
  assert.equal(result.loaded.monitors[0].snapshot.text, 'OLD');
  assert.equal(result.loaded.generation, 0);
  assert.deepEqual(result.recovery.find((entry) => entry.source === 'snapshots').raw, result.raw);
  assert.equal(result.recovery.find((entry) => entry.source === 'meta').raw, null);
});

test('ten thousand canonical records mutate one record without rewriting the list or immutable snapshot and retain capacity overflow for retry', { skip: !chromium, timeout: 60_000 }, async (t) => {
  const { page } = await fixture(t);
  const result = await page.evaluate(async () => {
    const records = Array.from({ length: 10_000 }, (_, index) => makeRecord('m' + index));
    await OpenStillRecordStore.commit({ changed: records, generation: 1 });
    await storageTest.getState();
    const writes = []; const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) { writes.push({ store: this.name, key, bytes: new TextEncoder().encode(JSON.stringify(value)).length }); return originalPut.call(this, value, key); };
    try { await storageTest.mutateMonitors((monitors) => { monitors.find((monitor) => monitor.id === 'm9999').unread = true; return { ok: true }; }); }
    finally { IDBObjectStore.prototype.put = originalPut; }
    const count = (await storageTest.getState()).monitors.length;
    const started = await storageTest.startImportSession({});
    await storageTest.appendImportSession({ id: started.id, monitors: [makeRecord('capacity-pending')] });
    const pending = await storageTest.finishImportSession({ id: started.id });
    const session = await OpenStillRecordStore.getAux('staging', 'import:' + started.id);
    await storageTest.mutateMonitors((monitors) => { monitors.splice(monitors.findIndex((monitor) => monitor.id === 'm0'), 1); return { ok: true }; });
    const retried = await storageTest.finishImportSession({ id: started.id, retry: true });
    return { count, writes, changed: (await OpenStillRecordStore.getAux('monitors', 'm9999')).record.unread,
      pending, phase: session.phase, staged: Boolean(await OpenStillRecordStore.getAux('staging', session.pendingCapacityIds[0].key)), retried,
      finalCount: (await storageTest.getState()).monitors.length };
  });
  assert.equal(result.count, 10_000);
  assert.equal(result.changed, true);
  assert.equal(result.writes.filter((entry) => entry.store === 'monitors').length, 1);
  assert.equal(result.writes.filter((entry) => entry.store === 'snapshots').length, 0);
  assert.ok(result.writes.reduce((total, entry) => total + entry.bytes, 0) < 20_000);
  assert.equal(result.pending.imported, 0);
  assert.equal(result.pending.recoveryPending, 1);
  assert.equal(result.pending.capacityRejected, 1);
  assert.equal(result.phase, 'partial');
  assert.equal(result.staged, true);
  assert.equal(result.retried.imported, 1);
  assert.equal(result.finalCount, 10_000);
});

test('import and export staging survive worker restart and commit replay does not duplicate records', { skip: !chromium }, async (t) => {
  const env = await fixture(t);
  const started = await env.page.evaluate(async () => { const started = await storageTest.startImportSession({}); await storageTest.appendImportSession({ id: started.id, monitors: [makeRecord('a')] }); return started; });
  await restart(env);
  const imported = await env.page.evaluate((id) => storageTest.finishImportSession({ id }), started.id);
  assert.equal(imported.imported, 1);
  await restart(env);
  const replayed = await env.page.evaluate((id) => storageTest.finishImportSession({ id }), started.id);
  assert.equal(replayed.replayed, true);
  const exported = await env.page.evaluate(() => storageTest.startExportSession({}));
  await restart(env);
  const output = await env.page.evaluate(async (id) => {
    const resumed = await storageTest.startExportSession({ resumeId: id }); const records = [];
    for (let index = 0; index < resumed.total; index += 1) records.push(JSON.parse((await storageTest.getExportMonitor({ id, index })).record));
    const monitor = records.find((record) => record._openStillMonitorRecord)?._openStillMonitorRecord;
    const blob = records.find((record) => record._openStillSnapshot?.id === monitor?.snapshot?.$snapshot)?._openStillSnapshot;
    return { resumed, monitor, snapshot: blob ? JSON.parse(blob.json) : null,
      digestVerified: blob ? await OpenStillRecordStore.digest(blob.json) === blob.id : false, count: (await storageTest.getState()).monitors.length };
  }, exported.id);
  assert.equal(output.resumed.resumed, true);
  assert.equal(output.monitor.id, 'a');
  assert.equal(output.snapshot.text, 'OLD');
  assert.equal(output.digestVerified, true);
  assert.equal(output.count, 1);
});

test('deleting unmigrated original records creates restorable trash with snapshot content', { skip: !chromium }, async (t) => {
  const { page } = await fixture(t);
  const result = await page.evaluate(async () => {
    await OpenStillRecordStore.commit({ changed: [], deletedIds: ['legacy'], deletedMonitors: [makeRecord('legacy')], generation: 1 });
    const trash = (await OpenStillRecordStore.allAux('recovery'))[0];
    return { trash, restored: await OpenStillRecordStore.unpack(trash.raw.record) };
  });
  assert.equal(result.trash.source, 'trash');
  assert.equal(result.restored.id, 'legacy');
  assert.equal(result.restored.snapshot.text, 'OLD');
});

test('a verified mirror recovers a shared snapshot across metadata generations and repairs primary atomically', { skip: !chromium }, async (t) => {
  const { page } = await fixture(t);
  const result = await page.evaluate(async () => {
    const store = OpenStillRecordStore;
    await store.commit({ changed: [makeRecord('a')], generation: 1 });
    await store.commit({ changed: [makeRecord('a', 'OLD', { name: 'new metadata' })], generation: 2 });
    const current = await store.getAux('monitors', 'a');
    const raw = { json: 'corrupt bytes 가', digest: 'broken' };
    await store.putAux('snapshots', current.record.snapshot.$snapshot, raw);
    const loaded = await store.load();
    await store.commit({ changed: [], recovery: loaded.recovery, generation: 3 });
    return { monitor: loaded.monitors[0], recovery: await store.allAux('recovery'),
      primary: await store.getAux('snapshots', current.record.snapshot.$snapshot), copy: await store.getAux('snapshotCopies', current.record.snapshot.$snapshot) };
  });
  assert.equal(result.monitor.name, 'new metadata');
  assert.equal(result.monitor.snapshot.text, 'OLD');
  assert.equal(result.recovery.find((entry) => entry.source === 'snapshots').raw.json, 'corrupt bytes 가');
  assert.deepEqual(result.primary, result.copy);
});

test('lazy loading keeps immutable references and metadata updates do not read or rewrite large blobs', { skip: !chromium }, async (t) => {
  const { page } = await fixture(t);
  const result = await page.evaluate(async () => {
    const store = OpenStillRecordStore;
    await store.commit({ changed: [makeRecord('a', '가'.repeat(400_000))], generation: 1 });
    const reads = []; const writes = [];
    const get = IDBObjectStore.prototype.get; const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.get = function (key) { reads.push(this.name); return get.call(this, key); };
    IDBObjectStore.prototype.put = function (value, key) { writes.push(this.name); return put.call(this, value, key); };
    let loaded;
    try {
      loaded = await store.load({ lazy: true });
      const packed = await store.stageMonitor({ ...loaded.monitors[0], name: 'updated' }, { allowReferences: true });
      await store.commit({ changed: [packed], generation: 2 });
    } finally { IDBObjectStore.prototype.get = get; IDBObjectStore.prototype.put = put; }
    return { loaded, reads, writes, full: await store.unpack(loaded.monitors[0]) };
  });
  assert.ok(result.loaded.monitors[0].snapshot.$snapshot);
  assert.equal(result.loaded.monitors[0].snapshot.text.length, 800);
  assert.equal(result.loaded.monitors[0].snapshot.exists, true);
  assert.equal(result.reads.includes('snapshots'), false);
  assert.equal(result.reads.includes('snapshotCopies'), false);
  assert.equal(result.writes.includes('snapshots'), false);
  assert.equal(result.full.snapshot.text.length, 400_000);
});

test('a version-one database upgrades and mirrors its existing immutable snapshot', { skip: !chromium }, async (t) => {
  const context = await browser.newContext(); t.after(() => context.close());
  const setup = await context.newPage();
  await setup.route('**/*', (route) => route.fulfill({ body: '<!doctype html>' }));
  await setup.goto('https://storage.example.test/');
  const seeded = await setup.evaluate(async () => {
    const json = JSON.stringify({ exists: true, text: 'legacy' });
    const id = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json)))].map((value) => value.toString(16).padStart(2, '0')).join('');
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('openstill-records', 1);
      request.onupgradeneeded = () => { for (const name of ['meta', 'monitors', 'snapshots', 'recovery', 'versions', 'staging', 'operations', 'jobs']) request.result.createObjectStore(name); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { const db = request.result; const tx = db.transaction('snapshots', 'readwrite'); tx.objectStore('snapshots').put({ json, digest: id }, id); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
    });
    return { id, json };
  });
  await setup.close();
  const page = await initPage(context);
  const copy = await page.evaluate((id) => OpenStillRecordStore.getAux('snapshotCopies', id), seeded.id);
  assert.equal(copy.json, seeded.json);
  assert.equal(copy.digest, seeded.id);
});

test('auxiliary batch exceptions abort earlier writes and future record schemas remain untouched', { skip: !chromium }, async (t) => {
  const { page } = await fixture(t);
  const result = await page.evaluate(async () => {
    const store = OpenStillRecordStore;
    let failed = false;
    try { await store.putAuxBatch('staging', [['first', { ok: true }], ['bad', { uncloneable: () => {} }]]); } catch { failed = true; }
    await store.commit({ changed: [makeRecord('future', 'unchanged', { schemaVersion: 99, enabled: true, extraFuture: { untouched: '🙂' } }), makeRecord('normal')], generation: 1 });
    const before = await store.getAux('monitors', 'future');
    await store.putAux('versions', 'normal', { malformed: 'preserve me' });
    const state = await storageTest.getState();
    await storageTest.mutateMonitors((monitors) => { monitors.find((monitor) => monitor.id === 'normal').name = 'changed'; return { ok: true }; });
    return { failed, first: await store.getAux('staging', 'first'), futureEnabled: state.monitors.find((monitor) => monitor.id === 'future').enabled,
      before, after: await store.getAux('monitors', 'future'), versionRecovery: (await store.allAux('recovery')).find((entry) => entry.source === 'versions'),
      futureRaw: (await store.allAux('recovery')).find((entry) => entry.source === 'future-schema') };
  });
  assert.equal(result.failed, true);
  assert.equal(result.first, undefined);
  assert.equal(result.futureEnabled, false);
  assert.deepEqual(result.after, result.before);
  assert.equal(result.versionRecovery.raw.malformed, 'preserve me');
  assert.deepEqual(result.futureRaw.raw, result.before);
});

test('staged bodies are compact and durable before activation, and auxiliary settings/receipt commits are atomic', { skip: !chromium }, async (t) => {
  const env = await fixture(t);
  const staged = await env.page.evaluate(async () => {
    const packed = await OpenStillRecordStore.stageMonitor(makeRecord('staged', '🙂가'.repeat(100_000)));
    await OpenStillRecordStore.putAux('staging', 'packed', packed);
    return { packed, current: await OpenStillRecordStore.getAux('meta', 'current'), monitors: await OpenStillRecordStore.allAux('monitors'),
      primaryCount: (await OpenStillRecordStore.allAux('snapshots')).length, copyCount: (await OpenStillRecordStore.allAux('snapshotCopies')).length };
  });
  assert.ok(staged.packed.snapshot.$snapshot);
  assert.equal(staged.packed.snapshot.text.length, 800);
  assert.equal(staged.current, undefined);
  assert.equal(staged.monitors.length, 0);
  assert.equal(staged.primaryCount, 1);
  assert.equal(staged.copyCount, 1);
  await restart(env);
  const result = await env.page.evaluate(async () => {
    const store = OpenStillRecordStore; const packed = await store.getAux('staging', 'packed');
    await store.commit({ changed: [packed], generation: 1 });
    await store.commitAux([['meta', 'settings', { soundEnabled: false }], ['operations', 'aux', { committed: true }]]);
    let failed = false;
    try { await store.commitAux([['meta', 'settings', { soundEnabled: true }], ['operations', 'bad', { uncloneable: () => {} }]]); } catch { failed = true; }
    return { full: await store.unpack((await store.load({ lazy: true })).monitors[0]), failed,
      settings: await store.getAux('meta', 'settings'), receipt: await store.getAux('operations', 'aux'), bad: await store.getAux('operations', 'bad') };
  });
  assert.equal(result.full.snapshot.text.length, 300_000);
  assert.equal(result.failed, true);
  assert.equal(result.settings.soundEnabled, false);
  assert.equal(result.receipt.committed, true);
  assert.equal(result.bad, undefined);
});

test('external reference-looking snapshot fields do not bypass body staging', { skip: !chromium }, async (t) => {
  const { page } = await fixture(t);
  const result = await page.evaluate(async () => {
    const record = makeRecord('external'); record.snapshot.$snapshot = 'a'.repeat(64); record.snapshot.previewVersion = 1;
    const packed = await OpenStillRecordStore.stageMonitor(record);
    return { packed, unpacked: await OpenStillRecordStore.unpack(packed) };
  });
  assert.notEqual(result.packed.snapshot.$snapshot, 'a'.repeat(64));
  assert.equal(result.unpacked.snapshot.text, 'OLD');
  assert.equal(result.unpacked.snapshot.$snapshot, undefined);
});

test('missing fragments remain staged and late fragments finish after worker restart', { skip: !chromium }, async (t) => {
  const env = await fixture(t);
  const started = await env.page.evaluate(async () => {
    const started = await storageTest.startImportSession({});
    const serialized = JSON.stringify(makeRecord('fragmented'));
    const middle = Math.floor(serialized.length / 2);
    await storageTest.appendImportSession({ id: started.id, monitors: [makeRecord('independent')] });
    await storageTest.appendImportFragments({ id: started.id, exportId: 'set', fragments: [{ recordId: 'fragmented', fragmentIndex: 0, fragmentCount: 2, payload: serialized.slice(0, middle) }] });
    const partial = await storageTest.finishImportSession({ id: started.id });
    return { id: started.id, last: serialized.slice(middle), partial };
  });
  assert.equal(started.partial.imported, 1);
  assert.equal(started.partial.recoveryPending, 1);
  await restart(env);
  const result = await env.page.evaluate(async ({ id, last }) => {
    await storageTest.appendImportFragments({ id, exportId: 'set', fragments: [{ recordId: 'fragmented', fragmentIndex: 1, fragmentCount: 2, payload: last }] });
    const finished = await storageTest.finishImportSession({ id, retry: true });
    return { finished, count: (await storageTest.getState()).monitors.length, session: await OpenStillRecordStore.getAux('staging', 'import:' + id) };
  }, started);
  assert.equal(result.finished.imported, 1);
  assert.equal(result.count, 2);
  assert.equal(result.finished.recoveryPending, 0);
  assert.equal(result.session.phase, 'committed');
});

test('session key discovery reads no staged payloads and handles Unicode prefixes', { skip: !chromium }, async (t) => {
  const { page } = await fixture(t);
  const result = await page.evaluate(async () => {
    const store = OpenStillRecordStore;
    await store.putAuxBatch('staging', [['import:one', { kind: 'import' }], ['import:two', { kind: 'import' }],
      ['record:one', { body: '가'.repeat(500_000) }], ['export:one', { kind: 'export' }],
      ['unicode:\uffff:a', {}], ['unicode:\uffff:b', {}], ['unicode:other', {}], ['\uffff:a', {}]]);
    const get = IDBObjectStore.prototype.get; const all = IDBObjectStore.prototype.getAll;
    const reads = [];
    IDBObjectStore.prototype.get = function (...args) { reads.push(this.name); return get.apply(this, args); };
    IDBObjectStore.prototype.getAll = function (...args) { reads.push(this.name); return all.apply(this, args); };
    try { return { imports: await store.keysAux('staging', { prefix: 'import:' }),
      unicode: await store.keysAux('staging', { prefix: 'unicode:\uffff' }), max: await store.keysAux('staging', { prefix: '\uffff' }), reads }; }
    finally { IDBObjectStore.prototype.get = get; IDBObjectStore.prototype.getAll = all; }
  });
  assert.deepEqual(result.imports, ['import:one', 'import:two']);
  assert.deepEqual(result.unicode, ['unicode:\uffff:a', 'unicode:\uffff:b']);
  assert.deepEqual(result.max, ['\uffff:a']);
  assert.deepEqual(result.reads, []);
});

test('native snapshot import preserves damaged originals atomically and rejects hash-valid invalid JSON', { skip: !chromium }, async (t) => {
  const { page } = await fixture(t);
  const result = await page.evaluate(async () => {
    const store = OpenStillRecordStore;
    const json = JSON.stringify({ text: 'restored body 가🙂', exists: true }); const id = await store.digest(json);
    const raw = { json: 'damaged primary 가', digest: 'bad' }; const copy = { bytes: 'damaged mirror 🙂' };
    await store.putAux('snapshots', id, raw); await store.putAux('snapshotCopies', id, copy);
    const session = await storageTest.startImportSession({});
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === 'snapshotCopies' && key === id) throw new DOMException('snapshot repair failure', 'DataCloneError');
      return put.call(this, value, key);
    };
    let failed = false;
    try { await storageTest.appendImportSession({ id: session.id, monitors: [{ _openStillSnapshot: { id, json } }] }); } catch { failed = true; }
    finally { IDBObjectStore.prototype.put = put; }
    const rollback = { primary: await store.getAux('snapshots', id), copy: await store.getAux('snapshotCopies', id), recovery: await store.allAux('recovery') };
    await storageTest.appendImportSession({ id: session.id, monitors: [{ _openStillSnapshot: { id, json } }] });
    const repairs = await store.allAux('recovery');
    await storageTest.appendImportSession({ id: session.id, monitors: [{ _openStillSnapshot: { id, json } }] });
    const invalid = '{ invalid snapshot 가'; const invalidId = await store.digest(invalid);
    const rejected = await storageTest.appendImportSession({ id: session.id, monitors: [{ _openStillSnapshot: { id: invalidId, json: invalid } }] });
    return { failed, raw, copy, rollback, repairs, primary: await store.getAux('snapshots', id), mirror: await store.getAux('snapshotCopies', id),
      repairedCount: repairs.length, afterReplay: (await store.allAux('recovery')).length, rejected,
      invalidBody: await store.getAux('snapshots', invalidId), invalidRaw: (await store.allAux('recovery')).find((entry) => entry.raw?._openStillSnapshot?.id === invalidId) };
  });
  assert.equal(result.failed, true);
  assert.deepEqual(result.rollback.primary, result.raw); assert.deepEqual(result.rollback.copy, result.copy);
  assert.deepEqual(result.rollback.recovery, []);
  assert.deepEqual(result.repairs.find((entry) => entry.source === 'snapshot-repair').raw, result.raw);
  assert.deepEqual(result.repairs.find((entry) => entry.source === 'snapshot-copy-repair').raw, result.copy);
  assert.deepEqual(result.primary, result.mirror);
  assert.equal(result.repairedCount, 2); assert.equal(result.afterReplay, 3);
  assert.equal(result.rejected.rejected, 1); assert.equal(result.invalidBody, undefined);
  assert.match(result.invalidRaw.raw._openStillSnapshot.json, /invalid snapshot/);
});
