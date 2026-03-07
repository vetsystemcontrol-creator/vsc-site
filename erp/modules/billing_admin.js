/* ============================================================
   billing_admin.js — DEV-only Billing Control
   - Gate: MASTER + localStorage.vsc_dev_mode == "1"
   - Não aparece no dashboard/topbar
   ============================================================ */
(() => {
  "use strict";

  window.__VSC_BILLING_ADMIN_BUILD = "ERP2.0.1|billing_admin.js|DEV_ONLY|2026-02-23";

  function $(id){ return document.getElementById(id); }
  function nowISO(){ return new Date().toISOString(); }

  function setMsg(kind, text){
    const box = $("msgBox");
    if(!box) return;
    if(!kind){ box.className = "msg"; box.style.display="none"; box.textContent=""; return; }
    box.style.display = "block";
    box.className = "msg msg--" + (kind === "ok" ? "ok" : "danger");
    box.textContent = text || "";
  }

  function setPill(kind, text){
    const p = $("pillStatus");
    if(!p) return;
    p.className = "pill" + (kind ? (" pill--" + kind) : "");
    p.textContent = text || "—";
  }

  function isDevMode(){
    try{ return String(localStorage.getItem("vsc_dev_mode")||"") === "1"; }catch(_){ return false; }
  }

  async function gate(){
    if(!window.VSC_AUTH) throw new Error("VSC_AUTH indisponível.");
    await VSC_AUTH.bootstrap();
    const u = await VSC_AUTH.getCurrentUser();
    if(!u) throw new Error("Sem sessão.");

    // Gate por role (MASTER)
    try{ await VSC_AUTH.requireRole("MASTER"); }catch(_){ throw new Error("Acesso negado (exige MASTER)."); }

    // Gate DEV (não é feature para assinante)
    if(!isDevMode()){
      throw new Error("DEV_MODE desativado. Ative: localStorage.vsc_dev_mode = \"1\" e recarregue.");
    }

    return u;
  }

  async function load(){
    setMsg(null, "");
    const u = await gate();

    if(!window.VSC_SUBSCRIPTION) throw new Error("VSC_SUBSCRIPTION indisponível.");
    const sub = await VSC_SUBSCRIPTION.ensureDefault();

    const st = String(sub.status||"ACTIVE").toUpperCase();
    if(st === "ACTIVE") setPill("ok", "✅ ACTIVE");
    else if(st === "GRACE" || st === "PAST_DUE") setPill("warn", "⚠ " + st);
    else setPill("danger", "⛔ " + st);

    $("planId").value = sub.plan_id || "";
    $("statusSel").value = st;
    $("nextDue").value = sub.next_due_at || "";
    $("graceDays").value = "";

    return { u, sub };
  }

  function parseISO(s){
    const x = String(s||"").trim();
    if(!x) return null;
    // aceitar YYYY-MM-DD como ISO date (sem time)
    if(/^\d{4}-\d{2}-\d{2}$/.test(x)) return x;
    // aceitar ISO completo
    if(/^\d{4}-\d{2}-\d{2}T/.test(x)) return x;
    throw new Error("Data inválida (use YYYY-MM-DD ou ISO completo).");
  }

  async function save(){
    setMsg(null, "");
    const u = await gate();

    const status = $("statusSel").value;
    const planId = String($("planId").value||"").trim() || "PLAN_DEFAULT";
    const nextDue = parseISO($("nextDue").value);
    const graceDaysRaw = String($("graceDays").value||"").trim();

    // atualizar plan_id via evento (sem store dedicado ainda)
    const sub = await VSC_SUBSCRIPTION.ensureDefault();
    sub.plan_id = planId;
    sub.updated_at = nowISO();
    sub.updated_by = u.id || null;

    // persist plan_id
    // (mantemos status e carimbos via VSC_SUBSCRIPTION.setStatus)
    await (async () => {
      const db = await VSC_DB.openDB();
      await new Promise((resolve, reject) => {
        const t = db.transaction(["tenant_subscription"], "readwrite");
        const st = t.objectStore("tenant_subscription");
        st.put(sub);
        t.oncomplete = () => resolve(true);
        t.onerror = () => reject(t.error || new Error("Tx falhou"));
        t.onabort = () => reject(t.error || new Error("Tx abortada"));
      }).finally(() => { try{ db.close(); }catch(_){ } });
    })();

    // aplicar graceDays se informado
    if(graceDaysRaw){
      const n = Number(graceDaysRaw);
      if(!isFinite(n) || n < 0) throw new Error("Dias de carência inválidos.");
      await VSC_SUBSCRIPTION.setGraceDays(n, { updated_by: u.id || null, next_due_at: nextDue });
    }else{
      await VSC_SUBSCRIPTION.setStatus(status, { updated_by: u.id || null, next_due_at: nextDue });
    }

    setMsg("ok", "Salvo. Recarregue um módulo para validar enforcement.");
    await load();
  }

  async function markPaid(){
    setMsg(null, "");
    const u = await gate();
    await VSC_SUBSCRIPTION.markPaid({ updated_by: u.id || null });
    setMsg("ok", "Pago registrado. Status ACTIVE.");
    await load();
  }

  async function suspendNow(){
    setMsg(null, "");
    const u = await gate();
    await VSC_SUBSCRIPTION.setStatus("SUSPENDED", { updated_by: u.id || null });
    setMsg("ok", "Tenant suspenso. As telas operacionais devem redirecionar para billing_blocked.html.");
    await load();
  }

  function wire(){
    const b1 = $("btnSalvar");
    if(b1) b1.addEventListener("click", (ev)=>{ ev.preventDefault(); save().catch(e=>setMsg("danger", e && e.message ? e.message : String(e))); });

    const b2 = $("btnMarkPaid");
    if(b2) b2.addEventListener("click", (ev)=>{ ev.preventDefault(); markPaid().catch(e=>setMsg("danger", e && e.message ? e.message : String(e))); });

    const b3 = $("btnSuspender");
    if(b3) b3.addEventListener("click", (ev)=>{ ev.preventDefault(); suspendNow().catch(e=>setMsg("danger", e && e.message ? e.message : String(e))); });
  }

  Promise.resolve().then(() => {
    wire();
    return load();
  }).catch((e)=>{
    setMsg("danger", e && e.message ? e.message : String(e));
    setPill("danger", "⛔ BLOQUEADO");
  });

  console.log("[VSC_BILLING_ADMIN] ready", { build: window.__VSC_BILLING_ADMIN_BUILD });
})();
