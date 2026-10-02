'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let chromium;
try { ({ chromium } = require(process.env.OPENSTILL_PLAYWRIGHT_MODULE || 'playwright')); } catch { /* optional host runtime */ }
const root = path.resolve(__dirname, '..');
const dist = path.resolve(root, 'dist');

function removeProfile(profile) {
  const absolute = path.resolve(profile);
  if (!absolute.startsWith(dist + path.sep) || !path.basename(absolute).startsWith('extension-smoke-')) {
    throw new Error('Temporary extension profile escaped the verified workspace dist directory.');
  }
  fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

test('unpacked extension loads its dashboard and imports/exports native snapshot references through real runtime messages', {
  skip: !chromium || process.env.OPENSTILL_EXTENSION_SMOKE !== '1'
}, async (t) => {
  fs.mkdirSync(dist, { recursive: true });
  const candidates = (process.env.OPENSTILL_CHROMIUM_EXECUTABLE ? [process.env.OPENSTILL_CHROMIUM_EXECUTABLE] : [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ]).filter(fs.existsSync);
  const failures = [];
  let context; let worker; let profile; let loadedBrowser;
  for (const executablePath of candidates) {
    profile = fs.mkdtempSync(path.join(dist, 'extension-smoke-'));
    try {
      context = await chromium.launchPersistentContext(profile, {
        executablePath, headless: true, timeout: 12_000,
        ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages'],
        args: ['--disable-extensions-except=' + root, '--load-extension=' + root]
      });
      const matches = (value) => value.url().startsWith('chrome-extension://') && value.url().endsWith('/service-worker.js');
      worker = context.serviceWorkers().find(matches)
        || await context.waitForEvent('serviceworker', { predicate: matches, timeout: 6_000 });
      loadedBrowser = path.basename(executablePath);
      break;
    } catch (error) {
      failures.push(path.basename(executablePath) + ': ' + error.message.split('\n')[0]);
      await context?.close().catch(() => undefined); context = null;
      removeProfile(profile); profile = null;
    }
  }
  if (!context || !worker) {
    t.skip('Unpacked extension loading was unavailable; actual extension behavior was NOT verified. ' + failures.join(' | '));
    return;
  }
  t.after(async () => { await context.close(); removeProfile(profile); });
  t.diagnostic('Actual unpacked extension verified using ' + loadedBrowser + '; temporary profile under workspace dist.');
  const extensionId = new URL(worker.url()).hostname;
  assert.match(extensionId, /^[a-p]{32}$/);
  assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().name), 'OpenStill');
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('chrome-extension://' + extensionId + '/dashboard.html');
  await page.waitForFunction(() => globalThis.OpenStillDashboardCore && globalThis.OpenStillBackupIntegrity);
  const text = '한글🙂 snapshot '.repeat(1_000) + 'END';
  const result = await page.evaluate(async ({ text }) => {
    const send = async (message) => {
      const response = await chrome.runtime.sendMessage(message);
      if (!response?.ok) throw new Error(message.type + ': ' + JSON.stringify(response));
      return response;
    };
    const raw = { id: 'actual-extension-smoke', name: 'Actual extension smoke', schemaVersion: 1,
      url: 'https://example.test/extension-smoke', enabled: false, scheduleMode: 'manual', schedule: { type: 'manual', params: {} },
      locators: [{ type: 'css', expr: 'body', op: 'include', frameId: 0, framePath: [], fields: [{ type: 'text' }] }],
      snapshot: { exists: true, text, html: '<p>' + text + '</p>', items: [{ text, identity: { key: 'post:smoke' } }], captureVersion: 2 },
      history: [], labels: [], createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z' };
    const started = await send({ type: 'start-import-session' });
    const prepared = await send({ type: 'append-import-session', id: started.id, monitors: [raw] });
    const finished = await send({ type: 'finish-import-session', id: started.id });
    const state = await send({ type: 'get-state' });
    const monitor = state.monitors.find((value) => value.id === raw.id);
    if (!monitor) throw new Error('Imported monitor is absent from real runtime state.');
    const detail = await send({ type: 'get-monitor-detail', id: monitor.id });
    const exported = await send({ type: 'start-export-session' }); const transfer = [];
    for (let index = 0; index < exported.total; index += 1) {
      const record = await send({ type: 'get-export-monitor', id: exported.id, index });
      if (!record.record) throw new Error('Smoke record unexpectedly requires fragmentation.');
      transfer.push(JSON.parse(record.record));
    }
    await send({ type: 'finish-export-session', id: exported.id, completed: true });
    await send({ type: 'delete-monitor', id: monitor.id, expectedRevision: monitor.revision, operationId: crypto.randomUUID() });
    const roundtrip = await send({ type: 'start-import-session' });
    await send({ type: 'append-import-session', id: roundtrip.id, monitors: transfer });
    const restored = await send({ type: 'finish-import-session', id: roundtrip.id });
    const restoredState = await send({ type: 'get-state' }); const restoredMonitor = restoredState.monitors.find((value) => value.id === raw.id);
    const restoredDetail = await send({ type: 'get-monitor-detail', id: restoredMonitor.id });
    await send({ type: 'delete-monitor', id: restoredMonitor.id, expectedRevision: restoredMonitor.revision, operationId: crypto.randomUUID() });
    const finalState = await send({ type: 'get-state' });
    return { prepared, finished, enabled: monitor.enabled, scheduleMode: monitor.scheduleMode,
      originalText: detail.monitor?.snapshot?.text, exported, snapshot: transfer.find((value) => value._openStillSnapshot)?._openStillSnapshot,
      native: transfer.find((value) => value._openStillMonitorRecord)?._openStillMonitorRecord,
      restored, restoredText: restoredDetail.monitor?.snapshot?.text, finalCount: finalState.monitors.length };
  }, { text });
  assert.equal(result.prepared.prepared, 1); assert.equal(result.finished.imported, 1);
  assert.equal(result.enabled, false); assert.equal(result.scheduleMode, 'manual');
  assert.equal(result.originalText, text); assert.ok(result.snapshot?.json); assert.match(result.snapshot.id, /^[a-f0-9]{64}$/);
  assert.equal(result.native.snapshot.$snapshot, result.snapshot.id);
  assert.equal(result.restored.imported, 1); assert.equal(result.restoredText, text); assert.equal(result.finalCount, 0);
  await page.reload(); await page.waitForFunction(() => globalThis.OpenStillDashboardCore && globalThis.OpenStillBackupIntegrity);
  assert.deepEqual(errors, []);
});
