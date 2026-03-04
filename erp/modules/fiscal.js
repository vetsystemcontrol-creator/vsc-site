/* global VSC_AUTH */
"use strict";

(function(){
  const DB_NAME = "vsc_fiscal_db";
  const DB_VER  = 1;
  const STORE_DOCS = "nfe_docs";

  function $(id){ return document.getElementById(id); }
  function nowISO(){ return new Date().toISOString(); }

  function toCentsBRL(v){
    const s = String(v||"").trim();
    if(!s) return 0;
    // aceita "1.234,56" e "1234,56" e "1234.56"
    const norm = s.replace(/\./g, "").replace(/,/g, ".");
    const n = Number(norm);
    if(!isFinite(n)) return 0;
    return Math.round(n * 100);
  }
  function centsToBRL(c){
    const n = Number(c||0);
    const v = (n/100).toFixed(2);
    return v.replace(/\./g, ",");
  }

  function badgeForStatus(st){
    const s = String(st||"DRAFT").toUpperCase();
    if(s === "AUTHORIZED") return { cls:"b-auth", label:"AUTORIZADA" };
    if(s === "REJECTED") return { cls:"b-rej", label:"REJEITADA" };
    if(s === "SENT") return { cls:"b-sent", label:"ENVIADA" };
    if(s === "SIGNED") return { cls:"b-signed", label:"ASSINADA" };
    return { cls:"b-draft", label:"DRAFT" };
  }

  function setMsg(text, kind){
    const el = $("msgArea");
    el.textContent = String(text||"—");
    el.style.color = kind === "err" ? "var(--danger)" : (kind === "ok" ? "var(--ok)" : "var(--muted)");
  }
  function setCertMsg(text, kind){
    const el = $("certMsg");
    el.textContent = String(text||"—");
    el.style.color = kind === "err" ? "var(--danger)" : (kind === "ok" ? "var(--ok)" : "var(--muted)");
  }

  // -------------------- IndexedDB (local) --------------------
  function openDB(){
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if(!db.objectStoreNames.contains(STORE_DOCS)){
          const st = db.createObjectStore(STORE_DOCS, { keyPath:"id" });
          st.createIndex("by_updated", "updated_at", { unique:false });
          st.createIndex("by_status", "status", { unique:false });
          st.createIndex("by_num", "numero", { unique:false });
          st.createIndex("by_dest", "dest_nome", { unique:false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbPutDoc(doc){
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_DOCS], "readwrite");
      const st = tx.objectStore(STORE_DOCS);
      const r = st.put(doc);
      r.onsuccess = () => resolve(true);
      r.onerror = () => reject(r.error);
      tx.oncomplete = () => db.close();
      tx.onerror = () => { try{ db.close(); }catch(_){} };
    });
  }

  async function dbDeleteDoc(id){
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_DOCS], "readwrite");
      const st = tx.objectStore(STORE_DOCS);
      const r = st.delete(String(id));
      r.onsuccess = () => resolve(true);
      r.onerror = () => reject(r.error);
      tx.oncomplete = () => db.close();
      tx.onerror = () => { try{ db.close(); }catch(_){} };
    });
  }

  async function dbGetAllDocs(){
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_DOCS], "readonly");
      const st = tx.objectStore(STORE_DOCS);
      const idx = st.index("by_updated");
      const out = [];
      idx.openCursor(null, "prev").onsuccess = (e) => {
        const cur = e.target.result;
        if(cur){ out.push(cur.value); cur.continue(); }
        else { resolve(out); }
      };
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => db.close();
    });
  }

  // -------------------- UI State --------------------
  let currentId = null;
  let cache = [];

  function getForm(){
    return {
      serie: String($("fSerie").value||"").trim() || "1",
      numero: String($("fNumero").value||"").trim(),
      ambiente: String($("fAmbiente").value||"HOMOLOG").trim(),
      dest_nome: String($("fDestNome").value||"").trim(),
      dest_doc: String($("fDestDoc").value||"").trim(),
      total_cents: toCentsBRL($("fTotal").value),
      obs: String($("fObs").value||"").trim(),
    };
  }

  function setForm(doc){
    $("fSerie").value = doc ? (doc.serie || "1") : "1";
    $("fNumero").value = doc ? (doc.numero || "") : "";
    $("fAmbiente").value = doc ? (doc.ambiente || "HOMOLOG") : "HOMOLOG";
    $("fDestNome").value = doc ? (doc.dest_nome || "") : "";
    $("fDestDoc").value = doc ? (doc.dest_doc || "") : "";
    $("fTotal").value = doc ? centsToBRL(doc.total_cents || 0) : "0,00";
    $("fObs").value = doc ? (doc.obs || "") : "";
  }

  function setStatusPill(doc){
    const el = $("docStatusPill");
    if(!doc){
      el.className = "pill";
      el.textContent = "Status: —";
      return;
    }
    const b = badgeForStatus(doc.status);
    el.className = "pill " + (b.label === "REJEITADA" ? "err" : (b.label === "AUTORIZADA" ? "ok" : ""));
    el.textContent = `Status: ${b.label}`;
  }

  function setButtons(doc){
    const has = !!(doc && doc.id);
    $("btnExcluir").disabled = !has;
    // stubs — habilitados quando houver certificado + implementação futura
    $("btnAssinar").disabled = true;
    $("btnEnviar").disabled = true;
  }

  function renderTable(){
    const q = String($("q").value||"").trim().toLowerCase();
    const tb = $("tb");
    tb.innerHTML = "";

    const rows = (q ? cache.filter(d => {
      const hay = `${d.dest_nome||""} ${d.numero||""} ${d.serie||""} ${d.chave||""}`.toLowerCase();
      return hay.includes(q);
    }) : cache);

    for(const d of rows){
      const b = badgeForStatus(d.status);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><span class="badge ${b.cls}">${b.label}</span></td>
        <td><div style="font-weight:900;">${(d.serie||"1")}/${(d.numero||"—")}</div><div class="muted small">${d.ambiente||"HOMOLOG"}</div></td>
        <td><div style="font-weight:900;">${d.dest_nome||"(sem destinatário)"}</div><div class="muted small">${d.dest_doc||""}</div></td>
        <td><div style="font-weight:900;">R$ ${centsToBRL(d.total_cents||0)}</div><div class="muted small">${(d.updated_at||"").slice(0,19).replace("T"," ")}</div></td>
        <td class="td-actions">
          <button class="linkbtn" data-open="${d.id}">Abrir</button>
        </td>
      `;
      tb.appendChild(tr);
    }

    tb.querySelectorAll("button[data-open]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-open");
        const doc = cache.find(x => x.id === id);
        if(!doc) return;
        currentId = doc.id;
        setForm(doc);
        setStatusPill(doc);
        setButtons(doc);
        setMsg(`Abrindo ${doc.serie||"1"}/${doc.numero||"—"} (${doc.status||"DRAFT"})`, "ok");
        window.scrollTo({ top:0, behavior:"smooth" });
      });
    });

    updateKPIs(cache);
  }

  function updateKPIs(all){
    const total = all.length;
    const auth = all.filter(x => String(x.status||"").toUpperCase()==="AUTHORIZED").length;
    const rej  = all.filter(x => String(x.status||"").toUpperCase()==="REJECTED").length;
    const pend = all.filter(x => ["DRAFT","SIGNED","SENT"].includes(String(x.status||"DRAFT").toUpperCase())).length;
    $("kpiTotal").textContent = String(total);
    $("kpiAuth").textContent = String(auth);
    $("kpiRejected").textContent = String(rej);
    $("kpiPending").textContent = String(pend);
  }

  async function refreshList(){
    cache = await dbGetAllDocs();
    renderTable();
  }

  // -------------------- Certificado (backend local) --------------------
  async function fetchCertStatus(){
    const pill = $("certPill");
    try{
      const r = await fetch("/api/fiscal/cert/status", { cache:"no-store" });
      const j = await r.json();
      if(!j || !j.ok) throw new Error((j && j.error) ? j.error : "Falha");
      if(j.has_cert){
        pill.className = "pill ok";
        pill.textContent = "Certificado: OK";
        setCertMsg(`A1 presente (hash: ${String(j.blob_sha256||"").slice(0,12)}…)`, "ok");
      }else{
        pill.className = "pill warn";
        pill.textContent = "Certificado: ausente";
        setCertMsg("Nenhum certificado A1 importado.", "");
      }
    }catch(e){
      pill.className = "pill err";
      pill.textContent = "Certificado: erro";
      setCertMsg(`Falha ao consultar status do certificado: ${String(e && e.message ? e.message : e)}`, "err");
    }
  }

  async function importCertA1(){
    const file = $("certFile").files && $("certFile").files[0];
    const pass = String($("certPass").value||"").trim();
    if(!file){ setCertMsg("Selecione o arquivo .PFX/.P12.", "err"); return; }
    if(!pass){ setCertMsg("Informe a senha do certificado.", "err"); return; }

    try{
      const buf = await file.arrayBuffer();
      // Base64 seguro (evita overflow de stack em arquivos maiores)
      const bytes = new Uint8Array(buf);
      let bin = "";
      const CHUNK = 0x8000;
      for(let i=0; i<bytes.length; i+=CHUNK){
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i+CHUNK));
      }
      const b64 = btoa(bin);
      const r = await fetch("/api/fiscal/cert/a1/import", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ pfx_b64: b64, password: pass })
      });
      const j = await r.json().catch(()=>null);
      if(!r.ok || !j || !j.ok){
        throw new Error((j && (j.error || j.detail)) ? `${j.error||""} ${j.detail||""}`.trim() : `HTTP ${r.status}`);
      }
      $("certPass").value = "";
      setCertMsg("Certificado importado com sucesso.", "ok");
      await fetchCertStatus();
    }catch(e){
      setCertMsg(`Falha ao importar certificado: ${String(e && e.message ? e.message : e)}`, "err");
    }
  }

  // -------------------- Actions --------------------
  async function actionNovo(){
    currentId = crypto.randomUUID();
    const f = getForm();
    const doc = {
      id: currentId,
      model: 55,
      status: "DRAFT",
      serie: f.serie,
      numero: f.numero || "",
      ambiente: f.ambiente,
      dest_nome: f.dest_nome,
      dest_doc: f.dest_doc,
      total_cents: f.total_cents,
      obs: f.obs,
      chave: "",
      created_at: nowISO(),
      updated_at: nowISO(),
    };
    await dbPutDoc(doc);
    setForm(doc);
    setStatusPill(doc);
    setButtons(doc);
    setMsg("Novo documento (Draft) criado.", "ok");
    await refreshList();
  }

  async function actionSalvar(){
    if(!currentId){
      setMsg("Nenhum documento aberto. Use 'Novo (Draft)' primeiro.", "err");
      return;
    }
    const f = getForm();
    const existing = cache.find(x => x.id === currentId);
    const doc = Object.assign({}, existing || {}, {
      id: currentId,
      model: 55,
      status: (existing && existing.status) ? existing.status : "DRAFT",
      serie: f.serie,
      numero: f.numero || (existing && existing.numero) || "",
      ambiente: f.ambiente,
      dest_nome: f.dest_nome,
      dest_doc: f.dest_doc,
      total_cents: f.total_cents,
      obs: f.obs,
      updated_at: nowISO(),
      created_at: (existing && existing.created_at) ? existing.created_at : nowISO(),
    });
    await dbPutDoc(doc);
    setStatusPill(doc);
    setButtons(doc);
    setMsg("Documento salvo (persistência local OK).", "ok");
    await refreshList();
  }

  async function actionExcluir(){
    if(!currentId){ return; }
    await dbDeleteDoc(currentId);
    currentId = null;
    setForm(null);
    setStatusPill(null);
    setButtons(null);
    setMsg("Documento excluído.", "ok");
    await refreshList();
  }

  function bind(){
    $("btnNovo").addEventListener("click", () => actionNovo().catch(e=>setMsg(String(e),"err")));
    $("btnSalvar").addEventListener("click", () => actionSalvar().catch(e=>setMsg(String(e),"err")));
    $("btnExcluir").addEventListener("click", () => actionExcluir().catch(e=>setMsg(String(e),"err")));
    $("btnLimpar").addEventListener("click", () => { $("q").value=""; renderTable(); });
    $("q").addEventListener("input", () => renderTable());
    $("btnCertImport").addEventListener("click", () => importCertA1());
    $("btnCertRefresh").addEventListener("click", () => fetchCertStatus());
  }

  async function init(){
    try{
      // garante sessão/token local
      if (typeof VSC_AUTH !== "undefined" && VSC_AUTH && typeof VSC_AUTH.selfTest === "function") {
        await VSC_AUTH.selfTest();
      }
    } catch (_) {}

    bind();
    setForm(null);
    setStatusPill(null);
    setButtons(null);
    setMsg("Pronto. Crie um Draft para iniciar.", "");
    setCertMsg("—", "");

    await refreshList();
    await fetchCertStatus();
  }

  window.addEventListener("DOMContentLoaded", () => {
    init().catch(e => {
      console.error("[FISCAL] init fail", e);
      setMsg("Falha ao inicializar (ver console).", "err");
    });
  });
})();
