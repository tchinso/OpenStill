'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Keep browser checks optional in the dependency-free Node suite. The host can
// supply Playwright and its installed browser without adding project packages.
let chromium;
try { ({ chromium } = require(process.env.OPENSTILL_PLAYWRIGHT_MODULE || 'playwright')); } catch { /* optional */ }
const pickerSource = ['selector-engine.js', 'picker.js']
  .map((name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8')).join('\n');
const workerSource = fs.readFileSync(path.join(__dirname, '..', 'service-worker.js'), 'utf8');
const captureStart = workerSource.indexOf('async function captureReferenceRenderedDocumentCollection(');
const captureEnd = workerSource.indexOf('\n// Reference-compatible CSS monitor capture', captureStart);
const captureSource = workerSource.slice(captureStart, captureEnd);
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

const styles = `<style>
  body { margin: 0; padding: 30px; font-family: sans-serif; }
  .feed { width: 360px; }
  .card { position: relative; padding: 22px; margin-bottom: 14px; border: 1px solid #ccc; }
  .cover { position: absolute; inset: 0; z-index: 2; }
  .card-title { font-size: 20px; line-height: 28px; margin: 0; }
  .card-detail { margin-top: 12px; }
</style>`;
const card = (title, index = 1) => `<article class="card">
  <a class="cover" href="/entries/${index}" aria-label="${title}" title="${title}"></a>
  <h2 class="card-title">${title}</h2><p class="card-detail">Entry details</p>
</article>`;
const utilityTitleClasses = 'text-sm font-medium text-ink-800 line-clamp-2 group-hover:text-sakura-600';
const utilityCard = (title, index = 1) => `<article class="moe-card moe-card-hover !rounded-2xl overflow-hidden flex flex-col group relative isolate">
  <a class="absolute inset-0 z-0" href="/entries/${index}" aria-label="${title}" title="${title}"></a>
  <div class="aspect-[3/2] bg-sakura-50 relative overflow-hidden pointer-events-none"></div>
  <div class="p-3 flex flex-col gap-2 flex-1"><div class="${utilityTitleClasses}">${title}</div>
    <div class="text-xs text-ink-500"><a href="/authors/${index}">Author ${index}</a><span> · Entry details</span></div>
  </div>
</article>`;

async function fixture(html, prepare = null) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html>${styles}${html}` }));
  await page.goto('https://picker.example.test/feed');
  if (prepare) await page.evaluate(prepare);
  await page.evaluate((script) => {
    globalThis.__pickerMessages = [];
    globalThis.chrome = { runtime: { sendMessage: async (message) => {
      globalThis.__pickerMessages.push(message);
      return { ok: true };
    } } };
    (0, eval)(script);
  }, pickerSource);
  return page;
}

async function mouseTarget(page, selector, click = true) {
  const rect = await page.locator(selector).boundingBox();
  assert.ok(rect, `Missing pointer target ${selector}`);
  const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  await page.mouse.move(point.x, point.y);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (click) {
    await page.mouse.click(point.x, point.y);
    await page.waitForFunction(() => globalThis.__openStillPickerInstance__?.mode === 'editing');
  }
}

async function clickPickerButton(page, selector) {
  const target = await page.evaluate((expression) => {
    const button = globalThis.__openStillPickerInstance__.shadow.querySelector(expression);
    const rect = button?.getBoundingClientRect();
    return button ? { disabled: button.disabled, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
  }, selector);
  assert.ok(target, `Missing picker control ${selector}`);
  assert.equal(target.disabled, false, `Disabled picker control ${selector}`);
  await page.mouse.click(target.x, target.y);
}

async function selectionSnapshot(page) {
  return page.evaluate(() => {
    const picker = globalThis.__openStillPickerInstance__;
    const selection = picker.currentSelection();
    return {
      selector: selection?.selector,
      selectorType: selection?.selectorType,
      fields: selection?.fields,
      text: selection?.text,
      localName: selection?.element?.localName,
      className: selection?.element?.className,
      totalMatchCount: selection?.totalMatchCount,
      selectionCount: picker.selections.length,
      preview: picker.shadow.querySelector('.preview')?.textContent,
      validity: picker.validity.textContent,
      hovered: picker.hoveredElement?.localName,
      hoveredClass: picker.hoveredElement?.className
    };
  });
}

async function captureSelections(page) {
  return page.evaluate(async (script) => {
    const capture = (0, eval)(`(${script})`);
    const locators = globalThis.__openStillPickerInstance__.selections.map((selection) => ({
      type: selection.selectorType, expr: selection.selector, op: selection.op,
      fields: selection.fields, fieldsSpecified: true
    }));
    return capture(locators, 0, 0, 0, 0, 0, {});
  }, captureSource);
}

test('mouse hover and click pass an empty covering link to its visible title; refreshed first slots capture current text', { skip: !chromium }, async () => {
  const page = await fixture(`<main class="feed">${card('First entry', 1)}${card('Second entry', 2)}${card('Third entry', 3)}</main>`);
  try {
    // This is a real hit-test: the topmost link receives the pointer, while the
    // title underneath is the readable element the picker should highlight.
    assert.equal(await page.locator('.cover').first().evaluate((element) => {
      const title = element.nextElementSibling.getBoundingClientRect();
      return document.elementFromPoint(title.x + title.width / 2, title.y + title.height / 2) === element;
    }), true);
    await mouseTarget(page, '.card-title >> nth=0', false);
    const hover = await selectionSnapshot(page);
    assert.equal(hover.hovered, 'h2');
    assert.equal(hover.hoveredClass, 'card-title');
    await mouseTarget(page, '.card-title >> nth=0');
    const selected = await selectionSnapshot(page);
    assert.equal(selected.localName, 'h2');
    assert.deepEqual(selected.fields, [{ type: 'text' }]);
    assert.equal(selected.preview, 'First entry');
    assert.doesNotMatch(selected.selector, /First entry|\/entries\/1|aria-label|title=/);
    const initial = await captureSelections(page);
    assert.equal(initial.ok, true, initial.error);
    assert.equal(initial.text, 'First entry');

    await page.evaluate(() => {
      const first = document.querySelector('.card');
      first.querySelector('.card-title').textContent = 'Updated entry';
      first.querySelector('.cover').setAttribute('aria-label', 'Updated entry');
      globalThis.__openStillPickerInstance__.validateSelector();
    });
    assert.equal((await selectionSnapshot(page)).selector, selected.selector);
    assert.equal((await selectionSnapshot(page)).preview, 'Updated entry');
    assert.equal((await captureSelections(page)).text, 'Updated entry');

    await page.evaluate((markup) => {
      document.querySelector('.feed').insertAdjacentHTML('afterbegin', markup);
      globalThis.__openStillPickerInstance__.validateSelector();
    }, card('Newest entry', 4));
    const prepended = await selectionSnapshot(page);
    assert.equal(prepended.selector, selected.selector);
    assert.equal(prepended.totalMatchCount, 1);
    assert.equal(prepended.preview, 'Newest entry');
    assert.equal((await captureSelections(page)).text, 'Newest entry');
  } finally { await page.close(); }
});

test('empty named elements default to attribute extraction without binding their changing names into selectors', { skip: !chromium }, async () => {
  for (const name of ['aria-label', 'title', 'alt']) {
    const page = await fixture(`<a class="named-link" ${name}="Initial name" href="/entries/current"></a>`);
    try {
      await page.evaluate(async () => {
        await globalThis.__openStillPickerInstance__.selectElement(document.querySelector('.named-link'));
      });
      const selected = await selectionSnapshot(page);
      assert.deepEqual(selected.fields, [{ type: 'attribute', name }]);
      assert.equal(selected.preview, 'Initial name');
      assert.doesNotMatch(selected.selector, /Initial name|\/entries\/current/);
      assert.equal((await captureSelections(page)).text, 'Initial name');
      await page.evaluate((attribute) => {
        document.querySelector('.named-link').setAttribute(attribute, 'Changed name');
        globalThis.__openStillPickerInstance__.validateSelector();
      }, name);
      const changed = await selectionSnapshot(page);
      assert.equal(changed.selector, selected.selector);
      assert.equal(changed.preview, 'Changed name');
      assert.equal((await captureSelections(page)).text, 'Changed name');
    } finally { await page.close(); }
  }
});

test('field preview and saved extraction preserve absolute URL attributes and scalar zero and false', { skip: !chromium }, async () => {
  const page = await fixture('<a class="ordinary" href="/entries/7">Visible entry</a>', () => {
    const link = document.querySelector('.ordinary');
    link.zeroValue = 0;
    link.falseValue = false;
  });
  try {
    await mouseTarget(page, '.ordinary');
    await page.evaluate(() => {
      const picker = globalThis.__openStillPickerInstance__;
      picker.editorFields = [
        { type: 'attribute', name: 'href' },
        { type: 'property', name: 'zeroValue' },
        { type: 'property', name: 'falseValue' }
      ];
      picker.commitFieldEditorChange();
    });
    const selected = await selectionSnapshot(page);
    assert.match(selected.preview, /https:\/\/picker\.example\.test\/entries\/7/);
    assert.match(selected.preview, /\b0\b/);
    assert.match(selected.preview, /\bfalse\b/);
    assert.doesNotMatch(selected.preview, /Visible entry/);
    const captured = await captureSelections(page);
    assert.equal(captured.ok, true, captured.error);
    assert.equal(captured.text.replace(/\s+/g, ' ').trim(), selected.preview.replace(/\s+/g, ' ').trim());
    await page.evaluate(async () => { await globalThis.__openStillPickerInstance__.save(); });
    const message = await page.evaluate(() => globalThis.__pickerMessages.find((item) => item.type === 'create-monitors'));
    assert.deepEqual(message.items[0].fields, selected.fields);
    assert.equal(message.items[0].fieldsSpecified, true);
  } finally { await page.close(); }
});

test('explicit text fields stay empty and distinguish a matched empty extraction from a missing selector', { skip: !chromium }, async () => {
  const page = await fixture('<a class="named-link" aria-label="Accessible name" href="/entries/current"></a>');
  try {
    await page.evaluate(async () => {
      const picker = globalThis.__openStillPickerInstance__;
      await picker.selectElement(document.querySelector('.named-link'));
      picker.editorFields = [{ type: 'text' }];
      picker.commitFieldEditorChange();
    });
    const empty = await selectionSnapshot(page);
    assert.deepEqual(empty.fields, [{ type: 'text' }]);
    assert.equal(empty.totalMatchCount, 1);
    assert.equal(empty.text, '');
    assert.doesNotMatch(empty.preview || '', /Accessible name/);
    assert.match(empty.validity, /1개/);
    assert.match(empty.validity, /(?:비어|없|empty)/i);
    const captured = await captureSelections(page);
    assert.equal(captured.ok, true, captured.error);
    assert.equal(captured.matchCount, 1);
    assert.equal(captured.text, '');
    await page.evaluate(() => {
      const picker = globalThis.__openStillPickerInstance__;
      picker.selectorInput.value = '.absent';
      picker.validateSelector();
    });
    const missing = await selectionSnapshot(page);
    assert.match(missing.validity, /일치하는 요소가 없습니다/);
    assert.notEqual(missing.validity, empty.validity);
  } finally { await page.close(); }
});

test('ordinary text links remain the selected element during mouse hover and click', { skip: !chromium }, async () => {
  const page = await fixture('<article class="card"><a class="ordinary" href="/entries/9">Readable entry</a><h2 class="card-title">Other text</h2></article>');
  try {
    await mouseTarget(page, '.ordinary', false);
    const hover = await selectionSnapshot(page);
    assert.equal(hover.hovered, 'a');
    assert.equal(hover.hoveredClass, 'ordinary');
    await mouseTarget(page, '.ordinary');
    const selected = await selectionSnapshot(page);
    assert.equal(selected.localName, 'a');
    assert.equal(selected.className, 'ordinary');
    assert.deepEqual(selected.fields, [{ type: 'text' }]);
    assert.equal(selected.preview, 'Readable entry');
    assert.equal((await captureSelections(page)).text, 'Readable entry');
  } finally { await page.close(); }
});

test('a separate modal overlay never passes the pointer through to unrelated content', { skip: !chromium }, async () => {
  const page = await fixture(`<main class="feed">${card('Covered entry')}</main><aside style="position:fixed;inset:0;z-index:20"><a class="modal-mask" href="/dialog" aria-label="Open dialog" style="position:absolute;inset:0"></a></aside>`);
  try {
    await mouseTarget(page, '.card-title', false);
    const hover = await selectionSnapshot(page);
    assert.equal(hover.hovered, 'a');
    assert.equal(hover.hoveredClass, 'modal-mask');
    await mouseTarget(page, '.card-title');
    const selected = await selectionSnapshot(page);
    assert.equal(selected.localName, 'a');
    assert.equal(selected.className, 'modal-mask');
    assert.equal(selected.preview, 'Open dialog');
    assert.doesNotMatch(selected.preview || '', /Covered entry/);
  } finally { await page.close(); }
});

test('covering links inside shadow roots resolve their visible titles and retain XCSS capture boundaries', { skip: !chromium }, async () => {
  const page = await fixture('<entry-feed></entry-feed>', () => {
    const root = document.querySelector('entry-feed').attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host { display:block; width:360px; }
      article { position:relative; padding:22px; border:1px solid #ccc; }
      .cover { position:absolute; inset:0; z-index:2; }
      h2 { font:20px/28px sans-serif; margin:0; }
    </style><article><a class="cover" href="/entries/shadow" aria-label="Shadow entry"></a><h2>Shadow entry</h2></article>`;
  });
  try {
    await mouseTarget(page, 'entry-feed h2', false);
    assert.equal(await page.evaluate(() => globalThis.__openStillPickerInstance__.hoveredElement === document.querySelector('entry-feed').shadowRoot.querySelector('h2')), true);
    await mouseTarget(page, 'entry-feed h2');
    const selected = await selectionSnapshot(page);
    assert.equal(selected.localName, 'h2');
    assert.equal(selected.selectorType, 'xcss');
    assert.equal(selected.preview, 'Shadow entry');
    const captured = await captureSelections(page);
    assert.equal(captured.ok, true, captured.error);
    assert.equal(captured.text, 'Shadow entry');
  } finally { await page.close(); }
});

