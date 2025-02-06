
const CACHE_NAME = 'flash-cache';

// A list of local resources we always want to be cached.
const PRECACHE_URLS = [
  'index.html',
];

// The install handler takes care of precaching the resources we always need.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        cache.addAll(PRECACHE_URLS);
      })
      .then(self.skipWaiting())
  );
});

// If a cache response exists, returns it, otherwise fetches result from server.
// If a cache response exists, try to fetch and update it (subsequent requests will
// get the updated response).
// Inpsired by https://jakearchibald.com/2014/offline-cookbook/#stale-while-revalidate
self.addEventListener('fetch', (event) => {
  if (!event.request.url.startsWith(self.location.origin)) {
    return;
  }
  // Skip non-GET requests.
  if (event.request.method !== 'GET') {
    return;
  }
  event.respondWith(
    (async function () {
      const cache = await caches.open('mysite-dynamic');
      const cachedResponse = await cache.match(event.request);
      const networkResponsePromise = fetch(event.request).catch(err => {
        // This catch() will handle exceptions thrown from the fetch() operation.
      });

      event.waitUntil(
        (async function () {
          const networkResponse = await networkResponsePromise;
          if (networkResponse) {
            await cache.put(event.request, networkResponse.clone());
          }
        })(),
      );

      // Returned the cached response if we have one, otherwise return the network response.
      return cachedResponse || networkResponsePromise;
    })(),
  );
});