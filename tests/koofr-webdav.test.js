'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let chromium;
try { ({ chromium } = require(process.env.OPENSTILL_PLAYWRIGHT_MODULE || 'playwright')); } catch { /* optional browser */ }

const origin = 'https://app.koofr.net';
const davRoot = '/dav/Koofr';
const root = davRoot + '/OpenStill';
const script = fs.readFileSync(path.join(__dirname, '..', 'koofr-webdav.js'), 'utf8');
const credentials = { email: 'test@example.test', appPassword: 'synthetic-password' };
const authorization = 'Basic ' + Buffer.from(credentials.email + ':' + credentials.appPassword).toString('base64');
let browser;

test.before(async () => {
  if (!chromium) return;
  const executablePath = process.env.OPENSTILL_CHROMIUM_EXECUTABLE || [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ].find((value) => fs.existsSync(value));
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
});
test.after(async () => { await browser?.close(); });

function xmlText(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function resource(href, collection, status = 200) {
  return '<d:response><d:href>' + xmlText(href) + '</d:href><d:propstat><d:prop><d:resourcetype>'
    + (collection ? '<d:collection/>' : '') + '</d:resourcetype></d:prop><d:status>HTTP/1.1 '
    + status + ' Test</d:status></d:propstat></d:response>';
}

function multistatus(rows) {
  return '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">' + rows.join('') + '</d:multistatus>';
}

async function fixture(t) {
  const page = await browser.newPage();
  t.after(() => page.close());
  const dirs = new Set([davRoot]);
  const files = new Map([[davRoot + '/keep.txt', Buffer.from('user file')]]);
  const requests = [];
  const listingRows = new Map();
  const responseOverrides = new Map();

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin && url.pathname === '/fixture') return route.fulfill({ body: '<!doctype html>' });
    if (url.origin === origin && url.pathname === '/koofr-webdav.js') {
      return route.fulfill({ contentType: 'application/javascript', body: script });
    }
    const method = request.method();
    const target = decodeURIComponent(url.pathname.replace(/\/$/, ''));
    const headers = request.headers();
    requests.push({ origin: url.origin, method, target, authorization: headers.authorization, precondition: headers['if-none-match'] });
    const fulfill = (status, body, extraHeaders) => route.fulfill({ status, body, headers: extraHeaders });
    if (url.origin !== origin || headers.authorization !== authorization || (target !== root && !target.startsWith(root + '/'))) {
      return fulfill(403);
    }
    const override = responseOverrides.get(method + ' ' + target);
    if (override?.length) {
      const response = override.shift();
      if (response.abort) return route.abort('failed');
      return fulfill(response.status, response.body, response.headers);
    }
    const parent = target.slice(0, target.lastIndexOf('/'));
    if (method === 'MKCOL') {
      if (dirs.has(target) || files.has(target)) return fulfill(405);
      if (!dirs.has(parent)) return fulfill(409);
      dirs.add(target);
      return fulfill(201);
    }
    if (method === 'PROPFIND') {
      if (!dirs.has(target)) return fulfill(404);
      const rows = [resource(url.pathname, true)];
      if (headers.depth === '1') {
        for (const item of [...dirs, ...files.keys()]) {
          if (item.slice(0, item.lastIndexOf('/')) === target) {
            const href = item.split('/').map(encodeURIComponent).join('/');
            rows.push(resource(origin + href + (dirs.has(item) ? '/' : ''), dirs.has(item)));
          }
        }
        rows.push(...listingRows.get(target) || []);
      }
      return fulfill(207, multistatus(rows));
    }
    if (method === 'PUT') {
      if (!dirs.has(parent)) return fulfill(409);
      if (headers['if-none-match'] === '*' && files.has(target)) return fulfill(412);
      files.set(target, request.postDataBuffer());
      return fulfill(201);
    }
    if (method === 'GET') {
      const content = files.get(target);
      return content ? fulfill(200, content) : fulfill(404);
    }
    if (method === 'DELETE') {
      if (files.delete(target)) return fulfill(204);
      if (!dirs.delete(target)) return fulfill(404);
      for (const item of dirs) if (item.startsWith(target + '/')) dirs.delete(item);
      for (const item of files.keys()) if (item.startsWith(target + '/')) files.delete(item);
      return fulfill(204);
    }
    return fulfill(405);
  });

  await page.goto(origin + '/fixture');
  await page.addScriptTag({ url: origin + '/koofr-webdav.js' });
  await page.evaluate((auth) => {
    window.webdav = OpenStillKoofrWebDav.createClient(auth);
    window.createdAt = '2026-11-09T00:00:00.000Z';
    window.content = new Blob([JSON.stringify({ format: 'openstill-export', snapshot: '<p>한글🙂</p>' })], { type: 'application/json' });
    window.captureError = async (operation) => {
      try { await operation(); } catch (error) { return { code: error.code, message: error.message, retryAt: error.retryAt }; }
      return {};
    };
  }, credentials);
  return { page, dirs, files, requests, listingRows, responseOverrides };
}

