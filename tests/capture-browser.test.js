'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');

// Browser regressions are optional in the dependency-free Node suite. Run with
// OPENSTILL_PLAYWRIGHT_MODULE set when Playwright is supplied by the host.
let chromium;
try { ({ chromium } = require(process.env.OPENSTILL_PLAYWRIGHT_MODULE || 'playwright')); } catch { /* optional */ }
const source = fs.readFileSync(path.join(__dirname, '..', 'service-worker.js'), 'utf8');
const start = source.indexOf('async function captureReferenceRenderedDocumentCollection(');
const end = source.indexOf('\n// Reference-compatible CSS monitor capture', start);
const captureSource = source.slice(start, end);
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

async function captureFixture(html, locators, options = {}, prepare = null) {
  const page = await browser.newPage();
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://capture.example.test/board');
  if (prepare) await page.evaluate(prepare);
  const result = await page.evaluate(async ({ captureSource, locators, options }) => {
    const original = document.documentElement.outerHTML;
    const mutations = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(document, { childList: true, attributes: true, characterData: true, subtree: true });
    const capture = (0, eval)(`(${captureSource})`);
    const output = await capture(locators, 0, 0, 0, options.retryCount || 0, 0, options);
    await Promise.resolve();
    observer.disconnect();
    return { output, unchanged: original === document.documentElement.outerHTML, mutations: mutations.length };
  }, { captureSource, locators, options });
  await page.close();
  return result;
}

test('template content, nested templates and comments survive without page mutations', { skip: !chromium }, async () => {
  const result = await captureFixture('<html><head></head><body><template id="outer">alpha<!--keep--><template>nested</template></template></body></html>',
    [{ expr: '#outer', type: 'css', op: 'include' }], { keepComments: true });
  assert.equal(result.output.ok, true);
  assert.match(result.output.text, /alpha.*nested/s);
  assert.match(result.output.html, /<!--keep-->/);
  assert.match(result.output.html, /<template>nested<\/template>/);
  assert.equal(result.unchanged, true);
  assert.equal(result.mutations, 0);
});

test('original scalar properties retain zero and false; multiple locators union fields', { skip: !chromium }, async () => {
  const result = await captureFixture('<html><head></head><body><a id="item" href="/post/1">title</a></body></html>', [
    { expr: '#item', type: 'css', op: 'include', fields: [{ type: 'text' }], fieldsSpecified: true },
    { expr: '#item', type: 'css', op: 'include', fields: [{ type: 'attribute', name: 'href' }, { type: 'property', name: 'zero' }, { type: 'property', name: 'disabledValue' }], fieldsSpecified: true }
  ], {}, () => { document.querySelector('#item').zero = 0; document.querySelector('#item').disabledValue = false; });
  assert.equal(result.output.ok, true);
  assert.match(result.output.text, /title/);
  assert.match(result.output.text, /https:\/\/capture\.example\.test\/post\/1/);
  assert.match(result.output.text, /0\s+false/);
  assert.equal(result.output.items[0].locators.length, 2);
  assert.equal(result.output.items[0].identity.key, 'url:https://capture.example.test/post/1');
  assert.equal(result.unchanged, true);
});

test('per-post identity and partial locator diagnostics persist', { skip: !chromium }, async () => {
  const result = await captureFixture('<html><head></head><body><article class="post" data-post-id="B"><a href="/posts/B">same title</a></article><article class="post" data-post-id="C"><a href="/posts/C">same title</a></article></body></html>', [
    { expr: '.post', type: 'css', op: 'include' }, { expr: '.missing', type: 'css', op: 'include' }
  ]);
  assert.equal(result.output.items.length, 2);
  assert.equal(result.output.items[0].identity.key, 'attr:data-post-id:B');
  assert.equal(result.output.items[1].identity.key, 'attr:data-post-id:C');
  assert.equal(result.output.captureQuality.status, 'partial');
  assert.equal(result.output.captureQuality.missingLocators[0].expr, '.missing');
});

test('textless covering links match without inventing text; explicit named fields capture their content', { skip: !chromium }, async () => {
  const html = '<section>' + ['First title', 'Second title', 'Third title'].map((title, index) =>
    `<article><a class="absolute inset-0 z-0" aria-label="${title}" title="${title}" href="/post/${index + 1}"></a><div>${title}</div></article>`
  ).join('') + '</section>';
  const locators = ['article:first-child', 'article:nth-child(2)', 'article:nth-child(3)'].map((expr) => ({
    type: 'css', expr: `${expr} [class*='inset']`, op: 'include', fields: [{ type: 'text' }], fieldsSpecified: true
  }));
  const empty = await captureFixture(html, locators);
  assert.equal(empty.output.ok, true);
  assert.equal(empty.output.exists, false);
  assert.equal(empty.output.matchCount, 3);
  assert.equal(empty.output.text, '');
  assert.deepEqual(empty.output.selectorMatches.map((match) => match.matchCount), [1, 1, 1]);
  assert.equal(empty.output.captureQuality.status, 'complete');
  assert.equal(empty.unchanged, true);
  const named = await captureFixture(html, locators.map((locator) => ({ ...locator,
    fields: [{ type: 'attribute', name: 'aria-label' }, { type: 'attribute', name: 'href' }]
  })));
  assert.equal(named.output.exists, true);
  assert.match(named.output.text, /First title/);
  assert.match(named.output.text, /https:\/\/capture\.example\.test\/post\/1/);
  assert.equal(named.output.items.length, 3);
  assert.equal(named.unchanged, true);
});

