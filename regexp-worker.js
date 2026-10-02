'use strict';

// This worker is disposable. The offscreen owner terminates it on every
// outcome, including catastrophic backtracking which blocks this event loop.
self.onmessage = (event) => {
  const { text, regexp, itemTexts } = event.data || {};
  try {
    const filter = (value) => {
      const matches = String(value ?? '').match(new RegExp(regexp.expr, regexp.flags));
      return matches?.length ? matches.join(' ') : '';
    };
    self.postMessage({ ok: true, text: filter(text),
      ...(Array.isArray(itemTexts) ? { itemTexts: itemTexts.map(filter) } : {}) });
  } catch (error) {
    self.postMessage({ ok: false, error: `정규식 필터 오류: ${error?.message || String(error)}` });
  }
};
