(() => {
  const pageTitle = document.querySelector('#pageTitle');
  const pageUrl = document.querySelector('#pageUrl');
  const pickButton = document.querySelector('#pickElement');
  const message = document.querySelector('#message');
  const monitorCount = document.querySelector('#monitorCount');
  const changedCount = document.querySelector('#changedCount');
  const attentionCount = document.querySelector('#attentionCount');
  const recentList = document.querySelector('#recentList');
  let activeTab;

  function formatWhen(iso) {
    const timestamp = Date.parse(iso ?? '');
    if (!Number.isFinite(timestamp)) return '방금 전';
    const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
    if (minutes < 1) return '방금 전';
    if (minutes < 60) return `${minutes}분 전`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}시간 전`;
    return `${Math.floor(hours / 24)}일 전`;
  }

  function hostLabel(url) {
    try { return new URL(url).hostname; } catch { return ''; }
  }

  function sitePattern(url) {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/*`;
  }

  function isSupportedPage(tab) {
    try {
      const url = new URL(tab?.url ?? '');
      return Boolean(tab?.id) && (url.protocol === 'https:' || url.protocol === 'http:');
    } catch {
      return false;
    }
  }

  async function send(messageToSend) {
    return chrome.runtime.sendMessage(messageToSend);
  }

  async function renderState() {
    const response = await send({ type: 'get-state' });
    const monitors = response?.monitors ?? [];
    const changed = monitors.filter((monitor) => monitor.unread);
    const needsAttention = (monitor) => (monitor.enabled || monitor.status === 'permission-needed')
      && ['needs-review', 'error', 'permission-needed'].includes(monitor.status);
    const attention = monitors.filter(needsAttention);
    monitorCount.textContent = String(monitors.filter((monitor) => monitor.enabled).length);
    changedCount.textContent = String(changed.length);
    attentionCount.textContent = String(attention.length);
    recentList.replaceChildren();

    const items = [...changed, ...attention.filter((monitor) => !monitor.unread), ...monitors.filter((monitor) => !monitor.unread && !needsAttention(monitor))]
      .sort((left, right) => Date.parse(right.lastChangedAt ?? right.lastReviewAt ?? right.updatedAt) - Date.parse(left.lastChangedAt ?? left.lastReviewAt ?? left.updatedAt))
      .slice(0, 3);

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '아직 추적 중인 요소가 없습니다. 이 페이지에서 첫 요소를 선택해 보세요.';
      recentList.append(empty);
      return;
    }

    for (const monitor of items) {
      const item = document.createElement('article');
      item.className = 'recent-item';
      const text = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'recent-name';
      name.textContent = monitor.name;
      const meta = document.createElement('div');
      meta.className = 'recent-meta';
      meta.textContent = monitor.status === 'needs-review'
        ? '확인 필요 · 요소를 찾지 못함'
        : monitor.unread ? `변경 감지 · ${formatWhen(monitor.lastChangedAt)}` : hostLabel(monitor.url);
      text.append(name, meta);
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'open-button';
      open.textContent = '작은 창';
      open.addEventListener('click', async () => {
        await send({ type: 'open-monitor-window', id: monitor.id });
        window.close();
      });
      item.append(text, open);
      recentList.append(item);
    }
  }

  async function loadActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    activeTab = tab;
    if (!isSupportedPage(tab)) {
      pageTitle.textContent = '이 페이지에서는 선택할 수 없어요';
      pageUrl.textContent = 'HTTP 또는 HTTPS 웹페이지를 열어 주세요.';
      pickButton.disabled = true;
      return;
    }
    pageTitle.textContent = tab.title || hostLabel(tab.url);
    pageUrl.textContent = hostLabel(tab.url);
    pickButton.disabled = false;
  }

  async function beginPicker() {
    if (!isSupportedPage(activeTab)) return;
    message.textContent = '';
    pickButton.disabled = true;
    pickButton.textContent = '권한을 확인하는 중…';
    let newlyGranted = false;
    try {
      const origins = [sitePattern(activeTab.url)];
      const alreadyGranted = await chrome.permissions.contains({ origins });
      const granted = alreadyGranted || await chrome.permissions.request({ origins });
      newlyGranted = granted && !alreadyGranted;
      if (!granted) {
        throw new Error('선택한 사이트의 접근 권한이 필요합니다. 권한을 허용한 뒤 다시 시도해 주세요.');
      }
      const response = await send({ type: 'start-picker', tabId: activeTab.id, url: activeTab.url });
      if (!response?.ok) throw new Error(response?.error || '선택기를 열 수 없습니다.');
      window.close();
    } catch (error) {
      if (newlyGranted) {
        await send({ type: 'release-unclaimed-origin', url: activeTab.url, tabId: activeTab.id }).catch(() => undefined);
      }
      message.textContent = error.message || '선택기를 열 수 없습니다.';
      pickButton.disabled = false;
      pickButton.textContent = '이 페이지에서 요소 선택';
    }
  }

  async function openDashboard() {
    await send({ type: 'open-dashboard' });
    window.close();
  }

  pickButton.addEventListener('click', () => void beginPicker());
  document.querySelector('#openDashboard').addEventListener('click', () => void openDashboard());
  document.querySelector('#manage').addEventListener('click', () => void openDashboard());
  chrome.storage.onChanged.addListener(() => void renderState());
  void Promise.all([loadActiveTab(), renderState()]);
})();
