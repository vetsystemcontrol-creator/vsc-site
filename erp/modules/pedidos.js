/* ============================================================
 * PEDIDOS (COMPRAS) — PREMIUM MAX (Contrato 4.6)
 * - Giro real por atendimentos_master (itens PRODUTO com estoque_movimentado=true)
 * - Classificação ABC por valor consumido (demanda * último custo)
 * - Política: Periodic Review (R) + Lead Time (L) + Safety Stock por Z-score
 * - EOQ opcional como piso de compra
 * - Geração de cotação em PDF (via impressão do Chrome)
 * - Sem alert nativo / sem som / feedback via VSC_UI.toast
 * ============================================================ */
(function(){
  "use strict";

  // Topbar: carregada via iframe no HTML (padrão canônico)

  // -----------------------------
  // Helpers (DOM)
  // -----------------------------
  function $(id){ return document.getElementById(id); }
  function esc(s){
    return String(s||"")
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
      .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  }

  function cssEsc(v){
    try{ if(window.CSS && typeof window.CSS.escape==='function') return window.CSS.escape(String(v)); }catch(_e){}
    return String(v||"").replace(/[^a-zA-Z0-9_\-]/g, "\\$");
  }

  function moneyBR(cents){
    var v = (Number(cents||0) / 100);
    try{ return v.toLocaleString("pt-BR",{style:"currency",currency:"BRL"}); }
    catch(_e){ return "R$ " + v.toFixed(2).replace(".",","); }
  }

  function clamp(n, a, b){
    n = Number(n||0);
    if (n < a) return a;
    if (n > b) return b;
    return n;
  }

  function isoDayFromAny(x){
    // x: ISO datetime or null
    try{
      if(!x) return null;
      var d = new Date(String(x));
      if(isNaN(d.getTime())) return null;
      var y = d.getFullYear();
      var m = String(d.getMonth()+1).padStart(2,"0");
      var da = String(d.getDate()).padStart(2,"0");
      return y + "-" + m + "-" + da;
    }catch(_e){ return null; }
  }

  // -----------------------------
  // IndexedDB minimal wrapper
  // -----------------------------
  function hasStore(db, storeName){
    try{
      return !!(db && db.objectStoreNames && db.objectStoreNames.contains(storeName));
    }catch(_e){ return false; }
  }

  function idbGetAll(db, storeName){
    return new Promise(function(resolve, reject){
      try{
        if(!hasStore(db, storeName)) return resolve([]);
        var tx = db.transaction([storeName], "readonly");
        var st = tx.objectStore(storeName);
        var req = st.getAll();
        req.onsuccess = function(){ resolve(req.result || []); };
        req.onerror = function(){ resolve([]); };
      }catch(e){ resolve([]); }
    });
  }

  function idbUpsert(db, storeName, obj){
    return new Promise(function(resolve){
      try{
        if(!hasStore(db, storeName)) return resolve(false);
        var tx = db.transaction([storeName], "readwrite");
        var st = tx.objectStore(storeName);
        var req = st.put(obj);
        req.onsuccess = function(){ resolve(true); };
        req.onerror = function(){ resolve(false); };
      }catch(_e){ resolve(false); }
    });
  }

  // -----------------------------
  // Config (policy) — stored in config_params
  // -----------------------------
  var CFG_KEY = "compras_pedidos_policy_v1";

  function defaultPolicy(){
    return {
      lead_time_days: 7,     // L
      review_days: 7,        // R
      max_coverage_days: 90, // trava anti-excesso
      // Service level by ABC (%)
      sl_a: 98.0,
      sl_b: 95.0,
      sl_c: 90.0,
      // EOQ
      holding_rate_pct_aa: 20.0, // i (a.a.)
      order_cost_cents: 5000,    // S (R$ 50,00)
      use_eoq_floor: true,
      // ABC thresholds (cumulative value %)
      abc_a: 80,
      abc_b: 95
    };
  }

  function zFromServiceLevelPct(pct){
    // Common Z approximations (cycle service level)
    // Use nearest bucket to keep deterministic and fast.
    var p = Number(pct||0);
    if (p >= 99.9) return 3.09;
    if (p >= 99.0) return 2.33;
    if (p >= 98.0) return 2.05;
    if (p >= 97.0) return 1.88;
    if (p >= 95.0) return 1.65;
    if (p >= 92.0) return 1.41;
    if (p >= 90.0) return 1.28;
    if (p >= 85.0) return 1.04;
    return 0.84; // ~80%
  }

  async function loadPolicy(db){
    var pol = defaultPolicy();
    try{
      if(!hasStore(db, "config_params")) return pol;
      var all = await idbGetAll(db, "config_params");
      for(var i=0;i<all.length;i++){
        var r = all[i];
        if(r && r.key === CFG_KEY){
          var v = null;
          try{ v = JSON.parse(String(r.value||"")); }catch(_e){ v = null; }
          if(v && typeof v === "object"){
            pol = Object.assign(pol, v);
          }
          break;
        }
      }
    }catch(_e){}
    return pol;
  }

  async function savePolicy(db, pol){
    try{
      if(!hasStore(db, "config_params")) return false;
      var rec = {
        id: (window.crypto && crypto.randomUUID ? crypto.randomUUID() : ("cfg_"+Date.now())),
        key: CFG_KEY,
        value: JSON.stringify(pol),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      // upsert by key: emulate by deleting old and inserting new
      // deterministic: keep only last entry for key
      var all = await idbGetAll(db, "config_params");
      for(var i=0;i<all.length;i++){
        if(all[i] && all[i].key === CFG_KEY){
          // overwrite using same id to avoid growth
          rec.id = all[i].id || rec.id;
          rec.created_at = all[i].created_at || rec.created_at;
          break;
        }
      }
      return await idbUpsert(db, "config_params", rec);
    }catch(_e){ return false; }
  }

  // -----------------------------
  // Fornecedores (legado)
  // -----------------------------
  var LS_FORN = "vsc_fornecedores_v1";
  function loadFornecedores(){
    try{
      var raw = localStorage.getItem(LS_FORN);
      var arr = raw ? JSON.parse(raw) : [];
      if(!Array.isArray(arr)) arr = [];
      // stable sort by nome
      arr = arr.filter(function(x){ return x && !x.deleted_at; }).slice().sort(function(a,b){
        return String(a.nome||"").localeCompare(String(b.nome||""), "pt-BR", { sensitivity:"base" });
      });
      return arr;
    }catch(_e){ return []; }
  }

  // -----------------------------
  // State
  // -----------------------------
  var STATE = {
    db: null,
    policy: defaultPolicy(),
    fornecedores: [],
    produtos: [],
    lotes: [],
    atendimentos: [],
    // computed
    giro: {},           // produto_id -> total units (period)
    giroDaily: {},      // produto_id -> { day -> units }
    consumoVal: {},     // produto_id -> cents
    abc: {},            // produto_id -> "A|B|C"
    rows: [],           // computed rows
    selected: {}        // produto_id -> { pedir:int, selected:bool }
  };

  // -----------------------------
  // UI refs
  // -----------------------------
  var UI = {
    build: $("uiBuild"),
    kpiItems: $("kpiItems"),
    kpiSelecionados: $("kpiSelecionados"),
    kpiZerado: $("kpiZerado"),
    kpiCritico: $("kpiCritico"),
    kpiValor: $("kpiValor"),
    kpiPol: $("kpiPol"),
    kpiSL: $("kpiSL"),
    status: $("fStatus"),
    dias: $("fDias"),
    top: $("fTop"),
    busca: $("fBusca"),
    forn: $("fFornecedor"),
    btnGerar: $("btnGerar"),
    btnPolitica: $("btnPolitica"),
    btnLimparSel: $("btnLimparSel"),
    tb: $("tb"),
    resumo: $("uiResumo"),
    btnExport: $("btnExport"),
    btnPDF: $("btnPDF"),

    // modal policy
    ovPol: $("ovPol"),
    xPol: $("xPol"),
    pLead: $("pLead"),
    pReview: $("pReview"),
    pMaxCov: $("pMaxCov"),
    pSLA: $("pSLA"),
    pSLB: $("pSLB"),
    pSLC: $("pSLC"),
    pHold: $("pHold"),
    pOrder: $("pOrder"),
    pEOQ: $("pEOQ"),
    btnResetPol: $("btnResetPol"),
    btnSalvarPol: $("btnSalvarPol")
  };

  function toast(kind, msg, opts){
    try{
      if(window.VSC_UI && typeof window.VSC_UI.toast === "function"){
        window.VSC_UI.toast(kind, msg, opts || null);
      }
    }catch(_e){}
  }

  // -----------------------------
  // Computation: estoque atual por produto
  // -----------------------------
  function buildEstoqueMap(lotes){
    var m = {};
    for(var i=0;i<lotes.length;i++){
      var l = lotes[i];
      if(!l || l.deleted_at) continue;
      var pid = String(l.produto_id || "");
      if(!pid) continue;
      var q = Number(l.qtd || 0);
      if(!isFinite(q)) q = 0;
      if(!m[pid]) m[pid] = 0;
      m[pid] += q;
    }
    return m;
  }

  // -----------------------------
  // Computation: giro real (atendimentos)
  // -----------------------------
  function computeGiro(atendimentos, dias){
    var now = new Date();
    var start = new Date(now.getTime() - (Math.max(1, Number(dias||1)) * 86400000));
    var g = {};
    var gd = {}; // daily
    for(var i=0;i<atendimentos.length;i++){
      var a = atendimentos[i];
      if(!a || a.deleted_at) continue;
      if(!a.estoque_movimentado) continue; // giro real
      var dt = a.created_at || a.updated_at || null;
      var dObj = dt ? new Date(String(dt)) : null;
      if(!dObj || isNaN(dObj.getTime())) continue;
      if(dObj < start) continue;

      var day = isoDayFromAny(dt);
      if(!day) continue;

      var itens = Array.isArray(a.itens) ? a.itens : [];
      for(var k=0;k<itens.length;k++){
        var it = itens[k];
        if(!it || it.tipo !== "PRODUTO") continue;
        var pid = String(it.catalog_id || "");
        if(!pid) continue;
        var q = Number(it.qtd || 0);
        if(!isFinite(q)) q = 0;
        if(q <= 0) continue;

        g[pid] = (g[pid] || 0) + q;

        if(!gd[pid]) gd[pid] = {};
        gd[pid][day] = (gd[pid][day] || 0) + q;
      }
    }
    return { total:g, daily:gd };
  }

  function stdDevFromDailyMap(dayMap, periodDays){
    // dayMap: {"YYYY-MM-DD": qty}
    // Consider missing days as zero to avoid optimistic bias.
    var days = Math.max(1, Number(periodDays||1));
    var vals = new Array(days);
    var now = new Date();
    for(var i=0;i<days;i++){
      var d = new Date(now.getTime() - (i * 86400000));
      var y = d.getFullYear();
      var m = String(d.getMonth()+1).padStart(2,"0");
      var da = String(d.getDate()).padStart(2,"0");
      var key = y + "-" + m + "-" + da;
      vals[i] = Number((dayMap && dayMap[key]) || 0);
    }
    // population std dev
    var sum = 0;
    for(var j=0;j<vals.length;j++) sum += vals[j];
    var mean = sum / vals.length;
    var v = 0;
    for(var k=0;k<vals.length;k++){
      var diff = vals[k] - mean;
      v += diff * diff;
    }
    v = v / vals.length;
    return Math.sqrt(v);
  }

  // -----------------------------
  // ABC classification by consumption value
  // -----------------------------
  function computeABC(produtos, giroTotal, dias){
    var rows = [];
    for(var i=0;i<produtos.length;i++){
      var p = produtos[i];
      if(!p || p.deleted_at) continue;
      var pid = String(p.produto_id||"");
      if(!pid) continue;
      var demand = Number(giroTotal[pid] || 0);
      var uc = Number(p.custo_base_cents || 0); // último custo
      if(!isFinite(uc)) uc = 0;
      var val = Math.round(demand * uc);
      rows.push({ pid:pid, val:val });
    }
    rows.sort(function(a,b){ return (b.val||0) - (a.val||0); });
    var total = 0;
    for(var j=0;j<rows.length;j++) total += rows[j].val || 0;
    total = Math.max(1, total);

    var abc = {};
    var cum = 0;
    for(var k=0;k<rows.length;k++){
      cum += rows[k].val || 0;
      var pct = (cum * 100) / total;
      if(pct <= STATE.policy.abc_a) abc[rows[k].pid] = "A";
      else if(pct <= STATE.policy.abc_b) abc[rows[k].pid] = "B";
      else abc[rows[k].pid] = "C";
    }
    return abc;
  }

  function serviceLevelForClass(klass, pol){
    if(klass === "A") return Number(pol.sl_a||98);
    if(klass === "B") return Number(pol.sl_b||95);
    return Number(pol.sl_c||90);
  }

  // -----------------------------
  // Policy math: Periodic Review target + Safety Stock
  // -----------------------------
  function computeSuggestion(row, pol){
    // row needs:
    // onhand, min, rep, demandDailyMean, demandDailyStd, class
    var L = Math.max(0, Number(pol.lead_time_days || 0));
    var R = Math.max(0, Number(pol.review_days || 0));
    var maxCov = Math.max(7, Number(pol.max_coverage_days || 90));
    var klass = row.abc || "C";

    var sl = serviceLevelForClass(klass, pol);
    var Z = zFromServiceLevelPct(sl);

    var dbar = Math.max(0, Number(row.demand_daily_mean || 0));
    var sigma = Math.max(0, Number(row.demand_daily_std || 0));

    // Safety stock for demand uncertainty during lead time:
    // SS = Z * sigma * sqrt(L)
    var SS = Z * sigma * Math.sqrt(Math.max(0, L));

    // Periodic review target level:
    // T = dbar*(L+R) + SS
    var target = dbar * (L + R) + SS;

    // Hard cap by max coverage days to prevent overstock:
    var cap = dbar * maxCov + SS;
    if(cap < target) target = cap;

    var onhand = Math.max(0, Number(row.onhand || 0));
    var sug = Math.ceil(Math.max(0, target - onhand));

    // If product has explicit minimum/ponto_reposicao, use it as a floor logic:
    // - If onhand <= ponto_reposicao, ensure we at least reach ponto_reposicao + SS buffer for next review.
    var rep = Number(row.rep || 0);
    if(isFinite(rep) && rep > 0 && onhand <= rep){
      var floorT = Math.max(target, rep + SS);
      sug = Math.ceil(Math.max(0, floorT - onhand));
    }

    // EOQ as floor (optional)
    var eoq = 0;
    if(pol.use_eoq_floor){
      var Dyear = dbar * 365; // units/year
      var S = Math.max(0, Number(pol.order_cost_cents || 0)) / 100.0;
      var uc = Math.max(0, Number(row.uc_cents || 0)) / 100.0;
      var iRate = Math.max(0, Number(pol.holding_rate_pct_aa || 0)) / 100.0;
      var H = uc * iRate; // holding cost/unit/year
      if(Dyear > 0 && S > 0 && H > 0){
        eoq = Math.sqrt((2 * Dyear * S) / H);
        eoq = Math.ceil(eoq);
        if(eoq > 0 && sug > 0 && sug < eoq) sug = eoq;
      }
    }

    // ROP informational (not gate)
    var rop = dbar * L + SS;

    return {
      sl: sl,
      z: Z,
      ss: SS,
      rop: rop,
      sug: sug,
      eoq: eoq
    };
  }

  // -----------------------------
  // Build computed rows (for table)
  // -----------------------------
  function buildRows(){
    var dias = clamp(Number(UI.dias.value || 60), 7, 3650);
    var giro = computeGiro(STATE.atendimentos, dias);
    STATE.giro = giro.total;
    STATE.giroDaily = giro.daily;

    var estoqueMap = buildEstoqueMap(STATE.lotes);

    // ABC needs policy thresholds
    STATE.abc = computeABC(STATE.produtos, STATE.giro, dias);

    var rows = [];
    for(var i=0;i<STATE.produtos.length;i++){
      var p = STATE.produtos[i];
      if(!p || p.deleted_at) continue;
      var pid = String(p.produto_id||"");
      if(!pid) continue;

      var onhand = Number(estoqueMap[pid] || 0);
      if(!isFinite(onhand)) onhand = 0;

      var min = Number(p.estoque_minimo || 0);
      if(!isFinite(min)) min = 0;

      var rep = Number(p.ponto_reposicao || 0);
      if(!isFinite(rep)) rep = 0;

      var units = Number(STATE.giro[pid] || 0);
      if(!isFinite(units)) units = 0;

      var dmean = units / dias;
      var dstd = stdDevFromDailyMap(STATE.giroDaily[pid] || null, dias);

      var klass = STATE.abc[pid] || "C";
      var uc = Number(p.custo_base_cents || 0);
      if(!isFinite(uc)) uc = 0;

      var calc = computeSuggestion({
        onhand:onhand,
        min:min,
        rep:rep,
        demand_daily_mean:dmean,
        demand_daily_std:dstd,
        abc:klass,
        uc_cents: uc
      }, STATE.policy);

      var sug = Number(calc.sug || 0);
      if(!isFinite(sug) || sug < 0) sug = 0;

      // selection state
      var sel = STATE.selected[pid];
      var isSel = !!(sel && sel.selected);
      var pedir = (sel && typeof sel.pedir === "number") ? sel.pedir : sug;

      rows.push({
        pid: pid,
        nome: String(p.nome || ""),
        ean: String(p.ean || ""),
        abc: klass,
        giro: units,
        onhand: onhand,
        min: min,
        rep: rep,
        rop: calc.rop,
        sug: sug,
        eoq: calc.eoq || 0,
        pedir: pedir,
        uc: uc,
        subtotal: Math.round(pedir * uc),
        sl: calc.sl
      });
    }

    // apply filters
    var mode = String(UI.status.value || "CRITICO");
    var top = clamp(Number(UI.top.value || 30), 5, 500);
    var q = String(UI.busca.value || "").trim().toLowerCase();

    var filtered = rows.filter(function(r){
      if(q){
        var hay = (r.nome + " " + r.ean).toLowerCase();
        if(hay.indexOf(q) === -1) return false;
      }
      if(mode === "ZERADO") return r.onhand <= 0;
      if(mode === "CRITICO") return r.onhand <= r.min;
      if(mode === "BAIXO") return r.onhand <= r.rep;
      return true;
    });

    if(mode === "GIRO"){
      filtered.sort(function(a,b){ return (b.giro||0) - (a.giro||0); });
      filtered = filtered.slice(0, top);
    }else{
      // enterprise: stable alphabetical
      filtered.sort(function(a,b){
        return String(a.nome||"").localeCompare(String(b.nome||""), "pt-BR", { sensitivity:"base" });
      });
    }

    // keep only meaningful suggestions unless TODOS
    if(mode !== "TODOS" && mode !== "GIRO"){
      filtered = filtered.filter(function(r){
        return (r.sug > 0) || (r.onhand <= 0) || (r.onhand <= r.min) || (r.onhand <= r.rep);
      });
    }

    STATE.rows = filtered;
  }

  // -----------------------------
  // Render
  // -----------------------------
  function render(){
    var rows = STATE.rows || [];
    UI.tb.innerHTML = "";

    var selectedCount = 0;
    var totalCents = 0;
    var zerado = 0;
    var crit = 0;

    for(var i=0;i<rows.length;i++){
      var r = rows[i];
      if(r.onhand <= 0) zerado++;
      if(r.onhand <= r.min) crit++;

      var st = STATE.selected[r.pid];
      var isSel = !!(st && st.selected);
      var pedir = (st && typeof st.pedir === "number") ? st.pedir : r.pedir;
      pedir = Math.max(0, Math.round(Number(pedir||0)));
      if(isSel){
        selectedCount++;
        totalCents += Math.round(pedir * r.uc);
      }

      var abcTag = "<span class='tag " + (r.abc||"c").toLowerCase() + "'>" + esc(r.abc||"C") + "</span>";

      var tr = document.createElement("tr");
      tr.innerHTML =
        "<td class='center'><input type='checkbox' data-act='sel' data-id='"+esc(r.pid)+"' "+(isSel?"checked":"")+"></td>"+
        "<td><div style='font-weight:900;'>"+esc(r.nome || "—")+"</div><div class='muted' style='font-size:12px;margin-top:2px;'>ID: "+esc(r.pid)+"</div></td>"+
        "<td class='center'>"+esc(r.ean || "—")+"</td>"+
        "<td class='center'>"+abcTag+"</td>"+
        "<td class='right'>"+esc(String(r.giro||0))+"</td>"+
        "<td class='right'>"+esc(String(r.onhand||0))+"</td>"+
        "<td class='right'>"+esc(String(r.min||0))+"</td>"+
        "<td class='right'>"+esc(String(Math.round(r.rop||0)))+"</td>"+
        "<td class='right'>"+esc(String(r.sug||0))+"</td>"+
        "<td class='right'>"+esc(String(r.eoq||0))+"</td>"+
        "<td class='right'><input class='qty' type='number' min='0' step='1' data-act='qtd' data-id='"+esc(r.pid)+"' value='"+esc(String(pedir))+"'></td>"+
        "<td class='right'>"+esc(moneyBR(r.uc))+"</td>"+
        "<td class='right'>"+esc(moneyBR(Math.round(pedir * r.uc)))+"</td>";
      UI.tb.appendChild(tr);
    }

    UI.kpiItems.textContent = String(rows.length);
    UI.kpiSelecionados.textContent = String(selectedCount);
    UI.kpiValor.textContent = moneyBR(totalCents);
    UI.kpiZerado.textContent = String(zerado);
    UI.kpiCritico.textContent = String(crit);

    UI.resumo.textContent = rows.length
      ? ("Mostrando " + rows.length + " itens • Selecionados: " + selectedCount + " • Valor estimado: " + moneyBR(totalCents))
      : "Nenhum item no filtro atual.";

    // Policy summary
    UI.kpiPol.textContent = "R=" + String(STATE.policy.review_days) + "d • EOQ " + (STATE.policy.use_eoq_floor ? "ON" : "OFF");
    UI.kpiSL.textContent = "A " + STATE.policy.sl_a + "% • B " + STATE.policy.sl_b + "% • C " + STATE.policy.sl_c + "% • L=" + STATE.policy.lead_time_days + "d";
  }

  // -----------------------------
  // Selection handling
  // -----------------------------
  function setSelected(pid, yes){
    if(!STATE.selected[pid]) STATE.selected[pid] = { selected:false, pedir:0 };
    STATE.selected[pid].selected = !!yes;
  }
  function setQty(pid, qty){
    qty = Math.max(0, Math.round(Number(qty||0)));
    if(!STATE.selected[pid]) STATE.selected[pid] = { selected:false, pedir:0 };
    STATE.selected[pid].pedir = qty;
  }
  function clearSelection(){
    STATE.selected = {};
  }

  // -----------------------------
  // Export + PDF
  // -----------------------------
  function buildPedidoDoc(){
    var fornId = String(UI.forn.value || "");
    var forn = null;
    for(var i=0;i<STATE.fornecedores.length;i++){
      if(String(STATE.fornecedores[i].id||"") === fornId){ forn = STATE.fornecedores[i]; break; }
    }

    var items = [];
    var total = 0;
    for(var j=0;j<STATE.rows.length;j++){
      var r = STATE.rows[j];
      var st = STATE.selected[r.pid];
      if(!st || !st.selected) continue;
      var qty = Math.max(0, Math.round(Number(st.pedir||0)));
      if(qty <= 0) continue;
      var sub = Math.round(qty * r.uc);
      total += sub;
      items.push({
        produto_id: r.pid,
        nome: r.nome,
        ean: r.ean,
        abc: r.abc,
        giro_periodo: r.giro,
        estoque_atual: r.onhand,
        sugerido: r.sug,
        pedir: qty,
        ultimo_custo_cents: r.uc,
        subtotal_cents: sub
      });
    }

    return {
      build: (UI.build && UI.build.textContent) ? UI.build.textContent : "",
      generated_at: new Date().toISOString(),
      periodo_dias: clamp(Number(UI.dias.value||60), 7, 3650),
      filtro: String(UI.status.value||""),
      fornecedor: forn ? { id: forn.id, nome: forn.nome, email: forn.email||"", whatsapp: forn.whatsapp||"", cnpj: forn.cnpj||"" } : null,
      policy: Object.assign({}, STATE.policy),
      total_cents: total,
      items: items
    };
  }

  function exportJSON(){
    var doc = buildPedidoDoc();
    if(!doc.items.length){
      toast("warn","Selecione itens (checkbox) para exportar.", null);
      return;
    }
    try{
      var blob = new Blob([JSON.stringify(doc,null,2)], { type:"application/json;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "pedido_cotacao_" + new Date().toISOString().slice(0,10) + ".json";
      document.body.appendChild(a);
      a.click();
      setTimeout(function(){ URL.revokeObjectURL(url); a.remove(); }, 200);
      toast("ok","JSON exportado.", null);
    }catch(_e){
      toast("err","Falha ao exportar JSON.", null);
    }
  }

  async function openPrintView(){
    var doc = buildPedidoDoc();
    if(!doc.items.length){
      toast("warn","Selecione itens (checkbox) e ajuste as quantidades antes do PDF.", null);
      return;
    }

    // Build print HTML
    var forn = doc.fornecedor;
    var title = "Pedido para Cotação";
    // Empresa (branding) + Emissor (usuário atual)
    var emp = null;
    try{ emp = JSON.parse(localStorage.getItem("vsc_empresa_v1") || "null"); }catch(_){}
    var empNome = (emp && (emp.nome_fantasia||emp.razao_social)) ? (emp.nome_fantasia||emp.razao_social) : "Vet System Control | Equine";
    var empLine2 = "";
    try{
      var cnpj = emp && emp.cnpj ? ("CNPJ " + emp.cnpj) : "";
      var loc = (emp && emp.cidade && emp.uf) ? (emp.cidade + " - " + emp.uf) : (emp && (emp.cidade||emp.uf) ? (emp.cidade||emp.uf) : "");
      var tel = emp && (emp.telefone||emp.celular) ? (emp.telefone||emp.celular) : "";
      var eml = emp && emp.email ? emp.email : "";
      empLine2 = [cnpj, loc, tel, eml].filter(Boolean).join(" • ");
    }catch(_){ empLine2=""; }

    var issuer = null;
    try{
      if(window.VSC_AUTH && typeof VSC_AUTH.getCurrentUser === "function"){
        issuer = await VSC_AUTH.getCurrentUser();
      }
    }catch(_){}
    var ip = (issuer && issuer.professional) ? issuer.professional : {};
    var issuerName = (ip.full_name || (issuer && issuer.username) || "");
    var issuerCRMV = (ip.crmv_uf && ip.crmv_num) ? ("CRMV-" + ip.crmv_uf + " Nº " + ip.crmv_num) : "";
    var issuerLine = (issuerName ? issuerName : "—") + (issuerCRMV ? (" — " + issuerCRMV) : "");
    var issuerLine2 = [ip.phone ? ("Tel " + ip.phone) : "", ip.email ? ("Email " + ip.email) : ""].filter(Boolean).join(" • ");
    var sig = ip.signature_image_dataurl || null;

    var html = ""
      + "<!DOCTYPE html><html lang='pt-BR'><head><meta charset='UTF-8'>"
      + "<meta name='viewport' content='width=device-width, initial-scale=1.0'>"
      + "<title>"+esc(title)+"</title>"
      + "<style>"
      + "body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;margin:24px;color:#0f172a;}"
      + ".h{display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;}"
      + ".h h1{margin:0;font-size:22px;}"
      + ".box{border:1px solid #e5e7eb;border-radius:14px;padding:12px 14px;}"
      + ".muted{color:#64748b;font-weight:700;font-size:12px;}"
      + "table{border-collapse:collapse;width:100%;margin-top:14px;}"
      + "th,td{border-bottom:1px solid #e5e7eb;padding:10px 8px;text-align:left;font-size:12px;}"
      + "th{color:#64748b;font-weight:900;}"
      + ".r{text-align:right;}"
      + ".tot{margin-top:14px;display:flex;justify-content:flex-end;font-weight:900;font-size:14px;}"
      + "@media print{ .noPrint{display:none;} body{margin:0.8cm;} }"
      + "</style></head><body>"
      + "<div style='border:1px solid rgba(0,0,0,.12);border-radius:14px;padding:10px 12px;margin:0 0 12px 0;'><div style='display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;'><div><div style='font-weight:900;font-size:14px;'>" + esc(empNome) + "</div><div style='font-size:12px;color:#444;font-weight:700;'>" + esc(empLine2) + "</div></div><div style='text-align:right;'><div style='font-weight:800;font-size:12px;'>" + esc(title) + "</div><div style='font-size:12px;color:#444;font-weight:700;'>Emitido em " + esc(new Date().toLocaleString("pt-BR")) + "</div></div></div><div style='display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:8px;'><div><div style='font-weight:800;font-size:12px;'>" + esc(issuerLine) + "</div><div style='font-size:12px;color:#444;font-weight:700;'>" + esc(issuerLine2) + "</div></div><div>" + (sig ? ("<img alt=\"Assinatura\" src=\"" + String(sig).replace(/"/g,"&quot;") + "\" style=\"max-height:60px;border:1px solid rgba(0,0,0,.10);border-radius:12px;padding:6px;background:#fff;\"/>") : "") + "</div></div></div>";

    html += "<div class='h'>"
      + "<div><h1>"+esc(title)+"</h1><div class='muted'>Gerado em "+esc(new Date().toLocaleString("pt-BR"))+"</div></div>"
      + "<div class='box'>"
      + "<div style='font-weight:900'>Fornecedor</div>"
      + "<div>"+esc((forn && forn.nome) ? forn.nome : "—")+"</div>"
      + "<div class='muted'>CNPJ: "+esc((forn && forn.cnpj) ? forn.cnpj : "—")+"</div>"
      + "<div class='muted'>E-mail: "+esc((forn && forn.email) ? forn.email : "—")+"</div>"
      + "<div class='muted'>WhatsApp: "+esc((forn && forn.whatsapp) ? forn.whatsapp : "—")+"</div>"
      + "</div>"
      + "</div>";

    html += "<div class='box' style='margin-top:12px'>"
      + "<div style='font-weight:900;margin-bottom:6px'>Critérios & Política</div>"
      + "<div class='muted'>Período: "+esc(String(doc.periodo_dias))+" dias • Filtro: "+esc(doc.filtro)+"</div>"
      + "<div class='muted'>Lead time (L): "+esc(String(doc.policy.lead_time_days))+" • Review (R): "+esc(String(doc.policy.review_days))+" • EOQ: "+(doc.policy.use_eoq_floor?"ON":"OFF")+"</div>"
      + "<div class='muted'>Nível de serviço: A "+doc.policy.sl_a+"% • B "+doc.policy.sl_b+"% • C "+doc.policy.sl_c+"%</div>"
      + "</div>";

    html += "<table><thead><tr>"
      + "<th>Produto</th><th>EAN</th><th>ABC</th><th class='r'>Pedir</th><th class='r'>Últ. custo</th><th class='r'>Subtotal</th>"
      + "</tr></thead><tbody>";

    for(var i=0;i<doc.items.length;i++){
      var it = doc.items[i];
      html += "<tr>"
        + "<td><div style='font-weight:900'>"+esc(it.nome)+"</div><div class='muted'>ID: "+esc(it.produto_id)+"</div></td>"
        + "<td>"+esc(it.ean||"—")+"</td>"
        + "<td>"+esc(it.abc||"C")+"</td>"
        + "<td class='r'>"+esc(String(it.pedir||0))+"</td>"
        + "<td class='r'>"+esc(moneyBR(it.ultimo_custo_cents))+"</td>"
        + "<td class='r'>"+esc(moneyBR(it.subtotal_cents))+"</td>"
        + "</tr>";
    }

    html += "</tbody></table>";
    html += "<div class='tot'>Total estimado: " + esc(moneyBR(doc.total_cents)) + "</div>";
    html += "<div class='noPrint muted' style='margin-top:18px'>Dica: no Chrome, escolha “Salvar como PDF”.</div>";
    html += "</body></html>";

    var w = window.open("", "_blank");
    if(!w){
      toast("err","Pop-up bloqueado. Permita abrir nova aba para gerar o PDF.", null);
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
    setTimeout(function(){
      try{ w.focus(); w.print(); }catch(_e){}
    }, 250);

    toast("ok","PDF aberto para impressão.", null);
  }

  // -----------------------------
  // Policy modal wiring
  // -----------------------------
  function openPolicyModal(){
    var p = STATE.policy || defaultPolicy();
    UI.pLead.value = String(p.lead_time_days);
    UI.pReview.value = String(p.review_days);
    UI.pMaxCov.value = String(p.max_coverage_days);
    UI.pSLA.value = String(p.sl_a);
    UI.pSLB.value = String(p.sl_b);
    UI.pSLC.value = String(p.sl_c);
    UI.pHold.value = String(p.holding_rate_pct_aa);
    UI.pOrder.value = String((Number(p.order_cost_cents||0)/100).toFixed(0));
    UI.pEOQ.value = p.use_eoq_floor ? "1" : "0";
    UI.ovPol.style.display = "flex";
  }
  function closePolicyModal(){
    UI.ovPol.style.display = "none";
  }

  function readPolicyFromModal(){
    var p = Object.assign({}, STATE.policy);
    p.lead_time_days = clamp(Number(UI.pLead.value||7), 0, 365);
    p.review_days = clamp(Number(UI.pReview.value||7), 0, 365);
    p.max_coverage_days = clamp(Number(UI.pMaxCov.value||90), 7, 3650);

    p.sl_a = clamp(Number(UI.pSLA.value||98), 50, 99.9);
    p.sl_b = clamp(Number(UI.pSLB.value||95), 50, 99.9);
    p.sl_c = clamp(Number(UI.pSLC.value||90), 50, 99.9);

    p.holding_rate_pct_aa = clamp(Number(UI.pHold.value||20), 0, 200);
    var oc = clamp(Number(UI.pOrder.value||50), 0, 100000);
    p.order_cost_cents = Math.round(oc * 100);
    p.use_eoq_floor = (String(UI.pEOQ.value||"1") === "1");

    return p;
  }

  // -----------------------------
  // Main load
  // -----------------------------
  async function init(){
    try{
      UI.build.textContent = "build 2 | " + new Date().toISOString().slice(0,10);
    }catch(_e){}

    if(!window.VSC_DB || typeof window.VSC_DB.openDB !== "function"){
      toast("err","VSC_DB não disponível. Verifique modules/vsc_db.js.", { persist:true });
      return;
    }

    toast("info","Carregando base offline…", null);

    STATE.fornecedores = loadFornecedores();
    fillFornecedorSelect();

    try{
      STATE.db = await window.VSC_DB.openDB();
    }catch(_e){
      toast("err","Falha ao abrir o banco offline (IndexedDB).", { persist:true });
      return;
    }

    // Load policy
    STATE.policy = await loadPolicy(STATE.db);

    // Load datasets needed
    STATE.produtos = await idbGetAll(STATE.db, "produtos_master");
    STATE.lotes = await idbGetAll(STATE.db, "produtos_lotes");
    STATE.atendimentos = await idbGetAll(STATE.db, "atendimentos_master");

    toast("ok","Base carregada. Gere a análise.", null);
    renderPolicyKPIs();
  }

  function fillFornecedorSelect(){
    UI.forn.innerHTML = "";
    var opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "— Selecione —";
    UI.forn.appendChild(opt0);

    for(var i=0;i<STATE.fornecedores.length;i++){
      var f = STATE.fornecedores[i];
      var o = document.createElement("option");
      o.value = String(f.id||"");
      o.textContent = String(f.nome||"");
      UI.forn.appendChild(o);
    }
  }

  function renderPolicyKPIs(){
    UI.kpiPol.textContent = "R=" + String(STATE.policy.review_days) + "d • EOQ " + (STATE.policy.use_eoq_floor ? "ON" : "OFF");
    UI.kpiSL.textContent = "A " + STATE.policy.sl_a + "% • B " + STATE.policy.sl_b + "% • C " + STATE.policy.sl_c + "% • L=" + STATE.policy.lead_time_days + "d";
  }

  // -----------------------------
  // Events
  // -----------------------------
  UI.btnGerar.addEventListener("click", function(){
    try{
      if(!STATE.db){ toast("err","Banco não inicializado.", null); return; }
      buildRows();
      render();
      toast("ok","Análise atualizada.", null);
    }catch(_e){
      toast("err","Falha ao gerar análise.", null);
    }
  });

  UI.btnPolitica.addEventListener("click", function(){
    openPolicyModal();
  });
  UI.xPol.addEventListener("click", function(){ closePolicyModal(); });
  UI.ovPol.addEventListener("click", function(ev){
    if(ev && ev.target === UI.ovPol) closePolicyModal();
  });

  UI.btnResetPol.addEventListener("click", function(){
    STATE.policy = defaultPolicy();
    openPolicyModal();
    toast("info","Padrão restaurado.", null);
  });

  UI.btnSalvarPol.addEventListener("click", async function(){
    if(!STATE.db){ toast("err","Banco não inicializado.", null); return; }
    var p = readPolicyFromModal();
    var ok = await savePolicy(STATE.db, p);
    if(ok){
      STATE.policy = p;
      closePolicyModal();
      renderPolicyKPIs();
      toast("ok","Política salva.", null);
      // rebuild if already have rows
      if(STATE.rows && STATE.rows.length){
        buildRows();
        render();
      }
    }else{
      toast("err","Não foi possível salvar a política.", null);
    }
  });

  UI.btnLimparSel.addEventListener("click", function(){
    clearSelection();
    render();
    toast("ok","Seleção limpa.", null);
  });

  UI.tb.addEventListener("input", function(ev){
    var t = ev && ev.target;
    if(!t) return;
    var act = t.getAttribute("data-act");
    var pid = t.getAttribute("data-id");
    if(!pid) return;

    if(act === "qtd"){
      setQty(pid, t.value);
      // keep selection if already selected
      // update subtotal KPI
      render();
    }
  });

  UI.tb.addEventListener("change", function(ev){
    var t = ev && ev.target;
    if(!t) return;
    var act = t.getAttribute("data-act");
    var pid = t.getAttribute("data-id");
    if(!pid) return;

    if(act === "sel"){
      setSelected(pid, !!t.checked);
      // if selecting first time and qty not set, keep current visible qty
      if(t.checked){
        var inp = UI.tb.querySelector("input[data-act='qtd'][data-id='"+cssEsc(pid)+"']");
        if(inp) setQty(pid, inp.value);
      }
      render();
    }
  });

  UI.btnExport.addEventListener("click", function(){ exportJSON(); });
  UI.btnPDF.addEventListener("click", async function(){ await openPrintView(); });

  // -----------------------------
  // Boot
  // -----------------------------
  init();

})();
