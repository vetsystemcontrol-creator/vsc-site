// ==========================================================
// ANIMAIS — JS ÚNICO (SEM DUPLICAÇÃO / SEM ONCLICK INLINE)
// ==========================================================

// ---- Util: UUID v4 (browser crypto) ----
function vsc_uuidv4(){
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
    throw new TypeError("[ANIMAIS] ambiente sem CSPRNG para gerar UUID v4.");
  }
function isoNow(){ return new Date().toISOString(); }

// ---- LocalStorage keys (canônico) ----
// ANIMAIS: PROIBIDO persistir em localStorage (fonte oficial é IndexedDB: animais_master)
const LS_ANIMAIS   = null;
const LS_CLIENTES  = "vsc_clientes_v1"; // chave canônica do módulo Clientes
const LS_RACAS     = "vsc_animais_racas_v1";     // legado (migração)
const LS_PELAGENS  = "vsc_animais_pelagens_v1";  // legado (migração)
const LS_ESPECIES  = "vsc_animais_especies_v1";  // legado (migração)
const LS_OUTBOX    = "sync_queue";               // legado (migração)

const LS_SEED     = "vsc_animais_seed_v1";   // flag de seed default (permitido)
// ---- Storage helpers (somente legado / migração) ----
function lsRead(key, fallback){
  try{
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  }catch(e){
    return fallback;
  }
}
function lsWrite(key, obj){
  // Fail-closed: impede regressão (Animais não pode voltar a gravar em localStorage)
  if(key === null) throw new Error("LS_WRITE_BLOQUEADO: Animais não pode gravar em localStorage.");
  localStorage.setItem(key, JSON.stringify(obj));
}

// ---- DOM ----
const $ = (id)=>document.getElementById(id);

function fmtDate(v){
  const s = String(v || '').trim();
  if(!s) return '—';
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if(br) return s;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  const d = new Date(s);
  if(Number.isNaN(d.getTime())) return s;
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const yy = d.getFullYear();
  return `${dd}/${mm}/${yy}`;
}

function normalizeDateDigits(v){
  return String(v || '').replace(/\D/g, '').slice(0, 8);
}

function maskDateInputValue(v){
  const digits = normalizeDateDigits(v);
  if(!digits) return '';
  if(digits.length <= 2) return digits;
  if(digits.length <= 4) return `${digits.slice(0,2)}/${digits.slice(2)}`;
  return `${digits.slice(0,2)}/${digits.slice(2,4)}/${digits.slice(4,8)}`;
}

function normalizeBirthValue(v){
  const masked = maskDateInputValue(v);
  const m = masked.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if(!m) return masked;
  const dd = Number(m[1]), mm = Number(m[2]), yy = Number(m[3]);
  const d = new Date(yy, mm - 1, dd);
  if(d.getFullYear() !== yy || d.getMonth() !== (mm - 1) || d.getDate() !== dd) return masked;
  return `${String(dd).padStart(2,'0')}/${String(mm).padStart(2,'0')}/${String(yy)}`;
}

// ==========================================================
// MODAL PREMIUM PADRÃO (substitui alert/confirm) — v1
// - Usa bdVscDialog do animais.html
// - Não executa ação silenciosa (Art. 36/37)
// ==========================================================
(function VSC_DIALOG_BOOT(){
  if(window.__VSC_DIALOG_READY) return;
  window.__VSC_DIALOG_READY = true;

  function openDialog(){
    const bd = $("bdVscDialog");
    if(bd) bd.classList.add("open");
  }
  function closeDialog(){
    const bd = $("bdVscDialog");
    if(bd) bd.classList.remove("open");
  }

  window.VSC_UI = window.VSC_UI || {};
  window.VSC_UI.alert = function(msg, title){
    return new Promise((resolve)=>{
      const t = $("vscDialogTitle");
      const m = $("vscDialogMsg");
      const ok = $("vscDialogOk");
      const cancel = $("vscDialogCancel");
      const x = $("vscDialogX");

      if(t) t.textContent = String(title || "Atenção");
      if(m) m.textContent = String(msg || "");
      if(cancel) cancel.style.display = "none";

      const done = ()=>{
        try{ ok && ok.removeEventListener("click", onOk); }catch(_){}
        try{ x && x.removeEventListener("click", onOk); }catch(_){}
        closeDialog();
        resolve(true);
      };
      const onOk = ()=>done();

      ok && ok.addEventListener("click", onOk);
      x && x.addEventListener("click", onOk);
      openDialog();
      setTimeout(()=>{ ok && ok.focus(); }, 20);
    });
  };

  window.VSC_UI.confirm = function(msg, title, okLabel, cancelLabel){
    return new Promise((resolve)=>{
      const t = $("vscDialogTitle");
      const m = $("vscDialogMsg");
      const ok = $("vscDialogOk");
      const cancel = $("vscDialogCancel");
      const x = $("vscDialogX");

      if(t) t.textContent = String(title || "Confirmação");
      if(m) m.textContent = String(msg || "");
      if(ok) ok.textContent = String(okLabel || "OK");
      if(cancel){
        cancel.textContent = String(cancelLabel || "Cancelar");
        cancel.style.display = "inline-block";
      }

      const cleanup = ()=>{
        try{ ok && ok.removeEventListener("click", onOk); }catch(_){}
        try{ cancel && cancel.removeEventListener("click", onCancel); }catch(_){}
        try{ x && x.removeEventListener("click", onCancel); }catch(_){}
      };
      const finish = (v)=>{
        cleanup();
        closeDialog();
        resolve(!!v);
      };
      const onOk = ()=>finish(true);
      const onCancel = ()=>finish(false);

      ok && ok.addEventListener("click", onOk);
      cancel && cancel.addEventListener("click", onCancel);
      x && x.addEventListener("click", onCancel);

      openDialog();
      setTimeout(()=>{ ok && ok.focus(); }, 20);
    });
  };
})();


// ==========================================================
// HELPERS UI (toast/confirm) — FAIL-CLOSED / enterprise
// ==========================================================
function vscToast(kind, msg, opts){
  try{
    if(window.VSC_UI && typeof window.VSC_UI.toast === "function"){
      window.VSC_UI.toast(kind, String(msg||""), opts||{});
      return true;
    }
  }catch(_){}
  // fallback silencioso (contrato: sem alert/sem som)
  try{ vscSnack(String(msg||"OK"), kind==="err"?"err":kind==="warn"?"warn":"ok"); }catch(_){}
  return false;
}

async function vscConfirmAsync(opts){
  const o = opts || {};
  const title = String(o.title || "Confirmação");
  const body  = String(o.body  || o.msg || "");
  const okText = String(o.okText || "OK");
  const cancelText = String(o.cancelText || "Cancelar");

  // REGRA UFC: usar SEMPRE o confirm premium local (VSC_DIALOG_BOOT),
  // ignorando implementações externas divergentes que causam modal quebrado.
  try{
    if(window.VSC_UI && typeof window.VSC_UI.confirm === "function"){
      const v = await window.VSC_UI.confirm(body, title, okText, cancelText);
      return !!v;
    }
  }catch(_){}

  // Fail-closed (sem alert/confirm nativo)
  return false;
}



// ==========================================================
// RECOVERY (same-origin) — procurar animais em outros IndexedDBs
// ==========================================================
async function vsc_scanOtherDBForAnimais(){
  if(!indexedDB || typeof indexedDB.open !== "function") return null;
  if(typeof indexedDB.databases !== "function") return null;

  const dbs = await indexedDB.databases().catch(()=>[]);
  if(!Array.isArray(dbs) || dbs.length === 0) return null;

  for(const d of dbs){
    const name = d && d.name ? String(d.name) : "";
    if(!name) continue;
    if(name === "vsc_db") continue; // já é o atual canônico

    const other = await new Promise((res) => {
      const rq = indexedDB.open(name);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => res(null);
      rq.onblocked = () => res(null);
    });

    if(!other) continue;

    try{
      if(!other.objectStoreNames || !other.objectStoreNames.contains("animais_master")){
        try{ other.close(); }catch(_){}
        continue;
      }

      const tx = other.transaction(["animais_master"], "readonly");
      const st = tx.objectStore("animais_master");

      const all = await new Promise((res, rej)=>{
        const rq = st.getAll();
        rq.onsuccess = () => res(rq.result || []);
        rq.onerror = () => rej(rq.error);
      }).catch(()=>[]);

      const list = (Array.isArray(all) ? all : []).filter(a => !(a && a.deleted === true));
      try{ other.close(); }catch(_){}

      if(list.length > 0){
        return { name, count: list.length, sample: list[0], rows: list };
      }
    }catch(_){
      try{ other.close(); }catch(_2){}
    }
  }

  return null;
}

async function vsc_recoverAnimaisFromOtherDB(){
  const hit = await vsc_scanOtherDBForAnimais();
  if(!hit){
    return { ok:false, msg:"Nenhum outro banco nesta origem contém animais_master com registros." };
  }

  const ok = await vscConfirmAsync({
    title: "Recuperação",
    body: "Encontramos " + hit.count + " animal(is) em outro banco (" + hit.name + ") nesta MESMA origem.\n\nDeseja copiar para o banco oficial (vsc_db)?",
    okText: "RECUPERAR",
    cancelText: "CANCELAR",
    kind: "warn"
  });

  if(!ok) return { ok:false, msg:"Recuperação cancelada." };

  if(!window.VSC_DB || typeof window.VSC_DB.openDB !== "function"){
    return { ok:false, msg:"VSC_DB indisponível para recuperação." };
  }

  // copiar para vsc_db.animais_master (sem quebrar IDs)
  const db = await window.VSC_DB.openDB();
  try{
    const tx = db.transaction(["animais_master"], "readwrite");
    const st = tx.objectStore("animais_master");

    for(const a of hit.rows){
      try{
        const row = Object.assign({}, a);
        if(!row.id) row.id = vsc_uuidv4();
        row.updated_at = isoNow();
        st.put(row);
      }catch(_){}
    }

    await new Promise((res, rej)=>{
      tx.oncomplete = () => res(true);
      tx.onerror = () => rej(tx.error || new Error("TX erro"));
      tx.onabort = () => rej(tx.error || new Error("TX abort"));
    });

    return { ok:true, msg:"Recuperação concluída: " + hit.count + " animal(is) copiado(s) para vsc_db." };
  } finally {
    try{ db.close(); }catch(_){}
  }
}

// ==========================================================
// FOTO OFFLINE (base64) — v1
// ==========================================================
const VSC_FOTO_MAX_BYTES = 450 * 1024;     // 450KB
const VSC_FOTO_MAX_SIDE  = 768;
const VSC_FOTO_MIME_OUT  = "image/jpeg";

function vsc_bytesToKB(n){ return Math.round((n||0)/1024); }

function vsc_dataUrlToBytes(dataUrl){
  try{
    const b64 = String(dataUrl||"").split(",")[1] || "";
    return Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  }catch(e){
    return 0;
  }
}

function vsc_setFotoUI(dataUrl){
  const img = $("aFotoPreview");
  const ph  = $("aFotoPlaceholder");
  const hid = $("aFotoData");

  if(hid) hid.value = dataUrl || "";

  if(img && ph){
    if(dataUrl){
      img.src = dataUrl;
      img.style.display = "block";
      ph.style.display  = "none";
    }else{
      img.removeAttribute("src");
      img.style.display = "none";
      ph.style.display  = "flex";
    }
  }
}