test('Koofr probes and round-trips immutable verified parts, lists only complete sets across devices, and scopes cleanup', { skip: !chromium }, async (t) => {
  const { page, dirs, files, requests, listingRows, responseOverrides } = await fixture(t);
  const ids = { first: root + '/devices/device-1/backups/backup-1', second: root + '/devices/device-2/backups/backup-2' };
  const complete = await page.evaluate(async () => {
    await webdav.probe();
    await webdav.ensureBackupFolder('device-1', 'backup-1');
    const first = await webdav.putPart('device-1', 'backup-1', 1, content);
    const second = await webdav.putPart('device-1', 'backup-1', 2, new Blob(['{"second":true}']));
    const data = { setId: 'local-set-1', createdAt, parts: [first, second] };
    const complete = await webdav.publish('device-1', 'backup-1', data);
    await webdav.putPart('device-1', 'backup-1', 1, content);
    await webdav.publish('device-1', 'backup-1', data);
    await webdav.ensureBackupFolder('device-1', 'interrupted');
    await webdav.putPart('device-1', 'interrupted', 1, content);
    await webdav.ensureBackupFolder('device-1', 'invalid-manifest');
    await webdav.ensureBackupFolder('device-2', 'backup-2');
    const next = await webdav.putPart('device-2', 'backup-2', 1, content);
    await webdav.publish('device-2', 'backup-2', { setId: 'local-set-2', createdAt: '2026-11-10T00:00:00.000Z', parts: [next] });
    return complete;
  });
  assert.equal(complete.partCount, 2);
  assert.equal(complete.totalBytes, files.get(ids.first + '/part-001.json').length + files.get(ids.first + '/part-002.json').length);
  assert.equal(requests.filter(({ method, target }) => method === 'PUT' && target === ids.first + '/part-001.json').length, 1);
  assert.equal(requests.filter(({ method, target }) => method === 'PUT' && target === ids.first + '/complete.json').length, 1);
  assert.ok(requests.filter(({ method }) => method === 'PUT').every(({ precondition }) => precondition === '*'));
  assert.equal([...files.keys()].filter((key) => key.includes('/probe-')).length, 0);
  assert.equal(requests.filter(({ method, target }) => method === 'DELETE' && target.startsWith(root + '/probe-')).length, 1);

  const devicePath = root + '/devices';
  const interruptedPart = devicePath + '/device-1/backups/interrupted/part-002.json';
  responseOverrides.set('PUT ' + interruptedPart, [{ status: 507 }]);
  const quotaFailure = await page.evaluate(() => captureError(() => webdav.putPart('device-1', 'interrupted', 2, content)));
  assert.equal(quotaFailure.code, 'QUOTA');
  assert.ok(!files.has(interruptedPart));
  listingRows.set(devicePath, [
    resource('https://outside.example.test' + devicePath + '/outside/', true),
    resource(devicePath + '/%2e%2e/escaped/', true),
    resource(devicePath + '/failed/', true, 403),
    resource(devicePath + '/encoded%2fslash/', true)
  ]);
  const bad = { ...complete, backupId: 'invalid-manifest', parts: [{ ...complete.parts[0], name: '../keep.txt' }, complete.parts[1]] };
  files.set(root + '/devices/device-1/backups/invalid-manifest/complete.json', Buffer.from(JSON.stringify(bad)));
  const listed = await page.evaluate(() => webdav.listBackups());
  assert.deepEqual(listed.map(({ deviceId, backupId, setId }) => [deviceId, backupId, setId]), [
    ['device-2', 'backup-2', 'local-set-2'],
    ['device-1', 'backup-1', 'local-set-1']
  ]);
  assert.deepEqual((await page.evaluate(() => webdav.listBackups({ deviceId: 'device-1' }))).map((value) => value.backupId), ['backup-1']);
  assert.ok(requests.every(({ origin: requestOrigin, target, authorization: auth }) => requestOrigin === origin
    && auth === authorization && !/outside|escaped|failed|encoded|keep\.txt/.test(target)));

  const download = await page.evaluate(async (entry) => (await webdav.getPart(entry, 1)).text(), complete);
  assert.deepEqual(JSON.parse(download), { format: 'openstill-export', snapshot: '<p>한글🙂</p>' });
  const changed = await page.evaluate(() => captureError(() => webdav.putPart('device-1', 'backup-1', 1, new Blob(['different']))));
  assert.equal(changed.code, 'CONFLICT');
  assert.equal(files.get(ids.first + '/part-001.json').toString(), download);
  const original = files.get(ids.first + '/part-001.json');
  const corrupted = Buffer.from(original);
  corrupted[2] ^= 1;
  files.set(ids.first + '/part-001.json', corrupted);
  const digestError = await page.evaluate((entry) => captureError(() => webdav.getPart(entry, 1)), complete);
  assert.equal(digestError.code, 'INVALID');
  files.set(ids.first + '/part-001.json', Buffer.alloc(original.length + 1));
  const sizeError = await page.evaluate((entry) => captureError(() => webdav.getPart(entry, 1)), complete);
  assert.equal(sizeError.code, 'INVALID');
  files.set(ids.first + '/part-001.json', original);

  const extra = ids.first + '/사용자 (보관).txt';
  files.set(extra, Buffer.from('keep'));
  assert.equal((await page.evaluate(() => captureError(() => webdav.deleteBackup('device-1', 'backup-1')))).code, 'INVALID');
  assert.ok(files.has(extra));
  assert.ok(files.has(ids.first + '/complete.json'));
  files.delete(extra);
  await page.evaluate(() => webdav.deleteBackup('device-1', 'backup-1'));
  assert.ok(dirs.has(ids.first));
  assert.ok(![...files.keys()].some((item) => item.startsWith(ids.first + '/')));
  assert.deepEqual(requests.filter(({ method, target }) => method === 'DELETE' && target.startsWith(ids.first))
    .map(({ target }) => target.slice(ids.first.length)), ['/complete.json', '/part-001.json', '/part-002.json']);
  assert.ok(files.has(ids.second + '/complete.json'));
  assert.equal(files.get(davRoot + '/keep.txt').toString(), 'user file');
});

