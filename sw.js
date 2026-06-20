// ShopManager service worker — only purpose is to make the app installable
// and let the shell load instantly when offline. It deliberately does NOT
// cache or interfere with Supabase API calls, so your data always stays live.
const CACHE_NAME = "shopmanager-shell-v2";
const SHELL_FILES = ["./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(SHELL_FILES);
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE_NAME; }).map(function (k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", function (e) {
  var url = new URL(e.request.url);

  // Only handle GET requests for our own shell files. Everything else
  // (Supabase reads/writes, XLSX library from cdnjs, etc.) goes straight
  // to the network untouched, so live sync is never affected.
  if (e.request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  // Network-first: always try to get the latest version when online (so
  // app updates show immediately, in the APK too). Only fall back to the
  // cached copy if the device has no internet connection right now.
  e.respondWith(
    fetch(e.request)
      .then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(e.request, copy); });
        }
        return res;
      })
      .catch(function () { return caches.match(e.request); })
  );
});