function vsc_clearFoto(){
  const file = $("aFotoFile");
  if(file) file.value = "";
  vsc_setFotoUI("");
}

function vsc_loadImageFromFile(file){
  return new Promise((resolve, reject)=>{
    const r = new FileReader();
    r.onerror = ()=>reject(new Error("Falha ao ler arquivo."));
    r.onload  = ()=>resolve(String(r.result||""));
    r.readAsDataURL(file);
  });
}

function vsc_loadImageElement(dataUrl){
  return new Promise((resolve, reject)=>{
    const img = new Image();
    img.onload = ()=>resolve(img);
    img.onerror= ()=>reject(new Error("Imagem inválida."));
    img.src = dataUrl;
  });
}

function vsc_drawToCanvas(img, maxSide){
  const w = img.naturalWidth  || img.width  || 0;
  const h = img.naturalHeight || img.height || 0;
  if(!w || !h) throw new Error("Imagem sem dimensão.");

  let nw = w, nh = h;
  const m = Math.max(w,h);
  if(m > maxSide){
    const ratio = maxSide / m;
    nw = Math.round(w * ratio);
    nh = Math.round(h * ratio);
  }

  const canvas = document.createElement("canvas");
  canvas.width  = nw;
  canvas.height = nh;

  const ctx = canvas.getContext("2d", { alpha:false });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0,0,nw,nh);
  ctx.drawImage(img, 0, 0, nw, nh);

  return canvas;
}

function vsc_canvasToJpegDataUrl(canvas, quality){
  return canvas.toDataURL(VSC_FOTO_MIME_OUT, quality);
}

async function vsc_prepareFotoDataUrl(file){
  if(!file) return "";

  if(!file.type || !file.type.toLowerCase().startsWith("image/")){
    throw new Error("Arquivo não é uma imagem.");
  }

  const rawDataUrl = await vsc_loadImageFromFile(file);
  const imgEl = await vsc_loadImageElement(rawDataUrl);

  const canvas = vsc_drawToCanvas(imgEl, VSC_FOTO_MAX_SIDE);

  let q = 0.86;
  let out = vsc_canvasToJpegDataUrl(canvas, q);
  let bytes = vsc_dataUrlToBytes(out);

  while(bytes > VSC_FOTO_MAX_BYTES && q > 0.50){
    q = Math.max(0.50, q - 0.08);
    out = vsc_canvasToJpegDataUrl(canvas, q);
    bytes = vsc_dataUrlToBytes(out);
  }

  if(bytes > VSC_FOTO_MAX_BYTES){
    throw new Error(`Foto muito grande após compressão (${vsc_bytesToKB(bytes)}KB). Use uma foto menor.`);
  }

  return out;
}

async function vsc_onFotoFileChange(){
  const input = $("aFotoFile");
  const file  = input && input.files ? input.files[0] : null;
  if(!file) return;

  try{
    if(file.size > (12 * 1024 * 1024)){
      vsc_clearFoto();
    renderAnimalHistoryPanel(null);
      await (window.VSC_UI && window.VSC_UI.alert ? window.VSC_UI.alert("Arquivo muito grande (>12MB). Use uma foto menor.") : Promise.resolve());
      return;
    }

    const dataUrl = await vsc_prepareFotoDataUrl(file);
    vsc_setFotoUI(dataUrl);
  }catch(err){
    vsc_clearFoto();
    renderAnimalHistoryPanel(null);
    await (window.VSC_UI && window.VSC_UI.alert ? window.VSC_UI.alert(err && err.message ? err.message : "Não foi possível processar a foto.") : Promise.resolve());
  }
}

// (continua na PARTE 2/4)
// ==========================================================
// SNACKBAR (rodapé) — feedback obrigatório (Art. 37)
// ==========================================================
function vscSnack(msg, kind){
  const box = document.getElementById("vscSnackbar");
  const txt = document.getElementById("vscSnackbarText");
  if(!box || !txt) return;

  txt.textContent = String(msg || "OK");

  if(kind === "err"){
    box.style.background = "#7f1d1d";
  }else if(kind === "warn"){
    box.style.background = "#92400e";
  }else{
    box.style.background = "#0b1220";
  }

  box.style.display = "block";
  clearTimeout(box.__vsc_to);
  box.__vsc_to = setTimeout(()=>{ box.style.display = "none"; }, 2000);
}

function escapeHtml(s){
  return String(s||"")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#39;");
}

// ==========================================================
// STATE
// ==========================================================
let st_animais  = [];
let st_vitals_history = [];
let st_animal_vaccines = [];
let st_atendimentos = [];
let st_racas    = [];
let st_pelagens = [];
let st_especies = [];
let st_clientes = [];

let editingAnimalId = null;

// ==========================================================
// CLIENTE — BLOQUEIO (inativo/bloqueado) — v1
// ==========================================================
function vsc_isClienteInativoOuBloqueado(c){
  if(!c) return false;

  if (c.bloqueado === true) return true;
  if (c.blocked === true) return true;
  if (String(c.bloqueado||"").toLowerCase() === "sim") return true;

  if (c.ativo === false) return true;
  if (c.is_active === false) return true;

  // canônico clientes.js: "ATIVO" / "INATIVO"
  var st = String(c.status ?? c.situacao ?? c.state ?? "").toLowerCase().trim();
  if (st === "inativo" || st === "inactive") return true;
  if (st === "bloqueado" || st === "blocked") return true;
  if (st === "ativo" || st === "active") return false;

  return false;
}

// ==========================================================
// VIEW ≠ EDIT — CANÔNICO (Animais)
// ==========================================================
window.__VSC_ANIMAL_UI_MODE = window.__VSC_ANIMAL_UI_MODE || "VIEW"; // "VIEW" | "EDIT"

function __vsc_animal_applyMode(mode){
  window.__VSC_ANIMAL_UI_MODE = (mode === "EDIT") ? "EDIT" : "VIEW";

  const badge = $("aModeBadge");
  if (badge){
    badge.textContent = (window.__VSC_ANIMAL_UI_MODE === "EDIT") ? "EDITANDO" : "VISUALIZAÇÃO";
    badge.style.background = (window.__VSC_ANIMAL_UI_MODE === "EDIT") ? "#1fa04a" : "#0b1220";
    badge.style.color = "#fff";
  }

  const btnEditar = $("btnEditarAnimal");
  if (btnEditar){
    btnEditar.style.display = (window.__VSC_ANIMAL_UI_MODE === "VIEW" && !!editingAnimalId) ? "inline-block" : "none";
  }

  const btnSalvar = $("btnSalvarAnimal");
  if (btnSalvar){
    const on = (window.__VSC_ANIMAL_UI_MODE === "EDIT");
    btnSalvar.disabled = !on;
    btnSalvar.style.opacity = on ? "1" : "0.55";
    btnSalvar.style.cursor = on ? "pointer" : "not-allowed";
  }

  const ids = [
    "aFotoFile", "aFotoClear",
    "aNome", "aEspecie", "btnCadEspeciesModal",
    "aSexo", "aNasc", "aRaca", "aPelagem",
    "aMicrochip", "aPassaporte",
    "aAtivo", "aClienteId",
    "aObs"
  ];

  for (let i = 0; i < ids.length; i++){
    const el = $(ids[i]);
    if (!el) continue;

    const tag = String(el.tagName || "").toUpperCase();
    const on = (window.__VSC_ANIMAL_UI_MODE === "EDIT");

    if (tag === "BUTTON"){
      el.disabled = !on;
      continue;
    }
    if (tag === "INPUT"){
      el.disabled = !on;
      continue;
    }
    if (tag === "SELECT" || tag === "TEXTAREA"){
      el.disabled = !on;
      continue;
    }
  }
}

async function __vsc_animal_requestEdit(){
  const ok = (window.VSC_UI && window.VSC_UI.confirm)
    ? await vscConfirmAsync({title:"Confirmação", body:"Alterar este cadastro?\n\nSIM = liberar edição\nNÃO = manter somente visualização", okText:"Confirmar", cancelText:"Cancelar", kind:"warn"}): false;

  if(!ok) return;

  __vsc_animal_applyMode("EDIT");
  setTimeout(() => { if ($("aNome")) $("aNome").focus(); }, 30);
}

// ==========================================================
// CATÁLOGOS — defaults mínimos em memória (NÃO usa LS)
// ==========================================================
function ensureCatalogs(){
  if (!Array.isArray(st_racas)) st_racas = [];
  if (!Array.isArray(st_pelagens)) st_pelagens = [];
  if (!Array.isArray(st_especies)) st_especies = [];

  if (st_especies.length === 0){
    const now = isoNow();
    st_especies = [
      { id:vsc_uuidv4(), nome:"Equino", created_at:now, updated_at:now, last_sync:null, ativo:true, status:"ATIVO", nome_norm:"equino" },
      { id:vsc_uuidv4(), nome:"Bovino", created_at:now, updated_at:now, last_sync:null, ativo:true, status:"ATIVO", nome_norm:"bovino" },
      { id:vsc_uuidv4(), nome:"Canino", created_at:now, updated_at:now, last_sync:null, ativo:true, status:"ATIVO", nome_norm:"canino" }
    ];
  }
}

// ==========================================================
// SEED DEFAULT — Raças e Pelagens mais comuns no Brasil (v1)
// - Only-once (flag LS_SEED)
// - Não sobrescreve catálogo existente
// ==========================================================
const VSC_DEFAULT_RACAS_BR = [
  "Mangalarga Marchador",
  "Quarto de Milha",
  "Crioulo",
  "Campolina",
  "Cavalo Árabe",
  "Puro Sangue Inglês",
  "Brasileiro de Hipismo",
  "Paint Horse",
  "Appaloosa",
  "Lusitano"
];

const VSC_DEFAULT_PELAGENS_BR = [
  "Alazão",
  "Alazão Tostado",
  "Castanho",
  "Baio",
  "Palomino",
  "Preto",
  "Tordilho",
  "Rosilho",
  "Lobuno",
  "Cremelo",
  "Perlino",
  "Gateado",
  "Zaino"
];

async function vsc_seedDefaultsIfNeeded(){
  try{
    // se já foi semeado, não mexe
    if(localStorage.getItem(LS_SEED) === "1") return;

    // seed só se o catálogo estiver vazio (não sobrescreve)
    let did = false;

    if((st_racas||[]).filter(x=>x && x.deleted!==true).length === 0){
      for(const nome of VSC_DEFAULT_RACAS_BR){
        const now = isoNow();
        await vsc_catalogUpsert("racas", { id:vsc_uuidv4(), nome, created_at:now, updated_at:now, last_sync:null, ativo:true, status:"ATIVO", nome_norm:String(nome).toLowerCase() }, "seed");
      }
      await vsc_catalogReloadToMemory("racas");
      did = true;
    }

    if((st_pelagens||[]).filter(x=>x && x.deleted!==true).length === 0){
      for(const nome of VSC_DEFAULT_PELAGENS_BR){
        const now = isoNow();
        await vsc_catalogUpsert("pelagens", { id:vsc_uuidv4(), nome, created_at:now, updated_at:now, last_sync:null, ativo:true, status:"ATIVO", nome_norm:String(nome).toLowerCase() }, "seed");
      }
      await vsc_catalogReloadToMemory("pelagens");
      did = true;
    }

    if(did){
      localStorage.setItem(LS_SEED, "1");
    }
  }catch(e){
    // fail-closed: não bloqueia o módulo por seed
    try{ console.warn("[ANIMAIS] seed defaults falhou:", e); }catch(_){}
  }
}

