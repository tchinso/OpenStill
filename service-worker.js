'use strict';

const MONITORS_KEY = 'openStill.monitors.v1';
const SETTINGS_KEY = 'openStill.settings.v1';
const PENDING_PICKERS_KEY = 'openStill.pending-pickers.v1';
const ALARM_NAME = 'openStill.next-check';

const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 14 * 24;
// Two bounded snapshots per monitor (current + last changed-from value) stay within
// chrome.storage.local's default 10 MB quota without requesting unlimitedStorage.
const MAX_MONITORS = 100;
const MAX_BATCH_ITEMS = 20;
const MAX_SNAPSHOT_CHARS = 10_000;
const PARSE_TIMEOUT_MS = 12_000;
const SOUND_DEBOUNCE_MS = 3_000;
const MAX_CHECKS_PER_SWEEP = 6;
const PENDING_PICKER_TTL_MS = 2 * 60 * 60 * 1000;
const RENDER_LOAD_TIMEOUT_MS = 30_000;
const RENDER_MINIMUM_WAIT_MS = 2_000;
const RENDER_QUIET_MS = 650;
const RENDER_SETTLE_TIMEOUT_MS = 5_000;

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

function normalizeSnapshot(value) {
  if (!value || typeof value !== 'object' || typeof value.exists !== 'boolean') {
    return null;
  }

  const matchCount = typeof value.matchCount === 'number'
    ? value.matchCount
    : typeof value.matchCount === 'string' && /^\d+$/.test(value.matchCount.trim())
      ? Number(value.matchCount)
      : Number.NaN;
  return {
    exists: value.exists,
    matchCount: Number.isInteger(matchCount) && matchCount >= 0 ? matchCount : value.exists ? 1 : 0,
    text: cleanSnapshotText(value.text),
    capturedAt: asIso(value.capturedAt, null)
  };
}

function snapshotsEqual(left, right) {
  return Boolean(left && right)
    && left.exists === right.exists
    && left.matchCount === right.matchCount
    && left.text === right.text;
}

function normalizeMonitor(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const url = normalizeUrl(value.url);
  const selector = cleanSelector(value.selector);
  const intervalHours = clampInterval(value.intervalHours);
  if (!url || !selector || !intervalHours) {
    return null;
  }
  const createdAt = asIso(value.createdAt, nowIso());
  const lastCheckedAt = asIso(value.lastCheckedAt, null);
  const calculatedNextCheck = lastCheckedAt ? addHours(lastCheckedAt, intervalHours) : nowIso();
  const requestedNextCheck = asIso(value.nextCheckAt, null);
  // Older development builds called this state "missing". It now deliberately
  // means "needs review": a logged-out page must not be reported as a content change.
  const requestedStatus = value.status === 'missing' ? 'needs-review' : value.status;
  const status = VALID_STATUSES.has(requestedStatus) ? requestedStatus : 'ok';
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
  // Stable fallback keeps early/hand-written exports working until their next edit.
  const revision = typeof value.revision === 'string' && value.revision.length <= 100
    ? value.revision
    : `legacy:${id}:${asIso(value.updatedAt, createdAt)}`;

  return {
    id,
    revision,
    name: cleanText(value.name, 120) || cleanText(value.pageTitle, 120) || new URL(url).hostname,
    url,
    pageTitle: cleanText(value.pageTitle, 180),
    selector,
    labels: cleanLabels(value.labels),
    selectionSetId: typeof value.selectionSetId === 'string' && value.selectionSetId.length <= 100 ? value.selectionSetId : null,
    selectionOrder: Number.isInteger(value.selectionOrder) && value.selectionOrder >= 0 ? value.selectionOrder : null,
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

async function inspectRenderedDocument(selector, minimumWaitMilliseconds, quietMilliseconds, settleTimeoutMilliseconds) {
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
    const matches = document.querySelectorAll(selector);
    const first = matches[0];
    return {
      ok: true,
      exists: Boolean(first),
      matchCount: matches.length,
      text: first ? String(first.innerText || first.textContent || '').slice(0, 10_000) : ''
    };
  } catch (error) {
    return { ok: false, error: 'CSS 선택자를 해석할 수 없습니다: ' + error.message };
  }
}

async function captureRenderedSnapshot(monitor) {
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  if (!Number.isInteger(tab?.id)) {
    throw new Error('검사용 백그라운드 탭을 만들지 못했습니다.');
  }

  let ready;
  try {
    ready = waitForRenderedTab(tab.id);
    await chrome.tabs.update(tab.id, { url: monitor.url, active: false });
    await ready.promise;
    const execution = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: inspectRenderedDocument,
      args: [monitor.selector, RENDER_MINIMUM_WAIT_MS, RENDER_QUIET_MS, RENDER_SETTLE_TIMEOUT_MS]
    });
    const result = execution[0]?.result;
    if (!result?.ok) {
      throw new Error(result?.error || '렌더링된 페이지에서 선택자를 확인하지 못했습니다.');
    }
    const snapshot = {
      exists: Boolean(result.exists),
      matchCount: Number.isInteger(result.matchCount) ? result.matchCount : 0,
      text: cleanSnapshotText(result.text),
      capturedAt: nowIso()
    };
    if (snapshot.matchCount > 1) {
      throw new Error('CSS 선택자가 현재 ' + snapshot.matchCount + '개 요소와 일치합니다. 하나만 일치하도록 선택자를 수정해 주세요.');
    }
    return snapshot;
  } finally {
    ready?.cancel();
    await chrome.tabs.remove(tab.id).catch(() => undefined);
  }
}

