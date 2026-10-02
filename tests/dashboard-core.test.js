'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../dashboard-core');
const row = (value, identity, href) => ({ type: 'element', tagName: 'li', ...(identity ? { identity: { key: identity } } : {}), attributes: href ? { href } : {}, children: [{ type: 'text', text: value }] });

for (const count of [5, 110, 1000, 10000]) {
  test(`whole-content anchors preserve head insertion in ${count} rows`, () => {
    const prefix = '공통 게시물 설명 '.repeat(100);
    const before = Array.from({ length: count }, (_, index) => row(`${prefix} 게시물 ${index + 1}`));
    const after = [row(`${prefix} 게시물 0`), ...before.slice(0, -1).map((node) => structuredClone(node))];
    const operations = core.align(before, after, () => 10);
    const pairs = operations.filter((item) => item.type === 'pair');
    assert.equal(pairs.length, count - 1);
    assert.equal(operations.filter((item) => item.type === 'added').length, 1);
    assert.equal(operations.filter((item) => item.type === 'removed').length, 1);
    assert.ok(pairs.every((item) => item.before.children[0].text === item.after.children[0].text));
    assert.ok(pairs.every((item) => !item.moved), 'head insertion must not mark retained posts as moves');
  });
}

test('identity pairs edited items and keeps duplicated titles with different links separate', () => {
  const before = [row('같은 제목', 'post-a', 'https://example.com/a'), row('같은 제목', 'post-b', 'https://example.com/b')];
  const after = [row('수정된 제목', 'post-b', 'https://example.com/b'), row('같은 제목', 'post-a', 'https://example.com/a'), row('같은 제목', 'post-c', 'https://example.com/c')];
  const result = core.align(before, after, () => 20);
  assert.equal(result.filter((item) => item.type === 'added').length, 1);
  assert.equal(result.filter((item) => item.type === 'removed').length, 0);
  assert.ok(result.some((item) => item.type === 'pair' && item.before.identity.key === 'post-b' && item.after.children[0].text === '수정된 제목'));
  assert.equal(result.filter((item) => item.moved).length, 1);
});

test('duplicate content uses occurrence counts and never matches differing known identities', () => {
  assert.equal(core.align([row('duplicate'), row('duplicate')], [row('duplicate')]).filter((item) => item.type === 'removed').length, 1);
  const result = core.align([row('same', 'a')], [row('same', 'b')], () => 20);
  assert.deepEqual(result.map((item) => item.type), ['removed', 'added']);
});

test('same site identity in different stable frames remains distinct', () => {
  const left = { ...row('same', 'post'), frame: { url: 'https://example.com/frame', path: [{ element: { attribute: 'id', value: 'left' } }] } };
  const right = { ...row('same', 'post'), frame: { url: 'https://example.com/frame', path: [{ element: { attribute: 'id', value: 'right' } }] } };
  assert.notEqual(core.identity(left), core.identity(right));
  const reload = structuredClone(left); reload.frame.frameId = 55;
  assert.equal(core.identity(left), core.identity(reload));
  left.frame.path[0].index = 1; reload.frame.path[0].index = 8;
  assert.equal(core.identity(left), core.identity(reload));
  left.frame.url += '?id=A&nonce=1'; reload.frame.url += '?id=A&nonce=2';
  left.locator = reload.locator = { frameVolatileParameters: ['nonce'] };
  assert.equal(core.identity(left), core.identity(reload));
  reload.frame.url = reload.frame.url.replace('id=A', 'id=B');
  assert.notEqual(core.identity(left), core.identity(reload));
});

test('large text-only list retains common rows beyond the LCS budget', () => {
  const before = Array.from({ length: 250 }, (_, index) => `공지사항 ${index + 1}`);
  const after = ['새 공지', ...before.slice(0, -1)];
  const result = core.diff(before, after);
  assert.equal(result.filter((item) => item.type === 'same').length, 249);
  assert.equal(result.filter((item) => item.type === 'added').length, 1);
  assert.equal(result.filter((item) => item.type === 'removed').length, 1);
  assert.deepEqual(result.filter((item) => item.type !== 'added').map((item) => item.value), before);
  assert.deepEqual(result.filter((item) => item.type !== 'removed').map((item) => item.value), after);
});

test('diff anchors preserve shared repetitions and full source order', () => {
  const before = Array.from({ length: 10000 }, (_, index) => `line ${index % 300}`);
  const after = ['new', ...before.slice(0, -1)];
  const result = core.diff(before, after);
  assert.equal(result.filter((item) => item.type === 'same').length, 9999);
  assert.deepEqual(result.filter((item) => item.type !== 'added').map((item) => item.value), before);
  assert.deepEqual(result.filter((item) => item.type !== 'removed').map((item) => item.value), after);
});

test('viewport is bounded at 30, 1000 and 10000 monitors', () => {
  for (const total of [30, 1000, 10000]) {
    for (const position of [0, 480, Math.max(0, total * 48 - 480)]) {
      const range = core.viewport(total, position, 480);
      assert.ok(range.end - range.start <= 26);
      assert.equal(range.top + (range.end - range.start) * 48 + range.bottom, total * 48);
    }
  }
});

test('invalid JSON locator rows keep their source and fail explicit edits', () => {
  const result = core.parseLocators('.valid\n{"type":"css","expr":\n{"type":"css","expr":".other","identityAttribute":"data-post-id"}');
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].line, 2);
  assert.equal(result.errors[0].source, '{"type":"css","expr":');
  assert.equal(result.locators[1].identityAttribute, 'data-post-id');
  assert.equal(core.parseLocators('{"type":"bogus","expr":"body"}').errors.length, 1);
  assert.equal(core.parseLocators('[]').errors.length, 1);
  assert.equal(core.parseLocators('{"expr":"body","fields":[{"type":"attribute"}]}').errors.length, 1);
  assert.equal(core.parseLocators('{"expr":"body","fields":["text","attr:href","property:value"]}').errors.length, 0);
  assert.deepEqual(core.parseLocators(''), { locators: [], errors: [] });
});

test('all-failed and truncated bulk results report the requested remainder', () => {
  assert.deepEqual(core.resultSummary({ completed: 0, failed: 2 }, 2), { completed: 0, skipped: 0, failed: 2, paused: 0, missing: 0, conflict: 0, unprocessed: 0 });
  assert.equal(core.resultSummary({ deletedCount: 1000 }, 10000).unprocessed, 9000);
  assert.equal(core.resultSummary({ deletedCount: 9, conflictIds: ['conflict'], unprocessedIds: ['conflict'] }, 10).unprocessed, 0);
  assert.equal(Object.values(core.resultSummary({ updated: 7, skipped: 1, missing: 1, failed: 1 }, 10)).reduce((total, value) => total + value, 0), 10);
});