// ==========================================================
// HELPERS UI
// ==========================================================
function setSelectOptions(sel, items, opts){
  const o2 = (opts||{});
  const includeAll = !!o2.includeAll;
  const allLabel = o2.allLabel || "Todos";
  const valueKey = o2.valueKey || "id";
  const labelKey = o2.labelKey || "nome";

  if(!sel) return;
  sel.innerHTML = "";

  if (includeAll){
    const o = document.createElement("option");
    o.value = "";
    o.textContent = allLabel;
    sel.appendChild(o);
  }

  (items||[]).forEach(it=>{
    const o = document.createElement("option");
    o.value = it && it[valueKey] ? it[valueKey] : "";
    o.textContent = (it && it[labelKey]) ? it[labelKey] : "";
    sel.appendChild(o);
  });
}

function getNomeCatalogById(arr, id){
  const it = (arr||[]).find(x=>x && x.id===id);
  return it ? (it.nome||"") : "";
}

function badgeCatalogs(){
  const r = $("tagRacas");
  const p = $("tagPelagens");
  const t = $("tagTopbar");
  if(r) r.textContent = `raças: ${(st_racas||[]).length}`;
  if(p) p.textContent = `pelagens: ${(st_pelagens||[]).length}`;
  if(t) t.textContent = `topbar: OK`;
}

function normalize(){
  (st_racas||[]).sort((a,b)=>String(a?.nome||"").localeCompare(String(b?.nome||""), "pt-BR", {sensitivity:"base"}));
  (st_pelagens||[]).sort((a,b)=>String(a?.nome||"").localeCompare(String(b?.nome||""), "pt-BR", {sensitivity:"base"}));
  (st_especies||[]).sort((a,b)=>String(a?.nome||"").localeCompare(String(b?.nome||""), "pt-BR", {sensitivity:"base"}));
  (st_animais||[]).sort((a,b)=>String(a?.nome||"").localeCompare(String(b?.nome||""), "pt-BR", {sensitivity:"base"}));
}

function refreshCombos(){
  const current = {
    raca: $("fRaca")?.value || "",
    pelagem: $("fPelagem")?.value || "",
    especie: $("fEspecie")?.value || "",
    cliente: $("fCliente")?.value || "",
    ativo: $("fAtivo")?.value || ""
  };

  setSelectOptions($("fRaca"), st_racas, { includeAll:true, allLabel:"Todas" });
  setSelectOptions($("fPelagem"), st_pelagens, { includeAll:true, allLabel:"Todas" });
  setSelectOptions($("fEspecie"), st_especies, { includeAll:true, allLabel:"Todas" });

  const fCliente = $("fCliente");
  if(fCliente){
    const clientsSorted = [...(st_clientes||[])]
      .filter(c => c && !c.deleted && String(c.id || '').trim())
      .sort((a,b)=>String(a?.nome||"").localeCompare(String(b?.nome||""), "pt-BR", {sensitivity:"base"}));
    fCliente.innerHTML = '';
    const first = document.createElement('option');
    first.value = '';
    first.textContent = 'Todos';
    fCliente.appendChild(first);
    const seen = new Set();
    clientsSorted.forEach(c=>{
      const id = String(c?.id || '').trim();
      const nome = String(c?.nome || c?.razao_social || '(sem nome)').trim();
      if(!id || seen.has(id)) return;
      seen.add(id);
      const o = document.createElement('option');
      o.value = id;
      o.textContent = nome;
      fCliente.appendChild(o);
    });
  }

  const fAt = $("fAtivo");
  if(fAt){
    fAt.innerHTML = "";
    [
      {v:"", t:"Todos"},
      {v:"1", t:"Ativos"},
      {v:"0", t:"Inativos"}
    ].forEach(x=>{
      const o=document.createElement("option");
      o.value=x.v; o.textContent=x.t;
      fAt.appendChild(o);
    });
  }

  setSelectOptions($("aRaca"), st_racas, { includeAll:true, allLabel:"(sem raça)" });
  setSelectOptions($("aPelagem"), st_pelagens, { includeAll:true, allLabel:"(sem pelagem)" });
  setSelectOptions($("aEspecie"), st_especies, { includeAll:true, allLabel:"(sem espécie)" });

  const sx = $("aSexo");
  if(sx){
    sx.innerHTML="";
    [
      {v:"", t:"(não informado)"},
      {v:"FEMEA", t:"Fêmea"},
      {v:"MATRIZ", t:"Matriz"},
      {v:"GARANHAO", t:"Garanhão"},
      {v:"CASTRADO", t:"Castrado"}
    ].forEach(x=>{
      const o=document.createElement("option");
      o.value=x.v; o.textContent=x.t;
      sx.appendChild(o);
    });
  }

  const at = $("aAtivo");
  if(at){
    at.innerHTML="";
    [
      {v:"1", t:"Ativo"},
      {v:"0", t:"Inativo"}
    ].forEach(x=>{
      const o=document.createElement("option");
      o.value=x.v; o.textContent=x.t;
      at.appendChild(o);
    });
  }

  const cid = $("aClienteId");
  if(cid){
    const clientsSorted = [...(st_clientes||[])].filter(c => c && String(c?.id||'').trim()).sort((a,b)=>String(a?.nome||"").localeCompare(String(b?.nome||""), "pt-BR", {sensitivity:"base"}));
    const prev = cid.value || '';
    cid.innerHTML="";
    const first = document.createElement("option");
    first.value=""; first.textContent="(selecione)";
    cid.appendChild(first);
    clientsSorted.forEach(c=>{
      const o=document.createElement("option");
      o.value = c?.id || "";
      o.textContent = c?.nome || c?.razao_social || "(sem nome)";
      cid.appendChild(o);
    });
    cid.value = prev;
  }

  if($("fRaca")) $("fRaca").value = current.raca;
  if($("fPelagem")) $("fPelagem").value = current.pelagem;
  if($("fEspecie")) $("fEspecie").value = current.especie;
  if($("fCliente")) $("fCliente").value = current.cliente;
  if($("fAtivo")) $("fAtivo").value = current.ativo;
}

function applyFilters(items){
  const q = ($("q")?.value||"").trim().toLowerCase();
  const fRaca = $("fRaca")?.value || "";
  const fPel  = $("fPelagem")?.value || "";
  const fEsp  = $("fEspecie")?.value || "";
  const fCli  = $("fCliente")?.value || "";
  const fAt   = $("fAtivo")?.value || "";

  return (items||[]).filter(a=>{
    const nome = String(a?.nome||"").toLowerCase();
    const micro= String(a?.microchip||"").toLowerCase();
    const pass = String(a?.passaporte||"").toLowerCase();
    const tutor= String(animalTutorNome(a)||"").toLowerCase();
    const especieNome = String(getNomeCatalogById(st_especies, a?.especie_id)||"").toLowerCase();
    const racaNome = String(getNomeCatalogById(st_racas, a?.raca_id)||"").toLowerCase();
    const pelNome = String(getNomeCatalogById(st_pelagens, a?.pelagem_id)||"").toLowerCase();

    if (q && !(nome.includes(q) || micro.includes(q) || pass.includes(q) || tutor.includes(q) || especieNome.includes(q) || racaNome.includes(q) || pelNome.includes(q))) return false;
    if (fRaca && a?.raca_id !== fRaca) return false;
    if (fPel  && a?.pelagem_id !== fPel) return false;
    if (fEsp  && a?.especie_id !== fEsp) return false;
    if (fCli){
      const animalCli = String(a?.cliente_id || a?.tutor_id || a?.proprietario_id || '');
      if(animalCli !== fCli) return false;
    }

    if (fAt !== ""){
      const isAt = !(a?.ativo===false || a?.ativo===0 || a?.ativo==="0");
      if (fAt==="1" && !isAt) return false;
      if (fAt==="0" && isAt) return false;
    }
    return true;
  });
}

function calcIdadeTxt(nasc){
  const s = String(nasc||"").trim();
  if(!s) return "—";
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  let d = null;
  if(m) d = new Date(Number(m[3]), Number(m[2])-1, Number(m[1]));
  else if(/^\d{4}-\d{2}-\d{2}$/.test(s)) { const p=s.split('-'); d = new Date(Number(p[0]), Number(p[1])-1, Number(p[2])); }
  if(!d || isNaN(d)) return "—";
  const now = new Date();
  let years = now.getFullYear() - d.getFullYear();
  let months = now.getMonth() - d.getMonth();
  if(now.getDate() < d.getDate()) months -= 1;
  if(months < 0){ years -= 1; months += 12; }
  if(years > 0) return years + 'a' + (months>0 ? ' ' + months + 'm' : '');
  return Math.max(months,0) + 'm';
}
function animalTutorNome(a){
  const c = (st_clientes||[]).find(x => x && x.id === (a?.cliente_id||a?.tutor_id||a?.proprietario_id));
  return c ? String(c.nome||'—') : '—';
}
function getAnimalVitalsHistory(animalId){
  return (st_vitals_history||[]).filter(x => String(x?.animal_id||'') === String(animalId||'')).sort((a,b)=>String(b?.recorded_at||'').localeCompare(String(a?.recorded_at||'')));
}
function getAnimalVaccines(animalId){
  return (st_animal_vaccines||[]).filter(x => String(x?.animal_id||'') === String(animalId||'')).sort((a,b)=>String(b?.data_aplicacao||'').localeCompare(String(a?.data_aplicacao||'')));
}
function getAnimalLastAtendimento(animalId){
  const rows = (st_atendimentos||[]).filter(x => Array.isArray(x?.animal_ids) && x.animal_ids.map(String).includes(String(animalId||''))).sort((a,b)=>String(b?.data_atendimento||b?.created_at||'').localeCompare(String(a?.data_atendimento||a?.created_at||'')));
  return rows[0] || null;
}
function getAnimalClinicalStatus(animalId){
  const at = getAnimalLastAtendimento(animalId);
  if(!at) return 'Sem histórico';
  const status = String(at.status||'').toLowerCase();
  if(status === 'em_atendimento') return 'Em tratamento';
  if(status === 'finalizado') return 'Estável';
  if(status === 'cancelado') return 'Cancelado';
  return status ? status.replace(/_/g,' ') : 'Sem status';
}
function openAnimalHistoryModal(){
  const bd = document.getElementById('bdAnimalHistory');
  if(bd) bd.classList.add('open');
}
function closeAnimalHistoryModal(){
  const bd = document.getElementById('bdAnimalHistory');
  if(bd) bd.classList.remove('open');
}
function renderAnimalHistoryPanel(animalId){
  const vit = document.getElementById('animalHistoryVitals');
  const vac = document.getElementById('animalHistoryVaccines');
  const title = document.getElementById('animalHistoryTitle');
  const name = document.getElementById('animalHistoryName');
  const meta = document.getElementById('animalHistoryMeta');
  const tutor = document.getElementById('animalHistoryTutor');
  const lastAt = document.getElementById('animalHistoryLastAt');
  const weight = document.getElementById('animalHistoryWeight');
  const status = document.getElementById('animalHistoryStatus');
  if(!vit || !vac || !title || !name || !meta || !tutor || !lastAt || !weight || !status) return;
  if(!animalId){
    title.textContent = 'Histórico do animal';
    name.textContent = '—';
    meta.textContent = 'Nenhum animal selecionado.';
    tutor.textContent = '—';
    lastAt.textContent = '—';
    weight.textContent = '—';
    status.textContent = '—';
    vit.innerHTML = '<div class="historyEmpty">Nenhum animal selecionado.</div>';
    vac.innerHTML = '<div class="historyEmpty">Nenhum animal selecionado.</div>';
    openAnimalHistoryModal();
    return;
  }
  const animal = (st_animais || []).find(a => String(a?.id||'') === String(animalId||'')) || null;
  const hv = getAnimalVitalsHistory(animalId).slice(0,6);
  const vc = getAnimalVaccines(animalId).slice(0,6);
  const ultimo = getAnimalLastAtendimento(animalId);
  const ultimaPesagem = hv.find(v => v && (v.peso || v.peso === 0)) || null;
  const especie = getNomeCatalogById(st_especies, animal?.especie_id) || 'Espécie não informada';
  const raca = getNomeCatalogById(st_racas, animal?.raca_id) || 'Raça não informada';
  const pelagem = getNomeCatalogById(st_pelagens, animal?.pelagem_id) || 'Pelagem não informada';
  title.textContent = 'Histórico clínico';
  name.textContent = animal?.nome || 'Animal sem nome';
  meta.textContent = `${especie} · ${raca} · ${pelagem} · ${calcIdadeTxt(animal?.nascimento)}`;
  tutor.textContent = animalTutorNome(animal);
  lastAt.textContent = ultimo ? fmtDate(ultimo.data_atendimento || ultimo.created_at) : 'Sem atendimento';
  weight.textContent = ultimaPesagem && (ultimaPesagem.peso || ultimaPesagem.peso === 0) ? `${String(ultimaPesagem.peso).replace('.',',')} kg` : 'Sem registro';
  status.textContent = getAnimalClinicalStatus(animalId);
  vit.innerHTML = hv.length ? hv.map(v => `<div style="padding:12px 0;border-bottom:1px solid #e2e8f0;"><b>${fmtDate(v.recorded_at||v.updated_at||'')}</b><div style="margin-top:4px;">${[v.peso||v.peso===0?('Peso '+String(v.peso).replace('.',',')+' kg'):'', v.temp||v.temp===0?('T° '+String(v.temp).replace('.',',')+'°C'):'', v.fc||v.fc===0?('FC '+v.fc):'', v.fr||v.fr===0?('FR '+v.fr):'', v.observacoes?escapeHtml(v.observacoes):''].filter(Boolean).join(' · ') || 'Sem sinais vitais preenchidos'}</div></div>`).join('') : '<div class="historyEmpty">Nenhum histórico clínico.</div>';
  vac.innerHTML = vc.length ? vc.map(v => `<div style="padding:12px 0;border-bottom:1px solid #e2e8f0;"><b>${escapeHtml(v.vacina_nome||'Vacina')}</b><div style="margin-top:4px;">${fmtDate(v.data_aplicacao||'')} ${v.proxima_dose ? ' · Próx.: ' + fmtDate(v.proxima_dose) : ''}</div></div>`).join('') : '<div class="historyEmpty">Nenhuma vacina registrada.</div>';
  openAnimalHistoryModal();
}

