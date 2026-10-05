'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let chromium;
try { ({ chromium } = require(process.env.OPENSTILL_PLAYWRIGHT_MODULE || 'playwright')); } catch { /* optional host browser */ }

test('bulk address UI includes filtered monitors, guards duplicate submits and recovers from failure', { skip: !chromium }, async () => {
  const executablePath = process.env.OPENSTILL_CHROMIUM_EXECUTABLE || [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ].find((value) => fs.existsSync(value));
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.route('https://dashboard.example.test/**', (route) => {
      const filename = new URL(route.request().url()).pathname.slice(1) || 'dashboard.html';
      const localPath = path.join(__dirname, '..', filename);
      if (!fs.existsSync(localPath)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ contentType: filename.endsWith('.js') ? 'application/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html', body: fs.readFileSync(localPath) });
    });
    await page.addInitScript(() => {
      window.__messages = [];
      window.__failMutation = true;
      window.__monitors = ['https://old.example/posts/one?q=%EA%B0%80#details', 'http://old.example/other?x=1&x=2#tail', 'https://elsewhere.test/untouched'].map((url, index) => ({
        id: `monitor-${index}`, revision: `revision-${index}`, name: `추적 ${index}`, url,
        enabled: index === 0, unread: index === 0, status: 'ok', labels: [`label-${index}`],
        locators: [{ type: 'css', expr: 'body', op: 'include', frameId: 0, framePath: [], fields: [{ type: 'text' }] }],
        tracking: { ignoreWhitespace: true }, schedule: { type: 'manual', params: {} },
        snapshot: { exists: true, text: `baseline-${index}` }, history: [{ snapshot: { exists: true, text: `history-${index}` } }],
        lastChangedAt: '2026-10-01T01:00:00Z', lastViewedAt: '2026-09-30T01:00:00Z'
      }));
      window.chrome = {
        runtime: { getURL: (value) => `https://dashboard.example.test/${value}`, sendMessage: async (message) => {
          window.__messages.push(message);
          if (message.type === 'start-dashboard-load') return { ok: true, id: 'load', total: window.__monitors.length, settings: {} };
          if (message.type === 'get-dashboard-load-page') return { ok: true, monitors: window.__monitors, done: true };
          if (message.type === 'get-recovery-status') return { ok: true, records: [], sessions: [] };
          if (message.type === 'replace-site-host') {
            await new Promise((resolve) => setTimeout(resolve, 40));
            if (window.__failMutation) { window.__failMutation = false; throw new Error('temporary address failure'); }
            const affected = window.__monitors.filter((monitor) => new URL(monitor.url).host === message.sourceHost);
            if (affected.some((monitor) => !message.expectedRevisions.some((expected) => expected.id === monitor.id && expected.revision === monitor.revision && expected.url === monitor.url))) return { ok: false, error: 'stale target group' };
            for (const monitor of affected) { const url = new URL(monitor.url); url.host = message.targetHost; monitor.url = url.href; }
            return { ok: true, count: affected.length };
          }
          return { ok: true };
        } },
        storage: { onChanged: { addListener() {} } }
      };
    });
    await page.goto('https://dashboard.example.test/dashboard.html');
    await page.waitForFunction(() => document.querySelector('#summaryTotal').textContent === '3');
    const before = await page.evaluate(() => window.__monitors);
    await page.locator('#searchInput').fill('추적 0');
    await page.waitForFunction(() => document.querySelectorAll('.monitor-row').length === 1);
    await page.locator('#batchUrlButton').click();
    await page.locator('#batchUrlSource').fill('old.example');
    await page.locator('#batchUrlTarget').fill('new.example:8443');
    assert.match(await page.locator('#batchUrlPreview').textContent(), /전체 2개 추적\(필터 밖 1개 포함\)/);
    const duplicateSubmit = () => page.evaluate(() => { const form = document.querySelector('#batchUrlForm'); form.requestSubmit(); form.requestSubmit(); });
    await duplicateSubmit();
    await page.waitForFunction(() => document.querySelector('#batchUrlMessage').textContent === 'temporary address failure');
    assert.equal(await page.locator('#batchUrlSave').isDisabled(), false);
    assert.deepEqual(await page.evaluate(() => window.__monitors), before);
    await duplicateSubmit();
    await page.waitForFunction(() => !document.querySelector('#batchUrlDialog').open && document.querySelector('#toast').textContent.includes('2개 추적 페이지'));
    const result = await page.evaluate(() => ({ monitors: window.__monitors, messages: window.__messages.filter((message) => message.type === 'replace-site-host') }));
    assert.equal(result.messages.length, 2);
    assert.ok(result.messages[0].operationId);
    assert.equal(result.messages[1].operationId, result.messages[0].operationId);
    assert.deepEqual(result.messages[1].expectedRevisions, before.slice(0, 2).map(({ id, revision, url }) => ({ id, revision, url })));
    assert.equal(result.messages[1].sourceHost, 'old.example');
    assert.equal(result.messages[1].targetHost, 'new.example:8443');
    assert.deepEqual(result.monitors, before.map((monitor, index) => {
      if (index === 2) return monitor;
      const url = new URL(monitor.url); url.host = 'new.example:8443';
      return { ...monitor, url: url.href };
    }));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
