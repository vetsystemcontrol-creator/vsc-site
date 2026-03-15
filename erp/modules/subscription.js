/* ============================================================
   VSC_SUBSCRIPTION — Subscription/Billing Control (tenant-level)
   - Domínio separado de Auth (boas práticas SaaS)
   - Máquina de estados: ACTIVE | PAST_DUE | GRACE | SUSPENDED | CANCELED
   - Ledger de eventos: billing_events (imutável)
   - Offline-first: tudo em IndexedDB
   ============================================================ */
(() => {
  "use strict";

  window.__VSC_SUBSCRIPTION_BUILD = "ERP2.0.1|subscription.js|TENANT_BILLING|2026-02-23";
  // ============================================================
  // BILLING/SUBSCRIPTION DESABILITADOS (DEV HARD-OFF) — ESOS 5.3
  // ============================================================
  window.__VSC_BILLING_DISABLED_GLOBAL = true;
  window.VSC_SUBSCRIPTION = {
    build: (typeof BUILD!=="undefined"?BUILD:"ERP2.0.1|subscription.js") + "|BILLING_DISABLED",
    enabled: false,
    status: "ACTIVE",
    plan: "DEV",
    is_blocked: false,
    async refresh(){ return this; },
    async getStatus(){ return { status: "ACTIVE", enabled: false, plan: "DEV" }; },
    isActive(){ return true; }
  };
  console.warn("[VSC_SUBSCRIPTION] billing/mensalidade DESABILITADOS (DEV HARD-OFF).");
  return;


  const S_SUB = "tenant_subscription";
  const S_EVT = "billing_events";

  const STATES = Object.freeze({
    ACTIVE: "ACTIVE",
    PAST_DUE: "PAST_DUE",
    GRACE: "GRACE",
    SUSPENDED: "SUSPENDED",
    CANCELED: "CANCELED"
  });

  function nowISO(){ return new Date().toISOString(); }

  function uuid(){
    try{
      if(window.VSC_UTILS && typeof window.VSC_UTILS.uuidv4 === "function") return window.VSC_UTILS.uuidv4();
    }catch(_){}
    try{ if(typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID(); }catch(_){}
    try{
      if(typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function"){
        const buf = new Uint8Array(16);
        crypto.getRandomValues(buf);
        buf[6] = (buf[6] & 0x0f) | 0x40;
        buf[8] = (buf[8] & 0x3f) | 0x80;
        const hex = Array.from(buf).map(b=>b.toString(16).padStart(2,"0")).join("");
        return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join("-");
      }
    }catch(_){}
    throw new TypeError("[SUBSCRIPTION] ambiente sem CSPRNG para gerar UUID v4.");
  }

  function tenantId(){
    // Enquanto o ERP não tiver tenant provisioning formal, usamos singleton.
    // (Fácil de migrar depois: basta trocar a origem do tenant_id)
    return "tenant_singleton";
  }

  async function openDB(){
    if(!window.VSC_DB || typeof window.VSC_DB.openDB !== "function") throw new Error("VSC_DB.openDB indisponível.");
    return await window.VSC_DB.openDB();
  }

  async function tx(storeNames, mode, fn){
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const t = db.transaction(storeNames, mode);
      const stores = {};
      for(const s of storeNames) stores[s] = t.objectStore(s);

      let done = false;
      t.oncomplete = () => { if(!done){ done=true; resolve(true); } };
      t.onerror = () => { if(!done){ done=true; reject(t.error || new Error("Tx falhou")); } };
      t.onabort = () => { if(!done){ done=true; reject(t.error || new Error("Tx abortada")); } };

      try{ fn(stores, t); }
      catch(e){ try{ t.abort(); }catch(_){ } if(!done){ done=true; reject(e); } }
    }).finally(() => { try{ db.close(); }catch(_){ } });
  }

  function normState(s){
    const x = String(s||"").toUpperCase().trim();
    return STATES[x] || null;
  }

  function makeSig(type, payload){
    // sig determinístico simples: type + JSON canonical-ish
    // (suficiente para dedup de eventos locais, sem crypto pesado)
    const p = payload ? JSON.stringify(payload) : "";
    return type + "|" + p;
  }

  async function getSubscription(tenant_id){
    const tid = tenant_id || tenantId();
    let out = null;
    await tx([S_SUB], "readonly", (s) => {
      const req = s[S_SUB].get(tid);
      req.onsuccess = () => { out = req.result || null; };
    });
    return out;
  }

  async function ensureDefault(tenant_id){
    const tid = tenant_id || tenantId();
    let sub = await getSubscription(tid);
    if(sub) return sub;

    const now = nowISO();
    sub = {
      tenant_id: tid,
      plan_id: "PLAN_DEFAULT",
      status: STATES.ACTIVE,
      current_period_start: null,
      current_period_end: null,
      next_due_at: null,
      grace_until: null,
      blocked_at: null,
      cancel_at: null,
      last_payment_at: null,
      gateway: {
        provider: "NONE",          // NONE | STRIPE | FUTURE
        customer_id: null,
        subscription_id: null,
        last_webhook_at: null
      },
      updated_at: now,
      updated_by: null
    };

    await tx([S_SUB], "readwrite", (s) => {
      s[S_SUB].put(sub);
    });

    await recordEvent(tid, "SUB_INIT", { status: sub.status, plan_id: sub.plan_id });
    return sub;
  }

  async function recordEvent(tenant_id, type, payload){
    const tid = tenant_id || tenantId();
    const now = nowISO();
    const evt = {
      id: uuid(),
      tenant_id: tid,
      type: String(type||"").toUpperCase(),
      payload: payload || null,
      created_at: now,
      sig: makeSig(String(type||"").toUpperCase(), payload || null)
    };

    // best-effort idempotente via index unique sig
    await tx([S_EVT], "readwrite", (s) => {
      try{ s[S_EVT].add(evt); }catch(_e){ /* ignore */ }
    }).catch((_e) => { /* ignore unique */ });

    return evt.id;
  }

  async function setStatus(nextStatus, opts){
    const tid = tenantId();
    const st = normState(nextStatus);
    if(!st) throw new Error("Status inválido.");

    const meta = opts || {};
    const now = nowISO();

    let sub = await ensureDefault(tid);

    // regras determinísticas de carimbo
    const prev = sub.status;
    sub.status = st;
    sub.updated_at = now;
    sub.updated_by = meta.updated_by || null;

    if(st === STATES.SUSPENDED){
      sub.blocked_at = now;
    }
    if(st === STATES.ACTIVE){
      sub.blocked_at = null;
      sub.grace_until = null;
    }
    if(st === STATES.CANCELED){
      sub.cancel_at = now;
    }

    if(meta.next_due_at !== undefined) sub.next_due_at = meta.next_due_at;
    if(meta.current_period_end !== undefined) sub.current_period_end = meta.current_period_end;
    if(meta.current_period_start !== undefined) sub.current_period_start = meta.current_period_start;
    if(meta.grace_until !== undefined) sub.grace_until = meta.grace_until;
    if(meta.last_payment_at !== undefined) sub.last_payment_at = meta.last_payment_at;

    await tx([S_SUB], "readwrite", (s) => {
      s[S_SUB].put(sub);
    });

    await recordEvent(tid, "SUB_STATUS", {
      from: prev,
      to: st,
      meta: {
        next_due_at: sub.next_due_at,
        grace_until: sub.grace_until,
        current_period_end: sub.current_period_end
      }
    });

    return sub;
  }

  async function setGraceDays(days, opts){
    const n = Number(days);
    if(!isFinite(n) || n < 0) throw new Error("Dias inválidos.");
    const d = n === 0 ? null : new Date(Date.now() + (n * 24*60*60*1000)).toISOString();
    return await setStatus(n === 0 ? STATES.PAST_DUE : STATES.GRACE, Object.assign({}, opts||{}, { grace_until: d }));
  }

  async function markPaid(opts){
    const now = nowISO();
    return await setStatus(STATES.ACTIVE, Object.assign({}, opts||{}, { last_payment_at: now }));
  }

  window.VSC_SUBSCRIPTION = {
    STATES,
    tenantId,
    ensureDefault,
    getSubscription,
    setStatus,
    setGraceDays,
    markPaid,
    recordEvent
  };

  console.log("[VSC_SUBSCRIPTION] ready", { build: window.__VSC_SUBSCRIPTION_BUILD });
})();