// ==========================================================
// LOAD (canônico)
// - clientes ainda seguem via localStorage (módulo Clientes)
// - animais via IndexedDB (animais_master)
// ==========================================================
async function loadAll(){
  // clientes (canônico: IndexedDB clientes_master)
  st_clientes = [];
  if(window.VSC_DB && typeof window.VSC_DB.openDB === "function"){
    const dbC = await window.VSC_DB.openDB();
    try{
      const txC = dbC.transaction(["clientes_master"], "readonly");
      const stC = txC.objectStore("clientes_master");
      const allC = await new Promise((res, rej)=>{
        const rq = stC.getAll();
        rq.onsuccess = () => res(rq.result || []);
        rq.onerror = () => rej(rq.error);
      }).catch(()=>[]);
      st_clientes = (Array.isArray(allC)? allC: []).filter(c => !(c && c.deleted === true));
    }catch(_){
      st_clientes = [];
    }finally{
      try{ dbC.close(); }catch(_){}
    }
  }

  if(!Array.isArray(st_clientes)) st_clientes = [];

  ensureCatalogs();
  normalize();

  // animais (IDB canônico)
  st_animais = [];

  if (!window.VSC_DB || typeof window.VSC_DB.openDB !== "function"){
    vscToast("err", String("[ANIMAIS] VSC_DB não disponível. Módulo BLOQUEADO."), {ms:3200});
if(window.VSC_UI && window.VSC_UI.alert){
      await window.VSC_UI.alert("ERRO: Banco offline não carregou (VSC_DB). Módulo bloqueado.", "Banco offline");
    }else{
      vscSnack("ERRO: Banco offline não carregou (VSC_DB). Módulo bloqueado.", "err");
    }

    const ids = ["btnNovo","btnLimpar","q","fRaca","fPelagem","fEspecie","fCliente","fAtivo"];
    for(let i=0;i<ids.length;i++){
      const el = document.getElementById(ids[i]);
      if(el) el.disabled = true;
    }
    return;
  }

  const db = await window.VSC_DB.openDB();
  try{
    const stores = ["animais_master"];
    if(db.objectStoreNames.contains("animal_vitals_history")) stores.push("animal_vitals_history");
    if(db.objectStoreNames.contains("animal_vaccines")) stores.push("animal_vaccines");
    if(db.objectStoreNames.contains("atendimentos_master")) stores.push("atendimentos_master");
    const tx = db.transaction(stores, "readonly");
    const st = tx.objectStore("animais_master");
    const all = await new Promise((res, rej) => {
      const rq = st.getAll();
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror = () => rej(rq.error);
    });

    st_animais = (Array.isArray(all) ? all : []).filter(a => !(a && a.deleted === true));
    try{ st_vitals_history = stores.includes("animal_vitals_history") ? await new Promise((res,rej)=>{ const rq = tx.objectStore("animal_vitals_history").getAll(); rq.onsuccess=()=>res(rq.result||[]); rq.onerror=()=>rej(rq.error); }).catch(()=>[]) : []; }catch(_){ st_vitals_history=[]; }
    try{ st_animal_vaccines = stores.includes("animal_vaccines") ? await new Promise((res,rej)=>{ const rq = tx.objectStore("animal_vaccines").getAll(); rq.onsuccess=()=>res(rq.result||[]); rq.onerror=()=>rej(rq.error); }).catch(()=>[]) : []; }catch(_){ st_animal_vaccines=[]; }
    try{ st_atendimentos = stores.includes("atendimentos_master") ? await new Promise((res,rej)=>{ const rq = tx.objectStore("atendimentos_master").getAll(); rq.onsuccess=()=>res(rq.result||[]); rq.onerror=()=>rej(rq.error); }).catch(()=>[]) : []; }catch(_){ st_atendimentos=[]; }
    // empty-state / recovery (enterprise)
    try{
      const box = document.getElementById("vscAnimaisRecovery");
      if(box){
        if(st_animais.length === 0){
          box.style.display = "block";
          const msg = document.getElementById("vscAnimaisRecoveryMsg");
          if(msg) msg.textContent = "Nenhum registro no banco offline desta origem. Use Importar Backup ou Procure em outros bancos (mesma origem).";
        }else{
          box.style.display = "none";
        }
      }
    }catch(_){}

  } finally {
    try { db.close(); } catch(_){}
  }
}

// ==========================================================
// RENDER
// ==========================================================
function render(){
  normalize();
  badgeCatalogs();
  refreshCombos();

  const list = applyFilters(st_animais);
  const all = st_animais.filter(x => x && !x.deleted_at);

  // KPI Strip
  const ativosCount = all.filter(x => !(x.ativo===false || x.ativo===0 || x.ativo==="0")).length;
  const comTutor = all.filter(x => !!(x.cliente_id || x.tutor_id || x.proprietario_id)).length;
  const racasSet = new Set(all.filter(x => x.raca_id).map(x => x.raca_id));
  const kAnTotal = document.getElementById("kpiAnTotal"); if(kAnTotal) kAnTotal.textContent = all.length;
  const kAnAtivos = document.getElementById("kpiAnAtivos"); if(kAnAtivos) kAnAtivos.textContent = ativosCount;
  const kAnTutor = document.getElementById("kpiAnTutor"); if(kAnTutor) kAnTutor.textContent = comTutor;
  const kAnRacas = document.getElementById("kpiAnRacas"); if(kAnRacas) kAnRacas.textContent = racasSet.size;

  const tb = $("tb");
  if(!tb) return;

  tb.innerHTML = "";
  const resultCount = document.getElementById("resultCount");
  if(resultCount) resultCount.textContent = `${list.length} de ${all.length} registro(s)`;
  const tbEmpty = document.getElementById("tbEmpty");
  if(tbEmpty) tbEmpty.style.display = list.length ? "none" : "block";

  list.forEach(a=>{
    const tr = document.createElement("tr");

    const tdNome = document.createElement("td");
    const nomeSafe = escapeHtml(a?.nome || "");
    const isInativo = (a?.ativo===false || a?.ativo===0 || a?.ativo==="0");

    const foto = String(a?.foto_data || a?.foto || a?.image || a?.imagem || "").trim();
    const hasFoto = !!foto;
    const ini = (String(a?.nome||"").trim().slice(0,1) || "🐴").toUpperCase();

    const avatarHtml = hasFoto
      ? `<img class="vsc-avatar" src="${foto}" alt="foto" />`
      : `<div class="vsc-avatar ph" aria-hidden="true">${escapeHtml(ini)}</div>`;

    tdNome.innerHTML = `
      <div class="vsc-animalcell">
        ${avatarHtml}
        <div>
          <div style="font-weight:900">${nomeSafe}</div>
          <div style="margin-top:6px">
            ${isInativo ? `<span class="pill pillOff">INATIVO</span>` : `<span class="pill">ATIVO</span>`}
          </div>
        </div>
      </div>
    `;
    tr.appendChild(tdNome);

    const tdTutor = document.createElement("td");
    tdTutor.textContent = animalTutorNome(a);
    tr.appendChild(tdTutor);

    const h = getAnimalVitalsHistory(a?.id);
    const lastVital = h[0] || null;
    const lastAt = getAnimalLastAtendimento(a?.id);

    const tdIdade = document.createElement("td");
    tdIdade.className = 'col-hide-md';
    tdIdade.textContent = calcIdadeTxt(a?.nascimento);
    tr.appendChild(tdIdade);

    const tdPeso = document.createElement("td");
    tdPeso.className = 'col-hide-md';
    tdPeso.textContent = lastVital && lastVital.peso ? String(lastVital.peso).replace('.',',') + ' kg' : '—';
    tr.appendChild(tdPeso);

    const tdUlt = document.createElement("td");
    tdUlt.className = 'col-hide-lg';
    tdUlt.textContent = lastAt ? fmtDate(lastAt.data_atendimento || lastAt.created_at) : '—';
    tr.appendChild(tdUlt);

    const tdStc = document.createElement("td");
    tdStc.className = 'col-hide-lg';
    tdStc.textContent = getAnimalClinicalStatus(a?.id);
    tr.appendChild(tdStc);

    const tdR = document.createElement("td");
    tdR.className = 'col-hide-lg';
    tdR.textContent = getNomeCatalogById(st_racas, a?.raca_id) || "-";
    tr.appendChild(tdR);

    const tdP = document.createElement("td");
    tdP.className = 'col-hide-xl';
    tdP.textContent = getNomeCatalogById(st_pelagens, a?.pelagem_id) || "-";
    tr.appendChild(tdP);

    const tdM = document.createElement("td");
    tdM.className = 'col-hide-xl';
    tdM.textContent = a?.microchip || "-";
    tr.appendChild(tdM);

    const tdPa = document.createElement("td");
    tdPa.className = 'col-hide-xl';
    tdPa.textContent = a?.passaporte || "-";
    tr.appendChild(tdPa);

    const tdA = document.createElement("td");
    tdA.className = 'col-actions';
    tdA.innerHTML = `
      <div class="vsc-animal-actions-row">
        <button class="btn btnMini btnGhost" type="button" data-act="history" data-id="${a?.id}">Histórico</button>
        <button class="btn btnMini ${isInativo ? "btnPrimary" : "btnWarn"}" type="button"
                data-act="toggle" data-id="${a?.id}">
          ${isInativo ? "Ativar" : "Inativar"}
        </button>
        <button class="btn btnMini btnGhost vsc-gear-trigger" type="button"
                data-act="gear" data-id="${a?.id}"
                aria-label="Mais ações" title="Mais ações">⚙</button>
      </div>
    `;
    tr.appendChild(tdA);

    tb.appendChild(tr);
  });
}

