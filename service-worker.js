'use strict';

const MONITORS_KEY = 'openStill.monitors.v2';
const SETTINGS_KEY = 'openStill.settings.v1';
const PENDING_PICKERS_KEY = 'openStill.pending-pickers.v1';
const ALARM_NAME = 'openStill.next-check';

const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 14 * 24;
// Two bounded collection snapshots per monitored URL (current + last changed-from
// value) stay within chrome.storage.local's default 10 MB quota without requesting
// unlimitedStorage.
const MAX_MONITORS = 100;
const MAX_SELECTORS_PER_MONITOR = 20;
const MAX_COLLECTION_ITEMS = 200;
const MAX_SNAPSHOT_CHARS = 10_000;
const PARSE_TIMEOUT_MS = 12_000;
const SOUND_DEBOUNCE_MS = 3_000;
const MAX_CHECKS_PER_SWEEP = 6;
const PENDING_PICKER_TTL_MS = 2 * 60 * 60 * 1000;
const RENDER_LOAD_TIMEOUT_MS = 30_000;
const RENDER_MINIMUM_WAIT_MS = 2_000;
const RENDER_QUIET_MS = 650;
const RENDER_SETTLE_TIMEOUT_MS = 5_000;
// Match the reference runner's empty-selection behavior: after the initial
// rendered capture it retries every five seconds through retryCount 5.
const RENDER_EMPTY_RETRY_COUNT = 4;
const RENDER_EMPTY_RETRY_DELAY_MS = 5_000;

const DEFAULT_SETTINGS = Object.freeze({ soundEnabled: true });
const VALID_STATUSES = new Set([
  'ok',
  'changed',
  'needs-review',
  'error',
  'permission-needed',
  'needs-baseline'
]);

const ELEMENT_NOT_FOUND_MESSAGE = '선택한 요소를 찾지 못했습니다. 로그인 상태나 페이지 구성, CSS 선택자를 확인해 주세요.';

let storageQueue = Promise.resolve();
let offscreenCreation;
let sweepRunning = false;
let lastSoundAt = 0;
const checksInProgress = new Set();
let alarmQueue = Promise.resolve();

function cleanText(value, maxLength = MAX_SNAPSHOT_CHARS) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

// Snapshot text has a different job from labels and error messages: line boundaries
// give the change view enough structure to show a newly inserted list item without
// highlighting every item that merely shifted down.
function cleanSnapshotText(value, maxLength = MAX_SNAPSHOT_CHARS) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t\f\v ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength);
}

function cleanSnapshotHtml(value, maxLength = MAX_SNAPSHOT_CHARS) {
  return String(value ?? '')
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, maxLength);
}

function cleanShortText(value, maxLength = 180) {
  return cleanText(value, maxLength);
}

function cleanLabels(value) {
  const values = Array.isArray(value) ? value : String(value ?? '').split(',');
  const labels = [];
  const seen = new Set();

  for (const item of values) {
    const label = cleanText(item, 48);
    const key = label.toLocaleLowerCase('ko-KR');
    if (label && !seen.has(key) && labels.length < 20) {
      labels.push(label);
      seen.add(key);
    }
  }

  return labels;
}

function asIso(value, fallback = null) {
  const timestamp = typeof value === 'number' ? value : Date.parse(value ?? '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function addHours(iso, hours) {
  const from = Date.parse(iso ?? '') || Date.now();
  return new Date(from + hours * 60 * 60 * 1000).toISOString();
}

function clampInterval(value) {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value)
      : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < MIN_INTERVAL_HOURS || parsed > MAX_INTERVAL_HOURS) {
    return null;
  }
  return parsed;
}

function createId() {
  return crypto.randomUUID();
}

function createRevision() {
  return crypto.randomUUID();
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return null;
    }
    if (url.username || url.password) {
      return null;
    }
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function originPattern(urlValue) {
  const url = new URL(urlValue);
  return `${url.protocol}//${url.host}/*`;
}

function cleanSelector(value) {
  const selector = String(value ?? '').trim();
  return selector && selector.length <= 2_000 ? selector : null;
}

function cleanSelectors(value) {
  const source = Array.isArray(value) ? value : [value];
  if (!source.length || source.length > MAX_SELECTORS_PER_MONITOR) {
    return null;
  }

  const selectors = [];
  const seen = new Set();
  for (const item of source) {
    const selector = cleanSelector(typeof item === 'string' ? item : item?.selector);
    if (!selector) {
      return null;
    }
    if (!seen.has(selector)) {
      selectors.push(selector);
      seen.add(selector);
    }
  }
  return selectors.length ? selectors : null;
}

function snapshotTextFromItems(items) {
  return items.map((item) => item.text).join('\n\n');
}

function snapshotHtmlFromItems(items) {
  return items.map((item) => item.html).filter(Boolean).join('\n');
}

function normalizeSnapshot(value) {
  if (!value || typeof value !== 'object' || typeof value.exists !== 'boolean') {
    return null;
  }

  const matchCount = typeof value.matchCount === 'number'
    ? value.matchCount
    : typeof value.matchCount === 'string' && /^\d+$/.test(value.matchCount.trim())
      ? Number(value.matchCount)
      : Number.NaN;
  const rawItems = Array.isArray(value.items) ? value.items : [];
  const itemCount = Math.min(rawItems.length, MAX_COLLECTION_ITEMS);
  const separatorLength = Math.max(0, itemCount - 1) * 2;
  const perItemLimit = itemCount
    ? Math.max(0, Math.floor(Math.max(0, MAX_SNAPSHOT_CHARS - separatorLength) / itemCount))
    : 0;
  const items = rawItems.slice(0, MAX_COLLECTION_ITEMS).map((item) => ({
    text: cleanSnapshotText(item?.text, perItemLimit)
  }));
  const html = cleanSnapshotHtml(
    typeof value.html === 'string' ? value.html : snapshotHtmlFromItems(rawItems),
    MAX_SNAPSHOT_CHARS
  );
  const safeMatchCount = Number.isInteger(matchCount) && matchCount >= 0
    ? matchCount
    : items.length;
  const exists = Boolean(value.exists) && safeMatchCount > 0;

  return {
    exists,
    matchCount: exists ? safeMatchCount : 0,
    text: exists ? snapshotTextFromItems(items) : '',
    html: exists ? html : '',
    items: exists ? items : [],
    capturedAt: asIso(value.capturedAt, null)
  };
}

function snapshotsEqual(left, right) {
  // The reference monitor compares its filtered text with whitespace ignored.
  // Match count and individual-root boundaries are presentation metadata, not
  // a change by themselves (a wrapper or a re-render must not manufacture an
  // alert when the monitored text is unchanged).
  const comparableText = (snapshot) => cleanSnapshotText(snapshot?.text).replace(/\s/g, '');
  return Boolean(left && right)
    && left.exists === right.exists
    && comparableText(left) === comparableText(right);
}

