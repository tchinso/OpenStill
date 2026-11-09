'use strict';
(() => {
  const active = new Map();
  const requests = new Set();
  const publicCodes = new Set(['AUTH', 'FORBIDDEN', 'QUOTA', 'TRANSIENT', 'INVALID', 'NOT_FOUND', 'CONFLICT', 'HTTP', 'REDIRECT', 'CANCELED', 'DEFERRED']);

  function failure(error) {
    if (publicCodes.has(error.code)) return { code: error.code, retryAt: error.retryAt, message: error.message };
    return { code: 'LOCAL', message: 'Koofr 백업 파일을 처리하지 못했습니다. 복구함과 작업 상태를 확인해 주세요.' };
  }

  async function send(job, action, fields = {}) {
    const result = await chrome.runtime.sendMessage({ type: 'koofr-runtime', id: job.id, action, ...fields }).catch(() => null);
    if (!result) throw Object.assign(new Error('백업 실행에 다시 연결해야 합니다.'), { code: 'TRANSIENT' });
    if (!result.ok) throw Object.assign(new Error(result.error), { code: result.code });
    return result;
  }

  function writeInWorker(session, signal, sendRecord, writePart) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const worker = new Worker('backup-transfer-worker.js');
      const { port1, port2 } = new MessageChannel();
      const abort = () => finish(signal.reason);
      function finish(error, progress) {
        signal.removeEventListener('abort', abort);
        port1.close();
        worker.terminate();
        if (error) reject(error);
        else resolve(progress);
      }
      signal.addEventListener('abort', abort, { once: true });
      worker.addEventListener('error', () => finish(new Error('백업 파일 생성 워커가 중단되었습니다.')), { once: true });
      port1.onmessage = async ({ data }) => {
        if (data.progress) { finish(null, data.progress); return; }
        if (data.failure) { finish(Object.assign(new Error(data.failure.message), data.failure)); return; }
        try {
          const result = data.part ? await writePart(data.part) : await sendRecord(data.request);
          port1.postMessage({ result });
        } catch (error) {
          port1.postMessage({ failure: failure(error) });
        }
      };
      worker.postMessage(session, [port2]);
    });
  }

  async function exportBackup(job, client, signal) {
    const session = await send(job, 'prepare');
    const { deviceId, backupId, parts } = job;
    await client.ensureBackupFolder(deviceId, backupId);
    for (let index = 0; index < parts.length; index += 1) {
      await client.getPart({ deviceId, backupId, parts }, index + 1);
    }
    const progress = await writeInWorker(session, signal, (request) => send(job, request.type, { request }),
      async ({ blob, partNumber }) => {
        const part = await client.putPart(deviceId, backupId, partNumber, blob);
        await send(job, 'part', { partNumber, part });
        parts[partNumber - 1] = part;
      });
    signal.throwIfAborted();
    await client.publish(deviceId, backupId, { setId: progress.exportId, createdAt: progress.exportedAt, parts });
    const { keep } = await send(job, 'published');
    let warning;
    if (keep) {
      try {
        const backups = await client.listBackups({ deviceId });
        const previous = backups.filter((backup) => backup.backupId !== backupId)
          .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
        for (const backup of previous.slice(keep - 1)) {
          signal.throwIfAborted();
          await client.deleteBackup(deviceId, backup.backupId);
        }
      } catch {
        warning = '백업을 저장했습니다. 이전 백업의 보관 정리를 마치지 못했습니다.';
      }
    }
    signal.throwIfAborted();
    await send(job, 'complete', { warning });
  }

  async function restoreBackup(job, client, signal) {
    await send(job, 'prepare');
    const complete = await client.readComplete(job.deviceId, job.backupId);
    const total = complete.parts.length;
    const parts = [];
    const append = (request) => send(job, request.type, { request });
    await send(job, 'restore-progress', { completed: 0, total });
    for (let index = 0; index < total; index += 1) {
      const partNumber = index + 1;
      const blob = await client.getPart(complete, partNumber);
      const file = new File([blob], complete.parts[index].name, { type: 'application/json', lastModified: Date.parse(complete.createdAt) });
      const parsed = await OpenStillBackupImport.parseImportFile(file, job.id, index, null, signal, append);
      for (const diagnostic of parsed.diagnostics) {
        await append({ type: 'append-import-session', diagnostic: { ...diagnostic, source: file.name, recoveryId: parsed.recoveryId } });
      }
      const part = parsed.backupPart;
      if (parsed.diagnostics.length || !part?.envelopeVerified || part.part !== partNumber || part.exportId !== complete.setId
        || part.exportedAt !== complete.createdAt || part.finalPart !== (partNumber === total)) {
        throw Object.assign(new Error('Koofr 백업 part의 순서·내용을 확인하지 못했습니다. 읽은 자료는 복구함에서 확인할 수 있습니다.'), { code: 'INVALID' });
      }
      parts.push(part);
      await send(job, 'restore-progress', { completed: partNumber, total });
    }
    const selection = OpenStillBackupIntegrity.validateBackupPartSelection(parts);
    if (!selection.ok) throw Object.assign(new Error(selection.error), { code: 'INVALID' });
    signal.throwIfAborted();
    await send(job, 'commit');
  }

  async function run(job, credentials, controller, alreadyStarted) {
    try {
      const client = OpenStillKoofrWebDav.createClient(credentials, { signal: controller.signal });
      if (job.kind === 'export') await exportBackup(job, client, controller.signal);
      else if (job.validated) await send(job, 'commit');
      else if (alreadyStarted) {
        throw Object.assign(new Error('Koofr 복원이 중단되었습니다. 복구함에서 준비한 자료를 확인해 주세요.'), { code: 'INVALID' });
      } else await restoreBackup(job, client, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) await send(job, 'failure', { failure: failure(error) }).catch(() => undefined);
    } finally {
      active.delete(job.id);
    }
  }

  function fromBackground(sender) {
    return sender.id === chrome.runtime.id && !sender.tab && !sender.documentId
      && (!sender.url || [chrome.runtime.getURL(''), chrome.runtime.getURL('service-worker.js')].includes(sender.url));
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!message?.type?.startsWith('koofr-offscreen-') || !fromBackground(sender)) return;
    if (message.type === 'koofr-offscreen-stop') {
      active.get(message.id)?.abort();
      for (const controller of requests) controller.abort();
      respond({ ok: true });
    } else if (message.type === 'koofr-offscreen-run') {
      const { job, credentials, alreadyStarted } = message;
      if (!active.has(job.id)) {
        const controller = new AbortController();
        active.set(job.id, controller);
        void run(job, credentials, controller, alreadyStarted);
      }
      respond({ ok: true });
    } else if (message.type === 'koofr-offscreen-probe' || message.type === 'koofr-offscreen-list') {
      const controller = new AbortController();
      requests.add(controller);
      void (async () => {
        try {
          const client = OpenStillKoofrWebDav.createClient(message.credentials, { signal: controller.signal });
          if (message.type === 'koofr-offscreen-probe') {
            await client.probe();
            respond({ ok: true });
          } else {
            const backups = await client.listBackups();
            respond({ ok: true, backups: backups.map(({ backupId, deviceId, createdAt, partCount, totalBytes }) =>
              ({ backupId, deviceId, createdAt, partCount, totalBytes })) });
          }
        } catch (error) {
          const info = failure(error);
          respond({ ok: false, error: info.message, code: info.code });
        } finally {
          requests.delete(controller);
        }
      })();
      return true;
    }
  });
})();