// (continua na PARTE 3/4)
function ensureAnimalActionsMenuStyles(){
  if(document.getElementById("vsc-animal-actions-menu-style")) return;
  const st = document.createElement("style");
  st.id = "vsc-animal-actions-menu-style";
  st.textContent = `
    .vsc-animal-actions-row{ display:flex; justify-content:flex-end; align-items:center; gap:8px; flex-wrap:nowrap; white-space:nowrap; min-width:0; }
    .vsc-gear-trigger{ min-width:42px; padding-left:10px !important; padding-right:10px !important; }
    /* Painel singleton appendado ao body — escapa de qualquer overflow/stacking context */
    #vsc-gear-panel{ position:fixed; display:none; flex-direction:column; gap:8px; min-width:148px; padding:8px; border:1px solid #dbe1ea; border-radius:12px; background:#fff; box-shadow:0 12px 28px rgba(15,23,42,.18); z-index:99999; }
    #vsc-gear-panel.open{ display:flex; }
    #vsc-gear-panel .btn{ width:100%; justify-content:flex-start; }
  `;
  document.head.appendChild(st);
}

// ==========================================================
// WIRE UI
// ==========================================================
function wireUI(){
  ensureAnimalActionsMenuStyles();

  // ── Painel singleton appendado ao body ──────────────────────────────────────
  // Escapa de qualquer overflow/stacking context da tabela.
  // Um único #vsc-gear-panel reutilizado por todas as linhas.
  let _gearPanel = null;
  let _gearActiveId = null;

  function _getGearPanel(){
    if(_gearPanel) return _gearPanel;
    _gearPanel = document.createElement("div");
    _gearPanel.id = "vsc-gear-panel";
    _gearPanel.innerHTML =
      '<button class="btn btnMini btnGhost" type="button" id="vsc-gear-edit">Alterar</button>' +
      '<button class="btn btnMini btnDanger" type="button" id="vsc-gear-del">Excluir</button>';
    document.body.appendChild(_gearPanel);

    // Ações do painel — chama funções do módulo diretamente
    _gearPanel.addEventListener("click", (ev)=>{
      ev.stopPropagation();
      const btn = ev.target.closest("button");
      if(!btn || !_gearActiveId) return;
      const id = _gearActiveId;
      _closeGearPanel();
      if(btn.id === "vsc-gear-edit") openAnimalModal(id, { mode:"EDIT", openHistory:false });
      if(btn.id === "vsc-gear-del")  delAnimal(id);
    });

    return _gearPanel;
  }

  function _openGearPanel(trigger, id){
    const panel = _getGearPanel();
    _gearActiveId = id;
    const rect = trigger.getBoundingClientRect();
    // Mostrar brevemente para medir largura real
    panel.style.visibility = "hidden";
    panel.classList.add("open");
    const pw = panel.offsetWidth || 148;
    panel.style.visibility = "";
    // Posição: abaixo do trigger, alinhado à direita
    let top  = rect.bottom + 6;
    let left = rect.right - pw;
    if(left < 8) left = 8;
    // Garantir que não sai pela base da viewport
    if(top + 120 > window.innerHeight) top = rect.top - 120;
    panel.style.top  = top + "px";
    panel.style.left = left + "px";
  }

  function _closeGearPanel(){
    if(!_gearPanel) return;
    _gearPanel.classList.remove("open");
    _gearActiveId = null;
  }

  // Abrir painel ao clicar na engrenagem
  document.addEventListener("click", (ev)=>{
    const gear = ev.target.closest(".vsc-gear-trigger");
    if(gear){
      ev.stopPropagation();
      const id = gear.dataset.id;
      const panel = _getGearPanel();
      // Toggle: fechar se já está aberto para este id
      if(panel.classList.contains("open") && _gearActiveId === id){
        _closeGearPanel(); return;
      }
      _openGearPanel(gear, id);
      return;
    }
    // Clicar fora fecha
    if(!ev.target.closest("#vsc-gear-panel")) _closeGearPanel();
  }, true);

  // Fechar ao scroll ou resize
  window.addEventListener("scroll", _closeGearPanel, { passive:true, capture:true });
  window.addEventListener("resize", _closeGearPanel, { passive:true });

  document.addEventListener("keydown", (ev)=>{
    if(ev.key === "Escape") _closeGearPanel();
  });

  // recovery buttons (empty-state)
  const btnEmptyNovo = document.getElementById("btnAnimaisNovoFromEmpty");
  if(btnEmptyNovo){
    btnEmptyNovo.addEventListener("click", (ev)=>{
      ev.preventDefault();
      try{
        const b = document.getElementById("btnNovo");
        if(b) b.click();
      }catch(_){}
    });
  }

  const btnImport = document.getElementById("btnAnimaisImportBackup");
  if(btnImport){
    btnImport.addEventListener("click", async (ev)=>{
      ev.preventDefault();
      try{
        if(window.VSC_DB && typeof window.VSC_DB.importBackupFile === "function"){
          const ok = await window.VSC_DB.importBackupFile();
          if(ok){
            vscToast("ok","Backup importado. Recarregando lista...",{ms:2200});
            await loadAll(); render();
          }else{
            vscToast("warn","Importação cancelada.",{ms:2200});
          }
        }else{
          vscToast("warn","Importação indisponível: VSC_DB.importBackupFile não encontrado.",{ms:3200});
        }
      }catch(e){
        vscToast("err","Falha ao importar backup: " + String(e && (e.message||e)),{ms:3200});
      }
    });
  }

  const btnScan = document.getElementById("btnAnimaisScanOtherDB");
  if(btnScan){
    btnScan.addEventListener("click", async (ev)=>{
      ev.preventDefault();
      const msg = document.getElementById("vscAnimaisRecoveryMsg");
      try{
        if(msg) msg.textContent = "Procurando animais em outros bancos (mesma origem)...";
        const r = await vsc_recoverAnimaisFromOtherDB();
        if(msg) msg.textContent = r.msg || "";
        if(r.ok){
          vscToast("ok", r.msg, {ms:2800});
          await loadAll(); render();
        }else{
          vscToast("warn", r.msg || "Nada para recuperar.", {ms:2800});
        }
      }catch(e){
        const t = "Falha na recuperação: " + String(e && (e.message||e));
        if(msg) msg.textContent = t;
        vscToast("err", t, {ms:3200});
      }
    });
  }


  const q = $("q");
  const fR = $("fRaca");
  const fP = $("fPelagem");
  const fE = $("fEspecie");
  const fC = $("fCliente");
  const fA = $("fAtivo");
  const lim = $("btnLimpar");
  const novo = $("btnNovo");
  const tb = $("tb");

  q && q.addEventListener("input", render);
  fR && fR.addEventListener("change", render);
  fP && fP.addEventListener("change", render);
  fE && fE.addEventListener("change", render);
  fC && fC.addEventListener("change", render);
  fA && fA.addEventListener("change", render);

  lim && lim.addEventListener("click", ()=>{
    if(q) q.value="";
    if(fR) fR.value="";
    if(fP) fP.value="";
    if(fE) fE.value="";
    if(fC) fC.value="";
    if(fA) fA.value="";
    render();
  });

  const nasc = $("aNasc");
  if(nasc && !nasc.__vscMasked){
    nasc.__vscMasked = true;
    nasc.setAttribute('inputmode', 'numeric');
    nasc.setAttribute('maxlength', '10');
    nasc.addEventListener('input', ()=>{
      nasc.value = maskDateInputValue(nasc.value);
    });
    nasc.addEventListener('blur', ()=>{ nasc.value = normalizeBirthValue(nasc.value); });
  }

  novo && novo.addEventListener("click", ()=>openAnimalModal(null));

  // delegação na tabela
  tb && tb.addEventListener("click", (ev)=>{
    const btn = ev.target.closest("button[data-act]");
    if(!btn) return;
    const act = btn.getAttribute("data-act");
    const id  = btn.getAttribute("data-id");
    if(act==="history"){ renderAnimalHistoryPanel(id); return; }
    if(act==="edit"){ openAnimalModal(id, { mode:"EDIT", openHistory:false }); return; }
    if(act==="toggle"){ toggleAnimal(id); return; }
    if(act==="del"){ delAnimal(id); return; }
  });

  const btnHistoryClose = document.getElementById("btnAnimalHistoryClose");
  btnHistoryClose && btnHistoryClose.addEventListener("click", closeAnimalHistoryModal);
  const bdAnimalHistory = document.getElementById("bdAnimalHistory");
  bdAnimalHistory && bdAnimalHistory.addEventListener("click", (ev)=>{
    if(ev.target === bdAnimalHistory) closeAnimalHistoryModal();
  });

  // botões catálogo (grid)
  const br = $("btnCadRacasGrid");
  const bp = $("btnCadPelagensGrid");
  br && br.addEventListener("click", ()=>openCatalog("racas"));
  bp && bp.addEventListener("click", ()=>openCatalog("pelagens"));
  $("btnCadRacasModal") && $("btnCadRacasModal").addEventListener("click", ()=>openCatalog("racas"));
  $("btnCadPelagensModal") && $("btnCadPelagensModal").addEventListener("click", ()=>openCatalog("pelagens"));

  // fechar/cancelar modal animal
  $("btnCancelarAnimal") && $("btnCancelarAnimal").addEventListener("click", closeAnimalModal);
  $("btnCancelarAnimal2") && $("btnCancelarAnimal2").addEventListener("click", closeAnimalModal);

  // salvar animal
  $("btnSalvarAnimal") && $("btnSalvarAnimal").addEventListener("click", saveAnimal);

  // VIEW ≠ EDIT: botão EDITAR (ação consciente)
  $("btnEditarAnimal") && $("btnEditarAnimal").addEventListener("click", (ev)=>{
    ev.preventDefault();
    __vsc_animal_requestEdit();
  });

  // FOTO
  $("aFotoFile") && $("aFotoFile").addEventListener("change", ()=>{ vsc_onFotoFileChange(); });
  $("aFotoClear") && $("aFotoClear").addEventListener("click", (ev)=>{ ev.preventDefault(); vsc_clearFoto(); });

  // catálogos: abrir pelo modal animal
  $("btnCadEspeciesModal") && $("btnCadEspeciesModal").addEventListener("click", ()=>openCatalog("especies"));

  // fechar catálogos
  $("c_racas_fechar") && $("c_racas_fechar").addEventListener("click", ()=>closeCatalog("racas"));
  $("c_pelagens_fechar") && $("c_pelagens_fechar").addEventListener("click", ()=>closeCatalog("pelagens"));
  $("c_especies_fechar") && $("c_especies_fechar").addEventListener("click", ()=>closeCatalog("especies"));

  // adicionar itens catálogo
  $("c_racas_add") && $("c_racas_add").addEventListener("click", ()=>catalogAdd("racas"));
  $("c_pelagens_add") && $("c_pelagens_add").addEventListener("click", ()=>catalogAdd("pelagens"));
  $("c_especies_add") && $("c_especies_add").addEventListener("click", ()=>catalogAdd("especies"));

  // ações catálogo (delegação)
  $("c_racas_tbody") && $("c_racas_tbody").addEventListener("click", (ev)=>catalogTableClick(ev,"racas"));
  $("c_pelagens_tbody") && $("c_pelagens_tbody").addEventListener("click", (ev)=>catalogTableClick(ev,"pelagens"));
  $("c_especies_tbody") && $("c_especies_tbody").addEventListener("click", (ev)=>catalogTableClick(ev,"especies"));
}