function normalizeMonitor(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const url = normalizeUrl(value.url);
  const selectors = cleanSelectors(value.selectors);
  const intervalHours = clampInterval(value.intervalHours);
  if (!url || !selectors || !intervalHours) {
    return null;
  }
  const createdAt = asIso(value.createdAt, nowIso());
  const lastCheckedAt = asIso(value.lastCheckedAt, null);
  const calculatedNextCheck = lastCheckedAt ? addHours(lastCheckedAt, intervalHours) : nowIso();
  const requestedNextCheck = asIso(value.nextCheckAt, null);
  const status = VALID_STATUSES.has(value.status) ? value.status : 'ok';
  const normalizedSnapshot = normalizeSnapshot(value.snapshot);
  // A no-match result is never a baseline. Keeping it here would make the
  // next successful render look like an element deletion/reappearance change.
  const snapshot = normalizedSnapshot?.exists ? normalizedSnapshot : null;
  const lastChange = value.lastChange && typeof value.lastChange === 'object'
    ? {
        previous: normalizeSnapshot(value.lastChange.previous),
        current: normalizeSnapshot(value.lastChange.current),
        detectedAt: asIso(value.lastChange.detectedAt, null)
      }
    : null;

  const id = typeof value.id === 'string' && value.id ? value.id.slice(0, 100) : createId();
  const revision = typeof value.revision === 'string' && value.revision.length <= 100
    ? value.revision
    : createRevision();

  return {
    id,
    revision,
    name: cleanText(value.name, 120) || cleanText(value.pageTitle, 120) || new URL(url).hostname,
    url,
    pageTitle: cleanText(value.pageTitle, 180),
    selectors,
    labels: cleanLabels(value.labels),
    intervalHours,
    enabled: value.enabled !== false,
    createdAt,
    updatedAt: asIso(value.updatedAt, createdAt),
    lastCheckedAt,
    lastChangedAt: asIso(value.lastChangedAt, null),
    nextCheckAt: requestedNextCheck ?? calculatedNextCheck,
    snapshot,
    lastChange,
    lastReviewAt: asIso(value.lastReviewAt, null),
    lastError: cleanText(value.lastError, 300) || null,
    status,
    unread: Boolean(value.unread)
  };
}

function normalizeSettings(value) {
  return {
    ...DEFAULT_SETTINGS,
    ...(value && typeof value === 'object' ? { soundEnabled: value.soundEnabled !== false } : {})
  };
}

async function getState() {
  const stored = await chrome.storage.local.get([MONITORS_KEY, SETTINGS_KEY]);
  const monitors = Array.isArray(stored[MONITORS_KEY])
    ? stored[MONITORS_KEY].map(normalizeMonitor).filter(Boolean)
    : [];

  return {
    monitors,
    settings: normalizeSettings(stored[SETTINGS_KEY])
  };
}

async function getMonitors() {
  return (await getState()).monitors;
}

function mutateMonitors(mutator) {
  const operation = storageQueue.catch(() => undefined).then(async () => {
    const state = await getState();
    const result = await mutator(state.monitors);
    await chrome.storage.local.set({ [MONITORS_KEY]: state.monitors });
    return result;
  });

  storageQueue = operation.catch(() => undefined);
  return operation;
}

async function updateSettings(settingsPatch) {
  const state = await getState();
  const settings = normalizeSettings({ ...state.settings, ...settingsPatch });
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}

async function hasSitePermission(url) {
  try {
    return await chrome.permissions.contains({ origins: [originPattern(url)] });
  } catch {
    return false;
  }
}

async function getPendingPickers() {
  const stored = await chrome.storage.session.get(PENDING_PICKERS_KEY);
  const pending = stored[PENDING_PICKERS_KEY];
  return pending && typeof pending === 'object' ? pending : {};
}

async function rememberPendingPicker(tabId, url) {
  if (!Number.isInteger(tabId)) return;
  const pending = await getPendingPickers();
  pending[String(tabId)] = { origin: originPattern(url), createdAt: nowIso() };
  await chrome.storage.session.set({ [PENDING_PICKERS_KEY]: pending });
}

async function forgetPendingPicker(tabId) {
  if (!Number.isInteger(tabId)) return;
  const pending = await getPendingPickers();
  if (Object.hasOwn(pending, String(tabId))) {
    delete pending[String(tabId)];
    await chrome.storage.session.set({ [PENDING_PICKERS_KEY]: pending });
  }
}

async function releaseUnusedOriginPermission(pattern) {
  await storageQueue.catch(() => undefined);
  const monitors = await getMonitors();
  const pending = await getPendingPickers();
  const stillUsed = monitors.some((monitor) => originPattern(monitor.url) === pattern)
    || Object.values(pending).some((entry) => entry?.origin === pattern);
  if (!stillUsed) {
    await chrome.permissions.remove({ origins: [pattern] }).catch(() => undefined);
  }
}

async function releaseUnusedSitePermission(url) {
  await releaseUnusedOriginPermission(originPattern(url));
}

async function releasePendingPicker(tabId) {
  if (!Number.isInteger(tabId)) return;
  const pending = await getPendingPickers();
  const entry = pending[String(tabId)];
  if (!entry?.origin) return;
  delete pending[String(tabId)];
  await chrome.storage.session.set({ [PENDING_PICKERS_KEY]: pending });
  await releaseUnusedOriginPermission(entry.origin);
}

async function clearExpiredPendingPickers() {
  const pending = await getPendingPickers();
  const cutoff = Date.now() - PENDING_PICKER_TTL_MS;
  const expiredOrigins = new Set();
  let changed = false;

  for (const [tabId, entry] of Object.entries(pending)) {
    if (!entry?.origin || (Date.parse(entry.createdAt ?? '') || 0) < cutoff) {
      if (entry?.origin) expiredOrigins.add(entry.origin);
      delete pending[tabId];
      changed = true;
    }
  }
  if (changed) {
    await chrome.storage.session.set({ [PENDING_PICKERS_KEY]: pending });
    await Promise.all([...expiredOrigins].map((origin) => releaseUnusedOriginPermission(origin)));
  }
}

async function cleanupUnusedSitePermissions() {
  const monitors = await getMonitors();
  const usedOrigins = new Set(monitors.map((monitor) => originPattern(monitor.url)));
  const pending = await getPendingPickers();
  Object.values(pending).forEach((entry) => {
    if (entry?.origin) usedOrigins.add(entry.origin);
  });
  const { origins = [] } = await chrome.permissions.getAll();
  const exactSiteOrigins = origins.filter((origin) => /^https?:\/\/[^*/]+\/\*$/.test(origin));
  await Promise.all(exactSiteOrigins
    .filter((origin) => !usedOrigins.has(origin))
    .map((origin) => chrome.permissions.remove({ origins: [origin] }).catch(() => undefined)));
}

