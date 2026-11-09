'use strict';

const KOOFR_CREDENTIALS_KEY = 'openStill.koofr.credentials.v1';
const KOOFR_STATE_KEY = 'openStill.koofr.jobs.v1';
const KOOFR_ALARM = 'openstill-koofr';
const KOOFR_INTERVALS = [0, 60, 360, 1440, 10080];
const KOOFR_RETENTION = [0, 3, 5, 10];
let koofrQueue = Promise.resolve();

function serializeKoofr(action) {
  const operation = koofrQueue.then(action);
  koofrQueue = operation.catch(() => undefined);
  return operation;
}

async function readKoofr() {
  const stored = await chrome.storage.local.get([KOOFR_CREDENTIALS_KEY, KOOFR_STATE_KEY]);
  return { credentials: stored[KOOFR_CREDENTIALS_KEY], state: stored[KOOFR_STATE_KEY] || { interval: 0, keep: 0 } };
}

function saveKoofrState(state) {
  return chrome.storage.local.set({ [KOOFR_STATE_KEY]: state });
}

function koofrStatus(credentials, state) {
  const job = state.job;
  return { ok: true, registered: Boolean(credentials), emailHint: credentials ? credentials.email.slice(0, 1) + '•••' : '',
    interval: state.interval, keep: state.keep, lastSuccess: state.lastSuccess, lastFailure: state.lastFailure,
    lastRestore: state.lastRestore, job: job && { id: job.id, kind: job.kind, phase: job.phase,
      completed: job.kind === 'export' ? job.parts.length : job.completed, total: job.total } };
}

async function sendKoofrOffscreen(message) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) return response || { ok: false, error: 'Koofr 백업 실행 문서에 연결하지 못했습니다.' };
  return response;
}

function koofrCredentials(message, stored) {
  if (!message.email && !message.appPassword && stored) return stored;
  const email = typeof message.email === 'string' ? message.email.trim() : '';
  const appPassword = typeof message.appPassword === 'string' ? message.appPassword.trim() : '';
  if (!/^[^\s:@]+@[^\s:@]+$/.test(email) || email.length > 254 || !appPassword || appPassword.length > 512 || /[\r\n]/.test(appPassword)) return null;
  return { email, appPassword };
}

function koofrActive(job) {
  return Boolean(job && job.phase !== 'paused');
}

async function scheduleKoofr(credentials, state) {
  if (!credentials || state.job?.phase === 'paused') return chrome.alarms.clear(KOOFR_ALARM);
  const job = state.job;
  const when = koofrActive(job) ? (job.retryAt || Date.now() + 60_000) : state.nextDue;
  if (when) await chrome.alarms.create(KOOFR_ALARM, { when });
  else await chrome.alarms.clear(KOOFR_ALARM);
}

async function cleanupKoofrJob(job) {
  if (!job) return;
  if (job.kind === 'export') await finishExportSession({ id: job.id, completed: true });
  else await abortImportSession({ id: job.id, keepCommitted: true });
}

async function stopKoofrJob(job) {
  await chrome.runtime.sendMessage({ type: 'koofr-offscreen-stop', id: job?.id }).catch(() => undefined);
}

function koofrError(message) {
  return { ok: false, error: message };
}

function sameKoofrRegistration(previous, current) {
  return previous.credentials?.registration === current.credentials?.registration
    && previous.state.removal === current.state.removal;
}

async function koofrConnectionRequest(previous, type, credentials) {
  await ensureOffscreenDocument();
  const { pending } = await serializeKoofr(async () => {
    if (!sameKoofrRegistration(previous, await readKoofr())) return {};
    // Serialize dispatch with disconnection, then release the queue while DAV
    // responds. A later disconnection can abort the request in offscreen.
    return { pending: chrome.runtime.sendMessage({ type, credentials }) };
  });
  if (!pending) return koofrError('다른 창에서 연결 정보가 변경되었습니다. 설정을 다시 열어 주세요.');
  return await pending || koofrError('Koofr 백업 실행 문서에 연결하지 못했습니다.');
}

