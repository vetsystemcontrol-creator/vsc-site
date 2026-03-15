/* ============================================================
   VSC — Relatórios Financeiro (Premium / Determinístico)
   Fonte: IndexedDB vsc_db via window.VSC_DB
   Arquivo: C:\Vet System Control - Equine\modules\relatorios_financeiro.js
   ============================================================ */

(function(){
  'use strict';

  const MOD = {};
  let UI = {};

  const STATE = {
    stores: [],
    counts: {},

    store: '',
    items: [],
    view: [],

    campoValor: '',
    campoData: '',
    campoStatus: '',
    campoTipo: '',

    fields: [],
    lastGeneratedAt: 0,

    // heurística segura para tipo pagar/receber (apenas filtro, nunca decisão crítica)
    tipoMode: 'pagar' // pagar|receber
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
    throw new TypeError("[REL_FIN] ambiente sem CSPRNG para gerar UUID v4.");
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

  async function pickIssuer(){
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

    var tRel = "Relatório Financeiro (" + (STATE.store || "—") + ")";
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


  // -------------------------
  // Helpers UI
  // -------------------------
  function $(id){ return document.getElementById(id); }

  function setStatus(kind, txt){
    UI.statusDot.className = 'dot ' + (kind || '');
    UI.statusTxt.textContent = txt;
  }

  function showErr(msg){
    UI.boxErr.style.display = 'block';
    UI.boxErr.textContent = msg;
    UI.boxOk.style.display = 'none';
  }

  function showOk(msg){
    UI.boxOk.style.display = 'block';
    UI.boxOk.textContent = msg;
    UI.boxErr.style.display = 'none';
  }

  function clearMsg(){
    UI.boxErr.style.display = 'none';
    UI.boxOk.style.display = 'none';
    UI.boxErr.textContent = '';
    UI.boxOk.textContent = '';
  }

  function money(n){
    const x = Number(n);
    if(!isFinite(x)) return 'R$ 0,00';
    return x.toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
  }

  function norm(s){
    return (s===null||s===undefined) ? '' : String(s).toLowerCase().trim();
  }

  // -------------------------
  // DB
  // -------------------------
  async function openDb(){
    if(!window.VSC_DB || typeof window.VSC_DB.openDB !== 'function'){
      throw new Error('VSC_DB não carregado. (confira <script src="modules/vsc_db.js">)');
    }
    return await window.VSC_DB.openDB();
  }

  async function listStores(){
    const db = await openDb();
    return [...db.objectStoreNames].filter(n => n !== 'sync_queue');
  }

  function countStore(db, store){
    return new Promise((res, rej) => {
      try{
        const tx = db.transaction([store], 'readonly');
        const st = tx.objectStore(store);
        const rq = st.count();
        rq.onsuccess = () => res(rq.result || 0);
        rq.onerror = () => rej(rq.error);
      }catch(e){
        rej(e);
      }
    });
  }

  async function getCounts(stores){
    const db = await openDb();
    const out = {};
    for(const s of stores){
      out[s] = await countStore(db, s);
    }
    return out;
  }

  async function getAll(store){
    const db = await openDb();
    return new Promise((res, rej) => {
      const tx = db.transaction([store],'readonly');
      const st = tx.objectStore(store);
      const rq = st.getAll();
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror = () => rej(rq.error);
    });
  }

  // -------------------------
  // Auto-detect (sem inventar)
  // -------------------------
  function collectFields(items){
    const set = {};
    const lim = Math.min(items.length, 200);
    for(let i=0;i<lim;i++){
      const it = items[i];
      if(it && typeof it === 'object'){
        Object.keys(it).forEach(k => set[k]=true);
      }
    }
    return Object.keys(set).sort();
  }

  function detectFirstExisting(fields, candidates){
    for(const c of candidates){
      if(fields.includes(c)) return c;
    }
    return '';
  }

  function guessValorField(fields){
    return detectFirstExisting(fields, [
      'valor', 'valor_total', 'total', 'amount', 'valor_centavos', 'total_centavos'
    ]);
  }

  function guessDataField(fields, periodoBase){
    const pref = {
      vencimento: ['data_vencimento','vencimento','dt_vencimento'],
      emissao: ['data_emissao','emissao','dt_emissao','data'],
      pagamento: ['data_pagamento','pagamento','data_baixa','dt_pagamento','dt_baixa']
    }[periodoBase] || ['data_vencimento','data','created_at'];

    const common = ['created_at','updated_at','last_sync'];

    let hit = detectFirstExisting(fields, pref);
    if(hit) return hit;

    hit = detectFirstExisting(fields, common);
    if(hit) return hit;

    return '';
  }

  function guessStatusField(fields){
    return detectFirstExisting(fields, [
      'status','situacao','pago','quitado','baixado','liquidado'
    ]);
  }

  function guessTipoField(fields){
    // campo que pode existir em alguns ERPs: tipo (pagar/receber), natureza (D/C), movimento etc.
    return detectFirstExisting(fields, [
      'tipo','natureza','debito_credito','dc','mov_tipo'
    ]);
  }

  function storeLooksFinancial(name){
    const n = norm(name);
    const keys = ['conta','contas','pagar','receber','titulo','titulos','finance','financeiro','mov','movimento','lanc'];
    return keys.some(k => n.includes(k));
  }

  function pickBestStore(stores, counts){
    const fin = stores
      .filter(s => storeLooksFinancial(s))
      .sort((a,b) => (counts[b]||0) - (counts[a]||0));
    for(const s of fin){
      if((counts[s]||0) > 0) return s;
    }

    const any = stores.slice().sort((a,b) => (counts[b]||0) - (counts[a]||0));
    for(const s of any){
      if((counts[s]||0) > 0) return s;
    }

    return stores[0] || '';
  }

  // -------------------------
  // UI wiring
  // -------------------------
  function setManualEnabled(on){
    UI.selStore.disabled = !on;
    UI.selCampoValor.disabled = !on;
    UI.selCampoData.disabled = !on;
    UI.selCampoStatus.disabled = !on;
  }

  function fillSelect(sel, values, placeholder){
    sel.innerHTML = '';
    if(placeholder){
      const o0 = document.createElement('option');
      o0.value = '';
      o0.textContent = placeholder;
      sel.appendChild(o0);
    }
    values.forEach(v => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v;
      sel.appendChild(o);
    });
  }

  function fillStoresSelect(stores, counts){
    const ordered = stores.slice().sort((a,b)=>{
      const ca = counts[a]||0, cb = counts[b]||0;
      if(cb !== ca) return cb - ca;
      return a.localeCompare(b);
    });

    UI.selStore.innerHTML = '';
    ordered.forEach(s=>{
      const o = document.createElement('option');
      o.value = s;
      o.textContent = `${s} (${counts[s]||0})`;
      UI.selStore.appendChild(o);
    });

    return ordered;
  }

  // -------------------------
  // Parsing (tolerante, mas determinístico)
  // -------------------------
  function parseValor(v){
    if(v === null || v === undefined) return 0;
    if(typeof v === 'number') return v;

    const s = String(v).replace(/\./g,'').replace(',','.');
    const n = Number(s);
    return isFinite(n) ? n : 0;
  }

  function parseDateMs(v){
    if(v === null || v === undefined) return NaN;
    if(typeof v === 'number') return v;
    const ms = Date.parse(String(v).replace(/\//g,'-'));
    return isNaN(ms) ? NaN : ms;
  }

  function statusIsPaid(v){
    const s = norm(v);
    if(!s) return false;
    return (
      s.includes('pago') || s.includes('receb') || s.includes('quit') ||
      s.includes('baix') || s.includes('liquid')
    );
  }

  function tipoMatch(it){
    // Filtro seguro: só filtra se existir campoTipo e valor reconhecível.
    // Se não existir, NÃO filtra (fail-open controlado).
    if(!STATE.campoTipo) return true;

    const val = norm(it[STATE.campoTipo]);
    if(!val) return true;

    // pagar: debito / despesa / pagar
    if(STATE.tipoMode === 'pagar'){
      if(val.includes('pagar') || val.includes('deb') || val.includes('desp') || val === 'd') return true;
      if(val.includes('receb') || val.includes('cred') || val === 'c') return false;
      return true; // desconhecido => não filtra
    }

    // receber: credito / receita / receber
    if(val.includes('receb') || val.includes('cred') || val.includes('recei') || val === 'c') return true;
    if(val.includes('pagar') || val.includes('deb') || val.includes('desp') || val === 'd') return false;
    return true;
  }

  function applyFilters(items){
    const q = norm(UI.txtBusca.value);
    const dtIni = UI.dtIni.value ? Date.parse(UI.dtIni.value) : NaN;
    const dtFim = UI.dtFim.value ? Date.parse(UI.dtFim.value) : NaN;

    return items.filter(it=>{
      if(!tipoMatch(it)) return false;

      if(q){
        let blob = '';
        try{ blob = JSON.stringify(it); }catch(_){ blob = String(it); }
        if(!norm(blob).includes(q)) return false;
      }

      if(STATE.campoData){
        const ms = parseDateMs(it[STATE.campoData]);
        if(!isNaN(dtIni) && !isNaN(ms) && ms < dtIni) return false;
        if(!isNaN(dtFim) && !isNaN(ms) && ms > (dtFim + (24*60*60*1000)-1)) return false;
      }

      return true;
    });
  }

  // -------------------------
  // KPIs + Render
  // -------------------------
  function computeKpis(rows){
    let total=0, aberto=0, vencido=0, pago=0;
    const hoje = Date.now();

    rows.forEach(r=>{
      const v = parseValor(STATE.campoValor ? r[STATE.campoValor] : 0);
      total += v;

      const paid = STATE.campoStatus ? statusIsPaid(r[STATE.campoStatus]) : false;

      if(paid){
        pago += v;
      }else{
        aberto += v;
        if(STATE.campoData){
          const ms = parseDateMs(r[STATE.campoData]);
          if(!isNaN(ms) && ms < hoje) vencido += v;
        }
      }
    });

    UI.kpiTotal.textContent   = money(total);
    UI.kpiAberto.textContent  = money(aberto);
    UI.kpiVencido.textContent = money(vencido);
    UI.kpiPago.textContent    = money(pago);
  }

  function buildCols(){
    const pref = [
      STATE.campoTipo,
      STATE.campoStatus,
      STATE.campoData,
      STATE.campoValor,
      'descricao','historico','documento','numero','nota','nf',
      'fornecedor','cliente','nome','razao_social','cnpj','cpf',
      'id','uuid','created_at'
    ].filter(Boolean);

    const cols = [];
    const has = (k) => STATE.fields.includes(k);

    pref.forEach(k => { if(k && has(k) && !cols.includes(k)) cols.push(k); });

    if(cols.length < 10){
      for(const k of STATE.fields){
        if(!cols.includes(k)){
          cols.push(k);
          if(cols.length >= 10) break;
        }
      }
    }
    return cols;
  }

  function renderTable(rows){
    const cols = buildCols();

    UI.trHead.innerHTML = '';
    UI.tb.innerHTML = '';

    cols.forEach(c=>{
      const th = document.createElement('th');
      th.textContent = c;
      UI.trHead.appendChild(th);
    });

    for(const r of rows){
      const tr = document.createElement('tr');
      cols.forEach(c=>{
        const td = document.createElement('td');
        let v = r[c];
        if(typeof v === 'object' && v !== null){
          try{ v = JSON.stringify(v); }catch(_){ v = String(v); }
        }
        td.textContent = (v===null||v===undefined) ? '' : String(v);
        if(c==='id' || c==='uuid' || c.includes('created_') || c.includes('updated_')) td.className = 'mono';
        tr.appendChild(td);
      });
      UI.tb.appendChild(tr);
    }

    UI.emptyTxt.style.display = rows.length ? 'none' : 'block';
    UI.tbl.style.display = rows.length ? 'table' : 'none';
    UI.btnCSV.disabled = rows.length === 0;
    UI.btnPrint.disabled = rows.length === 0;
  }

  function toCSV(cols, rows){
    function esc(x){
      const s = (x===null||x===undefined) ? '' : String(x);
      return '"' + s.replace(/"/g,'""') + '"';
    }
    const out = [];
    out.push(cols.map(esc).join(','));
    for(const r of rows){
      out.push(cols.map(c=>{
        let v = r[c];
        if(typeof v === 'object' && v !== null){
          try{ v = JSON.stringify(v); }catch(_){ v = String(v); }
        }
        return esc(v);
      }).join(','));
    }
    return out.join('\r\n');
  }

  function downloadCSVCurrent(){
    clearMsg();
    if(!STATE.view || !STATE.view.length){
      showErr('Nada para exportar. Gere primeiro.');
      return;
    }
    const cols = buildCols();
    const csv = toCSV(cols, STATE.view);
    const blob = new Blob([csv], {type:'text/csv;charset=utf-8'});
    const a = document.createElement('a');
    const ts = new Date(STATE.lastGeneratedAt || Date.now()).toISOString().slice(0,19).replace(/[:T]/g,'-');
    a.href = URL.createObjectURL(blob);
    a.download = `relatorio-financeiro-${STATE.store || 'dados'}-${STATE.tipoMode}-${ts}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 400);
    showOk('CSV exportado (download iniciado).');
  }

  async function doPrint(){
    clearMsg();
    if(!STATE.view || !STATE.view.length){
      showErr('Nada para imprimir. Gere primeiro.');
      return;
    }
    await ensurePrintHeader();
    showOk('Abrindo impressão…');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.print();
  }

  function clearAll(){
    UI.dtIni.value = '';
    UI.dtFim.value = '';
    UI.txtBusca.value = '';
    UI.selCampoValor.value = '';
    UI.selCampoData.value = '';
    UI.selCampoStatus.value = '';
    UI.btnCSV.disabled = true;
    UI.btnPrint.disabled = true;
    UI.tbl.style.display = 'none';
    UI.emptyTxt.style.display = 'block';
    UI.metaTxt.textContent = '—';
    UI.kpiTotal.textContent = 'R$ 0,00';
    UI.kpiAberto.textContent = 'R$ 0,00';
    UI.kpiVencido.textContent = 'R$ 0,00';
    UI.kpiPago.textContent = 'R$ 0,00';
    clearMsg();
    setStatus('ok','pronto');
  }

  // -------------------------
  // Generate
  // -------------------------
  async function generate(){
    clearMsg();
    setStatus('warn','gerando…');

    try{
      const modo = UI.selModo.value; // auto | manual
      const periodoBase = UI.selPeriodoBase.value; // vencimento|emissao|pagamento
      STATE.tipoMode = UI.selTipo.value; // pagar|receber

      if(!STATE.stores.length){
        STATE.stores = await listStores();
        STATE.counts = await getCounts(STATE.stores);
      }
      if(!STATE.stores.length) throw new Error('Nenhuma store encontrada em vsc_db.');

      let storePick = '';
      if(modo === 'manual'){
        storePick = UI.selStore.value;
        if(!storePick) throw new Error('Modo MANUAL: selecione a store.');
      }else{
        storePick = pickBestStore(STATE.stores, STATE.counts);
      }

      STATE.store = storePick;
      UI.selStore.value = storePick;

      const items = await getAll(storePick);
      STATE.items = Array.isArray(items) ? items : [];
      STATE.fields = collectFields(STATE.items);

      if(!STATE.items.length){
        UI.metaTxt.textContent = `Store: ${storePick} • Registros: 0`;
        showErr(`A store "${storePick}" está vazia. Selecione outra (modo MANUAL) ou crie lançamentos financeiros no ERP.`);
        setStatus('ok','pronto');
        renderTable([]);
        return;
      }

      // preencher selects manuais com base nos fields encontrados
      fillSelect(UI.selCampoValor, STATE.fields, '(selecionar)');
      fillSelect(UI.selCampoData, STATE.fields, '(selecionar)');
      fillSelect(UI.selCampoStatus, STATE.fields, '(selecionar)');

      if(modo === 'manual'){
        STATE.campoValor  = UI.selCampoValor.value || '';
        STATE.campoData   = UI.selCampoData.value || '';
        STATE.campoStatus = UI.selCampoStatus.value || '';
        STATE.campoTipo   = guessTipoField(STATE.fields); // no manual, tipo é opcional e só filtra se existir

        if(!STATE.campoValor) throw new Error('Modo MANUAL: selecione o Campo Valor.');
      }else{
        STATE.campoValor  = guessValorField(STATE.fields);
        STATE.campoData   = guessDataField(STATE.fields, periodoBase);
        STATE.campoStatus = guessStatusField(STATE.fields);
        STATE.campoTipo   = guessTipoField(STATE.fields);

        UI.selCampoValor.value = STATE.campoValor || '';
        UI.selCampoData.value = STATE.campoData || '';
        UI.selCampoStatus.value = STATE.campoStatus || '';

        if(!STATE.campoValor){
          showErr('AUTO: não detectei Campo Valor. Troque para MANUAL e selecione o campo correto.');
          setStatus('ok','pronto');
          UI.metaTxt.textContent = `Store: ${storePick} • Registros: ${STATE.items.length}`;
          renderTable([]);
          return;
        }
      }

      const filtered = applyFilters(STATE.items);
      STATE.view = filtered;
      STATE.lastGeneratedAt = Date.now();

      computeKpis(filtered);
      renderTable(filtered);

      UI.metaTxt.textContent =
        `Tipo: ${STATE.tipoMode} • Store: ${storePick} (${STATE.counts[storePick]||STATE.items.length}) • ` +
        `Filtrados: ${filtered.length} • Valor: ${STATE.campoValor||'—'} • Data: ${STATE.campoData||'—'} • ` +
        `Status: ${STATE.campoStatus||'—'} • TipoCampo: ${STATE.campoTipo||'—'}`;

      showOk('Relatório gerado.');
      setStatus('ok','pronto');

      console.log('[VSC_FIN_REL] generate OK', {
        tipo: STATE.tipoMode,
        store: storePick,
        totalStore: STATE.items.length,
        filtered: filtered.length,
        campoValor: STATE.campoValor,
        campoData: STATE.campoData,
        campoStatus: STATE.campoStatus,
        campoTipo: STATE.campoTipo
      });

    }catch(e){
      showErr(String(e && e.message ? e.message : e));
      setStatus('danger','erro');
      (window.VSC_UI?window.VSC_UI.toast("err", String('[VSC_FIN_REL] generate FAIL', e), {ms:3200}):null);
}
  }

  async function bootstrap(){
    clearMsg();
    setStatus('warn','carregando…');

    try{
      STATE.stores = await listStores();
      STATE.counts = await getCounts(STATE.stores);

      const ordered = fillStoresSelect(STATE.stores, STATE.counts);
      const pick = pickBestStore(ordered, STATE.counts);

      UI.selStore.value = pick || '';
      STATE.store = pick || '';

      setStatus('ok','pronto');
      showOk(`Pronto. Sugestão de fonte: ${pick || '—'}. Clique em Gerar.`);

      console.log('[VSC_FIN_REL] init OK', { stores: ordered, counts: STATE.counts, pick });

    }catch(e){
      setStatus('danger','erro');
      showErr(String(e && e.message ? e.message : e));
      (window.VSC_UI?window.VSC_UI.toast("err", String('[VSC_FIN_REL] init FAIL', e), {ms:3200}):null);
}
  }

  // -------------------------
  // Executive summary


  async function loadExecutiveSnapshot(){
    try{
      if(!window.VSC_FINANCE_ANALYTICS || !window.VSC_DB || !window.VSC_DB.stores) return;
      var apStore = window.VSC_DB.stores.contas_pagar;
      var arStore = window.VSC_DB.stores.contas_receber;
      var ap = await getAll(apStore).catch(function(){ return []; });
      var ar = await getAll(arStore).catch(function(){ return []; });
      var ex = window.VSC_FINANCE_ANALYTICS.summarizeExecutive(ap, ar);
      if(UI.execProjectedNet) UI.execProjectedNet.textContent = window.VSC_FINANCE_ANALYTICS.fmtBRLFromCents(ex.projectedNet30);
      if(UI.execProjectedNetSub) UI.execProjectedNetSub.textContent = 'Entradas previstas: ' + window.VSC_FINANCE_ANALYTICS.fmtBRLFromCents(ex.projectedInflows30) + ' · Saídas previstas: ' + window.VSC_FINANCE_ANALYTICS.fmtBRLFromCents(ex.projectedOutflows30);
      window.VSC_FINANCE_ANALYTICS.drawBars(UI.execCashflowChart, ex.monthlyCashflow.map(function(r){ return {label:r.label, value:r.net}; }), {yLabel:'Fluxo'});
      window.VSC_FINANCE_ANALYTICS.drawDonut(UI.execOpenChart, [
        {label:'Receber aberto', value:ex.openReceivable},
        {label:'Pagar aberto', value:ex.openPayable}
      ]);
      window.VSC_FINANCE_ANALYTICS.renderList(UI.execTopClientes, ex.ar.topEntities);
      window.VSC_FINANCE_ANALYTICS.renderList(UI.execTopFornecedores, ex.ap.topEntities);
    }catch(e){ console.warn('[VSC_FIN_REL] executive snapshot fail', e); }
  }

  // -------------------------
  // SelfTest (console-first)
  // -------------------------
  MOD.selfTest = async function(){
    try{
      console.log('[VSC_FIN_REL] selfTest start');

      if(!window.VSC_DB || typeof window.VSC_DB.openDB !== 'function'){
        throw new Error('VSC_DB ausente');
      }
      console.log('OK: VSC_DB');

      const db = await openDb();
      if(!db || !db.objectStoreNames) throw new Error('DB open falhou');
      console.log('OK: openDB');

      const stores = await listStores();
      console.log('OK: stores', stores);

      if(!UI || !UI.btnGerar) throw new Error('UI não inicializada');
      console.log('OK: UI bind');

      console.log('[VSC_FIN_REL] selfTest OK');
      return true;
    }catch(e){
      (window.VSC_UI?window.VSC_UI.toast("err", String('[VSC_FIN_REL] selfTest FAIL', e), {ms:3200}):null);
return false;
    }
  };

  // -------------------------
  // Init
  // -------------------------
  function bind(){
    UI = {
      statusDot: $('statusDot'),
      statusTxt: $('statusTxt'),

      selModo: $('selModo'),
      selTipo: $('selTipo'),
      selPeriodoBase: $('selPeriodoBase'),

      dtIni: $('dtIni'),
      dtFim: $('dtFim'),
      txtBusca: $('txtBusca'),

      selStore: $('selStore'),
      selCampoValor: $('selCampoValor'),
      selCampoData: $('selCampoData'),
      selCampoStatus: $('selCampoStatus'),

      btnGerar: $('btnGerar'),
      btnCSV: $('btnCSV'),
      btnPrint: $('btnPrint'),
      btnLimpar: $('btnLimpar'),

      kpiTotal: $('kpiTotal'),
      kpiAberto: $('kpiAberto'),
      kpiVencido: $('kpiVencido'),
      kpiPago: $('kpiPago'),

      metaTxt: $('metaTxt'),
      emptyTxt: $('emptyTxt'),
      tbl: $('tbl'),
      trHead: $('trHead'),
      tb: $('tb'),

      boxErr: $('boxErr'),
      boxOk: $('boxOk'),

      execProjectedNet: $('execProjectedNet'),
      execProjectedNetSub: $('execProjectedNetSub'),
      execCashflowChart: $('execCashflowChart'),
      execOpenChart: $('execOpenChart'),
      execTopClientes: $('execTopClientes'),
      execTopFornecedores: $('execTopFornecedores')
    };

    function on(el, ev, fn){ if(el && typeof el.addEventListener==='function') el.addEventListener(ev, fn); }
    // Guard enterprise: este módulo só inicializa na sua página (evita crash em painéis/embeds).
    if(!UI.btnGerar || !UI.btnCSV || !UI.btnPrint || !UI.btnLimpar){
      console.log('[VSC_FIN_REL] skip bind (DOM ausente)');
      return false;
    }

    on(UI.btnGerar, 'click', generate);
    on(UI.btnCSV, 'click', downloadCSVCurrent);
    on(UI.btnPrint, 'click', doPrint);
    on(UI.btnLimpar, 'click', clearAll);

    UI.selModo.addEventListener('change', function(){
      const on = (UI.selModo.value === 'manual');
      setManualEnabled(on);
      clearMsg();
      showOk(on ? 'Modo MANUAL: selecione store/campos.' : 'Modo AUTO: detecção determinística.');
    });

    setManualEnabled(false);
  }

  function init(){
    // Skip se não estiver na página correta (evita erros em painéis de autoteste)
    const sentinel = document.getElementById('btnGerar');
    if(!sentinel){ console.log('[VSC_FIN_REL] skip init (not on relatorios_financeiro.html)'); return; }
    const bound = bind();
    if(bound===false) return;
    clearAll();
    setStatus('ok','pronto');
    bootstrap();
    loadExecutiveSnapshot();
    console.log('[VSC_FIN_REL] ready');
  }

  // Debug controlado
  MOD.__STATE = STATE;

  window.VSC_FIN_REL = MOD;

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  }else{
    init();
  }

})();