function responseError(error) {
  return error instanceof Error ? error.message : String(error ?? '알 수 없는 오류');
}

function timeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })
  ]).finally(() => clearTimeout(timer));
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.some((context) => context.documentUrl === offscreenUrl)) {
    return;
  }

  if (!offscreenCreation) {
    offscreenCreation = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_PARSER', 'AUDIO_PLAYBACK'],
      justification: 'OpenStill validates user-entered CSS selector syntax and plays a local change alert tone.'
    }).catch(async (error) => {
      const contextsAfterFailure = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (!contextsAfterFailure.some((context) => context.documentUrl === offscreenUrl)) {
        throw error;
      }
    }).finally(() => {
      offscreenCreation = undefined;
    });
  }

  await offscreenCreation;
}

async function parseMonitoredHtml(html, selector) {
  await ensureOffscreenDocument();
  const result = await timeout(
    chrome.runtime.sendMessage({ type: 'parse-monitor-html', html, selector }),
    PARSE_TIMEOUT_MS,
    '페이지 HTML을 분석하는 데 시간이 너무 오래 걸렸습니다.'
  );

  if (!result?.ok) {
    throw new Error(result?.error || '선택자 분석 결과를 받지 못했습니다.');
  }

  return {
    exists: Boolean(result.exists),
    matchCount: Number.isInteger(result.matchCount) ? result.matchCount : 0,
    text: cleanText(result.text),
    capturedAt: nowIso()
  };
}

async function validateSelectorSyntax(selector) {
  await parseMonitoredHtml('', selector);
}

function waitForRenderedTab(tabId) {
  let cancel = () => undefined;
  const promise = new Promise((resolve, reject) => {
    let sawLoading = false;
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('렌더링된 페이지를 여는 데 30초가 넘게 걸렸습니다.'));
    }, RENDER_LOAD_TIMEOUT_MS);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'loading') {
        sawLoading = true;
      } else if (changeInfo.status === 'complete' && sawLoading) {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(listener);
    };
    cancel = cleanup;
    chrome.tabs.onUpdated.addListener(listener);
  });
  return { promise, cancel };
}

// Reference-compatible CSS monitor capture. All scheduled captures use this
// clone/filter/text pipeline rather than the old root-innerText collector.
async function captureReferenceRenderedDocumentCollection(
  selectors,
  minimumWaitMilliseconds,
  quietMilliseconds,
  settleTimeoutMilliseconds,
  emptyRetryCount = 4,
  emptyRetryDelayMilliseconds = 5_000
) {
  const selectorList = Array.isArray(selectors)
    ? selectors.filter((selector) => typeof selector === 'string' && selector.trim())
    : [];
  const root = document.documentElement;
  if (root) {
    await new Promise((resolve) => {
      const startedAt = performance.now();
      let lastMutationAt = startedAt;
      const observer = new MutationObserver(() => {
        lastMutationAt = performance.now();
      });
      observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
      const tick = () => {
        const now = performance.now();
        const elapsed = now - startedAt;
        if ((elapsed >= minimumWaitMilliseconds && now - lastMutationAt >= quietMilliseconds) || elapsed >= settleTimeoutMilliseconds) {
          observer.disconnect();
          resolve();
          return;
        }
        setTimeout(tick, Math.min(100, quietMilliseconds));
      };
      setTimeout(tick, Math.min(100, quietMilliseconds));
    });
  }

  const blockElements = new Set([
    'ARTICLE', 'BLOCKQUOTE', 'CAPTION', 'CODE', 'DD', 'DIV', 'FIELDSET', 'FOOTER', 'FORM',
    'HEADER', 'LI', 'OL', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TFOOT', 'THEAD', 'TR',
    'UL', 'IMG', 'BR'
  ]);
  const spacedElements = new Set(['A', 'ABBR', 'ACRONYM', 'ADDRESS', 'BUTTON', 'TD']);
  const excludedElements = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'FRAME', 'IFRAME']);
  const markerInclude = 'data-openstill-reference-include';
  const markerAncestor = 'data-openstill-reference-ancestor';

  const compareDocumentOrder = (left, right) => {
    if (left === right) return 0;
    const position = left.compareDocumentPosition(right);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  };

  const rootsFor = (elements) => [...elements].filter((element) => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (elements.has(parent)) return false;
    }
    return true;
  }).sort(compareDocumentOrder);

  // This mirrors the reference extractor rather than using innerText:
  // preserve block boundaries, retain CSS-hidden text, and ignore only the
  // same non-content elements filtered by the monitor.
  const textForElement = (element) => {
    const buffer = [];
    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        buffer.push(node.nodeValue || '');
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || excludedElements.has(node.tagName)) return;
      let isBlock = blockElements.has(node.tagName);
      try {
        isBlock = isBlock || getComputedStyle(node).display === 'block';
      } catch {
        // The semantic block list covers detached or transient elements.
      }
      if (isBlock) buffer.push('\n');
      else if (spacedElements.has(node.tagName)) buffer.push(' ');
      for (const child of node.childNodes) visit(child);
    };
    visit(element);
    return buffer.join('')
      .trim()
      .replace(/\s*\n+(\s*\n+)*/g, '\n')
      .replace(/[ \t]+/g, ' ');
  };

  const pathFromDocumentRoot = (element) => {
    const path = [];
    let current = element;
    while (current && current !== document.documentElement) {
      const parent = current.parentNode;
      if (!parent) return null;
      path.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
      current = parent;
    }
    return current === document.documentElement ? path : null;
  };

  const nodeAtPath = (cloneRoot, path) => {
    let current = cloneRoot;
    for (const index of path ?? []) {
      current = current?.childNodes[index];
      if (!current) return null;
    }
    return current;
  };

  const cleanClone = (cloneRoot) => {
    const walker = cloneRoot.ownerDocument.createTreeWalker(cloneRoot, NodeFilter.SHOW_COMMENT);
    const comments = [];
    while (walker.nextNode()) comments.push(walker.currentNode);
    comments.forEach((comment) => comment.remove());
    cloneRoot.querySelectorAll('script, style, noscript, frame, iframe, link[as="script"], link[rel="stylesheet"]').forEach((node) => node.remove());
    cloneRoot.querySelectorAll('*').forEach((node) => {
      for (const attribute of [...node.attributes]) {
        if (/^on/i.test(attribute.name) || attribute.name === 'style' || attribute.name === 'integrity') {
          node.removeAttribute(attribute.name);
        }
      }
    });
    const absoluteUrl = (value) => {
      try {
        return new URL(value, document.baseURI).href;
      } catch {
        return value;
      }
    };
    cloneRoot.querySelectorAll('a[href]').forEach((node) => node.setAttribute('href', absoluteUrl(node.getAttribute('href'))));
    cloneRoot.querySelectorAll('audio[src], img[src], video[src]').forEach((node) => node.setAttribute('src', absoluteUrl(node.getAttribute('src'))));
  };

  // Build the same filtered HTML shape as the reference: retain selected
  // subtrees and the minimum ancestor path, discard all unrelated page churn.
  const filteredHtmlForRoots = (roots) => {
    if (!roots.length || !document.documentElement) return '';
    const clonedDocument = document.implementation.createHTMLDocument('');
    const cloneRoot = document.documentElement.cloneNode(true);
    clonedDocument.replaceChild(cloneRoot, clonedDocument.documentElement);
    for (const rootElement of roots) {
      const clone = nodeAtPath(cloneRoot, pathFromDocumentRoot(rootElement));
      if (!clone || clone.nodeType !== Node.ELEMENT_NODE) continue;
      clone.setAttribute(markerInclude, '1');
      for (let parent = clone.parentElement; parent; parent = parent.parentElement) {
        parent.setAttribute(markerAncestor, '1');
      }
    }
    const prune = (node, insideIncluded = false) => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (!insideIncluded) node.remove();
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) {
        node.remove();
        return;
      }
      if (excludedElements.has(node.tagName)) {
        node.remove();
        return;
      }
      const included = insideIncluded || node.hasAttribute(markerInclude);
      if (!included && !node.hasAttribute(markerAncestor)) {
        node.remove();
        return;
      }
      for (const child of [...node.childNodes]) prune(child, included);
    };
    prune(cloneRoot);
    cleanClone(cloneRoot);
    cloneRoot.removeAttribute(markerInclude);
    cloneRoot.removeAttribute(markerAncestor);
    cloneRoot.querySelectorAll(`[${markerInclude}], [${markerAncestor}]`).forEach((node) => {
      node.removeAttribute(markerInclude);
      node.removeAttribute(markerAncestor);
    });
    return cloneRoot.outerHTML;
  };

  const capture = () => {
    const selected = new Set();
    const selectorMatches = [];
    for (const selector of selectorList) {
      const matches = [...document.querySelectorAll(selector)];
      selectorMatches.push({ selector, matchCount: matches.length });
      matches.forEach((element) => selected.add(element));
    }
    const roots = rootsFor(selected);
    const items = roots.map((element) => ({ text: textForElement(element) }));
    const filteredHtml = filteredHtmlForRoots(roots);
    const text = items.map((item) => item.text).filter(Boolean).join('\n\n');
    return { roots, items, text, html: filteredHtml, selectorMatches };
  };

  try {
    if (!selectorList.length) {
      return { ok: true, exists: false, matchCount: 0, items: [], selectorMatches: [] };
    }
    let result = capture();
    // Reference runner begins at retryCount 0 and retries while it is <= 4,
    // giving six total attempts and five 5-second waits for an empty selection.
    for (let retryCount = 0; !result.text && retryCount <= emptyRetryCount; retryCount += 1) {
      await new Promise((resolve) => setTimeout(resolve, emptyRetryDelayMilliseconds));
      result = capture();
    }
    return {
      ok: true,
      exists: Boolean(result.text),
      matchCount: result.roots.length,
      items: result.items,
      html: result.html,
      selectorMatches: result.selectorMatches
    };
  } catch (error) {
    return { ok: false, error: 'CSS selector could not be evaluated: ' + error.message };
  }
}

