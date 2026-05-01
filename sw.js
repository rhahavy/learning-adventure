/* Solvix Service Worker
   ------------------------
   Makes the app work offline on Chromebooks, iPads, and phones that lose
   connection mid-lesson. Strategy:
     • Shell (this origin) → cache-first, so the kid's next visit opens
       instantly even without Wi-Fi.
     • Cloud state JSON (jsonblob.com) → network-only, never cache —
       we MUST read fresh state to avoid clobbering progress.
     • Google Fonts + CDN assets → stale-while-revalidate, so they load
       instantly from cache but refresh in the background.
     • Everything else → try network first, fall back to cache if offline.

   Versioning: bump SW_VERSION whenever you change this file OR ship a new
   index.html and need old clients to drop the stale cache. On install we
   pre-cache the shell; on activate we delete caches that don't match the
   current version. skipWaiting + clients.claim means the new SW takes
   over on the very next page load after deploy. */

const SW_VERSION = 'kidquest-v161-w2-complete-lint-cleanup';
const SHELL_CACHE = SW_VERSION + '-shell';
const RUNTIME_CACHE = SW_VERSION + '-runtime';

// Files we want the app to have BEFORE going offline. Keep this tiny —
// it's what the SW pre-fetches on install. Covers both the marketing
// homepage (/) and the app shell (/app/). Bumping SW_VERSION on each
// deploy is how old caches get evicted on the next activate.
const SHELL_URLS = [
  '/',
  '/index.html',
  '/app/',
  '/app/index.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Pre-cache the shell. Use {cache:'reload'} so the install fetch
    // bypasses any HTTP cache and grabs the current live copy.
    await Promise.all(SHELL_URLS.map(url => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    // Activate this SW immediately — skipWaiting() bypasses the
    // "waiting" state so kids get the new version on next reload.
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Delete any cache whose name doesn't match our current version.
    const names = await caches.keys();
    await Promise.all(
      names
        .filter(n => n !== SHELL_CACHE && n !== RUNTIME_CACHE)
        .map(n => caches.delete(n))
    );
    // Take control of any open tabs immediately.
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only handle GETs — never cache POSTs (cloud writes, form submits).
  if(req.method !== 'GET') return;
  const url = new URL(req.url);

  // Cloud blob — ALWAYS network. Stale state = data loss. If the network
  // is down, let it fail naturally; the app's local-first flow handles
  // offline writes via localStorage.
  if(url.hostname.includes('jsonblob.com') || url.hostname.includes('api.jsonbin') ){
    return; // default: browser handles as network
  }

  // Same-origin HTML / JS / CSS / icons → cache-first with background
  // refresh. This is what makes the app open instantly offline.
  if(url.origin === self.location.origin){
    // Cache-bust escape hatch — when the URL carries adminEditor=1 (set
    // by the admin's hidden iframe that extracts the curriculum WEEKS
    // data), skip the cache entirely and go straight to network. The
    // admin scanner relies on getting the FRESHEST app HTML to read
    // post-deploy curriculum changes; the iframe was already adding a
    // ?_=<timestamp> buster, but cacheFirstWithRefresh.match() uses
    // ignoreSearch so the buster did nothing — which is why the admin
    // kept flagging lessons that already had passages added in the
    // last deploy. The scanner is now back in sync with reality.
    if(url.searchParams.get('adminEditor') === '1'){
      event.respondWith(fetch(req).catch(() => new Response('Offline', { status: 503 })));
      return;
    }
    event.respondWith(cacheFirstWithRefresh(req));
    return;
  }

  // Google Fonts, unpkg, jsdelivr — stale-while-revalidate.
  if(url.hostname.endsWith('googleapis.com') || url.hostname.endsWith('gstatic.com') ||
     url.hostname.endsWith('unpkg.com')      || url.hostname.endsWith('jsdelivr.net')){
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // Everything else (YouTube thumbnails, etc.) — network-first, cache as
  // fallback so a previously viewed video thumb still shows offline.
  event.respondWith(networkFirstWithCacheFallback(req));
});

async function cacheFirstWithRefresh(req){
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(req, { ignoreSearch: true });
  // Fire a background refresh so the NEXT load has the latest shell,
  // but don't block this response on it.
  const networkFetch = fetch(req).then(async (res) => {
    if(res && res.ok && res.status === 200){
      try{ await cache.put(req, res.clone()); }catch(e){}
    }
    return res;
  }).catch(()=>null);
  if(cached) return cached;
  const fresh = await networkFetch;
  if(fresh) return fresh;
  // Last resort — if we have the shell at least, serve it for navigation
  // requests so the SPA still boots.
  if(req.mode === 'navigate'){
    const fallback = await cache.match('/index.html');
    if(fallback) return fallback;
  }
  return new Response('Offline', { status: 503, statusText: 'Offline' });
}

async function staleWhileRevalidate(req){
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(req);
  const networkFetch = fetch(req).then(async (res) => {
    if(res && res.ok){
      try{ await cache.put(req, res.clone()); }catch(e){}
    }
    return res;
  }).catch(()=>null);
  return cached || (await networkFetch) || new Response('', { status: 504 });
}

async function networkFirstWithCacheFallback(req){
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const res = await fetch(req);
    if(res && res.ok){
      try{ await cache.put(req, res.clone()); }catch(e){}
    }
    return res;
  } catch(e){
    const cached = await cache.match(req);
    if(cached) return cached;
    return new Response('Offline', { status: 503 });
  }
}
