/* ============================================================
 * PRODUTOS — Cadastro Mestre (CANÔNICO v6 — 2026-02-20 (Batch + Estoque mínimo))
 * Contrato 4.6:
 * - Floorplan enterprise obrigatório: LISTA → DETALHE (VIEW/EDIT/NEW)
 * - Sem alert(), sem som, feedback premium centralizado
 * - Offline-first + UUID v4 + tipagem forte (centavos)
 * - Outbox transacional via VSC_DB.upsertWithOutbox
 *
 * Correções implementadas:
 * (1) Floorplan: entrada em LISTA, detalhe inicia EMPTY STATE (Cap. XXI)
 * (2) Remoção do "modal fantasma": HTML não tinha #prdModal; fluxo agora é Object Page
 * (3) Lotes: migração para store canônica produtos_lotes (v24+) — sem lotes embutidos no produto
 * ============================================================ */
(function(){
  "use strict";

  // =============================
  // Topbar: carregada via iframe no HTML (padrão canônico VSC)

  // =============================
  // Helpers
  // =============================
  function byId(id){ return document.getElementById(id); }
  
  // =============================
  // Floorplan enterprise (como Clientes):
  // - Entrada do módulo: LISTA (somente)
  // - Clique no item / NOVO: abre DETALHE
  // =============================
  function setDetailVisible(on){
    var lv = byId("produtosListView");
    var dv = byId("produtosDetailView");
    if(lv) lv.style.display = on ? "none" : "";
    if(dv) dv.style.display = on ? "" : "none";
  }

  function goListView(){
    // volta para a tela inicial (LISTA)
    setDetailVisible(false);
    // mantém filtro e lista; apenas esconde detalhe
    try{
      // estado do detalhe: volta para EMPTY (sem seleção)
      showDetailEmpty();
      var sub = byId("detailSub");
    if(sub) sub.textContent = "Selecione um item ou clique em NOVO.";
      if(byId("detailHint")) byId("detailHint").textContent = "";
    }catch(_){}
    try{
      var q = byId("q");
      if(q) q.focus();
    }catch(_){}
  }

function nowISO(){ return new Date().toISOString(); }

  function uuidv4(){
    try{ if(window.crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID(); }catch(_){}
    // fallback (último recurso) — mantém compatibilidade
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function centsToMoney(c){
    return (Number(c || 0) / 100).toFixed(2).replace(".", ",");
  }

  function moneyToCents(v){
    if (v === null || v === undefined) return NaN;
    var s = String(v).trim().replace(/\./g, "").replace(",", ".");
    var n = Number(s);
    if (!isFinite(n)) return NaN;
    return Math.round(n * 100);
  }

  function sanitizeEAN(eanRaw){
    return String(eanRaw || "").trim().replace(/\D+/g, "");
  }

  // Lucro % sobre venda (margem)
  function calcLucroPercent(vendaCents, custoCents){
    var v = Number(vendaCents || 0);
    var c = Number(custoCents || 0);
    if(!isFinite(v) || v <= 0) return 0;
    var p = ((v - c) / v) * 100;
    if(!isFinite(p)) return 0;
    return Math.max(-9999, Math.min(9999, p));
  }
  function fmtPercent(p){ return (Number(p || 0)).toFixed(2).replace(".", ","); }

  function normText(s){ return String(s || "").trim(); }
  function normDateISO(s){
    s = String(s || "").trim();
    if(!s) return "";
    if(/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return "";
  }
  function dateISOToBR(iso){
    iso = String(iso||"").trim();
    if(!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
    var y = iso.slice(0,4), m = iso.slice(5,7), d = iso.slice(8,10);
    return d + "/" + m + "/" + y;
  }

  // =============================
  // Toast enterprise (central)
  // =============================
  var _toastTimer = null;
  function toastShow(kind, title, message, opts){
    opts = opts || {};
    var box = byId("vscToast");
    var ico = byId("vscToastIcon");
    var tit = byId("vscToastTitle");
    var msg = byId("vscToastMsg");
    var cls = byId("vscToastClose");

    function fallback(){
      setMsg((title ? (title + ": ") : "") + (message || ""), (kind === "error") ? "err" : "ok");
    }

    if(!box || !tit || !msg) return fallback();
    if(_toastTimer){ try{ clearTimeout(_toastTimer); }catch(_e){} _toastTimer = null; }

    var k = String(kind || "info").toLowerCase();
    box.className = "vsc-toast " + k;
    tit.textContent = title ? String(title) : "";
    msg.textContent = message ? String(message) : "";
    if(ico){ ico.textContent = (k === "success") ? "✓" : (k === "warn") ? "!" : (k === "error") ? "×" : "i"; }

    box.style.display = "flex";
    box.setAttribute("role", (k === "error") ? "alert" : "status");

    if(cls && !cls._vscBound){
      cls._vscBound = true;
      cls.addEventListener("click", function(){
        box.style.display = "none";
        if(_toastTimer){ try{ clearTimeout(_toastTimer); }catch(_e){} _toastTimer = null; }
      });
    }

    var persist = (k === "error") ? true : !!opts.persist;
    var timeout = Number(opts.timeout || 4200);
    if(!persist){
      _toastTimer = setTimeout(function(){
        box.style.display = "none";
        _toastTimer = null;
      }, Math.max(1200, timeout));
    }
  }
  window.toastShow = toastShow;

  function setMsg(text, kind){
    var el = byId("msg");
    if(!el) return;
    var t = text ? String(text) : "";
    el.textContent = t;
    el.className = "note" + (kind ? (" " + kind) : "");
  }

  function setBadge(text, kind){
    var b = byId("badgeModo");
    if(!b) return;
    var t = String(text || "");
    if(!t){ b.style.display = "none"; return; }
    b.style.display = "inline-block";
    b.textContent = t;
    b.className = "badge " + (kind || "");
  }

  function assertVSCDB(){
    if(!window.VSC_DB || typeof VSC_DB.openDB !== "function"){
      toastShow("error", "Erro", "VSC_DB não carregado. Verifique o include modules/vsc_db.js.", { persist:true });
      return false;
    }
    return true;
  }

  // =============================
  // IDB access
  // =============================
  async function idbGetAllProdutos(){
    var db = await VSC_DB.openDB();
    try{
      return await new Promise(function(resolve, reject){
        var tx = db.transaction([VSC_DB.stores.produtos_master], "readonly");
        var st = tx.objectStore(VSC_DB.stores.produtos_master);
        var rq = st.getAll();
        rq.onsuccess = function(){ resolve(Array.isArray(rq.result) ? rq.result : []); };
        rq.onerror = function(){ reject(rq.error || new Error("Falha IDB getAll produtos")); };
      });
    } finally { try{ db.close(); }catch(_e){} }
  }


  // Soma quantidade por produto a partir de produtos_lotes (offline-first)
  async function idbGetStockMapFromLotes(){
    var db = await VSC_DB.openDB();
    try{
      return await new Promise(function(resolve, reject){
        var tx = db.transaction([VSC_DB.stores.produtos_lotes], "readonly");
        var st = tx.objectStore(VSC_DB.stores.produtos_lotes);
        var rq = st.openCursor();
        var map = {};
        rq.onsuccess = function(){
          var cur = rq.result;
          if(cur){
            var v = cur.value || {};
            if(!v.deleted_at){
              var pid = String(v.produto_id || "");
              var q = Number(v.qtd || 0);
              if(pid){
                map[pid] = (map[pid] || 0) + (isFinite(q) ? q : 0);
              }
            }
            cur.continue();
          } else {
            resolve(map);
          }
        };
        rq.onerror = function(){ reject(rq.error || new Error("Falha IDB cursor produtos_lotes")); };
      });
    } finally { try{ db.close(); }catch(_e){} }
  }

  async function idbGetLotesByProduto(produto_id){
    var db = await VSC_DB.openDB();
    try{
      return await new Promise(function(resolve, reject){
        var tx = db.transaction([VSC_DB.stores.produtos_lotes], "readonly");
        var st = tx.objectStore(VSC_DB.stores.produtos_lotes);
        var ix = st.index("produto_id");
        var out = [];
        var rq = ix.openCursor(IDBKeyRange.only(String(produto_id)), "next");
        rq.onsuccess = function(){
          var cur = rq.result;
          if(cur){ out.push(cur.value); cur.continue(); }
          else resolve(out);
        };
        rq.onerror = function(){ reject(rq.error || new Error("Falha IDB cursor lotes")); };
      });
    } finally { try{ db.close(); }catch(_e){} }
  }

  async function idbUpsertProdutoAtomico(obj){
    return VSC_DB.upsertWithOutbox(
      VSC_DB.stores.produtos_master,
      obj,
      "produtos",
      obj.produto_id || obj.id,
      { __origin:"MASTER_EDIT" }
    );
  }

  // ============================================================
  // API pública (Console/Automação): salvar produto enterprise
  // - usada pelo COMMERCIAL_GATE e testes ESOS
  // ============================================================
  window.VSC__produtoSaveEnterprise = async function(produto){
    if(!produto || typeof produto !== "object") return { ok:false, msg:"Produto inválido" };

    var nome = String(produto.nome || "").trim();
    if(!nome) return { ok:false, msg:"Nome do produto é obrigatório." };

    var now = nowISO();
    var obj = Object.assign({}, produto);

    // chave canônica
    var pid = obj.produto_id || obj.id || null;
    if(!pid){
      pid = uuidv4();
      obj.produto_id = pid;
      obj.id = pid; // compat
      obj.created_at = obj.created_at || now;
      obj.custo_real_cents = obj.custo_real_cents || 0;
      obj.custo_medio_cents = obj.custo_medio_cents || 0;
    } else {
      obj.produto_id = pid;
      obj.id = pid;
      obj.created_at = obj.created_at || now;
    }

    obj.nome = nome;
    obj.nome_norm = obj.nome_norm || nome;
    obj.updated_at = now;
    obj.deleted_at = null;

    try{
      await idbUpsertProdutoAtomico(obj);
      return { ok:true, produto_id: obj.produto_id };
    } catch(e){
      return { ok:false, msg: String((e && (e.message||e)) || e) };
    }
  };

  // compat: alguns testes usam este nome
  window.VSC__produtoNormalizeAndValidate = function(p){
    var r = { ok:false, msg:"Produto inválido" };
    try{
      var nome = String(p?.nome||"").trim();
      if(!nome) return { ok:false, msg:"Nome do produto é obrigatório." };
      return { ok:true, produto:Object.assign({}, p, { nome }) };
    } catch(e){
      return { ok:false, msg: String((e && (e.message||e)) || e) };
    }
  };

  async function idbUpsertLoteAtomico(loteObj){
    return VSC_DB.upsertWithOutbox(
      VSC_DB.stores.produtos_lotes,
      loteObj,
      "produtos_lotes",
      loteObj.id,
      { __origin:"MASTER_EDIT" }
    );
  }

  // =============================
  // State
  // =============================
  var state = {
    produtos: [],
    selectedId: "",
    mode: "LIST", // LIST | VIEW | EDIT | NEW
    lotes: [],
    loteEditingId: "",
    enrich: { last:null, selected:{} },
    qf: "ALL",
    stockMap: {}
  };

  // =============================
  // UI mode helpers
  // =============================
  function showDetailEmpty(){
    var empty = byId("detailEmpty");
    var frm = byId("frmProduto");
    if(empty) empty.hidden = false;
    if(frm) frm.hidden = true;
    var sub = byId("detailSub");
    if(sub) sub.textContent = "Selecione um item ou clique em NOVO.";
    setBadge("", "");
  }

  function showForm(){
    var empty = byId("detailEmpty");
    var frm = byId("frmProduto");
    if(empty) empty.hidden = true;
    if(frm) frm.hidden = false;
  }

  function setInputsEnabled(enabled){
    var _pNome = byId("pNome"); if(_pNome) _pNome.disabled = !enabled;
    var _pEAN = byId("pEAN"); if(_pEAN) _pEAN.disabled = !enabled;
    var _pCusto = byId("pCusto"); if(_pCusto) _pCusto.disabled = !enabled;
    var _pVenda = byId("pVenda"); if(_pVenda) _pVenda.disabled = !enabled;
    // dados técnicos
    if(byId("pMarca")) byId("pMarca").disabled = !enabled;
    if(byId("pCategoria")) byId("pCategoria").disabled = !enabled;
    if(byId("pNCM")) byId("pNCM").disabled = !enabled;
    if(byId("pCEST")) byId("pCEST").disabled = !enabled;
    if(byId("pRegistro")) byId("pRegistro").disabled = !enabled;
    if(byId("pPrincipio")) byId("pPrincipio").disabled = !enabled;
    if(byId("pImgUrl")) byId("pImgUrl").disabled = !enabled;
    if(byId("pMin")) byId("pMin").disabled = !enabled;
    if(byId("pRep")) byId("pRep").disabled = !enabled;
    // derivados sempre disabled
    var _pLucro = byId("pLucro"); if(_pLucro) _pLucro.disabled = true;
    var _pCustoReal = byId("pCustoReal"); if(_pCustoReal) _pCustoReal.disabled = true;
    var _pCustoMedio = byId("pCustoMedio"); if(_pCustoMedio) _pCustoMedio.disabled = true;
  }

  function setActionButtons(){
    var bEditar = byId("btnEditar");
    var bSalvar = byId("btnSalvar");
    var bCancelar = byId("btnCancelar");
    var bVoltar = byId("btnVoltar");
    var bExcluir = byId("btnExcluir");

    var isView = state.mode === "VIEW";
    var isEdit = state.mode === "EDIT";
    var isNew  = state.mode === "NEW";

    if(bEditar)   bEditar.hidden = !(isView);
    if(bSalvar)   bSalvar.hidden = !(isEdit || isNew);
    if(bCancelar) bCancelar.hidden = !(isEdit || isNew);
    if(bVoltar)   bVoltar.hidden = false;

    if(bExcluir)  bExcluir.disabled = !(state.selectedId && (isView || isEdit));
  }

  function setLotesEnabled(enabled){
    var lLote = byId("lLote");
    var lVenc = byId("lVenc");
    var lQtd  = byId("lQtd");
    var lCusto= byId("lCusto");
    var bLSal = byId("btnLoteSalvar");
    var bLCa  = byId("btnLoteCancelar");
    var bLEx  = byId("btnLoteExcluir");

    var canUse = !!state.selectedId; // só com produto salvo
    if(!canUse){
      if(lLote) lLote.disabled = true;
      if(lVenc) lVenc.disabled = true;
      if(lQtd)  lQtd.disabled  = true;
      if(lCusto)lCusto.disabled= true;
      if(bLSal) bLSal.disabled = true;
      if(bLCa)  bLCa.disabled  = true;
      if(bLEx)  bLEx.disabled  = true;
      return;
    }

    var en = !!enabled;
    if(lLote) lLote.disabled = !en;
    if(lVenc) lVenc.disabled = !en;
    if(lQtd)  lQtd.disabled  = !en;
    if(lCusto)lCusto.disabled= !en;
    if(bLSal) bLSal.disabled = !en;
    if(bLCa)  bLCa.disabled  = !en;
    // excluir só quando tiver edição de lote selecionada (setado no fillLoteForm)
    if(bLEx)  bLEx.disabled  = !(en && !!state.loteEditingId);
  }

  function setLotesVisibility(){
    var empty = byId("lotesEmpty");
    var box = byId("lotesBox");
    if(!state.selectedId){
      if(empty) empty.style.display = "block";
      if(box) box.style.display = "none";
      return;
    }
    if(empty) empty.style.display = "none";
    if(box) box.style.display = "block";
  }

  function clearForm(){
    state.selectedId = "";
    byId("pNome").value = "";
    byId("pEAN").value = "";
    byId("pCusto").value = "0,00";
    byId("pVenda").value = "0,00";
    byId("pLucro").value = "0,00";
    byId("pCustoReal").value = "0,00";
    byId("pCustoMedio").value = "0,00";
    if(byId("pMarca")) byId("pMarca").value = "";
    if(byId("pCategoria")) byId("pCategoria").value = "";
    if(byId("pNCM")) byId("pNCM").value = "";
    if(byId("pCEST")) byId("pCEST").value = "";
    if(byId("pRegistro")) byId("pRegistro").value = "";
    if(byId("pPrincipio")) byId("pPrincipio").value = "";
    if(byId("pImgUrl")) byId("pImgUrl").value = "";
    if(byId("pMin")) byId("pMin").value = "";
    if(byId("pRep")) byId("pRep").value = "";
    clearLoteForm();
    state.lotes = [];
    renderLotesTable();
  }

  function syncDerived(){
    var custo = moneyToCents(byId("pCusto").value);
    var venda = moneyToCents(byId("pVenda").value);
    var p = calcLucroPercent(venda, custo);
    byId("pLucro").value = fmtPercent(p);
  }

  function fillFormFromObj(obj){
    state.selectedId = String(obj.produto_id || obj.id || "");
    byId("pNome").value = obj.nome || "";
    byId("pEAN").value = obj.ean || "";
    byId("pCusto").value = centsToMoney(obj.custo_base_cents);
    byId("pVenda").value = centsToMoney(obj.venda_cents);
    byId("pCustoReal").value = centsToMoney(obj.custo_real_cents);
    byId("pCustoMedio").value = centsToMoney(obj.custo_medio_cents);
    byId("pLucro").value = fmtPercent(calcLucroPercent(obj.venda_cents, obj.custo_base_cents));
    if(byId("pMarca")) byId("pMarca").value = obj.marca || "";
    if(byId("pCategoria")) byId("pCategoria").value = obj.categoria || "";
    if(byId("pNCM")) byId("pNCM").value = obj.ncm || "";
    if(byId("pCEST")) byId("pCEST").value = obj.cest || "";
    if(byId("pRegistro")) byId("pRegistro").value = obj.registro || "";
    if(byId("pPrincipio")) byId("pPrincipio").value = obj.principio || "";
    if(byId("pImgUrl")) byId("pImgUrl").value = obj.img_url || "";
    if(byId("pMin")) byId("pMin").value = String(obj.estoque_minimo != null ? obj.estoque_minimo : "");
    if(byId("pRep")) byId("pRep").value = String(obj.ponto_reposicao != null ? obj.ponto_reposicao : "");
  }

  function getSelectedProduto(){
    var id = String(state.selectedId || "");
    if(!id) return null;
    for(var i=0;i<state.produtos.length;i++){
      var p = state.produtos[i];
      if(p && !p.deleted_at && String(p.produto_id) === id) return p;
    }
    return null;
  }


  function getStockQty(prod){
    var id = String(prod && (prod.produto_id || prod.id) || "");
    return Number(state.stockMap && state.stockMap[id] != null ? state.stockMap[id] : 0) || 0;
  }

  function getStockStatus(prod){
    var qty = getStockQty(prod);
    var min = Number(prod && prod.estoque_minimo != null ? prod.estoque_minimo : 0) || 0;
    var rep = Number(prod && prod.ponto_reposicao != null ? prod.ponto_reposicao : 0) || 0;

    // Sem configuração => neutro
    if(!(min > 0 || rep > 0)) return "NONE";

    if(qty <= min) return "CRIT";
    // LOW só existe acima do mínimo e até o ponto de reposição
    if(qty > min && rep > 0 && qty <= rep) return "LOW";
    return "OK";
  }

  function isProdutoPendente(prod){
    // pendências de dados técnicos
    if(!prod) return true;
    var need = ["marca","categoria","ncm","cest","registro","principio"];
    for(var i=0;i<need.length;i++){
      var k = need[i];
      if(!String(prod[k] || "").trim()) return true;
    }
    return false;
  }

  function stockBadgeHTML(prod){
    var qty = getStockQty(prod);
    var st = getStockStatus(prod);
    var bg = "#e2e8f0";
    var fg = "#0f172a";
    var label = "SEM CONTROLE";
    if(st === "CRIT"){ bg = "#ef4444"; fg = "#fff"; label="CRÍTICO"; }
    else if(st === "LOW"){ bg = "#f59e0b"; fg="#111827"; label="BAIXO"; }
    else if(st === "OK"){ bg = "#22c55e"; fg="#fff"; label="OK"; }

    return '<span class="pill" style="background:'+bg+';color:'+fg+';border-color:rgba(0,0,0,.08);min-width:74px;text-align:center;">' +
      String(qty).replace(".",",") + ' un</span>' +
      '<span class="pill" style="margin-left:8px;">' + label + '</span>';
  }


  // =============================
  // LIST rendering
  // =============================
  function renderList(){
    var tb = byId("tb");
    if(!tb) return;
    tb.innerHTML = "";

    var allProds = state.produtos.filter(function(x){ return x && !x.deleted_at; });

    // KPI Strip
    var critCount = allProds.filter(function(x){ try{ return getStockStatus(x)==="CRIT"; }catch(_){ return false; } }).length;
    var lowCount  = allProds.filter(function(x){ try{ return getStockStatus(x)==="LOW";  }catch(_){ return false; } }).length;
    var eanCount  = allProds.filter(function(x){ return !!(x.ean && String(x.ean).trim()); }).length;
    var kTotal = byId("kpiProdTotal"); if(kTotal) kTotal.textContent = allProds.length;
    var kCrit  = byId("kpiProdCrit");  if(kCrit)  kCrit.textContent  = critCount;
    var kLow   = byId("kpiProdLow");   if(kLow)   kLow.textContent   = lowCount;
    var kEan   = byId("kpiProdEan");   if(kEan)   kEan.textContent   = eanCount;

    var q = String(byId("q") && byId("q").value ? byId("q").value : "").trim().toLowerCase();

    var rows = allProds
      .filter(function(x){
        // quick filters (enterprise)
        var qf = state.qf || "ALL";
        if(qf === "CRIT" || qf === "LOW" || qf === "OK"){
          return getStockStatus(x) === qf;
        }
        if(qf === "PEND"){
          return isProdutoPendente(x);
        }
        return true;
      })
      .filter(function(x){
        if(!q) return true;
        var nome = String(x.nome || "").toLowerCase();
        var ean  = String(x.ean || "").toLowerCase();
        if(nome.indexOf(q) >= 0 || ean.indexOf(q) >= 0) return true;
        return false;
      });

    if(!rows.length){
      var tr0 = document.createElement("tr");
      tr0.innerHTML = '<td colspan="3" class="note" style="text-align:center;padding:20px;">Nenhum produto encontrado.</td>';
      tb.appendChild(tr0);
      return;
    }

    for(var i=0;i<rows.length;i++){
      var x = rows[i];
      var tr = document.createElement("tr");
      tr.setAttribute("data-act","view");
      tr.setAttribute("data-id", String(x.produto_id));
      tr.style.cursor = "pointer";
      tr.title = "Abrir detalhe";
      try{
        var st = getStockStatus(x);
        if(st === "CRIT") tr.classList.add("vsc-row-crit");
        else if(st === "LOW") tr.classList.add("vsc-row-low");
      }catch(_e){}
      tr.innerHTML =
        '<td>' +
          '<div style="font-weight:900;">' + (x.nome || "") + '</div>' +
          '<div style="opacity:.7; font-size:12px;">Custo: R$ ' + centsToMoney(x.custo_base_cents) + ' • Venda: R$ ' + centsToMoney(x.venda_cents) + '</div>' +
          '<div style="margin-top:6px;">' + stockBadgeHTML(x) + '</div>' +
        '</td>' +
        '<td>' + (x.ean || "") + '</td>' +
        '<td><button class="btn small" type="button" data-act="view" data-id="' + String(x.produto_id) + '">Ver</button></td>';
      tb.appendChild(tr);
    }
  }

  // =============================
  // LOTES (store produtos_lotes)
  // =============================
  function clearLoteForm(){
    state.loteEditingId = "";
    if(byId("lLote")) byId("lLote").value = "";
    if(byId("lVenc")) byId("lVenc").value = "";
    if(byId("lQtd"))  byId("lQtd").value  = "";
    if(byId("lCusto"))byId("lCusto").value= "";
    var ex = byId("btnLoteExcluir");
    if(ex) ex.disabled = true;
  }

  function fillLoteForm(l){
    state.loteEditingId = String(l && l.id ? l.id : "");
    if(byId("lLote")) byId("lLote").value = l.lote || "";
    if(byId("lVenc")) byId("lVenc").value = l.vencimento || "";
    if(byId("lQtd"))  byId("lQtd").value  = String(l.qtd || "");
    if(byId("lCusto"))byId("lCusto").value= centsToMoney(l.custo_cents || 0);
    var ex = byId("btnLoteExcluir");
    if(ex) ex.disabled = !state.loteEditingId;
  }

  function getLotesAtivos(){
    return (state.lotes || []).filter(function(l){
      if(!l) return false;
      if(l.deleted_at) return false;
      if(String(l.status || "ATIVO") === "DELETED") return false;
      return true;
    });
  }

  function renderLotesTable(){
    var tb = byId("tbLotes");
    if(!tb) return;
    tb.innerHTML = "";

    if(!state.selectedId){
      var tr0 = document.createElement("tr");
      tr0.innerHTML = '<td colspan="5" class="note">Salve um produto para cadastrar lotes.</td>';
      tb.appendChild(tr0);
      return;
    }

    var lotes = getLotesAtivos().slice();

    // FEFO: vencimento asc (vazio fim), depois lote
    lotes.sort(function(a,b){
      var av = String(a.vencimento || "");
      var bv = String(b.vencimento || "");
      if(!av && !bv) return String(a.lote||"").localeCompare(String(b.lote||""));
      if(!av) return 1;
      if(!bv) return -1;
      if(av < bv) return -1;
      if(av > bv) return 1;
      return String(a.lote||"").localeCompare(String(b.lote||""));
    });

    if(!lotes.length){
      var tr1 = document.createElement("tr");
      tr1.innerHTML = '<td colspan="5" class="note">Nenhum lote cadastrado para este produto.</td>';
      tb.appendChild(tr1);
      return;
    }

    for(var i=0;i<lotes.length;i++){
      var l = lotes[i];
      var tr = document.createElement("tr");
      tr.innerHTML =
        '<td><div style="font-weight:900;">' + (l.lote || "") + '</div></td>' +
        '<td>' + (dateISOToBR(l.vencimento) || "") + '</td>' +
        '<td>' + String(l.qtd || 0) + '</td>' +
        '<td>R$ ' + centsToMoney(l.custo_cents || 0) + '</td>' +
        '<td><button class="btn small" type="button" data-act="lote-view" data-id="' + String(l.id) + '">Editar</button></td>';
      tb.appendChild(tr);
    }
  }

  async function loadLotesForSelected(){
    if(!state.selectedId){ state.lotes = []; renderLotesTable(); return; }
    state.lotes = await idbGetLotesByProduto(state.selectedId);
    renderLotesTable();
  }

  async function onLoteSave(){
    if(!assertVSCDB()) return;
    if(!state.selectedId){
      toastShow("warn","Atenção","Salve um produto antes de cadastrar lote.");
      return;
    }

    var lote = normText(byId("lLote") && byId("lLote").value);
    var venc = normDateISO(byId("lVenc") && byId("lVenc").value);
    var qtdStr = String(byId("lQtd") && byId("lQtd").value ? byId("lQtd").value : "").trim().replace(",", ".");
    var qtd = Number(qtdStr || "0");
    var custo = moneyToCents(byId("lCusto") && byId("lCusto").value ? byId("lCusto").value : "0");

    if(!lote){ toastShow("warn","Atenção","Lote é obrigatório."); return; }
    if(!venc){ toastShow("warn","Atenção","Vencimento é obrigatório."); return; }
    if(!isFinite(qtd) || qtd <= 0){ toastShow("warn","Atenção","Quantidade inválida."); return; }
    if(!isFinite(custo) || custo < 0){ toastShow("warn","Atenção","Custo do lote inválido."); return; }

    var p = getSelectedProduto();
    var ean = p ? String(p.ean || "") : "";

    var now = nowISO();
    var id = state.loteEditingId ? String(state.loteEditingId) : uuidv4();

    var obj = {
      id: id,
      produto_id: String(state.selectedId),
      ean: ean,
      lote: lote,
      vencimento: venc,
      qtd: qtd,
      custo_cents: custo,
      status: "ATIVO",
      deleted_at: null,
      created_at: now,
      updated_at: now
    };

    // preserva created_at se estiver editando
    if(state.loteEditingId){
      for(var i=0;i<state.lotes.length;i++){
        var cur = state.lotes[i];
        if(cur && String(cur.id) === id){
          obj.created_at = cur.created_at || now;
          break;
        }
      }
    }

    try{
      await idbUpsertLoteAtomico(obj);
      toastShow("success","Lote","Salvo com sucesso.");
      clearLoteForm();
      await loadLotesForSelected();
    }catch(e){
      toastShow("error","Erro","Falha ao salvar lote. " + String((e && (e.message||e)) || e), { persist:true });
    }
  }

  async function onLoteDelete(){
    if(!assertVSCDB()) return;
    if(!state.selectedId || !state.loteEditingId) return;

    if(window.VSC_UI && typeof window.VSC_UI.confirmAsync === "function"){
      var ok = await window.VSC_UI.confirmAsync({
        title:"Excluir lote",
        body:"Excluir este lote?",
        okText:"Excluir",
        cancelText:"Cancelar",
        kind:"warn"
      });
      if(!ok) return;
    } else {
      // fail-closed: sem confirm modal canônico, não executa destrutivo
      toastShow("warn","Atenção","Confirmação não disponível. Operação cancelada.");
      return;
    }

    var id = String(state.loteEditingId);
    var cur = null;
    for(var i=0;i<state.lotes.length;i++){
      var x = state.lotes[i];
      if(x && String(x.id) === id){ cur = x; break; }
    }
    if(!cur) return;

    var now = nowISO();
    var obj = Object.assign({}, cur, { status:"DELETED", deleted_at: now, updated_at: now });

    try{
      await idbUpsertLoteAtomico(obj);
      toastShow("warn","Lote","Excluído.");
      clearLoteForm();
      await loadLotesForSelected();
    }catch(e){
      toastShow("error","Erro","Falha ao excluir lote. " + String((e && (e.message||e)) || e), { persist:true });
    }
  }

  // =============================
  // Actions: VIEW/EDIT/NEW
  // =============================
  async function enterView(produto_id){
    
    setDetailVisible(true);
state.mode = "VIEW";
    setBadge("VIEW", "ok");
    var obj = null;
    for(var i=0;i<state.produtos.length;i++){
      var p = state.produtos[i];
      if(p && !p.deleted_at && String(p.produto_id) === String(produto_id)){ obj = p; break; }
    }
    if(!obj){ showDetailEmpty(); return; }

    showForm();
    fillFormFromObj(obj);
    try{ if(byId("detailHint")) byId("detailHint").textContent = (obj.nome ? ("Selecionado: " + obj.nome) : ""); }catch(_e){}
    setInputsEnabled(false);
    setActionButtons();

    byId("detailSub").textContent = "Modo VIEW (somente leitura).";
    setLotesVisibility();
    setLotesEnabled(false); // em VIEW não edita lotes (governança)
    await loadLotesForSelected();
    setMsg("Produto carregado.", "ok");
  }

  async function enterNew(){
    
    setDetailVisible(true);
state.mode = "NEW";
    setBadge("NEW", "warn");
    showForm();
    clearForm();
    try{ if(byId("detailHint")) byId("detailHint").textContent = "Novo produto"; }catch(_e){}
    setInputsEnabled(true);
    setActionButtons();

    byId("detailSub").textContent = "Modo NEW (novo cadastro).";
    setLotesVisibility();
    setLotesEnabled(false);
    setMsg("Preencha os dados e clique em Salvar.", "ok");
    try{ byId("pNome").focus(); }catch(_e){}
  }

  function enterEdit(){
    if(!state.selectedId) return;
    state.mode = "EDIT";
    setBadge("EDIT", "warn");
    showForm();
    setInputsEnabled(true);
    setActionButtons();

    byId("detailSub").textContent = "Modo EDIT (edição).";
    setLotesVisibility();
    setLotesEnabled(true); // em EDIT pode ajustar lotes
    setMsg("Edite e clique em Salvar.", "ok");
    try{ byId("pNome").focus(); }catch(_e){}
  }

  function exitToList(){
    state.mode = "LIST";
    setBadge("", "");
    clearForm();
    showDetailEmpty();
    setMsg("Pronto. Selecione um produto na lista ou clique em Novo.", "ok");
    goListView();
  }

  // =============================
  // Save/Delete Produto
  // =============================
  var _saveInFlight = false;

  async function onSalvarProduto(){
    if(!assertVSCDB()) return;
    if(_saveInFlight) return;
    _saveInFlight = true;

    var b = byId("btnSalvar");
    if(b) b.disabled = true;

    setMsg("Salvando...", "ok");

    try{
      var nome = normText(byId("pNome") && byId("pNome").value);
      var ean  = sanitizeEAN(byId("pEAN") && byId("pEAN").value);

      if(!nome) throw new Error("Nome é obrigatório.");
      if(ean && ean.length < 8) throw new Error("EAN inválido (muito curto).");

      var custo = moneyToCents(byId("pCusto") && byId("pCusto").value);
      var venda = moneyToCents(byId("pVenda") && byId("pVenda").value);

      if(!isFinite(custo) || custo < 0) throw new Error("Custo inválido.");
      if(!isFinite(venda) || venda < 0) throw new Error("Venda inválida.");

      var now = nowISO();
      var obj = null;

      if(state.mode === "EDIT" || state.mode === "VIEW"){
        obj = getSelectedProduto();
      }

      if(!obj){
        obj = { produto_id: uuidv4(), created_at: now };
        obj.id = obj.produto_id; // compat
        obj.custo_real_cents = 0;
        obj.custo_medio_cents = 0;
      }

      obj.nome = nome;
      obj.nome_norm = nome; // compat (normalização pode ser feita em outro ciclo)
      obj.ean = ean;
      obj.custo_base_cents = custo;
      obj.venda_cents = venda;
      obj.deleted_at = null;
      obj.updated_at = now;
      // dados técnicos (podem vir do enriquecimento web)
      obj.marca = (byId("pMarca") ? String(byId("pMarca").value||"").trim() : (obj.marca||""));
      obj.categoria = (byId("pCategoria") ? String(byId("pCategoria").value||"").trim() : (obj.categoria||""));
      obj.ncm = (byId("pNCM") ? String(byId("pNCM").value||"").trim() : (obj.ncm||""));
      obj.cest = (byId("pCEST") ? String(byId("pCEST").value||"").trim() : (obj.cest||""));
      obj.registro = (byId("pRegistro") ? String(byId("pRegistro").value||"").trim() : (obj.registro||""));
      obj.principio = (byId("pPrincipio") ? String(byId("pPrincipio").value||"").trim() : (obj.principio||""));
      obj.img_url = (byId("pImgUrl") ? String(byId("pImgUrl").value||"").trim() : (obj.img_url||""));
      // estoque (cores + filtros)
      obj.estoque_minimo = (byId("pMin") ? Number(String(byId("pMin").value||"").trim().replace(",", ".")) : (obj.estoque_minimo||0));
      obj.ponto_reposicao = (byId("pRep") ? Number(String(byId("pRep").value||"").trim().replace(",", ".")) : (obj.ponto_reposicao||0));
      if(!isFinite(obj.estoque_minimo) || obj.estoque_minimo < 0) obj.estoque_minimo = 0;
      if(!isFinite(obj.ponto_reposicao) || obj.ponto_reposicao < 0) obj.ponto_reposicao = 0;
      obj.enrich_updated_at = obj.enrich_updated_at || null;

      await idbUpsertProdutoAtomico(obj);

      toastShow("success","Produto","Salvo com sucesso.");
      state.selectedId = String(obj.produto_id);
      await refreshProdutos();
      await enterView(state.selectedId);

    }catch(e){
      toastShow("error","Erro","Falha ao salvar produto. " + String((e && (e.message||e)) || e), { persist:true });
      setMsg("Falha ao salvar produto.", "err");
    }finally{
      if(b) b.disabled = false;
      _saveInFlight = false;
    }
  }

  async function onExcluirProduto(){
    if(!assertVSCDB()) return;
    if(!state.selectedId) return;

    var obj = getSelectedProduto();
    if(!obj) return;

    if(window.VSC_UI && typeof window.VSC_UI.confirmAsync === "function"){
      var ok = await window.VSC_UI.confirmAsync({
        title:"Excluir produto",
        body:"Excluir este produto?",
        okText:"Excluir",
        cancelText:"Cancelar",
        kind:"warn"
      });
      if(!ok) return;
    } else {
      toastShow("warn","Atenção","Confirmação não disponível. Operação cancelada.");
      return;
    }

    obj.deleted_at = nowISO();
    obj.updated_at = obj.deleted_at;

    try{
      await idbUpsertProdutoAtomico(obj);
      toastShow("warn","Produto","Excluído.");
      await refreshProdutos();
      exitToList();
    }catch(e){
      toastShow("error","Erro","Falha ao excluir produto. " + String((e && (e.message||e)) || e), { persist:true });
    }
  }

  function onCancelarEdicao(){
    if(state.mode === "NEW"){
      exitToList();
      return;
    }
    // volta para VIEW do item atual
    if(state.selectedId) enterView(state.selectedId);
    else exitToList();
  }

  // =============================
  // Refresh
  // =============================
  var _refreshInFlight = false;

  async function refreshProdutos(){
    if(!assertVSCDB()) return;
    if(_refreshInFlight) return;
    _refreshInFlight = true;

    try{
      state.produtos = await idbGetAllProdutos();
          state.stockMap = (window.VSC_ESTOQUE && typeof window.VSC_ESTOQUE.getStockMap === "function")
            ? await window.VSC_ESTOQUE.getStockMap()
            : await idbGetStockMapFromLotes();
      
          // ordem alfabética (enterprise default)
          state.produtos = (state.produtos || []).slice().sort(function(a,b){
            var an = String((a && (a.nome_norm || a.nome)) || "");
            var bn = String((b && (b.nome_norm || b.nome)) || "");
            return an.localeCompare(bn, "pt-BR", { sensitivity:"base" });
          });
      
          renderList();
    } finally {
      _refreshInFlight = false;
    }
  }

  
  // =============================
  // Enriquecimento Web (governança)
  // =============================
  function setNetPill(){
    var p = byId("enrichNet");
    if(!p) return;
    var on = (window.VSC_ENRICH && VSC_ENRICH.isOnline && VSC_ENRICH.isOnline());
    p.textContent = on ? "Online" : "Offline";
    p.style.borderColor = on ? "rgba(31,157,85,.35)" : "rgba(100,116,139,.35)";
    p.style.color = on ? "var(--vsc-green)" : "#334155";
  }

  function fieldLabel(k){
    var map = {
      nome:"Nome", marca:"Marca/Laboratório", categoria:"Categoria",
      ncm:"NCM", cest:"CEST", registro:"Registro", principio:"Princípio ativo",
      img_url:"Imagem (URL)"
    };
    return map[k] || k;
  }

  function getCurrentFieldValue(k){
    if(k === "nome") return String(byId("pNome") && byId("pNome").value || "").trim();
    if(k === "marca") return String(byId("pMarca") && byId("pMarca").value || "").trim();
    if(k === "categoria") return String(byId("pCategoria") && byId("pCategoria").value || "").trim();
    if(k === "ncm") return String(byId("pNCM") && byId("pNCM").value || "").trim();
    if(k === "cest") return String(byId("pCEST") && byId("pCEST").value || "").trim();
    if(k === "registro") return String(byId("pRegistro") && byId("pRegistro").value || "").trim();
    if(k === "principio") return String(byId("pPrincipio") && byId("pPrincipio").value || "").trim();
    if(k === "img_url") return String(byId("pImgUrl") && byId("pImgUrl").value || "").trim();
    return "";
  }

  function setFieldValue(k, v){
    v = String(v || "").trim();
    if(k === "nome" && byId("pNome")) byId("pNome").value = v;
    if(k === "marca" && byId("pMarca")) byId("pMarca").value = v;
    if(k === "categoria" && byId("pCategoria")) byId("pCategoria").value = v;
    if(k === "ncm" && byId("pNCM")) byId("pNCM").value = v;
    if(k === "cest" && byId("pCEST")) byId("pCEST").value = v;
    if(k === "registro" && byId("pRegistro")) byId("pRegistro").value = v;
    if(k === "principio" && byId("pPrincipio")) byId("pPrincipio").value = v;
    if(k === "img_url" && byId("pImgUrl")) byId("pImgUrl").value = v;
  }

  function showEnrichPanel(show){
    var p = byId("enrichPanel");
    if(!p) return;
    p.style.display = show ? "block" : "none";
  }

  function renderEnrichSuggestions(payload){
    var list = byId("enrichList");
    var meta = byId("enrichMeta");
    if(!list) return;

    list.innerHTML = "";
    state.enrich.selected = {};

    var fields = payload && payload.fields ? payload.fields : {};
    var prov = payload && payload.provenance ? payload.provenance : {};
    var keys = Object.keys(fields || {});
    if(meta){
      meta.textContent = (payload && payload.providersUsed && payload.providersUsed.length)
        ? ("Fontes: " + payload.providersUsed.join(", "))
        : "";
    }

    if(!keys.length){
      list.innerHTML = '<div class="note">Nenhuma sugestão encontrada para este EAN.</div>';
      return;
    }

    keys.forEach(function(k){
      var cur = getCurrentFieldValue(k);
      var sug = String(fields[k] || "").trim();
      if(!sug) return;

      // default: auto-marcar só se campo atual estiver vazio
      var checked = (!cur);

      state.enrich.selected[k] = checked;

      var row = document.createElement("div");
      row.className = "rowline";
      row.innerHTML =
        '<div><input type="checkbox" data-k="' + k + '"' + (checked ? " checked" : "") + ' /></div>' +
        '<div class="k">' + fieldLabel(k) + '</div>' +
        '<div class="v ' + (cur ? "" : "muted") + '">' + (cur ? cur : "— vazio —") + '</div>' +
        '<div class="v">' + sug + '<div class="src">Fonte: ' + (prov[k] || "web") + '</div></div>';

      list.appendChild(row);
    });

    // bind checkbox changes (event delegation)
    list.addEventListener("change", function(ev){
      var t = ev.target;
      if(!t) return;
      if(t && t.matches && t.matches("input[type='checkbox'][data-k]")){
        var k = t.getAttribute("data-k");
        state.enrich.selected[k] = !!t.checked;
      }
    }, { once:true });
  }

  
  async function onSyncPendencias(){
    setNetPill();
    if(!window.VSC_ENRICH || typeof VSC_ENRICH.lookupByEAN !== "function"){
      toastShow("error","Erro","Módulo de enriquecimento não carregou (modules/product_enrich.js).",{persist:true});
      return;
    }
    if(!VSC_ENRICH.isOnline()){
      toastShow("warn","Offline","Sem conexão para sincronizar pendências.");
      return;
    }
    // seleciona pendências
    var pend = [];
    for(var i=0;i<state.produtos.length;i++){
      var p = state.produtos[i];
      if(!p || p.deleted_at) continue;
      if(!sanitizeEAN(p.ean)) continue;
      if(isProdutoPendente(p)) pend.push(p);
    }
    if(!pend.length){
      toastShow("success","Pendências","Nenhum produto com pendências.");
      return;
    }

    // Confirmação enterprise (se disponível)
    if(window.VSC_UI && typeof window.VSC_UI.confirmAsync === "function"){
      var ok = await window.VSC_UI.confirmAsync({
        title:"Sincronizar pendências",
        body:"Encontramos " + pend.length + " produto(s) com campos técnicos vazios. Buscar dados na web e preencher somente campos vazios?",
        okText:"Sincronizar",
        cancelText:"Cancelar",
        kind:"warn"
      });
      if(!ok) return;
    }

    toastShow("info","Sincronizando","Processando " + pend.length + " produto(s)...",{persist:true});
    var done = 0, filled = 0, nodata = 0, failed = 0;

    for(var k=0;k<pend.length;k++){
      // pausa se ficou offline
      if(!VSC_ENRICH.isOnline()){
        toastShow("warn","Interrompido","Ficou offline. Sincronização pausada.");
        break;
      }
      var p0 = pend[k];
      var ean = sanitizeEAN(p0.ean);
      try{
        var px = (window.VSC_ENRICH_PROXIES || {});
        var payload = await VSC_ENRICH.lookupByEAN(ean, {
          gs1Endpoint: (typeof px.gs1 === "string" ? px.gs1 : ""),
          anvisaEndpoint: (typeof px.anvisa === "string" ? px.anvisa : "")
        });

        if(payload && payload.ok && payload.fields){
          var before = JSON.stringify({
            marca:p0.marca||"", categoria:p0.categoria||"", ncm:p0.ncm||"", cest:p0.cest||"",
            registro:p0.registro||"", principio:p0.principio||"", img_url:p0.img_url||""
          });

          // preencher SOMENTE vazios (governança)
          if(!String(p0.marca||"").trim() && payload.fields.marca) p0.marca = payload.fields.marca;
          if(!String(p0.categoria||"").trim() && payload.fields.categoria) p0.categoria = payload.fields.categoria;
          if(!String(p0.ncm||"").trim() && payload.fields.ncm) p0.ncm = payload.fields.ncm;
          if(!String(p0.cest||"").trim() && payload.fields.cest) p0.cest = payload.fields.cest;
          if(!String(p0.registro||"").trim() && payload.fields.registro) p0.registro = payload.fields.registro;
          if(!String(p0.principio||"").trim() && payload.fields.principio) p0.principio = payload.fields.principio;
          if(!String(p0.img_url||"").trim() && payload.fields.img_url) p0.img_url = payload.fields.img_url;

          p0.enrich_updated_at = nowISO();
          p0.enrich_sources = (payload.providersUsed || []).join(",");
          p0.updated_at = nowISO();

          var after = JSON.stringify({
            marca:p0.marca||"", categoria:p0.categoria||"", ncm:p0.ncm||"", cest:p0.cest||"",
            registro:p0.registro||"", principio:p0.principio||"", img_url:p0.img_url||""
          });

          if(before !== after){ filled++; await idbUpsertProdutoAtomico(p0); }
          else { nodata++; }
        } else {
          nodata++;
        }
        done++;
        toastShow("info","Sincronizando","" + done + "/" + pend.length + " concluído...",{persist:true});
      }catch(e){
        failed++;
      }
      // backoff leve para não estourar rate limits
      await new Promise(function(r){ setTimeout(r, 450); });
    }

    toastShow("success","Sincronização concluída","Atualizados: " + filled + " • Sem dados: " + nodata + " • Falhas: " + failed);
    await refreshProdutos();
  }


async function onEnrichFetch(){
    setNetPill();
    if(!window.VSC_ENRICH || typeof VSC_ENRICH.lookupByEAN !== "function"){
      toastShow("error","Erro","Módulo de enriquecimento não carregou (modules/product_enrich.js).",{persist:true});
      return;
    }

    var ean = sanitizeEAN(byId("pEAN") && byId("pEAN").value);
    if(!ean){
      toastShow("warn","Atenção","Informe um EAN/GTIN antes de buscar.");
      return;
    }
    if(!VSC_ENRICH.isOnline()){
      toastShow("warn","Offline","Sem conexão para buscar dados na web.");
      return;
    }
    var pxCfg = (window.VSC_ENRICH_PROXIES || {});
    var hasPx = (typeof pxCfg.gs1 === "string" && pxCfg.gs1) || (typeof pxCfg.anvisa === "string" && pxCfg.anvisa);
    if(!hasPx){
      // enterprise: degrada com aviso único, sem quebrar
      if(!window.__VSC_ENRICH_NO_PROXY_WARNED){
        window.__VSC_ENRICH_NO_PROXY_WARNED = true;
        toastShow("info","Aviso","Fontes premium (GS1/ANVISA) não configuradas no servidor. Usando base pública quando disponível.");
      }
    }

    toastShow("info","Buscando","Consultando bases por EAN/GTIN...");
    try{
      // Endpoints internos opcionais (proxy) — se não existirem, o enrich faz fallback sem quebrar
      var px = (window.VSC_ENRICH_PROXIES || {});
      var payload = await VSC_ENRICH.lookupByEAN(ean, {
        gs1Endpoint: (typeof px.gs1 === "string" ? px.gs1 : ""),
        anvisaEndpoint: (typeof px.anvisa === "string" ? px.anvisa : "")
      });
      state.enrich.last = payload;

      if(!payload || !payload.ok){
        showEnrichPanel(true);
        renderEnrichSuggestions({ fields:{}, provenance:{}, providersUsed: payload ? payload.providersUsed : [] });
        toastShow("warn","Sem dados","Nenhuma base retornou dados para este EAN.");
        return;
      }

      showEnrichPanel(true);
      renderEnrichSuggestions(payload);
      toastShow("success","Sugestões","Dados encontrados. Selecione e aplique.");
    }catch(e){
      showEnrichPanel(false);
      toastShow("error","Erro","Falha ao buscar dados na web. Verifique conexão e configuração de proxies (GS1/ANVISA).",{persist:true});
    }
  }

  function canApplyEnrichNow(){
    return (state.mode === "EDIT" || state.mode === "NEW");
  }

  async function onEnrichApply(){
    if(!state.enrich.last || !state.enrich.last.fields){
      showEnrichPanel(false);
      return;
    }

    if(!canApplyEnrichNow()){
      // governança: exige modo EDIT/NEW (como Clientes)
      if(window.VSC_UI && typeof window.VSC_UI.confirmAsync === "function"){
        var ok = await window.VSC_UI.confirmAsync({
          title:"Aplicar sugestões",
          body:"Para aplicar sugestões, o módulo precisa entrar em modo EDIT. Continuar?",
          okText:"Entrar em EDIT",
          cancelText:"Cancelar",
          kind:"warn"
        });
        if(!ok) return;
      } else {
        toastShow("warn","Atenção","Entre em EDIT para aplicar sugestões.");
        return;
      }
      enterEdit();
    }

    var fields = state.enrich.last.fields || {};
    var selected = state.enrich.selected || {};
    var applied = 0;

    Object.keys(selected).forEach(function(k){
      if(!selected[k]) return;
      var v = fields[k];
      if(!v) return;
      setFieldValue(k, v);
      applied++;
    });

    if(applied){
      // marca metadado de enriquecimento
      try{
        var obj = getSelectedProduto();
        if(obj){
          obj.enrich_updated_at = nowISO();
          obj.enrich_sources = (state.enrich.last.providersUsed || []).join(",");
        }
      }catch(_e){}
      toastShow("success","Aplicado","Campos atualizados. Clique em Salvar para persistir.");
    } else {
      toastShow("info","Nenhum campo","Nenhum campo selecionado para aplicar.");
    }
    showEnrichPanel(false);
  }

  function onEnrichDiscard(){
    showEnrichPanel(false);
    state.enrich.last = null;
    state.enrich.selected = {};
  }



  // =============================
  // Wire events
  // =============================
  function wire(){
    var frm = byId("frmProduto");
    if(frm) frm.addEventListener("submit", function(e){ e.preventDefault(); });

    if(byId("btnNovo")) byId("btnNovo").addEventListener("click", function(e){ e.preventDefault(); enterNew(); });
    if(byId("btnRecarregar")) byId("btnRecarregar").addEventListener("click", function(e){ e.preventDefault(); init(); });

    if(byId("q")) byId("q").addEventListener("input", function(){ renderList(); });

    // Quick filters (data-qf)
    document.addEventListener("click", function(ev){
      var t = ev.target;
      if(!t) return;
      if(t && t.getAttribute && t.getAttribute("data-qf")){
        ev.preventDefault();
        state.qf = String(t.getAttribute("data-qf") || "ALL");
        // visual selected
        try{
          var btns = document.querySelectorAll("[data-qf]");
          for(var i=0;i<btns.length;i++) btns[i].classList.remove("primary");
          t.classList.add("primary");
        }catch(_e){}
        renderList();
      }
    });

    // Batch sync pendências
    if(byId("btnSyncPend")) byId("btnSyncPend").addEventListener("click", function(e){ e.preventDefault(); onSyncPendencias(); });

    if(byId("pCusto")) byId("pCusto").addEventListener("input", syncDerived);
    if(byId("pVenda")) byId("pVenda").addEventListener("input", syncDerived);

    if(byId("btnEditar")) byId("btnEditar").addEventListener("click", function(e){ e.preventDefault(); enterEdit(); });
    if(byId("btnSalvar")) byId("btnSalvar").addEventListener("click", function(e){ e.preventDefault(); onSalvarProduto(); });
    if(byId("btnCancelar")) byId("btnCancelar").addEventListener("click", function(e){ e.preventDefault(); onCancelarEdicao(); });
    if(byId("btnVoltar")) byId("btnVoltar").addEventListener("click", function(e){ e.preventDefault(); exitToList(); });
    if(byId("btnVoltarLista")) byId("btnVoltarLista").addEventListener("click", function(e){ e.preventDefault(); exitToList(); });
    if(byId("btnExcluir")) byId("btnExcluir").addEventListener("click", function(e){ e.preventDefault(); onExcluirProduto(); });

    if(byId("btnLoteSalvar")) byId("btnLoteSalvar").addEventListener("click", function(e){ e.preventDefault(); onLoteSave(); });
    if(byId("btnLoteCancelar")) byId("btnLoteCancelar").addEventListener("click", function(e){ e.preventDefault(); clearLoteForm(); });
    if(byId("btnLoteExcluir")) byId("btnLoteExcluir").addEventListener("click", function(e){ e.preventDefault(); onLoteDelete(); });

    // Enriquecimento Web
    if(byId("btnEnrichFetch")) byId("btnEnrichFetch").addEventListener("click", function(e){ e.preventDefault(); onEnrichFetch(); });
    if(byId("btnEnrichApply")) byId("btnEnrichApply").addEventListener("click", function(e){ e.preventDefault(); onEnrichApply(); });
    if(byId("btnEnrichDiscard")) byId("btnEnrichDiscard").addEventListener("click", function(e){ e.preventDefault(); onEnrichDiscard(); });

    window.addEventListener("online", setNetPill);
    window.addEventListener("offline", setNetPill);

    var tb = byId("tb");
    if(tb){
      tb.addEventListener("click", function(e){
        var t = e.target;
        if(!t) return;
        var hit = null;
        // aceita clique no botão "Ver" OU na linha inteira
        if(t.closest){
          hit = t.closest("button[data-act='view']");
          if(!hit) hit = t.closest("tr[data-act='view']");
        }
        if(!hit) return;
        var id = hit.getAttribute("data-id");
        if(!id) return;
        enterView(id);
      });
    }

    var tbL = byId("tbLotes");
    if(tbL){
      tbL.addEventListener("click", function(e){
        var t = e.target;
        if(!t) return;
        var btn = t.closest ? t.closest("button[data-act='lote-view']") : null;
        if(!btn) return;
        var id = btn.getAttribute("data-id");
        if(!id) return;
        // seleciona lote do cache atual
        var lotes = getLotesAtivos();
        for(var i=0;i<lotes.length;i++){
          var l = lotes[i];
          if(l && String(l.id) === String(id)){
            fillLoteForm(l);
            setLotesEnabled(state.mode === "EDIT"); // só habilita exclusão se estiver em EDIT
            try{ byId("lLote").focus(); }catch(_e){}
            break;
          }
        }
      });
    }

    // ESC: apenas navegação segura (não destrutivo)
    document.addEventListener("keydown", function(e){
      if(e.key === "Escape"){
        if(state.mode === "EDIT" || state.mode === "NEW"){
          e.preventDefault();
          onCancelarEdicao();
        }
      }
    });
  }

  // =============================
  // Self-test (sem console)
  // =============================
  async function selfTest(){
    var out = {
      ok: true,
      issues: [],
      hasVSC_DB: !!window.VSC_DB,
      hasStores: false,
      hasUI: false,
      when: nowISO()
    };

    try{
      out.hasUI = !!(byId("tb") && byId("q") && byId("detailEmpty") && byId("frmProduto"));
      // enriquecimento é opcional, mas se o botão existir, o módulo deve carregar

      if(!out.hasUI){ out.ok = false; out.issues.push("UI crítica ausente (IDs do HTML)."); }

      if(!window.VSC_DB || typeof VSC_DB.openDB !== "function"){
        out.ok = false; out.issues.push("VSC_DB ausente (modules/vsc_db.js).");
      } else {
        var st = await VSC_DB.selfTest();
        out.hasStores = !!(st && st.stores && st.stores.length);
        if(!out.hasStores){ out.ok = false; out.issues.push("Stores não carregadas."); }
        // exige produtos_master e produtos_lotes
        try{
          var stores = (st && st.stores) ? st.stores : [];
          if(stores.indexOf("produtos_master") < 0) { out.ok = false; out.issues.push("Store produtos_master ausente."); }
          if(stores.indexOf("produtos_lotes") < 0)  { out.ok = false; out.issues.push("Store produtos_lotes ausente (v24+)."); }
        }catch(_e){}
      }
    }catch(e){
      out.ok = false;
      out.issues.push(String(e && (e.message||e)));
    }
    return out;
  }
  window.VSC_PRODUTOS = { selfTest: selfTest };

  // =============================
  // Init
  // =============================
  async function init(){
    setDetailVisible(false);

    if(!assertVSCDB()) return;

    setMsg("Carregando produtos...", "ok");
    setNetPill();
    await refreshProdutos();

    // entrada em LISTA + EMPTY STATE (cap. XXI)
    showDetailEmpty();
    setLotesVisibility();
    setLotesEnabled(false);

    state.mode = "LIST";
    setBadge("", "");
    setMsg("Pronto. Use o filtro e clique em Ver, ou clique em Novo.", "ok");
  }

  function boot(){
    // Guard enterprise: este módulo só deve inicializar na página de Produtos.
    if(!byId('frmProduto') && !byId('detailEmpty')){
      console.log('[VSC_PRODUTOS] skip boot (not on produtos.html)');
      return;
    }
    try{
      var host = byId("topbarHost");
      var h = host ? (host.offsetHeight || 0) : 0;
      document.documentElement.style.setProperty("--vsc-topbar-h", (h ? (h + "px") : "70px"));
    }catch(_e){}
    wire();
    if(document.readyState === "loading"){
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  }

  boot();
})();
