const SHELL_CACHE = "vsc-shell-v5";
const ASSET_CACHE = "vsc-assets-v5";
const CANONICAL_HTML_ROUTES = new Set([
  "/",
  "/index.html",
  "/login",
  "/login.html",
  "/dashboard",
  "/dashboard.html",
  "/topbar",
  "/topbar.html",
  "/ambiente",
  "/ambiente.html",
  "/animais",
  "/animais.html",
  "/atendimentos",
  "/atendimentos.html",
  "/atualizacoes",
  "/atualizacoes.html",
  "/billing_admin",
  "/billing_admin.html",
  "/billing_blocked",
  "/billing_blocked.html",
  "/clientes",
  "/clientes.html",
  "/configuracoes",
  "/configuracoes.html",
  "/configuracoes_usuarios",
  "/configuracoes_usuarios.html",
  "/contasapagar",
  "/contasapagar.html",
  "/contasareceber",
  "/contasareceber.html",
  "/empresa",
  "/empresa.html",
  "/exames",
  "/exames.html",
  "/fechamentos",
  "/fechamentos.html",
  "/fiscal",
  "/fiscal.html",
  "/fornecedores",
  "/fornecedores.html",
  "/importacaodados",
  "/importacaodados.html",
  "/importacaoxml",
  "/importacaoxml.html",
  "/pedidos",
  "/pedidos.html",
  "/produtos",
  "/produtos.html",
  "/relatorios",
  "/relatorios.html",
  "/relatorios_financeiro",
  "/relatorios_financeiro.html",
  "/reproducao_equina",
  "/reproducao_equina.html",
  "/servicos",
  "/servicos.html"
]);
const CORE = [
  "/",
  "/login",
  "/dashboard",
  "/topbar",
  "/manifest.webmanifest",
  "/assets/styles.css",
  "/assets/css/vsc-premium-enterprise.css",
  "/modules/vsc_db.js",
  "/modules/auth.js",
  "/modules/auth_guard.js",
  "/modules/ui-global.js",
  "/modules/vsc-cloud-sync.js",
  "/modules/vsc-outbox-relay.js",
  "/modules/vsc-attachments-relay.js",
  "/modules/vsc-sync-ui.js"
];

function isProductionPagesHost(hostname) {
  return hostname === "app.vetsystemcontrol.com.br" || hostname === "www.vetsystemcontrol.com.br";
}

function normalizeCanonicalPath(pathname) {
  const clean = String(pathname || "/").replace(/\/+/g, "/");
  if (clean === "/index.html") return "/";
  if (/\.html$/i.test(clean)) return clean.replace(/\.html$/i, "");
  return clean;
}

function shouldCanonicalize(url) {
  return isProductionPagesHost(url.hostname) && CANONICAL_HTML_ROUTES.has(url.pathname);
}

function getCanonicalUrl(url) {
  const next = new URL(url.toString());
  next.pathname = normalizeCanonicalPath(next.pathname);
  return next;
}

function buildForwardRequest(req, url) {
  return new Request(url.toString(), req);
}

async function pruneCaches() {
  const keys = await caches.keys();
  await Promise.all(keys.map((k) => ([SHELL_CACHE, ASSET_CACHE].includes(k) ? null : caches.delete(k))));
}

async function shellCache() {
  return caches.open(SHELL_CACHE);
}

async function assetCache() {
  return caches.open(ASSET_CACHE);
}

function isCacheableAsset(url, response) {
  const p = url.pathname || "";
  const ct = response.headers.get("content-type") || "";
  if (!response.ok || response.status >= 300 || response.redirected) return false;
  if (/\.html?$/i.test(p) || ct.includes("text/html")) return false;
  return /\.(css|js|mjs|png|jpg|jpeg|svg|webp|gif|woff2?|ttf|ico)$/i.test(p);
}

async function matchShellByUrl(cache, url) {
  return (await cache.match(url.toString())) || (await cache.match(url.pathname));
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await shellCache();
    try { await cache.addAll(CORE); } catch (_) {}
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    await pruneCaches();
    self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const originalUrl = new URL(req.url);

  if (req.method !== "GET" || originalUrl.origin !== self.location.origin) return;
  if (originalUrl.pathname.startsWith("/api/")) return;

  const effectiveUrl = shouldCanonicalize(originalUrl) ? getCanonicalUrl(originalUrl) : originalUrl;
  const effectiveReq = effectiveUrl.toString() === originalUrl.toString() ? req : buildForwardRequest(req, effectiveUrl);

  if (req.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await shellCache();
      try {
        const fresh = await fetch(effectiveReq, { cache: "no-store", redirect: "follow" });
        if (fresh && fresh.ok && !fresh.redirected) {
          await cache.put(effectiveUrl.toString(), fresh.clone()).catch(() => {});
          await cache.put(effectiveUrl.pathname, fresh.clone()).catch(() => {});
          if (effectiveUrl.toString() !== originalUrl.toString()) {
            await cache.put(originalUrl.toString(), fresh.clone()).catch(() => {});
            await cache.put(originalUrl.pathname, fresh.clone()).catch(() => {});
          }
        }
        if (fresh) return fresh;
      } catch (_) {}
      return (await matchShellByUrl(cache, originalUrl)) ||
             (await matchShellByUrl(cache, effectiveUrl)) ||
             (await cache.match("/dashboard")) ||
             (await cache.match("/login")) ||
             (await cache.match("/")) ||
             new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } });
    })());
    return;
  }

  event.respondWith((async () => {
    const assetStore = await assetCache();
    const shellStore = await shellCache();
    const cached = (await assetStore.match(req)) ||
                   (effectiveReq !== req ? await assetStore.match(effectiveReq) : null) ||
                   (await shellStore.match(originalUrl.toString())) ||
                   (await shellStore.match(originalUrl.pathname)) ||
                   (effectiveUrl.toString() !== originalUrl.toString() ? ((await shellStore.match(effectiveUrl.toString())) || (await shellStore.match(effectiveUrl.pathname))) : null);

    const networkPromise = fetch(effectiveReq, { cache: "no-store", redirect: "follow" })
      .then(async (res) => {
        if (isCacheableAsset(effectiveUrl, res)) {
          await assetStore.put(effectiveReq, res.clone()).catch(() => {});
          if (effectiveReq !== req) await assetStore.put(req, res.clone()).catch(() => {});
        } else {
          const ct = res.headers.get("content-type") || "";
          if (res.ok && !res.redirected && ct.includes("text/html")) {
            await shellStore.put(effectiveUrl.toString(), res.clone()).catch(() => {});
            await shellStore.put(effectiveUrl.pathname, res.clone()).catch(() => {});
            if (effectiveUrl.toString() !== originalUrl.toString()) {
              await shellStore.put(originalUrl.toString(), res.clone()).catch(() => {});
              await shellStore.put(originalUrl.pathname, res.clone()).catch(() => {});
            }
          }
        }
        return res;
      })
      .catch(() => null);

    if (cached) {
      event.waitUntil(networkPromise);
      return cached;
    }

    const networkRes = await networkPromise;
    if (networkRes) return networkRes;

    return (await matchShellByUrl(shellStore, originalUrl)) ||
           (await matchShellByUrl(shellStore, effectiveUrl)) ||
           new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } });
  })());
});
