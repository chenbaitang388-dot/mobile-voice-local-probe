/* Offline frontend for the opt-in mobile entry. Bump the version when shipping
 * a new frontend, so a failed upgrade cannot replace the previous shell. */
const scope = new URL(self.registration.scope);
const prefix = `baitang-frontend:${scope.pathname}:`;
const cacheName = `${prefix}v1`;
const entry = new URL('app/index.html', scope).href;
const assets = [
  'app/index.html',
  'app/style.css',
  'app/js/main.js',
  'app/js/offline.js',
  'app/js/config.js',
  'app/js/controller.js',
  'app/js/decode.js',
  'app/js/format.js',
  'app/js/limits.js',
  'app/js/object-url.js',
  'app/js/pcm.js',
  'app/js/recorder.js',
  'app/js/resample.js',
  'app/js/ui.js',
  'app/js/wav.js',
  'app/js/engine/adapter.js',
  'app/js/engine/blocks.js',
  'app/js/engine/contract.js',
  'app/js/engine/missing-engine.js',
  'app/js/engine/random.js',
  'app/js/engine/reference.js',
  'app/js/engine/roles.js',
  'app/js/engine/seed-chain.js',
  'app/js/engine/seed-engine.js',
  'app/js/engine/session-factory.js',
  'app/js/engine/solver.js',
  'app/js/engine/tensors.js',
  'app/js/engine/timegrid.js',
  'vendor/ort.webgpu.min.js',
  'vendor/ort-wasm-simd-threaded.jsep.mjs',
  'vendor/ort-wasm-simd-threaded.jsep.wasm',
].map((path) => new URL(path, scope).href);
const allowed = new Set(assets);

async function cachedAll() {
  const matches = await Promise.all(assets.map((url) => caches.match(url, { cacheName })));
  return matches.every(Boolean);
}

async function fillCache() {
  const cache = await caches.open(cacheName);
  await cache.addAll(assets.map((url) => new Request(url, { cache: 'reload', redirect: 'error' })));
}

self.addEventListener('install', (event) => {
  event.waitUntil(fillCache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
    const versions = await caches.keys();
    await Promise.all(versions.filter((name) => name.startsWith(prefix) && name !== cacheName).map((name) => caches.delete(name)));
  })());
});

self.addEventListener('message', (event) => {
  const { data, ports, source } = event;
  if (!ports[0] || !source?.url) return;
  const client = new URL(source.url);
  const mobileEntry = client.origin + client.pathname === entry && client.searchParams.get('mobile') === '1';
  if (!mobileEntry || (data !== 'offline-ready' && data !== 'offline-repair')) return;
  event.waitUntil((async () => {
    try {
      if (data === 'offline-repair' && !(await cachedAll())) await fillCache();
      ports[0].postMessage(await cachedAll());
    } catch {
      ports[0].postMessage(false);
    }
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const mobileNavigation = request.mode === 'navigate' &&
    url.origin + url.pathname === entry && url.searchParams.get('mobile') === '1';
  if (!mobileNavigation && (request.mode === 'navigate' || !allowed.has(url.href))) return;
  event.respondWith((async () => {
    if (!mobileNavigation) {
      const client = event.clientId && await self.clients.get(event.clientId);
      if (client) {
        const page = new URL(client.url);
        if (page.origin + page.pathname !== entry || page.searchParams.get('mobile') !== '1') return fetch(request);
      }
    }
    return (await caches.match(mobileNavigation ? entry : url.href, { cacheName })) || fetch(request);
  })());
});
