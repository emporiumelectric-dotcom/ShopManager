// ShopManager service worker: cache the application shell separately from
// validated runtime configuration. Supabase reads and writes remain online.
importScripts("config-validation.js", "shell-files.js");

const CACHE_NAME = "shopmanager-shell-v3";
const CONFIG_CACHE_NAME = "shopmanager-config-v1";
const CACHE_WHITELIST = [CACHE_NAME, CONFIG_CACHE_NAME];
const SHELL_FILES = self.EEShellFiles;

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(SHELL_FILES);
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    Promise.all([
      caches.keys().then(function (keys) {
        return Promise.all(
          keys
            .filter(function (key) {
              return CACHE_WHITELIST.indexOf(key) === -1;
            })
            .map(function (key) {
              return caches.delete(key);
            })
        );
      }),
      self.clients.claim()
    ])
  );
});

function configUnavailableResponse() {
  return new Response(JSON.stringify({ error: "config_unavailable" }), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function validateConfigResponse(response) {
  if (!response || !response.ok) {
    return Promise.reject(new Error("config_http_error"));
  }

  return response
    .clone()
    .text()
    .then(function (body) {
      var result = self.EEConfigValidation.validateConfigBody(body);
      if (!result.ok) {
        throw new Error(result.error);
      }
      return response;
    });
}

function serveCachedConfig(request) {
  return caches
    .open(CONFIG_CACHE_NAME)
    .then(function (configCache) {
      return configCache.match(request).then(function (cached) {
        if (!cached) {
          return configUnavailableResponse();
        }

        return cached
          .clone()
          .text()
          .then(function (body) {
            var result = self.EEConfigValidation.validateConfigBody(body);
            if (result.ok) {
              return cached;
            }

            return configCache.delete(request).then(function () {
              return configUnavailableResponse();
            });
          })
          .catch(function () {
            return configCache.delete(request).then(function () {
              return configUnavailableResponse();
            });
          });
      });
    })
    .catch(function () {
      return configUnavailableResponse();
    });
}

function handleConfig(request) {
  return fetch(request, { cache: "no-store" })
    .then(validateConfigResponse)
    .then(
      function (response) {
        return caches
          .open(CONFIG_CACHE_NAME)
          .then(function (configCache) {
            return configCache.put(request, response.clone());
          })
          .catch(function () {
            // A valid network response is still safe to serve if caching fails.
          })
          .then(function () {
            return response;
          });
      },
      function () {
        return serveCachedConfig(request);
      }
    );
}

self.addEventListener("fetch", function (event) {
  var url = new URL(event.request.url);

  if (
    event.request.method === "GET" &&
    url.origin === self.location.origin &&
    url.pathname.endsWith("/config.json")
  ) {
    event.respondWith(handleConfig(event.request));
    return;
  }

  // Cross-origin dependencies and all non-GET requests stay network-only.
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin
  ) {
    return;
  }

  // Network-first keeps application updates immediate. The shell cache is
  // only used when the network request itself fails.
  event.respondWith(
    fetch(event.request)
      .then(function (response) {
        if (response && response.status === 200) {
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function (shellCache) {
            shellCache.put(event.request, copy);
          });
        }
        return response;
      })
      .catch(async function () {
        try {
          var shellCache = await caches.open(CACHE_NAME);
          var cached =
            event.request.mode === "navigate"
              ? await shellCache.match("./index.html")
              : await shellCache.match(event.request);
          if (cached) {
            return cached;
          }
        } catch (error) {
          // Fall through to the explicit offline response below.
        }

        return new Response("Offline and no cached copy available.", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
      })
  );
});
