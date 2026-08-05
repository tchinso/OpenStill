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
  startImportSession,
  exportMonitorRecordForTransfer
};`;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function chromeMock(initial = {}) {
  const localValues = clone(initial);
  const sessionValues = {};
  const state = {
    failNextLocalSet: false,
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

function harness(initial = {}) {
  const mocks = chromeMock(initial);
  const context = vm.createContext({
    chrome: mocks.chrome,
    crypto: webcrypto,
    URL,
    TextEncoder,
    TextDecoder,
    Blob,
    structuredClone,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console
  });
  vm.runInContext(testSource, context, { filename: serviceWorkerPath });
  return { ...mocks, api: context.__openStillTest };
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

test('strict native import rejects invalid data without touching storage', async () => {
  const existing = monitor({ id: 'existing' });
  const env = harness({ 'openStill.monitors.v2': [existing] });
  const started = await env.api.startImportSession({ mode: 'merge' });
  const appended = await env.api.appendImportSession({ id: started.id, monitors: [null] });
  const finished = await env.api.finishImportSession({ id: started.id, requireAllValid: true });

  assert.equal(appended.rejected, 1);
  assert.equal(finished.ok, false);
  assert.equal(finished.reason, 'invalid-backup');
  assert.equal(env.state.localSetCalls, 0);
  assert.equal(env.localValues['openStill.monitors.v2'].length, 1);
  assert.equal(env.localValues['openStill.monitors.v2'][0].id, 'existing');
});

test('strict native import rejects insufficient 5,000-item capacity atomically', async () => {
  const existing = Array.from({ length: 4_999 }, (_, index) => monitor({
    id: `existing-${index}`,
    url: `https://existing-${index}.example/page`
  }));
  const env = harness({ 'openStill.monitors.v2': existing });
  const started = await env.api.startImportSession({ mode: 'merge' });
  const appended = await env.api.appendImportSession({
    id: started.id,
    monitors: [
      monitor({ id: 'new-1', url: 'https://new-1.example/page' }),
      monitor({ id: 'new-2', url: 'https://new-2.example/page' })
    ]
  });
  const finished = await env.api.finishImportSession({ id: started.id, requireAllValid: true });

  assert.equal(appended.prepared, 1);
  assert.equal(appended.rejected, 1);
  assert.equal(finished.ok, false);
  assert.equal(finished.reason, 'capacity');
  assert.equal(env.state.localSetCalls, 0);
  assert.equal(env.localValues['openStill.monitors.v2'].length, 4_999);
});

test('a committed import stays successful when derived badge state fails', async () => {
  const env = harness({ 'openStill.monitors.v2': [] });
  const started = await env.api.startImportSession({ mode: 'merge' });
  const appended = await env.api.appendImportSession({ id: started.id, monitors: [monitor()] });
  env.state.failBadge = true;
  const finished = await env.api.finishImportSession({ id: started.id, requireAllValid: true });

  assert.equal(appended.prepared, 1);
  assert.equal(finished.ok, true);
  assert.equal(finished.committed, true);
  assert.ok(finished.finalizationWarnings >= 1);
  assert.equal(env.localValues['openStill.monitors.v2'].length, 1);
});

test('a rejected storage write leaves the prior data intact', async () => {
  const existing = monitor({ id: 'existing' });
  const env = harness({ 'openStill.monitors.v2': [existing] });
  const started = await env.api.startImportSession({ mode: 'merge' });
  await env.api.appendImportSession({ id: started.id, monitors: [monitor({ id: 'new' })] });
  env.state.failNextLocalSet = true;

  await assert.rejects(
    env.api.finishImportSession({ id: started.id, requireAllValid: true }),
    /simulated storage failure/
  );
  assert.equal(env.localValues['openStill.monitors.v2'].length, 1);
  assert.equal(env.localValues['openStill.monitors.v2'][0].id, 'existing');
});

test('getState is read-only and queued repair performs the legacy write', async () => {
  const legacy = monitor({
    schedule: { type: 'interval', params: { interval: 3_600 } },
    scheduleMode: 'interval',
    intervalHours: 1,
    enabled: true,
    nextCheckAt: null
  });
  const env = harness({ 'openStill.monitors.v2': [legacy] });

  const state = await env.api.getState();
  assert.ok(state.monitors[0].nextCheckAt);
  assert.equal(env.state.localSetCalls, 0);

  const repaired = await env.api.persistNormalizedMonitorRepairs();
  assert.equal(repaired, true);
  assert.equal(env.state.localSetCalls, 1);
  assert.ok(env.localValues['openStill.monitors.v2'][0].nextCheckAt);
});

