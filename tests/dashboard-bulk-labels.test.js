'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let chromium;
try { ({ chromium } = require(process.env.OPENSTILL_PLAYWRIGHT_MODULE || 'playwright')); } catch { /* optional host browser */ }
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

async function fixture(mode) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept('회귀 라벨'));
  await page.route('https://dashboard.example.test/**', (route) => {
    const filename = new URL(route.request().url()).pathname.slice(1) || 'dashboard.html';
    const localPath = path.join(__dirname, '..', filename);
    if (!fs.existsSync(localPath)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: filename.endsWith('.js') ? 'application/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html', body: fs.readFileSync(localPath) });
  });
  await page.addInitScript((mode) => {
    window.__messages = [];
    window.__guardErrors = [];
    window.__monitors = Array.from({ length: 501 }, (_, index) => ({
      id: `monitor-${index}`, revision: `revision-${index}`, name: `추적 ${String(index).padStart(5, '0')}`,
      url: `https://site.example.test/page/${index}`, enabled: true, unread: false, status: 'ok',
      labels: ['기존 라벨', ...((mode === 'add' ? index === 500 : index !== 500) ? ['회귀 라벨'] : [])],
      locators: [{ type: 'css', expr: '.post', op: 'include', fields: [{ type: 'text' }] }],
      tracking: { dataAttr: 'text' }, schedule: { type: 'manual', params: {} }, createdAt: '2026-10-01T01:00:00Z'
    }));
    window.chrome = {
      runtime: { getURL: (value) => `https://dashboard.example.test/${value}`, sendMessage: async (message) => {
        window.__messages.push(message);
        if (message.type === 'start-dashboard-load') return { ok: true, id: 'load', total: window.__monitors.length, settings: {} };
        if (message.type === 'get-dashboard-load-page') return { ok: true, monitors: window.__monitors.slice(message.offset, message.offset + message.pageSize), done: message.offset + message.pageSize >= window.__monitors.length };
        if (message.type === 'get-recovery-status') return { ok: true, records: [], sessions: [] };
        if (message.type === 'update-monitor-labels') {
          const processedIds = [];
          let updated = 0;
          let skipped = 0;
          for (const id of message.ids) {
            const monitor = window.__monitors.find((value) => value.id === id);
            const guard = message.expectedRevisions?.find((value) => value.id === id);
            if (!message.operationId || guard?.revision !== monitor.revision) {
              window.__guardErrors.push(id);
              return { ok: false, error: 'missing operation identity or stale revision guard' };
            }
            processedIds.push(id);
            const hasLabel = monitor.labels.includes(message.label);
            if ((message.mode === 'add' && hasLabel) || (message.mode === 'remove' && !hasLabel)) {
              skipped += 1;
              continue;
            }
            monitor.labels = message.mode === 'add' ? [...monitor.labels, message.label] : monitor.labels.filter((label) => label !== message.label);
            monitor.revision = `mutation-${message.mode}-${id}`;
            updated += 1;
          }
          return { ok: true, updated, skipped, processedIds, missing: 0 };
        }
        return { ok: true };
      } },
      storage: { onChanged: { addListener: () => {} } }
    };
  }, mode);
  await page.goto('https://dashboard.example.test/dashboard.html');
  await page.waitForFunction(() => document.querySelector('#summaryTotal').textContent === '501' && document.querySelectorAll('.monitor-row').length > 0);
  return { page, errors };
}

for (const mode of ['add', 'remove']) {
  test(`bulk label ${mode} processes hidden selections in revision guarded chunks and refreshes labels`, { skip: !chromium, timeout: 30000 }, async () => {
    const { page, errors } = await fixture(mode);
    try {
      await page.locator('#selectAll').click();
      await page.locator('#searchInput').fill('추적 00500');
      await page.waitForFunction(() => document.querySelectorAll('.monitor-row').length === 1);
      assert.match(await page.locator('#selectedCount').textContent(), /표시 선택 1 · 숨김 선택 500 · 전체 501/);
      const button = page.locator(mode === 'add' ? '#addLabelSelected' : '#removeLabelSelected');
      await button.click();
      const expectedStatus = `라벨 ${mode === 'add' ? '추가' : '제거'} 500 · 건너뜀 1 · 실패 0 · 누락 0 · 충돌 0 · 미처리 0`;
      await page.waitForFunction((expected) => document.querySelector('#bulkStatus').textContent === expected && !document.querySelector('#addLabelSelected').disabled, expectedStatus);

      const state = await page.evaluate(() => ({
        messages: window.__messages.filter((message) => message.type === 'update-monitor-labels'),
        monitors: window.__monitors, guardErrors: window.__guardErrors
      }));
      assert.deepEqual(state.messages.map((message) => message.ids.length), [500, 1]);
      assert.equal(new Set(state.messages.flatMap((message) => message.ids)).size, 501);
      assert.equal(new Set(state.messages.map((message) => message.operationId)).size, 2);
      assert.equal(state.messages[0].operationId.replace(/:0$/, ''), state.messages[1].operationId.replace(/:500$/, ''));
      for (const message of state.messages) {
        assert.equal(message.mode, mode);
        assert.equal(message.label, '회귀 라벨');
        assert.deepEqual(message.expectedRevisions, message.ids.map((id) => ({ id, revision: `revision-${id.slice('monitor-'.length)}` })));
      }
      assert.deepEqual(state.guardErrors, []);
      assert.equal(state.monitors.every((monitor) => monitor.labels.includes('기존 라벨')), true);
      assert.equal(state.monitors.every((monitor) => monitor.labels.includes('회귀 라벨') === (mode === 'add')), true);
      assert.equal(state.monitors[0].revision, `mutation-${mode}-monitor-0`);
      assert.equal(state.monitors[500].revision, 'revision-500');
      const label = page.locator('#labelList button[data-label="회귀 라벨"]');
      if (mode === 'add') assert.equal(await label.locator('small').textContent(), '501');
      else assert.equal(await label.count(), 0);
      assert.match(await page.locator('#selectedCount').textContent(), /표시 선택 1 · 숨김 선택 500 · 전체 501/);
      assert.equal(await page.locator('.monitor-row input').isChecked(), true);
      assert.equal(await page.locator('#removeLabelSelected').isEnabled(), true);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
