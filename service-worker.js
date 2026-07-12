'use strict';

const MONITORS_KEY = 'openStill.monitors.v2';
const SETTINGS_KEY = 'openStill.settings.v1';
const PENDING_PICKERS_KEY = 'openStill.pending-pickers.v1';
const ALARM_NAME = 'openStill.next-check';

const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 14 * 24;
const SCHEDULE_MODE_MANUAL = 'manual';
const SCHEDULE_MODE_INTERVAL = 'interval';
const SCHEDULE_MODES = new Set([SCHEDULE_MODE_MANUAL, SCHEDULE_MODE_INTERVAL]);
// unlimitedStorage prevents a few large snapshots from blocking a legitimate
// import of hundreds of user-configured trackers.
const MAX_MONITORS = 1_000;
const MAX_SELECTORS_PER_MONITOR = 20;
const MAX_COLLECTION_ITEMS = 10_000;
// Storage is explicitly unlimited. Keep the canonical comparison payload much
// larger than the dashboard preview so a change after the first few cards is
// not silently invisible. Presentation code is responsible for clipping what
// it renders, never the comparison engine.
const MAX_SNAPSHOT_CHARS = 1_000_000;
const MAX_CHANGE_HISTORY = 20;
const MAX_RUN_HISTORY = 40;
const ERROR_RETRY_MS = 120_000;
const PARSE_TIMEOUT_MS = 12_000;
const SOUND_DEBOUNCE_MS = 3_000;
const MAX_CHECKS_PER_SWEEP = 6;
const MAX_BATCH_CHECKS = 1_000;
const MAX_CONCURRENT_BATCH_CHECKS = 3;
const PENDING_PICKER_TTL_MS = 2 * 60 * 60 * 1000;
const RENDER_LOAD_TIMEOUT_MS = 30_000;
// Never inspect a page or calculate picker coordinates before the top-level load
// event has completed and this additional settling period has elapsed.
const RENDER_MINIMUM_WAIT_MS = 2_500;
const PICKER_READY_DELAY_MS = 2_500;
const RENDER_QUIET_MS = 650;
const RENDER_SETTLE_TIMEOUT_MS = 5_000;
const CHECK_EXECUTION_TIMEOUT_MS = 60_000;
const MIN_CHECK_EXECUTION_TIMEOUT_MS = 10_000;
const MAX_CHECK_EXECUTION_TIMEOUT_MS = 300_000;
// Match the reference runner's empty-selection behavior: after the initial
// rendered capture it retries every five seconds through retryCount 5.
const RENDER_EMPTY_RETRY_COUNT = 4;
const RENDER_EMPTY_RETRY_DELAY_MS = 5_000;
const DEFAULT_LIVE_DEBOUNCE_MS = 1_200;
const MIN_LIVE_DEBOUNCE_MS = 250;
const MAX_LIVE_DEBOUNCE_MS = 30_000;

const DEFAULT_SETTINGS = Object.freeze({ soundEnabled: true });
const VALID_STATUSES = new Set([
  'ok',
  'changed',
  'needs-review',
  'error',
  'permission-needed',
  'needs-baseline'
]);
const LOCATOR_TYPES = new Set(['css', 'xcss', 'xpath']);
const LOCATOR_OPERATIONS = new Set(['include', 'exclude']);
const LOCATOR_FIELD_TYPES = new Set(['text', 'attribute', 'property']);

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

// A compact deterministic fingerprint lets the monitor detect a change beyond
// the stored dashboard preview cap without silently treating two truncated
// payloads as equal. It is not used as a security primitive.
function snapshotFingerprint(value) {
  const text = String(value ?? '');
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `${text.length.toString(36)}:${first.toString(36)}:${second.toString(36)}`;
}

// The reference comparison does not use literal-string equality when the
// user elects to keep whitespace significant. It separates words and runs of
// whitespace, which preserves punctuation and word boundaries while avoiding
// noisy line-wrap differences from independently rendered pages.
function comparisonTokens(value) {
  return String(value ?? '').split(/\s+|\b/g);
}

function comparisonTokenFingerprint(value) {
  // NUL cannot survive cleanSnapshotHtml and makes an unambiguous separator
  // for the otherwise variable-width tokens.
  return snapshotFingerprint(comparisonTokens(value).join('\u0000'));
}

function comparisonTokensEqual(left, right) {
  const leftTokens = comparisonTokens(left);
  const rightTokens = comparisonTokens(right);
  return leftTokens.length === rightTokens.length
    && leftTokens.every((token, index) => token === rightTokens[index]);
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

function normalizeScheduleMode(value, fallback = null) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const mode = typeof value === 'string' ? value.trim() : value;
  return SCHEDULE_MODES.has(mode) ? mode : null;
}

function isAutomaticSchedule(monitor) {
  return monitor?.scheduleMode === SCHEDULE_MODE_INTERVAL;
}

function nextCheckForSchedule(scheduleMode, lastCheckedAt, intervalHours, requestedNextCheck = null) {
  if (scheduleMode !== SCHEDULE_MODE_INTERVAL) {
    return null;
  }
  const calculatedNextCheck = lastCheckedAt ? addHours(lastCheckedAt, intervalHours) : nowIso();
  return asIso(requestedNextCheck, null) ?? calculatedNextCheck;
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

// A site-address migration deliberately operates on the URL host rather than
// doing a string replacement. That preserves every monitored path and query
// while ensuring `old.example` cannot accidentally change a path, label, or
// similarly named subdomain.
function normalizeSiteHost(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > 255) {
    return null;
  }

  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    if (
      !['https:', 'http:'].includes(url.protocol)
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
    ) {
      return null;
    }
    return url.host ? url.host.toLowerCase() : null;
  } catch {
    return null;
  }
}

