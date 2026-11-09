'use strict';

importScripts('backup-integrity.js', 'backup-transfer.js');

self.addEventListener('message', async ({ data: session, ports: [port] }) => {
  let pending;
  port.onmessage = ({ data }) => pending?.(data);
  function exchange(message) {
    return new Promise((resolve, reject) => {
      pending = ({ result, failure }) => {
        pending = null;
        if (failure) reject(Object.assign(new Error(failure.message), failure));
        else resolve(result);
      };
      port.postMessage(message);
    });
  }
  try {
    const progress = await OpenStillBackupTransfer.writeBackup({
      session,
      send: (request) => exchange({ request }),
      writePart: (part) => exchange({ part })
    });
    port.postMessage({ progress });
  } catch (error) {
    port.postMessage({ failure: { code: error.code, retryAt: error.retryAt, message: error.message } });
  }
}, { once: true });
