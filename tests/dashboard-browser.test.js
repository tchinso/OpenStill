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

async function fixture(count, extra = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  await page.route('https://dashboard.example.test/**', (route) => {
    const filename = new URL(route.request().url()).pathname.slice(1) || 'dashboard.html';
    const localPath = path.join(__dirname, '..', filename);
    if (!fs.existsSync(localPath)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: filename.endsWith('.js') ? 'application/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html', body: fs.readFileSync(localPath) });
  });
  await page.addInitScript(({ count, extra }) => {
    window.__messages = [];
    window.__storageListeners = [];
    window.__monitors = Array.from({ length: count }, (_, index) => ({
      id: `monitor-${index}`, revision: `revision-${index}`, name: `추적 ${String(index).padStart(5, '0')}`,
      url: `https://site${index % 3}.example.test/page/${index}`, pageTitle: `페이지제목 ${index}`,
      enabled: true, unread: false, status: 'ok', labels: [`label-${index}`],
      locators: [{ type: 'css', expr: `.post-${index}`, op: 'include', frameId: 0, framePath: [], fields: [{ type: 'text' }] }],
      tracking: { dataAttr: 'text', ignoreWhitespace: true, timeoutMilliseconds: 60000 },
      schedule: { type: 'manual', params: {} }, createdAt: '2026-10-01T01:00:00Z', lastChangedAt: '2026-10-01T01:00:00Z',
      ...extra
    }));
    window.__detail = null;
    window.__failRefresh = false;
    window.chrome = {
      runtime: { getURL: (value) => `https://dashboard.example.test/${value}`, sendMessage: async (message) => {
        window.__messages.push(message);
        if (window.__messageHandler) { const response = await window.__messageHandler(message); if (response !== undefined) return response; }
        if (message.type === 'start-dashboard-load') return window.__failRefresh ? { ok: false, error: 'test load failure' } : { ok: true, id: 'load', total: window.__monitors.length, settings: { soundEnabled: true } };
        if (message.type === 'get-dashboard-load-page') return { ok: true, monitors: window.__monitors.slice(message.offset, message.offset + message.pageSize), done: message.offset + message.pageSize >= window.__monitors.length };
        if (message.type === 'get-monitor-summaries') return { ok: true, monitors: window.__monitors.filter((monitor) => message.ids.includes(monitor.id)) };
        if (message.type === 'get-monitor-detail') return { ok: true, monitor: window.__detail || window.__monitors.find((monitor) => monitor.id === message.id) };
        if (message.type === 'get-recovery-status') return { ok: true, records: [], sessions: [] };
        if (message.type === 'get-runtime-status') return { ok: true, ...(window.__runtimeState || {}) };
        if (message.type === 'reconcile-runtime-ownership') { window.__runtimeState = { pendingCleanup: [] }; return { ok: true, committed: true }; }
        if (message.type === 'update-monitor-labels') return { ok: true, updated: message.ids.length, processedIds: message.ids, skipped: 0, missing: 0 };
        if (message.type === 'delete-monitors') {
          if (window.__partialDelete) {
            const call = window.__deleteCall || 0;
            window.__deleteCall = call + 1;
            if (call === 1) throw new Error('temporary delete failure');
            if (call === 0) {
              const deletedIds = message.ids.slice(0, -2);
              const conflictIds = message.ids.slice(-2, -1);
              const missingIds = message.ids.slice(-1);
              const removed = new Set([...deletedIds, ...missingIds]);
              window.__monitors = window.__monitors.filter((monitor) => !removed.has(monitor.id));
              return { ok: true, deletedCount: deletedIds.length, deletedIds, conflictIds, unprocessedIds: conflictIds, missingIds, missing: missingIds.length };
            }
          }
          const targets = new Set(message.ids);
          window.__monitors = window.__monitors.filter((monitor) => !targets.has(monitor.id));
          return { ok: true, deletedCount: message.ids.length, deletedIds: message.ids, missing: 0 };
        }
        if (message.type === 'check-page') return { ok: true, completed: 0, failed: window.__monitors.length, failedIds: window.__monitors.map((monitor) => monitor.id) };
        if (message.type === 'check-monitor') { window.__failRefresh = true; return { ok: true, changed: false }; }
        if (message.type === 'save-monitor') { await new Promise((resolve) => setTimeout(resolve, 80)); return { ok: true, committed: true }; }
        return { ok: true };
      } },
      storage: { onChanged: { addListener: (callback) => window.__storageListeners.push(callback) } }
    };
  }, { count, extra });
  await page.goto('https://dashboard.example.test/dashboard.html');
  await page.waitForFunction((expected) => document.querySelector('#summaryTotal').textContent === String(expected) && document.querySelectorAll('.monitor-row').length > 0, count);
  return { page, errors };
}

