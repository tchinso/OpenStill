'use strict';

// JSON parsing can be noticeably expensive even when the file is read
// asynchronously. Keep it out of the dashboard document so its progress UI
// and cancel/error feedback continue to paint while a backup part is decoded.
function readFileTextWithProgress(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('progress', (progress) => {
      self.postMessage({
        type: 'read-progress',
        loaded: progress.loaded,
        total: progress.total || file.size || 0
      });
    });
    reader.addEventListener('load', () => resolve(reader.result));
    reader.addEventListener('error', () => reject(reader.error || new Error('파일을 읽지 못했습니다.')));
    reader.addEventListener('abort', () => reject(new Error('파일 읽기가 취소되었습니다.')));
    reader.readAsText(file);
  });
}

self.addEventListener('message', async (event) => {
  if (event.data?.type !== 'parse') return;
  try {
    const file = event.data.file;
    if (!file || typeof file.text !== 'function') {
      throw new Error('선택한 파일을 읽을 수 없습니다.');
    }
    const text = await readFileTextWithProgress(file);
    self.postMessage({ type: 'parsing' });
    const payload = JSON.parse(text);
    self.postMessage({ type: 'parsed', payload });
  } catch (error) {
    self.postMessage({ type: 'error', error: error?.message || 'JSON 파일을 읽지 못했습니다.' });
  }
});
