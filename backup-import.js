'use strict';
(() => {
  const { MAX_FILE_BYTES: MAX_IMPORT_MESSAGE_BYTES, utf8ByteLength } = globalThis.OpenStillBackupTransfer;
  const IMPORT_RECORD_FRAGMENT_CHARS = 3 * 1024 * 1024;
  function parseImportFile(file, sessionId, fileIndex, onProgress, signal, send) {
    return new Promise((resolve, reject) => {
      const worker = new Worker('import-worker.js');
      let timer; let finished = false;
      const finish = (error, result) => {
        if (finished) return;
        finished = true; clearTimeout(timer); worker.terminate();
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(result);
      };
      const abort = () => finish(new Error('불러오기를 중단했습니다. 원본과 준비한 자료는 복구함에서 이어갈 수 있습니다.'));
      const watchdog = () => { clearTimeout(timer); timer = setTimeout(() => finish(new Error('파일 처리 응답이 없어 중단했습니다. 준비한 자료를 보관했습니다.')), 90_000); };
      worker.addEventListener('message', async (event) => {
        watchdog(); const message = event.data;
        if (message?.type === 'record') {
          try {
            const serialized = JSON.stringify(message.record);
            if (message.kind === 'monitor' && utf8ByteLength(serialized) + 1024 >= MAX_IMPORT_MESSAGE_BYTES) {
              const fragmentCount = Math.ceil(serialized.length / IMPORT_RECORD_FRAGMENT_CHARS);
              for (let index = 0; index < fragmentCount; index += 1) {
                const response = await send({ type: 'append-import-fragments', id: sessionId, exportId: message.source?.exportId,
                  fragments: [{ recordId: `file:${fileIndex}:${message.source.recordIndex}`, fragmentIndex: index, fragmentCount, payload: serialized.slice(index * IMPORT_RECORD_FRAGMENT_CHARS, (index + 1) * IMPORT_RECORD_FRAGMENT_CHARS) }] });
                if (!response?.ok) throw new Error(response?.error || '레코드 조각을 준비하지 못했습니다.');
              }
            } else {
              const response = await send({ type: message.kind === 'fragment' ? 'append-import-fragments' : 'append-import-session', id: sessionId,
                [message.kind === 'fragment' ? 'fragments' : 'monitors']: [message.record], source: message.source, exportId: message.source?.exportId });
              if (!response?.ok) throw new Error(response?.error || '레코드를 준비하지 못했습니다.');
            }
            worker.postMessage({ type: 'ack' }); watchdog();
          } catch (error) { worker.postMessage({ type: 'ack', error: error.message }); finish(error); }
        } else if (message?.type === 'read-progress' || message?.type === 'parsing') onProgress?.(message);
        else if (message?.type === 'parsed') finish(null, message);
        else if (message?.type === 'error') finish(new Error(message.error || '파일을 읽지 못했습니다.'));
      });
      worker.addEventListener('error', () => finish(new Error('JSON 해석 워커가 중단되었습니다. 원본과 준비 자료는 보관했습니다.')));
      worker.addEventListener('messageerror', () => finish(new Error('파일 처리 메시지를 읽지 못했습니다. 준비 자료는 보관했습니다.')));
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true }); watchdog();
      worker.postMessage({ type: 'parse', ...(file.storedFileId ? { storedFileId: file.storedFileId } : { file }), sessionId, fileIndex });
    });
  }
  globalThis.OpenStillBackupImport = Object.freeze({ parseImportFile });
})();
