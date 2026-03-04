/* ============================================================
   VSC — CONFIGURAÇÕES (date-effective) — v1
   - Fail-closed: sem stores canônicas => salvar BLOQUEADO
   - Vigência por data: valid_from/valid_to (intervalo não pode sobrepor)
   - Auditoria: registra before/after
   ============================================================ */
(function(){
  "use strict";

  // ========= Identidade build (ajuda debug determinístico)
  window.__CONFIG_JS_BUILD = "ERP2.0.1|configuracoes.js|ENTERPRISE|2026-02-20";

  // ========= Constantes (stores canônicas)
  var STORE_PARAMS = "config_params";
  var STORE_AUDIT  = "config_audit_log";

  function nowISO(){ return new Date().toISOString(); }

  function pad2(n){ return String(n).padStart(2,"0"); }
  function todayYMD(){
    var d = new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth()+1) + "-" + pad2(d.getDate());
  }


// ========= Salário mínimo vigente (Brasil) — tabela local (determinística / offline-first)
// Fonte normativa: decretos federais (vigência por data). Atualize ao mudar o ano.
// Hoje (2026-02-20): R$ 1.621,00 (162100 cents) desde 2026-01-01.
var SALARIO_MINIMO_TABELA = [
  { valid_from: "2025-01-01", value_cents: 151800 },
  { valid_from: "2026-01-01", value_cents: 162100 }
];

function ymdToMs(ymd){ return Date.parse(String(ymd||"")); }

function salarioMinimoVigenteCents(ymd){
  var x = ymdToMs(ymd || todayYMD());
  if(!isFinite(x)) return null;
  var best = null;
  for(var i=0;i<SALARIO_MINIMO_TABELA.length;i++){
    var r = SALARIO_MINIMO_TABELA[i];
    var a = ymdToMs(r.valid_from);
    if(!isFinite(a)) continue;
    if(a <= x){
      if(!best) best = r;
      else if(ymdToMs(best.valid_from) <= a) best = r;
    }
  }
  return best ? best.value_cents : null;
}

function centsToBRL(cents){
  if(!isFinite(Number(cents))) return "";
  return (Number(cents)/100).toFixed(2);
}

  function uuid(){
    try{ if(crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID(); }catch(_){}
    try{
  var buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  buf[6] = (buf[6] & 0x0f) | 0x40;
  buf[8] = (buf[8] & 0x3f) | 0x80;
  var hex = Array.prototype.map.call(buf, function(b){ return b.toString(16).padStart(2,"0"); }).join("");
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join("-");
}catch(_){}
return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c){
  var r = Math.random()*16|0, v = (c==="x") ? r : (r&0x3|0x8);
  return v.toString(16);
});
  }

  function $(id){ return document.getElementById(id); }

  function setMsg(kind, text){
    var box = $("msgBox");
    if(!box) return;
    box.className = "msg";
    if(kind === "danger") box.className += " msg--danger";
    else if(kind === "ok") box.className += " msg--ok";
    else box.className += " msg--warn";
    box.textContent = text || "";
    box.style.display = text ? "block" : "none";
  }

  function setPill(ok, text){
    var p = $("pillStatus");
    if(!p) return;
    p.className = "pill " + (ok ? "pill--ok" : "pill--danger");
    p.textContent = (ok ? "✅ " : "⛔ ") + (text || (ok ? "PRONTO" : "BLOQUEADO"));
  }

  function disableSaves(dis){
    var ids = ["btnSalvarF","btnSalvarA","btnSalvarR"];
    for(var i=0;i<ids.length;i++){
      var b = $(ids[i]);
      if(b) b.disabled = !!dis;
    }
  }

  function parseYMD(s){
    // retorna ms (UTC local) ou NaN
    if(!s) return NaN;
    var t = Date.parse(String(s));
    return t;
  }

  function parseBRDecimal(val){
    // Aceita: "200", "200,50", "1.234,56", "1234.56"
    var s = String(val==null ? "" : val).trim();
    if(!s) return NaN;
    // remove espaços e separadores de milhar comuns
    s = s.replace(/\s+/g,"");
    // se contém vírgula, assume pt-BR: "." = milhar, "," = decimal
    if(s.indexOf(",") >= 0){
      s = s.replace(/\./g,"").replace(/,/g,".");
    }
    // mantém apenas números, sinal e ponto
    s = s.replace(/[^0-9+\-\.]/g,"");
    var n = Number(s);
    return n;
  }


  function inVigencia(ymd, validFrom, validTo){
    var x = parseYMD(ymd);
    var a = parseYMD(validFrom);
    var b = validTo ? parseYMD(validTo) : NaN;
    if(!isFinite(x) || !isFinite(a)) return false;
    if(x < a) return false;
    if(isFinite(b) && x > b) return false;
    return true;
  }

  // ========= Tabs UI
  function initTabs(){
    var tabs = document.querySelectorAll(".tab[data-tab]");
    function show(name){
      for(var i=0;i<tabs.length;i++){
        var t = tabs[i];
        var is = (t.getAttribute("data-tab") === name);
        t.setAttribute("aria-selected", is ? "true" : "false");
      }
      var panes = document.querySelectorAll("[data-pane]");
      for(var j=0;j<panes.length;j++){
        var p = panes[j];
        var ok = (p.getAttribute("data-pane") === name);
        p.style.display = ok ? "block" : "none";
      }
    }
    for(var i2=0;i2<tabs.length;i2++){
      (function(tab){
        tab.addEventListener("click", function(ev){
          ev.preventDefault();
          show(tab.getAttribute("data-tab"));
        });
      })(tabs[i2]);
    }
  }

  // ========= DB helpers
  async function openDB(){
    if(!window.VSC_DB || typeof window.VSC_DB.openDB !== "function"){
      throw new Error("VSC_DB.openDB indisponível (vsc_db.js não carregou).");
    }
    return await window.VSC_DB.openDB();
  }

  async function hasStores(){
    var db = await openDB();
    try{
      var names = Array.from(db.objectStoreNames || []);
      return {
        ok: names.indexOf(STORE_PARAMS) !== -1 && names.indexOf(STORE_AUDIT) !== -1,
        hasParams: names.indexOf(STORE_PARAMS) !== -1,
        hasAudit: names.indexOf(STORE_AUDIT) !== -1,
        dbVersion: db.version,
        storeCount: names.length
      };
    } finally {
      try{ db.close(); }catch(_){}
    }
  }

  async function listAllByKey(key){
    // retorna todos registros dessa key (ordem indefinida)
    var db = await openDB();
    try{
      return await new Promise(function(resolve, reject){
        var tx = db.transaction([STORE_PARAMS], "readonly");
        var st = tx.objectStore(STORE_PARAMS);
        var out = [];

        // se existir índice "key", usa. senão varre tudo (fallback)
        var useIndex = false;
        try{
          useIndex = st.indexNames && Array.from(st.indexNames).indexOf("key") !== -1;
        }catch(_){ useIndex = false; }
tx.oncomplete = function(){ resolve(out); };
        tx.onerror = function(){ reject(tx.error || new Error("Tx listAllByKey falhou")); };
        tx.onabort = function(){ reject(tx.error || new Error("Tx listAllByKey abortou")); };

        if(useIndex){
          var ix = st.index("key");
          var rq = ix.openCursor(IDBKeyRange.only(key));
          rq.onerror = function(){ reject(rq.error); };
          rq.onsuccess = function(){
            var cur = rq.result;
            if(cur){ out.push(cur.value); cur.continue(); }
          };
        } else {
          var rq2 = st.openCursor();
          rq2.onerror = function(){ reject(rq2.error); };
          rq2.onsuccess = function(){
            var cur2 = rq2.result;
            if(!cur2) return;
            var v = cur2.value;
            if(v && v.key === key) out.push(v);
            cur2.continue();
          };
        }
      });
    } finally {
      try{ db.close(); }catch(_){}
    }
  }

  function pickVigente(rows, ymd){
    // escolhe o registro vigente com maior valid_from
    var best = null;
    for(var i=0;i<rows.length;i++){
      var r = rows[i];
      if(!r) continue;
      if(!inVigencia(ymd, r.valid_from, r.valid_to)) continue;
      if(!best) { best = r; continue; }
      var a = parseYMD(best.valid_from);
      var b = parseYMD(r.valid_from);
      if(isFinite(b) && (!isFinite(a) || b >= a)) best = r;
    }
    return best;
  }

  function intervalsOverlap(a1, a2, b1, b2){
    // intervalos [a1,a2] e [b1,b2] com fim opcional (null = infinito)
    var A1 = parseYMD(a1), A2 = a2 ? parseYMD(a2) : Infinity;
    var B1 = parseYMD(b1), B2 = b2 ? parseYMD(b2) : Infinity;
    if(!isFinite(A1) || !isFinite(B1)) return false;
    return (A1 <= B2) && (B1 <= A2);
  }

  async function upsertParam(section, key, value, unit, valid_from, valid_to){
    // valida vigência
    if(!key) throw new Error("key obrigatório");
    if(!valid_from) throw new Error("valid_from obrigatório");
    var vf = parseYMD(valid_from);
    var vt = valid_to ? parseYMD(valid_to) : NaN;
    if(!isFinite(vf)) throw new Error("valid_from inválido");
    if(valid_to && !isFinite(vt)) throw new Error("valid_to inválido");
    if(valid_to && vt < vf) throw new Error("valid_to não pode ser menor que valid_from");

    // não permitir sobreposição de intervalos na mesma key
    var existing = await listAllByKey(key);
    for(var i=0;i<existing.length;i++){
      var e = existing[i];
      if(!e) continue;
      if(intervalsOverlap(e.valid_from, e.valid_to, valid_from, valid_to)){
        // se é o mesmo registro (mesmo intervalo), permite update
        var same = (String(e.valid_from||"") === String(valid_from||"")) && (String(e.valid_to||"") === String(valid_to||""));
        if(!same){
          throw new Error("Vigência sobreposta detectada para '" + key + "'. Ajuste as datas para não sobrepor.");
        }
      }
    }

    var db = await openDB();
    try{
      return await new Promise(function(resolve, reject){
        var tx = db.transaction([STORE_PARAMS, STORE_AUDIT], "readwrite");
        var stP = tx.objectStore(STORE_PARAMS);
        var stA = tx.objectStore(STORE_AUDIT);

        var rec = {
  id: uuid(),
  section: section || "geral",
  key: String(key),

  // Compat: mantém "value" legado, mas adiciona tipagem forte quando possível
  value: value,
  value_type: (unit === "BRL" || unit === "BRL/KM") ? "cents" : (unit === "MIN" || unit === "DIA" ? "int" : (unit === "%" ? "decimal" : (unit === "ENUM" ? "text" : "text"))),
  value_cents: (unit === "BRL" || unit === "BRL/KM") ? Math.round(Number(value) * 100) : null,

  unit: unit || null,
  valid_from: String(valid_from),
  valid_to: valid_to ? String(valid_to) : null,
  updated_at: nowISO(),
  created_at: nowISO()
};

        // localizar se já existe exatamente este intervalo (key + valid_from + valid_to)
        // se existir, mantém id antigo e created_at
        var found = null;

        // se houver índice composto (key,valid_from), ótimo; se não, varre pela lista existente
        (function(){
          for(var i=0;i<existing.length;i++){
            var e = existing[i];
            if(!e) continue;
            if(String(e.valid_from||"") === String(valid_from||"") && String(e.valid_to||"") === String(valid_to||"")){
              found = e; break;
            }
          }
        })();

        if(found){
          rec.id = found.id;
          rec.created_at = found.created_at || rec.created_at;
        }

        tx.oncomplete = function(){ resolve({ ok:true, id: rec.id }); };
        tx.onerror = function(){ reject(tx.error || new Error("Tx upsertParam falhou")); };
        tx.onabort = function(){ reject(tx.error || new Error("Tx upsertParam abortou")); };

        try{
          stP.put(rec);
          stA.add({
            id: uuid(),
            when: nowISO(),
            user_id: (window.VSC_AUTH && window.VSC_AUTH.getCurrentUser) ? (window.__VSC_CFG_CUR_USER_ID || null) : null,
            username: window.__VSC_CFG_CUR_USERNAME || null,
            section: rec.section,
            key: rec.key,
            valid_from: rec.valid_from,
            valid_to: rec.valid_to,
            before: found ? { value: found.value, unit: found.unit } : null,
            after: { value: rec.value, unit: rec.unit }
          });
        }catch(e){
          try{ tx.abort(); }catch(_){}
          reject(e);
        }
      });
    } finally {
      try{ db.close(); }catch(_){}
    }
  }

  async function listAudit(limit){
    limit = limit || 50;
    var db = await openDB();
    try{
      return await new Promise(function(resolve, reject){
        var tx = db.transaction([STORE_AUDIT], "readonly");
        var st = tx.objectStore(STORE_AUDIT);
        var out = [];

        // se existir índice "when", usa para ordenar. senão cursor simples.
        var useIx = false;
        try{
          useIx = st.indexNames && Array.from(st.indexNames).indexOf("when") !== -1;
        }catch(_){ useIx = false; }

        tx.oncomplete = function(){ resolve(out); };
        tx.onerror = function(){ reject(tx.error || new Error("Tx listAudit falhou")); };

        var rq;
        if(useIx){
          rq = st.index("when").openCursor(null, "prev");
        }else{
          rq = st.openCursor(null, "prev");
        }

        rq.onerror = function(){ reject(rq.error); };
        rq.onsuccess = function(){
          var cur = rq.result;
          if(!cur) return;
          out.push(cur.value);
          if(out.length >= limit) return;
          cur.continue();
        };
      });
    } finally {
      try{ db.close(); }catch(_){}
    }
  }

  // ========= UI binds
  function bindDefaults(){
    // default: vigência início hoje
    var t = todayYMD();
    var ids = ["validFromF","validFromA","validFromR"];
    for(var i=0;i<ids.length;i++){
      var el = $(ids[i]);
      if(el && !el.value) el.value = t;
    }
  }

  async function loadVigenteFinanceiro(silent){
    var ymd = todayYMD();
    var keys = ["salario_minimo","valor_hora","deslocamento_modo","deslocamento_valor"];
    var map = {};
    for(var i=0;i<keys.length;i++){
      var rows = await listAllByKey(keys[i]);
      var v = pickVigente(rows, ymd);
      map[keys[i]] = v;
    }

if(map.salario_minimo){
  $("salarioMinimo").value = map.salario_minimo.value ?? "";
}else{
  // fallback determinístico (tabela local) se não existe config cadastrada
  var cents = salarioMinimoVigenteCents(ymd);
  if(cents !== null) $("salarioMinimo").value = centsToBRL(cents);
}
    if(map.valor_hora) $("valorHora").value = map.valor_hora.value ?? "";
    if(map.deslocamento_modo) $("deslocModo").value = map.deslocamento_modo.value ?? "POR_KM";
    if(map.deslocamento_valor) $("deslocValor").value = map.deslocamento_valor.value ?? "";

    if(!silent) setMsg("ok", "Valores vigentes (hoje) carregados.");
  }

  async function loadVigenteAtendimentos(){
    var ymd = todayYMD();
    var keys = ["tempo_padrao_min","cobrar_desloc_auto"];
    var map = {};
    for(var i=0;i<keys.length;i++){
      var rows = await listAllByKey(keys[i]);
      var v = pickVigente(rows, ymd);
      map[keys[i]] = v;
    }

    if(map.tempo_padrao_min) $("tempoPadrao").value = map.tempo_padrao_min.value ?? "";
    if(map.cobrar_desloc_auto) $("cobrarDesloc").value = map.cobrar_desloc_auto.value ?? "SIM";

    setMsg("ok", "Valores vigentes (hoje) carregados.");
  }

  async function loadVigenteRegras(){
    var ymd = todayYMD();
    var keys = ["margem_padrao_pct","juros_mensal_pct","multa_pct","dias_venc_padrao"];
    var map = {};
    for(var i=0;i<keys.length;i++){
      var rows = await listAllByKey(keys[i]);
      var v = pickVigente(rows, ymd);
      map[keys[i]] = v;
    }

    if(map.margem_padrao_pct) $("margemPadrao").value = map.margem_padrao_pct.value ?? "";
    if(map.juros_mensal_pct) $("jurosMensal").value = map.juros_mensal_pct.value ?? "";
    if(map.multa_pct) $("multaPerc").value = map.multa_pct.value ?? "";
    if(map.dias_venc_padrao) $("diasVenc").value = map.dias_venc_padrao.value ?? "";

    setMsg("ok", "Valores vigentes (hoje) carregados.");
  }

  function renderAuditRows(rows){
    var body = $("auditBody");
    if(!body) return;

    body.innerHTML = "";
    if(!rows || rows.length === 0){
      body.innerHTML = '<tr><td colspan="5" style="color:var(--muted); font-weight:800;">(vazio)</td></tr>';
      return;
    }

    for(var i=0;i<rows.length;i++){
      var r = rows[i];
      var tr = document.createElement("tr");

      var tdW = document.createElement("td");
      tdW.textContent = r.when || "";
      tr.appendChild(tdW);

      var tdS = document.createElement("td");
      tdS.textContent = r.section || "";
      tr.appendChild(tdS);

      var tdK = document.createElement("td");
      tdK.textContent = r.key || "";
      tr.appendChild(tdK);

      var tdD = document.createElement("td");
      var bef = r.before ? String(r.before.value) : "(novo)";
      var aft = r.after ? String(r.after.value) : "";
      tdD.textContent = bef + " → " + aft;
      tr.appendChild(tdD);

      var tdV = document.createElement("td");
      tdV.textContent = (r.valid_from || "") + (r.valid_to ? (" até " + r.valid_to) : " até ∞");
      tr.appendChild(tdV);

      body.appendChild(tr);
    }
  }

  async function reloadAudit(){
    try{
      var rows = await listAudit(50);
      renderAuditRows(rows);
      setMsg("ok", "Auditoria carregada.");
    }catch(e){
      setMsg("danger", "Falha ao carregar auditoria: " + (e && e.message ? e.message : String(e)));
    }
  }