test('picker scope buttons widen to containing areas and narrow back to the original title', { skip: !chromium }, async () => {
  const page = await fixture(`<main class="feed">${card('First entry')}${card('Second entry', 2)}</main>`);
  try {
    await mouseTarget(page, '.card-title >> nth=0');
    const initial = await selectionSnapshot(page);
    assert.equal(await page.evaluate(() => globalThis.__openStillPickerInstance__.narrowButton.disabled), true);
    await clickPickerButton(page, '#widen');
    const cardScope = await selectionSnapshot(page);
    assert.equal(cardScope.localName, 'article');
    assert.equal(cardScope.totalMatchCount, 1);
    assert.match(cardScope.preview, /First entry/);
    assert.match(cardScope.preview, /Entry details/);
    await clickPickerButton(page, '#widen');
    assert.equal((await selectionSnapshot(page)).localName, 'main');
    await clickPickerButton(page, '#narrow');
    assert.equal((await selectionSnapshot(page)).localName, 'article');
    await clickPickerButton(page, '#narrow');
    const restored = await selectionSnapshot(page);
    assert.equal(restored.localName, 'h2');
    assert.equal(restored.selector, initial.selector);
    assert.equal(restored.preview, 'First entry');
    assert.deepEqual(restored.fields, initial.fields);
    assert.equal(restored.selectionCount, 1);
    assert.equal(await page.evaluate(() => globalThis.__openStillPickerInstance__.narrowButton.disabled), true);
  } finally { await page.close(); }
});

