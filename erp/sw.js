const CACHE = "vsc-static-v1";
const CORE = [
  "/index.html",
  "/login.html",
  "/dashboard.html",
  "/manifest.webmanifest"
];
self.addEventListener("install", (event) => {
  event.waitUntil((async ()=>{
    const cache = await caches.open(CACHE);
    await cache.addAll(CORE);
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async ()=>{
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k===CACHE)?null:caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Only cache GET same-origin
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith((async ()=>{
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    if (cached) return cached;
    try{
      const res = await fetch(req);
      // Cache static assets opportunistically
      const ct = res.headers.get("content-type") || "";
      if (res.ok && (ct.includes("text/") || ct.includes("javascript") || ct.includes("css") || ct.includes("image") || ct.includes("font"))) {
        cache.put(req, res.clone());
      }
      return res;
    }catch(e){
      // Offline fallback to cached index (works for direct reload)
      const fallback = await cache.match("/index.html");
      return fallback || new Response("Offline", {status: 503, headers: {"content-type":"text/plain"}});
    }
  })());
});