async function koofrDashboardMessage(message) {
  const previous = await readKoofr();
  const { credentials, state } = previous;
  if (message.type === 'koofr-status') return koofrStatus(credentials, state);
  if (message.type === 'koofr-list') {
    if (!credentials) return koofrError('먼저 Koofr 연결 정보를 등록해 주세요.');
    return koofrConnectionRequest(previous, 'koofr-offscreen-list', credentials);
  }
  if (message.type === 'koofr-check' || message.type === 'koofr-save') {
    const entered = koofrCredentials(message, credentials);
    if (!entered) return koofrError('이메일과 Koofr 앱 비밀번호를 입력해 주세요.');
    if (message.type === 'koofr-check' || entered !== credentials) {
      const probe = await koofrConnectionRequest(previous, 'koofr-offscreen-probe', entered);
      if (!probe.ok || message.type === 'koofr-check') return probe;
    }
    return serializeKoofr(async () => {
      const current = await readKoofr();
      if (!sameKoofrRegistration(previous, current)) {
        return koofrError('다른 창에서 연결 정보가 변경되었습니다. 설정을 다시 열어 주세요.');
      }
      const next = current.state;
      const interval = KOOFR_INTERVALS.includes(message.interval) ? message.interval : next.interval;
      const keep = KOOFR_RETENTION.includes(message.keep) ? message.keep : next.keep;
      const changed = entered.email !== credentials?.email || entered.appPassword !== credentials?.appPassword;
      const saved = changed ? { ...entered, registration: crypto.randomUUID() } : current.credentials;
      const oldJob = changed ? next.job : null;
      if (changed) {
        await stopKoofrJob(oldJob);
        next.job = null;
      }
      if (changed || interval !== next.interval) {
        next.nextDue = interval ? Date.now() + interval * 60_000 : null;
      }
      next.interval = interval;
      next.keep = keep;
      next.deviceId ||= crypto.randomUUID();
      if (changed) {
        next.lastFailure = null;
        next.lastSuccess = null;
        next.lastRestore = null;
      }
      // Restrict extension storage before ever writing authentication information.
      await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
      await chrome.storage.local.set({ [KOOFR_CREDENTIALS_KEY]: saved, [KOOFR_STATE_KEY]: next });
      await cleanupKoofrJob(oldJob);
      await scheduleKoofr(saved, next);
      return koofrStatus(saved, next);
    });
  }
  return serializeKoofr(async () => {
    const current = await readKoofr();
    const next = current.state;
    if (message.type === 'koofr-remove' || message.type === 'koofr-cancel') {
      const oldJob = next.job;
      await stopKoofrJob(oldJob);
      next.job = null;
      if (message.type === 'koofr-remove') {
        const removed = { interval: 0, keep: 0, deviceId: next.deviceId, removal: crypto.randomUUID() };
        await chrome.storage.local.set({ [KOOFR_CREDENTIALS_KEY]: null, [KOOFR_STATE_KEY]: removed });
        await cleanupKoofrJob(oldJob);
        await scheduleKoofr(null, removed);
        return koofrStatus(null, removed);
      }
      await saveKoofrState(next);
      await cleanupKoofrJob(oldJob);
      await scheduleKoofr(current.credentials, next);
      return koofrStatus(current.credentials, next);
    }
    if (!current.credentials) return koofrError('먼저 Koofr 연결 정보를 등록해 주세요.');
    if (koofrActive(next.job) || (next.job && message.type === 'koofr-restore')) {
      return koofrError('Koofr 작업이 진행 중이거나 이어가기를 기다리고 있습니다.');
    }
    if (message.type === 'koofr-restore') {
      if (![message.deviceId, message.backupId].every((id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id))) {
        return koofrError('백업 식별자가 올바르지 않습니다.');
      }
      next.job = { version: 1, id: crypto.randomUUID(), kind: 'restore', phase: 'queued',
        deviceId: message.deviceId, backupId: message.backupId, completed: 0 };
    } else if (next.job) {
      next.job.phase = 'queued';
      next.job.retryAt = null;
      next.job.attempts = 0;
    } else {
      next.job = newKoofrExport(next.deviceId, false, message.dashboardSort);
    }
    await saveKoofrState(next);
    await scheduleKoofr(current.credentials, next);
    return koofrStatus(current.credentials, next);
  }).then((result) => {
    if (result.ok && koofrActive(result.job)) void wakeKoofr().catch(() => undefined);
    return result;
  });
}

