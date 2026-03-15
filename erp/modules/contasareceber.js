/* =====================================================================================
   VET SYSTEM CONTROL – EQUINE
   Módulo: CONTAS A RECEBER (AR)
   Versão: VSC_AR v2.0.0 (IDB canônico)

   CORREÇÃO R-01 (Auditoria 2026-02-18):
     Persistência migrada de localStorage → IndexedDB canônico (VSC_DB.contas_receber).
     Migração one-shot via _migrateLStoIDB() com flag em localStorage.

   CORREÇÃO R-04/R-05: utilitários delegados a VSC_UTILS (sem duplicação, sem Math.random)
   ===================================================================================== */

(() => {
  "use strict";

  const VSC_AR_VERSION = "2.0.0";

  // ---------------------------
  // Delegação a VSC_UTILS (R-04)
  // ---------------------------
  const _u = window.VSC_UTILS;
  if (!_u) {
    (window.VSC_UI?window.VSC_UI.toast("err", String("[VSC_AR] VSC_UTILS não encontrado. Carregue vsc-utils.js antes de contasareceber.js"), {ms:3200}):null);
return;
  }
  const nowISO        = _u.nowISO;
  const todayYMD      = _u.todayYMD;
  const uuidv4        = _u.uuidv4;
  const clampInt      = _u.clampInt;
  const safeJSONParse = _u.safeJSONParse;

  const _db = window.VSC_DB;
  if (!_db) {
    (window.VSC_UI?window.VSC_UI.toast("err", String("[VSC_AR] VSC_DB não encontrado. Carregue vsc_db.js antes de contasareceber.js"), {ms:3200}):null);
return;
  }

  // ---------------------------
  // Storage Keys (somente para migração)
  // ---------------------------
  const KEY_AR_LS      = "contas_receber";
  const MIGRATION_FLAG = "vsc_ar_migrated_v1";

  function _safeJSONParse(txt, fallback) {
    try { return JSON.parse(txt); } catch (_) { return fallback; }
  }

  // BRL <-> centavos delegados a VSC_UTILS (R-04)
  const moneyToCentsBR = _u.moneyToCentsBR;
  const centsToMoneyBR = _u.centsToMoneyBR;

  function normalizeString(s) {
    return String(s ?? "").trim();
  }

  // ---------------------------
  // Modelo canônico (AR)
  // ---------------------------
  // status derivado:
  // - recebido: saldo==0
  // - parcial: saldo>0 e tem recebimentos
  // - vencido: saldo>0 e vencimento < hoje
  // - aberto: saldo>0 e não vencido
  // - cancelado: flag cancelado=true
  function computeStatus(t) {
    if (!t) return "aberto";
    if (t.cancelado) return "cancelado";
    const saldo = clampInt(t.saldo_centavos ?? 0, 0, 2147483647);
    if (saldo === 0) return "recebido";
    const recs = Array.isArray(t.recebimentos) ? t.recebimentos : [];
    const hasRec = recs.length > 0;
    const vcto = normalizeString(t.vencimento);
    const hoje = todayYMD();
    const vencido = vcto && vcto < hoje;
    if (hasRec) return "parcial";
    if (vencido) return "vencido";
    return "aberto";
  }

  function normalizeTitulo(x) {
    const obj = (x && typeof x === "object") ? x : {};
    const id = normalizeString(obj.id) || uuidv4();

    const valor_original_centavos = clampInt(obj.valor_original_centavos ?? 0, 0, 2147483647);
    const saldo_centavos = clampInt(
      (obj.saldo_centavos ?? valor_original_centavos),
      0,
      2147483647
    );

    const recsIn = Array.isArray(obj.recebimentos) ? obj.recebimentos : [];
    const recebimentos = recsIn.map(r => ({
      id: normalizeString(r.id) || uuidv4(),
      valor_centavos: clampInt(r.valor_centavos ?? 0, 0, 2147483647),
      data: normalizeString(r.data) || todayYMD(),
      forma_pagamento: normalizeString(r.forma_pagamento),
      obs: normalizeString(r.obs),
      created_at: normalizeString(r.created_at) || nowISO()
    })).filter(r => r.valor_centavos > 0);

    const t = {
      id,
      documento: normalizeString(obj.documento),
      cliente_nome: normalizeString(obj.cliente_nome),
      cliente_doc: normalizeString(obj.cliente_doc),
      competencia: normalizeString(obj.competencia),      // "YYYY-MM"
      vencimento: normalizeString(obj.vencimento),        // "YYYY-MM-DD"
      valor_original_centavos,
      saldo_centavos,
      origem: normalizeString(obj.origem),
      ref_tipo: normalizeString(obj.ref_tipo),
      ref_id: normalizeString(obj.ref_id),
      billing_cycle: normalizeString(obj.billing_cycle),
      billing_mode: normalizeString(obj.billing_mode),
      payment_preference: normalizeString(obj.payment_preference),
      settlement_mode: normalizeString(obj.settlement_mode),
      installments: clampInt(obj.installments ?? 1, 1, 24),
      obs: normalizeString(obj.obs),

      cancelado: !!obj.cancelado,
      cancelado_at: normalizeString(obj.cancelado_at),
      cancelado_motivo: normalizeString(obj.cancelado_motivo),

      recebimentos,

      created_at: normalizeString(obj.created_at) || nowISO(),
      updated_at: normalizeString(obj.updated_at) || nowISO(),
      last_sync: normalizeString(obj.last_sync) || ""
    };

    t.status = computeStatus(t);
    return t;
  }

  // ================================================================
  // Repositório IDB canônico (R-01)
  // ================================================================
  const STORE_AR = _db.stores.contas_receber; // "contas_receber"

  async function loadAR() {
    const db = await _db.openDB();
    return new Promise((resolve, reject) => {
      const tx0 = db.transaction([STORE_AR], "readonly");
      const st0  = tx0.objectStore(STORE_AR);
      const out  = [];
      const rq   = st0.openCursor();
      rq.onsuccess = () => {
        const cur = rq.result;
        if (cur) { out.push(normalizeTitulo(cur.value)); cur.continue(); }
        else resolve(out);
      };
      rq.onerror = () => reject(rq.error);
    });
  }

  async function upsertTitulo(input) {
    // [FIX C-09] Verificar papel de usuário — apenas ADMIN ou MASTER podem lançar contas a receber manualmente
    if (window.VSC_AUTH && typeof window.VSC_AUTH.requireRole === "function") {
      try {
        await window.VSC_AUTH.requireRole("ADMIN");
      } catch(e) {
        throw new Error(e && e.message ? e.message : "Acesso negado: requer papel ADMIN ou MASTER para lançar contas a receber.");
      }
    }
    const t = normalizeTitulo(input);
    t.updated_at = nowISO();
    t.status     = computeStatus(t);
    if (!t.created_at) t.created_at = nowISO();

    const result = await _db.upsertWithOutbox(
      STORE_AR,
      t,
      "contas_receber",
      t.id,
      t
    );

    if (window.VSC_RELAY && typeof window.VSC_RELAY.kick === "function") {
      window.VSC_RELAY.kick();
    }
    return result;
  }

  async function saveAR(list) {
    const norm = (Array.isArray(list) ? list : []).map(normalizeTitulo);
    for (const t of norm) await upsertTitulo(t);
    return norm;
  }

  // Migração one-shot localStorage → IDB (R-01)
  async function _migrateLStoIDB() {
    if (localStorage.getItem(MIGRATION_FLAG) === "1") return;
    const raw = localStorage.getItem(KEY_AR_LS);
    if (!raw) { localStorage.setItem(MIGRATION_FLAG, "1"); return; }
    const arr = _safeJSONParse(raw, []);
    if (!Array.isArray(arr) || arr.length === 0) { localStorage.setItem(MIGRATION_FLAG, "1"); return; }
    let migrated = 0;
    for (const item of arr) {
      try { await upsertTitulo(item); migrated++; } catch (_) {}
    }
    localStorage.setItem(MIGRATION_FLAG, "1");
    if (migrated > 0 && window.__VSC_DEBUG__) {
      console.info(`[VSC_AR] Migração LS→IDB: ${migrated} título(s) migrado(s).`);
    }
  }

  _migrateLStoIDB().catch(() => {});

  window.VSC_AR = {
    version: VSC_AR_VERSION,
    loadAR,    // async → retorna Promise<Array>
    saveAR,
    upsertTitulo,
    _util: { centsToMoneyBR, moneyToCentsBR, computeStatus }
  };

})();
// =====================================================================================
// =====================================================================================
// UI — CONTAS A RECEBER (premium, alinhado ao novo HTML)
// =====================================================================================
(function(){
  "use strict";
  if (!window.VSC_AR) return;

  var AR = window.VSC_AR;
  var $ = function(id){ return document.getElementById(id); };
  var qs = function(s, el){ return (el||document).querySelector(s); };
  var norm = function(s){ return String(s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim(); };

  var _snackTo = null;
  function snack(msg, type){
    var el = $("vscSnackbar"); if(!el) return;
    el.textContent = String(msg||"");
    el.className = type||"";
    el.style.display = "block";
    clearTimeout(_snackTo);
    _snackTo = setTimeout(function(){ el.style.display="none"; }, 3200);
  }

  function fmtBRL(cents){
    try{ return "R$\u00a0"+Number((cents||0)/100).toLocaleString("pt-BR",{minimumFractionDigits:2}); }catch(_){ return "R$ 0,00"; }
  }
  function fmtDate(s){ if(!s) return "—"; try{ return new Date(s+"T00:00:00").toLocaleDateString("pt-BR"); }catch(_){ return s; } }

  function statusPill(s){
    var map = {aberto:"aberto",parcial:"parcial",vencido:"vencido",recebido:"recebido",cancelado:"cancelado"};
    var cls = map[s]||"aberto";
    var labels = {aberto:"Aberto",parcial:"Parcial",vencido:"Vencido",recebido:"Recebido",cancelado:"Cancelado"};
    return '<span class="spill spill--'+cls+'">'+(labels[s]||s)+'</span>';
  }

  // ── Filtros ──
  var _fCliente="", _fStatus="", _fComp="", _fCiclo="", _fVenc="";
  var _fOverdue=false; // filtro especial: em atraso (inclui vencido + parcial com saldo > 0)
  var _listaAll = [];

  function _parseISODate(iso){
  if(!iso) return null;
  // expect YYYY-MM-DD
  var s = String(iso).slice(0,10);
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if(!m) return null;
  return new Date(Number(m[1]), Number(m[2])-1, Number(m[3]));
}

function _isOverdueTitulo(t){
  if(!t) return false;
      if(_fOverdue && !_isOverdueTitulo(t)) return false;
  var saldo = Number((t.saldo_centavos ?? t.valor_original_centavos ?? 0));
  if(!(saldo > 0)) return false;

  var dv = _parseISODate(t.vencimento);
  if(!dv) return false;

  var hoje = new Date();
  hoje = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());

  // atraso = vencimento < hoje
  if(!(dv < hoje)) return false;

  // aceitar "vencido" e também "parcial" (pagamento parcial em atraso)
  // e aceitar "aberto" se existir título em atraso sem recomputar status.
  var st = String(t.status || "");
  return (st === "vencido" || st === "parcial" || st === "aberto");
}

  function aplicarFiltros(lista){
    return lista.filter(function(t){
      if(!t) return false;
      if(_fCliente && !norm(t.cliente_nome||"").includes(norm(_fCliente)) &&
                      !norm(t.cliente_doc||"").includes(norm(_fCliente)) &&
                      !norm(t.documento||"").includes(norm(_fCliente))) return false;
      if(_fStatus){
        if(_fOverdue && _fStatus==="vencido"){
          if(!(t.status==="vencido" || t.status==="parcial")) return false;
        } else {
          if(t.status !== _fStatus) return false;
        }
      }
      if(_fComp && (t.competencia||"").slice(0,7) !== _fComp) return false;
      if(_fCiclo && String(t.billing_cycle||"") !== _fCiclo) return false;
      if(_fVenc && t.vencimento !== _fVenc) return false;
      return true;
    });
  }

  function renderGrid(){
    var tbody = $("listaReceber"); if(!tbody) return;
    var lista = aplicarFiltros(_listaAll);
    // Expor para KPI updater
    window.__VSC_AR_ALL = _listaAll;

    updateFinanceInsights(lista);
    if(!lista.length){
      tbody.innerHTML = '<tr><td colspan="8" style="padding:24px;text-align:center;color:var(--muted-lt);">Nenhum registro encontrado.</td></tr>';
      return;
    }
    // Ordenar: vencidos primeiro, depois por vencimento asc
    lista = lista.slice().sort(function(a,b){
      var sa = a.vencimento||"9999-12-31", sb = b.vencimento||"9999-12-31";
      return sa.localeCompare(sb);
    });
    tbody.innerHTML = lista.map(function(t){
      return '<tr>'+
        '<td class="mono" style="font-size:12px;font-weight:700;">'+(t.documento||"—")+'<div style="margin-top:4px;font-size:11px;color:var(--muted);font-family:inherit;">'+esc((t.billing_cycle||'').replace(/_/g,' ') || 'sem ciclo')+'</div></td>'+
        '<td style="font-weight:700;">'+(t.cliente_nome||"—")+'<div style="margin-top:4px;font-size:11px;color:var(--muted);font-weight:600;">'+esc((t.payment_preference||'definir_depois').replace(/_/g,' '))+'</div></td>'+
        '<td style="color:var(--muted);font-size:12px;">'+(t.competencia||"—")+'</td>'+
        '<td style="font-size:12px;">'+(t.vencimento?fmtDate(t.vencimento):"—")+'</td>'+
        '<td class="mono" style="font-size:12px;">'+fmtBRL(t.valor_original_centavos)+'</td>'+
        '<td class="mono" style="font-size:12px;font-weight:800;">'+(t.cancelado?'<span style="color:var(--muted)">—</span>':fmtBRL(t.saldo_centavos))+'</td>'+
        '<td>'+statusPill(t.status)+'</td>'+
        '<td style="white-space:nowrap;">'+
          (!t.cancelado&&(t.saldo_centavos>0)?'<button class="btn btn--amber btn--xs" data-act="receber" data-id="'+t.id+'" style="margin-right:4px;">💰 Receber</button>':'') +
          '<button class="btn btn--ghost btn--xs" data-act="editar" data-id="'+t.id+'" style="margin-right:4px;">✏️</button>'+
          (!t.cancelado?'<button class="btn btn--danger btn--xs" data-act="cancelar" data-id="'+t.id+'">✕</button>':'')+
        '</td>'+
      '</tr>';
    }).join("");
  }



  function updateFinanceInsights(lista){
    var F = window.VSC_FINANCE_ANALYTICS;
    lista = Array.isArray(lista) ? lista : [];
    var abertoC=0, abertoN=0, parcialC=0, parcialN=0, vencidoC=0, vencidoN=0, recebidoMesC=0, recebidoMesN=0;
    var hoje = new Date();
    lista.forEach(function(t){
      var total = Number(t.valor_original_centavos||0);
      var saldo = Number(t.saldo_centavos!=null?t.saldo_centavos:total);
      var status = String(t.status||'');
      if(status==='aberto'){ abertoC += saldo; abertoN++; }
      if(status==='parcial'){ parcialC += saldo; parcialN++; }
      if(status==='vencido'){ vencidoC += saldo; vencidoN++; }
      var recs = Array.isArray(t.recebimentos)?t.recebimentos:[];
      recs.forEach(function(r){
        var d = F && F.parseYMD ? F.parseYMD(r.data) : null;
        if(d && d.getMonth()===hoje.getMonth() && d.getFullYear()===hoje.getFullYear()){
          recebidoMesC += Number(r.valor_centavos||0); recebidoMesN++;
        }
      });
    });
    if($('kpiAberto')) $('kpiAberto').textContent = fmtBRL(abertoC);
    if($('kpiAbertoSub')) $('kpiAbertoSub').textContent = abertoN + ' título(s)';
    if($('kpiParcial')) $('kpiParcial').textContent = fmtBRL(parcialC);
    if($('kpiParcialSub')) $('kpiParcialSub').textContent = parcialN + ' título(s)';
    if($('kpiVencido')) $('kpiVencido').textContent = fmtBRL(vencidoC);
    if($('kpiVencidoSub')) $('kpiVencidoSub').textContent = vencidoN + ' título(s)';
    if($('kpiRecebido')) $('kpiRecebido').textContent = fmtBRL(recebidoMesC);
    if($('kpiRecebidoSub')) $('kpiRecebidoSub').textContent = recebidoMesN + ' baixa(s)';

    if(!F) return;
    var sum = F.summarizePortfolio(lista,'ar');
    if($('arPrevisto30')) $('arPrevisto30').textContent = F.fmtBRLFromCents(sum.upcoming30);
    if($('arAtrasoTotal')) $('arAtrasoTotal').textContent = F.fmtBRLFromCents(sum.overdue);
    if($('arTicketMedio')) $('arTicketMedio').textContent = F.fmtBRLFromCents(sum.count ? Math.round(sum.total / sum.count) : 0);
    var conv = sum.total>0 ? Math.round((sum.settledMonth / sum.total) * 100) : 0;
    if($('arConversaoMes')) $('arConversaoMes').textContent = conv + '%';
    if($('arCarteiraHealth')) $('arCarteiraHealth').textContent = sum.overdue > sum.upcoming30 ? 'Atenção na cobrança' : 'Carteira equilibrada';
    F.drawBars($('arAgingChart'), Object.keys(sum.aging).map(function(k){ return {label:k, value:sum.aging[k]}; }), {yLabel:'Saldo'});
    F.drawLine($('arMonthlyChart'), sum.monthlySettled.map(function(row, idx){ return {label:row.label, value:Math.max(row.value||0, (sum.monthlyDue[idx]&&sum.monthlyDue[idx].value)||0)}; }));
    F.drawDonut($('arPaymentChart'), sum.paymentMethods.length ? sum.paymentMethods : [{label:'Sem baixas', value:1}]);
    F.renderList($('arTopClientes'), sum.topEntities);
  }

  async function recarregar(){
    try{
      _listaAll = await AR.loadAR()||[];
// Deep-link (Premium Enterprise): abrir já filtrado quando vindo do Dashboard
try{
  var params = new URLSearchParams(window.location.search || "");
  var dlFilter = params.get("filter") || "";
  var dlOnly = params.get("only") || "";

  var ls = null;
  try { ls = JSON.parse(localStorage.getItem("vsc_nav_ar_filter") || "null"); } catch(_){}
  if(!dlFilter && ls && ls.filter) dlFilter = ls.filter;

  if(String(dlFilter) === "overdue" || String(dlOnly) === "atraso"){
    _fOverdue = true;
    _fStatus = "vencido"; // UI mostra "Vencido" mas inclui "Parcial" em atraso também
    var fS = $("fStatus"); if(fS) fS.value = "vencido";
  }

  // limpar para evitar reexecução no F5 e evitar URL suja
  if(params.has("filter") || params.has("only")){
    params.delete("filter"); params.delete("only");
    var clean = window.location.pathname + (params.toString()?("?"+params.toString()):"");
    window.history.replaceState({}, document.title, clean);
  }
  if(ls) localStorage.removeItem("vsc_nav_ar_filter");
}catch(_){}
      renderGrid();
    }catch(e){ snack("Erro ao carregar: "+(e.message||e),"err"); }
  }

  // ── Modal Novo/Editar ──
  var _editId = null;

  function openModalTitulo(titulo){
    _editId = titulo ? titulo.id : null;
    $("modalTituloTitle").textContent = titulo ? "Editar título" : "Novo título a receber";
    $("mClienteNome").value = titulo ? (titulo.cliente_nome||"") : "";
    $("mClienteDoc").value = titulo ? (titulo.cliente_doc||"") : "";
    $("mDocumento").value = titulo ? (titulo.documento||"") : "";
    $("mCompetencia").value = titulo ? (titulo.competencia||"") : new Date().toISOString().slice(0,7);
    $("mVencimento").value = titulo ? (titulo.vencimento||"") : new Date().toISOString().slice(0,10);
    $("mValor").value = titulo ? AR._util.centsToMoneyBR(titulo.valor_original_centavos) : "";
    $("mBillingCycle").value = titulo ? (titulo.billing_cycle||"gerar_agora") : "gerar_agora";
    $("mPaymentPreference").value = titulo ? (titulo.payment_preference||"definir_depois") : "definir_depois";
    $("mSettlementMode").value = titulo ? (titulo.settlement_mode||"manual") : "manual";
    $("mInstallments").value = titulo ? String(Math.max(1, Number(titulo.installments||1))) : "1";
    $("mObs").value = titulo ? (titulo.obs||"") : "";
    var w = $("mWarn"); if(w){ w.textContent=""; w.classList.remove("show"); }
    $("modalTitulo").classList.remove("hidden");
    $("modalTitulo").setAttribute("aria-hidden","false");
    setTimeout(function(){ $("mClienteNome").focus(); },50);
  }

  function closeModalTitulo(){
    $("modalTitulo").classList.add("hidden");
    $("modalTitulo").setAttribute("aria-hidden","true");
    _editId = null;
  }

  async function saveModalTitulo(){
    var nome = ($("mClienteNome").value||"").trim();
    var doc  = ($("mClienteDoc").value||"").trim();
    var docum= ($("mDocumento").value||"").trim();
    var comp = ($("mCompetencia").value||"").trim();
    var venc = ($("mVencimento").value||"").trim();
    var valStr = ($("mValor").value||"").trim();
    var billingCycle = ($("mBillingCycle").value||"gerar_agora").trim();
    var paymentPreference = ($("mPaymentPreference").value||"definir_depois").trim();
    var settlementMode = ($("mSettlementMode").value||"manual").trim();
    var installments = Math.max(1, Math.min(24, Number(($("mInstallments").value||1)) || 1));
    var obs  = ($("mObs").value||"").trim();
    var warn = $("mWarn");

    function warnMsg(m){ if(warn){ warn.textContent=m; warn.classList.add("show"); } }

    if(!nome){ warnMsg("Informe o nome do cliente."); $("mClienteNome").focus(); return; }
    if(!venc){ warnMsg("Informe a data de vencimento."); $("mVencimento").focus(); return; }
    if(!valStr){ warnMsg("Informe o valor."); $("mValor").focus(); return; }
    var cents = AR._util.moneyToCentsBR(valStr);
    if(!cents||cents<=0){ warnMsg("Valor inválido (ex: 150,00)."); $("mValor").focus(); return; }

    try{
      var titulo;
      if(_editId){
        var lista = await AR.loadAR();
        titulo = lista.find(function(x){ return x.id===_editId; });
        if(!titulo){ warnMsg("Título não encontrado."); return; }
        titulo.cliente_nome = nome; titulo.cliente_doc = doc; titulo.documento = docum;
        titulo.competencia = comp; titulo.vencimento = venc; titulo.obs = obs;
        titulo.billing_cycle = billingCycle; titulo.payment_preference = paymentPreference; titulo.settlement_mode = settlementMode; titulo.installments = installments;
        titulo.valor_original_centavos = cents;
        if(titulo.saldo_centavos===null||titulo.saldo_centavos===undefined) titulo.saldo_centavos=cents;
      } else {
        titulo = {
          id: uuidv4(),
          documento: docum, cliente_nome: nome, cliente_doc: doc,
          competencia: comp, vencimento: venc, obs: obs,
          billing_cycle: billingCycle, billing_mode: billingCycle === "gerar_agora" ? "imediato" : "periodico", payment_preference: paymentPreference, settlement_mode: settlementMode, installments: installments,
          valor_original_centavos: cents, saldo_centavos: cents,
          origem: "MANUAL", recebimentos: [], cancelado: false,
          created_at: new Date().toISOString()
        };
      }
      await AR.upsertTitulo(titulo);
      closeModalTitulo();
      snack(_editId?"Título atualizado.":"Título salvo.", "ok");
      await recarregar();
    }catch(e){ warnMsg("Erro: "+(e.message||e)); }
  }

  // ── Modal Receber ──
  var _recId = null;

  function openModalReceber(titulo){
    _recId = titulo.id;
    $("rId").value = titulo.id;
    var info = document.getElementById("rTituloInfo");
    if(info) info.innerHTML = '<b>'+esc(titulo.cliente_nome||"—")+'</b> — '+esc(titulo.documento||"—")+
      ' &nbsp;|&nbsp; Saldo: <b>'+fmtBRL(titulo.saldo_centavos)+'</b>';
    $("rData").value = new Date().toISOString().slice(0,10);
    $("rForma").value = "";
    $("rValor").value = AR._util.centsToMoneyBR(titulo.saldo_centavos);
    $("rObs").value = "";
    var w = $("rWarn"); if(w){ w.textContent=""; w.classList.remove("show"); }
    $("modalReceber").classList.remove("hidden");
    $("modalReceber").setAttribute("aria-hidden","false");
    setTimeout(function(){ $("rValor").focus(); $("rValor").select(); },50);
  }

  function closeModalReceber(){
    $("modalReceber").classList.add("hidden");
    $("modalReceber").setAttribute("aria-hidden","true");
    _recId = null;
  }

  async function confirmarReceber(){
    var id = ($("rId").value||"").trim();
    var data = ($("rData").value||"").trim();
    var forma= ($("rForma").value||"").trim();
    var valStr=($("rValor").value||"").trim();
    var obs  = ($("rObs").value||"").trim();
    var warn = $("rWarn");
    function warnMsg(m){ if(warn){ warn.textContent=m; warn.classList.add("show"); } }

    if(!data){ warnMsg("Informe a data."); return; }
    if(!forma){ warnMsg("Selecione a forma de pagamento."); $("rForma").focus(); return; }
    if(!valStr){ warnMsg("Informe o valor."); return; }
    var cents = AR._util.moneyToCentsBR(valStr);
    if(!cents||cents<=0){ warnMsg("Valor inválido."); return; }

    try{
      var lista = await AR.loadAR();
      var titulo = lista.find(function(x){ return x.id===id; });
      if(!titulo){ warnMsg("Título não encontrado."); return; }
      var recs = Array.isArray(titulo.recebimentos)?titulo.recebimentos:[];
      recs.push({ id: uuidv4(), data: data, forma_pagamento: forma, canal_baixa: titulo.settlement_mode || "manual", valor_centavos: cents, obs: obs, created_at: new Date().toISOString() });
      titulo.recebimentos = recs;
      var totalRec = recs.reduce(function(s,r){ return s+(r.valor_centavos||0); },0);
      titulo.saldo_centavos = Math.max(0,(titulo.valor_original_centavos||0)-totalRec);
      await AR.upsertTitulo(titulo);
      closeModalReceber();
      snack("Recebimento registrado: "+fmtBRL(cents)+".", "ok");
      await recarregar();
    }catch(e){ warnMsg("Erro: "+(e.message||e)); }
  }

  function esc(s){ return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

  // ── Wiring ──
  function wire(){
    // Filtros
    var fC=$("fCliente"),fS=$("fStatus"),fCo=$("fCompetencia"),fCi=$("fCiclo"),fV=$("fVencimento");
    if(fC) fC.addEventListener("input",function(){ _fCliente=fC.value; renderGrid(); });
    if(fS) fS.addEventListener("change",function(){ _fStatus=fS.value; renderGrid(); });
    if(fCo) fCo.addEventListener("change",function(){ _fComp=fCo.value; renderGrid(); });
    if(fCi) fCi.addEventListener("change",function(){ _fCiclo=fCi.value; renderGrid(); });
    if(fV) fV.addEventListener("change",function(){ _fVenc=fV.value; renderGrid(); });

    // Botão Novo
    var btnN=$("btnNovo");
    if(btnN) btnN.addEventListener("click",function(){ openModalTitulo(null); });

    // Modal Título
    var mc=$("btnModalClose"),cc=$("btnCancelarModal"),sv=$("btnSalvarTitulo");
    if(mc) mc.addEventListener("click",closeModalTitulo);
    if(cc) cc.addEventListener("click",closeModalTitulo);
    if(sv) sv.addEventListener("click",saveModalTitulo);
    var mt=$("modalTitulo");
    if(mt) mt.addEventListener("click",function(e){ if(e.target===mt) closeModalTitulo(); });

    // Modal Receber
    var rc=$("btnReceberClose"),cr=$("btnCancelarReceber"),cf=$("btnConfirmarReceber");
    if(rc) rc.addEventListener("click",closeModalReceber);
    if(cr) cr.addEventListener("click",closeModalReceber);
    if(cf) cf.addEventListener("click",confirmarReceber);
    var mr=$("modalReceber");
    if(mr) mr.addEventListener("click",function(e){ if(e.target===mr) closeModalReceber(); });

    // Ações inline tabela
    var tbody=$("listaReceber");
    if(tbody) tbody.addEventListener("click", async function(ev){
      var t=ev.target;
      while(t&&t!==tbody&&!t.getAttribute("data-act")) t=t.parentNode;
      if(!t||!t.getAttribute) return;
      var act=t.getAttribute("data-act"), id=t.getAttribute("data-id");
      if(!id) return;
      var lista = await AR.loadAR();
      var titulo = lista.find(function(x){ return x.id===id; });
      if(!titulo) return;
      if(act==="editar") openModalTitulo(titulo);
      else if(act==="receber") openModalReceber(titulo);
      else if(act==="cancelar"){
        if(window.confirm("Cancelar este título? Esta ação não pode ser desfeita.")){
          titulo.cancelado=true; titulo.cancelado_at=new Date().toISOString();
          await AR.upsertTitulo(titulo);
          snack("Título cancelado.","ok");
          await recarregar();
        }
      }
    });

    // Enter nos modais
    document.addEventListener("keydown",function(ev){
      if(ev.key==="Escape"){
        if(mt&&!mt.classList.contains("hidden")) closeModalTitulo();
        if(mr&&!mr.classList.contains("hidden")) closeModalReceber();
      }
    });
  }

  function init(){
    wire();
    recarregar();
  }

  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",init);
  else init();
})();
