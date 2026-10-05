'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const serviceWorkerPath = path.join(__dirname, '..', 'service-worker.js');
const fullSource = fs.readFileSync(serviceWorkerPath, 'utf8');
const handlerBoundary = fullSource.indexOf('\nconst messageHandlers = {');
assert.ok(handlerBoundary > 0, 'service-worker test boundary was not found');
const testSource = `${fullSource.slice(0, handlerBoundary)}
globalThis.__openStillTest = {
  appendImportSession,
  finishImportSession,
  getExportMonitor,
  getState,
  mutateMonitors,
  persistNormalizedMonitorRepairs,
  startExportSession,
  startImportSession, checkpointExportSession, finishExportSession, getMonitorById, recoveryStatus, abortImportSession,
  exportMonitorRecordForTransfer, normalizeSnapshot, normalizeMonitor, snapshotsEqual, compareSnapshotIdentities, importMonitors, appendImportFragments, reusePageUrl, replaceSiteHost
};`;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function chromeMock(initial = {}, existingValues) {
  const localValues = existingValues || clone(initial);
  const sessionValues = {};
  const state = {
    failNextLocalSet: false, failNextCommit: false,
    localSetCalls: 0,
    failBadge: false,
    failAlarm: false
  };

  const storageArea = (values, countLocalSets = false) => ({
    async get(keys) {
      if (keys === null || keys === undefined) return clone(values);
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.map((key) => [key, clone(values[key])]));
    },
    async set(patch) {
      if (countLocalSets) {
        if (state.failNextCommit && Object.keys(patch).some((key) => key.startsWith('openStill.record-store.v1.monitors.'))) { state.failNextCommit = false; throw new Error('simulated storage failure'); }
        if (state.failNextLocalSet) {
          state.failNextLocalSet = false;
          throw new Error('simulated storage failure');
        }
        state.localSetCalls += 1;
      }
      for (const [key, value] of Object.entries(patch)) values[key] = clone(value);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
    async setAccessLevel() {}
  });

  const offscreenUrl = 'chrome-extension://test/offscreen.html';
  const chrome = {
    storage: {
      local: storageArea(localValues, true),
      session: storageArea(sessionValues)
    },
    runtime: {
      getURL: (resource) => `chrome-extension://test/${resource}`,
      getContexts: async () => [{ documentUrl: offscreenUrl }],
      sendMessage: async () => ({ ok: true })
    },
    offscreen: { createDocument: async () => undefined },
    action: {
      setBadgeBackgroundColor: async () => {
        if (state.failBadge) throw new Error('simulated badge failure');
      },
      setBadgeText: async () => {
        if (state.failBadge) throw new Error('simulated badge failure');
      }
    },
    alarms: {
      clear: async () => {
        if (state.failAlarm) throw new Error('simulated alarm failure');
        return true;
      },
      create: async () => {
        if (state.failAlarm) throw new Error('simulated alarm failure');
      }
    },
    tabs: {
      query: async () => [],
      get: async () => null,
      remove: async () => undefined,
      update: async () => undefined
    },
    scripting: { executeScript: async () => [] },
    notifications: { create: async () => undefined },
    windows: { create: async () => undefined },
    webNavigation: {}
  };

  return { chrome, localValues, sessionValues, state };
}