async function inspectLegacyRenderedDocumentCollection(selectors, minimumWaitMilliseconds, quietMilliseconds, settleTimeoutMilliseconds) {
  const selectorList = Array.isArray(selectors) ? selectors : [];
  const root = document.documentElement;
  if (root) {
    await new Promise((resolve) => {
      const startedAt = performance.now();
      let lastMutationAt = startedAt;
      const observer = new MutationObserver(() => {
        lastMutationAt = performance.now();
      });
      observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
      const tick = () => {
        const now = performance.now();
        const elapsed = now - startedAt;
        if ((elapsed >= minimumWaitMilliseconds && now - lastMutationAt >= quietMilliseconds) || elapsed >= settleTimeoutMilliseconds) {
          observer.disconnect();
          resolve();
          return;
        }
        setTimeout(tick, Math.min(100, quietMilliseconds));
      };
      setTimeout(tick, Math.min(100, quietMilliseconds));
    });
  }

  try {
    const selected = new Set();
    for (const selector of selectorList) {
      document.querySelectorAll(selector).forEach((element) => selected.add(element));
    }

    const roots = [...selected].filter((element) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (selected.has(parent)) return false;
      }
      return true;
    }).sort((left, right) => {
      if (left === right) return 0;
      const position = left.compareDocumentPosition(right);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    return {
      ok: true,
      exists: roots.length > 0,
      matchCount: roots.length,
      items: roots.map((element) => ({
        text: String(element.innerText || element.textContent || '').slice(0, 10_000)
      }))
    };
  } catch (error) {
    return { ok: false, error: 'CSS 선택자를 해석할 수 없습니다: ' + error.message };
  }
}

async function captureRenderedSnapshot(monitor) {
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  if (!Number.isInteger(tab?.id)) {
    throw new Error('Could not create a background tab for checking.');
  }

  let ready;
  try {
    ready = waitForRenderedTab(tab.id);
    await chrome.tabs.update(tab.id, { url: monitor.url, active: false });
    await ready.promise;
    const execution = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: captureReferenceRenderedDocumentCollection,
      args: [
        monitor.selectors,
        RENDER_MINIMUM_WAIT_MS,
        RENDER_QUIET_MS,
        RENDER_SETTLE_TIMEOUT_MS,
        RENDER_EMPTY_RETRY_COUNT,
        RENDER_EMPTY_RETRY_DELAY_MS
      ]
    });
    const result = execution[0]?.result;
    if (!result?.ok) {
      throw new Error(result?.error || '렌더링된 페이지를 확인하지 못했습니다.');
    }

    const snapshot = normalizeSnapshot({
      exists: Boolean(result.exists),
      matchCount: Number.isInteger(result.matchCount) ? result.matchCount : 0,
      items: result.items,
      text: Array.isArray(result.items) ? result.items.map((item) => item.text).join('\n\n') : '',
      html: result.html,
      capturedAt: nowIso()
    });
    if (!snapshot) {
      throw new Error('선택자 목록 결과를 정리하지 못했습니다.');
    }
    return snapshot;
  } finally {
    ready?.cancel();
    await chrome.tabs.remove(tab.id).catch(() => undefined);
  }
}

