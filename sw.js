// Offline cache. Bump VERSION whenever the app shell changes so phones pick up the new build.
const VERSION = '1';
const SHELL = `reps-shell-${VERSION}`;
const ASSETS = 'reps-assets-1'; // the 24 MB model + wasm: kept across app updates
const SHELL_FILES = [
  './', 'index.html', 'style.css', 'app.js', 'engine.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'vendor/mediapipe/vision_bundle.mjs', 'vendor/mediapipe/wasm/vision_wasm_internal.js',
];
const isAsset = (path) => path.endsWith('.wasm') || path.endsWith('.task');

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('reps-shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(isAsset(url.pathname) ? ASSETS : SHELL);
    const hit = await cache.match(event.request, { ignoreSearch: true });
    if (hit) return hit;
    const res = await fetch(event.request);
    if (res.ok && res.type === 'basic') cache.put(event.request, res.clone());
    return res;
  })());
});