test('similar selection groups utility-heavy card titles into one rule and includes new cards without unrelated text', { skip: !chromium }, async () => {
  const page = await fixture(`<style>
    .utility-feed { width:360px; }
    .utility-feed article { position:relative; isolation:isolate; display:flex; flex-direction:column; margin-bottom:12px; border:1px solid #ccc; }
    .utility-feed .absolute { position:absolute; inset:0; z-index:0; }
    .utility-feed [class~="aspect-[3/2]"] { height:48px; position:relative; pointer-events:none; }
    .utility-feed .p-3 { padding:12px; display:flex; flex-direction:column; gap:8px; }
    .utility-feed .font-medium { font-size:14px; line-height:20px; }
  </style><main class="utility-feed">${utilityCard('First card', 1)}${utilityCard('Second card', 2)}${utilityCard('Third card', 3)}</main>
  <aside><div class="${utilityTitleClasses}">Unrelated title</div></aside>`);
  try {
    const titleSelector = '.utility-feed article:first-child .font-medium';
    assert.equal(await page.locator(titleSelector).evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === element.closest('article').querySelector('a');
    }), true);
    await mouseTarget(page, titleSelector, false);
    assert.equal(await page.evaluate(() => globalThis.__openStillPickerInstance__.hoveredElement === document.querySelector('.utility-feed article:first-child .font-medium')), true);
    await mouseTarget(page, titleSelector);
    assert.equal((await selectionSnapshot(page)).preview, 'First card');
    await clickPickerButton(page, '#selectSimilar');
    await page.waitForFunction(() => globalThis.__openStillPickerInstance__.currentSelection()?.totalMatchCount === 3);
    const grouped = await selectionSnapshot(page);
    assert.equal(grouped.selectionCount, 1);
    assert.equal(grouped.selectorType, 'css');
    assert.doesNotMatch(grouped.selector, /First card|Second card|Third card|\/entries\/|\/authors\/|aria-label|title=/);
    assert.doesNotMatch(grouped.preview, /Unrelated title|Author|Entry details/);
    assert.equal(await page.evaluate(() => {
      const picker = globalThis.__openStillPickerInstance__;
      return picker.currentSelection().matchedElements.every((element) => element.matches('.utility-feed .font-medium'));
    }), true);
    const captured = await captureSelections(page);
    assert.equal(captured.ok, true, captured.error);
    assert.equal(captured.matchCount, 3);
    assert.match(captured.text, /First card/);
    assert.match(captured.text, /Second card/);
    assert.match(captured.text, /Third card/);
    assert.doesNotMatch(captured.text, /Unrelated title|Author|Entry details/);

    await page.evaluate((markup) => {
      document.querySelector('.utility-feed').insertAdjacentHTML('afterbegin', markup);
      globalThis.__openStillPickerInstance__.validateSelector();
    }, utilityCard('Fresh card', 4));
    const refreshed = await selectionSnapshot(page);
    assert.equal(refreshed.selector, grouped.selector);
    assert.equal(refreshed.selectionCount, 1);
    assert.equal(refreshed.totalMatchCount, 4);
    const current = await captureSelections(page);
    assert.equal(current.ok, true, current.error);
    assert.equal(current.matchCount, 4);
    assert.match(current.text, /Fresh card/);
    assert.doesNotMatch(current.text, /Unrelated title|Author|Entry details/);
    await page.evaluate(async () => { await globalThis.__openStillPickerInstance__.save(); });
    const message = await page.evaluate(() => globalThis.__pickerMessages.find((item) => item.type === 'create-monitors'));
    assert.equal(message.items.length, 1);
    assert.equal(message.items[0].expr, grouped.selector);
  } finally { await page.close(); }
});

