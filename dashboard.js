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

  function hostname(url) {
    try { return new URL(url).hostname; } catch { return url; }
  }

  function sitePattern(url) {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('HTTP 또는 HTTPS 주소만 사용할 수 있습니다.');
    return `${parsed.protocol}//${parsed.host}/*`;
  }

  async function requestSitePermission(url) {
    try {
      return await chrome.permissions.request({ origins: [sitePattern(url)] });
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
    if (monitor.unread || monitor.status === 'changed') return { key: 'changed', label: '변경 감지' };
    const labels = {
      ok: ['ok', '정상'],
      missing: ['missing', '요소 없음'],
      error: ['error', '오류'],
      'permission-needed': ['permission-needed', '권한 필요'],
      'needs-baseline': ['needs-baseline', '기준값 필요']
    };
    const [key, label] = labels[monitor.status] ?? labels.ok;
    return { key, label };
  }

  function needsAttention(monitor) {
    return ['error', 'permission-needed'].includes(monitor.status);
  }

  function getFilteredMonitors() {
    const query = filters.query.trim().toLocaleLowerCase('ko-KR');
    return state.monitors.filter((monitor) => {
      if (filters.label && !monitor.labels.some((label) => label.toLocaleLowerCase('ko-KR') === filters.label)) return false;
      if (filters.status === 'changed' && !monitor.unread) return false;
      if (filters.status === 'active' && !monitor.enabled) return false;
      if (filters.status === 'attention' && !needsAttention(monitor)) return false;
      if (filters.status === 'paused' && monitor.enabled) return false;
      if (query) {
        const haystack = [monitor.name, monitor.url, monitor.selector, ...(monitor.labels ?? [])].join(' ').toLocaleLowerCase('ko-KR');
        if (!haystack.includes(query)) return false;
      }
      return true;
    }).sort((left, right) => {
      if (left.unread !== right.unread) return left.unread ? -1 : 1;
      const leftTime = Date.parse(left.lastChangedAt ?? left.updatedAt ?? 0) || 0;
      const rightTime = Date.parse(right.lastChangedAt ?? right.updatedAt ?? 0) || 0;
      return rightTime - leftTime;
    });
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

  function monitorCard(monitor) {
    const card = element('article', `monitor-card${monitor.unread ? ' unread' : ''}`);
    const top = element('div', 'card-top');
    const title = element('div', 'card-title');
    title.append(element('h2', '', monitor.name), element('p', 'card-url', hostname(monitor.url)));
    const status = statusInfo(monitor);
    top.append(title, element('span', `status ${status.key}`, status.label));
    card.append(top);

    if (monitor.labels?.length) {
      const chips = element('div', 'chips');
      monitor.labels.forEach((label) => chips.append(element('span', 'chip', label)));
      card.append(chips);
    }

    const details = element('div', 'details');
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

    const snapshot = monitor.snapshot;
    const preview = element('p', 'snapshot-preview', snapshot
      ? (snapshot.exists ? (snapshot.text || '(텍스트 없음)') : '(선택한 요소를 찾지 못했습니다)')
      : '(아직 기준값이 없습니다)');
    card.append(preview);

    if (monitor.lastError) card.append(element('p', 'error-text', monitor.lastError));

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

  function updateListHeading(monitors) {
    if (filters.label) {
      const current = labelCollection().find(([key]) => key === filters.label);
      elements.listTitle.textContent = current ? `${current[1].label} 라벨` : '라벨 모니터';
      elements.listDescription.textContent = '이 라벨이 붙은 모니터를 모아 보고 있습니다.';
    } else {
      const headings = { changed: '변경 감지됨', active: '추적 중', attention: '권한 또는 오류 확인', paused: '일시정지됨', all: '모든 모니터' };
      elements.listTitle.textContent = headings[filters.status] ?? headings.all;
      elements.listDescription.textContent = '선택한 요소를 주기적으로 확인합니다.';
    }
    elements.visibleCount.textContent = `${monitors.length}개 표시`;
  }

  function renderMonitors() {
    const monitors = getFilteredMonitors();
    updateListHeading(monitors);
    elements.monitorList.replaceChildren();
    if (!monitors.length) {
      const empty = element('div', 'empty-state');
      const title = element('strong', '', state.monitors.length ? '조건에 맞는 모니터가 없습니다.' : '아직 저장된 모니터가 없습니다.');
      empty.append(title, document.createTextNode(state.monitors.length
        ? '검색어나 라벨, 상태 필터를 바꿔 보세요.'
        : '추적할 웹페이지에서 브라우저 툴바의 OpenStill 버튼을 눌러 CSS 요소를 선택하세요.'));
      elements.monitorList.append(empty);
      return;
    }
    monitors.forEach((monitor) => elements.monitorList.append(monitorCard(monitor)));
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
    showToast('모니터 설정을 저장했습니다. 선택자나 주소를 바꾸면 다음 확인에서 새 기준값을 저장합니다.');
    await refresh();
  }

  function openChange(monitor) {
    const lastChange = monitor.lastChange;
    elements.changeDialog.dataset.id = monitor.id;
    elements.changeTitle.textContent = monitor.name;
    elements.changeWhen.textContent = `감지 시각: ${formatDate(monitor.lastChangedAt ?? lastChange?.detectedAt)}`;
    elements.previousSnapshot.textContent = lastChange?.previous
      ? (lastChange.previous.exists ? (lastChange.previous.text || '(텍스트 없음)') : '(요소 없음)')
      : '(이전 텍스트가 없습니다)';
    elements.currentSnapshot.textContent = lastChange?.current
      ? (lastChange.current.exists ? (lastChange.current.text || '(텍스트 없음)') : '(요소 없음)')
      : (monitor.snapshot?.exists ? (monitor.snapshot.text || '(텍스트 없음)') : '(요소 없음)');
    elements.changeDialog.showModal();
  }

  async function actionCheck(monitor, button) {
    button.disabled = true;
    button.textContent = '확인 중…';
    try {
      const response = await send({ type: 'check-monitor', id: monitor.id });
      if (!response?.ok) throw new Error(response?.error || '확인하지 못했습니다.');
      showToast(response.changed ? '변경을 감지했습니다.' : '변경 없이 최신 상태입니다.');
    } catch (error) {
      showToast(error.message || '확인하지 못했습니다.');
    }
    await refresh();
  }

  async function actionGrant(monitor) {
    if (!await requestSitePermission(monitor.url)) {
      showToast('권한이 허용되지 않았습니다.');
      return;
    }
    const response = await send({ type: 'set-monitor-enabled', id: monitor.id, enabled: true });
    showToast(response?.ok ? '권한을 허용하고 추적을 시작했습니다.' : (response?.error || '추적을 시작하지 못했습니다.'));
    await refresh();
  }

  async function handleCardAction(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const monitor = monitorById(button.dataset.id);
    if (!monitor) return;

    switch (button.dataset.action) {
      case 'change': openChange(monitor); break;
      case 'check': await actionCheck(monitor, button); break;
      case 'open': {
        const response = await send({ type: 'open-monitor-window', id: monitor.id });
        if (!response?.ok) showToast(response?.error || '작은 창을 열지 못했습니다.');
        break;
      }
      case 'edit': openEditor(monitor); break;
      case 'grant': await actionGrant(monitor); break;
      case 'toggle': {
        if (!monitor.enabled && monitor.status === 'permission-needed') {
          await actionGrant(monitor);
          break;
        }
        let response = await send({ type: 'set-monitor-enabled', id: monitor.id, enabled: !monitor.enabled });
        if (!response?.ok && response?.reason === 'permission') {
          await actionGrant(monitor);
          break;
        }
        showToast(response?.ok ? (monitor.enabled ? '일시정지했습니다.' : '추적을 다시 시작했습니다.') : (response?.error || '상태를 바꾸지 못했습니다.'));
        await refresh();
        break;
      }
      case 'delete': {
        if (!window.confirm(`“${monitor.name}” 모니터를 삭제할까요?`)) return;
        const response = await send({ type: 'delete-monitor', id: monitor.id });
        showToast(response?.ok ? '모니터를 삭제했습니다.' : (response?.error || '삭제하지 못했습니다.'));
        await refresh();
        break;
      }
      default: break;
    }
  }

  function exportMonitors() {
    const payload = {
      format: 'openstill-export',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      monitors: state.monitors,
      settings: { soundEnabled: state.settings.soundEnabled !== false }
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `openstill-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
    showToast('모니터 데이터 JSON을 내보냈습니다.');
  }

  async function importMonitors(file) {
    if (!file) return;
    try {
      if (file.size > MAX_IMPORT_BYTES) {
        throw new Error('불러올 수 있는 JSON 파일 크기는 최대 8 MB입니다.');
      }
      const parsed = JSON.parse(await file.text());
      if (parsed?.format !== 'openstill-export' || parsed?.schemaVersion !== 1 || !Array.isArray(parsed?.monitors)) {
        throw new Error('OpenStill 내보내기 JSON(v1) 파일이 아닙니다.');
      }
      const response = await send({ type: 'import-monitors', monitors: parsed.monitors, mode: 'merge' });
      if (!response?.ok) throw new Error(response?.error || '불러오지 못했습니다.');
      if (parsed.settings && typeof parsed.settings === 'object') {
        await send({ type: 'save-settings', settings: { soundEnabled: parsed.settings.soundEnabled !== false } });
      }
      showToast(`${response.imported}개를 불러왔습니다.${response.rejected ? ` ${response.rejected}개는 유효하지 않거나 최대 100개 제한을 넘어 제외했습니다.` : ''}${response.disabledForPermission ? ` ${response.disabledForPermission}개는 사이트 권한을 허용한 뒤 시작하세요.` : ''}`);
      await refresh();
    } catch (error) {
      showToast(error.message || '파일을 불러오지 못했습니다.');
    } finally {
      elements.importInput.value = '';
    }
  }

  elements.labelList.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-label]');
    if (!button) return;
    filters.label = button.dataset.label;
    render();
  });
  elements.monitorList.addEventListener('click', (event) => void handleCardAction(event));
  elements.searchInput.addEventListener('input', () => { filters.query = elements.searchInput.value; renderMonitors(); });
  elements.statusFilter.addEventListener('change', () => { filters.status = elements.statusFilter.value; renderMonitors(); });
  elements.soundEnabled.addEventListener('change', async () => {
    const response = await send({ type: 'save-settings', settings: { soundEnabled: elements.soundEnabled.checked } });
    if (response?.ok) { state.settings = response.settings; showToast(elements.soundEnabled.checked ? '변경 소리를 켰습니다.' : '변경 소리를 껐습니다.'); }
  });
  elements.exportButton.addEventListener('click', exportMonitors);
  elements.importButton.addEventListener('click', () => elements.importInput.click());
  elements.importInput.addEventListener('change', () => void importMonitors(elements.importInput.files?.[0]));
  elements.editDays.addEventListener('change', updateEditorInterval);
  elements.editHours.addEventListener('change', updateEditorInterval);
  elements.editorForm.addEventListener('submit', (event) => { event.preventDefault(); void saveEditor(); });
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