function newKoofrExport(deviceId, automatic, dashboardSort) {
  const id = crypto.randomUUID();
  return { version: 1, id, kind: 'export', phase: 'queued', backupId: id, deviceId, automatic,
    parts: [], attempts: 0, dashboardSort: normalizeSettings({ dashboardSort }).dashboardSort };
}

async function localImportActive() {
  const keys = await OpenStillRecordStore.keysAux('staging', { prefix: 'import:' });
  for (const key of keys) {
    if (!/^import:[^:]+$/.test(key)) continue;
    const entry = await OpenStillRecordStore.getAux('staging', key);
    if (['staging', 'committing'].includes(entry?.phase)
      && Date.now() - Date.parse(entry.updatedAt) < 120_000) return true;
  }
  return false;
}

async function wakeKoofr() {
  await serializeKoofr(async () => {
    const { credentials, state } = await readKoofr();
    if (!credentials) return;
    const now = Date.now();
    if (!state.job && state.interval && state.nextDue <= now) {
      if (await localImportActive()) {
        await chrome.alarms.create(KOOFR_ALARM, { when: now + 60_000 });
        return;
      }
      state.job = newKoofrExport(state.deviceId, true);
      state.nextDue = now + state.interval * 60_000;
      await saveKoofrState(state);
    }
    if (koofrActive(state.job) && (!state.job.retryAt || state.job.retryAt <= now)) {
      const job = state.job;
      const alreadyStarted = job.phase === 'running';
      job.phase = 'running';
      job.retryAt = null;
      await saveKoofrState(state);
      await scheduleKoofr(credentials, state);
      const started = await sendKoofrOffscreen({ type: 'koofr-offscreen-run', job, credentials, alreadyStarted }).catch(() => null);
      if (!started?.ok) {
        state.lastFailure = { at: nowIso(), kind: job.kind, message: 'Koofr 백업 실행 문서에 연결하지 못했습니다. 잠시 뒤 다시 연결합니다.' };
        await saveKoofrState(state);
      }
    } else {
      await scheduleKoofr(credentials, state);
    }
  });
}

function handleKoofrRuntime(message) {
  return serializeKoofr(async () => {
    const { credentials, state } = await readKoofr();
    const job = state.job;
    if (!credentials || !job || job.id !== message.id || job.phase !== 'running') {
      return koofrError('Koofr 작업이 종료되었습니다.');
    }
    if (message.action === 'failure') {
      const failure = message.failure;
      state.lastFailure = { at: nowIso(), kind: job.kind, message: failure.message };
      if (job.kind === 'restore' && state.lastRestore?.id === job.id && state.lastRestore.result) {
        job.phase = 'retry';
        job.retryAt = Date.now() + 60_000;
      } else if (job.kind === 'restore') {
        await cleanupKoofrJob(job);
        state.lastRestore = { id: job.id, at: nowIso(), error: failure.message };
        state.job = null;
      } else if (failure.code === 'DEFERRED') {
        job.phase = 'retry';
        job.retryAt = Date.now() + 60_000;
      } else if (failure.code === 'TRANSIENT' && job.attempts < 3) {
        job.attempts += 1;
        job.phase = 'retry';
        job.retryAt = Math.max(Date.now() + 60_000 * job.attempts, failure.retryAt || 0);
      } else {
        job.phase = 'paused';
      }
      if (state.nextDue && state.nextDue <= Date.now()) state.nextDue = Date.now() + state.interval * 60_000;
      await saveKoofrState(state);
      await scheduleKoofr(credentials, state);
      return { ok: true };
    }
    if (job.kind === 'export') return handleKoofrExport(message, credentials, state, job);
    return handleKoofrRestore(message, credentials, state, job);
  });
}

