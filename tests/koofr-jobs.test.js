'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '..', 'koofr-jobs.js'), 'utf8');
const credentialsKey = 'openStill.koofr.credentials.v1';
const stateKey = 'openStill.koofr.jobs.v1';
const alarmName = 'openstill-koofr';
const credentials = { email: 'test@example.test', appPassword: 'synthetic-password' };
const minute = 60_000;

function fixture() {
  let now = Date.parse('2026-11-09T00:00:00.000Z');
  class Clock extends Date {
    static now() { return now; }
  }

  const data = new Map();
  const alarms = new Map();
  const staging = new Map();
  const sent = [];
  const events = [];
  const storage = {
    async get(keys) { return Object.fromEntries(keys.map((key) => [key, structuredClone(data.get(key))])); },
    async set(values) {
      events.push({ type: 'set', keys: Object.keys(values) });
      for (const [key, value] of Object.entries(values)) data.set(key, structuredClone(value));
    },
    async setAccessLevel(value) { events.push({ type: 'access', value: structuredClone(value) }); }
  };
  const runtime = {
    id: 'test-extension',
    getURL(page) { return 'chrome-extension://' + this.id + '/' + page; },
    async sendMessage(message) {
      sent.push(structuredClone(message));
      return await fixtureApi.offscreen?.(message) || { ok: true };
    }
  };
  const functions = {
    startExportSession: async (...args) => { events.push({ type: 'prepare-export', args }); return { ok: true }; },
    finishExportSession: async (value) => { events.push({ type: 'finish-export', value }); return { ok: true }; },
    startImportSession: async (...args) => { events.push({ type: 'prepare-restore', args }); return { ok: true }; },
    abortImportSession: async (value) => { events.push({ type: 'abort-restore', value }); return { ok: true }; }
  };

  let context;
  function restart() {
    context = vm.createContext({
      chrome: { storage: { local: storage }, runtime, alarms: {
        async create(name, value) { alarms.set(name, structuredClone(value)); },
        async clear(name) { return alarms.delete(name); }
      } },
      crypto, Date: Clock, nowIso: () => new Date(now).toISOString(),
      ensureOffscreenDocument: async () => {},
      normalizeSettings: ({ dashboardSort }) => ({ dashboardSort: dashboardSort || 'default' }),
      OpenStillRecordStore: {
        keysAux: async (_store, { prefix }) => [...staging.keys()].filter((key) => key.startsWith(prefix)),
        getAux: async (_store, key) => staging.get(key)
      },
      ...functions
    });
    vm.runInContext(source, context);
  }
  function invoke(name, ...args) {
    context.testArgs = args;
    return vm.runInContext(name + '(...testArgs)', context);
  }

  const fixtureApi = {
    data, alarms, staging, sent, events, runtime, restart, invoke,
    now: () => now, advance: (delta) => { now += delta; },
    state: () => data.get(stateKey),
    status: () => invoke('koofrDashboardMessage', { type: 'koofr-status' }),
    dashboard: (type, options) => invoke('koofrDashboardMessage', { type, ...options }),
    jobMessage: (id, action, options) => invoke('handleKoofrRuntime', { id, action, ...options }),
    wake: () => invoke('wakeKoofr'),
    settled: () => vm.runInContext('koofrQueue', context),
    runs: () => sent.filter((entry) => entry.type === 'koofr-offscreen-run')
  };
  restart();
  return fixtureApi;
}

test('Koofr starts disabled and stores credentials separately under trusted-context access', async () => {
  const env = fixture();
  const initial = await env.status();
  assert.equal(initial.registered, false);
  assert.equal(initial.interval, 0);
  assert.equal(initial.keep, 0);
  await env.wake();
  assert.equal(env.alarms.size, 0);
  assert.equal(env.sent.length, 0);

  const registered = await env.dashboard('koofr-save', credentials);
  assert.equal(registered.registered, true);
  assert.equal(registered.emailHint, 't•••');
  assert.equal(env.alarms.size, 0);
  assert.deepEqual(env.events.slice(0, 2), [
    { type: 'access', value: { accessLevel: 'TRUSTED_CONTEXTS' } },
    { type: 'set', keys: [credentialsKey, stateKey] }
  ]);
  assert.equal(env.data.get(credentialsKey).appPassword, credentials.appPassword);
  assert.doesNotMatch(JSON.stringify([registered, env.state()]), /test@example\.test|synthetic-password|Authorization/);

  const deviceId = env.state().deviceId;
  const enabled = await env.dashboard('koofr-save', { interval: 60, keep: 3 });
  assert.equal(enabled.interval, 60);
  assert.equal(enabled.keep, 3);
  assert.equal(env.state().deviceId, deviceId);
  assert.equal(env.alarms.get(alarmName).when, env.now() + 60 * minute);
  assert.equal(env.sent.filter((message) => message.type === 'koofr-offscreen-probe').length, 1);
});

test('Koofr collapses overdue automatic runs and serializes them against manual backup', async () => {
  const env = fixture();
  await env.dashboard('koofr-save', { ...credentials, interval: 60 });
  env.advance(180 * minute);
  const [, , manual] = await Promise.all([
    env.wake(), env.wake(), env.dashboard('koofr-export')
  ]);
  assert.equal(manual.ok, false);
  assert.equal(env.state().nextDue, env.now() + 60 * minute);
  const { job } = env.state();
  assert.equal(job.automatic, true);
  assert.deepEqual(env.runs().map((message) => [message.job.id, message.alreadyStarted]), [[job.id, false], [job.id, true]]);
  assert.equal(env.alarms.get(alarmName).when, env.now() + minute);

  const part = { name: 'part-001.json', size: 24, sha256: 'a'.repeat(64) };
  assert.equal((await env.jobMessage(job.id, 'part', { partNumber: 1, part })).ok, true);
  assert.equal((await env.jobMessage(job.id, 'part', { partNumber: 1, part })).ok, true);
  assert.equal((await env.jobMessage(job.id, 'part', { partNumber: 1, part: { ...part, size: 25 } })).ok, false);
  assert.equal(env.state().job.parts.length, 1);
  assert.equal(env.state().lastSuccess, null);
  assert.equal((await env.jobMessage(job.id, 'published')).ok, true);
  assert.equal(env.state().lastSuccess.id, job.id);
  assert.equal((await env.jobMessage(job.id, 'complete')).ok, true);
  assert.equal(env.state().job, null);
  assert.equal(env.alarms.get(alarmName).when, env.now() + 60 * minute);
});

