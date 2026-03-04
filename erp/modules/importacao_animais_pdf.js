/* ============================================================
 * IMPORTAÇÃO — ANIMAIS (PDF relatório) — SGQT 8.0
 *
 * Objetivo:
 *  - Ler texto colado do relatório "Animais" do Equinovet (PDF)
 *  - Criar registros em animais_master
 *  - Vincular automaticamente ao cliente (clientes_master) via cliente_id
 *
 * Observações:
 *  - Offline-first: grava em IndexedDB via VSC_DB.upsertWithOutbox
 *  - Auto-create: se algum proprietário não existir em Clientes, cria automaticamente (seguro para seu caso de migração)
 *  - Idempotência: não duplica (cliente_id + nome normalizado do animal)
 *
 * Compatível com o layout observado no PDF:
 *  - Linhas alternam: Proprietário → Animal → Categoria → (opcional) Data nasc → (opcional) Sexo (M/F)
 *  - Em alguns PDFs, sexo (M/F) pode aparecer como coluna solta: tratado como opcional.
 * ============================================================ */
(function(){
  "use strict";

  // SGQT_CORS_GUARD — esta tela deve rodar sob http(s). Abrir via file:// gera origin null e bloqueia /api.
  const __API_BASE__ = (function(){
    try{
      if (typeof location !== "undefined" && location && location.protocol === "file:") {
        throw new Error("Esta tela foi aberta via file://. Abra pelo servidor do ERP (ex.: http://127.0.0.1:8081/importacaodados.html) para liberar chamadas /api e evitar CORS.");
      }

      if (location && (location.protocol === "http:" || location.protocol === "https:")) return "";
      // fallback apenas para mensagens/diagnóstico; o correto é abrir a página via http://127.0.0.1:8081
      return "http://127.0.0.1:8081";
    }catch(_){ return "http://127.0.0.1:8081"; }
  })();
  function apiUrl(path){
    path = String(path||"");
    if (!path.startsWith("/")) path = "/" + path;
    return (__API_BASE__ ? (__API_BASE__ + path) : path);
  }


  // ─────────────────────────────────────────────────────────────
  // UI
  function $(id){ return document.getElementById(id); }
  function esc(s){ return String(s ?? "").replace(/[&<>\"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c])); }
  function setPill(kind, txt){
    const el = $("pillStateAni");
    if(!el) return;
    el.className = "pill " + (kind || "warn");
    el.textContent = txt || "";
  }
  function setStatus(html){
    const el = $("statusAni");
    if(el) el.innerHTML = html || "";
  }
  function setPreview(txt){
    const el = $("previewAni");
    if(el) el.innerHTML = txt || "";
  }

  function setExtractStatus(html){
    const el = $("pdfExtractStatusAni");
    if(el) el.innerHTML = html || "";
  }

  // ─────────────────────────────────────────────────────────────
  // Normalização / Fuzzy
  function norm(s){
    return String(s||"").trim().toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ");
  }
  function stripParens(s){
    return String(s||"").replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+/g, " ").trim();
  }
  function normalizeAnimalName(name){
    return String(name||"")
      .trim()
      .replace(/\.+$/g, "") // "Diversos." -> "Diversos"
      .replace(/\s+/g, " ");
  }
  function jaroSim(s1, s2){
    if(s1===s2) return 1;
    const l1=s1.length,l2=s2.length;
    const md=Math.floor(Math.max(l1,l2)/2)-1;
    if(md<0) return 0;
    const m1=new Array(l1).fill(false);
    const m2=new Array(l2).fill(false);
    let matches=0, trans=0;
    for(let i=0;i<l1;i++){
      const lo=Math.max(0,i-md);
      const hi=Math.min(i+md+1,l2);
      for(let j=lo;j<hi;j++){
        if(m2[j]||s1[i]!==s2[j]) continue;
        m1[i]=m2[j]=true; matches++; break;
      }
    }
    if(!matches) return 0;
    let k=0;
    for(let i=0;i<l1;i++){
      if(!m1[i]) continue;
      while(!m2[k]) k++;
      if(s1[i]!==s2[k]) trans++;
      k++;
    }
    const jaro=(matches/l1 + matches/l2 + (matches - trans/2)/matches)/3;
    let prefix=0;
    for(let i=0;i<Math.min(4,l1,l2);i++){
      if(s1[i]===s2[i]) prefix++; else break;
    }
    return jaro + prefix*0.1*(1-jaro);
  }
  function bestClientMatch(ownerName, clientes){
    const raw = stripParens(ownerName);
    const nk  = norm(raw);
    const byName = new Map();
    (clientes||[]).forEach(c=>{
      if(!c) return;
      const k = norm(stripParens(c.nome||""));
      if(k && !byName.has(k)) byName.set(k,c);
    });
    if(byName.has(nk)) return { score:1, rec: byName.get(nk), mode:"exact" };

    // fuzzy
    let best = { score:0, rec:null };
    for(const [k, rec] of byName){
      const sc = jaroSim(nk, k);
      if(sc > best.score) best = { score:sc, rec };
    }
    if(best.score >= 0.92) return { score:best.score, rec:best.rec, mode:"fuzzy" };
    return { score:best.score, rec:null, mode:"none" };
  }

  // ─────────────────────────────────────────────────────────────
  // IDB helpers
  async function openDb(){
    if(!window.VSC_DB || typeof window.VSC_DB.openDB !== "function"){
      throw new Error("VSC_DB.openDB indisponível (vsc_db.js não carregou).");
    }
    return await window.VSC_DB.openDB();
  }
  function hasStore(db, name){
    try{
      if(!db || !db.objectStoreNames) return false;
      return typeof db.objectStoreNames.contains === "function"
        ? db.objectStoreNames.contains(name)
        : Array.from(db.objectStoreNames).includes(name);
    }catch(_){ return false; }
  }
  function idbGetAll(db, store){
    return new Promise(resolve=>{
      try{
        if(!hasStore(db, store)) return resolve([]);
        const tx = db.transaction([store], "readonly");
        const rq = tx.objectStore(store).getAll();
        rq.onsuccess = ()=> resolve(rq.result || []);
        rq.onerror   = ()=> resolve([]);
      }catch(_){ resolve([]); }
    });
  }
  function uuidv4(){
    try{ if(crypto && crypto.randomUUID) return crypto.randomUUID(); }catch(_){ }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c=>{
      const r=(Math.random()*16)|0;
      return (c==="x"?r:((r&0x3)|0x8)).toString(16);
    });
  }
  function isoNow(){ return new Date().toISOString(); }
  function normNascimentoToBR(s){
    const m = String(s||"").trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if(!m) return "";
    return `${m[1]}/${m[2]}/${m[3]}`;
  }
  function getStores(){
    const S = (window.VSC_DB && window.VSC_DB.stores) ? window.VSC_DB.stores : {};
    return {
      clientes: S.clientes_master || "clientes_master",
      animais:  S.animais_master  || "animais_master"
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Parser do relatório "Animais"
  const CATEGORIAS = new Set([
    "matriz","potra","potro","garanhao","castrado","receptora","doadora",
    "burro","cavalo","egua","diversos","consumidor"
  ]);

  function isCategoriaLine(line){
    const k = norm(line);
    return CATEGORIAS.has(k);
  }
  function isDateLine(line){
    return /^\d{2}\/\d{2}\/\d{4}$/.test(String(line||"").trim());
  }
  function isSexoLine(line){
    const t = String(line||"").trim();
    return t === "M" || t === "F";
  }
  function isIgnorable(line){
    const t = String(line||"").trim();
    if(!t) return true;
    if(/^animais$/i.test(t)) return true;
    if(/^total de animais cadastrados/i.test(t)) return true;
    if(/^dados do animal/i.test(norm(t))) return true;
    if(/^idade$/i.test(t)) return true;
    if(/^status/i.test(norm(t))) return true;
    if(/^prenhez/i.test(norm(t))) return true;
    if(/^refer/i.test(norm(t))) return true;
    // números soltos (ex: 119)
    if(/^\d+$/.test(t)) return true;
    return false;
  }

  function parseAnimaisReport(text){
    const rawLines = String(text||"").split(/\r?\n/).map(s=>s.trim());
    const lines = rawLines.filter(l=>!isIgnorable(l));

    let owner = null;
    let i = 0;
    const out = [];

    function nextCategoriaIndex(start, maxLook){
      const lim = Math.min(lines.length, start + (maxLook||10));
      for(let j=start; j<lim; j++){
        if(isCategoriaLine(lines[j])) return j;
      }
      return -1;
    }

    // Proprietário: linha de texto que precede um animal (1+ linhas) e uma categoria
    function isOwnerStart(idx){
      const l = lines[idx];
      if(!l) return false;
      if(isCategoriaLine(l) || isDateLine(l) || isSexoLine(l)) return false;

      const catIdx = nextCategoriaIndex(idx+1, 12);
      if(catIdx < 0) return false;

      // precisa existir ao menos 1 linha de animal entre owner e categoria
      if(catIdx - idx < 2) return false;

      // a linha imediatamente após owner não pode ser categoria/data/sexo
      const l1 = lines[idx+1] || "";
      if(isCategoriaLine(l1) || isDateLine(l1) || isSexoLine(l1)) return false;

      return true;
    }

    while(i < lines.length){
      const line = lines[i];

      if(!owner){
        if(isOwnerStart(i)){
          owner = line;
          i++;
          continue;
        }
        i++;
        continue;
      }

      // troca de proprietário
      if(isOwnerStart(i)){
        owner = line;
        i++;
        continue;
      }

      // pular lixo
      if(isCategoriaLine(line) || isDateLine(line) || isSexoLine(line)){
        i++;
        continue;
      }

      // Captura nome do animal em 1+ linhas até categoria OU até detectar novo owner
      const parts = [];
      while(i < lines.length && !isCategoriaLine(lines[i]) && !isDateLine(lines[i]) && !isSexoLine(lines[i]) && !isOwnerStart(i)){
        parts.push(lines[i]);
        i++;
      }
      const animalNomeRaw = parts.join(" ").replace(/\s+/g, " ").trim();
      const animalNome = normalizeAnimalName(animalNomeRaw);
      if(!animalNome) continue;

      let categoria = "";
      let nasc = "";
      let sexo = "";

      if(i < lines.length && isCategoriaLine(lines[i])){
        categoria = lines[i];
        i++;
      }
      if(i < lines.length && isDateLine(lines[i])){
        nasc = normNascimentoToBR(lines[i]);
        i++;
      }
      if(i < lines.length && isSexoLine(lines[i])){
        sexo = String(lines[i]).trim();
        i++;
      }

      out.push({ owner, animalNome, categoria, nascimento: nasc, sexo });
    }

    return out;
  }

  // ─────────────────────────────────────────────────────────────
  // Preview + Commit
  let lastPreview = null;
  // Preferência enterprise: usar parse server-side (/api/import/animais-pdf)
  // para respeitar o layout real do PDF (owner/animal), em vez de heurística
  // apenas sobre texto extraído.
  let lastGroupsFromPdf = null;

  // ─────────────────────────────────────────────────────────────
  // PDF Upload (Enterprise) → texto via backend (pdftotext)
  async function extractPdfToTextarea(){
    const inp = $("pdfFileAni");
    const file = inp && inp.files && inp.files[0] ? inp.files[0] : null;
    if(!file){
      setExtractStatus("<span class='err'>Selecione um PDF.</span>");
      return;
    }
    if(!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name||"")){
      setExtractStatus("<span class='err'>Arquivo inválido. Selecione um PDF.</span>");
      return;
    }

    try{
      setExtractStatus("Extraindo texto do PDF... (pode levar alguns segundos)");
      setPill("warn", "Extraindo...");

      const buf = await file.arrayBuffer();
      // SGQT 8.0: preferir endpoint que já faz parse determinístico Owner->Animals.
      // Mantém fallback para /api/pdf/to-text caso o endpoint não exista.
      let resp = await fetch(apiUrl("/api/import/animais-pdf"), {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: buf,
        credentials: "include"
      });

      // fallback (compatibilidade): se /api/import/animais-pdf não existir
      // ou falhar por 404/405, usa extração de texto pura e parse client-side.
      if(!resp.ok && (resp.status === 404 || resp.status === 405)){
        resp = await fetch(apiUrl("/api/pdf/to-text"), {
          method: "POST",
          headers: { "Content-Type": "application/pdf" },
          body: buf,
          credentials: "include"
        });
        // limpa grupos server-side (pois usaremos parse local)
        lastGroupsFromPdf = null;
      }

      if(!resp.ok){
        let msg = "Falha ao extrair PDF";
        try{ const j = await resp.json(); msg = j?.error || msg; }catch(_){
          try{ msg = await resp.text(); }catch(__){}
        }
        throw new Error(String(msg||"Falha ao extrair PDF"));
      }

      const data = await resp.json();

      // Caso 1: endpoint /api/import/animais-pdf retornou grupos (preferido)
      if(Array.isArray(data?.owners)){
        lastGroupsFromPdf = data.owners || [];
        // mantém textarea vazio para evitar confusão (o source é o PDF)
        $("pdfTextAni") && ($("pdfTextAni").value = "");
        const stOwners  = data?.stats?.owners ?? lastGroupsFromPdf.length;
        const stAnimals = data?.stats?.animals ?? (lastGroupsFromPdf.reduce((n,g)=>n+((g?.animals||[]).length),0));
        setExtractStatus(`<span class='ok'>PDF interpretado com sucesso.</span> Proprietários: <b>${esc(stOwners)}</b> • Animais: <b>${esc(stAnimals)}</b> • Método: <b>${esc(data?.method || "")}</b>`);
        setPill("warn", "Aguardando");
        try{ await preview(); }catch(_){ }
        return;
      }

      // Caso 2: endpoint /api/pdf/to-text retornou texto (fallback)
      const text = String(data?.text || "");
      if(!text.trim()) throw new Error("Texto extraído vazio (PDF pode estar protegido ou imagem)." );

      $("pdfTextAni") && ($("pdfTextAni").value = text);
      setExtractStatus(`<span class='ok'>Texto extraído com sucesso.</span> Páginas: <b>${esc(data?.pages ?? "?")}</b> • Caracteres: <b>${esc(text.length)}</b>`);
      setPill("warn", "Aguardando");
      try{ await preview(); }catch(_){ }
    }catch(e){
      console.error(e);
      setPill("bad", "Erro");
      setExtractStatus(`<span class='err'>${esc(e?.message || e)}</span>`);
    }
  }

  async function preview(){
    const txt = $("pdfTextAni")?.value || "";
    const hasGroups = Array.isArray(lastGroupsFromPdf) && lastGroupsFromPdf.length;
    if(!hasGroups && !txt.trim()){
      setPill("warn", "Selecione o PDF");
      setStatus("<span class='err'>Selecione o PDF do relatório Animais e clique em <b>Extrair texto do PDF</b>.</span>");
      setPreview("Selecione o PDF e extraia o texto para pré-visualizar.");
      $("btnCommitAni") && ($("btnCommitAni").disabled = true);
      return;
    }

    setPill("warn", "Analisando...");
    setStatus("Lendo IndexedDB e analisando o texto...");

    const db = await openDb();
    const stores = getStores();

    const [clientes, animais] = await Promise.all([
      idbGetAll(db, stores.clientes),
      idbGetAll(db, stores.animais),
    ]);

    // Fonte preferida: parse server-side (owners/animals). Fallback: parse local por texto.
    let parsed = [];
    if(hasGroups){
      parsed = (lastGroupsFromPdf || [])
        .flatMap(g => {
          const ownerName = String((g && g.owner) ? g.owner : "").trim();
          const animalsArr = (g && g.animals) ? g.animals : [];
          return (animalsArr || []).map(a => ({
            owner: ownerName,
            animalNome: normalizeAnimalName((a && a.nome) ? a.nome : (a || "")),
            categoria: "",
            nascimento: "",
            sexo: ""
          }));
        });
    }else{
      parsed = parseAnimaisReport(txt);
    }

    // index de animais existentes por (cliente_id|nome_norm)
    const existing = new Set();
    (animais||[]).forEach(a=>{
      if(!a || a.deleted === true) return;
      const key = `${a.cliente_id||""}::${norm(normalizeAnimalName(a.nome||""))}`;
      existing.add(key);
    });

    const byOwner = new Map();
    const rows = [];

    parsed.forEach(rec=>{
      const owner = rec.owner;
      if(!byOwner.has(owner)){
        byOwner.set(owner, bestClientMatch(owner, clientes));
      }
      const m = byOwner.get(owner);

      // Se não achou, marcar como "vai criar"
      if(!m || !m.rec){
        rows.push({
          ...rec,
          cliente_id: `__CREATE__:${owner}`,
          cliente_nome: owner,
          match_score: m ? m.score : 0,
          match_mode: "create",
          status: "NOVO"
        });
        return;
      }

      const cliente_id = m.rec.id;
      const key = `${cliente_id}::${norm(normalizeAnimalName(rec.animalNome))}`;
      const dup = existing.has(key);

      rows.push({
        ...rec,
        cliente_id,
        cliente_nome: m.rec.nome || "",
        match_score: m.score,
        match_mode: m.mode,
        status: dup ? "JÁ EXISTE" : "NOVO"
      });
    });

    const total = rows.length;
    const novos = rows.filter(r=>r.status==="NOVO").length;
    const ja = rows.filter(r=>r.status==="JÁ EXISTE").length;

    lastPreview = { rows, total, novos, ja };

    const okToCommit = (total>0);
    $("btnCommitAni") && ($("btnCommitAni").disabled = !okToCommit);
    setPill(okToCommit ? "ok" : "warn", okToCommit ? "Pronto" : "Aguardando");

    setStatus(
      `<div><b>Total:</b> ${total} • <b>Novos:</b> ${novos} • <b>Já existe:</b> ${ja}</div>` +
      `<div class='hint'>Pode commitar. Clientes ausentes serão criados automaticamente; duplicados serão ignorados.</div>`
    );

    const previewLines = [];
    previewLines.push(`<b>Prévia (primeiros 30)</b>`);
    previewLines.push(`<div class='hint'>Formato: Proprietário → Animal → Categoria → Nascimento</div>`);
    previewLines.push(`<table><thead><tr><th>Proprietário (PDF)</th><th>Cliente</th><th>Animal</th><th>Categoria</th><th>Nasc.</th><th>Status</th></tr></thead><tbody>`);
    rows.slice(0,30).forEach(r=>{
      const clienteTxt = r.match_mode === "create"
        ? `${esc(r.cliente_nome)} <span class='muted'>(criar)</span>`
        : `${esc(r.cliente_nome || "")}${r.match_mode==="fuzzy" ? " <span class='muted'>(fuzzy)</span>" : ""}`;
      previewLines.push(`<tr>`+
        `<td>${esc(r.owner)}</td>`+
        `<td>${clienteTxt}</td>`+
        `<td>${esc(r.animalNome)}</td>`+
        `<td>${esc(r.categoria||"")}</td>`+
        `<td class='mono'>${esc(r.nascimento||"")}</td>`+
        `<td>${esc(r.status)}</td>`+
      `</tr>`);
    });
    previewLines.push(`</tbody></table>`);
    setPreview(previewLines.join("\n"));
  }

  async function commit(){
    if(!lastPreview || !lastPreview.rows){
      setPill("warn", "Pré-visualize");
      return;
    }

    const db = await openDb();
    const stores = getStores();
    const now = isoNow();

    // Recarrega animais p/ idempotência
    const animais = await idbGetAll(db, stores.animais);
    const existing = new Set();
    (animais||[]).forEach(a=>{
      if(!a || a.deleted === true) return;
      existing.add(`${a.cliente_id||""}::${norm(normalizeAnimalName(a.nome||""))}`);
    });

    // cache de clientes (para match e para evitar criar duplicado dentro do mesmo commit)
    const clientes = await idbGetAll(db, stores.clientes);
    const ownerToClienteId = new Map();
    (clientes||[]).forEach(c=>{
      if(!c || c.deleted === true) return;
      ownerToClienteId.set(norm(stripParens(c.nome||"")), c.id);
    });

    let inserted = 0, skipped = 0, createdClients = 0;

    setPill("warn", "Gravando...");
    setStatus("Gravando no IndexedDB (clientes_master / animais_master) ...");

    for(const r of lastPreview.rows){
      if(r.status !== "NOVO") { skipped++; continue; }

      // Resolve/Cria cliente
      let cliente_id = r.cliente_id;
      if(String(cliente_id).startsWith("__CREATE__:")){
        const ownerName = stripParens(r.owner || "").trim();
        const ownerKey = norm(ownerName);

        // já criado neste commit?
        if(ownerToClienteId.has(ownerKey)){
          cliente_id = ownerToClienteId.get(ownerKey);
        }else{
          const novoCliente = {
            id: uuidv4(),
            created_at: now,
            updated_at: now,
            last_sync: null,
            nome: ownerName || (r.owner||"").trim(),
            ativo: true,
            observacoes: "Criado automaticamente via importação PDF Animais",
          };
          await window.VSC_DB.upsertWithOutbox(
            stores.clientes,
            novoCliente.id,
            novoCliente,
            "clientes"
          );
          ownerToClienteId.set(ownerKey, novoCliente.id);
          cliente_id = novoCliente.id;
          createdClients++;
        }
      }

      const animalNome = normalizeAnimalName(r.animalNome);
      const key = `${cliente_id}::${norm(animalNome)}`;
      if(existing.has(key)) { skipped++; continue; }

      const obsParts = [];
      if(r.categoria) obsParts.push(`Categoria: ${String(r.categoria).trim()}`);
      obsParts.push("Importado do PDF (relatório Animais)");

      const obj = {
        id: uuidv4(),
        created_at: now,
        updated_at: now,
        last_sync: null,

        nome: animalNome,
        especie_id: "",
        sexo: (r.sexo === "M" || r.sexo === "F") ? r.sexo : "",
        nascimento: r.nascimento || "",
        raca_id: "",
        pelagem_id: "",
        microchip: "",
        passaporte: "",
        ativo: true,
        cliente_id: cliente_id,
        observacoes: obsParts.join(" | "),
        foto_data: ""
      };

      await window.VSC_DB.upsertWithOutbox(
        stores.animais,
        obj.id,
        obj,
        "animais"
      );
      existing.add(key);
      inserted++;
    }

    setPill("ok", "Concluído");
    setStatus(`<b>Importação concluída:</b> clientes criados ${createdClients}, animais inseridos ${inserted}, ignorados ${skipped}.`);
    $("btnCommitAni") && ($("btnCommitAni").disabled = true);
  }

  function clearAll(){
    $("pdfTextAni") && ($("pdfTextAni").value = "");
    lastGroupsFromPdf = null;
    lastPreview = null;
    setPill("warn", "Aguardando");
    setStatus("");
    setPreview("Cole o texto do relatório Animais e clique em Pré-visualizar.");
    $("btnCommitAni") && ($("btnCommitAni").disabled = true);
  }

  // ─────────────────────────────────────────────────────────────
  // Wire
  function wire(){
    const b1 = $("btnPreviewAni");
    const b2 = $("btnCommitAni");
    const b3 = $("btnClearAni");
    const b4 = $("btnExtractPdfAni");
    if(b1) b1.addEventListener("click", ()=> preview().catch(e=>{
      console.error(e);
      setPill("bad","Erro");
      setStatus(`<span class='err'>Falha: ${esc(e?.message||e)}</span>`);
    }));
    if(b2) b2.addEventListener("click", ()=> commit().catch(e=>{
      console.error(e);
      setPill("bad","Erro");
      setStatus(`<span class='err'>Falha ao commitar: ${esc(e?.message||e)}</span>`);
    }));
    if(b3) b3.addEventListener("click", clearAll);
    if(b4) b4.addEventListener("click", ()=> extractPdfToTextarea());
    const fi = $("pdfFileAni");
    if(fi) fi.addEventListener("change", ()=> extractPdfToTextarea());
  }

  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
