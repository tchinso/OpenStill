(() => {
  const backupIntegrity = globalThis.OpenStillBackupIntegrity;
  if (!backupIntegrity) throw new Error('백업 무결성 모듈을 불러오지 못했습니다.');
  const MIN_HOURS = 1;
  const MAX_HOURS = 14 * 24;
  // Keep a small buffer below the requested 32 MiB split point. It leaves
  // room for the runtime-message envelope while every generated JSON part is
  // valid JSON and remains strictly below 32 MiB.
  const EXPORT_FILE_SPLIT_BYTES = 32 * 1024 * 1024;
  const EXPORT_FILE_HEADROOM_BYTES = 64 * 1024;
  const EXPORT_INTEGRITY_METADATA_RESERVE_BYTES = 1_024;
  const MAX_EXPORT_FILE_BYTES = EXPORT_FILE_SPLIT_BYTES - EXPORT_FILE_HEADROOM_BYTES;
  const MAX_IMPORT_MESSAGE_BYTES = MAX_EXPORT_FILE_BYTES;
  const IMPORT_RECORD_FRAGMENT_CHARS = 3 * 1024 * 1024;
  const BULK_TRANSFER_THRESHOLD = 200;
  const BULK_TRANSFER_CHUNK_SIZE = 100;
  const TRANSFER_YIELD_BYTE_BUDGET = 4 * 1024 * 1024;
  const DASHBOARD_RENDER_CHUNK_SIZE = 50;
  const SELECTED_CHECK_CHUNK_SIZE = 6;
  const MONITOR_PREVIEW_MAX_CHARS = 800;
  const SEARCH_RENDER_DEBOUNCE_MS = 150;
  const dateTimeFormatter = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
  const state = { monitors: [], settings: { soundEnabled: true } };
  const filters = { label: '', status: 'all', query: '' };
  const sorting = { field: 'lastViewedAt', direction: 'desc' };
  const SORT_FIELDS = new Set(['lastViewedAt', 'lastCheckedAt', 'lastChangedAt', 'name']);
  const SORT_DIRECTIONS = new Set(['asc', 'desc']);
  const SORT_PREFERENCE_KEY = 'openstill-dashboard-sort';
  const selectedMonitorIds = new Set();
  let toastTimer;
  let transferProgressTimer;
  let searchRenderTimer = null;
  let batchActionRunning = false;
  let transferRunning = false;
  let dashboardLoading = false;
  let monitorRenderGeneration = 0;
  let activeHistoryEntries = [];
  let activeHistoryUrl = '';
  const exportDownloadUrls = new Map();
  const importRecordByteLengths = new WeakMap();
  let refreshQueued = false;
  let refreshPending = false;
  let refreshQueueTimer = null;

  const elements = {
    soundEnabled: document.querySelector('#soundEnabled'),
    batchUrlButton: document.querySelector('#batchUrlButton'),
    exportButton: document.querySelector('#exportButton'),
    importButton: document.querySelector('#importButton'),
    importInput: document.querySelector('#importInput'),
    transferProgress: document.querySelector('#transferProgress'),
    transferProgressLabel: document.querySelector('#transferProgressLabel'),
    transferProgressBar: document.querySelector('#transferProgressBar'),
    transferProgressValue: document.querySelector('#transferProgressValue'),
    searchInput: document.querySelector('#searchInput'),
    statusFilter: document.querySelector('#statusFilter'),
    sortField: document.querySelector('#sortField'),
    sortDirection: document.querySelector('#sortDirection'),
    selectVisible: document.querySelector('#selectVisible'),
    selectedCount: document.querySelector('#selectedCount'),
    checkSelected: document.querySelector('#checkSelected'),
    invertSelection: document.querySelector('#invertSelection'),
    clearSelection: document.querySelector('#clearSelection'),
    addLabelSelected: document.querySelector('#addLabelSelected'),
    removeLabelSelected: document.querySelector('#removeLabelSelected'),
    deleteSelected: document.querySelector('#deleteSelected'),
    bulkStatus: document.querySelector('#bulkStatus'),
    labelList: document.querySelector('#labelList'),
    labelCount: document.querySelector('#labelCount'),
    listTitle: document.querySelector('#listTitle'),
    listDescription: document.querySelector('#listDescription'),
    visibleCount: document.querySelector('#visibleCount'),
    monitorList: document.querySelector('#monitorList'),
    summaryTotal: document.querySelector('#summaryTotal'),
    summaryActive: document.querySelector('#summaryActive'),
    summaryChanged: document.querySelector('#summaryChanged'),
    summaryAttention: document.querySelector('#summaryAttention'),
    editorDialog: document.querySelector('#editorDialog'),
    editorForm: document.querySelector('#editorForm'),
    editId: document.querySelector('#editId'),
    editName: document.querySelector('#editName'),
    editUrl: document.querySelector('#editUrl'),
    editSelectors: document.querySelector('#editSelectors'),
    editCompareMode: document.querySelector('#editCompareMode'),
    editDelaySeconds: document.querySelector('#editDelaySeconds'),
    editTimeoutSeconds: document.querySelector('#editTimeoutSeconds'),
    editRegexp: document.querySelector('#editRegexp'),
    editRegexpFlags: document.querySelector('#editRegexpFlags'),
    editIgnoreWhitespace: document.querySelector('#editIgnoreWhitespace'),
    editAllowEmpty: document.querySelector('#editAllowEmpty'),
    editIncludeStyle: document.querySelector('#editIncludeStyle'),
    editIncludeScript: document.querySelector('#editIncludeScript'),
    editKeepComments: document.querySelector('#editKeepComments'),
    editLive: document.querySelector('#editLive'),
    editLabels: document.querySelector('#editLabels'),
    editScheduleMode: document.querySelector('#editScheduleMode'),
    editIntervalInputs: document.querySelector('#editIntervalInputs'),
    editDays: document.querySelector('#editDays'),
    editHours: document.querySelector('#editHours'),
    editEnabled: document.querySelector('#editEnabled'),
    editIntervalHelp: document.querySelector('#editIntervalHelp'),
    editorMessage: document.querySelector('#editorMessage'),
    pageUrlDialog: document.querySelector('#pageUrlDialog'),
    pageUrlForm: document.querySelector('#pageUrlForm'),
    pageUrlTitle: document.querySelector('#pageUrlTitle'),
    pageUrlSource: document.querySelector('#pageUrlSource'),
    pageUrlDescription: document.querySelector('#pageUrlDescription'),
    pageUrlInput: document.querySelector('#pageUrlInput'),
    pageUrlMessage: document.querySelector('#pageUrlMessage'),
    pageUrlSave: document.querySelector('#pageUrlSave'),
    batchUrlDialog: document.querySelector('#batchUrlDialog'),
    batchUrlForm: document.querySelector('#batchUrlForm'),
    batchUrlSource: document.querySelector('#batchUrlSource'),
    batchUrlTarget: document.querySelector('#batchUrlTarget'),
    batchUrlPreview: document.querySelector('#batchUrlPreview'),
    batchUrlMessage: document.querySelector('#batchUrlMessage'),
    batchUrlSave: document.querySelector('#batchUrlSave'),
    changeDialog: document.querySelector('#changeDialog'),
    changeTitle: document.querySelector('#changeTitle'),
    changeWhen: document.querySelector('#changeWhen'),
    previousSnapshot: document.querySelector('#previousSnapshot'),
    currentSnapshot: document.querySelector('#currentSnapshot'),
    changeOpenPage: document.querySelector('#changeOpenPage'),
    changeOpenPageTab: document.querySelector('#changeOpenPageTab'),
    acknowledgeButton: document.querySelector('#acknowledgeButton'),
    historyDialog: document.querySelector('#historyDialog'),
    historyTitle: document.querySelector('#historyTitle'),
    historyDescription: document.querySelector('#historyDescription'),
    historyEntries: document.querySelector('#historyEntries'),
    historyRuns: document.querySelector('#historyRuns'),
    historyWhen: document.querySelector('#historyWhen'),
    historyPreviousSnapshot: document.querySelector('#historyPreviousSnapshot'),
    historyCurrentSnapshot: document.querySelector('#historyCurrentSnapshot'),
    toast: document.querySelector('#toast')
  };

  try {
    const savedSorting = JSON.parse(localStorage.getItem(SORT_PREFERENCE_KEY) || 'null');
    if (SORT_FIELDS.has(savedSorting?.field)) sorting.field = savedSorting.field;
    if (SORT_DIRECTIONS.has(savedSorting?.direction)) sorting.direction = savedSorting.direction;
  } catch {
    // A corrupt or unavailable preference must never prevent the dashboard from loading.
  }
  elements.sortField.value = sorting.field;
  elements.sortDirection.value = sorting.direction;

  function installAdvancedScheduleControls() {
    const mode = elements.editScheduleMode;
    if (!mode) return;
    for (const [value, label] of [['random', '무작위 간격'], ['cron', 'CRON'], ['live', '실시간']]) {
      if (![...mode.options].some((option) => option.value === value)) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        mode.append(option);
      }
    }
    const makeNumber = (id, label, value, minimum = 5, maximum = 2_592_000) => {
      const wrapper = document.createElement('label');
      const caption = document.createElement('span');
      caption.textContent = label;
      const input = document.createElement('input');
      input.id = id;
      input.type = 'number';
      input.min = String(minimum);
      input.max = String(maximum);
      input.step = '1';
      input.inputMode = 'numeric';
      input.value = String(value);
      wrapper.append(caption, input);
      return { wrapper, input };
    };
    const precise = makeNumber('editIntervalSeconds', '정확한 간격(초)', 3_600);
    elements.editIntervalInputs.append(precise.wrapper);
    elements.editIntervalSeconds = precise.input;

    const fieldset = mode.closest('fieldset');
    const random = document.createElement('div');
    random.id = 'editRandomInputs';
    random.className = 'interval-inputs';
    random.hidden = true;
    const randomMin = makeNumber('editRandomMinSeconds', '최소(초)', 3_600);
    const randomMax = makeNumber('editRandomMaxSeconds', '최대(초)', 7_200);
    random.append(randomMin.wrapper, randomMax.wrapper);
    elements.editRandomInputs = random;
    elements.editRandomMinSeconds = randomMin.input;
    elements.editRandomMaxSeconds = randomMax.input;

    const cron = document.createElement('div');
    cron.id = 'editCronInputs';
    cron.className = 'interval-inputs';
    cron.hidden = true;
    const expressionLabel = document.createElement('label');
    const expressionCaption = document.createElement('span');
    expressionCaption.textContent = '식 (분 시 일 월 요일)';
    const expression = document.createElement('input');
    expression.id = 'editCronExpression';
    expression.maxLength = 160;
    expression.placeholder = '0 3 * * *';
    expressionLabel.append(expressionCaption, expression);
    const timezoneLabel = document.createElement('label');
    const timezoneCaption = document.createElement('span');
    timezoneCaption.textContent = '시간대 (선택)';
    const timezone = document.createElement('input');
    timezone.id = 'editCronTimezone';
    timezone.maxLength = 80;
    timezone.placeholder = 'Asia/Seoul';
    timezoneLabel.append(timezoneCaption, timezone);
    cron.append(expressionLabel, timezoneLabel);
    elements.editCronInputs = cron;
    elements.editCronExpression = expression;
    elements.editCronTimezone = timezone;
    fieldset.insertBefore(random, elements.editIntervalHelp);
    fieldset.insertBefore(cron, elements.editIntervalHelp);
  }

  function send(message) {
    return chrome.runtime.sendMessage(message);
  }

  function element(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // CSS line clamping only limits what is painted; keeping a large snapshot in
  // every card still makes dashboard construction and updates expensive.
  function monitorPreviewText(value) {
    const text = String(value ?? '');
    return text.length > MONITOR_PREVIEW_MAX_CHARS
      ? `${text.slice(0, MONITOR_PREVIEW_MAX_CHARS - 1)}…`
      : text;
  }

  function locatorsOf(monitor) {
    if (Array.isArray(monitor?.locators)) {
      return monitor.locators
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
          type: ['css', 'xcss', 'xpath'].includes(item.type) ? item.type : 'css',
          expr: String(item.expr ?? item.selector ?? item.value ?? '').trim(),
          op: item.op === 'exclude' ? 'exclude' : 'include',
          frameId: Number.isInteger(item.frameId) ? item.frameId : 0,
          framePath: Array.isArray(item.framePath) ? item.framePath : [],
          ...(Number.isInteger(item.frameOrder) ? { frameOrder: item.frameOrder } : {}),
          fields: Array.isArray(item.fields) ? item.fields : [{ type: 'text' }],
          ...(item.fieldsSpecified === true ? { fieldsSpecified: true } : {})
        }))
        .filter((item) => item.expr);
    }
    const selectors = Array.isArray(monitor?.selectors) ? monitor.selectors : [];
    return selectors
      .map((item) => typeof item === 'string' ? item : item?.selector ?? item?.css)
      .map((expr) => String(expr ?? '').trim())
      .filter(Boolean)
      .map((expr) => ({ type: 'css', expr, op: 'include', frameId: 0, framePath: [], fields: [{ type: 'text' }] }));
  }

  function selectorsOf(monitor) {
    return locatorsOf(monitor).map((locator) => locator.expr);
  }

  function locatorLine(locator) {
    const basic = locator.type === 'css'
      && locator.op === 'include'
      && locator.frameId === 0
      && !locator.framePath?.length
      && locator.fieldsSpecified !== true
      && (!locator.fields?.length || locator.fields.every((field) => field?.type === 'text'));
    return basic ? locator.expr : JSON.stringify(locator);
  }

  function parseLocatorLine(line) {
    const source = String(line ?? '').trim();
    if (!source) return null;
    if (source.startsWith('{')) {
      try {
        const value = JSON.parse(source);
        return value && typeof value === 'object' ? value : null;
      } catch {
        return null;
      }
    }
    const prefixed = source.match(/^(?:(exclude)\s+)?(css|xcss|xpath)\s*:\s*(.+)$/i);
    if (prefixed) {
      return { type: prefixed[2].toLowerCase(), expr: prefixed[3].trim(), op: prefixed[1] ? 'exclude' : 'include' };
    }
    return { type: 'css', expr: source, op: 'include' };
  }

  function selectorPreview(monitor) {
    const selectors = selectorsOf(monitor);
    if (!selectors.length) return 'CSS 선택자가 없습니다.';
    const first = selectors[0];
    return selectors.length === 1 ? first : `${selectors.length}개 선택자 · ${first}`;
  }

  function snapshotItems(snapshot) {
    if (Array.isArray(snapshot?.items) && snapshot.items.length) {
      return snapshot.items
        .map((item) => typeof item === 'string' ? item : item?.text)
        .map((text) => String(text ?? '').trim())
        .filter(Boolean);
    }
    const text = String(snapshot?.text ?? '').trim();
    return text ? text.split('\n').filter(Boolean) : [];
  }

  function formatDuration(hours) {
    const numeric = Number(hours);
    const days = Math.floor(numeric / 24);
    const rest = numeric % 24;
    return `${days ? `${days}일` : ''}${days && rest ? ' ' : ''}${rest ? `${rest}시간` : ''}` || '0시간';
  }

  function scheduleModeOf(monitor) {
    return monitor?.scheduleMode === 'interval' ? 'interval' : 'manual';
  }

  function formatSchedule(monitor) {
    return scheduleModeOf(monitor) === 'manual' ? '수동' : formatDuration(monitor.intervalHours);
  }

  // Expanded schedule descriptors are intentionally decoded in the dashboard
  // rather than flattened to the legacy intervalHours field.
  function scheduleModeOf(monitor) {
    const type = String(monitor?.schedule?.type ?? monitor?.scheduleMode ?? 'manual').toLowerCase();
    return ['manual', 'interval', 'random', 'cron', 'live'].includes(type) ? type : 'manual';
  }

  function formatSeconds(seconds) {
    const value = Math.max(0, Math.round(Number(seconds) || 0));
    const days = Math.floor(value / 86_400);
    const hours = Math.floor((value % 86_400) / 3_600);
    const minutes = Math.floor((value % 3_600) / 60);
    const rest = value % 60;
    return [
      days ? `${days}일` : '',
      hours ? `${hours}시간` : '',
      minutes ? `${minutes}분` : '',
      rest || !value ? `${rest}초` : ''
    ].filter(Boolean).join(' ');
  }

  function formatSchedule(monitor) {
    const type = scheduleModeOf(monitor);
    const params = monitor?.schedule?.params ?? {};
    if (type === 'manual') return '수동';
    if (type === 'live') return '실시간';
    if (type === 'random') return `무작위 ${formatSeconds(params.min)}–${formatSeconds(params.max)}`;
    if (type === 'cron') return `CRON ${params.expr || ''}`.trim();
    return formatSeconds(params.interval ?? monitor?.intervalSeconds ?? Number(monitor?.intervalHours || 0) * 3_600);
  }

  function formatDate(iso) {
    const timestamp = Date.parse(iso ?? '');
    if (!Number.isFinite(timestamp)) return '아직 없음';
    return dateTimeFormatter.format(timestamp);
  }

  function hostname(url) {
    try { return new URL(url).hostname; } catch { return url; }
  }

  function originOf(url) {
    try { return new URL(url).origin; } catch { return url; }
  }

  function siteHostFromInput(value) {
    const raw = String(value ?? '').trim();
    if (!raw || raw.length > 255) return null;
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

  function monitorCountForSiteHost(siteHost) {
    return state.monitors.filter((monitor) => {
      try { return new URL(monitor.url).host.toLowerCase() === siteHost; } catch { return false; }
    }).length;
  }

  function pagePath(url) {
    try {
      const parsed = new URL(url);
      // Fragments are part of a monitor's page identity for hash-routed apps.
      return `${parsed.pathname === '/' ? '홈' : parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return url;
    }
  }

  function sitePattern(url) {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('HTTP 또는 HTTPS 주소만 사용할 수 있습니다.');
    return `${parsed.protocol}//${parsed.host}/*`;
  }

  async function requestSitePermission(url) {
    try {
      // HTTP/HTTPS access is now granted at installation time so a bulk import
      // can begin without hundreds of origin-by-origin permission prompts.
      // Retain URL validation at this UI boundary.
      sitePattern(url);
      return true;
    } catch (error) {
      showToast(error.message || 'HTTP 또는 HTTPS 주소를 확인해 주세요.');
      return false;
    }
  }

  function statusInfo(monitor) {
    if (!monitor.enabled) {
      return monitor.status === 'permission-needed'
        ? { key: 'permission-needed', label: '권한 필요' }
        : { key: 'paused', label: '일시정지' };
    }
    if (monitor.status === 'needs-review') return { key: 'needs-review', label: '확인 필요' };
    if (monitor.unread || monitor.status === 'changed') return { key: 'changed', label: '변경 감지' };
    const labels = {
      ok: ['ok', '정상'],
      error: ['error', '오류'],
      'permission-needed': ['permission-needed', '권한 필요'],
      'needs-baseline': ['needs-baseline', '기준값 필요']
    };
    const [key, label] = labels[monitor.status] ?? labels.ok;
    return { key, label };
  }

  function needsAttention(monitor) {
    if (!monitor.enabled && monitor.status !== 'permission-needed') return false;
    return ['needs-review', 'error', 'permission-needed'].includes(monitor.status);
  }

  function compareMonitors(left, right) {
    const direction = sorting.direction === 'asc' ? 1 : -1;
    let compared = 0;
    if (sorting.field === 'name') {
      compared = String(left.name ?? '').localeCompare(String(right.name ?? ''), 'ko-KR', {
        numeric: true,
        sensitivity: 'base'
      });
    } else {
      const leftTimestamp = Date.parse(left[sorting.field] ?? '');
      const rightTimestamp = Date.parse(right[sorting.field] ?? '');
      const leftExists = Number.isFinite(leftTimestamp);
      const rightExists = Number.isFinite(rightTimestamp);
      // "아직 없음" records remain at the bottom in both directions so that
      // choosing ascending order does not bury real activity below empty data.
      if (leftExists !== rightExists) return leftExists ? -1 : 1;
      if (leftExists) compared = leftTimestamp - rightTimestamp;
    }
    if (compared) return compared * direction;
    const byName = String(left.name ?? '').localeCompare(String(right.name ?? ''), 'ko-KR', {
      numeric: true,
      sensitivity: 'base'
    });
    if (byName) return byName;
    return String(left.id ?? '').localeCompare(String(right.id ?? ''));
  }

  function monitorMatchesFilters(monitor) {
    if (filters.label && !(monitor.labels ?? []).some((label) => label.toLocaleLowerCase('ko-KR') === filters.label)) return false;
    if (filters.status === 'changed' && !monitor.unread) return false;
    if (filters.status === 'active' && !monitor.enabled) return false;
    if (filters.status === 'attention' && !needsAttention(monitor)) return false;
    if (filters.status === 'paused' && monitor.enabled) return false;
    const query = filters.query.trim().toLocaleLowerCase('ko-KR');
    if (!query) return true;
    const haystack = [monitor.name, monitor.url, ...selectorsOf(monitor), ...(monitor.labels ?? [])]
      .join(' ')
      .toLocaleLowerCase('ko-KR');
    return haystack.includes(query);
  }

  function groupMonitorsBySite(monitors) {
    const sites = new Map();
    for (const monitor of monitors) {
      const origin = originOf(monitor.url);
      let site = sites.get(origin);
      if (!site) {
        site = { origin, host: hostname(monitor.url), allMonitors: [], pagesByUrl: new Map() };
        sites.set(origin, site);
      }
      site.allMonitors.push(monitor);
      let page = site.pagesByUrl.get(monitor.url);
      if (!page) {
        page = { url: monitor.url, monitors: [] };
        site.pagesByUrl.set(monitor.url, page);
      }
      page.monitors.push(monitor);
    }

    return [...sites.values()].map((site) => ({
      ...site,
      pages: [...site.pagesByUrl.values()]
    }));
  }

  function getFilteredSiteGroups() {
    return groupMonitorsBySite(state.monitors)
      .map((site) => {
        const pages = site.pages
          .map((page) => {
            const visibleMonitors = page.monitors.filter(monitorMatchesFilters).sort(compareMonitors);
            return {
              ...page,
              visibleMonitors,
              sortMonitor: visibleMonitors[0] ?? null
            };
          })
          .filter((page) => page.visibleMonitors.length)
          .sort((left, right) => (
            compareMonitors(left.sortMonitor, right.sortMonitor)
            || left.url.localeCompare(right.url)
          ));
        return {
          ...site,
          pages,
          sortMonitor: pages[0]?.sortMonitor ?? null
        };
      })
      .filter((site) => site.pages.length)
      .sort((left, right) => (
        compareMonitors(left.sortMonitor, right.sortMonitor)
        || left.origin.localeCompare(right.origin)
      ));
  }

  function visibleMonitorIds(sites = getFilteredSiteGroups()) {
    return sites.flatMap((site) => site.pages.flatMap((page) => (
      page.visibleMonitors.map((monitor) => monitor.id)
    )));
  }

  function pruneSelectedMonitorIds() {
    const knownIds = new Set(state.monitors.map((monitor) => monitor.id));
    for (const id of selectedMonitorIds) {
      if (!knownIds.has(id)) selectedMonitorIds.delete(id);
    }
  }

  function renderSelectionControls(sites = getFilteredSiteGroups()) {
    pruneSelectedMonitorIds();
    const visibleIds = visibleMonitorIds(sites);
    const selectedVisible = visibleIds.filter((id) => selectedMonitorIds.has(id)).length;
    const selectedCount = selectedMonitorIds.size;
    elements.selectedCount.textContent = `${selectedCount}개 선택`;
    elements.selectVisible.checked = Boolean(visibleIds.length) && selectedVisible === visibleIds.length;
    elements.selectVisible.indeterminate = selectedVisible > 0 && selectedVisible < visibleIds.length;
    elements.selectVisible.disabled = batchActionRunning || !visibleIds.length;
    elements.checkSelected.disabled = batchActionRunning || !selectedCount;
    elements.invertSelection.disabled = batchActionRunning || !visibleIds.length;
    elements.clearSelection.disabled = batchActionRunning || !selectedCount;
    elements.addLabelSelected.disabled = batchActionRunning || !selectedCount;
    elements.removeLabelSelected.disabled = batchActionRunning || !selectedCount;
    elements.deleteSelected.disabled = batchActionRunning || !selectedCount;
  }

  function setVisibleSelection(selected) {
    const ids = visibleMonitorIds();
    ids.forEach((id) => {
      if (selected) selectedMonitorIds.add(id);
      else selectedMonitorIds.delete(id);
    });
    void renderMonitorList();
  }

  function invertVisibleSelection() {
    if (batchActionRunning) return;
    visibleMonitorIds().forEach((id) => {
      if (selectedMonitorIds.has(id)) selectedMonitorIds.delete(id);
      else selectedMonitorIds.add(id);
    });
    void renderMonitorList();
  }

  function renderOverview() {
    elements.summaryTotal.textContent = String(state.monitors.length);
    elements.summaryActive.textContent = String(state.monitors.filter((monitor) => monitor.enabled).length);
    elements.summaryChanged.textContent = String(state.monitors.filter((monitor) => monitor.unread).length);
    elements.summaryAttention.textContent = String(state.monitors.filter(needsAttention).length);
    elements.soundEnabled.checked = state.settings.soundEnabled !== false;
  }

  function labelCollection() {
    const labels = new Map();
    for (const monitor of state.monitors) {
      for (const label of monitor.labels ?? []) {
        const key = label.toLocaleLowerCase('ko-KR');
        const entry = labels.get(key) ?? { label, count: 0 };
        entry.count += 1;
        labels.set(key, entry);
      }
    }
    return [...labels.entries()].sort((left, right) => left[1].label.localeCompare(right[1].label, 'ko-KR'));
  }

  function renderLabels() {
    const labels = labelCollection();
    elements.labelCount.textContent = `${labels.length}개`;
    elements.labelList.replaceChildren();

    const allButton = element('button', `label-button${filters.label ? '' : ' active'}`);
    allButton.type = 'button';
    allButton.dataset.label = '';
    allButton.append(element('span', 'label-dot'), element('span', '', '전체'), element('small', '', String(state.monitors.length)));
    elements.labelList.append(allButton);

    for (const [key, entry] of labels) {
      const button = element('button', `label-button${filters.label === key ? ' active' : ''}`);
      button.type = 'button';
      button.dataset.label = key;
      button.append(element('span', 'label-dot'), element('span', '', entry.label), element('small', '', String(entry.count)));
      elements.labelList.append(button);
    }
  }

  function makeAction(label, action, id, className = '') {
    const button = element('button', className, label);
    button.type = 'button';
    button.dataset.action = action;
    button.dataset.id = id;
    return button;
  }

  function makePageAction(label, action, url, className = '') {
    const button = element('button', className, label);
    button.type = 'button';
    button.dataset.action = action;
    button.dataset.url = url;
    return button;
  }

  function monitorCard(monitor) {
    const selected = selectedMonitorIds.has(monitor.id);
    const card = element('article', `tracking-card${monitor.unread ? ' unread' : ''}${needsAttention(monitor) ? ' needs-attention' : ''}${selected ? ' selected' : ''}`);
    const top = element('div', 'tracking-top');
    const selectLabel = element('label', 'monitor-select');
    const selectInput = document.createElement('input');
    selectInput.type = 'checkbox';
    selectInput.dataset.selectMonitor = monitor.id;
    selectInput.checked = selected;
    selectInput.disabled = batchActionRunning;
    selectInput.setAttribute('aria-label', `“${monitor.name}” 추적 선택`);
    selectLabel.append(selectInput);
    const title = element('div', 'tracking-title');
    title.append(element('h4', '', monitor.name), element('p', 'selector-preview', selectorPreview(monitor)));
    const status = statusInfo(monitor);
    top.append(selectLabel, title, element('span', `status ${status.key}`, status.label));
    card.append(top);

    if (monitor.labels?.length) {
      const chips = element('div', 'chips');
      monitor.labels.forEach((label) => chips.append(element('span', 'chip', label)));
      card.append(chips);
    }

    const snapshot = monitor.snapshot;
    let previewText = snapshot
      ? (snapshot.text || '(텍스트 없음)')
      : '(아직 기준값이 없습니다)';
    if (monitor.status === 'needs-review' && snapshot) {
      previewText = `마지막 정상 값: ${previewText}`;
    }
    card.append(element('p', 'snapshot-preview', monitorPreviewText(previewText)));

    const details = element('div', 'tracking-details');
    const rows = [
      ['선택', `${selectorsOf(monitor).length}개`],
      ['확인 방식', formatSchedule(monitor)],
      ['마지막 읽음', formatDate(monitor.lastViewedAt)],
      ['마지막 확인', formatDate(monitor.lastCheckedAt)],
      ['마지막 변경', formatDate(monitor.lastChangedAt)]
    ];
    rows.forEach(([label, value]) => {
      const row = element('div');
      row.append(element('span', '', label), element('strong', '', value));
      details.append(row);
    });
    card.append(details);

    if (monitor.lastError) {
      card.append(element('p', monitor.status === 'needs-review' ? 'review-text' : 'error-text', monitor.lastError));
    }

    const actions = element('div', 'card-actions');
    if (monitor.unread) actions.append(makeAction('변경 내용', 'change', monitor.id, 'attention-action'));
    if (monitor.hasErrorEvidence) actions.append(makeAction('선택 실패 화면', 'evidence', monitor.id, 'attention-action'));
    if (monitor.historyCount || monitor.runCount) actions.append(makeAction('기록', 'history', monitor.id));
    if (monitor.tracking?.live) actions.append(makeAction('실시간 연결', 'live', monitor.id));
    if (monitor.status === 'permission-needed') actions.append(makeAction('추적 시작', 'grant', monitor.id, 'attention-action'));
    actions.append(
      makeAction('지금 확인', 'check', monitor.id),
      makeAction('작은 창', 'open', monitor.id),
      makeAction('새 탭', 'open-tab', monitor.id),
      makeAction('편집', 'edit', monitor.id),
      makeAction(monitor.enabled ? '일시정지' : '다시 시작', 'toggle', monitor.id),
      makeAction('삭제', 'delete', monitor.id, 'attention-action')
    );
    card.append(actions);
    return card;
  }

  function pageCardShell(page) {
    const pageElement = element('section', 'page-card');
    const top = element('div', 'page-top');
    const heading = element('div', 'page-title');
    const pageTitle = page.monitors.map((monitor) => monitor.pageTitle).find(Boolean);
    heading.append(
      element('h3', '', pageTitle || pagePath(page.url)),
      element('p', 'page-url', page.url)
    );

    const selectorCount = page.monitors.reduce((count, monitor) => count + selectorsOf(monitor).length, 0);
    const changed = page.monitors.some((monitor) => monitor.unread) ? 1 : 0;
    const attention = page.monitors.some(needsAttention) ? 1 : 0;
    const summary = element('div', 'page-summary');
    summary.append(element('span', 'page-count', `${selectorCount}개 선택자`));
    if (changed) summary.append(element('span', 'page-badge changed', '변경 감지'));
    if (attention) summary.append(element('span', 'page-badge attention', '확인 필요'));
    top.append(heading, summary);
    pageElement.append(top);

    const actions = element('div', 'page-actions');
    actions.append(
      makePageAction('이 페이지 확인', 'check-page', page.url),
      makePageAction('주소만 변경', 'move-page-url', page.url),
      makePageAction('주소만 복제', 'copy-page-url', page.url),
      makePageAction('페이지 추적 삭제', 'delete-page', page.url, 'attention-action')
    );
    pageElement.append(actions);

    const tracks = element('div', 'tracking-list');
    pageElement.append(tracks);
    return { pageElement, tracks };
  }

  function pageCard(page) {
    const { pageElement, tracks } = pageCardShell(page);
    page.visibleMonitors.forEach((monitor) => tracks.append(monitorCard(monitor)));
    return pageElement;
  }

  function siteCardShell(site) {
    const card = element('article', 'site-group');
    const top = element('div', 'site-heading');
    const title = element('div');
    title.append(
      element('h2', '', site.host),
      element('p', '', `${site.pages.length}개 페이지 · ${site.allMonitors.length}개 추적`)
    );
    const changed = site.allMonitors.filter((monitor) => monitor.unread).length;
    const attention = site.allMonitors.filter(needsAttention).length;
    const badges = element('div', 'site-badges');
    if (changed) badges.append(element('span', 'page-badge changed', `변경 ${changed}`));
    if (attention) badges.append(element('span', 'page-badge attention', `확인 ${attention}`));
    top.append(title, badges);
    card.append(top);

    const pages = element('div', 'site-pages');
    card.append(pages);
    return { card, pages };
  }

  function siteCard(site) {
    const { card, pages } = siteCardShell(site);
    site.pages.forEach((page) => pages.append(pageCard(page)));
    return card;
  }

  function updateListHeading(sites, visibleMonitorCount) {
    if (filters.label) {
      const current = labelCollection().find(([key]) => key === filters.label);
      elements.listTitle.textContent = current ? `${current[1].label} 라벨` : '라벨 추적';
      elements.listDescription.textContent = '같은 사이트와 페이지를 묶어 표시합니다.';
    } else {
      const headings = {
        changed: '변경 감지됨',
        active: '추적 중',
        attention: '확인 필요',
        paused: '일시정지됨',
        all: '모든 추적'
      };
      elements.listTitle.textContent = headings[filters.status] ?? headings.all;
      elements.listDescription.textContent = '사이트 → 페이지(주소) → CSS 선택자 목록 순서로 하나의 추적을 관리합니다.';
    }
    elements.visibleCount.textContent = `${sites.length}개 사이트 · ${visibleMonitorCount}개 추적`;
  }

  function renderMonitors() {
    monitorRenderGeneration += 1;
    if (searchRenderTimer !== null) {
      clearTimeout(searchRenderTimer);
      searchRenderTimer = null;
    }
    const sites = getFilteredSiteGroups();
    const visibleMonitorCount = sites.reduce((count, site) => count + site.pages.reduce(
      (pageCount, page) => pageCount + page.visibleMonitors.length,
      0
    ), 0);
    updateListHeading(sites, visibleMonitorCount);
    renderSelectionControls(sites);
    elements.monitorList.replaceChildren();
    if (!sites.length) {
      const empty = element('div', 'empty-state');
      const title = element('strong', '', state.monitors.length ? '조건에 맞는 추적이 없습니다.' : '아직 저장된 추적이 없습니다.');
      empty.append(title, document.createTextNode(state.monitors.length
        ? '검색어, 라벨, 상태 필터를 바꿔 보세요.'
        : '추적할 웹페이지에서 브라우저 툴바의 OpenStill 버튼을 눌러 CSS 요소를 선택하세요.'));
      elements.monitorList.append(empty);
      return;
    }
    sites.forEach((site) => elements.monitorList.append(siteCard(site)));
  }

  async function renderMonitorsProgressively(total = state.monitors.length) {
    const generation = ++monitorRenderGeneration;
    if (searchRenderTimer !== null) {
      clearTimeout(searchRenderTimer);
      searchRenderTimer = null;
    }
    const sites = getFilteredSiteGroups();
    const visibleMonitorCount = sites.reduce((count, site) => count + site.pages.reduce(
      (pageCount, page) => pageCount + page.visibleMonitors.length,
      0
    ), 0);
    updateListHeading(sites, visibleMonitorCount);
    renderSelectionControls(sites);
    elements.monitorList.replaceChildren();
    if (!sites.length) {
      const empty = element('div', 'empty-state');
      const title = element('strong', '', state.monitors.length ? '조건에 맞는 추적이 없습니다.' : '아직 등록된 추적이 없습니다.');
      empty.append(title, document.createTextNode(state.monitors.length
        ? '검색어, 라벨, 상태 필터를 바꿔 보세요.'
        : '추적할 웹페이지에서 브라우저 도구 모음의 OpenStill 버튼을 눌러 CSS 요소를 선택하세요.'));
      elements.monitorList.append(empty);
      return;
    }

    const pendingNodes = document.createDocumentFragment();
    let rendered = 0;
    updateDashboardRenderProgress(0, total);
    for (const site of sites) {
      if (generation !== monitorRenderGeneration) return;
      const { card, pages } = siteCardShell(site);
      pendingNodes.append(card);
      for (const page of site.pages) {
        const { pageElement, tracks } = pageCardShell(page);
        pages.append(pageElement);
        for (const monitor of page.visibleMonitors) {
          tracks.append(monitorCard(monitor));
          rendered += 1;
          if (rendered % DASHBOARD_RENDER_CHUNK_SIZE === 0) {
            elements.monitorList.append(pendingNodes);
            updateDashboardRenderProgress(Math.min(rendered, total), total);
            await yieldToBrowser();
            if (generation !== monitorRenderGeneration) return;
          }
        }
      }
    }
    if (generation !== monitorRenderGeneration) return;
    elements.monitorList.append(pendingNodes);
    updateDashboardRenderProgress(total, total);
  }

  function renderMonitorList() {
    if (state.monitors.length >= BULK_TRANSFER_THRESHOLD) {
      return renderMonitorsProgressively(state.monitors.length);
    }
    renderMonitors();
    return Promise.resolve();
  }

  function render() {
    renderOverview();
    renderLabels();
    return renderMonitorList();
  }

  async function refresh() {
    if (dashboardLoading) return;
    if (refreshQueueTimer !== null) {
      clearTimeout(refreshQueueTimer);
      refreshQueueTimer = null;
      refreshQueued = false;
      refreshPending = false;
    }
    dashboardLoading = true;
    let loadTotal = 0;
    let loadFinished = false;
    beginDashboardLoadProgress();
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const started = await send({ type: 'start-dashboard-load' });
        if (!started?.ok) throw new Error(started?.error || '저장된 데이터를 불러오지 못했습니다.');
        const loadId = started.id;
        const total = started.total || 0;
        loadTotal = total;
        startDashboardLoadProgress(total);
        const monitors = [];
        let expired = false;
        try {
          for (let offset = 0; offset < total;) {
            const page = await send({
              type: 'get-dashboard-load-page',
              id: loadId,
              offset,
              pageSize: total >= BULK_TRANSFER_THRESHOLD ? BULK_TRANSFER_CHUNK_SIZE : Math.max(total, 1)
            });
            if (!page?.ok) {
              if (page?.reason === 'expired') {
                expired = true;
                break;
              }
              throw new Error(page?.error || '대시보드 데이터를 불러오지 못했습니다.');
            }
            monitors.push(...(page.monitors ?? []));
            offset += (page.monitors ?? []).length;
            updateDashboardLoadProgress(offset, total);
            if (!page.done && (page.monitors ?? []).length) await yieldToBrowser();
            if (!page.done && !(page.monitors ?? []).length) {
              throw new Error('대시보드 데이터를 계속 불러올 수 없습니다.');
            }
          }
        } finally {
          await send({ type: 'finish-dashboard-load', id: loadId }).catch(() => undefined);
        }
        if (expired) continue;
        state.monitors = monitors;
        state.settings = started.settings ?? { soundEnabled: true };
        await render();
        finishDashboardLoadProgress(total);
        loadFinished = true;
        return;
      }
      throw new Error('대시보드 로드가 만료되어 다시 시도하지 못했습니다.');
    } finally {
      dashboardLoading = false;
      if (!loadFinished) finishDashboardLoadProgress(loadTotal, true);
      if (!transferRunning) {
        elements.exportButton.disabled = false;
        elements.importButton.disabled = false;
        elements.importInput.disabled = false;
      }
      flushQueuedDashboardRefresh();
    }
  }

  function showToast(text) {
    clearTimeout(toastTimer);
    elements.toast.textContent = text;
    elements.toast.classList.add('show');
    toastTimer = setTimeout(() => elements.toast.classList.remove('show'), 4_200);
  }

  function formatTransferCount(value) {
    return Number(value).toLocaleString('ko-KR');
  }

  function formatByteSize(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  // The item count is unknown until JSON is decoded. Show byte-level feedback
  // for that stage; the regular item-count bar still starts at 200 records.
  function updateImportFileProgress(label, loaded, total, parsing = false) {
    clearTimeout(transferProgressTimer);
    elements.transferProgress.hidden = false;
    elements.transferProgressLabel.textContent = label;
    if (parsing || !total) {
      elements.transferProgressBar.removeAttribute('value');
      elements.transferProgressValue.textContent = parsing ? 'JSON 해석 중' : '';
      return;
    }
    elements.transferProgressBar.max = total;
    elements.transferProgressBar.value = Math.min(Math.max(0, loaded), total);
    elements.transferProgressValue.textContent = `${formatByteSize(loaded)} / ${formatByteSize(total)}`;
  }

  function showsTransferProgress(total) {
    return total >= BULK_TRANSFER_THRESHOLD;
  }

  function updateTransferProgress(label, completed, total) {
    if (!showsTransferProgress(total)) return;
    elements.transferProgress.hidden = false;
    elements.transferProgressLabel.textContent = label;
    elements.transferProgressBar.max = Math.max(total, 1);
    elements.transferProgressBar.value = Math.min(completed, total);
    elements.transferProgressValue.textContent = `${formatTransferCount(completed)} / ${formatTransferCount(total)}`;
  }

  function beginTransfer(label, total, completed = 0) {
    clearTimeout(transferProgressTimer);
    transferRunning = true;
    elements.exportButton.disabled = true;
    elements.importButton.disabled = true;
    elements.importInput.disabled = true;
    if (showsTransferProgress(total)) updateTransferProgress(label, completed, total);
    else elements.transferProgress.hidden = true;
  }

  function finishTransfer(label, completed, total) {
    transferRunning = false;
    elements.exportButton.disabled = false;
    elements.importButton.disabled = false;
    elements.importInput.disabled = false;
    if (!showsTransferProgress(total)) {
      elements.transferProgress.hidden = true;
    } else {
      updateTransferProgress(label, completed, total);
      transferProgressTimer = setTimeout(() => {
        elements.transferProgress.hidden = true;
      }, 4_200);
    }
    flushQueuedDashboardRefresh();
  }

  function beginDashboardLoadProgress() {
    clearTimeout(transferProgressTimer);
    elements.exportButton.disabled = true;
    elements.importButton.disabled = true;
    elements.importInput.disabled = true;
    elements.transferProgress.hidden = true;
  }

  function startDashboardLoadProgress(total) {
    if (!showsTransferProgress(total)) return;
    updateTransferProgress('대시보드 불러오는 중', 0, total);
  }

  function updateDashboardLoadProgress(completed, total) {
    if (!showsTransferProgress(total)) return;
    updateTransferProgress('대시보드 불러오는 중', completed, total);
  }

  function updateDashboardRenderProgress(completed, total) {
    if (!dashboardLoading || !showsTransferProgress(total)) return;
    updateTransferProgress('대시보드 목록 표시 중', completed, total);
  }

  function finishDashboardLoadProgress(total, failed = false) {
    if (showsTransferProgress(total)) {
      updateTransferProgress(failed ? '대시보드 불러오기 실패' : '대시보드 준비 완료', total, total);
      transferProgressTimer = setTimeout(() => {
        elements.transferProgress.hidden = true;
      }, 4_200);
      return;
    }
    elements.transferProgress.hidden = true;
  }

  function transferChunkSize(total) {
    return total >= BULK_TRANSFER_THRESHOLD ? BULK_TRANSFER_CHUNK_SIZE : Math.max(total, 1);
  }

  async function nextImportChunk(monitors, start, maxItems = BULK_TRANSFER_CHUNK_SIZE) {
    let end = start;
    let byteLength = 256; // Envelope fields added by chrome.runtime.sendMessage.
    while (end < monitors.length && end - start < maxItems) {
      const item = monitors[end];
      const cachedBytes = item && typeof item === 'object' ? importRecordByteLengths.get(item) : undefined;
      const recordBytes = (cachedBytes ?? await utf8ByteLengthYielding(JSON.stringify(item)))
        + (end > start ? 1 : 0);
      if (byteLength + recordBytes > MAX_IMPORT_MESSAGE_BYTES) {
        if (end === start) {
          throw new Error('불러오기 전송 데이터 조각이 32 MB 안전 범위를 넘습니다.');
        }
        break;
      }
      byteLength += recordBytes;
      end += 1;
    }
    return { end, monitors: monitors.slice(start, end) };
  }

  function yieldToBrowser() {
    return new Promise((resolve) => {
      let settled = false;
      let frameId = null;
      let fallbackId = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (frameId !== null) window.cancelAnimationFrame(frameId);
        if (fallbackId !== null) window.clearTimeout(fallbackId);
        resolve();
      };
      // requestAnimationFrame may stop entirely in a hidden dashboard tab.
      // The timer keeps a long import/export moving (and its SW session alive)
      // when the user switches tabs midway through a backup.
      fallbackId = window.setTimeout(finish, 100);
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        window.clearTimeout(fallbackId);
        fallbackId = null;
        window.setTimeout(finish, 0);
      });
    });
  }

  async function utf8ByteLengthYielding(value, chunkChars = 1024 * 1024) {
    if (value.length <= chunkChars) return utf8ByteLength(value);
    let bytes = 0;
    for (let start = 0; start < value.length;) {
      let end = Math.min(value.length, start + chunkChars);
      const last = value.charCodeAt(end - 1);
      const next = value.charCodeAt(end);
      if (end < value.length && last >= 0xd800 && last <= 0xdbff
        && next >= 0xdc00 && next <= 0xdfff) {
        end = end - start > 1 ? end - 1 : end + 1;
      }
      bytes += utf8ByteLength(value.slice(start, end));
      start = end;
      if (start < value.length) await yieldToBrowser();
    }
    return bytes;
  }

  function monitorById(id) {
    return state.monitors.find((monitor) => monitor.id === id);
  }

  async function loadMonitorDetail(id) {
    const response = await send({ type: 'get-monitor-detail', id });
    if (!response?.ok || !response.monitor) {
      throw new Error(response?.error || '추적 세부 정보를 불러오지 못했습니다.');
    }
    return response.monitor;
  }

  function pageByUrl(url) {
    const monitors = state.monitors.filter((monitor) => monitor.url === url);
    return monitors.length ? { url, monitors } : null;
  }

  function populateIntervalSelects() {
    for (let day = 0; day <= 14; day += 1) {
      const option = element('option', '', `${day}일`);
      option.value = String(day);
      elements.editDays.append(option);
    }
    for (let hour = 0; hour < 24; hour += 1) {
      const option = element('option', '', `${hour}시간`);
      option.value = String(hour);
      elements.editHours.append(option);
    }
  }

  function updateEditorInterval() {
    const scheduleMode = elements.editScheduleMode.value === 'interval' ? 'interval' : 'manual';
    const days = Number(elements.editDays.value);
    let hours = Number(elements.editHours.value);
    if (days === 14 && hours > 0) {
      hours = 0;
      elements.editHours.value = '0';
    }
    [...elements.editHours.options].forEach((option) => {
      option.disabled = days === 14 && Number(option.value) > 0;
    });
    const total = days * 24 + hours;
    elements.editIntervalInputs.hidden = scheduleMode === 'manual';
    elements.editIntervalHelp.textContent = scheduleMode === 'manual'
      ? '자동으로 갱신하지 않습니다. 대시보드의 “지금 확인”으로만 갱신합니다.'
      : total >= MIN_HOURS && total <= MAX_HOURS
      ? `매 ${formatDuration(total)}마다 확인합니다.`
      : '간격은 최소 1시간, 최대 14일입니다.';
    return total;
  }

  function updateEditorInterval() {
    const rawMode = elements.editScheduleMode.value;
    const scheduleMode = ['manual', 'interval', 'random', 'cron', 'live'].includes(rawMode) ? rawMode : 'manual';
    const days = Number(elements.editDays.value);
    const hours = Number(elements.editHours.value);
    const friendlySeconds = Math.max(0, Math.round((days * 24 + hours) * 3_600));
    const intervalSeconds = Number(elements.editIntervalSeconds?.value || friendlySeconds);
    const randomMin = Number(elements.editRandomMinSeconds?.value || 0);
    const randomMax = Number(elements.editRandomMaxSeconds?.value || 0);
    elements.editIntervalInputs.hidden = scheduleMode !== 'interval';
    elements.editRandomInputs.hidden = scheduleMode !== 'random';
    elements.editCronInputs.hidden = scheduleMode !== 'cron';
    if (elements.editLive) {
      if (scheduleMode === 'live') elements.editLive.checked = true;
      elements.editLive.disabled = scheduleMode === 'live';
    }
    const validInterval = Number.isInteger(intervalSeconds) && intervalSeconds >= 5 && intervalSeconds <= 2_592_000;
    const validRandom = Number.isInteger(randomMin) && Number.isInteger(randomMax)
      && randomMin >= 5 && randomMax <= 2_592_000 && randomMin <= randomMax;
    const validCron = Boolean(elements.editCronExpression?.value.trim());
    elements.editIntervalHelp.textContent = scheduleMode === 'manual'
      ? '수동 확인만 수행합니다.'
      : scheduleMode === 'live'
        ? '열려 있는 동일 페이지에 자동으로 실시간 감시를 연결합니다.'
        : scheduleMode === 'interval'
          ? (validInterval ? `매 ${formatSeconds(intervalSeconds)}마다 확인합니다.` : '간격은 5초에서 30일 사이의 정수여야 합니다.')
          : scheduleMode === 'random'
            ? (validRandom ? `${formatSeconds(randomMin)}~${formatSeconds(randomMax)} 사이에서 무작위로 확인합니다.` : '최소/최대는 5초에서 30일 사이의 정수이며 최소가 더 작아야 합니다.')
            : validCron ? 'CRON 식과 선택 시간대로 다음 실행 시각을 계산합니다.' : 'CRON 식을 입력하세요.';
    return { scheduleMode, intervalSeconds, randomMin, randomMax, validInterval, validRandom, validCron };
  }

  function syncIntervalSecondsFromFriendlyInputs() {
    const seconds = (Number(elements.editDays.value) * 24 + Number(elements.editHours.value)) * 3_600;
    if (elements.editIntervalSeconds) elements.editIntervalSeconds.value = String(seconds);
    updateEditorInterval();
  }

  function openEditor(monitor) {
    elements.editId.value = monitor.id;
    elements.editName.value = monitor.name;
    elements.editUrl.value = monitor.url;
    elements.editSelectors.value = locatorsOf(monitor).map(locatorLine).join('\n');
    elements.editCompareMode.value = monitor.tracking?.dataAttr === 'data' ? 'data' : 'text';
    elements.editDelaySeconds.value = String(Math.round((Number(monitor.tracking?.delayMilliseconds) || 0) / 1_000));
    elements.editTimeoutSeconds.value = String(Math.round((Number(monitor.tracking?.timeoutMilliseconds) || 60_000) / 1_000));
    elements.editRegexp.value = monitor.tracking?.regexp?.expr ?? '';
    elements.editRegexpFlags.value = monitor.tracking?.regexp?.flags ?? '';
    elements.editIgnoreWhitespace.checked = monitor.tracking?.ignoreWhitespace !== false;
    elements.editAllowEmpty.checked = monitor.tracking?.allowEmpty === true;
    elements.editIncludeStyle.checked = monitor.tracking?.includeStyle === true;
    elements.editIncludeScript.checked = monitor.tracking?.includeScript === true;
    elements.editKeepComments.checked = monitor.tracking?.keepComments === true;
    elements.editLive.checked = monitor.tracking?.live === true;
    elements.editLabels.value = (monitor.labels ?? []).join(', ');
    elements.editScheduleMode.value = scheduleModeOf(monitor);
    const scheduleParams = monitor.schedule?.params ?? {};
    const intervalSeconds = Number(scheduleParams.interval ?? monitor.intervalSeconds ?? Number(monitor.intervalHours || 1) * 3_600);
    elements.editIntervalSeconds.value = String(Number.isFinite(intervalSeconds) ? intervalSeconds : 3_600);
    elements.editRandomMinSeconds.value = String(Number(scheduleParams.min ?? 3_600));
    elements.editRandomMaxSeconds.value = String(Number(scheduleParams.max ?? 7_200));
    elements.editCronExpression.value = String(scheduleParams.expr ?? '0 3 * * *');
    elements.editCronTimezone.value = String(scheduleParams.tz ?? '');
    const friendlyHours = Math.max(0, Math.min(336, Math.floor(intervalSeconds / 3_600)));
    elements.editDays.value = String(Math.floor(friendlyHours / 24));
    elements.editHours.value = String(friendlyHours % 24);
    elements.editEnabled.checked = monitor.enabled;
    elements.editorMessage.textContent = '';
    updateEditorInterval();
    elements.editorDialog.showModal();
  }

  async function saveEditor() {
    const id = elements.editId.value;
    const scheduleDraft = updateEditorInterval();
    const { scheduleMode, intervalSeconds, randomMin, randomMax, validInterval, validRandom, validCron } = scheduleDraft;
    const url = elements.editUrl.value.trim();
    const locators = elements.editSelectors.value
      .split(/\r?\n/)
      .map(parseLocatorLine)
      .filter(Boolean);
    const delaySeconds = Number(elements.editDelaySeconds.value || 0);
    const timeoutSeconds = Number(elements.editTimeoutSeconds.value || 60);
    const regexp = elements.editRegexp.value.trim();
    const regexpFlags = elements.editRegexpFlags.value.trim();
    // An empty locator editor intentionally means the Reference full-page
    // default (`body`). Exclude-only input remains invalid because it has no
    // positive capture root.
    if (!id || !url || (locators.length && !locators.some((locator) => locator.op !== 'exclude'))
      || (scheduleMode === 'interval' && !validInterval)
      || (scheduleMode === 'random' && !validRandom)
      || (scheduleMode === 'cron' && !validCron)) {
      elements.editorMessage.textContent = '필수 정보와 확인 간격을 확인해 주세요.';
      return;
    }
    if (!Number.isFinite(delaySeconds) || delaySeconds < 0 || delaySeconds > 60 || !Number.isInteger(delaySeconds)) {
      elements.editorMessage.textContent = '렌더링 대기는 0초에서 60초 사이의 정수여야 합니다.';
      return;
    }
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 300 || !Number.isInteger(timeoutSeconds)) {
      elements.editorMessage.textContent = '최대 캡처 시간은 10초에서 300초 사이의 정수여야 합니다.';
      return;
    }
    let enabled = elements.editEnabled.checked;
    if (enabled && !await requestSitePermission(url)) {
      enabled = false;
      elements.editEnabled.checked = false;
      elements.editorMessage.textContent = '권한을 허용하지 않아 일시정지 상태로 저장합니다.';
    }

    const schedule = scheduleMode === 'interval'
      ? { type: 'interval', params: { interval: intervalSeconds } }
      : scheduleMode === 'random'
        ? { type: 'random', params: { min: randomMin, max: randomMax } }
        : scheduleMode === 'cron'
          ? {
              type: 'cron',
              params: {
                expr: elements.editCronExpression.value.trim(),
                ...(elements.editCronTimezone.value.trim() ? { tz: elements.editCronTimezone.value.trim() } : {})
              }
            }
          : { type: scheduleMode, params: {} };

    const response = await send({
      type: 'save-monitor',
      id,
      name: elements.editName.value,
      url,
      locators,
      tracking: {
        dataAttr: elements.editCompareMode.value === 'data' ? 'data' : 'text',
        ignoreWhitespace: elements.editIgnoreWhitespace.checked,
        allowEmpty: elements.editAllowEmpty.checked,
        delayMilliseconds: delaySeconds * 1_000,
        timeoutMilliseconds: timeoutSeconds * 1_000,
        regexp: regexp ? { expr: regexp, flags: regexpFlags } : null,
        includeStyle: elements.editIncludeStyle.checked,
        includeScript: elements.editIncludeScript.checked,
        keepComments: elements.editKeepComments.checked,
        live: elements.editLive.checked || scheduleMode === 'live'
      },
      labels: elements.editLabels.value.split(','),
      scheduleMode,
      schedule,
      intervalSeconds,
      intervalHours: intervalSeconds / 3_600,
      enabled
    });
    if (!response?.ok) {
      elements.editorMessage.textContent = response?.error || '저장하지 못했습니다.';
      return;
    }
    elements.editorDialog.close();
    showToast('추적 설정을 저장했습니다. 주소나 선택자를 바꾸면 다음 확인에서 새 기준값을 저장합니다.');
    await refresh();
  }

  function openPageUrlDialog(page, mode) {
    const copying = mode === 'copy';
    elements.pageUrlDialog.dataset.mode = mode;
    elements.pageUrlSource.value = page.url;
    elements.pageUrlTitle.textContent = copying ? '주소만 복제' : '주소만 변경';
    elements.pageUrlDescription.textContent = copying
      ? `이 페이지의 ${page.monitors.length}개 추적을 새 주소에 복제합니다. 원래 페이지 추적은 그대로 남습니다.`
      : `이 페이지의 ${page.monitors.length}개 추적을 새 주소로 옮깁니다.`;
    elements.pageUrlInput.value = page.url;
    elements.pageUrlMessage.textContent = '';
    elements.pageUrlSave.textContent = copying ? '새 주소로 복제' : '주소 변경';
    elements.pageUrlDialog.showModal();
    requestAnimationFrame(() => {
      elements.pageUrlInput.focus();
      elements.pageUrlInput.select();
    });
  }

  async function savePageUrl() {
    const sourceUrl = elements.pageUrlSource.value;
    const targetUrl = elements.pageUrlInput.value.trim();
    const mode = elements.pageUrlDialog.dataset.mode;
    const sourcePage = pageByUrl(sourceUrl);
    if (!sourcePage || !targetUrl) {
      elements.pageUrlMessage.textContent = '기존 주소와 새 주소를 확인해 주세요.';
      return;
    }
    if (targetUrl === sourceUrl) {
      elements.pageUrlMessage.textContent = '새 주소가 기존 주소와 같습니다.';
      return;
    }
    if (sourcePage.monitors.some((monitor) => monitor.enabled) && !await requestSitePermission(targetUrl)) {
      elements.pageUrlMessage.textContent = '새 주소의 추적을 시작하려면 사이트 접근 권한이 필요합니다.';
      return;
    }

    const response = await send({
      type: mode === 'copy' ? 'copy-page-url' : 'move-page-url',
      sourceUrl,
      targetUrl
    });
    if (!response?.ok) {
      elements.pageUrlMessage.textContent = response?.error || '주소를 저장하지 못했습니다.';
      return;
    }
    elements.pageUrlDialog.close();
    showToast(mode === 'copy'
      ? `${response.count}개 추적을 새 주소에 복제했습니다. 첫 확인에서 기준값을 저장합니다.`
      : `${response.count}개 추적의 주소를 변경했습니다. 첫 확인에서 기준값을 저장합니다.`);
    await refresh();
  }

  function updateBatchUrlPreview() {
    const sourceHost = siteHostFromInput(elements.batchUrlSource.value);
    const targetHost = siteHostFromInput(elements.batchUrlTarget.value);
    if (!sourceHost) {
      elements.batchUrlPreview.textContent = '기존 사이트 주소에 example.com처럼 도메인만 입력해 주세요.';
      return 0;
    }

    const affected = monitorCountForSiteHost(sourceHost);
    if (!targetHost) {
      elements.batchUrlPreview.textContent = `${sourceHost}의 ${affected}개 추적 페이지를 찾았습니다. 새 사이트 주소를 입력해 주세요.`;
      return affected;
    }
    if (sourceHost === targetHost) {
      elements.batchUrlPreview.textContent = '새 사이트 주소가 기존 주소와 같습니다.';
      return 0;
    }

    elements.batchUrlPreview.textContent = `${sourceHost} → ${targetHost}: ${affected}개 추적 페이지의 주소를 변경합니다.`;
    return affected;
  }

  function openBatchUrlDialog() {
    elements.batchUrlSource.value = '';
    elements.batchUrlTarget.value = '';
    elements.batchUrlMessage.textContent = '';
    updateBatchUrlPreview();
    elements.batchUrlDialog.showModal();
    requestAnimationFrame(() => elements.batchUrlSource.focus());
  }

  async function saveBatchUrl() {
    const sourceHost = siteHostFromInput(elements.batchUrlSource.value);
    const targetHost = siteHostFromInput(elements.batchUrlTarget.value);
    if (!sourceHost || !targetHost) {
      elements.batchUrlMessage.textContent = '기존 및 새 사이트 주소에는 도메인(필요하면 포트)만 입력해 주세요.';
      return;
    }
    if (sourceHost === targetHost) {
      elements.batchUrlMessage.textContent = '새 사이트 주소가 기존 주소와 같습니다.';
      return;
    }
    if (!monitorCountForSiteHost(sourceHost)) {
      elements.batchUrlMessage.textContent = '기존 사이트 주소에 해당하는 추적을 찾지 못했습니다.';
      return;
    }

    elements.batchUrlSave.disabled = true;
    elements.batchUrlMessage.textContent = '주소를 안전하게 변경하는 중입니다…';
    try {
      const response = await send({ type: 'replace-site-host', sourceHost, targetHost });
      if (!response?.ok) {
        elements.batchUrlMessage.textContent = response?.error || '주소를 일괄 변경하지 못했습니다.';
        return;
      }
      elements.batchUrlDialog.close();
      showToast(`${response.count}개 추적 페이지의 사이트 주소를 변경했습니다. 기존 기록을 유지한 채 다음 결과를 비교합니다.`);
      await refresh();
    } catch (error) {
      elements.batchUrlMessage.textContent = error.message || '주소를 일괄 변경하지 못했습니다.';
    } finally {
      elements.batchUrlSave.disabled = false;
    }
  }

  function pushText(target, text) {
    if (text) target.append(document.createTextNode(text));
  }

  // Snapshot markup is data from a remote page.  Do not inject that markup into
  // the dashboard: parse it into a deliberately small, inert tree and build the
  // view with DOM APIs.  In addition to preventing active content from running,
  // this preserves a link's position in the original tree instead of trying to
  // rediscover it by matching visible text (which fails for duplicate labels).
  const SNAPSHOT_ALLOWED_TAGS = new Set([
    'a', 'abbr', 'address', 'article', 'aside', 'b', 'blockquote', 'br', 'caption',
    'cite', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'figcaption',
    'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i',
    'kbd', 'li', 'main', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'section',
    'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td',
    'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul', 'var', 'wbr', 'img'
  ]);
  const SNAPSHOT_DROPPED_TAGS = new Set([
    'base', 'embed', 'frame', 'frameset', 'iframe', 'link', 'meta', 'noscript',
    'object', 'script', 'style', 'svg', 'math', 'canvas', 'source', 'track'
  ]);
  const SNAPSHOT_VOID_TAGS = new Set(['br', 'hr', 'img', 'wbr']);
  const SNAPSHOT_MAX_NODES = 5_000;
  const SNAPSHOT_MAX_TEXT = 180_000;
  const SNAPSHOT_ALIGNMENT_CELLS = 12_000;

  function safeSnapshotLink(value, baseUrl = '') {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    try {
      const url = baseUrl ? new URL(raw, baseUrl) : new URL(raw);
      return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
    } catch {
      return '';
    }
  }

  function snapshotBaseUrl(snapshot, fallback = '') {
    const candidates = [snapshot?.baseUrl, snapshot?.url, fallback];
    for (const candidate of candidates) {
      const safe = safeSnapshotLink(candidate);
      if (safe) return safe;
    }
    return '';
  }

  function clippedSnapshotText(value, maximum = 1_200) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maximum);
  }

  function appendSnapshotTreeChild(children, node) {
    if (!node) return;
    if (node.type === 'fragment') {
      node.children.forEach((child) => appendSnapshotTreeChild(children, child));
      return;
    }
    const previous = children[children.length - 1];
    if (node.type === 'text' && previous?.type === 'text') {
      previous.text += node.text;
      return;
    }
    children.push(node);
  }

  function snapshotAttributesFromNode(node, tagName, baseUrl) {
    const attributes = {};
    const title = clippedSnapshotText(node.getAttribute('title'), 500);
    const label = clippedSnapshotText(node.getAttribute('aria-label'), 500);
    if (title) attributes.title = title;
    if (label) attributes.ariaLabel = label;
    // This is displayed only as a changed-attribute badge; it is never copied
    // back onto the dashboard element, so opted-in inline-style comparison
    // cannot affect the dashboard's own rendering.
    const inlineStyle = clippedSnapshotText(node.getAttribute('style'), 2_000);
    if (inlineStyle) attributes.style = inlineStyle;
    for (const attribute of [...node.attributes].slice(0, 24)) {
      const name = attribute.name.toLowerCase();
      if (name === 'id' || name === 'class' || name.startsWith('data-')) {
        const value = clippedSnapshotText(attribute.value, 500);
        if (value) attributes[name] = value;
      }
    }

    if (tagName === 'a') {
      const href = safeSnapshotLink(node.getAttribute('href'), baseUrl);
      if (href) attributes.href = href;
    }
    if (tagName === 'img') {
      const alt = clippedSnapshotText(node.getAttribute('alt'), 500);
      if (alt) attributes.alt = alt;
      const src = safeSnapshotLink(node.getAttribute('src'), baseUrl);
      if (src) attributes.src = src;
    }
    if (tagName === 'time') {
      const dateTime = clippedSnapshotText(node.getAttribute('datetime'), 200);
      if (dateTime) attributes.dateTime = dateTime;
    }
    if (['td', 'th'].includes(tagName)) {
      for (const name of ['colspan', 'rowspan']) {
        const value = Number.parseInt(node.getAttribute(name), 10);
        if (Number.isInteger(value) && value > 0 && value <= 1_000) attributes[name] = String(value);
      }
    }
    if (tagName === 'ol') {
      const start = Number.parseInt(node.getAttribute('start'), 10);
      if (Number.isInteger(start) && Math.abs(start) <= 1_000_000) attributes.start = String(start);
    }
    if (tagName === 'li') {
      const value = Number.parseInt(node.getAttribute('value'), 10);
      if (Number.isInteger(value) && Math.abs(value) <= 1_000_000) attributes.value = String(value);
    }
    if (tagName === 'details' && node.hasAttribute('open')) attributes.open = true;
    return attributes;
  }

  function snapshotTreeFromDomNode(node, context) {
    if (context.nodes >= SNAPSHOT_MAX_NODES || context.text >= SNAPSHOT_MAX_TEXT) return null;
    if (node.nodeType === Node.TEXT_NODE) {
      const text = String(node.nodeValue ?? '').replace(/\s+/g, ' ');
      if (!text) return null;
      const remaining = SNAPSHOT_MAX_TEXT - context.text;
      if (remaining <= 0) return null;
      context.nodes += 1;
      context.text += Math.min(text.length, remaining);
      return { type: 'text', text: text.slice(0, remaining) };
    }
    if (node.nodeType === Node.COMMENT_NODE) {
      const text = String(node.nodeValue ?? '');
      const remaining = SNAPSHOT_MAX_TEXT - context.text;
      if (remaining <= 0) return null;
      context.nodes += 1;
      context.text += Math.min(text.length, remaining);
      return { type: 'comment', text: text.slice(0, remaining) };
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return null;

    const tagName = node.tagName.toLowerCase();
    // Script/style capture is opt-in in the tracker. Render it only as inert
    // text here, never by inserting the original element into the dashboard.
    if (tagName === 'script' || tagName === 'style') {
      const text = String(node.textContent ?? '');
      const remaining = SNAPSHOT_MAX_TEXT - context.text;
      if (remaining <= 0) return null;
      context.nodes += 1;
      context.text += Math.min(text.length, remaining);
      return { type: 'code', language: tagName, text: text.slice(0, remaining) };
    }
    if (tagName === 'link' && /(^|\s)stylesheet(\s|$)/i.test(node.getAttribute('rel') || '')) {
      const href = safeSnapshotLink(node.getAttribute('href'), context.baseUrl);
      if (!href) return null;
      context.nodes += 1;
      return { type: 'resource', resource: 'stylesheet', attributes: { href } };
    }
    if (SNAPSHOT_DROPPED_TAGS.has(tagName)) return null;
    if (tagName === 'openstill-frame') {
      const frameTemplate = [...node.children].find((child) => child.tagName?.toLowerCase() === 'template');
      const children = [];
      for (const child of frameTemplate ? frameTemplate.content.childNodes : node.childNodes) {
        appendSnapshotTreeChild(children, snapshotTreeFromDomNode(child, context));
      }
      context.nodes += 1;
      return {
        type: 'template',
        frame: true,
        label: `Frame ${node.getAttribute('data-frame-id') ?? '?'}`,
        children
      };
    }
    const sourceChildren = tagName === 'template' ? node.content.childNodes : node.childNodes;
    const children = [];
    for (const child of sourceChildren) {
      appendSnapshotTreeChild(children, snapshotTreeFromDomNode(child, context));
    }

    if (tagName === 'template') {
      context.nodes += 1;
      return {
        type: 'template',
        shadow: node.hasAttribute('shadowrootmode') || node.hasAttribute('shadowroot')
          || node.hasAttribute('data-openstill-shadow-root') || node.hasAttribute('data-shadow-root'),
        children
      };
    }
    if (!SNAPSHOT_ALLOWED_TAGS.has(tagName)) return { type: 'fragment', children };
    context.nodes += 1;
    return {
      type: 'element',
      tagName,
      attributes: snapshotAttributesFromNode(node, tagName, context.baseUrl),
      children
    };
  }

  function snapshotTextTree(snapshot) {
    const lines = snapshotItems(snapshot);
    return {
      type: 'root',
      children: lines.map((line) => ({
        type: 'element',
        tagName: 'p',
        attributes: {},
        children: [{ type: 'text', text: line }]
      }))
    };
  }

  function snapshotTree(snapshot, fallbackBaseUrl = '') {
    const html = typeof snapshot?.html === 'string' ? snapshot.html.trim() : '';
    if (!html || typeof DOMParser !== 'function') return snapshotTextTree(snapshot);
    try {
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      const context = { baseUrl: snapshotBaseUrl(snapshot, fallbackBaseUrl), nodes: 0, text: 0 };
      const children = [];
      for (const node of parsed.body.childNodes) {
        appendSnapshotTreeChild(children, snapshotTreeFromDomNode(node, context));
      }
      return children.length ? { type: 'root', children } : snapshotTextTree(snapshot);
    } catch {
      return snapshotTextTree(snapshot);
    }
  }

  function visibleSnapshotText(node, maximum = 800) {
    if (!node) return '';
    if (node.visibleText !== undefined) return node.visibleText;
    let text = '';
    if (node.type === 'text') text = node.text;
    else if (node.type === 'code') text = node.text;
    else if (node.type === 'comment') text = node.text;
    else if (node.type === 'resource') text = node.attributes?.href || node.resource || '';
    else if (node.type === 'element' && node.tagName === 'img') text = node.attributes.alt || 'image';
    else text = (node.children ?? []).map((child) => visibleSnapshotText(child, maximum)).join(' ');
    node.visibleText = clippedSnapshotText(text, maximum);
    return node.visibleText;
  }

  function snapshotFingerprint(node, maximum = 260) {
    if (!node) return '';
    if (node.fingerprint !== undefined) return node.fingerprint;
    if (node.type === 'text') {
      node.fingerprint = `text:${clippedSnapshotText(node.text, maximum)}`;
      return node.fingerprint;
    }
    if (node.type === 'code') {
      node.fingerprint = `code:${node.language}:${clippedSnapshotText(node.text, maximum)}`;
      return node.fingerprint;
    }
    if (node.type === 'comment') {
      node.fingerprint = `comment:${clippedSnapshotText(node.text, maximum)}`;
      return node.fingerprint;
    }
    const attributeText = Object.entries(node.attributes ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${String(value)}`)
      .join('&');
    const childText = (node.children ?? [])
      .map((child) => snapshotFingerprint(child, Math.max(32, Math.floor(maximum / 2))))
      .join('|')
      .slice(0, maximum);
    node.fingerprint = `${node.type}:${node.tagName ?? ''}:${attributeText}:${childText}`.slice(0, maximum);
    return node.fingerprint;
  }

  function wordOverlap(left, right) {
    const leftWords = new Set(String(left).toLocaleLowerCase('ko-KR').match(/[\p{L}\p{N}_]+/gu) ?? []);
    const rightWords = new Set(String(right).toLocaleLowerCase('ko-KR').match(/[\p{L}\p{N}_]+/gu) ?? []);
    if (!leftWords.size || !rightWords.size) return 0;
    let common = 0;
    leftWords.forEach((word) => { if (rightWords.has(word)) common += 1; });
    return common / Math.max(leftWords.size, rightWords.size);
  }

  function snapshotNodeSimilarity(before, after) {
    if (!before || !after || before.type !== after.type) return 0;
    if (snapshotFingerprint(before) === snapshotFingerprint(after)) return 12;
    if (before.type === 'text' || before.type === 'code' || before.type === 'comment') {
      const overlap = wordOverlap(before.text, after.text);
      return overlap ? 0.5 + overlap * 4 : 0;
    }
    if (before.type === 'resource') return before.resource === after.resource ? 1 : 0;
    if (before.type === 'root' || before.type === 'template') {
      return 1.5 + wordOverlap(visibleSnapshotText(before), visibleSnapshotText(after)) * 2;
    }
    if (before.tagName !== after.tagName) return 0;
    const beforeText = visibleSnapshotText(before);
    const afterText = visibleSnapshotText(after);
    const overlap = wordOverlap(beforeText, afterText);
    const sharedLink = Boolean(
      (before.attributes.href && before.attributes.href === after.attributes.href)
      || (before.attributes.src && before.attributes.src === after.attributes.src)
    );
    // Repeated rows must be aligned by their content rather than merely by a
    // shared tag name. Otherwise inserting E before A/B/C pairs every old row
    // with its new positional neighbour and paints the entire list as changed.
    if (beforeText && afterText && beforeText === afterText) return 10 + (sharedLink ? 1 : 0);
    if (!beforeText && !afterText) return 1.5 + (sharedLink ? 1 : 0);
    if (!overlap && !sharedLink) return 0;
    let score = 1.5 + overlap * 4;
    if (sharedLink) score += 2;
    return score;
  }

  function sameSnapshotAlignmentAnchor(before, after) {
    if (!before || !after || before.type !== after.type) return false;
    if (snapshotFingerprint(before) === snapshotFingerprint(after)) return true;
    if (before.type === 'element' && before.tagName !== after.tagName) return false;
    const beforeText = visibleSnapshotText(before);
    const afterText = visibleSnapshotText(after);
    return Boolean(beforeText && beforeText === afterText);
  }

  function greedySnapshotAlignment(beforeChildren, afterChildren) {
    const operations = [];
    let beforeIndex = 0;
    let afterIndex = 0;
    const lookAhead = 12;

    while (beforeIndex < beforeChildren.length && afterIndex < afterChildren.length) {
      const before = beforeChildren[beforeIndex];
      const after = afterChildren[afterIndex];
      if (sameSnapshotAlignmentAnchor(before, after) || snapshotNodeSimilarity(before, after) >= 1) {
        operations.push({ type: 'pair', before, after });
        beforeIndex += 1;
        afterIndex += 1;
        continue;
      }
      const matchingAfter = afterChildren.slice(afterIndex + 1, afterIndex + 1 + lookAhead)
        .findIndex((candidate) => sameSnapshotAlignmentAnchor(before, candidate));
      const matchingBefore = beforeChildren.slice(beforeIndex + 1, beforeIndex + 1 + lookAhead)
        .findIndex((candidate) => sameSnapshotAlignmentAnchor(candidate, after));
      if (matchingAfter >= 0 && (matchingBefore < 0 || matchingAfter <= matchingBefore)) {
        operations.push({ type: 'added', after });
        afterIndex += 1;
      } else if (matchingBefore >= 0) {
        operations.push({ type: 'removed', before });
        beforeIndex += 1;
      } else {
        operations.push({ type: 'removed', before }, { type: 'added', after });
        beforeIndex += 1;
        afterIndex += 1;
      }
    }
    while (beforeIndex < beforeChildren.length) operations.push({ type: 'removed', before: beforeChildren[beforeIndex++] });
    while (afterIndex < afterChildren.length) operations.push({ type: 'added', after: afterChildren[afterIndex++] });
    return operations;
  }

  function alignSnapshotChildren(beforeChildren, afterChildren) {
    const beforeLength = beforeChildren.length;
    const afterLength = afterChildren.length;
    if (!beforeLength || !afterLength) {
      return [
        ...beforeChildren.map((before) => ({ type: 'removed', before })),
        ...afterChildren.map((after) => ({ type: 'added', after }))
      ];
    }
    if (beforeLength * afterLength > SNAPSHOT_ALIGNMENT_CELLS) {
      return greedySnapshotAlignment(beforeChildren, afterChildren);
    }

    const matrix = Array.from({ length: beforeLength + 1 }, () => new Float32Array(afterLength + 1));
    for (let beforeIndex = beforeLength - 1; beforeIndex >= 0; beforeIndex -= 1) {
      for (let afterIndex = afterLength - 1; afterIndex >= 0; afterIndex -= 1) {
        const paired = snapshotNodeSimilarity(beforeChildren[beforeIndex], afterChildren[afterIndex]);
        matrix[beforeIndex][afterIndex] = Math.max(
          matrix[beforeIndex + 1][afterIndex],
          matrix[beforeIndex][afterIndex + 1],
          paired ? paired + matrix[beforeIndex + 1][afterIndex + 1] : 0
        );
      }
    }

    const operations = [];
    let beforeIndex = 0;
    let afterIndex = 0;
    while (beforeIndex < beforeLength && afterIndex < afterLength) {
      const paired = snapshotNodeSimilarity(beforeChildren[beforeIndex], afterChildren[afterIndex]);
      const diagonal = paired ? paired + matrix[beforeIndex + 1][afterIndex + 1] : -1;
      const removed = matrix[beforeIndex + 1][afterIndex];
      const added = matrix[beforeIndex][afterIndex + 1];
      if (paired && diagonal >= removed && diagonal >= added) {
        operations.push({ type: 'pair', before: beforeChildren[beforeIndex++], after: afterChildren[afterIndex++] });
      } else if (removed >= added) {
        operations.push({ type: 'removed', before: beforeChildren[beforeIndex++] });
      } else {
        operations.push({ type: 'added', after: afterChildren[afterIndex++] });
      }
    }
    while (beforeIndex < beforeLength) operations.push({ type: 'removed', before: beforeChildren[beforeIndex++] });
    while (afterIndex < afterLength) operations.push({ type: 'added', after: afterChildren[afterIndex++] });
    return operations;
  }

  function buildDiffOperations(before, after, maxCells = 60_000) {
    const operations = [];
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
      operations.push({ type: 'same', value: before[prefix] });
      prefix += 1;
    }

    let beforeEnd = before.length - 1;
    let afterEnd = after.length - 1;
    const suffix = [];
    while (beforeEnd >= prefix && afterEnd >= prefix && before[beforeEnd] === after[afterEnd]) {
      suffix.unshift({ type: 'same', value: before[beforeEnd] });
      beforeEnd -= 1;
      afterEnd -= 1;
    }

    const beforeMiddle = before.slice(prefix, beforeEnd + 1);
    const afterMiddle = after.slice(prefix, afterEnd + 1);
    if (!beforeMiddle.length) {
      afterMiddle.forEach((value) => operations.push({ type: 'added', value }));
      return operations.concat(suffix);
    }
    if (!afterMiddle.length) {
      beforeMiddle.forEach((value) => operations.push({ type: 'removed', value }));
      return operations.concat(suffix);
    }
    if (beforeMiddle.length * afterMiddle.length > maxCells) {
      beforeMiddle.forEach((value) => operations.push({ type: 'removed', value }));
      afterMiddle.forEach((value) => operations.push({ type: 'added', value }));
      return operations.concat(suffix);
    }

    const matrix = Array.from({ length: beforeMiddle.length + 1 }, () => new Uint16Array(afterMiddle.length + 1));
    for (let beforeIndex = beforeMiddle.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
      for (let afterIndex = afterMiddle.length - 1; afterIndex >= 0; afterIndex -= 1) {
        matrix[beforeIndex][afterIndex] = beforeMiddle[beforeIndex] === afterMiddle[afterIndex]
          ? matrix[beforeIndex + 1][afterIndex + 1] + 1
          : Math.max(matrix[beforeIndex + 1][afterIndex], matrix[beforeIndex][afterIndex + 1]);
      }
    }

    let beforeIndex = 0;
    let afterIndex = 0;
    while (beforeIndex < beforeMiddle.length && afterIndex < afterMiddle.length) {
      if (beforeMiddle[beforeIndex] === afterMiddle[afterIndex]) {
        operations.push({ type: 'same', value: beforeMiddle[beforeIndex] });
        beforeIndex += 1;
        afterIndex += 1;
      } else if (matrix[beforeIndex + 1][afterIndex] >= matrix[beforeIndex][afterIndex + 1]) {
        operations.push({ type: 'removed', value: beforeMiddle[beforeIndex] });
        beforeIndex += 1;
      } else {
        operations.push({ type: 'added', value: afterMiddle[afterIndex] });
        afterIndex += 1;
      }
    }
    while (beforeIndex < beforeMiddle.length) {
      operations.push({ type: 'removed', value: beforeMiddle[beforeIndex++] });
    }
    while (afterIndex < afterMiddle.length) {
      operations.push({ type: 'added', value: afterMiddle[afterIndex++] });
    }
    return operations.concat(suffix);
  }

  function tokenize(text) {
    if (globalThis.Intl?.Segmenter) {
      return [...new Intl.Segmenter('ko', { granularity: 'word' }).segment(text)].map((segment) => segment.segment);
    }
    return text.match(/\s+|[\p{L}\p{N}_]+|[^\s]/gu) ?? [];
  }

  function buildSnapshotTextDiff(beforeText, afterText) {
    const hasLineStructure = String(beforeText).includes('\n') || String(afterText).includes('\n');
    const operations = buildDiffOperations(
      hasLineStructure ? String(beforeText).split('\n') : tokenize(beforeText),
      hasLineStructure ? String(afterText).split('\n') : tokenize(afterText),
      hasLineStructure ? 60_000 : 40_000
    );
    const forSide = (excludedType) => {
      const visible = operations
        .filter((operation) => operation.type !== excludedType)
        .map((operation) => ({ ...operation }));
      if (!hasLineStructure) return visible;
      visible.forEach((operation) => { operation.value += '\n'; });
      if (visible.length) visible[visible.length - 1].value = visible[visible.length - 1].value.slice(0, -1);
      return visible;
    };
    return {
      beforeOperations: forSide('added'),
      afterOperations: forSide('removed')
    };
  }

  function stateForSnapshotNode(states, node) {
    let state = states.get(node);
    if (!state) {
      state = {};
      states.set(node, state);
    }
    return state;
  }

  function markSnapshotSubtree(states, node, mode) {
    if (node) stateForSnapshotNode(states, node).mode = mode;
  }

  function changedSnapshotAttributes(before, after) {
    const beforeAttributes = before.attributes ?? {};
    const afterAttributes = after.attributes ?? {};
    const names = new Set([...Object.keys(beforeAttributes), ...Object.keys(afterAttributes)]);
    return [...names].filter((name) => beforeAttributes[name] !== afterAttributes[name]);
  }

  function canCompareSnapshotContainers(before, after) {
    if (before.type !== after.type) return false;
    if (before.type === 'root' || before.type === 'template') return true;
    if (before.type === 'code') return before.language === after.language;
    if (before.type === 'comment') return true;
    if (before.type === 'resource') return before.resource === after.resource;
    return before.type === 'element' && before.tagName === after.tagName;
  }

  function compareSnapshotNodes(before, after, beforeStates, afterStates) {
    if (!before) {
      markSnapshotSubtree(afterStates, after, 'added');
      return;
    }
    if (!after) {
      markSnapshotSubtree(beforeStates, before, 'removed');
      return;
    }
    if (before.type === 'text' && after.type === 'text') {
      if (before.text === after.text) return;
      const diff = buildSnapshotTextDiff(before.text, after.text);
      stateForSnapshotNode(beforeStates, before).textOperations = diff.beforeOperations;
      stateForSnapshotNode(afterStates, after).textOperations = diff.afterOperations;
      return;
    }
    if (before.type === 'code' && after.type === 'code') {
      if (before.text === after.text) return;
      const diff = buildSnapshotTextDiff(before.text, after.text);
      stateForSnapshotNode(beforeStates, before).textOperations = diff.beforeOperations;
      stateForSnapshotNode(afterStates, after).textOperations = diff.afterOperations;
      return;
    }
    if (before.type === 'comment' && after.type === 'comment') {
      if (before.text === after.text) return;
      const diff = buildSnapshotTextDiff(before.text, after.text);
      stateForSnapshotNode(beforeStates, before).textOperations = diff.beforeOperations;
      stateForSnapshotNode(afterStates, after).textOperations = diff.afterOperations;
      return;
    }
    if (!canCompareSnapshotContainers(before, after)) {
      markSnapshotSubtree(beforeStates, before, 'removed');
      markSnapshotSubtree(afterStates, after, 'added');
      return;
    }

    if (before.type === 'element') {
      const changed = changedSnapshotAttributes(before, after);
      if (changed.length) {
        stateForSnapshotNode(beforeStates, before).changedAttributes = changed;
        stateForSnapshotNode(afterStates, after).changedAttributes = changed;
      }
    }
    if (before.type === 'resource') {
      const changed = changedSnapshotAttributes(before, after);
      if (changed.length) {
        stateForSnapshotNode(beforeStates, before).changedAttributes = changed;
        stateForSnapshotNode(afterStates, after).changedAttributes = changed;
      }
      return;
    }
    for (const operation of alignSnapshotChildren(before.children ?? [], after.children ?? [])) {
      if (operation.type === 'pair') {
        compareSnapshotNodes(operation.before, operation.after, beforeStates, afterStates);
      } else if (operation.type === 'removed') {
        markSnapshotSubtree(beforeStates, operation.before, 'removed');
      } else {
        markSnapshotSubtree(afterStates, operation.after, 'added');
      }
    }
  }

  function configureSnapshotAnchor(anchor, href, title = '') {
    anchor.href = href;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.referrerPolicy = 'no-referrer';
    anchor.title = title || href;
  }

  function appendLinkifiedSnapshotText(target, text) {
    let cursor = 0;
    for (const match of String(text).matchAll(/https?:\/\/[^\s<>"']+/g)) {
      const start = match.index ?? 0;
      const raw = match[0];
      const href = safeSnapshotLink(raw);
      if (!href) continue;
      pushText(target, text.slice(cursor, start));
      const anchor = element('a', 'snapshot-link', raw);
      configureSnapshotAnchor(anchor, href);
      target.append(anchor);
      cursor = start + raw.length;
    }
    pushText(target, text.slice(cursor));
  }

  function appendSnapshotTextRun(target, text, mode = '', insideLink = false) {
    if (!text) return;
    const wrapper = mode === 'added'
      ? element('ins', 'diff-added')
      : mode === 'removed'
        ? element('del', 'diff-removed')
        : target;
    if (insideLink) pushText(wrapper, text);
    else appendLinkifiedSnapshotText(wrapper, text);
    if (wrapper !== target) target.append(wrapper);
  }

  function appendSnapshotTextNode(target, node, nodeState, inheritedMode, insideLink) {
    if (inheritedMode) {
      appendSnapshotTextRun(target, node.text, inheritedMode, insideLink);
      return;
    }
    const operations = nodeState?.textOperations ?? [{ type: 'same', value: node.text }];
    for (const operation of operations) {
      appendSnapshotTextRun(target, operation.value, operation.type === 'same' ? '' : operation.type, insideLink);
    }
  }

  function applySnapshotAttributes(target, node) {
    const attributes = node.attributes ?? {};
    if (attributes.title) target.title = attributes.title;
    if (attributes.ariaLabel) target.setAttribute('aria-label', attributes.ariaLabel);
    if (attributes.dateTime) target.setAttribute('datetime', attributes.dateTime);
    for (const name of ['colspan', 'rowspan', 'start', 'value']) {
      if (attributes[name]) target.setAttribute(name, attributes[name]);
    }
    if (attributes.open) target.setAttribute('open', '');
    if (node.tagName === 'a' && attributes.href) configureSnapshotAnchor(target, attributes.href, attributes.title);
  }

  function decorateSnapshotNode(target, node, nodeState, side, inheritedMode) {
    const mode = nodeState?.mode ?? inheritedMode;
    target.classList.add('snapshot-node');
    if (mode) {
      target.classList.add(`snapshot-${mode}`);
      target.dataset.snapshotChange = mode;
    }
    if (nodeState?.changedAttributes?.length) {
      target.classList.add('snapshot-attribute-changed');
      target.dataset.snapshotAttributes = nodeState.changedAttributes.join(',');
      if (node.tagName === 'a' && nodeState.changedAttributes.includes('href')) {
        target.classList.add('snapshot-link-changed', `snapshot-link-${side}`);
      }
    }
    return mode;
  }

  function appendSnapshotAttributeBadge(target, node, nodeState) {
    const changed = nodeState?.changedAttributes;
    if (!changed?.length) return;
    const hrefChanged = node.tagName === 'a' && changed.includes('href');
    const badge = element('span', `snapshot-attribute-badge${hrefChanged ? ' snapshot-link-badge' : ''}`, hrefChanged ? '↗' : '속성 변경');
    badge.title = hrefChanged ? '링크 주소가 변경되었습니다.' : `변경된 속성: ${changed.join(', ')}`;
    badge.setAttribute('aria-label', badge.title);
    target.append(badge);
  }

  function appendSnapshotNode(target, node, states, side, inheritedMode = '', insideLink = false) {
    const nodeState = states.get(node);
    const mode = nodeState?.mode ?? inheritedMode;
    if (node.type === 'root') {
      node.children.forEach((child) => appendSnapshotNode(target, child, states, side, mode, false));
      return;
    }
    if (node.type === 'text') {
      appendSnapshotTextNode(target, node, nodeState, mode, insideLink);
      return;
    }
    if (node.type === 'code') {
      const shell = element('section', 'snapshot-code');
      decorateSnapshotNode(shell, node, nodeState, side, inheritedMode);
      shell.append(element('span', 'snapshot-code-label', node.language === 'style' ? 'Style' : 'Inline script'));
      const code = document.createElement('pre');
      appendSnapshotTextNode(code, node, nodeState, mode, false);
      shell.append(code);
      target.append(shell);
      return;
    }
    if (node.type === 'comment') {
      const shell = element('section', 'snapshot-comment');
      decorateSnapshotNode(shell, node, nodeState, side, inheritedMode);
      shell.append(element('span', 'snapshot-code-label', 'HTML comment'));
      const content = document.createElement('pre');
      appendSnapshotTextNode(content, node, nodeState, mode, false);
      shell.append(content);
      target.append(shell);
      return;
    }
    if (node.type === 'resource') {
      const shell = element('section', 'snapshot-resource');
      decorateSnapshotNode(shell, node, nodeState, side, inheritedMode);
      shell.append(element('span', 'snapshot-resource-label', 'Stylesheet'));
      const href = node.attributes?.href;
      if (href) {
        const anchor = element('a', 'snapshot-link', href);
        configureSnapshotAnchor(anchor, href);
        shell.append(anchor);
      }
      appendSnapshotAttributeBadge(shell, node, nodeState);
      target.append(shell);
      return;
    }
    if (node.type === 'template') {
      const shell = element('section', `snapshot-template${node.shadow ? ' snapshot-shadow-template' : ''}`);
      decorateSnapshotNode(shell, node, nodeState, side, inheritedMode);
      const label = element('span', 'snapshot-template-label', node.shadow ? 'Shadow DOM' : node.frame ? node.label : '템플릿 콘텐츠');
      const content = element('div', 'snapshot-template-content');
      node.children.forEach((child) => appendSnapshotNode(content, child, states, side, mode, insideLink));
      shell.append(label, content);
      target.append(shell);
      return;
    }
    if (node.tagName === 'img') {
      const image = element('span', 'snapshot-image', node.attributes.alt ? `이미지: ${node.attributes.alt}` : '이미지');
      image.setAttribute('role', 'img');
      if (node.attributes.alt) image.setAttribute('aria-label', node.attributes.alt);
      decorateSnapshotNode(image, node, nodeState, side, inheritedMode);
      target.append(image);
      return;
    }

    // An untrusted or unsupported href remains visible as text, never as an
    // inert-looking clickable anchor with an unsafe destination.
    const rendered = document.createElement(node.tagName === 'a' && !node.attributes.href ? 'span' : node.tagName);
    applySnapshotAttributes(rendered, node);
    decorateSnapshotNode(rendered, node, nodeState, side, inheritedMode);
    const childInsideLink = insideLink || (node.tagName === 'a' && Boolean(node.attributes.href));
    if (!SNAPSHOT_VOID_TAGS.has(node.tagName)) {
      node.children.forEach((child) => appendSnapshotNode(rendered, child, states, side, mode, childInsideLink));
    }
    appendSnapshotAttributeBadge(rendered, node, nodeState);
    target.append(rendered);
  }

  function renderSnapshotTree(target, tree, states, side) {
    target.replaceChildren();
    target.classList.add('snapshot-render');
    target.dataset.snapshotSide = side;
    if (!tree.children.length) {
      target.append(element('span', 'snapshot-empty', '(텍스트 없음)'));
      return;
    }
    const documentView = element('div', 'snapshot-document');
    tree.children.forEach((node) => appendSnapshotNode(documentView, node, states, side));
    target.append(documentView);
  }

  function renderSnapshotDiff(previousSnapshot, currentSnapshot, fallbackBaseUrl = '', targets = elements) {
    const beforeTree = snapshotTree(previousSnapshot, fallbackBaseUrl);
    const afterTree = snapshotTree(currentSnapshot, fallbackBaseUrl);
    const beforeStates = new WeakMap();
    const afterStates = new WeakMap();
    compareSnapshotNodes(beforeTree, afterTree, beforeStates, afterStates);
    renderSnapshotTree(targets.previousSnapshot, beforeTree, beforeStates, 'before');
    renderSnapshotTree(targets.currentSnapshot, afterTree, afterStates, 'after');
  }

  function openChange(monitor) {
    const lastChange = monitor.lastChange;
    const current = lastChange?.current ?? monitor.snapshot;
    elements.changeDialog.dataset.id = monitor.id;
    elements.changeTitle.textContent = monitor.name;
    elements.changeWhen.textContent = `감지 시각: ${formatDate(monitor.lastChangedAt ?? lastChange?.detectedAt)}`;
    renderSnapshotDiff(
      lastChange?.previous?.exists ? lastChange.previous : null,
      current?.exists ? current : null,
      monitor.url
    );
    elements.changeDialog.showModal();
  }

  function evidenceSnapshot(snapshot) {
    const html = String(snapshot?.evidenceHtml ?? '').trim();
    const text = String(snapshot?.text ?? '').trim() || '선택 결과가 비어 있습니다.';
    return {
      exists: true,
      matchCount: 1,
      text,
      html,
      data: html,
      items: [{ text }]
    };
  }

  function renderHistoryRuns(runs) {
    elements.historyRuns.replaceChildren();
    const values = Array.isArray(runs) ? runs : [];
    if (!values.length) return;
    values.slice(0, 40).forEach((run) => {
      const status = String(run?.status ?? 'error');
      const line = element('div', `history-run ${status}`);
      const summary = `${formatDate(run?.at)} · ${status}${run?.matchCount == null ? '' : ` · ${run.matchCount}개 일치`}`;
      line.append(element('strong', '', summary));
      if (run?.message) line.append(element('span', '', run.message));
      elements.historyRuns.append(line);
    });
  }

  function renderHistoryEntries(activeIndex = 0) {
    elements.historyEntries.replaceChildren();
    activeHistoryEntries.forEach((entry, index) => {
      const button = element('button', `history-entry${index === activeIndex ? ' active' : ''}`);
      button.type = 'button';
      button.dataset.historyIndex = String(index);
      const kind = entry.kind === 'baseline' ? '기준값' : entry.kind === 'evidence' ? '선택 실패 화면' : '변경 기록';
      button.append(
        element('strong', '', kind),
        element('span', '', `${formatDate(entry.capturedAt ?? entry.snapshot?.capturedAt)} · ${entry.snapshot?.matchCount ?? 0}개 일치`)
      );
      elements.historyEntries.append(button);
    });
  }

  function renderHistoryEntry(index) {
    const selectedIndex = Math.min(Math.max(Number(index) || 0, 0), Math.max(activeHistoryEntries.length - 1, 0));
    const current = activeHistoryEntries[selectedIndex];
    if (!current) {
      elements.historyWhen.textContent = '저장된 스냅샷이 없습니다.';
      renderSnapshotDiff(null, null, activeHistoryUrl, {
        previousSnapshot: elements.historyPreviousSnapshot,
        currentSnapshot: elements.historyCurrentSnapshot
      });
      return;
    }
    const previous = activeHistoryEntries[selectedIndex + 1] ?? null;
    elements.historyWhen.textContent = `${current.kind === 'baseline' ? '기준값' : current.kind === 'evidence' ? '선택 실패' : '변경'} · ${formatDate(current.capturedAt ?? current.snapshot?.capturedAt)}`;
    renderHistoryEntries(selectedIndex);
    renderSnapshotDiff(previous?.snapshot ?? null, current.snapshot ?? null, activeHistoryUrl, {
      previousSnapshot: elements.historyPreviousSnapshot,
      currentSnapshot: elements.historyCurrentSnapshot
    });
  }

  function openHistory(monitor) {
    const stored = Array.isArray(monitor.history) ? monitor.history.filter((entry) => entry?.snapshot) : [];
    activeHistoryEntries = stored.length
      ? stored
      : monitor.snapshot ? [{ kind: 'baseline', capturedAt: monitor.snapshot.capturedAt, snapshot: monitor.snapshot }] : [];
    activeHistoryUrl = monitor.url;
    elements.historyTitle.textContent = `${monitor.name} 기록`;
    elements.historyDescription.textContent = activeHistoryEntries.length
      ? `저장된 기준값과 변경 결과 ${activeHistoryEntries.length}개를 최신순으로 표시합니다.`
      : '저장된 스냅샷이 없습니다. 먼저 확인을 실행해 기준값을 만드세요.';
    renderHistoryRuns(monitor.runs);
    renderHistoryEntry(0);
    elements.historyDialog.showModal();
  }

  function openEvidence(monitor) {
    if (!monitor.lastErrorSnapshot?.evidenceHtml) {
      showToast('선택 실패 당시의 화면 증거가 없습니다. 다시 확인한 뒤 시도해 주세요.');
      return;
    }
    activeHistoryEntries = [{
      kind: 'evidence',
      capturedAt: monitor.lastErrorSnapshot.capturedAt ?? monitor.lastCheckedAt,
      snapshot: evidenceSnapshot(monitor.lastErrorSnapshot)
    }];
    activeHistoryUrl = monitor.url;
    elements.historyTitle.textContent = `${monitor.name} · 선택 실패 화면`;
    elements.historyDescription.textContent = '선택 결과가 비었을 때 저장한 정제된 페이지 증거입니다. 마지막 정상 기준값은 변경하지 않았습니다.';
    renderHistoryRuns(monitor.runs);
    renderHistoryEntry(0);
    elements.historyDialog.showModal();
  }

  function closeDialog(dialog) {
    if (!dialog?.open) return;
    try {
      dialog.close();
    } catch {
      // A dialog can be removed while a storage refresh is pending.
    }
  }

  function closeChangeDialog() {
    closeDialog(elements.changeDialog);
  }

  async function acknowledgeChange() {
    const id = elements.changeDialog.dataset.id;
    closeChangeDialog();
    try {
      const response = await send({ type: 'acknowledge-monitor', id });
      if (!response?.ok) {
        throw new Error(response?.error || 'Could not mark the change as reviewed.');
      }
      await refresh();
    } catch (error) {
      showToast(error.message || 'Could not mark the change as reviewed.');
    }
  }

  async function actionCheck(monitor, button) {
    button.disabled = true;
    button.textContent = '확인 중…';
    try {
      const response = await send({ type: 'check-monitor', id: monitor.id });
      if (!response?.ok) throw new Error(response?.error || '확인하지 못했습니다.');
      showToast(response.needsReview
        ? '요소를 찾지 못했습니다. 로그인 상태나 페이지 구성을 확인해 주세요.'
        : response.changed ? '변경을 감지했습니다.' : '변경 없이 최신 상태입니다.');
    } catch (error) {
      showToast(error.message || '확인하지 못했습니다.');
    }
    await refresh();
  }

  async function actionCheckPage(page, button) {
    button.disabled = true;
    button.textContent = '확인 중…';
    try {
      const response = await send({ type: 'check-page', url: page.url });
      if (!response?.ok) throw new Error(response?.error || '페이지를 확인하지 못했습니다.');
      showToast(response.needsReview && response.changed
        ? '변경을 감지했고, 일부 요소는 찾지 못했습니다. 로그인 상태나 페이지 구성을 확인해 주세요.'
        : response.needsReview
          ? '일부 요소를 찾지 못했습니다. 로그인 상태나 페이지 구성을 확인해 주세요.'
          : response.changed ? '변경을 감지했습니다.' : '이 페이지의 추적을 최신 상태로 확인했습니다.');
    } catch (error) {
      showToast(error.message || '페이지를 확인하지 못했습니다.');
    }
    await refresh();
  }

  async function actionCheckSelected() {
    const ids = [...selectedMonitorIds].filter((id) => Boolean(monitorById(id)));
    if (!ids.length) {
      elements.bulkStatus.textContent = '확인할 추적을 선택해 주세요.';
      renderSelectionControls();
      return;
    }

    batchActionRunning = true;
    let completed = 0;
    let changed = 0;
    let needsReview = 0;
    let failed = 0;
    let lastError = '';
    void renderMonitorList();

    try {
      for (let start = 0; start < ids.length; start += SELECTED_CHECK_CHUNK_SIZE) {
        const chunk = ids.slice(start, start + SELECTED_CHECK_CHUNK_SIZE);
        elements.bulkStatus.textContent = `${ids.length}개 중 ${start + 1}–${Math.min(start + chunk.length, ids.length)}개를 확인하는 중…`;
        try {
          const response = await send({ type: 'check-monitors', ids: chunk });
          if (!response?.ok) throw new Error(response?.error || '선택한 추적을 확인하지 못했습니다.');
          completed += response.completed ?? 0;
          changed += response.changed ?? 0;
          needsReview += response.needsReview ?? 0;
          failed += response.failed ?? 0;
        } catch (error) {
          failed += chunk.length;
          lastError = error.message || '선택한 추적을 확인하지 못했습니다.';
        }
        await refresh();
      }

      const summary = `${completed}개 확인 완료${changed ? ` · 변경 ${changed}개` : ''}${needsReview ? ` · 확인 필요 ${needsReview}개` : ''}${failed ? ` · 실패 ${failed}개` : ''}`;
      elements.bulkStatus.textContent = lastError ? `${summary} · ${lastError}` : summary;
      showToast(lastError ? `${summary} (${lastError})` : summary);
    } finally {
      batchActionRunning = false;
      void renderMonitorList();
    }
  }

  function selectedMonitorIdsForAction() {
    return [...selectedMonitorIds].filter((id) => Boolean(monitorById(id)));
  }

  async function actionUpdateSelectedLabels(mode) {
    const ids = selectedMonitorIdsForAction();
    if (!ids.length) {
      elements.bulkStatus.textContent = '라벨을 변경할 추적을 선택해 주세요.';
      renderSelectionControls();
      return;
    }

    const verb = mode === 'add' ? '추가할' : '제거할';
    const label = window.prompt(`선택한 ${ids.length}개 추적에 ${verb} 라벨을 입력하세요.`);
    if (label === null) return;
    if (!label.trim()) {
      elements.bulkStatus.textContent = '라벨을 입력해 주세요.';
      return;
    }

    batchActionRunning = true;
    elements.bulkStatus.textContent = `선택한 ${ids.length}개 추적의 라벨을 ${mode === 'add' ? '추가' : '제거'}하는 중…`;
    void renderMonitorList();
    try {
      const response = await send({ type: 'update-monitor-labels', mode, label, ids });
      if (!response?.ok) throw new Error(response?.error || '라벨을 변경하지 못했습니다.');
      const summary = `${response.updated ?? 0}개 추적의 라벨을 ${mode === 'add' ? '추가' : '제거'}했습니다.`;
      const details = [
        response.skipped ? `${response.skipped}개 건너뜀` : '',
        response.missing ? `${response.missing}개 찾지 못함` : ''
      ].filter(Boolean).join(' · ');
      elements.bulkStatus.textContent = details ? `${summary} ${details}` : summary;
      showToast(details ? `${summary} ${details}` : summary);
      await refresh();
    } catch (error) {
      const message = error.message || '라벨을 변경하지 못했습니다.';
      elements.bulkStatus.textContent = message;
      showToast(message);
    } finally {
      batchActionRunning = false;
      void renderMonitorList();
    }
  }

  async function actionDeleteSelected() {
    const ids = selectedMonitorIdsForAction();
    if (!ids.length) {
      elements.bulkStatus.textContent = '삭제할 추적을 선택해 주세요.';
      renderSelectionControls();
      return;
    }
    if (!window.confirm(`선택한 ${ids.length}개 페이지 추적을 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) return;

    batchActionRunning = true;
    elements.bulkStatus.textContent = `선택한 ${ids.length}개 페이지 추적을 삭제하는 중…`;
    void renderMonitorList();
    try {
      const response = await send({ type: 'delete-monitors', ids });
      if (!response?.ok) throw new Error(response?.error || '선택한 추적을 삭제하지 못했습니다.');
      ids.forEach((id) => selectedMonitorIds.delete(id));
      const summary = `${response.deletedCount ?? 0}개 페이지 추적을 삭제했습니다.`;
      const detail = response.missing ? ` ${response.missing}개는 이미 없었습니다.` : '';
      elements.bulkStatus.textContent = `${summary}${detail}`;
      showToast(`${summary}${detail}`);
      await refresh();
    } catch (error) {
      const message = error.message || '선택한 추적을 삭제하지 못했습니다.';
      elements.bulkStatus.textContent = message;
      showToast(message);
    } finally {
      batchActionRunning = false;
      void renderMonitorList();
    }
  }

  async function actionGrant(monitor) {
    if (!await requestSitePermission(monitor.url)) {
      showToast('권한을 허용하지 않았습니다.');
      return;
    }
    const response = await send({ type: 'set-monitor-enabled', id: monitor.id, enabled: true });
    showToast(response?.ok ? '권한을 허용하고 추적을 시작했습니다.' : (response?.error || '추적을 시작하지 못했습니다.'));
    await refresh();
  }

  async function handlePageAction(action, page, button) {
    switch (action) {
      case 'check-page':
        await actionCheckPage(page, button);
        break;
      case 'move-page-url':
        openPageUrlDialog(page, 'move');
        break;
      case 'copy-page-url':
        openPageUrlDialog(page, 'copy');
        break;
      case 'delete-page':
        if (!window.confirm(`“${pagePath(page.url)}” 페이지의 ${page.monitors.length}개 추적을 모두 삭제할까요?`)) return;
        {
          const response = await send({ type: 'delete-page', url: page.url });
          showToast(response?.ok ? `${response.deletedCount}개 추적을 삭제했습니다.` : (response?.error || '페이지 추적을 삭제하지 못했습니다.'));
          await refresh();
        }
        break;
      default:
        break;
    }
  }

  async function handleCardAction(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;

    if (button.dataset.url) {
      const page = pageByUrl(button.dataset.url);
      if (page) await handlePageAction(button.dataset.action, page, button);
      return;
    }

    const monitor = monitorById(button.dataset.id);
    if (!monitor) return;
    switch (button.dataset.action) {
      case 'change':
      case 'history':
      case 'evidence': {
        button.disabled = true;
        try {
          const detail = await loadMonitorDetail(monitor.id);
          if (button.dataset.action === 'change') openChange(detail);
          else if (button.dataset.action === 'history') openHistory(detail);
          else openEvidence(detail);
        } catch (error) {
          showToast(error.message || '추적 세부 정보를 불러오지 못했습니다.');
        } finally {
          button.disabled = false;
        }
        break;
      }
      case 'live': {
        button.disabled = true;
        try {
          const response = await send({ type: 'start-live-monitor', id: monitor.id });
          if (!response?.ok) throw new Error(response?.error || '실시간 감시를 시작하지 못했습니다.');
          showToast(response.initial?.needsReview
            ? '실시간 감시는 연결했지만 현재 선택 결과가 비어 있습니다.'
            : '열려 있는 페이지에 실시간 감시를 연결했습니다.');
          await refresh();
        } catch (error) {
          showToast(error.message || '실시간 감시를 시작하지 못했습니다.');
        } finally {
          button.disabled = false;
        }
        break;
      }
      case 'check':
        await actionCheck(monitor, button);
        break;
      case 'open': {
        const response = await send({ type: 'open-monitor-window', id: monitor.id });
        if (!response?.ok) showToast(response?.error || '작은 창을 열지 못했습니다.');
        break;
      }
      case 'open-tab': {
        const response = await send({ type: 'open-monitor-tab', id: monitor.id });
        if (!response?.ok) showToast(response?.error || '새 탭을 열지 못했습니다.');
        break;
      }
      case 'edit':
        openEditor(monitor);
        break;
      case 'grant':
        await actionGrant(monitor);
        break;
      case 'toggle': {
        if (!monitor.enabled && monitor.status === 'permission-needed') {
          await actionGrant(monitor);
          break;
        }
        const response = await send({ type: 'set-monitor-enabled', id: monitor.id, enabled: !monitor.enabled });
        if (!response?.ok && response?.reason === 'permission') {
          await actionGrant(monitor);
          break;
        }
        showToast(response?.ok
          ? (monitor.enabled ? '일시정지했습니다.' : '추적을 다시 시작했습니다.')
          : (response?.error || '상태를 바꾸지 못했습니다.'));
        await refresh();
        break;
      }
      case 'delete': {
        if (!window.confirm(`“${monitor.name}” 추적을 삭제할까요?`)) return;
        const response = await send({ type: 'delete-monitor', id: monitor.id });
        showToast(response?.ok ? '삭제했습니다.' : (response?.error || '삭제하지 못했습니다.'));
        await refresh();
        break;
      }
      default:
        break;
    }
  }

  // Unlike TextEncoder.encode(), this calculates the UTF-8 byte length without
  // allocating a second byte array as large as an export record.
  function utf8ByteLength(value) {
    let length = 0;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code <= 0x7f) length += 1;
      else if (code <= 0x7ff) length += 2;
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          length += 4;
          index += 1;
        } else {
          length += 3;
        }
      } else length += 3;
    }
    return length;
  }

  function createExportPart(exportedAt, exportId, partNumber) {
    const prefix = `${JSON.stringify({
      format: 'openstill-export',
      schemaVersion: 4,
      exportedAt,
      exportId,
      part: partNumber
    }).slice(0, -1)},"monitors":[`;
    const divider = '],"fragments":[';
    const suffix = ']}';
    return {
      monitorParts: [prefix],
      fragmentParts: [],
      divider,
      suffix,
      exportedAt,
      exportId,
      partNumber,
      integrityState: backupIntegrity.createChecksumState(),
      // The final prefix contains counts, the checksum, and completion
      // metadata. Reserve more than its maximum practical size so the exact
      // Blob remains below the same 32 MiB safety boundary.
      byteLength: utf8ByteLength(prefix) + utf8ByteLength(divider) + utf8ByteLength(suffix)
        + EXPORT_INTEGRITY_METADATA_RESERVE_BYTES,
      monitorCount: 0,
      fragmentCount: 0
    };
  }

  function hasExportPartData(part) {
    return part.monitorCount > 0 || part.fragmentCount > 0;
  }

  function canAppendExportPartValue(part, countKey, valueBytes) {
    const delimiterBytes = part[countKey] ? 1 : 0;
    return part.byteLength + delimiterBytes + valueBytes < MAX_EXPORT_FILE_BYTES;
  }

  async function appendExportPartValue(part, partsKey, countKey, value, valueBytes) {
    const delimiter = part[countKey] ? ',' : '';
    part[partsKey].push(delimiter, value);
    part.byteLength += utf8ByteLength(delimiter) + valueBytes;
    part[countKey] += 1;
    await backupIntegrity.appendSerializedRecordChunked(
      part.integrityState,
      partsKey === 'fragmentParts' ? 'fragment' : 'monitor',
      value,
      yieldToBrowser
    );
  }

  function exportPartBlobParts(part, finalPart, totalMonitors) {
    const prefix = `${JSON.stringify({
      format: 'openstill-export',
      schemaVersion: 4,
      exportedAt: part.exportedAt,
      exportId: part.exportId,
      part: part.partNumber,
      integrityRequired: true,
      integrity: backupIntegrity.createIntegrityMetadata(part.integrityState, {
        monitorCount: part.monitorCount,
        fragmentCount: part.fragmentCount,
        finalPart,
        totalParts: part.partNumber,
        totalMonitors
      })
    }).slice(0, -1)},"monitors":[`;
    return [prefix, ...part.monitorParts.slice(1), part.divider, ...part.fragmentParts, part.suffix];
  }

  function settleExportDownload(downloadId, state) {
    const pending = exportDownloadUrls.get(downloadId);
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    URL.revokeObjectURL(pending.url);
    exportDownloadUrls.delete(downloadId);
    if (state === 'complete') {
      pending.resolve?.();
    } else {
      pending.reject?.(new Error(`“${pending.filename}” 다운로드가 중단되었습니다.`));
    }
  }

  function waitForExportDownload(downloadId, url, filename) {
    if (!chrome.downloads?.onChanged) {
      window.setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1_000);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        const pending = exportDownloadUrls.get(downloadId);
        if (!pending) return;
        clearTimeout(pending.timeoutId);
        URL.revokeObjectURL(pending.url);
        exportDownloadUrls.delete(downloadId);
        reject(new Error(`“${filename}” 다운로드 완료를 확인하지 못했습니다.`));
      }, 10 * 60 * 1_000);
      exportDownloadUrls.set(downloadId, { url, filename, resolve, reject, timeoutId });
    });
  }

  async function downloadExportPart(part, exportedAt, partNumber, finalPart, totalMonitors) {
    const blob = new Blob(exportPartBlobParts(part, finalPart, totalMonitors), { type: 'application/json' });
    if (blob.size >= MAX_EXPORT_FILE_BYTES) {
      throw new Error('내보내기 파일 한도를 넘는 데이터 묶음을 만들었습니다.');
    }
    const url = URL.createObjectURL(blob);
    const filename = `openstill-export-${exportedAt.slice(0, 10)}-part-${String(partNumber).padStart(3, '0')}.json`;
    if (chrome.downloads?.download) {
      try {
        const downloadId = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
        const completed = waitForExportDownload(downloadId, url, filename);
        if (chrome.downloads.search) {
          try {
            const [download] = await chrome.downloads.search({ id: downloadId });
            if (download?.state === 'complete' || download?.state === 'interrupted') {
              settleExportDownload(downloadId, download.state);
            }
          } catch {
            // onChanged remains the normal completion signal.
          }
        }
        await completed;
      } catch (error) {
        URL.revokeObjectURL(url);
        throw error;
      }
    } else {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
    }
    if (!chrome.downloads?.download) window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  async function exportMonitors() {
    if (transferRunning || dashboardLoading) return;
    let total = state.monitors.length;
    let completed = 0;
    let exportSessionId = '';
    let exportKeepaliveTimer = null;
    beginTransfer('내보내는 중', total);
    try {
      const started = await send({ type: 'start-export-session' });
      if (!started?.ok) throw new Error(started?.error || '내보낼 데이터를 준비하지 못했습니다.');
      exportSessionId = started.id;
      exportKeepaliveTimer = window.setInterval(() => {
        if (!exportSessionId) return;
        void send({ type: 'touch-export-session', id: exportSessionId }).catch(() => undefined);
      }, 20_000);
      total = started.total || 0;
      updateTransferProgress('내보내는 중', 0, total);
      // Serialise a modest number of records at once. This keeps a large
      // snapshot backup from blocking dashboard painting for one long task.
      if (showsTransferProgress(total)) await yieldToBrowser();
      const exportedAt = new Date().toISOString();
      const exportId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      let partNumber = 1;
      let part = createExportPart(exportedAt, exportId, partNumber);
      const flushExportPart = async () => {
        if (!hasExportPartData(part)) return;
        await downloadExportPart(part, exportedAt, partNumber, false, total);
        partNumber += 1;
        part = createExportPart(exportedAt, exportId, partNumber);
      };
      const appendExportPartValueSafely = async (partsKey, countKey, value) => {
        const valueBytes = await utf8ByteLengthYielding(value);
        if (!canAppendExportPartValue(part, countKey, valueBytes) && hasExportPartData(part)) {
          await flushExportPart();
        }
        if (!canAppendExportPartValue(part, countKey, valueBytes)) {
          throw new Error('내보낼 데이터 조각이 32 MB 파일 분할 기준을 넘습니다.');
        }
        await appendExportPartValue(part, partsKey, countKey, value, valueBytes);
        return valueBytes;
      };
      const chunkSize = transferChunkSize(total);
      let bytesSinceYield = 0;
      for (let start = 0; start < total; start += chunkSize) {
        const end = Math.min(start + chunkSize, total);
        for (let index = start; index < end; index += 1) {
          const response = await send({ type: 'get-export-monitor', id: exportSessionId, index });
          if (!response?.ok) {
            throw new Error(response?.error || '내보낼 추적을 불러오지 못했습니다.');
          }
          if (response.fragmented) {
            if (typeof response.recordId !== 'string' || !Number.isInteger(response.fragmentCount) || response.fragmentCount < 1) {
              throw new Error('내보낼 큰 추적 데이터를 나누지 못했습니다.');
            }
            for (let fragmentIndex = 0; fragmentIndex < response.fragmentCount; fragmentIndex += 1) {
              const fragmentResponse = await send({
                type: 'get-export-monitor-fragment',
                id: exportSessionId,
                index,
                fragmentIndex
              });
              if (!fragmentResponse?.ok || typeof fragmentResponse.payload !== 'string') {
                throw new Error(fragmentResponse?.error || '내보낼 추적 조각을 불러오지 못했습니다.');
              }
              const fragment = JSON.stringify({
                recordId: response.recordId,
                fragmentIndex,
                fragmentCount: response.fragmentCount,
                payload: fragmentResponse.payload
              });
              const fragmentBytes = await appendExportPartValueSafely('fragmentParts', 'fragmentCount', fragment);
              bytesSinceYield += fragmentBytes;
              if (bytesSinceYield >= TRANSFER_YIELD_BYTE_BUDGET) {
                await yieldToBrowser();
                bytesSinceYield = 0;
              }
            }
          } else if (typeof response.record === 'string') {
            const recordBytes = await appendExportPartValueSafely('monitorParts', 'monitorCount', response.record);
            bytesSinceYield += recordBytes;
            if (bytesSinceYield >= TRANSFER_YIELD_BYTE_BUDGET) {
              await yieldToBrowser();
              bytesSinceYield = 0;
            }
          } else {
            throw new Error('내보낼 추적 데이터를 읽지 못했습니다.');
          }
        }
        completed = end;
        updateTransferProgress('내보내는 중', completed, total);
        if (end < total && showsTransferProgress(total)) await yieldToBrowser();
      }
      await downloadExportPart(part, exportedAt, partNumber, true, total);
      finishTransfer('내보내기 완료', total, total);
      showToast(partNumber > 1
        ? `${partNumber}개의 JSON 파일을 저장했습니다.`
        : 'JSON 파일을 저장했습니다.');
    } catch (error) {
      finishTransfer('내보내기 실패', completed, total);
      showToast(error.message || '내보내지 못했습니다.');
    } finally {
      if (exportKeepaliveTimer !== null) window.clearInterval(exportKeepaliveTimer);
      if (exportSessionId) await send({ type: 'finish-export-session', id: exportSessionId }).catch(() => undefined);
    }
  }

  function importMonitorPayload(payload) {
    if (payload?.format === 'openstill-export' && [2, 3].includes(payload?.schemaVersion) && Array.isArray(payload?.monitors)) {
      return { monitors: payload.monitors, fragments: [] };
    }
    if (payload?.format === 'openstill-export' && payload?.schemaVersion === 4
      && Array.isArray(payload?.monitors) && Array.isArray(payload?.fragments)) {
      return { monitors: payload.monitors, fragments: payload.fragments };
    }
    // Reference Chrome backups are either the bare sieve array or a wrapper
    // with `sieves`. Keep the records intact; the worker performs the typed
    // selector/schedule conversion and rejects unsupported data sources.
    if (Array.isArray(payload)) return { monitors: payload, fragments: [] };
    if (Array.isArray(payload?.sieves)) return { monitors: payload.sieves, fragments: [] };
    if (Array.isArray(payload?.sieve_backup)) return { monitors: payload.sieve_backup, fragments: [] };
    return null;
  }

  function parseImportFile(file, onProgress) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(chrome.runtime.getURL('import-worker.js'));
      const finish = () => worker.terminate();
      worker.addEventListener('message', (event) => {
        const message = event.data;
        if (message?.type === 'read-progress' || message?.type === 'parsing') {
          onProgress?.(message);
        } else if (message?.type === 'parsed') {
          finish();
          resolve({ payload: message.payload, backupPart: message.backupPart ?? null });
        } else if (message?.type === 'error') {
          finish();
          reject(new Error(message.error || 'JSON 파일을 읽지 못했습니다.'));
        }
      }, { once: false });
      worker.addEventListener('error', () => {
        finish();
        reject(new Error('JSON 파일을 해석하지 못했습니다.'));
      }, { once: true });
      worker.postMessage({ type: 'parse', file });
    });
  }

  async function splitLargeImportMonitors(monitors, fileIndex) {
    const directMonitors = [];
    const fragments = [];
    const importId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${fileIndex}`;
    let bytesSinceYield = 0;
    for (let monitorIndex = 0; monitorIndex < monitors.length; monitorIndex += 1) {
      const monitor = monitors[monitorIndex];
      const record = JSON.stringify(monitor);
      const recordBytes = await utf8ByteLengthYielding(record);
      if (monitor && typeof monitor === 'object') importRecordByteLengths.set(monitor, recordBytes);
      bytesSinceYield += recordBytes;
      // Reserve the message envelope as well as the 32 MiB part buffer. A
      // large legacy/Reference record is represented in the same v4 fragment
      // form as a record that crossed the export-file boundary.
      if (recordBytes + 1_024 < MAX_IMPORT_MESSAGE_BYTES) {
        directMonitors.push(monitor);
      } else {
        const fragmentCount = Math.ceil(record.length / IMPORT_RECORD_FRAGMENT_CHARS);
        for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex += 1) {
          const start = fragmentIndex * IMPORT_RECORD_FRAGMENT_CHARS;
          fragments.push({
            recordId: `${importId}:${monitorIndex}`,
            fragmentIndex,
            fragmentCount,
            payload: record.slice(start, start + IMPORT_RECORD_FRAGMENT_CHARS)
          });
        }
      }
      if (bytesSinceYield >= TRANSFER_YIELD_BYTE_BUDGET
        || (monitors.length >= BULK_TRANSFER_THRESHOLD && (monitorIndex + 1) % BULK_TRANSFER_CHUNK_SIZE === 0)) {
        await yieldToBrowser();
        bytesSinceYield = 0;
      }
    }
    return { monitors: directMonitors, fragments };
  }

  async function importMonitors(fileList) {
    const files = [...(fileList ?? [])];
    if (!files.length) return;
    if (transferRunning || dashboardLoading) return;
    // Reading a large file is asynchronous. Reserve the transfer before its
    // record count is known so a second picker selection cannot overlap it.
    transferRunning = true;
    beginTransfer('불러오기 준비 중', 0);
    let total = 0;
    let completed = 0;
    let processedUnits = 0;
    let transferStarted = false;
    let importSessionId = '';
    let importKeepaliveTimer = null;
    const backupParts = [];
    let allFilesVerified = true;
    const summary = { imported: 0, rejected: 0, disabledForPermission: 0 };
    try {
      for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
        const file = files[fileIndex];
        const parsingLabel = files.length > 1
          ? `불러오기 파일 분석 중 (${fileIndex + 1}/${files.length})`
          : '불러오기 파일 분석 중';
        updateImportFileProgress(parsingLabel, 0, file.size || 0);
        const parsedFile = await parseImportFile(file, (progress) => {
          if (progress?.type === 'read-progress') {
            updateImportFileProgress(parsingLabel, progress.loaded || 0, progress.total || file.size || 0);
          } else if (progress?.type === 'parsing') {
            updateImportFileProgress(parsingLabel, 0, 0, true);
          }
        });
        const parsed = parsedFile.payload;
        const importedPayload = importMonitorPayload(parsed);
        if (!importedPayload) {
          throw new Error(`“${file.name || '선택한 파일'}”은(는) OpenStill 또는 Reference 내보내기 파일 형식이 아닙니다.`);
        }
        const backupPart = parsedFile.backupPart
          ? { ...parsedFile.backupPart, sourceName: file.name || `part ${fileIndex + 1}` }
          : null;
        if (backupPart) backupParts.push(backupPart);
        if (!backupPart?.verified) allFilesVerified = false;
        updateImportFileProgress('불러오기 데이터 준비 중', 0, 0, true);
        const splitPayload = await splitLargeImportMonitors(importedPayload.monitors, fileIndex);
        const monitors = splitPayload.monitors;
        const fragments = [...importedPayload.fragments, ...splitPayload.fragments];
        if (!importSessionId) {
          const started = await send({ type: 'start-import-session', mode: 'merge' });
          if (!started?.ok || !started.id) {
            throw new Error(started?.error || '불러오기 작업을 준비하지 못했습니다.');
          }
          importSessionId = started.id;
          importKeepaliveTimer = window.setInterval(() => {
            if (!importSessionId) return;
            void send({ type: 'touch-import-session', id: importSessionId }).catch(() => undefined);
          }, 20_000);
        }
        const fileTotal = monitors.length + fragments.length;
        total = processedUnits + fileTotal;
        completed = processedUnits;
        const label = files.length > 1
          ? `불러오는 중 (${fileIndex + 1}/${files.length})`
          : '불러오는 중';
        beginTransfer(label, total, completed);
        transferStarted = true;
        if (showsTransferProgress(total)) await yieldToBrowser();
        const chunkSize = transferChunkSize(total);

        for (let start = 0; start < monitors.length;) {
          const chunk = await nextImportChunk(monitors, start, chunkSize);
          const { end } = chunk;
          const response = await send({
            type: 'append-import-session',
            id: importSessionId,
            monitors: chunk.monitors,
          });
          if (!response?.ok) throw new Error(response?.error || '불러오지 못했습니다.');
          completed = processedUnits + end;
          updateTransferProgress(label, completed, total);
          if (end < monitors.length && showsTransferProgress(total)) await yieldToBrowser();
          start = end;
        }
        for (let start = 0; start < fragments.length;) {
          const chunk = await nextImportChunk(fragments, start, chunkSize);
          const { end } = chunk;
          const response = await send({
            type: 'append-import-fragments',
            id: importSessionId,
            fragments: chunk.monitors,
          });
          if (!response?.ok) throw new Error(response?.error || '큰 추적 데이터를 불러오지 못했습니다.');
          completed = processedUnits + monitors.length + end;
          updateTransferProgress(label, completed, total);
          if (end < fragments.length && showsTransferProgress(total)) await yieldToBrowser();
          start = end;
        }
        processedUnits += fileTotal;
        completed = processedUnits;
        total = processedUnits;
      }
      const selectionValidation = backupIntegrity.validateBackupPartSelection(backupParts, {
        totalFiles: files.length
      });
      if (!selectionValidation.ok) {
        throw new Error(selectionValidation.error || '백업 part 구성을 확인하지 못했습니다.');
      }
      let finalized = null;
      if (importSessionId) {
        finalized = await send({
          type: 'finish-import-session',
          id: importSessionId,
          requireAllValid: allFilesVerified
        });
        if (!finalized?.ok) throw new Error(finalized?.error || '불러온 추적을 준비하지 못했습니다.');
        summary.imported = finalized.imported || 0;
        summary.rejected = finalized.rejected || 0;
        summary.disabledForPermission = finalized.disabledForPermission || 0;
        importSessionId = '';
      }
      finishTransfer('불러오기 완료', completed, total);
      transferStarted = false;
      showToast(`${summary.imported}개를 불러왔습니다.${summary.rejected ? ` ${summary.rejected}개는 유효하지 않거나 최대 5,000개 제한을 넘어 제외했습니다.` : ''}${summary.disabledForPermission ? ` ${summary.disabledForPermission}개는 사이트 권한을 허용한 뒤 시작하세요.` : ''}${finalized?.finalizationWarnings ? ' 데이터 저장은 완료됐으며, 후속 상태 갱신은 다음 실행 때 다시 처리됩니다.' : ''}`);
      queueDashboardRefresh();
    } catch (error) {
      if (importSessionId) await send({ type: 'abort-import-session', id: importSessionId }).catch(() => undefined);
      if (transferStarted) finishTransfer('불러오기 실패', completed, total);
      else finishTransfer('불러오기 실패', 0, 0);
      showToast(error.message || '불러오지 못했습니다.');
    } finally {
      if (importKeepaliveTimer !== null) window.clearInterval(importKeepaliveTimer);
      elements.importInput.value = '';
    }
  }

  elements.monitorList.addEventListener('click', (event) => void handleCardAction(event));
  elements.monitorList.addEventListener('change', (event) => {
    const input = event.target.closest('input[data-select-monitor]');
    if (!input || batchActionRunning) return;
    if (input.checked) selectedMonitorIds.add(input.dataset.selectMonitor);
    else selectedMonitorIds.delete(input.dataset.selectMonitor);
    void renderMonitorList();
  });
  elements.labelList.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-label]');
    if (!button) return;
    filters.label = button.dataset.label;
    void render();
  });
  elements.searchInput.addEventListener('input', () => {
    filters.query = elements.searchInput.value;
    if (searchRenderTimer !== null) clearTimeout(searchRenderTimer);
    searchRenderTimer = setTimeout(() => {
      searchRenderTimer = null;
      void renderMonitorList();
    }, SEARCH_RENDER_DEBOUNCE_MS);
  });
  elements.statusFilter.addEventListener('change', () => { filters.status = elements.statusFilter.value; void renderMonitorList(); });
  const updateSorting = () => {
    sorting.field = SORT_FIELDS.has(elements.sortField.value) ? elements.sortField.value : 'lastViewedAt';
    sorting.direction = SORT_DIRECTIONS.has(elements.sortDirection.value) ? elements.sortDirection.value : 'desc';
    try {
      localStorage.setItem(SORT_PREFERENCE_KEY, JSON.stringify(sorting));
    } catch {
      // Sorting remains fully functional for this session without persistence.
    }
    void renderMonitorList();
  };
  elements.sortField.addEventListener('change', updateSorting);
  elements.sortDirection.addEventListener('change', updateSorting);
  elements.selectVisible.addEventListener('change', () => setVisibleSelection(elements.selectVisible.checked));
  elements.invertSelection.addEventListener('click', invertVisibleSelection);
  elements.clearSelection.addEventListener('click', () => {
    if (batchActionRunning) return;
    selectedMonitorIds.clear();
    elements.bulkStatus.textContent = '';
    void renderMonitorList();
  });
  elements.checkSelected.addEventListener('click', () => void actionCheckSelected());
  elements.addLabelSelected.addEventListener('click', () => void actionUpdateSelectedLabels('add'));
  elements.removeLabelSelected.addEventListener('click', () => void actionUpdateSelectedLabels('remove'));
  elements.deleteSelected.addEventListener('click', () => void actionDeleteSelected());
  elements.soundEnabled.addEventListener('change', async () => {
    await send({ type: 'save-settings', settings: { soundEnabled: elements.soundEnabled.checked } });
    await refresh();
  });
  elements.batchUrlButton.addEventListener('click', openBatchUrlDialog);
  elements.exportButton.addEventListener('click', () => void exportMonitors());
  elements.importButton.addEventListener('click', () => elements.importInput.click());
  elements.importInput.addEventListener('change', () => void importMonitors(elements.importInput.files));
  installAdvancedScheduleControls();
  elements.editDays.addEventListener('change', syncIntervalSecondsFromFriendlyInputs);
  elements.editHours.addEventListener('change', syncIntervalSecondsFromFriendlyInputs);
  elements.editIntervalSeconds.addEventListener('input', updateEditorInterval);
  elements.editRandomMinSeconds.addEventListener('input', updateEditorInterval);
  elements.editRandomMaxSeconds.addEventListener('input', updateEditorInterval);
  elements.editCronExpression.addEventListener('input', updateEditorInterval);
  elements.editCronTimezone.addEventListener('input', updateEditorInterval);
  elements.editScheduleMode.addEventListener('change', updateEditorInterval);
  elements.editorForm.addEventListener('submit', (event) => { event.preventDefault(); void saveEditor(); });
  elements.pageUrlForm.addEventListener('submit', (event) => { event.preventDefault(); void savePageUrl(); });
  elements.batchUrlSource.addEventListener('input', updateBatchUrlPreview);
  elements.batchUrlTarget.addEventListener('input', updateBatchUrlPreview);
  elements.batchUrlForm.addEventListener('submit', (event) => { event.preventDefault(); void saveBatchUrl(); });
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-close-dialog]');
    if (!button) return;
    closeDialog(document.getElementById(button.dataset.closeDialog));
  });
  elements.changeOpenPage.addEventListener('click', async () => {
    const response = await send({ type: 'open-monitor-window', id: elements.changeDialog.dataset.id });
    if (!response?.ok) showToast(response?.error || '작은 창을 열지 못했습니다.');
  });
  elements.changeOpenPageTab.addEventListener('click', async () => {
    const response = await send({ type: 'open-monitor-tab', id: elements.changeDialog.dataset.id });
    if (!response?.ok) showToast(response?.error || '새 탭을 열지 못했습니다.');
  });
  elements.acknowledgeButton.addEventListener('click', () => void acknowledgeChange());
  elements.historyEntries.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-history-index]');
    if (button) renderHistoryEntry(Number(button.dataset.historyIndex));
  });
  if (chrome.downloads?.onChanged) {
    chrome.downloads.onChanged.addListener((delta) => {
      if (!delta.state || !['complete', 'interrupted'].includes(delta.state.current)) return;
      settleExportDownload(delta.id, delta.state.current);
    });
  }

  function queueDashboardRefresh() {
    if (transferRunning || dashboardLoading) {
      refreshPending = true;
      return;
    }
    if (refreshQueued) return;
    refreshQueued = true;
    refreshQueueTimer = setTimeout(() => {
      refreshQueueTimer = null;
      refreshQueued = false;
      if (transferRunning || dashboardLoading) {
        refreshPending = true;
        return;
      }
      void refresh();
    }, 100);
  }

  function flushQueuedDashboardRefresh() {
    if (!refreshPending || transferRunning || dashboardLoading) return;
    refreshPending = false;
    queueDashboardRefresh();
  }

  chrome.storage.onChanged.addListener(queueDashboardRefresh);

  populateIntervalSelects();
  void refresh().catch((error) => showToast(error.message || '데이터를 불러오지 못했습니다.'));
})();
