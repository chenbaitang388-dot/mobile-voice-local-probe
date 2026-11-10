/* Explicit installation of the public frontend and WASM only. */
const workerUrl = new URL('../../offline-worker.js', import.meta.url);

function serviceWorkers() {
  return typeof navigator !== 'undefined' && navigator.serviceWorker;
}

function ask(worker, command, timeoutMs) {
  if (worker?.scriptURL !== workerUrl.href) return Promise.resolve(false);
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    function finish(value) {
      clearTimeout(timer);
      port1.close();
      resolve(value);
    }
    const timer = setTimeout(() => finish(false), timeoutMs);
    port1.onmessage = (event) => finish(event.data === true);
    try {
      worker.postMessage(command, [port2]);
    } catch {
      finish(false);
    }
  });
}

export async function offlineFrontendReady() {
  try {
    return await ask(serviceWorkers()?.controller, 'offline-ready', 5000);
  } catch {
    return false;
  }
}

async function waitForActivation(worker) {
  if (!worker) return false;
  return new Promise((resolve) => {
    function finish(result) {
      clearTimeout(timer);
      worker.removeEventListener('statechange', check);
      resolve(result);
    }
    function check() {
      if (worker.state === 'activated' || worker.state === 'redundant') {
        finish(worker.state === 'activated');
      }
    }
    const timer = setTimeout(() => finish(false), 120000);
    worker.addEventListener('statechange', check);
    check();
  });
}

export async function installOfflineFrontend() {
  const workers = serviceWorkers();
  if (!workers) throw new Error('需要在 Safari 中使用 HTTPS 页面，才能保存离线前端。');
  const scope = new URL('./', workerUrl).href;
  const existing = await workers.getRegistration(scope);
  if (existing?.scope === scope &&
      [existing.installing, existing.waiting, existing.active].some((worker) => worker && worker.scriptURL !== workerUrl.href)) {
    throw new Error('此地址已有其他离线应用。请使用白棠候选的独立地址。');
  }
  const registration = await workers.register(workerUrl, { updateViaCache: 'none' });
  const worker = registration.installing || registration.waiting || registration.active;
  if (!(await waitForActivation(worker)) || !(await ask(worker, 'offline-repair', 120000))) {
    throw new Error('离线前端未保存完整。请检查网络和可用空间后重试。');
  }
  return true;
}
