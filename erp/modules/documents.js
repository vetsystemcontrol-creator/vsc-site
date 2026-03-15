/* ============================================================
   VSC — Documentos/Anexos (PDF + Imagens) — v1 (offline-first)
   Store: documents_store (IndexedDB vsc_db)
   Objetivo:
   - Anexar PDF/fotos a qualquer entidade (entity_type + entity_id)
   - Visualizar/baixar
   - Preparar renderização para impressão de relatórios (best-effort)
   ============================================================ */
(function(){
  "use strict";

  if(window.VSC_DOCS){ return; }

  const STORE = "documents_store";
  const MAX_BYTES_DEFAULT = 15 * 1024 * 1024; // 15MB (padrão enterprise conservador)
  const ALLOWED = {
    "application/pdf": true,
    "image/png": true,
    "image/jpeg": true,
    "image/webp": true
  };

  function nowISO(){ return new Date().toISOString(); }
  function uuid(){
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
    throw new TypeError("[DOCS] ambiente sem CSPRNG para gerar UUID v4.");
  }

  function mustHaveDb(){
    if(!window.VSC_DB || typeof window.VSC_DB.openDB !== "function"){
      throw new Error("[VSC_DOCS] VSC_DB indisponível.");
    }
  }

  async function openDb(){
    mustHaveDb();
    return await window.VSC_DB.openDB();
  }

  async function sha256Hex(blob){
    // Hash de integridade (SHA-256) — alinhado a práticas de integridade de artefatos
    const ab = await blob.arrayBuffer();
    const hash = await crypto.subtle.digest("SHA-256", ab);
    const bytes = new Uint8Array(hash);
    let hex = "";
    for(let i=0;i<bytes.length;i++){
      hex += bytes[i].toString(16).padStart(2,"0");
    }
    return hex;
  }

  function sanitizeFileName(name){
    const s = String(name||"arquivo").replace(/[\/:*?"<>|]+/g, "_").trim();
    return s || "arquivo";
  }

  async function list(entity_type, entity_id){
    const db = await openDb();
    return await new Promise((resolve, reject)=>{
      try{
        const tx = db.transaction([STORE], "readonly");
        const st = tx.objectStore(STORE);
        const ix = st.index("entity_type_id");
        const rq = ix.getAll([String(entity_type||""), String(entity_id||"")]);
        rq.onsuccess = ()=> resolve(rq.result||[]);
        rq.onerror = ()=> reject(rq.error || new Error("Falha list documents"));
      }catch(e){ reject(e); }
    });
  }

  async function get(doc_id){
    const db = await openDb();
    return await new Promise((resolve, reject)=>{
      try{
        const tx = db.transaction([STORE], "readonly");
        const st = tx.objectStore(STORE);
        const rq = st.get(String(doc_id));
        rq.onsuccess = ()=> resolve(rq.result||null);
        rq.onerror = ()=> reject(rq.error || new Error("Falha get document"));
      }catch(e){ reject(e); }
    });
  }

  async function remove(doc_id){
    const db = await openDb();
    return await new Promise((resolve, reject)=>{
      try{
        const tx = db.transaction([STORE], "readwrite");
        const st = tx.objectStore(STORE);
        const rq = st.delete(String(doc_id));
        rq.onsuccess = ()=> resolve(true);
        rq.onerror = ()=> reject(rq.error || new Error("Falha delete document"));
      }catch(e){ reject(e); }
    });
  }

  async function addFiles(entity_type, entity_id, fileList, opts){
    opts = opts || {};
    const maxBytes = typeof opts.max_bytes === "number" ? opts.max_bytes : MAX_BYTES_DEFAULT;

    if(!entity_type || !entity_id) throw new Error("[VSC_DOCS] entity_type/entity_id obrigatórios.");
    if(!fileList || !fileList.length) return { ok:true, added:0 };

    let added = 0;

    for(const f of Array.from(fileList)){
      const mime = String(f.type||"").toLowerCase();
      if(!ALLOWED[mime]){
        throw new Error("[VSC_DOCS] Tipo não permitido: " + (mime||"(desconhecido)") + " — permitido: PDF/PNG/JPEG/WEBP.");
      }
      if(f.size > maxBytes){
        throw new Error("[VSC_DOCS] Arquivo acima do limite (" + Math.round(maxBytes/1024/1024) + "MB): " + f.name);
      }

      const id = uuid();
      const file_name = sanitizeFileName(f.name);
      const created_at = nowISO();
      const blob = f; // File é Blob

      const sha256 = await sha256Hex(blob);

      const doc = {
        id,
        entity_type: String(entity_type),
        entity_id: String(entity_id),

        file_name,
        mime_type: mime,
        size_bytes: Number(f.size||0),
        sha256,

        version: 1,
        created_at,
        updated_at: created_at,
        last_sync: null,

        // binário offline-first
        file_blob: blob
      };

      // UPSERT + OUTBOX (mesma transação) — origem AUTO (sem auditoria master)
      await window.VSC_DB.upsertWithOutbox(
        STORE,
        doc,
        "DOCUMENT",
        id,
        { __origin:"AUTO", entity_type: doc.entity_type, entity_id: doc.entity_id, mime_type: doc.mime_type, sha256: doc.sha256, size_bytes: doc.size_bytes }
      );

      added++;
    }

    return { ok:true, added };
  }

  function humanBytes(n){
    const x = Number(n||0);
    if(x < 1024) return x + " B";
    if(x < 1024*1024) return (x/1024).toFixed(1) + " KB";
    return (x/1024/1024).toFixed(2) + " MB";
  }

  // ============================================================
  // Modal UI (opcional, usado por relatorios.js)
  // ============================================================
  let MODAL = null;
  function ensureModal(){
    if(MODAL) return MODAL;

    const el = document.getElementById("vscDocsModal");
    if(!el) return null;

    const file = el.querySelector("#vscDocsFile");
    const listEl = el.querySelector("#vscDocsList");
    const title = el.querySelector("#vscDocsTitle");
    const btnClose = el.querySelector("[data-vsc-docs-close]");
    const btnAttach = el.querySelector("#vscDocsAttach");

    if(btnClose){
      btnClose.addEventListener("click", ()=>{ el.style.display="none"; });
    }

    MODAL = { el, file, listEl, title, btnAttach, current:null };
    return MODAL;
  }

  async function openFor(entity_type, entity_id){
    const m = ensureModal();
    if(!m){
      throw new Error("[VSC_DOCS] Modal não encontrado no HTML (vscDocsModal).");
    }
    m.current = { entity_type, entity_id };
    m.title.textContent = "Anexos — " + entity_type + " • " + entity_id;
    m.el.style.display = "block";
    await refreshModal();
  }

  async function refreshModal(){
    const m = ensureModal();
    if(!m || !m.current) return;

    const rows = await list(m.current.entity_type, m.current.entity_id);
    m.listEl.innerHTML = "";

    if(!rows.length){
      const div = document.createElement("div");
      div.style.opacity = "0.7";
      div.style.padding = "10px 6px";
      div.textContent = "Nenhum anexo. Use “Anexar”.";
      m.listEl.appendChild(div);
      return;
    }

    for(const d of rows.sort((a,b)=> String(b.created_at||"").localeCompare(String(a.created_at||"")) )){
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.gap = "10px";
      row.style.alignItems = "center";
      row.style.justifyContent = "space-between";
      row.style.padding = "8px 6px";
      row.style.borderBottom = "1px solid rgba(0,0,0,.06)";

      const left = document.createElement("div");
      left.innerHTML = "<b style='font-size:12px'>" + (d.file_name||"(arquivo)") + "</b>" +
        "<div style='font-size:11px;opacity:.75'>" + (d.mime_type||"") + " • " + humanBytes(d.size_bytes) + "</div>";

      const right = document.createElement("div");
      right.style.display = "flex";
      right.style.gap = "8px";

      const btnView = document.createElement("button");
      btnView.type = "button";
      btnView.className = "ghost";
      btnView.textContent = "Visualizar";
      btnView.addEventListener("click", async ()=>{
        const obj = await get(d.id);
        if(!obj || !obj.file_blob) return;
        const url = URL.createObjectURL(obj.file_blob);
        window.open(url, "_blank", "noopener");
        // não revoga imediatamente (janela nova precisa)
        setTimeout(()=>{ try{ URL.revokeObjectURL(url);}catch(_){} }, 60_000);
      });

      const btnDel = document.createElement("button");
      btnDel.type = "button";
      btnDel.className = "danger";
      btnDel.textContent = "Excluir";
      btnDel.addEventListener("click", async ()=>{
        await remove(d.id);
        await refreshModal();
        (window.VSC_UI?window.VSC_UI.toast("ok","Anexo excluído.",{ms:1800}):null);
      });

      right.appendChild(btnView);
      right.appendChild(btnDel);

      row.appendChild(left);
      row.appendChild(right);
      m.listEl.appendChild(row);
    }
  }

  async function attachFromModal(){
    const m = ensureModal();
    if(!m || !m.current) return;
    const files = m.file.files;
    if(!files || !files.length){
      (window.VSC_UI?window.VSC_UI.toast("warn","Selecione um arquivo PDF ou imagem.",{ms:2200}):null);
      return;
    }
    const r = await addFiles(m.current.entity_type, m.current.entity_id, files);
    m.file.value = "";
    await refreshModal();
    (window.VSC_UI?window.VSC_UI.toast("ok","Anexos adicionados: "+r.added,{ms:2200}):null);
  }

  // bind modal attach
  document.addEventListener("DOMContentLoaded", ()=>{
    const m = ensureModal();
    if(!m) return;
    if(m.btnAttach) m.btnAttach.addEventListener("click", ()=>{ attachFromModal().catch(e=> (window.VSC_UI?window.VSC_UI.toast("err", String(e&&e.message||e), {ms:3200}):alert(String(e)))); });
  });

  // ============================================================
  // Render para impressão (best-effort)
  // ============================================================
  async function renderAttachmentsForPrint(container, entity_type, entity_id){
    const rows = await list(entity_type, entity_id);

    const wrap = document.createElement("div");
    wrap.className = "vsc-print-attachments";

    const h = document.createElement("h3");
    h.textContent = "Anexos";
    h.style.margin = "10px 0 6px";
    h.style.fontSize = "14px";
    wrap.appendChild(h);

    if(!rows.length){
      const p = document.createElement("div");
      p.style.opacity = "0.7";
      p.textContent = "Sem anexos.";
      wrap.appendChild(p);
      container.appendChild(wrap);
      return { urls: [] };
    }

    const urlsToRevoke = [];

    for(const d of rows.sort((a,b)=> String(a.created_at||"").localeCompare(String(b.created_at||"")) )){
      const obj = await get(d.id);
      if(!obj || !obj.file_blob) continue;

      const url = URL.createObjectURL(obj.file_blob);
      urlsToRevoke.push(url);

      const block = document.createElement("div");
      block.className = "vsc-print-attach";
      block.style.pageBreakInside = "avoid";
      block.style.margin = "10px 0 14px";
      block.innerHTML = "<div style='font-size:12px;opacity:.85;margin-bottom:6px'><b>"+(obj.file_name||"arquivo")+"</b> • "+(obj.mime_type||"")+" • "+humanBytes(obj.size_bytes)+"</div>";

      if(String(obj.mime_type||"") === "application/pdf"){
        // Best-effort: embed do PDF. Em alguns ambientes o print pode variar.
        const embed = document.createElement("embed");
        embed.src = url;
        embed.type = "application/pdf";
        embed.style.width = "100%";
        embed.style.height = "92vh";
        embed.style.border = "1px solid rgba(0,0,0,.12)";
        embed.style.borderRadius = "10px";
        block.appendChild(embed);
      }else{
        const img = document.createElement("img");
        img.src = url;
        img.alt = obj.file_name || "imagem";
        img.style.maxWidth = "100%";
        img.style.height = "auto";
        img.style.border = "1px solid rgba(0,0,0,.12)";
        img.style.borderRadius = "10px";
        block.appendChild(img);
      }

      wrap.appendChild(block);
    }

    container.appendChild(wrap);
    return { urls: urlsToRevoke };
  }

  window.VSC_DOCS = {
    STORE,
    addFiles,
    list,
    get,
    remove,
    openFor,
    renderAttachmentsForPrint
  };

  console.log("[VSC_DOCS] ready", { store: STORE });
})();
