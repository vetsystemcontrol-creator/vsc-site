/* ============================================================
   VSC — Relatórios (Enterprise / Determinístico / Offline-first)
   Fonte de dados: IndexedDB (vsc_db) via window.VSC_DB (canônico)
   Arquivo: C:\Vet System Control - Equine\modules\relatorios.js
   ============================================================ */

(function(){
  'use strict';

  // Anti-dupla execução (blindagem)
  if(window.VSC_REL_LOADED){ return; }
  window.VSC_REL_LOADED = true;

  var MOD = {};
  var UI = {};
  var STATE = {
    fonteKey: '',
    itemsAll: [],
    itemsView: [],
    fields: [],
    campoData: '',
    lastGeneratedAt: 0,
    stores: [],      // nomes (sem sync_queue)
    counts: {}       // {store: count}
  };


  // ============================================================
  // Print Header (Emitente/CRMV) — Enterprise
  // ============================================================
  function uuidv4(){
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
    throw new TypeError("[RELATORIOS] ambiente sem CSPRNG para gerar UUID v4.");
  }

  async function readEmpresa(){
    try{
      if(window.VSC_DB && typeof window.VSC_DB.getEmpresaSnapshot === "function"){
        return await window.VSC_DB.getEmpresaSnapshot({ preferIdb:true, hydrateLocalStorage:true });
      }
      var raw = localStorage.getItem("vsc_empresa_v1");
      if(!raw) return {};
      var obj = JSON.parse(raw);
      return obj && typeof obj === "object" ? obj : {};
    }catch(_){ return {}; }
  }

  function fmtEmpresa(o){
    if(!o) return { line1:"Vet System Control | Equine", line2:"" };
    var nome = (o.nome_fantasia || o.razao_social || "Empresa");
    var cnpj = o.cnpj ? ("CNPJ " + o.cnpj) : "";
    var loc  = ((o.cidade||"") && (o.uf||"")) ? (o.cidade + " - " + o.uf) : (o.cidade||o.uf||"");
    var tel  = o.telefone || o.celular || "";
    var email= o.email || "";
    var line2 = [cnpj, loc, tel, email].filter(Boolean).join(" • ");
    return { line1:nome, line2:line2 };
  }

  function resolveEmpresaNome(src){
    if(!src || typeof src !== 'object') return '';
    return String(src.nome || src.razao_social || src.nome_fantasia || src.fantasia || src.empresa_nome || '').trim();
  }

  function resolveEmpresaLogoA(src){
    if(!src || typeof src !== 'object') return '';
    return String(src.__logoA || src.logoA || src.logo_a || src.logoADataUrl || src.logo || '').trim();
  }

  function resolveEmpresaLogoB(src){
    if(!src || typeof src !== 'object') return '';
    return String(src.__logoB || src.logoB || src.logo_b || src.logoBDataUrl || '').trim();
  }

  function resolvePreferredCompanyPrintLogo(src){
    return resolveEmpresaLogoA(src) || resolveEmpresaLogoB(src) || '';
  }

  function ensureCanonicalPrintHeaderCss(){
    if(document.getElementById('vscCanonicalPrintHeaderCss')) return;
    if(!window.VSCPrintTemplate || typeof window.VSCPrintTemplate.getInstitutionalCss !== 'function') return;
    var style = document.createElement('style');
    style.id = 'vscCanonicalPrintHeaderCss';
    style.textContent = window.VSCPrintTemplate.getInstitutionalCss() + `
#vscPrintHeader .kado-hdr{margin-bottom:14px;}
#vscPrintHeader .vsc-print-issuer{display:grid;gap:4px;margin-top:10px;padding:10px 14px;border:1px solid #d8e1ec;border-radius:14px;background:#fff;}
#vscPrintHeader .vsc-print-issuer__title{font-size:11px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:#64748b;}
#vscPrintHeader .vsc-print-issuer__main{font-size:12px;font-weight:800;color:#0f172a;}
#vscPrintHeader .vsc-print-issuer__meta{font-size:11px;color:#64748b;font-weight:700;}
#vscPrintHeader .vsc-print-issuer__sig img{max-height:58px;border:1px solid rgba(15,23,42,.10);border-radius:10px;padding:6px;background:#fff;}`;
    document.head.appendChild(style);
  }

  async function waitPrintAssets(root){
    var scope = root || document;
    var imgs = Array.from(scope.querySelectorAll('img'));
    if(!imgs.length) return;
    await Promise.all(imgs.map(function(img){
      return new Promise(function(resolve){
        if(img.complete && img.naturalWidth > 0) return resolve(true);
        var done = false;
        var to = setTimeout(function(){ if(done) return; done = true; resolve(false); }, 12000);
        function ok(){ if(done) return; done = true; clearTimeout(to); resolve(true); }
        function bad(){ if(done) return; done = true; clearTimeout(to); resolve(false); }
        img.addEventListener('load', ok, { once:true });
        img.addEventListener('error', bad, { once:true });
        try{ if(typeof img.decode === 'function') img.decode().then(ok).catch(function(){}); }catch(_){ }
      });
    }));
  }

  function pickIssuerFromRows(){
    try{
      if(STATE.fonteKey === "atendimentos_master" && STATE.itemsView && STATE.itemsView.length){
        var snap = null;
        var uid = null;
        for(var i=0;i<STATE.itemsView.length;i++){
          var r = STATE.itemsView[i];
          if(!r) continue;
          var s = r.responsavel_snapshot || null;
          var rid = (s && s.user_id) ? s.user_id : (r.responsavel_user_id || null);
          if(!rid) return null; // determinístico: sem responsável => fallback no current user
          if(uid == null){ uid = rid; snap = s || null; }
          else if(uid !== rid){ return null; } // múltiplos responsáveis => fallback
        }
        return snap || null;
      }
    }catch(_){}
    return null;
  }

  async function pickIssuer(){
    // 1) snapshot do atendimento (preferência)
    var snap = pickIssuerFromRows();
    if(snap) return snap;

    // 2) usuário atual (fallback)
    try{
      if(window.VSC_AUTH && typeof VSC_AUTH.getCurrentUser === "function"){
        var cu = await VSC_AUTH.getCurrentUser();
        if(cu && cu.id){
          var p = cu.professional || {};
          var crmvTxt = (p.crmv_uf && p.crmv_num) ? ("CRMV-" + p.crmv_uf + " Nº " + p.crmv_num) : "";
          return {
            user_id: cu.id,
            username: cu.username || "",
            full_name: p.full_name || "",
            crmv_uf: p.crmv_uf || "",
            crmv_num: p.crmv_num || "",
            phone: p.phone || "",
            email: p.email || "",
            signature_image_dataurl: p.signature_image_dataurl || null,
            icp_enabled: !!p.icp_enabled,
            captured_at: new Date().toISOString(),
            display_line: ((p.full_name||cu.username||"") + (crmvTxt ? (" — " + crmvTxt) : ""))
          };
        }
      }
    }catch(_){}
    return null;
  }

  async function ensurePrintHeader(){
    var ph = document.getElementById("vscPrintHeader");
    if(!ph) return;

    ensureCanonicalPrintHeaderCss();

    var empresaRaw = await readEmpresa();
    var empresa = fmtEmpresa(empresaRaw);
    var issuer = await pickIssuer();

    var docId = uuidv4();
    var nowIso = new Date().toISOString();
    var nowBr = "";
    try{ nowBr = new Date(nowIso).toLocaleString("pt-BR"); }catch(_){ nowBr = nowIso; }

    var tRel = "Relatório (" + (STATE.fonteKey || "—") + ")";
    var meta = tRel + " • DOC " + docId;
    var companyLogo = resolvePreferredCompanyPrintLogo(empresaRaw);
    var issuerMain = "Emissor: —";
    var issuerMeta = "";
    var issuerSig = "";

    if(issuer){
      var crmv = (issuer.crmv_uf && issuer.crmv_num) ? ("CRMV-" + issuer.crmv_uf + " Nº " + issuer.crmv_num) : "";
      issuerMain = (issuer.full_name || issuer.username || "—") + (crmv ? (" — " + crmv) : "");
      issuerMeta = [issuer.phone ? ("Tel " + issuer.phone) : "", issuer.email ? ("Email " + issuer.email) : ""].filter(Boolean).join(" • ");
      if(issuer.signature_image_dataurl){
        issuerSig = `<div class="vsc-print-issuer__sig"><img alt="Assinatura" src="${String(issuer.signature_image_dataurl).replace(/"/g,'&quot;')}" /></div>`;
      }
    }

    if(window.VSCPrintTemplate && typeof window.VSCPrintTemplate.renderInstitutionalHeader === 'function'){
      ph.innerHTML = window.VSCPrintTemplate.renderInstitutionalHeader({
        systemLogoSrc: location.origin + '/assets/brand/vsc-logo-horizontal.png',
        systemLogoFallback: '<div class="kado-fallback-system">Vet System Control</div>',
        companyLogoHtml: companyLogo
          ? '<img class="kado-company-logo" src="' + String(companyLogo).replace(/"/g,'&quot;') + '" alt="Logo institucional da empresa"/>'
          : '<div class="kado-company-logo-fallback"></div>',
        companyName: empresa.line1 || '—',
        companyMetaHtml: empresa.line2 ? ('<div>' + empresa.line2 + '</div>') : '',
        documentTitle: tRel,
        documentMetaHtml: '<div><b>Documento:</b> ' + meta + '</div><div><b>Emitido em:</b> ' + nowBr + '</div>'
      }) + '<div class="vsc-print-issuer"><div class="vsc-print-issuer__title">Emissor responsável</div><div class="vsc-print-issuer__main">' + issuerMain + '</div>' + (issuerMeta ? '<div class="vsc-print-issuer__meta">' + issuerMeta + '</div>' : '') + issuerSig + '</div>';
    }

    await waitPrintAssets(ph);
  }


  function $(id){ return document.getElementById(id); }

  function setStatus(kind, txt){
    var dot = UI.statusDot;
    var st = UI.statusTxt;
    if(dot) dot.className = 'dot' + (kind ? (' ' + kind) : '');
    if(st) st.textContent = txt;
  }

  function showErr(msg){
    if(UI.boxErr){ UI.boxErr.style.display = 'block'; UI.boxErr.textContent = msg; }
    if(UI.boxOk){ UI.boxOk.style.display = 'none'; }
  }
  function showOk(msg){
    if(UI.boxOk){ UI.boxOk.style.display = 'block'; UI.boxOk.textContent = msg; }
    if(UI.boxErr){ UI.boxErr.style.display = 'none'; }
  }
  function clearMsg(){
    if(UI.boxErr){ UI.boxErr.style.display = 'none'; UI.boxErr.textContent = ''; }
    if(UI.boxOk){ UI.boxOk.style.display = 'none'; UI.boxOk.textContent = ''; }
  }

  // ============================================================
  // DB helpers (CANÔNICO): IndexedDB via window.VSC_DB
  // ============================================================

  function mustHaveVscDb(){
    if(!window.VSC_DB || typeof window.VSC_DB.openDB !== 'function'){
      throw new Error('VSC_DB indisponível. Confirme que vsc_db.js está carregado no ERP.');
    }
  }

  async function openDb(){
    mustHaveVscDb();
    return await window.VSC_DB.openDB();
  }

  async function idbListStores(){
    var db = await openDb();
    var names = [];
    for(var i=0;i<db.objectStoreNames.length;i++){
      names.push(db.objectStoreNames[i]);
    }
    names = names.filter(function(n){ return n !== 'sync_queue'; });
    names.sort();
    STATE.stores = names.slice(0);
    return names;
  }

  function idbCount(db, storeName){
    return new Promise(function(resolve, reject){
      try{
        var tx = db.transaction([storeName], 'readonly');
        var st = tx.objectStore(storeName);
        var rq = st.count();
        rq.onsuccess = function(){ resolve(rq.result || 0); };
        rq.onerror = function(){ reject(rq.error || new Error('Falha count em ' + storeName)); };
      }catch(e){
        reject(e);
      }
    });
  }

  async function idbGetCounts(names){
    var db = await openDb();
    var out = {};
    for(var i=0;i<names.length;i++){
      var n = names[i];
      out[n] = await idbCount(db, n);
    }
    STATE.counts = out;
    return out;
  }

  function idbGetAll(storeName){
    mustHaveVscDb();
    return new Promise(async function(resolve, reject){
      try{
        var db = await openDb();
        var tx = db.transaction([storeName], 'readonly');
        var st = tx.objectStore(storeName);
        var req = st.getAll();
        req.onsuccess = function(){ resolve(req.result || []); };
        req.onerror = function(){ reject(req.error || new Error('Falha getAll em ' + storeName)); };
      }catch(e){
        reject(e);
      }
    });
  }

  // ============================================================
  // Utilitários
  // ============================================================

  function guessDateField(items){
    if(!items || !items.length) return '';
    var sample = items.slice(0, Math.min(50, items.length));
    var keys = {};
    sample.forEach(function(it){
      if(it && typeof it === 'object'){
        Object.keys(it).forEach(function(k){ keys[k]=true; });
      }
    });
    var keyList = Object.keys(keys);

    function looksDate(v){
      if(v === null || v === undefined) return false;
      if(typeof v === 'number'){
        return v > 946684800000 || (v > 946684800 && v < 4102444800);
      }
      if(typeof v === 'string'){
        if(/^\d{4}-\d{2}-\d{2}/.test(v)) return true;
        if(/^\d{4}\/\d{2}\/\d{2}/.test(v)) return true;
      }
      return false;
    }

    var preferred = ['data','dt','data_emissao','data_pagamento','data_vencimento','created_at','updated_at','last_sync'];
    for(var p=0;p<preferred.length;p++){
      var pk = preferred[p];
      if(keyList.indexOf(pk) >= 0){
        for(var i=0;i<sample.length;i++){
          if(sample[i] && looksDate(sample[i][pk])) return pk;
        }
      }
    }

    for(var k=0;k<keyList.length;k++){
      var kk = keyList[k];
      for(var j=0;j<sample.length;j++){
        var it2 = sample[j];
        if(it2 && looksDate(it2[kk])) return kk;
      }
    }
    return '';
  }

  function toDateMs(v){
    if(v === null || v === undefined) return NaN;
    if(typeof v === 'number'){
      if(v < 4102444800) return v * 1000;
      return v;
    }
    if(typeof v === 'string'){
      var s = v.replace(/\//g,'-');
      var ms = Date.parse(s);
      if(!isNaN(ms)) return ms;
    }
    return NaN;
  }

  function clampStr(v, max){
    var s = (v===null||v===undefined) ? '' : String(v);
    if(s.length <= max) return s;
    return s.slice(0, max-1) + '…';
  }

  function collectFields(items){
    var set = {};
    var limit = Math.min(200, items.length);
    for(var i=0;i<limit;i++){
      var it = items[i];
      if(it && typeof it === 'object'){
        Object.keys(it).forEach(function(k){ set[k]=true; });
      }
    }
    var arr = Object.keys(set);
    arr.sort();
    return arr;
  }

  function normalizeText(v){
    if(v===null||v===undefined) return '';
    return String(v).toLowerCase().trim();
  }

  function humanStoreLabel(name){
    var map = {
      auth_audit_log: 'Auditoria de login/acesso',
      business_audit_log: 'Auditoria de alterações',
      ux_audit_log: 'Auditoria de usabilidade/sync/erros'
    };
    return map[name] || name;
  }

  function applyAuditPreset(kind){
    var presets = {
      login: { store: 'auth_audit_log', search: '' },
      alteracoes: { store: 'business_audit_log', search: '' },
      usabilidade: { store: 'ux_audit_log', search: '' },
      sync: { store: 'ux_audit_log', search: 'sync_' },
      erros: { store: 'ux_audit_log', search: 'error' }
    };
    var p = presets[kind];
    if(!p) return;
    if(UI.fonte){ UI.fonte.value = p.store; STATE.fonteKey = p.store; }
    if(UI.busca){ UI.busca.value = p.search || ''; }
    clearMsg();
    setStatus('ok','pronto');
    showOk('Preset de auditoria aplicado. Clique em Gerar.');
  }

  function buildRowObj(it, fields){
    var o = {};
    for(var i=0;i<fields.length;i++){
      var k = fields[i];
      o[k] = (it && typeof it === 'object') ? it[k] : '';
    }
    return o;
  }
  // ============================================================
  // UI: fonte + tabela + export
  // ============================================================

  function fillFonteSelect(stores, counts){
    var sel = UI.fonte;
    sel.innerHTML = "";

    // Ordena por: 1) maior count  2) nome
    var ordered = stores.slice(0).sort(function(a,b){
      var ca = counts[a] || 0;
      var cb = counts[b] || 0;
      if(cb !== ca) return cb - ca;
      return String(a).localeCompare(String(b));
    });

    for(var i=0;i<ordered.length;i++){
      var s = ordered[i];
      var opt = document.createElement("option");
      opt.value = s;
      opt.textContent = humanStoreLabel(s) + " — " + s + " (" + (counts[s] || 0) + ")";
      sel.appendChild(opt);
    }

    // escolha determinística: 1ª store não vazia; senão 1ª
    var pick = "";
    for(var j=0;j<ordered.length;j++){
      if((counts[ordered[j]] || 0) > 0){ pick = ordered[j]; break; }
    }
    if(!pick && ordered.length) pick = ordered[0];

    if(pick){
      sel.value = pick;
      STATE.fonteKey = pick;
    }
  }

  function renderTable(items){
    var tbody = UI.tableBody;
    tbody.innerHTML = "";

    if(!items || !items.length){
      var tr0 = document.createElement("tr");
      tr0.innerHTML = '<td colspan="5" style="opacity:.65;text-align:center;padding:18px;">Nenhum registro para os filtros atuais.</td>';
      tbody.appendChild(tr0);
      return;
    }

    // Campos fixos enterprise (sem inventar): tenta usar campoData + alguns comuns
    var dateKey = STATE.campoData || "";
    var common = ["id","uuid","documento","nf","numero","cliente","fornecedor","nome","razao_social","valor","total","obs","observacao","created_at"];
    var cols = [];
    function hasField(k){ return STATE.fields.indexOf(k) >= 0; }

    if(dateKey && hasField(dateKey)) cols.push(dateKey);

    for(var i=0;i<common.length;i++){
      var k = common[i];
      if(hasField(k) && cols.indexOf(k) < 0) cols.push(k);
      if(cols.length >= 5) break;
    }

    // fallback: se ainda pouco, pega primeiros campos detectados
    for(var j=0; cols.length < 5 && j<STATE.fields.length; j++){
      var kk = STATE.fields[j];
      if(cols.indexOf(kk) < 0) cols.push(kk);
    }

    // Cabeçalho
    UI.th1.textContent = cols[0] || "campo1";
    UI.th2.textContent = cols[1] || "campo2";
    UI.th3.textContent = cols[2] || "campo3";
    UI.th4.textContent = cols[3] || "campo4";
    UI.th5.textContent = cols[4] || "campo5";

    // Linhas
    for(var r=0;r<items.length;r++){
      var it = items[r];
      var row = buildRowObj(it, cols);

      var tr = document.createElement("tr");

      var td1 = document.createElement("td");
      td1.textContent = clampStr(row[cols[0]], 80);

      var td2 = document.createElement("td");
      td2.textContent = clampStr(row[cols[1]], 80);

      var td3 = document.createElement("td");
      td3.textContent = clampStr(row[cols[2]], 80);

      var td4 = document.createElement("td");
      td4.textContent = clampStr(row[cols[3]], 80);

      var td5 = document.createElement("td");
      td5.textContent = clampStr(row[cols[4]], 80);

      tr.appendChild(td1);
      tr.appendChild(td2);
      tr.appendChild(td3);
      tr.appendChild(td4);
      tr.appendChild(td5);

      tbody.appendChild(tr);
    }
  }

  function applyFilters(list){
    var q = normalizeText(UI.busca.value);
    var dtIni = UI.dtIni.value ? Date.parse(UI.dtIni.value) : NaN;
    var dtFim = UI.dtFim.value ? Date.parse(UI.dtFim.value) : NaN;

    var out = [];
    for(var i=0;i<list.length;i++){
      var it = list[i];

      if(q){
        var blob = "";
        try{ blob = JSON.stringify(it); }catch(_){ blob = String(it); }
        if(normalizeText(blob).indexOf(q) < 0) continue;
      }

      if(STATE.campoData){
        var ms = toDateMs(it[STATE.campoData]);
        if(!isNaN(dtIni) && !isNaN(ms) && ms < dtIni) continue;
        if(!isNaN(dtFim) && !isNaN(ms) && ms > (dtFim + (24*60*60*1000) - 1)) continue;
      }

      out.push(it);
    }
    return out;
  }

  function downloadCSV(rows){
    if(!rows || !rows.length){
      showErr("Nada para exportar.");
      return;
    }

    // CSV com colunas detectadas (primeiras 12)
    var cols = STATE.fields.slice(0, Math.min(12, STATE.fields.length));

    function esc(x){
      var s = (x===null||x===undefined) ? "" : String(x);
      return '"' + s.replace(/"/g,'""') + '"';
    }

    var lines = [];
    lines.push(cols.map(esc).join(","));

    for(var i=0;i<rows.length;i++){
      var it = rows[i] || {};
      var line = [];
      for(var c=0;c<cols.length;c++){
        var k = cols[c];
        var v = it[k];
        if(typeof v === "object" && v !== null){
          try{ v = JSON.stringify(v); }catch(_){ v = String(v); }
        }
        line.push(esc(v));
      }
      lines.push(line.join(","));
    }

    var csv = lines.join("\r\n");
    var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });

    var a = document.createElement("a");
    var ts = new Date(Date.now()).toISOString().slice(0,19).replace(/[:T]/g,'-');
    a.href = URL.createObjectURL(blob);
    a.download = "relatorio-" + (STATE.fonteKey || "dados") + "-" + ts + ".csv";

    document.body.appendChild(a);
    a.click();
    setTimeout(function(){
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 400);

    showOk("CSV exportado (download iniciado).");
  }

  // ============================================================
  // Fluxo principal
  // ============================================================

  async function refreshFonte(){
    clearMsg();
    setStatus("warn","carregando…");
    try{
      var stores = await idbListStores();
      if(!stores.length) throw new Error("Nenhuma store encontrada em vsc_db.");

      var counts = await idbGetCounts(stores);
      fillFonteSelect(stores, counts);

      setStatus("ok","pronto");
      showOk("Fonte carregada. Clique em Gerar.");
    }catch(e){
      setStatus("danger","erro");
      showErr(String(e && e.message ? e.message : e));
    }
  }

  async function generate(){
    clearMsg();
    setStatus("warn","gerando…");
    try{
      var fonte = UI.fonte.value;
      if(!fonte) throw new Error("Selecione uma fonte (store).");

      STATE.fonteKey = fonte;

      var all = await idbGetAll(fonte);
      if(!Array.isArray(all)) all = [];

      // [FIX C-10] Excluir registros marcados como deletados — evita distorção nos relatórios
      all = all.filter(function(r){ return !r.deleted_at && !r.deleted && r.status !== "EXCLUIDO"; });

      STATE.itemsAll = all;
      STATE.fields = collectFields(all);
      STATE.campoData = guessDateField(all);

      var view = applyFilters(all);
      STATE.itemsView = view;
      STATE.lastGeneratedAt = Date.now();

      UI.meta.textContent =
        "Store: " + fonte + " (" + (STATE.counts[fonte] || all.length) + ") · " +
        "Filtrados: " + view.length + " · " +
        "CampoData: " + (STATE.campoData || "—");

      renderTable(view);

      setStatus("ok","pronto");
      showOk("Relatório gerado.");
    }catch(e){
      setStatus("danger","erro");
      showErr(String(e && e.message ? e.message : e));
    }
  }

  function clearAll(){
    UI.dtIni.value = "";
    UI.dtFim.value = "";
    UI.busca.value = "";
    UI.meta.textContent = "—";
    clearMsg();
    renderTable([]);
    setStatus("ok","pronto");
  }

  // ============================================================
  // SelfTest (console-first)
  // ============================================================
  MOD.selfTest = async function(){
    try{
      if(!window.VSC_DB || typeof window.VSC_DB.openDB !== "function") throw new Error("VSC_DB ausente");
      var db = await openDb();
      if(!db || !db.objectStoreNames) throw new Error("openDB falhou");

      var stores = await idbListStores();
      if(!stores || !stores.length) throw new Error("Sem stores");
      if(!UI || !UI.btnGerar) throw new Error("UI não inicializada");

      return true;
    }catch(_){
      return false;
    }
  };

  window.VSC_REL = MOD;
  function bind(){
    UI = {
      statusDot: $("statusDot"),
      statusTxt: $("statusTxt"),

      fonte: $("selFonte"),
      dtIni: $("dtIni"),
      dtFim: $("dtFim"),
      busca: $("txtBusca"),

      btnGerar: $("btnGerar"),
      btnCSV: $("btnCSV"),
      btnPrint: $("btnPrint"),
      btnLimpar: $("btnLimpar"),

      meta: $("metaTxt"),

      th1: $("th1"),
      th2: $("th2"),
      th3: $("th3"),
      th4: $("th4"),
      th5: $("th5"),

      tableBody: $("tb"),

      boxErr: $("boxErr"),
      boxOk: $("boxOk")
    };

    if(!UI.statusDot || !UI.btnGerar || !UI.fonte){
      throw new Error("HTML incompatível: IDs obrigatórios não encontrados (statusDot/btnGerar/selFonte).");
    }

    // Ações (nada em silêncio)
    UI.btnGerar.addEventListener("click", function(){ generate(); });

    UI.btnCSV.addEventListener("click", function(){
      downloadCSV(STATE.itemsView || []);
      console.log("[VSC_REL] CSV", { store: STATE.fonteKey, rows: (STATE.itemsView||[]).length });
    });

    UI.btnPrint.addEventListener("click", async function(){
      clearMsg();
      if(!STATE.itemsView || !STATE.itemsView.length){
        showErr("Nada para imprimir. Gere o relatório primeiro.");
        return;
      }
      await ensurePrintHeader();
      showOk("Abrindo impressão…");
      console.log("[VSC_REL] print", { store: STATE.fonteKey, rows: STATE.itemsView.length });
      await new Promise(function(resolve){ requestAnimationFrame(function(){ requestAnimationFrame(resolve); }); });
      window.print();
    });

    UI.btnLimpar.addEventListener("click", function(){
      clearAll();
      console.log("[VSC_REL] cleared");
    });

    // Busca incremental (premium)
    UI.busca.addEventListener("input", function(){
      if(!STATE.itemsAll || !STATE.itemsAll.length){
        renderTable([]);
        return;
      }
      var view = applyFilters(STATE.itemsAll);
      STATE.itemsView = view;

      UI.meta.textContent =
        "Store: " + (STATE.fonteKey || "—") + " · " +
        "Filtrados: " + view.length + " · " +
        "CampoData: " + (STATE.campoData || "—");

      renderTable(view);
    });

    // Mudança de fonte não gera relatório automaticamente (controle premium)
    UI.fonte.addEventListener("change", function(){
      STATE.fonteKey = UI.fonte.value || "";
      clearMsg();
      setStatus("ok","pronto");
      showOk("Fonte alterada. Clique em Gerar.");
      console.log("[VSC_REL] fonte changed", { store: STATE.fonteKey });
    });
  }

  async function init(){
    // Guard enterprise: só inicializa na página de relatórios (evita crash se incluído em painéis/autoteste)
    if(!document.getElementById('statusDot') || !document.getElementById('btnGerar')){
      console.log('[VSC_REL] skip init (not on relatorios.html)');
      return;
    }
    try{
      bind();
      clearAll();
      setStatus("warn","carregando…");

      var stores = await idbListStores();
      if(!stores.length){
        setStatus("danger","erro");
        showErr("Nenhuma store encontrada em vsc_db.");
        return;
      }

      var counts = await idbGetCounts(stores);
      STATE.counts = counts;

      fillFonteSelect(stores, counts);

      // Não auto-gerar: só prepara (controle do usuário)
      setStatus("ok","pronto");
      showOk("Pronto. Selecione a fonte e clique em Gerar.");

      console.log("[VSC_REL] init OK", {
        stores: STATE.stores,
        counts: STATE.counts,
        pick: STATE.fonteKey
      });

    }catch(e){
      setStatus("danger","erro");
      showErr(String(e && e.message ? e.message : e));
      (window.VSC_UI?window.VSC_UI.toast("err", String("[VSC_REL] init FAIL", e), {ms:3200}):null);
}
  }

  // Bootstrap
  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", init);
  }else{
    init();
  }

})();
/* ============================================================
   PATCH 4/4 — Compatibilidade HTML real + Error-Zero override
   HTML usa: trHead, tb, tbl, emptyTxt, metaTxt (não th1..th5)
   Fonte: relatorios.html
   ============================================================ */

// Override seguro: rebind + rerender compatível com relatorios.html
bind = function(){
  UI = {
    statusDot: $("statusDot"),
    statusTxt: $("statusTxt"),

    fonte: $("selFonte"),
    dtIni: $("dtIni"),
    dtFim: $("dtFim"),
    busca: $("txtBusca"),

    btnGerar: $("btnGerar"),
    btnCSV: $("btnCSV"),
    btnPrint: $("btnPrint"),
    btnLimpar: $("btnLimpar"),

    meta: $("metaTxt"),

    // IDs reais do HTML
    trHead: $("trHead"),
    tb: $("tb"),
    tbl: $("tbl"),
    emptyTxt: $("emptyTxt"),
    tblWrap: $("tblWrap"),

    boxErr: $("boxErr"),
    boxOk: $("boxOk"),

    // KPIs (IDs reais)
    kpiLinhas: $("kpiLinhas"),
    kpiTotal: $("kpiTotal"),
    kpiCampos: $("kpiCampos"),

    btnAuditLogin: $("btnAuditLogin"),
    btnAuditAlteracoes: $("btnAuditAlteracoes"),
    btnAuditUsabilidade: $("btnAuditUsabilidade"),
    btnAuditSync: $("btnAuditSync"),
    btnAuditErros: $("btnAuditErros")
  };

  // Fail-closed: sem IDs mínimos, aborta claramente
  if(!UI.statusDot || !UI.statusTxt || !UI.fonte || !UI.btnGerar || !UI.trHead || !UI.tb || !UI.tbl || !UI.emptyTxt){
    throw new Error("HTML incompatível: faltam IDs obrigatórios (statusDot/statusTxt/selFonte/btnGerar/trHead/tb/tbl/emptyTxt).");
  }

  UI.btnGerar.addEventListener("click", function(){ generate(); });

  UI.btnCSV.addEventListener("click", function(){
    downloadCSV(STATE.itemsView || []);
    console.log("[VSC_REL] CSV", { store: STATE.fonteKey, rows: (STATE.itemsView||[]).length });
  });

  UI.btnPrint.addEventListener("click", function(){
    clearMsg();
    if(!STATE.itemsView || !STATE.itemsView.length){
      showErr("Nada para imprimir. Gere o relatório primeiro.");
      return;
    }
    showOk("Abrindo impressão…");
    console.log("[VSC_REL] print", { store: STATE.fonteKey, rows: STATE.itemsView.length });
    ensurePrintHeader().then(function(){
      return new Promise(function(resolve){ requestAnimationFrame(function(){ requestAnimationFrame(resolve); }); });
    }).then(function(){ window.print(); });
  });

  UI.btnLimpar.addEventListener("click", function(){
    clearAll();
    console.log("[VSC_REL] cleared");
  });

  if(UI.btnAuditLogin) UI.btnAuditLogin.addEventListener('click', function(){ applyAuditPreset('login'); });
  if(UI.btnAuditAlteracoes) UI.btnAuditAlteracoes.addEventListener('click', function(){ applyAuditPreset('alteracoes'); });
  if(UI.btnAuditUsabilidade) UI.btnAuditUsabilidade.addEventListener('click', function(){ applyAuditPreset('usabilidade'); });
  if(UI.btnAuditSync) UI.btnAuditSync.addEventListener('click', function(){ applyAuditPreset('sync'); });
  if(UI.btnAuditErros) UI.btnAuditErros.addEventListener('click', function(){ applyAuditPreset('erros'); });

  // Busca incremental (premium)
  UI.busca.addEventListener("input", function(){
    if(!STATE.itemsAll || !STATE.itemsAll.length){
      renderTable([]);
      return;
    }
    var view = applyFilters(STATE.itemsAll);
    STATE.itemsView = view;

    UI.meta.textContent =
      "Fonte: " + (STATE.fonteKey || "—") + " • " +
      "Filtrados: " + view.length + " • " +
      "CampoData: " + (STATE.campoData || "—");

    if(UI.kpiLinhas) UI.kpiLinhas.textContent = String(view.length);
    renderTable(view);
  });

  // Mudança de fonte não gera automaticamente
  UI.fonte.addEventListener("change", function(){
    STATE.fonteKey = UI.fonte.value || "";
    clearMsg();
    setStatus("ok","pronto");
    showOk("Fonte alterada. Clique em Gerar.");
    console.log("[VSC_REL] fonte changed", { store: STATE.fonteKey });
  });
};

// Override seguro do renderTable para o HTML real (trHead + tb)
renderTable = function(items){
  UI.trHead.innerHTML = "";
  UI.tb.innerHTML = "";

  if(!items || !items.length){
    UI.tbl.style.display = "none";
    UI.emptyTxt.style.display = "block";
    return;
  }

  // colunas determinísticas: usa campos detectados; limita para UX enterprise
  var cols = STATE.fields.slice(0, Math.min(12, STATE.fields.length));
  if(!cols.length){
    // fallback mínimo
    cols = ["id"];
  }

  // header
  for(var i=0;i<cols.length;i++){
    var th = document.createElement("th");
    th.textContent = cols[i];
    UI.trHead.appendChild(th);
  }

  // rows
  for(var r=0;r<items.length;r++){
    var it = items[r] || {};
    var tr = document.createElement("tr");

    for(var c=0;c<cols.length;c++){
      var k = cols[c];
      var td = document.createElement("td");

      var v = it[k];
      if(typeof v === "object" && v !== null){
        try{ v = JSON.stringify(v); }catch(_){ v = String(v); }
      }
      td.textContent = clampStr(v, 220);

      if(k === "id" || k.indexOf("uuid")>=0 || k.indexOf("created_at")>=0 || k.indexOf("updated_at")>=0){
        td.className = "mono";
      }

      tr.appendChild(td);
    }

    UI.tb.appendChild(tr);
  }

  UI.emptyTxt.style.display = "none";
  UI.tbl.style.display = "table";
};

// Ajuste: limpar deve resetar tabela conforme HTML
clearAll = function(){
  UI.dtIni.value = "";
  UI.dtFim.value = "";
  UI.busca.value = "";
  UI.meta.textContent = "—";
  clearMsg();
  UI.trHead.innerHTML = "";
  UI.tb.innerHTML = "";
  UI.tbl.style.display = "none";
  UI.emptyTxt.style.display = "block";
  if(UI.kpiLinhas) UI.kpiLinhas.textContent = "0";
  if(UI.kpiTotal) UI.kpiTotal.textContent = "0";
  if(UI.kpiCampos) UI.kpiCampos.textContent = "0";
  setStatus("ok","pronto");
};

// Ajuste: generate deve atualizar KPIs do HTML
generate = async function(){
  clearMsg();
  setStatus("warn","gerando…");
  try{
    var fonte = UI.fonte.value;
    if(!fonte) throw new Error("Selecione uma fonte (store).");
    STATE.fonteKey = fonte;

    var all = await idbGetAll(fonte);
    if(!Array.isArray(all)) all = [];
    // [FIX C-10] Excluir registros marcados como deletados
    all = all.filter(function(r){ return !r.deleted_at && !r.deleted && r.status !== "EXCLUIDO"; });
    STATE.itemsAll = all;

    STATE.fields = collectFields(all);
    STATE.campoData = guessDateField(all);

    var view = applyFilters(all);
    STATE.itemsView = view;
    STATE.lastGeneratedAt = Date.now();

    if(UI.kpiTotal) UI.kpiTotal.textContent = String(all.length);
    if(UI.kpiCampos) UI.kpiCampos.textContent = String(STATE.fields.length);
    if(UI.kpiLinhas) UI.kpiLinhas.textContent = String(view.length);

    UI.meta.textContent =
      "Fonte: " + fonte + " • Total: " + all.length + " • Filtrados: " + view.length +
      " • CampoData: " + (STATE.campoData || "—");

    renderTable(view);

    setStatus("ok","pronto");
    showOk("Relatório gerado.");
    console.log("[VSC_REL] generate OK", {
      store: fonte,
      total: all.length,
      filtrados: view.length,
      campoData: STATE.campoData,
      campos: STATE.fields.length
    });

  }catch(e){
    setStatus("danger","erro");
    showErr(String(e && e.message ? e.message : e));
    (window.VSC_UI?window.VSC_UI.toast("err", String("[VSC_REL] generate FAIL", e), {ms:3200}):null);
}
};

// SelfTest mais explícito (console-first)
(window.VSC_REL = window.VSC_REL || {}).selfTest = async function(){
  try{
    console.log("[VSC_REL] selfTest start");
    mustHaveVscDb();
    var db = await openDb();
    if(!db || !db.objectStoreNames) throw new Error("openDB falhou");

    if(!UI || !UI.btnGerar || !UI.fonte || !UI.trHead) throw new Error("UI bind falhou");
    var stores = await idbListStores();
    console.log("[VSC_REL] selfTest OK", { stores: stores.length });
    return true;
  }catch(e){
    (window.VSC_UI?window.VSC_UI.toast("err", String("[VSC_REL] selfTest FAIL", e), {ms:3200}):null);
return false;
  }
};