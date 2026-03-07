/* =====================================================================
VSC — clientes.js (Módulo Clientes) — ERP 2.0.1
Offline-first • IndexedDB (clientes_master) • Outbox (sync_queue)
Conforme PATCH CANÔNICO ÚNICO (AA — Automações Premium)
===================================================================== */

(function(){
  "use strict";

  // -----------------------------
  // Constantes / Config
  // -----------------------------
  var STORE_CLIENTES = "clientes_master";
  var STORE_OUTBOX  = "sync_queue";

  var STATUS = {
    SYNC: "SYNC",
    SALVANDO: "SALVANDO",
    SALVO: "SALVO",
    ERRO: "ERRO"
  };


  // -----------------------------
  // Utilitários base (do legado)
  // -----------------------------
  function uuidv4(){
    // UUID v4 determinístico o suficiente (crypto) com fallback
    if(window.crypto && crypto.getRandomValues){
      var a = new Uint8Array(16);
      crypto.getRandomValues(a);
      a[6] = (a[6] & 0x0f) | 0x40;
      a[8] = (a[8] & 0x3f) | 0x80;
      var s = Array.from(a).map(function(b){ return ("0"+b.toString(16)).slice(-2); }).join("");
      return s.slice(0,8)+"-"+s.slice(8,12)+"-"+s.slice(12,16)+"-"+s.slice(16,20)+"-"+s.slice(20);
    }
    // fallback (menos ideal)
    var d = Date.now();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,function(c){
      var r = (d + Math.random()*16)%16|0;
      d = Math.floor(d/16);
      return (c==="x" ? r : (r&0x3|0x8)).toString(16);
    });
  }

  function onlyDigits(s){ return String(s||"").replace(/\D+/g,""); }

  function clampStr(s, max){
    s = String(s||"").trim();
    if(max && s.length>max) s = s.slice(0,max);
    return s;
  }

  function setText(id, txt){
    var el = document.getElementById(id);
    if(el) el.textContent = txt;
  }

  function showEl(id, on){
    var el = document.getElementById(id);
    if(!el) return;
    el.style.display = on ? "" : "none";
  }

  // -----------------------------
  // Enterprise Floorplan: List Report (lista) + Object Page (detalhe)
  // - Detalhe fica oculto até seleção ou NOVO
  // -----------------------------
  function setDetailVisible(on){
    // on=true  => mostra DETALHE e oculta LISTA
    // on=false => mostra LISTA e oculta DETALHE
    var lv = document.getElementById("clientesListView");
    var dv = document.getElementById("clientesDetailView");
    if(lv) lv.style.display = on ? "none" : "";
    if(dv) dv.style.display = on ? "" : "none";

    // Compat: mantém blocos internos do detalhe (empty vs content)
    var empty = document.getElementById("detailEmpty");
    var cont  = document.getElementById("detailContent");
    if(on){
      // Se não há registro carregado e não está em NOVO, mostra mensagem
      var showEmpty = (!state || (!state.editingId && state.uiMode !== "NOVO"));
      if(empty) empty.style.display = showEmpty ? "" : "none";
      if(cont)  cont.style.display  = showEmpty ? "none" : "";
    }else{
      if(empty) empty.style.display = "";
      if(cont)  cont.style.display  = "none";
    }
  }


  // Toast determinístico (AA-4)
// Toast/snackbar + Modal de confirmação forte (premium)
var toastTimer = null;
var modalTimer = null;

  function ensureMsgModal(){
    var m = document.getElementById("msgModal");
    if(m) return m;

    // cria modal (somente via JS, mínimo diff no HTML)
    m = document.createElement("div");
    m.id = "msgModal";
    m.style.cssText = "display:none; position:fixed; inset:0; z-index:10000;";
    m.innerHTML = ''
      + '<div id="msgBackdrop" style="position:absolute; inset:0; background:rgba(0,0,0,.35);"></div>'
      + '<div style="position:relative; max-width:520px; margin:22vh auto 0; background:#fff; border:1px solid #e5e7eb; border-radius:14px; padding:16px; box-shadow:0 18px 60px rgba(0,0,0,.18);">'
      + '  <div id="msgTitle" style="font-weight:900; font-size:16px;">OK</div>'
      + '  <div id="msgText" style="margin-top:8px; font-size:14px; color:#111827;"></div>'
      + '</div>';

    document.body.appendChild(m);

    // fechar ao clicar no backdrop
    var bd = document.getElementById("msgBackdrop");
    if(bd){
      bd.addEventListener("click", function(){
        hideMsgModal();
      });
    }
    return m;
  }
function confirmModal(title, text){
  return new Promise(function(resolve){
    ensureMsgModal();

    var m = document.getElementById("msgModal");
    var t = document.getElementById("msgTitle");
    var x = document.getElementById("msgText");

    if(t) t.textContent = String(title || "Confirmação");
    if(x) x.textContent = String(text || "");

    // remove timer automático do modal (confirmação não pode sumir sozinha)
    try{
      if(modalTimer){ clearTimeout(modalTimer); modalTimer = null; }
    }catch(_){}

    // cria footer com botões (se não existir)
    var footer = m.querySelector('[data-role="footer"]');
    if(!footer){
      footer = document.createElement("div");
      footer.setAttribute("data-role","footer");
      footer.style.cssText = "display:flex; justify-content:flex-end; gap:8px; margin-top:14px;";
      // card interno do modal (onde ficam título e texto)
      var card = m.querySelector("div[style*='max-width']");
      if(card) card.appendChild(footer);
      else m.appendChild(footer);
    }
    footer.innerHTML = "";

    var btnCancel = document.createElement("button");
    btnCancel.className = "btn";
    btnCancel.type = "button";
    btnCancel.textContent = "Cancelar";

    var btnOk = document.createElement("button");
    btnOk.className = "btn btnPrimary";
    btnOk.type = "button";
    btnOk.textContent = "Confirmar";

    footer.appendChild(btnCancel);
    footer.appendChild(btnOk);

    function done(v){
      try{ m.style.display = "none"; }catch(_){}
      resolve(!!v);
    }

    btnCancel.addEventListener("click", function(){ done(false); });
    btnOk.addEventListener("click", function(){ done(true); });

    // abre e foca no seguro
    m.style.display = "block";
    setTimeout(function(){ try{ btnCancel.focus(); }catch(_){ } }, 0);
  });
}

  function showMsgModal(title, text, ms){
    ensureMsgModal();
    var m = document.getElementById("msgModal");
    var t = document.getElementById("msgTitle");
    var x = document.getElementById("msgText");
    if(t) t.textContent = String(title || "OK");
    if(x) x.textContent = String(text || "");

    if(modalTimer){ clearTimeout(modalTimer); modalTimer = null; }
    m.style.display = "block";

    modalTimer = setTimeout(function(){
      hideMsgModal();
    }, (typeof ms === "number" ? ms : 2000));
  }

  function hideMsgModal(){
    var m = document.getElementById("msgModal");
    if(!m) return;
    m.style.display = "none";
    if(modalTimer){ clearTimeout(modalTimer); modalTimer = null; }
  }

  function toast(msg, kind, strong){
    // strong=true -> modal forte + snackbar
    var el = document.getElementById("toast");
    if(el){
      if(toastTimer) { clearTimeout(toastTimer); toastTimer=null; }
      el.style.display = "block";
      el.textContent = String(msg||"");
      el.setAttribute("data-kind", kind||"info");
      toastTimer = setTimeout(function(){
        el.style.display = "none";
        el.textContent = "";
        el.removeAttribute("data-kind");
      }, 2200);
    }

    if(strong){
      var title = (kind === "error") ? "Erro" :
                  (kind === "warn")  ? "Atenção" : "Sucesso";
      showMsgModal(title, String(msg||""), 2000);
    }
  }

  // Badge (AA-4)
  function setSyncBadge(label, cssClass){
    var b = document.getElementById("syncBadge");
    if(!b) return;
    b.textContent = label;
    // remove classes conhecidas
    b.classList.remove("b-off","b-on","b-warn","b-err","b-sync");
    if(cssClass) b.classList.add(cssClass);
  }
  
    // -----------------------------
  // IndexedDB — abertura CANÔNICA (VSC_DB)
  // Fonte única de versão/esquema: vsc_db.js
  // -----------------------------
  function openDb(){
    return new Promise(function(resolve, reject){
      try{
        if(!window.VSC_DB || typeof window.VSC_DB.openDB !== "function"){
          reject(new Error("VSC_DB ausente. Banco canônico não disponível."));
          return;
        }
        Promise.resolve()
          .then(function(){ return window.VSC_DB.openDB(); })
          .then(function(db){ resolve(db); })
          .catch(function(err){ reject(err || new Error("Falha ao abrir VSC_DB")); });
      }catch(e){
        reject(e);
      }
    });
  }

  // -----------------------------
  // IndexedDB — wrapper mínimo (TX / CRUD usando db já aberto)
  // -----------------------------
  function txp(db, storeName, mode, fn){
    return new Promise(function(resolve, reject){
      try{
        var tx = db.transaction(storeName, mode);
        var st = tx.objectStore(storeName);
        var out = fn(st, tx);
        tx.oncomplete = function(){ resolve(out); };
        tx.onerror = function(){ reject(tx.error || new Error("Falha TX")); };
        tx.onabort = function(){ reject(tx.error || new Error("TX abortada")); };
      }catch(e){ reject(e); }
    });
  }

  function getAll(db, storeName){
    return txp(db, storeName, "readonly", function(st){
      return new Promise(function(resolve, reject){
        var r = st.getAll();
        r.onsuccess = function(){ resolve(r.result || []); };
        r.onerror = function(){ reject(r.error); };
      });
    });
  }

  function getById(db, storeName, id){
    return txp(db, storeName, "readonly", function(st){
      return new Promise(function(resolve, reject){
        var r = st.get(id);
        r.onsuccess = function(){ resolve(r.result || null); };
        r.onerror = function(){ reject(r.error); };
      });
    });
  }

  function put(db, storeName, obj){
    return txp(db, storeName, "readwrite", function(st){
      return new Promise(function(resolve, reject){
        var r = st.put(obj);
        r.onsuccess = function(){ resolve(obj); };
        r.onerror = function(){ reject(r.error); };
      });
    });
  }

  // Outbox: registra evento determinístico (AA-6)
  
  function delById(db, storeName, id){
    return txp(db, storeName, "readwrite", function(st){
      return new Promise(function(resolve, reject){
        try{
          var r = st.delete(String(id));
          r.onsuccess = function(){ resolve(true); };
          r.onerror = function(){ reject(r.error || new Error("Falha ao excluir")); };
        }catch(e){ reject(e); }
      });
    });
  }

function outboxEnqueue(db, entity, entityId, action, payload){
    var now = Date.now();
    var evt = {
      id: uuidv4(),
      entity: String(entity),
      entity_id: String(entityId),
      action: String(action),
      payload: payload || {},
      status: "PENDING",
      created_at: now,
      updated_at: now
    };
    return put(db, STORE_OUTBOX, evt);
  }

  function countPendingOutbox(db){
    return new Promise(function(resolve, reject){
      try{
        var tx = db.transaction(STORE_OUTBOX, "readonly");
        var st = tx.objectStore(STORE_OUTBOX);
        // OBS: o índice canônico em vsc_db.js chama "status"
        // (vamos ajustar no 2/4 para ficar 100% canônico)
        var idx = st.index("status");
        var range = IDBKeyRange.only("PENDING");
        var c = 0;
        var req = idx.openCursor(range);
        req.onsuccess = function(){
          var cur = req.result;
          if(cur){ c++; cur.continue(); return; }
          resolve(c);
        };
        req.onerror = function(){ reject(req.error); };
      }catch(e){ reject(e); }
    });
  }
  // -----------------------------
  // Normalização / Validação
  // -----------------------------
  function normNome(s){
    s = String(s||"").trim();
    s = s.normalize ? s.normalize("NFD").replace(/[\u0300-\u036f]/g,"") : s;
    return s.toLowerCase();
  }

  function validaCPF(cpf){
    cpf = onlyDigits(cpf);
    if(cpf.length !== 11) return false;
    if(/^(\d)\1+$/.test(cpf)) return false;
    var sum=0, i=0;
    for(i=0;i<9;i++) sum += parseInt(cpf.charAt(i),10)*(10-i);
    var d1 = 11 - (sum % 11); if(d1>=10) d1=0;
    if(d1 !== parseInt(cpf.charAt(9),10)) return false;
    sum=0;
    for(i=0;i<10;i++) sum += parseInt(cpf.charAt(i),10)*(11-i);
    var d2 = 11 - (sum % 11); if(d2>=10) d2=0;
    return d2 === parseInt(cpf.charAt(10),10);
  }

  function validaCNPJ(cnpj){
    cnpj = onlyDigits(cnpj);
    if(cnpj.length !== 14) return false;
    if(/^(\d)\1+$/.test(cnpj)) return false;
    var t = cnpj.length - 2;
    var d = cnpj.substring(t);
    var d1 = parseInt(d.charAt(0),10);
    var d2 = parseInt(d.charAt(1),10);
    var calc = function(x){
      var n = cnpj.substring(0, x);
      var y = x - 7;
      var sum = 0;
      var i = 0;
      for(i=x; i>=1; i--){
        sum += parseInt(n.charAt(x - i),10) * y--;
        if(y < 2) y = 9;
      }
      var r = 11 - (sum % 11);
      return (r > 9) ? 0 : r;
    };
    return calc(t) === d1 && calc(t+1) === d2;
  }

  function docValido(doc){
    var d = onlyDigits(doc);
    if(!d) return true; // doc é opcional
    if(d.length === 11) return validaCPF(d);
    if(d.length === 14) return validaCNPJ(d);
    return false;
  }

  function validaUF(uf){
    uf = String(uf||"").trim().toUpperCase();
    if(!uf) return true;
    return /^[A-Z]{2}$/.test(uf);
  }

  function showErr(errId, on){
  var e = document.getElementById(errId);
  if(!e) return;
  if(on) e.classList.add("show");
  else e.classList.remove("show");
}

function markInvalid(el, on){
  if(!el) return;
  if(on) el.classList.add("is-invalid");
  else el.classList.remove("is-invalid");
}

// ============================================================
// FIORI-LIKE: Dirty-state detection (alterações pendentes)
// - snapshot do "form normalizado" (somente campos do readForm)
// - comparação determinística
// ============================================================
function snapshotFromForm(){
  // snapshot baseado nos dados do formulário (readForm), sem campos voláteis
  var f = readForm();
  // normaliza trims básicos para reduzir falso-positivo
  try{
    f.nome = String(f.nome||"").trim();
    f.doc  = String(f.doc||"").trim();
    f.telefone = String(f.telefone||"").trim();
    f.email = String(f.email||"").trim();
    f.uf = String(f.uf||"").trim().toUpperCase();
  }catch(_){}
  return f;
}

function sameSnapshot(a,b){
  try{
    return JSON.stringify(a||null) === JSON.stringify(b||null);
  }catch(_){
    return false;
  }
}

function setDirty(on){
  state.dirty = !!on;
  var pill = document.getElementById("dirtyPill");
  if(pill) pill.style.display = state.dirty ? "" : "none";
}

function refreshDirty(){
  // Só faz sentido quando está EDITANDO um registro existente
  if(state.uiMode !== "EDIT" || !state.editingId){
    setDirty(false);
    return false;
  }

  var cur = snapshotFromForm();
  var isDirty = !sameSnapshot(cur, state.snapshot);
  setDirty(isDirty);
  return isDirty;
}

  function setSaveEnabled(on){
    var b = document.getElementById("btnSalvar");
    if(b) b.disabled = !on;
  }

  // -----------------------------
  // Estado do módulo
  // -----------------------------
  var state = {
    db: null,
    editingId: null,
    selectedId: null,          // FIORI-like: item ativo no Master
    uiMode: "NOVO",
    showInativos: false,
    q: "",
    lastList: [],
    pendingCount: 0,

    // FIORI-like: dirty-state detection
    dirty: false,
    snapshot: null
  };

  function setFormReadonly(readonly){
  var frm = document.getElementById("frm");
  if(!frm) return;

  var els = frm.querySelectorAll("input, select, textarea");
  for(var i=0;i<els.length;i++){
    // mantém checkbox whatsapp respeitando modo
    if(readonly){
      els[i].setAttribute("disabled","disabled");
    }else{
      els[i].removeAttribute("disabled");
    }
  }

  // salvar só pode quando não está em VIEW
  var b = document.getElementById("btnSalvar");
  if(b) b.disabled = readonly;
}

function setEditState(mode){
  // mode: "NOVO" | "VIEW" | "EDIT"
  state.uiMode = mode;

  var badge = document.getElementById("editStateBadge");
  var txt   = document.getElementById("editStateText");

  // Modo enterprise inicial: LISTA (sem detalhe visível)
  if(mode === "EMPTY"){
    setDetailVisible(false);
    if(badge){
      badge.textContent = "LISTA";
      badge.classList.remove("b-ok","b-warn");
      badge.classList.add("b-off");
    }
    if(txt) txt.textContent = "Selecione um cliente na lista ou clique em NOVO.";
    setFormReadonly(true);

    // Botões: nada de edição/salvar em modo LISTA
    var bEdit0 = document.getElementById("btnEditar");
    if(bEdit0) bEdit0.style.display = "none";
    var bSalvar0 = document.getElementById("btnSalvar");
    if(bSalvar0) bSalvar0.disabled = true;

    var bEditTop0 = document.getElementById("btnEditarTop");
    if(bEditTop0) bEditTop0.style.display = "none";
    var bSalvarTop0 = document.getElementById("btnSalvarTop");
    if(bSalvarTop0) bSalvarTop0.disabled = true;
    var bCancelTop0 = document.getElementById("btnCancelarTop");
    if(bCancelTop0) bCancelTop0.disabled = true;

    setDirty(false);

    var rel0 = document.getElementById("relGrid");
    if(rel0) rel0.style.display = "none";

    return;
  }

  // Qualquer outro modo mostra o detalhe
  setDetailVisible(true);


  if(mode === "VIEW"){
    if(badge){
      badge.textContent = "VISUALIZAÇÃO";
      badge.classList.remove("b-ok","b-warn");
      badge.classList.add("b-off");
    }
    if(txt) txt.textContent = "Modo: Visualização (somente leitura)";
    setFormReadonly(true);
          // Mostra botão EDITAR (ação consciente) se existir no HTML
    var bEdit = document.getElementById("btnEditar");
    if(bEdit) bEdit.style.display = "";
    var bSalvar = document.getElementById("btnSalvar");
    if(bSalvar) bSalvar.disabled = true;
    // FIORI-like: ações no topo do Detail
    var bEditTop = document.getElementById("btnEditarTop");
    if(bEditTop) bEditTop.style.display = "";
    var bSalvarTop = document.getElementById("btnSalvarTop");
    if(bSalvarTop) bSalvarTop.disabled = true;
    var bCancelTop = document.getElementById("btnCancelarTop");
    if(bCancelTop) bCancelTop.disabled = false;

    // Em VIEW não existe "dirty"
    setDirty(false);

var rel = document.getElementById("relGrid");
if(rel){
  // Só mostra relacionados se existe cliente selecionado
  rel.style.display = state.editingId ? "grid" : "none";
}

    return;
  }

  if(mode === "EDIT"){
    if(badge){
      badge.textContent = "EDITANDO";
      badge.classList.remove("b-off","b-warn");
      badge.classList.add("b-ok");
    }
    if(txt) txt.textContent = "Modo: Editando cliente";
    setFormReadonly(false);
    validateForm();

    // Oculta botão EDITAR durante edição (já está editando)
    var bEdit2 = document.getElementById("btnEditar");
    if(bEdit2) bEdit2.style.display = "none";

    // FIORI-like: topo
    var bEditTop2 = document.getElementById("btnEditarTop");
    if(bEditTop2) bEditTop2.style.display = "none";
    var bSalvarTop2 = document.getElementById("btnSalvarTop");
    if(bSalvarTop2) bSalvarTop2.disabled = false;
    var bCancelTop2 = document.getElementById("btnCancelarTop");
    if(bCancelTop2) bCancelTop2.disabled = false;

    // Snapshot base da edição (dirty-state)
    state.snapshot = snapshotFromForm();
    setDirty(false);

    return;

  }

  // NOVO (padrão)
  if(badge){
    badge.textContent = "NOVO";
    badge.classList.remove("b-ok","b-warn");
    badge.classList.add("b-off");
  }
  if(txt) txt.textContent = "Modo: Criando novo cliente";
  setFormReadonly(false);
      // Novo também não precisa do botão EDITAR
  var bEdit3 = document.getElementById("btnEditar");
  if(bEdit3) bEdit3.style.display = "none";
  validateForm();
  // FIORI-like: topo em NOVO
  var bEditTop3 = document.getElementById("btnEditarTop");
  if(bEditTop3) bEditTop3.style.display = "none";
  var bSalvarTop3 = document.getElementById("btnSalvarTop");
  if(bSalvarTop3) bSalvarTop3.disabled = false;
  var bCancelTop3 = document.getElementById("btnCancelarTop");
  if(bCancelTop3) bCancelTop3.disabled = false;

  state.snapshot = snapshotFromForm();
  setDirty(false);

}
  // -----------------------------
  // Status / Badges (premium, determinístico)
  // -----------------------------
  
  function isOnline(){
    try{ return !!navigator.onLine; }catch(_){ return false; }
  }

  function updateStatusBadge(status){
    var badge = document.getElementById("syncBadge");
    if(!badge) return;

    // Offline sempre domina (fail-closed)
    if(!isOnline()){
      badge.textContent = "OFFLINE";
      badge.classList.remove("b-ok","b-warn");
      badge.classList.add("b-off");
      badge.title = "Sem conexão";
      return;
    }

    // Online + sem status especial
    if(!status){
      badge.textContent = "ONLINE";
      badge.classList.remove("b-off","b-warn");
      badge.classList.add("b-ok");
      badge.title = "Conectado";
      return;
    }

    // Status especiais (não silencioso)
    if(status === STATUS.SYNC){
      badge.textContent = "SYNC...";
      badge.classList.remove("b-off","b-ok");
      badge.classList.add("b-warn");
      badge.title = "Sincronização solicitada";
      return;
    }

    if(status === STATUS.SALVANDO){
      badge.textContent = "SALVANDO...";
      badge.classList.remove("b-off","b-ok");
      badge.classList.add("b-warn");
      badge.title = "Persistindo no vsc_db";
      return;
    }

    if(status === STATUS.SALVO){
      badge.textContent = "OK";
      badge.classList.remove("b-off","b-warn");
      badge.classList.add("b-ok");
      badge.title = "Operação concluída";
      return;
    }

    if(status === STATUS.ERRO){
      badge.textContent = "ERRO";
      badge.classList.remove("b-off","b-ok");
      badge.classList.add("b-warn");
      badge.title = "Falha (ver console)";
      return;
    }
  }

  // -----------------------------
  // Pending count (sync_queue) — determinístico, sem depender de externo
  // -----------------------------
  function refreshPendingCount(){
    // Atualiza badge sem inventar UI nova (mínimo diff)
    if(!state || !state.db) return Promise.resolve(0);

    return new Promise(function(resolve, reject){
      try{
        var tx = state.db.transaction("sync_queue", "readonly");
        var st = tx.objectStore("sync_queue");

        var idx = st.indexNames && st.indexNames.contains("status") ? st.index("status") : null;
        var req = idx ? idx.openCursor(IDBKeyRange.only("PENDING")) : st.openCursor();

        var count = 0;

        req.onsuccess = function(ev){
          var cur = ev.target.result;
          if(!cur){
            // Badge: se tiver pendência, mostra PEND:n (premium)
            try{
              if(isOnline()){
                var b = document.getElementById("syncBadge");
                if(b){
                  if(count > 0){
                    b.textContent = "PEND: " + count;
                    b.classList.remove("b-off","b-ok");
                    b.classList.add("b-warn");
                    b.title = "Pendências na fila de sync_queue";
                  }else{
                    updateStatusBadge(); // ONLINE
                  }
                }
              }else{
                updateStatusBadge(); // OFFLINE
              }
            }catch(_){}

            resolve(count);
            return;
          }

          var v = cur.value;

          // Se não usamos índice, filtramos manualmente
          if(!idx){
            if(v && v.status === "PENDING") count++;
          }else{
            count++;
          }

          cur.continue();
        };

        req.onerror = function(){
          resolve(0); // fail-closed: não quebra o boot por badge
        };
      }catch(e){
        resolve(0);
      }
    });
  }

  // -----------------------------
  // Montagem/extração do form
  // -----------------------------
  function el(id){ return document.getElementById(id); }

  function readForm(){
    var o = {};
    o.tipo = (el("tipo") && el("tipo").value) ? el("tipo").value : "PF";
    o.nome = clampStr(el("nome") && el("nome").value, 120);
    o.doc  = clampStr(el("doc") && el("doc").value, 30);
    o.fantasia = clampStr(el("fantasia") && el("fantasia").value, 120);
    o.status = (el("status") && el("status").value) ? el("status").value : "ATIVO";

    o.telefone = clampStr(el("tel") && el("tel").value, 30);
    o.email = clampStr(el("email") && el("email").value, 120);
    o.whatsapp = !!(el("whatsapp") && el("whatsapp").checked);

    o.cep = clampStr(el("cep") && el("cep").value, 12);
    o.logradouro = clampStr(el("logradouro") && el("logradouro").value, 120);
    o.numero = clampStr(el("numero") && el("numero").value, 30);
    o.complemento = clampStr(el("complemento") && el("complemento").value, 120);
    o.bairro = clampStr(el("bairro") && el("bairro").value, 120);
    o.cidade = clampStr(el("cidade") && el("cidade").value, 80);
    o.uf = clampStr(el("uf") && el("uf").value, 2).toUpperCase();
    o.ibge = clampStr(el("ibge") && el("ibge").value, 20);

    o.prazo_dias = parseInt((el("prazo_dias") && el("prazo_dias").value) ? el("prazo_dias").value : "0", 10);
    if(isNaN(o.prazo_dias) || o.prazo_dias < 0) o.prazo_dias = 0;

    o.limite_credito = clampStr(el("limite_credito") && el("limite_credito").value, 30);

    o.obs = clampStr(el("obs") && el("obs").value, 2000);
    return o;
  }

  function fillForm(c){
    if(!c) c = {};
    if(el("tipo")) el("tipo").value = c.tipo || "PF";
    if(el("nome")) el("nome").value = c.nome || "";
    if(el("doc")) el("doc").value = c.doc || "";
    if(el("fantasia")) el("fantasia").value = c.fantasia || "";
    if(el("status")) el("status").value = c.status || "ATIVO";

    if(el("tel")) el("tel").value = c.telefone || "";
    if(el("email")) el("email").value = c.email || "";
    if(el("whatsapp")) el("whatsapp").checked = (c.whatsapp !== false);

    if(el("cep")) el("cep").value = c.cep || "";
    if(el("logradouro")) el("logradouro").value = c.logradouro || "";
    if(el("numero")) el("numero").value = c.numero || "";
    if(el("complemento")) el("complemento").value = c.complemento || "";
    if(el("bairro")) el("bairro").value = c.bairro || "";
    if(el("cidade")) el("cidade").value = c.cidade || "";
    if(el("uf")) el("uf").value = (c.uf || "").toUpperCase();
    if(el("ibge")) el("ibge").value = c.ibge || "";

    if(el("prazo_dias")) el("prazo_dias").value = (typeof c.prazo_dias === "number") ? String(c.prazo_dias) : "0";
    if(el("limite_credito")) el("limite_credito").value = c.limite_credito || "0,00";



    if(el("obs")) el("obs").value = c.obs || "";
  }

  function validateForm(){
  var f = readForm();

  var okNome = !!String(f.nome||"").trim();
  var okDoc  = docValido(f.doc);
  var okUf   = validaUF(f.uf);

  // Regra premium: pelo menos 1 canal de contato
  var telDigits = onlyDigits(f.telefone);
  var hasTel = telDigits.length >= 8;
  var hasEmail = !!String(f.email||"").trim();
  var okContato = hasTel || hasEmail;

  // borda vermelha
  markInvalid(el("nome"), !okNome);
  markInvalid(el("doc"), !okDoc);
  markInvalid(el("uf"), !okUf);

  // mensagens textuais (HTML já tem err_nome/err_doc/err_uf)
  showErr("err_nome", !okNome);
  showErr("err_doc", !okDoc);
  showErr("err_uf", !okUf);

  // contato mínimo
  showErr("err_contato", !okContato);
// FIORI-like: mensagem sempre como "OU" (nunca "E")
try{
  var ec = document.getElementById("err_contato");
  if(ec) ec.textContent = "Informe Telefone OU E-mail para contato.";
}catch(_){}

  markInvalid(el("tel"), !okContato && !hasEmail);
  markInvalid(el("email"), !okContato && !hasTel);

  var ok = okNome && okDoc && okUf && okContato;
  setSaveEnabled(ok);
  return ok;
}

  
  // -----------------------------
  // KPI Strip (igual ao módulo Animais)
  // - Total / Ativos / Inativos / Com Documento (CPF/CNPJ)
  // -----------------------------
  function refreshKpis(all){
    try{
      all = all || [];
      var total = all.length;

      var ativos = 0, inativos = 0, comDoc = 0;

      for(var i=0;i<all.length;i++){
        var c = all[i] || {};
        if(String(c.status||"ATIVO") === "INATIVO") inativos++;
        else ativos++;

        var dd = String(c.doc_digits || onlyDigits(c.doc) || "");
        if(dd.length === 11 || dd.length === 14) comDoc++;
      }

      setText("kpiCliTotal", String(total));
      setText("kpiCliAtivos", String(ativos));
      setText("kpiCliInativos", String(inativos));
      setText("kpiCliDoc", String(comDoc));
    }catch(_){}
  }

// -----------------------------
  // Render da lista (AA-3)
  // -----------------------------
  function escapeHtml(s){
    return String(s||"")
      .replace(/&/g,"&amp;")
      .replace(/</g,"&lt;")
      .replace(/>/g,"&gt;")
      .replace(/"/g,"&quot;")
      .replace(/'/g,"&#39;");
  }
  function formatBRPhone(value){
  // Normaliza para dígitos
  const d = String(value ?? "").replace(/\D/g, "");
  if(!d) return "";

  // Limita a 11 dígitos (DD + 9)
  const x = d.slice(0, 11);

  // Se tiver menos que 3 dígitos, retorna como está (evita "travamento" na digitação)
  if(x.length < 3) return x;

  const ddd = x.slice(0,2);
  const rest = x.slice(2);

  // 11 dígitos: (DD) 9XXXX-XXXX
  if(rest.length >= 9){
    const p1 = rest.slice(0,5);
    const p2 = rest.slice(5,9);
    return `(${ddd}) ${p1}-${p2}`;
  }

  // 10 dígitos: (DD) XXXX-XXXX
  if(rest.length >= 8){
    const p1 = rest.slice(0,4);
    const p2 = rest.slice(4,8);
    return `(${ddd}) ${p1}-${p2}`;
  }

  // Parcial (enquanto digita)
  return `(${ddd}) ${rest}`;
}

  function renderList(rows){
    var wrap = el("list");
    if(!wrap) return;

    if(!rows || rows.length === 0){
      wrap.innerHTML = '<div style="padding:12px; opacity:.75;">Nenhum cliente encontrado.</div>';
      return;
    }

    var html = "";
    for(var i=0;i<rows.length;i++){
      var c = rows[i];
      var inactive = (c.status === "INATIVO");

      var badge = inactive
        ? '<span style="font-size:12px; font-weight:700; opacity:.8;">INATIVO</span>'
        : '<span style="font-size:12px; font-weight:700; opacity:.8;">ATIVO</span>';

      var btnReativar = inactive
        ? '<button class="btn btn-sm" data-act="reativar" data-id="'+escapeHtml(c.id)+'">Reativar</button>'
        : '';

      var btnInativar = (!inactive)
        ? '<button class="btn btn-sm" data-act="inativar" data-id="'+escapeHtml(c.id)+'">Inativar</button>'
        : '';

      var activeCls = (state.selectedId && c.id === state.selectedId) ? " is-active" : "";
      html += ''
  + '<div class="card'+activeCls+'" data-act="editar" data-id="'+escapeHtml(c.id)+'" style="margin:8px 0; padding:10px 12px; border-radius:12px; cursor:pointer;">'

        + '  <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">'
        + '    <div style="min-width:0;">'
        + '      <div style="font-weight:800;">'+escapeHtml(c.nome||"")+'</div>'
        + '      <div style="opacity:.85; font-size:13px; margin-top:2px;">'
        +          (c.doc ? ('Doc: '+escapeHtml(c.doc)) : 'Sem documento')
        +          (c.telefone ? (' • Tel: '+escapeHtml(c.telefone)) : '')
        +          (c.email ? (' • '+escapeHtml(c.email)) : '')
        + '      </div>'
        + '      <div style="opacity:.8; font-size:13px; margin-top:2px;">'
        +          (c.cidade ? escapeHtml(c.cidade) : '')
        +          (c.uf ? ('/'+escapeHtml(c.uf)) : '')
        + '      </div>'
        + '      <div style="opacity:.75; font-size:12px; margin-top:6px;">'+badge+'</div>'
        + '    </div>'
        + '    <div style="display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end;">'
        + '      <button class="btn btn-sm" data-act="editar" data-id="'+escapeHtml(c.id)+'">Abrir</button>'
        +        btnInativar
        +        btnReativar
        + '    </div>'
        + '  </div>'
        + '</div>';
    }

    wrap.innerHTML = html;
  }

  function applyFilters(all){
  var showInativos = !!state.showInativos;
  var q = normNome(state.q || "");
  var qDigits = onlyDigits(state.q || "");
  var out = [];

  for(var i=0;i<all.length;i++){
    var c = all[i];

    var inactive = (c.status === "INATIVO");

    if(showInativos){
      if(!inactive) continue;
    } else {
      if(inactive) continue;
    }

    if(q){
      var hayText = (c.nome_norm || "") + " " +
                    normNome(c.telefone||"") + " " +
                    normNome(c.email||"") + " " +
                    normNome(c.cidade||"") + " " +
                    normNome(c.uf||"");

      var okText = hayText.indexOf(q) !== -1;

      var okDigits = false;
      if(qDigits){
        var docd = String(c.doc_digits || "");
        var teld = onlyDigits(c.telefone || "");
        okDigits = (docd.indexOf(qDigits) !== -1) || (teld.indexOf(qDigits) !== -1);
      }

      if(!okText && !okDigits) continue;
    }

    out.push(c);
  }

  return out;
}
// -----------------------------
// Recarregar lista (fonte única: IndexedDB clientes_master)
// - mantém state.lastList em memória
// - aplica filtros (state.q / state.showInativos)
// - renderiza no #list (Master à esquerda)
// -----------------------------
function reloadList(){
  if(!state.db){
    try{ renderList([]); }catch(_){}
    return Promise.resolve([]);
  }

  return getAll(state.db, STORE_CLIENTES).then(function(all){
    all = all || [];

    // ordenação enterprise estável: nome_norm, depois nome, depois created_at
    all.sort(function(a,b){
      var an = String((a && a.nome_norm) || "").toLowerCase();
      var bn = String((b && b.nome_norm) || "").toLowerCase();
      if(an < bn) return -1;
      if(an > bn) return  1;

      var a2 = String((a && a.nome) || "").toLowerCase();
      var b2 = String((b && b.nome) || "").toLowerCase();
      if(a2 < b2) return -1;
      if(a2 > b2) return  1;

      var ac = (a && a.created_at) ? a.created_at : 0;
      var bc = (b && b.created_at) ? b.created_at : 0;
      return ac - bc;
    });

    state.lastList = all;
    refreshKpis(all);
// FIORI-like: se selectedId existe, garante que ele ainda está na lista
// (se foi filtrado/inativado, highlight desaparece naturalmente)
try{
  if(state.selectedId){
    // nada a fazer aqui além de preservar; renderList já aplica .is-active
  }
}catch(_){}

    var rows = applyFilters(all);
    renderList(rows);

    return rows;
  }).catch(function(){
    // fail-closed: não quebra boot, só mostra vazio + toast
    try{ renderList([]); }catch(_){}
    toast("Falha ao carregar lista de clientes.", "error");
    return [];
  });
}
 
  // -----------------------------
  // Persistência (Upsert) + Outbox (AA-6)
  // (Neste módulo: mantém compat, mas usa VSC_DB como fonte do DB)
  // -----------------------------
  function buildClienteForSave(form){
    var now = Date.now();
    var id = state.editingId || uuidv4();

    var docDigits = onlyDigits(form.doc);
    var obj = {
      id: id,
      tipo: form.tipo || "PF",
      nome: form.nome,
      nome_norm: normNome(form.nome),
      doc: form.doc ? form.doc : "",
      doc_digits: docDigits || "",
      fantasia: form.fantasia || "",
      telefone: form.telefone || "",
      email: form.email || "",
      whatsapp: (form.whatsapp !== false),

      cep: form.cep || "",
      logradouro: form.logradouro || "",
      numero: form.numero || "",
      complemento: form.complemento || "",
      bairro: form.bairro || "",
      cidade: form.cidade || "",
      uf: (form.uf || "").toUpperCase(),
      ibge: form.ibge || "",

      prazo_dias: (typeof form.prazo_dias === "number") ? form.prazo_dias : 0,
      limite_credito: form.limite_credito || "0,00",

      obs: form.obs || "",

      status: (form.status || "ATIVO"),

            created_at: 0, // será definido apenas no CREATE (imutável)
      updated_at: now,
      last_sync: 0
    };
    return obj;
  }

  function mergeForUpdate(oldObj, newObj){
    var now = Date.now();
    var out = Object.assign({}, oldObj || {});
    // created_at imutável:
    // - UPDATE: preserva o created_at antigo
    // - CREATE: define created_at agora
    if(out && out.created_at){
      newObj.created_at = out.created_at;
    }else{
      newObj.created_at = now;
    }

    // editar não reativa automaticamente
    if(out.status === "INATIVO") newObj.status = "INATIVO";

    out = Object.assign(out, newObj);
    out.updated_at = now;
    return out;
  }

  function saveCliente(){
    if(!state.db){
      toast("Banco offline indisponível (vsc_db).", "error");
      return Promise.resolve(false);
    }
    if(state.uiMode === "VIEW"){
  toast("Operação bloqueada: clique em EDITAR para modificar.", "warn", true);
  // modal forte (nunca silencioso)
  showMsgModal("Bloqueado", "Você está em VISUALIZAÇÃO. Clique em EDITAR para liberar alterações.", 2400);
  return Promise.resolve(false);
}

    if(!validateForm()){
  toast("Corrija os campos marcados antes de salvar.", "warn", true);

  // mensagem determinística do motivo principal
  var reasons = [];
  try{
    if(document.getElementById("err_nome")?.classList.contains("show")) reasons.push("Nome/Razão Social obrigatório.");
    if(document.getElementById("err_doc")?.classList.contains("show")) reasons.push("CPF/CNPJ inválido.");
    if(document.getElementById("err_uf")?.classList.contains("show")) reasons.push("UF inválida.");
    if(document.getElementById("err_contato")?.classList.contains("show")) reasons.push("Informe Telefone OU E-mail.");
  }catch(_){}
  var msg = reasons.length ? reasons.join(" ") : "Campos inválidos.";

  showMsgModal("Não foi possível salvar", msg, 2600);
// Foco automático no primeiro erro (contato)
setTimeout(function(){
  try{
    if(document.getElementById("err_contato")?.classList.contains("show")){
      var tel = document.getElementById("tel");
      var email = document.getElementById("email");
      if(tel && !String(tel.value||"").trim()) return tel.focus();
      if(email) return email.focus();
    }
  }catch(_){}
}, 0);
  
return Promise.resolve(false);
}


    updateStatusBadge(STATUS.SALVANDO);
    toast("Salvando...", "info");

    var form = readForm();
    var base = buildClienteForSave(form);

    return getById(state.db, STORE_CLIENTES, base.id).then(function(old){
      var obj = mergeForUpdate(old, base);

      return put(state.db, STORE_CLIENTES, obj).then(function(){
        return outboxEnqueue(state.db, "clientes", obj.id, (old ? "UPSERT" : "CREATE"), {
          id: obj.id,
          updated_at: obj.updated_at
        });
      }).then(function(){
        state.editingId = obj.id;
state.selectedId = obj.id; // FIORI-like: mantém highlight no Master após salvar
        setEditState("VIEW");
var rel = document.getElementById("relGrid");
if(rel) rel.style.display = "grid";
        toast("Cliente salvo com sucesso.", "success", true);
        updateStatusBadge(STATUS.SALVO);
        return refreshPendingCount().then(function(){ return reloadList(); }).then(function(){ return true; });
      });
    }).catch(function(){
      updateStatusBadge(STATUS.ERRO);
      toast("Erro ao salvar. Operação bloqueada.", "error");
      return false;
    }).finally(function(){
      updateStatusBadge();
    });
  }

  function setClienteStatus(id, newStatus){
    if(!state.db || !id) return Promise.resolve(false);

    return getById(state.db, STORE_CLIENTES, id).then(function(c){
      if(!c) return false;
      if(c.status === newStatus) return true;

      var now = Date.now();
      c.status = newStatus;
      c.updated_at = now;

      return put(state.db, STORE_CLIENTES, c).then(function(){
        return outboxEnqueue(state.db, "clientes", c.id, (newStatus==="INATIVO" ? "INATIVAR" : "REATIVAR"), {
          id: c.id,
          status: c.status,
          updated_at: c.updated_at
        });
      }).then(function(){
        toast((newStatus==="INATIVO" ? "Cliente inativado." : "Cliente reativado.") , "success");
        return refreshPendingCount().then(function(){ return reloadList(); }).then(function(){ return true; });
      });
    }).catch(function(){
      toast("Falha ao atualizar status.", "error");
      return false;
    }).finally(function(){
      updateStatusBadge();
    });
  }

    // -----------------------------
  // Sync (botão “Sincronizar agora”) — fail-closed
  // -----------------------------
  
  function syncNow(){
    updateStatusBadge(STATUS.SYNC);

    return refreshPendingCount().then(function(){
      if(!isOnline()){
        toast("Offline. Sincronização bloqueada.", "warn", true);
        updateStatusBadge();
        return false;
      }

      // Compatibilidade: hook legado, se existir
      if(typeof window.VSC_SYNC_NOW === "function"){
        return Promise.resolve()
          .then(function(){ return window.VSC_SYNC_NOW(); })
          .then(function(){
            toast("Sincronização iniciada.", "success");
            return refreshPendingCount();
          })
          .then(function(){ return true; })
          .catch(function(){
            toast("Falha na sincronização.", "error");
            return false;
          })
          .finally(function(){
            updateStatusBadge();
          });
      }

      // Padrão enterprise: Transactional Outbox Relay (VSC_RELAY)
      var ensureRelay = function(){
        if(window.VSC_RELAY && typeof window.VSC_RELAY.kick === "function") return Promise.resolve(window.VSC_RELAY);
        if(typeof window.VSC_LOAD_RELAY === "function") return window.VSC_LOAD_RELAY();

        // Fallback local: tenta carregar o script (último recurso)
        return new Promise(function(resolve, reject){
          try{
            var id = "vsc-relay-autoload";
            var el = document.getElementById(id);
            if(el){
              el.addEventListener("load", function(){ resolve(window.VSC_RELAY); });
              el.addEventListener("error", function(){ reject(new Error("Falha ao carregar relay")); });
              return;
            }
            var s = document.createElement("script");
            s.id = id;
            s.src = "modules/vsc-outbox-relay.js?v=20260225";
            s.defer = true;
            s.onload = function(){
              if(window.VSC_RELAY && typeof window.VSC_RELAY.kick === "function") return resolve(window.VSC_RELAY);
              return reject(new Error("Relay não disponível"));
            };
            s.onerror = function(){ reject(new Error("Falha ao carregar relay")); };
            (document.head || document.documentElement).appendChild(s);
          }catch(e){ reject(e); }
        });
      };

      var lastRunBefore = null;
      try{
        if(window.VSC_RELAY && typeof window.VSC_RELAY.status === "function"){
          lastRunBefore = window.VSC_RELAY.status().last_run || null;
        }
      }catch(_){}

      toast("Sincronização iniciada. Aguarde…", "info");

      return ensureRelay()
        .then(function(relay){
          relay.kick();

          // Progresso auditável: polling do status do relay
          var startedAt = Date.now();
          var maxMs = 60 * 1000; // 60s
          var tickMs = 700;

          return new Promise(function(resolve){
            var t = setInterval(function(){
              var st = null;
              try{ st = (relay && typeof relay.status === "function") ? relay.status() : null; }catch(_){}
              if(st){
                var lastRun = st.last_run || null;
                if(!st.running && lastRun && lastRun !== lastRunBefore){
                  clearInterval(t);

                  if(st.last_error){
                    toast("Falha na sincronização: " + String(st.last_error), "error", true);
                    updateStatusBadge();
                    refreshPendingCount().finally(function(){ resolve(false); });
                    return;
                  }

                  var sent = (typeof st.last_sent === "number") ? st.last_sent : 0;
                  toast("Sincronização concluída. Enviados: " + sent, "success");
                  updateStatusBadge();
                  refreshPendingCount().finally(function(){ resolve(true); });
                  return;
                }
              }

              if(Date.now() - startedAt > maxMs){
                clearInterval(t);
                toast("Sincronização em andamento (timeout de monitoramento).", "warn", true);
                updateStatusBadge();
                refreshPendingCount().finally(function(){ resolve(true); });
                return;
              }
            }, tickMs);
          });
        })
        .catch(function(){
          toast("Sync indisponível: relay não carregado.", "warn", true);
          updateStatusBadge();
          return false;
        });

    }).catch(function(){
      toast("Falha ao preparar sincronização.", "error");
      updateStatusBadge();
      return false;
    });
  }


  // -----------------------------
  // Ações de UI
  // -----------------------------
// ============================================================
// FIORI-LIKE: Guard de saída com alterações (dirty)
// Bloqueia trocas de registro / novo / fechar modal, se EDIT + dirty
// ============================================================
// ============================================================
// FIORI-LIKE: Guard de saída com alterações (dirty)
// Bloqueia trocas de registro / novo / fechar modal, se EDIT + dirty
// ============================================================
function guardIfDirty(nextAction){
  // nextAction é uma função que executa a navegação real
  if(state.uiMode === "EDIT"){
    var d = refreshDirty();
    if(d){
      return confirmModal("Atenção", "Existem alterações não salvas. Deseja DESCARTAR e continuar?")
        .then(function(ok){
          if(ok){
            // descarta: volta snapshot atual como base e limpa dirty
            setDirty(false);
            state.snapshot = snapshotFromForm();
            try{ nextAction(); }catch(_){}
            return true;
          }
          return false;
        });
    }
  }
  try{ nextAction(); }catch(_){}
  return Promise.resolve(true);
}

function startNew(){
  // NOVO deve abrir DETALHE em modo NOVO (não é LISTA)
  return guardIfDirty(function(){
    state.editingId = null;
    // mantém seleção anterior na lista (não é obrigatório zerar)
    fillForm(null);
    setEditState("NOVO");
    validateForm();
    var n = el("nome");
    if(n) n.focus();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

function goListView(){
  // Voltar para LISTA (tela inicial)
  return guardIfDirty(function(){
    // não apaga o selectedId, apenas volta a mostrar a lista
    setEditState("EMPTY");
    try{ reloadList(); }catch(_){}
    var q = el("qMaster");
    if(q) q.focus();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

  function editById(id){
    if(!state.db) return Promise.resolve(false);

    return guardIfDirty(function(){
      // ação real acontece dentro do fluxo abaixo
    }).then(function(ok){
      if(!ok) return false;

      return getById(state.db, STORE_CLIENTES, id).then(function(c){

      if(!c){
        toast("Cliente não encontrado.", "warn");
        return;
      }
      state.editingId = c.id;
      state.selectedId = c.id; // FIORI-like: destaca no Master
      fillForm(c);
      setEditState("VIEW");
// FIORI-like: força re-render do Master para aplicar highlight (.is-active)
try{
  var all = state.lastList || [];
  var rows = applyFilters(all);
  renderList(rows);
}catch(_){}

// Relacionados: só aparecem quando um cliente existente foi carregado
var rel = document.getElementById("relGrid");
if(rel) rel.style.display = "grid";
      validateForm();

      // Padrão enterprise: abre sempre em VISUALIZAÇÃO (readonly).
      // Edição somente via botão explícito EDITAR.

      window.scrollTo({ top: 0, behavior: "smooth" });
      var n = el("nome"); if(n) n.focus();
      }).catch(function(){
        toast("Falha ao abrir cliente.", "error");
      });
    });
  }

 
// ============================================================
// Clique na lista (delegação premium)
// - Clique no card inteiro ou em botões internos (data-act/data-id)
// ============================================================
function onListClick(ev){
  var t = ev && ev.target ? ev.target : null;
  if(!t) return;

  // Sobe no DOM até achar data-act/data-id
  var root = el("list");
  while(t && t !== root && !(t.getAttribute && t.getAttribute("data-act"))) t = t.parentNode;

  var act = t && t.getAttribute ? t.getAttribute("data-act") : null;
  var id  = t && t.getAttribute ? t.getAttribute("data-id") : null;
  if(!act || !id) return;

  if(act === "editar"){
    editById(id);
    return;
  }

  if(act === "inativar"){
    confirmModal("Confirmação", "Inativar este cliente?").then(function(ok){
      if(!ok) return;
      setClienteStatus(id, "INATIVO");
    });
    return;
  }

  if(act === "reativar"){
    confirmModal("Confirmação", "Reativar este cliente?").then(function(ok){
      if(!ok) return;
      setClienteStatus(id, "ATIVO");
    });
    return;
  }
}
  
  // ============================================================
  // Clique na lista (delegação premium)
  // - Funciona clicando no botão ou em qualquer área do card
  // ============================================================
  
  // ============================================================
  // Clique na lista (delegação premium)
  // ============================================================
  

function bindEvents(){
    var qModal = el("qModal");
    var preview = el("searchPreview");
    // Clique no preview (listbox): seleciona o item clicado
    if(preview){
      preview.addEventListener("click", function(ev){
        var t = ev && ev.target ? ev.target : null;
        if(!t) return;

        while(t && t !== preview && !(t.getAttribute && t.getAttribute("data-act"))) t = t.parentNode;

        var act = t && t.getAttribute ? t.getAttribute("data-act") : null;
        if(act !== "pick") return;

        var idx = t.getAttribute("data-idx");
        if(idx != null) pvSetActive(parseInt(idx,10));
        pvPickActive();
      });
    }

    var previewCount = el("previewCount");

    // Modal de busca/filtro (🔍)
    var m = el("searchModal");
    var open = el("btnOpenSearch");
    var close = el("btnCloseSearch");
    var back = el("searchBackdrop");
    var apply = el("btnApplySearch");
    var clear = el("btnClearSearch");
        var inat = el("inativosModal");
    // Teclado premium (combobox/listbox): ↑ ↓ Enter Esc
    if(qModal){
      qModal.addEventListener("keydown", function(ev){
        if(ev.key === "ArrowDown"){
          ev.preventDefault();
          pvSetActive(_pvActive + 1);
          return;
        }
        if(ev.key === "ArrowUp"){
          ev.preventDefault();
          pvSetActive(_pvActive - 1);
          return;
        }
        if(ev.key === "Enter"){
          ev.preventDefault();
          pvPickActive();
          return;
        }
        if(ev.key === "Escape"){
          ev.preventDefault();
          closeSearch();
          return;
        }
      });
    }

// Master search (lista à esquerda)
var qMaster = el("qMaster");
if(qMaster){
  qMaster.disabled = false; // era só visual; agora vira funcional
  qMaster.value = state.q || "";
}
// Master reativo (enterprise): digita → filtra lista (debounce) e mantém modal em sync
if(qMaster){
  qMaster.addEventListener("input", function(){
    var v = qMaster.value || "";
    if(qModal) qModal.value = v;     // sincroniza com a lupa
    state.q = v;
    scheduleReactive();
  });

  // Enter não “submete” nada; filtro já é reativo
  qMaster.addEventListener("keydown", function(ev){
    if(ev.key === "Enter"){
      ev.preventDefault();
    }
  });
}

    // Preview reativo (modal 🔍)
    // ============================================================
    // Preview premium: item ativo (teclado) + aria-activedescendant
    // ============================================================
    var _pvRows = [];
    var _pvActive = -1;

    function pvSetActive(idx){
  var pv = document.getElementById("searchPreview");
  if(!pv) return;

  var items = pv.querySelectorAll('[data-act="pick"]');
  if(!items.length){
    _pvActive = -1;
    return;
  }

  if(idx < 0) idx = 0;
  if(idx >= items.length) idx = items.length - 1;

  _pvActive = idx;

  for(var i=0;i<items.length;i++){
    var el = items[i];

    if(i === idx){
      el.classList.add("active");
      el.setAttribute("aria-selected","true");

      var id = el.getAttribute("id");
      if(qModal && id){
        qModal.setAttribute("aria-activedescendant", id);
      }
    }else{
      el.classList.remove("active");
      el.setAttribute("aria-selected","false");
    }
  }
}

    function pvPickActive(){
      if(_pvActive < 0 || !_pvRows || _pvActive >= _pvRows.length) return;
      var c = _pvRows[_pvActive];
      if(!c || !c.id) return;
      closeSearch();
      editById(c.id);
    }

    var _searchTimer = null;

    function renderPreview(rows){
      if(!preview) return;
      rows = rows || [];

      if(previewCount) previewCount.textContent = String(rows.length);

      if(rows.length === 0){
  preview.innerHTML = '<div class="small" style="padding:10px; opacity:.7;">Nenhum resultado.</div>';

  // Limpa estado/ARIA quando não existem opções
  _pvRows = [];
  _pvActive = -1;
  try{
    if(qModal){
      qModal.removeAttribute("aria-activedescendant");
      qModal.setAttribute("aria-expanded","false");
    }
  }catch(_){}

  return;
}

      var html = "";
var max = 10;
for(var i=0;i<rows.length && i<max;i++){
  var c = rows[i];
  var inactive = (c.status === "INATIVO");

  var badge = inactive
    ? '<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:#ffe6e6;color:#a40000;font-weight:800;font-size:12px;">INATIVO</span>'
    : '<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:#e8fff0;color:#0b6b2a;font-weight:800;font-size:12px;">ATIVO</span>';

  var doc = c.doc ? ('<div style="opacity:.85;font-size:12px;margin-top:2px;">Doc: '+escapeHtml(c.doc)+'</div>') : '';
  var tel = c.telefone ? (' • Tel: '+escapeHtml(c.telefone)) : '';
  var city = (c.cidade ? escapeHtml(c.cidade) : '') + (c.uf ? ('/'+escapeHtml(c.uf)) : '');

  html +=
    '<div id="pvopt_'+i+'" role="option" aria-selected="false" data-act="pick" data-idx="'+i+'" data-id="'+escapeHtml(c.id)+'"'
    + ' style="cursor:pointer; padding:10px 12px; border-bottom:1px solid var(--border); display:flex; gap:10px; align-items:flex-start;">'
    + '  <div style="width:90px;">'+badge+'</div>'
    + '  <div style="flex:1; min-width:0;">'
    + '    <div style="font-weight:900;">'+escapeHtml(c.nome||"")+'</div>'
    + '    <div style="opacity:.85; font-size:12px; margin-top:2px;">'
    +        (c.telefone ? escapeHtml(c.telefone) : 'Sem telefone')
    +    '</div>'
    +      doc
    + '    <div style="opacity:.75; font-size:12px; margin-top:2px;">'+escapeHtml(city)+'</div>'
    + '  </div>'
    + '</div>';
}
preview.innerHTML = html;
_pvRows = rows || [];
pvSetActive(_pvRows.length ? 0 : -1);

// ARIA: garante estado coerente mesmo após re-render
if(qModal && _pvRows.length){
  qModal.setAttribute("aria-expanded","true");
}

    }

    function applyReactiveSearch(){
      // Atualiza estado (sem botão "Aplicar")
      // Fonte do filtro: prioriza modal; se não houver, usa Master; fallback no state
var q = "";
if(qModal) q = (qModal.value || "");
else if(qMaster) q = (qMaster.value || "");
else q = (state.q || "");
state.q = q;

      state.showInativos = !!(inat && inat.checked);
      // FIORI-like: indicador de filtro ativo no botão 🔍
      try{
        var btn = document.getElementById("btnOpenSearch");
        var active = !!(String(state.q||"").trim() || state.showInativos);
        if(btn){
          btn.textContent = "🔍";
btn.title = active ? "Filtro ativo (clique para revisar)" : "Pesquisar / Filtrar";
btn.setAttribute("data-filter-active", active ? "1" : "0");

        }
      }catch(_){}

      // Garante lista em memória
      var all = state.lastList || [];
      var rows = applyFilters(all);

      // Atualiza preview sempre.
// Performance premium: enquanto o modal está aberto, não re-renderiza a lista inteira atrás do modal.
var modalOpen = false;
try{
  modalOpen = !!(m && getComputedStyle(m).display !== "none");
}catch(_){
  modalOpen = !!(m && m.style.display === "block");
}

if(!modalOpen){
  renderList(rows);
}
renderPreview(rows);

    }

    function scheduleReactive(){
      if(_searchTimer) clearTimeout(_searchTimer);
      _searchTimer = setTimeout(function(){
        applyReactiveSearch();
      }, 120);
    }

    // Clique no preview: fecha modal, abre em VIEW e pergunta "Alterar?"
   

    function openSearch(){
  if(!m) return;

  m.style.display = "block";

  // pré-preenche e foca
  if(qModal){ qModal.value = state.q || ""; qModal.focus(); }
  if(qMaster) qMaster.value = state.q || "";
  if(inat) inat.checked = !!state.showInativos;

  // ARIA premium: abre
  if(qModal){
    qModal.setAttribute("aria-expanded","true");
    qModal.removeAttribute("aria-activedescendant");
  }

  // garante preview/lista ao vivo ao abrir
  applyReactiveSearch();
}

    function closeSearch(){
  if(!m) return;
  m.style.display = "none";
  // ARIA premium: fecha e limpa seleção ativa
if(qModal){
  qModal.setAttribute("aria-expanded","false");
  qModal.removeAttribute("aria-activedescendant");
}

  
  // Performance premium: ao fechar o modal, atualiza a lista 1x (sem re-render a cada tecla).
  try{
    var all = state.lastList || [];
    var rows = applyFilters(all);
    renderList(rows);
  }catch(_){}
}
    if(open) open.addEventListener("click", function(ev){ ev.preventDefault(); openSearch(); });
    if(close) close.addEventListener("click", function(ev){ ev.preventDefault(); closeSearch(); });
    if(back) back.addEventListener("click", function(){ closeSearch(); });

    if(apply) apply.addEventListener("click", function(ev){
  ev.preventDefault();
  // padrão enterprise puro: já filtrou enquanto digitava
  closeSearch();
});

    if(clear) clear.addEventListener("click", function(ev){
  ev.preventDefault();
  if(qModal) { qModal.value = ""; qModal.focus(); }
  if(inat) inat.checked = false;
  state.q = "";
  state.showInativos = false;
  applyReactiveSearch(); // atualiza lista + preview sem fechar modal
});
   // Reativo: digita e já filtra (enterprise puro)
if(qModal){
  qModal.addEventListener("input", function(){
    scheduleReactive();
  });
    qModal.addEventListener("keydown", function(ev){
    if(ev.key === "ArrowDown"){
      ev.preventDefault();
      pvSetActive(_pvActive + 1);
      return;
    }
    if(ev.key === "ArrowUp"){
      ev.preventDefault();
      pvSetActive(_pvActive - 1);
      return;
    }
    if(ev.key === "Enter"){
  ev.preventDefault();
  if(_pvActive < 0){
    pvSetActive(0);
  }
  pvPickActive();
}

    if(ev.key === "Escape"){
      ev.preventDefault();
      closeSearch();
      return;
    }
  });

}
if(inat){
  inat.addEventListener("change", function(){
    applyReactiveSearch();
  });
}

    // mostrar inativos
    var chk = el("show_inativos");
    if(chk){
      chk.addEventListener("change", function(){
        state.showInativos = !!chk.checked;
        reloadList();
      });
    }

    // salvar
    
    // excluir (RBAC: somente ADMIN/MASTER)
    function ensureDeleteButtons(){
      // bottom button
      if(!el("btnExcluir")){
        var ref = el("btnSalvar");
        if(ref && ref.parentElement){
          var b = document.createElement("button");
          b.id = "btnExcluir";
          b.type = "button";
          b.className = "btn btnDanger";
          b.textContent = "Excluir";
          b.style.marginLeft = "8px";
          ref.parentElement.appendChild(b);
        }
      }
      // top button
      if(!el("btnExcluirTop")){
        var refTop = el("btnSalvarTop");
        if(refTop && refTop.parentElement){
          var bt = document.createElement("button");
          bt.id = "btnExcluirTop";
          bt.type = "button";
          bt.className = "btn btnDanger";
          bt.textContent = "Excluir";
          bt.style.marginLeft = "8px";
          refTop.parentElement.appendChild(bt);
        }
      }
    }

    async function deleteCliente(){
      try{
        await window.VSC_AUTH.requireRole("ADMIN"); // ADMIN ou MASTER
      }catch(e){
        toast(e && e.message ? e.message : "Acesso negado.", "warn", true);
        return;
      }
      if(!state.selectedId){
        toast("Selecione um cliente para excluir.", "warn", false);
        return;
      }
      var ok = await confirmModal("Excluir cliente", "Confirma a exclusão definitiva deste cliente? Essa ação não pode ser desfeita.");
      if(!ok) return;

      try{
        setEditState("SYNC", "Excluindo...");
        await delById(state.db, STORE_CLIENTES, state.selectedId);
        // registrar na outbox (DELETE)
        var now = new Date().toISOString();
        await outboxEnqueue(state.db, "clientes", state.selectedId, "DELETE", { id: state.selectedId, deleted_at: now });
        // limpar seleção e UI
        state.selectedId = null;
        state.editingId = null;
        try{ fillForm(null); }catch(_){}
        try{ setDetailVisible(false); }catch(_){}
        await reloadList();
        await refreshPendingCount();
        toast("Cliente excluído.", "ok", false);
        setEditState("SALVO", "Excluído");
      }catch(err){
        console.error(err);
        toast("Falha ao excluir cliente.", "error", true);
        setEditState("ERRO", "Erro");
      }finally{
        refreshDeleteUI();
      }
    }

    ensureDeleteButtons();
var bsave = el("btnSalvar");
    if(bsave){
      bsave.addEventListener("click", function(ev){
        ev.preventDefault();
        saveCliente();
      });

      // excluir
      var bdel = el("btnExcluir");
      if(bdel){
        bdel.addEventListener("click", function(ev){
          ev.preventDefault();
          deleteCliente();
        });
      }
      var bdelTop = el("btnExcluirTop");
      if(bdelTop){
        bdelTop.addEventListener("click", function(ev){
          ev.preventDefault();
          deleteCliente();
        });
      }

    }
    // FIORI-like: salvar no topo
    var bsaveTop = el("btnSalvarTop");
    if(bsaveTop){
      bsaveTop.addEventListener("click", function(ev){
        ev.preventDefault();
        saveCliente();
      });
    }

    // cancelar
    var bcancel = el("btnCancelar");
    if(bcancel){
      bcancel.addEventListener("click", function(ev){
        ev.preventDefault();
                goListView();
    
      });
    }
// FIORI-like: cancelar no topo (registrar 1 vez, fora do btnCancelar)
var bcancelTop = el("btnCancelarTop");
if(bcancelTop){
  bcancelTop.addEventListener("click", function(ev){
    ev.preventDefault();
    goListView();
  });
}

    // novo (topo)
    var bnew = el("btnNovoTop");
    if(bnew){
      bnew.addEventListener("click", function(ev){
        ev.preventDefault();
        startNew();
      });
    }
    // voltar para lista (detail → list)
    var bback = el("btnVoltarLista");
    if(bback){
      bback.addEventListener("click", function(ev){
        ev.preventDefault();
        goListView();
      });
    }
    // enterprise: botões do estado vazio (LISTA)
    var bEmptyNovo = el("btnEmptyNovo");
    if(bEmptyNovo){
      bEmptyNovo.addEventListener("click", function(ev){
        ev.preventDefault();
        startNew();
      });
    }
    var bEmptyImport = el("btnEmptyImport");
    if(bEmptyImport){
      bEmptyImport.addEventListener("click", function(ev){
        ev.preventDefault();
        if(!window.VSC_DB || typeof window.VSC_DB.importBackupFile !== "function"){
          failClosed("VSC_DB.importBackupFile indisponível.");
          return;
        }
        window.VSC_DB.importBackupFile().then(function(){
          toast("Backup importado. Recarregando lista...", "success");
          return reloadList();
        }).then(function(){
          // volta para modo LISTA até selecionar
          state.editingId = null;
          fillForm(null);
          setEditState("EMPTY");
        }).catch(function(err){
          // Cancelamento do diálogo não deve derrubar
          var msg = (err && (err.message||err)) ? String(err.message||err) : "Falha ao importar backup.";
          toast(msg, "warn");
        });
      });
    }



    // sync
    var bsync = el("btnSyncNow");
    if(bsync){
      bsync.addEventListener("click", function(ev){
        ev.preventDefault();
        syncNow();
      });
    }
        // telefone: máscara BR (não bloqueia digitação)
    var tel = el("tel");
    if(tel){
      tel.addEventListener("input", function(){
        var cur = tel.value;
        var fmt = formatBRPhone(cur);
        if(fmt !== cur) tel.value = fmt;
      });
      tel.addEventListener("blur", function(){
        tel.value = formatBRPhone(tel.value);
      });
    }

    // ============================================================
    // BOTÃO EDITAR (VIEW → EDIT consciente) — único bloco canônico
    // ============================================================
    var btnEditar = document.getElementById("btnEditar");

    if(!btnEditar){
      var bSalvar2 = document.getElementById("btnSalvar");
      if(bSalvar2 && bSalvar2.parentNode){
        btnEditar = document.createElement("button");
        btnEditar.id = "btnEditar";
        btnEditar.className = "btn";
        btnEditar.type = "button";
        btnEditar.textContent = "EDITAR";
        btnEditar.style.marginRight = "8px";
        btnEditar.style.display = "none";
        bSalvar2.parentNode.insertBefore(btnEditar, bSalvar2);
      }
    }

    if(btnEditar){
      btnEditar.addEventListener("click", function(ev){
        ev.preventDefault();
        if(state.uiMode === "VIEW"){
          setEditState("EDIT");
        }
      });
    }

    // FIORI-like: EDITAR no topo (VIEW → EDIT consciente)
    var btnEditarTop = document.getElementById("btnEditarTop");
    if(btnEditarTop){
      btnEditarTop.addEventListener("click", function(ev){
        ev.preventDefault();
        if(state.uiMode === "VIEW"){
          setEditState("EDIT");
        }
      });
    }

    // validação inline + dirty
    var ids = ["nome","doc","uf","tel","email","cidade","obs","cep","logradouro","numero","complemento","bairro","ibge","fantasia","limite_credito","prazo_dias"];
    for(var i=0;i<ids.length;i++){
      var e = el(ids[i]);
      if(e){
        e.addEventListener("input", function(){
          validateForm();
          refreshDirty();
        });
        e.addEventListener("blur", function(){
          validateForm();
          refreshDirty();
        });
      }
    }

    // clique na lista (delegação)
    var list = el("list");
    if(list) list.addEventListener("click", onListClick);

    // online/offline badge
    window.addEventListener("online", function(){ updateStatusBadge(); });
    window.addEventListener("offline", function(){ updateStatusBadge(); });
  }

  // -----------------------------
  // Init / Boot (fail-closed)
  // -----------------------------
  function failClosed(reason){
    try{
      if(reason && !window.__CLIENTES_LAST_ERROR) window.__CLIENTES_LAST_ERROR = String(reason);
    }catch(_){}
    setSaveEnabled(false);
    setEditState("VIEW");
    state.db = null;

    try{ renderList([]); }catch(_){}
    updateStatusBadge(STATUS.ERRO);
    toast(reason || "Falha crítica. Operação bloqueada.", "error");
  }

  function init(){
    // Sinais determinísticos p/ teste via console
    window.__CLIENTES_JS_BUILD = "ERP2.0.1|clientes.js|KPI|BUILD|2026-02-21";
    window.__CLIENTES_READY = false;

    showEl("toast", false);
state.editingId = null;
fillForm(null);
setEditState("EMPTY");


    state.showInativos = !!(el("show_inativos") && el("show_inativos").checked);
    state.q = "";

    bindEvents();
    validateForm();

    openDb().then(function(db){
      state.db = db;
      return refreshPendingCount();
    }).then(function(){
      updateStatusBadge();
      return reloadList();
    }).then(function(){
      var q = el("qMaster");
      if(q) q.focus();
      window.__CLIENTES_READY = true;
      toast("Clientes: pronto.", "success");
    }).catch(function(err){
      try{
        window.__CLIENTES_LAST_ERROR = err && (err.stack || err.message) ? (err.stack || err.message) : String(err);
      }catch(_){
        window.__CLIENTES_LAST_ERROR = "Erro desconhecido no boot (falha ao serializar err).";
      }
      failClosed("Falha no boot. Veja no console: window.__CLIENTES_LAST_ERROR");


    });
  }

  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", init);
  }else{
    init();
  }

})();
