/* =====================================================================================
   THE CRISIS SERVICE WORKER -- the app itself, kept on the handset.

     "Crisis Preparedness: Develop response plans for expected damages e.g. national
      challenges of oct 29th 2025 when internet was shut down. Here we should have a hidden
      switch to download offline data that when I allow it and one presses it then the app
      saves all the customer columns to be accessed offline: and the app itself"

   The lists were already surviving offline -- every screen the officer works from lives in
   localStorage and boot() enters from the warm copy when the network is dead. What did NOT
   survive was the PAGE: if Android had evicted /call from the ordinary browser cache, a
   shutdown left the officer with saved data and no app to read it with.

   This worker closes exactly that gap and nothing more:

     /call and /brand.js   cache-first, refreshed in the background on every ONLINE open --
                           so the copy is at most one online visit old, and a shutdown finds
                           it ready
     /api/*                NEVER touched. The page's own code owns every failure there and
                           says the right words for each; a worker interfering would turn
                           "taarifa zinachelewa kuupdate" into silent wrongness.
     everything else       straight to the network, exactly as if this worker did not exist

   Registered by call.html ONLY while the admin's OFFLINE_PACK setting says yes, and
   unregistered -- caches deleted -- the next time boot() sees the setting off. The switch
   stays in the company's hands.
   ===================================================================================== */
var CACHE = 'hoop-crisis-v1';
var PAGES = ['/call', '/brand.js'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(PAGES); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(self.clients.claim());
});
self.addEventListener('message', function (e) {
  // The page says "the admin switched this off": drop everything and retire.
  if (e.data === 'hoop-crisis-off') {
    caches.delete(CACHE).then(function () { return self.registration.unregister(); });
  }
});
self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;                 // other hosts: not ours
  if (url.pathname.indexOf('/api/') === 0) return;                 // the page owns its API failures
  var page = PAGES.indexOf(url.pathname) >= 0
    || (e.request.mode === 'navigate' && url.pathname === '/call');
  if (!page) return;
  /* Cache first, refresh behind: the officer gets the app instantly and offline; every
     ONLINE open quietly replaces the stored copy with the newest deploy. */
  e.respondWith(
    caches.open(CACHE).then(function (c) {
      return c.match(url.pathname).then(function (hit) {
        var fresh = fetch(e.request).then(function (res) {
          if (res && res.ok) c.put(url.pathname, res.clone());
          return res;
        }).catch(function () { return hit; });
        return hit || fresh;
      });
    })
  );
});