async function inspectRenderedDocumentBatch(selectors, minimumWaitMilliseconds, quietMilliseconds, settleTimeoutMilliseconds) {
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

  const snapshots = selectorList.map((selector) => {
    try {
      const matches = document.querySelectorAll(selector);
      const first = matches[0];
      return {
        ok: true,
        exists: Boolean(first),
        matchCount: matches.length,
        text: first ? String(first.innerText || first.textContent || '').slice(0, 10_000) : ''
      };
    } catch (error) {
      return { ok: false, error: 'CSS 선택자를 해석할 수 없습니다: ' + error.message };
    }
  });
  return { ok: true, snapshots };
}

async function captureRenderedSnapshots(monitors) {
  if (!Array.isArray(monitors) || !monitors.length) {
    return new Map();
  }
  const url = monitors[0].url;
  if (!monitors.every((monitor) => monitor.url === url)) {
    throw new Error('하나의 선택 묶음에는 같은 페이지의 요소만 포함할 수 있습니다.');
  }

  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  if (!Number.isInteger(tab?.id)) {
    throw new Error('검사용 백그라운드 탭을 만들지 못했습니다.');
  }

  let ready;
  try {
    ready = waitForRenderedTab(tab.id);
    await chrome.tabs.update(tab.id, { url, active: false });
    await ready.promise;
    const execution = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: inspectRenderedDocumentBatch,
      args: [monitors.map((monitor) => monitor.selector), RENDER_MINIMUM_WAIT_MS, RENDER_QUIET_MS, RENDER_SETTLE_TIMEOUT_MS]
    });
    const result = execution[0]?.result;
    if (!result?.ok || !Array.isArray(result.snapshots) || result.snapshots.length !== monitors.length) {
      throw new Error('렌더링된 페이지를 확인하지 못했습니다.');
    }

    const capturedAt = nowIso();
    const outcomes = new Map();
    monitors.forEach((monitor, index) => {
      const rendered = result.snapshots[index];
      if (!rendered?.ok) {
        outcomes.set(monitor.id, { error: cleanText(rendered?.error || 'CSS 선택자를 해석할 수 없습니다.', 300) });
        return;
      }
      const snapshot = {
        exists: Boolean(rendered.exists),
        matchCount: Number.isInteger(rendered.matchCount) ? rendered.matchCount : 0,
        text: cleanSnapshotText(rendered.text),
        capturedAt
      };
      if (snapshot.matchCount > 1) {
        outcomes.set(monitor.id, { error: 'CSS 선택자가 현재 ' + snapshot.matchCount + '개의 요소와 일치합니다.' });
      } else {
        outcomes.set(monitor.id, { snapshot });
      }
    });
    return outcomes;
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