test('similar selection keeps a unique title unchanged when no repeated card family exists', { skip: !chromium }, async () => {
  const page = await fixture(`<main class="feed">${card('Unique entry')}</main><aside><h2 class="card-title">Unrelated heading</h2></aside>`);
  try {
    await mouseTarget(page, '.feed .card-title');
    const initial = await selectionSnapshot(page);
    await clickPickerButton(page, '#selectSimilar');
    await page.waitForFunction(() => /유사한 요소를 찾지 못했습니다/.test(globalThis.__openStillPickerInstance__.message.textContent));
    const unchanged = await selectionSnapshot(page);
    assert.equal(unchanged.selector, initial.selector);
    assert.deepEqual(unchanged.fields, initial.fields);
    assert.equal(unchanged.totalMatchCount, 1);
    assert.equal(unchanged.selectionCount, 1);
    assert.equal(unchanged.preview, 'Unique entry');
  } finally { await page.close(); }
});

test('SelectorX prefers a meaningful title class over modern layout utilities and survives layout class changes', { skip: !chromium }, async () => {
  const page = await fixture('<section><h2 class="relative inset-0 z-20 line-clamp-2 pointer-events-none post-title">Meaningful entry</h2><h2 class="card-title">Another heading</h2></section>');
  try {
    const result = await page.evaluate(async () => {
      const element = document.querySelector('.post-title');
      const selector = await globalThis.__openStillSelectorX.getCSS([element], { timeout: 500 });
      const before = [...document.querySelectorAll(selector)];
      element.className = 'post-title block border z-0';
      const after = [...document.querySelectorAll(selector)];
      return { selector, before: before.length === 1 && before[0] === element, after: after.length === 1 && after[0] === element };
    });
    assert.equal(result.before, true);
    assert.match(result.selector, /post-title/);
    assert.doesNotMatch(result.selector, /inset|clamp|relative|pointer|z-20/);
    assert.equal(result.after, true);
  } finally { await page.close(); }
});