test('Koofr resumes the same job across scheduler restarts, honors Retry-After, and pauses bounded failures', async () => {
  const env = fixture();
  await env.dashboard('koofr-save', credentials);
  await env.dashboard('koofr-export');
  await env.settled();
  const id = env.state().job.id;
  const retryAt = env.now() + 5 * minute;
  const failure = { code: 'TRANSIENT', message: 'Temporary failure', retryAt };
  assert.equal((await env.jobMessage(id, 'failure', { failure })).ok, true);
  assert.equal(env.state().job.phase, 'retry');
  assert.equal(env.alarms.get(alarmName).when, retryAt);
  assert.equal(env.runs().length, 1);

  env.restart();
  await env.wake();
  assert.equal(env.runs().length, 1);
  env.advance(5 * minute);
  await env.wake();
  assert.equal(env.runs().at(-1).job.id, id);
  assert.equal(env.runs().at(-1).alreadyStarted, false);

  for (const expected of [2, 3]) {
    await env.jobMessage(id, 'failure', { failure });
    assert.equal(env.state().job.attempts, expected);
    assert.equal(env.state().job.phase, 'retry');
    env.advance(env.state().job.retryAt - env.now());
    await env.wake();
  }
  await env.jobMessage(id, 'failure', { failure });
  assert.equal(env.state().job.phase, 'paused');
  assert.equal(env.alarms.has(alarmName), false);
  assert.equal(env.state().lastFailure.message, failure.message);

  await env.dashboard('koofr-export');
  await env.settled();
  assert.equal(env.state().job.id, id);
  assert.equal(env.state().job.attempts, 0);
  await env.jobMessage(id, 'failure', { failure: { code: 'AUTH', message: 'Credentials expired' } });
  assert.equal(env.state().job.phase, 'paused');
  assert.equal((await env.status()).registered, true);
});

test('Koofr defers automatic backup during imports and removes credentials and local staging without a remote delete', async () => {
  const env = fixture();
  await env.dashboard('koofr-save', { ...credentials, interval: 60, keep: 3 });
  const deviceId = env.state().deviceId;
  env.advance(60 * minute);
  env.staging.set('import:local', { phase: 'staging', updatedAt: new Date(env.now()).toISOString() });
  await env.wake();
  assert.equal(env.state().job, null);
  assert.equal(env.alarms.get(alarmName).when, env.now() + minute);
  assert.equal(env.runs().length, 0);

  env.staging.clear();
  const restore = await env.dashboard('koofr-restore', { deviceId: 'other-device', backupId: 'existing-backup' });
  await env.settled();
  assert.equal(restore.job.kind, 'restore');
  const id = restore.job.id;
  await env.wake();
  assert.ok(env.runs().every((message) => message.job.id === id && message.job.kind === 'restore'));
  assert.equal((await env.dashboard('koofr-export')).ok, false);
  assert.equal((await env.jobMessage(id, 'prepare')).ok, true);
  assert.equal(env.events.find(({ type }) => type === 'prepare-restore').args[1].id, id);

  const removed = await env.dashboard('koofr-remove');
  assert.equal(removed.registered, false);
  assert.equal(removed.interval, 0);
  assert.equal(removed.keep, 0);
  assert.equal(env.data.get(credentialsKey), null);
  assert.equal(env.state().deviceId, deviceId);
  assert.equal(env.state().job, undefined);
  assert.equal(env.alarms.has(alarmName), false);
  assert.equal(env.sent.at(-1).type, 'koofr-offscreen-stop');
  assert.equal(env.events.find(({ type }) => type === 'abort-restore').value.id, id);
  assert.equal((await env.jobMessage(id, 'commit')).ok, false);
  assert.ok(env.sent.every(({ type }) => !type.includes('delete')));
});

test('Koofr rejects stale saves after a removal and only accepts messages from the intended extension page', async () => {
  const env = fixture();
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  let finishProbe;
  env.offscreen = (message) => message.type === 'koofr-offscreen-probe' && new Promise((resolve) => {
    finishProbe = resolve;
    ready();
  });
  const staleSave = env.dashboard('koofr-save', credentials);
  await started;
  await env.dashboard('koofr-remove');
  finishProbe({ ok: true });
  assert.equal((await staleSave).ok, false);
  assert.equal((await env.status()).registered, false);

  const verify = (url, options) => env.invoke('isKoofrSender', { url, id: env.runtime.id, frameId: 0, ...options }, 'dashboard.html');
  assert.equal(verify(env.runtime.getURL('dashboard.html') + '?source=test'), true);
  assert.equal(verify(env.runtime.getURL('offscreen.html')), false);
  assert.equal(verify(env.runtime.getURL('dashboard.html'), { frameId: 1 }), false);
  assert.equal(verify(env.runtime.getURL('dashboard.html'), { id: 'other-extension' }), false);
  assert.equal(verify('https://example.test/dashboard.html'), false);
});