async function handleKoofrExport(message, credentials, state, job) {
  switch (message.action) {
    case 'prepare':
      if (job.automatic && !await OpenStillRecordStore.getAux('staging', 'export:' + job.id) && await localImportActive()) {
        return { ok: false, code: 'DEFERRED', error: '진행 중인 불러오기가 끝난 뒤 자동 백업을 이어갑니다.' };
      }
      return startExportSession({ dashboardSort: job.dashboardSort }, { id: job.id });
    case 'get-export-monitor':
      return getExportMonitor({ id: job.id, index: message.request.index });
    case 'get-export-monitor-fragment':
      return getExportMonitorFragment({ id: job.id, index: message.request.index, fragmentIndex: message.request.fragmentIndex });
    case 'checkpoint-export-session':
      return checkpointExportSession({ id: job.id, progress: message.request.progress });
    case 'part': {
      const { partNumber, part } = message;
      if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > job.parts.length + 1) {
        return koofrError('확인된 part의 순서가 올바르지 않습니다.');
      }
      const prior = job.parts[partNumber - 1];
      if (prior && (prior.name !== part.name || prior.size !== part.size || prior.sha256 !== part.sha256)) {
        return koofrError('다시 확인한 Koofr part의 지문이 달라졌습니다.');
      }
      if (!prior) {
        job.parts.push({ name: part.name, size: part.size, sha256: part.sha256 });
        await saveKoofrState(state);
      }
      return { ok: true };
    }
    case 'published': {
      state.lastSuccess = { at: nowIso(), id: job.id, partCount: job.parts.length };
      state.lastFailure = null;
      // Keep the job until opt-in retention finishes. A restarted worker can
      // reverify the same marker before another attempt at retention.
      await saveKoofrState(state);
      return { ok: true, keep: state.keep };
    }
    case 'complete':
      await finishExportSession({ id: job.id, completed: true });
      if (message.warning) state.lastFailure = { at: nowIso(), kind: 'retention', message: message.warning };
      state.job = null;
      if (state.nextDue && state.nextDue <= Date.now()) state.nextDue = Date.now() + state.interval * 60_000;
      await saveKoofrState(state);
      await scheduleKoofr(credentials, state);
      return { ok: true };
    default:
      return koofrError('알 수 없는 Koofr 백업 작업입니다.');
  }
}

async function handleKoofrRestore(message, credentials, state, job) {
  switch (message.action) {
    case 'prepare':
      return startImportSession({ mode: 'merge' }, { id: job.id });
    case 'append-import-session':
      return appendImportSession({ ...message.request, id: job.id });
    case 'append-import-fragments':
      return appendImportFragments({ ...message.request, id: job.id });
    case 'restore-progress':
      job.completed = message.completed;
      job.total = message.total;
      await saveKoofrState(state);
      return { ok: true };
    case 'commit': {
      if (!job.validated) {
        job.validated = true;
        await saveKoofrState(state);
      }
      if (state.lastRestore?.id !== job.id || !state.lastRestore.result) {
        const result = await finishImportSession({ id: job.id });
        if (!result.ok) return result;
        const { imported, duplicates, conflicts, rejected, repaired, capacityRejected, finalizationWarnings } = result;
        job.keepStaging = Boolean(result.recoveryPending || result.diagnostics?.length);
        state.lastRestore = { id: job.id, at: nowIso(), result: {
          imported, duplicates, conflicts, rejected, repaired, capacityRejected, finalizationWarnings
        } };
        await saveKoofrState(state);
      }
      await releaseCloudImport(job.id, job.keepStaging);
      state.job = null;
      await saveKoofrState(state);
      await scheduleKoofr(credentials, state);
      return { ok: true };
    }
    default:
      return koofrError('알 수 없는 Koofr 복원 작업입니다.');
  }
}

async function releaseCloudImport(id, keepStaging) {
  const session = await loadImportSession(id);
  if (!session) return;
  if (keepStaging) {
    delete session.target;
    await persistImportSession(session);
    return;
  }
  const keys = [];
  for (const prefix of ['import-file:', 'record:', 'prepared-marker:', 'prepared-index:', 'fragment:', 'recovery-file:', 'pending-native:']) {
    keys.push(...await OpenStillRecordStore.keysAux('staging', { prefix: prefix + id + ':' }));
  }
  await OpenStillRecordStore.deleteAuxBatch('staging', ['import:' + id, ...keys]);
  importSessions.delete(id);
}

const KOOFR_DASHBOARD_MESSAGES = new Set([
  'koofr-status', 'koofr-check', 'koofr-save', 'koofr-remove', 'koofr-list', 'koofr-export', 'koofr-restore', 'koofr-cancel'
]);

function isKoofrSender(sender, page) {
  if (sender?.id !== chrome.runtime.id || sender.frameId > 0 || !sender.url) return false;
  const expected = chrome.runtime.getURL(page);
  return sender.url.split(/[?#]/, 1)[0] === expected;
}
