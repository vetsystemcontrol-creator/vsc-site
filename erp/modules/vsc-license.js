/* ============================================================
   VSC_LICENSE — Licenciamento / Trial / Planos / Bloqueio Progressivo
   Padrão: SaaS B2B (trial 14d, dunning + grace, suspensão progressiva)
   - Fonte soberana: backend (/api/license/*)
   - Offline-first: cache local + last_validation_at (anti-rollback básico)
   - Enforcement: bloqueia transações readwrite (VSC_DB.tx) em modo restrito
   Build: 2026-02-22
   ============================================================ */
(() => {
  "use strict";

  const BUILD = "ERP2.0.1|vsc-license.js|ENTERPRISE|2026-02-22";
  // ============================================================
  // BILLING/Licença DESABILITADOS (DEV HARD-OFF) — ESOS 5.3
  // Motivo: remover completamente enforcement por pagamento até release final.
  // Este módulo fica como NO-OP para não bloquear transações nem UI.
  // ============================================================
  window.__VSC_BILLING_DISABLED_GLOBAL = true;
  window.VSC_LICENSE = {
    build: BUILD + "|BILLING_DISABLED",
    enabled: false,
    status: "DISABLED",
    mode: "DEV_NO_BILLING",
    is_readonly: false,
    banner: null,
    async refresh(){ return this; },
    async getStatus(){ return { status: this.status, enabled: this.enabled, mode: this.mode }; },
    canWrite(){ return true; }
  };
  console.warn("[VSC_LICENSE] billing/licença DESABILITADOS (DEV HARD-OFF).");
  return;

  window.__VSC_LICENSE_BUILD = BUILD;

  const LS_KEY = "vsc_license_state_v1";

  function nowISO(){ return new Date().toISOString(); }
  function ms(x){ const t = Date.parse(String(x||"")); return isFinite(t) ? t : NaN; }
  function clampInt(n, a, b){
    const x = Number(n);
    if(!isFinite(x)) return a;
    return Math.max(a, Math.min(b, Math.trunc(x)));
  }


  function isLocalDev(){
    const proto = String(location && location.protocol || "").toLowerCase();
    const host  = String(location && location.hostname || "").toLowerCase();
    if(proto === "file:") return true;
    if(host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") return true;
    return false;
  }

  function forceLicenseAPI(){
    try{ return String(localStorage.getItem("vsc_force_license_api")||"") === "1"; }catch(_){ return false; }
  }
  function safeJsonParse(s){ try{ return JSON.parse(String(s||"")); }catch(_){ return null; } }
  function loadCache(){
    const o = safeJsonParse(localStorage.getItem(LS_KEY));
    return (o && typeof o === "object") ? o : null;
  }
  function saveCache(o){
    try{ localStorage.setItem(LS_KEY, JSON.stringify(o||{})); }catch(_){}
  }

  async function apiGET(path){
    const r = await fetch(path, { cache:"no-store" });
    const t = await r.text();
    let j = null;
    try{ j = JSON.parse(t); }catch(_){}
    if(!r.ok) {
      const msg = (j && j.error) ? j.error : (t || ("HTTP " + r.status));
      const e = new Error(msg);
      e.status = r.status;
      e.body = j || t;
      throw e;
    }
    return j || {};
  }

  // ------------------------ Policy
  function computePolicy(state){
    // state: { status, trial_end_at, period_end_at, grace_days, last_validation_at }
    const now = Date.now();
    const status = String(state && state.status || "UNKNOWN");
    const trialEnd = ms(state && state.trial_end_at);
    const periodEnd = ms(state && state.period_end_at);
    const lastVal  = ms(state && state.last_validation_at);

    // anti-rollback (básico): se relógio voltou antes da última validação, restringe
    let antiRollback = false;
    if(isFinite(lastVal) && now + 2*60*1000 < lastVal) antiRollback = true; // tolerância 2 min

    let phase = "ACTIVE";
    let message = "";
    let color = "ok";

    const dPlus = (baseMs) => Math.floor((now - baseMs) / (24*60*60*1000));

    if(antiRollback){
      phase = "SUSPENDED";
      color = "danger";
      message = "Relógio do sistema inconsistente. Conecte para revalidar a licença.";
      return { phase, color, message, antiRollback:true, d: null };
    }

    if(status === "TRIAL_ACTIVE"){
      if(isFinite(trialEnd) && now <= trialEnd){
        phase = "TRIAL";
        color = "warn";
        const daysLeft = Math.max(0, Math.ceil((trialEnd - now) / (24*60*60*1000)));
        message = "Trial ativo — " + daysLeft + " dia(s) restante(s).";
        return { phase, color, message, d: null };
      }
      // trial expirou
    }

    // ACTIVE
    if(status === "ACTIVE"){
      phase = "ACTIVE";
      color = "ok";
      message = "Assinatura ativa.";
      return { phase, color, message, d: null };
    }

    // PAST_DUE / TRIAL_ENDED / UNKNOWN => usa period_end_at como base de vencimento
    const base = isFinite(periodEnd) ? periodEnd : (isFinite(trialEnd) ? trialEnd : NaN);
    if(!isFinite(base)){
      // sem base => fail-closed leve: permite leitura, bloqueia writes críticos
      phase = "PAST_DUE_14";
      color = "danger";
      message = "Licença não validada. Conecte para validar.";
      return { phase, color, message, d: null };
    }

    const d = dPlus(base);
    if(d <= 0){
      phase = "PAST_DUE_0";
      color = "warn";
      message = "Pagamento em atraso. Regularize para evitar bloqueio progressivo.";
      return { phase, color, message, d };
    }
    if(d >= 20){
      phase = "SUSPENDED";
      color = "danger";
      message = "Acesso suspenso (somente leitura). Efetue o pagamento para desbloquear.";
      return { phase, color, message, d };
    }
    if(d >= 14){
      phase = "PAST_DUE_14";
      color = "danger";
      message = "Acesso restrito (operações críticas bloqueadas). Regularize o pagamento.";
      return { phase, color, message, d };
    }
    if(d >= 7){
      phase = "PAST_DUE_7";
      color = "warn";
      message = "Acesso restrito (novas inclusões bloqueadas). Regularize o pagamento.";
      return { phase, color, message, d };
    }
    phase = "PAST_DUE_0";
    color = "warn";
    message = "Pagamento em atraso. Regularize para evitar bloqueio progressivo.";
    return { phase, color, message, d };
  }

  // ------------------------ UI banner
  function ensureBanner(){
    let el = document.getElementById("vscLicenseBanner");
    if(el) return el;

    el = document.createElement("div");
    el.id = "vscLicenseBanner";
    el.style.position = "sticky";
    el.style.top = "0";
    el.style.zIndex = "9999";
    el.style.padding = "10px 12px";
    el.style.fontWeight = "900";
    el.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, Arial";
    el.style.borderBottom = "1px solid rgba(0,0,0,.08)";
    el.style.display = "none";
    el.style.cursor = "default";
    (document.body || document.documentElement).prepend(el);
    return el;
  }

  function renderBanner(policy, state){
    const el = ensureBanner();
    // Em ambiente local (dev/offline) sem backend, não exibe banner nem aplica bloqueio.
    if(state && state._dev_local){ el.style.display = "none"; return; }
    if(!policy) { el.style.display = "none"; return; }

    let bg = "#e8f7ee"; // ok
    if(policy.color === "warn") bg = "#fff7e6";
    if(policy.color === "danger") bg = "#ffe7ee";

    el.style.background = bg;
    el.style.color = "#111";
    el.textContent = "🔐 " + (policy.message || "Licença");
    el.style.display = "block";
  }

  // ------------------------ Enforcement via VSC_DB.tx
  const ALLOW_STORES_ALWAYS = new Set([
    "sync_queue",
    "config_params","config_audit_log",
    "auth_users","auth_roles","auth_role_permissions","auth_sessions","auth_audit_log",
    "sys_meta","updates_inbox"
  ]);

  function shouldBlockWrites(policy){
    // Política determinística:
    // - TRIAL/ACTIVE: não bloqueia
    // - PAST_DUE_0: não bloqueia
    // - PAST_DUE_7+: bloqueia writes em stores de negócio (fail-safe)
    if(!policy) return true;
    if(policy.phase === "ACTIVE" || policy.phase === "TRIAL" || policy.phase === "PAST_DUE_0") return false;
    return true;
  }

  function patchVSCDB(){
    if(!window.VSC_DB || typeof window.VSC_DB.tx !== "function") return false;
    if(window.VSC_DB.__LICENSE_PATCHED) return true;

    const origTx = window.VSC_DB.tx;
    window.VSC_DB.tx = async function(storeNames, mode, fn){
      try{
        const isRW = String(mode||"").toLowerCase().includes("readwrite");
        if(isRW){
          const names = Array.isArray(storeNames) ? storeNames : [storeNames];
          const cache = window.VSC_LICENSE && window.VSC_LICENSE.state ? window.VSC_LICENSE.state : loadCache();
          const policy = computePolicy(cache || {});
          if(shouldBlockWrites(policy)){
            // allowlist
            let allow = true;
            for(let i=0;i<names.length;i++){
              const n = String(names[i]||"");
              if(!ALLOW_STORES_ALWAYS.has(n)){
                allow = false; break;
              }
            }
            if(!allow){
              const e = new Error("Operação bloqueada por licenciamento (" + policy.phase + ").");
              e.code = "VSC_LICENSE_BLOCK";
              throw e;
            }
          }
        }
      }catch(err){
        throw err;
      }
      return origTx.apply(this, arguments);
    };

    window.VSC_DB.__LICENSE_PATCHED = true;
    return true;
  }

  // ------------------------ Public API
  const VSC_LICENSE = {
    state: null,
    policy: null,

    computePolicy(){ return computePolicy(this.state || {}); },

    async refresh(){
      // Determinístico:
      // - Em ambiente local (dev/offline) SEM backend: não faz chamada /api/* (evita 404 no console),
      //   usa cache se existir; senão, considera ACTIVE (dev) sem banner e sem bloqueio.
      // - Em ambiente com backend: consulta /api/license/status; em falha, usa cache.
      let st = null;

      const localDevNoAPI = isLocalDev() && !forceLicenseAPI();

      if(localDevNoAPI){
        st = loadCache();
        if(!st || typeof st !== "object"){
          st = { status:"ACTIVE", _dev_local:true, last_validation_at: nowISO() };
        }else{
          st._dev_local = true;
        }
        this.state = st;
        this.policy = computePolicy(st || {});
        renderBanner(this.policy, this.state);
        patchVSCDB();
        return { ok:true, state:this.state, policy:this.policy };
      }

      try{
        const j = await apiGET("/api/license/status");
        st = (j && j.state) ? j.state : j;
        if(st && typeof st === "object"){
          st.last_validation_at = nowISO();
          saveCache(st);
        }
      }catch(_){
        st = loadCache() || { status:"UNKNOWN" };
      }

      this.state = st;
      this.policy = computePolicy(st || {});
      renderBanner(this.policy, this.state);
      patchVSCDB();
      return { ok:true, state:this.state, policy:this.policy };
    },

    async selfTest(){
      const r = await this.refresh();
      const hasDB = !!(window.VSC_DB && window.VSC_DB.openDB);
      return { ok:true, build:BUILD, hasDB, policy:r.policy, state:r.state };
    }
  };

  window.VSC_LICENSE = VSC_LICENSE;

  // Boot
  document.addEventListener("DOMContentLoaded", () => {
    VSC_LICENSE.refresh().catch(()=>{});
  });

})();