// ==========================================================
// MODAL ANIMAL
// ==========================================================
function openAnimalModal(id, opts){
  const options = opts || {};
  editingAnimalId = id || null;

  if(editingAnimalId){
    const a = (st_animais||[]).find(x=>x && x.id===editingAnimalId);
    if(!a) return;

    $("mAnimalTitle") && ($("mAnimalTitle").textContent = "Alterar Animal");

    const requestedMode = String(options.mode || "VIEW").toUpperCase();
    __vsc_animal_applyMode(requestedMode === "EDIT" ? "EDIT" : "VIEW");

    $("aNome") && ($("aNome").value = a.nome || "");
    $("aEspecie") && ($("aEspecie").value = a.especie_id || "");
    $("aSexo") && ($("aSexo").value = (function(){
      const sx = String(a.sexo||"").trim().toUpperCase();
      if(sx==="F") return "FEMEA";
      if(sx==="M") return "GARANHAO";
      if(["FEMEA","MATRIZ","GARANHAO","CASTRADO"].includes(sx)) return sx;
      return "";
    })());
    $("aNasc") && ($("aNasc").value = normalizeBirthValue(a.nascimento || ""));
    $("aRaca") && ($("aRaca").value = a.raca_id || "");
    $("aPelagem") && ($("aPelagem").value = a.pelagem_id || "");
    $("aMicrochip") && ($("aMicrochip").value = a.microchip || "");
    $("aPassaporte") && ($("aPassaporte").value = a.passaporte || "");
    $("aAtivo") && ($("aAtivo").value = (a.ativo===false || a.ativo===0 || a.ativo==="0") ? "0" : "1");
    $("aClienteId") && ($("aClienteId").value = a.cliente_id || "");
    $("aObs") && ($("aObs").value = a.observacoes || "");

    // FOTO
    vsc_setFotoUI(a.foto_data || "");
    if(options.openHistory === true){
      renderAnimalHistoryPanel(editingAnimalId);
    }else{
      closeAnimalHistoryModal();
    }
  }else{
    $("mAnimalTitle") && ($("mAnimalTitle").textContent = "Novo Animal");

    // CANÔNICO: novo abre em EDITANDO
    __vsc_animal_applyMode("EDIT");

    $("aNome") && ($("aNome").value = "");
    $("aEspecie") && ($("aEspecie").value = "");
    $("aSexo") && ($("aSexo").value = "");
    $("aNasc") && ($("aNasc").value = "");
    $("aRaca") && ($("aRaca").value = "");
    $("aPelagem") && ($("aPelagem").value = "");
    $("aMicrochip") && ($("aMicrochip").value = "");
    $("aPassaporte") && ($("aPassaporte").value = "");
    $("aAtivo") && ($("aAtivo").value = "1");
    $("aClienteId") && ($("aClienteId").value = "");
    $("aObs") && ($("aObs").value = "");

    vsc_clearFoto();
    renderAnimalHistoryPanel(null);
  }

  $("bdAnimal") && $("bdAnimal").classList.add("open");
  setTimeout(()=>{ $("aNome") && $("aNome").focus(); }, 20);
}

function closeAnimalModal(){
  $("bdAnimal") && $("bdAnimal").classList.remove("open");

  const f = $("aFotoFile");
  if(f) f.value = "";

  editingAnimalId = null;
}

// ==========================================================
// SAVE ANIMAL (IDB + OUTBOX) — com modal premium
// ==========================================================
async function saveAnimal(){
  if (window.__VSC_ANIMAL_UI_MODE !== "EDIT"){
    if(window.VSC_UI && window.VSC_UI.alert){
      vscToast("warn", String("Modo VISUALIZAÇÃO: clique em EDITAR para liberar alterações."), {ms:2600});
    }
    $("btnEditarAnimal") && $("btnEditarAnimal").focus();
    return;
  }

  const nome = ($("aNome")?.value||"").trim();
  const cliente_id = $("aClienteId")?.value || "";

  const foto_data = String($("aFotoData")?.value || "").trim();
  if(foto_data && !foto_data.startsWith("data:image/")){
    if(window.VSC_UI && window.VSC_UI.alert){
      vscToast("warn", String("Foto inválida. Remova e selecione novamente."), {ms:2600});
    }
    $("aFotoFile") && $("aFotoFile").focus();
    return;
  }

  if(!nome){
    if(window.VSC_UI && window.VSC_UI.alert){
      vscToast("warn", String("Informe o nome do animal."), {ms:2600});
    }
    $("aNome") && $("aNome").focus();
    return;
  }

  if(!cliente_id){
    if(window.VSC_UI && window.VSC_UI.alert){
      vscToast("warn", String("Selecione um cliente para vincular o animal antes de salvar."), {ms:2600});
    }
    $("aClienteId") && $("aClienteId").focus();
    return;
  }

  const cli = (st_clientes||[]).find(c => c && (c.id === cliente_id));
  if(cli && vsc_isClienteInativoOuBloqueado(cli)){
    if(window.VSC_UI && window.VSC_UI.alert){
      vscToast("warn", String("Este cliente está inativo ou bloqueado. Ative o cliente para vincular novos animais."), {ms:2600});
    }
    $("aClienteId") && $("aClienteId").focus();
    return;
  }

  const now = isoNow();

  let obj;
  let isEdit = false;

  if(editingAnimalId){
    const idx = (st_animais||[]).findIndex(x=>x && x.id===editingAnimalId);
    if(idx < 0) return;

    const prev = st_animais[idx];
    isEdit = true;

    obj = {
      ...prev,
      nome,
      especie_id: $("aEspecie")?.value || "",
      sexo: $("aSexo")?.value || "",
      nascimento: normalizeBirthValue(($("aNasc")?.value||"").trim()),
      raca_id: $("aRaca")?.value || "",
      pelagem_id: $("aPelagem")?.value || "",
      microchip: ($("aMicrochip")?.value||"").trim(),
      passaporte: ($("aPassaporte")?.value||"").trim(),
      ativo: ($("aAtivo")?.value === "1"),
      cliente_id,
      observacoes: ($("aObs")?.value||"").trim(),
      foto_data,
      updated_at: now
    };

    st_animais[idx] = obj;
  } else {
    obj = {
      id: vsc_uuidv4(),
      created_at: now,
      updated_at: now,
      last_sync: null,

      nome,
      especie_id: $("aEspecie")?.value || "",
      sexo: $("aSexo")?.value || "",
      nascimento: normalizeBirthValue(($("aNasc")?.value||"").trim()),
      raca_id: $("aRaca")?.value || "",
      pelagem_id: $("aPelagem")?.value || "",
      microchip: ($("aMicrochip")?.value||"").trim(),
      passaporte: ($("aPassaporte")?.value||"").trim(),
      ativo: ($("aAtivo")?.value === "1"),
      cliente_id,
      observacoes: ($("aObs")?.value||"").trim(),
      foto_data
    };

    st_animais.push(obj);
  }

  try{
    if (!window.VSC_DB || typeof window.VSC_DB.upsertWithOutbox !== "function") {
      throw new Error("VSC_DB.upsertWithOutbox não disponível (vsc_db.js não carregou).");
    }

    await window.VSC_DB.upsertWithOutbox(
      "animais_master",
      obj.id,
      obj,
      "animais"
    );

    closeAnimalModal();
    render();
    vscSnack(isEdit ? "Registro atualizado com sucesso." : "Salvo com sucesso.", "ok");
  }catch(e){
    vscToast("err", String("[ANIMAIS] Falha ao salvar via VSC_DB:", e), {ms:3200});
if(window.VSC_UI && window.VSC_UI.alert){
      await window.VSC_UI.alert("ERRO ao salvar (veja o console). " + (e && e.message ? e.message : e), "Erro");
    }
  }
}

// ==========================================================
// STATUS + DELETE (IDB + OUTBOX) — com modal premium
// ==========================================================
async function toggleAnimal(id){
  const idx = (st_animais||[]).findIndex(x=>x && x.id===id);
  if(idx<0) return;

  const a = st_animais[idx];
  const now = isoNow();
  const isAt = !(a.ativo===false || a.ativo===0 || a.ativo==="0");

  const updated = { ...a, ativo: !isAt, updated_at: now };

  try{
    if (!window.VSC_DB || typeof window.VSC_DB.upsertWithOutbox !== "function") {
      throw new Error("VSC_DB.upsertWithOutbox não disponível (vsc_db.js não carregou).");
    }

    await window.VSC_DB.upsertWithOutbox(
      "animais_master",
      updated.id,
      updated,
      "animais"
    );

    st_animais[idx] = updated;
    render();
    vscSnack(updated.ativo ? "Animal ativado." : "Animal inativado.", "ok");
  }catch(e){
    vscToast("err", String("[ANIMAIS] Falha ao ativar/inativar via VSC_DB:", e), {ms:3200});
if(window.VSC_UI && window.VSC_UI.alert){
      await window.VSC_UI.alert("ERRO ao atualizar status (veja o console). " + (e && e.message ? e.message : e), "Erro");
    }
  }
}

