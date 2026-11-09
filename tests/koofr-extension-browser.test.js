'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

let chromium;
try { ({ chromium } = require(process.env.OPENSTILL_PLAYWRIGHT_MODULE || 'playwright')); } catch { /* optional host browser */ }

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const dav = '/dav/Koofr';
const folder = dav + '/OpenStill';
const email = 'test@example.test';
const password = 'synthetic-koofr-extension-password';
const authorization = 'Basic ' + Buffer.from(email + ':' + password).toString('base64');
const credentialsKey = 'openStill.koofr.credentials.v1';
const stateKey = 'openStill.koofr.jobs.v1';
const slowPutDuration = 41_000;

async function until(read, label, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await read();
    if (result) return result;
    await delay(100);
  } while (Date.now() < deadline);
  assert.fail('Timed out waiting for ' + label);
}

async function webdavFixture() {
  const folders = new Set([dav]);
  const files = new Map([[dav + '/outside.json', Buffer.from('{"userFile":true}')]]);
  const requests = [];
  let slowPut;
  const server = http.createServer((request, response) => {
    void (async () => {
      const target = request.url.replace(/\/$/, '');
      if (target === '/fixture') {
        response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>OpenStill fixture</title>');
        return;
      }
      if (!target.startsWith(dav)) { response.writeHead(404).end(); return; }
      const method = request.method;
      const valid = request.headers.authorization === authorization && (target === folder || target.startsWith(folder + '/'));
      requests.push({ method, target, valid });
      const reply = (status, body, headers) => response.writeHead(status, headers).end(body);
      if (!valid) return reply(403);
      const parent = target.slice(0, target.lastIndexOf('/'));
      if (method === 'MKCOL') {
        if (folders.has(target)) return reply(405);
        if (!folders.has(parent)) return reply(409);
        folders.add(target);
        return reply(201);
      }
      if (method === 'PROPFIND') {
        if (!folders.has(target)) return reply(404);
        const members = request.headers.depth === '1' ? [...folders, ...files.keys()].filter((name) => name.slice(0, name.lastIndexOf('/')) === target) : [];
        const rows = [target, ...members].map((name) => `<d:response><d:href>${name}</d:href><d:propstat><d:prop><d:resourcetype>${folders.has(name) ? '<d:collection/>' : ''}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`);
        return reply(207, '<d:multistatus xmlns:d="DAV:">' + rows.join('') + '</d:multistatus>', { 'Content-Type': 'application/xml' });
      }
      if (method === 'PUT') {
        if (!folders.has(parent)) return reply(409);
        if (files.has(target)) return reply(412);
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        if (!slowPut && target.endsWith('/part-001.json')) {
          slowPut = { startedAt: Date.now(), target, size: body.length };
          await delay(slowPutDuration, undefined, { ref: false });
          slowPut.finishedAt = Date.now();
        }
        files.set(target, body);
        return reply(201);
      }
      if (method === 'GET') {
        const body = files.get(target);
        return body ? reply(200, body, { 'Content-Type': 'application/json', 'Content-Length': body.length }) : reply(404);
      }
      if (method === 'DELETE') return reply(files.delete(target) ? 204 : 404);
      return reply(405);
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    files, requests,
    slowPut: () => slowPut,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); })
  };
}

function copyExtension(directory, origin) {
  fs.mkdirSync(directory);
  // Keep the release allowlist in the loop so omitted Worker/HTML dependencies
  // fail the unpacked test as they would in the store package.
  const release = fs.readFileSync(path.join(root, 'package-release.ps1'), 'utf8');
  const list = /\$extensionFiles = @\(([\s\S]*?)\)/.exec(release)[1];
  for (const [, name] of list.matchAll(/'([^']+)'/g)) fs.copyFileSync(path.join(root, name), path.join(directory, name));
  fs.cpSync(path.join(root, 'icons'), path.join(directory, 'icons'), { recursive: true });
  const clientPath = path.join(directory, 'koofr-webdav.js');
  const client = fs.readFileSync(clientPath, 'utf8');
  const endpoint = "const ORIGIN = 'https://app.koofr.net';";
  assert.equal(client.split(endpoint).length, 2);
  fs.writeFileSync(clientPath, client.replace(endpoint, `const ORIGIN = '${origin}';`));
}

function runtime(page, type, fields) {
  return page.evaluate((message) => chrome.runtime.sendMessage(message), { type, ...fields });
}

