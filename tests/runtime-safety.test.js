'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const root = path.join(__dirname, '..');
const workerSource = fs.readFileSync(path.join(root, 'service-worker.js'), 'utf8');
const boundary = workerSource.indexOf('\nconst messageHandlers = {');
const initializeStart = workerSource.indexOf('\nfunction initialize(');
const initializeEnd = workerSource.indexOf('\nchrome.runtime.onInstalled.addListener', initializeStart);
const helpers = `
globalThis.api = { enqueueCaptureTask, checkMonitorWithCapture, getMonitors, getMonitorById, persistNormalizedMonitorRepairs, normalizeSnapshot, applySnapshotOutcome, scheduleNextAlarm, setMonitorEnabled, deleteMonitor, deleteMonitors, updateMonitorLabels, acknowledgeMonitor, saveMonitor, runMutationOperation, startLiveMonitor, stopLiveMonitor, initializeLiveSession, detachLiveSession, rememberLiveControlledTab, getLiveOwnedTabs, getRuntimeStatus, recoverRuntime, initialize, mutationConflict, batchMonitorIds, installLiveMutationObserver, removeLiveMutationObserver, reconcileRuntimeOwnership,
  setSession(id, value) { liveSessions.set(id, { frameIds: new Set([0]), rawTextByFrame: new Map(), ownedTab: true, ...value }); },
  getSession(id) { return liveSessions.get(id); },
  clearBackoff(id) { storageFailureBackoff.delete(id); storageUnavailableUntil = 0; if (storageRetryTimer !== null) { clearTimeout(storageRetryTimer); storageRetryTimer = null; } },
  setCapture(snapshot) { captureRenderedSnapshot = async () => normalizeSnapshot(snapshot); },
  putAux: putRuntimeAux, getAux: getRuntimeAux,
  currentQueue() { return { active: activeCaptures, pending: captureQueue.length, monitors: captureTasks.size }; }
};`;
function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function monitor(overrides = {}) {
  return { id: 'm1', revision: 'r1', name: 'Example', url: 'https://example.com/page', locators: [{ type: 'css', expr: 'body', op: 'include' }], tracking: {}, labels: [], schedule: { type: 'manual', params: {} }, scheduleMode: 'manual', enabled: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', history: [], runs: [], status: 'ok', ...overrides };
}
function harness(monitors = [], options = {}) {
  const local = { 'openStill.monitors.v2': clone(monitors) };
  const session = {};
  const tabs = new Map();
  const state = { failCommit: false, failBadge: false, failAlarm: false, failRemove: false, failRunningJob: false, failRuntimeCheckpoint: false, observerOk: true, created: 0, removed: [], alarms: new Map(), writes: [] };
  const storageArea = (values, isLocal) => ({
    async get(keys) { if (keys == null) return clone(values); return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, clone(values[key])])); },
    async set(patch) { if (isLocal && state.failCommit && Object.keys(patch).some((key) => key.startsWith('openStill.record-store.v1.monitors.'))) throw new Error('storage failed'); if (isLocal && state.failRunningJob && Object.values(patch).some((value) => value?.kind === 'capture' && value.stage === 'running')) { state.failRunningJob = false; throw new Error('job checkpoint failed'); } if (isLocal && state.failRuntimeCheckpoint && Object.hasOwn(patch, 'openStill.record-store.v1.meta.runtime.checkpoint')) { state.failRuntimeCheckpoint = false; throw new Error('runtime checkpoint failed'); } for (const [key, value] of Object.entries(patch)) values[key] = clone(value); if (isLocal) state.writes.push(Object.keys(patch)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; }, async setAccessLevel() {}
  });
  const event = { addListener() {}, removeListener() {} };
  const chrome = {
    storage: { local: storageArea(local, true), session: storageArea(session, false) },
    runtime: { getURL: (resource) => 'chrome-extension://test/' + resource, getContexts: async () => [{ documentUrl: 'chrome-extension://test/offscreen.html' }], sendMessage: async () => ({ ok: true }) },
    offscreen: { createDocument: async () => undefined },
    action: { setBadgeBackgroundColor: async () => { if (state.failBadge) throw new Error('badge failed'); }, setBadgeText: async () => undefined },
    alarms: { clear: async (name) => { state.alarms.delete(name); return true; }, create: async (name, value) => { if (state.failAlarm) throw new Error('alarm failed'); state.alarms.set(name, value); } },
    tabs: { async create(props) { const tab = { id: ++state.created, status: 'complete', ...props }; tabs.set(tab.id, tab); return clone(tab); }, async get(id) { if (!tabs.has(id)) throw new Error('no tab'); return clone(tabs.get(id)); }, async query() { return [...tabs.values()].map(clone); }, async remove(id) { if (state.failRemove) throw new Error('remove failed'); tabs.delete(id); state.removed.push(id); }, async update(id, patch) { const tab = tabs.get(id); if (!tab) throw new Error('no tab'); Object.assign(tab, patch); return clone(tab); }, onUpdated: event, onRemoved: event },
    scripting: { async executeScript(details) { return (details.target.frameIds || [0]).map((frameId) => ({ frameId, result: { ok: state.observerOk } })); } },
    webNavigation: {}, notifications: { create: async () => undefined }, windows: { create: async () => undefined }, permissions: { getAll: async () => ({ origins: [] }), remove: async () => true }
  };
  const context = vm.createContext({ chrome, crypto: webcrypto, URL, TextEncoder, TextDecoder, Blob, structuredClone, AbortController, setTimeout: options.fastWatchdog ? (fn, ms, ...args) => setTimeout(fn, ms === 10_000 ? 10 : ms, ...args) : setTimeout, clearTimeout, setInterval, clearInterval, console });
  for (const file of ['record-store.js', 'import-session.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  vm.runInContext(workerSource.slice(0, boundary) + workerSource.slice(initializeStart, initializeEnd) + helpers, context, { filename: 'service-worker.js' });
  return { api: context.api, local, session, tabs, state, context, async ready() { await context.api.getMonitors(); await context.api.persistNormalizedMonitorRepairs(); } };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('matched empty fields report an empty-content review and preserve the last baseline', async () => {
  const env = harness([monitor({ snapshot: { exists: true, text: 'previous title', matchCount: 1 } })]);
  await env.ready();
  const result = await env.api.checkMonitorWithCapture('m1', () => env.api.normalizeSnapshot({
    exists: false, matchCount: 1, text: '', html: '<a title="current title" href="/post/2"></a>',
    selectorMatches: [{ type: 'css', expr: 'a', op: 'include', matchCount: 1 }],
    evidenceHtml: '<html><body>current title</body></html>'
  }), { reschedule: false });
  assert.equal(result.ok, true);
  assert.equal(result.needsReview, true);
  assert.equal(result.reason, 'selection-content-empty');
  assert.match(result.message, /요소는 찾았지만/);
  assert.match(result.message, /title·aria-label·href/);
  const stored = await env.api.getMonitorById('m1');
  assert.equal(stored.lastError, result.message);
  assert.equal(stored.snapshot.text, 'previous title');
  assert.equal(stored.lastErrorSnapshot.matchCount, 1);
  assert.equal(stored.runs[0].code, 'selection-content-empty');

  const missing = env.api.applySnapshotOutcome(monitor(), env.api.normalizeSnapshot({
    exists: false, matchCount: 0, text: '', selectorMatches: [{ type: 'css', expr: 'a', op: 'include', matchCount: 0 }]
  }), '2026-10-06T01:00:00Z');
  assert.equal(missing.reason, 'selection-empty');
  const allowEmpty = monitor({ tracking: { allowEmpty: true } });
  const allowed = env.api.applySnapshotOutcome(allowEmpty, env.api.normalizeSnapshot({ exists: false, matchCount: 1, text: '' }), '2026-10-06T01:00:00Z');
  assert.equal(allowed.needsReview, false);
  assert.equal(allowEmpty.lastError, null);
});

test('manual, batch, scheduler and live share six permits and two per origin', async () => {
  const env = harness();
  let active = 0, maximum = 0;
  const origins = new Map(); const maximums = new Map(); const gates = [];
  const work = Array.from({ length: 24 }, (_, index) => {
    const origin = 'https://site' + (index % 4) + '.example';
    return env.api.enqueueCaptureTask('queue-' + index, origin + '/page', ['manual', 'batch', 'scheduled', 'live'][index % 4], async () => {
      active += 1; maximum = Math.max(maximum, active);
      origins.set(origin, (origins.get(origin) || 0) + 1); maximums.set(origin, Math.max(maximums.get(origin) || 0, origins.get(origin)));
      await new Promise((resolve) => gates.push(resolve));
      active -= 1; origins.set(origin, origins.get(origin) - 1); return { ok: true };
    });
  });
  for (let rounds = 0; rounds < 100; rounds += 1) { await tick(); gates.splice(0).forEach((resolve) => resolve()); if (rounds > 0 && !env.api.currentQueue().monitors) break; }
  await Promise.all(work);
  assert.equal(maximum, 6);
  assert.ok([...maximums.values()].every((value) => value <= 2));
  assert.ok(env.state.writes.every((keys) => !keys.some((key) => key === 'openStill.monitors.v2')));
});

test('concurrent queue submissions for one monitor have one underlying capture', async () => {
  const env = harness(); let calls = 0; let release;
  const first = env.api.enqueueCaptureTask('same', 'https://example.com/', 'manual', async () => { calls += 1; await new Promise((resolve) => { release = resolve; }); return { ok: true }; });
  const second = env.api.enqueueCaptureTask('same', 'https://example.com/', 'live', async () => { calls += 1; return { ok: true }; });
  await tick();
  assert.equal((await second).reason, 'checking');
  release(); await first;
  assert.equal(calls, 1);
});

test('a failed live commit does not advance dedupe; the same capture can retry', async () => {
  const env = harness([monitor({ tracking: { live: true }, snapshot: { exists: true, text: 'OLD', capturedAt: '2026-01-01T00:00:00Z' } })]); await env.ready();
  env.api.setSession('m1', { tabId: 1, revision: 'r1' }); env.state.failCommit = true;
  const capture = () => env.api.normalizeSnapshot({ exists: true, text: 'NEW', capturedAt: '2026-01-02T00:00:00Z' });
  const failed = await env.api.checkMonitorWithCapture('m1', capture, { source: 'live', liveTabId: 1, reschedule: false });
  assert.equal(failed.ok, false); assert.equal(env.api.getSession('m1').rawTextByFrame.size, 0); assert.equal((await env.api.getMonitorById('m1')).snapshot.text, 'OLD');
  env.state.failCommit = false;
  const retried = await env.api.checkMonitorWithCapture('m1', capture, { source: 'live', liveTabId: 1, reschedule: false });
  assert.equal(retried.ok, true); assert.equal(retried.changed, true); assert.equal((await env.api.getMonitorById('m1')).snapshot.text, 'NEW');
});

test('live data mode notices a link-only change with identical visible text', async () => {
  const env = harness([monitor({ tracking: { live: true, dataAttr: 'data' }, snapshot: { exists: true, text: 'same', data: '<a href="old">same</a>' } })]); await env.ready(); env.api.setSession('m1', { tabId: 1, revision: 'r1' });
  const capture = () => env.api.normalizeSnapshot({ exists: true, text: 'same', data: '<a href="new">same</a>' });
  const result = await env.api.checkMonitorWithCapture('m1', capture, { source: 'live', reschedule: false });
  assert.equal(result.changed, true);
});

test('pause and deletion storage failures leave the running live session intact', async () => {
  for (const action of ['pause', 'delete']) {
    const env = harness([monitor({ tracking: { live: true } })]); await env.ready(); env.api.setSession('m1', { tabId: 1, revision: 'r1' }); env.state.failCommit = true;
    await assert.rejects(action === 'pause' ? env.api.setMonitorEnabled({ id: 'm1', enabled: false }) : env.api.deleteMonitor('m1'), /storage failed/);
    assert.ok(env.api.getSession('m1')); assert.equal((await env.api.getMonitorById('m1')).enabled, true); assert.equal(env.state.removed.length, 0);
  }
});

test('commit success with badge or alarm failure returns committed warnings', async () => {
  const env = harness([monitor()]); await env.ready(); env.state.failBadge = true; env.state.failAlarm = true;
  const result = await env.api.deleteMonitor('m1');
  assert.equal(result.ok, true); assert.equal(result.committed, true); assert.ok(result.warnings.some((warning) => warning.step === 'badge')); assert.equal(await env.api.getMonitorById('m1'), null);
});

test('stale edit revision and stale change acknowledgment leave newer data intact', async () => {
  const env = harness([monitor({ unread: true, lastChange: { id: 'new-change', detectedAt: '2026-01-02T00:00:00Z' } })]); await env.ready();
  const edit = await env.api.saveMonitor({ id: 'm1', name: 'overwrite', expectedRevision: 'old' });
  const acknowledgment = await env.api.acknowledgeMonitor('m1', { expectedChangeId: 'old-change' });
  assert.equal(edit.reason, 'conflict'); assert.equal(acknowledgment.reason, 'change-conflict'); assert.equal((await env.api.getMonitorById('m1')).unread, true);
});

test('one operation ID survives response loss and never repeats a deletion', async () => {
  const env = harness([monitor()]); await env.ready();
  const message = { type: 'delete-monitor', operationId: 'op-delete', id: 'm1' };
  const first = await env.api.runMutationOperation(message, () => env.api.deleteMonitor('m1'));
  const replay = await env.api.runMutationOperation(message, () => { throw new Error('must not run'); });
  assert.equal(first.committed, true); assert.equal(replay.ok, true); assert.equal(replay.replayed, true); assert.deepEqual(Array.from(replay.deletedIds), ['m1']);
});

test('bulk deletion handles 1,001 records and keeps stale or missing IDs explicit', async () => {
  const records = Array.from({ length: 1001 }, (_, index) => monitor({ id: 'm' + index })); const env = harness(records); await env.ready();
  const result = await env.api.deleteMonitors({ ids: [...records.map((entry) => entry.id), 'missing'], expectedRevisions: records.map((entry) => ({ id: entry.id, revision: entry.id === 'm1' ? 'stale' : entry.revision, url: entry.url })) });
  assert.equal(result.requested, 1002); assert.equal(result.deletedCount, 1000); assert.deepEqual(Array.from(result.conflictIds), ['m1']); assert.deepEqual(Array.from(result.missingIds), ['missing']); assert.equal((await env.api.getMonitors()).length, 1);
});

test('live tab starts are single flight and observers check result.ok', async () => {
  const env = harness([monitor({ tracking: { live: true } })]); await env.ready(); env.api.setCapture({ exists: true, text: 'baseline' });
  const [first, second] = await Promise.all([env.api.startLiveMonitor({ id: 'm1' }), env.api.startLiveMonitor({ id: 'm1' })]);
  assert.equal(first.ok, true); assert.equal(second.reused, true); assert.equal(env.state.created, 1);
  await env.api.stopLiveMonitor({ id: 'm1' });
  env.state.observerOk = false;
  const failed = await env.api.startLiveMonitor({ id: 'm1' });
  assert.equal(failed.ok, false); assert.match(failed.error, /설치 실패/); assert.equal(env.api.getSession('m1'), undefined);
});

test('failed tab removal retains a durable pendingCleanup owner', async () => {
  const env = harness([monitor({ tracking: { live: true } })]); await env.ready(); env.api.setCapture({ exists: true, text: 'baseline' }); await env.api.startLiveMonitor({ id: 'm1' }); env.state.failRemove = true;
  const result = await env.api.stopLiveMonitor({ id: 'm1' });
  assert.equal(result.ok, false); assert.equal(result.pendingCleanup, true); assert.equal((await env.api.getLiveOwnedTabs()).m1.stage, 'pendingCleanup');
});

test('a changed browser session never closes or reuses a candidate user tab', async () => {
  const env = harness([monitor({ tracking: { live: true } })]); await env.ready(); env.tabs.set(7, { id: 7, url: 'https://example.com/page', pinned: true, status: 'complete' }); env.local['openStill.live-controlled-tabs.v1'] = { m1: { tabId: 7, revision: 'r1', url: 'https://example.com/page', sessionId: 'previous-browser' } };
  const result = await env.api.startLiveMonitor({ id: 'm1' });
  assert.equal(result.reason, 'pending-cleanup'); assert.equal(env.state.created, 0); assert.equal(env.state.removed.length, 0);
});

test('replacing a failed alarm preserves the already armed alarm', async () => {
  const env = harness([monitor({ schedule: { type: 'interval', params: { interval: 3600 } }, scheduleMode: 'interval', lastCheckedAt: new Date().toISOString(), nextCheckAt: new Date(Date.now() + 3600_000).toISOString() })]); await env.ready(); env.state.alarms.set('openStill.next-check', { when: 1234 }); env.state.failAlarm = true;
  await assert.rejects(env.api.scheduleNextAlarm(), /alarm failed/); assert.equal(env.state.alarms.get('openStill.next-check').when, 1234);
});

test('watchdog cancels the job and keeps its lock until the underlying work ends', async () => {
  const env = harness([monitor({ tracking: { timeoutMilliseconds: 10_000 } })], { fastWatchdog: true }); await env.ready(); let resolveCapture;
  const job = { cancelled: false, async cancel() { this.cancelled = true; } };
  const result = await env.api.checkMonitorWithCapture('m1', () => new Promise((resolve) => { resolveCapture = resolve; }), { job, reschedule: false, source: 'live' });
  assert.equal(result.ok, false); assert.equal(job.cancelled, true); const repeated = await env.api.checkMonitorWithCapture('m1', () => env.api.normalizeSnapshot({ exists: true, text: 'new' }), { reschedule: false }); assert.equal(repeated.reason, 'checking');
  resolveCapture(env.api.normalizeSnapshot({ exists: true, text: 'late' })); await tick();
  assert.equal((await env.api.getMonitorById('m1')).snapshot, null);
});

test('initialization is singleton and badge failure does not prevent engine recovery', async () => {
  const env = harness(); env.state.failBadge = true;
  const first = env.api.initialize(); const second = env.api.initialize(); assert.equal(first, second);
  const result = await first; assert.ok(result.warnings.some((entry) => entry.step === 'badge')); assert.ok(env.state.alarms.has('openStill.runtime-recovery'));
});

test('a 10,000-monitor mixed queue never exceeds global or origin limits', async () => {
  const env = harness(); let active = 0, peak = 0, completed = 0; const activeOrigin = new Map(); let originPeak = 0;
  await Promise.all(Array.from({ length: 10_000 }, (_, index) => {
    const origin = 'https://origin' + index % 17 + '.example';
    return env.api.enqueueCaptureTask('large-' + index, origin + '/', ['manual', 'scheduled', 'live'][index % 3], async () => {
      active += 1; peak = Math.max(peak, active); activeOrigin.set(origin, (activeOrigin.get(origin) || 0) + 1); originPeak = Math.max(originPeak, activeOrigin.get(origin));
      await Promise.resolve(); active -= 1; activeOrigin.set(origin, activeOrigin.get(origin) - 1); completed += 1; return { ok: true };
    });
  }));
  assert.equal(completed, 10_000); assert.ok(peak <= 6); assert.ok(originPeak <= 2); assert.equal(env.api.batchMonitorIds(Array.from({ length: 10_000 }, (_, index) => 'm' + index)).length, 10_000);
});

test('an interrupted capture owner survives restart and is cleaned before resumption', async () => {
  const env = harness([monitor({ enabled: false })]); await env.ready(); env.session['openStill.runtime-session.v1'] = 'same-browser'; env.tabs.set(77, { id: 77, url: 'https://example.com/page', status: 'complete' });
  await env.api.putAux('jobs', 'capture.m1', { kind: 'capture', id: 'm1', source: 'manual', stage: 'loading', sessionId: 'same-browser', tabId: 77, createdAt: '2026-01-01T00:00:00Z' });
  await env.api.recoverRuntime({ startup: true });
  assert.deepEqual(env.state.removed, [77]); assert.equal(await env.api.getAux('jobs', 'capture.m1'), undefined);
});

test('a failed one-shot cleanup keeps its job as pendingCleanup', async () => {
  const env = harness(); env.state.failRemove = true; env.tabs.set(77, { id: 77, url: 'https://example.com/page', status: 'complete' });
  await env.api.enqueueCaptureTask('orphan', 'https://example.com/page', 'manual', async (job) => { await job.onTabCreated(77); return { ok: true }; });
  for (let index = 0; index < 10; index += 1) await tick();
  assert.equal((await env.api.getAux('jobs', 'capture.orphan')).stage, 'pendingCleanup');
  const retried = await env.api.enqueueCaptureTask('orphan', 'https://example.com/page', 'manual', async () => ({ ok: true })); assert.equal(retried.reason, 'pending-cleanup');
});

test('parallel live starts respect the resident limit', async () => {
  const records = Array.from({ length: 13 }, (_, index) => monitor({ id: 'live-' + index, tracking: { live: true } })); const env = harness(records); await env.ready(); env.api.setCapture({ exists: true, text: 'baseline' });
  const results = await Promise.all(records.map((entry) => env.api.startLiveMonitor({ id: entry.id })));
  assert.ok(env.state.created <= 12); assert.ok(results.some((result) => result.reason === 'resident-limit')); assert.ok((await env.api.getRuntimeStatus()).residentLiveTabs <= 12);
});

test('a label edit reconnects the observer under the new revision', async () => {
  const env = harness([monitor({ tracking: { live: true } })]); await env.ready(); env.api.setCapture({ exists: true, text: 'baseline' }); await env.api.startLiveMonitor({ id: 'm1' });
  await env.api.updateMonitorLabels({ ids: ['m1'], mode: 'add', label: 'test' }); const current = await env.api.getMonitorById('m1');
  assert.notEqual(current.revision, 'r1'); assert.equal(env.api.getSession('m1').revision, current.revision);
});

test('live observer watches arbitrary attributes plus input/change and property polling', () => {
  const env = harness(); const observed = []; const listeners = new Map();
  class Node {} Node.DOCUMENT_FRAGMENT_NODE = 11;
  class Element extends Node { constructor() { super(); this.localName = 'body'; } getAttribute() { return null; } querySelectorAll() { return []; } }
  env.context.Node = Node; env.context.Element = Element;
  env.context.MutationObserver = class { observe(node, options) { observed.push(options); } disconnect() {} };
  env.context.document = { documentElement: new Element(), addEventListener(name, listener) { listeners.set(name, listener); }, removeEventListener(name) { listeners.delete(name); } };
  env.context.addEventListener = () => undefined;
  const installed = env.api.installLiveMutationObserver('m1', 'r1', { propertyPolling: true });
  assert.equal(installed.ok, true); assert.equal(observed[0].attributes, true); assert.equal(Object.hasOwn(observed[0], 'attributeFilter'), false); assert.ok(listeners.has('input')); assert.ok(listeners.has('change'));
  env.api.removeLiveMutationObserver('m1'); assert.equal(listeners.size, 0);
});

test('explicit ownership adoption validates the shown pinned tab and reuses it', async () => {
  const env = harness([monitor({ tracking: { live: true } })]); await env.ready(); env.api.setCapture({ exists: true, text: 'baseline' }); env.tabs.set(7, { id: 7, url: 'https://example.com/page', pinned: true, status: 'complete' }); env.local['openStill.live-controlled-tabs.v1'] = { m1: { tabId: 7, revision: 'r1', url: 'https://example.com/page', sessionId: 'previous', stage: 'ownership-unverified' } };
  const wrong = await env.api.reconcileRuntimeOwnership({ monitorId: 'm1', tabId: 8, action: 'adopt' }); assert.equal(wrong.reason, 'conflict');
  const adopted = await env.api.reconcileRuntimeOwnership({ monitorId: 'm1', tabId: 7, expectedRevision: 'r1', action: 'adopt' }); assert.equal(adopted.ok, true); assert.equal(adopted.committed, true); assert.equal(env.state.created, 0); assert.equal(env.api.getSession('m1').tabId, 7);
});

test('ownership release leaves a candidate tab open and cleanup refuses changed URL', async () => {
  const env = harness([monitor({ tracking: { live: true } })]); await env.ready(); env.tabs.set(7, { id: 7, url: 'https://different.example/', pinned: true, status: 'complete' }); env.local['openStill.live-controlled-tabs.v1'] = { m1: { tabId: 7, revision: 'r1', url: 'https://example.com/page', sessionId: 'previous', stage: 'ownership-unverified' } };
  const clean = await env.api.reconcileRuntimeOwnership({ monitorId: 'm1', tabId: 7, action: 'retry-cleanup' }); assert.equal(clean.reason, 'ownership-mismatch');
  const released = await env.api.reconcileRuntimeOwnership({ monitorId: 'm1', tabId: 7, action: 'release' }); assert.equal(released.released, true); assert.ok(env.tabs.has(7)); assert.equal((await env.api.getLiveOwnedTabs()).m1, undefined);
});

test('a worker terminated after atomic commit can replay its stored result', async () => {
  const env = harness([monitor()]); await env.ready(); env.context.chrome.action.setBadgeBackgroundColor = () => new Promise(() => undefined);
  const message = { type: 'delete-monitor', id: 'm1', operationId: 'lost-response' };
  void env.api.runMutationOperation(message, () => env.api.deleteMonitor('m1'));
  let receipt;
  for (let index = 0; index < 100 && !receipt; index += 1) { await tick(); receipt = await env.api.getAux('operations', 'lost-response'); }
  assert.ok(receipt?.committed);
  const restarted = harness(); Object.assign(restarted.local, clone(env.local));
  const replay = await restarted.api.runMutationOperation(message, () => { throw new Error('must not reapply'); }); assert.equal(replay.committed, true); assert.equal(replay.replayed, true); assert.deepEqual(Array.from(replay.deletedIds), ['m1']);
});

test('failed running checkpoint and interrupted recovery keep a resumable job', async () => {
  const env = harness([monitor()]); await env.ready(); env.api.setCapture({ exists: true, text: 'recovered' }); env.state.failRunningJob = true;
  await assert.rejects(env.api.enqueueCaptureTask('m1', 'https://example.com/page', 'manual', async () => ({ ok: true })), /job checkpoint failed/);
  for (let index = 0; index < 10; index += 1) await tick(); assert.equal((await env.api.getAux('jobs', 'capture.m1')).stage, 'resumable'); env.api.clearBackoff('m1');
  env.state.failRuntimeCheckpoint = true; await assert.rejects(env.api.recoverRuntime({ startup: true }), /runtime checkpoint failed/); assert.equal((await env.api.getAux('jobs', 'capture.m1')).stage, 'resumable');
  await env.api.recoverRuntime({ startup: true });
  for (let index = 0; index < 100; index += 1) { await tick(); if ((await env.api.getMonitorById('m1')).snapshot?.text === 'recovered') break; }
  assert.equal((await env.api.getMonitorById('m1')).snapshot.text, 'recovered');
});

test('a global storage outage stops dispatch and reuses bounded pending captures', async () => {
  const records = Array.from({ length: 20 }, (_, index) => monitor({ id: 'outage-' + index, url: 'https://origin' + index % 5 + '.example/page' })); const env = harness(records); await env.ready(); env.state.failCommit = true; let captures = 0;
  const capture = () => { captures += 1; return env.api.normalizeSnapshot({ exists: true, text: 'observed' }); }; env.api.setCapture({ exists: true, text: 'observed' });
  const requests = records.map((entry) => env.api.enqueueCaptureTask(entry.id, entry.url, 'manual', (job) => env.api.checkMonitorWithCapture(entry.id, capture, { job, reschedule: false })));
  let status;
  for (let index = 0; index < 200; index += 1) { await tick(); status = await env.api.getRuntimeStatus(); if (!status.activeCaptures && status.pendingCaptureCount === 6) break; }
  assert.equal(captures, 6); assert.equal(status.queuedCaptures, 14); assert.equal(status.pendingCaptureCount, 6); assert.ok(status.pendingCaptureBytes <= status.pendingCaptureByteLimit); assert.ok(status.storageRetryAt);
  env.state.failCommit = false; records.forEach((entry) => env.api.clearBackoff(entry.id)); const checkpoint = await env.api.getAux('runtime', 'checkpoint'); await env.api.putAux('runtime', 'checkpoint', { ...checkpoint, backoff: {}, storageRetryAt: 0 });
  await env.api.recoverRuntime({ startup: true }); await Promise.all(requests);
  for (let index = 0; index < 200; index += 1) { await tick(); if (!env.api.currentQueue().monitors) break; }
  assert.equal((await env.api.getRuntimeStatus()).pendingCaptureCount, 0); assert.equal((await Promise.all(records.map((entry) => env.api.getMonitorById(entry.id)))).filter((entry) => entry.snapshot?.text === 'observed').length, 20);
});

test('startup live restoration can drain the shared queue without a recovery deadlock', async () => {
  const env = harness([monitor({ tracking: { live: true } })]); env.api.setCapture({ exists: true, text: 'live baseline' });
  const result = await env.api.initialize(); assert.equal(result.ok, true); assert.equal(env.api.getSession('m1').frameIds.size, 1); assert.equal(env.state.created, 1);
});