async function delAnimal(id){
  const idx = (st_animais||[]).findIndex(x=>x && x.id===id);
  if(idx<0) return;

  const a = st_animais[idx];

  const ok = (window.VSC_UI && window.VSC_UI.confirm)
    ? await vscConfirmAsync({title:"Confirmação", body:`Excluir "${a?.nome||"animal"}"?`, okText:"Confirmar", cancelText:"Cancelar", kind:"warn"}): false;

  if(!ok) return;

  const now = isoNow();
  const updated = { ...a, deleted:true, deleted_at: now, updated_at: now };

  try{
    if (!window.VSC_DB || typeof window.VSC_DB.upsertWithOutbox !== "function") {
      throw new Error("VSC_DB.upsertWithOutbox não disponível (vsc_db.js não carregou).");
    }

    // ── Soft-delete local (IDB) - sempre permitido para ADMIN/MASTER ──
    // Para sincronizar a remoção ao D1 (banco mãe), exige confirmação MASTER.
    // Literatura: "Distributed Systems - Martin Fowler" + LGPD Art.16 + OWASP re-autenticação.
    const db = await window.VSC_DB.openDB();
    await new Promise(function(res,rej){
      const tx = db.transaction(["animais_master"],"readwrite");
      const req = tx.objectStore("animais_master").put(updated);
      req.onsuccess = ()=>res(); req.onerror = ()=>rej(req.error);
    });
    db.close();

    st_animais.splice(idx, 1);
    render();

    // Verificar se é MASTER para propagar ao D1
    let isMaster = false;
    try{ await window.VSC_AUTH.requireRole("MASTER"); isMaster = true; }catch(_){}

    if(!isMaster){
      const senha = window.prompt("Para remover do banco central (D1), informe a senha MASTER. Em branco = cancelar.");
      if(senha){
        try{
          // verificação simplificada via IDB auth_users
          const db2 = await window.VSC_DB.openDB();
          const users = await new Promise(function(res,rej){
            const tx=db2.transaction(["auth_users"],"readonly");
            const req=tx.objectStore("auth_users").getAll();
            req.onsuccess=()=>res(req.result||[]); req.onerror=()=>rej(req.error);
          });
          db2.close();
          const masterUser = users.find(u=>u&&String(u.role||"").toUpperCase()==="MASTER");
          if(masterUser && (masterUser.password===senha||masterUser.password_hash===senha||
            (window.VSC_AUTH.verifyPassword&&await window.VSC_AUTH.verifyPassword(masterUser,senha)))){
            isMaster = true;
          } else {
            vscSnack("Senha MASTER incorreta. Animal ocultado localmente, não removido do D1.", "warn");
          }
        }catch(e){ console.warn("[ANIMAIS] verify master:", e); }
      }
    }

    if(isMaster){
      await window.VSC_DB.upsertWithOutbox("animais_master", updated.id, updated, "animais");
      vscSnack("Animal removido do sistema e do banco central.", "warn");
    } else {
      vscSnack("Animal ocultado localmente. Use conta MASTER para remover do banco central.", "warn");
    }
  }catch(e){
    vscToast("err", String("[ANIMAIS] Falha ao excluir via VSC_DB:", e), {ms:3200});
    if(window.VSC_UI && window.VSC_UI.alert){
      await window.VSC_UI.alert("ERRO ao excluir (veja o console). " + (e && e.message ? e.message : e), "Erro");
    }
  }
}

// (continua na PARTE 4/4)
// ==========================================================
// CATÁLOGOS — Persistência canônica no IndexedDB (IDB-only)
// stores: animais_racas / animais_pelagens / animais_especies
// ==========================================================
function vsc_catalogStore(kind){
  if(kind==="racas") return "animais_racas";
  if(kind==="pelagens") return "animais_pelagens";
  if(kind==="especies") return "animais_especies";
  throw new Error("catalog kind inválido");
}

function vsc_catalogNormalizeItem(it){
  const now = isoNow();
  const nome = String(it?.nome||"").trim();
  const ativo = (it?.ativo !== false);

  return {
    id: String(it?.id || vsc_uuidv4()),
    nome,
    nome_norm: nome.toLowerCase(),
    ativo,
    status: ativo ? "ATIVO" : "INATIVO",
    created_at: it?.created_at || now,
    updated_at: it?.updated_at || now,
    last_sync: (it?.last_sync ?? null),
    deleted: (it?.deleted === true),
    deleted_at: (it?.deleted_at ?? null)
  };
}

async function vsc_catalogUpsert(kind, item, action){
  if(!window.VSC_DB || typeof window.VSC_DB.openDB !== "function"){
    throw new Error("VSC_DB.openDB não disponível.");
  }

  const store = vsc_catalogStore(kind);
  const obj = vsc_catalogNormalizeItem(item);

  const db = await window.VSC_DB.openDB();
  try{
    await new Promise((resolve, reject)=>{
      const tx = db.transaction([store,"sync_queue"], "readwrite");
      tx.oncomplete = ()=>resolve(true);
      tx.onerror = ()=>reject(tx.error || new Error("Tx catálogo falhou"));
      tx.onabort = ()=>reject(tx.error || new Error("Tx catálogo abortada"));

      tx.objectStore(store).put(obj);

      tx.objectStore("sync_queue").put({
        id: vsc_uuidv4(),
        entity: "catalog",
        entity_id: String(obj.id),
        kind: kind,
        action: action || "upsert",
        payload: { id: obj.id, updated_at: obj.updated_at, status: obj.status, nome: obj.nome },
        status: "PENDING",
        created_at: isoNow(),
        updated_at: isoNow()
      });
    });
  } finally {
    try{ db.close(); }catch(_){}
  }

  return obj;
}

async function vsc_catalogSoftDelete(kind, item){
  const now = isoNow();
  const obj = vsc_catalogNormalizeItem({
    ...item,
    ativo: false,
    status: "DELETED",
    deleted: true,
    deleted_at: now,
    updated_at: now
  });
  return await vsc_catalogUpsert(kind, obj, "soft_delete");
}

async function vsc_loadCatalogFromIDB(storeName){
  if(!window.VSC_DB || typeof window.VSC_DB.openDB !== "function") return [];
  const db = await window.VSC_DB.openDB();
  try{
    const tx = db.transaction([storeName], "readonly");
    const st = tx.objectStore(storeName);
    const all = await new Promise((res, rej)=>{
      const rq = st.getAll();
      rq.onsuccess = ()=>res(rq.result || []);
      rq.onerror = ()=>rej(rq.error);
    });
    return Array.isArray(all) ? all : [];
  } finally {
    try{ db.close(); }catch(_){}
  }
}

async function vsc_catalogReloadToMemory(kind){
  const store = vsc_catalogStore(kind);
  const arr = await vsc_loadCatalogFromIDB(store);
  const clean = (Array.isArray(arr)?arr:[])
    .filter(x => !(x && x.deleted === true))
    .map(vsc_catalogNormalizeItem);

  if(kind==="racas") st_racas = clean;
  if(kind==="pelagens") st_pelagens = clean;
  if(kind==="especies") st_especies = clean;
}

// ==========================================================
// Catálogos — UI
// ==========================================================
function openCatalog(kind){
  if(kind==="racas")    $("bd_racas")?.classList.add("open");
  if(kind==="pelagens") $("bd_pelagens")?.classList.add("open");
  if(kind==="especies") $("bd_especies")?.classList.add("open");

  catalogRender(kind);

  if(kind==="racas") setTimeout(()=>$("c_racas_nome")?.focus(), 30);
  if(kind==="pelagens") setTimeout(()=>$("c_pelagens_nome")?.focus(), 30);
  if(kind==="especies") setTimeout(()=>$("c_especies_nome")?.focus(), 30);
}

function closeCatalog(kind){
  if(kind==="racas")    $("bd_racas")?.classList.remove("open");
  if(kind==="pelagens") $("bd_pelagens")?.classList.remove("open");
  if(kind==="especies") $("bd_especies")?.classList.remove("open");
  render();
}

function getCatalogState(kind){
  if(kind==="racas") return { arr: st_racas, ent:"raca" };
  if(kind==="pelagens") return { arr: st_pelagens, ent:"pelagem" };
  if(kind==="especies") return { arr: st_especies, ent:"especie" };
  throw new Error("catalog kind inválido");
}

function catalogRender(kind){
  const st = getCatalogState(kind);
  const tbId = (kind==="racas") ? "c_racas_tbody" : (kind==="pelagens") ? "c_pelagens_tbody" : "c_especies_tbody";
  const tb = $(tbId);
  if(!tb) return;

  tb.innerHTML = "";

  (st.arr||[]).forEach(it=>{
    if(it && it.deleted === true) return;

    const tr = document.createElement("tr");

    const tdN = document.createElement("td");
    const nome = String(it?.nome||"");
    const ativo = (it?.ativo !== false);

    tdN.innerHTML = `
      <div style="font-weight:900">${escapeHtml(nome || "-")}</div>
      <div style="margin-top:6px">
        ${ativo ? `<span class="pill">ATIVO</span>` : `<span class="pill pillOff">INATIVO</span>`}
      </div>
    `;
    tr.appendChild(tdN);

    const tdA = document.createElement("td");
    tdA.style.width = "220px";
    tdA.innerHTML = `
      <div style="display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end">
        <button class="btn btnMini ${ativo ? "btnWarn" : "btnPrimary"}" data-cact="toggle" data-id="${it.id}">
          ${ativo ? "Inativar" : "Ativar"}
        </button>
        <button class="btn btnMini btnGhost" data-cact="edit" data-id="${it.id}">Renomear</button>
        <button class="btn btnMini btnDanger" data-cact="del" data-id="${it.id}">Excluir</button>
      </div>
    `;
    tr.appendChild(tdA);

    tb.appendChild(tr);
  });
}

async function catalogAdd(kind){
  const inputId = kind==="racas" ? "c_racas_nome" : kind==="pelagens" ? "c_pelagens_nome" : "c_especies_nome";
  const inp = $(inputId);
  const nome = String(inp?.value||"").trim();

  if(!nome){
    vscToast("warn", String("Informe o nome."), {ms:2600});
    inp?.focus();
    return;
  }

  const st = getCatalogState(kind);
  const exists = (st.arr||[]).some(x => x && x.deleted !== true && String(x.nome||"").toLowerCase() === nome.toLowerCase());
  if(exists){
    vscToast("warn", String("Já existe."), {ms:2600});
    inp?.select();
    return;
  }

  try{
    const now = isoNow();
    const item = { id:vsc_uuidv4(), nome, created_at:now, updated_at:now, last_sync:null, ativo:true, status:"ATIVO", nome_norm:nome.toLowerCase() };
    await vsc_catalogUpsert(kind, item, "upsert");
    await vsc_catalogReloadToMemory(kind);

    if(inp) inp.value = "";
    catalogRender(kind);
    render();
    vscSnack("Catálogo salvo.", "ok");
  }catch(e){
    vscToast("err", String("[ANIMAIS] Falha ao salvar catálogo:", e), {ms:3200});
if(window.VSC_UI && window.VSC_UI.alert) await window.VSC_UI.alert("ERRO ao salvar catálogo (veja o console). " + (e?.message || e), "Erro");
  }
}

async function __vsc_toggleCatalogItem(kind, id){
  const st = getCatalogState(kind);
  const idx = (st.arr||[]).findIndex(x => x && x.id === id);
  if (idx < 0) return;

  const cur = st.arr[idx];
  const now = isoNow();
  const ativo = (cur.ativo !== false);

  const updated = { ...cur, ativo: !ativo, status: (!ativo ? "ATIVO" : "INATIVO"), updated_at: now };

  try{
    await vsc_catalogUpsert(kind, updated, "toggle_ativo");
    await vsc_catalogReloadToMemory(kind);
    catalogRender(kind);
    render();
    vscSnack(updated.ativo ? "Item ativado." : "Item inativado.", "ok");
  }catch(e){
    vscToast("err", String("[ANIMAIS] Falha ao ativar/inativar catálogo:", e), {ms:3200});
if(window.VSC_UI && window.VSC_UI.alert) await window.VSC_UI.alert("ERRO ao atualizar catálogo (veja o console). " + (e?.message || e), "Erro");
  }
}