// ========= Sistema / Multiusuários (ADMIN/MASTER)
async function initSistemaMultiUsuario(curUser, canEdit){
  // Usuário atual
  try{
    var pillUser = $("pillUser");
    if(pillUser){
      pillUser.className = "pill pill--ok";
      pillUser.textContent = "✅ " + (curUser.username || "usuário") + " (" + (curUser.role || curUser.role_id || "") + ")";
    }
    if($("curUsername")) $("curUsername").value = curUser.username || "";
    if($("curRole")) $("curRole").value = (curUser.role || curUser.role_id || "");
  }catch(_){}

  // Logout
  var btnLogout = $("btnLogout");
  if(btnLogout){
    btnLogout.addEventListener("click", async function(ev){
      ev.preventDefault();
      try{ await VSC_AUTH.logout(); }catch(_){}
      location.href = "dashboard.html";
    });
  }

  // Trocar senha (próprio usuário)
  var btnTrocar = $("btnTrocarSenha");
  var boxPw = $("boxTrocarSenha");
  var btnSalvarPw = $("btnSalvarSenha");
  var btnCancelPw = $("btnCancelarSenha");
  if(btnTrocar && boxPw){
    btnTrocar.addEventListener("click", function(ev){
      ev.preventDefault();
      boxPw.style.display = (boxPw.style.display === "none" ? "block" : "none");
      try{ $("pwNova")?.focus(); }catch(_){}
    });
  }
  if(btnCancelPw && boxPw){
    btnCancelPw.addEventListener("click", function(ev){
      ev.preventDefault();
      boxPw.style.display = "none";
    });
  }
  if(btnSalvarPw){
    btnSalvarPw.addEventListener("click", async function(ev){
      ev.preventDefault();
      setMsg(null, "");
      try{
        var p1 = String($("pwNova")?.value || "");
        var p2 = String($("pwConfirm")?.value || "");
        if(!p1 || !p2) throw new Error("Preencha a nova senha e a confirmação.");
        if(p1 !== p2) throw new Error("A confirmação não confere.");
        await VSC_AUTH.changePassword(curUser.id, p1);
        setMsg("ok", "Senha alterada. Você será desconectado para segurança.");
        try{ await VSC_AUTH.logout(); }catch(_){}
        setTimeout(function(){ location.reload(); }, 800);
      }catch(e){
        setMsg("danger", e && e.message ? e.message : String(e));
      }
    });
  }

  // ADMIN/MASTER area
  var isAdmin = false;
  try{ await VSC_AUTH.requirePermission(VSC_AUTH.CONST.MODULE_CONFIG, "admin"); isAdmin = true; }catch(_){}
  // fallback: allow ADMIN by role gate if module doesn't have "admin" perm
  if(!isAdmin){
    try{ await VSC_AUTH.requireRole("ADMIN"); isAdmin = true; }catch(_){}
  }

  var pillAdmin = $("pillAdmin");
  var adminBox = $("adminBox");
  if(isAdmin){
    if(pillAdmin){ pillAdmin.className = "pill pill--ok"; pillAdmin.textContent = "✅ LIBERADO"; }
    if(adminBox) adminBox.style.display = "block";
await reloadUsersTable();
  }else{
    if(pillAdmin){ pillAdmin.className = "pill pill--danger"; pillAdmin.textContent = "⛔ RESTRITO"; }
    if(adminBox) adminBox.style.display = "none";
  }

  // wire admin buttons
  var btnReloadUsers = $("btnReloadUsers");
  if(btnReloadUsers){
    btnReloadUsers.addEventListener("click", function(ev){
      ev.preventDefault();
      reloadUsersTable().catch(function(e){ setMsg("danger", e && e.message ? e.message : String(e)); });
    });
  }

  var btnCriar = $("btnCriarUser");
  if(btnCriar){
    btnCriar.addEventListener("click", async function(ev){
      ev.preventDefault();
      setMsg(null, "");
      try{
        var u = String($("newUser")?.value || "").trim();
        var r = String($("newRole")?.value || "USER").trim();
        var p1 = String($("newPass")?.value || "");
        var p2 = String($("newPass2")?.value || "");
        if(!u) throw new Error("Informe o usuário.");
        if(!p1 || !p2) throw new Error("Informe a senha temporária e confirme.");
        if(p1 !== p2) throw new Error("A confirmação não confere.");
        await VSC_AUTH.adminCreateUser(u, p1, r);
        setMsg("ok", "Usuário criado. Exigir troca de senha no 1º login.");
        $("newUser").value = ""; $("newPass").value = ""; $("newPass2").value = "";
        await reloadUsersTable();
      }catch(e){
        setMsg("danger", e && e.message ? e.message : String(e));
      }
    });
  }

  async function reloadUsersTable(){
    var body = $("usersBody");
    if(!body) return;
    body.innerHTML = '<tr><td colspan="7" style="color:var(--muted); font-weight:800;">Carregando…</td></tr>';

    var rows = await VSC_AUTH.listUsers({ limit: 200 });
    if(!rows || rows.length === 0){
      body.innerHTML = '<tr><td colspan="7" style="color:var(--muted); font-weight:800;">(vazio)</td></tr>';
      return;
    }

    body.innerHTML = "";
    for(var i=0;i<rows.length;i++){
      var r = rows[i];
      var tr = document.createElement("tr");

      function td(txt){
        var x = document.createElement("td");
        x.textContent = txt == null ? "" : String(txt);
        return x;
      }

      tr.appendChild(td(r.username));
      tr.appendChild(td(r.role_id));
      tr.appendChild(td(r.status));
      tr.appendChild(td(r.force_change_password ? "SIM" : "NÃO"));
      tr.appendChild(td(r.failed_attempts || 0));
      tr.appendChild(td(r.lock_until || "-"));

      var tdA = document.createElement("td");
      var btnRevoke = document.createElement("button");
      btnRevoke.className = "btn";
      btnRevoke.textContent = "Revogar sessões";
      btnRevoke.addEventListener("click", async function(userId){
        return async function(ev){
          ev.preventDefault();
          setMsg(null, "");
          try{
            await VSC_AUTH.revokeAllSessionsForUser(userId, "admin_revoke");
            setMsg("ok", "Sessões revogadas.");
          }catch(e){
            setMsg("danger", e && e.message ? e.message : String(e));
          }
        };
      }(r.id));

      tdA.appendChild(btnRevoke);

      var btnProf = document.createElement("button");
      btnProf.className = "btn btn--primary";
      btnProf.style.marginLeft = "8px";
      btnProf.textContent = "Perfil/CRMV";
      btnProf.addEventListener("click", async function(userId){
        return async function(ev){
          ev.preventDefault();
          setMsg(null, "");
          try{ await openProfModal(userId); }catch(e){ setMsg("danger", e && e.message ? e.message : String(e)); }
        };
      }(r.id));
      tdA.appendChild(btnProf);

      // Bloqueio (lock_until) — ADMIN/MASTER
      var btnUnlock = document.createElement("button");
      btnUnlock.className = "btn";
      btnUnlock.style.marginLeft = "8px";
      btnUnlock.textContent = "Cancelar bloqueio";
      btnUnlock.title = "Limpa lock_until e zera falhas de login";
      btnUnlock.addEventListener("click", (function(userId){
        return async function(ev){
          ev.preventDefault();
          setMsg(null, "");
          try{
            await VSC_AUTH.adminClearUserLock(userId, "ui_cancel_lock");
            setMsg("ok", "Bloqueio cancelado.");
            await reloadUsersTable();
          }catch(e){
            setMsg("danger", e && e.message ? e.message : String(e));
          }
        };
      })(r.id));
      tdA.appendChild(btnUnlock);

      var btnSetLock = document.createElement("button");
      btnSetLock.className = "btn";
      btnSetLock.style.marginLeft = "8px";
      btnSetLock.textContent = "Alterar bloqueio";
      btnSetLock.title = "Define lock_until manualmente (em horas a partir de agora)";
      btnSetLock.addEventListener("click", (function(userId){
        return async function(ev){
          ev.preventDefault();
          setMsg(null, "");
          try{
            var h = prompt("Bloquear por quantas horas a partir de agora?\n\n- 0 ou vazio = remover bloqueio\n- exemplo: 24", "24");
            if(h == null) return; // cancelou
            h = String(h).trim();
            if(!h || Number(h) === 0){
              await VSC_AUTH.adminClearUserLock(userId, "ui_set_lock_0");
              setMsg("ok", "Bloqueio removido.");
              await reloadUsersTable();
              return;
            }
            var hours = Number(h);
            if(!isFinite(hours) || hours < 0) throw new Error("Valor inválido de horas.");
            var until = new Date(Date.now() + Math.round(hours * 3600 * 1000)).toISOString();
            await VSC_AUTH.adminSetUserLockUntil(userId, until, "ui_set_lock_hours=" + hours);
            setMsg("ok", "Bloqueio atualizado para: " + until);
            await reloadUsersTable();
          }catch(e){
            setMsg("danger", e && e.message ? e.message : String(e));
          }
        };
      })(r.id));
      tdA.appendChild(btnSetLock);

      tr.appendChild(tdA);

      body.appendChild(tr);
    }
  }

  // -----------------------------
  // Perfil Profissional (CRMV) — Modal
  // -----------------------------
  var __profState = { sigDataUrl: null };

  function profMsg(kind, text){
    var box = $("profMsg");
    if(!box) return;
    if(!kind){ box.style.display="none"; box.className="msg"; box.textContent=""; return; }
    box.style.display="block";
    box.className = "msg msg--" + (kind === "ok" ? "ok" : (kind === "warn" ? "warn" : "danger"));
    box.textContent = text || "";
  }

  function openOverlay(){
    var ov = $("vscModalOverlayProf");
    if(ov) ov.style.display = "flex";
  }
  function closeOverlay(){
    var ov = $("vscModalOverlayProf");
    if(ov) ov.style.display = "none";
  }

  async function openProfModal(userId){
    if(!window.VSC_AUTH) throw new Error("VSC_AUTH indisponível.");
    profMsg(null,"");
    __profState.sigDataUrl = null;

    var u = await VSC_AUTH.adminGetUser(userId);

    $("profUserId").value = u.id;
    $("profUsername").value = u.username || "";
    $("profRole").value = u.role_id || "";

    var p = (u.professional || {});
    $("profFullName").value = p.full_name || "";
    $("profCrmvUf").value = (p.crmv_uf || "").toUpperCase();
    $("profCrmvNum").value = p.crmv_num || "";
    $("profPhone").value = p.phone || "";
    $("profEmail").value = p.email || "";
    $("profIsVet").checked = !!p.is_vet;
    $("profIcp").checked = !!p.icp_enabled;

    var prev = $("profSigPreview");
    if(prev){
      if(p.signature_image_dataurl){
        prev.src = p.signature_image_dataurl;
        prev.style.display = "inline-block";
        __profState.sigDataUrl = p.signature_image_dataurl;
      }else{
        prev.removeAttribute("src");
        prev.style.display = "none";
      }
    }

    var file = $("profSigFile");
    if(file) file.value = "";

    openOverlay();
  }

  async function saveProfModal(){
    if(!window.VSC_AUTH) throw new Error("VSC_AUTH indisponível.");

    var userId = $("profUserId").value;
    if(!userId) throw new Error("Usuário inválido.");

    var payload = {
      is_vet: $("profIsVet").checked,
      full_name: ($("profFullName").value || "").trim(),
      crmv_uf: ($("profCrmvUf").value || "").trim().toUpperCase(),
      crmv_num: ($("profCrmvNum").value || "").trim(),
      phone: ($("profPhone").value || "").trim(),
      email: ($("profEmail").value || "").trim(),
      icp_enabled: $("profIcp").checked,
      signature_image_dataurl: __profState.sigDataUrl
    };

    // regra enterprise: se for emissor, nome completo obrigatório
    if(payload.is_vet || (payload.crmv_uf && payload.crmv_num)){
      if(!payload.full_name) throw new Error("Nome completo é obrigatório para Médico-Veterinário emissor.");
    }

    var r = await VSC_AUTH.adminUpdateProfessionalProfile(userId, payload);
    profMsg("ok", "Perfil salvo. Campos alterados: " + ((r && r.changed && r.changed.length) ? r.changed.join(", ") : "nenhum"));
    // atualiza a lista
    try{ await reloadUsersTable(); }catch(_){}
  }

  function wireProfModal(){
    var closeBtns = ["btnProfClose","btnProfCancel"].map($).filter(Boolean);
    closeBtns.forEach(function(b){
      b.addEventListener("click", function(ev){ ev.preventDefault(); closeOverlay(); });
    });

    var ov = $("vscModalOverlayProf");
    if(ov){
      ov.addEventListener("click", function(ev){
        if(ev.target === ov) closeOverlay();
      });
    }

    var clear = $("btnProfSigClear");
    if(clear){
      clear.addEventListener("click", function(ev){
        ev.preventDefault();
        __profState.sigDataUrl = null;
        var prev = $("profSigPreview");
        if(prev){ prev.removeAttribute("src"); prev.style.display="none"; }
        var file = $("profSigFile");
        if(file) file.value = "";
      });
    }

    var file = $("profSigFile");
    if(file){
      file.addEventListener("change", function(){
        profMsg(null,"");
        var f = (file.files && file.files[0]) ? file.files[0] : null;
        if(!f) return;

        if(f.size > 350*1024){
          profMsg("warn", "Imagem grande (" + Math.round(f.size/1024) + "KB). Recomendo reduzir para melhor performance.");
        }

        var rd = new FileReader();
        rd.onload = function(){
          __profState.sigDataUrl = String(rd.result || "");
          var prev = $("profSigPreview");
          if(prev){
            prev.src = __profState.sigDataUrl;
            prev.style.display = "inline-block";
          }
        };
        rd.onerror = function(){
          profMsg("danger", "Falha ao ler imagem da assinatura.");
        };
        rd.readAsDataURL(f);
      });
    }

    var save = $("btnProfSave");
    if(save){
      save.addEventListener("click", async function(ev){
        ev.preventDefault();
        profMsg(null,"");
        try{
          await saveProfModal();
        }catch(e){
          profMsg("danger", e && e.message ? e.message : String(e));
        }
      });
    }
  }

  // expose for refresh
  // init modal wiring
  wireProfModal();


  window.__VSC_CFG_reloadUsers = reloadUsersTable;
}

  function wireButtons(){
    var bF = $("btnSalvarF");
    var bA = $("btnSalvarA");
    var bR = $("btnSalvarR");

    var cF = $("btnCarregarVigenteF");
    var cA = $("btnCarregarVigenteA");
    var cR = $("btnCarregarVigenteR");

    if(cF) cF.addEventListener("click", function(ev){ ev.preventDefault(); loadVigenteFinanceiro().catch(function(e){ setMsg("danger", e.message); }); });
    if(cA) cA.addEventListener("click", function(ev){ ev.preventDefault(); loadVigenteAtendimentos().catch(function(e){ setMsg("danger", e.message); }); });
    if(cR) cR.addEventListener("click", function(ev){ ev.preventDefault(); loadVigenteRegras().catch(function(e){ setMsg("danger", e.message); }); });

    var bAud = $("btnRecarregarAudit");
    if(bAud) bAud.addEventListener("click", function(ev){ ev.preventDefault(); reloadAudit(); });

    if(bF){
      bF.addEventListener("click", async function(ev){
        ev.preventDefault();
        setMsg(null, "");
        try{
          var vf = $("validFromF").value || "";
          var vt = $("validToF").value || "";
          var sm = parseBRDecimal($("salarioMinimo").value || "");
          var vh = parseBRDecimal($("valorHora").value || "");
          var dm = $("deslocModo").value || "POR_KM";
          var dv = parseBRDecimal($("deslocValor").value || "");

          if(!vf) throw new Error("Vigência (início) é obrigatória.");
          if(!isFinite(sm) || sm <= 0) throw new Error("Salário mínimo inválido.");
          if(!isFinite(vh) || vh <= 0) throw new Error("Valor hora inválido.");
          if(!isFinite(dv) || dv < 0) throw new Error("Valor de deslocamento inválido.");

          await upsertParam("financeiro","salario_minimo", sm, "BRL", vf, vt||null);
          await upsertParam("financeiro","valor_hora", vh, "BRL", vf, vt||null);
          await upsertParam("financeiro","deslocamento_modo", dm, "ENUM", vf, vt||null);
          await upsertParam("financeiro","deslocamento_valor", dv, (dm==="POR_KM" ? "BRL/KM" : "BRL"), vf, vt||null);

          setMsg("ok", "Financeiro salvo com sucesso.");
          await reloadAudit();
        }catch(e){
          setMsg("danger", e && e.message ? e.message : String(e));
        }
      });
    }

    if(bA){
      bA.addEventListener("click", async function(ev){
        ev.preventDefault();
        setMsg(null, "");
        try{
          // EDIT permission (fail-closed)
          try{ await VSC_AUTH.requirePermission(VSC_AUTH.CONST.MODULE_CONFIG, "edit"); }catch(e){ throw new Error("Sem permissão para salvar (EDIT)."); }

          var vf = $("validFromA").value || "";
          var vt = $("validToA").value || "";
          var tp = $("tempoPadrao").value ? Number($("tempoPadrao").value) : null;
          var cd = $("cobrarDesloc").value || "SIM";

          if(!vf) throw new Error("Vigência (início) é obrigatória.");

          if(tp !== null){
            if(!isFinite(tp) || tp < 0) throw new Error("Tempo padrão inválido.");
            await upsertParam("atendimentos","tempo_padrao_min", tp, "MIN", vf, vt||null);
          }
          await upsertParam("atendimentos","cobrar_desloc_auto", cd, "ENUM", vf, vt||null);

          setMsg("ok", "Atendimentos salvo com sucesso.");
          await reloadAudit();
        }catch(e){
          setMsg("danger", e && e.message ? e.message : String(e));
        }
      });
    }

    if(bR){
      bR.addEventListener("click", async function(ev){
        ev.preventDefault();
        setMsg(null, "");
        try{
          // EDIT permission (fail-closed)
          try{ await VSC_AUTH.requirePermission(VSC_AUTH.CONST.MODULE_CONFIG, "edit"); }catch(e){ throw new Error("Sem permissão para salvar (EDIT)."); }

          var vf = $("validFromR").value || "";
          var vt = $("validToR").value || "";
          if(!vf) throw new Error("Vigência (início) é obrigatória.");

          var mp = $("margemPadrao").value ? Number($("margemPadrao").value) : null;
          var jm = $("jurosMensal").value ? Number($("jurosMensal").value) : null;
          var mu = $("multaPerc").value ? Number($("multaPerc").value) : null;
          var dv = $("diasVenc").value ? Number($("diasVenc").value) : null;

          if(mp !== null){
            if(!isFinite(mp) || mp < 0) throw new Error("Margem inválida.");
            await upsertParam("regras","margem_padrao_pct", mp, "%", vf, vt||null);
          }
          if(jm !== null){
            if(!isFinite(jm) || jm < 0) throw new Error("Juros inválido.");
            await upsertParam("regras","juros_mensal_pct", jm, "%", vf, vt||null);
          }
          if(mu !== null){
            if(!isFinite(mu) || mu < 0) throw new Error("Multa inválida.");
            await upsertParam("regras","multa_pct", mu, "%", vf, vt||null);
          }
          if(dv !== null){
            if(!isFinite(dv) || dv < 0) throw new Error("Dias de vencimento inválido.");
            await upsertParam("regras","dias_venc_padrao", dv, "DIA", vf, vt||null);
          }

          setMsg("ok", "Regras salvas com sucesso.");
await reloadAudit();
        }catch(e){
          setMsg("danger", e && e.message ? e.message : String(e));
        }
      });
    }
  }

  async function boot(){
  initTabs();
  bindDefaults();

  // ============================
  // RBAC (enterprise / fail-closed)
  // ============================
  if(!window.VSC_AUTH){
    setPill(false, "BLOQUEADO (auth ausente)");
    disableSaves(true);
    setMsg("danger", "Falha crítica: módulo auth não carregado.");
    window.__CONFIG_READY = false;
    window.__CONFIG_LAST_ERROR = "AUTH_MISSING";
    return;
  }

  try{ await VSC_AUTH.bootstrap(); }catch(_){}

  // Modal login (UI local, sem alert/som)
  function showLoginModal(message){
    if(document.getElementById("vscAuthModal")) return;

    var overlay = document.createElement("div");
    overlay.id = "vscAuthModal";
    overlay.style.position = "fixed";
    overlay.style.left = "0";
    overlay.style.top = "0";
    overlay.style.right = "0";
    overlay.style.bottom = "0";
    overlay.style.background = "rgba(0,0,0,.55)";
    overlay.style.zIndex = "9999";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.padding = "18px";

    var card = document.createElement("div");
    card.style.width = "100%";
    card.style.maxWidth = "440px";
    card.style.background = "#fff";
    card.style.borderRadius = "18px";
    card.style.border = "1px solid rgba(0,0,0,.10)";
    card.style.boxShadow = "0 24px 60px rgba(0,0,0,.25)";
    card.style.padding = "16px";

    var h = document.createElement("div");
    h.style.fontWeight = "900";
    h.style.fontSize = "16px";
    h.style.marginBottom = "6px";
    h.textContent = "Acesso restrito — Login obrigatório";
    card.appendChild(h);

    var p = document.createElement("div");
    p.style.fontWeight = "800";
    p.style.fontSize = "13px";
    p.style.color = "#6b7280";
    p.style.marginBottom = "12px";
    p.textContent = message || "Entre com usuário e senha para acessar Configurações.";
    card.appendChild(p);

    var uLab = document.createElement("label");
    uLab.style.fontSize = "12px";
    uLab.style.fontWeight = "900";
    uLab.textContent = "Usuário";
    card.appendChild(uLab);

    var uInp = document.createElement("input");
    uInp.type = "text";
    uInp.autocomplete = "username";
    uInp.style.width = "100%";
    uInp.style.boxSizing = "border-box";
    uInp.style.border = "1px solid rgba(0,0,0,.14)";
    uInp.style.borderRadius = "12px";
    uInp.style.padding = "11px 12px";
    uInp.style.margin = "6px 0 10px";
    card.appendChild(uInp);

    var sLab = document.createElement("label");
    sLab.style.fontSize = "12px";
    sLab.style.fontWeight = "900";
    sLab.textContent = "Senha";
    card.appendChild(sLab);

    var sInp = document.createElement("input");
    sInp.type = "password";
    sInp.autocomplete = "current-password";
    sInp.style.width = "100%";
    sInp.style.boxSizing = "border-box";
    sInp.style.border = "1px solid rgba(0,0,0,.14)";
    sInp.style.borderRadius = "12px";
    sInp.style.padding = "11px 12px";
    sInp.style.margin = "6px 0 10px";
    card.appendChild(sInp);

    var msg = document.createElement("div");
    msg.style.display = "none";
    msg.style.marginTop = "8px";
    msg.style.borderRadius = "12px";
    msg.style.padding = "10px 10px";
    msg.style.border = "1px solid rgba(225,29,72,.35)";
    msg.style.background = "rgba(225,29,72,.10)";
    msg.style.fontWeight = "900";
    msg.style.fontSize = "12px";
    card.appendChild(msg);

    var row = document.createElement("div");
    row.style.display = "flex";
    row.style.gap = "10px";
    row.style.marginTop = "12px";

    var btn = document.createElement("button");
    btn.textContent = "Entrar";
    btn.style.flex = "1";
    btn.style.border = "1px solid rgba(47,178,106,.35)";
    btn.style.background = "rgba(47,178,106,.12)";
    btn.style.fontWeight = "900";
    btn.style.borderRadius = "12px";
    btn.style.padding = "10px 12px";
    btn.style.cursor = "pointer";

    var btnClose = document.createElement("button");
    btnClose.textContent = "Cancelar";
    btnClose.style.border = "1px solid rgba(0,0,0,.12)";
    btnClose.style.background = "#fff";
    btnClose.style.fontWeight = "900";
    btnClose.style.borderRadius = "12px";
    btnClose.style.padding = "10px 12px";
    btnClose.style.cursor = "pointer";

    row.appendChild(btn);
    row.appendChild(btnClose);
    card.appendChild(row);

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    function close(){ try{ document.body.removeChild(overlay); }catch(_){ } }

    btnClose.onclick = function(ev){ ev.preventDefault(); close(); };

    async function doLogin(){
      msg.style.display = "none";
      btn.disabled = true;
      try{
        await VSC_AUTH.login(uInp.value, sInp.value);
        close();
        location.reload();
      }catch(e){
        msg.textContent = (e && e.message) ? e.message : String(e);
        msg.style.display = "block";
        btn.disabled = false;
        try{ sInp.focus(); }catch(_){}
      }
    }

    btn.onclick = function(ev){ ev.preventDefault(); doLogin(); };
    sInp.addEventListener("keydown", function(ev){
      if(ev.key === "Enter"){ ev.preventDefault(); doLogin(); }
    });

    setTimeout(function(){ try{ uInp.focus(); }catch(_){ } }, 0);
  }

  // Exige sessão + permissão VIEW
  var curUser = null;
  try{ curUser = await VSC_AUTH.getCurrentUser(); }catch(_){}
  if(!curUser){
    setPill(false, "BLOQUEADO (login)");
    disableSaves(true);
    setMsg("warn", "Acesso restrito: faça login para acessar Configurações.");
    showLoginModal("Somente perfis autorizados (ADMIN/MASTER) acessam este módulo.");
    window.__CONFIG_READY = false;
    window.__CONFIG_LAST_ERROR = "AUTH_REQUIRED";
    return;
  }

  window.__VSC_CFG_CUR_USER_ID = curUser.id || null;
  window.__VSC_CFG_CUR_USERNAME = curUser.username || null;

  try{
await VSC_AUTH.requirePermission(VSC_AUTH.CONST.MODULE_CONFIG, "view");
  }catch(e){
    setPill(false, "BLOQUEADO (sem permissão)");
    disableSaves(true);
    setMsg("danger", "Acesso negado: você não tem permissão para ver Configurações.");
    console.error("[VSC][CFG] ACCESS DENY:", e);
    window.__CONFIG_READY = false;
    window.__CONFIG_LAST_ERROR = "ACCESS_DENIED_VIEW";
    return;
  }

  // Habilita salvar apenas se tiver EDIT
  var canEdit = true;
  try{
await VSC_AUTH.requirePermission(VSC_AUTH.CONST.MODULE_CONFIG, "edit");
    canEdit = true;
  }catch(_){
    canEdit = false;
  }

  // Valida schema (fail-closed)
  try{
var s = await hasStores();
    if(!s.ok){
      setPill(false, "BLOQUEADO (schema ausente)");
      disableSaves(true);
      setMsg("danger",
        "Schema canônico ausente. Necessário criar stores '" + STORE_PARAMS + "' e '" + STORE_AUDIT + "' no IndexedDB (vsc_db)." +
        " Salvar está bloqueado por segurança."
      );
      window.__CONFIG_READY = false;
      window.__CONFIG_LAST_ERROR = "SCHEMA_MISSING";
      return;
    }

    setPill(true, "PRONTO");
    disableSaves(!canEdit);
    if(!canEdit){
      setMsg("warn", "Você tem acesso de leitura. Salvar está bloqueado (sem permissão EDIT).");
    }else{
      setMsg("ok", "Módulo pronto. Schema OK. DB v" + s.dbVersion + ".");
    }

await reloadAudit();
    window.__CONFIG_READY = true;
    window.__CONFIG_LAST_ERROR = undefined;

  }catch(e){
    setPill(false, "BLOQUEADO (erro)");
    disableSaves(true);
    setMsg("danger", "Falha no boot: " + (e && e.message ? e.message : String(e)));
    console.error("[VSC][CFG] boot error:", e);
    window.__CONFIG_READY = false;
    window.__CONFIG_LAST_ERROR = String(e && (e.message||e));
    return;
  }

  // Auto-sugestão (determinística) — salário mínimo vigente se campo vazio
  try{
    var smEl = $("salarioMinimo");
    if(smEl && !String(smEl.value||"").trim()){
      var cents = salarioMinimoVigenteCents(todayYMD());
      if(cents !== null){
        smEl.value = centsToBRL(cents);
      }
    }
  }catch(_){}

  // Sistema / multiusuários
try{ await initSistemaMultiUsuario(curUser, canEdit); }catch(e){ console.warn("[VSC][CFG] initSistema falhou:", e); }

  wireButtons();

  // Auto-carregar vigente (enterprise) para que F5 reflita valores persistidos
  try{ await loadVigenteFinanceiro(true); }catch(e){ /* silencioso */ }
}

  // ========= Self-test (console)
  async function selfTest(){
    var out = {
      build: window.__CONFIG_JS_BUILD,
      hasVSC_DB: !!window.VSC_DB,
      hasOpenDB: !!(window.VSC_DB && typeof window.VSC_DB.openDB === "function"),
      storesOk: false,
      stores: null
    };
    try{
      out.stores = await hasStores();
      out.storesOk = !!(out.stores && out.stores.ok);
    }catch(e){
      out.error = String(e && (e.message||e));
    }
    return out;
  }
  window.VSC_CFG = { selfTest: selfTest };

  // ========= DOM ready
  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

})();
