/* ArenaSignage offline resilience service worker v1
 *
 * Strict separation so updates NEVER go stale:
 *  - Schedule/ads JSON (worker API)  -> network-first, cached copy served
 *    ONLY when the network fails (response then carries x-asg-cache: 1).
 *  - Ad media (proxy / storage)      -> cache-first. Safe because media URLs
 *    are immutable: new campaign = new URL = cache miss = fresh download.
 *  - Player shell (index, lg-*.js)  -> network-first, cache fallback, so
 *    player deploys roll out exactly as before.
 */
var MEDIA_CACHE = 'asg-media-v1';
var DATA_CACHE = 'asg-data-v1';
var SHELL_CACHE = 'asg-shell-v1';
var MEDIA_CACHE_MAX_ENTRIES = 40; // ~40 items x <=25MB keeps LG storage safe

self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

function isMediaRequest(url) {
  if (url.searchParams.get('media_proxy') === '1') return true;
  return url.pathname.indexOf('/storage/v1/object/public/ad-videos/') !== -1;
}

function isDisplayDataRequest(url) {
  if (url.hostname.indexOf('workers.dev') === -1) return false;
  if (!url.searchParams.get('id')) return false;
  // Only the plain display payload — commands, health, plays etc. must
  // always hit the network and never be answered from cache.
  var blocked = ['command', 'command_ack', 'health', 'device', 'player_error', 'ad_play', 'screenshot', 'media_proxy'];
  for (var i = 0; i < blocked.length; i++) if (url.searchParams.get(blocked[i]) === '1') return false;
  return true;
}

function isShellRequest(url) {
  if (url.origin !== self.location.origin) return false;
  var p = url.pathname;
  return p === '/' || p === '/index.html' || /\/lg-[a-z.]+\.js$/.test(p) || p === '/logo.png';
}

function markCached(response) {
  try {
    var headers = new Headers(response.headers);
    headers.set('x-asg-cache', '1');
    return response.blob().then(function (body) {
      return new Response(body, { status: response.status, statusText: response.statusText, headers: headers });
    });
  } catch (e) { return Promise.resolve(response); }
}

function pruneMediaCache() {
  return caches.open(MEDIA_CACHE).then(function (cache) {
    return cache.keys().then(function (keys) {
      if (keys.length <= MEDIA_CACHE_MAX_ENTRIES) return;
      var excess = keys.length - MEDIA_CACHE_MAX_ENTRIES;
      var removals = [];
      for (var i = 0; i < excess; i++) removals.push(cache.delete(keys[i])); // oldest first
      return Promise.all(removals);
    });
  });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (e) { return; }

  if (isMediaRequest(url)) {
    // Cache-first. Match ignoring Range headers: a full 200 satisfies a
    // ranged video request and keeps playback alive offline.
    event.respondWith(
      caches.open(MEDIA_CACHE).then(function (cache) {
        return cache.match(req.url).then(function (hit) {
          if (hit) return hit;
          return fetch(req.url, { mode: 'cors' }).then(function (net) {
            if (net && net.status === 200) {
              var copy = net.clone();
              cache.put(req.url, copy).then(pruneMediaCache).catch(function () {});
            }
            return net;
          });
        });
      })
    );
    return;
  }

  if (isDisplayDataRequest(url)) {
    event.respondWith(
      fetch(req).then(function (net) {
        if (net && net.ok) {
          var copy = net.clone();
          caches.open(DATA_CACHE).then(function (c) { c.put(req.url, copy); }).catch(function () {});
        }
        return net;
      }).catch(function () {
        return caches.open(DATA_CACHE).then(function (c) { return c.match(req.url); }).then(function (hit) {
          if (hit) return markCached(hit);
          throw new Error('offline and no cached payload');
        });
      })
    );
    return;
  }

  if (isShellRequest(url)) {
    event.respondWith(
      fetch(req).then(function (net) {
        if (net && net.ok) {
          var copy = net.clone();
          caches.open(SHELL_CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        }
        return net;
      }).catch(function () {
        return caches.match(req, { cacheName: SHELL_CACHE }).then(function (hit) {
          if (hit) return hit;
          throw new Error('offline and shell not cached');
        });
      })
    );
  }
});

// The player sends the current media URL list after every payload apply;
// anything no longer referenced is evicted.
self.addEventListener('message', function (event) {
  var data = event.data || {};
  if (data.type !== 'asg-media-keep' || !Array.isArray(data.urls)) return;
  var keep = {};
  data.urls.forEach(function (u) { keep[String(u)] = true; });
  event.waitUntil(
    caches.open(MEDIA_CACHE).then(function (cache) {
      return cache.keys().then(function (keys) {
        return Promise.all(keys.map(function (k) {
          if (!keep[k.url]) return cache.delete(k);
        }));
      });
    })
  );
});