for (const count of [30, 1000, 10000]) {
  test(`real viewport renders bounded rows and retains focus/selection/scroll at ${count}`, { skip: !chromium, timeout: 60000 }, async () => {
    const { page, errors } = await fixture(count);
    try {
      const first = await page.evaluate(() => ({ rows: document.querySelectorAll('.monitor-row').length, height: document.querySelector('.monitor-row').getBoundingClientRect().height, nodes: document.querySelector('#monitorList').querySelectorAll('*').length }));
      assert.ok(first.rows < 40, JSON.stringify(first));
      assert.equal(first.height, 48);
      await page.evaluate(() => { const list = document.querySelector('#monitorList'); list.scrollTop = Math.min(480 * 10, list.scrollHeight - list.clientHeight); list.dispatchEvent(new Event('scroll')); });
      await page.waitForTimeout(40);
      await page.evaluate(() => { const input = document.querySelector('.monitor-row input'); window.__focusInput = input; input.focus(); input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); window.__top = document.querySelector('#monitorList').scrollTop; });
      assert.equal(await page.evaluate(() => document.activeElement === window.__focusInput), true);
      const calls = await page.evaluate(() => window.__messages.filter((message) => message.type === 'start-dashboard-load').length);
      await page.evaluate(() => window.__storageListeners.forEach((callback) => callback({ unrelated: { newValue: 1 } }, 'session')));
      await page.waitForTimeout(130);
      assert.equal(await page.evaluate(() => window.__messages.filter((message) => message.type === 'start-dashboard-load').length), calls);
      await page.evaluate(() => window.__storageListeners.forEach((callback) => callback({ 'openStill.monitors.v2': { newValue: [] } }, 'local')));
      await page.waitForFunction((previous) => window.__messages.filter((message) => message.type === 'start-dashboard-load').length > previous, calls);
      await page.waitForTimeout(70);
      assert.equal(await page.evaluate(() => document.activeElement === window.__focusInput), true);
      assert.equal(await page.evaluate(() => document.querySelector('#monitorList').scrollTop === window.__top), true);
      assert.match(await page.locator('#selectedCount').textContent(), /전체 1/);
      assert.ok(await page.locator('.monitor-row').count() < 45);
      const patchesBefore = await page.evaluate(() => window.__messages.filter((message) => message.type === 'start-dashboard-load').length);
      const focusedId = await page.evaluate(() => document.activeElement.dataset.selectMonitor);
      await page.evaluate((id) => {
        window.__monitors.find((monitor) => monitor.id === id).name += ' 수정된 이름';
        window.__storageListeners.forEach((callback) => callback({ 'openStill.records.changed.v1': { newValue: { ids: [id], deletedIds: [] } } }, 'local'));
      }, focusedId);
      await page.waitForFunction(() => document.querySelector('.row-name') && [...document.querySelectorAll('.row-name')].some((button) => button.textContent.includes('수정된 이름')));
      assert.equal(await page.evaluate(() => document.activeElement.dataset.selectMonitor), focusedId);
      assert.equal(await page.evaluate(() => document.querySelector('#monitorList').scrollTop === window.__top), true);
      assert.equal(await page.evaluate(() => window.__messages.filter((message) => message.type === 'start-dashboard-load').length), patchesBefore);
      assert.deepEqual(errors, []);
      console.log(`dashboard ${count}: ${first.rows} rows, ${first.nodes} list elements, row height ${first.height}px`);
    } finally { await page.close(); }
  });
}