function harness(initial = {}, existingValues) {
  const mocks = chromeMock(initial, existingValues);
  const context = vm.createContext({
    chrome: mocks.chrome,
    crypto: webcrypto,
    URL,
    TextEncoder,
    TextDecoder,
    Blob,
    structuredClone, AbortController, atob, btoa,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console
  });
  for (const file of ['record-store.js', 'import-session.js', 'export-session.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, { filename: file });
  vm.runInContext(testSource, context, { filename: serviceWorkerPath });
  return { ...mocks, api: context.__openStillTest, store: context.OpenStillRecordStore };
}

function monitor(overrides = {}) {
  return {
    id: 'monitor-1',
    revision: 'revision-1',
    name: 'Example',
    url: 'https://example.com/page',
    locators: [{ type: 'css', expr: 'body', op: 'include' }],
    tracking: {},
    labels: [],
    schedule: { type: 'manual', params: {} },
    scheduleMode: 'manual',
    enabled: false,
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
    history: [],
    runs: [],
    status: 'needs-baseline',
    ...overrides
  };
}

test('partial recovery restores healthy records and preserves invalid originals', async () => {
  const env = harness({ 'openStill.monitors.v2': [monitor({ id: 'existing' })] });
  const started = await env.api.startImportSession({ mode: 'merge' });
  await env.api.appendImportSession({ id: started.id, monitors: [null, monitor({ id: 'new' })] });
  const finished = await env.api.finishImportSession({ id: started.id, requireAllValid: true });
  assert.equal(finished.ok, true); assert.equal(finished.imported, 1); assert.equal(finished.rejected, 1);
  assert.equal((await env.api.getState()).monitors.length, 2);
  assert.ok(Object.values(env.localValues).some((entry) => entry?.source === 'import-record' && entry.raw === null));
});

test('invalid replace preserves existing data; explicit empty replace keeps a trash record', async () => {
  const env = harness({ 'openStill.monitors.v2': [monitor()] });
  const result = await env.api.importMonitors({ mode: 'replace', monitors: [null] });
  assert.equal(result.ok, false); assert.equal(result.reason, 'empty-recovery');
  assert.equal((await env.api.getState()).monitors.length, 1);
  const cleared = await env.api.importMonitors({ mode: 'replace', monitors: [], explicitEmpty: true });
  assert.equal(cleared.committed, true); assert.equal((await env.api.getState()).monitors.length, 0);
  assert.ok(Object.values(env.localValues).some((entry) => entry?.source === 'trash'));
});

test('commit succeeds when derived badge or alarm state fails', async () => {
  const env = harness(); const started = await env.api.startImportSession({ mode: 'merge' });
  await env.api.appendImportSession({ id: started.id, monitors: [monitor()] });
  env.state.failBadge = true; env.state.failAlarm = true;
  const finished = await env.api.finishImportSession({ id: started.id });
  assert.equal(finished.committed, true); assert.ok(finished.finalizationWarnings >= 1);
  assert.equal((await env.api.getState()).monitors.length, 1);
});

test('failed commit retains prior records and persistent staging for retry', async () => {
  const env = harness({ 'openStill.monitors.v2': [monitor({ id: 'existing' })] });
  const started = await env.api.startImportSession({ mode: 'merge' });
  await env.api.appendImportSession({ id: started.id, monitors: [monitor({ id: 'new' })] });
  env.state.failNextCommit = true;
  await assert.rejects(env.api.finishImportSession({ id: started.id }), /simulated storage failure/);
  assert.equal((await env.api.getState()).monitors.length, 1);
  const restarted = harness({}, env.localValues);
  const finished = await restarted.api.finishImportSession({ id: started.id });
  assert.equal(finished.imported, 1); assert.equal((await restarted.api.getState()).monitors.length, 2);
  const replay = await restarted.api.finishImportSession({ id: started.id });
  assert.equal(replay.replayed, true); assert.equal((await restarted.api.getState()).monitors.length, 2);
});

test('same backup skips identical IDs and retains deterministic content conflicts', async () => {
  const env = harness();
  for (let index = 0; index < 3; index += 1) await env.api.importMonitors({ monitors: [monitor()] });
  assert.equal((await env.api.getState()).monitors.length, 1);
  for (let index = 0; index < 3; index += 1) await env.api.importMonitors({ monitors: [monitor({ name: 'conflicting content' })] });
  const records = (await env.api.getState()).monitors;
  assert.equal(records.length, 2); assert.equal(records[0].name, 'Example'); assert.equal(records[1].name, 'conflicting content');
  await env.api.importMonitors({ monitors: [monitor({ id: 'different-id' })] });
  assert.equal((await env.api.getState()).monitors.length, 3);
});

test('independent records commit even when fragments are incomplete, then resume missing pieces', async () => {
  const env = harness(); const started = await env.api.startImportSession({ mode: 'merge' });
  await env.api.appendImportSession({ id: started.id, monitors: [monitor()] });
  const json = JSON.stringify(monitor({ id: 'fragmented' })); const split = Math.floor(json.length / 2);
  await env.api.appendImportFragments({ id: started.id, exportId: 'set-a', fragments: [{ recordId: 'frag', fragmentIndex: 0, fragmentCount: 2, payload: json.slice(0, split) }] });
  const partial = await env.api.finishImportSession({ id: started.id });
  assert.equal(partial.imported, 1); assert.equal(partial.recoveryPending, 1);
  await env.api.appendImportFragments({ id: started.id, exportId: 'set-a', fragments: [{ recordId: 'frag', fragmentIndex: 1, fragmentCount: 2, payload: json.slice(split) }] });
  const resumed = await env.api.finishImportSession({ id: started.id });
  assert.equal(resumed.imported, 1); assert.equal((await env.api.getState()).monitors.length, 2);
});

test('legacy container, invalid records, duplicate IDs and unknown fields survive unrelated mutations', async () => {
  const raw = { monitors: [monitor({ id: 'same', createdAt: 1e20, extensions: { future: 42 } }), monitor({ id: 'same' }), { id: 'bad', url: 'file://bad', payload: 'do not lose' }], unknown: 'container metadata' };
  const env = harness({ 'openStill.monitors.v2': raw });
  const before = await env.api.getState(); assert.equal(before.monitors.length, 2); assert.notEqual(before.monitors[0].id, before.monitors[1].id);
  assert.equal(env.state.localSetCalls, 0);
  await env.api.mutateMonitors((records) => { records[0].unread = false; records[0].labels = ['updated']; });
  assert.deepEqual(env.localValues['openStill.monitors.v2'], raw);
  assert.equal((await env.api.getState()).monitors[0].extensions.future, 42);
  assert.ok(Object.values(env.localValues).some((entry) => entry?.id === 'legacy-container' && entry.raw.unknown === 'container metadata'));
  const restarted = harness({}, env.localValues); assert.equal((await restarted.api.getState()).monitors.length, 2);
});

test('safe field repair preserves content and scans past broken histories and runs', () => {
  const env = harness();
  const record = env.api.normalizeMonitor(monitor({ createdAt: 1e20, enabled: 'false', locators: [null, { type: 'css', expr: '.good', op: 'include' }], schedule: { type: 'interval', params: { interval: 'broken' } },
    snapshot: { text: 'aggregate survives', items: [null, 'invalid'] }, history: [null, null, null, { snapshot: { text: 'late healthy' }, capturedAt: '2026-01-01' }], runs: Array.from({ length: 40 }, () => null).concat({ at: '2026-01-01', status: 'ok' }) }));
  assert.equal(record.enabled, false); assert.equal(record.scheduleMode, 'manual'); assert.equal(record.locators.length, 1);
  assert.equal(record.snapshot.text, 'aggregate survives'); assert.equal(record.snapshot.existsInferred, true);
  assert.equal(record.history.length, 1); assert.equal(record.runs.length, 1); assert.equal(record.createdAt, '1970-01-01T00:00:00.000Z');
  assert.ok(record.recoveryRepairs.some((field) => field.startsWith('createdAt:')));
});

test('snapshot boundaries keep original fingerprints and truncation through repeated reads and backups', async () => {
  const env = harness();
  const originals = [];
  for (const length of [999999, 1000000, 1000001]) {
    const original = env.api.normalizeSnapshot({ exists: true, text: '가'.repeat(length), data: '나'.repeat(length) });
    const again = env.api.normalizeSnapshot(env.api.normalizeSnapshot(original));
    assert.equal(again.textFingerprint, original.textFingerprint); assert.equal(again.dataFingerprint, original.dataFingerprint);
    assert.equal(again.textTruncated, length > 1000000); assert.equal(again.dataTruncated, length > 1000000);
    assert.equal(again.textOriginalLength, length); assert.equal(env.api.snapshotsEqual(original, again), true);
    originals.push({ length, snapshot: original });
  }
  await env.api.importMonitors({ monitors: originals.map((entry) => monitor({ id: 'boundary-' + entry.length, snapshot: entry.snapshot })) });
  await env.api.mutateMonitors((records) => { records[0].labels = ['unrelated change']; });
  const exported = await env.api.startExportSession(); const transfer = [];
  for (let index = 0; index < exported.total; index += 1) {
    const response = await env.api.getExportMonitor({ id: exported.id, index });
    assert.equal(typeof response.record, 'string'); transfer.push(JSON.parse(response.record));
  }
  const target = harness(); await target.api.importMonitors({ monitors: transfer });
  for (const entry of originals) {
    const restored = (await target.api.getMonitorById('boundary-' + entry.length)).snapshot;
    assert.equal(restored.textFingerprint, entry.snapshot.textFingerprint); assert.equal(restored.dataFingerprint, entry.snapshot.dataFingerprint);
    assert.equal(restored.textTruncated, entry.length > 1000000); assert.equal(restored.dataTruncated, entry.length > 1000000);
    assert.equal(restored.textOriginalLength, entry.length); assert.equal(env.api.snapshotsEqual(entry.snapshot, restored), true);
  }
  const uneven = env.api.normalizeSnapshot({ exists: true, items: [{ text: 'a'.repeat(700000) }, { text: 'tiny' }] });
  assert.equal(uneven.items[0].text.length, 700000); assert.equal(uneven.textTruncated, false);
  const legacy = env.api.normalizeSnapshot({ exists: true, text: 'stored prefix', textTruncated: true, textFingerprint: 'legacy-original', data: 'stored html', dataTruncated: true, dataFingerprint: 'legacy-data' });
  assert.equal(legacy.textFingerprint, 'legacy-original'); assert.equal(legacy.dataFingerprint, 'legacy-data');
});

test('stable item identity detects equal-title replacement and separates reordering', () => {
  const env = harness(); const snapshot = (ids) => env.api.normalizeSnapshot({ exists: true, items: ids.map((id) => ({ text: 'same title', identity: { key: 'post:' + id } })) });
  const old = snapshot(['B', 'C', 'D', 'E', 'F']);
  assert.equal(env.api.snapshotsEqual(old, snapshot(['A', 'B', 'C', 'D', 'E'])), false);
  assert.equal(env.api.snapshotsEqual(old, snapshot(['F', 'E', 'D', 'C', 'B'])), true);
  assert.equal(env.api.compareSnapshotIdentities(old, snapshot(['F', 'E', 'D', 'C', 'B'])).orderChanged, true);
});

test('export waits for queued mutation, includes original records, and resumes after restart', async () => {
  const env = harness({ 'openStill.monitors.v2': [monitor({ id: 'legacy' }), null] });
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const mutation = env.api.mutateMonitors(async (records) => { await gate; records.push(env.api.normalizeMonitor(monitor({ id: 'new' }))); });
  const exportStarted = env.api.startExportSession(); release(); await mutation;
  const session = await exportStarted; assert.equal(session.normalCount, 2); assert.ok(session.originalCount >= 2);
  const restarted = harness({}, env.localValues);
  const resumed = await restarted.api.startExportSession({ resumeId: session.id }); assert.equal(resumed.total, session.total);
  const transferred = [];
  for (let index = 0; index < session.total; index += 1) { const response = await restarted.api.getExportMonitor({ id: session.id, index }); assert.equal(response.ok, true); transferred.push(JSON.parse(response.record)); }
  assert.equal(transferred.filter((record) => record._openStillRecovery).length, session.originalCount);
  const target = harness(); const imported = await target.api.importMonitors({ monitors: transferred });
  assert.equal(imported.imported, 2); assert.equal((await target.api.getState()).monitors.length, 2);
});

test('history timestamp-only export explicitly marks omitted content', () => {
  const env = harness();
  const exported = env.api.exportMonitorRecordForTransfer({ history: [ { snapshot: { exists: true, text: 'latest' } }, { capturedAt: '2026-01-01', snapshot: { exists: true, text: 'older' } } ] });
  assert.equal(exported.history[0].snapshot.text, 'latest'); assert.equal(exported.history[1].snapshot.contentOmitted, true);
  const normalized = env.api.normalizeMonitor(monitor({ history: exported.history }));
  assert.equal(normalized.history[1].snapshot.contentOmitted, true);
});

test('address relocation preserves baseline, changes, read state, and history', async () => {
  const env = harness({ 'openStill.monitors.v2': [monitor({ snapshot: { exists: true, text: 'baseline' }, unread: true, lastChangedAt: '2026-01-01', lastViewedAt: '2025-01-01', history: [{ snapshot: { exists: true, text: 'baseline' } }] })] });
  const result = await env.api.reusePageUrl({ sourceUrl: 'https://example.com/page', targetUrl: 'https://new.example/page' });
  assert.equal(result.ok, true); const record = (await env.api.getState()).monitors[0];
  assert.equal(record.snapshot.text, 'baseline'); assert.equal(record.history.length, 1); assert.equal(record.unread, true); assert.equal(record.addressHistory[0].previousUrl, 'https://example.com/page');
});

test('guarded bulk host replacement preserves each monitor state and URL components', async () => {
  const sources = [
    monitor({ id: 'https-source', url: 'https://example.com/posts/one?q=%EA%B0%80#details', enabled: true, unread: true, status: 'changed', labels: ['보존'], tracking: { compareMode: 'text' }, snapshot: { exists: true, text: 'baseline' }, lastChange: { id: 'change-one', previous: { exists: true, text: 'before' }, current: { exists: true, text: 'baseline' } }, lastCheckedAt: '2026-10-01T01:00:00Z', lastChangedAt: '2026-10-01T01:00:00Z', lastViewedAt: '2026-09-30T01:00:00Z', history: [{ capturedAt: '2026-10-01T01:00:00Z', snapshot: { exists: true, text: 'baseline' } }], runs: [{ checkedAt: '2026-10-01T01:00:00Z', status: 'changed' }] }),
    monitor({ id: 'http-source', url: 'http://example.com/other?x=1&x=2#tail', labels: ['다른 라벨'], snapshot: { exists: true, text: 'other baseline' } }),
    monitor({ id: 'unrelated', url: 'https://elsewhere.test/untouched' })
  ];
  const env = harness({ 'openStill.monitors.v2': sources });
  const before = clone(await Promise.all(sources.map(({ id }) => env.api.getMonitorById(id))));
  const expectedRevisions = before.filter((item) => new URL(item.url).host === 'example.com').map(({ id, revision, url }) => ({ id, revision, url }));
  const result = await env.api.replaceSiteHost({ sourceHost: 'example.com', targetHost: 'new.example:8443', expectedRevisions });
  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  const after = clone(await Promise.all(sources.map(({ id }) => env.api.getMonitorById(id))));
  for (const original of before) {
    const current = after.find((item) => item.id === original.id);
    if (original.id === 'unrelated') {
      assert.deepEqual(current, original);
      continue;
    }
    const expectedUrl = new URL(original.url);
    expectedUrl.host = 'new.example:8443';
    assert.equal(current.url, expectedUrl.href);
    assert.notEqual(current.revision, original.revision);
    assert.deepEqual({ ...current, revision: original.revision, url: original.url, updatedAt: original.updatedAt }, original);
  }
});

test('bulk host replacement atomically refuses stale revisions and changed source groups', async (t) => {
  for (const change of ['revision', 'added', 'deleted', 'moved']) {
    await t.test(change, async () => {
      const sources = [monitor({ id: 'one' }), monitor({ id: 'two', url: 'http://example.com/second' }), monitor({ id: 'other', url: 'https://elsewhere.test/page' })];
      const env = harness({ 'openStill.monitors.v2': sources });
      const initial = clone((await env.api.getState()).monitors);
      const expectedRevisions = initial.filter((item) => new URL(item.url).host === 'example.com').map(({ id, revision, url }) => ({ id, revision, url }));
      await env.api.mutateMonitors((monitors) => {
        if (change === 'revision') monitors.find((item) => item.id === 'two').revision = 'new-revision';
        if (change === 'added') monitors.push(env.api.normalizeMonitor(monitor({ id: 'new-source', url: 'https://example.com/new' })));
        if (change === 'deleted') monitors.splice(monitors.findIndex((item) => item.id === 'two'), 1);
        if (change === 'moved') monitors.find((item) => item.id === 'two').url = 'https://elsewhere.test/moved';
      });
      const before = clone((await env.api.getState()).monitors);
      const result = await env.api.replaceSiteHost({ sourceHost: 'example.com', targetHost: 'new.example', expectedRevisions });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'conflict');
      assert.deepEqual(Array.from(result.conflictIds), [change === 'added' ? 'new-source' : 'two']);
      assert.deepEqual(clone((await env.api.getState()).monitors), before);
    });
  }
});

test('bulk host replacement retains support for callers without revision guards', async () => {
  const env = harness({ 'openStill.monitors.v2': [monitor(), monitor({ id: 'second', url: 'https://example.com/second' })] });
  const result = await env.api.replaceSiteHost({ sourceHost: 'example.com', targetHost: 'new.example' });
  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  assert.ok((await env.api.getState()).monitors.every((item) => new URL(item.url).host === 'new.example'));
});

test('v5 reference backup retains shared multibyte snapshots, settings and restart checkpoints', async () => {
  const body = '같은 본문🙂\n'.repeat(10000);
  const source = harness({ 'openStill.monitors.v2': [monitor({ id: 'one', snapshot: { exists: true, text: body, data: '<article>' + body + '</article>' } }), monitor({ id: 'two', snapshot: { exists: true, text: body, data: '<article>' + body + '</article>' } })], 'openStill.settings.v1': { soundEnabled: false } });
  const started = await source.api.startExportSession({ dashboardSort: { field: 'name', direction: 'asc' } });
  assert.equal(started.normalCount, 2); assert.equal(started.snapshotCount, 1);
  await source.api.checkpointExportSession({ id: started.id, progress: { nextIndex: 1, fragmentIndex: 0, partNumber: 2, manifest: ['previous'], exportId: 'frozen-set', exportedAt: '2026-10-02T00:00:00Z' } });
  const restarted = harness({}, source.localValues);
  const resumed = await restarted.api.startExportSession({ resumeId: started.id });
  assert.equal(resumed.progress.exportId, 'frozen-set'); assert.equal(resumed.progress.partNumber, 2);
  const records = [];
  for (let index = 0; index < started.total; index += 1) records.push(JSON.parse((await restarted.api.getExportMonitor({ id: started.id, index })).record));
  const target = harness(); const session = await target.api.startImportSession();
  // Reversed file selection leaves references pending until their blobs arrive.
  for (const record of records.toReversed()) await target.api.appendImportSession({ id: session.id, monitors: [record] });
  const result = await target.api.finishImportSession({ id: session.id });
  assert.equal(result.imported, 2); assert.equal(result.recoveryPending, 0);
  const first = await target.api.getMonitorById('one'); assert.equal(first.snapshot.text, body.trim());
  assert.equal(first.snapshot.data, '<article>' + body + '</article>');
  assert.deepEqual(clone(result.settings.dashboardSort), { field: 'name', direction: 'asc' });
  assert.equal((await target.api.getState()).settings.soundEnabled, false);
  await restarted.api.finishExportSession({ id: started.id, completed: false });
  assert.equal((await restarted.api.recoveryStatus()).sessions.find((entry) => entry.id === started.id).phase, 'paused');
  await restarted.api.finishExportSession({ id: started.id, completed: true });
  assert.equal(Object.keys(source.localValues).some((key) => key.startsWith('openStill.record-store.v1.staging.export:' + started.id + ':')), false);
});

test('out of order original file pieces and concurrent append requests survive session resume', async () => {
  const env = harness(); const session = await env.api.startImportSession();
  const raw = Buffer.from('원본🙂 damaged {json}', 'utf8'); const midpoint = Math.floor(raw.length / 2);
  const piece = (index) => ({ _openStillRecoveryFile: { id: 'source-file', name: 'original.json', chunkIndex: index, chunkCount: 2, base64: raw.subarray(index ? midpoint : 0, index ? raw.length : midpoint).toString('base64') } });
  await env.api.appendImportSession({ id: session.id, monitors: [piece(1)] });
  const partial = await env.api.finishImportSession({ id: session.id }); assert.equal(partial.recoveryPending, 1);
  await Promise.all([env.api.appendImportSession({ id: session.id, monitors: [piece(0), monitor({ id: 'first' })] }), env.api.appendImportSession({ id: session.id, monitors: [monitor({ id: 'second' })] })]);
  const restarted = harness({}, env.localValues); const result = await restarted.api.finishImportSession({ id: session.id, retry: true });
  assert.equal(result.imported, 2); assert.equal(result.recoveryPending, 0);
  const original = Object.values(env.localValues).find((entry) => entry?.id === 'source-file' && entry.raw instanceof Blob);
  assert.deepEqual(Buffer.from(await original.raw.arrayBuffer()), raw);
});

test('discarding a recovery session preserves prepared records and incomplete originals', async () => {
  const env = harness(); const session = await env.api.startImportSession();
  await env.api.appendImportSession({ id: session.id, monitors: [monitor()] });
  await env.api.appendImportFragments({ id: session.id, fragments: [{ recordId: 'partial', fragmentIndex: 0, fragmentCount: 2, payload: '{"original":' }] });
  const response = await env.api.abortImportSession({ id: session.id, discard: true }); assert.equal(response.ok, true);
  const entries = Object.values(env.localValues);
  assert.ok(entries.some((entry) => entry?.source === 'discarded-prepared' && entry.raw.monitor.id === 'monitor-1'));
  assert.ok(entries.some((entry) => entry?.source === 'discarded-fragment' && entry.raw.payload === '{"original":'));
  assert.equal((await env.api.recoveryStatus()).sessions.some((entry) => entry.id === session.id), false);
});

test('export includes a worker-terminated source file even before pause finalization', async () => {
  const env = harness(); const session = await env.api.startImportSession();
  const id = 'import-file:' + session.id + ':0'; const original = new Blob(['[{"complete":true},{"broken":']);
  await env.store.putAux('staging', id, { kind: 'import-file', id, sessionId: session.id, raw: original, source: 'interrupted.json', phase: 'parsing' });
  const exported = await env.api.startExportSession(); assert.equal(exported.originalCount, 1);
  const records = [];
  for (let index = 0; index < exported.total; index += 1) records.push(JSON.parse((await env.api.getExportMonitor({ id: exported.id, index })).record));
  const file = records.find((record) => record._openStillRecoveryFile)._openStillRecoveryFile;
  assert.equal(Buffer.from(file.base64, 'base64').toString(), await original.text());
});
