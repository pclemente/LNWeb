const CACHE = 'mi-loteria-shell-2026-7';
const SHELL = ['./', './index.html', './styles.css', './script.js', './app-core.js', './pwa.js', './privacy.html', './manifest.json', './images/icon-32.png', './images/icon-180.png', './images/icon-192.png', './images/icon-512.png', './images/uky.png', './images/cookie.jpg'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  // Activate after old clients close, avoiding mixed application versions.
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('mi-loteria-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    const page = url.pathname.endsWith('/privacy.html') ? './privacy.html' : './index.html';
    event.respondWith(caches.match(page).then(cached => cached || fetch(event.request))); 
    return;
  }
  const assets = SHELL.map(path => new URL(path, self.registration.scope).pathname);
  if (!assets.includes(url.pathname)) return;
  event.respondWith(caches.match(event.request, { ignoreSearch: true }).then(cached => cached || fetch(event.request)));
});