test('a small absolute bookmark link over a title remains the selected link', { skip: !chromium }, async () => {
  const page = await fixture(`<style>
    .bookmark { position:absolute; left:22px; top:22px; width:25px; height:25px; z-index:2; }
    .bookmark::before { content:'★'; }
  </style><article class="card"><h2 class="card-title">Title behind bookmark</h2>
  <a class="bookmark" href="/bookmarks/current" aria-label="Bookmark"></a></article>`);
  try {
    assert.equal(await page.locator('.bookmark').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const stack = document.elementsFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return stack[0] === element && stack.includes(element.previousElementSibling);
    }), true);
    await mouseTarget(page, '.bookmark', false);
    const hover = await selectionSnapshot(page);
    assert.equal(hover.hovered, 'a');
    assert.equal(hover.hoveredClass, 'bookmark');
    await mouseTarget(page, '.bookmark');
    const selected = await selectionSnapshot(page);
    assert.equal(selected.localName, 'a');
    assert.equal(selected.className, 'bookmark');
    assert.deepEqual(selected.fields, [{ type: 'attribute', name: 'aria-label' }]);
    assert.equal(selected.preview, 'Bookmark');
    assert.equal((await captureSelections(page)).text, 'Bookmark');
  } finally { await page.close(); }
});

test('similar titles sharing a utility class with authors group across articles without including authors', { skip: !chromium }, async () => {
  const sharedCard = (title, index) => `<article class="card"><a class="cover" href="/entries/shared-${index}" aria-label="${title}"></a>
    <div class="text-sm font-medium">${title}</div><div class="text-sm muted">Author ${index}</div></article>`;
  const page = await fixture(`<main class="feed">${sharedCard('First shared title', 1)}${sharedCard('Second shared title', 2)}</main>
    <aside><div class="text-sm font-medium">Outside title</div></aside>`);
  try {
    await mouseTarget(page, '.feed article:first-child .font-medium');
    assert.equal((await selectionSnapshot(page)).preview, 'First shared title');
    await clickPickerButton(page, '#selectSimilar');
    await page.waitForFunction(() => globalThis.__openStillPickerInstance__.currentSelection()?.totalMatchCount === 2);
    const grouped = await selectionSnapshot(page);
    assert.equal(grouped.selectionCount, 1);
    assert.equal(await page.evaluate(() => globalThis.__openStillPickerInstance__.currentSelection().matchedElements.every((element) => element.matches('.feed .font-medium') && !element.matches('.muted'))), true);
    const initial = await captureSelections(page);
    assert.equal(initial.ok, true, initial.error);
    assert.equal(initial.matchCount, 2);
    assert.match(initial.text, /First shared title/);
    assert.match(initial.text, /Second shared title/);
    assert.doesNotMatch(initial.text, /Author|Outside title/);
    await page.evaluate((markup) => {
      document.querySelector('.feed').insertAdjacentHTML('afterbegin', markup);
      globalThis.__openStillPickerInstance__.validateSelector();
    }, sharedCard('Fresh shared title', 3));
    const refreshed = await selectionSnapshot(page);
    assert.equal(refreshed.selector, grouped.selector);
    assert.equal(refreshed.totalMatchCount, 3);
    const current = await captureSelections(page);
    assert.equal(current.ok, true, current.error);
    assert.equal(current.matchCount, 3);
    assert.match(current.text, /Fresh shared title/);
    assert.doesNotMatch(current.text, /Author|Outside title/);
  } finally { await page.close(); }
});