function outcomesWithError(monitors, status, error) {
  return new Map(monitors.map((monitor) => [monitor.id, { status, error }]));
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
  monitor.snapshot = nextSnapshot;
  monitor.lastError = null;
  monitor.lastReviewAt = null;

  if (changed) {
    monitor.lastChangedAt = checkedAt;
    monitor.lastChange = {
      previous,
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

async function commitCheckOutcomes(candidates, outcomes) {
  const checkedAt = nowIso();
  return mutateMonitors((monitors) => {
    const currentById = new Map(monitors.map((monitor) => [monitor.id, monitor]));
    const valid = candidates.every((candidate) => {
      const current = currentById.get(candidate.id);
      return current && current.enabled && current.revision === candidate.revision;
    });
    if (!valid) {
      return { ok: false, reason: 'outdated', changedMonitors: [], needsReviewMonitors: [] };
    }

    const changedMonitors = [];
    const needsReviewMonitors = [];
    for (const candidate of candidates) {
      const current = currentById.get(candidate.id);
      const outcome = outcomes.get(candidate.id);
      current.lastCheckedAt = checkedAt;
      current.nextCheckAt = addHours(checkedAt, current.intervalHours);
      current.updatedAt = checkedAt;

      if (!outcome?.snapshot) {
        current.status = outcome?.status === 'permission-needed' ? 'permission-needed' : 'error';
        current.lastReviewAt = null;
        current.lastError = cleanText(outcome?.error || '페이지를 확인하지 못했습니다.', 300);
        continue;
      }

      const applied = applySnapshotOutcome(current, outcome.snapshot, checkedAt);
      if (applied.changed) {
        changedMonitors.push({ ...current });
      } else if (applied.needsReview) {
        needsReviewMonitors.push({ ...current });
      }
    }

    return { ok: true, changedMonitors, needsReviewMonitors };
  });
}

async function checkSelectionSet(candidates, { reschedule = true } = {}) {
  const monitors = [...new Map(candidates
    .filter((monitor) => monitor?.enabled)
    .map((monitor) => [monitor.id, monitor])).values()];
  if (!monitors.length) {
    return { ok: false, reason: 'disabled' };
  }
  if (monitors.some((monitor) => checksInProgress.has(monitor.id))) {
    return { ok: false, reason: 'checking' };
  }

  monitors.forEach((monitor) => checksInProgress.add(monitor.id));
  try {
    let outcomes;
    if (!monitors.every((monitor) => monitor.url === monitors[0].url)) {
      outcomes = outcomesWithError(monitors, 'error', '하나의 선택 묶음에는 같은 페이지의 요소만 포함할 수 있습니다.');
    } else if (!await hasSitePermission(monitors[0].url)) {
      outcomes = outcomesWithError(monitors, 'permission-needed', '사이트 접근 권한이 필요합니다.');
    } else {
      try {
        outcomes = await captureRenderedSnapshots(monitors);
      } catch (error) {
        outcomes = outcomesWithError(monitors, 'error', responseError(error));
      }
    }

    const result = await commitCheckOutcomes(monitors, outcomes);
    if (result.ok) {
      await Promise.all(result.changedMonitors.map((monitor) => announceChange(monitor)));
      await refreshBadge();
    }
    return result;
  } catch (error) {
    return { ok: false, error: responseError(error) };
  } finally {
    monitors.forEach((monitor) => checksInProgress.delete(monitor.id));
    if (reschedule) {
      await scheduleNextAlarm().catch((error) => console.warn('OpenStill could not reschedule checks.', error));
    }
  }
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

function chunkMonitors(monitors, size = MAX_BATCH_ITEMS) {
  const batches = [];
  for (let index = 0; index < monitors.length; index += size) {
    batches.push(monitors.slice(index, index + size));
  }
  return batches;
}

async function checkPage(urlValue) {
  const url = normalizeUrl(urlValue);
  if (!url) {
    return { ok: false, error: '확인할 페이지 주소가 올바르지 않습니다.' };
  }

  const monitors = (await getMonitors()).filter((monitor) => monitor.enabled && monitor.url === url);
  if (!monitors.length) {
    return { ok: false, reason: 'disabled', error: '이 페이지에서 활성화된 추적을 찾을 수 없습니다.' };
  }

  try {
    const results = await Promise.all(chunkMonitors(monitors)
      .map((batch) => checkSelectionSet(batch, { reschedule: false })));
    const completed = results.filter((result) => result?.ok);
    const firstFailure = results.find((result) => !result?.ok);
    const changed = completed.some((result) => result.changedMonitors?.length);
    const needsReview = completed.some((result) => result.needsReviewMonitors?.length);
    return firstFailure && !completed.length
      ? firstFailure
      : { ok: true, changed, needsReview, checked: completed.length };
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
    const allMonitors = await getMonitors();
    const due = allMonitors
      .filter((monitor) => monitor.enabled && dueTimestamp(monitor) <= now)
      .sort((left, right) => dueTimestamp(left) - dueTimestamp(right));
    const scheduledIds = new Set();
    const batches = [];

    for (const monitor of due) {
      if (scheduledIds.has(monitor.id)) {
        continue;
      }
      // A page is the unit we render and manage. Check every due page selector
      // together even when it was created in a different picker session.
      const samePageMonitors = allMonitors.filter((candidate) => candidate.enabled && candidate.url === monitor.url);
      const pageBatches = chunkMonitors(samePageMonitors);
      pageBatches.forEach((batch) => {
        if (batches.length < MAX_CHECKS_PER_SWEEP && batch.some((candidate) => !scheduledIds.has(candidate.id))) {
          batch.forEach((candidate) => scheduledIds.add(candidate.id));
          batches.push(batch);
        }
      });
      if (batches.length >= MAX_CHECKS_PER_SWEEP) {
        break;
      }
    }

    await Promise.allSettled(batches.map((batch) => checkSelectionSet(batch, { reschedule: false })));
  } finally {
    sweepRunning = false;
    await scheduleNextAlarm();
  }
}

async function createMonitors(message, sender) {
  const url = normalizeUrl(message.url);
  const intervalHours = clampInterval(message.intervalHours);
  const rawItems = Array.isArray(message.items)
    ? message.items
    : [{ selector: message.selector, text: message.text, matchCount: message.matchCount, name: message.name }];
  if (!url || !intervalHours || !rawItems.length || rawItems.length > MAX_BATCH_ITEMS) {
    return { ok: false, error: `URL, 1시간~14일 간격, 그리고 1~${MAX_BATCH_ITEMS}개의 선택 요소를 확인해 주세요.` };
  }

  const items = [];
  const seenSelectors = new Set();
  for (const rawItem of rawItems) {
    const selector = cleanSelector(rawItem?.selector);
    if (!selector || Number(rawItem?.matchCount) !== 1) {
      return { ok: false, error: '각 CSS 선택자는 정확히 하나의 요소와 일치해야 합니다.' };
    }
    if (seenSelectors.has(selector)) {
      return { ok: false, error: '같은 CSS 선택자를 두 번 저장할 수 없습니다.' };
    }
    try {
      await validateSelectorSyntax(selector);
    } catch (error) {
      return { ok: false, error: responseError(error) };
    }
    seenSelectors.add(selector);
    items.push({
      selector,
      text: cleanSnapshotText(rawItem.text),
      name: cleanText(rawItem.name, 120)
    });
  }
  if (!await hasSitePermission(url)) {
    return { ok: false, error: '저장하기 전에 이 사이트의 접근 권한을 허용해 주세요.' };
  }

  const createdAt = nowIso();
  const pageTitle = cleanText(message.pageTitle, 180);
  const baseName = cleanText(message.name, 120) || pageTitle || new URL(url).hostname;
  const labels = cleanLabels(message.labels);
  const selectionSetId = items.length > 1 ? createId() : null;
  const monitorsToCreate = items.map((item, index) => ({
    id: createId(),
    revision: createRevision(),
    name: item.name || (items.length > 1 ? `${baseName} · ${index + 1}` : baseName),
    url,
    pageTitle,
    selector: item.selector,
    labels,
    selectionSetId,
    selectionOrder: selectionSetId ? index : null,
    intervalHours,
    enabled: true,
    createdAt,
    updatedAt: createdAt,
    lastCheckedAt: createdAt,
    lastChangedAt: null,
    nextCheckAt: addHours(createdAt, intervalHours),
    snapshot: normalizeSnapshot({
      exists: true,
      matchCount: 1,
      text: item.text,
      capturedAt: createdAt
    }),
    lastChange: null,
    lastReviewAt: null,
    lastError: null,
    status: 'ok',
    unread: false
  }));

  await mutateMonitors((monitors) => {
    if (monitors.length + monitorsToCreate.length > MAX_MONITORS) {
      throw new Error(`모니터는 최대 ${MAX_MONITORS}개까지 저장할 수 있습니다.`);
    }
    monitors.push(...monitorsToCreate);
    return monitorsToCreate;
  });
  await forgetPendingPicker(sender?.tab?.id);
  await scheduleNextAlarm();
  return { ok: true, monitors: monitorsToCreate, count: monitorsToCreate.length };
}

async function createMonitor(message, sender) {
  const response = await createMonitors({
    ...message,
    items: [{
      selector: message.selector,
      text: message.text,
      matchCount: message.matchCount,
      name: message.name
    }]
  }, sender);
  return response.ok ? { ok: true, monitor: response.monitors[0] } : response;
}

async function saveMonitor(message) {
  const url = normalizeUrl(message.url);
  const selector = cleanSelector(message.selector);
  const intervalHours = clampInterval(message.intervalHours);
  if (!message.id || !url || !selector || !intervalHours) {
    return { ok: false, error: 'URL, CSS 선택자, 1시간~14일의 간격을 확인해 주세요.' };
  }

  try {
    await validateSelectorSyntax(selector);
  } catch (error) {
    return { ok: false, error: responseError(error) };
  }

  const existing = (await getMonitors()).find((item) => item.id === message.id);
  const previousUrl = existing?.url;
  const permissionGranted = await hasSitePermission(url);
  const result = await mutateMonitors((monitors) => {
    const monitor = monitors.find((item) => item.id === message.id);
    if (!monitor) {
      return { ok: false, error: '모니터를 찾을 수 없습니다.' };
    }

    const selectionChanged = monitor.url !== url || monitor.selector !== selector;
    monitor.name = cleanText(message.name, 120) || monitor.name;
    monitor.revision = createRevision();
    monitor.url = url;
    monitor.selector = selector;
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
  if (previousUrl) {
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
  const reset = {
    ...monitor,
    id: copy ? createId() : monitor.id,
    revision: createRevision(),
    url,
    // Page grouping is derived from URL, so old one-off picker batches no longer
    // have any behavioural meaning after an address is reused.
    selectionSetId: null,
    selectionOrder: null,
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
  return reset;
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

  const sourceMonitors = (await getMonitors()).filter((monitor) => monitor.url === sourceUrl);
  if (!sourceMonitors.length) {
    return { ok: false, error: '주소를 재사용할 추적 페이지를 찾을 수 없습니다.' };
  }
  if (copy && sourceMonitors.length + (await getMonitors()).length > MAX_MONITORS) {
    return { ok: false, error: `복제하면 모니터 최대 ${MAX_MONITORS}개 제한을 넘습니다.` };
  }

  const hasEnabledMonitor = sourceMonitors.some((monitor) => monitor.enabled);
  if (hasEnabledMonitor && !await hasSitePermission(targetUrl)) {
    return { ok: false, reason: 'permission', error: '새 사이트의 접근 권한이 필요합니다.' };
  }

  const timestamp = nowIso();
  let affected = [];
  const result = await mutateMonitors((monitors) => {
    const sourceIds = new Set(sourceMonitors.map((monitor) => monitor.id));
    if (copy) {
      const clones = monitors
        .filter((monitor) => sourceIds.has(monitor.id))
        .map((monitor) => resetMonitorForPageUrl(monitor, targetUrl, timestamp, { copy: true }));
      if (monitors.length + clones.length > MAX_MONITORS) {
        return { ok: false, error: `복제하면 모니터 최대 ${MAX_MONITORS}개 제한을 넘습니다.` };
      }
      monitors.push(...clones);
      affected = clones;
    } else {
      affected = monitors
        .filter((monitor) => sourceIds.has(monitor.id))
        .map((monitor) => resetMonitorForPageUrl(monitor, targetUrl, timestamp));
      const replacementById = new Map(affected.map((monitor) => [monitor.id, monitor]));
      monitors.forEach((monitor, index) => {
        if (replacementById.has(monitor.id)) {
          monitors[index] = replacementById.get(monitor.id);
        }
      });
    }
    return { ok: true, monitors: affected, count: affected.length };
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

  let deletedCount = 0;
  await mutateMonitors((monitors) => {
    for (let index = monitors.length - 1; index >= 0; index -= 1) {
      if (monitors[index].url === url) {
        monitors.splice(index, 1);
        deletedCount += 1;
      }
    }
  });
  if (!deletedCount) return { ok: false, error: '삭제할 추적 페이지를 찾을 수 없습니다.' };

  await releaseUnusedSitePermission(url);
  await refreshBadge();
  await scheduleNextAlarm();
  return { ok: true, deletedCount };
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
  let rejected = Math.max(0, sourceMonitors.length - MAX_MONITORS);
  let imported = 0;
  let disabledForPermission = 0;
  const usedIds = new Set();

  for (const raw of rawMonitors) {
    const monitor = normalizeMonitor(raw);
    if (!monitor) {
      rejected += 1;
      continue;
    }
    if (usedIds.has(monitor.id)) {
      monitor.id = createId();
    }
    usedIds.add(monitor.id);

    try {
      await validateSelectorSyntax(monitor.selector);
    } catch {
      rejected += 1;
      continue;
    }
    if (monitor.enabled && !await hasSitePermission(monitor.url)) {
      monitor.enabled = false;
      monitor.status = 'permission-needed';
      monitor.lastError = '가져온 뒤 이 사이트의 접근 권한을 허용해 주세요.';
      disabledForPermission += 1;
    } else if (!monitor.enabled && monitor.status === 'permission-needed') {
      monitor.status = statusForStoredSnapshot(monitor.snapshot);
      monitor.lastError = null;
    }
    monitor.revision = createRevision();
    prepared.push(monitor);
  }

  const result = await mutateMonitors((monitors) => {
    if (message.mode === 'replace') {
      monitors.splice(0, monitors.length);
    }

    for (const monitor of prepared) {
      const index = monitors.findIndex((item) => item.id === monitor.id);
      if (index >= 0) {
        monitors[index] = monitor;
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
    await chrome.scripting.executeScript({ target: { tabId }, files: ['picker.js'] });
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
