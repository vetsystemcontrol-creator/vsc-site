/* ============================================================
   VSC_BOOT — Loader determinístico (core-first) — ESOS 5.2
   Objetivo:
   - eliminar race de carregamento (VSC_DB/VSC_AUTH antes de guards)
   - remover duplicações e garantir ordem única
   - fail-closed com mensagem clara (sem loop)
   ============================================================ */
(() => {
  "use strict";

  window.__VSC_BOOT_BUILD = "ERP2.0.1|vsc_boot.js|DETERMINISTIC_LOADER|2026-02-23";

  const BOOT_ATTR = "data-vsc-boot";
  const LOADING_CLASS = "vsc-boot-loading";

  const PAGES = {
    // Core mínimo
    "__core__": [
      "modules/vsc_ui_core.js",
      "modules/vsc_db.js",
      "modules/auth.js"
    ],

    // Páginas
    "login": [
      "modules/vsc_db.js",
      "modules/auth.js",
      "modules/login.js"
    ],
    "dashboard": [
      "modules/app.js",
      "modules/vsc_db.js",
      "modules/auth.js",
      "modules/auth_guard.js",
      "modules/enter-nav.js",
      "modules/vsc-topbar.js",
      "modules/dashboard.js"
    ],
    "configuracoes": [
      "modules/app.js",
      "modules/vsc_db.js",
      "modules/auth.js",
      "modules/auth_guard.js",
      "modules/enter-nav.js",
      "modules/vsc-topbar.js",
      "modules/configuracoes.js"
    ],
    "configuracoes_usuarios": [
      "modules/app.js",
      "modules/vsc_db.js",
      "modules/auth.js",
      "modules/auth_guard.js",
      "modules/enter-nav.js",
      "modules/vsc-topbar.js",
      "modules/configuracoes_usuarios.js"
    ],
    "ambiente": [
      "modules/app.js",
      "modules/vsc_db.js",
      "modules/auth.js",
      "modules/auth_guard.js",
      "modules/enter-nav.js",
      "modules/vsc-topbar.js",
      "modules/ui-global.js",
      "modules/ambiente.js"
    ],
    "exames": [
      "modules/app.js",
      "modules/vsc_db.js",
      "modules/auth.js",
      "modules/auth_guard.js",
      "modules/enter-nav.js",
      "modules/vsc-topbar.js",
      "modules/ui-global.js",
      "modules/exames.js"
    ],
    "servicos": [
      "modules/app.js",
      "modules/vsc_db.js",
      "modules/auth.js",
      "modules/auth_guard.js",
      "modules/enter-nav.js",
      "modules/vsc-topbar.js",
      "modules/ui-global.js",
      "modules/servicos.js"
    ],
    "reproducao_equina": [
      "modules/app.js",
      "modules/vsc_db.js",
      "modules/auth.js",
      "modules/auth_guard.js",
      "modules/enter-nav.js",
      "modules/vsc-topbar.js",
      "modules/reproducao_equina.js"
    ],
    "relatorios": [
      "modules/app.js",
      "modules/vsc_db.js",
      "modules/auth.js",
      "modules/auth_guard.js",
      "modules/enter-nav.js",
      "modules/vsc-topbar.js",
      "modules/vsc-outbox-relay.js",
      "modules/relatorios.js"
    ],
    "relatorios_financeiro": [
      "modules/app.js",
      "modules/vsc_db.js",
      "modules/auth.js",
      "modules/auth_guard.js",
      "modules/enter-nav.js",
      "modules/vsc-topbar.js",
      "modules/vsc-outbox-relay.js",
      "modules/relatorios_financeiro.js"
    ],
    "vsc_test_100": [
      "modules/app.js",
      "modules/vsc_db.js",
      "modules/auth.js",
      "modules/auth_guard.js",
      "modules/vsc-utils.js",
      "modules/vsc-license.js",
      "modules/vsc_commercial_gate.js"
    ]
  };

  function uniq(list){
    const out = [];
    const seen = new Set();
    for(const x of (list||[])){
      const k = String(x||"");
      if(!k) continue;
      if(seen.has(k)) continue;
      seen.add(k);
      out.push(k);
    }
    return out;
  }

  function ensureOverlay(msg){
    try{
      let el = document.getElementById("vscBootOverlay");
      if(!el){
        el = document.createElement("div");
        el.id = "vscBootOverlay";
        el.style.cssText = [
          "position:fixed","inset:0","background:#fff","z-index:99999",
          "display:flex","align-items:center","justify-content:center",
          "font-family:system-ui,Segoe UI,Arial","padding:24px","text-align:center"
        ].join(";");
        const box = document.createElement("div");
        box.style.cssText = "max-width:720px";
        const h = document.createElement("div");
        h.style.cssText = "font-size:18px;font-weight:700;margin-bottom:10px";
        h.textContent = "Carregando módulos…";
        const p = document.createElement("div");
        p.id = "vscBootMsg";
        p.style.cssText = "font-size:14px;color:#333;white-space:pre-wrap";
        p.textContent = msg || "Inicializando…";
        box.appendChild(h); box.appendChild(p);
        el.appendChild(box);
        document.documentElement.classList.add(LOADING_CLASS);
        document.body.appendChild(el);
      }else{
        const p = document.getElementById("vscBootMsg");
        if(p) p.textContent = msg || "Inicializando…";
      }
    }catch(_){}
  }

  function removeOverlay(){
    try{
      const el = document.getElementById("vscBootOverlay");
      if(el) el.remove();
      document.documentElement.classList.remove(LOADING_CLASS);
    }catch(_){}
  }

  function loadScript(src){
    return new Promise((resolve, reject) => {
      // já carregado?
      const existing = document.querySelector('script[data-vsc-loaded="'+src+'"]');
      if(existing){ resolve(true); return; }

      const s = document.createElement("script");
      s.src = src;
      s.async = false; // preservar ordem
      s.charset = "utf-8";
      s.setAttribute("data-vsc-loaded", src);
      s.onload = () => resolve(true);
      s.onerror = () => reject(new Error("Falha ao carregar: " + src));
      document.head.appendChild(s);
    });
  }

  async function boot(pageKey){
    const core = PAGES["__core__"] || [];
    const page = (pageKey && pageKey !== "__core__") ? (PAGES[pageKey] || []) : [];
    // Enterprise rule: core sempre carregado antes de qualquer página
    const scripts = uniq(core.concat(pageKey === "__core__" ? [] : page));

    ensureOverlay("Página: " + pageKey + "\nIniciando…");
    for(let i=0;i<scripts.length;i++){
      const src = scripts[i];
      ensureOverlay("Página: " + pageKey + "\nCarregando ("+(i+1)+"/"+scripts.length+"): " + src);
      await loadScript(src);
    }

    // Gate: garantir core pronto antes de liberar UI
    if(!(window.VSC_DB && typeof window.VSC_DB.openDB === "function")){
      throw new Error("VSC_DB não inicializou corretamente (openDB ausente).");
    }
    if(!(window.VSC_AUTH && typeof window.VSC_AUTH.bootstrap === "function")){
      throw new Error("VSC_AUTH não inicializou corretamente (bootstrap ausente).");
    }

    removeOverlay();
    return true;
  }

  function getPageKey(){
    try{
      const me = document.currentScript;
      if(me){
        const v = me.getAttribute(BOOT_ATTR);
        if(v) return String(v).trim();
      }
    }catch(_){}
    // fallback por pathname
    try{
      const pn = (location.pathname||"").split("/").filter(Boolean).pop() || "";
      const n = pn.toLowerCase().replace(".html","");
      return n || "__core__";
    }catch(_){ return "__core__"; }
  }

  // Execução
  (async () => {
    const pageKey = getPageKey();
    try{
      await boot(pageKey);
    }catch(e){
      console.error("[VSC_BOOT] erro:", e);
      ensureOverlay("FALHA NO BOOT\n\n" + (e && e.message ? e.message : String(e)) + "\n\n(Ver Console F12)");
      // fail-closed: não redirecionar automaticamente para evitar loop.
    }
  })();

})();
