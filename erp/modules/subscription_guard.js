/* ============================================================
   VSC_SUBSCRIPTION_GUARD — Enforcement tenant-level (mensalidade)
   - Não mistura com lock técnico de usuário
   - Fail-closed para módulos operacionais
   - Permite sempre: login, billing_blocked, billing_admin
   ============================================================ */
(() => {
  "use strict";

  window.__VSC_SUBSCRIPTION_GUARD_BUILD = "ERP2.0.1|subscription_guard.js|ENFORCE_TENANT|2026-02-23";
  // ============================================================
  // BILLING GUARD DESABILITADO (DEV HARD-OFF) — ESOS 5.3
  // ============================================================
  window.__VSC_BILLING_DISABLED_GLOBAL = true;
  window.VSC_SUBSCRIPTION_GUARD = {
    build: window.__VSC_SUBSCRIPTION_GUARD_BUILD + "|BILLING_DISABLED",
    async enforce(){ return true; }
  };
  console.warn("[VSC_SUBSCRIPTION_GUARD] enforcement DESABILITADO (DEV HARD-OFF).");
  return;


  const ALLOW_PAGES = new Set([
    "login.html",
    "billing_blocked.html",
    "billing_admin.html"
  ]);

  function pageName(){
    try{
      const p = (location && location.pathname) ? String(location.pathname) : "";
      const parts = p.split("/").filter(Boolean);
      return (parts[parts.length-1] || "").toLowerCase();
    }catch(_){ return ""; }
  }

  function redirectBlocked(){
    try{
      // preservar destino (para voltar após pagamento)
      const cur = (location && location.href) ? String(location.href) : "";
      const next = encodeURIComponent(cur);
      location.replace("billing_blocked.html?next=" + next);
    }catch(_){
      try{ location.href = "billing_blocked.html"; }catch(__){}
    }
  }

  async function enforce(){
    const pn = pageName();
    if(ALLOW_PAGES.has(pn)) return true;

    if(!window.VSC_SUBSCRIPTION || typeof window.VSC_SUBSCRIPTION.ensureDefault !== "function"){
      // não quebra o ERP se o módulo não carregou (mas fail-closed não pode loopar)
      console.error("[VSC_SUBSCRIPTION_GUARD] VSC_SUBSCRIPTION indisponível.");
      return true;
    }

    const sub = await window.VSC_SUBSCRIPTION.ensureDefault();
    const st = String(sub && sub.status ? sub.status : "ACTIVE").toUpperCase();

    if(st === "SUSPENDED" || st === "CANCELED"){
      redirectBlocked();
      return false;
    }

    return true;
  }

  window.VSC_SUBSCRIPTION_GUARD = { enforce };

  console.log("[VSC_SUBSCRIPTION_GUARD] ready", { build: window.__VSC_SUBSCRIPTION_GUARD_BUILD });
})();