test('Koofr honors rate limits and failures, rejects redirects and malformed Multi-Status, and retries temporary outages', { skip: !chromium }, async (t) => {
  const { page, requests, responseOverrides } = await fixture(t);
  const probe = () => page.evaluate(() => captureError(() => webdav.probe()));
  const endpoint = 'MKCOL ' + root;
  for (const [status, expected] of [[401, 'AUTH'], [403, 'FORBIDDEN'], [507, 'QUOTA']]) {
    const count = requests.length;
    responseOverrides.set(endpoint, [{ status, body: 'synthetic-password Authorization: should not be exposed' }]);
    const result = await probe();
    assert.equal(result.code, expected);
    assert.doesNotMatch(result.message, /synthetic-password|Authorization/);
    assert.equal(requests.length - count, 1);
  }
  responseOverrides.set(endpoint, [{ status: 429, headers: { 'Retry-After': '120' } }]);
  const rate = await probe();
  assert.equal(rate.code, 'TRANSIENT');
  assert.ok(rate.retryAt >= Date.now() + 110_000);

  responseOverrides.set(endpoint, [{ status: 307, headers: { Location: 'https://outside.example.test/disclose' } }]);
  assert.equal((await probe()).code, 'REDIRECT');
  assert.ok(requests.every((entry) => entry.origin === origin));

  const requestsBeforeRetry = requests.length;
  responseOverrides.set(endpoint, [{ abort: true }, { status: 503 }]);
  assert.deepEqual(await probe(), {});
  assert.equal(requests.slice(requestsBeforeRetry).filter(({ method }) => method === 'MKCOL').length, 3);

  const probeListing = 'PROPFIND ' + root;
  responseOverrides.set(probeListing, [{ status: 207, body: multistatus([resource(root + '/', true, 403)]) }]);
  assert.equal((await probe()).code, 'FORBIDDEN');
  responseOverrides.set(probeListing, [{
    status: 207, body: '<!DOCTYPE d:multistatus [<!ENTITY invalid SYSTEM "https://outside.example.test/xxe">]>'
      + '<d:multistatus xmlns:d="DAV:">&invalid;</d:multistatus>'
  }]);
  assert.equal((await probe()).code, 'INVALID');
  responseOverrides.set(probeListing, [{ status: 207, body: multistatus([resource(root + '/', true), '<invalid>']) }]);
  assert.equal((await probe()).code, 'INVALID');
  assert.ok(requests.every((entry) => entry.origin === origin));

  responseOverrides.set(endpoint, [{ status: 503 }]);
  const aborted = await page.evaluate(async (auth) => {
    const controller = new AbortController();
    const client = OpenStillKoofrWebDav.createClient(auth, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    return captureError(() => client.probe());
  }, credentials);
  assert.equal(aborted.code, 'CANCELED');
});
