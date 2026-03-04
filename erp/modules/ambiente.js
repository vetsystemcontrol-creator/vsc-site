/* ============================================================
 * Gestão de Ambiente — Reset Enterprise (Contrato 4.6)
 * - Backup obrigatório (arquivo local + SHA-256)
 * - Reset Geral: Nova instalação cliente (mantém produtos, zera estoque)
 * - Reset Seletivo: 1 módulo OU múltiplos módulos
 * - Fail-closed: somente ADMIN/MASTER
 * - Sem alert(); feedback via VSC_UI.toast/confirm
 * ============================================================ */
(function(){
  "use strict";

  var BUILD = "ERP2.0.1|ambiente.js|RESET|2026-02-21c";

  function byId(id){ return document.getElementById(id); }
  function setText(id, v){ var el = byId(id); if(el) el.textContent = String(v==null?"":v); }
  function val(id){ var el = byId(id); return el ? String(el.value||"") : ""; }

  function toast(kind, msg, opts){
    try{
      if(window.VSC_UI && typeof window.VSC_UI.toast === "function"){
        window.VSC_UI.toast(kind, String(msg||""), opts||{});
      }
    }catch(_){/* no-op */}
  }

  function hasRole(user){
    var r = String((user && user.role) || "").toUpperCase();
    return (r === "MASTER" || r === "ADMIN");
  }

  function nowStamp(){
    var d = new Date();
    function p(n){ return String(n).padStart(2,"0"); }
    return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes())+":"+p(d.getSeconds());
  }

  // ---------------- SHA-256 (texto) ----------------
  async function sha256Hex(text){
    try{
      if(!(window.crypto && window.crypto.subtle) || typeof TextEncoder !== "function") return null;
      var u8 = new TextEncoder().encode(String(text||""));
      var dig = await window.crypto.subtle.digest("SHA-256", u8);
      var arr = Array.from(new Uint8Array(dig));
      return arr.map(function(b){ return b.toString(16).padStart(2,"0"); }).join("");
    }catch(_){ return null; }
  }

  function downloadBlob(blob, filename){
    var url = URL.createObjectURL(blob);
    try{
      var a = document.createElement("a");
      a.href = url;
      a.download = filename || "backup.json";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(function(){
        try{ document.body.removeChild(a); }catch(_e){}
        try{ URL.revokeObjectURL(url); }catch(_e){}
      }, 0);
      return true;
    }catch(_){
      try{ URL.revokeObjectURL(url); }catch(_e){}
      return false;
    }
  }

  function pad2(n){ return String(n).padStart(2,"0"); }
  function backupFilename(meta){
    var d = new Date();
    var y = d.getFullYear();
    var m = pad2(d.getMonth()+1);
    var da = pad2(d.getDate());
    var hh = pad2(d.getHours());
    var mm = pad2(d.getMinutes());
    var ss = pad2(d.getSeconds());
    var v = (meta && meta.db_version) ? String(meta.db_version) : "";
    var n = (meta && meta.db_name) ? String(meta.db_name) : "vsc_db";
    return "vsc_backup_" + n + (v? ("_v"+v) : "") + "_" + y + m + da + "_" + hh + mm + ss + ".json";
  }

  // ---------------- Reset helpers ----------------
  function lsRemove(keys){
    for(var i=0;i<keys.length;i++){
      try{ localStorage.removeItem(keys[i]); }catch(_){ }
    }
  }
  function lsClearEmpresa(){
    lsRemove([
      "empresa_configurada",
      "vsc_empresa_v1",
      "erp_empresa",
      "vsc_logoA",
      "vsc_logoB",
      "vsc_logoC"
    ]);
  }
  function lsClearAuth(){
    lsRemove(["vsc_session_id", "vsc_local_token"]);
  }

  async function idbClearStores(storeNames){
    var db = await window.VSC_DB.openDB();
    try{
      var existing = Array.from(db.objectStoreNames || []);
      var toClear = [];
      for(var i=0;i<storeNames.length;i++){
        var s = String(storeNames[i]||"");
        if(s && existing.indexOf(s) >= 0) toClear.push(s);
      }
      if(!toClear.length) return { ok:true, cleared:[], missing:storeNames.slice() };

      await new Promise(function(resolve, reject){
        var tx = db.transaction(toClear, "readwrite");
        tx.oncomplete = function(){ resolve(); };
        tx.onerror = function(){ reject(tx.error || new Error("Falha na transação IDB")); };
        tx.onabort = function(){ reject(tx.error || new Error("Transação IDB abortada")); };
        for(var k=0;k<toClear.length;k++){
          tx.objectStore(toClear[k]).clear();
        }
      });

      return { ok:true, cleared:toClear, missing:storeNames.filter(function(s){ return toClear.indexOf(s) < 0; }) };
    } finally {
      try{ db.close(); }catch(_){ }
    }
  }

  async function idbKeepProdutosClearEverythingElse(){
    var db = await window.VSC_DB.openDB();
    try{
      var all = Array.from(db.objectStoreNames || []);
      var keep = [ window.VSC_DB.stores.produtos_master ];
      var toClear = [];
      for(var i=0;i<all.length;i++){
        var s = String(all[i]||"");
        if(keep.indexOf(s) < 0) toClear.push(s);
      }
      // estoque = 0 (Opção A): limpa lotes também
      if(toClear.indexOf(window.VSC_DB.stores.produtos_lotes) < 0) toClear.push(window.VSC_DB.stores.produtos_lotes);
      return await idbClearStores(toClear);
    } finally {
      try{ db.close(); }catch(_){ }
    }
  }

  // ---------------- UI state ----------------
  var state = {
    user: null,
    canReset: false,
    backupDone: false,
    backupSha: null,
    backupFilename: null
  };

  function setPill(id, ok, txt){
    var el = byId(id);
    if(!el) return;
    el.className = "pill " + (ok?"pill--ok":"pill--danger");
    el.textContent = txt;
  }

  function getMode(){
    var g = byId("modeGeral");
    var o = byId("modeOne");
    var m = byId("modeMulti");
    if(m && m.checked) return "multi";
    if(o && o.checked) return "one";
    if(g && g.checked) return "geral";
    return "geral";
  }

  function showPanels(){
    var mode = getMode();
    var pg = byId("panelGeral");
    var po = byId("panelOne");
    var pm = byId("panelMulti");
    if(pg) pg.classList.toggle("hidden", mode !== "geral");
    if(po) po.classList.toggle("hidden", mode !== "one");
    if(pm) pm.classList.toggle("hidden", mode !== "multi");
  }

  // -------- module catalog (derivado do schema real vsc_db.js v26) ------
  function getCatalog(){
    var s = window.VSC_DB && window.VSC_DB.stores ? window.VSC_DB.stores : {};
    // IMPORTANT: produtos_master é sempre preservado (não aparece aqui).
    return [
      { key:"atendimentos", label:"Atendimentos", stores:[s.atendimentos_master] },
      { key:"financeiro",   label:"Financeiro (Pagar/Receber)", stores:[s.contas_pagar, s.contas_receber] },
      { key:"estoque",      label:"Estoque (Opção A: zerar)", stores:[s.produtos_lotes] },
      { key:"clientes",     label:"Clientes", stores:[s.clientes_master] },
      { key:"animais",      label:"Animais (inclui raças/pelagens/espécies)", stores:[s.animais_master, s.animais_racas, s.animais_pelagens, s.animais_especies] },
      { key:"reproducao",   label:"Reprodução", stores:[s.repro_cases, s.repro_exams, s.repro_protocols, s.repro_events, s.repro_pregnancy, s.repro_foaling, s.repro_tasks] },
      { key:"exames",       label:"Exames (cadastro mestre)", stores:[s.exames_master] },
      { key:"servicos",     label:"Serviços (cadastro mestre)", stores:[s.servicos_master] },
      { key:"config",       label:"Configurações / Empresa (IDB + local)", stores:[s.config_params, s.config_audit_log, s.sys_meta] , clearsEmpresa:true },
      { key:"auth",         label:"Auth/RBAC (usuários/roles/sessões)", stores:[s.auth_users, s.auth_roles, s.auth_role_permissions, s.auth_sessions, s.auth_audit_log] , clearsAuth:true },
      { key:"sync",         label:"Sync/Outbox", stores:[s.sync_queue] },
      { key:"auditoria",    label:"Auditoria (logs)", stores:[s.business_audit_log, s.config_audit_log, s.auth_audit_log, s.backup_events] },
      { key:"backups",      label:"Backups internos (meta)", stores:[s.db_backups, s.backup_events] },
      { key:"xml",          label:"XML/Importações (heurística)", stores:[], heuristic:true }
    ].filter(function(it){ return it.key && it.label; });
  }

  function initModuleSelect(){
    var sel = byId("selModuloOne");
    if(!sel) return;
    while(sel.firstChild) sel.removeChild(sel.firstChild);

    var ph = document.createElement("option");
    ph.value = "";
    ph.textContent = "— selecione —";
    sel.appendChild(ph);

    var cat = getCatalog();
    for(var i=0;i<cat.length;i++){
      var o = document.createElement("option");
      o.value = cat[i].key;
      o.textContent = cat[i].label;
      sel.appendChild(o);
    }
  }

  function initModuleChecklist(){
    var box = byId("moduleChecklist");
    if(!box) return;
    while(box.firstChild) box.removeChild(box.firstChild);

    var cat = getCatalog();
    for(var i=0;i<cat.length;i++){
      var it = cat[i];
      var wrap = document.createElement("label");
      wrap.className = "check";

      var inp = document.createElement("input");
      inp.type = "checkbox";
      inp.value = it.key;
      inp.setAttribute("data-key", it.key);

      var txt = document.createElement("div");
      txt.textContent = it.label;

      wrap.appendChild(inp);
      wrap.appendChild(txt);
      box.appendChild(wrap);

      inp.addEventListener("change", updateButtons);
    }
  }

  function getMultiSelectedKeys(){
    var box = byId("moduleChecklist");
    if(!box) return [];
    var inputs = Array.from(box.querySelectorAll("input[type=checkbox][data-key]"));
    var out = [];
    for(var i=0;i<inputs.length;i++){
      if(inputs[i].checked) out.push(String(inputs[i].getAttribute("data-key")||""));
    }
    // unique
    var uniq = [];
    for(var j=0;j<out.length;j++){
      if(out[j] && uniq.indexOf(out[j])<0) uniq.push(out[j]);
    }
    return uniq;
  }

  function updateButtons(){
    showPanels();

    var accessOk = !!state.canReset;
    var backupOk = !!state.backupDone;
    var mode = getMode();

    // backup button: bloqueia só por acesso
    var bB = byId("btnBackup");
    if(bB) bB.disabled = !accessOk;

    var bG = byId("btnResetGeral");
    var bO = byId("btnResetOne");
    var bM = byId("btnResetMulti");

    if(bG) bG.disabled = true;
    if(bO) bO.disabled = true;
    if(bM) bM.disabled = true;

    if(mode === "geral"){
      var okG = backupOk && accessOk && (val("txtConfirmGeral").trim() === "RESETAR SISTEMA");
      if(bG) bG.disabled = !okG;
      return;
    }
    if(mode === "one"){
      var selKey = val("selModuloOne").trim();
      var okO = backupOk && accessOk && !!selKey && (val("txtConfirmOne").trim() === "RESET MODULO");
      if(bO) bO.disabled = !okO;
      return;
    }
    if(mode === "multi"){
      var keys = getMultiSelectedKeys();
      var okM = backupOk && accessOk && keys.length>0 && (val("txtConfirmMulti").trim() === "RESET CONFIRMADO");
      if(bM) bM.disabled = !okM;
      return;
    }
  }

  async function doBackup(){
    if(!state.canReset){ toast("err","Operação bloqueada: requer ADMIN/MASTER."); return; }
    if(!(window.VSC_DB && typeof window.VSC_DB.exportDump === "function")){
      toast("err","VSC_DB indisponível. Operação bloqueada.");
      return;
    }

    try{
      toast("info","Gerando backup...", { ms: 1800 });
      var dump = await window.VSC_DB.exportDump();
      var json = JSON.stringify(dump, null, 2);
      var sha = await sha256Hex(json);
      var filename = backupFilename(dump && dump.meta);
      var blob = new Blob([json], { type:"application/json" });
      var ok = downloadBlob(blob, filename);
      if(!ok) throw new Error("Falha ao iniciar download do backup.");

      state.backupDone = true;
      state.backupSha = sha;
      state.backupFilename = filename;

      setPill("pillBackup", true, "✓ GERADO");
      setText("backupInfo", "Arquivo: " + filename + " · " + String(blob.size) + " bytes" + (sha ? (" · SHA-256: " + sha) : ""));
      toast("ok","Backup gerado. Reset liberado.", { ms: 2400 });
    }catch(e){
      state.backupDone = false;
      setPill("pillBackup", false, "⛔ PENDENTE");
      setText("backupInfo", "Falha ao gerar backup.");
      toast("err","Falha ao gerar backup. " + String((e && (e.message||e)) || e), { ms: 4200 });
    }
    updateButtons();
  }

  async function doSelfTest(){
    try{
      if(!(window.VSC_DB && typeof window.VSC_DB.selfTest === "function")){
        setText("sysInfo", "build: " + BUILD + " · DB: (VSC_DB.selfTest indisponível)");
        return;
      }
      var r = await window.VSC_DB.selfTest();
      var txt = "DB: " + String(r && r.name) + " · v" + String(r && (r.version_actual||r.version_expected||"?")) + " · stores: " + String(r && r.stores ? r.stores.length : 0);
      setText("sysInfo", txt + " · build: " + BUILD);
    }catch(e){
      setText("sysInfo", "build: " + BUILD + " · DB self-test falhou");
    }
  }

  async function doResetGeral(){
    if(!state.canReset || !state.backupDone){ toast("err","Reset bloqueado. Gere backup e confirme acesso."); return; }

    var ok = false;
    try{
      ok = await window.VSC_UI.confirmAsync({
        kind:"err",
        title:"Confirmar Reset Geral",
        body:"Isso apagará dados do sistema para NOVA INSTALAÇÃO.\n\nMantém somente PRODUTOS e zera estoque.\nRemove Empresa/Config/Usuários/Financeiro/Atendimentos/XML/Sync/Logs.\n\nDeseja continuar?",
        okText:"SIM, resetar",
        cancelText:"Cancelar"
      });
    }catch(_){ ok = false; }
    if(!ok) return;

    try{
      toast("info","Executando reset geral...", { ms: 2400 });

      // 1) Limpa DB (mantém produtos_master; zera estoque limpando lotes)
      await idbKeepProdutosClearEverythingElse();

      // 2) Limpa empresa/branding (local)
      lsClearEmpresa();

      // 3) Limpa auth local (sessão)
      lsClearAuth();

      // 4) Best-effort: reset do backend empresa (se servidor estiver ativo)
      try{
        await fetch("/api/empresa", {
          method:"POST",
          headers:{ "Content-Type":"application/json" },
          body: JSON.stringify({})
        }).catch(function(){ return null; });
      }catch(_e){}

      // 5) Logout (se possível)
      try{ if(window.VSC_AUTH && typeof window.VSC_AUTH.logout === "function") await window.VSC_AUTH.logout(); }catch(_e){}

      toast("ok","Reset geral concluído. Recarregando...", { ms: 2000 });
      setTimeout(function(){ try{ location.href = "dashboard.html"; }catch(_e){ location.reload(); } }, 650);
    }catch(e){
      toast("err","Falha no reset geral. " + String((e && (e.message||e)) || e), { ms: 5200 });
    }
  }

  function catalogByKey(){
    var cat = getCatalog();
    var map = {};
    for(var i=0;i<cat.length;i++) map[cat[i].key]=cat[i];
    return map;
  }

  async function resolveStoresForKey(key){
    var map = catalogByKey();
    var cfg = map[key];
    if(!cfg) return { stores:[], clearsEmpresa:false, clearsAuth:false, label:String(key||"") };

    if(cfg.heuristic){
      // Heurística segura: limpa somente stores existentes com nome contendo xml/nfe/import
      var stores = [];
      try{
        var dbx = await window.VSC_DB.openDB();
        try{
          var allx = Array.from(dbx.objectStoreNames || []);
          for(var i=0;i<allx.length;i++){
            var nm = String(allx[i]||"").toLowerCase();
            if(nm.indexOf("xml")>=0 || nm.indexOf("nfe")>=0 || nm.indexOf("import")>=0){
              stores.push(allx[i]);
            }
          }
        } finally { try{ dbx.close(); }catch(_e){} }
      }catch(_e){}
      return { stores:stores, clearsEmpresa:false, clearsAuth:false, label:cfg.label };
    }

    return { stores:(cfg.stores||[]).slice(0), clearsEmpresa:!!cfg.clearsEmpresa, clearsAuth:!!cfg.clearsAuth, label:cfg.label };
  }

  function uniqList(arr){
    var out = [];
    for(var i=0;i<arr.length;i++){
      var x = arr[i];
      if(!x) continue;
      if(out.indexOf(x)<0) out.push(x);
    }
    return out;
  }

  async function doResetOne(){
    if(!state.canReset || !state.backupDone){ toast("err","Reset bloqueado. Gere backup e confirme acesso."); return; }

    var key = val("selModuloOne").trim();
    if(!key){ toast("warn","Selecione um módulo para reset."); return; }

    var cfg = await resolveStoresForKey(key);
    var stores = uniqList(cfg.stores || []);

    var ok = false;
    try{
      ok = await window.VSC_UI.confirmAsync({
        kind:"warn",
        title:"Confirmar Reset do Módulo",
        body:"Módulo: " + cfg.label + "\n\nIsto apagará os dados desse módulo.\nProdutos não serão afetados.\n\nDeseja continuar?",
        okText:"SIM, executar",
        cancelText:"Cancelar"
      });
    }catch(_){ ok = false; }
    if(!ok) return;

    try{
      toast("info","Executando reset do módulo...", { ms: 2400 });

      var r = await idbClearStores(stores);

      if(cfg.clearsEmpresa) lsClearEmpresa();
      if(cfg.clearsAuth) lsClearAuth();

      setText("oneInfo",
        "["+nowStamp()+"] " +
        "Módulo: " + cfg.label +
        " · Stores limpas: " + (r.cleared||[]).join(", ") +
        ((r.missing&&r.missing.length)?(" · Ignoradas: " + r.missing.join(", ")):"")
      );

      toast("ok","Reset do módulo concluído.", { ms: 2200 });
      setTimeout(function(){ try{ location.reload(); }catch(_e){} }, 450);
    }catch(e){
      toast("err","Falha no reset do módulo. " + String((e && (e.message||e)) || e), { ms: 5200 });
    }
  }

  async function doResetMulti(){
    if(!state.canReset || !state.backupDone){ toast("err","Reset bloqueado. Gere backup e confirme acesso."); return; }

    var keys = getMultiSelectedKeys();
    if(!keys.length){ toast("warn","Marque pelo menos 1 módulo."); return; }

    // resolve + union
    var labels = [];
    var stores = [];
    var clearsEmpresa = false;
    var clearsAuth = false;

    for(var i=0;i<keys.length;i++){
      var cfg = await resolveStoresForKey(keys[i]);
      labels.push(cfg.label);
      stores = stores.concat(cfg.stores || []);
      if(cfg.clearsEmpresa) clearsEmpresa = true;
      if(cfg.clearsAuth) clearsAuth = true;
    }
    stores = uniqList(stores);

    var ok = false;
    try{
      ok = await window.VSC_UI.confirmAsync({
        kind:"err",
        title:"Confirmar Reset dos Módulos",
        body:"Você selecionou:\n- " + labels.join("\n- ") + "\n\nIsto apagará os dados desses módulos.\nProdutos não serão afetados.\n\nDeseja continuar?",
        okText:"SIM, executar",
        cancelText:"Cancelar"
      });
    }catch(_){ ok = false; }
    if(!ok) return;

    try{
      toast("info","Executando reset dos módulos...", { ms: 2400 });

      var r = await idbClearStores(stores);

      if(clearsEmpresa) lsClearEmpresa();
      if(clearsAuth) lsClearAuth();

      setText("multiInfo",
        "["+nowStamp()+"] " +
        "Módulos: " + labels.join(" | ") +
        " · Stores limpas: " + (r.cleared||[]).join(", ") +
        ((r.missing&&r.missing.length)?(" · Ignoradas: " + r.missing.join(", ")):"")
      );

      toast("ok","Reset dos módulos concluído.", { ms: 2200 });
      setTimeout(function(){ try{ location.reload(); }catch(_e){} }, 450);
    }catch(e){
      toast("err","Falha no reset dos módulos. " + String((e && (e.message||e)) || e), { ms: 5200 });
    }
  }

  function setAllChecks(on){
    var box = byId("moduleChecklist");
    if(!box) return;
    var inputs = Array.from(box.querySelectorAll("input[type=checkbox][data-key]"));
    for(var i=0;i<inputs.length;i++) inputs[i].checked = !!on;
    updateButtons();
  }

  async function boot(){
    setText("sysInfo", "build: " + BUILD);

    // Access gate
    var u = null;
    try{
      if(window.VSC_AUTH && typeof window.VSC_AUTH.getCurrentUser === "function"){
        u = await window.VSC_AUTH.getCurrentUser();
      }
    }catch(_){ u = null; }

    state.user = u;
    state.canReset = hasRole(u);

    setPill("pillAccess", state.canReset, state.canReset ? "✓ LIBERADO" : "⛔ BLOQUEADO");
    if(!state.canReset){
      toast("warn","Acesso restrito: requer ADMIN/MASTER.", { ms: 2400 });
    }

    await doSelfTest();

    initModuleSelect();
    initModuleChecklist();
    showPanels();
    updateButtons();

    // wiring
    var bB = byId("btnBackup"); if(bB) bB.addEventListener("click", doBackup);

    var bG = byId("btnResetGeral"); if(bG) bG.addEventListener("click", doResetGeral);
    var bO = byId("btnResetOne"); if(bO) bO.addEventListener("click", doResetOne);
    var bM = byId("btnResetMulti"); if(bM) bM.addEventListener("click", doResetMulti);

    var back = byId("btnVoltarConfig"); if(back) back.addEventListener("click", function(){ location.href="configuracoes.html"; });

    var sa = byId("btnSelectAll"); if(sa) sa.addEventListener("click", function(e){ e.preventDefault(); setAllChecks(true); });
    var sn = byId("btnSelectNone"); if(sn) sn.addEventListener("click", function(e){ e.preventDefault(); setAllChecks(false); });

    var inputs = ["txtConfirmGeral","txtConfirmOne","txtConfirmMulti","selModuloOne","modeGeral","modeOne","modeMulti"];
    for(var i=0;i<inputs.length;i++){
      var el = byId(inputs[i]);
      if(el) el.addEventListener("input", updateButtons);
      if(el) el.addEventListener("change", updateButtons);
    }
  }

  document.addEventListener("DOMContentLoaded", function(){ boot(); });
})();
