(function(){
  "use strict";

  // [FIX C-07] Banco fiscal migrado de vsc_fiscal_db para VSC_DB principal.
  // nfe_docs agora vive em VSC_DB (DB_VERSION 37) e sincroniza via outbox.
  // DB_NAME e DB_VERSION locais mantidos apenas para leitura de dados legados na migração.
  const DB_NAME_LEGACY = "vsc_fiscal_db";
  const DB_VERSION_LEGACY = 2;
  const STORE_DOCS = "nfe_docs";

  const $ = (id) => document.getElementById(id);

  function nowISO(){ return new Date().toISOString(); }

  function uuidv4(){
    try {
      if (window.VSC_UTILS && typeof window.VSC_UTILS.uuidv4 === "function") return window.VSC_UTILS.uuidv4();
    } catch (_) {}
    try { if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID(); } catch (_) {}
    try {
      if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
        const buf = new Uint8Array(16);
        crypto.getRandomValues(buf);
        buf[6] = (buf[6] & 0x0f) | 0x40;
        buf[8] = (buf[8] & 0x3f) | 0x80;
        const hex = Array.from(buf).map(b => b.toString(16).padStart(2, "0")).join("");
        return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
      }
    } catch (_) {}
    throw new TypeError("[FISCAL] ambiente sem CSPRNG para gerar UUID v4.");
  }

  function esc(s){
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function onlyDigits(v){ return String(v || "").replace(/\D+/g, ""); }

  function centsToBRL(c){
    const n = (Number(c || 0) / 100);
    return n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function parseMoneyLike(v){
    const raw = String(v == null ? "" : v).trim();
    if(!raw) return 0;
    const clean = raw.replace(/\s+/g, "").replace(/\./g, "").replace(",", ".");
    const num = Number(clean);
    return Number.isFinite(num) ? num : 0;
  }

  function toCentsBRL(v){
    return Math.round(parseMoneyLike(v) * 100);
  }

  function fromDateTimeLocalToISO(v){
    const s = String(v || "").trim();
    if(!s) return "";
    const dt = new Date(s);
    return Number.isNaN(dt.getTime()) ? "" : dt.toISOString();
  }

  function toDateTimeLocalValue(v){
    const s = String(v || "").trim();
    if(!s) return "";
    const dt = new Date(s);
    if(Number.isNaN(dt.getTime())) return "";
    const pad = (n)=> String(n).padStart(2, "0");
    const yyyy = dt.getFullYear();
    const mm = pad(dt.getMonth() + 1);
    const dd = pad(dt.getDate());
    const hh = pad(dt.getHours());
    const mi = pad(dt.getMinutes());
    return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
  }

  function fmtDateTime(v){
    const s = String(v || "").trim();
    if(!s) return "—";
    const dt = new Date(s);
    if(Number.isNaN(dt.getTime())) return esc(s);
    return dt.toLocaleString("pt-BR");
  }

  function snack(msg, kind){
    try{
      if(window.VSC && typeof window.VSC.toast === "function"){
        window.VSC.toast(msg, kind === "err" ? "error" : (kind || "info"));
        return;
      }
    }catch(_){}
    try{
      alert(msg);
    }catch(_){}
  }

  function setMsg(msg, kind){
    const el = $("msgArea");
    if(!el) return;
    el.textContent = msg || "—";
    el.style.color =
      kind === "err" ? "#b91c1c" :
      kind === "ok"  ? "#166534" :
      kind === "warn"? "#92400e" : "#64748b";
  }

  function setCertMsg(msg, kind){
    const el = $("certMsg");
    if(!el) return;
    el.textContent = msg || "—";
    el.style.color =
      kind === "err" ? "#b91c1c" :
      kind === "ok"  ? "#166534" :
      kind === "warn"? "#92400e" : "#64748b";
  }

  function badgeForStatus(status){
    const s = String(status || "DRAFT").toUpperCase();
    if(s === "AUTHORIZED") return { label:"AUTORIZADA", cls:"b-auth" };
    if(s === "REJECTED") return { label:"REJEITADA", cls:"b-rej" };
    if(s === "SENT") return { label:"ENVIADA", cls:"b-sent" };
    if(s === "SIGNED") return { label:"ASSINADA", cls:"b-signed" };
    return { label:"DRAFT", cls:"b-draft" };
  }

  function getDefaultItems(){
    return [{
      id: uuidv4(),
      codigo: "",
      descricao: "",
      ncm: "",
      cfop: "",
      unidade: "UN",
      quantidade: 1,
      valor_unit_cents: 0,
      valor_total_cents: 0
    }];
  }

  function normalizeItem(raw){
    const qty = Number(raw && raw.quantidade != null ? raw.quantidade : 0);
    const quantidade = Number.isFinite(qty) && qty > 0 ? qty : 1;
    const vu = Number(raw && raw.valor_unit_cents != null ? raw.valor_unit_cents : 0);
    const valorUnit = Number.isFinite(vu) ? Math.max(0, Math.round(vu)) : 0;
    const vt = Number(raw && raw.valor_total_cents != null ? raw.valor_total_cents : Math.round(quantidade * valorUnit));
    const valorTotal = Number.isFinite(vt) ? Math.max(0, Math.round(vt)) : Math.round(quantidade * valorUnit);
    return {
      id: String(raw && raw.id || uuidv4()),
      codigo: String(raw && raw.codigo || "").trim(),
      descricao: String(raw && raw.descricao || "").trim(),
      ncm: String(raw && raw.ncm || "").trim(),
      cfop: String(raw && raw.cfop || "").trim(),
      unidade: String(raw && raw.unidade || "UN").trim().toUpperCase().slice(0, 6) || "UN",
      quantidade,
      valor_unit_cents: valorUnit,
      valor_total_cents: valorTotal
    };
  }

  function normalizeDoc(doc){
    const items = Array.isArray(doc && doc.items) && doc.items.length ? doc.items.map(normalizeItem) : getDefaultItems().map(normalizeItem);
    const totalItens = items.reduce((sum, it)=> sum + Number(it.valor_total_cents || 0), 0);
    const frete = Number(doc && doc.frete_cents || 0) || 0;
    const desconto = Number(doc && doc.desconto_cents || 0) || 0;
    const totalProvided = Number(doc && doc.total_cents || 0);
    const total = totalProvided > 0 ? totalProvided : Math.max(0, totalItens + frete - desconto);

    return {
      id: String(doc && doc.id || uuidv4()),
      model: 55,
      status: String(doc && doc.status || "DRAFT"),
      serie: String(doc && doc.serie || "1"),
      numero: String(doc && doc.numero || ""),
      ambiente: String(doc && doc.ambiente || "HOMOLOG"),
      natureza: String(doc && doc.natureza || "Venda / faturamento"),
      emissao_em: String(doc && doc.emissao_em || nowISO()),
      saida_em: String(doc && doc.saida_em || ""),
      dest_nome: String(doc && doc.dest_nome || ""),
      dest_doc: String(doc && doc.dest_doc || ""),
      dest_ie: String(doc && doc.dest_ie || ""),
      dest_fone: String(doc && doc.dest_fone || ""),
      dest_endereco: String(doc && doc.dest_endereco || ""),
      base_icms_cents: Number(doc && doc.base_icms_cents || 0) || 0,
      valor_icms_cents: Number(doc && doc.valor_icms_cents || 0) || 0,
      frete_cents: frete,
      desconto_cents: desconto,
      total_cents: total,
      obs: String(doc && doc.obs || ""),
      chave: String(doc && doc.chave || ""),
      protocolo: String(doc && doc.protocolo || ""),
      items,
      created_at: String(doc && doc.created_at || nowISO()),
      updated_at: String(doc && doc.updated_at || nowISO())
    };
  }

  function summarizeEmpresa(empresa){
    const nome = empresa.razao_social || empresa.nome_fantasia || "Empresa não configurada";
    const doc = empresa.cnpj ? `CNPJ ${maskCnpjCpf(empresa.cnpj)}` : "CNPJ não informado";
    const endereco = [empresa.logradouro, empresa.numero, empresa.bairro, empresa.cidade, empresa.uf].filter(Boolean).join(", ") || "Endereço não informado";
    const contato = [empresa.telefone || empresa.celular || "", empresa.email || ""].filter(Boolean).join(" · ") || "Contato não informado";
    $("emitenteResumo").textContent = nome;
    $("emitenteResumo2").textContent = `${doc} · ${endereco}`;
    $("sumEmpresaNome").textContent = nome;
    $("sumEmpresaDoc").textContent = doc;
    $("sumEmpresaEndereco").textContent = endereco;
    $("sumEmpresaContato").textContent = contato;
  }

  async function readEmpresa(){
    try{
      if(window.VSC_DB && typeof window.VSC_DB.getEmpresaSnapshot === "function"){
        return await window.VSC_DB.getEmpresaSnapshot({ preferIdb:true, hydrateLocalStorage:true });
      }
      const raw = localStorage.getItem("vsc_empresa_v1");
      if(!raw) return {};
      const obj = JSON.parse(raw);
      return obj && typeof obj === "object" ? obj : {};
    }catch(_){
      return {};
    }
  }

  function maskCnpjCpf(v){
    const d = onlyDigits(v);
    if(d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
    if(d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
    return d || "";
  }

  function buildAccessKeyPreview(doc, empresa){
    if(doc.chave && onlyDigits(doc.chave).length >= 44){
      return onlyDigits(doc.chave).slice(0,44);
    }
    const uf = "35";
    const d = new Date(doc.emissao_em || nowISO());
    const aamm = `${String(d.getFullYear()).slice(-2)}${String(d.getMonth()+1).padStart(2,"0")}`;
    const cnpj = onlyDigits(empresa.cnpj || "").padStart(14, "0").slice(0, 14);
    const mod = "55";
    const serie = onlyDigits(doc.serie || "").padStart(3, "0").slice(-3);
    const numero = onlyDigits(doc.numero || "").padStart(9, "0").slice(-9);
    const tpEmis = doc.ambiente === "PROD" ? "1" : "2";
    const codigo = String(Math.abs(hashCode(`${cnpj}${numero}${doc.id}`))).padStart(8, "0").slice(0, 8);
    const dv = String((Number(codigo.slice(-1)) + Number(numero.slice(-1)) + Number(serie.slice(-1))) % 9);
    return `${uf}${aamm}${cnpj}${mod}${serie}${numero}${tpEmis}${codigo}${dv}`.slice(0,44);
  }

  function hashCode(str){
    let h = 0;
    for(let i=0;i<str.length;i++) h = ((h << 5) - h) + str.charCodeAt(i), h |= 0;
    return h;
  }

  function groupKey(key){
    const d = onlyDigits(key);
    return d.replace(/(\d{4})(?=\d)/g, "$1 ").trim();
  }

  function docResumo(doc){
    if(!doc){
      $("docResumo").textContent = "Nenhum documento selecionado";
      $("docResumo2").textContent = "Abra um rascunho ou crie uma nova NF-e.";
      return;
    }
    const label = `${doc.serie || "1"}/${doc.numero || "—"} · ${badgeForStatus(doc.status).label}`;
    const txt = `${doc.dest_nome || "Sem destinatário"} · R$ ${centsToBRL(doc.total_cents || 0)}`;
    $("docResumo").textContent = label;
    $("docResumo2").textContent = txt;
  }

  function updateStatusPill(doc){
    const el = $("docStatusPill");
    if(!doc){
      el.className = "pill";
      el.textContent = "Status: —";
      return;
    }
    const b = badgeForStatus(doc.status);
    el.className = "pill " + (b.cls === "b-auth" ? "ok" : (b.cls === "b-rej" ? "err" : ""));
    el.textContent = `Status: ${b.label}`;
  }

  function setButtons(doc){
    const has = !!(doc && doc.id);
    $("btnExcluir").disabled = !has;
    $("btnVisualizar").disabled = !has;
    $("btnImprimir").disabled = !has;
    $("btnAssinar").disabled = true;
    $("btnEnviar").disabled = true;
  }

  // [FIX C-07] openDB agora usa VSC_DB principal (não mais banco isolado)
  function openDB(){
    if(window.VSC_DB && typeof window.VSC_DB.openDB === "function"){
      return window.VSC_DB.openDB();
    }
    // Fallback legado — não deve ser atingido em produção
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME_LEGACY, DB_VERSION_LEGACY);
      req.onupgradeneeded = () => {
        const db = req.result;
        let st;
        if(!db.objectStoreNames.contains(STORE_DOCS)){
          st = db.createObjectStore(STORE_DOCS, { keyPath:"id" });
        }else{
          st = req.transaction.objectStore(STORE_DOCS);
        }
        if(st && !st.indexNames.contains("by_updated")){
          st.createIndex("by_updated", "updated_at", { unique:false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // [FIX C-07] dbPutDoc usa VSC_DB.outboxEnqueue para garantir sync offline
  async function dbPutDoc(doc){
    if(window.VSC_DB && typeof window.VSC_DB.outboxEnqueue === "function"){
      try{
        // Persistir no IDB via upsertWithOutbox se disponível
        if(typeof window.VSC_DB.upsertWithOutbox === "function"){
          await window.VSC_DB.upsertWithOutbox(STORE_DOCS, doc, STORE_DOCS, doc.id, doc);
          return true;
        }
        // Fallback: put direto + enqueue manual
        const db = await openDB();
        await new Promise((resolve, reject) => {
          const tx = db.transaction([STORE_DOCS], "readwrite");
          tx.objectStore(STORE_DOCS).put(normalizeDoc(doc));
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
        });
        await window.VSC_DB.outboxEnqueue(STORE_DOCS, "upsert", doc.id, doc);
        return true;
      }catch(e){
        console.error("[fiscal] dbPutDoc falhou:", e);
        return false;
      }
    }
    // Fallback legado (sem VSC_DB)
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_DOCS], "readwrite");
      tx.objectStore(STORE_DOCS).put(normalizeDoc(doc));
      tx.oncomplete = () => { try{ db.close(); }catch(_){} resolve(true); };
      tx.onerror = () => { const err = tx.error; try{ db.close(); }catch(_){} reject(err); };
    });
  }

  async function dbDeleteDoc(id){
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_DOCS], "readwrite");
      tx.objectStore(STORE_DOCS).delete(id);
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { const err = tx.error; try{ db.close(); }catch(_){} reject(err); };
    });
  }

  async function dbGetAllDocs(){
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_DOCS], "readonly");
      const st = tx.objectStore(STORE_DOCS);
      const idx = st.index("by_updated");
      const out = [];
      idx.openCursor(null, "prev").onsuccess = (e) => {
        const cur = e.target.result;
        if(cur){ out.push(normalizeDoc(cur.value)); cur.continue(); }
        else resolve(out);
      };
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => db.close();
    });
  }

  let currentId = null;
  let cache = [];
  let currentItems = getDefaultItems().map(normalizeItem);
  let previewUrl = "";

  function getForm(){
    return {
      serie: String($("fSerie").value || "").trim() || "1",
      numero: String($("fNumero").value || "").trim(),
      ambiente: String($("fAmbiente").value || "HOMOLOG").trim(),
      natureza: String($("fNatureza").value || "").trim(),
      emissao_em: fromDateTimeLocalToISO($("fEmissao").value),
      saida_em: fromDateTimeLocalToISO($("fSaida").value),
      dest_nome: String($("fDestNome").value || "").trim(),
      dest_doc: String($("fDestDoc").value || "").trim(),
      dest_ie: String($("fDestIE").value || "").trim(),
      dest_fone: String($("fDestFone").value || "").trim(),
      dest_endereco: String($("fDestEndereco").value || "").trim(),
      base_icms_cents: toCentsBRL($("fBaseICMS").value),
      valor_icms_cents: toCentsBRL($("fValorICMS").value),
      frete_cents: toCentsBRL($("fFrete").value),
      desconto_cents: toCentsBRL($("fDesconto").value),
      total_cents: toCentsBRL($("fTotal").value),
      obs: String($("fObs").value || "").trim(),
      chave: String($("fChave").value || "").trim(),
      protocolo: String($("fProtocolo").value || "").trim(),
      items: currentItems.map(normalizeItem)
    };
  }

  function setForm(doc){
    const d = normalizeDoc(doc || {});
    $("fSerie").value = d.serie || "1";
    $("fNumero").value = d.numero || "";
    $("fAmbiente").value = d.ambiente || "HOMOLOG";
    $("fNatureza").value = d.natureza || "";
    $("fEmissao").value = toDateTimeLocalValue(d.emissao_em);
    $("fSaida").value = toDateTimeLocalValue(d.saida_em);
    $("fDestNome").value = d.dest_nome || "";
    $("fDestDoc").value = d.dest_doc || "";
    $("fDestIE").value = d.dest_ie || "";
    $("fDestFone").value = d.dest_fone || "";
    $("fDestEndereco").value = d.dest_endereco || "";
    $("fBaseICMS").value = centsToBRL(d.base_icms_cents || 0);
    $("fValorICMS").value = centsToBRL(d.valor_icms_cents || 0);
    $("fFrete").value = centsToBRL(d.frete_cents || 0);
    $("fDesconto").value = centsToBRL(d.desconto_cents || 0);
    $("fTotal").value = centsToBRL(d.total_cents || 0);
    $("fObs").value = d.obs || "";
    $("fChave").value = d.chave || "";
    $("fProtocolo").value = d.protocolo || "";
    currentItems = d.items.map(normalizeItem);
    renderItems();
  }

  function renderItems(){
    const tb = $("itemsBody");
    if(!tb) return;
    tb.innerHTML = "";

    currentItems.forEach((item, index) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><input class="item-input" data-k="codigo" data-i="${index}" value="${esc(item.codigo)}" /></td>
        <td><input data-k="descricao" data-i="${index}" value="${esc(item.descricao)}" placeholder="Produto / serviço" /></td>
        <td><input class="item-input" data-k="ncm" data-i="${index}" value="${esc(item.ncm)}" placeholder="0000.00.00" /></td>
        <td><input class="item-input" data-k="cfop" data-i="${index}" value="${esc(item.cfop)}" placeholder="5102" /></td>
        <td><input class="item-input" data-k="unidade" data-i="${index}" value="${esc(item.unidade)}" placeholder="UN" /></td>
        <td><input class="item-input num-right" data-k="quantidade" data-i="${index}" value="${String(item.quantidade).replace(".", ",")}" inputmode="decimal" /></td>
        <td><input class="item-input num-right" data-k="valor_unit_cents" data-i="${index}" value="${centsToBRL(item.valor_unit_cents)}" inputmode="decimal" /></td>
        <td class="num-right" data-total="${index}">R$ ${centsToBRL(item.valor_total_cents)}</td>
        <td><div class="item-row-actions"><button class="linkbtn" data-remove="${index}" type="button">Remover</button></div></td>
      `;
      tb.appendChild(tr);
    });

    tb.querySelectorAll("input[data-k]").forEach((input) => {
      input.addEventListener("input", onItemInputChange);
      input.addEventListener("change", onItemInputChange);
    });
    tb.querySelectorAll("button[data-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-remove"));
        if(currentItems.length === 1){
          currentItems = getDefaultItems().map(normalizeItem);
        }else{
          currentItems.splice(idx, 1);
        }
        renderItems();
        recalcTotalsFromItems();
      });
    });

    recalcTotalsFromItems({ silent:true });
  }

  function onItemInputChange(ev){
    const input = ev.currentTarget;
    const idx = Number(input.getAttribute("data-i"));
    const key = String(input.getAttribute("data-k"));
    const item = currentItems[idx];
    if(!item) return;

    const raw = String(input.value || "");
    if(key === "quantidade"){
      const q = parseMoneyLike(raw);
      item.quantidade = Number.isFinite(q) && q > 0 ? q : 1;
    }else if(key === "valor_unit_cents"){
      item.valor_unit_cents = Math.max(0, toCentsBRL(raw));
    }else{
      item[key] = key === "unidade" ? raw.trim().toUpperCase().slice(0,6) : raw.trim();
    }
    item.valor_total_cents = Math.max(0, Math.round((Number(item.quantidade || 0) * Number(item.valor_unit_cents || 0))));
    const totalCell = document.querySelector(`[data-total="${idx}"]`);
    if(totalCell) totalCell.textContent = `R$ ${centsToBRL(item.valor_total_cents)}`;
    recalcTotalsFromItems({ silent:true });
  }

  function recalcTotalsFromItems(opts){
    opts = opts || {};
    const itens = currentItems.reduce((sum, it) => sum + Number(it.valor_total_cents || 0), 0);
    const frete = toCentsBRL($("fFrete").value);
    const desconto = toCentsBRL($("fDesconto").value);
    const total = Math.max(0, itens + frete - desconto);
    $("fTotal").value = centsToBRL(total);
    if(!opts.silent) setMsg("Totais recalculados pelos itens.", "ok");
  }

  async function fillDefaultsForNewDoc(){
    const empresa = await readEmpresa();
    currentId = uuidv4();
    const now = nowISO();
    const doc = normalizeDoc({
      id: currentId,
      status: "DRAFT",
      serie: "1",
      numero: "",
      ambiente: "HOMOLOG",
      natureza: "Venda / faturamento",
      emissao_em: now,
      saida_em: now,
      base_icms_cents: 0,
      valor_icms_cents: 0,
      frete_cents: 0,
      desconto_cents: 0,
      total_cents: 0,
      obs: "",
      items: getDefaultItems(),
      emitente_snapshot: empresa
    });
    setForm(doc);
    updateStatusPill(doc);
    setButtons(doc);
    docResumo(doc);
    setMsg("Novo documento criado em rascunho. Preencha os campos e salve.", "ok");
  }

  function currentDocSnapshot(){
    const existing = cache.find(x => x.id === currentId);
    const base = normalizeDoc(existing || {});
    const form = getForm();
    const totalByItems = form.items.reduce((sum, it) => sum + Number(it.valor_total_cents || 0), 0);
    const total = form.total_cents > 0 ? form.total_cents : Math.max(0, totalByItems + form.frete_cents - form.desconto_cents);
    return normalizeDoc(Object.assign({}, base, form, {
      id: currentId || (existing && existing.id) || uuidv4(),
      model: 55,
      status: base.status || "DRAFT",
      total_cents: total,
      created_at: base.created_at || nowISO(),
      updated_at: nowISO()
    }));
  }

  async function actionNovo(){
    await fillDefaultsForNewDoc();
    const doc = currentDocSnapshot();
    await dbPutDoc(doc);
    await refreshList();
  }

  async function actionSalvar(){
    if(!currentId){
      await fillDefaultsForNewDoc();
    }
    const doc = currentDocSnapshot();
    await dbPutDoc(doc);
    updateStatusPill(doc);
    setButtons(doc);
    docResumo(doc);
    setForm(doc);
    setMsg("Documento salvo com sucesso. Snapshot pronto para reimpressão.", "ok");
    await refreshList();
  }

  async function actionExcluir(){
    if(!currentId) return;
    await dbDeleteDoc(currentId);
    currentId = null;
    setForm(normalizeDoc({}));
    currentItems = getDefaultItems().map(normalizeItem);
    renderItems();
    updateStatusPill(null);
    setButtons(null);
    docResumo(null);
    setMsg("Documento excluído.", "ok");
    await refreshList();
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

  function renderTable(){
    const q = String($("q").value || "").trim().toLowerCase();
    const rows = q ? cache.filter(d => {
      const hay = `${d.dest_nome || ""} ${d.numero || ""} ${d.serie || ""} ${d.chave || ""}`.toLowerCase();
      return hay.includes(q);
    }) : cache;

    const tb = $("tb");
    tb.innerHTML = "";

    rows.forEach((d) => {
      const b = badgeForStatus(d.status);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><span class="badge ${b.cls}">${b.label}</span></td>
        <td><div style="font-weight:900;">${esc(d.serie || "1")}/${esc(d.numero || "—")}</div><div class="small">${esc(d.ambiente || "HOMOLOG")}</div></td>
        <td><div style="font-weight:900;">${esc(d.dest_nome || "(sem destinatário)")}</div><div class="small">${esc(maskCnpjCpf(d.dest_doc || ""))}</div></td>
        <td class="num-right"><div style="font-weight:900;">R$ ${centsToBRL(d.total_cents || 0)}</div><div class="small">${fmtDateTime(d.updated_at)}</div></td>
        <td class="td-actions"><button class="linkbtn" data-open="${esc(d.id)}" type="button">Abrir</button></td>
      `;
      tb.appendChild(tr);
    });

    tb.querySelectorAll("button[data-open]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-open");
        const doc = cache.find(x => x.id === id);
        if(!doc) return;
        currentId = doc.id;
        setForm(doc);
        updateStatusPill(doc);
        setButtons(doc);
        docResumo(doc);
        setMsg(`Documento ${doc.serie || "1"}/${doc.numero || "—"} carregado para edição.`, "ok");
        window.scrollTo({ top:0, behavior:"smooth" });
      });
    });

    updateKPIs(cache);
  }

  async function refreshList(){
    cache = await dbGetAllDocs();
    renderTable();
  }

  async function fetchCertStatus(){
    const pill = $("certPill");
    try{
      const r = await fetch("/api/fiscal/cert/status", { cache:"no-store" });
      const j = await r.json();
      if(!j || !j.ok) throw new Error((j && j.error) ? j.error : "Falha");
      if(j.has_cert){
        pill.className = "pill ok";
        pill.textContent = "Certificado: OK";
        setCertMsg(`A1 presente (hash: ${String(j.blob_sha256 || "").slice(0,12)}…)`, "ok");
      }else{
        pill.className = "pill warn";
        pill.textContent = "Certificado: ausente";
        setCertMsg("Nenhum certificado A1 importado.", "warn");
      }
    }catch(e){
      pill.className = "pill err";
      pill.textContent = "Certificado: erro";
      setCertMsg(`Falha ao consultar status do certificado: ${String(e && e.message ? e.message : e)}`, "err");
    }
  }

  async function importCertA1(){
    const file = $("certFile").files && $("certFile").files[0];
    const pass = String($("certPass").value || "").trim();
    if(!file){ setCertMsg("Selecione o arquivo .PFX/.P12.", "err"); return; }
    if(!pass){ setCertMsg("Informe a senha do certificado.", "err"); return; }

    try{
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = "";
      const CHUNK = 0x8000;
      for(let i=0; i<bytes.length; i+=CHUNK){
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      const b64 = btoa(bin);
      const r = await fetch("/api/fiscal/cert/a1/import", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ pfx_b64: b64, password: pass })
      });
      const j = await r.json().catch(()=>null);
      if(!r.ok || !j || !j.ok){
        throw new Error((j && (j.error || j.detail)) ? `${j.error || ""} ${j.detail || ""}`.trim() : `HTTP ${r.status}`);
      }
      $("certPass").value = "";
      setCertMsg("Certificado importado com sucesso.", "ok");
      await fetchCertStatus();
    }catch(e){
      setCertMsg(`Falha ao importar certificado: ${String(e && e.message ? e.message : e)}`, "err");
    }
  }

  async function buildDanfeHTML(doc){
    const empresa = await readEmpresa();
    const emitNome = empresa.razao_social || empresa.nome_fantasia || "Empresa não configurada";
    const emitDoc = empresa.cnpj ? maskCnpjCpf(empresa.cnpj) : "CNPJ não informado";
    const emitIE = empresa.ie || "—";
    const emitIM = empresa.im || "—";
    const emitEndereco = [empresa.logradouro, empresa.numero, empresa.complemento, empresa.bairro, empresa.cidade, empresa.uf, empresa.cep].filter(Boolean).join(", ") || "Endereço não informado";
    const emitContato = [empresa.telefone || empresa.celular || "", empresa.email || ""].filter(Boolean).join(" · ");
    const logo = empresa.__logoA || "";
    const key = buildAccessKeyPreview(doc, empresa);
    const keyGrouped = groupKey(key);
    const isAuthorized = String(doc.status || "").toUpperCase() === "AUTHORIZED";
    const statusText = badgeForStatus(doc.status).label;
    const itemRows = (doc.items || []).map((item) => `
      <tr>
        <td>${esc(item.codigo || "")}</td>
        <td>${esc(item.descricao || "—")}</td>
        <td>${esc(item.ncm || "")}</td>
        <td>${esc(item.cfop || "")}</td>
        <td>${esc(item.unidade || "UN")}</td>
        <td class="num">${String(Number(item.quantidade || 0)).replace(".", ",")}</td>
        <td class="num">${centsToBRL(item.valor_unit_cents || 0)}</td>
        <td class="num">${centsToBRL(item.valor_total_cents || 0)}</td>
      </tr>
    `).join("");

    const totalProdutos = doc.items.reduce((sum, item) => sum + Number(item.valor_total_cents || 0), 0);
    const watermark = !isAuthorized ? `<div class="watermark">${doc.ambiente === "HOMOLOG" ? "SEM VALOR FISCAL" : "RASCUNHO INTERNO"}</div>` : "";
    const protocoloLinha = doc.protocolo ? esc(doc.protocolo) : (isAuthorized ? "Protocolo não informado" : "Aguardando autorização SEFAZ");

    return `<!DOCTYPE html>
<html lang="pt-br">
<head>
<meta charset="utf-8" />
<title>DANFE ${esc(doc.numero || "")}</title>
<style>
  @page { size: A4 portrait; margin: 10mm; }
  *{ box-sizing:border-box; }
  body{
    margin:0; font-family:Arial,Helvetica,sans-serif; color:#111; background:#e2e8f0;
  }
  .sheet{
    width:190mm; min-height:277mm; margin:0 auto; background:#fff; position:relative;
    padding:6mm 7mm 7mm; box-shadow:0 0 0 1px rgba(15,23,42,.08);
  }
  .watermark{
    position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
    font-size:42px; font-weight:900; letter-spacing:.16em; color:rgba(185,28,28,.11); transform:rotate(-26deg);
    pointer-events:none; text-align:center;
  }
  .danfe-title{
    display:grid; grid-template-columns:1.35fr .95fr; gap:6mm;
  }
  .box{
    border:1px solid #111; padding:2.4mm; position:relative;
  }
  .box h1,.box h2,.box h3,.box p{ margin:0; }
  .emitente-grid{
    display:grid; grid-template-columns:${logo ? "34mm 1fr" : "1fr"}; gap:3mm; align-items:start;
  }
  .logo{
    width:100%; max-height:24mm; object-fit:contain; border:1px solid #ddd; padding:2mm;
  }
  .emitente-nome{ font-size:13px; font-weight:900; line-height:1.2; }
  .tiny{ font-size:9px; line-height:1.35; }
  .micro{ font-size:8px; line-height:1.35; }
  .title-right{
    text-align:center; min-height:100%;
  }
  .title-right .docname{ font-size:18px; font-weight:900; letter-spacing:.02em; }
  .title-right .tipo{ font-size:10px; margin-top:1.5mm; }
  .title-right .num{ font-size:12px; font-weight:900; margin-top:2mm; }
  .keybox{
    margin-top:3mm; text-align:center; border:1px solid #111; padding:2mm 1.5mm;
  }
  .keybox .lbl{ font-size:8px; font-weight:900; text-transform:uppercase; letter-spacing:.08em; }
  .keybox .key{ font-size:11px; font-weight:900; letter-spacing:.07em; margin-top:1.4mm; }
  .barcode{
    margin:2.2mm auto 0; width:92%; height:12mm; background:
      repeating-linear-gradient(90deg,
        #000 0,#000 .8mm,
        transparent .8mm, transparent 1.2mm,
        #000 1.2mm,#000 1.8mm,
        transparent 1.8mm, transparent 2.4mm);
    opacity:.86;
  }
  .hdr-grid{
    display:grid; grid-template-columns:1.1fr .9fr; gap:3mm; margin-top:3mm;
  }
  .sec{
    margin-top:2.5mm;
  }
  .sec-title{
    font-size:8px; font-weight:900; text-transform:uppercase; letter-spacing:.08em; margin-bottom:1mm;
  }
  .row{
    display:grid; grid-template-columns:repeat(4, 1fr); gap:2mm;
  }
  .field{
    border:1px solid #111; min-height:13mm; padding:1.6mm 1.8mm;
  }
  .field.w2{ grid-column:span 2; }
  .field.w3{ grid-column:span 3; }
  .field.w4{ grid-column:span 4; }
  .field .lbl{ font-size:7px; font-weight:900; text-transform:uppercase; letter-spacing:.05em; }
  .field .val{ font-size:10px; margin-top:.8mm; line-height:1.25; word-break:break-word; }
  table{
    width:100%; border-collapse:collapse; margin-top:0;
  }
  thead th{
    border:1px solid #111; background:#f8fafc; font-size:7px; text-transform:uppercase;
    letter-spacing:.05em; padding:1.6mm 1.2mm; text-align:left;
  }
  tbody td{
    border:1px solid #111; font-size:9px; padding:1.6mm 1.2mm; vertical-align:top;
  }
  td.num, th.num{ text-align:right; }
  .totais{
    display:grid; grid-template-columns:repeat(4,1fr); gap:2mm; margin-top:2mm;
  }
  .obs{
    border:1px solid #111; min-height:20mm; padding:2mm;
  }
  .footer{
    margin-top:3mm; display:grid; grid-template-columns:1fr auto; gap:3mm; align-items:end;
  }
  .status{
    border:1px solid #111; padding:2mm; text-align:center; font-size:10px; font-weight:900;
    background:${isAuthorized ? "#ecfdf3" : "#fff7ed"};
  }
  .page-note{
    margin-top:2mm; font-size:7.5px; color:#334155;
  }
  @media print{
    body{ background:#fff; }
    .sheet{ margin:0; width:auto; min-height:auto; box-shadow:none; }
  }
</style>
</head>
<body>
  <div class="sheet">
    ${watermark}
    <div class="danfe-title">
      <div class="box">
        <div class="emitente-grid">
          ${logo ? `<img src="${logo}" alt="Logo" class="logo" />` : ""}
          <div>
            <div class="emitente-nome">${esc(emitNome)}</div>
            <div class="tiny" style="margin-top:1.6mm;">${esc(emitEndereco)}</div>
            <div class="tiny" style="margin-top:1.2mm;">${esc(emitDoc)} · IE ${esc(emitIE)} · IM ${esc(emitIM)}</div>
            ${emitContato ? `<div class="tiny" style="margin-top:1.2mm;">${esc(emitContato)}</div>` : ""}
          </div>
        </div>
      </div>

      <div class="box title-right">
        <div class="docname">DANFE</div>
        <div class="tipo">Documento Auxiliar da Nota Fiscal Eletrônica</div>
        <div class="num">NF-e nº ${esc(doc.numero || "—")}</div>
        <div class="tiny" style="margin-top:1mm;">Série ${esc(doc.serie || "1")} · ${esc(doc.ambiente || "HOMOLOG")}</div>
        <div class="keybox">
          <div class="lbl">${isAuthorized ? "Chave de acesso" : "Chave prévia interna para impressão"}</div>
          <div class="key">${esc(keyGrouped)}</div>
          <div class="barcode"></div>
        </div>
      </div>
    </div>

    <div class="hdr-grid">
      <div class="box">
        <div class="sec-title">Natureza da operação</div>
        <div class="tiny">${esc(doc.natureza || "—")}</div>
      </div>
      <div class="box">
        <div class="sec-title">Protocolo de autorização / status</div>
        <div class="tiny">${protocoloLinha}</div>
      </div>
    </div>

    <div class="sec">
      <div class="row">
        <div class="field w2">
          <div class="lbl">Destinatário / razão social</div>
          <div class="val">${esc(doc.dest_nome || "—")}</div>
        </div>
        <div class="field">
          <div class="lbl">CPF/CNPJ</div>
          <div class="val">${esc(maskCnpjCpf(doc.dest_doc || "")) || "—"}</div>
        </div>
        <div class="field">
          <div class="lbl">Inscrição estadual</div>
          <div class="val">${esc(doc.dest_ie || "—")}</div>
        </div>
        <div class="field w3">
          <div class="lbl">Endereço</div>
          <div class="val">${esc(doc.dest_endereco || "—")}</div>
        </div>
        <div class="field">
          <div class="lbl">Telefone</div>
          <div class="val">${esc(doc.dest_fone || "—")}</div>
        </div>
        <div class="field">
          <div class="lbl">Data de emissão</div>
          <div class="val">${esc(fmtDateTime(doc.emissao_em))}</div>
        </div>
        <div class="field">
          <div class="lbl">Data de saída</div>
          <div class="val">${esc(fmtDateTime(doc.saida_em))}</div>
        </div>
      </div>
    </div>

    <div class="sec">
      <div class="sec-title">Itens</div>
      <table>
        <thead>
          <tr>
            <th style="width:13%;">Código</th>
            <th>Descrição do produto / serviço</th>
            <th style="width:10%;">NCM</th>
            <th style="width:9%;">CFOP</th>
            <th style="width:7%;">UN</th>
            <th style="width:9%;" class="num">Qtd.</th>
            <th style="width:12%;" class="num">Vlr unit.</th>
            <th style="width:12%;" class="num">Vlr total</th>
          </tr>
        </thead>
        <tbody>
          ${itemRows || `<tr><td colspan="8" class="micro">Nenhum item informado.</td></tr>`}
        </tbody>
      </table>
    </div>

    <div class="sec">
      <div class="sec-title">Cálculo do imposto</div>
      <div class="totais">
        <div class="field">
          <div class="lbl">Base ICMS</div>
          <div class="val">R$ ${centsToBRL(doc.base_icms_cents || 0)}</div>
        </div>
        <div class="field">
          <div class="lbl">Valor ICMS</div>
          <div class="val">R$ ${centsToBRL(doc.valor_icms_cents || 0)}</div>
        </div>
        <div class="field">
          <div class="lbl">Frete</div>
          <div class="val">R$ ${centsToBRL(doc.frete_cents || 0)}</div>
        </div>
        <div class="field">
          <div class="lbl">Desconto</div>
          <div class="val">R$ ${centsToBRL(doc.desconto_cents || 0)}</div>
        </div>
        <div class="field">
          <div class="lbl">Total produtos</div>
          <div class="val">R$ ${centsToBRL(totalProdutos)}</div>
        </div>
        <div class="field">
          <div class="lbl">Total NF-e</div>
          <div class="val">R$ ${centsToBRL(doc.total_cents || 0)}</div>
        </div>
        <div class="field w2">
          <div class="lbl">Status do documento</div>
          <div class="val">${esc(statusText)} · ${isAuthorized ? "Apto para representação autorizada" : "Pré-visualização interna"}</div>
        </div>
      </div>
    </div>

    <div class="sec">
      <div class="sec-title">Informações complementares</div>
      <div class="obs tiny">${esc(doc.obs || "Sem observações adicionais.")}</div>
    </div>

    <div class="footer">
      <div class="page-note">
        DANFE gerada pelo Vet System Control — impressão A4 interna. O Manual de Especificações Técnicas do DANFE permanece a referência para leiaute, e o documento auxiliar só acompanha circulação de mercadoria quando vinculado a NF-e autorizada. 
      </div>
      <div class="status">${esc(statusText)}</div>
    </div>
  </div>
</body>
</html>`;
  }

  function cleanupPreviewUrl(){
    try{
      if(previewUrl){
        URL.revokeObjectURL(previewUrl);
      }
    }catch(_){}
    previewUrl = "";
  }

  async function openPreview(doc, autoPrint){
    const modal = $("danfePreviewModal");
    const frame = $("danfeFrame");
    const info = $("danfePreviewInfo");
    const html = await buildDanfeHTML(doc);
    const blob = new Blob([html], { type:"text/html;charset=utf-8" });
    cleanupPreviewUrl();
    previewUrl = URL.createObjectURL(blob);
    frame.src = previewUrl;
    info.textContent = `NF-e ${doc.serie || "1"}/${doc.numero || "—"} · ${doc.dest_nome || "sem destinatário"} · R$ ${centsToBRL(doc.total_cents || 0)}`;
    modal.style.display = "flex";
    modal.setAttribute("aria-hidden", "false");

    frame.onload = () => {
      if(autoPrint){
        try{
          frame.contentWindow.focus();
          frame.contentWindow.print();
        }catch(e){
          console.error("[FISCAL][PRINT]", e);
          snack("Não foi possível acionar a impressão automaticamente.", "warn");
        }
      }
    };
  }

  function closePreview(){
    const modal = $("danfePreviewModal");
    const frame = $("danfeFrame");
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
    frame.src = "about:blank";
    cleanupPreviewUrl();
  }

  function bindPreviewUI(){
    $("btnDanfeClose").addEventListener("click", closePreview);
    $("danfePreviewModal").addEventListener("click", (ev) => {
      if(ev.target === $("danfePreviewModal")) closePreview();
    });
    $("btnDanfePrint").addEventListener("click", () => {
      try{
        $("danfeFrame").contentWindow.focus();
        $("danfeFrame").contentWindow.print();
      }catch(e){
        snack("Não foi possível imprimir o DANFE.", "err");
      }
    });
    $("btnDanfeDownload").addEventListener("click", () => {
      if(!previewUrl){
        snack("Nenhuma pré-visualização carregada.", "warn");
        return;
      }
      const a = document.createElement("a");
      const doc = currentDocSnapshot();
      a.href = previewUrl;
      a.download = `danfe-${doc.serie || "1"}-${doc.numero || "rascunho"}.html`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  }

  function bindFormAutoRecalc(){
    ["fFrete","fDesconto"].forEach((id) => {
      const el = $(id);
      if(el){
        el.addEventListener("input", () => recalcTotalsFromItems({ silent:true }));
        el.addEventListener("change", () => recalcTotalsFromItems({ silent:true }));
      }
    });
  }

  function bind(){
    $("btnNovo").addEventListener("click", () => actionNovo().catch(e => setMsg(String(e), "err")));
    $("btnSalvar").addEventListener("click", () => actionSalvar().catch(e => setMsg(String(e), "err")));
    $("btnExcluir").addEventListener("click", () => actionExcluir().catch(e => setMsg(String(e), "err")));
    $("btnVisualizar").addEventListener("click", async () => {
      try{
        await actionSalvar();
        openPreview(currentDocSnapshot(), false);
      }catch(e){
        setMsg(`Falha ao gerar pré-visualização: ${String(e && e.message ? e.message : e)}`, "err");
      }
    });
    $("btnImprimir").addEventListener("click", async () => {
      try{
        await actionSalvar();
        openPreview(currentDocSnapshot(), true);
      }catch(e){
        setMsg(`Falha ao imprimir DANFE: ${String(e && e.message ? e.message : e)}`, "err");
      }
    });
    $("btnLimpar").addEventListener("click", () => { $("q").value = ""; renderTable(); });
    $("q").addEventListener("input", renderTable);
    $("btnAddItem").addEventListener("click", () => {
      currentItems.push(normalizeItem({ id: uuidv4(), unidade:"UN", quantidade:1 }));
      renderItems();
    });
    $("btnCertImport").addEventListener("click", () => importCertA1());
    $("btnCertRefresh").addEventListener("click", () => fetchCertStatus());
    bindPreviewUI();
    bindFormAutoRecalc();
  }

  async function init(){
    try{
      if(window.VSC_AUTH && typeof window.VSC_AUTH.selfTest === "function"){
        await window.VSC_AUTH.selfTest();
      }
    }catch(_){}

    summarizeEmpresa(await readEmpresa());
    bind();
    await fillDefaultsForNewDoc();
    setButtons(currentDocSnapshot());
    await refreshList();
    await fetchCertStatus();

    window.addEventListener("storage", async (ev) => {
      if(ev.key === "vsc_empresa_v1"){
        summarizeEmpresa(await readEmpresa());
      }
    });
  }

  window.addEventListener("beforeunload", cleanupPreviewUrl);
  window.addEventListener("DOMContentLoaded", () => {
    init().catch((e) => {
      console.error("[FISCAL] init fail", e);
      setMsg("Falha ao inicializar módulo fiscal.", "err");
    });
  });
})();