async function refreshBadge(monitors = null) {
  const list = monitors ?? await getMonitors();
  const unreadCount = list.filter((monitor) => monitor.unread).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#EF6A5B' });
  await chrome.action.setBadgeText({ text: unreadCount ? String(unreadCount) : '' });
}

async function playAlertSound() {
  const { settings } = await getState();
  if (!settings.soundEnabled || Date.now() - lastSoundAt < SOUND_DEBOUNCE_MS) {
    return;
  }

  lastSoundAt = Date.now();
  await ensureOffscreenDocument();
  await chrome.runtime.sendMessage({ type: 'play-alert-sound' }).catch(() => undefined);
}

async function announceChange(monitor) {
  const notificationId = `openstill-change:${monitor.id}`;
  try {
    await chrome.notifications.create(notificationId, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'OpenStill · 변경 감지',
      message: `${monitor.name}에서 변경을 확인했습니다.`,
      priority: 1
    });
  } catch (error) {
    console.warn('OpenStill could not show a change notification.', error);
  }
  await playAlertSound().catch((error) => console.warn('OpenStill could not play a change sound.', error));
}

function dueTimestamp(monitor) {
  const timestamp = Date.parse(monitor.nextCheckAt ?? '');
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

async function scheduleNextAlarm() {
  const operation = alarmQueue.catch(() => undefined).then(async () => {
    const monitors = await getMonitors();
    const enabled = monitors.filter((monitor) => monitor.enabled);
    await chrome.alarms.clear(ALARM_NAME);

    if (!enabled.length) {
      return;
    }

    const nextDue = Math.min(...enabled.map(dueTimestamp));
    await chrome.alarms.create(ALARM_NAME, { when: Math.max(Date.now() + 1_000, nextDue) });
  });
  alarmQueue = operation.catch(() => undefined);
  return operation;
}

async function setCheckFailure(id, expectedRevision, status, errorMessage) {
  const checkedAt = nowIso();
  await mutateMonitors((monitors) => {
    const monitor = monitors.find((item) => item.id === id);
    if (!monitor || !monitor.enabled || monitor.revision !== expectedRevision) {
      return null;
    }
    monitor.lastCheckedAt = checkedAt;
    monitor.nextCheckAt = addHours(checkedAt, monitor.intervalHours);
    monitor.status = status;
    monitor.lastReviewAt = null;
    monitor.lastError = cleanText(errorMessage, 300);
    monitor.updatedAt = checkedAt;
    return monitor;
  });
}

function statusForStoredSnapshot(snapshot) {
  if (!snapshot) return 'needs-baseline';
  return snapshot.exists ? 'ok' : 'needs-review';
}

function applySnapshotOutcome(monitor, nextSnapshot, checkedAt) {
  // A missing match is deliberately not a comparison result. A session can have
  // expired, the page can be behind a login wall, or a temporary error page can
  // be rendered. Keep the last successful snapshot so a later reappearance is
  // compared against real content instead of producing a false change.
  if (!nextSnapshot.exists) {
    monitor.status = 'needs-review';
    monitor.lastReviewAt = checkedAt;
    monitor.lastError = ELEMENT_NOT_FOUND_MESSAGE;
    return { changed: false, needsReview: true };
  }

  const previous = monitor.snapshot;
  const changed = Boolean(previous) && !snapshotsEqual(previous, nextSnapshot);
  // The reference runner only persists a baseline on the first successful
  // capture or a real filtered-text change. An equal re-render must not churn
  // the saved HTML/text history merely because its capture timestamp changed.
  if (!previous || changed) {
    monitor.snapshot = nextSnapshot;
  }
  monitor.lastError = null;
  monitor.lastReviewAt = null;

  if (changed) {
    monitor.lastChangedAt = checkedAt;
    monitor.lastChange = {
      previous,
      current: nextSnapshot,
      detectedAt: checkedAt
    };
    monitor.unread = true;
    monitor.status = 'changed';
  } else {
    // An unread change remains actionable after a later successful re-check.
    monitor.status = monitor.unread ? 'changed' : 'ok';
  }

  return { changed, needsReview: false };
}

async function checkMonitor(id, { reschedule = true } = {}) {
  if (checksInProgress.has(id)) {
    return { ok: false, reason: 'checking', error: '이미 확인 중입니다.' };
  }

  checksInProgress.add(id);
  try {
    const monitor = (await getMonitors()).find((item) => item.id === id);
    if (!monitor) {
      return { ok: false, error: '모니터를 찾을 수 없습니다.' };
    }
    if (!monitor.enabled) {
      return { ok: false, reason: 'disabled', error: '일시정지된 모니터입니다.' };
    }
    if (!await hasSitePermission(monitor.url)) {
      await setCheckFailure(id, monitor.revision, 'permission-needed', '이 사이트의 접근 권한이 필요합니다.');
      return { ok: false, reason: 'permission', error: '이 사이트의 접근 권한이 필요합니다.' };
    }

    let nextSnapshot;
    try {
      nextSnapshot = await captureRenderedSnapshot(monitor);
    } catch (error) {
      const message = responseError(error);
      await setCheckFailure(id, monitor.revision, 'error', message);
      return { ok: false, error: message };
    }

    const checkedAt = nowIso();
    const result = await mutateMonitors((monitors) => {
      const current = monitors.find((item) => item.id === id);
      if (!current || !current.enabled || current.revision !== monitor.revision) {
        return { ok: false, reason: 'outdated', error: '확인 중 모니터 설정이 변경되었습니다.' };
      }

      current.lastCheckedAt = checkedAt;
      current.nextCheckAt = addHours(checkedAt, current.intervalHours);
      current.updatedAt = checkedAt;
      const applied = applySnapshotOutcome(current, nextSnapshot, checkedAt);

      return { ok: true, ...applied, monitor: { ...current } };
    });

    if (result?.changed) {
      await announceChange(result.monitor);
    }
    await refreshBadge();
    return result;
  } catch (error) {
    return { ok: false, error: responseError(error) };
  } finally {
    checksInProgress.delete(id);
    if (reschedule) {
      await scheduleNextAlarm().catch((error) => console.warn('OpenStill could not reschedule checks.', error));
    }
  }
}

async function checkPage(urlValue) {
  const url = normalizeUrl(urlValue);
  if (!url) {
    return { ok: false, error: '확인할 페이지 주소가 올바르지 않습니다.' };
  }

  const monitor = (await getMonitors()).find((item) => item.enabled && item.url === url);
  if (!monitor) {
    return { ok: false, reason: 'disabled', error: '이 페이지에서 활성화된 추적을 찾을 수 없습니다.' };
  }

  try {
    const result = await checkMonitor(monitor.id, { reschedule: false });
    return result?.ok
      ? { ok: true, changed: Boolean(result.changed), needsReview: Boolean(result.needsReview), checked: 1 }
      : result;
  } finally {
    await scheduleNextAlarm().catch((error) => console.warn('OpenStill could not reschedule checks.', error));
  }
}

async function runDueChecks() {
  if (sweepRunning) {
    return;
  }

  sweepRunning = true;
  try {
    const now = Date.now();
    const due = (await getMonitors())
      .filter((monitor) => monitor.enabled && dueTimestamp(monitor) <= now)
      .sort((left, right) => dueTimestamp(left) - dueTimestamp(right));

    const scheduledUrls = new Set();
    const scheduled = [];
    for (const monitor of due) {
      if (scheduledUrls.has(monitor.url)) continue;
      scheduledUrls.add(monitor.url);
      scheduled.push(monitor);
      if (scheduled.length >= MAX_CHECKS_PER_SWEEP) break;
    }

    await Promise.allSettled(scheduled.map((monitor) => checkMonitor(monitor.id, { reschedule: false })));
  } finally {
    sweepRunning = false;
    await scheduleNextAlarm();
  }
}

function selectorsEqual(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((selector, index) => selector === right[index]);
}

function pickerItemsFromMessage(message) {
  const rawItems = Array.isArray(message.items)
    ? message.items
    : Array.isArray(message.selectors)
      ? message.selectors.map((selector) => ({ selector }))
      : [{ selector: message.selector }];

  if (!rawItems.length || rawItems.length > MAX_SELECTORS_PER_MONITOR) {
    return null;
  }

  const items = [];
  const seenSelectors = new Set();
  for (const rawItem of rawItems) {
    const selector = cleanSelector(typeof rawItem === 'string' ? rawItem : rawItem?.selector);
    if (!selector) return null;
    if (seenSelectors.has(selector)) continue;
    seenSelectors.add(selector);

    items.push({ selector });
  }
  return items.length ? items : null;
}

async function validateSelectorList(selectors) {
  for (const selector of selectors) {
    await validateSelectorSyntax(selector);
  }
}

async function createMonitors(message, sender) {
  const url = normalizeUrl(message.url);
  const intervalHours = clampInterval(message.intervalHours);
  const pickerItems = pickerItemsFromMessage(message);
  if (!url || !intervalHours || !pickerItems) {
    return { ok: false, error: 'URL, 확인 간격, 그리고 하나 이상의 CSS 선택자를 확인해 주세요.' };
  }

  try {
    await validateSelectorList(pickerItems.map((item) => item.selector));
  } catch (error) {
    return { ok: false, error: responseError(error) };
  }
  if (!await hasSitePermission(url)) {
    return { ok: false, error: '저장하기 전에 이 사이트의 접근 권한을 허용해 주세요.' };
  }

  const timestamp = nowIso();
  const pageTitle = cleanText(message.pageTitle, 180);
  const baseName = cleanText(message.name, 120) || pageTitle || new URL(url).hostname;
  const labels = cleanLabels(message.labels);
  const result = await mutateMonitors((monitors) => {
    const existing = monitors.find((monitor) => monitor.url === url);
    if (existing) {
      const knownSelectors = new Set(existing.selectors);
      const additions = pickerItems.filter((item) => !knownSelectors.has(item.selector));
      if (additions.length) {
        if (existing.selectors.length + additions.length > MAX_SELECTORS_PER_MONITOR) {
          return { ok: false, error: `한 주소에는 CSS 선택자를 최대 ${MAX_SELECTORS_PER_MONITOR}개까지 저장할 수 있습니다.` };
        }
        existing.selectors = [...existing.selectors, ...additions.map((item) => item.selector)];
        existing.revision = createRevision();
        existing.updatedAt = timestamp;
        // A picker session only knows the elements selected in that session,
        // not the DOM order of the already-saved selectors.  Do not append its
        // text to an old collection snapshot: that would manufacture a change
        // on the next rendered check.  The due-now check below establishes one
        // complete, DOM-ordered baseline for the expanded collection.
        existing.snapshot = null;
        existing.lastChange = null;
        existing.lastCheckedAt = null;
        existing.lastChangedAt = null;
        existing.lastReviewAt = null;
        existing.lastError = null;
        existing.unread = false;
        existing.status = 'needs-baseline';
        existing.nextCheckAt = timestamp;
      }
      return { ok: true, monitor: { ...existing } };
    }

    if (monitors.length >= MAX_MONITORS) {
      throw new Error('추적은 최대 개수에 도달했습니다.');
    }

    const monitor = {
      id: createId(),
      revision: createRevision(),
      name: baseName,
      url,
      pageTitle,
      selectors: pickerItems.map((item) => item.selector),
      labels,
      intervalHours,
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastCheckedAt: null,
      lastChangedAt: null,
      // Establish the first baseline from the same rendered collection used
      // for later checks, rather than from click order in the picker.
      nextCheckAt: timestamp,
      snapshot: null,
      lastChange: null,
      lastReviewAt: null,
      lastError: null,
      status: 'needs-baseline',
      unread: false
    };
    monitors.push(monitor);
    return { ok: true, monitor: { ...monitor } };
  });

  if (!result?.ok) return result;
  await forgetPendingPicker(sender?.tab?.id);
  await scheduleNextAlarm();
  return { ok: true, monitor: result.monitor, monitors: [result.monitor], count: 1 };
}

async function createMonitor(message, sender) {
  return createMonitors({
    ...message,
    items: [{
      selector: message.selector
    }]
  }, sender);
}

async function saveMonitor(message) {
  const url = normalizeUrl(message.url);
  const selectors = cleanSelectors(Object.hasOwn(message, 'selectors') ? message.selectors : message.selector);
  const intervalHours = clampInterval(message.intervalHours);
  if (!message.id || !url || !selectors || !intervalHours) {
    return { ok: false, error: 'URL, CSS 선택자, 확인 간격을 확인해 주세요.' };
  }

  try {
    await validateSelectorList(selectors);
  } catch (error) {
    return { ok: false, error: responseError(error) };
  }

  const existing = (await getMonitors()).find((item) => item.id === message.id);
  if (!existing) {
    return { ok: false, error: '추적을 찾을 수 없습니다.' };
  }
  const previousUrl = existing.url;
  const permissionGranted = await hasSitePermission(url);
  const result = await mutateMonitors((monitors) => {
    const monitor = monitors.find((item) => item.id === message.id);
    if (!monitor) {
      return { ok: false, error: '추적을 찾을 수 없습니다.' };
    }
    if (monitors.some((item) => item.id !== monitor.id && item.url === url)) {
      return { ok: false, error: '이 주소는 이미 다른 추적으로 관리되고 있습니다.' };
    }

    const selectionChanged = monitor.url !== url || !selectorsEqual(monitor.selectors, selectors);
    monitor.name = cleanText(message.name, 120) || monitor.name;
    monitor.revision = createRevision();
    monitor.url = url;
    monitor.selectors = [...selectors];
    monitor.labels = cleanLabels(message.labels);
    monitor.intervalHours = intervalHours;
    const requestedEnabled = message.enabled !== false;
    monitor.enabled = requestedEnabled && permissionGranted;
    monitor.updatedAt = nowIso();
    monitor.nextCheckAt = selectionChanged ? nowIso() : addHours(monitor.lastCheckedAt ?? nowIso(), intervalHours);

    if (selectionChanged) {
      monitor.snapshot = null;
      monitor.lastChange = null;
      monitor.lastChangedAt = null;
      monitor.lastReviewAt = null;
      monitor.lastCheckedAt = null;
      monitor.unread = false;
      monitor.status = monitor.enabled ? 'needs-baseline' : requestedEnabled ? 'permission-needed' : 'needs-baseline';
      monitor.lastError = null;
    } else if (requestedEnabled && !permissionGranted) {
      monitor.status = 'permission-needed';
      monitor.lastError = '이 사이트의 접근 권한이 필요합니다.';
    } else if (!requestedEnabled && monitor.status === 'permission-needed') {
      monitor.status = statusForStoredSnapshot(monitor.snapshot);
      monitor.lastError = null;
    }

    return { ok: true, monitor: { ...monitor }, permissionGranted };
  });

  await refreshBadge();
  await scheduleNextAlarm();
  if (previousUrl !== url) {
    await releaseUnusedSitePermission(previousUrl);
  }
  return result;
}

async function setMonitorEnabled(message) {
  const enabled = Boolean(message.enabled);
  const monitor = (await getMonitors()).find((item) => item.id === message.id);
  if (!monitor) {
    return { ok: false, error: '모니터를 찾을 수 없습니다.' };
  }

  const permissionGranted = !enabled || await hasSitePermission(monitor.url);
  if (enabled && !permissionGranted) {
    return { ok: false, reason: 'permission', error: '이 사이트의 접근 권한이 필요합니다.' };
  }

  await mutateMonitors((monitors) => {
    const current = monitors.find((item) => item.id === message.id);
    if (!current) {
      return;
    }
    current.enabled = enabled;
    current.revision = createRevision();
    current.updatedAt = nowIso();
    current.nextCheckAt = enabled ? nowIso() : current.nextCheckAt;
    if (enabled && current.status === 'permission-needed') {
      current.status = statusForStoredSnapshot(current.snapshot);
      current.lastError = null;
    } else if (!enabled && current.status === 'permission-needed') {
      current.status = statusForStoredSnapshot(current.snapshot);
      current.lastError = null;
    }
  });
  await scheduleNextAlarm();
  return { ok: true };
}

async function deleteMonitor(id) {
  let deleted;
  await mutateMonitors((monitors) => {
    const index = monitors.findIndex((item) => item.id === id);
    if (index >= 0) {
      deleted = monitors.splice(index, 1)[0];
    }
  });

  if (!deleted) {
    return { ok: false, error: '모니터를 찾을 수 없습니다.' };
  }
  await releaseUnusedSitePermission(deleted.url);
  await refreshBadge();
  await scheduleNextAlarm();
  return { ok: true };
}

function resetMonitorForPageUrl(monitor, url, timestamp, { copy = false } = {}) {
  return {
    ...monitor,
    id: copy ? createId() : monitor.id,
    revision: createRevision(),
    url,
    selectors: [...monitor.selectors],
    ...(copy ? { createdAt: timestamp } : {}),
    updatedAt: timestamp,
    lastCheckedAt: null,
    lastChangedAt: null,
    nextCheckAt: timestamp,
    snapshot: null,
    lastChange: null,
    lastReviewAt: null,
    lastError: null,
    status: 'needs-baseline',
    unread: false
  };
}

async function reusePageUrl(message, { copy = false } = {}) {
  const sourceUrl = normalizeUrl(message.sourceUrl);
  const targetUrl = normalizeUrl(message.targetUrl);
  if (!sourceUrl || !targetUrl) {
    return { ok: false, error: '기존 주소와 새 주소를 모두 확인해 주세요.' };
  }
  if (sourceUrl === targetUrl) {
    return { ok: false, error: '새 주소가 기존 주소와 같습니다.' };
  }

  const monitors = await getMonitors();
  const sourceMonitor = monitors.find((monitor) => monitor.url === sourceUrl);
  if (!sourceMonitor) {
    return { ok: false, error: '주소를 재사용할 추적 페이지를 찾을 수 없습니다.' };
  }
  if (monitors.some((monitor) => monitor.url === targetUrl)) {
    return { ok: false, error: '새 주소는 이미 추적 중입니다.' };
  }
  if (copy && monitors.length >= MAX_MONITORS) {
    return { ok: false, error: '추적은 최대 개수에 도달했습니다.' };
  }
  if (sourceMonitor.enabled && !await hasSitePermission(targetUrl)) {
    return { ok: false, reason: 'permission', error: '새 사이트의 접근 권한이 필요합니다.' };
  }

  const timestamp = nowIso();
  const result = await mutateMonitors((currentMonitors) => {
    const sourceIndex = currentMonitors.findIndex((monitor) => monitor.id === sourceMonitor.id);
    if (sourceIndex < 0) {
      return { ok: false, error: '주소를 재사용할 추적 페이지를 찾을 수 없습니다.' };
    }
    if (currentMonitors.some((monitor) => monitor.id !== sourceMonitor.id && monitor.url === targetUrl)) {
      return { ok: false, error: '새 주소는 이미 추적 중입니다.' };
    }

    const affected = resetMonitorForPageUrl(currentMonitors[sourceIndex], targetUrl, timestamp, { copy });
    if (copy) {
      if (currentMonitors.length >= MAX_MONITORS) {
        return { ok: false, error: '추적은 최대 개수에 도달했습니다.' };
      }
      currentMonitors.push(affected);
    } else {
      currentMonitors[sourceIndex] = affected;
    }
    return { ok: true, monitor: { ...affected }, monitors: [{ ...affected }], count: 1 };
  });

  if (!result?.ok) return result;
  if (!copy) {
    await releaseUnusedSitePermission(sourceUrl);
  }
  await refreshBadge();
  await scheduleNextAlarm();
  return result;
}

async function deletePage(urlValue) {
  const url = normalizeUrl(urlValue);
  if (!url) return { ok: false, error: '삭제할 페이지 주소가 올바르지 않습니다.' };

  let deleted;
  await mutateMonitors((monitors) => {
    const index = monitors.findIndex((monitor) => monitor.url === url);
    if (index >= 0) {
      deleted = monitors.splice(index, 1)[0];
    }
  });
  if (!deleted) return { ok: false, error: '삭제할 추적 페이지를 찾을 수 없습니다.' };

  await releaseUnusedSitePermission(url);
  await refreshBadge();
  await scheduleNextAlarm();
  return { ok: true, deletedCount: 1 };
}

async function acknowledgeMonitor(id) {
  await mutateMonitors((monitors) => {
    const monitor = monitors.find((item) => item.id === id);
    if (!monitor) {
      return;
    }
    monitor.unread = false;
    if (monitor.status === 'changed') {
      monitor.status = statusForStoredSnapshot(monitor.snapshot);
    }
    monitor.updatedAt = nowIso();
  });
  await refreshBadge();
  return { ok: true };
}

async function openMonitorWindow(id) {
  const monitor = (await getMonitors()).find((item) => item.id === id);
  if (!monitor) {
    return { ok: false, error: '모니터를 찾을 수 없습니다.' };
  }

  await chrome.windows.create({
    url: monitor.url,
    type: 'popup',
    width: 520,
    height: 680,
    focused: true
  });
  await acknowledgeMonitor(id);
  return { ok: true };
}

async function importMonitors(message) {
  const beforeImport = await getMonitors();
  const sourceMonitors = Array.isArray(message.monitors) ? message.monitors : [];
  const rawMonitors = sourceMonitors.slice(0, MAX_MONITORS);
  const prepared = [];
  const preparedUrls = new Set();
  const usedIds = new Set();
  let rejected = Math.max(0, sourceMonitors.length - MAX_MONITORS);
  let imported = 0;
  let disabledForPermission = 0;

  for (const raw of rawMonitors) {
    if (!raw || !Array.isArray(raw.selectors)) {
      rejected += 1;
      continue;
    }

    const monitor = normalizeMonitor(raw);
    if (!monitor || preparedUrls.has(monitor.url)) {
      rejected += 1;
      continue;
    }
    try {
      await validateSelectorList(monitor.selectors);
    } catch {
      rejected += 1;
      continue;
    }

    if (usedIds.has(monitor.id)) {
      monitor.id = createId();
    }
    usedIds.add(monitor.id);
    preparedUrls.add(monitor.url);
    monitor.revision = createRevision();

    if (!monitor.snapshot && monitor.status === 'ok') {
      monitor.status = 'needs-baseline';
    }
    if (monitor.enabled && !await hasSitePermission(monitor.url)) {
      monitor.enabled = false;
      monitor.status = 'permission-needed';
      monitor.lastError = '가져온 추적에 이 사이트의 접근 권한이 필요합니다.';
      disabledForPermission += 1;
    } else if (!monitor.enabled && monitor.status === 'permission-needed') {
      monitor.status = statusForStoredSnapshot(monitor.snapshot);
      monitor.lastError = null;
    }
    prepared.push(monitor);
  }

  const result = await mutateMonitors((monitors) => {
    if (message.mode === 'replace') {
      monitors.splice(0, monitors.length);
    }

    for (const preparedMonitor of prepared) {
      const monitor = {
        ...preparedMonitor,
        selectors: [...preparedMonitor.selectors]
      };
      const urlIndex = monitors.findIndex((item) => item.url === monitor.url);
      const idCollision = monitors.some((item) => item.id === monitor.id && item.url !== monitor.url);
      if (idCollision) {
        monitor.id = createId();
      }

      if (urlIndex >= 0) {
        monitors[urlIndex] = monitor;
        imported += 1;
      } else if (monitors.length < MAX_MONITORS) {
        monitors.push(monitor);
        imported += 1;
      } else {
        rejected += 1;
      }
    }
    return { ok: true, imported, rejected, disabledForPermission };
  });

  await refreshBadge();
  await scheduleNextAlarm();
  await Promise.all(beforeImport.map((monitor) => releaseUnusedSitePermission(monitor.url)));
  return result;
}

async function openDashboard() {
  await chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  return { ok: true };
}

async function releaseUnclaimedOrigin(message, sender) {
  const url = normalizeUrl(message.url);
  await releasePendingPicker(message.tabId ?? sender?.tab?.id);
  if (url) {
    await releaseUnusedSitePermission(url);
  }
  return { ok: true };
}

async function startPicker(tabId, url) {
  if (!Number.isInteger(tabId)) {
    return { ok: false, error: '현재 탭을 찾을 수 없습니다.' };
  }
  const normalizedUrl = normalizeUrl(url);
  if (normalizedUrl) {
    await rememberPendingPicker(tabId, normalizedUrl);
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['selector-engine.js', 'picker.js']
    });
  } catch (error) {
    await forgetPendingPicker(tabId);
    throw error;
  }
  return { ok: true };
}