test('visible sibling titles retain distinct identities from their exactly labelled empty card links', { skip: !chromium }, async () => {
  const html = '<section><article><a class="cover" aria-label="Same   title" href="/post/1"></a>'
    + '<h2 class="entry-title">Same title</h2><a href="/author/1">Author</a></article>'
    + '<article><a class="cover" title="Same title" href="/post/2"></a>'
    + '<h2 class="entry-title">Same title</h2><a href="/author/2">Author</a></article></section>';
  const result = await captureFixture(html, [{ type: 'css', expr: '.entry-title', op: 'include' }]);
  assert.equal(result.output.ok, true, result.output.error);
  assert.deepEqual(result.output.items.map((item) => item.text), ['Same title', 'Same title']);
  assert.deepEqual(result.output.items.map((item) => item.identity?.key), [
    'url:https://capture.example.test/post/1', 'url:https://capture.example.test/post/2'
  ]);
  assert.doesNotMatch(result.output.html, /\/post\/|\/author\//);
  assert.equal(result.unchanged, true);
  assert.equal(result.mutations, 0);
});

test('card title identities reject ambiguous, unrelated, non-HTTP and explicitly excluded sibling links', { skip: !chromium }, async () => {
  const title = '<h2 class="entry-title">Same title</h2>';
  const emptyLink = '<a class="cover" aria-label="Same title" href="/post/1"></a>';
  const include = { type: 'css', expr: '.entry-title', op: 'include' };
  const cases = [
    { html: `<article>${title}${emptyLink}<a aria-label="Same title" href="/post/2"></a></article>` },
    { html: `<article>${title}<a aria-label="Different title" href="/post/1"></a><a aria-label="Same title" href="/author/1">Author</a></article>` },
    { html: `<article>${title}<a aria-label="Same title" href="javascript:void(0)"></a></article>` },
    { html: `<div>${title}${emptyLink}</div>` },
    { html: `<article>${title}<article>${emptyLink}</article></article>` },
    { html: `<article>${title}${emptyLink}</article>`, exclude: { type: 'css', expr: '.cover', op: 'exclude' } },
    { html: `<article>${title}${emptyLink}</article>`, exclude: { type: 'xpath', expr: '//a/@href', op: 'exclude' } },
    { html: `<article>${title}${emptyLink}</article>`, exclude: { type: 'xpath', expr: '//a/@aria-label', op: 'exclude' } }
  ];
  for (const fixture of cases) {
    const result = await captureFixture(fixture.html, [include, ...(fixture.exclude ? [fixture.exclude] : [])]);
    assert.equal(result.output.ok, true, result.output.error);
    assert.equal(result.output.items[0].text, 'Same title');
    assert.equal(result.output.items[0].identity, undefined, JSON.stringify(fixture));
    assert.equal(result.unchanged, true);
  }
});

test('XPath attributes extract values and unsupported result kinds give actionable errors', { skip: !chromium }, async () => {
  const attribute = await captureFixture('<a href="/post/1">title</a>', [{ type: 'xpath', expr: '//a/@href', op: 'include' }]);
  assert.equal(attribute.output.ok, true);
  assert.equal(attribute.output.text, 'https://capture.example.test/post/1');
  const text = await captureFixture('<p>title</p>', [{ type: 'xpath', expr: '//p/text()', op: 'include' }]);
  assert.equal(text.output.ok, false);
  assert.match(text.output.error, /elements or attributes/);
});

test('offscreen XPath inspection agrees with capture for attribute and text results', { skip: !chromium }, async () => {
  const page = await browser.newPage();
  const offscreenSource = fs.readFileSync(path.join(__dirname, '..', 'offscreen.js'), 'utf8');
  const results = await page.evaluate((script) => {
    let handler;
    globalThis.chrome = { runtime: { onMessage: { addListener: (listener) => { handler = listener; } } } };
    (0, eval)(script);
    const invoke = (selector) => {
      let result;
      handler({ type: 'parse-monitor-html', html: '<a href="/post/1">title</a>', selector, selectorType: 'xpath' }, {}, (value) => { result = value; });
      return result;
    };
    return { attribute: invoke('//a/@href'), text: invoke('//a/text()') };
  }, offscreenSource);
  assert.equal(results.attribute.ok, true);
  assert.equal(results.attribute.text, '/post/1');
  assert.equal(results.text.ok, false);
  assert.match(results.text.error, /text\(\)/);
  await page.close();
});

test('XCSS execution does not affect a later CSS capture in the same frame', { skip: !chromium }, async () => {
  const page = await browser.newPage();
  await page.setContent('<div id="host">light<!--comment--></div>');
  const result = await page.evaluate(async (captureSource) => {
    const host = document.querySelector('#host');
    host.attachShadow({ mode: 'open' }).innerHTML = '<span>shadow</span>';
    const capture = (0, eval)(`(${captureSource})`);
    const css = [{ type: 'css', expr: '#host', op: 'include' }];
    const before = await capture(css, 0, 0, 0, 0, 0, { keepComments: true });
    const extended = await capture([{ type: 'xcss', expr: '#host', op: 'include' }], 0, 0, 0, 0, 0, { keepComments: true });
    const after = await capture(css, 0, 0, 0, 0, 0, { keepComments: true });
    return { before, extended, after };
  }, captureSource);
  assert.equal(result.before.html, result.after.html);
  assert.match(result.extended.html, /shadowrootmode/);
  assert.match(result.extended.html, /<!--comment-->/);
  await page.close();
});

test('empty retries compare only final HTML and ten thousand roots stay bounded', { skip: !chromium }, async () => {
  const empty = await captureFixture('<div id="empty"></div>', [{ type: 'css', expr: '#empty', op: 'include' }], { allowEmpty: true, retryCount: 2 });
  assert.equal(empty.output.data, empty.output.html);
  assert.equal(empty.output.captureAttempts.length, 3);
  const page = await browser.newPage();
  await page.setContent(`<section>${Array.from({ length: 10_000 }, (_, index) => `<article class="post" data-post-id="${index}">post ${index}</article>`).join('')}</section>`);
  const result = await page.evaluate(async (captureSource) => {
    const capture = (0, eval)(`(${captureSource})`);
    const started = performance.now();
    const output = await capture([{ type: 'css', expr: '.post', op: 'include' }], 0, 0, 0, 0, 0, {});
    return { ok: output.ok, items: output.items.length, milliseconds: performance.now() - started, error: output.error };
  }, captureSource);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.items, 10_000);
  assert.ok(result.milliseconds < 15_000, `10,000 roots took ${result.milliseconds}ms`);
  await page.close();
});