// ==========================================================
// catalogTableClick — FIX CRÍTICO (chaves + fluxo correto)
// ==========================================================
async function catalogTableClick(ev, kind){
  const btn = ev.target.closest("button[data-cact]");
  if(!btn) return;

  const act = btn.getAttribute("data-cact");
  const id  = btn.getAttribute("data-id");

  const st = getCatalogState(kind);
  const idx = (st.arr||[]).findIndex(x=>x && x.id===id);
  if(idx<0) return;

  // TOGGLE
  if(act==="toggle"){
    await __vsc_toggleCatalogItem(kind, id);
    return;
  }

  // RENAME
  if(act==="edit"){
    const cur = st.arr[idx];
    const novo = prompt("Novo nome:", cur?.nome||"");
    if(novo===null) return;

    const nome = String(novo||"").trim();
    if(!nome) return;

    const dup = (st.arr||[]).some(x=>x && x.id!==id && String(x.nome||"").toLowerCase()===nome.toLowerCase() && x.deleted !== true);
    if(dup){
      vscToast("warn", String("Já existe."), {ms:2600});
      return;
    }

    const now = isoNow();
    const updated = { ...cur, nome, nome_norm: nome.toLowerCase(), updated_at: now, status: (cur.ativo!==false ? "ATIVO" : "INATIVO") };

    try{
      await vsc_catalogUpsert(kind, updated, "rename");
      await vsc_catalogReloadToMemory(kind);
      catalogRender(kind);
      render();
      vscSnack("Nome atualizado.", "ok");
    }catch(e){
      vscToast("err", String("[ANIMAIS] Falha ao renomear catálogo:", e), {ms:3200});
if(window.VSC_UI && window.VSC_UI.alert) await window.VSC_UI.alert("ERRO ao renomear (veja o console). " + (e?.message || e), "Erro");
    }
    return;
  }

  // DELETE
  if(act==="del"){
    const cur = st.arr[idx];

    const ok = (window.VSC_UI && window.VSC_UI.confirm)
      ? await vscConfirmAsync({title:"Confirmação", body:`Excluir "${cur?.nome||""}"?`, okText:"Confirmar", cancelText:"Cancelar", kind:"warn"}): false;

    if(!ok) return;

    const used = (kind==="racas")
      ? (st_animais||[]).some(a=>a && a.raca_id===id)
      : (kind==="pelagens")
        ? (st_animais||[]).some(a=>a && a.pelagem_id===id)
        : (st_animais||[]).some(a=>a && a.especie_id===id);

    if(used){
      vscToast("warn", String("Não é possível excluir: item em uso em animais."), {ms:2600});
      return;
    }

    try{
      await vsc_catalogSoftDelete(kind, cur);
      await vsc_catalogReloadToMemory(kind);
      catalogRender(kind);
      render();
      vscSnack("Item excluído.", "warn");
    }catch(e){
      vscToast("err", String("[ANIMAIS] Falha ao excluir catálogo:", e), {ms:3200});
if(window.VSC_UI && window.VSC_UI.alert) await window.VSC_UI.alert("ERRO ao excluir (veja o console). " + (e?.message || e), "Erro");
    }
    return;
  }
}

// ==========================================================
// MIGRAÇÃO PREMIUM — sync_queue legado (localStorage → IndexedDB)
// ==========================================================
async function vsc_migrateLegacySyncQueue(){
  try{
    const raw = localStorage.getItem("sync_queue");
    if(!raw) return;

    let arr = null;
    try{ arr = JSON.parse(raw); }catch(_){ arr = null; }

    if(!Array.isArray(arr) || arr.length === 0){
      localStorage.removeItem("sync_queue");
      return;
    }

    const ok = await vscConfirmAsync({
      title: "Migração",
      body: "Foi encontrada uma fila LEGADA (sync_queue) no localStorage com " + arr.length + " item(ns).\n\nRECOMENDADO: MIGRAR para o IndexedDB (vsc_db) e remover do localStorage.",
      okText: "MIGRAR",
      cancelText: "CANCELAR",
      kind: "warn"
    });

    if(!ok) return;

    if(!window.VSC_DB || typeof window.VSC_DB.openDB !== "function"){
      throw new Error("VSC_DB.openDB não disponível para migração.");
    }

    const db = await window.VSC_DB.openDB();
    const tx = db.transaction(["sync_queue"], "readwrite");
    const st = tx.objectStore("sync_queue");

    for(const it of arr){
      try{
        const row = Object.assign({}, it);
        if(!row.id) row.id = vsc_uuidv4();
        row.created_at = row.created_at || isoNow();
        row.updated_at = row.updated_at || isoNow();
        st.put(row);
      }catch(_){}
    }

    await new Promise((res, rej)=>{
      tx.oncomplete = () => res(true);
      tx.onerror = () => rej(tx.error || new Error("TX erro"));
      tx.onabort = () => rej(tx.error || new Error("TX abort"));
    });

    try{ db.close(); }catch(_){}
    localStorage.removeItem("sync_queue");
    vscToast("ok", "Fila LEGADA (sync_queue) migrada para o banco offline.", {ms:2600});
  }catch(e){
    vscToast("warn", "[ANIMAIS] Migração da sync_queue falhou: " + String(e && (e.message||e)), {ms:3200});
  }
}

async function vsc_migrateAnimaisCatalogosToIDB(){
  try{
    const kEsp = "animais_especies";
    const kRac = "animais_racas";
    const kPel = "animais_pelagens";

    const rawEsp = localStorage.getItem(kEsp);
    const rawRac = localStorage.getItem(kRac);
    const rawPel = localStorage.getItem(kPel);

    if(!rawEsp && !rawRac && !rawPel) return;

    const ok = await vscConfirmAsync({
      title: "Migração",
      body: "Foram encontrados catálogos LEGADOS (espécies/raças/pelagens) no localStorage.\n\nRECOMENDADO: Migrar para o IndexedDB (vsc_db) e remover do localStorage.",
      okText: "MIGRAR",
      cancelText: "CANCELAR",
      kind: "warn"
    });

    if(!ok) return;

    if(!window.VSC_DB || typeof window.VSC_DB.openDB !== "function"){
      throw new Error("VSC_DB.openDB não disponível para migração.");
    }

    const db = await window.VSC_DB.openDB();
    const tx = db.transaction(["catalogs_master"], "readwrite");
    const st = tx.objectStore("catalogs_master");

    function putCatalog(cat, arr){
      if(!Array.isArray(arr)) return;
      for(const it of arr){
        try{
          const row = {
            id: (it && it.id) ? String(it.id) : vsc_uuidv4(),
            cat: String(cat),
            nome: String((it && (it.nome||it.name||it.label)) || "").trim(),
            ativo: (it && typeof it.ativo==="boolean") ? it.ativo : true,
            deleted: false,
            created_at: (it && it.created_at) ? String(it.created_at) : isoNow(),
            updated_at: isoNow(),
            last_sync: (it && it.last_sync) ? String(it.last_sync) : ""
          };
          if(!row.nome) continue;
          st.put(row);
        }catch(_){}
      }
    }

    let esp=null, rac=null, pel=null;
    try{ esp = rawEsp ? JSON.parse(rawEsp) : null; }catch(_){ esp=null; }
    try{ rac = rawRac ? JSON.parse(rawRac) : null; }catch(_){ rac=null; }
    try{ pel = rawPel ? JSON.parse(rawPel) : null; }catch(_){ pel=null; }

    putCatalog("animais_especies", esp);
    putCatalog("animais_racas", rac);
    putCatalog("animais_pelagens", pel);

    await new Promise((res, rej)=>{
      tx.oncomplete = () => res(true);
      tx.onerror = () => rej(tx.error || new Error("TX erro"));
      tx.onabort = () => rej(tx.error || new Error("TX abort"));
    });

    try{ db.close(); }catch(_){}
    localStorage.removeItem(kEsp);
    localStorage.removeItem(kRac);
    localStorage.removeItem(kPel);

    vscToast("ok", "Catálogos legados migrados para o banco offline.", {ms:2600});
  }catch(e){
    vscToast("warn", "[ANIMAIS] Migração de catálogos falhou: " + String(e && (e.message||e)), {ms:3200});
  }
}



// ==========================================================
// KUX ENGINE — AK (CANÔNICO)
// ==========================================================
(function VSC_KUX_ENGINE_AK(){
  if (window.__VSC_KUX_INSTALLED) return;
  window.__VSC_KUX_INSTALLED = true;

  function kuxProfile(el){
    if(!el || !el.closest) return "";
    const host = el.closest("[data-kux]");
    if(!host) return "";
    return String(host.getAttribute("data-kux") || "").trim().toLowerCase();
  }

  function isForbiddenTarget(t){
    if(!t || !t.tagName) return true;
    const tag = t.tagName.toUpperCase();

    if(tag === "TEXTAREA") return true;
    if(tag === "BUTTON") return true;
    if(tag === "A") return true;
    if(tag === "SELECT") return true;

    const role = String(t.getAttribute?.("role") || "").toLowerCase();
    if(role === "combobox") return true;
    const ariaAC = String(t.getAttribute?.("aria-autocomplete") || "").toLowerCase();
    if(ariaAC && ariaAC !== "none") return true;

    if(t.closest && (t.closest("table") || t.closest('[role="grid"]'))) return true;
    if(t.isContentEditable) return true;

    if(tag === "INPUT"){
      const type = String(t.getAttribute("type") || "text").toLowerCase();
      if(["button","submit","reset","checkbox","radio","file","hidden"].includes(type)) return true;
      if(t.readOnly || t.disabled) return true;
    }
    return false;
  }

  function focusablesIn(container){
    const all = [...container.querySelectorAll("input,[tabindex]:not([tabindex='-1'])")];
    return all.filter(el=>{
      if(!el || !el.tagName) return false;
      if(el.disabled) return false;
      const style = window.getComputedStyle(el);
      if(style.display === "none" || style.visibility === "hidden") return false;

      const tag = el.tagName.toUpperCase();
      if(tag !== "INPUT") return false;

      const type = String(el.getAttribute("type") || "text").toLowerCase();
      if(["button","submit","reset","checkbox","radio","file","hidden"].includes(type)) return false;
      if(el.readOnly) return false;
      return true;
    });
  }

  function focusNext(container, current){
    const list = focusablesIn(container);
    if(!list.length) return false;
    const idx = list.indexOf(current);
    const next = list[(idx >= 0 ? idx + 1 : 0)] || null;
    if(next){ next.focus(); return true; }
    return false;
  }

  document.addEventListener("keydown", function(ev){
    if(ev.key !== "Enter") return;
    const t = ev.target;
    if(kuxProfile(t) !== "data-entry") return;
    if(isForbiddenTarget(t)) return;

    const container = t.closest("[data-kux='data-entry']");
    if(!container) return;

    ev.preventDefault();
    focusNext(container, t);
  }, true);
})();

// ==========================================================
// BOOT FINAL (IDB-only + migrações premium)
// ==========================================================
(async function init(){
  await vsc_migrateLegacySyncQueue();
  await vsc_migrateAnimaisCatalogosToIDB();

  st_racas    = await vsc_loadCatalogFromIDB("animais_racas");
  st_pelagens = await vsc_loadCatalogFromIDB("animais_pelagens");
  st_especies = await vsc_loadCatalogFromIDB("animais_especies");


  await vsc_seedDefaultsIfNeeded();
  await loadAll();
  wireUI();
  render();
})();
