// SGQT-Version: 12.6
// Module-Version: VSC_BILLING v1.1.0
// Change-Request: CR-2026-010
// Date: 2026-03-03
// Author: Patch Bot (GPT-5.2)

/* ========================================================================
   VET SYSTEM CONTROL – EQUINE
   MÓDULO: FECHAMENTOS (Faturamento em Lote / Statement)
   Correções premium enterprise (UI + fluxo + robustez):
   - Alinha com layout dos módulos (Topbar iframe + UI-global)
   - Corrige integração com VSC_DB: openDB (não openDb)
   - Aguarda readiness (DB/Auth) e fail-closed com toast
   - Lookup de clientes (digitação → lista) no padrão do Atendimentos
   - Carregamento determinístico de atendimentos elegíveis e KPIs
   - Registro de forma de pagamento/condição/parcelas no fechamento (metadados)

   Observação SGQT: PASS/aceite só via PDO local; aqui é proposta de correção.
   ======================================================================== */

(function(){
  "use strict";

  const $ = (id)=>document.getElementById(id);
  const esc = (s)=>String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;").replace(/'/g,"&#39;");

  // ──────────────────────────────────────────────────────────
  // UI helpers
  // ──────────────────────────────────────────────────────────
  function toast(msg, kind){
    // Prefer UI core toast when available.
    try{
      if(window.VSC_UI && typeof window.VSC_UI.toast === "function"){
        const t = (kind === "err") ? "err" : (kind === "ok" ? "ok" : "info");
        window.VSC_UI.toast(t, String(msg||""), { ms: 3200 });
        return;
      }
    }catch(_){ }
    const el = $("toast");
    if(!el){ console.log("[VSC_FECH]", msg); return; }
    el.textContent = String(msg||"");
    el.classList.add("is-on");
    clearTimeout(toast._t);
    toast._t = setTimeout(()=> el.classList.remove("is-on"), 3200);
  }

  function fmtBRLFromCents(cents){
    const v = Number.isFinite(cents) ? cents : Number(cents||0);
    return (v/100).toLocaleString("pt-BR", { style:"currency", currency:"BRL" });
  }

  function ymdToday(){ return new Date().toISOString().slice(0,10); }

  function isoNow(){ return new Date().toISOString(); }

  // ──────────────────────────────────────────────────────────
  // String normalize for lookup
  // ──────────────────────────────────────────────────────────
  function norm(s){
    return String(s||"")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g,"")
      .replace(/\s+/g," ")
      .trim();
  }
  function onlyDigits(s){ return String(s||"").replace(/\D+/g,""); }

  // ──────────────────────────────────────────────────────────
  // DB wrappers
  // ──────────────────────────────────────────────────────────
  async function openDb(){
    if(!window.VSC_DB || typeof window.VSC_DB.openDB !== "function") throw new Error("VSC_DB.openDB indisponível");
    return await window.VSC_DB.openDB();
  }

  function txDone(tx){
    return new Promise((res, rej)=>{
      tx.oncomplete = ()=>res(true);
      tx.onerror = ()=>rej(tx.error || new Error("TX_ERROR"));
      tx.onabort = ()=>rej(tx.error || new Error("TX_ABORT"));
    });
  }

  async function idbGetAll(db, store){
    return await new Promise((res, rej)=>{
      const tx = db.transaction([store], "readonly");
      const st = tx.objectStore(store);
      const rq = st.getAll();
      rq.onsuccess = ()=>res(rq.result || []);
      rq.onerror = ()=>rej(rq.error || new Error("GETALL_FAIL"));
    });
  }

  async function idbPut(db, store, value){
    return await new Promise((res, rej)=>{
      const tx = db.transaction([store], "readwrite");
      tx.objectStore(store).put(value);
      tx.oncomplete = ()=>res(true);
      tx.onerror = ()=>rej(tx.error || new Error("PUT_FAIL"));
      tx.onabort = ()=>rej(tx.error || new Error("PUT_ABORT"));
    });
  }

  // ──────────────────────────────────────────────────────────
  // State
  // ──────────────────────────────────────────────────────────
  const ST = {
    db: null,
    cliente: { id:"", label:"" },
    elegiveis: [],
    selecionados: new Set(),
    bloqueados: [],
    fechamento: null
  };

  // ──────────────────────────────────────────────────────────
  // Cliente lookup (padrão Atendimentos)
  // ──────────────────────────────────────────────────────────
  let LOOKUP_CACHE = [];
  let LOOKUP_READY = false;
  let LOOKUP_TS = 0;
  let _debTo = null;

  function debounce(fn, ms){ clearTimeout(_debTo); _debTo = setTimeout(fn, ms); }

  async function loadClientesCache(force){
    try{
      const now = Date.now();
      const age = now - (LOOKUP_TS||0);
      if(!force && LOOKUP_READY && age < 3000) return;
      const all = await idbGetAll(ST.db, "clientes_master");
      LOOKUP_CACHE = (Array.isArray(all)?all:[])
        .filter(c => c && !c.deleted && !c.deleted_at)
        .map(c => ({
          id: String(c.id||""),
          nome: String(c.nome || c.razao_social || "(sem nome)"),
          status: String(c.status || "ATIVO"),
          doc: String(c.doc || c.cnpj || c.cpf || ""),
          telefone: String(c.telefone || ""),
          cidade: String(c.cidade || ""),
          uf: String(c.uf || ""),
          nome_norm: norm(c.nome || c.razao_social || ""),
          doc_digits: onlyDigits(c.doc || c.cnpj || c.cpf || ""),
          tel_digits: onlyDigits(c.telefone || "")
        }))
        .filter(x => x.id);
      LOOKUP_READY = true;
      LOOKUP_TS = now;
    }catch(_e){
      LOOKUP_CACHE = LOOKUP_CACHE || [];
      LOOKUP_READY = true;
      LOOKUP_TS = Date.now();
    }
  }

  function findClientes(q){
    q = String(q||"").trim();
    if(!q) return [];
    const qn = norm(q);
    const qd = onlyDigits(q);
    const out = [];
    for(let i=0;i<LOOKUP_CACHE.length;i++){
      const c = LOOKUP_CACHE[i];
      let ok = false;
      if(qd && (c.doc_digits.includes(qd) || c.tel_digits.includes(qd))) ok = true;
      if(!ok && qn && c.nome_norm.includes(qn)) ok = true;
      if(ok){ out.push(c); if(out.length>=12) break; }
    }
    return out;
  }

  function lookupHide(){
    const box = $("vscClienteLookup");
    if(!box) return;
    box.hidden = true;
    box.innerHTML = "";
  }

  function lookupRender(list){
    const box = $("vscClienteLookup");
    if(!box) return;
    if(!list.length){
      box.hidden = false;
      box.innerHTML = `<div class="lookup-item"><strong>Nenhum resultado</strong><span>Tente outro termo.</span></div>`;
      return;
    }
    box.hidden = false;
    box.innerHTML = list.map(c=>{
      const sub = [c.doc, c.telefone, (c.cidade && c.uf) ? (c.cidade+"-"+c.uf) : (c.cidade||c.uf)].filter(Boolean).join(" • ");
      const st = String(c.status||"ATIVO").toUpperCase();
      const pill = (st && st !== "ATIVO") ? ` <span style="font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid rgba(0,0,0,.10);background:#f3f4f6;font-weight:900;">${esc(st)}</span>` : "";
      return `<div class="lookup-item" data-id="${esc(c.id)}" data-label="${esc(c.nome)}"><strong>${esc(c.nome)}${pill}</strong><span>${esc(sub)}</span></div>`;
    }).join("");
  }

  function setClienteSelection(id, label){
    ST.cliente.id = String(id||"").trim();
    ST.cliente.label = String(label||"").trim();
    const hid = $("cliente_id"); if(hid) hid.value = ST.cliente.id;
    const inp = $("cliente_busca"); if(inp) inp.value = ST.cliente.label;
    const hint = $("cliente_hint");
    if(hint) hint.textContent = ST.cliente.label ? ("Selecionado: " + ST.cliente.label) : "Digite para buscar. Selecione um item.";
  }

  function wireLookup(){
    const inp = $("cliente_busca");
    const box = $("vscClienteLookup");
    if(!inp || !box || inp.__wired) return;
    inp.__wired = true;

    inp.addEventListener("input", async ()=>{
      try{
        await loadClientesCache(true);
        const q = inp.value || "";
        debounce(()=> lookupRender(findClientes(q)), 120);
      }catch(_){ lookupHide(); }
    });

    inp.addEventListener("focus", async ()=>{
      try{
        await loadClientesCache(true);
        if(inp.value) debounce(()=> lookupRender(findClientes(inp.value)), 120);
      }catch(_){ }
    });

    document.addEventListener("click", (ev)=>{
      if(ev.target === inp || box.contains(ev.target)) return;
      lookupHide();
    });

    box.addEventListener("click", (ev)=>{
      let t = ev.target;
      while(t && t !== box && !t.getAttribute("data-id")) t = t.parentNode;
      if(!t || t === box) return;
      setClienteSelection(t.getAttribute("data-id"), t.getAttribute("data-label"));
      lookupHide();
      // Carrega automaticamente elegíveis quando cliente selecionado.
      void carregarElegiveis();
    });
  }

  // ──────────────────────────────────────────────────────────
  // Elegibilidade / KPIs
  // ──────────────────────────────────────────────────────────
  function isAtendimentoElegivel(a, ini, fim){
    if(!a || !a.id) return false;
    if(String(a.status||"") !== "finalizado") return false;
    if(String(a.cliente_id||"") !== String(ST.cliente.id||"")) return false;

    // anti-dupla-cobrança: atendimento já vinculado a fechamento emitido/rascunho
    if(a.fechamento_id) return false;

    const dt = String(a.created_at||"").slice(0,10);
    if(ini && dt && dt < ini) return false;
    if(fim && dt && dt > fim) return false;
    return true;
  }

  function totalAtendimentoCents(a){
    const t = a && a.totals ? a.totals : null;
    const cents = t && Number.isFinite(t.total_geral_cents) ? t.total_geral_cents : null;
    if(Number.isFinite(cents)) return cents;
    // fallback antigo (float)
    const v = t && Number.isFinite(t.total_geral) ? t.total_geral : 0;
    return Math.round(v * 100);
  }

  function renderKpis(){
    const elig = ST.elegiveis || [];
    const selCount = ST.selecionados.size;
    const selTotal = elig.filter(a => ST.selecionados.has(String(a.id))).reduce((acc,a)=>acc+totalAtendimentoCents(a),0);
    const eligTotal = elig.reduce((acc,a)=>acc+totalAtendimentoCents(a),0);

    $("kpiElegiveis") && ($("kpiElegiveis").textContent = String(elig.length));
    $("kpiTotal") && ($("kpiTotal").textContent = fmtBRLFromCents(eligTotal));
    $("kpiSel") && ($("kpiSel").textContent = String(selCount));
    $("kpiBlock") && ($("kpiBlock").textContent = String((ST.bloqueados||[]).length));

    $("kpiElegiveisSub") && ($("kpiElegiveisSub").textContent = ST.cliente.label ? ("Cliente: " + ST.cliente.label) : "—");
    $("kpiTotalSub") && ($("kpiTotalSub").textContent = selCount ? ("Selecionado: " + fmtBRLFromCents(selTotal)) : "—");
    $("kpiSelSub") && ($("kpiSelSub").textContent = selCount ? "Pronto para emitir" : "Selecione atendimentos");
    $("kpiBlockSub") && ($("kpiBlockSub").textContent = (ST.bloqueados||[]).length ? "Revisar bloqueios" : "—");

    // botões
    const canEmit = selCount > 0;
    $("btnEmitir") && ($("btnEmitir").disabled = !canEmit);
    $("btnImprimir") && ($("btnImprimir").disabled = !(ST.fechamento && ST.fechamento.status === "emitido"));
  }

  function statusBadge(){
    const el = $("uiStatus");
    if(!el) return;
    const f = ST.fechamento;
    if(!f){ el.style.display = "none"; return; }
    el.style.display = "";
    const st = String(f.status||"rascunho");
    el.classList.remove("badge--rascunho","badge--emitido","badge--erro");
    if(st === "emitido"){
      el.classList.add("badge--emitido");
      el.textContent = "EMITIDO";
    }else if(st === "erro"){
      el.classList.add("badge--erro");
      el.textContent = "ERRO";
    }else{
      el.classList.add("badge--rascunho");
      el.textContent = "RASCUNHO";
    }
  }

  function renderAtds(){
    const tb = $("tbAtds");
    if(!tb) return;

    const list = ST.elegiveis || [];
    if(!ST.cliente.id){
      tb.innerHTML = `<tr><td colspan="6" style="padding:18px;" class="hint">Selecione um cliente para listar.</td></tr>`;
      renderKpis();
      return;
    }

    if(!list.length){
      tb.innerHTML = `<tr><td colspan="6" style="padding:18px;" class="hint">Nenhum atendimento elegível no período.</td></tr>`;
      renderKpis();
      return;
    }

    tb.innerHTML = list.map(a=>{
      const id = String(a.id);
      const checked = ST.selecionados.has(id);
      const num = a.numero || "—";
      const dt = String(a.created_at||"").slice(0,10);
      const animals = Array.isArray(a._animal_names) ? a._animal_names.join(", ") : (a._animal_nome || "—");
      const total = fmtBRLFromCents(totalAtendimentoCents(a));
      return `<tr data-id="${esc(id)}">
        <td><input class="chk" data-id="${esc(id)}" type="checkbox" ${checked?"checked":""}/></td>
        <td class="mono" style="font-weight:900;">${esc(num)}</td>
        <td class="mono">${esc(dt || "—")}</td>
        <td>${esc(animals || "—")}</td>
        <td class="mono">${esc(total)}</td>
        <td><span class="badge badge--emitido" style="background:#f8fafc;color:#334155;border-color:rgba(0,0,0,.10);">FINALIZADO</span></td>
      </tr>`;
    }).join("");

    renderKpis();
  }

  async function carregarElegiveis(){
    try{
      if(!ST.db) return;
      if(!ST.cliente.id){ renderAtds(); return; }
      const ini = $("periodo_ini")?.value || "";
      const fim = $("periodo_fim")?.value || "";

      const all = await idbGetAll(ST.db, "atendimentos_master");
      const animaisAll = await idbGetAll(ST.db, "animais_master");

      // Enriquecer nomes de animais
      const list = (Array.isArray(all)?all:[])
        .filter(a => isAtendimentoElegivel(a, ini, fim));

      list.forEach(a=>{
        const ids = Array.isArray(a.animal_ids) ? a.animal_ids : [];
        a._animal_names = ids.map(id=>{
          const an = animaisAll.find(x => String(x.id) === String(id));
          return an ? String(an.nome || id) : String(id);
        }).filter(Boolean);
      });

      // Ordenar por data asc (statement cronológico)
      ST.elegiveis = list.sort((a,b)=>String(a.created_at||"").localeCompare(String(b.created_at||"")));

      // Default: selecionar todos
      ST.selecionados = new Set(ST.elegiveis.map(a => String(a.id)));
      $("chkAll") && ($("chkAll").checked = true);

      // Bloqueados (informativo)
      ST.bloqueados = (Array.isArray(all)?all:[])
        .filter(a => a && a.id && String(a.cliente_id||"") === String(ST.cliente.id||""))
        .filter(a => {
          // no período mas não elegível
          const dt = String(a.created_at||"").slice(0,10);
          if(ini && dt && dt < ini) return false;
          if(fim && dt && dt > fim) return false;
          return String(a.status||"") !== "finalizado" || !!a.fechamento_id;
        });

      renderAtds();
      toast(`Carregado: ${ST.elegiveis.length} elegível(eis).`, "ok");
    }catch(e){
      console.error(e);
      toast("Falha ao carregar atendimentos elegíveis.", "err");
    }
  }

  // ──────────────────────────────────────────────────────────
  // Fechamento (rascunho/emissão)
  // ──────────────────────────────────────────────────────────
  function buildFechamentoDraft(){
    const now = isoNow();
    const competencia = String($("competencia")?.value || "").trim();
    const ini = String($("periodo_ini")?.value || "").trim();
    const fim = String($("periodo_fim")?.value || "").trim();
    const vcto = String($("vencimento")?.value || "").trim();

    const forma = String($("forma_pagamento")?.value || "").trim();
    const cond = String($("condicao")?.value || "").trim();
    const parcelas = Math.max(1, Math.min(24, parseInt(String($("parcelas")?.value||"1"),10)||1));
    const obs = String($("obs")?.value || "").trim();

    const atdIds = Array.from(ST.selecionados.values());
    const totalCents = (ST.elegiveis||[])
      .filter(a => ST.selecionados.has(String(a.id)))
      .reduce((acc,a)=>acc+totalAtendimentoCents(a),0);

    return {
      id: (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ("fech_" + Math.random().toString(16).slice(2) + Date.now()),
      created_at: now,
      updated_at: now,
      status: "rascunho",

      cliente_id: ST.cliente.id,
      cliente_label: ST.cliente.label,

      competencia,
      periodo_ini: ini,
      periodo_fim: fim,
      vencimento: vcto,

      forma_pagamento_preferida: forma,
      condicao_pagamento: cond,
      parcelas,
      obs,

      atendimento_ids: atdIds,
      total_centavos: totalCents,

      ar_id: null,
      emitido_em: null
    };
  }

  async function criarRascunho(){
    if(!ST.cliente.id){ toast("Selecione um cliente.", "err"); return; }
    if(!ST.selecionados.size){ toast("Selecione ao menos 1 atendimento.", "err"); return; }
    const draft = buildFechamentoDraft();

    try{
      await idbPut(ST.db, "fechamentos", draft);
      ST.fechamento = draft;
      statusBadge();
      renderKpis();
      toast("Rascunho criado.", "ok");
    }catch(e){
      console.error(e);
      toast("Falha ao salvar rascunho.", "err");
    }
  }

  async function emitir(){
    // Emissão = cria AR + marca atendimentos com fechamento_id (anti dupla cobrança)
    if(!window.VSC_AR){ toast("Contas a Receber (VSC_AR) não carregado.", "err"); return; }

    if(!ST.fechamento){
      await criarRascunho();
      if(!ST.fechamento) return;
    }
    if(ST.fechamento.status === "emitido"){ toast("Já emitido.", "info"); return; }

    const f = { ...ST.fechamento };
    const atdIds = Array.isArray(f.atendimento_ids) ? f.atendimento_ids : [];
    if(!atdIds.length){ toast("Rascunho sem atendimentos.", "err"); return; }

    try{
      const tx = ST.db.transaction(["atendimentos_master","contas_receber","fechamentos"], "readwrite");
      const stA = tx.objectStore("atendimentos_master");
      const stAR = tx.objectStore("contas_receber");
      const stF = tx.objectStore("fechamentos");

      // Validar novamente elegibilidade e coletar total
      let total = 0;
      for(const id of atdIds){
        const rec = await new Promise((res,rej)=>{
          const rq = stA.get(id);
          rq.onsuccess = ()=>res(rq.result||null);
          rq.onerror = ()=>rej(rq.error||new Error("GET_FAIL"));
        });
        if(!rec) throw new Error("Atendimento não encontrado: " + id);
        if(String(rec.status||"") !== "finalizado") throw new Error("Atendimento não finalizado: " + (rec.numero||id));
        if(rec.fechamento_id) throw new Error("Atendimento já faturado: " + (rec.numero||id));
        total += totalAtendimentoCents(rec);
      }

      // Criar AR (título)
      const arId = (window.VSC_UTILS && window.VSC_UTILS.uuidv4) ? window.VSC_UTILS.uuidv4() : ((window.crypto&&crypto.randomUUID)?crypto.randomUUID():("ar_"+Date.now()));
      const titulo = {
        id: arId,
        tipo: "RECEBER",
        origem: "FECHAMENTO",
        origem_id: f.id,
        cliente_id: f.cliente_id,
        cliente_nome: f.cliente_label,
        competencia: f.competencia || null,
        emissao: ymdToday(),
        vencimento: f.vencimento || ymdToday(),
        valor_centavos: total,
        saldo_centavos: total,
        forma_pagamento_preferida: f.forma_pagamento_preferida || null,
        condicao_pagamento: f.condicao_pagamento || null,
        parcelas: f.parcelas || 1,
        observacao: f.obs || null,
        fechamento_meta: {
          periodo_ini: f.periodo_ini || null,
          periodo_fim: f.periodo_fim || null,
          atendimento_ids: atdIds
        },
        recebimentos: [],
        cancelado: false,
        created_at: isoNow(),
        updated_at: isoNow()
      };
      stAR.put(titulo);

      // Marcar atendimentos
      for(const id of atdIds){
        const rec = await new Promise((res,rej)=>{
          const rq = stA.get(id);
          rq.onsuccess = ()=>res(rq.result||null);
          rq.onerror = ()=>rej(rq.error||new Error("GET_FAIL"));
        });
        rec.fechamento_id = f.id;
        rec.financeiro_gerado = true;
        rec.updated_at = isoNow();
        stA.put(rec);
      }

      // Atualizar fechamento
      f.total_centavos = total;
      f.ar_id = arId;
      f.status = "emitido";
      f.emitido_em = isoNow();
      f.updated_at = isoNow();
      stF.put(f);

      await txDone(tx);

      ST.fechamento = f;
      statusBadge();
      renderKpis();
      toast("Fechamento emitido e AR gerado.", "ok");
    }catch(e){
      console.error(e);
      toast(String("Falha ao emitir: " + (e && (e.message||e))), "err");
      if(ST.fechamento){
        try{
          const f2 = { ...ST.fechamento, status:"erro", updated_at: isoNow() };
          await idbPut(ST.db, "fechamentos", f2);
          ST.fechamento = f2;
          statusBadge();
        }catch(_){ }
      }
    }
  }

  async function imprimir(){
    // Placeholder enterprise: impressão via print_pack.js /api/fechamentos/print-pack
    // Se o endpoint não existir, mantém fail-closed com feedback.
    const f = ST.fechamento;
    if(!f || f.status !== "emitido") { toast("Emita o fechamento antes de imprimir.", "err"); return; }
    try{
      const url = `/api/fechamentos/print-pack?fechamento_id=${encodeURIComponent(String(f.id))}`;
      window.open(url, "_blank", "noopener,noreferrer");
    }catch(_){
      toast("Falha ao abrir impressão.", "err");
    }
  }

  // ──────────────────────────────────────────────────────────
  // Wiring
  // ──────────────────────────────────────────────────────────
  function wireOnce(){
    if(wireOnce.__wired) return;
    wireOnce.__wired = true;

    $("btnCarregar")?.addEventListener("click", ()=>carregarElegiveis());
    $("btnRascunho")?.addEventListener("click", ()=>criarRascunho());
    $("btnEmitir")?.addEventListener("click", ()=>emitir());
    $("btnImprimir")?.addEventListener("click", ()=>imprimir());

    // datas e periodo → recarrega lista
    ["periodo_ini","periodo_fim"].forEach(id=>{
      $(id)?.addEventListener("change", ()=>carregarElegiveis());
    });

    // checkbox all
    $("chkAll")?.addEventListener("change", (ev)=>{
      const on = !!ev.target.checked;
      ST.selecionados = new Set(on ? (ST.elegiveis||[]).map(a=>String(a.id)) : []);
      // atualizar checks
      document.querySelectorAll("#tbAtds input.chk").forEach(ch=>{ ch.checked = on; });
      renderKpis();
    });

    // individual selection
    $("tbAtds")?.addEventListener("change", (ev)=>{
      const t = ev.target;
      if(!t || !t.classList || !t.classList.contains("chk")) return;
      const id = String(t.getAttribute("data-id")||"");
      if(!id) return;
      if(t.checked) ST.selecionados.add(id);
      else ST.selecionados.delete(id);
      // manter chkAll coerente
      const all = (ST.elegiveis||[]).length;
      const sel = ST.selecionados.size;
      $("chkAll") && ($("chkAll").checked = (all>0 && sel === all));
      renderKpis();
    });

    // defaults
    $("periodo_ini") && ($("periodo_ini").value = ymdToday().slice(0,8) + "01");
    $("periodo_fim") && ($("periodo_fim").value = ymdToday());
    $("vencimento") && ($("vencimento").value = ymdToday());
    $("competencia") && ($("competencia").value = ymdToday().slice(0,7));
  }

  async function init(){
    try{
      // readiness gates (compat)
      if(window.__VSC_DB_READY && typeof window.__VSC_DB_READY.then === "function"){
        await window.__VSC_DB_READY;
      }
      if(window.__VSC_AUTH_READY && typeof window.__VSC_AUTH_READY.then === "function"){
        await window.__VSC_AUTH_READY;
      }

      // abrir DB
      ST.db = await openDb();

      // sanity: stores mínimas
      const names = ST.db.objectStoreNames;
      const need = ["clientes_master","atendimentos_master","contas_receber","fechamentos","animais_master"];
      for(const s of need){
        if(!names.contains(s)){
          toast("DB sem store obrigatória: " + s + ". Atualize vsc_db.js.", "err");
          return;
        }
      }

      wireOnce();
      wireLookup();
      await loadClientesCache(true);

      // UI inicial
      renderAtds();
      statusBadge();

    }catch(e){
      console.error(e);
      toast("Erro ao iniciar Fechamentos: " + (e && (e.message||e)), "err");
    }
  }

  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

})();