test('cross-origin duplicate iframe URLs are mapped to their actual parent DOM identities', { skip: !chromium }, async () => {
  const page = await browser.newPage();
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: route.request().url().includes('/embed')
    ? '<p>frame</p>' : '<iframe id="left" src="https://frame.example.test/embed?id=A"></iframe><iframe id="right" src="https://frame.example.test/embed?id=A"></iframe>' }));
  await page.goto('https://capture.example.test/board');
  const browserFrames = page.frames();
  const frames = browserFrames.map((frame, frameId) => ({ frameId, parentFrameId: frame.parentFrame() ? browserFrames.indexOf(frame.parentFrame()) : -1, url: frame.url() }));
  const chrome = { scripting: { executeScript: async ({ func, args }) => Promise.all(browserFrames.map(async (frame, frameId) => ({
    frameId, result: await frame.evaluate(async ({ script, args }) => (0, eval)(`(${script})`)(...args), { script: func.toString(), args })
  }))) } };
  const helperStart = source.indexOf('async function collectStableFrameDescriptors(');
  const helperEnd = source.indexOf('\nfunction cleanRegularExpression(', helperStart);
  const collect = new Function('chrome', 'crypto', `return (${source.slice(helperStart, helperEnd)});`)(chrome, webcrypto);
  const resolved = await collect(123, frames);
  assert.deepEqual(resolved.slice(1).map((frame) => frame.elementIdentity?.value).sort(), ['left', 'right']);
  await page.close();
});

test('picker shows positional selector stability hints and clears them for semantic selectors', { skip: !chromium }, async () => {
  const page = await browser.newPage();
  await page.setContent('<ul><li>first</li><li>second</li></ul><p data-hint=":nth-child(2)">quoted evidence</p>');
  const pickerSource = ['selector-engine.js', 'picker.js'].map((name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8')).join('\n');
  const result = await page.evaluate(async (script) => {
    globalThis.chrome = { runtime: { sendMessage: async () => ({ ok: true }) } };
    (0, eval)(script);
    const picker = globalThis.__openStillPickerInstance__;
    await picker.selectElement(document.querySelectorAll('li')[0]);
    const generatedSelector = picker.selectorInput.value;
    const generated = picker.shadow.querySelector('.selection-stability-hint')?.textContent;
    picker.selectorInput.value = 'li'; picker.validateSelector();
    const semantic = picker.shadow.querySelector('.selection-stability-hint');
    picker.selectorTypeInput.value = 'xpath'; picker.selectorInput.value = '//li[2]'; picker.validateSelector();
    const xpath = picker.shadow.querySelector('.selection-stability-hint')?.textContent;
    picker.selectorTypeInput.value = 'css'; picker.selectorInput.value = 'p[data-hint=":nth-child(2)"]'; picker.validateSelector();
    const quoted = picker.shadow.querySelector('.selection-stability-hint');
    picker.destroy();
    return { generated, generatedSelector, semantic: !!semantic, xpath, quoted: !!quoted };
  }, pickerSource);
  assert.match(result.generated, /요소 순서/, result.generatedSelector); assert.match(result.xpath, /다른 요소/);
  assert.equal(result.semantic, false); assert.equal(result.quoted, false);
  await page.close();
});