test('export snapshot waits for an already queued mutation', async () => {
  const env = harness({ 'openStill.monitors.v2': [] });
  let releaseMutation;
  const mutationGate = new Promise((resolve) => { releaseMutation = resolve; });
  const mutation = env.api.mutateMonitors(async (monitors) => {
    await mutationGate;
    monitors.push(monitor());
  });
  const exportStarted = env.api.startExportSession();

  releaseMutation();
  await mutation;
  const session = await exportStarted;
  assert.equal(session.total, 1);
  assert.equal(env.api.getExportMonitor({ id: session.id, index: 0 }).ok, true);
});

test('export keeps the newest history snapshot and only timestamps older entries', () => {
  const env = harness();
  const exported = env.api.exportMonitorRecordForTransfer({
    history: [
      { kind: 'change', capturedAt: '2026-08-05T00:00:00.000Z', snapshot: { exists: true, text: 'latest' } },
      { kind: 'change', capturedAt: '2026-08-04T00:00:00.000Z', snapshot: { exists: true, text: 'older' } }
    ]
  });

  assert.equal(exported.history[0].snapshot.text, 'latest');
  assert.equal(exported.history[1].capturedAt, '2026-08-04T00:00:00.000Z');
  assert.deepEqual(Object.keys(exported.history[1].snapshot), ['exists']);
});

test('500 monitors complete through chunked staging and one storage commit', async () => {
  const env = harness({ 'openStill.monitors.v2': [] });
  const records = Array.from({ length: 500 }, (_, index) => monitor({
    id: `monitor-${index}`,
    url: `https://site-${index}.example/page`,
    name: `Site ${index}`
  }));
  const started = await env.api.startImportSession({ mode: 'merge' });
  for (let offset = 0; offset < records.length; offset += 100) {
    const appended = await env.api.appendImportSession({
      id: started.id,
      monitors: records.slice(offset, offset + 100)
    });
    assert.equal(appended.prepared, 100);
  }
  const finished = await env.api.finishImportSession({ id: started.id, requireAllValid: true });

  assert.equal(finished.ok, true);
  assert.equal(finished.imported, 500);
  assert.equal(finished.rejected, 0);
  assert.equal(env.state.localSetCalls, 1);
  assert.equal(env.localValues['openStill.monitors.v2'].length, 500);
});

test('300-monitor export/import round trip preserves latest content and older timestamps', async () => {
  const sourceRecords = Array.from({ length: 300 }, (_, index) => monitor({
    id: `roundtrip-${index}`,
    url: `https://roundtrip-${index}.example/page`,
    snapshot: { exists: true, text: `current ${index}`, capturedAt: '2026-08-05T00:00:00.000Z' },
    history: [
      {
        kind: 'change',
        capturedAt: '2026-08-05T00:00:00.000Z',
        snapshot: { exists: true, text: `latest ${index}`, capturedAt: '2026-08-05T00:00:00.000Z' }
      },
      {
        kind: 'change',
        capturedAt: '2026-08-04T00:00:00.000Z',
        snapshot: { exists: true, text: `older ${index}`, capturedAt: '2026-08-04T00:00:00.000Z' }
      }
    ],
    status: 'ok'
  }));
  const source = harness({ 'openStill.monitors.v2': sourceRecords });
  const exportSession = await source.api.startExportSession();
  const transferred = [];
  for (let index = 0; index < exportSession.total; index += 1) {
    const response = source.api.getExportMonitor({ id: exportSession.id, index });
    assert.equal(response.ok, true);
    assert.equal(response.fragmented, undefined);
    transferred.push(JSON.parse(response.record));
  }

  const target = harness({ 'openStill.monitors.v2': [] });
  const importSession = await target.api.startImportSession({ mode: 'merge' });
  for (let offset = 0; offset < transferred.length; offset += 100) {
    await target.api.appendImportSession({
      id: importSession.id,
      monitors: transferred.slice(offset, offset + 100)
    });
  }
  const finished = await target.api.finishImportSession({ id: importSession.id, requireAllValid: true });
  const restored = target.localValues['openStill.monitors.v2'];

  assert.equal(finished.imported, 300);
  assert.equal(restored.length, 300);
  assert.equal(restored[0].history[0].snapshot.text, 'latest 0');
  assert.equal(restored[0].history[1].capturedAt, '2026-08-04T00:00:00.000Z');
  assert.equal(restored[0].history[1].snapshot.text, '');
});