function siteHostOfUrl(value) {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

function replaceUrlHost(urlValue, sourceHost, targetHost) {
  try {
    const url = new URL(urlValue);
    if (url.host.toLowerCase() !== sourceHost) {
      return null;
    }
    url.host = targetHost;
    return normalizeUrl(url.href);
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

function cleanLocatorField(value) {
  const raw = typeof value === 'string'
    ? { type: value === 'text' ? 'text' : 'attribute', name: value }
    : value && typeof value === 'object'
      ? value
      : null;
  if (!raw) return null;
  let type = String(raw.type ?? raw.kind ?? '').trim().toLowerCase();
  let name = String(raw.name ?? raw.value ?? '').trim();
  if (typeof value === 'string') {
    if (value.startsWith('attr:')) {
      type = 'attribute';
      name = value.slice('attr:'.length).trim();
    } else if (value.startsWith('property:')) {
      type = 'property';
      name = value.slice('property:'.length).trim();
    }
  }
  if (type === 'builtin') type = name === 'text' ? 'text' : '';
  if (!LOCATOR_FIELD_TYPES.has(type)) return null;
  if (type === 'text') return { type: 'text' };
  if (!/^[A-Za-z_$][\w$-]{0,80}$/.test(name)) return null;
  return { type, name };
}

function cleanLocatorFields(value) {
  const explicitlyConfigured = value !== undefined && value !== null;
  const source = Array.isArray(value) ? value : explicitlyConfigured ? [value] : [];
  const fields = [];
  const seen = new Set();
  for (const item of source.slice(0, 12)) {
    const field = cleanLocatorField(item);
    if (!field) continue;
    const key = `${field.type}\u0000${field.name ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      fields.push(field);
    }
  }
  // Omitted fields mean the familiar text monitor. An explicit empty list is
  // different: it keeps filtered HTML/data while deliberately contributing no
  // text, which is useful for a data-mode structural monitor.
  return fields.length || explicitlyConfigured ? fields : [{ type: 'text' }];
}

function cleanFramePath(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 16) return null;
  const path = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null;
    const url = normalizeUrl(entry.url);
    const indexValue = entry.index ?? entry.siblingIndex;
    const index = Number.isInteger(indexValue)
      ? indexValue
      : typeof indexValue === 'string' && /^\d+$/.test(indexValue.trim())
        ? Number(indexValue)
        : Number.NaN;
    if (!url || !Number.isInteger(index) || index < 0 || index > 10_000) return null;
    path.push({ url, index });
  }
  return path;
}

function cleanLocator(value, defaults = {}) {
  const raw = typeof value === 'string' ? { expr: value } : value;
  if (!raw || typeof raw !== 'object') return null;
  const typeAlias = String(raw.type ?? defaults.type ?? 'css').trim().toLowerCase();
  const type = typeAlias === 'extended-css' || typeAlias === 'extendedcss' ? 'xcss' : typeAlias;
  if (!LOCATOR_TYPES.has(type)) return null;
  const expr = cleanSelector(raw.expr ?? raw.selector ?? raw.value);
  if (!expr) return null;
  const operationAlias = String(raw.op ?? raw.operation ?? defaults.op ?? 'include').trim().toLowerCase();
  const op = operationAlias === 'exclude' ? 'exclude' : operationAlias === 'include' ? 'include' : '';
  if (!LOCATOR_OPERATIONS.has(op)) return null;
  const frameValue = raw.frameId ?? raw.frame ?? defaults.frameId ?? 0;
  const frameId = Number.isInteger(frameValue)
    ? frameValue
    : typeof frameValue === 'string' && /^\d+$/.test(frameValue.trim())
      ? Number(frameValue)
      : Number.NaN;
  if (!Number.isInteger(frameId) || frameId < 0 || frameId > 1_000_000) return null;
  const framePath = cleanFramePath(raw.framePath ?? raw.frameDescriptor);
  if (framePath === null) return null;
  return {
    type,
    expr,
    op,
    frameId,
    framePath,
    fields: cleanLocatorFields(raw.fields)
  };
}

function locatorKey(locator) {
  return [
    locator.type,
    locator.op,
    locator.frameId,
    JSON.stringify(locator.framePath ?? []),
    locator.expr,
    ...locator.fields.map((field) => `${field.type}:${field.name ?? ''}`)
  ].join('\u0001');
}

function cleanLocators(value) {
  const source = Array.isArray(value) ? value : [value];
  if (!source.length || source.length > MAX_SELECTORS_PER_MONITOR) return null;
  const locators = [];
  const seen = new Set();
  for (const item of source) {
    const locator = cleanLocator(item);
    if (!locator) return null;
    const key = locatorKey(locator);
    if (seen.has(key)) continue;
    seen.add(key);
    locators.push(locator);
  }
  return locators.some((locator) => locator.op === 'include') ? locators : null;
}

function displaySelectorsForLocators(locators) {
  return locators
    .filter((locator) => locator.op === 'include')
    .map((locator) => locator.expr);
}

function framePathForFrame(frameId, frames) {
  if (frameId === 0) return [];
  const byId = new Map(frames.map((frame) => [frame.frameId, frame]));
  const path = [];
  let current = byId.get(frameId);
  while (current && current.parentFrameId >= 0) {
    const url = normalizeUrl(current.url);
    if (!url) return null;
    // Frame ids are assigned afresh on every load.  Counting every sibling
    // makes a saved route drift merely because an unrelated ad or widget was
    // inserted before it, so disambiguate only among siblings with the same
    // normalized document URL.
    const siblings = frames
      .filter((frame) => frame.parentFrameId === current.parentFrameId && normalizeUrl(frame.url) === url)
      .sort((left, right) => left.frameId - right.frameId);
    const index = siblings.findIndex((frame) => frame.frameId === current.frameId);
    if (index < 0) return null;
    path.unshift({ url, index });
    current = byId.get(current.parentFrameId);
  }
  return current ? path : null;
}

function stableFrameLocation(value) {
  const normalized = normalizeUrl(value);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    // Session/query tokens on embed URLs commonly change on every reload.
    // They are useful for an exact match first, but origin+path is the safe
    // secondary identity when it identifies one and only one frame route.
    url.search = '';
    return url.href;
  } catch {
    return null;
  }
}

function sameFramePath(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((part, index) => part.url === right[index]?.url && part.index === right[index]?.index);
}

function sameRelaxedFramePath(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((part, index) => (
      part.index === right[index]?.index
      && stableFrameLocation(part.url) === stableFrameLocation(right[index]?.url)
    ));
}

function resolveLocatorFrame(locator, frames) {
  if (locator.framePath?.length) {
    const exact = frames.filter((frame) => sameFramePath(locator.framePath, framePathForFrame(frame.frameId, frames)));
    if (exact.length === 1) return exact[0].frameId;
    const relaxed = frames.filter((frame) => sameRelaxedFramePath(locator.framePath, framePathForFrame(frame.frameId, frames)));
    if (relaxed.length === 1) return relaxed[0].frameId;
    // A saved path is stronger evidence than Chrome's transient frame id.  Do
    // not silently run a selector in a possibly unrelated frame after a
    // reload: callers turn this sentinel into a clear configuration error.
    return -1;
  }
  return Number.isInteger(locator.frameId) ? locator.frameId : 0;
}

function cleanRegularExpression(value) {
  const source = typeof value === 'string'
    ? { expr: value }
    : value && typeof value === 'object' ? value : null;
  if (!source) return null;
  const expr = String(source.expr ?? source.pattern ?? source.value ?? '').trim();
  const flags = String(source.flags ?? '').trim();
  if (!expr) return null;
  if (expr.length > 1_000 || flags.length > 12 || !/^[dgimsuvy]*$/.test(flags) || new Set(flags).size !== flags.length) {
    return null;
  }
  try {
    // Validate in the same JavaScript regexp engine used for a later capture.
    // `u` and `v` are mutually exclusive even in engines that support both.
    if (flags.includes('u') && flags.includes('v')) return null;
    new RegExp(expr, flags);
    return { expr, flags };
  } catch {
    return null;
  }
}

function hasInvalidConfiguredRegularExpression(value) {
  const source = value && typeof value === 'object' ? value : {};
  const candidate = source.regexp ?? source.regex ?? source.textFilter;
  if (candidate === undefined || candidate === null || candidate === '') return false;
  if (typeof candidate === 'object' && !String(candidate.expr ?? candidate.pattern ?? candidate.value ?? '').trim()) return false;
  return !cleanRegularExpression(candidate);
}

function normalizeTracking(value) {
  const input = value && typeof value === 'object' ? value : {};
  const requestedDataAttr = String(input.dataAttr ?? input.compare ?? input.comparison ?? 'text').toLowerCase();
  const dataAttr = requestedDataAttr === 'data' || requestedDataAttr === 'html' ? 'data' : 'text';
  const delayMilliseconds = Object.hasOwn(input, 'delayMilliseconds')
    ? Number(input.delayMilliseconds)
    : Number(input.delay ?? 0) * 1_000;
  const timeoutMilliseconds = Object.hasOwn(input, 'timeoutMilliseconds')
    ? Number(input.timeoutMilliseconds)
    : Object.hasOwn(input, 'timeout')
      ? Number(input.timeout) * 1_000
      : CHECK_EXECUTION_TIMEOUT_MS;
  const liveDebounce = Number(input.liveDebounceMilliseconds ?? input.liveDebounce ?? DEFAULT_LIVE_DEBOUNCE_MS);
  return {
    dataAttr,
    ignoreWhitespace: input.ignoreWhitespace !== false,
    allowEmpty: input.allowEmpty === true || input.ignoreEmptyText === false,
    regexp: cleanRegularExpression(input.regexp ?? input.regex ?? input.textFilter),
    includeScript: input.includeScript === true || input.includeScripts === true,
    includeStyle: input.includeStyle === true || input.includeStyles === true,
    keepComments: input.keepComments === true,
    live: input.live === true || input.liveMonitoring === true,
    liveDebounceMilliseconds: Number.isFinite(liveDebounce)
      ? Math.max(MIN_LIVE_DEBOUNCE_MS, Math.min(MAX_LIVE_DEBOUNCE_MS, Math.round(liveDebounce)))
      : DEFAULT_LIVE_DEBOUNCE_MS,
    delayMilliseconds: Number.isFinite(delayMilliseconds)
      ? Math.max(0, Math.min(60_000, Math.round(delayMilliseconds)))
      : 0,
    timeoutMilliseconds: Number.isFinite(timeoutMilliseconds)
      ? Math.max(MIN_CHECK_EXECUTION_TIMEOUT_MS, Math.min(MAX_CHECK_EXECUTION_TIMEOUT_MS, Math.round(timeoutMilliseconds)))
      : CHECK_EXECUTION_TIMEOUT_MS
  };
}

function filterCapturedText(text, tracking) {
  const regexp = normalizeTracking(tracking).regexp;
  const source = String(text ?? '');
  if (!regexp) return source;
  try {
    const matches = source.match(new RegExp(regexp.expr, regexp.flags));
    return matches?.length ? matches.join(' ') : '';
  } catch {
    // Stored monitors are normalized before use, but preserve a deterministic
    // empty result if a browser later rejects a previously valid regexp flag.
    return '';
  }
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
  const fullItemTexts = rawItems.map((item) => cleanSnapshotText(item?.text, Number.MAX_SAFE_INTEGER));
  const fullText = rawItems.length
    ? fullItemTexts.join('\n\n')
    : cleanSnapshotText(value.text, Number.MAX_SAFE_INTEGER);
  const itemCount = Math.min(rawItems.length, MAX_COLLECTION_ITEMS);
  const separatorLength = Math.max(0, itemCount - 1) * 2;
  const perItemLimit = itemCount
    ? Math.max(0, Math.floor(Math.max(0, MAX_SNAPSHOT_CHARS - separatorLength) / itemCount))
    : 0;
  const items = rawItems.slice(0, MAX_COLLECTION_ITEMS).map((item) => ({
    text: cleanSnapshotText(item?.text, perItemLimit)
  }));
  if (!items.length && fullText) items.push({ text: fullText.slice(0, MAX_SNAPSHOT_CHARS) });
  const fullHtml = cleanSnapshotHtml(
    typeof value.html === 'string' ? value.html : snapshotHtmlFromItems(rawItems),
    Number.MAX_SAFE_INTEGER
  );
  const fullData = cleanSnapshotHtml(
    typeof value.data === 'string' ? value.data : fullHtml,
    Number.MAX_SAFE_INTEGER
  );
  const html = fullHtml.slice(0, MAX_SNAPSHOT_CHARS);
  const data = fullData.slice(0, MAX_SNAPSHOT_CHARS);
  const evidenceHtml = cleanSnapshotHtml(value.evidenceHtml, MAX_SNAPSHOT_CHARS);
  const safeMatchCount = Number.isInteger(matchCount) && matchCount >= 0
    ? matchCount
    : items.length;
  // `exists` records whether the extractor found a meaningful selected root;
  // it is deliberately independent from whether there is textual content.
  // An allow-empty monitor must retain its filtered HTML/data even at zero
  // matches so a later structural reappearance can be compared faithfully.
  const exists = Boolean(value.exists);
  const retainPayload = exists
    || rawItems.length > 0
    || Boolean(fullText)
    || Boolean(fullHtml)
    || Boolean(fullData);

  return {
    exists,
    matchCount: safeMatchCount,
    text: retainPayload ? snapshotTextFromItems(items) : '',
    html: retainPayload ? html : '',
    data: retainPayload ? data : '',
    evidenceHtml,
    items: retainPayload ? items : [],
    textFingerprint: snapshotFingerprint(fullText),
    compactTextFingerprint: snapshotFingerprint(fullText.replace(/\s/g, '')),
    tokenTextFingerprint: comparisonTokenFingerprint(fullText),
    dataFingerprint: snapshotFingerprint(fullData),
    compactDataFingerprint: snapshotFingerprint(fullData.replace(/\s/g, '')),
    tokenDataFingerprint: comparisonTokenFingerprint(fullData),
    textTruncated: fullText.length > MAX_SNAPSHOT_CHARS || rawItems.length > MAX_COLLECTION_ITEMS,
    dataTruncated: fullData.length > MAX_SNAPSHOT_CHARS,
    capturedAt: asIso(value.capturedAt, null)
  };
}

function snapshotsEqual(left, right, tracking = null) {
  // Match count and individual-root boundaries are presentation metadata, not
  // a change by themselves. The selected representation is explicit, though:
  // `text` preserves the familiar whitespace-insensitive monitor behaviour,
  // while `data` compares the filtered HTML so a changed href/src is visible.
  const options = normalizeTracking(tracking);
  const field = options.dataAttr === 'data' ? 'data' : 'text';
  const fingerprintField = field === 'data'
    ? options.ignoreWhitespace ? 'compactDataFingerprint' : 'tokenDataFingerprint'
    : options.ignoreWhitespace ? 'compactTextFingerprint' : 'tokenTextFingerprint';
  const truncatedField = field === 'data' ? 'dataTruncated' : 'textTruncated';
  const fingerprintComparable = left?.[fingerprintField] && right?.[fingerprintField]
    && (left?.[truncatedField] || right?.[truncatedField])
    ? left[fingerprintField] === right[fingerprintField]
    : null;
  const comparable = options.ignoreWhitespace
    ? String(left?.[field] ?? '').replace(/\s/g, '') === String(right?.[field] ?? '').replace(/\s/g, '')
    : comparisonTokensEqual(left?.[field], right?.[field]);
  return Boolean(left && right)
    && left.exists === right.exists
    && (fingerprintComparable ?? comparable);
}

function normalizeMonitor(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const url = normalizeUrl(value.url);
  const locators = cleanLocators(value.locators ?? value.selectors);
  const selectors = locators ? displaySelectorsForLocators(locators) : null;
  // Pre-manual-mode monitors always used interval scheduling. Preserve that
  // behavior during migration; newly created monitors explicitly store manual.
  const scheduleMode = normalizeScheduleMode(value.scheduleMode, SCHEDULE_MODE_INTERVAL);
  const intervalHours = clampInterval(value.intervalHours)
    ?? (scheduleMode === SCHEDULE_MODE_MANUAL ? MIN_INTERVAL_HOURS : null);
  if (!url || !locators || !selectors || !scheduleMode || !intervalHours) {
    return null;
  }
  const createdAt = asIso(value.createdAt, nowIso());
  const lastCheckedAt = asIso(value.lastCheckedAt, null);
  const lastChangedAt = asIso(value.lastChangedAt, null);
  const lastViewedAt = asIso(value.lastViewedAt ?? value.lastReadAt, null);
  const status = VALID_STATUSES.has(value.status) ? value.status : 'ok';
  const tracking = normalizeTracking(value.tracking ?? value);
  const normalizedSnapshot = normalizeSnapshot(value.snapshot);
  // A no-match result is never a baseline. Keeping it here would make the
  // next successful render look like an element deletion/reappearance change.
  const snapshot = normalizedSnapshot && (normalizedSnapshot.exists || tracking.allowEmpty)
    ? normalizedSnapshot
    : null;
  const lastChange = value.lastChange && typeof value.lastChange === 'object'
    ? {
        previous: normalizeSnapshot(value.lastChange.previous),
        current: normalizeSnapshot(value.lastChange.current),
        detectedAt: asIso(value.lastChange.detectedAt, null)
      }
    : null;
  const lastErrorSnapshot = normalizeSnapshot(value.lastErrorSnapshot);
  const history = Array.isArray(value.history)
    ? value.history.slice(0, MAX_CHANGE_HISTORY).map((entry) => {
        const snapshot = normalizeSnapshot(entry?.snapshot ?? entry);
        return snapshot?.exists
          ? {
              snapshot,
              capturedAt: asIso(entry?.capturedAt ?? snapshot.capturedAt, null),
              kind: entry?.kind === 'baseline' ? 'baseline' : 'change'
            }
          : null;
      }).filter(Boolean)
    : [];
  const runs = Array.isArray(value.runs)
    ? value.runs.slice(0, MAX_RUN_HISTORY).map((entry) => ({
        at: asIso(entry?.at ?? entry?.checkedAt, null),
        status: VALID_STATUSES.has(entry?.status) ? entry.status : 'error',
        code: cleanShortText(entry?.code, 80) || null,
        message: cleanShortText(entry?.message ?? entry?.error, 300) || null,
        changed: Boolean(entry?.changed),
        matchCount: Number.isInteger(entry?.matchCount) && entry.matchCount >= 0 ? entry.matchCount : null
      })).filter((entry) => entry.at)
    : [];

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
    locators,
    tracking,
    labels: cleanLabels(value.labels),
    scheduleMode,
    intervalHours,
    enabled: value.enabled !== false,
    createdAt,
    updatedAt: asIso(value.updatedAt, createdAt),
    lastCheckedAt,
    lastChangedAt,
    nextCheckAt: nextCheckForSchedule(scheduleMode, lastCheckedAt, intervalHours, value.nextCheckAt),
    snapshot,
    lastChange,
    lastErrorSnapshot,
    history,
    runs,
    lastReviewAt: asIso(value.lastReviewAt, null),
    lastViewedAt,
    lastError: cleanText(value.lastError, 300) || null,
    status,
    unread: lastChangedAt && (!lastViewedAt || Date.parse(lastViewedAt) < Date.parse(lastChangedAt))
      ? true
      : Boolean(value.unread)
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

function migrateLegacyScheduleModes() {
  const operation = storageQueue.catch(() => undefined).then(async () => {
    const stored = await chrome.storage.local.get(MONITORS_KEY);
    const rawMonitors = stored[MONITORS_KEY];
    if (!Array.isArray(rawMonitors) || !rawMonitors.some((monitor) => (
      monitor && typeof monitor === 'object' && !Object.hasOwn(monitor, 'scheduleMode')
    ))) {
      return false;
    }

    // Older releases only had intervalHours, which meant automatic scheduling.
    // Persist that explicit meaning once so the new default applies only to new
    // trackers rather than silently stopping existing schedules.
    const monitors = rawMonitors.map(normalizeMonitor).filter(Boolean);
    await chrome.storage.local.set({ [MONITORS_KEY]: monitors });
    return true;
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
  // HTTP/HTTPS host access is a required install-time permission. Keep this
  // guard so every caller still rejects unsupported schemes, but do not make
  // users approve hundreds of imported origins one at a time.
  return Boolean(normalizeUrl(url));
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
  // Host access is now declared in manifest.json, so Chrome does not allow it
  // to be removed per origin at runtime. The picker bookkeeping still calls
  // this helper when a user cancels selection; making it a no-op keeps that
  // lifecycle explicit without attempting to mutate required permissions.
  void pattern;
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
  // See releaseUnusedOriginPermission: broad HTTP/HTTPS access is required at
  // installation time for batch imports and scheduled checks.
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
      justification: 'OpenStill validates CSS selectors and plays a local alert tone.'
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

async function parseMonitoredHtml(html, selector, selectorType = 'css') {
  await ensureOffscreenDocument();
  const result = await timeout(
    chrome.runtime.sendMessage({ type: 'parse-monitor-html', html, selector, selectorType }),
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

async function validateSelectorSyntax(selector, selectorType = 'css') {
  await parseMonitoredHtml('', selector, selectorType);
}

function waitForRenderedTab(tabId) {
  let cancel = () => undefined;
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      finish(() => reject(new Error('렌더링된 페이지를 여는 데 30초가 넘게 걸렸습니다.')));
    }, RENDER_LOAD_TIMEOUT_MS);
    const finish = (settle) => {
      if (settled) return;
      settled = true;
      cleanup();
      settle();
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'complete') {
        finish(resolve);
      }
    };
    const cleanup = () => {
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(listener);
    };
    cancel = cleanup;
    chrome.tabs.onUpdated.addListener(listener);

    // A fast cached page can finish before the listener above is attached.
    // We only create this tab for the target URL, so an already-complete state
    // is a valid full-load signal as well.
    if (typeof chrome.tabs.get === 'function') {
      void chrome.tabs.get(tabId).then((tab) => {
        if (tab?.status === 'complete') finish(resolve);
      }).catch(() => undefined);
    }
  });
  return { promise, cancel };
}

async function waitForPageLoadAndPickerDelay(tabId) {
  const execution = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (delayMilliseconds) => {
      if (document.readyState !== 'complete') {
        await new Promise((resolve) => window.addEventListener('load', resolve, { once: true }));
      }
      await new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
      return document.readyState;
    },
    args: [PICKER_READY_DELAY_MS]
  });

  if (execution[0]?.result !== 'complete') {
    throw new Error('페이지가 완전히 로드되기 전에 선택기를 시작할 수 없습니다.');
  }
}

// Typed capture entry point. Its implementation is kept separate from the
// legacy collector below so existing stored CSS-only monitors can migrate
// without a behavior gap while richer locators are introduced.
async function captureReferenceRenderedDocumentCollection(...args) {
  const [rawLocators, minimumWaitMilliseconds, quietMilliseconds, settleTimeoutMilliseconds,
    emptyRetryCount = 4, emptyRetryDelayMilliseconds = 5_000, captureOptions = {}] = args;
  const includeMark = 'data-openstill-capture-include';
  const excludeMark = 'data-openstill-capture-exclude';
  const automaticIncludeMark = 'data-openstill-capture-automatic';
  const includeInlineScripts = captureOptions?.includeScript === true || captureOptions?.includeScripts === true;
  const includeStyles = captureOptions?.includeStyle === true || captureOptions?.includeStyles === true;
  const keepComments = captureOptions?.keepComments === true;
  const isIgnoredElement = (node) => {
    if (node?.nodeType !== Node.ELEMENT_NODE) return true;
    if (['NOSCRIPT', 'FRAME', 'IFRAME'].includes(node.tagName)) return true;
    // When code capture is disabled, scripts and script-preload links are
    // excluded. When it is enabled, inline scripts are added automatically,
    // while an external script remains visible if it belongs to a broader
    // user-selected subtree (the page's own markup is still meaningful data).
    if (node.tagName === 'SCRIPT') return !includeInlineScripts;
    if (node.tagName === 'LINK' && String(node.getAttribute('as') || '').toLowerCase() === 'script') return !includeInlineScripts;
    if (node.tagName === 'STYLE') return !includeStyles;
    if (node.tagName === 'LINK' && /(^|\s)stylesheet(\s|$)/i.test(node.getAttribute('rel') || '')) return !includeStyles;
    return false;
  };
  const blockTags = new Set([
    'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'CAPTION', 'CODE', 'DD', 'DIV', 'FIELDSET', 'FIGCAPTION',
    'FOOTER', 'FORM', 'HEADER', 'HR', 'LI', 'MAIN', 'OL', 'P', 'SECTION', 'SUMMARY', 'TABLE',
    'TBODY', 'TFOOT', 'THEAD', 'TR', 'UL', 'IMG', 'BR'
  ]);
  const spacedTags = new Set(['A', 'ABBR', 'ACRONYM', 'ADDRESS', 'BUTTON', 'INPUT', 'LABEL', 'TD']);

  const fieldOf = (value) => {
    const raw = typeof value === 'string'
      ? { type: value === 'text' ? 'text' : 'attribute', name: value }
      : value && typeof value === 'object' ? value : null;
    if (!raw) return null;
    let type = String(raw.type ?? raw.kind ?? '').toLowerCase();
    let name = String(raw.name ?? raw.value ?? '').trim();
    if (typeof value === 'string' && value.startsWith('attr:')) {
      type = 'attribute';
      name = value.slice(5).trim();
    }
    if (typeof value === 'string' && value.startsWith('property:')) {
      type = 'property';
      name = value.slice(9).trim();
    }
    if (type === 'builtin') type = name === 'text' ? 'text' : '';
    if (type === 'text') return { type: 'text' };
    return ['attribute', 'property'].includes(type) && /^[A-Za-z_$][\w$-]{0,80}$/.test(name)
      ? { type, name }
      : null;
  };

  const locatorOf = (value) => {
    const raw = typeof value === 'string' ? { expr: value } : value;
    if (!raw || typeof raw !== 'object') return null;
    const inputType = String(raw.type ?? 'css').trim().toLowerCase();
    const type = inputType === 'extendedcss' || inputType === 'extended-css' ? 'xcss' : inputType;
    const expr = String(raw.expr ?? raw.selector ?? raw.value ?? '').trim();
    const op = String(raw.op ?? raw.operation ?? 'include').trim().toLowerCase();
    if (!['css', 'xcss', 'xpath'].includes(type) || !expr || !['include', 'exclude'].includes(op)) return null;
    const hasExplicitFields = Object.hasOwn(raw, 'fields') && raw.fields != null;
    const values = Array.isArray(raw.fields) ? raw.fields : raw.fields == null ? [] : [raw.fields];
    const fields = [];
    const seen = new Set();
    for (const value of values) {
      const field = fieldOf(value);
      const key = field && field.type + ':' + (field.name || '');
      if (field && !seen.has(key)) {
        seen.add(key);
        fields.push(field);
      }
    }
    return {
      type,
      expr,
      op,
      fields: fields.length || hasExplicitFields ? fields : [{ type: 'text' }],
      legacy: typeof value === 'string'
    };
  };

  const locators = (Array.isArray(rawLocators) ? rawLocators : []).map(locatorOf).filter(Boolean);
  const includeLocators = locators.filter((locator) => locator.op === 'include');
  const usesExtendedCss = locators.some((locator) => locator.type === 'xcss');
  const unique = (items) => [...new Set(items)];
  const shadowFor = (element) => {
    if (element?.nodeType !== Node.ELEMENT_NODE) return null;
    try { return element.shadowRoot || globalThis.chrome?.dom?.openOrClosedShadowRoot?.(element) || null; } catch { return element.shadowRoot || null; }
  };

  const splitUnion = (source) => {
    const parts = [];
    let value = '', quote = '', escaped = false, square = 0, round = 0;
    for (const character of String(source || '')) {
      if (escaped) { value += character; escaped = false; continue; }
      if (character === '\\') { value += character; escaped = true; continue; }
      if (quote) { value += character; if (character === quote) quote = ''; continue; }
      if (character === "'" || character === '"') { value += character; quote = character; continue; }
      if (character === '[') square += 1;
      if (character === ']') square = Math.max(0, square - 1);
      if (character === '(') round += 1;
      if (character === ')') round = Math.max(0, round - 1);
      if (character === ',' && !square && !round) { if (value.trim()) parts.push(value.trim()); value = ''; }
      else value += character;
    }
    if (value.trim()) parts.push(value.trim());
    return parts;
  };

  const splitSteps = (source) => {
    const parts = [];
    let value = '', quote = '', escaped = false, escapedHexDigits = 0, square = 0, round = 0;
    const flush = () => { if (value.trim()) parts.push(value.trim()); value = ''; };
    for (const character of String(source || '').trim()) {
      if (escaped) {
        value += character;
        escaped = false;
        escapedHexDigits = /[0-9a-f]/i.test(character) ? 1 : 0;
        continue;
      }
      if (escapedHexDigits) {
        if (/[0-9a-f]/i.test(character) && escapedHexDigits < 6) {
          value += character;
          escapedHexDigits += 1;
          continue;
        }
        if (/\s/.test(character)) {
          value += character;
          escapedHexDigits = 0;
          continue;
        }
        escapedHexDigits = 0;
      }
      if (character === '\\') { value += character; escaped = true; continue; }
      if (quote) { value += character; if (character === quote) quote = ''; continue; }
      if (character === "'" || character === '"') { value += character; quote = character; continue; }
      if (character === '[') square += 1;
      if (character === ']') square = Math.max(0, square - 1);
      if (character === '(') round += 1;
      if (character === ')') round = Math.max(0, round - 1);
      if (/\s/.test(character) && !square && !round) flush(); else value += character;
    }
    flush();
    for (let index = 0; index < parts.length; index += 1) {
      if (/^[>+~]$/.test(parts[index]) && index > 0 && index < parts.length - 1) {
        parts[index - 1] += parts[index] + parts[index + 1];
        parts.splice(index, 2); index -= 1;
      } else if (/[>+~]$/.test(parts[index]) && index < parts.length - 1) {
        parts[index] += parts[index + 1]; parts.splice(index + 1, 1); index -= 1;
      } else if (/^[>+~]/.test(parts[index]) && index > 0) {
        parts[index - 1] += parts[index]; parts.splice(index, 1); index -= 1;
      }
    }
    return parts.filter(Boolean);
  };

  const queryShadowAware = (selector, root) => {
    const matches = [], visited = new Set();
    const visit = (scope) => {
      if (!scope || visited.has(scope) || typeof scope.querySelectorAll !== 'function') return;
      visited.add(scope);
      matches.push(...scope.querySelectorAll(selector));
      const descendants = [...scope.querySelectorAll('*')];
      const candidates = scope.nodeType === Node.ELEMENT_NODE ? [scope, ...descendants] : descendants;
      for (const element of candidates) {
        const shadow = shadowFor(element);
        if (shadow) visit(shadow);
      }
    };
    visit(root);
    return unique(matches);
  };

  const queryXcss = (selector) => {
    const result = [];
    for (const branch of splitUnion(selector)) {
      let roots = [document];
      for (const step of splitSteps(branch)) {
        roots = unique(roots.flatMap((root) => queryShadowAware(step, root)));
        if (!roots.length) break;
      }
      result.push(...roots);
    }
    return unique(result);
  };

  const select = (locator) => {
    if (locator.type === 'css') return [...document.querySelectorAll(locator.expr)].map((element) => ({ element }));
    if (locator.type === 'xcss') return queryXcss(locator.expr).map((element) => ({ element }));
    const iterator = document.evaluate(
      locator.expr,
      document,
      (prefix) => prefix === 'xhtml' ? 'http://www.w3.org/1999/xhtml' : null,
      XPathResult.ORDERED_NODE_ITERATOR_TYPE,
      null
    );
    const matches = [];
    for (let node = iterator.iterateNext(); node; node = iterator.iterateNext()) {
      if (node.nodeType === Node.ATTRIBUTE_NODE && node.ownerElement) {
        matches.push({ element: node.ownerElement, attributeName: node.name });
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        matches.push({ element: node });
      }
    }
    const seen = new Map();
    return matches.filter((match) => {
      const names = seen.get(match.element) || new Set();
      const key = match.attributeName || '';
      if (names.has(key)) return false;
      names.add(key);
      seen.set(match.element, names);
      return true;
    });
  };

  const parentAcrossShadow = (element) => element.parentElement || element.getRootNode?.().host || null;
  const containsAcrossShadow = (ancestor, element) => {
    for (let current = element; current; current = parentAcrossShadow(current)) if (current === ancestor) return true;
    return false;
  };
  const outerHost = (element) => {
    let current = element;
    for (let root = current.getRootNode?.(); root?.host; root = current.getRootNode?.()) current = root.host;
    return current;
  };
  const compare = (left, right) => {
    if (left === right) return 0;
    if (containsAcrossShadow(left, right)) return -1;
    if (containsAcrossShadow(right, left)) return 1;
    const position = outerHost(left).compareDocumentPosition(outerHost(right));
    return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : position & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
  };

  const fieldValues = (element, fields) => fields.filter((field) => field.type !== 'text').map((field) => {
    try {
      return field.type === 'attribute'
        ? element.hasAttribute(field.name) ? element.getAttribute(field.name) || '' : 'undefined'
        : element[field.name] ?? '';
    } catch { return ''; }
  }).map(String).filter(Boolean);

  const writeText = (root, included, excluded, automaticallyIncluded, fields) => {
    const out = [];
    // A slotted light-DOM node is reached through its slot and again through
    // the host's child list. Treat the composed text tree as a tree, not a
    // graph, so a component does not manufacture a duplicate change.
    const visitedNodes = new Set();
    const visit = (node, enabled, textEnabled) => {
      if (!node || visitedNodes.has(node)) return;
      visitedNodes.add(node);
      if (node.nodeType === Node.TEXT_NODE) { if (enabled && textEnabled) out.push(node.nodeValue || ''); return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (['NOSCRIPT', 'FRAME', 'IFRAME'].includes(node.tagName)) return;
      // Script and style selection controls structural/data capture. Their
      // source is not text-monitor content unless the user explicitly chose a
      // text field on that node; otherwise enabling the option would create a
      // surprising text-only change for a stylesheet or inline script.
      if (['SCRIPT', 'STYLE'].includes(node.tagName) && !fields.has(node)) return;
      if (isIgnoredElement(node) && !included.has(node)) return;
      let active = enabled;
      // Includes are applied before exclusions in the selection model, and a
      // direct include deliberately reopens an excluded branch. This also
      // defines the deterministic outcome when two locators match the same
      // node: include wins instead of silently erasing the tracked root.
      if (included.has(node)) active = true;
      else if (excluded.has(node)) active = false;
      else if (automaticallyIncluded.has(node)) active = true;
      let descendantsUseText = textEnabled;
      const inheritedSelectedText = [...included].some((ancestor) => (
        ancestor !== node
        && containsAcrossShadow(ancestor, node)
        && fields.get(ancestor)?.some((field) => field.type === 'text')
      ));
      if (included.has(node) && fields.has(node) && !inheritedSelectedText) {
        descendantsUseText = fields.get(node).some((field) => field.type === 'text');
      }
      if (active && descendantsUseText) {
        let block = blockTags.has(node.tagName);
        try { block ||= getComputedStyle(node).display === 'block'; } catch { /* keep semantic block */ }
        out.push(block ? '\n' : spacedTags.has(node.tagName) ? ' ' : '');
      }
      const shadow = usesExtendedCss ? shadowFor(node) : null;
      if (node.localName === 'slot') {
        const assigned = node.assignedNodes?.({ flatten: true }) || [];
        (assigned.length ? assigned : [...node.childNodes]).forEach((child) => visit(child, active, descendantsUseText));
      } else {
        if (shadow) [...shadow.childNodes].forEach((child) => visit(child, active, descendantsUseText));
        [...node.childNodes].forEach((child) => visit(child, active, descendantsUseText));
      }
      if (active && fields.has(node)) fieldValues(node, fields.get(node)).forEach((value) => out.push('\n' + value + '\n'));
    };
    visit(root, false, true);
    return out.join('').replace(/\s*\n+(\s*\n+)*/g, '\n').replace(/[\t\f\v ]+/g, ' ').trim();
  };

  const makeHtml = (included, excluded, automaticallyIncluded, excludedAttributes) => {
    if (!included.size && !automaticallyIncluded.size) return '';
    const targetDocument = document.implementation.createHTMLDocument('');
    const clones = new Map();
    const copy = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return targetDocument.createTextNode(node.nodeValue || '');
      if (node.nodeType === Node.COMMENT_NODE) return keepComments ? targetDocument.createComment(node.nodeValue || '') : null;
      if (node.nodeType !== Node.ELEMENT_NODE) return null;
      const clone = targetDocument.importNode(node, false);
      clones.set(node, clone);
      [...node.childNodes].forEach((child) => { const next = copy(child); if (next) clone.append(next); });
      const shadow = shadowFor(node);
      if (shadow) {
        const template = targetDocument.createElement('template');
        template.setAttribute('shadowrootmode', 'open');
        [...shadow.childNodes].forEach((child) => { const next = copy(child); if (next) template.content.append(next); });
        clone.insertBefore(template, clone.firstChild);
      }
      return clone;
    };
    const rootCopy = copy(document.documentElement);
    if (!rootCopy) return '';
    targetDocument.replaceChild(rootCopy, targetDocument.documentElement);
    // Reference captures always expose an absolute base. Create one when the
    // page did not provide it, then mark it as retained before the pruning
    // pass; otherwise a fragment-only capture would lose the only URL context.
    let base = rootCopy.querySelector('base');
    if (!base) {
      base = targetDocument.createElement('base');
      const head = rootCopy.querySelector('head');
      if (head) head.prepend(base);
      else rootCopy.prepend(base);
      base.setAttribute(automaticIncludeMark, '1');
    }
    try { base.setAttribute('href', document.baseURI); } catch { /* preserve a malformed source value */ }
    included.forEach((node) => clones.get(node)?.setAttribute(includeMark, '1'));
    excluded.forEach((node) => clones.get(node)?.setAttribute(excludeMark, '1'));
    automaticallyIncluded.forEach((node) => clones.get(node)?.setAttribute(automaticIncludeMark, '1'));
    excludedAttributes.forEach((names, node) => {
      const clone = clones.get(node);
      if (!clone) return;
      names.forEach((name) => clone.removeAttribute(name));
    });
    const children = (node) => node.localName === 'template' ? [...node.content.childNodes] : [...node.childNodes];
    const prune = (node, active = false) => {
      if (node.nodeType === Node.TEXT_NODE) { if (!active) node.remove(); return active; }
      if (node.nodeType === Node.COMMENT_NODE) { if (!keepComments || !active) node.remove(); return keepComments && active; }
      if (node.nodeType !== Node.ELEMENT_NODE) { node.remove(); return false; }
      // A user-selected node wins over an automatic script/style exclusion,
      // matching the include-over-exclude contract of the filtered DOM. The
      // dashboard later renders this preserved markup inertly.
      if (isIgnoredElement(node) && !node.hasAttribute(includeMark)) { node.remove(); return false; }
      let enabled = active;
      if (node.hasAttribute(includeMark)) enabled = true;
      else if (node.hasAttribute(excludeMark)) enabled = false;
      else if (node.hasAttribute(automaticIncludeMark)) enabled = true;
      const retained = children(node).map((child) => prune(child, enabled)).some(Boolean);
      if (!enabled && !retained) { node.remove(); return false; }
      return true;
    };
    prune(rootCopy);
    const absolute = (value) => { try { return new URL(value, document.baseURI).href; } catch { return value; } };
    const sanitize = (node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      for (const attribute of [...node.attributes]) {
        const internalMarker = [includeMark, excludeMark, automaticIncludeMark].includes(attribute.name);
        if ((/^on/i.test(attribute.name) && !includeInlineScripts) || internalMarker || (attribute.name === 'style' && !includeStyles)) {
          node.removeAttribute(attribute.name);
        }
      }
      if (node.matches('a[href]')) node.setAttribute('href', absolute(node.getAttribute('href')));
      if (node.matches('img[src],audio[src],video[src]')) node.setAttribute('src', absolute(node.getAttribute('src')));
      children(node).forEach(sanitize);
    };
    sanitize(rootCopy);
    return rootCopy.outerHTML;
  };

  const waitForStable = async () => {
    const root = document.documentElement;
    if (!root) return;
    const min = Math.max(0, Number(minimumWaitMilliseconds) || 0);
    const quiet = Math.max(0, Number(quietMilliseconds) || 0);
    const limit = Math.max(min, Number(settleTimeoutMilliseconds) || min);
    await new Promise((resolve) => {
      const started = performance.now(); let changed = started;
      const observer = new MutationObserver(() => { changed = performance.now(); });
      observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
      const check = () => {
        const now = performance.now();
        if ((now - started >= min && now - changed >= quiet) || now - started >= limit) { observer.disconnect(); resolve(); }
        else setTimeout(check, Math.max(25, Math.min(100, quiet || 80)));
      };
      setTimeout(check, Math.max(25, Math.min(100, quiet || 80)));
    });
  };

  const capture = () => {
    const included = new Set();
    const excluded = new Set();
    const automaticallyIncluded = new Set();
    const excludedAttributes = new Map();
    const fields = new Map();
    const selectorMatches = [];
    for (const locator of locators) {
      const matches = select(locator);
      selectorMatches.push(locator.legacy
        ? { selector: locator.expr, matchCount: matches.length }
        : { type: locator.type, expr: locator.expr, op: locator.op, matchCount: matches.length });
      matches.forEach(({ element, attributeName }) => {
        if (locator.op === 'exclude' && attributeName) {
          const names = excludedAttributes.get(element) || new Set();
          names.add(attributeName);
          excludedAttributes.set(element, names);
          return;
        }
        (locator.op === 'include' ? included : excluded).add(element);
        if (locator.op === 'include') {
          // Locator processing is ordered. A later rule for the same element
          // intentionally replaces its extraction-field mode instead of
          // merging unrelated text/attribute values into one result.
          fields.set(element, locator.fields.map((field) => ({ ...field })));
        }
      });
    }
    if (includeInlineScripts) {
      document.querySelectorAll('script:not([src])').forEach((element) => automaticallyIncluded.add(element));
    }
    if (includeStyles) {
      document.querySelectorAll('style, link').forEach((element) => {
        if (element.tagName === 'STYLE' || (element.tagName === 'LINK' && /(^|\s)stylesheet(\s|$)/i.test(element.getAttribute('rel') || ''))) {
          automaticallyIncluded.add(element);
        }
      });
    }
    // A captured fragment still needs its document base to keep relative
    // resources and links meaningful when it is rendered later.
    document.querySelectorAll('base').forEach((element) => automaticallyIncluded.add(element));
    const rootCandidates = [...included, ...automaticallyIncluded];
    const roots = rootCandidates
      .filter((element) => !rootCandidates.some((candidate) => candidate !== element && containsAcrossShadow(candidate, element)))
      .sort(compare);
    // Empty structural roots (for example an opted-in external stylesheet)
    // belong in the filtered HTML/data representation, not as blank lines in
    // text-mode comparison. Match count still records that the root existed.
    const items = roots
      .map((root) => ({ text: writeText(root, included, excluded, automaticallyIncluded, fields) }))
      .filter((item) => item.text);
    const text = items.map((item) => item.text).filter(Boolean).join('\n\n');
    const html = makeHtml(included, excluded, automaticallyIncluded, excludedAttributes);
    return { roots, items, text, html, selectorMatches };
  };

  try {
    if (!includeLocators.length) return { ok: true, exists: false, matchCount: 0, items: [], html: '', data: '', selectorMatches: [] };
    await waitForStable();
    const configuredDelay = Math.max(0, Math.min(60_000, Number(captureOptions?.delayMilliseconds) || 0));
    if (configuredDelay) await new Promise((resolve) => setTimeout(resolve, configuredDelay));
    let result = capture();
    // HTML/data comparison still needs a nonempty selected text result to
    // distinguish a real page from a broken selection, but the reference
    // runner limits that mode to two delayed retries rather than waiting the
    // full text-monitor retry budget.
    const retryLimit = captureOptions?.dataAttr === 'data'
      ? Math.min(1, Math.max(0, Number(emptyRetryCount) || 0))
      : Math.max(0, Number(emptyRetryCount) || 0);
    for (let attempt = 0; !captureOptions?.allowEmpty && !result.text && attempt <= retryLimit; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(emptyRetryDelayMilliseconds) || 0)));
      result = capture();
    }
    const exists = captureOptions?.allowEmpty ? result.roots.length > 0 : Boolean(result.text);
    const errorHtml = exists
      ? ''
      : result.html || makeHtml(new Set([document.documentElement]), new Set(), new Set(), new Map());
    return {
      ok: true,
      exists,
      matchCount: result.roots.length,
      items: result.items,
      text: result.text,
      html: result.html,
      data: result.html,
      errorHtml,
      selectorMatches: result.selectorMatches
    };
  } catch (error) {
    return { ok: false, error: 'Selector capture could not be evaluated: ' + error.message };
  }
}

// Reference-compatible CSS monitor capture. All scheduled captures use this
// clone/filter/text pipeline rather than the old root-innerText collector.
async function captureLegacyRenderedDocumentCollection(
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

async function captureRenderedSnapshot(monitor, existingTabId = null) {
  // Pinned tabs are Chrome's favicon-only, leftmost tab UI. They make a
  // scheduled check visible without taking focus or leaving a titled tab in
  // the strip; a live watcher passes an already-open tab, which this function
  // deliberately leaves untouched after reusing the exact same capture path.
  const ownsTab = !Number.isInteger(existingTabId);
  const tab = ownsTab ? await chrome.tabs.create({
    url: monitor.url,
    active: false,
    pinned: true,
    index: 0
  }) : { id: existingTabId };
  if (!Number.isInteger(tab?.id)) {
    throw new Error('Could not create a background tab for checking.');
  }

  let ready;
  try {
    if (ownsTab) {
      ready = waitForRenderedTab(tab.id);
      await ready.promise;
    }
    let frames = [{ frameId: 0, parentFrameId: -1 }];
    if (monitor.locators.some((locator) => locator.frameId !== 0 || locator.framePath?.length)) {
      if (typeof chrome.webNavigation?.getAllFrames !== 'function') throw new Error('Subframe selector capture is unavailable.');
      frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
    }
    const frameById = new Map(frames.map((frame) => [frame.frameId, frame]));
    const frameGroups = new Map();
    for (const locator of monitor.locators) {
      const frameId = resolveLocatorFrame(locator, frames);
      if (!frameGroups.has(frameId)) frameGroups.set(frameId, []);
      frameGroups.get(frameId).push(locator);
    }
    const requestedFrameIds = [...frameGroups.keys()];
    for (const frameId of requestedFrameIds) {
      if (!frameById.has(frameId)) throw new Error(`The configured frame (${frameId}) is not available on this page.`);
    }
    const depthFor = (frame) => {
      let current = frame;
      let depth = 0;
      while (current?.parentFrameId >= 0) { depth += 1; current = frameById.get(current.parentFrameId); }
      return depth;
    };
    const captures = [];
    for (const frame of frames.filter((frame) => frameGroups.has(frame.frameId)).sort((left, right) => depthFor(right) - depthFor(left) || right.frameId - left.frameId)) {
      let execution;
      try {
        execution = await chrome.scripting.executeScript({
          target: frame.frameId === 0 ? { tabId: tab.id } : { tabId: tab.id, frameIds: [frame.frameId] },
          func: captureReferenceRenderedDocumentCollection,
          args: [frameGroups.get(frame.frameId), RENDER_MINIMUM_WAIT_MS, RENDER_QUIET_MS, RENDER_SETTLE_TIMEOUT_MS,
            RENDER_EMPTY_RETRY_COUNT, RENDER_EMPTY_RETRY_DELAY_MS, {
              allowEmpty: monitor.tracking?.allowEmpty === true,
              delayMilliseconds: monitor.tracking?.delayMilliseconds ?? 0,
              includeScript: monitor.tracking?.includeScript === true,
              includeStyle: monitor.tracking?.includeStyle === true,
              keepComments: monitor.tracking?.keepComments === true,
              dataAttr: monitor.tracking?.dataAttr === 'data' ? 'data' : 'text'
            }]
        });
      } catch (error) {
        throw new Error(`Could not inspect frame ${frame.frameId}: ${responseError(error)}`);
      }
      const frameResult = execution[0]?.result;
      if (!frameResult?.ok) throw new Error(frameResult?.error || `Could not inspect frame ${frame.frameId}.`);
      captures.push({ frameId: frame.frameId, result: frameResult });
    }
    const result = {
      ok: true,
      items: captures.flatMap(({ result }) => Array.isArray(result.items) ? result.items : []),
      selectorMatches: captures.flatMap(({ frameId, result }) => (result.selectorMatches || []).map((match) => ({ ...match, frameId })))
    };
    result.text = result.items.map((item) => item?.text).filter(Boolean).join('\n\n');
    // Raw <html> documents cannot be safely nested in an element.  A template
    // keeps each subframe's serialized document intact for the dashboard's
    // inert structural diff, while a single-frame snapshot remains compact.
    const frameMarkup = (frameId, html) => `<openstill-frame data-frame-id="${frameId}"><template data-openstill-frame-content="1">${html || ''}</template></openstill-frame>`;
    result.html = captures.length === 1
      ? captures[0].result.html || ''
      : captures.map(({ frameId, result: frameResult }) => frameMarkup(frameId, frameResult.html)).join('\n');
    result.data = result.html;
    const errorCaptures = captures.filter(({ result: frameResult }) => frameResult.errorHtml);
    result.errorHtml = errorCaptures.length === 1
      ? errorCaptures[0].result.errorHtml
      : errorCaptures.map(({ frameId, result: frameResult }) => frameMarkup(frameId, frameResult.errorHtml)).join('\n');
    result.matchCount = captures.reduce((total, { result: frameResult }) => (
      total + (Number.isInteger(frameResult.matchCount) ? frameResult.matchCount : Array.isArray(frameResult.items) ? frameResult.items.length : 0)
    ), 0);
    const filteredText = filterCapturedText(result.text, monitor.tracking);
    if (normalizeTracking(monitor.tracking).regexp) {
      // A regular-expression monitor observes the matched aggregate, not each
      // original DOM root.  Keep one ordered item so snapshot normalization
      // cannot reconstruct the unfiltered text from the old root list.
      result.items = [{ text: filteredText }];
    }
    result.text = filteredText;
    result.exists = monitor.tracking?.allowEmpty ? result.matchCount > 0 : Boolean(result.text);

    const snapshot = normalizeSnapshot({
      exists: Boolean(result.exists),
      matchCount: Number.isInteger(result.matchCount) ? result.matchCount : 0,
      items: result.items,
      text: Array.isArray(result.items) ? result.items.map((item) => item.text).join('\n\n') : '',
      html: result.html,
      data: result.data ?? result.html,
      evidenceHtml: result.errorHtml,
      capturedAt: nowIso()
    });
    if (!snapshot) {
      throw new Error('선택자 목록 결과를 정리하지 못했습니다.');
    }
    return snapshot;
  } finally {
    ready?.cancel();
    if (ownsTab) {
      await chrome.tabs.remove(tab.id).catch(async () => {
        // A browser can occasionally reject removal while a pinned tab is being
        // animated into the strip. Unpin and make one final best-effort removal.
        await chrome.tabs.update(tab.id, { pinned: false }).catch(() => undefined);
        await chrome.tabs.remove(tab.id).catch(() => undefined);
      });
    }
  }
}

// This function is deliberately self-contained because Chrome serializes it
// into the monitored page.  It observes only; the service worker always makes
// the actual typed-locator capture, so live and scheduled checks share one
// filtering, frame, retry, and comparison implementation.
function installLiveMutationObserver(monitorId, revision, debounceMilliseconds) {
  const registryKey = '__openStillLiveMutationObservers';
  const registry = globalThis[registryKey] || (globalThis[registryKey] = new Map());
  const existing = registry.get(monitorId);
  if (existing?.revision === revision) {
    return { ok: true, reused: true };
  }
  existing?.observer?.disconnect();
  if (existing?.timer) clearTimeout(existing.timer);

  const wait = Math.max(250, Math.min(30_000, Number(debounceMilliseconds) || 1_200));
  let timer = null;
  const notify = () => {
    timer = null;
    try {
      const sent = chrome.runtime.sendMessage({
        type: 'live-monitor-mutated',
        id: monitorId,
        revision,
        observedAt: Date.now()
      });
      sent?.catch?.(() => undefined);
    } catch {
      // A page can be unloading while the isolated world still has an observer.
    }
  };
  const observer = new MutationObserver(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(notify, wait);
  });
  const root = document.documentElement;
  if (!root) return { ok: false, error: 'The page has no document root.' };
  observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
  const record = { revision, observer, get timer() { return timer; } };
  registry.set(monitorId, record);
  addEventListener('pagehide', () => {
    if (registry.get(monitorId) !== record) return;
    observer.disconnect();
    if (timer) clearTimeout(timer);
    registry.delete(monitorId);
  }, { once: true });
  return { ok: true, reused: false };
}

function removeLiveMutationObserver(monitorId) {
  const registry = globalThis.__openStillLiveMutationObservers;
  const record = registry?.get(monitorId);
  record?.observer?.disconnect();
  if (record?.timer) clearTimeout(record.timer);
  registry?.delete(monitorId);
  return { ok: true };
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
    const enabled = monitors.filter((monitor) => monitor.enabled && isAutomaticSchedule(monitor));
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

function appendRunHistory(monitor, entry) {
  const prior = Array.isArray(monitor.runs) ? monitor.runs : [];
  monitor.runs = [{
    at: asIso(entry?.at, nowIso()),
    status: VALID_STATUSES.has(entry?.status) ? entry.status : 'error',
    code: cleanShortText(entry?.code, 80) || null,
    message: cleanShortText(entry?.message, 300) || null,
    changed: Boolean(entry?.changed),
    matchCount: Number.isInteger(entry?.matchCount) && entry.matchCount >= 0 ? entry.matchCount : null
  }, ...prior].slice(0, MAX_RUN_HISTORY);
}

async function setCheckFailure(id, expectedRevision, status, errorMessage) {
  const checkedAt = nowIso();
  await mutateMonitors((monitors) => {
    const monitor = monitors.find((item) => item.id === id);
    if (!monitor || !monitor.enabled || monitor.revision !== expectedRevision) {
      return null;
    }
    monitor.lastCheckedAt = checkedAt;
    monitor.nextCheckAt = isAutomaticSchedule(monitor) && monitor.snapshot
      ? new Date(Date.now() + ERROR_RETRY_MS).toISOString()
      : nextCheckForSchedule(monitor.scheduleMode, checkedAt, monitor.intervalHours);
    monitor.status = status;
    monitor.lastReviewAt = null;
    monitor.lastError = cleanText(errorMessage, 300);
    monitor.updatedAt = checkedAt;
    appendRunHistory(monitor, {
      at: checkedAt,
      status,
      code: status,
      message: monitor.lastError,
      changed: false
    });
    return monitor;
  });
}

function statusForStoredSnapshot(snapshot, tracking = null) {
  if (!snapshot) return 'needs-baseline';
  return snapshot.exists || normalizeTracking(tracking).allowEmpty ? 'ok' : 'needs-review';
}

function appendSnapshotHistory(monitor, snapshot, kind) {
  if (!snapshot) return;
  const entry = {
    snapshot,
    capturedAt: snapshot.capturedAt ?? nowIso(),
    kind: kind === 'baseline' ? 'baseline' : 'change'
  };
  const prior = Array.isArray(monitor.history) ? monitor.history : [];
  monitor.history = [entry, ...prior].slice(0, MAX_CHANGE_HISTORY);
}

function applySnapshotOutcome(monitor, nextSnapshot, checkedAt) {
  // A missing match is deliberately not a comparison result. A session can have
  // expired, the page can be behind a login wall, or a temporary error page can
  // be rendered. Keep the last successful snapshot so a later reappearance is
  // compared against real content instead of producing a false change.
  const tracking = normalizeTracking(monitor.tracking);
  if (!nextSnapshot.exists && !tracking.allowEmpty) {
    monitor.status = 'needs-review';
    monitor.lastReviewAt = checkedAt;
    monitor.lastError = ELEMENT_NOT_FOUND_MESSAGE;
    monitor.lastErrorSnapshot = nextSnapshot.evidenceHtml ? nextSnapshot : null;
    return { changed: false, needsReview: true };
  }

  const previous = monitor.snapshot;
  const changed = Boolean(previous) && !snapshotsEqual(previous, nextSnapshot, tracking);
  // The reference runner only persists a baseline on the first successful
  // capture or a real filtered-text change. An equal re-render must not churn
  // the saved HTML/text history merely because its capture timestamp changed.
  if (!previous || changed) {
    monitor.snapshot = nextSnapshot;
    appendSnapshotHistory(monitor, nextSnapshot, previous ? 'change' : 'baseline');
  }
  monitor.lastError = null;
  monitor.lastErrorSnapshot = null;
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
    if (!previous) {
      monitor.lastViewedAt = checkedAt;
      monitor.unread = false;
    }
    // An unread change remains actionable after a later successful re-check.
    monitor.status = monitor.unread ? 'changed' : statusForStoredSnapshot(monitor.snapshot, tracking);
  }

  return { changed, needsReview: false };
}

async function checkMonitorWithCapture(id, capture, { reschedule = true } = {}) {
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
      const captureTimeout = monitor.tracking?.timeoutMilliseconds ?? CHECK_EXECUTION_TIMEOUT_MS;
      nextSnapshot = await timeout(
        capture(monitor),
        captureTimeout + (monitor.tracking?.delayMilliseconds ?? 0),
        'The page capture exceeded its allowed time.'
      );
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
      current.nextCheckAt = nextCheckForSchedule(current.scheduleMode, checkedAt, current.intervalHours);
      current.updatedAt = checkedAt;
      const applied = applySnapshotOutcome(current, nextSnapshot, checkedAt);
      appendRunHistory(current, {
        at: checkedAt,
        status: applied.needsReview ? 'needs-review' : applied.changed ? 'changed' : 'ok',
        code: applied.needsReview ? 'selection-empty' : null,
        message: applied.needsReview ? current.lastError : null,
        changed: applied.changed,
        matchCount: nextSnapshot.matchCount
      });

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

async function checkMonitor(id, options = {}) {
  return checkMonitorWithCapture(id, (monitor) => captureRenderedSnapshot(monitor), options);
}

async function checkMonitorInOpenTab(id, tabId, options = {}) {
  return checkMonitorWithCapture(id, (monitor) => captureRenderedSnapshot(monitor, tabId), options);
}

function tabMatchesMonitor(tab, monitor) {
  return Number.isInteger(tab?.id) && normalizeUrl(tab.url) === monitor.url;
}

async function liveTabForMonitor(monitor, requestedTabId = null) {
  if (typeof chrome.tabs?.query !== 'function') {
    throw new Error('This browser cannot inspect open tabs for live monitoring.');
  }
  const tabs = await chrome.tabs.query({});
  const matching = tabs.filter((tab) => tabMatchesMonitor(tab, monitor));
  if (Number.isInteger(requestedTabId)) {
    const requested = matching.find((tab) => tab.id === requestedTabId);
    if (requested) return requested;
  }
  return matching.sort((left, right) => Number(Boolean(right.active)) - Number(Boolean(left.active)) || left.id - right.id)[0] ?? null;
}

async function startLiveMonitor(message) {
  const monitor = (await getMonitors()).find((item) => item.id === message?.id);
  if (!monitor) return { ok: false, error: '추적을 찾을 수 없습니다.' };
  if (!monitor.enabled) return { ok: false, error: '일시 정지된 추적입니다.' };
  if (!normalizeTracking(monitor.tracking).live) {
    return { ok: false, error: '먼저 추적 설정에서 실시간 감시를 켜 주세요.' };
  }
  if (!await hasSitePermission(monitor.url)) {
    return { ok: false, reason: 'permission', error: '이 사이트의 접근 권한이 필요합니다.' };
  }
  let tab;
  try {
    tab = await liveTabForMonitor(monitor, message?.tabId);
  } catch (error) {
    return { ok: false, error: responseError(error) };
  }
  if (!tab) {
    return { ok: false, error: '실시간으로 감시할 열린 페이지를 찾지 못했습니다. 먼저 해당 URL을 일반 탭으로 열어 주세요.' };
  }
  try {
    const installed = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: installLiveMutationObserver,
      args: [monitor.id, monitor.revision, normalizeTracking(monitor.tracking).liveDebounceMilliseconds]
    });
    const initial = await checkMonitorInOpenTab(monitor.id, tab.id, { reschedule: false });
    return {
      ok: true,
      tabId: tab.id,
      installedFrames: installed.length,
      initial
    };
  } catch (error) {
    return { ok: false, error: responseError(error) };
  }
}

async function stopLiveMonitor(message) {
  const monitor = (await getMonitors()).find((item) => item.id === message?.id);
  if (!monitor) return { ok: false, error: '추적을 찾을 수 없습니다.' };
  let tab;
  try {
    tab = await liveTabForMonitor(monitor, message?.tabId);
  } catch (error) {
    return { ok: false, error: responseError(error) };
  }
  if (!tab) return { ok: true, stopped: false };
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: removeLiveMutationObserver,
      args: [monitor.id]
    });
    return { ok: true, stopped: true, tabId: tab.id };
  } catch (error) {
    return { ok: false, error: responseError(error) };
  }
}

async function handleLiveMonitorMutation(message, sender) {
  const id = typeof message?.id === 'string' ? message.id : '';
  const tabId = sender?.tab?.id;
  if (!id || !Number.isInteger(tabId)) return { ok: false, ignored: true };
  const monitor = (await getMonitors()).find((item) => item.id === id);
  if (!monitor || !monitor.enabled || monitor.revision !== message?.revision || !normalizeTracking(monitor.tracking).live) {
    return { ok: false, ignored: true };
  }
  if (!tabMatchesMonitor(sender.tab, monitor)) return { ok: false, ignored: true };
  if (checksInProgress.has(id)) return { ok: true, pending: true };
  return checkMonitorInOpenTab(id, tabId, { reschedule: false });
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

function batchMonitorIds(value) {
  const ids = Array.isArray(value) ? value : [];
  const unique = [];
  const seen = new Set();
  for (const valueId of ids) {
    const id = typeof valueId === 'string' ? valueId.trim().slice(0, 100) : '';
    if (id && !seen.has(id)) {
      seen.add(id);
      unique.push(id);
      if (unique.length >= MAX_BATCH_CHECKS) break;
    }
  }
  return unique;
}

async function checkMonitors(message) {
  const requestedIds = batchMonitorIds(message?.ids);
  if (!requestedIds.length) {
    return { ok: false, error: '확인할 추적을 하나 이상 선택해 주세요.' };
  }

  const knownIds = new Set((await getMonitors()).map((monitor) => monitor.id));
  const ids = requestedIds.filter((id) => knownIds.has(id));
  if (!ids.length) {
    return { ok: false, error: '선택한 추적을 찾을 수 없습니다.' };
  }

  const outcomes = new Array(ids.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < ids.length) {
      const index = cursor;
      cursor += 1;
      const id = ids[index];
      try {
        outcomes[index] = await checkMonitor(id, { reschedule: false });
      } catch (error) {
        outcomes[index] = { ok: false, error: responseError(error) };
      }
    }
  };

  try {
    await Promise.all(Array.from(
      { length: Math.min(MAX_CONCURRENT_BATCH_CHECKS, ids.length) },
      () => worker()
    ));
  } finally {
    await scheduleNextAlarm().catch((error) => console.warn('OpenStill could not reschedule checks.', error));
  }

  const completed = outcomes.filter((outcome) => outcome?.ok).length;
  const changed = outcomes.filter((outcome) => outcome?.ok && outcome.changed).length;
  const needsReview = outcomes.filter((outcome) => outcome?.ok && outcome.needsReview).length;
  const failed = outcomes.filter((outcome) => !outcome?.ok).length;
  return {
    ok: true,
    requested: requestedIds.length,
    found: ids.length,
    completed,
    changed,
    needsReview,
    failed,
    missing: requestedIds.length - ids.length
  };
}

async function runDueChecks() {
  if (sweepRunning) {
    return;
  }

  sweepRunning = true;
  try {
    const now = Date.now();
    const due = (await getMonitors())
      .filter((monitor) => monitor.enabled && isAutomaticSchedule(monitor) && dueTimestamp(monitor) <= now)
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

function locatorsEqual(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((locator, index) => locatorKey(locator) === locatorKey(right[index]));
}

function trackingEqual(left, right) {
  return JSON.stringify(normalizeTracking(left)) === JSON.stringify(normalizeTracking(right));
}

function pickerItemsFromMessage(message, defaultFrameId = 0) {
  const rawItems = Array.isArray(message.items)
    ? message.items
    : Array.isArray(message.locators)
      ? message.locators
    : Array.isArray(message.selectors)
      ? message.selectors.map((selector) => ({ selector }))
      : [{ selector: message.selector }];

  if (!rawItems.length || rawItems.length > MAX_SELECTORS_PER_MONITOR) {
    return null;
  }

  const items = [];
  const seenLocators = new Set();
  for (const rawItem of rawItems) {
    const locator = cleanLocator(rawItem, { frameId: defaultFrameId });
    if (!locator) return null;
    const key = locatorKey(locator);
    if (seenLocators.has(key)) continue;
    seenLocators.add(key);
    items.push(locator);
  }
  return items.some((item) => item.op === 'include') ? items : null;
}

async function validateLocatorList(locators) {
  for (const locator of locators) {
    await validateSelectorSyntax(locator.expr, locator.type);
  }
}

async function createMonitors(message, sender) {
  const url = normalizeUrl(sender?.tab?.url ?? message.url);
  const scheduleMode = normalizeScheduleMode(message.scheduleMode, SCHEDULE_MODE_MANUAL);
  const intervalHours = clampInterval(message.intervalHours)
    ?? (scheduleMode === SCHEDULE_MODE_MANUAL ? MIN_INTERVAL_HOURS : null);
  const trackingInput = message.tracking ?? message;
  const pickerItems = pickerItemsFromMessage(
    message,
    Number.isInteger(sender?.frameId) ? sender.frameId : 0
  );
  if (!url || !scheduleMode || !intervalHours || !pickerItems) {
    return { ok: false, error: 'URL, 확인 방식과 간격, 그리고 하나 이상의 CSS 선택자를 확인해 주세요.' };
  }
  if (hasInvalidConfiguredRegularExpression(trackingInput)) {
    return { ok: false, error: '변경 내용을 거를 정규식 또는 플래그가 올바르지 않습니다.' };
  }

  try {
    await validateLocatorList(pickerItems);
  } catch (error) {
    return { ok: false, error: responseError(error) };
  }
  if (pickerItems.some((locator) => locator.frameId !== 0) && Number.isInteger(sender?.tab?.id)) {
    if (typeof chrome.webNavigation?.getAllFrames !== 'function') {
      return { ok: false, error: 'This browser cannot save subframe selections.' };
    }
    let frames;
    try {
      frames = await chrome.webNavigation.getAllFrames({ tabId: sender.tab.id });
    } catch (error) {
      return { ok: false, error: `Could not identify the selected frame: ${responseError(error)}` };
    }
    for (const locator of pickerItems) {
      const framePath = framePathForFrame(locator.frameId, frames);
      if (framePath === null) {
        return { ok: false, error: `The selected frame (${locator.frameId}) cannot be stably identified.` };
      }
      locator.framePath = framePath;
    }
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
      const knownLocators = new Set(existing.locators.map(locatorKey));
      const additions = pickerItems.filter((item) => !knownLocators.has(locatorKey(item)));
      if (additions.length) {
        if (existing.locators.length + additions.length > MAX_SELECTORS_PER_MONITOR) {
          return { ok: false, error: `한 주소에는 CSS 선택자를 최대 ${MAX_SELECTORS_PER_MONITOR}개까지 저장할 수 있습니다.` };
        }
        existing.locators = [...existing.locators, ...additions];
        existing.selectors = displaySelectorsForLocators(existing.locators);
        existing.revision = createRevision();
        existing.updatedAt = timestamp;
        // A picker session only knows the elements selected in that session,
        // not the DOM order of the already-saved selectors.  Do not append its
        // text to an old collection snapshot: that would manufacture a change
        // on the next rendered check.  An automatic tracker checks immediately;
        // a manual tracker waits for the user's explicit "check now" action.
        existing.snapshot = null;
        existing.lastChange = null;
        existing.history = [];
        existing.runs = [];
        existing.lastCheckedAt = null;
        existing.lastChangedAt = null;
        existing.lastReviewAt = null;
        existing.lastViewedAt = null;
        existing.lastError = null;
        existing.lastErrorSnapshot = null;
        existing.unread = false;
        existing.status = 'needs-baseline';
        existing.nextCheckAt = isAutomaticSchedule(existing) ? timestamp : null;
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
      locators: pickerItems,
      selectors: displaySelectorsForLocators(pickerItems),
      tracking: normalizeTracking(trackingInput),
      labels,
      scheduleMode,
      intervalHours,
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastCheckedAt: null,
      lastChangedAt: null,
      // A manual tracker has no due time. Its first baseline is established
      // only by an explicit user check.
      nextCheckAt: nextCheckForSchedule(scheduleMode, null, intervalHours, timestamp),
      snapshot: null,
      lastChange: null,
      history: [],
      runs: [],
      lastReviewAt: null,
      lastViewedAt: null,
      lastError: null,
      lastErrorSnapshot: null,
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
  const locators = cleanLocators(
    Object.hasOwn(message, 'locators')
      ? message.locators
      : Object.hasOwn(message, 'selectors')
        ? message.selectors
        : message.selector
  );
  if (!message.id || !url || !locators) {
    return { ok: false, error: 'URL과 CSS 선택자를 확인해 주세요.' };
  }
  const trackingInput = message.tracking ?? null;
  if (trackingInput && hasInvalidConfiguredRegularExpression(trackingInput)) {
    return { ok: false, error: '변경 내용을 거를 정규식 또는 플래그가 올바르지 않습니다.' };
  }

  const existing = (await getMonitors()).find((item) => item.id === message.id);
  if (!existing) {
    return { ok: false, error: '추적을 찾을 수 없습니다.' };
  }
  const scheduleMode = normalizeScheduleMode(message.scheduleMode, existing.scheduleMode);
  const intervalHours = clampInterval(message.intervalHours)
    ?? (scheduleMode === SCHEDULE_MODE_MANUAL ? existing.intervalHours ?? MIN_INTERVAL_HOURS : null);
  if (!scheduleMode || !intervalHours) {
    return { ok: false, error: '확인 방식과 간격을 확인해 주세요.' };
  }

  try {
    await validateLocatorList(locators);
  } catch (error) {
    return { ok: false, error: responseError(error) };
  }

  const previousUrl = existing.url;
  const previousTracking = normalizeTracking(existing.tracking);
  const permissionGranted = await hasSitePermission(url);
  const result = await mutateMonitors((monitors) => {
    const monitor = monitors.find((item) => item.id === message.id);
    if (!monitor) {
      return { ok: false, error: '추적을 찾을 수 없습니다.' };
    }
    if (monitors.some((item) => item.id !== monitor.id && item.url === url)) {
      return { ok: false, error: '이 주소는 이미 다른 추적으로 관리되고 있습니다.' };
    }

    const selectionChanged = monitor.url !== url || !locatorsEqual(monitor.locators, locators);
    const nextTracking = normalizeTracking(trackingInput ?? monitor.tracking);
    const trackingChanged = !trackingEqual(monitor.tracking, nextTracking);
    const captureConfigurationChanged = selectionChanged || trackingChanged;
    const scheduleChanged = monitor.scheduleMode !== scheduleMode;
    monitor.name = cleanText(message.name, 120) || monitor.name;
    monitor.revision = createRevision();
    monitor.url = url;
    monitor.locators = [...locators];
    monitor.selectors = displaySelectorsForLocators(locators);
    monitor.tracking = nextTracking;
    monitor.labels = cleanLabels(message.labels);
    monitor.scheduleMode = scheduleMode;
    monitor.intervalHours = intervalHours;
    const requestedEnabled = message.enabled !== false;
    monitor.enabled = requestedEnabled && permissionGranted;
    monitor.updatedAt = nowIso();
    monitor.nextCheckAt = scheduleMode === SCHEDULE_MODE_INTERVAL
      ? (captureConfigurationChanged || scheduleChanged
        ? monitor.updatedAt
        : addHours(monitor.lastCheckedAt ?? monitor.updatedAt, intervalHours))
      : null;

    if (captureConfigurationChanged) {
      monitor.snapshot = null;
      monitor.lastChange = null;
      monitor.history = [];
      monitor.runs = [];
      monitor.lastChangedAt = null;
      monitor.lastReviewAt = null;
      monitor.lastViewedAt = null;
      monitor.lastCheckedAt = null;
      monitor.unread = false;
      monitor.status = monitor.enabled ? 'needs-baseline' : requestedEnabled ? 'permission-needed' : 'needs-baseline';
      monitor.lastError = null;
      monitor.lastErrorSnapshot = null;
    } else if (requestedEnabled && !permissionGranted) {
      monitor.status = 'permission-needed';
      monitor.lastError = '이 사이트의 접근 권한이 필요합니다.';
    } else if (!requestedEnabled && monitor.status === 'permission-needed') {
      monitor.status = statusForStoredSnapshot(monitor.snapshot, monitor.tracking);
      monitor.lastError = null;
    }

    return { ok: true, monitor: { ...monitor }, permissionGranted };
  });

  if (result?.ok) {
    const updatedTracking = normalizeTracking(result.monitor?.tracking);
    const liveConfigurationChanged = existing.url !== url
      || !locatorsEqual(existing.locators, result.monitor?.locators)
      || !trackingEqual(previousTracking, updatedTracking);
    if (previousTracking.live && !updatedTracking.live) {
      await stopLiveMonitor({ id: existing.id }).catch(() => undefined);
    } else if (updatedTracking.live && liveConfigurationChanged) {
      // A saved selector or tracking edit creates a new revision. Reinstall on
      // any matching open page so an older isolated-world observer cannot keep
      // sending ignored revision messages forever.
      await startLiveMonitor({ id: existing.id }).catch(() => undefined);
    }
  }
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
  if (!enabled && normalizeTracking(monitor.tracking).live) {
    await stopLiveMonitor({ id: monitor.id }).catch(() => undefined);
  }

  await mutateMonitors((monitors) => {
    const current = monitors.find((item) => item.id === message.id);
    if (!current) {
      return;
    }
    current.enabled = enabled;
    current.revision = createRevision();
    current.updatedAt = nowIso();
    current.nextCheckAt = isAutomaticSchedule(current) && enabled ? nowIso() : null;
    if (enabled && current.status === 'permission-needed') {
      current.status = statusForStoredSnapshot(current.snapshot, current.tracking);
      current.lastError = null;
    } else if (!enabled && current.status === 'permission-needed') {
      current.status = statusForStoredSnapshot(current.snapshot, current.tracking);
      current.lastError = null;
    }
  });
  await scheduleNextAlarm();
  return { ok: true };
}

async function deleteMonitor(id) {
  const existing = (await getMonitors()).find((item) => item.id === id);
  if (existing && normalizeTracking(existing.tracking).live) {
    await stopLiveMonitor({ id: existing.id }).catch(() => undefined);
  }
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
    locators: monitor.locators.map((locator) => ({
      ...locator,
      framePath: locator.framePath.map((part) => ({ ...part })),
      fields: locator.fields.map((field) => ({ ...field }))
    })),
    selectors: [...monitor.selectors],
    ...(copy ? { createdAt: timestamp } : {}),
    updatedAt: timestamp,
    lastCheckedAt: null,
    lastChangedAt: null,
    nextCheckAt: nextCheckForSchedule(monitor.scheduleMode, null, monitor.intervalHours, timestamp),
    snapshot: null,
    lastChange: null,
    history: [],
    runs: [],
    lastReviewAt: null,
    lastViewedAt: null,
    lastError: null,
    lastErrorSnapshot: null,
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

function planSiteHostReplacement(monitors, sourceHost, targetHost) {
  const replacements = [];
  const targetUrls = new Set();

  for (const monitor of monitors) {
    if (siteHostOfUrl(monitor.url) !== sourceHost) {
      continue;
    }

    const targetUrl = replaceUrlHost(monitor.url, sourceHost, targetHost);
    if (!targetUrl) {
      return { ok: false, error: '일괄 변경할 주소를 준비하지 못했습니다.' };
    }
    if (targetUrls.has(targetUrl)) {
      return { ok: false, error: '변경 결과가 같은 주소로 겹쳐 일괄 변경을 취소했습니다.' };
    }
    targetUrls.add(targetUrl);
    replacements.push({ id: monitor.id, sourceUrl: monitor.url, targetUrl, enabled: monitor.enabled });
  }

  if (!replacements.length) {
    return { ok: false, error: '기존 사이트 주소에 해당하는 추적을 찾지 못했습니다.' };
  }

  const movingIds = new Set(replacements.map((replacement) => replacement.id));
  const collisions = monitors.filter((monitor) => !movingIds.has(monitor.id) && targetUrls.has(monitor.url));
  if (collisions.length) {
    return {
      ok: false,
      error: `새 사이트에 이미 추적 중인 ${collisions.length}개 페이지가 있어 안전하게 일괄 변경을 취소했습니다. 먼저 중복 페이지를 정리한 뒤 다시 시도해 주세요.`
    };
  }

  return { ok: true, replacements };
}

async function replaceSiteHost(message) {
  const sourceHost = normalizeSiteHost(message?.sourceHost);
  const targetHost = normalizeSiteHost(message?.targetHost);
  if (!sourceHost || !targetHost) {
    return { ok: false, error: '기존 및 새 사이트 주소에는 도메인(필요하면 포트)만 입력해 주세요.' };
  }
  if (sourceHost === targetHost) {
    return { ok: false, error: '새 사이트 주소가 기존 주소와 같습니다.' };
  }

  const before = await getMonitors();
  const planned = planSiteHostReplacement(before, sourceHost, targetHost);
  if (!planned.ok) {
    return planned;
  }

  const enabledTargetUrls = [...new Set(planned.replacements
    .filter((replacement) => replacement.enabled)
    .map((replacement) => replacement.targetUrl))];
  for (const targetUrl of enabledTargetUrls) {
    if (!await hasSitePermission(targetUrl)) {
      return { ok: false, reason: 'permission', error: '새 사이트의 접근 권한이 필요합니다.' };
    }
  }

  const timestamp = nowIso();
  const result = await mutateMonitors((monitors) => {
    // Recreate the plan inside the serialized mutation. A concurrent edit must
    // not turn a safe preview into a partial host migration.
    const currentPlan = planSiteHostReplacement(monitors, sourceHost, targetHost);
    if (!currentPlan.ok) {
      return currentPlan;
    }

    const replacementsById = new Map(currentPlan.replacements.map((replacement) => [replacement.id, replacement]));
    for (let index = 0; index < monitors.length; index += 1) {
      const replacement = replacementsById.get(monitors[index].id);
      if (replacement) {
        monitors[index] = resetMonitorForPageUrl(monitors[index], replacement.targetUrl, timestamp);
      }
    }
    return {
      ok: true,
      count: currentPlan.replacements.length,
      sourceUrls: currentPlan.replacements.map((replacement) => replacement.sourceUrl)
    };
  });

  if (!result?.ok) {
    return result;
  }

  await Promise.all([...new Set(result.sourceUrls)].map((sourceUrl) => releaseUnusedSitePermission(sourceUrl)));
  await refreshBadge();
  await scheduleNextAlarm();
  return { ok: true, count: result.count };
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
  const viewedAt = nowIso();
  await mutateMonitors((monitors) => {
    const monitor = monitors.find((item) => item.id === id);
    if (!monitor) {
      return;
    }
    monitor.unread = false;
    monitor.lastViewedAt = viewedAt;
    if (monitor.status === 'changed') {
      monitor.status = statusForStoredSnapshot(monitor.snapshot, monitor.tracking);
    }
    monitor.updatedAt = viewedAt;
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
    if (!raw || (!Array.isArray(raw.locators) && !Array.isArray(raw.selectors))) {
      rejected += 1;
      continue;
    }

    const monitor = normalizeMonitor(raw);
    if (!monitor || preparedUrls.has(monitor.url)) {
      rejected += 1;
      continue;
    }
    try {
      await validateLocatorList(monitor.locators);
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
      monitor.status = statusForStoredSnapshot(monitor.snapshot, monitor.tracking);
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
        selectors: [...preparedMonitor.selectors],
        locators: preparedMonitor.locators.map((locator) => ({
          ...locator,
          framePath: locator.framePath.map((part) => ({ ...part })),
          fields: locator.fields.map((field) => ({ ...field }))
        }))
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
    // picker.js reads getBoundingClientRect() to position its highlights. Wait
    // until the document has finished loading, then keep the requested 2.5 s
    // settling window before asking it for any element coordinates.
    await waitForPageLoadAndPickerDelay(tabId);
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
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
  'start-live-monitor': (message) => startLiveMonitor(message),
  'stop-live-monitor': (message) => stopLiveMonitor(message),
  'live-monitor-mutated': (message, sender) => handleLiveMonitorMutation(message, sender),
  'check-monitors': (message) => checkMonitors(message),
  'check-page': (message) => checkPage(message.url),
  'move-page-url': (message) => reusePageUrl(message),
  'copy-page-url': (message) => reusePageUrl(message, { copy: true }),
  'replace-site-host': (message) => replaceSiteHost(message),
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
  await migrateLegacyScheduleModes();
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