test('unpacked Koofr auto backup survives a slow multipart PUT, dashboard close and service-worker restart, then restores through the UI', {
  skip: !chromium || process.env.OPENSTILL_EXTENSION_SMOKE !== '1', timeout: 180_000
}, async (t) => {
  const fixture = await webdavFixture();
  fs.mkdirSync(dist, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(dist, 'koofr-extension-smoke-'));
  let context;
  t.after(async () => {
    await context?.close();
    await fixture.close();
    const absolute = path.resolve(temporary);
    assert.equal(path.dirname(absolute), dist);
    assert.match(path.basename(absolute), /^koofr-extension-smoke-/);
    fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const extension = path.join(temporary, 'extension');
  copyExtension(extension, fixture.origin);
  const executablePath = process.env.OPENSTILL_CHROMIUM_EXECUTABLE || [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ].find((value) => fs.existsSync(value));
  context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
    headless: true, ...(executablePath ? { executablePath } : {}), timeout: 12_000,
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages'],
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]
  });
  const matches = (value) => /^chrome-extension:\/\/[a-p]{32}\/service-worker\.js$/.test(value.url());
  const worker = context.serviceWorkers().find(matches) || await context.waitForEvent('serviceworker', { predicate: matches, timeout: 8_000 });
  const dashboardUrl = new URL('dashboard.html', worker.url()).href;
  const observer = await context.newPage();
  await observer.goto(fixture.origin + '/fixture');
  const cdp = await context.newCDPSession(observer);
  const versions = new Map();
  cdp.on('ServiceWorker.workerVersionUpdated', (event) => {
    for (const version of event.versions) versions.set(version.versionId, version);
  });
  await cdp.send('ServiceWorker.enable');
  let dashboard = await context.newPage();
  const errors = [];
  dashboard.on('pageerror', (error) => errors.push(error.message));
  await dashboard.goto(dashboardUrl);
  await dashboard.locator('.runtime-summary #koofrSettings').waitFor();
  assert.equal(await dashboard.locator('#runtimeOwnership').isHidden(), true);
  assert.equal(await dashboard.locator('#koofrExport, #koofrImport').evaluateAll((nodes) => nodes.every((node) => node.hidden)), true);
  assert.equal(await dashboard.locator('#exportButton, #importButton').evaluateAll((nodes) => nodes.every((node) => !node.hidden)), true);
  await dashboard.locator('#koofrSettings').click();
  await dashboard.locator('#koofrEmail').fill(email);
  await dashboard.locator('#koofrPassword').fill(password);
  await dashboard.locator('#koofrSave').click();
  await dashboard.waitForFunction(() => !document.querySelector('#koofrRemove').hidden);
  assert.equal(await dashboard.locator('#koofrPassword').inputValue(), '');
  assert.equal(await dashboard.locator('#koofrInterval').inputValue(), '0');
  assert.equal(await dashboard.locator('#koofrRetention').inputValue(), '0');
  await dashboard.locator('#koofrInterval').selectOption('60');
  await dashboard.locator('#koofrSave').click();
  await until(async () => (await runtime(dashboard, 'koofr-status')).interval === 60, 'automatic interval saved');
  await dashboard.locator('#koofrSettingsDialog [aria-label="닫기"]').click();
  await dashboard.reload();
  await dashboard.locator('.header-actions #koofrExport').waitFor();
  assert.equal(await dashboard.locator('.header-actions #koofrImport').isVisible(), true);

  const seeded = await dashboard.evaluate(async () => {
    const send = async (message) => {
      const result = await chrome.runtime.sendMessage(message);
      if (!result?.ok) throw new Error(result?.error || 'Unexpected test fixture message failure');
      return result;
    };
    const { id } = await send({ type: 'start-import-session' });
    const text = '한국어와 🙂 HTML';
    const monitor = { id: 'koofr-restore-fixture', name: 'Koofr restore fixture', url: 'https://example.test/fixture',
      enabled: false, schedule: { type: 'manual', params: {} }, locators: [{ type: 'css', expr: 'body', op: 'include' }],
      snapshot: { exists: true, text, html: `<p>${text}</p>`, items: [{ text }] } };
    await send({ type: 'append-import-session', id, monitors: [monitor] });
    for (const [index, mebibytes] of [10, 10, 10, 2].entries()) {
      await send({ type: 'append-import-session', id, monitors: [{ _openStillRecovery: {
        id: 'fixture-archive-' + index, source: 'fixture', raw: 'x'.repeat(mebibytes * 1024 * 1024)
      } }] });
    }
    const result = await send({ type: 'finish-import-session', id });
    return { imported: result.imported, text, monitorId: monitor.id };
  });
  assert.equal(seeded.imported, 1);
  const isolated = await dashboard.evaluate(async ({ origin, key }) => {
    const tabs = await chrome.tabs.query({});
    const tabId = tabs.find((tab) => tab.url === origin + '/fixture').id;
    const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: async (storageKey) => {
      try { return Boolean((await chrome.storage.local.get(storageKey))[storageKey]); }
      catch { return false; }
    }, args: [key] });
    return injection.result;
  }, { origin: fixture.origin, key: credentialsKey });
  assert.equal(isolated, false);
  const localBackupLeakedSecret = await dashboard.evaluate(async (secret) => {
    const send = (request) => chrome.runtime.sendMessage(request);
    const session = await send({ type: 'start-export-session' });
    try {
      for (let index = 0; index < session.total; index += 1) {
        const { record } = await send({ type: 'get-export-monitor', id: session.id, index });
        if (record?.includes(secret)) return true;
      }
      return false;
    } finally { await send({ type: 'finish-export-session', id: session.id, completed: true }); }
  }, password);
  assert.equal(localBackupLeakedSecret, false);

  await worker.evaluate(async ({ key, secret }) => {
    const state = (await chrome.storage.local.get(key))[key];
    if (JSON.stringify(state).includes(secret)) throw new Error('A secret was persisted in the backup job');
    state.nextDue = Date.now() - 1;
    await chrome.storage.local.set({ [key]: state });
    await chrome.alarms.create('openstill-koofr', { when: Date.now() + 2_000 });
    globalThis.__openStillWorkerBeforeStop = true;
  }, { key: stateKey, secret: password });
  const firstPut = await until(fixture.slowPut, 'first 30 MiB PUT', 35_000);
  assert.ok(firstPut.size >= 30 * 1024 * 1024 && firstPut.size < 32 * 1024 * 1024);
  assert.equal((await runtime(dashboard, 'koofr-export')).ok, false, 'manual backup cannot duplicate the active scheduled job');
  await dashboard.close();
  const version = await until(() => [...versions.values()].find((value) => value.scriptURL === worker.url() && value.runningStatus === 'running'), 'running extension service worker');
  await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  await until(() => versions.get(version.versionId)?.runningStatus === 'stopped', 'stopped extension service worker');
  assert.equal([...fixture.files.keys()].some((key) => key.endsWith('/complete.json')), false);
  const marker = await until(() => [...fixture.files.keys()].find((key) => key.endsWith('/complete.json')), 'verified completion marker', 100_000);
  assert.ok(firstPut.finishedAt - firstPut.startedAt >= 40_000);
  const manifest = JSON.parse(fixture.files.get(marker));
  assert.equal(manifest.partCount, 2);
  assert.equal(fixture.requests.filter(({ method, target }) => method === 'PUT' && target === firstPut.target).length, 1);
  assert.equal(fixture.requests.filter(({ method, target }) => method === 'PUT' && target.endsWith('/complete.json')).length, 1);
  const backupFolder = marker.slice(0, marker.lastIndexOf('/'));
  for (const part of manifest.parts) assert.equal(fixture.files.get(backupFolder + '/' + part.name).includes(password), false);

  dashboard = await context.newPage();
  dashboard.on('pageerror', (error) => errors.push(error.message));
  await dashboard.goto(dashboardUrl);
  const completed = await until(async () => {
    const status = await runtime(dashboard, 'koofr-status');
    return !status.job && status.lastSuccess && status;
  }, 'saved remote completion');
  assert.equal(completed.lastSuccess.partCount, 2);
  assert.equal(JSON.stringify(completed).includes(password), false);
  assert.equal(await worker.evaluate(() => Boolean(globalThis.__openStillWorkerBeforeStop)), false);
  const state = await runtime(dashboard, 'get-state');
  const target = state.monitors.find((monitor) => monitor.id === seeded.monitorId);
  assert.equal((await runtime(dashboard, 'delete-monitor', { id: target.id, expectedRevision: target.revision })).ok, true);
  let lastRestore;
  for (const [imported, duplicates] of [[1, 0], [0, 1]]) {
    await dashboard.locator('#koofrImport').click();
    await dashboard.waitForFunction(() => !document.querySelector('#koofrRestore').disabled);
    assert.equal(await dashboard.locator('#koofrBackupChoice option').count(), 1);
    await dashboard.locator('#koofrBackupChoice').selectOption('0');
    await dashboard.locator('#koofrRestore').click();
    const restored = await until(async () => {
      const status = await runtime(dashboard, 'koofr-status');
      return !status.job && status.lastRestore && status.lastRestore.id !== lastRestore && status.lastRestore;
    }, 'restore results', 35_000);
    lastRestore = restored.id;
    assert.equal(restored.error, undefined);
    assert.equal(restored.result.imported, imported);
    assert.equal(restored.result.duplicates, duplicates);
    assert.equal(restored.result.conflicts, 0);
    const detail = await runtime(dashboard, 'get-monitor-detail', { id: seeded.monitorId });
    assert.equal(detail.monitor.snapshot.text, seeded.text);
    assert.equal(detail.monitor.snapshot.html, `<p>${seeded.text}</p>`);
    const recovery = await runtime(dashboard, 'get-recovery-status');
    assert.equal(recovery.records.filter((entry) => entry.source === 'fixture').length, 4);
  }

  await dashboard.locator('#koofrSettings').click();
  await dashboard.locator('#koofrRemove').click();
  await dashboard.waitForFunction(() => document.querySelector('#koofrExport').hidden && document.querySelector('#koofrImport').hidden);
  assert.equal((await runtime(dashboard, 'koofr-status')).interval, 0);
  assert.ok(fixture.files.has(marker));
  assert.ok(fixture.files.has(dav + '/outside.json'));
  assert.ok(fixture.requests.every(({ valid }) => valid));
  assert.ok(fixture.requests.filter(({ method }) => method === 'DELETE').every(({ target }) => target.startsWith(folder + '/probe-')));
  assert.deepEqual(errors, []);
});
