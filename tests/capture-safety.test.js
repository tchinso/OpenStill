'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { Worker: NodeWorker } = require('node:worker_threads');

const source = fs.readFileSync(path.join(__dirname, '..', 'service-worker.js'), 'utf8');
const boundary = source.indexOf('\nconst messageHandlers = {');
function api(chrome = {}) {
  const context = vm.createContext({ chrome, crypto: webcrypto, URL, TextEncoder, TextDecoder, Blob,
    structuredClone, setTimeout, clearTimeout, setInterval, clearInterval, console });
  vm.runInContext(`${source.slice(0, boundary)}\nglobalThis.captureTest={resolveLocatorFrame,framePathForFrame,cleanLocator,stableFrameLocation,filterCapturedText,captureRenderedSnapshot};`, context);
  return context.captureTest;
}

test('meaningful frame query parameters never identify a different document', () => {
  const methods = api();
  const frames = [{ frameId: 0, parentFrameId: -1, url: 'https://example.test/' },
    { frameId: 4, parentFrameId: 0, url: 'https://example.test/embed?id=B' }];
  assert.equal(methods.resolveLocatorFrame({ frameUrl: 'https://example.test/embed?id=A' }, frames), -1);
  assert.equal(methods.resolveLocatorFrame({ framePath: [{ url: 'https://example.test/embed?id=A', index: 0 }] }, frames), -1);
  assert.equal(methods.resolveLocatorFrame({ frameUrl: 'https://example.test/embed?id=B#route-A' }, frames), -1);
  assert.equal(methods.stableFrameLocation('https://example.test/embed?id=A&token=old', ['token']), 'https://example.test/embed?id=A');
  assert.equal(methods.resolveLocatorFrame({ frameUrl: 'https://example.test/embed?id=B&token=old', frameVolatileParameters: ['token'] }, frames), 4);
});

test('duplicate frame URLs require stable parent element identity across reorder', () => {
  const methods = api();
  const frames = [{ frameId: 0, parentFrameId: -1, url: 'https://example.test/' },
    { frameId: 8, parentFrameId: 0, url: 'https://example.test/embed', elementIdentity: { attribute: 'id', value: 'left' } },
    { frameId: 2, parentFrameId: 0, url: 'https://example.test/embed', elementIdentity: { attribute: 'id', value: 'right' } }];
  assert.equal(methods.resolveLocatorFrame({ framePath: [{ url: 'https://example.test/embed', index: 0, element: { attribute: 'id', value: 'left' } }] }, frames), 8);
  assert.equal(methods.resolveLocatorFrame({ framePath: [{ url: 'https://example.test/embed', index: 0 }] }, frames), -1);
  assert.equal(methods.framePathForFrame(8, frames.map(({ elementIdentity, ...frame }) => frame)), null);
  assert.equal(methods.resolveLocatorFrame({ frameId: 8 }, frames), -1);
  const locator = methods.cleanLocator({ expr: '.post', identityAttribute: 'data-post-id', framePath: [{ url: 'https://example.test/embed', index: 0, element: { attribute: 'id', value: 'left' } }] });
  assert.equal(locator.identityAttribute, 'data-post-id');
  assert.equal(locator.framePath[0].element.value, 'left');
});

test('frameUrl-only locators query frames and retain every frame during live capture', async () => {
  let frameQueries = 0;
  const requested = [];
  const chrome = {
    webNavigation: { getAllFrames: async () => { frameQueries += 1; return [
      { frameId: 0, parentFrameId: -1, url: 'https://example.test/' },
      { frameId: 3, parentFrameId: 0, url: 'https://example.test/embed?id=A' }
    ]; } },
    scripting: { executeScript: async (request) => {
      if (request.func.name !== 'captureReferenceRenderedDocumentCollection') return [];
      const frameId = request.target.frameIds?.[0] || 0;
      requested.push(frameId);
      return [{ result: { ok: true, matchCount: 1, text: frameId ? 'SUB' : 'TOP', html: `<div>${frameId ? 'SUB' : 'TOP'}</div>`,
        items: [{ text: frameId ? 'SUB' : 'TOP', identity: { key: frameId ? 'sub' : 'top' } }], selectorMatches: [] } }];
    } }, tabs: {}
  };
  const snapshot = await api(chrome).captureRenderedSnapshot({ id: 'test', url: 'https://example.test/', tracking: {}, locators: [
    { frameId: 0, type: 'css', expr: '.top', op: 'include' },
    { frameId: 0, frameUrl: 'https://example.test/embed?id=A', type: 'css', expr: '.sub', op: 'include' }
  ] }, 123, { live: true, frameId: 0 });
  assert.equal(frameQueries, 1);
  assert.deepEqual(requested.sort(), [0, 3]);
  assert.match(snapshot.text, /SUB/);
  assert.match(snapshot.text, /TOP/);
  assert.equal(snapshot.items.length, 2);
});

function offscreenHarness() {
  const workerSource = fs.readFileSync(path.join(__dirname, '..', 'regexp-worker.js'), 'utf8');
  let listener;
  let terminations = 0;
  class WorkerAdapter {
    constructor() {
      this.worker = new NodeWorker(`const {parentPort}=require('node:worker_threads');globalThis.self={postMessage:value=>parentPort.postMessage(value)};${workerSource}\nparentPort.on('message',data=>self.onmessage({data}));`, { eval: true });
      this.worker.on('message', (data) => this.onmessage?.({ data }));
      this.worker.on('error', (error) => this.onerror?.(error));
      this.worker.on('messageerror', (error) => this.onmessageerror?.(error));
    }
    postMessage(value) { this.worker.postMessage(value); }
    terminate() { terminations += 1; void this.worker.terminate(); }
  }
  const context = vm.createContext({ Worker: WorkerAdapter, setTimeout, clearTimeout, console,
    chrome: { runtime: { getURL: (value) => value, onMessage: { addListener: (value) => { listener = value; } } } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'offscreen.js'), 'utf8'), context);
  return { invoke: (message) => new Promise((resolve) => listener(message, {}, resolve)), terminated: () => terminations };
}

test('regular-expression workers are terminated after success and catastrophic timeout', async () => {
  const env = offscreenHarness();
  const normal = await env.invoke({ type: 'filter-captured-text', text: 'One TWO three', itemTexts: ['One TWO', 'three'], regexp: { expr: 't\\w+', flags: 'gi' }, timeoutMilliseconds: 1_500 });
  assert.equal(normal.text, 'TWO three');
  assert.deepEqual(Array.from(normal.itemTexts), ['TWO', 'three']);
  assert.equal(env.terminated(), 1);
  const started = Date.now();
  const blocked = await env.invoke({ type: 'filter-captured-text', text: `${'a'.repeat(35)}!`, regexp: { expr: '(a+)+$', flags: '' }, timeoutMilliseconds: 150 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.timedOut, true);
  assert.ok(Date.now() - started < 2_000, 'the owner event loop remained responsive');
  assert.equal(env.terminated(), 2);
});