test('10k bulk delete processes every ID and selection distinguishes hidden results', { skip: !chromium, timeout: 60000 }, async () => {
  const { page, errors } = await fixture(10000);
  try {
    await page.locator('#selectAll').click();
    await page.locator('#searchInput').fill('페이지제목 9999');
    await page.waitForFunction(() => document.querySelectorAll('.monitor-row').length === 1);
    assert.match(await page.locator('#selectedCount').textContent(), /표시 선택 1 · 숨김 선택 9999 · 전체 10000/);
    await page.locator('#deleteSelected').click();
    await page.waitForFunction(() => window.__monitors.length === 0 && document.querySelector('#bulkStatus').textContent.includes('삭제 10000'));
    const ids = await page.evaluate(() => window.__messages.filter((message) => message.type === 'delete-monitors').flatMap((message) => message.ids));
    assert.equal(new Set(ids).size, 10000);
    assert.equal(ids.length, 10000);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('invalid locator editor blocks save and valid duplicate submits use one revision guarded operation', { skip: !chromium }, async () => {
  const { page, errors } = await fixture(1);
  try {
    await page.locator('.row-name').click();
    await page.locator('#monitorDetailDialog [data-action="edit"]').click();
    await page.locator('#editSelectors').fill('{"type":"css","expr":');
    await page.locator('#editorForm button[type="submit"]').click();
    assert.match(await page.locator('#editorMessage').textContent(), /1행/);
    assert.equal(await page.evaluate(() => window.__messages.filter((message) => message.type === 'save-monitor').length), 0);
    await page.locator('#editSelectors').fill('.valid');
    await page.evaluate(() => { const form = document.querySelector('#editorForm'); form.requestSubmit(); form.requestSubmit(); });
    await page.waitForFunction(() => window.__messages.some((message) => message.type === 'save-monitor'));
    await page.waitForTimeout(100);
    const messages = await page.evaluate(() => window.__messages.filter((message) => message.type === 'save-monitor'));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].expectedRevision, 'revision-0');
    assert.ok(messages[0].operationId);
    assert.equal(Object.prototype.hasOwnProperty.call(messages[0], 'tracking'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(messages[0], 'schedule'), false);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('all failed page checks report failure and refresh failures release check buttons', { skip: !chromium }, async () => {
  const { page, errors } = await fixture(1);
  try {
    await page.locator('.row-name').click();
    await page.locator('#monitorDetailDialog [data-action="check-page"]').click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('실패 1'));
    assert.match(await page.locator('#toast').textContent(), /확인 완료 0 · 실패 1/);
    assert.equal(await page.locator('#retryFailedChecks').isVisible(), true);
    await page.locator('#monitorDetailDialog [data-action="check"]').click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('목록을 불러오지 못했습니다'));
    assert.equal(await page.locator('#monitorDetailDialog [data-action="check"]').isDisabled(), false);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('changes beyond 180k characters are visible and acknowledge uses the viewed change identity', { skip: !chromium }, async () => {
  const { page, errors } = await fixture(1, { unread: true });
  try {
    await page.evaluate(() => {
      const before = '공통 내용 '.repeat(40000) + '이전 마지막';
      const after = '공통 내용 '.repeat(40000) + '새 마지막';
      window.__detail = { ...window.__monitors[0], lastChange: { id: 'viewed-change', detectedAt: '2026-10-02T01:00:00Z', previous: { exists: true, text: before }, current: { exists: true, text: after } } };
    });
    await page.locator('.row-primary').click();
    await page.waitForFunction(() => document.querySelector('#changeDialog').open);
    assert.match(await page.locator('#currentSnapshot').textContent(), /새 마지막/);
    assert.match(await page.locator('#currentSnapshot').textContent(), /큰 내용 부분/);
    await page.locator('#acknowledgeButton').click();
    assert.equal(await page.evaluate(() => window.__messages.find((message) => message.type === 'acknowledge-monitor').expectedChangeId), 'viewed-change');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('partial bulk failures preserve the unhandled selection and disjoint outcome totals', { skip: !chromium }, async () => {
  const { page, errors } = await fixture(1001);
  try {
    await page.evaluate(() => { window.__partialDelete = true; });
    await page.locator('#selectAll').click();
    await page.locator('#deleteSelected').click();
    await page.waitForFunction(() => document.querySelector('#bulkStatus').textContent.includes('삭제 499'));
    assert.match(await page.locator('#bulkStatus').textContent(), /삭제 499 · 실패 500 · 누락 1 · 충돌 1 · 미처리 0/);
    await page.waitForFunction(() => document.querySelector('#summaryTotal').textContent === '501');
    assert.match(await page.locator('#selectedCount').textContent(), /전체 501/);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('history distinguishes omitted contents from an observed empty value', { skip: !chromium }, async () => {
  const { page, errors } = await fixture(1);
  try {
    await page.evaluate(() => {
      window.__detail = { ...window.__monitors[0], history: [
        { kind: 'change', capturedAt: '2026-10-02T01:00:00Z', snapshot: { exists: false, text: '', matchCount: 0 } },
        { kind: 'baseline', capturedAt: '2026-10-01T01:00:00Z', snapshot: { exists: true, contentOmitted: true } }
      ] };
    });
    await page.locator('.row-name').click();
    await page.locator('#monitorDetailDialog [data-action="history"]').click();
    await page.waitForFunction(() => document.querySelector('#historyDialog').open);
    assert.match(await page.locator('#historyPreviousSnapshot').textContent(), /내용 생략됨/);
    assert.match(await page.locator('#historyCurrentSnapshot').textContent(), /관측 결과가 비어 있음/);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('10k structured identities render partial pages with one insertion and one departure', { skip: !chromium, timeout: 60000 }, async () => {
  const { page, errors } = await fixture(1, { unread: true });
  try {
    await page.evaluate(() => {
      const item = (id) => ({ text: `중복 제목 ${id}`, html: `<a href="https://posts.example.test/${id}">중복 제목 ${id}</a>`, identity: { key: String(id) }, locator: { type: 'css', expr: '.post' } });
      const items = Array.from({ length: 10000 }, (_, index) => item(index));
      const after = [item('NEW'), ...items.slice(0, -1)];
      const snapshot = (values) => ({ exists: true, items: values, text: values.map((value) => value.text).join('\n'), html: values.map((value) => value.html).join('') });
      window.__detail = { ...window.__monitors[0], lastChange: { id: 'structured-change', previous: snapshot(items), current: snapshot(after) } };
    });
    await page.locator('.row-primary').click();
    await page.waitForFunction(() => document.querySelector('#changeDialog').open);
    assert.equal(await page.locator('#currentSnapshot .diff-added').count(), 1);
    assert.equal(await page.locator('#previousSnapshot .diff-removed').count(), 1);
    assert.ok(await page.locator('#currentSnapshot .snapshot-document > article').count() <= 80);
    assert.match(await page.locator('#currentSnapshot').textContent(), /전체 10000개 항목/);
    assert.match(await page.locator('#currentSnapshot').textContent(), /중복 제목 NEW/);
    assert.match(await page.locator('#previousSnapshot').textContent(), /중복 제목 9999/);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('a large identity-matched item reveals its tail change without hiding siblings', { skip: !chromium, timeout: 60000 }, async () => {
  const { page, errors } = await fixture(1, { unread: true });
  try {
    await page.evaluate(() => {
      const item = (key, text) => ({ text, identity: { key }, locator: { type: 'css', expr: '.post' } });
      const before = [item('long', '공통 '.repeat(70000) + '이전 마지막'), item('other', '다른 항목')];
      const after = [item('long', '공통 '.repeat(70000) + '새 마지막'), item('other', '다른 항목')];
      window.__detail = { ...window.__monitors[0], lastChange: { id: 'item-tail-change', previous: { exists: true, items: before }, current: { exists: true, items: after } } };
    });
    await page.locator('.row-primary').click();
    await page.waitForFunction(() => document.querySelector('#changeDialog').open);
    assert.match(await page.locator('#currentSnapshot').textContent(), /새 마지막/);
    assert.match(await page.locator('#currentSnapshot').textContent(), /다른 항목/);
    assert.match(await page.locator('#currentSnapshot').textContent(), /큰 내용 부분/);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('runtime ownership displays the candidate and guards adopt, cleanup and release actions', { skip: !chromium }, async () => {
  const { page, errors } = await fixture(1);
  try {
    await page.evaluate(() => { window.__runtimeState = { queuedCaptures: 3, oldestQueueWaitMilliseconds: 65000, pendingCleanup: [{ id: 'monitor-0', monitorId: 'monitor-0', kind: 'live', tabId: 7, stage: 'ownership-unverified', url: window.__monitors[0].url, monitorRevision: 'revision-0', ownerToken: 'ownership-token', candidate: { id: 7, url: 'https://unrelated.example.test/', pinned: true }, canAdopt: false }] }; });
    await page.locator('#refreshRuntime').click();
    assert.match(await page.locator('#runtimeSummary').textContent(), /대기 3 \(최장 1분 5초\)/);
    await page.locator('#runtimeOwnership').click();
    assert.match(await page.locator('#runtimeOwnershipDialog').textContent(), /현재 주소: https:\/\/unrelated.example.test\//);
    assert.equal(await page.locator('[data-ownership-action="adopt"]').isDisabled(), true);
    assert.equal(await page.locator('[data-ownership-action="retry-cleanup"]').isDisabled(), true);
    await page.locator('[data-ownership-action="release"]').click();
    await page.waitForFunction(() => window.__messages.some((message) => message.type === 'reconcile-runtime-ownership'));
    const message = await page.evaluate(() => window.__messages.find((value) => value.type === 'reconcile-runtime-ownership'));
    assert.equal(message.action, 'release'); assert.equal(message.tabId, 7); assert.equal(message.ownerToken, 'ownership-token'); assert.equal(message.expectedRevision, 'revision-0'); assert.ok(message.operationId);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('locator editing preserves identity and durable frame metadata', { skip: !chromium }, async () => {
  const locator = { type: 'css', expr: '.post', op: 'include', frameId: 0, framePath: [], fields: [{ type: 'text' }], identityAttribute: 'data-post-id', frameVolatileParameters: ['nonce'] };
  const { page, errors } = await fixture(1, { locators: [locator] });
  try {
    await page.locator('.row-name').click();
    await page.locator('#monitorDetailDialog [data-action="edit"]').click();
    const source = JSON.parse(await page.locator('#editSelectors').inputValue());
    assert.equal(source.identityAttribute, 'data-post-id'); assert.deepEqual(source.frameVolatileParameters, ['nonce']);
    source.expr = '.new-post';
    await page.locator('#editSelectors').fill(JSON.stringify(source));
    await page.locator('#editorForm button[type="submit"]').click();
    await page.waitForFunction(() => window.__messages.some((message) => message.type === 'save-monitor'));
    const saved = await page.evaluate(() => window.__messages.find((message) => message.type === 'save-monitor').locators[0]);
    assert.equal(saved.identityAttribute, 'data-post-id'); assert.deepEqual(saved.frameVolatileParameters, ['nonce']);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

async function installExportMock(page, failSecond = false) {
  await page.evaluate((failSecond) => {
    window.__exportProgress = null; window.__exportPhase = 'ready'; window.__exportCheckpoints = [];
    window.__downloadArtifacts = []; window.__successfulParts = []; window.__downloadStates = {}; window.__downloadNumber = 0;
    window.__messageHandler = async (message) => {
      if (message.type === 'start-export-session') return { ok: true, id: 'durable-export', total: 3, progress: window.__exportProgress };
      if (message.type === 'get-export-monitor') return { ok: true, record: JSON.stringify({ _openStillRecovery: { id: `original-${message.index}`, source: 'import-record', raw: 'x'.repeat(11 * 1024 * 1024) } }) };
      if (message.type === 'checkpoint-export-session') {
        window.__exportProgress = structuredClone(message.progress);
        window.__exportCheckpoints.push({ ...structuredClone(message.progress), confirmedDownloads: window.__successfulParts.length });
        return { ok: true };
      }
      if (message.type === 'finish-export-session') { window.__exportPhase = message.completed ? 'completed' : 'paused'; return { ok: true }; }
      if (message.type === 'get-recovery-status') return { ok: true, records: [], sessions: window.__exportPhase === 'paused' ? [{ id: 'durable-export', kind: 'export', phase: 'paused', pending: 1, progress: window.__exportProgress }] : [] };
    };
    window.chrome.downloads = {
      onChanged: { addListener: () => {} },
      download: async ({ url, filename }) => {
        const payload = JSON.parse(await (await fetch(url)).text());
        const inspected = window.OpenStillBackupIntegrity.inspectBackupPart(payload);
        if (!inspected.ok) throw new Error(inspected.error);
        const id = ++window.__downloadNumber;
        const state = failSecond && id === 2 ? 'interrupted' : 'complete';
        window.__downloadStates[id] = state;
        const artifact = { filename, schemaVersion: payload.schemaVersion, exportId: payload.exportId, part: payload.part, finalPart: payload.integrity.finalPart, manifest: payload.manifest, previousPartDigest: payload.previousPartDigest, digest: inspected.part.digest, recordIds: payload.monitors.map((record) => record._openStillRecovery.id), state };
        window.__downloadArtifacts.push(artifact);
        if (state === 'complete') window.__successfulParts.push({ ...inspected.part, sourceName: filename });
        return id;
      },
      search: async ({ id }) => [{ id, state: window.__downloadStates[id] }]
    };
  }, failSecond);
}

test('actual v5 download blobs carry linked envelopes and checkpoint only confirmed parts', { skip: !chromium, timeout: 120000 }, async () => {
  const { page, errors } = await fixture(1);
  try {
    await installExportMock(page);
    await page.locator('#exportButton').click();
    await page.waitForFunction(() => window.__exportPhase === 'completed', null, { timeout: 90000 });
    const result = await page.evaluate(() => ({ artifacts: window.__downloadArtifacts, checkpoints: window.__exportCheckpoints, validation: window.OpenStillBackupIntegrity.validateBackupPartSelection([...window.__successfulParts].reverse()) }));
    assert.equal(result.artifacts.length, 2); assert.ok(result.artifacts.every((part) => part.schemaVersion === 5));
    assert.deepEqual(result.artifacts.flatMap((part) => part.recordIds), ['original-0', 'original-1', 'original-2']);
    assert.deepEqual(result.artifacts[1].manifest, [result.artifacts[0].digest]); assert.equal(result.artifacts[1].previousPartDigest, result.artifacts[0].digest);
    assert.deepEqual(result.validation, { ok: true });
    assert.deepEqual(result.checkpoints.map((checkpoint) => checkpoint.confirmedDownloads), [0, 1, 2]);
    assert.equal(result.checkpoints[1].nextIndex, 2); assert.equal(result.checkpoints[1].partNumber, 2); assert.equal(result.checkpoints[2].done, true);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('interrupted export resumes its saved set identity, cursor and manifest from recovery UI', { skip: !chromium, timeout: 120000 }, async () => {
  const { page, errors } = await fixture(1);
  try {
    await installExportMock(page, true);
    await page.locator('#exportButton').click();
    await page.waitForFunction(() => window.__exportPhase === 'paused', null, { timeout: 90000 });
    const before = await page.evaluate(() => ({ progress: window.__exportProgress, artifacts: window.__downloadArtifacts }));
    assert.equal(before.progress.nextIndex, 2); assert.equal(before.progress.partNumber, 2); assert.equal(before.progress.done, false); assert.equal(before.progress.manifest.length, 1);
    assert.match(await page.locator('#toast').textContent(), /다운로드가 중단/);
    assert.equal(await page.locator('#exportButton').isDisabled(), false);
    await page.getByRole('button', { name: '복구함', exact: true }).click();
    await page.getByRole('button', { name: '내보내기 이어가기', exact: true }).click();
    await page.waitForFunction(() => window.__exportPhase === 'completed', null, { timeout: 90000 });
    const result = await page.evaluate(() => ({ artifacts: window.__downloadArtifacts, starts: window.__messages.filter((message) => message.type === 'start-export-session'), reads: window.__messages.filter((message) => message.type === 'get-export-monitor').map((message) => message.index), validation: window.OpenStillBackupIntegrity.validateBackupPartSelection(window.__successfulParts) }));
    assert.equal(result.starts[1].resumeId, 'durable-export'); assert.deepEqual(result.reads, [0, 1, 2, 2]);
    assert.equal(result.artifacts[2].part, 2); assert.equal(result.artifacts[2].exportId, before.progress.exportId); assert.equal(result.artifacts[2].digest, before.artifacts[1].digest); assert.deepEqual(result.artifacts[2].manifest, before.progress.manifest);
    assert.deepEqual(result.validation, { ok: true }); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('partial import recovery commits with retry and reparses stored or added files in the same session', { skip: !chromium, timeout: 60000 }, async () => {
  const { page, errors } = await fixture(1);
  try {
    await page.addScriptTag({ url: 'https://dashboard.example.test/record-store.js' });
    await page.evaluate(async () => {
      const id = 'import-file:durable-import:5';
      const raw = new File([JSON.stringify({ format: 'openstill-export', schemaVersion: 3, monitors: [{ id: 'stored-record', url: 'https://recovered.example.test/', name: '보관된 항목' }] })], 'stored.json', { type: 'application/json' });
      await window.OpenStillRecordStore.putAux('staging', id, { kind: 'import-file', id, fileIndex: 5, raw, source: 'stored.json', phase: 'reading' });
      window.__importSession = { id: 'durable-import', kind: 'import', phase: 'partial', pending: 1, files: [{ id, fileIndex: 5, source: 'stored.json', name: 'stored.json', size: raw.size, phase: 'reading' }] };
      window.__messageHandler = async (message) => {
        if (message.type === 'get-recovery-status') return { ok: true, records: [], sessions: [window.__importSession] };
        if (message.type === 'start-import-session') return { ok: true, id: 'durable-import' };
        if (message.type === 'finish-import-session') return { ok: true, imported: 1, rejected: 0 };
      };
    });
    await page.getByRole('button', { name: '복구함', exact: true }).click();
    await page.getByRole('button', { name: '준비한 자료 복원', exact: true }).click();
    await page.waitForFunction(() => window.__messages.some((message) => message.type === 'finish-import-session'));
    assert.equal(await page.evaluate(() => window.__messages.find((message) => message.type === 'finish-import-session').retry), true);
    await page.getByRole('button', { name: '복구함', exact: true }).click();
    await page.getByRole('button', { name: '보관된 파일 처리 이어가기', exact: true }).click();
    await page.waitForFunction(() => window.__messages.some((message) => message.type === 'append-import-session' && message.monitors?.[0]?.id === 'stored-record'));
    await page.waitForFunction(() => window.__messages.filter((message) => message.type === 'finish-import-session').length === 2);
    assert.equal(await page.evaluate(() => window.__messages.find((message) => message.type === 'start-import-session').resumeId), 'durable-import');
    await page.evaluate(() => { window.__importSession.files[0].phase = 'parsed'; });
    await page.getByRole('button', { name: '복구함', exact: true }).click();
    await page.locator('#recoveryDialog input[type="file"]').setInputFiles({ name: 'added.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'openstill-export', schemaVersion: 3, monitors: [{ id: 'added-record', url: 'https://added.example.test/', name: '추가 항목' }] })) });
    await page.waitForFunction(() => window.__messages.some((message) => message.type === 'append-import-session' && message.monitors?.[0]?.id === 'added-record'));
    await page.waitForFunction(() => window.__messages.filter((message) => message.type === 'finish-import-session').length === 3);
    const files = await page.evaluate(async () => (await window.OpenStillRecordStore.allAux('staging')).filter((entry) => entry.kind === 'import-file').map(({ id, phase }) => ({ id, phase })));
    assert.ok(files.some((file) => file.id === 'import-file:durable-import:5' && file.phase === 'parsed'));
    assert.ok(files.some((file) => file.id === 'import-file:durable-import:6' && file.phase === 'parsed'));
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
