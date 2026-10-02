'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'service-worker.js'), 'utf8');
const boundary = source.indexOf('\nconst messageHandlers = {');
function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function harness(existing = {}) {
  const local = existing;
  const state = { failSnapshotRead: false };
  const area = (values) => ({
    async get(keys) {
      const requested = keys == null ? Object.keys(values) : Array.isArray(keys) ? keys : [keys];
      if (state.failSnapshotRead && keys != null && requested.some((key) => key.startsWith('openStill.record-store.v1.snapshots.'))) throw new Error('temporary outage');
      return Object.fromEntries(requested.map((key) => [key, clone(values[key])]));
    },
    async set(patch) { for (const [key, value] of Object.entries(patch)) values[key] = clone(value); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; },
    async setAccessLevel() {}
  });
  const chrome = {
    storage: { local: area(local), session: area({}) },
    runtime: { getURL: (name) => 'chrome-extension://test/' + name, getContexts: async () => [{ documentUrl: 'chrome-extension://test/offscreen.html' }] },
    action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {} },
    alarms: { create: async () => {}, clear: async () => true },
    tabs: { query: async () => [], get: async () => null, remove: async () => {}, update: async () => {} },
    scripting: { executeScript: async () => [] },
    permissions: { getAll: async () => ({ origins: ['https://example.com/*'] }) },
    notifications: { create: async () => {} }, webNavigation: {}
  };
  const context = vm.createContext({ chrome, crypto: webcrypto, URL, TextEncoder, TextDecoder, Blob, structuredClone, AbortController, atob, btoa, setTimeout, clearTimeout, setInterval, clearInterval, console });
  for (const file of ['record-store.js', 'import-session.js', 'export-session.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  vm.runInContext(source.slice(0, boundary) + '\nglobalThis.api = { normalizeMonitor, normalizeTracking, compareSnapshotIdentities, getMonitorById, getMonitorMetadataById, persistNormalizedMonitorRepairs, restoreRecoveryRecord, startExportSession, getExportMonitor };', context);
  return { local, state, api: context.api, store: context.OpenStillRecordStore };
}
const snapshot = (text) => ({ exists: true, matchCount: 1, text, capturedAt: '2026-01-01T00:00:00.000Z' });
const monitor = (extra = {}) => ({ id: 'm1', revision: 'r1', name: 'current config', url: 'https://example.com/page', enabled: true,
  schedule: { type: 'manual', params: {} }, locators: [{ type: 'css', expr: 'body' }], tracking: {}, history: [], runs: [], ...extra });
async function seed(env, record, generation = 1) {
  const staged = await env.store.stageMonitor(env.api.normalizeMonitor(record));
  await env.store.commit({ changed: [staged], deletedIds: [], recovery: [], generation });
  return env.store.getAux('monitors', record.id);
}
async function damage(env, reference) {
  await env.store.putAux('snapshots', reference.$snapshot, { json: '{broken primary', digest: reference.$snapshot });
  await env.store.putAux('snapshotCopies', reference.$snapshot, { json: '{broken copy', digest: reference.$snapshot });
}

test('identity frame scope uses durable URLs and iframe attributes, excluding order and frame ID', () => {
  const env = harness();
  const item = (id, index, attribute = 'posts', url = 'https://example.com/frame?category=1&session=a', volatile = []) => ({ identity: { key: 'post-17' }, text: 'same post',
    frame: { id, frameId: id, url, path: [{ url: 'https://example.com/page', index, element: { attribute: 'id', value: attribute } }] }, locator: { frameVolatileParameters: volatile } });
  const left = { items: [item(5, 0)] };
  assert.equal(env.api.compareSnapshotIdentities(left, { items: [item(40, 8)] }).equal, true);
  assert.equal(env.api.compareSnapshotIdentities(left, { items: [item(40, 8, 'comments')] }).equal, false);
  assert.equal(env.api.compareSnapshotIdentities(left, { items: [item(40, 8, 'posts', 'https://example.com/frame?category=2&session=a')] }).equal, false);
  const before = { items: [item(5, 0, 'posts', 'https://example.com/frame?category=1&session=a', ['session'])] };
  const after = { items: [item(9, 3, 'posts', 'https://example.com/frame?category=1&session=b', ['session'])] };
  assert.equal(env.api.compareSnapshotIdentities(before, after).equal, true);
});

test('nested extension fields survive canonical normalization without copying legacy monitor into tracking', () => {
  const env = harness();
  const value = env.api.normalizeMonitor(monitor({ extension: { top: true }, tracking: { allowEmpty: true, futureTracking: { flag: 1 } },
    schedule: { type: 'interval', futureSchedule: { flag: 2 }, params: { interval: 300, futureParam: { flag: 3 } } },
    locators: [{ type: 'css', expr: 'article', futureLocator: { flag: 4 }, fields: [{ type: 'attribute', name: 'href', futureField: { flag: 5 } }],
      framePath: [{ url: 'https://example.com/frame', index: 1, futureFrame: { flag: 6 }, element: { attribute: 'id', value: 'posts', futureElement: { flag: 7 } } }] }],
    snapshot: snapshot('baseline'), history: [{ kind: 'baseline', snapshot: snapshot('historic'), futureHistory: { flag: 8 } }],
    runs: [{ at: '2026-01-01T00:00:00Z', status: 'ok', futureRun: { flag: 9 } }],
    lastChange: { detectedAt: '2026-01-01T00:00:00Z', previous: snapshot('previous'), current: snapshot('current'), futureChange: { flag: 10 } }
  }));
  assert.equal(value.extension.top, true);
  for (const [object, key, number] of [[value.tracking, 'futureTracking', 1], [value.schedule, 'futureSchedule', 2], [value.schedule.params, 'futureParam', 3],
    [value.locators[0], 'futureLocator', 4], [value.locators[0].fields[0], 'futureField', 5], [value.locators[0].framePath[0], 'futureFrame', 6],
    [value.locators[0].framePath[0].element, 'futureElement', 7], [value.history[0], 'futureHistory', 8], [value.runs[0], 'futureRun', 9], [value.lastChange, 'futureChange', 10]]) assert.equal(object[key].flag, number);
  const legacy = env.api.normalizeMonitor({ ...monitor(), tracking: undefined, live: true, name: 'legacy', snapshot: snapshot('body'), extension: { huge: 'raw' } });
  assert.equal(legacy.tracking.live, true);
  assert.equal(Object.hasOwn(legacy.tracking, 'name'), false);
  assert.equal(Object.hasOwn(legacy.tracking, 'snapshot'), false);
  assert.equal(Object.hasOwn(legacy.tracking, 'extension'), false);
});

test('corrupted references are repaired independently and their primary and copy originals remain quarantined', async () => {
  const initial = harness();
  const envelope = await seed(initial, monitor({ snapshot: snapshot('broken baseline'), lastChange: { previous: snapshot('broken previous'), current: snapshot('healthy change'), futureChange: 1 },
    history: [{ snapshot: snapshot('broken baseline'), futureHistory: 2 }, { snapshot: snapshot('healthy history'), futureHistory: 3 }] }));
  await damage(initial, envelope.record.snapshot); await damage(initial, envelope.record.lastChange.previous);
  const env = harness(initial.local);
  const restored = await env.api.getMonitorById('m1');
  assert.equal(restored.enabled, false); assert.equal(restored.status, 'needs-review');
  assert.equal(restored.snapshot.text, 'healthy change'); assert.equal(restored.name, 'current config');
  assert.equal(restored.lastChange.previous.contentUnavailable, true); assert.equal(restored.lastChange.current.text, 'healthy change');
  assert.equal(restored.history[0].snapshot.contentUnavailable, true); assert.equal(restored.history[1].snapshot.text, 'healthy history');
  assert.equal(restored.history[0].futureHistory, 2); assert.equal(restored.lastChange.futureChange, 1);
  await env.api.persistNormalizedMonitorRepairs();
  const committed = await env.store.getAux('monitors', 'm1');
  const unpacked = await env.store.unpack(committed.record);
  assert.equal(unpacked.snapshot.text, 'healthy change'); assert.equal(unpacked.history[0].snapshot.contentUnavailable, true);
  const quarantined = await env.store.allAux('recovery');
  assert.ok(quarantined.some((record) => record.source === 'records' && record.raw.digest === envelope.digest));
  assert.ok(quarantined.some((record) => record.source === 'snapshots' && record.raw.json === '{broken primary' && record.copyRaw.json === '{broken copy'));
  const exporting = await env.api.startExportSession({});
  assert.equal(exporting.ok, true);
});

test('damaged optional history does not replace a healthy current baseline', async () => {
  const initial = harness(); const envelope = await seed(initial, monitor({ snapshot: snapshot('healthy baseline'), history: [{ snapshot: snapshot('broken history') }] }));
  await damage(initial, envelope.record.history[0].snapshot);
  const env = harness(initial.local); const restored = await env.api.getMonitorById('m1');
  assert.equal(restored.snapshot.text, 'healthy baseline'); assert.equal(restored.history[0].snapshot.contentUnavailable, true); assert.equal(restored.enabled, false);
  await env.api.persistNormalizedMonitorRepairs();
  assert.equal((await env.store.unpack((await env.store.getAux('monitors', 'm1')).record)).snapshot.text, 'healthy baseline');
});

test('older verified baseline recovery keeps the latest configuration', async () => {
  const initial = harness(); await seed(initial, monitor({ name: 'old configuration', snapshot: snapshot('older healthy') }));
  const envelope = await seed(initial, monitor({ revision: 'r2', name: 'new configuration', extension: { latest: true }, snapshot: snapshot('new broken') }), 2);
  await damage(initial, envelope.record.snapshot);
  const env = harness(initial.local); const restored = await env.api.getMonitorById('m1');
  assert.equal(restored.snapshot.text, 'older healthy'); assert.equal(restored.name, 'new configuration'); assert.equal(restored.revision, 'r2'); assert.equal(restored.extension.latest, true); assert.equal(restored.enabled, false);
});

test('irrecoverable baseline is nullable and remaining missing roles are exportable markers', async () => {
  const initial = harness(); const envelope = await seed(initial, monitor({ snapshot: snapshot('lost'), lastErrorSnapshot: snapshot('lost'), lastChange: { previous: snapshot('lost'), current: snapshot('lost') }, history: [{ snapshot: snapshot('lost') }] }));
  await damage(initial, envelope.record.snapshot);
  const env = harness(initial.local); const restored = await env.api.getMonitorById('m1');
  assert.equal(restored.snapshot, null); assert.equal(restored.lastErrorSnapshot.contentUnavailable, true); assert.equal(restored.lastChange.current.contentUnavailable, true);
  await env.api.persistNormalizedMonitorRepairs();
  await assert.doesNotReject(env.store.unpack((await env.store.getAux('monitors', 'm1')).record));
  assert.equal((await env.api.startExportSession({})).ok, true);
});

test('temporary snapshot read failures remain retryable without quarantine or disabling', async () => {
  const initial = harness(); await seed(initial, monitor({ snapshot: snapshot('healthy') }));
  const env = harness(initial.local); await env.api.getMonitorMetadataById('m1'); env.state.failSnapshotRead = true;
  await assert.rejects(env.api.getMonitorById('m1'), /temporary outage/);
  assert.equal((await env.api.getMonitorMetadataById('m1')).enabled, true);
  assert.equal((await env.store.allAux('recovery')).length, 0);
  env.state.failSnapshotRead = false; assert.equal((await env.api.getMonitorById('m1')).snapshot.text, 'healthy');
});

test('every recovery envelope source unpacks private snapshot refs before import', async () => {
  for (const source of ['records', 'trash', 'future-schema']) {
    const env = harness(); const envelope = await seed(env, monitor({ id: source, snapshot: snapshot('archived body') }));
    await env.store.putAux('recovery', 'source', { id: 'source', source, raw: envelope });
    await env.store.commit({ changed: [], deletedIds: [source], recovery: [], generation: 2 });
    const result = await env.api.restoreRecoveryRecord({ id: 'source' });
    assert.equal(result.ok, true, source);
    assert.equal((await env.api.getMonitorById(source)).snapshot.text, 'archived body');
  }
});
