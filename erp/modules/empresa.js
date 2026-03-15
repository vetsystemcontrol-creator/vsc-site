/* =====================================================================================
   VSC — EMPRESA MODULE (OFFLINE-FIRST)
   Arquivo: C:\Vet System Control - Equine\modules\empresa.js
   Origem: scripts inline do empresa.html (VSC_EMPRESA_REBUILD_OFFLINE_E6_V1 + masks + legacy flag)
   Regra: manter console limpo, não depender de backend, falhas externas não podem quebrar a UI.
===================================================================================== */
(function () {
  "use strict";
  // =================================================================================
  // VSC_EMPRESA_BOOTSTRAP_V1
  // - Flag de modo offline (sem backend)
  // - Bloqueio determinístico de /api/empresa (console limpo)
  // - Máscara CNPJ + legacy flag
  // =================================================================================
  (function bootstrapEmpresa(){
    try{
      // Flag consumida por camadas antigas
      try{ window.VSC_DISABLE_EMPRESA_API = true; }catch(e){}

      // Bloquear /api/empresa (sem request real)
      try{
        // fetch
        var _fetch = window.fetch;
        if (typeof _fetch === "function") {
          window.fetch = function(input, init){
            try{
              var url = (typeof input === "string") ? input : (input && input.url);
              if (url && /\/api\/empresa(\b|\/|\?)/i.test(url) && !/\/api\/empresa\/logo(\b|\/|\?)/i.test(url)) {
                return Promise.resolve(new Response(
                  JSON.stringify({ "__offline": true }),
                  { status: 200, headers: { "Content-Type":"application/json" } }
                ));
              }
            }catch(e){}
            return _fetch.apply(this, arguments);
          };
        }

        // XHR
        var _open = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url){
          try{
            if (url && /\/api\/empresa(\b|\/|\?)/i.test(url) && !/\/api\/empresa\/logo(\b|\/|\?)/i.test(url)) {
              url = "data:application/json,%7B%22__offline%22%3Atrue%7D";
            }
          }catch(e){}
          return _open.call(this, method, url);
        };
      }catch(e){}

      // Máscara CNPJ + legacy
      function onlyDigits(v){ return (v||"").toString().replace(/\D+/g,''); }
      function formatCNPJ(v){
        var d = onlyDigits(v);
        if(d.length !== 14) return v;
        return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
      }

      function trySetLegacyFlag(){
        try{
          var raw = localStorage.getItem("vsc_empresa_v1");
          if(raw && raw.length > 5){
            localStorage.setItem("empresa_configurada","1");
          }
        }catch(e){}
      }

      function hookCnpjMask(){
        var el = document.getElementById("cnpj") || document.querySelector('input[name="cnpj"], input[name="CNPJ"]');
        if(!el) return;

        el.value = formatCNPJ(el.value);

        el.addEventListener("blur", function(){
          el.value = formatCNPJ(el.value);
        });
      }

      document.addEventListener("DOMContentLoaded", function(){
        trySetLegacyFlag();
        hookCnpjMask();
      });
    }catch(e){}
  })();

  // =========================
  // Config / Keys
  // =========================
  var LS_KEY = "vsc_empresa_v1";
  var LS_META = "vsc_empresa_v1_meta";
  var MAX_LOGO_BYTES = 1200 * 1024; // ~1.2MB por logo

  // =========================
  // Helpers
  // =========================
  function byId(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }

  function onlyDigits(v) {
    return (v || "").toString().replace(/\D+/g, "");
  }

function normalizePix(tipo, chave){
    tipo = (tipo || "").toString().trim().toLowerCase();
    chave = (chave || "").toString().trim();
    if(!tipo) return {tipo:"", chave:"", norm:""};
    var norm = chave;
    if(tipo === "cpf" || tipo === "cnpj"){
      norm = onlyDigits(chave);
    } else if(tipo === "telefone" || tipo === "phone" || tipo === "celular"){
      norm = onlyDigits(chave);
      if(norm && norm.slice(0,2) !== "55"){
        norm = "55" + norm;
      }
      if(norm) norm = "+" + norm;
    } else if(tipo === "email"){
      norm = chave.trim().toLowerCase();
    } else if(tipo === "evp" || tipo === "aleatoria" || tipo === "random"){
      norm = chave.trim().toLowerCase();
    } else {
      norm = chave.trim();
    }
    return {tipo: tipo, chave: chave, norm: norm};
  }

  function isValidPix(tipo, norm){
    tipo = (tipo || "").toString().trim().toLowerCase();
    norm = (norm || "").toString().trim();
    if(!tipo) return true;
    if(tipo === "cpf") return /^\d{11}$/.test(norm.replace(/\D+/g,""));
    if(tipo === "cnpj") return /^\d{14}$/.test(norm.replace(/\D+/g,""));
    if(tipo === "telefone" || tipo === "phone" || tipo === "celular") return /^\+\d{10,15}$/.test(norm);
    if(tipo === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(norm);
    if(tipo === "evp" || tipo === "aleatoria" || tipo === "random") return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(norm);
    return norm.length > 0;
  }

  function toast(msg) {
    try {
      var el = byId("vscToast");
      if (!el) return;
      el.textContent = msg;
      el.style.display = "block";
      clearTimeout(window.__vscToastT);
      window.__vscToastT = setTimeout(function () {
        el.style.display = "none";
      }, 3200);
    } catch (e) { /* silencioso */ }
  }

  function fields() {
    return [
      "cnpj", "razao_social", "nome_fantasia", "ie", "im", "cnae", "abertura", "regime",
      "telefone", "celular", "email", "site", "pix_tipo", "pix_nome", "pix_chave",
      "cep", "uf", "logradouro", "numero", "complemento", "bairro", "cidade", "ibge",
      "crmv", "crmv_uf",
      "obs"
    ];
  }

  function readForm() {
    var o = {};
    var ids = fields();
    for (var i = 0; i < ids.length; i++) {
      var el = byId(ids[i]);
      if (el && typeof el.value !== "undefined") o[ids[i]] = el.value;
    }
    return o;
  }

  function applyForm(o) {
    if (!o) return;
    var ids = fields();
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var el = byId(id);
      if (el && Object.prototype.hasOwnProperty.call(o, id) && typeof el.value !== "undefined") {
        el.value = o[id] || "";
      }
    }
  }

  function setLogoPreview(imgId, dataUrl) {
    var img = byId(imgId);
    if (!img) return;
    if (!dataUrl) {
      img.src = "";
      img.style.display = "none";
      return;
    }
    img.src = dataUrl;
    img.style.display = "block";
  }

  
  function _b64Bytes(dataUrl){
    try{
      if(!dataUrl) return 0;
      var i = dataUrl.indexOf("base64,");
      if(i < 0) return dataUrl.length;
      var b64 = dataUrl.slice(i + 7);
      // 4 chars -> 3 bytes (aprox). Ajuste por padding.
      var padding = (b64.endsWith("==") ? 2 : (b64.endsWith("=") ? 1 : 0));
      return Math.floor((b64.length * 3) / 4) - padding;
    }catch(e){ return 0; }
  }

  function _imgToDataUrlFit(img, maxBytes, cb){
    try{
      // tamanhos-alvo (px) — desce até caber
      var targets = [1400, 1200, 1024, 900, 800, 700, 600, 512, 420, 360];
      var iw = img.naturalWidth || img.width || 0;
      var ih = img.naturalHeight || img.height || 0;
      if(!iw || !ih) return cb(null);

      (function tryNext(idx){
        if(idx >= targets.length) return cb(null);
        var t = targets[idx];

        var scale = Math.min(1, t / Math.max(iw, ih));
        var w = Math.max(1, Math.round(iw * scale));
        var h = Math.max(1, Math.round(ih * scale));

        var canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        var ctx = canvas.getContext("2d", { alpha: true });
        // melhor qualidade de resize
        try{
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
        }catch(e){}
        ctx.clearRect(0,0,w,h);
        ctx.drawImage(img, 0, 0, w, h);

        // 1) tenta PNG (mantém transparência)
        var pngUrl = null;
        try{ pngUrl = canvas.toDataURL("image/png"); }catch(e){ pngUrl = null; }
        if(pngUrl && _b64Bytes(pngUrl) <= maxBytes) return cb(pngUrl);

        // 2) tenta WEBP (melhor compressão, mantém alpha)
        var qualities = [0.90, 0.85, 0.80, 0.75, 0.70, 0.65];
        for(var q=0; q<qualities.length; q++){
          var webpUrl = null;
          try{ webpUrl = canvas.toDataURL("image/webp", qualities[q]); }catch(e){ webpUrl = null; }
          if(webpUrl && _b64Bytes(webpUrl) <= maxBytes) return cb(webpUrl);
        }

        // não coube — tenta menor
        return tryNext(idx + 1);
      })(0);

    }catch(e){ return cb(null); }
  }

  function readFileAsDataURL(file, cb) {
    try {
      if (!file) return cb(null);

      // Se já está pequeno o suficiente, lê direto.
      if (file.size <= MAX_LOGO_BYTES) {
        var fr = new FileReader();
        fr.onload = function () { cb(String(fr.result || "")); };
        fr.onerror = function () { cb(null); };
        fr.readAsDataURL(file);
        return;
      }

      // Grande demais: auto-otimiza (resize + compress), sem exigir do usuário.
      toast("Logo grande demais. Otimizando automaticamente…");
      var url = null;
      try{ url = URL.createObjectURL(file); }catch(e){ url = null; }
      if(!url) {
        toast("Não foi possível ler a imagem. Tente novamente.");
        return cb(null);
      }

      var img = new Image();
      img.onload = function(){
        try{ URL.revokeObjectURL(url); }catch(e){}
        _imgToDataUrlFit(img, MAX_LOGO_BYTES, function(out){
          if(!out){
            toast("Não foi possível otimizar a logo para caber no limite. Use uma imagem menor.");
          }
          cb(out);
        });
      };
      img.onerror = function(){
        try{ URL.revokeObjectURL(url); }catch(e){}
        toast("Falha ao carregar a imagem. Verifique o arquivo.");
        cb(null);
      };
      img.src = url;

    } catch (e) { cb(null); }
  }


  // =========================
  // Storage (Offline)
  // =========================
  function getStoredEmpresa(){
    try{
      if(window.VSC_DB && typeof window.VSC_DB.getEmpresaSnapshot === "function"){
        return window.VSC_DB.getEmpresaSnapshot({ preferIdb:false, hydrateLocalStorage:false });
      }
      var raw = localStorage.getItem(LS_KEY);
      if(!raw) return {};
      var o = JSON.parse(raw);
      return (o && typeof o === "object") ? o : {};
    }catch(e){ return {}; }
  }

  // =========================
  // IDB — persistência offline-first (empresa)
  // Usa VSC_DB canônico (vsc_db / store "empresa")
  // keyPath id = "empresa_local" (registro único por instalação)
  // =========================
  var IDB_STORE = "empresa";
  var IDB_KEY   = "empresa_local";

  async function _saveEmpresaToIDB(o){
    try{
      var vscDb = _getVSC_DB();
      if(!vscDb || typeof vscDb.openDB !== "function") return false;
      var db = await vscDb.openDB();
      try{
        await new Promise(function(resolve, reject){
          try{
            var t = db.transaction([IDB_STORE], "readwrite");
            var st = t.objectStore(IDB_STORE);
            var rec = Object.assign({}, o, {
              id: IDB_KEY,
              updated_at: new Date().toISOString()
            });
            var r = st.put(rec);
            r.onsuccess = function(){ resolve(true); };
            r.onerror   = function(){ reject(r.error || new Error("IDB put error")); };
          }catch(e){ reject(e); }
        });
        return true;
      }finally{ try{ db.close(); }catch(_){} }
    }catch(e){
      console.warn("[EMPRESA] _saveEmpresaToIDB erro:", e);
      return false;
    }
  }

  async function _loadEmpresaFromIDB(){
    try{
      var vscDb = _getVSC_DB();
      if(!vscDb || typeof vscDb.openDB !== "function") return null;
      var db = await vscDb.openDB();
      try{
        return await new Promise(function(resolve, reject){
          try{
            var t = db.transaction([IDB_STORE], "readonly");
            var st = t.objectStore(IDB_STORE);
            var r = st.get(IDB_KEY);
            r.onsuccess = function(){ resolve(r.result || null); };
            r.onerror   = function(){ reject(r.error || new Error("IDB get error")); };
          }catch(e){ reject(e); }
        });
      }finally{ try{ db.close(); }catch(_){} }
    }catch(e){
      console.warn("[EMPRESA] _loadEmpresaFromIDB erro:", e);
      return null;
    }
  }


  function _getVSC_DB() {
    if (window.VSC_DB && typeof window.VSC_DB.openDB === 'function') return window.VSC_DB;
    // Tentar pegar do iframe topbar
    try {
      const frames = Array.from(document.querySelectorAll('iframe'));
      for (const f of frames) {
        const w = f.contentWindow;
        if (w && w.VSC_DB && typeof w.VSC_DB.openDB === 'function') return w.VSC_DB;
      }
    } catch(_) {}
    // Tentar window.top e window.parent
    try { if (window.top && window.top.VSC_DB) return window.top.VSC_DB; } catch(_) {}
    try { if (window.parent && window.parent.VSC_DB) return window.parent.VSC_DB; } catch(_) {}
    return null;
  }

function safeUuidV4(){
  if(window.VSC_UTILS && typeof window.VSC_UTILS.uuidv4 === "function") return window.VSC_UTILS.uuidv4();
  if(typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  if(typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function"){
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    buf[6] = (buf[6] & 0x0f) | 0x40;
    buf[8] = (buf[8] & 0x3f) | 0x80;
    const hex = Array.from(buf).map(b=>b.toString(16).padStart(2,"0")).join("");
    return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join("-");
  }
  throw new TypeError("[EMPRESA] ambiente sem CSPRNG para gerar UUID v4.");
}

  async function _enqueueEmpresaSync(o) {
    try {
      const vscDb = _getVSC_DB();
      if (!vscDb || typeof vscDb.openDB !== 'function') return;
      var db = await vscDb.openDB();
      try {
        await new Promise(function(resolve, reject) {
          try {
            var t = db.transaction(['sync_queue'], 'readwrite');
            var st = t.objectStore('sync_queue');
            var opId = safeUuidV4();
            var op = {
              id: opId,
              op_id: opId,
              store: 'empresa',
              entity: 'empresa',
              entity_id: IDB_KEY,
              op: 'upsert',
              operation: 'upsert',
              payload: Object.assign({}, o, { id: IDB_KEY }),
              created_at: new Date().toISOString(),
              status: 'PENDING'
            };
            var r = st.put(op);
            r.onsuccess = function() { resolve(true); };
            r.onerror   = function() { reject(r.error); };
          } catch(e) { reject(e); }
        });
      } finally { try { db.close(); } catch(_) {} }
    } catch(e) {
      console.warn('[EMPRESA] _enqueueEmpresaSync erro:', e);
    }
  }

  async function setStoredEmpresa(o){
    try{
      if(window.VSC_DB && typeof window.VSC_DB.saveEmpresaSnapshot === "function"){
        await window.VSC_DB.saveEmpresaSnapshot(o || {}, { enqueueSync:true, mirrorLocalStorage:true });
        return true;
      }
      var meta = { version: 1, savedAt: new Date().toISOString() };
      localStorage.setItem(LS_KEY, JSON.stringify(o || {}));
      localStorage.setItem(LS_META, JSON.stringify(meta));
      try { localStorage.setItem("empresa_configurada", "1"); } catch (e) { /* ignora */ }
      var ok = await _saveEmpresaToIDB(o || {});
      if(!ok) return false;
      try { await _enqueueEmpresaSync(o || {}); } catch(e) { console.warn("[EMPRESA] enqueue sync warn:", e); }
      return true;
    }catch(e){
      console.error("[EMPRESA] setStoredEmpresa fail:", e);
      return false;
    }
  }

  async function saveLocal(extra) {
    try {
      var obj = readForm();
      var prev = await Promise.resolve(getStoredEmpresa());
      // Preservar campos internos (logos/normalizações) que não estão no form
      if(prev && typeof prev === "object"){
        if(typeof prev.__logoA === "string" && !obj.__logoA) obj.__logoA = prev.__logoA;
        if(typeof prev.__logoB === "string" && !obj.__logoB) obj.__logoB = prev.__logoB;
        if(typeof prev.pix_chave_norm === "string" && !obj.pix_chave_norm) obj.pix_chave_norm = prev.pix_chave_norm;
      }


      // =========================
      // Validação final (bloqueante) — AN/AQ
      // =========================
      function focusId(id){
        try{ var el = byId(id); if(el && el.focus) el.focus(); }catch(e){}
      }
      function isEmail(v){
        v = (v||"").toString().trim();
        if(!v) return true;
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
      }
      function isDateBR(v){
        v = (v||"").toString().trim();
        if(!v) return true;
        if(!/^(\d{2})\/(\d{2})\/(\d{4})$/.test(v)) return false;
        var p = v.split("/");
        var dd = parseInt(p[0],10), mm = parseInt(p[1],10), yy = parseInt(p[2],10);
        if(!(yy>=1900 && yy<=2100)) return false;
        if(!(mm>=1 && mm<=12)) return false;
        if(!(dd>=1 && dd<=31)) return false;
        return true;
      }

      var cnpjD = onlyDigits(obj.cnpj);
      if (obj.cnpj && cnpjD.length !== 14) { toast("CNPJ inválido: informe 14 dígitos."); focusId("cnpj"); return false; }

      var cepD = onlyDigits(obj.cep);
      if (obj.cep && cepD.length !== 8) { toast("CEP inválido: informe 8 dígitos."); focusId("cep"); return false; }

      var uf = (obj.uf || "").toString().trim();
      if (uf && !/^[A-Za-z]{2}$/.test(uf)) { toast("UF inválida: use 2 letras (ex.: SP)."); focusId("uf"); return false; }

      if (!isEmail(obj.email)) { toast("E-mail inválido."); focusId("email"); return false; }

      if (!isDateBR(obj.abertura)) { toast("Abertura inválida: use dd/mm/aaaa."); focusId("abertura"); return false; }


      // Preserva logos já salvas no storage (evita que SALVAR apague __logoA/__logoB)
      try {
        var prevRaw = localStorage.getItem(LS_KEY);
        if (prevRaw) {
          var prev = JSON.parse(prevRaw);
          if (prev) {
            if (!Object.prototype.hasOwnProperty.call(obj, "__logoA") && prev.__logoA) obj.__logoA = prev.__logoA;
            if (!Object.prototype.hasOwnProperty.call(obj, "__logoB") && prev.__logoB) obj.__logoB = prev.__logoB;
          }
        }
      } catch (_e) { /* ignora */ }

      if (extra && typeof extra === "object") {
        for (var k in extra) {
          if (Object.prototype.hasOwnProperty.call(extra, k)) obj[k] = extra[k];
        }
      }

      // =========================
      // PIX — normalização + validação (bloqueante)
      // =========================
      try{
        var pixTipo = (obj.pix_tipo || "").toString().trim();
        var pixNome = (obj.pix_nome || "").toString().trim();
        var pixChave = (obj.pix_chave || "").toString().trim();
        if(pixTipo){
          if(!pixChave){ toast("Informe a chave PIX."); focusId("pix_chave"); return false; }
          var r = normalizePix(pixTipo, pixChave);
          if(!isValidPix(r.tipo, r.norm)){
            toast("Chave PIX inválida para o tipo selecionado."); focusId("pix_chave"); return false;
          }
          obj.pix_tipo = r.tipo;
          obj.pix_chave = r.chave;
          obj.pix_chave_norm = r.norm;
          if(pixNome) obj.pix_nome = pixNome;
        } else {
          obj.pix_chave_norm = obj.pix_chave_norm || "";
        }
      }catch(_e){}

      var saved = await setStoredEmpresa(obj);
      if(!saved){
        toast("Falha ao salvar: armazenamento indisponível.");
        console.error("[EMPRESA] persistência canônica da empresa falhou.");
        return false;
      }

      toast("Empresa salva.");
      return true;
    } catch (e) {
      console.error("[EMPRESA] saveLocal exception:", e);
      toast("Falha ao salvar: " + (e && e.message ? e.message : String(e)));
      return false;
    }
  }

  async function loadLocal() {
    try {
      var obj = null;
      if(window.VSC_DB && typeof window.VSC_DB.getEmpresaSnapshot === "function"){
        obj = await window.VSC_DB.getEmpresaSnapshot({ preferIdb:true, hydrateLocalStorage:true });
      }
      if (!obj || typeof obj !== "object" || (!obj.nome && !obj.razao_social && !obj.nome_fantasia)) {
        var raw = localStorage.getItem(LS_KEY);
        if (raw) {
          try { obj = JSON.parse(raw); } catch(_) {}
        }
      }
      if (!obj || typeof obj !== "object" || (!obj.nome && !obj.razao_social && !obj.nome_fantasia)) {
        var idbObj = await _loadEmpresaFromIDB();
        if (idbObj && typeof idbObj === "object") {
          obj = idbObj;
          try {
            localStorage.setItem(LS_KEY, JSON.stringify(obj));
            localStorage.setItem("empresa_configurada", "1");
          } catch(_) {}
          console.log("[EMPRESA] dados restaurados do IDB para localStorage");
        }
      }
      if (!obj || typeof obj !== "object") {
        toast("Sem dados cadastrados. Preencha e salve.");
        return false;
      }
      applyForm(obj);
      if (obj.__logoA) setLogoPreview("logoAPreview", obj.__logoA);
      if (obj.__logoB) setLogoPreview("logoBPreview", obj.__logoB);
      toast("Dados carregados.");
      return true;
    } catch (e) {
      toast("Falha ao carregar dados.");
      return false;
    }
  }

  async function clearLocal() {
    try {
      localStorage.removeItem(LS_KEY);
      localStorage.removeItem(LS_META);
      try { localStorage.removeItem("empresa_configurada"); } catch(_) {}
      if(window.VSC_DB && typeof window.VSC_DB.openDB === "function"){
        var db = await window.VSC_DB.openDB();
        try{
          await new Promise(function(resolve, reject){
            try{
              var tx = db.transaction([IDB_STORE], "readwrite");
              var st = tx.objectStore(IDB_STORE);
              var req = st.delete(IDB_KEY);
              req.onsuccess = function(){ resolve(true); };
              req.onerror = function(){ reject(req.error || new Error("empresa_delete_failed")); };
            }catch(e){ reject(e); }
          });
        } finally { try { db.close(); } catch(_){} }
        try { window.dispatchEvent(new CustomEvent("vsc:empresa-updated", { detail: { snapshot: {} } })); } catch(_) {}
      }
      applyForm({});
      setLogoPreview("logoAPreview", null);
      setLogoPreview("logoBPreview", null);
      toast("Dados locais removidos.");
      return true;
    } catch (e) {
      console.error("[EMPRESA] clearLocal fail:", e);
      toast("Falha ao limpar dados locais.");
      return false;
    }
  }

  // ====== (continua na PARTE 2/4) ======
  window.__VSC_EMPRESA__ = window.__VSC_EMPRESA__ || {};
  window.__VSC_EMPRESA__.saveLocal = saveLocal;
  window.__VSC_EMPRESA__.loadLocal = loadLocal;
  window.__VSC_EMPRESA__.clearLocal = clearLocal;

  // =========================
  // Logos — bind premium (upload/remove persistente)
  // =========================
  function setLogo(kind, dataUrl){
    var extra = {};
    if(kind === "A"){ extra.__logoA = dataUrl || ""; setLogoPreview("logoAPreview", dataUrl); }
    if(kind === "B"){ extra.__logoB = dataUrl || ""; setLogoPreview("logoBPreview", dataUrl); }
    return saveLocal(extra);
  }

  function removeLogo(kind){
    if(kind === "A") return setLogo("A", "");
    if(kind === "B") return setLogo("B", "");
    return false;
  }

  // Compatibilidade com chamadas antigas (evita ReferenceError)
  window.removeLogo = removeLogo;

  document.addEventListener("DOMContentLoaded", function(){
    try{
      var a = byId("logoAFile");
      var b = byId("logoBFile");
      var ra = byId("btnRemoverLogoA");
      var rb = byId("btnRemoverLogoB");

      if(a){
        a.addEventListener("change", function(){
          try{
            var file = (a.files && a.files[0]) ? a.files[0] : null;
            readFileAsDataURL(file, function(dataUrl){
              if(!dataUrl){ return; }
              setLogo("A", dataUrl);
            });
          }catch(e){}
        });
      }

      if(b){
        b.addEventListener("change", function(){
          try{
            var file = (b.files && b.files[0]) ? b.files[0] : null;
            readFileAsDataURL(file, function(dataUrl){
              if(!dataUrl){ return; }
              setLogo("B", dataUrl);
            });
          }catch(e){}
        });
      }

      if(ra){ ra.addEventListener("click", function(){ removeLogo("A"); }); }
      if(rb){ rb.addEventListener("click", function(){ removeLogo("B"); }); }
    }catch(e){}
  });

})();
/* ===========================
   VSC_EMPRESA_MODULE — PARTE 2/4
   - fetchJson robusto (timeout + não explode em erro HTTP)
   - Auto CNPJ (BrasilAPI)
   - Auto CEP (ViaCEP)
=========================== */
(function () {
  "use strict";

  function byId(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function onlyDigits(v) { return (v || "").toString().replace(/\D+/g, ""); }

  function toast(msg) {
    try {
      var el = byId("vscToast");
      if (!el) return;
      el.textContent = msg;
      el.style.display = "block";
      clearTimeout(window.__vscToastT);
      window.__vscToastT = setTimeout(function () { el.style.display = "none"; }, 3200);
    } catch (e) { }
  }

  function fetchJson(url, timeoutMs) {
    timeoutMs = timeoutMs || 10000;

    return new Promise(function (resolve) {
      var ctrl = new AbortController();
      var t = setTimeout(function () { try { ctrl.abort(); } catch (e) { } }, timeoutMs);

      fetch(url, { signal: ctrl.signal })
        .then(function (r) {
          clearTimeout(t);

          // Não explode em 404/500: devolve objeto de diagnóstico
          if (!r.ok) {
            resolve({ __http_ok: false, __status: r.status, __url: url });
            return null;
          }

          return r.json()
            .then(function (data) { resolve(data); })
            .catch(function () { resolve({ __http_ok: false, __status: 200, __url: url }); });
        })
        .catch(function () {
          clearTimeout(t);
          resolve({ __http_ok: false, __status: 0, __url: url });
        });
    });
  }

  // Bridge com PARTE 1/4
  function saveLocal(extra) {
    try {
      if (window.__VSC_EMPRESA__ && typeof window.__VSC_EMPRESA__.saveLocal === "function") {
        return window.__VSC_EMPRESA__.saveLocal(extra);
      }
    } catch (e) { }
    return false;
  }

  // Auto CNPJ (BrasilAPI)
  function autoCNPJ() {
    var el = byId("cnpj");
    if (!el) return;

    var dig = onlyDigits(el.value);
    if (dig.length !== 14) return;

    toast("Consultando CNPJ...");
    fetchJson("https://brasilapi.com.br/api/cnpj/v1/" + dig, 10000)
      .then(function (d) {
        if (!d || d.__http_ok === false) {
          toast("CNPJ não encontrado / serviço indisponível.");
          return;
        }

        if (byId("razao_social") && d.razao_social) byId("razao_social").value = d.razao_social;
        if (byId("nome_fantasia") && d.nome_fantasia) byId("nome_fantasia").value = d.nome_fantasia;

        if (byId("cnae")) {
          if (d.cnae_fiscal && d.cnae_fiscal_descricao) {
            byId("cnae").value = d.cnae_fiscal + " - " + d.cnae_fiscal_descricao;
          } else if (d.cnae_fiscal) {
            byId("cnae").value = d.cnae_fiscal;
          }
        }

        var tel = d.ddd_telefone_1 || d.telefone_1 || d.ddd_telefone_2 || d.telefone_2;
        if (byId("telefone") && tel) byId("telefone").value = tel;

        if (byId("email") && d.email) byId("email").value = d.email;

        // Endereço (quando disponível)
        if (byId("cep") && d.cep) byId("cep").value = d.cep;
        if (byId("logradouro") && d.logradouro) byId("logradouro").value = d.logradouro;
        if (byId("numero") && d.numero) byId("numero").value = d.numero;
        if (byId("complemento") && d.complemento) byId("complemento").value = d.complemento;
        if (byId("bairro") && d.bairro) byId("bairro").value = d.bairro;
        if (byId("cidade") && (d.municipio || d.nome_municipio)) byId("cidade").value = d.municipio || d.nome_municipio;
        if (byId("uf") && d.uf) byId("uf").value = d.uf;
        if (byId("ibge") && (d.codigo_municipio_ibge || d.municipio_ibge)) byId("ibge").value = d.codigo_municipio_ibge || d.municipio_ibge;

        toast("CNPJ preenchido.");
        saveLocal();
      })
      .catch(function () {
        toast("CNPJ não disponível agora. Você pode preencher manualmente.");
      });
  }

  // Auto CEP (ViaCEP)
  function autoCEP() {
    var el = byId("cep");
    if (!el) return;

    var dig = onlyDigits(el.value);
    if (dig.length !== 8) return;

    toast("Consultando CEP...");
    fetchJson("https://viacep.com.br/ws/" + dig + "/json/", 8000)
      .then(function (d) {
        if (d && d.erro) throw new Error("cep");

        if (byId("logradouro") && d.logradouro) byId("logradouro").value = d.logradouro;
        if (byId("bairro") && d.bairro) byId("bairro").value = d.bairro;
        if (byId("cidade") && d.localidade) byId("cidade").value = d.localidade;
        if (byId("uf") && d.uf) byId("uf").value = d.uf;
        if (byId("ibge") && d.ibge) byId("ibge").value = d.ibge;

        toast("CEP preenchido.");
        saveLocal();
      })
      .catch(function () {
        toast("CEP não disponível agora. Você pode preencher manualmente.");
      });
  }

  // Export interno
  window.__VSC_EMPRESA__ = window.__VSC_EMPRESA__ || {};
  window.__VSC_EMPRESA__.autoCNPJ = autoCNPJ;
  window.__VSC_EMPRESA__.autoCEP = autoCEP;
  window.__VSC_EMPRESA__.fetchJson = fetchJson;

})();
/* ===========================
   VSC_EMPRESA_MODULE — PARTE 3/4
   - Máscaras (data, telefone)
   - Regra do Enter (não destrutivo)
   - Wire do DOM (botões, blur/change)
   - Auto-load inicial
=========================== */
(function () {
  "use strict";

  function byId(id){ try{ return document.getElementById(id); }catch(e){ return null; } }
  function onlyDigits(v){ return (v||"").replace(/\D+/g,""); }

  // ===== Máscaras =====
  function maskDate(el){
    if(!el) return;
    el.addEventListener("input", function(){
      var d = onlyDigits(el.value).slice(0,8);
      var o = "";
      if(d.length>0) o = d.slice(0,2);
      if(d.length>=3) o += "/" + d.slice(2,4);
      if(d.length>=5) o += "/" + d.slice(4,8);
      el.value = o;
    });
    el.addEventListener("blur", function(){
      // Mantém DD/MM/AAAA se formato básico; não força
      if(!/^(\d{2})\/(\d{2})\/(\d{4})$/.test(el.value)) return;
    });
  }

  function maskPhone(el){
    if(!el) return;
    el.addEventListener("input", function(){
      var d = onlyDigits(el.value).slice(0,11);
      var o = "";
      if(d.length>0) o = "(" + d.slice(0,2);
      if(d.length>=3) o += ") ";
      if(d.length>=3 && d.length<=6) o += d.slice(2);
      if(d.length>=7) o += d.slice(2,7) + "-" + d.slice(7,11);
      el.value = o;
    });
  }

  // ===== Enter-safe (avança foco; não submete destrutivo) =====
  function enterAsTab(form){
    if(!form) return;
    form.addEventListener("keydown", function(e){
      if(e.key !== "Enter") return;
      var t = e.target;
      if(!t) return;

            // PROIBIDO interceptar ENTER em textarea (Patch AK)
      if (t.tagName === "TEXTAREA") return;

      // Não interceptar ENTER em select (comportamento nativo/enterprise)
      if (t.tagName === "SELECT") return;

      // Permite Enter apenas em botão focado
      if (t.tagName === "BUTTON") return;

      // Evita submit automático
      try{ e.preventDefault(); }catch(_e){}

      var focusables = Array.prototype.slice.call(
        form.querySelectorAll("input, select, textarea, button")
      ).filter(function(el){
        return !el.disabled && el.offsetParent !== null;
      });

      var i = focusables.indexOf(t);
      if(i > -1 && focusables[i+1]) focusables[i+1].focus();
    }, true);
  }

  // ===== Wire do DOM =====
  function wire(){
    var form = byId("empresaForm");
    var btnSalvar = byId("btnSalvar");
    var btnRecarregar = byId("btnRecarregar");
    var btnLimpar = byId("btnLimpar");

    if(btnSalvar){
      btnSalvar.addEventListener("click", function(){
        if(window.__VSC_EMPRESA__ && window.__VSC_EMPRESA__.saveLocal){
          Promise.resolve(window.__VSC_EMPRESA__.saveLocal()).catch(function(e){ console.warn("[EMPRESA] saveLocal click fail:", e); });
        }
      }, false);
    }

    if(btnRecarregar){
      btnRecarregar.addEventListener("click", function(){
        if(window.__VSC_EMPRESA__ && window.__VSC_EMPRESA__.loadLocal){
          Promise.resolve(window.__VSC_EMPRESA__.loadLocal()).catch(function(e){ console.warn("[EMPRESA] loadLocal click fail:", e); });
        }
      }, false);
    }

    if(btnLimpar){
      btnLimpar.addEventListener("click", function(){
        if(window.__VSC_EMPRESA__ && window.__VSC_EMPRESA__.clearLocal){
          Promise.resolve(window.__VSC_EMPRESA__.clearLocal()).catch(function(e){ console.warn("[EMPRESA] clearLocal click fail:", e); });
        }
      }, false);
    }

    if(form){
      // Bloqueia submit/navegação
      form.addEventListener("submit", function(e){
        try{ e.preventDefault(); }catch(_e){}
        if(window.__VSC_EMPRESA__ && window.__VSC_EMPRESA__.saveLocal){
          Promise.resolve(window.__VSC_EMPRESA__.saveLocal()).catch(function(err){ console.warn("[EMPRESA] saveLocal submit fail:", err); });
        }
      }, false);

      // KUX: Enter navega SOMENTE em data-entry (opt-in declarativo)
      try{
        var kux = (form && form.getAttribute("data-kux")) || (document.body && document.body.getAttribute("data-kux")) || "";
        if (String(kux).toLowerCase() === "data-entry") enterAsTab(form);
      }catch(e){}

    }

    // Auto CNPJ / CEP (não agressivo)
    var cnpjEl = byId("cnpj");
    if(cnpjEl){
      cnpjEl.addEventListener("blur", function(){
        window.__VSC_EMPRESA__ && window.__VSC_EMPRESA__.autoCNPJ && window.__VSC_EMPRESA__.autoCNPJ();
      }, false);
      cnpjEl.addEventListener("change", function(){
        window.__VSC_EMPRESA__ && window.__VSC_EMPRESA__.autoCNPJ && window.__VSC_EMPRESA__.autoCNPJ();
      }, false);
    }

    var cepEl = byId("cep");
    if(cepEl){
      cepEl.addEventListener("blur", function(){
        window.__VSC_EMPRESA__ && window.__VSC_EMPRESA__.autoCEP && window.__VSC_EMPRESA__.autoCEP();
      }, false);
      cepEl.addEventListener("change", function(){
        window.__VSC_EMPRESA__ && window.__VSC_EMPRESA__.autoCEP && window.__VSC_EMPRESA__.autoCEP();
      }, false);
    }

    // Máscaras
    maskDate(byId("abertura"));
    maskPhone(byId("celular"));

    // Auto-load inicial (async: tenta localStorage, fallback IDB)
    if (window.__VSC_EMPRESA__ && typeof window.__VSC_EMPRESA__.loadLocal === "function") {
      Promise.resolve(window.__VSC_EMPRESA__.loadLocal()).catch(function(e){
        console.warn("[EMPRESA] loadLocal error:", e);
      });
    }
  }

  document.addEventListener("DOMContentLoaded", function(){
    try{ wire(); }catch(e){}
  });
})();

/* ===========================
   VSC_EMPRESA_ADAPTER_V1
   - Compatibilidade extra com empresa.html (ids/botoes)
   - Enter-safe fallback (nao destrutivo)
   - Evita submit acidental (type=button)
   - Foco inicial no CNPJ
   OBS: nao altera logica existente; apenas reforca protecoes.
=========================== */
(function(){
  "use strict";

  function byId(id){ try{ return document.getElementById(id); }catch(e){ return null; } }
  function setBtnType(id){
    var b = byId(id);
    if(!b) return;
    try{
      if(!b.getAttribute("type")) b.setAttribute("type","button");
    }catch(e){}
  }

  function enterAsTab(form){
    if(!form) return;
    form.addEventListener("keydown", function(e){
      try{
        if(e.key !== "Enter") return;
        var t = e.target;
        if(!t) return;

        // Permite Enter em textarea (quebra de linha)
        if(t.tagName === "TEXTAREA") return;

        // Permite Enter se botao estiver focado
        if(t.tagName === "BUTTON") return;

        e.preventDefault();

        var focusables = Array.prototype.slice.call(
          form.querySelectorAll("input, select, textarea, button")
        ).filter(function(el){
          return !el.disabled && el.offsetParent !== null;
        });

        var i = focusables.indexOf(t);
        if(i > -1 && focusables[i+1]) focusables[i+1].focus();
      }catch(_e){}
    }, true);
  }

  document.addEventListener("DOMContentLoaded", function(){
    try{
      // Evitar submit acidental
      setBtnType("btnSalvar");
      setBtnType("btnRecarregar");
      setBtnType("btnLimpar");
      setBtnType("btnRemoverLogoA");
      setBtnType("btnRemoverLogoB");

           // UFC: Enter é gerenciado apenas no módulo principal (KUX data-entry).
      // Adapter não deve duplicar regra de teclado.

      // Foco inicial
      var cnpj = byId("cnpj");
      if(cnpj && !cnpj.value){
        try{ cnpj.focus(); }catch(e){}
      }
    }catch(e){}
  });
})();
