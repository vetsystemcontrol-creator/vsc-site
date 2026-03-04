/* =========================================================================
   VSC — FORNECEDORES (módulo externo obrigatório)
   Arquivo: C:\Vet System Control - Equine\modules\fornecedores.js

   Objetivo (Canônico ERP 2.0.1):
   - Console zero
   - UUID v4 + timestamps
   - Soft delete (deleted_at)
   - Offline-first (IDB + Outbox) quando store existir
   - Compatibilidade: se store ainda não existir, usa legado (localStorage) sem quebrar
   - API pública estável: window.VSC.fornecedores.{list,getById,getByCnpj,search,getOrCreateFromExternal}
   ========================================================================= */

(function(){
  "use strict";

  // ---------------------------------------------------------------------
  // Bootstrap global
  // ---------------------------------------------------------------------
  window.VSC = window.VSC || {};
  var VSC = window.VSC;

  // ---------------------------------------------------------------------
  // Helpers (determinísticos / sem console)
  // ---------------------------------------------------------------------
  function $(id){ return document.getElementById(id); }

  function nowIso(){ return new Date().toISOString(); }

  function uuidv4(){
    try{ if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID(); }catch(_){}
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c){
      var r = Math.random()*16|0;
      var v = (c === "x") ? r : (r&0x3|0x8);
      return v.toString(16);
    });
  }

  function onlyDigits(s){ return String(s || "").replace(/\D+/g, ""); }

  function normLower(s){ return String(s || "").trim().toLowerCase(); }

  function escapeHtml(s){
    return String(s ?? "")
      .replaceAll("&","&amp;")
      .replaceAll("<","&lt;")
      .replaceAll(">","&gt;")
      .replaceAll('"',"&quot;")
      .replaceAll("'","&#39;");
  }

  function formatCnpj(d){
    var x = onlyDigits(d).slice(0,14);
    var p1 = x.slice(0,2), p2 = x.slice(2,5), p3 = x.slice(5,8), p4 = x.slice(8,12), p5 = x.slice(12,14);
    var out = x;
    if (x.length >= 3){
      out = (p1 + "." + p2 + (x.length>5?".":"") + p3 + (x.length>8?"/":"") + p4 + (x.length>12?"-":"") + p5)
        .replace(/[\.\-\/]+$/,"");
    }
    return out;
  }

  function formatTelefoneBr(s){
    var d = onlyDigits(s).slice(0,11);
    if (!d) return "";
    if (d.length <= 10){
      var a = d.slice(0,2), n1 = d.slice(2,6), n2 = d.slice(6,10);
      var out = d;
      if (d.length >= 3) out = "(" + a + ") " + n1 + (d.length>6?"-":"") + n2;
      return out.replace(/[\-\s]+$/,"");
    }
    var a2 = d.slice(0,2), m1 = d.slice(2,7), m2 = d.slice(7,11);
    return "(" + a2 + ") " + m1 + "-" + m2;
  }

  // ---------------------------------------------------------------------
  // Validação CNPJ (dígitos)
  // ---------------------------------------------------------------------
  function isValidCnpjDigits(d){
    var c = onlyDigits(d);
    if (c.length !== 14) return false;
    if (/^(\d)\1{13}$/.test(c)) return false;

    function calc(base, pesos){
      var sum = 0;
      for (var i=0;i<pesos.length;i++){
        sum += Number(base[i]) * pesos[i];
      }
      var r = sum % 11;
      return (r < 2) ? 0 : (11 - r);
    }

    var p1 = [5,4,3,2,9,8,7,6,5,4,3,2];
    var p2 = [6,5,4,3,2,9,8,7,6,5,4,3,2];

    var b12 = c.slice(0,12);
    var d1 = calc(b12, p1);
    var d2 = calc(b12 + String(d1), p2);

    return c === (b12 + String(d1) + String(d2));
  }

  // ---------------------------------------------------------------------
  // UI helpers (sem console)
  // ---------------------------------------------------------------------
  function setPill(state, kind){
    var el = $("vscFornecedorStatePill");
    if (!el) return;
    el.classList.remove("ok","err");
    if (kind === "ok") el.classList.add("ok");
    if (kind === "err") el.classList.add("err");
    el.textContent = state;
  }

  function showMsg(id, msg){
    var el = $(id);
    if (!el) return;
    el.textContent = msg || "";
  }

  function showErr(id, msg){
    var el = $(id);
    if (!el) return;
    if (!msg){
      el.style.display = "none";
      el.textContent = "";
      return;
    }
    el.style.display = "block";
    el.textContent = msg;
  }

  // ---------------------------------------------------------------------
  // Estado + Cache (fonte única em memória)
  // ---------------------------------------------------------------------
  var State = {
    mode: "Idle",        // Idle | Creating | Editing | Validating | Saving | Error | Success
    editingId: null,
    ready: false
  };

  var Cache = {
    list: [],          // fornecedores (ativos e inativos; excluídos ficam com deleted_at)
    byId: new Map(),   // id -> obj
    byCnpj: new Map()  // cnpj_digits -> obj
  };

  function rebuildIndex(){
    Cache.byId = new Map();
    Cache.byCnpj = new Map();
    for (var i=0;i<Cache.list.length;i++){
      var x = Cache.list[i];
      if (!x || !x.id) continue;
      Cache.byId.set(x.id, x);
      var d = onlyDigits(x.cnpj_digits || x.cnpj || "");
      if (d) Cache.byCnpj.set(d, x);
    }
  }

  function setMode(mode, kind){
    State.mode = mode;
    setPill(mode, kind || null);
  }

  // ---------------------------------------------------------------------
  // Storage Adapter (IDB canônico se disponível; senão legado localStorage)
  // ---------------------------------------------------------------------
  var LS_KEY = "vsc_fornecedores_v1"; // legado
  var STORE_NAME = "fornecedores_master"; // canônico (quando existir no vsc_db)

  function safeJsonParse(s){
    try{ return JSON.parse(s); }catch(_e){ return null; }
  }

  function legacyLoadAll(){
    var arr = safeJsonParse(localStorage.getItem(LS_KEY) || "[]");
    return Array.isArray(arr) ? arr : [];
  }

  function legacySaveAll(arr){
    localStorage.setItem(LS_KEY, JSON.stringify(Array.isArray(arr) ? arr : []));
  }

  async function idbStoreExists(){
    try{
      if (!window.VSC_DB || typeof window.VSC_DB.openDB !== "function") return false;
      var db = await window.VSC_DB.openDB();
      var ok = db && db.objectStoreNames && db.objectStoreNames.contains(STORE_NAME);
      try{ db.close(); }catch(_){}
      return !!ok;
    }catch(_e){
      return false;
    }
  }

  async function idbGetAll(){
    var db = await window.VSC_DB.openDB();
    return new Promise(function(resolve, reject){
      try{
        var tx = db.transaction([STORE_NAME], "readonly");
        var st = tx.objectStore(STORE_NAME);
        var req = st.getAll();
        req.onsuccess = function(){
          try{ db.close(); }catch(_){}
          resolve(req.result || []);
        };
        req.onerror = function(){
          try{ db.close(); }catch(_){}
          reject(req.error);
        };
      }catch(err){
        try{ db.close(); }catch(_){}
        reject(err);
      }
    });
  }

  async function idbPutWithOutbox(obj, action){
    // action: "create" | "update" | "delete"
    // OBS: VSC_DB.upsertWithOutbox(storeName, obj, entity, entity_id, payload)
    var entity = "fornecedores";
    var entity_id = String(obj && obj.id ? obj.id : "");
    if (!entity_id) throw new Error("entity_id obrigatório");
    var payload = { action: action || "upsert", fornecedor: obj };

    await window.VSC_DB.upsertWithOutbox(STORE_NAME, obj, entity, entity_id, payload);
    return true;
  }

  async function storageLoadAll(){
    // se IDB não existe ainda, usa legado
    var ok = await idbStoreExists();
    if (!ok) return legacyLoadAll();
    return await idbGetAll();
  }

  async function storageUpsert(obj, action){
    var ok = await idbStoreExists();
    if (!ok){
      // legado: persiste a lista inteira
      var all = legacyLoadAll();
      var idx = all.findIndex(function(z){ return z && z.id === obj.id; });
      if (idx >= 0) all[idx] = obj;
      else all.push(obj);
      legacySaveAll(all);
      return true;
    }
    await idbPutWithOutbox(obj, action || "upsert");
    return true;
  }

  async function storageSoftDelete(id){
    var x = findById(id);
    if (!x) return false;
    var now = nowIso();
    var y = Object.assign({}, x, { deleted_at: now, updated_at: now });
    await storageUpsert(y, "delete");
    return true;
  }

  async function storageMigrateLegacyToIdbIfPossible(){
    // Migra legado -> IDB uma vez (sem console)
    var ok = await idbStoreExists();
    if (!ok) return false;

    var legacy = legacyLoadAll();
    if (!legacy || legacy.length === 0) return true;

    // Se IDB já tem dados, não duplica (fail-closed)
    var existing = await idbGetAll();
    if (Array.isArray(existing) && existing.length > 0) return true;

    // Migra gravando um a um com outbox (upsert)
    for (var i=0;i<legacy.length;i++){
      var x = legacy[i];
      if (!x || !x.id) continue;
      // normaliza soft delete
      if (!("deleted_at" in x)) x.deleted_at = null;
      await idbPutWithOutbox(x, "migrate");
    }
    return true;
  }
  // ---------------------------------------------------------------------
  // Modelo canônico do fornecedor (normalização)
  // ---------------------------------------------------------------------
  function canonicalizeFornecedor(input){
    var now = nowIso();
    var cnpjDigits = onlyDigits(input && (input.cnpj_digits || input.cnpj || ""));
    var telDigits = onlyDigits(input && (input.telefone_digits || input.telefone || "")).slice(0,11);

    var out = {
      id: String(input && input.id ? input.id : uuidv4()),
      razao: String(input && (input.razao || input.razao_social || input.nome || "")).trim(),
      fantasia: String(input && (input.fantasia || input.nome_fantasia || "")).trim(),
      cnpj_digits: cnpjDigits,
      cnpj: formatCnpj(cnpjDigits),
      ie: String(input && (input.ie || input.inscricao_estadual || "")).trim(),
      telefone_digits: telDigits,
      telefone: formatTelefoneBr(telDigits),
      email: String(input && (input.email || "")).trim(),
      cep_digits: onlyDigits(input && (input.cep_digits || input.cep || "")).slice(0,8),
      cep: String(input && (input.cep || "")).trim(),
      endereco: String(input && (input.endereco || input.logradouro || "")).trim(),
      numero: String(input && (input.numero || "")).trim(),
      bairro: String(input && (input.bairro || "")).trim(),
      cidade: String(input && (input.cidade || "")).trim(),
      uf: String(input && (input.uf || "")).trim().toUpperCase().slice(0,2),
      obs: String(input && (input.obs || input.observacoes || "")).trim(),
      created_at: String(input && input.created_at ? input.created_at : now),
      updated_at: now,
      deleted_at: (input && ("deleted_at" in input)) ? input.deleted_at : null
    };

    return out;
  }

  function findById(id){
    if (!id) return null;
    return Cache.byId.get(String(id)) || null;
  }

  function findByCnpjDigits(d){
    var x = onlyDigits(d);
    if (!x) return null;
    return Cache.byCnpj.get(x) || null;
  }

  function listActive(){
    return Cache.list.filter(function(x){ return x && !x.deleted_at; });
  }

  function listAll(){
    return Cache.list.slice();
  }

  // ---------------------------------------------------------------------
  // Render (lista) — idempotente / sem console
  // ---------------------------------------------------------------------
  function renderList(){
    var host = $("tblFornecedoresBody") || $("tblBody") || $("fornBody") || $("tbFornecedores");
    if (!host) return;

    var arr = listActive();

    // KPI Strip
    var all = Cache.list ? Cache.list.filter(function(x){ return !x.deleted_at; }) : arr;
    var ativos = all.filter(function(x){ return x.status === "ativo" || !x.status; }).length;
    var inativos = all.filter(function(x){ return x.status === "inativo"; }).length;
    var comEmail = all.filter(function(x){ return !!(x.email && x.email.trim()); }).length;
    var kTotal = $("kpiFornTotal"); if(kTotal) kTotal.textContent = all.length;
    var kAtivos = $("kpiFornAtivos"); if(kAtivos) kAtivos.textContent = ativos;
    var kInativos = $("kpiFornInativos"); if(kInativos) kInativos.textContent = inativos;
    var kEmail = $("kpiFornEmail"); if(kEmail) kEmail.textContent = comEmail;

    var pillCount = $("pillCount"); if(pillCount) pillCount.textContent = arr.length + " registros";

    host.innerHTML = "";
    for (var i=0;i<arr.length;i++){
      var f = arr[i];
      var tr = document.createElement("tr");
      tr.setAttribute("data-id", f.id);
      tr.style.cursor = "pointer";

      var nome = escapeHtml(f.razao || f.fantasia || "—");
      var fantasia = f.fantasia && f.fantasia !== f.razao ? '<div style="font-size:11px;color:var(--muted);">' + escapeHtml(f.fantasia) + '</div>' : '';
      var cnpj = escapeHtml(f.cnpj || (f.cnpj_digits ? formatCnpj(f.cnpj_digits) : "—"));
      var tel  = escapeHtml(f.telefone || "—");
      var statusCor = (f.status === "inativo") ? 'color:#b91c1c;' : 'color:#065f46;';
      var statusLabel = (f.status === "inativo") ? 'Inativo' : 'Ativo';

      tr.innerHTML =
        '<td><div style="font-weight:700;">' + nome + '</div>' + fantasia + '</td>' +
        '<td style="font-size:12px;font-family:monospace;">' + cnpj + '</td>' +
        '<td>' + tel + '</td>' +
        '<td><span style="' + statusCor + 'font-weight:800;font-size:12px;">' + statusLabel + '</span></td>' +
        '<td style="text-align:right;">' +
          '<button type="button" class="btn" data-act="edit" style="padding:6px 10px;font-size:12px;">Editar</button> ' +
          '<button type="button" class="btn btn-danger" data-act="del" style="padding:6px 10px;font-size:12px;">Excluir</button>' +
        '</td>';

      host.appendChild(tr);
    }

    if (arr.length === 0) {
      var tr0 = document.createElement("tr");
      tr0.innerHTML = '<td colspan="5" style="color:var(--muted);padding:20px;text-align:center;">Nenhum fornecedor cadastrado.</td>';
      host.appendChild(tr0);
    }

    showMsg("fornCount", String(arr.length));
  }

  // ---------------------------------------------------------------------
  // Form helpers (map IDs existentes, sem quebrar layout)
  // ---------------------------------------------------------------------
  function getField(idCandidates){
    for (var i=0;i<idCandidates.length;i++){
      var el = $(idCandidates[i]);
      if (el) return el;
    }
    return null;
  }

  // Mapeia possíveis IDs (seu HTML pode variar)
  var FIELDS = {
    razao:   ["razao","razao_social","nome","fornRazao","fornecedorRazao"],
    fantasia:["fantasia","nome_fantasia","fornFantasia"],
    cnpj:    ["cnpj","fornCnpj","cnpjFornecedor"],
    ie:      ["ie","inscricao_estadual","fornIE"],
    telefone:["telefone","fone","fornTelefone"],
    email:   ["email","fornEmail"],
    cep:     ["cep","fornCep"],
    endereco:["endereco","logradouro","fornEndereco"],
    numero:  ["numero","fornNumero"],
    bairro:  ["bairro","fornBairro"],
    cidade:  ["cidade","fornCidade"],
    uf:      ["uf","fornUF"],
    obs:     ["obs","observacoes","fornObs"]
  };

  function readForm(){
    var out = {};
    var el;

    el = getField(FIELDS.razao);    out.razao = el ? el.value : "";
    el = getField(FIELDS.fantasia); out.fantasia = el ? el.value : "";
    el = getField(FIELDS.cnpj);     out.cnpj = el ? el.value : "";
    el = getField(FIELDS.ie);       out.ie = el ? el.value : "";
    el = getField(FIELDS.telefone); out.telefone = el ? el.value : "";
    el = getField(FIELDS.email);    out.email = el ? el.value : "";
    el = getField(FIELDS.cep);      out.cep = el ? el.value : "";
    el = getField(FIELDS.endereco); out.endereco = el ? el.value : "";
    el = getField(FIELDS.numero);   out.numero = el ? el.value : "";
    el = getField(FIELDS.bairro);   out.bairro = el ? el.value : "";
    el = getField(FIELDS.cidade);   out.cidade = el ? el.value : "";
    el = getField(FIELDS.uf);       out.uf = el ? el.value : "";
    el = getField(FIELDS.obs);      out.obs = el ? el.value : "";

    return out;
  }

  function writeForm(f){
    var el;
    el = getField(FIELDS.razao);    if (el) el.value = f ? (f.razao||"") : "";
    el = getField(FIELDS.fantasia); if (el) el.value = f ? (f.fantasia||"") : "";
    el = getField(FIELDS.cnpj);     if (el) el.value = f ? (f.cnpj||f.cnpj_digits||"") : "";
    el = getField(FIELDS.ie);       if (el) el.value = f ? (f.ie||"") : "";
    el = getField(FIELDS.telefone); if (el) el.value = f ? (f.telefone||f.telefone_digits||"") : "";
    el = getField(FIELDS.email);    if (el) el.value = f ? (f.email||"") : "";
    el = getField(FIELDS.cep);      if (el) el.value = f ? (f.cep||f.cep_digits||"") : "";
    el = getField(FIELDS.endereco); if (el) el.value = f ? (f.endereco||"") : "";
    el = getField(FIELDS.numero);   if (el) el.value = f ? (f.numero||"") : "";
    el = getField(FIELDS.bairro);   if (el) el.value = f ? (f.bairro||"") : "";
    el = getField(FIELDS.cidade);   if (el) el.value = f ? (f.cidade||"") : "";
    el = getField(FIELDS.uf);       if (el) el.value = f ? (f.uf||"") : "";
    el = getField(FIELDS.obs);      if (el) el.value = f ? (f.obs||"") : "";
  }

  function clearForm(){
    writeForm(null);
    State.editingId = null;
  }

  // ---------------------------------------------------------------------
  // Validação (bloqueante, sem console)
  // ---------------------------------------------------------------------
  function validateFornecedorDraft(draft, editingId){
    var err = [];

    var razao = String(draft && draft.razao ? draft.razao : "").trim();
    if (!razao) err.push("Razão social é obrigatória.");

    var cnpjDigits = onlyDigits(draft && draft.cnpj ? draft.cnpj : "");
    if (!cnpjDigits) err.push("CNPJ é obrigatório.");
    else if (cnpjDigits.length !== 14) err.push("CNPJ deve ter 14 dígitos.");
    else if (!isValidCnpjDigits(cnpjDigits)) err.push("CNPJ inválido.");

    // Unicidade de CNPJ (entre ativos)
    if (cnpjDigits){
      var existing = findByCnpjDigits(cnpjDigits);
      if (existing && !existing.deleted_at && String(existing.id) !== String(editingId||"")){
        err.push("Já existe fornecedor ativo com este CNPJ.");
      }
    }

    return err;
  }

  // ---------------------------------------------------------------------
  // UI: abrir/fechar modal (compatível se existir openModal global)
  // ---------------------------------------------------------------------
  function openModalSafe(){
    var id = "modalFornecedor";
    if (typeof window.openModal === "function") { window.openModal(id); return; }
    var el = $(id);
    if (!el) return;
    el.classList.add("open");
    el.setAttribute("aria-hidden","false");
  }

  function closeModalSafe(){
    var id = "modalFornecedor";
    if (typeof window.closeModal === "function") { window.closeModal(id); return; }
    var el = $(id);
    if (!el) return;
    el.classList.remove("open");
    el.setAttribute("aria-hidden","true");
  }

  // ---------------------------------------------------------------------
  // UI: Handlers principais
  // ---------------------------------------------------------------------
  async function handleNew(){
    showErr("fornErr", "");
    clearForm();
    setMode("Creating");
    openModalSafe();
  }

  async function handleEdit(id){
    showErr("fornErr", "");
    var f = findById(id);
    if (!f) return;
    State.editingId = f.id;
    writeForm(f);
    setMode("Editing");
    openModalSafe();
  }

  async function handleDelete(id){
    showErr("fornErr", "");
    if (!id) return;
    setMode("Saving");
    await storageSoftDelete(id);
    // recarrega cache
    Cache.list = await storageLoadAll();
    rebuildIndex();
    renderList();
    setMode("Success","ok");
    try{ window.dispatchEvent(new Event("vsc:fornecedor:changed")); }catch(_){}
  }

  async function handleSave(){
    showErr("fornErr", "");
    setMode("Validating");

    var draft = readForm();
    var errs = validateFornecedorDraft(draft, State.editingId);
    if (errs.length){
      showErr("fornErr", errs.join(" "));
      setMode("Error","err");
      return;
    }

    setMode("Saving");

    var base = State.editingId ? (findById(State.editingId) || {}) : {};
    var obj = canonicalizeFornecedor(Object.assign({}, base, draft, { id: State.editingId || base.id || uuidv4() }));

    await storageUpsert(obj, State.editingId ? "update" : "create");

    // recarrega cache
    Cache.list = await storageLoadAll();
    rebuildIndex();
    renderList();

    closeModalSafe();
    setMode("Success","ok");

    try{ window.dispatchEvent(new Event("vsc:fornecedor:changed")); }catch(_){}
  }
  // ---------------------------------------------------------------------
  // Busca / Pesquisa (lista em memória)
  // ---------------------------------------------------------------------
  function search(q){
    var s = normLower(q);
    if (!s) return listActive();

    var out = [];
    var arr = listActive();
    for (var i=0;i<arr.length;i++){
      var f = arr[i];
      var a = normLower(f.razao);
      var b = normLower(f.fantasia);
      var c = onlyDigits(f.cnpj_digits || f.cnpj || "");
      if (a.includes(s) || b.includes(s) || c.includes(onlyDigits(s))) out.push(f);
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // API pública estável (para outros módulos: contas a pagar, xml, etc.)
  // ---------------------------------------------------------------------
  VSC.fornecedores = VSC.fornecedores || {};

  VSC.fornecedores.list = function(opts){
    opts = opts || {};
    if (opts && opts.all) return listAll();
    return listActive();
  };

  VSC.fornecedores.getById = function(id){
    return findById(id);
  };

  VSC.fornecedores.getByCnpj = function(cnpj){
    return findByCnpjDigits(cnpj);
  };

  VSC.fornecedores.search = function(q){
    return search(q);
  };

  // Autocadastro atômico (regra do seu contrato: por CNPJ)
  // Entrada típica vinda de XML: { razao, fantasia, cnpj, ... }
  VSC.fornecedores.getOrCreateFromExternal = async function(payload){
    payload = payload || {};
    var cnpjDigits = onlyDigits(payload.cnpj_digits || payload.cnpj || "");
    if (!cnpjDigits || cnpjDigits.length !== 14) return null;

    // 1) cache
    var existing = findByCnpjDigits(cnpjDigits);
    if (existing && !existing.deleted_at) return existing;

    // 2) carrega do storage (garante que cache está atualizado)
    Cache.list = await storageLoadAll();
    rebuildIndex();
    existing = findByCnpjDigits(cnpjDigits);
    if (existing && !existing.deleted_at) return existing;

    // 3) cria canônico
    var now = nowIso();
    var obj = canonicalizeFornecedor({
      id: uuidv4(),
      razao: payload.razao || payload.razao_social || payload.nome || "",
      fantasia: payload.fantasia || payload.nome_fantasia || "",
      cnpj_digits: cnpjDigits,
      cnpj: formatCnpj(cnpjDigits),
      ie: payload.ie || payload.inscricao_estadual || "",
      telefone: payload.telefone || "",
      email: payload.email || "",
      cep: payload.cep || "",
      endereco: payload.endereco || payload.logradouro || "",
      numero: payload.numero || "",
      bairro: payload.bairro || "",
      cidade: payload.cidade || "",
      uf: payload.uf || "",
      obs: payload.obs || "",
      created_at: now,
      updated_at: now,
      deleted_at: null
    });

    // 4) persiste (IDB+Outbox se possível; legado se não)
    await storageUpsert(obj, "create");

    // 5) atualiza cache e dispara evento
    Cache.list = await storageLoadAll();
    rebuildIndex();
    renderList();
    try{ window.dispatchEvent(new Event("vsc:fornecedor:changed")); }catch(_){}

    return findById(obj.id);
  };

  // ---------------------------------------------------------------------
  // Integração UI: busca incremental (se existir campo)
  // ---------------------------------------------------------------------
  function hookSearchUi(){
    var inp = $("fornSearch") || $("buscaFornecedor") || $("searchFornecedor");
    if (!inp) return;

    if (inp.__vscBound) return;
    inp.__vscBound = true;

    inp.addEventListener("input", function(){
      var q = inp.value || "";
      var host = $("tblFornecedoresBody") || $("tblBody") || $("fornBody") || $("tbFornecedores");
      if (!host) return;

      var arr = search(q);

      host.innerHTML = "";
      for (var i=0;i<arr.length;i++){
        var f = arr[i];
        var tr = document.createElement("tr");
        tr.setAttribute("data-id", f.id);

        var nome = escapeHtml(f.razao || f.fantasia || "—");
        var cnpj = escapeHtml(f.cnpj || (f.cnpj_digits ? formatCnpj(f.cnpj_digits) : "—"));
        var tel  = escapeHtml(f.telefone || "");
        var email= escapeHtml(f.email || "");

        tr.innerHTML =
          '<td>' + nome + '</td>' +
          '<td>' + cnpj + '</td>' +
          '<td>' + tel + '</td>' +
          '<td>' + email + '</td>' +
          '<td style="text-align:right;">' +
            '<button type="button" class="btn btn-sm btn-outline-primary" data-act="edit">Editar</button> ' +
            '<button type="button" class="btn btn-sm btn-outline-danger" data-act="del">Excluir</button>' +
          '</td>';

        host.appendChild(tr);
      }

      showMsg("fornCount", String(arr.length));
    });
  }

  // ---------------------------------------------------------------------
  // Boot (carrega storage, migra se possível, monta índices e render)
  // ---------------------------------------------------------------------
  async function boot(){
    try{
      setMode("Idle");
      // migra legado -> idb se store existir (sem duplicar)
      await storageMigrateLegacyToIdbIfPossible();

      Cache.list = await storageLoadAll();
      // normaliza objetos legados (garante campos canônicos)
      var normalized = [];
      for (var i=0;i<Cache.list.length;i++){
        var x = Cache.list[i];
        if (!x) continue;
        // se vier no formato antigo, canonicaliza preservando id e timestamps
        if (!x.id || !("updated_at" in x) || !("deleted_at" in x) || !("cnpj_digits" in x)){
          x = canonicalizeFornecedor(x);
        }
        normalized.push(x);
      }
      Cache.list = normalized;

      rebuildIndex();
      renderList();
      hookSearchUi();

      State.ready = true;
      setMode("Success","ok");
    }catch(_e){
      State.ready = false;
      setMode("Error","err");
      showErr("fornErr", "Falha ao carregar fornecedores.");
    }
  }

  // ---------------------------------------------------------------------
  // Delegação de ações (Editar/Excluir) + botões do modal
  // ---------------------------------------------------------------------
  function hookUi(){
    // Botão Novo
    var btnNovo = $("btnNovoFornecedor") || $("btnNovo") || $("novoFornecedor");
    if (btnNovo && !btnNovo.__vscBound){
      btnNovo.__vscBound = true;
      btnNovo.addEventListener("click", function(){ handleNew(); });
    }

    // Delegação tabela
    document.addEventListener("click", function(ev){
      var btn = ev && ev.target ? ev.target.closest("button[data-act]") : null;
      if (!btn) return;
      var tr = btn.closest("tr");
      if (!tr) return;
      var id = tr.getAttribute("data-id");
      var act = btn.getAttribute("data-act");
      if (act === "edit") handleEdit(id);
      if (act === "del") handleDelete(id);
    }, true);

    // Botões modal
    var btnSalvar = $("btnSalvarFornecedor") || $("btnSalvar") || $("salvarFornecedor");
    if (btnSalvar && !btnSalvar.__vscBound){
      btnSalvar.__vscBound = true;
      btnSalvar.addEventListener("click", function(){ handleSave(); });
    }

    var btnCancelar = $("btnCancelarFornecedor") || $("btnCancelar") || $("cancelarFornecedor");
    if (btnCancelar && !btnCancelar.__vscBound){
      btnCancelar.__vscBound = true;
      btnCancelar.addEventListener("click", function(){
        showErr("fornErr","");
        closeModalSafe();
        setMode("Idle");
      });
    }
  }

  if (document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", function(){
      hookUi();
      boot();
    }, { once:true });
  } else {
    hookUi();
    boot();
  }
  // ---------------------------------------------------------------------
  // Máscaras e normalização (determinístico, sem “surpresa”)
  // ---------------------------------------------------------------------
  function hookMasks(){
    var elCnpj = getField(FIELDS.cnpj);
    if (elCnpj && !elCnpj.__vscBound){
      elCnpj.__vscBound = true;
      elCnpj.addEventListener("input", function(){
        var d = onlyDigits(elCnpj.value).slice(0,14);
        elCnpj.value = formatCnpj(d);
      });
    }

    var elTel = getField(FIELDS.telefone);
    if (elTel && !elTel.__vscBound){
      elTel.__vscBound = true;
      elTel.addEventListener("input", function(){
        var d = onlyDigits(elTel.value).slice(0,11);
        elTel.value = formatTelefoneBr(d);
      });
    }

    var elUf = getField(FIELDS.uf);
    if (elUf && !elUf.__vscBound){
      elUf.__vscBound = true;
      elUf.addEventListener("input", function(){
        elUf.value = String(elUf.value || "").toUpperCase().slice(0,2);
      });
    }
  }

  // ---------------------------------------------------------------------
  // Enter-nav compatível (não quebra) — apenas garante foco inicial
  // ---------------------------------------------------------------------
  function focusFirstRequired(){
    var el = getField(FIELDS.razao) || getField(FIELDS.cnpj);
    try{ if (el) el.focus(); }catch(_){}
  }

  // Quando abrir modal, foca no primeiro campo
  var _oldOpen = openModalSafe;
  openModalSafe = function(){
    _oldOpen();
    setTimeout(function(){ focusFirstRequired(); hookMasks(); }, 0);
  };

  // ---------------------------------------------------------------------
  // Export hooks (CSV simples) — opcional se botão existir
  // ---------------------------------------------------------------------
  function toCsvRow(cols){
    return cols.map(function(x){
      var s = String(x ?? "");
      if (s.includes('"')) s = s.replaceAll('"','""');
      if (/[,"\n]/.test(s)) s = '"' + s + '"';
      return s;
    }).join(",");
  }

  function exportCsv(){
    var arr = listActive();
    var lines = [];
    lines.push(toCsvRow(["razao","fantasia","cnpj","telefone","email","cidade","uf"]));
    for (var i=0;i<arr.length;i++){
      var f = arr[i];
      lines.push(toCsvRow([
        f.razao||"", f.fantasia||"", f.cnpj||formatCnpj(f.cnpj_digits||""),
        f.telefone||"", f.email||"", f.cidade||"", f.uf||""
      ]));
    }
    var blob = new Blob([lines.join("\n")], { type:"text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "fornecedores.csv";
    document.body.appendChild(a);
    a.click();
    setTimeout(function(){
      try{ URL.revokeObjectURL(a.href); }catch(_){}
      try{ a.remove(); }catch(_){}
    }, 0);
  }

  var btnCsv = $("btnExportCsv") || $("exportCsv") || $("btnCsvFornecedores");
  if (btnCsv && !btnCsv.__vscBound){
    btnCsv.__vscBound = true;
    btnCsv.addEventListener("click", function(){ exportCsv(); });
  }

  // ---------------------------------------------------------------------
  // Hardening: garante que a API pública existe mesmo antes do boot
  // ---------------------------------------------------------------------
    // Hardening: blindar ready() contra overwrite por outros scripts
  try{
    Object.defineProperty(VSC.fornecedores, "ready", {
      value: function(){ return !!State.ready; },
      writable: false,
      configurable: false
    });
  }catch(_e){
    VSC.fornecedores.ready = function(){ return !!State.ready; };
  }


  // ---------------------------------------------------------------------
  // Fim do módulo
  // ---------------------------------------------------------------------
})();
