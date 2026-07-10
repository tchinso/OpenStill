(() => {
  const MIN_HOURS = 1;
  const MAX_HOURS = 14 * 24;
  const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
  const state = { monitors: [], settings: { soundEnabled: true } };
  const filters = { label: '', status: 'all', query: '' };
  let toastTimer;

  const elements = {
    soundEnabled: document.querySelector('#soundEnabled'),
    exportButton: document.querySelector('#exportButton'),
    importButton: document.querySelector('#importButton'),
    importInput: document.querySelector('#importInput'),
    searchInput: document.querySelector('#searchInput'),
    statusFilter: document.querySelector('#statusFilter'),
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
    editSelector: document.querySelector('#editSelector'),
    editLabels: document.querySelector('#editLabels'),
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
    changeDialog: document.querySelector('#changeDialog'),
    changeTitle: document.querySelector('#changeTitle'),
    changeWhen: document.querySelector('#changeWhen'),
    previousSnapshot: document.querySelector('#previousSnapshot'),
    currentSnapshot: document.querySelector('#currentSnapshot'),
    changeOpenPage: document.querySelector('#changeOpenPage'),
    acknowledgeButton: document.querySelector('#acknowledgeButton'),
    toast: document.querySelector('#toast')
  };

  function send(message) {
    return chrome.runtime.sendMessage(message);
  }

  function element(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function formatDuration(hours) {
    const numeric = Number(hours);
    const days = Math.floor(numeric / 24);
    const rest = numeric % 24;
    return `${days ? `${days}일` : ''}${days && rest ? ' ' : ''}${rest ? `${rest}시간` : ''}` || '0시간';
  }

  function formatDate(iso) {
    const timestamp = Date.parse(iso ?? '');
    if (!Number.isFinite(timestamp)) return '아직 없음';
    return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
  }

  function timestampOf(monitor) {
    return Date.parse(monitor.lastChangedAt ?? monitor.lastReviewAt ?? monitor.updatedAt ?? 0) || 0;
  }

  function hostname(url) {
    try { return new URL(url).hostname; } catch { return url; }
  }

  function originOf(url) {
    try { return new URL(url).origin; } catch { return url; }
  }

  function pagePath(url) {
    try {
      const parsed = new URL(url);
      return `${parsed.pathname === '/' ? '홈' : parsed.pathname}${parsed.search}`;
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
      const origins = [sitePattern(url)];
      return await chrome.permissions.contains({ origins }) || await chrome.permissions.request({ origins });
    } catch (error) {
      showToast(error.message || '사이트 접근 권한을 요청할 수 없습니다.');
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
    if (left.unread !== right.unread) return left.unread ? -1 : 1;
    if (needsAttention(left) !== needsAttention(right)) return needsAttention(left) ? -1 : 1;
    return timestampOf(right) - timestampOf(left);
  }

  function monitorMatchesFilters(monitor) {
    if (filters.label && !(monitor.labels ?? []).some((label) => label.toLocaleLowerCase('ko-KR') === filters.label)) return false;
    if (filters.status === 'changed' && !monitor.unread) return false;
    if (filters.status === 'active' && !monitor.enabled) return false;
    if (filters.status === 'attention' && !needsAttention(monitor)) return false;
    if (filters.status === 'paused' && monitor.enabled) return false;
    const query = filters.query.trim().toLocaleLowerCase('ko-KR');
    if (!query) return true;
    const haystack = [monitor.name, monitor.url, monitor.selector, ...(monitor.labels ?? [])]
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

    return [...sites.values()]
      .map((site) => ({
        ...site,
        pages: [...site.pagesByUrl.values()].sort((left, right) => {
          const leftTime = Math.max(...left.monitors.map(timestampOf));
          const rightTime = Math.max(...right.monitors.map(timestampOf));
          return rightTime - leftTime;
        })
      }))
      .sort((left, right) => {
        const leftUnread = left.allMonitors.some((monitor) => monitor.unread);
        const rightUnread = right.allMonitors.some((monitor) => monitor.unread);
        if (leftUnread !== rightUnread) return leftUnread ? -1 : 1;
        const leftAttention = left.allMonitors.some(needsAttention);
        const rightAttention = right.allMonitors.some(needsAttention);
        if (leftAttention !== rightAttention) return leftAttention ? -1 : 1;
        const leftTime = Math.max(...left.allMonitors.map(timestampOf));
        const rightTime = Math.max(...right.allMonitors.map(timestampOf));
        return rightTime - leftTime;
      });
  }

  function getFilteredSiteGroups() {
    return groupMonitorsBySite(state.monitors)
      .map((site) => {
        const pages = site.pages
          .map((page) => ({
            ...page,
            visibleMonitors: page.monitors.filter(monitorMatchesFilters).sort(compareMonitors)
          }))
          .filter((page) => page.visibleMonitors.length);
        return { ...site, pages };
      })
      .filter((site) => site.pages.length);
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
    const card = element('article', `tracking-card${monitor.unread ? ' unread' : ''}${needsAttention(monitor) ? ' needs-attention' : ''}`);
    const top = element('div', 'tracking-top');
    const title = element('div', 'tracking-title');
    title.append(element('h4', '', monitor.name), element('p', 'selector-preview', monitor.selector));
    const status = statusInfo(monitor);
    top.append(title, element('span', `status ${status.key}`, status.label));
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
    card.append(element('p', 'snapshot-preview', previewText));

    const details = element('div', 'tracking-details');
    const rows = [
      ['간격', formatDuration(monitor.intervalHours)],
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
    if (monitor.status === 'permission-needed') actions.append(makeAction('권한 허용 및 시작', 'grant', monitor.id, 'attention-action'));
    actions.append(
      makeAction('지금 확인', 'check', monitor.id),
      makeAction('작은 창', 'open', monitor.id),
      makeAction('편집', 'edit', monitor.id),
      makeAction(monitor.enabled ? '일시정지' : '다시 시작', 'toggle', monitor.id),
      makeAction('삭제', 'delete', monitor.id, 'attention-action')
    );
    card.append(actions);
    return card;
  }

  function pageCard(page) {
    const pageElement = element('section', 'page-card');
    const top = element('div', 'page-top');
    const heading = element('div', 'page-title');
    const pageTitle = page.monitors.map((monitor) => monitor.pageTitle).find(Boolean);
    heading.append(
      element('h3', '', pageTitle || pagePath(page.url)),
      element('p', 'page-url', page.url)
    );

    const total = page.monitors.length;
    const changed = page.monitors.filter((monitor) => monitor.unread).length;
    const attention = page.monitors.filter(needsAttention).length;
    const summary = element('div', 'page-summary');
    summary.append(element('span', 'page-count', `${page.visibleMonitors.length}/${total}개 추적`));
    if (changed) summary.append(element('span', 'page-badge changed', `변경 ${changed}`));
    if (attention) summary.append(element('span', 'page-badge attention', `확인 ${attention}`));
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
    page.visibleMonitors.forEach((monitor) => tracks.append(monitorCard(monitor)));
    pageElement.append(tracks);
    return pageElement;
  }

  function siteCard(site) {
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
    site.pages.forEach((page) => pages.append(pageCard(page)));
    card.append(pages);
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
      elements.listDescription.textContent = '사이트 → 페이지 → CSS 선택자 순서로 함께 관리합니다.';
    }
    elements.visibleCount.textContent = `${sites.length}개 사이트 · ${visibleMonitorCount}개 추적`;
  }

  function renderMonitors() {
    const sites = getFilteredSiteGroups();
    const visibleMonitorCount = sites.reduce((count, site) => count + site.pages.reduce(
      (pageCount, page) => pageCount + page.visibleMonitors.length,
      0
    ), 0);
    updateListHeading(sites, visibleMonitorCount);
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

  function render() {
    renderOverview();
    renderLabels();
    renderMonitors();
  }

  async function refresh() {
    const response = await send({ type: 'get-state' });
    if (!response?.ok) throw new Error(response?.error || '저장된 데이터를 불러오지 못했습니다.');
    state.monitors = response.monitors ?? [];
    state.settings = response.settings ?? { soundEnabled: true };
    render();
  }

  function showToast(text) {
    clearTimeout(toastTimer);
    elements.toast.textContent = text;
    elements.toast.classList.add('show');
    toastTimer = setTimeout(() => elements.toast.classList.remove('show'), 4_200);
  }

  function monitorById(id) {
    return state.monitors.find((monitor) => monitor.id === id);
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
    elements.editIntervalHelp.textContent = total >= MIN_HOURS && total <= MAX_HOURS
      ? `매 ${formatDuration(total)}마다 확인합니다.`
      : '간격은 최소 1시간, 최대 14일입니다.';
    return total;
  }

  function openEditor(monitor) {
    elements.editId.value = monitor.id;
    elements.editName.value = monitor.name;
    elements.editUrl.value = monitor.url;
    elements.editSelector.value = monitor.selector;
    elements.editLabels.value = (monitor.labels ?? []).join(', ');
    elements.editDays.value = String(Math.floor(monitor.intervalHours / 24));
    elements.editHours.value = String(monitor.intervalHours % 24);
    elements.editEnabled.checked = monitor.enabled;
    elements.editorMessage.textContent = '';
    updateEditorInterval();
    elements.editorDialog.showModal();
  }

  async function saveEditor() {
    const id = elements.editId.value;
    const totalHours = updateEditorInterval();
    const url = elements.editUrl.value.trim();
    const selector = elements.editSelector.value.trim();
    if (!id || !url || !selector || totalHours < MIN_HOURS || totalHours > MAX_HOURS) {
      elements.editorMessage.textContent = '필수 정보와 확인 간격을 확인해 주세요.';
      return;
    }

    let enabled = elements.editEnabled.checked;
    if (enabled && !await requestSitePermission(url)) {
      enabled = false;
      elements.editEnabled.checked = false;
      elements.editorMessage.textContent = '권한을 허용하지 않아 일시정지 상태로 저장합니다.';
    }

    const response = await send({
      type: 'save-monitor',
      id,
      name: elements.editName.value,
      url,
      selector,
      labels: elements.editLabels.value.split(','),
      intervalHours: totalHours,
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

  function pushText(target, text) {
    if (text) target.append(document.createTextNode(text));
  }

  function pushMarkedText(target, text, className) {
    if (!text) return;
    const mark = element(className === 'diff-added' ? 'ins' : 'del', className, text);
    target.append(mark);
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

  function renderWordDiff(previousTarget, currentTarget, previousText, currentText) {
    const operations = buildDiffOperations(tokenize(previousText), tokenize(currentText), 40_000);
    for (const operation of operations) {
      if (operation.type === 'same') {
        pushText(previousTarget, operation.value);
        pushText(currentTarget, operation.value);
      } else if (operation.type === 'removed') {
        pushMarkedText(previousTarget, operation.value, 'diff-removed');
      } else {
        pushMarkedText(currentTarget, operation.value, 'diff-added');
      }
    }
  }

  function appendLineBreak(target) {
    target.append(document.createTextNode('\n'));
  }

  function appendWholeLine(target, text, className) {
    if (className) pushMarkedText(target, text, className);
    else pushText(target, text);
    appendLineBreak(target);
  }

  function renderSnapshotDiff(previousText, currentText) {
    const previousTarget = elements.previousSnapshot;
    const currentTarget = elements.currentSnapshot;
    previousTarget.replaceChildren();
    currentTarget.replaceChildren();

    const before = String(previousText ?? '');
    const after = String(currentText ?? '');
    if (!before && !after) {
      pushText(previousTarget, '(텍스트 없음)');
      pushText(currentTarget, '(텍스트 없음)');
      return;
    }

    const beforeLines = before ? before.split('\n') : [];
    const afterLines = after ? after.split('\n') : [];
    const operations = buildDiffOperations(beforeLines, afterLines);
    let removedLines = [];
    let addedLines = [];

    const flushChangedLines = () => {
      const paired = Math.min(removedLines.length, addedLines.length);
      for (let index = 0; index < paired; index += 1) {
        renderWordDiff(previousTarget, currentTarget, removedLines[index], addedLines[index]);
        appendLineBreak(previousTarget);
        appendLineBreak(currentTarget);
      }
      removedLines.slice(paired).forEach((line) => appendWholeLine(previousTarget, line, 'diff-removed'));
      addedLines.slice(paired).forEach((line) => appendWholeLine(currentTarget, line, 'diff-added'));
      removedLines = [];
      addedLines = [];
    };

    for (const operation of operations) {
      if (operation.type === 'removed') {
        removedLines.push(operation.value);
      } else if (operation.type === 'added') {
        addedLines.push(operation.value);
      } else {
        flushChangedLines();
        appendWholeLine(previousTarget, operation.value);
        appendWholeLine(currentTarget, operation.value);
      }
    }
    flushChangedLines();
  }

  function openChange(monitor) {
    const lastChange = monitor.lastChange;
    const current = lastChange?.current ?? monitor.snapshot;
    elements.changeDialog.dataset.id = monitor.id;
    elements.changeTitle.textContent = monitor.name;
    elements.changeWhen.textContent = `감지 시각: ${formatDate(monitor.lastChangedAt ?? lastChange?.detectedAt)}`;
    renderSnapshotDiff(
      lastChange?.previous?.exists ? lastChange.previous.text : '',
      current?.exists ? current.text : ''
    );
    elements.changeDialog.showModal();
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
        openChange(monitor);
        break;
      case 'check':
        await actionCheck(monitor, button);
        break;
      case 'open': {
        const response = await send({ type: 'open-monitor-window', id: monitor.id });
        if (!response?.ok) showToast(response?.error || '작은 창을 열지 못했습니다.');
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

  function exportMonitors() {
    const payload = {
      format: 'openstill-export',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      monitors: state.monitors
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `openstill-export-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function importMonitors(file) {
    if (!file) return;
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error('8 MB보다 작은 JSON 파일만 불러올 수 있습니다.');
      const parsed = JSON.parse(await file.text());
      if (parsed?.format !== 'openstill-export' || parsed?.schemaVersion !== 1 || !Array.isArray(parsed?.monitors)) {
        throw new Error('OpenStill 내보내기 파일 형식이 아닙니다.');
      }
      const response = await send({ type: 'import-monitors', monitors: parsed.monitors, mode: 'merge' });
      if (!response?.ok) throw new Error(response?.error || '불러오지 못했습니다.');
      showToast(`${response.imported}개를 불러왔습니다.${response.rejected ? ` ${response.rejected}개는 유효하지 않거나 최대 100개 제한을 넘어 제외했습니다.` : ''}${response.disabledForPermission ? ` ${response.disabledForPermission}개는 사이트 권한을 허용한 뒤 시작하세요.` : ''}`);
      await refresh();
    } catch (error) {
      showToast(error.message || '불러오지 못했습니다.');
    } finally {
      elements.importInput.value = '';
    }
  }

  elements.monitorList.addEventListener('click', (event) => void handleCardAction(event));
  elements.labelList.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-label]');
    if (!button) return;
    filters.label = button.dataset.label;
    render();
  });
  elements.searchInput.addEventListener('input', () => { filters.query = elements.searchInput.value; renderMonitors(); });
  elements.statusFilter.addEventListener('change', () => { filters.status = elements.statusFilter.value; renderMonitors(); });
  elements.soundEnabled.addEventListener('change', async () => {
    await send({ type: 'save-settings', settings: { soundEnabled: elements.soundEnabled.checked } });
    await refresh();
  });
  elements.exportButton.addEventListener('click', exportMonitors);
  elements.importButton.addEventListener('click', () => elements.importInput.click());
  elements.importInput.addEventListener('change', () => void importMonitors(elements.importInput.files?.[0]));
  elements.editDays.addEventListener('change', updateEditorInterval);
  elements.editHours.addEventListener('change', updateEditorInterval);
  elements.editorForm.addEventListener('submit', (event) => { event.preventDefault(); void saveEditor(); });
  elements.pageUrlForm.addEventListener('submit', (event) => { event.preventDefault(); void savePageUrl(); });
  document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => document.querySelector(`#${button.dataset.closeDialog}`).close()));
  elements.changeOpenPage.addEventListener('click', async () => {
    const response = await send({ type: 'open-monitor-window', id: elements.changeDialog.dataset.id });
    if (!response?.ok) showToast(response?.error || '작은 창을 열지 못했습니다.');
  });
  elements.acknowledgeButton.addEventListener('click', async () => {
    await send({ type: 'acknowledge-monitor', id: elements.changeDialog.dataset.id });
    elements.changeDialog.close();
    await refresh();
  });

  let refreshQueued = false;
  chrome.storage.onChanged.addListener(() => {
    if (!refreshQueued) {
      refreshQueued = true;
      setTimeout(() => { refreshQueued = false; void refresh(); }, 100);
    }
  });

  populateIntervalSelects();
  void refresh().catch((error) => showToast(error.message || '데이터를 불러오지 못했습니다.'));
})();