const messageHandlers = {
  'get-state': async () => ({ ok: true, ...(await getState()) }),
  'start-picker': (message) => startPicker(message.tabId, message.url),
  'create-monitor': (message, sender) => createMonitor(message, sender),
  'create-monitors': (message, sender) => createMonitors(message, sender),
  'save-monitor': (message) => saveMonitor(message),
  'set-monitor-enabled': (message) => setMonitorEnabled(message),
  'delete-monitor': (message) => deleteMonitor(message.id),
  'check-monitor': (message) => checkMonitor(message.id),
  'check-page': (message) => checkPage(message.url),
  'move-page-url': (message) => reusePageUrl(message),
  'copy-page-url': (message) => reusePageUrl(message, { copy: true }),
  'delete-page': (message) => deletePage(message.url),
  'acknowledge-monitor': (message) => acknowledgeMonitor(message.id),
  'open-monitor-window': (message) => openMonitorWindow(message.id),
  'import-monitors': (message) => importMonitors(message),
  'open-dashboard': () => openDashboard(),
  'release-unclaimed-origin': (message, sender) => releaseUnclaimedOrigin(message, sender),
  'save-settings': async (message) => ({ ok: true, settings: await updateSettings(message.settings) })
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = messageHandlers[message?.type];
  if (!handler) {
    return;
  }

  Promise.resolve(handler(message, _sender)).then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: responseError(error) });
  });
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    void runDueChecks();
  }
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId.startsWith('openstill-change:')) {
    void openMonitorWindow(notificationId.slice('openstill-change:'.length));
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void releasePendingPicker(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    void releasePendingPicker(tabId);
  }
});

async function initialize({ cleanupPermissions = false } = {}) {
  if (chrome.storage.local.setAccessLevel) {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  }
  await refreshBadge();
  await clearExpiredPendingPickers();
  if (cleanupPermissions) {
    await cleanupUnusedSitePermissions();
  }
  await scheduleNextAlarm();
}

chrome.runtime.onInstalled.addListener(() => {
  void initialize({ cleanupPermissions: true });
});

chrome.runtime.onStartup.addListener(() => {
  void initialize({ cleanupPermissions: true });
});

void initialize();