test('light DOM attribute preview matches filtered capture and deduplicates named values without altering saved fields', { skip: !chromium }, async () => {
  const page = await fixture('<a class="ordinary" href="/entries/filtered" style="color: purple" onclick="return false">Filtered entry</a>');
  try {
    await mouseTarget(page, '.ordinary');
    await page.evaluate(() => {
      const picker = globalThis.__openStillPickerInstance__;
      picker.editorFields = [
        { type: 'attribute', name: 'href' },
        { type: 'attribute', name: 'style' },
        { type: 'attribute', name: 'onclick' },
        { type: 'attribute', name: 'href' }
      ];
      picker.commitFieldEditorChange();
    });
    const selected = await selectionSnapshot(page);
    assert.equal(selected.fields.length, 4);
    assert.equal(selected.preview, 'https://picker.example.test/entries/filtered\nundefined\nundefined');
    const captured = await captureSelections(page);
    assert.equal(captured.ok, true, captured.error);
    assert.equal(captured.text, selected.preview);
    assert.doesNotMatch(captured.text, /color: purple|return false/);
    await page.evaluate(async () => { await globalThis.__openStillPickerInstance__.save(); });
    const message = await page.evaluate(() => globalThis.__pickerMessages.find((item) => item.type === 'create-monitors'));
    assert.deepEqual(message.items[0].fields, selected.fields);
  } finally { await page.close(); }
});

test('shadow attribute preview retains live style and inline handler values exactly as capture does', { skip: !chromium }, async () => {
  const page = await fixture('<entry-feed></entry-feed>', () => {
    const root = document.querySelector('entry-feed').attachShadow({ mode: 'open' });
    root.innerHTML = '<a href="/entries/shadow-fields" style="color: purple" onclick="return false">Shadow entry</a>';
  });
  try {
    await mouseTarget(page, 'entry-feed a');
    await page.evaluate(() => {
      const picker = globalThis.__openStillPickerInstance__;
      picker.editorFields = [
        { type: 'attribute', name: 'style' },
        { type: 'attribute', name: 'onclick' },
        { type: 'attribute', name: 'href' },
        { type: 'attribute', name: 'href' }
      ];
      picker.commitFieldEditorChange();
    });
    const selected = await selectionSnapshot(page);
    assert.equal(selected.selectorType, 'xcss');
    assert.equal(selected.preview, 'color: purple\nreturn false\n/entries/shadow-fields');
    const captured = await captureSelections(page);
    assert.equal(captured.ok, true, captured.error);
    assert.equal(captured.text, selected.preview);
  } finally { await page.close(); }
});
