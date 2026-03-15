// SGQT-Version: 12.6
// Module-Version: 3.1.0
// Change-Request: CR-2026-005
// Date: 2026-03-03
// Author: Patch Bot

/* ========================================================================
   VET SYSTEM CONTROL – EQUINE
   MÓDULO: ATENDIMENTOS v3.0 — Workflow Completo
   
   NOVIDADES v3.0:
   ─ Numeração AUTOMÁTICA SEQUENCIAL (ATD-AAAA-NNNNN)
   ─ 3 estados: orcamento / em_atendimento / finalizado
   ─ Orçamento: NÃO movimenta estoque nem financeiro
   ─ Em Atendimento: movimenta ESTOQUE (produtos)
   ─ Finalizado: movimenta ESTOQUE + gera CONTAS A RECEBER
   ─ Mensagens claras sobre o que será ou não movimentado
   ─ Lista com filtros (número, cliente, animal, status, data)
   ─ Integração real com VSC_AR (contas a receber)
   ─ Integração real com catálogo (produtos/serviços/exames)
   ─ Deslocamento km × R$/km via config_params
   ======================================================================== */

/* globals VSC_DB, VSC_AR */
(function () {
  "use strict";

  // ─── Helpers ──────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const onlyDigits = (s) => String(s || "").replace(/\D+/g, "");
  const isoNow = () => new Date().toISOString();
  const todayYMD = () => new Date().toISOString().slice(0, 10);

  function parseDateFlexible(v){
    if(!v) return null;
    if(v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
    const s = String(v).trim();
    if(!s) return null;
    if(/^\d{4}-\d{2}-\d{2}$/.test(s)){
      const d = new Date(s + 'T12:00:00');
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if(br){
      const d = new Date(`${br[3]}-${br[2]}-${br[1]}T12:00:00`);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const shortBr = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
    if(shortBr){
      const year = Number(shortBr[3]) + 2000;
      const mm = String(shortBr[2]).padStart(2,'0');
      const dd = String(shortBr[1]).padStart(2,'0');
      const d = new Date(`${year}-${mm}-${dd}T12:00:00`);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // Normaliza data para <input type="date"> (YYYY-MM-DD).
  function toYMD(v){
    const d = parseDateFlexible(v);
    return d ? d.toISOString().slice(0,10) : "";
  }
  const todayYear = () => new Date().getFullYear();

  function uuidv4() {
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
    throw new TypeError("[ATENDIMENTOS] ambiente sem CSPRNG para gerar UUID v4.");
  }

  function toNumPt(s) {
    s = String(s || "").trim().replace(/\s+/g, "");
    if (!s) return 0;
    if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }

  function fmtBRL(n) {
    n = Number(n || 0);
    try { return "R$ " + n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    catch (_) { return "R$ " + Math.round(n * 100) / 100; }
  }

  function fmtDate(iso) {
    const d = parseDateFlexible(iso);
    if (!d) return "—";
    try { return d.toLocaleDateString("pt-BR"); } catch (_) { return "—"; }
  }

  function fmtDateTime(iso) {
    const d = parseDateFlexible(iso);
    if (!d) return "—";
    try { return d.toLocaleString("pt-BR"); } catch (_) { return "—"; }
  }

  function addDaysYMD(ymd, days){
    const d = parseDateFlexible(ymd || todayYMD()) || new Date();
    d.setDate(d.getDate() + Number(days || 0));
    return d.toISOString().slice(0,10);
  }

  function boolish(v){
    if (typeof v === "boolean") return v;
    const s = norm(v);
    return ["1","true","sim","yes","ativo","enabled"].includes(s);
  }

  function pickFirstNonEmpty(){
    for (const v of arguments){
      if (v == null) continue;
      if (Array.isArray(v) && v.length) return v[0];
      if (String(v).trim()) return v;
    }
    return "";
  }

  
  
  // ─── UX ENTERPRISE: normalização/máscara determinística (pt-BR) ───────
  // Objetivo: impedir persistência de "texto livre" em campos numéricos/monetários
  // e padronizar a experiência (estilo enterprise/Fiori-like): input guiado + validação no blur.
  function formatFixedBR(n, dec){
    n = Number(n || 0);
    if(!Number.isFinite(n)) n = 0;
    return n.toFixed(dec).replace(".", ",");
  }

  function sanitizeDecimalStringBR(raw, dec){
    // mantém somente dígitos e uma vírgula; limita casas decimais
    let s = String(raw || "");
    s = s.replace(/[^0-9,]/g, "");
    const parts = s.split(",");
    const intPart = (parts[0] || "").replace(/^0+(?=\d)/, "0"); // mantém um 0 se houver
    let frac = parts[1] != null ? parts[1] : "";
    if (dec >= 0) frac = frac.slice(0, dec);
    s = parts.length > 1 ? (intPart + "," + frac) : intPart;
    // se começar com vírgula, prefixa 0
    if(s.startsWith(",")) s = "0" + s;
    return s;
  }

  function wireDecimalInput(id, dec, opts){
    const el = $(id);
    if(!el || el.__vscDecWired) return;
    el.__vscDecWired = true;
    const allowEmpty = !!(opts && opts.allowEmpty);
    const min = (opts && typeof opts.min === "number") ? opts.min : null;
    const max = (opts && typeof opts.max === "number") ? opts.max : null;

    el.addEventListener("input", () => {
      const caret = el.selectionStart;
      const before = el.value;
      const cleaned = sanitizeDecimalStringBR(before, dec);
      if(cleaned !== before){
        el.value = cleaned;
        try{ el.setSelectionRange(caret, caret); }catch(_){}
      }
    });

    el.addEventListener("blur", () => {
      const raw = String(el.value || "").trim();
      if(!raw){
        if(!allowEmpty) el.value = formatFixedBR(0, dec);
        return;
      }
      let n = toNumPt(raw);
      if(min != null) n = Math.max(min, n);
      if(max != null) n = Math.min(max, n);
      el.value = formatFixedBR(n, dec);
    });
  }

  function wireIntInput(id, opts){
    const el = $(id);
    if(!el || el.__vscIntWired) return;
    el.__vscIntWired = true;
    const allowEmpty = !!(opts && opts.allowEmpty);
    const min = (opts && typeof opts.min === "number") ? opts.min : null;
    const max = (opts && typeof opts.max === "number") ? opts.max : null;

    el.addEventListener("input", () => {
      el.value = String(el.value || "").replace(/\D+/g,"");
    });
    el.addEventListener("blur", () => {
      const raw = String(el.value || "").trim();
      if(!raw){
        if(!allowEmpty) el.value = "0";
        return;
      }
      let n = parseInt(raw,10);
      if(!Number.isFinite(n)) n = 0;
      if(min != null) n = Math.max(min, n);
      if(max != null) n = Math.min(max, n);
      el.value = String(n);
    });
  }

  function wireEnterpriseMasks(){
    if(wireEnterpriseMasks.__wired) return;
    wireEnterpriseMasks.__wired = true;

    // Desconto: se tipo "%" limitar 0-100; se "R$" tratar como moeda/decimal
    const tipoSel = $("desconto_tipo");
    const valInp = $("desconto_valor");
    function applyDescontoMask(){
      const t = String(tipoSel?.value || "R$");
      if(t === "%"){
        wireDecimalInput("desconto_valor", 2, { min: 0, max: 100, allowEmpty:false });
      }else{
        wireDecimalInput("desconto_valor", 2, { min: 0, allowEmpty:false });
      }
    }
    if(tipoSel){
      tipoSel.addEventListener("change", applyDescontoMask);
    }
    applyDescontoMask();

    // Deslocamento (km): 1 casa é suficiente, mas 2 dá flexibilidade
    wireDecimalInput("desl_km", 2, { min: 0, allowEmpty:false });

    // Modal item
    wireDecimalInput("item_qtd", 2, { min: 0, allowEmpty:false });
    wireDecimalInput("item_vu", 2, { min: 0, allowEmpty:false });

    // Vitais
    wireDecimalInput("v_temp", 1, { min: 0, allowEmpty:true });
    wireIntInput("v_fc", { min: 0, allowEmpty:true });
    wireIntInput("v_fr", { min: 0, allowEmpty:true });
    wireDecimalInput("v_peso", 1, { min: 0, allowEmpty:true });

    // Campos financeiros
    wireDecimalInput("financeDecisionEntryAmount", 2, { min: 0, allowEmpty:true });

    // Campos readonly monetários são calculados via JS (não edita)
  }


  // ─── ATTACHMENTS (PDF + IMAGENS) ─────────────────────────────────────
  // Padrão web: <input type="file"> + FileReader.readAsDataURL() para embutir imagem/PDF no relatório,
  // e window.print() para abrir o diálogo de impressão (o usuário escolhe a impressora).
  // Referências: MDN (input:file, FileReader.readAsDataURL, window.print, load/beforeprint/print CSS).
  const ATTACH_MAX_FILE_BYTES = 12 * 1024 * 1024; // 12MB por arquivo (base64 cresce)
  const PDFJS_VERSION = "3.11.174";
  const PDFJS_CDN_BASE = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/" + PDFJS_VERSION;

  function bytesToHuman(n){
    n = Number(n||0);
    const u = ["B","KB","MB","GB"];
    let i=0; while(n>=1024 && i<u.length-1){ n/=1024; i++; }
    return (i===0? String(Math.round(n)) : n.toFixed(1).replace('.',',')) + " " + u[i];
  }

  function isImageMime(t){ return /^image\//.test(String(t||"")); }

  function renderAttachPills(){
    const btns = ["btnAnexosTop","btnAnexos"].map(id => $(id)).filter(Boolean);
    const count = (ATD.attachments||[]).length;
    btns.forEach(b => {
      const base = "📎 Anexos";
      b.textContent = count ? `${base} (${count})` : base;
    });
  }

  function openAttachModal(){
    const m = $("vscAttachModal"); if(!m) return;
    m.classList.remove("hidden"); m.setAttribute("aria-hidden","false");
    $("attachLimitInfo") && ($("attachLimitInfo").value = bytesToHuman(ATTACH_MAX_FILE_BYTES));
    renderAttachList();
  }

  function closeAttachModal(){
    const m = $("vscAttachModal"); if(!m) return;
    m.classList.add("hidden"); m.setAttribute("aria-hidden","true");
  }

  
  function renderAttachList(){
    const list = $("attachList"); if(!list) return;
    const atts = Array.isArray(ATD.attachments) ? ATD.attachments : [];
    if(!atts.length){
      list.innerHTML = `<div class="hint" style="padding:14px 4px;">Nenhum arquivo anexado.</div>`;
      renderAttachPills();
      $("btnAttachSave") && ($("btnAttachSave").disabled = true);
      return;
    }

    list.innerHTML = atts.map((a, idx) => {
      const isPdf  = String(a.mime||"") === "application/pdf";
      const icon   = isPdf ? "PDF" : "IMG";
      const sub    = `${isPdf ? "PDF" : "Imagem"} • ${bytesToHuman(a.size||0)}`;
      const desc   = String(a.descricao || "").trim();
      const badge  = `<span class="attach-tipo-badge${isPdf ? ' pdf' : ''}">${isPdf ? 'PDF' : 'Foto'}</span>`;

      // Descrição disponível para TODOS os tipos (foto e PDF)
      const missingCls = !desc ? "missing" : "";
      const placeholder = isPdf
        ? "Descreva o conteúdo do PDF (ex.: hemograma 08/2022, laudo de imagem...)"
        : "Descreva a foto (ex.: lesão na região X; antes/depois; detalhe do casco...)";
      const descHtml = `
        <div class="attach-desc-wrap" style="margin-top:8px;">
          <div class="hint" style="margin-bottom:6px;font-size:11px;">
            ${isPdf ? '📄 Descrição do PDF' : '📷 Descrição da foto'} <span style="opacity:.6;">(impressa abaixo do arquivo no relatório)</span>
          </div>
          <textarea class="attach-desc ${missingCls}" data-attach-desc data-idx="${idx}" placeholder="${placeholder}">${esc(desc)}</textarea>
        </div>`;

      return `<div class="attach-row" data-idx="${idx}">
        <div class="attach-row-top">
          <div class="attach-ico"><strong style="font-size:11px;color:var(--muted);">${icon}</strong></div>
          <div class="attach-meta">
            <div class="attach-name" title="${esc(a.name||"")}">${esc(a.name||"(sem nome)")}${badge}</div>
            <div class="attach-sub">${esc(sub)}</div>
          </div>
          <div class="attach-actions">
            <button class="btn btn--ghost btn--xs" data-act="view" type="button">Ver</button>
            <button class="btn btn--danger btn--xs" data-act="del" type="button">Remover</button>
          </div>
        </div>
        ${descHtml}
      </div>`;
    }).join("");

    renderAttachPills();
    // Habilita salvar se houver qualquer anexo (não só fotos)
    $("btnAttachSave") && ($("btnAttachSave").disabled = !atts.length);
  }

  async function handleAttachFiles(files){
    if(!files || !files.length) return;
    const arr = Array.from(files);
    for(const f of arr){
      const mime = String(f.type||"");
      const okType = mime === "application/pdf" || isImageMime(mime);
      if(!okType){ snack(`Tipo não suportado: ${f.name}`, "err"); continue; }
      if(f.size > ATTACH_MAX_FILE_BYTES){ snack(`Arquivo muito grande (${bytesToHuman(f.size)}): ${f.name}`, "err"); continue; }

      const dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result||""));
        r.onerror = () => reject(new Error("Falha ao ler arquivo"));
        r.readAsDataURL(f);
      });

      ATD.attachments = Array.isArray(ATD.attachments) ? ATD.attachments : [];
      ATD.attachments.push({
        id: uuidv4(),
        name: f.name || "arquivo",
        mime,
        size: f.size || 0,
        dataUrl,
        descricao: "", // SGQT: descrição clínica (somente fotos)
        created_at: isoNow()
      });
    }
    renderAttachList();
    snack("Anexos adicionados. Preencha as descrições e clique em Salvar.", "ok");
  }

  async function openAttachmentInNewTab(att){
    if(!att) return;

    // Se tem dataUrl local, abre direto
    if(att.dataUrl){
      _renderAttachWindow(att, att.dataUrl);
      return;
    }

    // Sem dataUrl — busca do R2
    if(!att.synced_to_r2){ snack("Anexo sem dados locais e não sincronizado com o servidor.", "err"); return; }
    if(!ATD.atendimento_id){ snack("ID do atendimento não encontrado.", "err"); return; }

    snack("Baixando anexo do servidor...", "ok");
    try {
      const base = (location.hostname==='127.0.0.1'||location.hostname==='localhost')
        ? 'https://app.vetsystemcontrol.com.br' : '';
      const url = `${base}/api/attachments?action=download&atendimento_id=${encodeURIComponent(ATD.atendimento_id)}&attachment_id=${encodeURIComponent(att.id)}`;
      const res = await fetch(url, { headers: getAttachmentAuthHeaders() });
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      // Salva localmente para próxima vez
      att.dataUrl = dataUrl;
      _renderAttachWindow(att, dataUrl);
    } catch(e) {
      snack("Erro ao baixar anexo: " + (e.message||"erro"), "err");
    }
  }

  function _renderAttachWindow(att, dataUrl){
    const attWin = window.open("about:blank", "_blank");
    if(!attWin){ snack("Pop-up bloqueado. Libere pop-ups para visualizar anexos.", "warn"); return; }
    const title = esc(att.name || "Anexo");
    const isPdf = String(att.mime||"") === "application/pdf";
    const body = isPdf
      ? `<embed src="${dataUrl}" type="application/pdf" style="width:100%;height:100vh;"/>`
      : `<img src="${dataUrl}" style="max-width:100%;height:auto;display:block;margin:0 auto;"/>`;
    attWin.document.open();
    attWin.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="margin:0;padding:0;background:#111;color:#fff;">${body}</body></html>`);
    attWin.document.close();
  }

  // SGQT-ATTACH-VALIDATE-1.1 — descrição obrigatória para qualquer anexo (imagem/PDF)
  // Justificativa (enterprise/segurança clínica): anexo sem contexto perde rastreabilidade e pode invalidar auditoria/relato.
  function validateAttachDescriptionsBeforeFinalize(){
    const atts = Array.isArray(ATD.attachments) ? ATD.attachments : [];
    const missing = [];
    for(let i=0;i<atts.length;i++){
      const a = atts[i] || {};
      if(!String(a.descricao||"").trim()) missing.push(i);
    }
    return missing;
  }

function wireAttachListInteractions(db){
    const list = $("attachList");
    if(!list || list.__wiredAttachList) return;
    list.__wiredAttachList = true;

    // Clique: ver/remover
    list.addEventListener("click", async (ev) => {
      let t = ev.target;
      if(!t) return;
      const act = t.getAttribute && t.getAttribute("data-act");
      if(!act) return;
      const row = t.closest && t.closest(".attach-row");
      const idx = row ? Number(row.getAttribute("data-idx")) : NaN;
      if(!Number.isFinite(idx)) return;

      const atts = Array.isArray(ATD.attachments) ? ATD.attachments : [];
      const att = atts[idx];
      if(!att) return;

      if(act === "view"){
        openAttachmentInNewTab(att);
        return;
      }

      if(act === "del"){
        const ok = await confirm("Remover anexo", `Deseja remover o anexo "${att.name||"arquivo"}"?`);
        if(!ok) return;
        atts.splice(idx, 1);
        ATD.attachments = atts;
        renderAttachList();
        snack("Anexo removido. Salve o atendimento para persistir.", "ok");
      }
    });

    // Input: descrição (somente fotos)
    list.addEventListener("input", (ev) => {
      const el = ev.target;
      if(!el || el.tagName !== "TEXTAREA") return;
      if(!el.hasAttribute("data-attach-desc")) return;
      const idx = Number(el.getAttribute("data-idx"));
      if(!Number.isFinite(idx)) return;
      const atts = Array.isArray(ATD.attachments) ? ATD.attachments : [];
      const att = atts[idx];
      if(!att) return;
      att.descricao = String(el.value || "").trim();
      // marca visualmente
      if(att.descricao){ el.classList.remove("missing"); }
      else { el.classList.add("missing"); }
      // habilita salvar
      $("btnAttachSave") && ($("btnAttachSave").disabled = false);
    });
  }
// ─── IMPRESSÃO "PREMIUM" (RELATÓRIO + ANEXOS) ─────────────────────────
  // Padrão premium em apps web: gerar um "print document" dedicado (HTML),
  // garantir carregamento total (load) e então chamar window.print() (abre diálogo de impressora).
  // PDFs anexados: renderizar cada página em canvas via PDF.js e inserir como imagem (efeito “folha escaneada”).
  // Referências: MDN window.print/load/beforeprint; PDF.js getting started e CDNs.
  function dataUrlToUint8(dataUrl){
    const s = String(dataUrl||"");
    const i = s.indexOf("base64,");
    if(i<0) return null;
    const b64 = s.slice(i+7);
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for(let k=0;k<bin.length;k++) u8[k]=bin.charCodeAt(k);
    return u8;
  }

  function resolveEmpresaNome(src){
    if(!src || typeof src !== "object") return "";
    return String(src.nome || src.razao_social || src.nome_fantasia || src.fantasia || src.empresa_nome || "").trim();
  }

  function resolveEmpresaLogoA(src){
    if(!src || typeof src !== "object") return "";
    return String(
      src.__logoA ||
      src.logoA ||
      src.logo_a ||
      src.logo_a_dataurl ||
      src.logo_a_dataUrl ||
      src.logo_a_dataURL ||
      src.logoAUrl ||
      src.logo_url_a ||
      src.empresa_logo_a ||
      src.logo ||
      ""
    ).trim();
  }

  function resolveEmpresaLogoB(src){
    if(!src || typeof src !== "object") return "";
    return String(
      src.__logoB ||
      src.logoB ||
      src.logo_b ||
      src.logo_b_dataurl ||
      src.logo_b_dataUrl ||
      src.logo_b_dataURL ||
      src.logoBUrl ||
      src.logo_url_b ||
      src.empresa_logo_b ||
      ""
    ).trim();
  }

  function resolvePreferredCompanyPrintLogo(src){
    const logoA = resolveEmpresaLogoA(src);
    if(logoA) return logoA;
    return resolveEmpresaLogoB(src);
  }

  function getAttachmentId(att){
    if(!att || typeof att !== "object") return "";
    return String(att.id || att.attachment_id || att.uuid || att.key || att.file_id || "").trim();
  }

  function getAttachmentName(att, fallback){
    if(!att || typeof att !== "object") return String(fallback || "");
    return String(att.name || att.nome || att.filename || att.file_name || att.originalname || att.titulo || fallback || "").trim();
  }

  function getAttachmentMime(att){
    if(!att || typeof att !== "object") return "";
    return String(att.mime || att.mime_type || att.contentType || att.type || att.content_type || "").trim();
  }

  function getAttachmentSize(att){
    if(!att || typeof att !== "object") return 0;
    return Number(att.size || att.tamanho || att.size_bytes || 0) || 0;
  }

  function normalizeInlineAttachmentData(att){
    if(!att || typeof att !== "object") return "";
    const direct = att.dataUrl || att.dataURL || att.data_base64 || att.base64 || att.file_base64 || att.blob_base64 || "";
    if(!direct) return "";
    const text = String(direct).trim();
    if(!text) return "";
    if(/^data:/i.test(text)) return text;
    const mime = String(att.mime || att.mime_type || 'application/octet-stream').trim() || 'application/octet-stream';
    return `data:${mime};base64,${text.replace(/^base64,/i,'')}`;
  }

  async function getEmpresaLogoAFromLocalStorage(){
    try{
      const j = localStorage.getItem("vsc_empresa_v1") || localStorage.getItem("VSC_EMPRESA_V1") || "";
      if(j){
        const o = JSON.parse(j);
        const a = resolveEmpresaLogoA(o);
        if(a) return a;
      }
      const direct = localStorage.getItem("vsc_empresa_logoA") || localStorage.getItem("vsc_empresa_logo_a") || localStorage.getItem("VSC_EMPRESA_LOGO_A") || "";
      if(direct) return String(direct);
      return "";
    }catch(_){
      return "";
    }
  }

  async function getEmpresaLogoBFromLocalStorage(){
    try{
      const j = localStorage.getItem("vsc_empresa_v1") || localStorage.getItem("VSC_EMPRESA_V1") || "";
      if(j){
        const o = JSON.parse(j);
        const b = resolveEmpresaLogoB(o);
        if(b) return b;
      }
      const direct = localStorage.getItem("vsc_empresa_logoB") || localStorage.getItem("vsc_empresa_logo_b") || localStorage.getItem("VSC_EMPRESA_LOGO_B") || "";
      if(direct) return String(direct);
      return "";
    }catch(_){
      return "";
    }
  }

async function loadEmpresaSnapshot(db){
    try{
      if(window.VSC_DB && typeof window.VSC_DB.getEmpresaSnapshot === "function"){
        const canonical = await window.VSC_DB.getEmpresaSnapshot({ preferIdb:true, hydrateLocalStorage:true });
        if(canonical && typeof canonical === "object"){
          return Object.assign({ nome:'', razao_social:'', nome_fantasia:'', cnpj:'', endereco:'', telefone:'', email:'', __logoA:'', __logoB:'', pix_chave:'' }, canonical);
        }
      }
    }catch(_){ }
    function asObject(v){
      if(!v) return null;
      if(typeof v === 'object') return v;
      if(typeof v === 'string'){
        try{
          const parsed = JSON.parse(v);
          if(parsed && typeof parsed === 'object') return parsed;
        }catch(_){ }
      }
      return null;
    }

    function scoreEmpresaCandidate(src){
      if(!src || typeof src !== 'object') return 0;
      let score = 0;
      if(resolveEmpresaNome(src)) score += 4;
      if(resolveEmpresaLogoA(src) || resolveEmpresaLogoB(src)) score += 3;
      if(src.cnpj || src.doc) score += 2;
      if(src.email) score += 1;
      if(src.telefone || src.celular || src.fone) score += 1;
      if(src.pix_chave || src.chave_pix || src.pix || src.pixKey) score += 1;
      return score;
    }

    function normalizeEmpresaRecord(src){
      const data = src && typeof src === 'object' ? src : {};
      return Object.assign({}, data, {
        nome: resolveEmpresaNome(data),
        razao_social: String(data.razao_social || data.nome || ''),
        nome_fantasia: String(data.nome_fantasia || data.fantasia || data.nome || ''),
        cnpj: data.cnpj || data.doc || '',
        endereco: data.endereco || data.endereco_completo || [data.logradouro, data.numero, data.bairro, data.cidade, data.uf].filter(Boolean).join(' • '),
        cidade: data.cidade || '',
        uf: data.uf || '',
        cep: data.cep || '',
        telefone: data.telefone || data.fone || data.celular || data.whatsapp || '',
        email: data.email || data.email_comercial || '',
        site: data.site || '',
        crmv: data.crmv || '',
        __logoA: resolveEmpresaLogoA(data),
        __logoB: resolveEmpresaLogoB(data),
        pix_tipo: data.pix_tipo || data.pixTipo || '',
        pix_nome: data.pix_nome || data.pixNome || data.favorecido_pix || '',
        pix_chave: data.pix_chave || data.chave_pix || data.pixKey || data.pix || data.pix_chave_copia_cola || '',
        pix_chave_norm: data.pix_chave_norm || ''
      });
    }

    const picks = [];
    const candidateStores = ["empresa_master","empresa","empresa_config","config_empresa","sys_meta"];
    for(const st of candidateStores){
      if(!hasStore(db, st)) continue;
      try{
        const rows = await idbGetAll(db, st);
        for(const row of (Array.isArray(rows) ? rows : [])){
          const rawCandidates = [row];
          for(const key of ['value','valor','data','payload','content','json','meta']){
            const parsed = asObject(row && row[key]);
            if(parsed) rawCandidates.push(parsed);
          }
          for(const raw of rawCandidates){
            const normalized = normalizeEmpresaRecord(raw);
            if(scoreEmpresaCandidate(normalized) > 0) picks.push(normalized);
          }
        }
      }catch(_){ }
    }

    if(hasStore(db,"config_params")){
      try{
        const rows = await idbGetAll(db,"config_params");
        function getKey(k){
          const r = (rows || []).find(x => String(x && (x.key || x.nome || x.name || x.id || '')) === k);
          return r ? String(r.value || r.valor || r.data || '') : '';
        }
        const keysToParse = [
          'vsc_empresa_v1','VSC_EMPRESA_V1','empresa','empresa_snapshot','empresa_dados','empresa_configurada_dados'
        ];
        for(const key of keysToParse){
          const parsed = asObject(getKey(key));
          if(parsed){
            const normalized = normalizeEmpresaRecord(parsed);
            if(scoreEmpresaCandidate(normalized) > 0) picks.push(normalized);
          }
        }
        const flat = normalizeEmpresaRecord({
          nome: getKey('empresa_nome') || getKey('razao_social') || getKey('nome_fantasia') || '',
          razao_social: getKey('razao_social') || '',
          nome_fantasia: getKey('nome_fantasia') || '',
          cnpj: getKey('empresa_cnpj') || getKey('cnpj') || '',
          endereco: getKey('empresa_endereco') || getKey('endereco') || '',
          telefone: getKey('empresa_telefone') || getKey('telefone') || '',
          email: getKey('empresa_email') || getKey('email') || '',
          __logoA: getKey('empresa_logo_a') || getKey('logo_a') || getKey('vsc_empresa_logo_a') || '',
          __logoB: getKey('empresa_logo_b') || getKey('logo_b') || getKey('vsc_empresa_logo_b') || '',
          pix_tipo: getKey('pix_tipo') || '',
          pix_nome: getKey('pix_nome') || '',
          pix_chave: getKey('pix_chave') || getKey('chave_pix') || getKey('pix') || ''
        });
        if(scoreEmpresaCandidate(flat) > 0) picks.push(flat);
      }catch(_){ }
    }

    try{
      const raw = localStorage.getItem("vsc_empresa_v1");
      const parsed = asObject(raw);
      if(parsed){
        const normalized = normalizeEmpresaRecord(parsed);
        if(scoreEmpresaCandidate(normalized) > 0) picks.push(normalized);
      }
    }catch(_){ }

    const best = picks.sort((a,b) => scoreEmpresaCandidate(b) - scoreEmpresaCandidate(a))[0] || {};
    return Object.assign({
      nome:'', razao_social:'', nome_fantasia:'', cnpj:'', endereco:'', telefone:'', email:'', __logoA:'', __logoB:'', pix_chave:''
    }, best, {
      __logoA: best.__logoA || (await getEmpresaLogoAFromLocalStorage()),
      __logoB: best.__logoB || (await getEmpresaLogoBFromLocalStorage()),
      pix_chave: best.pix_chave || (await getEmpresaPixFromLocalStorage())
    });
  }



  function getAttachmentPrintBaseUrls(){
    const isLocalHost = location.hostname === "127.0.0.1" || location.hostname === "localhost";
    const bases = [];
    if(isLocalHost){
      bases.push("https://app.vetsystemcontrol.com.br");
    } else {
      bases.push("");
    }
    return Array.from(new Set(bases.filter(Boolean).concat(isLocalHost ? [] : [""])));
  }

  async function blobToDataUrl(blob){
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ""));
      fr.onerror = () => reject(fr.error || new Error("blob_to_dataurl_failed"));
      fr.readAsDataURL(blob);
    });
  }

  function mergeAttachmentLists(primary, secondary){
    const out = [];
    const seen = new Set();
    const all = [Array.isArray(primary) ? primary : [], Array.isArray(secondary) ? secondary : []];
    for(const list of all){
      for(const item of list){
        if(!item) continue;
        const key = String(item.id || item.attachment_id || item.uuid || item.key || item.name || '').trim();
        if(key && seen.has(key)) continue;
        if(key) seen.add(key);
        out.push(Object.assign({}, item));
      }
    }
    return out;
  }

  async function hydrateAttachmentFromLocalStores(db, atendimentoId, att){
    const inline = normalizeInlineAttachmentData(att);
    if(inline) return inline;

    const attId = getAttachmentId(att);
    const attName = getAttachmentName(att);
    const currentList = Array.isArray(ATD.attachments) ? ATD.attachments : [];
    const byCurrent = currentList.find(x => x && getAttachmentId(x) === attId)
      || currentList.find(x => x && getAttachmentName(x) === attName);
    const currentInline = normalizeInlineAttachmentData(byCurrent);
    if(currentInline) return currentInline;

    if(att && typeof Blob !== 'undefined'){
      const blobLike = att.file_blob || att.blob || att.fileBlob || null;
      if(blobLike instanceof Blob){
        try{ return await blobToDataUrl(blobLike); }catch(_){ }
      }
    }

    if(db && hasStore(db, 'attachments_queue')){
      try{
        const rows = await idbGetAll(db, 'attachments_queue');
        const row = (rows || []).find(x => x && String(x.attachment_id || x.id || '') === attId)
          || (rows || []).find(x => x && String(x.filename || x.name || '') === attName);
        const rowInline = normalizeInlineAttachmentData(row);
        if(rowInline) return rowInline;
      }catch(_){ }
    }

    if(db && atendimentoId && hasStore(db, 'atendimentos_master')){
      try{
        const rec = await idbGet(db, 'atendimentos_master', atendimentoId);
        const rows = Array.isArray(rec && rec.attachments) ? rec.attachments : [];
        const row = rows.find(x => x && getAttachmentId(x) === attId)
          || rows.find(x => x && getAttachmentName(x) === attName);
        const rowInline = normalizeInlineAttachmentData(row);
        if(rowInline) return rowInline;
      }catch(_){ }
    }

    if(db && hasStore(db, 'documents_store')){
      try{
        const rows = await idbGetAll(db, 'documents_store');
        const match = (rows || []).find(x => x && String(x.entity_id || '') === String(atendimentoId) && String(x.entity_type || '').toLowerCase().includes('atendimento') && (
          String(x.id || '') === attId ||
          String(x.file_name || x.filename || '') === attName
        ));
        if(match){
          const docInline = normalizeInlineAttachmentData(match);
          if(docInline) return docInline;
          if(typeof Blob !== 'undefined'){
            const blobLike = match.file_blob || match.blob || null;
            if(blobLike instanceof Blob){
              try{ return await blobToDataUrl(blobLike); }catch(_){ }
            }
          }
        }
      }catch(_){ }
    }

    return '';
  }

  async function hydrateAttachmentsForPrint(db, atendimento){
    if(!atendimento || !Array.isArray(atendimento.attachments) || !atendimento.attachments.length) return atendimento;
    const tenant = localStorage.getItem("vsc_tenant") || localStorage.getItem("VSC_TENANT") || "tenant-default";
    const atendimentoId = atendimento.atendimento_id || atendimento.id || "";
    if(!atendimentoId) return atendimento;

    const bases = getAttachmentPrintBaseUrls();
    const hydrated = [];
    for(const src of atendimento.attachments){
      const att = src ? Object.assign({}, src) : src;
      if(!att){ hydrated.push(att); continue; }

      const localInline = await hydrateAttachmentFromLocalStores(db, atendimentoId, att);
      if(localInline){
        att.dataUrl = localInline;
        hydrated.push(att);
        continue;
      }

      const possibleUrls = [
        att.url,
        att.download_url,
        att.downloadUrl,
        att.r2_url,
        att.file_url,
        att.src,
        att.preview_url,
        att.public_url
      ].filter(Boolean);

      let done = false;

      for(const rawUrl of possibleUrls){
        try{
          const url = String(rawUrl);
          if((location.hostname === '127.0.0.1' || location.hostname === 'localhost') && /^\/api\/attachments/i.test(url)) continue;
          const res = await fetch(url, { credentials:"include" });
          if(!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          att.dataUrl = await blobToDataUrl(blob);
          att.mime = att.mime || blob.type || "";
          done = true;
          break;
        }catch(_err){}
      }

      const attId = getAttachmentId(att);
      if(!done && attId){
        const candidates = [];
        for(const currentBase of bases){
          candidates.push(`${currentBase}/api/attachments?action=download&disposition=inline&atendimento_id=${encodeURIComponent(atendimentoId)}&attachment_id=${encodeURIComponent(attId)}`);
        }
        for(const url of candidates){
          try{
            const currentBase = url.startsWith('https://') ? new URL(url).origin : '';
            const res = await fetch(url, {
              headers: getAttachmentAuthHeaders(),
              credentials: currentBase ? "omit" : "include"
            });
            if(!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();
            att.dataUrl = await blobToDataUrl(blob);
            att.mime = att.mime || blob.type || "";
            done = true;
            break;
          }catch(_err){}
        }

        if(!done){
          for(const currentBase of bases){
            try{
              const listUrl = `${currentBase}/api/attachments?action=list&atendimento_id=${encodeURIComponent(atendimentoId)}`;
              const listRes = await fetch(listUrl, {
                headers: getAttachmentAuthHeaders(),
                credentials: currentBase ? "omit" : "include"
              });
              if(!listRes.ok) continue;
              const listBody = await listRes.json().catch(() => ({}));
              const items = Array.isArray(listBody && listBody.items) ? listBody.items : [];
              const matched = items.find(item => String(item && item.meta && item.meta.attachment_id || '').trim() === attId)
                || items.find(item => String(item && item.meta && item.meta.filename || '').trim() === getAttachmentName(att));
              if(!matched) continue;
              const dl = `${currentBase}/api/attachments?action=download&disposition=inline&atendimento_id=${encodeURIComponent(atendimentoId)}&attachment_id=${encodeURIComponent(attId)}`;
              const res = await fetch(dl, {
                headers: getAttachmentAuthHeaders(),
                credentials: currentBase ? "omit" : "include"
              });
              if(!res.ok) continue;
              const blob = await res.blob();
              att.dataUrl = await blobToDataUrl(blob);
              att.mime = att.mime || blob.type || "";
              done = true;
              break;
            }catch(_listErr){}
          }
        }
      }

      if(!done){
        console.warn("[PRINT][ATTACH] anexo não hidratado para impressão:", getAttachmentName(att) || getAttachmentId(att) || att);
      }
      hydrated.push(att);
    }

    atendimento.attachments = hydrated;
    return atendimento;
  }


  async function flushRemoteAttachmentStateForPrint(atendimentoId){
    const syncTasks = [];
    try{
      if(window.VSC_RELAY && typeof window.VSC_RELAY.syncNow === "function"){
        syncTasks.push(window.VSC_RELAY.syncNow({ reason:"print_prepare", atendimentoId: String(atendimentoId || "") }));
      }
    }catch(_){ }
    try{
      if(window.VSC_ATTACHMENTS_RELAY && typeof window.VSC_ATTACHMENTS_RELAY.syncNow === "function"){
        syncTasks.push(window.VSC_ATTACHMENTS_RELAY.syncNow());
      }
    }catch(_){ }
    if(!syncTasks.length) return;
    try{
      await Promise.allSettled(syncTasks);
    }catch(_){ }
  }

  async function buildPrintData(db){
    // garantir persistência
    await salvar(db, false);
    await flushRemoteAttachmentStateForPrint(ATD.atendimento_id);
    const rec = await idbGet(db,"atendimentos_master", ATD.atendimento_id);
    if(!rec) throw new Error("Atendimento não encontrado para impressão.");

    const empresa = await loadEmpresaSnapshot(db);

    const cliente = (rec.cliente_id && hasStore(db,"clientes_master"))
      ? await idbGet(db,"clientes_master", rec.cliente_id)
      : null;

    const animais = (hasStore(db,"animais_master") && Array.isArray(rec.animal_ids))
      ? (await Promise.all(rec.animal_ids.map(id => idbGet(db,"animais_master", id)))).filter(Boolean)
      : [];

    const atendimentoPrint = await hydrateAttachmentsForPrint(db, Object.assign({}, rec, {
      attachments: mergeAttachmentLists(
        Array.isArray(ATD.attachments) ? ATD.attachments : [],
        Array.isArray(rec.attachments) ? rec.attachments : []
      )
    }));

    return { empresa, cliente, animais, atendimento: atendimentoPrint, gerado_em: isoNow() };
  }

// SGQT-PRINT-3.0 (Premium Enterprise) — melhor prática: gerar PDF server-side (Chromium headless)
// e mesclar anexos como páginas reais. Mantém fallback client-side para modo offline.
// SGQT-PRINT-FRONT-2.0 — Auth headers (enterprise):
// O backend exige token. Sem isso, cai no fallback client-side (about:blank).
function getAttachmentAuthHeaders(extraHeaders){
  const headers = Object.assign({}, extraHeaders || {});
  try{
    const tenant = (window.localStorage && (localStorage.getItem('vsc_tenant') || localStorage.getItem('VSC_TENANT'))) || 'tenant-default';
    headers["X-VSC-Tenant"] = String(tenant || 'tenant-default');
    const token = String(
      (window.localStorage && (localStorage.getItem('vsc_local_token') || localStorage.getItem('vsc_token'))) ||
      (window.sessionStorage && (sessionStorage.getItem('vsc_local_token') || sessionStorage.getItem('vsc_token'))) ||
      ''
    ).trim();
    const sessionId = String(
      (window.localStorage && localStorage.getItem('vsc_session_id')) ||
      (window.sessionStorage && sessionStorage.getItem('vsc_session_id')) ||
      ''
    ).trim();
    if(token){
      headers["X-VSC-Token"] = token;
      headers["Authorization"] = `Bearer ${token}`;
    }
    if(sessionId) headers["X-VSC-Client-Session"] = sessionId;
    return headers;
  }catch(_){
    return Object.assign({ "X-VSC-Tenant": "tenant-default" }, extraHeaders || {});
  }
}

function getPrintAuthHeaders(){
  return getAttachmentAuthHeaders({ "Content-Type": "application/json" });
}

function getEmpresaSnapshotForPrint(){
  // Fonte canônica: módulo Empresa salva em localStorage (LS_KEY = "vsc_empresa_v1")
  try{
    var raw = localStorage.getItem("vsc_empresa_v1");
    if(!raw) return {};
    var obj = JSON.parse(raw);
    return (obj && typeof obj === "object") ? obj : {};
  }catch(e){
    return {};
  }
}


async function getEmpresaPixFromLocalStorage(){
  try{
    const j = localStorage.getItem("vsc_empresa_v1") || localStorage.getItem("VSC_EMPRESA_V1") || "";
    if(j){
      const o = JSON.parse(j);
      const k = o.pix_chave || o.pixKey || o.pix || o.chave_pix || o.chavePix || o.pix_chave_copia_cola || "";
      if(k) return String(k);
    }
    const direct = localStorage.getItem("vsc_pix_chave") || localStorage.getItem("VSC_PIX_CHAVE") || "";
    if(direct) return String(direct);
    return "";
  }catch(_){
    return "";
  }
}



function ensurePrintPreviewModal(){
  let m = document.getElementById("vscPrintPreviewModal");
  if(m && m.__api) return m.__api;

  // Modal shell (injetado para não depender de HTML pré-existente)
  m = document.createElement("div");
  m.id = "vscPrintPreviewModal";
  m.style.position = "fixed";
  m.style.left = "0";
  m.style.top = "0";
  m.style.right = "0";
  m.style.bottom = "0";
  m.style.zIndex = "99999";
  m.style.background = "rgba(0,0,0,0.55)";
  m.style.display = "flex";
  m.style.alignItems = "center";
  m.style.justifyContent = "center";

  m.innerHTML = `
    <div style="width:min(980px, 96vw); height:min(92vh, 920px); background:#fff; border-radius:12px; overflow:hidden; box-shadow:0 12px 40px rgba(0,0,0,0.35); display:flex; flex-direction:column;">
      <div style="padding:10px 12px; border-bottom:1px solid #eee; display:flex; gap:10px; align-items:center;">
        <div style="font-weight:700;">Impressão premium</div>
        <div id="vscPPStatus" style="font-size:12px; color:#555; flex:1;">—</div>
        <button id="vscPPPrint" class="btn" style="padding:6px 10px;">Imprimir</button>
        <button id="vscPPDownload" class="btn" style="padding:6px 10px;">Baixar</button>
        <button id="vscPPClose" class="btn" style="padding:6px 10px;">Fechar</button>
      </div>
      <div id="vscPPBody" style="flex:1; background:#f6f6f6; display:flex; align-items:center; justify-content:center;">
        <div id="vscPPLoader" style="padding:16px; font-size:14px; color:#333;">Gerando…</div>
        <iframe id="vscPPFrame" title="Print Preview" style="display:none; width:100%; height:100%; border:0; background:#fff;"></iframe>
      </div>
      <div id="vscPPError" style="display:none; padding:10px 12px; border-top:1px solid #eee; color:#b00020; font-size:13px;"></div>
    </div>
  `;
  document.body.appendChild(m);

  const frame = m.querySelector("#vscPPFrame");
  const statusEl = m.querySelector("#vscPPStatus");
  const loaderEl = m.querySelector("#vscPPLoader");
  const errEl = m.querySelector("#vscPPError");
  const btnClose = m.querySelector("#vscPPClose");
  const btnPrint = m.querySelector("#vscPPPrint");
  const btnDl = m.querySelector("#vscPPDownload");

  let currentUrl = "";
  let currentName = "print-preview.html";
  let currentMode = "html";

  function open(){ m.style.display = "flex"; }
  function close(){
    m.style.display = "none";
    // revoga URL anterior para não vazar memória
    try{ if(currentUrl) URL.revokeObjectURL(currentUrl); }catch(_){}
    currentUrl = "";
    frame.src = "about:blank";
    frame.style.display = "none";
    loaderEl.style.display = "block";
    errEl.style.display = "none";
  }

  btnClose.addEventListener("click", (e)=>{ e.preventDefault(); close(); });
  m.addEventListener("click", (e)=>{ if(e.target === m) close(); });

  btnPrint.addEventListener("click", async (e)=>{
    e.preventDefault();
    if(!frame || !frame.contentWindow){
      snack("Pré-visualização ainda não está pronta.", "warn");
      return;
    }
    try{
      statusEl.textContent = "Preparando impressão…";
      const w = frame.contentWindow;
      if(w.__VSC_PRINT_READY__ && typeof w.__VSC_PRINT_READY__.then === "function"){
        await w.__VSC_PRINT_READY__;
      }
      if(typeof w.__VSC_DO_PRINT__ === "function"){
        await w.__VSC_DO_PRINT__();
      }else{
        w.focus();
        w.print();
      }
      statusEl.textContent = currentMode === "html" ? "Pré-visualização local pronta." : "PDF pronto.";
    }catch(err){
      console.error("[SGQT-PRINT][BTN] falha ao imprimir preview:", err);
      snack("Falha ao abrir diálogo de impressão.", "err");
    }
  });

  btnDl.addEventListener("click", async (e)=>{
    e.preventDefault();
    if(!currentUrl){
      snack("Arquivo ainda não está pronto.", "warn");
      return;
    }
    if(currentMode === "html"){
      snack("Use Imprimir e escolha 'Salvar como PDF' no navegador.", "warn");
      return;
    }
    const a = document.createElement("a");
    a.href = currentUrl;
    a.download = currentName || "print-pack.pdf";
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  const api = {
    setState(kind, msg){
      open();
      statusEl.textContent = msg || "—";
      if(kind === "loading"){
        loaderEl.style.display = "block";
        frame.style.display = "none";
        errEl.style.display = "none";
      }else if(kind === "ready"){
        loaderEl.style.display = "none";
        errEl.style.display = "none";
      }else if(kind === "error"){
        loaderEl.style.display = "none";
        frame.style.display = "none";
        errEl.style.display = "block";
        errEl.textContent = msg || "Erro ao gerar impressão.";
      }
    },
    setPdf(url, filename){
      try{ if(currentUrl) URL.revokeObjectURL(currentUrl); }catch(_){}
      currentUrl = url;
      currentName = filename || "print-pack.pdf";
      currentMode = "pdf";
      frame.src = url;
      frame.style.display = "block";
      loaderEl.style.display = "none";
      errEl.style.display = "none";
    },
    setHtml(html, filename){
      try{ if(currentUrl) URL.revokeObjectURL(currentUrl); }catch(_){}
      currentMode = "html";
      currentName = filename || "print-preview.html";
      const blob = new Blob([String(html || "")], { type: "text/html;charset=utf-8" });
      currentUrl = URL.createObjectURL(blob);
      frame.src = currentUrl;
      frame.style.display = "block";
      loaderEl.style.display = "none";
      errEl.style.display = "none";
    }
  };

  m.__api = api;
  open();
  return api;
}

async function openPrintWindow(payload, docType){
  const doc = payload || {};
  let html = openPrintWindowClient(payload, docType, { returnHtml: true });
  try{
    if(html && typeof html.then === "function") html = await html;
  }catch(e){
    console.error("[SGQT-PRINT][HTML] falha ao resolver html Promise:", e);
  }
  if(typeof html !== "string") html = (html==null ? "" : String(html));
  if(!html || !html.trim()){
    const ui = ensurePrintPreviewModal();
    ui.setState("error", "HTML da impressão está vazio.");
    throw new Error("PRINT_PACK_MISSING_HTML_LOCAL");
  }
  const ui = ensurePrintPreviewModal();
  ui.setState("loading", "Gerando pré-visualização local...");
  ui.setHtml(html, `relatorio-${String((doc.atendimento && (doc.atendimento.numero || doc.atendimento.id || doc.atendimento.atendimento_id)) || 'atendimento')}.html`);
  ui.setState("ready", "Pré-visualização local pronta.");
}

// Fallback (modo offline / compatibilidade legada): impressão client-side (PDF.js + window.print())
function openPrintWindowClient(payload, docType, opts){
  opts = opts || {};

  const R = payload || {};
  const empresa = R.empresa || {};
  const logoA = resolveEmpresaLogoA(empresa) || "";
  const logoB = resolveEmpresaLogoB(empresa) || "";
  const companyPrintLogo = resolvePreferredCompanyPrintLogo(empresa) || "";
  const empresaNome = resolveEmpresaNome(empresa) || "Empresa";
  const pixKey = empresa.pix_chave || empresa.chave_pix || empresa.pixKey || empresa.pix || empresa.pix_chave_copia_cola || "";
  const atd = R.atendimento || {};
  const cli = R.cliente || {};
  const animais = Array.isArray(R.animais) ? R.animais : [];

  docType = String(docType || "clinico");
  const DOC_LABEL = (docType === "financeiro") ? "Comprovante Financeiro" : (docType === "prescricao") ? "Prescrição" : (docType === "clinico_financeiro") ? "Relatório Clínico + Financeiro" : "Relatório Clínico / Prontuário";
  const DOC_SPEC = "SGQT-PRINT-1.0";

  const SYSTEM_LOGO_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-label="Vet System Control">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#16a34a"/>
      <stop offset="1" stop-color="#0ea5e9"/>
    </linearGradient>
  </defs>
  <rect x="6" y="6" width="52" height="52" rx="12" fill="url(#g)"/>
  <path d="M18 39c7-10 16-16 28-17-3 4-7 7-11 8 3 1 5 3 6 6-6-3-13-3-19-1-1 2-3 4-4 4z" fill="#fff" opacity=".95"/>
  <path d="M24 46c7-5 16-7 26-6" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".9"/>
</svg>`;

  const empLine = [empresa.cnpj, empresa.endereco, [empresa.telefone, empresa.email].filter(Boolean).join(" • ")].filter(Boolean).join("<br/>");
  const animaisTxt = animais.length ? animais.map(a=>a.nome||a.id).filter(Boolean).join(", ") : (Array.isArray(atd._animal_names)?atd._animal_names.join(", "):"—");
  const itens = Array.isArray(atd.itens) ? atd.itens : [];
  const totals = atd.totals || {};
  const atts = Array.isArray(atd.attachments) ? atd.attachments : [];

  const vitalsByAnimal = atd.vitals_by_animal || {};
  function vitalsLine(v){
    if(!v) return "—";
    const parts = [];
    if(v.temp) parts.push(`T° ${v.temp}°C`);
    if(v.fc) parts.push(`FC ${v.fc}`);
    if(v.fr) parts.push(`FR ${v.fr}`);
    if(v.peso) parts.push(`${v.peso}kg`);
    if(v.mm) parts.push(`MM ${v.mm}`);
    if(v.trc) parts.push(`TRC ${v.trc}s`);
    if(v.hid) parts.push(`Hid ${v.hid}`);
    if(v.dor) parts.push(`Dor ${v.dor}`);
    return parts.length ? parts.join(" · ") : "—";
  }

  const vet = atd.responsavel_snapshot || {};
  const vetLine = [
    vet.full_name || vet.username || "",
    (vet.crmv_uf && vet.crmv_num) ? ("CRMV-"+vet.crmv_uf+" Nº "+vet.crmv_num) : ""
  ].filter(Boolean).join(" — ");

  const institutionalCss = (window.VSCPrintTemplate && typeof window.VSCPrintTemplate.getInstitutionalCss === "function")
    ? window.VSCPrintTemplate.getInstitutionalCss()
    : ``;

  const css = `
${institutionalCss}
:root{--text:#0f172a;--muted:#64748b;--bd:#d8e1ec;--soft:#f8fbfd;--brand:#0f766e;--brand2:#0ea5e9;}
body{font-family:'DM Sans',system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:var(--text);margin:0;background:#fff;}
.page{width:190mm;max-width:190mm;margin:0 auto;padding:8mm 8mm 12mm;box-sizing:border-box;}
.sheet{position:relative;}
.sheet + .sheet{margin-top:14px;}
.sheet--attachments{padding-top:4px;}
.small{font-size:11px;color:var(--muted);line-height:1.45;}
.box{border:1px solid var(--bd);border-radius:14px;padding:12px 14px;margin:10px 0;background:#fff;}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.lbl{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;font-weight:800;}
.val{font-size:13px;font-weight:800;margin-top:3px;}
.pre{white-space:pre-wrap;font-weight:600;line-height:1.55;}
.table-tight{margin-top:8px;}
table{width:100%;border-collapse:collapse;margin-top:8px;border-top:1px solid var(--bd);}
th,td{border-bottom:1px solid var(--bd);padding:8px 10px;font-size:12.5px;vertical-align:top;}
th{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;text-align:left;}
.right{text-align:right;}
.tot{display:flex;justify-content:flex-end;margin-top:10px;}
.tot .box{min-width:320px;}
.section-title{margin-top:18px;font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:.12em;color:#0f766e;}
img{max-width:100%;height:auto;display:block;margin:10px auto;border:1px solid var(--bd);border-radius:10px;}
.pdf-loading{font-size:12px;color:var(--muted);padding:10px 0;}
.muted{color:var(--muted);}
.att{margin:12px 0;padding:12px 14px;border:1px solid var(--bd);border-radius:12px;}
.att--pdf{padding-bottom:10px;}
.att-head{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;margin-bottom:8px;}
.att-title{font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:.06em;color:#334155;}
.att-kind{font-size:11px;color:var(--muted);font-weight:800;white-space:nowrap;}
.att-desc-wrap{margin-top:10px;padding-top:10px;border-top:1px dashed #cbd5e1;}
.att-desc-label{font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.09em;font-weight:800;margin-bottom:5px;}
.att-desc{font-size:12px;color:#0f172a;white-space:pre-wrap;line-height:1.45;}
.att-nodata{font-size:12px;color:#92400e;background:#fff7ed;padding:8px 10px;border-radius:8px;margin-top:6px;border:1px solid #fed7aa;}
.wmLocal{position:absolute; inset:0; display:flex; align-items:center; justify-content:center; pointer-events:none; user-select:none; z-index:0;}
.wmLocal img{width:62%;max-width:560px;border:none !important;border-radius:0 !important;margin:0 !important;opacity:.06;filter:grayscale(1);object-fit:contain;}
.sheetContent{position:relative; z-index:1;}
.footer{display:none;}
@media print{
  @page{ size:A4; margin:10mm 10mm 22mm 10mm; }
  .no-print{display:none !important;}
  body{margin:0;}
  .page{max-width:none;padding:0;}
  .box,.att-media,tr,canvas{break-inside:avoid;page-break-inside:avoid;}
  .sheet{padding:0;}
  .sheet + .sheet{break-before:page;page-break-before:always;margin-top:0;}
  .att{break-inside:auto;page-break-inside:auto;}
  .att--image,.att--missing,.att-head,.att-desc-wrap{break-inside:avoid;page-break-inside:avoid;}
  .pdf-block,.pdf-pages{break-inside:auto;page-break-inside:auto;}
  .pdf-page{display:flex;justify-content:center;margin:0 0 8mm;break-inside:avoid;page-break-inside:avoid;}
  .pdf-page:last-child{margin-bottom:0;}
  .pdf-page img{display:block;margin:0 auto;border:1px solid var(--bd);border-radius:8px;max-width:100%;width:auto;height:auto;max-height:220mm;}
  .att-inline-image{max-width:100%;width:auto;height:auto;max-height:220mm;margin:0 auto;}
  .footer{display:block;position:fixed;left:0;right:0;bottom:0;border-top:1px solid var(--bd);padding:2.5mm 10mm;font-size:9px;color:var(--muted);background:#fff;}
  .footer .row{display:flex;justify-content:space-between;gap:10px;align-items:center;}
}
  `;


  const rowsFinanceiro = itens.length ? itens.map(it=>{
    const sub = (Number(it.qtd||0)*Number(it.vu||0));
    return `<tr>
      <td>${esc(it.tipo||"")}</td>
      <td>${esc(it.desc||"")}</td>
      <td class="right">${esc(String(it.qtd||0))}</td>
      <td class="right">${esc(fmtBRL(it.vu||0))}</td>
      <td class="right">${esc(fmtBRL(sub))}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="5" class="muted">Nenhum item lançado.</td></tr>`;

  const rowsClinico = itens.length ? itens.map(it=>{
    return `<tr>
      <td>${esc(it.tipo||"")}</td>
      <td>${esc(it.desc||"")}</td>
      <td class="right">${esc(String(it.qtd||0))}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="3" class="muted">Nenhum item registrado.</td></tr>`;

  const prescProdutos = itens.filter(it => String(it.tipo||"") === "PRODUTO");
  const prescRowsSrc = prescProdutos.length ? prescProdutos : [{desc:"",qtd:""},{desc:"",qtd:""},{desc:"",qtd:""}];
  const rowsPrescricao = prescRowsSrc.map(it=>{
    return `<tr>
      <td>${esc(it.desc||"")}</td>
      <td class="right">${esc(String(it.qtd||""))}</td>
      <td></td><td></td><td></td>
    </tr>`;
  }).join("");

  const attHtml = ((docType === "clinico") || (docType === "clinico_financeiro")) ? (
    atts.length ? atts.map((a, idx)=>{
      const mime = String(getAttachmentMime(a) || "").toLowerCase();
      const attNameRaw = getAttachmentName(a, "Anexo " + (idx+1));
      const isPdf = mime === "application/pdf" || /\.pdf$/i.test(String(attNameRaw||""));
      const name = esc(attNameRaw);
      const hasData = !!normalizeInlineAttachmentData(a);
      const sizeNum = getAttachmentSize(a);
      const sizeKb = sizeNum ? Math.round(sizeNum/1024) + " KB" : "";
      const desc = esc(a.descricao || a.description || a.desc || "—");
      if(!hasData){
        return `
          <section class="att att--missing">
            <div class="att-head">
              <div class="att-title">${name}</div>
              <div class="att-kind">${isPdf ? "PDF" : "Imagem"}${sizeKb ? ` • ${sizeKb}` : ""}</div>
            </div>
            <div class="att-nodata">⚠ O arquivo não pôde ser carregado para a impressão.</div>
            <div class="att-desc-wrap">
              <div class="att-desc-label">Descrição clínica do anexo</div>
              <div class="att-desc">${desc}</div>
            </div>
          </section>
        `;
      }
      if(isPdf){
        return `
          <section class="att att--pdf">
            <div class="att-head">
              <div class="att-title">${name}</div>
              <div class="att-kind">PDF${sizeKb ? ` • ${sizeKb}` : ""}</div>
            </div>
            <div class="att-desc-wrap">
              <div class="att-desc-label">Descrição clínica do anexo</div>
              <div class="att-desc">${desc}</div>
            </div>
            <div class="pdf-block att-media" data-idx="${idx}">
              <div class="pdf-loading">Renderizando PDF para impressão…</div>
              <div class="pdf-pages" data-name="${name}" data-dataurl="${normalizeInlineAttachmentData(a)}"></div>
            </div>
          </section>
        `;
      }
      return `
        <section class="att att--image">
          <div class="att-head">
            <div class="att-title">${name}</div>
            <div class="att-kind">Imagem${sizeKb ? ` • ${sizeKb}` : ""}</div>
          </div>
          <div class="att-media">
            <img class="att-inline-image" data-anexo="1" src="${normalizeInlineAttachmentData(a)}" alt="${name}" style="max-width:100%;display:block;margin:0 auto;border:1px solid #e2e8f0;border-radius:8px;" />
          </div>
          <div class="att-desc-wrap">
            <div class="att-desc-label">Descrição clínica do anexo</div>
            <div class="att-desc">${desc}</div>
          </div>
        </section>
      `;
    }).join("")
    : `<div class="small muted">Nenhum anexo clínico registrado.</div>`
  ) : "";

  const vitalsHtml = (animais.length ? animais : (Array.isArray(atd.animal_ids) ? atd.animal_ids.map(id=>({id, nome:id})) : [])).map(a=>{
    const id = String(a.id || "");
    const nm = String(a.nome || id || "Paciente");
    const v = vitalsByAnimal[id] || null;
    return `<div class="box" style="margin:8px 0;">
      <div class="lbl">Sinais vitais — ${esc(nm)}</div>
      <div class="val" style="font-weight:700;">${esc(vitalsLine(v))}</div>
    </div>`;
  }).join("");

  const headerHtml = (window.VSCPrintTemplate && typeof window.VSCPrintTemplate.renderInstitutionalHeader === "function")
    ? window.VSCPrintTemplate.renderInstitutionalHeader({
        systemLogoSrc: location.origin + '/assets/brand/vsc-logo-horizontal.png',
        systemLogoFallback: '<div class="kado-fallback-system">Vet System Control</div>',
        companyLogoHtml: companyPrintLogo
          ? `<img class="kado-company-logo" src="${companyPrintLogo}" alt="Logo institucional da empresa"/>`
          : `<div class="kado-company-logo-fallback"></div>`,
        companyName: esc(empresaNome),
        companyMetaHtml: [
          empresa.cnpj ? `<div>CNPJ: ${esc(empresa.cnpj)}</div>` : "",
          empresa.email ? `<div>${esc(empresa.email)}</div>` : "",
          pixKey ? `<div>PIX: ${esc([empresa.pix_tipo || empresa.pixTipo || '', pixKey, empresa.pix_nome || empresa.pixNome || empresa.favorecido_pix || ''].filter(Boolean).join(' • '))}</div>` : ""
        ].filter(Boolean).join(""),
        documentTitle: esc(DOC_LABEL),
        documentMetaHtml: [
          `<div><b>Nº:</b> ${esc(atd.numero||"—")}</div>`,
          `<div><b>Status:</b> ${esc(atd.status||"—")}</div>`,
          `<div><b>Data de emissão:</b> ${esc(fmtDate(R.gerado_em))}</div>`,
          `<div><b>Paciente(s):</b> ${esc(animaisTxt||"—")}</div>`
        ].join("")
      })
    : '';

  const bodyClinicoMain = (window.VSCPrintTemplate && typeof window.VSCPrintTemplate.renderClinicalInstitutionalCover === "function")
    ? window.VSCPrintTemplate.renderClinicalInstitutionalCover({
        spec: esc(DOC_SPEC),
        originLine1: 'Vet System Control • ERP Equine',
        originLine2: 'Documento operacional para atendimento, balcão e auditoria clínica.',
        clientLabel: 'Cliente / Proprietário',
        clientValue: esc(cli.nome||cli.razao_social||atd.cliente_label||"—"),
        patientLabel: 'Paciente(s)',
        patientValue: esc(animaisTxt||"—"),
        vetLabel: 'Veterinário / Responsável',
        vetValue: esc(vetLine||"—"),
        attachmentsLabel: 'Anexos clínicos',
        attachmentsValue: esc(String(atts.length || 0)),
        dateLabel: 'Data',
        dateValue: esc(fmtDate(atd.created_at))
      }) + `

    <div class="section-title">Sinais vitais</div>
    ${vitalsHtml || `<div class="small muted">Nenhum sinal vital registrado.</div>`}

    <div class="section-title">Anamnese / Queixa / Observações</div>
    <div class="box"><div class="pre">${esc(atd.observacoes || "—")}</div></div>

    <div class="section-title">Diagnóstico</div>
    <div class="box"><div class="pre">${esc(atd.cli_diagnostico || "—")}</div></div>

    <div class="section-title">Conduta / Evolução</div>
    <div class="box"><div class="pre">${esc(atd.cli_evolucao || "—")}</div></div>

    <div class="section-title">Procedimentos / Materiais / Itens utilizados (sem valores)</div>
    <table class="table-tight">
      <thead><tr>
        <th style="width:110px;">Tipo</th><th>Descrição</th>
        <th style="width:70px;" class="right">Qtd</th>
      </tr></thead>
      <tbody>${rowsClinico}</tbody>
    </table>
  `
    : ``;


  const bodyClinicoAttachments = `
    <div class="section-title">Anexos</div>
    <div class="attachments">${attHtml || `<div class="small muted">Nenhum anexo.</div>`}</div>
  `;


  const pixBox = pixKey ? `
    <div class="section-title">Pagamento via PIX</div>
    <div class="box">
      <div class="grid" style="grid-template-columns:1fr 180px; align-items:start;">
        <div>
          <div class="lbl">Chave PIX (copia e cola)</div>
          <div class="val" style="word-break:break-all;">${esc(pixKey)}</div>
          <div class="small muted">Aponte a câmera do app do banco para o QR ao lado ou copie a chave acima.</div>
        </div>
        <div>
          <div class="lbl" style="text-align:center;">QR PIX</div>
          <div id="pixQr" data-pix="${esc(pixKey)}" style="display:flex;justify-content:center;"></div>
        </div>
      </div>
    </div>
  ` : ``;

  const bodyFinanceiro = `
    <div class="section-title">Lançamentos</div>
    <table>
      <thead><tr>
        <th style="width:110px;">Tipo</th><th>Descrição</th>
        <th style="width:70px;" class="right">Qtd</th>
        <th style="width:110px;" class="right">V. Unit.</th>
        <th style="width:120px;" class="right">Subtotal</th>
      </tr></thead>
      <tbody>${rowsFinanceiro}</tbody>
    </table>

    <div class="tot">
      <div class="box">
        <div class="grid">
          <div><div class="lbl">Itens</div><div class="val">${esc(fmtBRL(totals.total_itens||0))}</div></div>
          <div><div class="lbl">Desconto</div><div class="val">${esc(fmtBRL(totals.desconto_calc||0))}</div></div>
          <div><div class="lbl">Deslocamento</div><div class="val">${esc(fmtBRL(totals.deslocamento||0))}</div></div>
          <div><div class="lbl">Total Geral</div><div class="val">${esc(fmtBRL(totals.total_geral||0))}</div></div>
        </div>
      </div>
    </div>

    <div class="section-title">Observações</div>
    <div class="box"><div class="pre">${esc(atd.observacoes || "—")}</div></div>
    <div class="small muted">Documento auxiliar. Se necessário, emita NF/recibo fiscal conforme o regime tributário aplicável.</div>
  `;

  const bodyPrescricao = `
    <div class="box">
      <div class="grid">
        <div>
          <div class="lbl">Cliente / Proprietário</div>
          <div class="val">${esc(cli.nome||cli.razao_social||atd.cliente_label||"—")}</div>
          <div class="small">${esc([cli.doc||cli.cnpj||cli.cpf||"", cli.telefone||cli.fone||""].filter(Boolean).join(" • "))}</div>
        </div>
        <div>
          <div class="lbl">Paciente(s)</div>
          <div class="val">${esc(animaisTxt||"—")}</div>
          <div class="small"><strong>Data:</strong> ${esc(fmtDate(atd.created_at))}</div>
          <div class="small"><strong>Veterinário:</strong> ${esc(vetLine||"—")}</div>
        </div>
      </div>
    </div>

    <div class="section-title">Prescrição</div>
    <table>
      <thead><tr>
        <th>Medicamento / Item</th>
        <th style="width:70px;" class="right">Qtd</th>
        <th style="width:110px;">Dose</th>
        <th style="width:110px;">Via</th>
        <th style="width:170px;">Frequência / Duração</th>
      </tr></thead>
      <tbody>${rowsPrescricao}</tbody>
    </table>
    <div class="section-title">Orientações</div>
    <div class="box"><div class="pre">${esc(atd.observacoes || "—")}</div></div>
    <div class="small muted">Complete posologia conforme avaliação clínica. Para antimicrobianos e itens controlados, seguir exigências vigentes.</div>
  `;


  const bodyClinicoFinanceiro = bodyClinicoMain + `\n\n<div class="page-break"></div>\n\n` + bodyFinanceiro;
  const html = `<!doctype html><html lang="pt-BR"><head>
    <meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
    <title>Impressão — ${esc(DOC_LABEL)}</title>
    <style>${css}</style>
    <script src="${PDFJS_CDN_BASE}/pdf.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"></script>
  </head><body>
    <div class="page">
      <div class="no-print" style="padding:10px 0 16px;color:var(--muted);font-size:12px;">
        Padrão hospitalar: documentos separados. O diálogo de impressão abrirá automaticamente.
      </div>

      <div class="sheet sheet--main">
        ${(docType === "clinico" && companyPrintLogo) ? `<div class="wmLocal"><img src="${companyPrintLogo}" alt="Marca d'água"/></div>` : ``}
        <div class="sheetContent">
          ${headerHtml}

          ${(docType === "financeiro") ? bodyFinanceiro : (docType === "prescricao") ? bodyPrescricao : (docType === "clinico_financeiro") ? bodyClinicoFinanceiro : bodyClinicoMain}
        </div>
      </div>

      ${(((docType === "clinico") || (docType === "clinico_financeiro")) && atts.length) ? `
        <div class="sheet sheet--attachments">
          <div class="sheetContent">
            ${bodyClinicoAttachments}
          </div>
        </div>
      ` : ``}
    </div>

    <div class="footer">
      <div class="row">
        <div>
          <div><b>${esc(DOC_SPEC)}</b> • ${esc(DOC_LABEL)} • Emitido em ${esc(new Date(R.gerado_em||Date.now()).toLocaleString("pt-BR"))}</div>
          <div>Hash: <span id="docHash">calculando…</span></div>
        </div>
        <div class="pnum"></div>
      </div>
    </div>

    <script>
      (function(){
        function dataUrlToUint8(dataUrl){
          var s = String(dataUrl||"");
          var i = s.indexOf("base64,");
          if(i<0) return null;
          var b64 = s.slice(i+7);
          var bin = atob(b64);
          var u8 = new Uint8Array(bin.length);
          for(var k=0;k<bin.length;k++) u8[k]=bin.charCodeAt(k);
          return u8;
        }

        async function renderOnePdf(container){
          var dataUrl = container.getAttribute('data-dataurl');
          if(!dataUrl) return;
          if(window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions){
            window.pdfjsLib.GlobalWorkerOptions.workerSrc = "${PDFJS_CDN_BASE}/pdf.worker.min.js";
          }
          var bytes = dataUrlToUint8(dataUrl);
          if(!bytes){ container.innerHTML = '<div class="small muted">Não foi possível ler o PDF (base64 inválido).</div>'; return; }
          var loadingTask = window.pdfjsLib.getDocument({ data: bytes });
          var pdf = await loadingTask.promise;
          var frag = document.createDocumentFragment();
          for(var p=1; p<=pdf.numPages; p++){
            var page = await pdf.getPage(p);
            var viewport = page.getViewport({ scale: 1.6 });
            var canvas = document.createElement('canvas');
            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);
            var ctx = canvas.getContext('2d', { alpha: false });
            await page.render({ canvasContext: ctx, viewport: viewport }).promise;
            var wrapper = document.createElement('div');
            wrapper.className = 'pdf-page';
            var img = document.createElement('img');
            img.alt = 'PDF página ' + p;
            img.src = canvas.toDataURL('image/png');
            wrapper.appendChild(img);
            frag.appendChild(wrapper);
          }
          container.innerHTML = '';
          container.appendChild(frag);
          var block = container.closest('.pdf-block');
          if(block){ var t = block.querySelector('.pdf-loading'); if(t) t.remove(); }
        }

        async function renderAllPdfs(){
          var nodes = Array.from(document.querySelectorAll('.pdf-pages'));
          if(!nodes.length) return;
          if(!window.pdfjsLib || !window.pdfjsLib.getDocument){
            nodes.forEach(function(n){
              n.innerHTML = '<div class="small muted">PDF.js indisponível neste navegador. Use “Abrir PDF em nova aba” para imprimir o PDF.</div>';
              var block = n.closest('.pdf-block');
              if(block){ var t = block.querySelector('.pdf-loading'); if(t) t.remove(); }
            });
            return;
          }
          for(const n of nodes){
            try{ await renderOnePdf(n); }
            catch(e){
              n.innerHTML = '<div class="small muted">Falha ao renderizar PDF. Use “Abrir PDF em nova aba” para imprimir.</div>';
              var block = n.closest('.pdf-block');
              if(block){ var t = block.querySelector('.pdf-loading'); if(t) t.remove(); }
            }
          }
        }

        async function sha256Hex(text){
          try{
            if(!window.crypto || !crypto.subtle) return null;
            var enc = new TextEncoder();
            var buf = enc.encode(String(text||""));
            var digest = await crypto.subtle.digest('SHA-256', buf);
            var arr = Array.from(new Uint8Array(digest));
            return arr.map(function(b){return b.toString(16).padStart(2,'0');}).join('');
          }catch(e){ return null; }
        }


        function renderPixQr(){
          try{
            var el = document.getElementById('pixQr');
            if(!el) return;
            var k = el.getAttribute('data-pix') || '';
            if(!k) return;
            if(!window.qrcode){
              el.innerHTML = '<div class="small muted">QR indisponível.</div>';
              return;
            }
            var qr = window.qrcode(0, 'M');
            qr.addData(String(k));
            qr.make();
            el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0 });
            // ajusta tamanho máximo
            var svg = el.querySelector('svg');
            if(svg){
              svg.setAttribute('style','width:160px;height:160px;max-width:160px;max-height:160px;');
            }
          }catch(_e){}
        }

        // Renderiza imagens grandes via canvas (evita travamento)
        async function renderCanvasImages(){
          var canvases = Array.from(document.querySelectorAll('.att-img-canvas'));
          for(var cv of canvases){
            var src = cv.getAttribute('data-src');
            if(!src) continue;
            try{
              var MAX_W = 900, MAX_H = 1200;
              var img = new Image();
              await new Promise(function(res,rej){ img.onload=res; img.onerror=rej; img.src=src; });
              var w = img.naturalWidth, h = img.naturalHeight;
              var scale = Math.min(1, MAX_W/w, MAX_H/h);
              cv.width = Math.floor(w*scale);
              cv.height = Math.floor(h*scale);
              var ctx = cv.getContext('2d');
              ctx.drawImage(img, 0, 0, cv.width, cv.height);
            }catch(e){ cv.style.display='none'; }
          }
        }

        // Preenche número de páginas no rodapé (Chrome não suporta counter(pages) em about:blank)
        function fillPageNumbers(){
          try{
            var body = document.body;
            var pageH = 1122; // altura aproximada A4 a 96dpi (297mm)
            var total = Math.max(1, Math.ceil(body.scrollHeight / pageH));
            document.querySelectorAll('.pnum').forEach(function(el, i){
              el.textContent = 'Página ' + (i+1) + ' de ' + total;
            });
          }catch(_){}
        }

                async function preparePrintDocument(){
          try{ await renderCanvasImages(); } catch(e){}
          try{ await renderAllPdfs(); } catch(e){}
          try{ renderPixQr(); } catch(e){}

          async function waitForImages(timeoutMs){
            timeoutMs = timeoutMs || 12000;
            var imgs = Array.from(document.images || []);
            if(!imgs.length) return true;
            function one(img){
              return new Promise(function(resolve){
                if(img.complete && img.naturalWidth > 0) return resolve(true);
                var done = false;
                var to = setTimeout(function(){ if(done) return; done=true; resolve(false); }, timeoutMs);
                function ok(){ if(done) return; done=true; clearTimeout(to); resolve(true); }
                function bad(){ if(done) return; done=true; clearTimeout(to); resolve(false); }
                img.addEventListener('load', ok, { once:true });
                img.addEventListener('error', bad, { once:true });
                try{ if(typeof img.decode === 'function') img.decode().then(ok).catch(function(){}); }catch(_){ }
              });
            }
            try{ await Promise.all(imgs.map(one)); }catch(_){ }
            return true;
          }

          try{
            var audit = ${JSON.stringify({
              spec: DOC_SPEC,
              label: DOC_LABEL,
              docType: docType,
              numero: atd.numero || "",
              status: atd.status || "",
              gerado_em: R.gerado_em || "",
              atendimento_id: atd.id || atd.atendimento_id || ""
            })};
            var h = await sha256Hex(JSON.stringify(audit));
            var el = document.getElementById('docHash');
            if(el) el.textContent = h ? h : '(indisponível neste navegador)';
          }catch(_e){}
          try{ if(document.fonts && document.fonts.ready) { await document.fonts.ready; } }catch(_){ }
          try{ await waitForImages(12000); }catch(_){ }
          try{ fillPageNumbers(); }catch(_){ }
          await new Promise(function(r){ requestAnimationFrame(function(){ requestAnimationFrame(r); }); });
          return true;
        }
        window.__VSC_PRINT_READY__ = preparePrintDocument();
        window.__VSC_DO_PRINT__ = async function(){
          await window.__VSC_PRINT_READY__;
          window.focus();
          window.print();
        };
      })();
    </script>
  </body></html>`;

  if(opts.returnHtml) return html;
  const ui = ensurePrintPreviewModal();
  ui.setState("loading", "Gerando pré-visualização local...");
  ui.setHtml(html, `relatorio-${String(atd.numero || atd.id || 'atendimento')}.html`);
  ui.setState("ready", "Pré-visualização local pronta.");
  return;
}

  async function imprimirAtendimento(db, docType){
    try{
      if(!ATD.atendimento_id){ snack("Selecione ou crie um atendimento para imprimir.", "warn"); return; }
      const payload = await buildPrintData(db);
      openPrintWindow(payload, docType || "clinico");
    }catch(e){
      snack("Falha ao preparar impressão: " + (e.message||"erro"), "err");
    }
  }

  // ─── UI: modal de impressão (seleção do tipo) ───────────────────────
  function openPrintModal(){
    const m = $("vscPrintModal");
    if(!m){
      const r = window.prompt("Tipo de impressão: clinico | prescricao | financeiro", "clinico");
      const t = String(r||"clinico").toLowerCase().trim();
      const ok = (t==="clinico"||t==="prescricao"||t==="financeiro") ? t : "clinico";
      openDb().then(db=>imprimirAtendimento(db, ok)).catch(()=>{});
      return;
    }
    m.classList.remove("hidden");
    m.setAttribute("aria-hidden","false");
  }

  function closePrintModal(){
    const m = $("vscPrintModal");
    if(!m) return;
    m.classList.add("hidden");
    m.setAttribute("aria-hidden","true");
  }

  // ─── SGQT-PRINT-7.1 — Binding robusto do modal de impressão ───────────────
  // Problema comum em sistemas legados: HTML muda e os IDs dos botões não batem.
  // Solução enterprise: detectar pelos textos (fallback) e garantir opção dupla (clínico+financeiro).
  function bindPrintModalButtons(db){
    const m = $("vscPrintModal");
    if(!m) return;

    // 1) garantir botão "Relatório + Financeiro"
    try{
      const btns = Array.from(m.querySelectorAll("button"));
      const hasDuplo = btns.some(b => /relat[óo]rio\s*\+\s*finance|cl[íi]nico\s*\+\s*finance|relat[óo]rio\s*cl[íi]nico\s*\+\s*finance/i.test(b.textContent||""))
        || !!$("btnPrintClinicoFinanceiro");
      if(!hasDuplo){
        // tenta achar o grupo de botões do tipo documento: pega o primeiro botão "Relatório/Prescrição/Financeiro"
        const docBtn = btns.find(b => /relat[óo]rio|prescri[cç][aã]o|financeiro/i.test(b.textContent||""));
        const host = docBtn ? (docBtn.parentElement || m) : m;
        const protoClass = docBtn ? docBtn.className : "";
        const b = document.createElement("button");
        b.type = "button";
        b.id = "btnPrintClinicoFinanceiro";
        b.className = protoClass;
        b.textContent = "Relatório + Financeiro";
        b.style.marginLeft = "6px";
        host.appendChild(b);
      }
    }catch(_e){}

    // 2) fallback: bind por texto (para quando IDs não existirem no HTML)
    const map = [
      { re: /relat[óo]rio\s*cl[íi]nico|prontu[aá]rio|relat[óo]rio\b/i, type: "clinico" },
      { re: /prescri[cç][aã]o/i, type: "prescricao" },
      { re: /comprovante\s*financeiro|financeiro/i, type: "financeiro" },
      { re: /relat[óo]rio\s*\+\s*finance|cl[íi]nico\s*\+\s*finance/i, type: "clinico_financeiro" },
    ];

    const buttons = Array.from(m.querySelectorAll("button"));
    for(const b of buttons){
      if(!b || b.dataset.vscPrintBound === "1") continue;
      const t = String(b.textContent||"").trim();
      let type = null;

      // prioridade: IDs conhecidos
      if(b.id === "btnPrintClinico") type = "clinico";
      else if(b.id === "btnPrintPrescricao") type = "prescricao";
      else if(b.id === "btnPrintFinanceiro") type = "financeiro";
      else if(b.id === "btnPrintClinicoFinanceiro" || b.id === "btnPrintCompleto") type = "clinico_financeiro";

      // fallback por texto
      if(!type){
        for(const it of map){
          if(it.re.test(t)){ type = it.type; break; }
        }
      }

      if(!type) continue;

      b.addEventListener("click", async (ev) => {
        ev.preventDefault();
        closePrintModal();
        try{
          await imprimirAtendimento(db, type);
        }catch(e){
          snack("Falha ao imprimir: " + (e.message||"erro"), "err");
        }
      });

      b.dataset.vscPrintBound = "1";
    }
  }


// ─── Snackbar ─────────────────────────────────────────────────────────
  var _snackTo = null;
  function snack(msg, type) {
    // type: "ok" | "warn" | "err" | "" (default dark)
    const el = $("vscSnackbar");
    if (!el) { return; }
    el.textContent = String(msg || "");
    el.className = type || "";
    el.style.display = "block";
    clearTimeout(_snackTo);
    _snackTo = setTimeout(() => { el.style.display = "none"; }, 3200);
  }

  // ─── Transition Banner ────────────────────────────────────────────────
  function showBanner(msg, type) {
    // type: "ok" | "warn" | "info"
    const el = $("transBanner");
    if (!el) return;
    el.textContent = String(msg || "");
    el.className = "trans-banner show trans-banner--" + (type || "info");
    clearTimeout(el.__to);
    el.__to = setTimeout(() => { el.classList.remove("show"); }, 7000);
  }

  // ─── Confirm dialog ───────────────────────────────────────────────────
  function confirm(title, body) {
    return new Promise((resolve) => {
      const ov = $("vscConfirmOverlay");
      if (!ov) { resolve(window.confirm(body || title)); return; }
      $("confirmTitle").textContent = title;
      $("confirmBody").textContent = body || "";
      ov.classList.remove("hidden");
      function cleanup(v) {
        ov.classList.add("hidden");
        $("confirmOk").removeEventListener("click", okH);
        $("confirmCancel").removeEventListener("click", cancelH);
        resolve(v);
      }
      function okH() { cleanup(true); }
      function cancelH() { cleanup(false); }
      $("confirmOk").addEventListener("click", okH);
      $("confirmCancel").addEventListener("click", cancelH);
    });
  }

  // ─── IDB helpers ──────────────────────────────────────────────────────
  async function openDb() {
    if (!window.VSC_DB || typeof window.VSC_DB.openDB !== "function")
      throw new Error("VSC_DB.openDB indisponível. Carregue vsc_db.js primeiro.");
    return await window.VSC_DB.openDB();
  }

  function hasStore(db, name) {
    try {
      if (!db || !db.objectStoreNames) return false;
      return typeof db.objectStoreNames.contains === "function"
        ? db.objectStoreNames.contains(name)
        : Array.from(db.objectStoreNames).includes(name);
    } catch (_) { return false; }
  }

  // ===============================
  // SGQT-PRINT-5.6 — Loaders Reais (ROBUSTOS) + Diagnóstico
  // Objetivo:
  // - Resolver casos em que a chave do IDB não bate por tipo (string vs number)
  // - Resolver casos em que rec.cliente_id / rec.animal_ids guardam "id externo"
  //   e o store usa outra chave → fallback por varredura (String(id)===String(x.id))
  // Stores oficiais:
  // - clientes_master
  // - animais_master
  // ===============================

  async function idbGetRobust(db, store, key) {
    if (!key) return null;
    // 1) tenta como veio
    let v = await idbGet(db, store, key);
    if (v) return v;

    // 2) tenta coerções (string <-> number)
    const ks = String(key);
    if (ks && ks !== key) {
      v = await idbGet(db, store, ks);
      if (v) return v;
    }
    if (/^\d+$/.test(ks)) {
      const kn = Number(ks);
      if (Number.isFinite(kn)) {
        v = await idbGet(db, store, kn);
        if (v) return v;
      }
    }
    // 3) fallback: varrer store e comparar por String(id)
    try {
      const all = await idbGetAll(db, store);
      if (Array.isArray(all)) {
        const hit = all.find(x => x && String(x.id) === ks);
        if (hit) return hit;
      }
    } catch (_) {}
    return null;
  }

  async function loadClienteById(clienteId) {
    try {
      if (!clienteId) return null;

      const db = await openDb();
      if (!hasStore(db, "clientes_master")) return null;

      const cli = await idbGetRobust(db, "clientes_master", clienteId);
      if (!cli) return null;

      return {
        id: cli.id,
        nome: cli.nome || cli.razao_social || "",
        documento: cli.doc || cli.cnpj || cli.cpf || "",
        telefone: cli.telefone || cli.fone || "",
        email: cli.email || ""
      };
    } catch (e) {
      console.warn("[SGQT-PRINT-5.6] loadClienteById erro:", e);
      return null;
    }
  }

  async function loadAnimalById(animalId) {
    try {
      if (!animalId) return null;

      const db = await openDb();
      if (!hasStore(db, "animais_master")) return null;

      const ani = await idbGetRobust(db, "animais_master", animalId);
      if (!ani) return null;

      return {
        id: ani.id,
        nome: ani.nome || "",
        cliente_id: ani.cliente_id || ani.proprietario_id || ""
      };
    } catch (e) {
      console.warn("[SGQT-PRINT-5.6] loadAnimalById erro:", e);
      return null;
    }
  }

  // Diagnóstico: expor helpers e permitir obter IDs do atendimento atual via UI (sem tocar no backend)
  try {
    globalThis.loadClienteById = loadClienteById;
    globalThis.loadAnimalById = loadAnimalById;
    globalThis.__SGQT_PRINT_DB = {
      openDb,
      idbGetRobust,
      version: "SGQT-PRINT-9.1"
    };

    // Expor funções IDB internas para diagnóstico (Console)
    // Permite rodar: await __SGQT_PRINT_DB.getAll("clientes_master")
    try {
      globalThis.__SGQT_PRINT_DB.idbGet = idbGet;
      globalThis.__SGQT_PRINT_DB.idbGetAll = idbGetAll;
      globalThis.__SGQT_PRINT_DB.hasStore = hasStore;

      globalThis.__SGQT_PRINT_DB.getAll = async (store) => {
        const db = await openDb();
        return await idbGetAll(db, store);
      };

      globalThis.__SGQT_PRINT_DB.get = async (store, key) => {
        const db = await openDb();
        return await idbGet(db, store, key);
      };

      globalThis.__SGQT_PRINT_DB.peek = async (store, n = 3) => {
        const all = await globalThis.__SGQT_PRINT_DB.getAll(store);
        return Array.isArray(all) ? all.slice(0, n) : all;
      };

      console.info("[SGQT-PRINT-9.1] __SGQT_PRINT_DB.get/getAll/peek habilitados");
    } catch (e) {
      // ignore
    }

    console.info("[SGQT-PRINT-9.1] Loaders exportados + idbGetRobust + getAll ativo");
  } catch (_) {}


  function idbGetAll(db, store) {
    return new Promise((resolve) => {
      try {
        if (!hasStore(db, store)) return resolve([]);
        const tx = db.transaction([store], "readonly");
        const st = tx.objectStore(store);
        const rq = st.getAll();
        rq.onsuccess = () => resolve(rq.result || []);
        rq.onerror = () => resolve([]);
      } catch (_) { resolve([]); }
    });
  }

  function idbPut(db, store, obj) {
    return new Promise((resolve, reject) => {
      try {
        if (!hasStore(db, store)) return reject(new Error("Store ausente: " + store));
        const tx = db.transaction([store], "readwrite");
        const st = tx.objectStore(store);
        const rq = st.put(obj);
        rq.onsuccess = () => resolve(true);
        rq.onerror = () => reject(rq.error || new Error("idbPut erro"));
      } catch (e) { reject(e); }
    });
  }

  function idbGet(db, store, key) {
    return new Promise((resolve) => {
      try {
        if (!hasStore(db, store)) return resolve(null);
        const tx = db.transaction([store], "readonly");
        const rq = tx.objectStore(store).get(key);
        rq.onsuccess = () => resolve(rq.result || null);
        rq.onerror = () => resolve(null);
      } catch (_) { resolve(null); }
    });
  }

  // ─── NUMERAÇÃO SEQUENCIAL ─────────────────────────────────────────────
  async function gerarNumeroSequencial(db) {
    const STORE = "config_params";
    const KEY = "atd_next_seq";
    const year = todayYear();

    if (!hasStore(db, STORE)) {
      // Fallback: usa timestamp se config_params não existir
      return `ATD-${year}-${Date.now().toString().slice(-5)}`;
    }

    return new Promise((resolve) => {
      try {
        const tx = db.transaction([STORE], "readwrite");
        const st = tx.objectStore(STORE);
        const rq = st.get(KEY);
        rq.onsuccess = () => {
          const current = rq.result || { id: KEY, key: KEY, value: 0, year: year };
          // Compatibilidade: a store usa keyPath "id", mas mantemos também "key"
          // para leitura legada e para evitar DataError ao salvar o contador.
          current.id = KEY;
          current.key = KEY;

          // Resetar se virou ano
          if (Number(current.year || 0) !== year) {
            current.value = 0;
            current.year = year;
          }
          const next = (Number(current.value || 0)) + 1;
          current.value = next;
          current.year = year;
          current.updated_at = isoNow();
          st.put(current);
          tx.oncomplete = () => {
            const seq = String(next).padStart(5, "0");
            resolve(`ATD-${year}-${seq}`);
          };
          tx.onerror = () => resolve(`ATD-${year}-${Date.now().toString().slice(-5)}`);
        };
        rq.onerror = () => resolve(`ATD-${year}-${Date.now().toString().slice(-5)}`);
      } catch (_) {
        resolve(`ATD-${year}-${Date.now().toString().slice(-5)}`);
      }
    });
  }

  // ─── STATUS UTILS ─────────────────────────────────────────────────────
  const STATUS_LABELS = {
    orcamento: "Orçamento",
    em_atendimento: "Em Atendimento",
    finalizado: "Finalizado",
    cancelado: "Cancelado"
  };

  function statusLabel(s) { return STATUS_LABELS[s] || s; }

  function updateStatusBadges(status) {
    const resolved = status || "orcamento";
    ["uiStatusBadge", "uiStatusBadge2"].forEach(id => {
      const el = $(id);
      if (!el) return;
      el.className = "sbadge sbadge--" + resolved;
      el.textContent = statusLabel(resolved);
    });
    setText('uiHeroStatus', statusLabel(resolved), 'Orçamento');
    setText('uiSummaryStatus', statusLabel(resolved), 'Orçamento');
    const flowMap = {
      orcamento: 'Fluxo inicial sem movimentação financeira automática.',
      em_atendimento: 'Atendimento em execução com prontuário e itens em andamento.',
      finalizado: 'Prontuário concluído e pronto para faturamento ou fechamento.'
    };
    setText('uiSummaryFlow', flowMap[resolved] || 'Prontuário em atualização.', 'Fluxo inicial sem movimentação.');
    const sel = $("status");
    if (sel) sel.value = resolved;
    refreshFinalizadoActionButtons();
  }

  function refreshFinalizadoActionButtons(){
    const isFinalizado = String(ATD.status || "") === "finalizado";
    ["btnAlterarFinalizadoTop","btnAlterarFinalizado"].forEach(id => {
      const b = $(id);
      if(!b) return;
      b.style.display = isFinalizado ? "" : "none";
      b.disabled = !ATD.atendimento_id;
    });
    ["btnFinalizarTop","btnFinalizar"].forEach(id => {
      const b = $(id);
      if(!b) return;
      b.style.display = isFinalizado ? "none" : "";
    });
  }

  // ─── Estado do módulo ─────────────────────────────────────────────────
  let _dbRef = null;

  const ATD = {
    atendimento_id: null,
    numero: "",
    status: "orcamento",
    data_atendimento: "",
    responsavel_user_id: null,
    responsavel_snapshot: null,
    cliente_id: "",
    cliente_label: "",
    _cliente_nome: "",
    animal_ids: [],
    vitals_by_animal: {},
    vitals_active_animal_id: "",
    vitals_prefill_by_animal: {},
    vitals_prefill_pending_by_animal: {},
    vitals_prefill_dirty_by_animal: {},
    itens: [],
    desconto_tipo: "R$",
    desconto_valor: 0,
    desl_km: 0,
    desl_valor_km: 0,
    deslocamento: 0,
    // estoque: IDs de atendimento que já movimentaram
    estoque_movimentado: false,
    financeiro_gerado: false,
    financeiro_fechamento_modo: "aberto",
    financeiro_fechamento_label: "Em aberto",
    financeiro_tipo_pagamento: "definir_depois",
    financeiro_preferencia_pagamento: "definir_depois",
    financeiro_condicao_pagamento: "avista",
    financeiro_baixa_modo: "manual",
    financeiro_vencimento: "",
    financeiro_parcelas: 1,
    financeiro_intervalo_dias: 30,
    financeiro_valor_entrada: 0,
    financeiro_tipo_cobranca: "avulsa",
    financeiro_aceita_parcial: "sim",
    financeiro_prazo_custom_dias: 0,
    cr_id: null, // ID do título em contas_receber
    created_at: null,
    updated_at: null,
    attachments: [],
    vaccine_events: []
  };

  // ─── LISTA DE ATENDIMENTOS ────────────────────────────────────────────
  let _listaCache = [];
  let _listaFiltro = { numero: "", cliente: "", animal: "", status: "", data: "" };
  let _listDebTo = null;

  function filtrarLista(lista) {
    const f = _listaFiltro;
    return lista.filter(a => {
      if (f.numero && !String(a.numero || "").toLowerCase().includes(f.numero.toLowerCase())) return false;
      if (f.cliente && !norm(a.cliente_label || a._cliente_nome || "").includes(norm(f.cliente))) return false;
      if (f.animal) {
        const names = (a._animal_names || []).join(" ");
        if (!norm(names).includes(norm(f.animal))) return false;
      }
      if (f.status && a.status !== f.status) return false;
      if (f.data && (toYMD(a.data_atendimento || a.created_at) || "").slice(0, 10) !== f.data) return false;
      return true;
    });
  }

  function renderLista(db) {
    const tb = $("tbLista");
    if (!tb) return;

    const lista = filtrarLista(_listaCache);

    if (!lista.length) {
      tb.innerHTML = `<tr><td colspan="7" style="padding:24px;text-align:center;" class="hint">Nenhum atendimento encontrado.</td></tr>`;
      return;
    }

    // Ordenar por data desc
    const sorted = [...lista].sort((a, b) => (toYMD(b.data_atendimento || b.created_at) || "").localeCompare(toYMD(a.data_atendimento || a.created_at) || ""));

    tb.innerHTML = sorted.map(a => {
      const isActive = ATD.atendimento_id === a.id;
      const total = fmtBRL(a.totals ? (a.totals.total_geral || 0) : 0);
      const animais = (a._animal_names || []).join(", ") || "—";
      return `<tr class="clickable${isActive ? " is-active" : ""}" data-id="${esc(a.id)}">
        <td><span class="mono" style="font-weight:800;font-size:12px;">${esc(a.numero || "—")}</span></td>
        <td>${esc(a.cliente_label || a._cliente_nome || "—")}</td>
        <td>${esc(animais)}</td>
        <td>${fmtDate(a.data_atendimento || a.created_at)}</td>
        <td><span class="mono" style="font-size:12px;">${total}</span></td>
        <td><span class="sbadge sbadge--${a.status || "orcamento"}">${statusLabel(a.status)}</span></td>
        <td><button class="btn btn--ghost btn--xs" data-act="abrir" data-id="${esc(a.id)}">Abrir</button></td>
      </tr>`;
    }).join("");

    // Delegar clique
    tb.__wiredList = true;
  }

  async function recarregarLista(db) {
    const all = await idbGetAll(db, "atendimentos_master");
    _listaCache = (Array.isArray(all) ? all : []).filter(x => x && x.id);

    // Enriquecer com nomes de animais cacheados
    const animaisAll = hasStore(db, "animais_master") ? await idbGetAll(db, "animais_master") : [];
    _listaCache.forEach(a => {
      const ids = a.animal_ids || [];
      a._animal_names = ids.map(id => {
        const animal = animaisAll.find(x => String(x.id) === String(id));
        return animal ? String(animal.nome || id) : String(id);
      }).filter(Boolean);
    });

    renderLista(db);
  }

  function wireFiltros(db) {
    if (wireFiltros.__wired) return;
    wireFiltros.__wired = true;

    function onFiltro() {
      clearTimeout(_listDebTo);
      _listDebTo = setTimeout(() => renderLista(db), 150);
    }

    $("filtNumero")?.addEventListener("input", (ev) => { _listaFiltro.numero = ev.target.value; onFiltro(); });
    $("filtCliente")?.addEventListener("input", (ev) => { _listaFiltro.cliente = ev.target.value; onFiltro(); });
    $("filtAnimal")?.addEventListener("input", (ev) => { _listaFiltro.animal = ev.target.value; onFiltro(); });
    $("filtStatus")?.addEventListener("change", (ev) => { _listaFiltro.status = ev.target.value; onFiltro(); });
    $("filtData")?.addEventListener("change", (ev) => { _listaFiltro.data = ev.target.value; onFiltro(); });

    // Clique nas linhas da lista → abrir
    $("tbLista")?.addEventListener("click", async (ev) => {
      let t = ev.target;
      while (t && t !== $("tbLista") && !t.getAttribute("data-id")) t = t.parentNode;
      if (!t || t === $("tbLista")) return;
      const id = t.getAttribute("data-id");
      if (!id) return;
      await abrirAtendimento(db, id);
    });
  }

  async function abrirAtendimento(db, id) {
    const rec = _listaCache.find(x => x.id === id);
    if (!rec) {
      // Tentar carregar direto do IDB
      const found = await idbGet(db, "atendimentos_master", id);
      if (!found) { snack("Atendimento não encontrado.", "err"); return; }
      await carregarNoFormulario(db, found);
    } else {
      await carregarNoFormulario(db, rec);
    }
    goDetailView();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function resolveLaunchContext(db) {
    try {
      const qs = new URLSearchParams(window.location.search || "");
      const queryCtx = {
        id: String(qs.get("id") || "").trim(),
        numero: String(qs.get("numero") || "").trim(),
        origem: String(qs.get("origem") || "").trim()
      };

      let sessionCtx = null;
      try {
        const raw = sessionStorage.getItem("vsc_atendimento_launch_ctx");
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") sessionCtx = parsed;
        }
      } catch (_) { sessionCtx = null; }

      const finalCtx = {
        id: queryCtx.id || String(sessionCtx?.id || "").trim(),
        numero: queryCtx.numero || String(sessionCtx?.numero || "").trim(),
        origem: queryCtx.origem || String(sessionCtx?.origem || "").trim()
      };

      if (!finalCtx.id && !finalCtx.numero) return null;

      let found = null;

      if (finalCtx.id) {
        found = await idbGet(db, "atendimentos_master", finalCtx.id);
      }

      if (!found && finalCtx.numero) {
        const pool = (_listaCache && _listaCache.length) ? _listaCache : await idbGetAll(db, "atendimentos_master");
        found = pool.find((row) => String(row?.numero || row?.numero_atendimento || "").trim() === finalCtx.numero) || null;
      }

      if (!found) {
        console.warn("[ATD][DEEPLINK] Atendimento não localizado para contexto de abertura.", finalCtx);
        return { ctx: finalCtx, rec: null };
      }

      console.info("[ATD][DEEPLINK] Atendimento resolvido via contexto de abertura.", {
        id: finalCtx.id || found.id || "",
        numero: finalCtx.numero || found.numero || "",
        origem: finalCtx.origem || "dashboard"
      });
      return { ctx: finalCtx, rec: found };
    } catch (e) {
      console.warn("[ATD][DEEPLINK] Falha ao resolver contexto de abertura:", e);
      return null;
    }
  }

  function consumeLaunchContext() {
    try { sessionStorage.removeItem("vsc_atendimento_launch_ctx"); } catch (_) {}
    try {
      const url = new URL(window.location.href);
      ["id", "numero", "origem"].forEach((k) => url.searchParams.delete(k));
      const next = url.pathname + (url.searchParams.toString() ? ("?" + url.searchParams.toString()) : "") + (url.hash || "");
      window.history.replaceState({}, document.title, next);
    } catch (_) {}
  }

  async function carregarNoFormulario(db, rec) {
    // Recarregar cache de clientes e animais para lookup
    await loadClientesCache(db);

    ATD.atendimento_id = rec.id;
    ATD.numero = rec.numero || "";
    ATD.status = rec.status || "orcamento";

    // Data do atendimento: automática (default hoje), mas editável (campo "Data")
    ATD.data_atendimento = toYMD(rec.data_atendimento || rec.data || rec.data_atd || rec.dataAtendimento || rec.created_at) || todayYMD();

    // Responsável (persistido no atendimento) — fallback para usuário logado se ausente
    ATD.responsavel_user_id = rec.responsavel_user_id || null;
    ATD.responsavel_snapshot = rec.responsavel_snapshot || null;
    if(!ATD.responsavel_user_id){
      try{
        var cu = ATD._currentUser || (window.VSC_AUTH ? await VSC_AUTH.getCurrentUser() : null);
        if(cu && cu.id){
          ATD.responsavel_user_id = cu.id;
          var p = cu.professional || {};
          var crmvTxt = (p.crmv_uf && p.crmv_num) ? ("CRMV-" + p.crmv_uf + " Nº " + p.crmv_num) : "";
          ATD.responsavel_snapshot = {
            user_id: cu.id,
            username: cu.username || "",
            full_name: p.full_name || "",
            crmv_uf: p.crmv_uf || "",
            crmv_num: p.crmv_num || "",
            phone: p.phone || "",
            email: p.email || "",
            signature_image_dataurl: p.signature_image_dataurl || null,
            icp_enabled: !!p.icp_enabled,
            captured_at: isoNow(),
            display_line: ((p.full_name||cu.username||"") + (crmvTxt ? (" — " + crmvTxt) : ""))
          };
        }
      }catch(_e){}
    }

    ATD.cliente_id = rec.cliente_id || "";
    ATD.cliente_label = rec.cliente_label || rec._cliente_nome || "";
    ATD._cliente_nome = ATD.cliente_label;
    ATD.animal_ids = Array.isArray(rec.animal_ids) ? [...rec.animal_ids] : [];
    ATD.vitals_by_animal = rec.vitals_by_animal || {};
    ATD.vitals_active_animal_id = rec.vitals_active_animal_id || "";
    ATD.vitals_prefill_by_animal = {};
    ATD.vitals_prefill_pending_by_animal = {};
    ATD.vitals_prefill_dirty_by_animal = {};
    ATD.itens = Array.isArray(rec.itens) ? [...rec.itens] : [];
    ATD.desconto_tipo = rec.totals?.desconto_tipo || "R$";
    ATD.desconto_valor = rec.totals?.desconto_valor || 0;
    ATD.desl_km = rec.totals?.desl_km || 0;
    ATD.desl_valor_km = rec.totals?.desl_valor_km || ATD.desl_valor_km;
    ATD.deslocamento = rec.totals?.deslocamento || 0;
    ATD.estoque_movimentado = !!rec.estoque_movimentado;
    ATD.financeiro_gerado = !!rec.financeiro_gerado;
    ATD.financeiro_fechamento_modo = rec.financeiro_fechamento_modo || (ATD.financeiro_gerado ? "gerar_agora" : "aberto");
    ATD.financeiro_fechamento_label = rec.financeiro_fechamento_label || (ATD.financeiro_gerado ? "Gerado agora" : "Em aberto");
    ATD.financeiro_observacao = rec.financeiro_observacao || "";
    ATD.financeiro_tipo_pagamento = rec.financeiro_tipo_pagamento || rec.financeiro_preferencia_pagamento || "definir_depois";
    ATD.financeiro_preferencia_pagamento = rec.financeiro_preferencia_pagamento || rec.financeiro_tipo_pagamento || "definir_depois";
    ATD.financeiro_condicao_pagamento = rec.financeiro_condicao_pagamento || "avista";
    ATD.financeiro_baixa_modo = rec.financeiro_baixa_modo || "manual";
    ATD.financeiro_vencimento = rec.financeiro_vencimento || rec.data_atendimento || todayYMD();
    ATD.financeiro_parcelas = Math.max(1, Number(rec.financeiro_parcelas || 1));
    ATD.financeiro_intervalo_dias = Math.max(0, Number(rec.financeiro_intervalo_dias ?? 30));
    ATD.financeiro_valor_entrada = Number(rec.financeiro_valor_entrada || 0);
    ATD.financeiro_tipo_cobranca = rec.financeiro_tipo_cobranca || "avulsa";
    ATD.financeiro_aceita_parcial = rec.financeiro_aceita_parcial || "sim";
    ATD.financeiro_prazo_custom_dias = Math.max(0, Number(rec.financeiro_prazo_custom_dias || 0));
    ATD.cr_id = rec.cr_id || null;
    ATD.created_at = rec.created_at || null;
    // Anexos
    ATD.attachments = Array.isArray(rec.attachments) ? [...rec.attachments] : [];
    ATD.vaccine_events = Array.isArray(rec.vaccine_events) ? [...rec.vaccine_events] : [];
    renderAttachPills();


    // Preencher campos HTML
    $("numero") && ($("numero").value = ATD.numero);
    $("status") && ($("status").value = ATD.status);
    $("data_atendimento") && ($("data_atendimento").value = ATD.data_atendimento || todayYMD());
    $("observacoes") && ($("observacoes").value = rec.observacoes || "");
    $("cli_diagnostico") && ($("cli_diagnostico").value = rec.cli_diagnostico || "");
    $("cli_evolucao") && ($("cli_evolucao").value = rec.cli_evolucao || "");
    $("desconto_tipo") && ($("desconto_tipo").value = ATD.desconto_tipo);
    $("desconto_valor") && ($("desconto_valor").value = ATD.desconto_valor > 0 ? String(ATD.desconto_valor).replace(".", ",") : "0");
    $("desl_km") && ($("desl_km").value = ATD.desl_km > 0 ? String(ATD.desl_km).replace(".", ",") : "0");
    $("desl_valor_km") && ($("desl_valor_km").value = ATD.desl_valor_km > 0 ? String(ATD.desl_valor_km).replace(".", ",") : "—");
    $("deslocamento") && ($("deslocamento").value = ATD.deslocamento > 0 ? String(ATD.deslocamento).replace(".", ",") : "0");

    // Cliente
    $("cliente_id") && ($("cliente_id").value = ATD.cliente_label);
    $("cliente_id_value") && ($("cliente_id_value").value = ATD.cliente_id);
    uiSetCliente(ATD.cliente_label);

    // Animais
    MODAL_ALL = await listarAnimaisPorCliente(db, ATD.cliente_id);
    MODAL_SEL = new Set(ATD.animal_ids);
    applyPickedAnimals(false); // false = não mostrar snack

    // Vitais
    loadVitalsForActiveAnimal();

    // Itens e totais
    renderItens();
    updateTotaisUI();

    // Status badges e editor title
    updateStatusBadges(ATD.status);
    updateEditorTitle();
    renderLista(db); // atualizar seleção ativa na lista
    renderExecutivePanels(db).catch(()=>{});
  }

  // ─── LOOKUP CLIENTE ───────────────────────────────────────────────────
  let LOOKUP_CACHE = [];
  let LOOKUP_READY = false;
  let LOOKUP_CACHE_TS = 0;
  let _debTo = null;

  function debounce(fn, ms) { clearTimeout(_debTo); _debTo = setTimeout(fn, ms); }

  async function loadClientesCache(db, force) {
    // Cache curta e revalidação: evita "não aparece cliente" após incluir/alterar em outra aba.
    // Enterprise: degrade gracioso (se falhar, lookup continua vazio sem quebrar a tela).
    try{
      const now = Date.now();
      const age = now - (LOOKUP_CACHE_TS || 0);
      if (!force && LOOKUP_READY && age < 3000) return;

      const all = await idbGetAll(db, "clientes_master");
      LOOKUP_CACHE = (Array.isArray(all) ? all : [])
        .filter(c => c && !c.deleted && !c.deleted_at) // não excluir por status (permite histórico/fechamento mensal)
        .map(c => ({
          id: String(c.id || ""),
          nome: String(c.nome || c.razao_social || "(sem nome)"),
          status: String(c.status || "ATIVO"),
          doc: String(c.doc || c.cnpj || c.cpf || ""),
          telefone: String(c.telefone || ""),
          cidade: String(c.cidade || ""),
          uf: String(c.uf || ""),
          nome_norm: norm(c.nome || c.razao_social || ""),
          doc_digits: onlyDigits(c.doc || c.cnpj || c.cpf || ""),
          tel_digits: onlyDigits(c.telefone || "")
        })).filter(x => x.id);

      LOOKUP_READY = true;
      LOOKUP_CACHE_TS = now;
    }catch(_){
      LOOKUP_CACHE = LOOKUP_CACHE || [];
      LOOKUP_READY = true;
      LOOKUP_CACHE_TS = Date.now();
    }
  }

  function findClientes(q) {
    q = String(q || "").trim();
    if (!q) return [];
    const qn = norm(q), qd = onlyDigits(q);
    const out = [];
    for (let i = 0; i < LOOKUP_CACHE.length; i++) {
      const c = LOOKUP_CACHE[i];
      let ok = false;
      if (qd && (c.doc_digits.includes(qd) || c.tel_digits.includes(qd))) ok = true;
      if (!ok && qn && c.nome_norm.includes(qn)) ok = true;
      if (ok) { out.push(c); if (out.length >= 12) break; }
    }
    return out;
  }

  function lookupHide() {
    const box = $("vscClienteLookup"); if (!box) return;
    box.hidden = true; box.innerHTML = "";
  }

  function lookupRender(list) {
    const box = $("vscClienteLookup"); if (!box) return;
    if (!list.length) {
      box.hidden = false;
      box.innerHTML = `<div class="lookup-item"><strong>Nenhum resultado</strong><span>Tente outro termo.</span></div>`;
      return;
    }
    box.hidden = false;
    box.innerHTML = list.map(c => {
      const sub = [c.doc, c.telefone, c.cidade && c.uf ? c.cidade + "-" + c.uf : (c.cidade || c.uf)].filter(Boolean).join(" • ");
      const st = String(c.status || "ATIVO").toUpperCase();
      const pill = (st && st !== "ATIVO") ? ` <span class="pill" style="font-size:11px; padding:1px 8px; border-radius:999px; border:1px solid rgba(0,0,0,.10); background:#f3f4f6; font-weight:900;">${esc(st)}</span>` : "";
      return `<div class="lookup-item" data-id="${esc(c.id)}" data-label="${esc(c.nome)}">
        <strong>${esc(c.nome)}${pill}</strong><span>${esc(sub)}</span></div>`;
    }).join("");
  }

  function setClienteSelection(id, label) {
    ATD.cliente_id = String(id || "").trim();
    ATD.cliente_label = String(label || "").trim();
    ATD._cliente_nome = ATD.cliente_label;
    const hid = $("cliente_id_value"); if (hid) hid.value = ATD.cliente_id;
    const inp = $("cliente_id"); if (inp) inp.value = ATD.cliente_label;
    uiSetCliente(ATD.cliente_label || "—");
    $("uiClienteHint") && ($("uiClienteHint").textContent = "Selecionado: " + ATD.cliente_label);
  }

  function uiSetCliente(label) {
    $("uiClienteNome") && ($("uiClienteNome").textContent = label || "—");
    $("uiHeroClienteLine") && ($("uiHeroClienteLine").textContent = label || "—");
  }

  function uiSetAnimalResumo(label) {
    $("uiAnimal") && ($("uiAnimal").textContent = label || "—");
    $("uiHeroAnimalLine") && ($("uiHeroAnimalLine").textContent = label || "—");
    const side = $("uiAnimalSide");
    if (side) { side.textContent = label || ""; side.style.display = label ? "" : "none"; }
  }


  function calcIdadeAprox(nascimento){
    const d = parseDateFlexible(nascimento);
    if(!d) return "Idade não informada";
    const now = new Date();
    let years = now.getFullYear() - d.getFullYear();
    let months = now.getMonth() - d.getMonth();
    if(now.getDate() < d.getDate()) months -= 1;
    if(months < 0){ years -= 1; months += 12; }
    if(years > 0) return years + (years === 1 ? " ano" : " anos");
    if(months > 0) return months + (months === 1 ? " mês" : " meses");
    return "< 1 mês";
  }

  async function getCatalogName(db, store, id){
    try{
      if(!db || !id || !hasStore(db, store)) return "";
      const rec = await idbGet(db, store, id);
      return String(rec?.nome || rec?.descricao || "").trim();
    }catch(_){ return ""; }
  }

  async function getAnimalProfile(db){
    try{
      const rawId = String((ATD.animal_ids||[])[0] || "");
      if(!db || !hasStore(db, "animais_master")) return null;
      let rec = null;
      if(rawId) rec = await idbGet(db, "animais_master", rawId);
      if(!rec){
        const all = await idbGetAll(db, "animais_master");
        const firstName = String((ATD.animais_snapshot && ATD.animais_snapshot[0] && ATD.animais_snapshot[0].nome) || '').trim().toLowerCase();
        if(firstName){
          rec = (Array.isArray(all)?all:[]).find(x => x && String(x.nome || '').trim().toLowerCase() === firstName) || null;
        }
      }
      if(!rec) return null;
      const animalId = String(rec.id || rawId || "");
      const especie = await getCatalogName(db, "animais_especies", rec.especie_id);
      const raca = await getCatalogName(db, "animais_racas", rec.raca_id);
      const nascimento = rec.nascimento || rec.data_nascimento || rec.nascimento_data || rec.nascimento_em || rec.dt_nascimento || rec.birth_date || "";
      return {
        id: animalId,
        nome: String(rec.nome || "Paciente não selecionado"),
        foto: String(rec.foto_data || rec.foto || rec.image || rec.imagem || ""),
        especie,
        raca,
        sexo: String(rec.sexo || "").trim(),
        idade: calcIdadeAprox(nascimento),
        nascimento,
        pelagem: await getCatalogName(db, "animais_pelagens", rec.pelagem_id),
      };
    }catch(_){ return null; }
  }

  async function getRecentAtendimentosForAnimal(db, animalId){
    try{
      if(!db || !animalId || !hasStore(db, "atendimentos_master")) return [];
      const all = await idbGetAll(db, "atendimentos_master");
      return (Array.isArray(all)?all:[])
        .filter(r => r && Array.isArray(r.animal_ids) && r.animal_ids.map(String).includes(String(animalId)))
        .sort((a,b)=> String(b.data_atendimento || b.created_at || "").localeCompare(String(a.data_atendimento || a.created_at || "")))
        .slice(0,6);
    }catch(_){ return []; }
  }

  function renderFinanceiroResumo(){
    const badge = $("uiFinanceiroBadge");
    const resumo = $("uiResumoFinanceiro");
    const resumoBox = $("uiResumoFinanceiroBox");
    const heroFinanceiro = $("uiHeroFinanceiro");
    const total = fmtBRL(Math.max(0, itensSubtotal() - calcDesconto(itensSubtotal()) + (ATD.deslocamento||0)));
    const itensCount = String((ATD.itens||[]).length || 0);
    $("uiResumoItens") && ($("uiResumoItens").textContent = itensCount);
    $("uiResumoTotal") && ($("uiResumoTotal").textContent = total);
    $("uiSummaryItens") && ($("uiSummaryItens").textContent = itensCount);
    $("uiSummaryItensTxt") && ($("uiSummaryItensTxt").textContent = (ATD.itens||[]).length ? 'Produtos, serviços e exames lançados.' : 'Sem produtos ou serviços.');
    const label = ATD.financeiro_gerado ? "Gerado agora" : (ATD.financeiro_fechamento_label || "Em aberto");
    if(resumo) resumo.textContent = label;
    if(resumoBox) resumoBox.textContent = label;
    $("uiSummaryFinanceiro") && ($("uiSummaryFinanceiro").textContent = label);
    $("uiSummaryFinanceiroTxt") && ($("uiSummaryFinanceiroTxt").textContent = ATD.financeiro_gerado ? 'Título já lançado em contas a receber.' : 'Definido no fluxo de finalização.');
    if(badge){
      badge.className = 'hero-pill' + (ATD.financeiro_gerado ? '' : ' info');
      badge.textContent = ATD.financeiro_gerado ? 'Financeiro gerado agora' : ('Financeiro em aberto • ' + label);
    }
    if(heroFinanceiro){
      heroFinanceiro.className = 'hero-pill' + (ATD.financeiro_gerado ? '' : ' info');
      heroFinanceiro.textContent = ATD.financeiro_gerado ? 'Financeiro gerado agora' : ('Financeiro em aberto • ' + label);
    }
    $("uiHeroTotal") && ($("uiHeroTotal").textContent = total);
  }

  function renderPrescriptionSummary(){
    const box = $("uiRxSummary");
    if(!box) return;
    const itens = Array.isArray(ATD.itens) ? ATD.itens : [];
    if(!itens.length){
      box.innerHTML = '<div class="atd-empty-soft">Nenhum item clínico lançado ainda.</div>';
      return;
    }
    box.innerHTML = itens.slice(0,8).map(it => {
      const tipo = String(it.tipo || 'ITEM').toUpperCase();
      const qtd = Number(it.qtd || 0);
      const title = esc(String(it.desc || it.nome || 'Item sem descrição'));
      const sub = esc(tipo + (it.vu ? ' • ' + fmtBRL(it.vu) : ''));
      return `<div class="rx-item"><div style="min-width:0;"><div class="rx-item__title">${title}</div><div class="rx-item__sub">${sub}</div></div><div class="rx-item__qty">${qtd > 0 ? qtd + 'x' : '—'}</div></div>`;
    }).join('');
  }

  function renderTimelineResumo(){
    const box = $("uiTimelineResumo");
    if(!box) return;
    const itens = [];
    itens.push({t:'Prontuário', s: ATD.numero ? ('Número ' + ATD.numero) : 'Novo atendimento em elaboração'});
    itens.push({t:'Status atual', s: statusLabel(ATD.status)});
    itens.push({t:'Fechamento financeiro', s: ATD.financeiro_gerado ? 'Título gerado em Contas a Receber' : (ATD.financeiro_fechamento_label || 'Em aberto')});
    box.innerHTML = itens.map(i => `<div class="mini-item"><div class="mini-item__main"><div class="mini-item__title">${esc(i.t)}</div><div class="mini-item__sub">${esc(i.s)}</div></div></div>`).join('');
  }

  function setText(id, value, fallback){
    const el = $(id);
    if(el) el.textContent = (value == null || value === "") ? (fallback || "—") : String(value);
  }

  function resolveCurrentStatusMeta(){
    const status = String(ATD.status || $("status")?.value || "orcamento");
    const mapa = {
      orcamento: 'Fluxo inicial sem movimentação financeira automática.',
      em_atendimento: 'Atendimento em execução com prontuário e itens em andamento.',
      finalizado: 'Prontuário concluído e pronto para faturamento ou fechamento.'
    };
    return { status, label: statusLabel(status), flow: mapa[status] || 'Prontuário em atualização.' };
  }

  function getCurrentAnimalName(profile){
    return String((profile && profile.nome) || (ATD.animais_snapshot && ATD.animais_snapshot[0] && ATD.animais_snapshot[0].nome) || $("uiAnimalSide")?.textContent || "").trim();
  }

  function getAttachmentStats(){
    const items = Array.isArray(ATD.attachments) ? ATD.attachments : [];
    let semDescricao = 0;
    items.forEach(a => {
      if(!String(a?.descricao || a?.description || '').trim()) semDescricao += 1;
    });
    return { total: items.length, semDescricao };
  }

  function resolvePreviousWeightFromHistory(hist, currentId){
    const prev = (Array.isArray(hist) ? hist : []).find(r => String(r?.id || '') !== String(currentId || ''));
    if(!prev) return { label: '—', dateLabel: '—', raw: null };
    const vitals = prev.vitals_by_animal || {};
    let weight = null;
    Object.keys(vitals).some(k => {
      const v = vitals[k];
      const p = Number(v?.peso || 0);
      if(p > 0){ weight = p; return true; }
      return false;
    });
    if(weight == null) weight = Number(prev?.peso || prev?.peso_anterior || 0) || null;
    return {
      label: weight ? String(weight).replace('.',',') + ' kg' : '—',
      dateLabel: fmtDate(prev.data_atendimento || prev.data || prev.created_at || prev.updated_at),
      raw: prev
    };
  }

  function renderExecutiveSnapshot(profile, hist){
    const statusMeta = resolveCurrentStatusMeta();
    const animalName = getCurrentAnimalName(profile) || 'Nenhum animal vinculado.';
    const attachments = getAttachmentStats();
    const prevWeight = resolvePreviousWeightFromHistory(hist, ATD.atendimento_id);
    const dataAtual = fmtDate(ATD.data_atendimento || $("data_atendimento")?.value || ATD.created_at);
    const delta = String($("v_peso_delta")?.value || '').trim();
    const alertMessages = [];
    if(delta && delta !== '—' && !/^\+?0([,.]0+)?\s*kg$/i.test(delta)) alertMessages.push('Variação de peso ' + delta);
    if(attachments.semDescricao > 0) alertMessages.push('Anexo sem descrição clínica');
    setText('uiHeroData', dataAtual, 'Data não definida');
    setText('uiHeroPesoAnterior', prevWeight.label, '—');
    setText('uiHeroUltimo', prevWeight.dateLabel || '—', '—');
    setText('uiHeroStatus', statusMeta.label, 'Orçamento');
    setText('uiSummaryStatus', statusMeta.label, 'Orçamento');
    setText('uiSummaryFlow', statusMeta.flow, 'Fluxo inicial sem movimentação.');
    setText('uiSummaryAnimais', String((ATD.animal_ids || []).length || 0), '0');
    setText('uiSummaryAnimalNome', animalName, 'Nenhum animal vinculado.');
    setText('uiHeroAnexos', String(attachments.total), '0');
    setText('uiHeroAlertasQtd', String(alertMessages.length), '0');
    setText('uiHeroAlertaTexto', alertMessages[0] || 'Sem alertas clínicos automáticos.', 'Sem alertas clínicos automáticos.');
  }

  async function renderExecutivePanels(db){
    renderFinanceiroResumo();
    renderPrescriptionSummary();
    renderTimelineResumo();
    const avatar = $("uiHeroAvatar");
    const nameEl = $("uiHeroName");
    const registroEl = $("uiHeroRegistro");
    const metaEl = $("uiHeroMeta");
    const tutorEl = $("uiHeroTutor");
    const ultimoEl = $("uiHeroUltimo");
    const pesoEl = $("uiHeroPesoAnterior");
    const dataEl = $("uiHeroData");
    const histEl = $("uiRecentAtendimentos");
    const alertsEl = $("uiHeroAlerts");
    const profile = await getAnimalProfile(db);
    if(profile){
      if(avatar) avatar.innerHTML = profile.foto && profile.foto.startsWith('data:image/') ? `<img src="${profile.foto}" alt="paciente"/>` : '🐴';
      if(nameEl) nameEl.textContent = profile.nome;
      if(registroEl) registroEl.textContent = ATD.numero ? ('Registro clínico • ' + ATD.numero) : 'Registro clínico em criação';
      const meta = [profile.especie || 'Espécie não informada', profile.raca || 'Raça não informada', profile.idade].filter(Boolean).join(' · ');
      if(metaEl) metaEl.innerHTML = '<strong>' + esc(meta) + '</strong>';
    }else{
      if(avatar) avatar.textContent = '🐴';
      if(nameEl) nameEl.textContent = 'Paciente não selecionado';
      if(registroEl) registroEl.textContent = ATD.numero ? ('Registro clínico • ' + ATD.numero) : 'Registro clínico —';
      if(metaEl) metaEl.textContent = 'Selecione o cliente e o animal para iniciar o atendimento clínico premium.';
    }
    if(tutorEl) tutorEl.textContent = ATD.cliente_label || '—';
    if(dataEl) dataEl.textContent = fmtDate(ATD.data_atendimento || $("data_atendimento")?.value || ATD.created_at) || 'Data não definida';
    if(pesoEl) pesoEl.textContent = $("v_peso_prev")?.value || '—';

    let hist = [];
    if(profile?.id) hist = await getRecentAtendimentosForAnimal(db, profile.id);
    if(ultimoEl){
      const prev = hist.find(r => String(r.id) !== String(ATD.atendimento_id));
      ultimoEl.textContent = prev ? fmtDate(prev.data_atendimento || prev.data || prev.created_at || prev.updated_at) : '—';
    }
    if(histEl){
      if(!hist.length){
        histEl.innerHTML = '<div class="atd-empty-soft">Sem histórico recente para o animal selecionado.</div>';
      } else {
        let currentYear = '';
        histEl.innerHTML = hist.map(r => {
          const year = String(toYMD(r.data_atendimento || r.created_at || r.updated_at) || '').slice(0,4) || 'Sem data';
          const titulo = esc(String(r.cli_diagnostico || r.observacoes || statusLabel(r.status || 'orcamento')).slice(0,80) || 'Atendimento sem descrição');
          const sub = esc((r.status ? statusLabel(r.status) : 'Atendimento') + ' • ' + fmtBRL(r.totals?.total_geral || 0));
          const prefix = year !== currentYear ? `<div class="history-year">${esc(year)}</div>` : '';
          currentYear = year;
          return `${prefix}<div class="history-item history-item--clickable" data-atd-id="${esc(String(r.id || ''))}"><div class="history-item__date">${esc(fmtDate(r.data_atendimento || r.created_at))}</div><div class="history-item__main"><div class="history-item__title">${titulo}</div><div class="history-item__sub">${sub}</div></div><div class="history-item__cta">Abrir</div></div>`;
        }).join('');
      }
    }
    if(alertsEl){
      const delta = String($("v_peso_delta")?.value || '').trim();
      const prev = hist.find(r => String(r.id) !== String(ATD.atendimento_id));
      const prevDate = parseDateFlexible(prev?.data_atendimento || prev?.data || prev?.created_at || prev?.updated_at);
      const diasSemConsulta = prevDate ? Math.floor((Date.now() - prevDate.getTime()) / 86400000) : 0;
      if(delta && delta !== '—' && !delta.startsWith('+') && !delta.startsWith('0')){
        alertsEl.className = 'hero-pill warn';
        alertsEl.textContent = 'Atenção: variação de peso ' + delta;
      } else if ((ATD.attachments||[]).some(a => !String(a?.descricao||a?.description||'').trim())) {
        alertsEl.className = 'hero-pill warn';
        alertsEl.textContent = 'Há anexos sem descrição para auditoria clínica';
      } else if (diasSemConsulta >= 180) {
        alertsEl.className = 'hero-pill warn';
        alertsEl.textContent = 'Intervalo clínico elevado • ' + diasSemConsulta + ' dias sem retorno';
      } else {
        alertsEl.className = 'hero-pill info';
        alertsEl.textContent = 'Sem alertas clínicos automáticos';
      }
    }
    renderExecutiveSnapshot(profile, hist);
  }


  function wireLookup(getDb) {
    const inp = $("cliente_id");
    const box = $("vscClienteLookup");
    if (!inp || !box || inp.__wired) return;
    inp.__wired = true;

    inp.addEventListener("input", async () => {
      try {
        await loadClientesCache(getDb(), true);
        const q = inp.value || "";
        debounce(() => { lookupRender(findClientes(q)); }, 120);
      } catch (_) { lookupHide(); }
    });
    inp.addEventListener("focus", async () => {
      try {
        await loadClientesCache(getDb(), true);
        if (inp.value) debounce(() => lookupRender(findClientes(inp.value)), 120);
      } catch (_) { }
    });
    document.addEventListener("click", (ev) => {
      if (ev.target === inp || box.contains(ev.target)) return;
      lookupHide();
    });
    box.addEventListener("click", (ev) => {
      let t = ev.target;
      while (t && t !== box && !t.getAttribute("data-id")) t = t.parentNode;
      if (!t || t === box) return;
      const id = t.getAttribute("data-id");
      const label = t.getAttribute("data-label");
      setClienteSelection(id, label);
      lookupHide();
      VSC_ATD_openAnimalModalAsk(getDb);
    });
  }

  // ─── ANIMAIS ──────────────────────────────────────────────────────────
  let MODAL_ALL = [];
  let MODAL_SEL = new Set();

  function VSC_ATD_openAnimalModalAsk(getDb) {
    const m = $("vscAnimalModal"); if (!m) return;
    $("vscAnimalModalStepAsk")?.classList.remove("hidden");
    $("vscAnimalModalStepPick")?.classList.add("hidden");
    m.classList.remove("hidden"); m.setAttribute("aria-hidden", "false");
    $("vscAnimalModalAskGetDb") && delete $("vscAnimalModalAskGetDb");
    m._getDb = getDb;
  }

  function VSC_ATD_closeAnimalModal() {
    const m = $("vscAnimalModal"); if (!m) return;
    m.classList.add("hidden"); m.setAttribute("aria-hidden", "true");
  }

  function avatarHtml(a) {
    try {
      const foto = String(a?.foto_data || a?.foto || a?.image || a?.imagem || a?.avatar || "").trim();
      const ini = (String(a?.nome || "").trim().slice(0, 1) || "🐴").toUpperCase();
      if (foto && foto.startsWith("data:image/"))
        return `<img src="${foto}" alt="foto" style="width:100%;height:100%;object-fit:cover;border-radius:8px;" />`;
      return `<span style="font-size:16px;">${esc(ini)}</span>`;
    } catch (_) { return "🐴"; }
  }

  async function listarAnimaisPorCliente(db, cliente_id) {
    const cid = String(cliente_id || "").trim();
    if (!cid) return [];
    const all = await idbGetAll(db, "animais_master");
    let clienteNome = '';
    try{
      if(hasStore(db, 'clientes_master')){
        const cli = await idbGet(db, 'clientes_master', cid);
        clienteNome = String(cli?.nome || cli?.razao_social || '').trim().toLowerCase();
      }
    }catch(_){ }
    const items = (Array.isArray(all) ? all : [])
      .filter(a => {
        if(!a || a.deleted || a.deleted_at) return false;
        const animalCli = String(a.cliente_id || a.proprietario_id || a.tutor_id || '');
        if(animalCli === cid) return true;
        if(clienteNome){
          const nomeTutor = String(a.tutor_nome || a.proprietario_nome || a.cliente_nome || a.tutor || '').trim().toLowerCase();
          if(nomeTutor && nomeTutor === clienteNome) return true;
        }
        return false;
      })
      .map(a => ({ id: String(a.id || ""), nome: String(a.nome || "(sem nome)"), foto_data: String(a.foto_data || a.foto || a.image || a.imagem || ''), ativo: !(a.ativo === false || a.ativo === 0) }))
      .filter(a => a.id);
    items.sort((a,b) => String(a.nome||'').localeCompare(String(b.nome||''), 'pt-BR', {sensitivity:'base'}));
    return items;
  }

  function renderPickList() {
    const list = $("vscAnimalList");
    const q = String($("vscAnimalSearch")?.value || "").toLowerCase().trim();
    if (!list) return;
    const items = (MODAL_ALL || []).filter(a => !q || String(a.nome || "").toLowerCase().includes(q));
    list.innerHTML = items.length ? items.map(a => {
      const id = String(a.id || "");
      const on = MODAL_SEL.has(id);
      return `<label class="animal-pick ${on ? "is-on" : ""}" data-id="${esc(id)}" style="display:flex;">
        <input type="checkbox" class="vsc-modal-animal" data-id="${esc(id)}" ${on ? "checked" : ""} style="margin-right:8px;flex-shrink:0;margin-top:4px;"/>
        <div class="animal-pick__avatar">${avatarHtml(a)}</div>
        <div style="flex:1;padding-left:8px;">
          <div class="animal-pick__name">${esc(a.nome || "(sem nome)")}</div>
          <span class="animal-pick__tag ${a.ativo ? "animal-pick__tag--ativo" : "animal-pick__tag--inativo"}">${a.ativo ? "ATIVO" : "INATIVO"}</span>
        </div>
      </label>`;
    }).join("") : `<div style="padding:16px;" class="hint">Nenhum animal encontrado.</div>`;
    const count = $("vscAnimalCount");
    if (count) count.textContent = `${MODAL_SEL.size} selecionado(s)`;
  }

  async function openPickStep(getDb) {
    const db = getDb();
    const cid = String($("cliente_id_value")?.value || ATD.cliente_id || "").trim();
    if (!cid) { snack("Selecione um cliente primeiro.", "err"); return; }
    MODAL_ALL = await listarAnimaisPorCliente(db, cid);
    MODAL_SEL = new Set(ATD.animal_ids || []);
    $("vscAnimalModalStepAsk")?.classList.add("hidden");
    $("vscAnimalModalStepPick")?.classList.remove("hidden");
    renderPickList();
  }

  function wireModalOnce(getDb) {
    const m = $("vscAnimalModal");
    if (!m || m.__wired) return;
    m.__wired = true;

    $("vscAnimalModalClose")?.addEventListener("click", VSC_ATD_closeAnimalModal);
    $("vscAnimalNo")?.addEventListener("click", (ev) => {
      ev.preventDefault(); VSC_ATD_closeAnimalModal(); snack("Ok, nenhum animal adicionado.", false);
    });
    $("vscAnimalYes")?.addEventListener("click", (ev) => {
      ev.preventDefault(); openPickStep(m._getDb || getDb);
    });
    $("vscAnimalSearch")?.addEventListener("input", renderPickList);
    $("vscAnimalList")?.addEventListener("change", (ev) => {
      const t = ev.target;
      if (!t?.classList?.contains("vsc-modal-animal")) return;
      const id = String(t.getAttribute("data-id") || "");
      if (!id) return;
      t.checked ? MODAL_SEL.add(id) : MODAL_SEL.delete(id);
      const label = t.closest("label");
      if (label) label.classList.toggle("is-on", t.checked);
      const count = $("vscAnimalCount");
      if (count) count.textContent = `${MODAL_SEL.size} selecionado(s)`;
    });
    $("vscAnimalCancelPick")?.addEventListener("click", VSC_ATD_closeAnimalModal);
    $("vscAnimalApplyPick")?.addEventListener("click", () => {
      applyPickedAnimals(true);
      VSC_ATD_closeAnimalModal();
    });
    $("tb_animais")?.addEventListener("click", (ev) => {
      let t = ev.target;
      while (t && t !== $("tb_animais") && !t.getAttribute("data-act")) t = t.parentNode;
      if (!t || !t.getAttribute) return;
      const act = t.getAttribute("data-act");
      const id = t.getAttribute("data-id");
      if (act === "remAnimal" && id) {
        ATD.animal_ids = (ATD.animal_ids || []).filter(x => String(x) !== String(id));
        MODAL_SEL = new Set(ATD.animal_ids);
        applyPickedAnimals(true);
      }
    });
    $("vscVaccineClose")?.addEventListener("click", closeVaccineModal);
    $("vscVaccineSkip")?.addEventListener("click", closeVaccineModal);
    $("vscVaccineSave")?.addEventListener("click", (ev)=>{ ev.preventDefault(); saveVaccineModal(); });
    $("vscVaccineModal")?.addEventListener("click", (ev)=>{ if (ev.target === $("vscVaccineModal")) closeVaccineModal(); });
    document.addEventListener("change", (ev) => {
      if (ev.target?.id === "vscVitalsAnimalSel") {
        ATD.vitals_active_animal_id = ev.target.value;
        loadVitalsForActiveAnimal();
      }
    });
    $("btnVitalsApply")?.addEventListener("click", (ev) => { ev.preventDefault(); applyVitalsFromUI(); });
    $("btnVitalsClear")?.addEventListener("click", (ev) => { ev.preventDefault(); clearVitalsUI(); });
    VITALS_FIELD_IDS.forEach(id => {
      $(id)?.addEventListener('input', markVitalsPrefillDirty);
      $(id)?.addEventListener('change', markVitalsPrefillDirty);
    });
  }

  function applyPickedAnimals(showSnack) {
    const ids = Array.from(MODAL_SEL.values());
    ATD.animal_ids = ids;
    setVitalsVisible(ids.length > 0);
    setClinicosVisible(ids.length > 0);
    if (!ids.length) ATD.vitals_active_animal_id = "";
    else if (!ATD.vitals_active_animal_id || !ids.includes(ATD.vitals_active_animal_id))
      ATD.vitals_active_animal_id = String(ids[0]);

    const tb = $("tb_animais");
    if (tb) {
      if (!ids.length) {
        tb.innerHTML = `<tr><td colspan="2" style="padding:16px;" class="hint">Nenhum animal selecionado.</td></tr>`;
        uiSetAnimalResumo("—");
      } else {
        const names = [];
        for (let i = 0; i < MODAL_ALL.length; i++) {
          const a = MODAL_ALL[i];
          if (ids.includes(String(a.id))) names.push(String(a.nome || ""));
        }
        uiSetAnimalResumo(names.join(", ") || ids.length + " animal(is)");
        tb.innerHTML = ids.map(id => {
          const a = MODAL_ALL.find(x => String(x.id) === String(id));
          const nm = a ? String(a.nome || "(sem nome)") : String(id);
          return `<tr>
            <td style="padding:10px;">
              <div style="display:flex;gap:10px;align-items:center;">
                <div class="animal-pick__avatar">${a ? avatarHtml(a) : "🐴"}</div>
                <div style="font-weight:900;">${esc(nm)}</div>
              </div>
            </td>
            <td style="padding:10px;">
              <button type="button" class="btn btn--ghost btn--xs" data-act="remAnimal" data-id="${esc(String(id))}">Remover</button>
            </td>
          </tr>`;
        }).join("");
      }
    }

    const hint = $("uiAnimalPick");
    if (hint) hint.textContent = ids.length ? ids.length + " animal(is) selecionado(s)." : "Selecione um cliente para listar os animais.";

    loadVitalsForActiveAnimal();
    renderExecutivePanels(_dbRef).catch(()=>{});
    if (showSnack) snack("Animais aplicados: " + ids.length + ".", "ok");
  }

  // ─── VITAIS ───────────────────────────────────────────────────────────
  function setVitalsVisible(on) {
    const card = $("cardVitais");
    if (card) card.style.display = on ? "" : "none";
  }


  function setClinicosVisible(on){
    const card = $("cardClinicos");
    if(card) card.style.display = on ? "" : "none";
  }

  function getActiveAnimalIdForVitals() {
    const ids = ATD.animal_ids || [];
    if (!ids.length) return "";
    if (!ATD.vitals_active_animal_id || !ids.includes(ATD.vitals_active_animal_id))
      ATD.vitals_active_animal_id = String(ids[0]);
    return ATD.vitals_active_animal_id;
  }

  function renderVitalsAnimalSelector() {
    const wrap = $("vscVitalsAnimalWrap");
    const sel = $("vscVitalsAnimalSel");
    if (!wrap || !sel) return;
    const ids = ATD.animal_ids || [];
    if (ids.length <= 1) { wrap.style.display = "none"; return; }
    const opts = ids.map(id => {
      const a = MODAL_ALL.find(x => String(x.id) === String(id));
      return { id: String(id), nome: a ? String(a.nome || id) : String(id) };
    });
    sel.innerHTML = opts.map(o => `<option value="${esc(o.id)}">${esc(o.nome)}</option>`).join("");
    sel.value = getActiveAnimalIdForVitals();
    wrap.style.display = "";
  }

  function vitalsReadFromUI() {
    return {
      temp: toNumPt($("v_temp")?.value),
      fc: toNumPt($("v_fc")?.value),
      fr: toNumPt($("v_fr")?.value),
      peso: toNumPt($("v_peso")?.value),
      mm: String($("v_mm")?.value || ""),
      trc: String($("v_trc")?.value || ""),
      hid: String($("v_hid")?.value || ""),
      dor: String($("v_dor")?.value || ""),
      updated_at: isoNow()
    };
  }

  function vitalsWriteToUI(v) {
    v = v || {};
    $("v_temp") && ($("v_temp").value = (v.temp && v.temp !== 0) ? String(v.temp).replace(".", ",") : "");
    $("v_fc") && ($("v_fc").value = (v.fc && v.fc !== 0) ? String(v.fc) : "");
    $("v_fr") && ($("v_fr").value = (v.fr && v.fr !== 0) ? String(v.fr) : "");
    $("v_peso") && ($("v_peso").value = (v.peso && v.peso !== 0) ? String(v.peso).replace(".", ",") : "");
    $("v_mm") && ($("v_mm").value = String(v.mm || ""));
    $("v_trc") && ($("v_trc").value = String(v.trc || ""));
    $("v_hid") && ($("v_hid").value = String(v.hid || ""));
    $("v_dor") && ($("v_dor").value = String(v.dor || ""));
  }

  function vitalsResumo(v) {
    if (!v) return "—";
    const parts = [];
    if (v.temp) parts.push(`T° ${v.temp}°C`);
    if (v.fc) parts.push(`FC ${v.fc}`);
    if (v.fr) parts.push(`FR ${v.fr}`);
    if (v.peso) parts.push(`${v.peso}kg`);
    if (v.mm) parts.push(v.mm);
    if (v.trc) parts.push(`TRC ${v.trc}s`);
    if (v.hid) parts.push(`Hid ${v.hid}`);
    if (v.dor) parts.push(`Dor ${v.dor}`);
    return parts.length ? parts.join(" · ") : "—";
  }

  const VITALS_FIELD_IDS = ["v_temp","v_fc","v_fr","v_peso","v_mm","v_trc","v_hid","v_dor"];

  function vitalsMatch(a, b){
    const va = a || {};
    const vb = b || {};
    return ['temp','fc','fr','peso','mm','trc','hid','dor'].every(k => String(va[k] ?? '').trim() === String(vb[k] ?? '').trim());
  }

  function refreshVitalsResumoStatus(aid){
    aid = aid || getActiveAnimalIdForVitals();
    const label = $('uiVitalsResumo');
    if(!label || !aid) return;
    const current = ATD.vitals_by_animal[aid] || null;
    if(current){
      label.textContent = vitalsResumo(current);
      return;
    }
    const pending = !!ATD.vitals_prefill_pending_by_animal?.[aid];
    const dirty = !!ATD.vitals_prefill_dirty_by_animal?.[aid];
    const prefill = ATD.vitals_prefill_by_animal?.[aid] || null;
    if(pending && prefill){
      label.textContent = dirty
        ? 'Histórico ajustado no formulário · salvar ou aplicar para registrar'
        : 'Histórico carregado · clique Aplicar se os dados permanecerem iguais';
      return;
    }
    label.textContent = prefill ? vitalsResumo(prefill) : '—';
  }

  function markVitalsPrefillDirty(){
    const aid = getActiveAnimalIdForVitals();
    if(!aid || !ATD.vitals_prefill_pending_by_animal?.[aid]) return;
    const current = vitalsReadFromUI();
    const original = ATD.vitals_prefill_by_animal?.[aid] || null;
    ATD.vitals_prefill_dirty_by_animal[aid] = !vitalsMatch(current, original);
    refreshVitalsResumoStatus(aid);
  }

  async function fetchVitalsHistory(db, animalId){
    if(!db || !animalId || !hasStore(db, "animal_vitals_history")) return [];
    const all = await idbGetAll(db, "animal_vitals_history");
    return (Array.isArray(all) ? all : []).filter(x => String(x?.animal_id||"") === String(animalId||"")).sort((a,b)=>String(b?.recorded_at||b?.updated_at||"").localeCompare(String(a?.recorded_at||a?.updated_at||"")));
  }

  function renderVitalsHistoryUI(rows){
    const box = $("vitalsHistoryList");
    if(box) box.innerHTML = rows && rows.length ? rows.slice(0,6).map(r => `<div style="padding:8px 0;border-bottom:1px solid #e2e8f0;"><b>${fmtDate(r.recorded_at||r.updated_at||"")}</b><div>${esc(vitalsResumo(r))}</div></div>`).join("") : "Nenhum histórico clínico.";
    const prev = rows && rows.length ? rows[0] : null;
    $("v_peso_prev") && ($("v_peso_prev").value = prev && prev.peso ? String(prev.peso).replace('.',',') + ' kg' : '—');
    const atual = toNumPt($("v_peso")?.value);
    const delta = (prev && prev.peso && atual) ? (atual - Number(prev.peso)) : null;
    $("v_peso_delta") && ($("v_peso_delta").value = (delta==null || !isFinite(delta)) ? '—' : ((delta>0?'+':'') + String(delta.toFixed(1)).replace('.',',') + ' kg'));
    $("v_last_seen") && ($("v_last_seen").value = prev ? fmtDate(prev.recorded_at||prev.updated_at||"") : '—');
  }

  function vitalsHasContent(v){
    if(!v) return false;
    return ['temp','fc','fr','peso','mm','trc','hid','dor'].some(k => {
      const value = v[k];
      return value !== '' && value != null && !(typeof value === 'number' && value === 0);
    });
  }

  async function persistVitalsSnapshot(db, aid, v, source){
    if(!db || !aid || !vitalsHasContent(v) || !hasStore(db, 'animal_vitals_history')) return;
    const id = `${ATD.atendimento_id || 'draft'}::${aid}`;
    await idbPut(db, 'animal_vitals_history', Object.assign({
      id,
      animal_id: aid,
      atendimento_id: ATD.atendimento_id || null,
      recorded_at: ATD.data_atendimento ? `${ATD.data_atendimento}T12:00:00` : isoNow(),
      updated_at: isoNow(),
      user_id: ATD.responsavel_user_id || null,
      source: source || 'save'
    }, v));
  }

  function captureActiveVitalsFromUI(){
    const aid = getActiveAnimalIdForVitals();
    if(!aid) return null;
    const v = vitalsReadFromUI();
    const pending = !!ATD.vitals_prefill_pending_by_animal?.[aid];
    const dirty = !!ATD.vitals_prefill_dirty_by_animal?.[aid];
    if(vitalsHasContent(v)){
      if(pending && !dirty){
        delete ATD.vitals_by_animal[aid];
        refreshVitalsResumoStatus(aid);
        return { aid, v:null, skipped_prefill:true };
      }
      ATD.vitals_by_animal[aid] = v;
      delete ATD.vitals_prefill_by_animal[aid];
      delete ATD.vitals_prefill_pending_by_animal[aid];
      delete ATD.vitals_prefill_dirty_by_animal[aid];
      refreshVitalsResumoStatus(aid);
      return { aid, v };
    }
    if(!pending){
      delete ATD.vitals_by_animal[aid];
    }
    refreshVitalsResumoStatus(aid);
    return { aid, v:null };
  }

  async function captureAllVitalsForSave(db){
    const current = captureActiveVitalsFromUI();
    if(current && current.v){
      try{ await persistVitalsSnapshot(db, current.aid, current.v, 'save'); }catch(_){ }
    }
  }

  async function loadVitalsForActiveAnimal() {
    const aid = getActiveAnimalIdForVitals();
    setVitalsVisible(!!aid);
    if (!aid) { $('uiVitalsResumo') && ($('uiVitalsResumo').textContent = '—'); renderVitalsHistoryUI([]); renderExecutivePanels(_dbRef).catch(()=>{}); return; }
    renderVitalsAnimalSelector();
    try{
      const db = await window.VSC_DB.openDB();
      const hist = await fetchVitalsHistory(db, aid);
      const current = ATD.vitals_by_animal[aid] || null;
      const prefill = !current && hist.length ? hist[0] : null;
      if(current){
        vitalsWriteToUI(current);
        delete ATD.vitals_prefill_by_animal[aid];
        delete ATD.vitals_prefill_pending_by_animal[aid];
        delete ATD.vitals_prefill_dirty_by_animal[aid];
      }else if(prefill){
        ATD.vitals_prefill_by_animal[aid] = prefill;
        ATD.vitals_prefill_pending_by_animal[aid] = true;
        ATD.vitals_prefill_dirty_by_animal[aid] = false;
        vitalsWriteToUI(prefill);
      }else{
        vitalsWriteToUI(null);
        delete ATD.vitals_prefill_by_animal[aid];
        delete ATD.vitals_prefill_pending_by_animal[aid];
        delete ATD.vitals_prefill_dirty_by_animal[aid];
      }
      refreshVitalsResumoStatus(aid);
      renderVitalsHistoryUI(hist);
      try{ db.close(); }catch(_){}
    }catch(_){ renderVitalsHistoryUI([]); }
  }

  async function applyVitalsFromUI() {
    const aid = getActiveAnimalIdForVitals();
    if (!aid) { snack('Selecione um animal para registrar vitais.', 'err'); return; }
    const v = vitalsReadFromUI();
    if(!vitalsHasContent(v) && ATD.vitals_prefill_by_animal[aid]){
      vitalsWriteToUI(ATD.vitals_prefill_by_animal[aid]);
      ATD.vitals_by_animal[aid] = Object.assign({}, ATD.vitals_prefill_by_animal[aid], { updated_at: isoNow() });
    } else {
      ATD.vitals_by_animal[aid] = v;
    }
    delete ATD.vitals_prefill_by_animal[aid];
    delete ATD.vitals_prefill_pending_by_animal[aid];
    delete ATD.vitals_prefill_dirty_by_animal[aid];
    refreshVitalsResumoStatus(aid);
    try{
      const db = await window.VSC_DB.openDB();
      await persistVitalsSnapshot(db, aid, ATD.vitals_by_animal[aid], 'apply');
      const hist = await fetchVitalsHistory(db, aid);
      renderVitalsHistoryUI(hist);
      try{ db.close(); }catch(_){}
    }catch(_){ }
    snack('Sinais vitais confirmados para este atendimento.', 'ok');
  }

  function clearVitalsUI() {
    const aid = getActiveAnimalIdForVitals();
    vitalsWriteToUI(null);
    if(aid){
      delete ATD.vitals_by_animal[aid];
      delete ATD.vitals_prefill_by_animal[aid];
      delete ATD.vitals_prefill_pending_by_animal[aid];
      delete ATD.vitals_prefill_dirty_by_animal[aid];
    }
    refreshVitalsResumoStatus(aid);
  }


  // ─── CATÁLOGO + MODAL ITEM ────────────────────────────────────────────
  const STORE_MAP = {
    PRODUTO: { store: "produtos_master", priceField: "venda_cents", nameField: "nome", idField: "produto_id" },
    SERVICO: { store: "servicos_master", priceField: "preco_base_cents", nameField: "nome", idField: "id" },
    EXAME: { store: "exames_master", priceField: "venda_cents", nameField: "nome", idField: "id" }
  };

  let _catalogCache = {};
  let _selectedCatalogItem = null;

  async function loadCatalogForTipo(db, tipo) {
    if (_catalogCache[tipo]) return _catalogCache[tipo];
    const cfg = STORE_MAP[tipo];
    if (!cfg || !hasStore(db, cfg.store)) return [];
    const all = await idbGetAll(db, cfg.store);
    const items = (Array.isArray(all) ? all : [])
      .filter(r => r && !r.deleted_at && r.ativo !== false && r.ativo !== 0)
      .map(r => ({
        id: String(r[cfg.idField] || r.id || r.produto_id || ""),
        nome: String(r[cfg.nameField] || ""),
        preco_cents: Number(r[cfg.priceField] || 0),
        tipo,
        tipo_produto: String(r.tipo_produto || "").toLowerCase(),
        categoria: String(r.categoria || ""),
        // para produtos: saldo de estoque
        saldo_estoque: r.saldo_estoque != null ? Number(r.saldo_estoque) : null
      })).filter(r => r.id);
    _catalogCache[tipo] = items;
    return items;
  }

  function renderItemResults(items, q) {
    const el = $("item_results");
    if (!el) return;
    if (!items.length) {
      el.innerHTML = `<div class="item-result-empty">Nenhum item encontrado no catálogo.</div>`;
      return;
    }
    const filtered = q ? items.filter(i => norm(i.nome).includes(norm(q))) : items;
    if (!filtered.length) {
      el.innerHTML = `<div class="item-result-empty">Nenhum resultado para "${q}".</div>`;
      return;
    }
    el.innerHTML = filtered.slice(0, 50).map(item => {
      const preco = fmtBRL(item.preco_cents / 100);
      const stock = item.saldo_estoque != null
        ? `<span class="item-result-stock">${item.saldo_estoque > 0 ? item.saldo_estoque + " em estoque" : "⚠ sem estoque"}</span>` : "";
      const isSel = _selectedCatalogItem?.id === item.id;
      return `<div class="item-result-row${isSel ? " is-sel" : ""}" data-catalog-id="${esc(item.id)}" data-tipo="${esc(item.tipo)}">
        <span class="item-result-name">${esc(item.nome)}</span>
        ${stock}
        <span class="item-result-price">${preco}</span>
      </div>`;
    }).join("");
  }

  function selectCatalogItem(item) {
    _selectedCatalogItem = item;
    const ajuste = $("item_ajuste");
    if (ajuste) ajuste.classList.remove("hidden");
    $("item_desc") && ($("item_desc").value = item.nome);
    $("item_qtd") && ($("item_qtd").value = "1");
    const vu = item.preco_cents / 100;
    $("item_vu") && ($("item_vu").value = String(vu).replace(".", ","));
    updateItemSubtotal();
    $("btnItemAdd") && ($("btnItemAdd").disabled = false);
  }

  function updateItemSubtotal() {
    const qtd = Math.max(0, toNumPt($("item_qtd")?.value));
    const vu = Math.max(0, toNumPt($("item_vu")?.value));
    $("item_subtotal") && ($("item_subtotal").value = fmtBRL(qtd * vu));
  }

  function openItemModal() {
    const m = $("vscItemModal"); if (!m) return;
    _selectedCatalogItem = null;
    m.classList.remove("hidden"); m.setAttribute("aria-hidden", "false");
    // Reset
    $("item_tipo") && ($("item_tipo").value = "PRODUTO");
    $("item_busca") && ($("item_busca").value = "");
    $("item_desc") && ($("item_desc").value = "");
    $("item_qtd") && ($("item_qtd").value = "1");
    $("item_vu") && ($("item_vu").value = "0");
    $("item_subtotal") && ($("item_subtotal").value = "R$ 0,00");
    $("item_ajuste")?.classList.add("hidden");
    $("item_results") && ($("item_results").innerHTML = `<div class="item-result-empty">Selecione um tipo acima e busque.</div>`);
    $("btnItemAdd") && ($("btnItemAdd").disabled = true);
    // Ativar primeiro tipo
    document.querySelectorAll(".item-tipo-btn").forEach(b => b.classList.remove("active-tipo--PRODUTO", "active-tipo--SERVICO", "active-tipo--EXAME"));
    document.querySelector('.item-tipo-btn[data-tipo="PRODUTO"]')?.classList.add("active-tipo--PRODUTO");
    setTimeout(() => $("item_busca")?.focus(), 40);
  }

  function closeItemModal() {
    _editItemIdx = null;
    const m = $("vscItemModal"); if (!m) return;
    m.classList.add("hidden"); m.setAttribute("aria-hidden", "true");
    _selectedCatalogItem = null;
    // restaurar título e botão
    const titleEl = m.querySelector(".modal__title");
    if (titleEl) titleEl.textContent = "Adicionar item";
    $("btnItemAdd") && ($("btnItemAdd").textContent = "Adicionar item");
    $("btnItemAdd") && ($("btnItemAdd").disabled = true);
  }

  function addItemFromModal() {
    const tipo = String($("item_tipo")?.value || "PRODUTO");
    const desc = String($("item_desc")?.value || "").trim();
    const qtd = Math.max(0, toNumPt($("item_qtd")?.value));
    const vu = Math.max(0, toNumPt($("item_vu")?.value));
    if (!desc) { snack("Informe a descrição do item.", "err"); return; }
    if (!qtd || qtd <= 0) { snack("Quantidade inválida.", "err"); return; }

    // Modo editar
    if (_editItemIdx !== null && _editItemIdx >= 0 && _editItemIdx < ATD.itens.length) {
      ATD.itens[_editItemIdx].desc = desc;
      ATD.itens[_editItemIdx].qtd = qtd;
      ATD.itens[_editItemIdx].vu = vu;
      ATD.itens[_editItemIdx].tipo = tipo;
      renderItens();
      closeEditItemModal();
      snack("Item atualizado.", "ok");
      return;
    }

    // Modo adicionar: verificar duplicata
    const catalogId = _selectedCatalogItem?.id || null;
    const dupIdx = catalogId
      ? ATD.itens.findIndex(it => it.catalog_id === catalogId && it.tipo === tipo)
      : ATD.itens.findIndex(it => norm(it.desc) === norm(desc) && it.tipo === tipo);

    if (dupIdx >= 0) {
      // Perguntar se deseja somar ao existente
      const dup = ATD.itens[dupIdx];
      const existeQtd = dup.qtd;
      if (window.confirm(`"${desc}" já está lançado (qtd atual: ${existeQtd}).\n\nDeseja ADICIONAR ${qtd} à quantidade existente (total: ${existeQtd + qtd})?\n\nOK = Somar  |  Cancelar = Adicionar separado`)) {
        ATD.itens[dupIdx].qtd = existeQtd + qtd;
        renderItens();
        closeItemModal();
        snack(`Quantidade atualizada: ${existeQtd + qtd}.`, "ok");
        return;
      }
    }

    const newItem = {
      id: uuidv4(),
      tipo,
      desc,
      qtd,
      vu,
      catalog_id: catalogId,
      tipo_produto: _selectedCatalogItem?.tipo_produto || "",
      categoria: _selectedCatalogItem?.categoria || ""
    };
    ATD.itens.push(newItem);
    renderItens();
    closeItemModal();
    snack("Item adicionado.", "ok");
    const isVaccine = tipo === "PRODUTO" && (String(newItem.tipo_produto||"").toLowerCase() === "vacina" || String(newItem.categoria||"").toLowerCase().includes("vacin"));
    if(isVaccine) openVaccineModalForItem(newItem);
  }

  let _pendingVaccineItem = null;

  function openVaccineModalForItem(item){
    const m = $("vscVaccineModal"); if(!m) return;
    _pendingVaccineItem = item || null;
    $("vac_nome") && ($("vac_nome").value = String(item?.desc || item?.nome || ""));
    $("vac_data") && ($("vac_data").value = toYMD(ATD.data_atendimento || isoNow()) || todayYMD());
    $("vac_lote") && ($("vac_lote").value = "");
    $("vac_proxima") && ($("vac_proxima").value = "");
    $("vac_obs") && ($("vac_obs").value = "");
    const aid = getActiveAnimalIdForVitals() || (ATD.animal_ids||[])[0] || "";
    const an = MODAL_ALL.find(x => String(x.id) === String(aid||""));
    $("vscVaccineHint") && ($("vscVaccineHint").textContent = aid ? `Registrar aplicação para ${an ? an.nome : 'animal selecionado'}.` : 'Selecione um animal antes de registrar.');
    m.classList.remove("hidden"); m.setAttribute("aria-hidden","false");
  }

  function closeVaccineModal(){
    const m=$("vscVaccineModal"); if(!m) return;
    m.classList.add("hidden"); m.setAttribute("aria-hidden","true");
    _pendingVaccineItem = null;
  }

  async function saveVaccineModal(){
    const aid = getActiveAnimalIdForVitals() || (ATD.animal_ids||[])[0] || "";
    if(!aid){ snack("Selecione um animal para registrar a vacina.", "err"); return; }
    const item = _pendingVaccineItem;
    if(!item){ closeVaccineModal(); return; }
    const ev = {
      id: uuidv4(),
      item_id: item.id,
      animal_id: aid,
      atendimento_id: ATD.atendimento_id || null,
      produto_id: item.catalog_id || null,
      vacina_nome: String($("vac_nome")?.value || item.desc || "").trim(),
      lote: String($("vac_lote")?.value || "").trim(),
      data_aplicacao: String($("vac_data")?.value || toYMD(ATD.data_atendimento || isoNow()) || "").trim(),
      proxima_dose: String($("vac_proxima")?.value || "").trim(),
      observacao: String($("vac_obs")?.value || "").trim(),
      created_at: isoNow(),
      user_id: ATD.responsavel_user_id || null
    };
    ATD.vaccine_events = (ATD.vaccine_events||[]).filter(v => String(v.item_id||"") !== String(item.id));
    ATD.vaccine_events.push(ev);
    try{
      const db = await window.VSC_DB.openDB();
      if(hasStore(db, "animal_vaccines")) await idbPut(db, "animal_vaccines", ev);
      try{ db.close(); }catch(_){}
    }catch(_){ }
    closeVaccineModal();
    snack("Vacinação registrada.", "ok");
  }

  function wireItensOnce(getDb) {
    if (wireItensOnce.__wired) return;
    wireItensOnce.__wired = true;

    $("btnAddItem")?.addEventListener("click", (ev) => { ev.preventDefault(); openItemModal(); });
    $("vscItemModalClose")?.addEventListener("click", (ev) => { ev.preventDefault(); closeItemModal(); });
    $("btnItemCancel")?.addEventListener("click", (ev) => { ev.preventDefault(); closeItemModal(); });
    $("btnItemAdd")?.addEventListener("click", (ev) => { ev.preventDefault(); addItemFromModal(); });
    $("vscItemModal")?.addEventListener("click", (ev) => { if (ev.target === $("vscItemModal")) closeItemModal(); });

    // Selecionar tipo
    document.querySelectorAll(".item-tipo-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const tipo = btn.getAttribute("data-tipo");
        $("item_tipo") && ($("item_tipo").value = tipo);
        document.querySelectorAll(".item-tipo-btn").forEach(b => b.classList.remove("active-tipo--PRODUTO", "active-tipo--SERVICO", "active-tipo--EXAME"));
        btn.classList.add("active-tipo--" + tipo);
        _selectedCatalogItem = null;
        $("item_ajuste")?.classList.add("hidden");
        $("btnItemAdd") && ($("btnItemAdd").disabled = true);
        try {
          const db = getDb();
          const items = await loadCatalogForTipo(db, tipo);
          renderItemResults(items, $("item_busca")?.value || "");
        } catch (_) { $("item_results") && ($("item_results").innerHTML = `<div class="item-result-empty">Erro ao carregar catálogo.</div>`); }
      });
    });

    // Buscar
    let _itemDebTo = null;
    $("item_busca")?.addEventListener("input", async (ev) => {
      clearTimeout(_itemDebTo);
      const q = ev.target.value;
      const tipo = String($("item_tipo")?.value || "PRODUTO");
      _itemDebTo = setTimeout(async () => {
        try {
          const db = getDb();
          const items = await loadCatalogForTipo(db, tipo);
          renderItemResults(items, q);
        } catch (_) { }
      }, 120);
    });

    // Selecionar item
    $("item_results")?.addEventListener("click", (ev) => {
      let t = ev.target;
      while (t && t !== $("item_results") && !t.getAttribute("data-catalog-id")) t = t.parentNode;
      if (!t || t === $("item_results")) return;
      const id = t.getAttribute("data-catalog-id");
      const tipo = String($("item_tipo")?.value || "PRODUTO");
      const items = _catalogCache[tipo] || [];
      const item = items.find(x => x.id === id);
      if (item) selectCatalogItem(item);
      // Remark selected
      document.querySelectorAll("#item_results .item-result-row").forEach(r => r.classList.remove("is-sel"));
      t.classList.add("is-sel");
    });

    // Subtotal ao digitar
    $("item_qtd")?.addEventListener("input", updateItemSubtotal);
    $("item_vu")?.addEventListener("input", updateItemSubtotal);

    // Remover item (via overlay de ação)
    $("tb_itens")?.addEventListener("click", (ev) => {
      let t = ev.target;
      while (t && t !== $("tb_itens") && !t.getAttribute("data-item-idx")) t = t.parentNode;
      if (!t || !t.getAttribute) return;
      const idx = Number(t.getAttribute("data-item-idx"));
      if (Number.isFinite(idx) && idx >= 0 && idx < ATD.itens.length) {
        confirmItemAction(idx);
      }
    });

    // Wire overlay de ação do item
    $("vscItemActionOverlay")?.addEventListener("click", (ev) => {
      if (ev.target === $("vscItemActionOverlay")) {
        $("vscItemActionOverlay")?.classList.add("hidden");
      }
    });
    $("btnItemActionDelete")?.addEventListener("click", () => {
      const ov = $("vscItemActionOverlay");
      const idx = ov?._idx;
      if (Number.isFinite(idx) && idx >= 0 && idx < ATD.itens.length) {
        const rem = ATD.itens[idx];
        ATD.itens.splice(idx, 1);
        if(rem && rem.id) ATD.vaccine_events = (ATD.vaccine_events||[]).filter(v => String(v.item_id||"") !== String(rem.id));
        renderItens();
        snack("Item removido.", "ok");
      }
      ov?.classList.add("hidden");
    });
    $("btnItemActionEdit")?.addEventListener("click", () => {
      const ov = $("vscItemActionOverlay");
      const idx = ov?._idx;
      ov?.classList.add("hidden");
      if (Number.isFinite(idx)) openEditItemModal(idx);
    });
    $("btnItemActionCancel")?.addEventListener("click", () => {
      $("vscItemActionOverlay")?.classList.add("hidden");
    });

    // Totais
    $("desconto_tipo")?.addEventListener("change", updateTotaisUI);
    $("desconto_valor")?.addEventListener("input", () => debounce(updateTotaisUI, 120));
    $("desl_km")?.addEventListener("input", () => debounce(updateDeslocamento, 120));
  }

  // ─── MODAL EDITAR ITEM ────────────────────────────────────────────────
  let _editItemIdx = null;

  function openEditItemModal(idx) {
    const it = ATD.itens[idx];
    if (!it) return;
    _editItemIdx = idx;

    // reutilizar o modal existente como "editar"
    const m = $("vscItemModal"); if (!m) return;
    m.classList.remove("hidden"); m.setAttribute("aria-hidden", "false");

    // mudar título
    const titleEl = m.querySelector(".modal__title");
    if (titleEl) titleEl.textContent = "Editar item";

    // limpar catálogo e mostrar ajuste direto
    $("item_tipo") && ($("item_tipo").value = it.tipo);
    $("item_busca") && ($("item_busca").value = "");
    $("item_results") && ($("item_results").innerHTML = `<div class="item-result-empty">Editando item existente — ajuste abaixo.</div>`);
    $("item_ajuste")?.classList.remove("hidden");
    $("item_desc") && ($("item_desc").value = it.desc);
    $("item_qtd") && ($("item_qtd").value = String(it.qtd).replace(".", ","));
    $("item_vu") && ($("item_vu").value = String(it.vu).replace(".", ","));
    updateItemSubtotal();

    // desativar tipos (já editando item)
    document.querySelectorAll(".item-tipo-btn").forEach(b => {
      b.classList.remove("active-tipo--PRODUTO", "active-tipo--SERVICO", "active-tipo--EXAME");
      if (b.getAttribute("data-tipo") === it.tipo) b.classList.add("active-tipo--" + it.tipo);
    });

    $("btnItemAdd") && ($("btnItemAdd").disabled = false);
    $("btnItemAdd") && ($("btnItemAdd").textContent = "Salvar alteração");

    _selectedCatalogItem = { id: it.catalog_id };
    setTimeout(() => $("item_qtd")?.focus(), 40);
  }

  function closeEditItemModal() {
    _editItemIdx = null;
    const m = $("vscItemModal"); if (!m) return;
    m.classList.add("hidden"); m.setAttribute("aria-hidden", "true");
    // restaurar título
    const titleEl = m.querySelector(".modal__title");
    if (titleEl) titleEl.textContent = "Adicionar item";
    $("btnItemAdd") && ($("btnItemAdd").textContent = "Adicionar item");
  }

  // ─── CONFIRM DIALOG NATIVO (item grid) ──────────────────────────────
  function confirmItemAction(idx) {
    const it = ATD.itens[idx];
    if (!it) return;
    const tipo = it.tipo;
    const desc = it.desc || "";

    const ov = $("vscItemActionOverlay");
    if (!ov) {
      // fallback
      const choice = window.confirm(`Deseja EXCLUIR "${desc}"?\n\nOK = Excluir | Cancelar = Alterar`);
      if (choice) {
        const rem = ATD.itens[idx];
        ATD.itens.splice(idx, 1);
        if(rem && rem.id) ATD.vaccine_events = (ATD.vaccine_events||[]).filter(v => String(v.item_id||"") !== String(rem.id));
        renderItens();
        snack("Item removido.", "ok");
      } else {
        openEditItemModal(idx);
      }
      return;
    }

    const nameEl = $("itemActionName");
    if (nameEl) nameEl.textContent = desc;
    const tipoEl = $("itemActionTipo");
    if (tipoEl) tipoEl.textContent = tipo;

    ov.classList.remove("hidden");
    ov._idx = idx;
  }


  function itensSubtotal() {
    let s = 0;
    for (let i = 0; i < ATD.itens.length; i++) { s += Number(ATD.itens[i].qtd || 0) * Number(ATD.itens[i].vu || 0); }
    return s;
  }

  function calcDesconto(base) {
    const tipo = String($("desconto_tipo")?.value || ATD.desconto_tipo || "R$");
    const v = toNumPt($("desconto_valor")?.value);
    ATD.desconto_tipo = tipo; ATD.desconto_valor = v;
    if (!v) return 0;
    if (tipo === "%") return base * (Math.max(0, Math.min(100, v)) / 100);
    return Math.max(0, v);
  }

  function updateDeslocamento() {
    const km = Math.max(0, toNumPt($("desl_km")?.value || "0"));
    ATD.desl_km = km;
    ATD.deslocamento = km * ATD.desl_valor_km;
    $("deslocamento") && ($("deslocamento").value = ATD.deslocamento > 0 ? String(ATD.deslocamento.toFixed(2)).replace(".", ",") : "0");
    updateTotaisUI();
  }

  function updateTotaisUI() {
    const base = itensSubtotal();
    const desc = calcDesconto(base);
    const desl = ATD.deslocamento || Math.max(0, toNumPt($("deslocamento")?.value));
    const totalItens = Math.max(0, base);
    const totalGeral = Math.max(0, base - desc + desl);

    $("total_itens") && ($("total_itens").textContent = fmtBRL(totalItens));
    $("ui_desconto_calc") && ($("ui_desconto_calc").textContent = "− " + fmtBRL(desc));
    $("ui_desl_calc") && ($("ui_desl_calc").textContent = "+ " + fmtBRL(desl));
    $("total_geral") && ($("total_geral").textContent = fmtBRL(totalGeral));
    renderExecutivePanels(_dbRef).catch(()=>{});
  }

  function renderItens() {
    const tb = $("tb_itens");
    if (!tb) return;
    if (!ATD.itens.length) {
      tb.innerHTML = `<tr><td colspan="5" style="padding:16px;" class="hint">Nenhum item lançado. Clique em "+ Adicionar item" para incluir.</td></tr>`;
      updateTotaisUI(); return;
    }
    tb.innerHTML = ATD.itens.map((it, idx) => {
      const sub = Number(it.qtd || 0) * Number(it.vu || 0);
      return `<tr class="item-row-clickable" data-item-idx="${idx}" style="cursor:pointer;" title="Clique para editar ou excluir">
        <td><span class="tipo-pill tipo-pill--${esc(it.tipo)}">${esc(it.tipo)}</span></td>
        <td>${esc(it.desc || "")}</td>
        <td>${esc(String(it.qtd || 0))}</td>
        <td class="mono" style="font-size:12px;">${esc(String(it.vu > 0 ? it.vu.toFixed(2).replace(".", ",") : "0,00"))}</td>
        <td class="mono" style="font-size:12px;">${esc(String(sub > 0 ? sub.toFixed(2).replace(".", ",") : "0,00"))}</td>
      </tr>`;
    }).join("");
    updateTotaisUI();
  }


  // ─── DESLOCAMENTO (config_params) ─────────────────────────────────────
  // Regra: buscar valor vigente em Configurações (date-effective), tolerando legado.
  // Aceita chaves compatíveis e registros sem valid_from (assume sempre vigente).
  async function carregarValorKm(db) {
    if (!hasStore(db, "config_params")) return 0;

    const rows = await idbGetAll(db, "config_params");
    const today = todayYMD();

    const KEYS = new Set([
      "deslocamento_valor",      // chave canônica
      "deslocamento_valor_km",   // compat
      "valor_km_deslocamento",   // compat
      "km_deslocamento_valor"    // compat
    ]);

    // Preferir "financeiro" se existir em alguma coluna (tolerância: section/modulo/grupo)
    function isFinanceiro(r){
      const s = String(r?.section || r?.modulo || r?.grupo || "").toLowerCase();
      if(!s) return true; // se não existir, não filtra (legado)
      return s.includes("finan");
    }

    function parseValue(v){
      // tolera decimal com vírgula, string, number
      const n = toNumPt(String(v ?? "0"));
      return Number.isFinite(n) ? n : 0;
    }

    const vigentes = (Array.isArray(rows) ? rows : []).filter(r => {
      const k = String(r?.key || r?.nome || r?.param || "").trim();
      if (!KEYS.has(k)) return false;
      if (!isFinanceiro(r)) return false;

      const vf = String(r?.valid_from || r?.vigencia_inicio || "").trim();
      const vt = String(r?.valid_to || r?.vigencia_fim || "").trim();

      // sem valid_from => sempre vigente (legado)
      if (vf && today < vf) return false;
      if (vt && today > vt) return false;

      return true;
    });

    if (!vigentes.length) return 0;

    // Ordenação: valid_from desc (quando existir), senão updated_at/created_at
    function ordKey(r){
      const vf = String(r?.valid_from || r?.vigencia_inicio || "");
      if(vf) return vf;
      return String(r?.updated_at || r?.created_at || "");
    }
    vigentes.sort((a, b) => String(ordKey(b)).localeCompare(String(ordKey(a))));

    return parseValue(vigentes[0].value);
  }

  // ─── MOVIMENTAÇÃO DE ESTOQUE ──────────────────────────────────────────
  async function movimentarEstoque(db, itens, sentido) {
    // sentido: "baixar" ou "estornar"
    const produtosItens = itens.filter(it => it.tipo === "PRODUTO" && it.catalog_id);
    if (!produtosItens.length) return { ok: true, movs: 0 };
    if (!hasStore(db, "produtos_master")) return { ok: false, msg: "Store produtos_master não encontrada." };

    // Usa VSC_ESTOQUE (estoque_core.js) quando disponível — garante ledger correto
    if (window.VSC_ESTOQUE && typeof window.VSC_ESTOQUE.registrarSaida === "function") {
      let movs = 0;
      for (const it of produtosItens) {
        if (!it.catalog_id || Number(it.qtd||0) <= 0) continue;
        try {
          const fn = sentido === "baixar" ? window.VSC_ESTOQUE.registrarSaida : window.VSC_ESTOQUE.registrarEntrada;
          await fn({
            produto_id: it.catalog_id,
            produto_nome: it.desc || "",
            qtd: Number(it.qtd || 0),
            origem: "ATENDIMENTO",
            ref_id: ATD.atendimento_id,
            ref_numero: ATD.numero || "",
            responsavel_user_id: ATD.responsavel_user_id || null,
            custo_unit_cents: Number(it.custo_cents || 0)
          });
          movs++;
        } catch(e) { console.warn("[ATD] VSC_ESTOQUE erro:", it.catalog_id, e); }
      }
      _catalogCache["PRODUTO"] = null;
      return { ok: true, movs };
    }

    let movs = 0;
    const now = isoNow();
    const tipoMov = sentido === "baixar" ? "SAIDA" : "ENTRADA";

    for (const it of produtosItens) {
      try {
        const prod = await idbGet(db, "produtos_master", it.catalog_id);
        if (!prod) continue;
        const qty = Number(it.qtd || 0);
        if (qty <= 0) continue;

        // 1. Atualiza saldo_estoque no produto (cache denormalizado)
        const saldoAtual = Number(prod.saldo_estoque || 0);
        const novoSaldo = sentido === "baixar" ? Math.max(0, saldoAtual - qty) : saldoAtual + qty;
        prod.saldo_estoque = novoSaldo;
        prod.updated_at = now;
        await idbPut(db, "produtos_master", prod);

        // 2. Atualiza estoque_saldos (fonte canônica, alinhado com importacaoxml)
        if (hasStore(db, "estoque_saldos")) {
          try {
            const saldoKey = String(it.catalog_id) + ":sem-lote";
            const saldoRec = await idbGet(db, "estoque_saldos", saldoKey);
            const saldoBase = Number((saldoRec && saldoRec.saldo) || saldoAtual || 0);
            const novoSaldoRec = sentido === "baixar" ? Math.max(0, saldoBase - qty) : saldoBase + qty;
            await idbPut(db, "estoque_saldos", Object.assign({}, saldoRec || {}, {
              id: saldoKey,
              produto_id: it.catalog_id,
              lote_id: null,
              saldo: novoSaldoRec,
              updated_at: now,
              _origem: "atendimento"
            }));
          } catch(_) {}
        }

        // 3. Registra movimento individual em estoque_movimentos (store canonico)
        if (hasStore(db, "estoque_movimentos")) {
          try {
            const movItem = {
              id: uuidv4(),
              produto_id: it.catalog_id,
              produto_nome: it.desc || "",
              tipo: tipoMov,
              origem: "ATENDIMENTO",
              ref_id: ATD.atendimento_id,
              ref_numero: ATD.numero || "",
              responsavel_user_id: ATD.responsavel_user_id || null,
              qtd_delta: sentido === "baixar" ? -qty : qty,
              saldo_delta: novoSaldo - saldoAtual,
              custo_unit_cents: Number(it.custo_cents || 0),
              custo_total_cents: Math.round(Number(it.custo_cents || 0) * qty),
              created_at: now,
              updated_at: now,
              _origem: "atendimento"
            };
            await idbPut(db, "estoque_movimentos", movItem);
          } catch(_) {}
        }

        movs++;
      } catch (e) { console.warn("[ATD] estoque mov erro item:", it.catalog_id, e); }
    }

    // Limpar cache de catálogo para forçar releitura
    _catalogCache["PRODUTO"] = null;

    return { ok: true, movs };
  }

  // ─── GERAÇÃO DE CONTAS A RECEBER ──────────────────────────────────────
  async function gerarContasAReceber(db) {
    // Usa VSC_AR se disponível, caso contrário grava direto no IDB
    const base = itensSubtotal();
    const desc = calcDesconto(base);
    const desl = ATD.deslocamento || 0;
    const totalGeral = Math.max(0, base - desc + desl);
    const totalCents = Math.round(totalGeral * 100);

    const crId = ATD.cr_id || uuidv4();
    ATD.cr_id = crId;

    const titulo = {
      id: crId,
      documento: ATD.numero,
      cliente_nome: ATD.cliente_label || ATD._cliente_nome || "—",
      cliente_doc: "",
      competencia: todayYMD().slice(0, 7),
      vencimento: ATD.financeiro_vencimento || todayYMD(),
      valor_original_centavos: totalCents,
      saldo_centavos: totalCents,
      origem: "VSC_ATENDIMENTOS",
      ref_tipo: "atendimento",
      ref_id: ATD.atendimento_id,
      billing_cycle: ATD.financeiro_fechamento_modo || "gerar_agora",
      billing_mode: ATD.financeiro_gerado ? "imediato" : "posterior",
      payment_type: ATD.financeiro_tipo_pagamento || ATD.financeiro_preferencia_pagamento || "definir_depois",
      forma_pagamento: ATD.financeiro_tipo_pagamento || ATD.financeiro_preferencia_pagamento || "definir_depois",
      payment_preference: ATD.financeiro_preferencia_pagamento || ATD.financeiro_tipo_pagamento || "definir_depois",
      payment_terms: ATD.financeiro_condicao_pagamento || "avista",
      settlement_mode: ATD.financeiro_baixa_modo || "manual",
      installments: Math.max(1, Number(ATD.financeiro_parcelas || 1)),
      installment_interval_days: Math.max(0, Number(ATD.financeiro_intervalo_dias ?? 30)),
      entry_amount: Number(ATD.financeiro_valor_entrada || 0),
      charge_type: ATD.financeiro_tipo_cobranca || 'avulsa',
      allow_partial_payments: (ATD.financeiro_aceita_parcial || 'sim') === 'sim',
      custom_term_days: Math.max(0, Number(ATD.financeiro_prazo_custom_dias || 0)),
      obs: ((ATD.financeiro_observacao || "") ? ("Gerado automaticamente pelo módulo de atendimentos. " + ATD.financeiro_observacao) : "Gerado automaticamente pelo módulo de atendimentos."),
      cancelado: false,
      recebimentos: [],
      created_at: isoNow(),
      updated_at: isoNow()
    };

    // Tentar via VSC_AR primeiro
    if (window.VSC_AR && typeof window.VSC_AR.upsertTitulo === "function") {
      try {
        await window.VSC_AR.upsertTitulo(titulo);
        return { ok: true, via: "VSC_AR" };
      } catch (e) {
        // fallback para IDB direto
      }
    }

    // Fallback: gravar diretamente no store contas_receber
    if (hasStore(db, "contas_receber")) {
      await idbPut(db, "contas_receber", titulo);
      return { ok: true, via: "IDB_direto" };
    }

    return { ok: false, msg: "Store contas_receber não encontrada." };
  }

  async function cancelarContasAReceber(db) {
    if (!ATD.cr_id) return;
    try {
      const rec = await idbGet(db, "contas_receber", ATD.cr_id);
      if (!rec) return;
      rec.cancelado = true;
      rec.cancelado_at = isoNow();
      rec.cancelado_motivo = "Atendimento cancelado.";
      rec.updated_at = isoNow();
      if (window.VSC_AR && typeof window.VSC_AR.upsertTitulo === "function") {
        await window.VSC_AR.upsertTitulo(rec);
      } else if (hasStore(db, "contas_receber")) {
        await idbPut(db, "contas_receber", rec);
      }
    } catch (_) { }
  }


  function mapFinanceDecisionLabel(mode){
    switch(String(mode||'')){
      case 'gerar_agora': return 'Contas a receber gerado agora';
      case 'mensal': return 'Fechamento em lote mensal';
      case 'posterior': return 'Definir depois';
      default: return 'Em aberto';
    }
  }

  function syncFinanceChoiceVisualState(selectedValue){
    document.querySelectorAll('.finance-choice').forEach(card => {
      const input = card.querySelector('input[name="financeDecision"]');
      const active = !!input && String(input.value) === String(selectedValue || '');
      card.classList.toggle('is-selected', active);
    });
  }

  function syncFinanceTermsUI(){
    const terms = String($("financeDecisionTerms")?.value || ATD.financeiro_condicao_pagamento || "avista");
    const inst = $("financeDecisionInstallments");
    const interval = $("financeDecisionInstallmentInterval");
    const due = $("financeDecisionDueDate");
    const customDaysWrap = $("financeDecisionCustomDaysWrap");
    const customDays = $("financeDecisionCustomDays");
    const type = String($("financeDecisionChargeType")?.value || ATD.financeiro_tipo_cobranca || 'avulsa');
    if(customDaysWrap) customDaysWrap.style.display = terms === 'personalizado' ? '' : 'none';
    if(terms === "avista"){
      if(inst) inst.value = "1";
      if(interval) interval.value = "0";
      if(due) due.value = due.value || ATD.data_atendimento || todayYMD();
    }else if(terms === "semanal"){
      if(interval) interval.value = '7';
      if(due && !due.value) due.value = addDaysYMD(ATD.data_atendimento || todayYMD(), 7);
    }else if(terms === "quinzenal"){
      if(interval) interval.value = '15';
      if(due && !due.value) due.value = addDaysYMD(ATD.data_atendimento || todayYMD(), 15);
    }else if(terms === "mensal"){
      if(interval) interval.value = "30";
      if(due && !due.value) due.value = addDaysYMD(ATD.data_atendimento || todayYMD(), 30);
    }else if(terms === 'entrada_saldo'){
      if(inst && Number(inst.value || 1) < 2) inst.value = '2';
      if(interval && Number(interval.value || 0) === 0) interval.value = '30';
      if(due && !due.value) due.value = ATD.data_atendimento || todayYMD();
    }else if(terms === 'personalizado'){
      const days = Math.max(0, Number(customDays?.value || ATD.financeiro_prazo_custom_dias || 0));
      if(interval && Number(interval.value || 0) === 0 && Number(inst?.value || 1) > 1) interval.value = String(days || 30);
      if(due && !due.value) due.value = addDaysYMD(ATD.data_atendimento || todayYMD(), days || 30);
    }else if(/_dias$/.test(terms)){
      const days = Number(String(terms).split("_")[0] || 0);
      if(interval && Number(interval.value || 0) === 0 && Number(inst?.value || 1) > 1) interval.value = String(days || 30);
      if(due && !due.value) due.value = addDaysYMD(ATD.data_atendimento || todayYMD(), days);
    }
    if((type === 'faturamento_mensal' || type === 'recorrente_mensal') && interval && Number(interval.value || 0) < 30) interval.value = '30';
  }

  function chooseFinanceDecision(){
    const modal = $('vscFinanceDecisionModal');
    if(!modal) return Promise.resolve('gerar_agora');

    const current = String(ATD.financeiro_fechamento_modo || (ATD.financeiro_gerado ? 'gerar_agora' : 'posterior'));
    document.querySelectorAll('input[name="financeDecision"]').forEach(el => {
      el.checked = (el.value === current);
    });
    syncFinanceChoiceVisualState(current);

    $('financeDecisionObs') && ($('financeDecisionObs').value = String(ATD.financeiro_observacao || ''));
    $('financeDecisionPaymentMethod') && ($('financeDecisionPaymentMethod').value = String(ATD.financeiro_tipo_pagamento || ATD.financeiro_preferencia_pagamento || ''));
    $('financeDecisionTerms') && ($('financeDecisionTerms').value = String(ATD.financeiro_condicao_pagamento || 'avista'));
    $('financeDecisionSettlementMode') && ($('financeDecisionSettlementMode').value = String(ATD.financeiro_baixa_modo || 'manual'));
    $('financeDecisionDueDate') && ($('financeDecisionDueDate').value = String(ATD.financeiro_vencimento || ATD.data_atendimento || todayYMD()));
    $('financeDecisionInstallments') && ($('financeDecisionInstallments').value = String(Math.max(1, Number(ATD.financeiro_parcelas || 1))));
    $('financeDecisionInstallmentInterval') && ($('financeDecisionInstallmentInterval').value = String(Math.max(0, Number(ATD.financeiro_intervalo_dias ?? 30))));
    $('financeDecisionEntryAmount') && ($('financeDecisionEntryAmount').value = ATD.financeiro_valor_entrada ? formatFixedBR(Number(ATD.financeiro_valor_entrada || 0), 2) : '');
    $('financeDecisionChargeType') && ($('financeDecisionChargeType').value = String(ATD.financeiro_tipo_cobranca || 'avulsa'));
    $('financeDecisionAllowPartial') && ($('financeDecisionAllowPartial').value = String(ATD.financeiro_aceita_parcial || 'sim'));
    $('financeDecisionCustomDays') && ($('financeDecisionCustomDays').value = String(Math.max(0, Number(ATD.financeiro_prazo_custom_dias || 0))));

    document.querySelectorAll('.finance-choice').forEach(card => {
      const input = card.querySelector('input[name="financeDecision"]');
      if(!input) return;
      if(card.__vscFinanceBound) return;
      card.__vscFinanceBound = true;
      const activateChoice = () => { input.checked = true; syncFinanceChoiceVisualState(input.value); };
      card.addEventListener('click', activateChoice);
      input.addEventListener('change', () => syncFinanceChoiceVisualState(input.value));
      input.addEventListener('click', (ev) => ev.stopPropagation());
    });
    $('financeDecisionTerms')?.addEventListener('change', syncFinanceTermsUI);
    $('financeDecisionChargeType')?.addEventListener('change', syncFinanceTermsUI);
    $('financeDecisionCustomDays')?.addEventListener('input', syncFinanceTermsUI);
    syncFinanceTermsUI();

    return new Promise(resolve => {
      const confirmBtn = $('btnFinanceDecisionConfirm');
      const cancelBtn = $('btnFinanceDecisionCancel');
      const closeBtn = $('vscFinanceDecisionModalClose');
      let resolved = false;
      const cleanup = () => {
        modal.removeEventListener('click', onBackdropClick);
        document.removeEventListener('keydown', onKeydown);
        $('financeDecisionTerms')?.removeEventListener('change', syncFinanceTermsUI);
        $('financeDecisionChargeType')?.removeEventListener('change', syncFinanceTermsUI);
        $('financeDecisionCustomDays')?.removeEventListener('input', syncFinanceTermsUI);
        [confirmBtn, cancelBtn, closeBtn].forEach((btn) => {
          btn && btn.removeEventListener('click', btn === confirmBtn ? onConfirm : onCancel);
        });
      };
      const close = (result) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden','true');
        resolve(result || null);
      };
      const onConfirm = (ev) => {
        ev?.preventDefault?.();
        const sel = document.querySelector('input[name="financeDecision"]:checked');
        close(sel ? sel.value : 'gerar_agora');
      };
      const onCancel = (ev) => { ev?.preventDefault?.(); close(null); };
      const onBackdropClick = (ev) => { if (ev.target === modal) close(null); };
      const onKeydown = (ev) => {
        if (ev.key === 'Escape') close(null);
        if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') onConfirm(ev);
      };
      [confirmBtn, cancelBtn, closeBtn].forEach((btn) => {
        btn && btn.addEventListener('click', btn === confirmBtn ? onConfirm : onCancel);
      });
      modal.addEventListener('click', onBackdropClick);
      document.addEventListener('keydown', onKeydown);
      modal.classList.remove('hidden');
      modal.setAttribute('aria-hidden','false');
      confirmBtn?.focus?.();
    });
  }


  function getCurrentUserRoleFlags(){
    const u = ATD._currentUser || {};
    const candidates = [u.role, u.perfil, u.profile, u.user_role, u.userRole, u.tipo, u.type, u.username, u.slug, u.access_level, ...(Array.isArray(u.roles) ? u.roles : []), ...(Array.isArray(u.permissions) ? u.permissions : []), ...(Array.isArray(u.groups) ? u.groups : [])].flat().filter(Boolean).map(norm);
    const isMaster = candidates.some(v => ['master','empresa_master','superadmin','super_admin','owner','proprietario'].includes(v));
    const isAdmin = isMaster || candidates.some(v => ['admin','administrador','administrator','gestor'].includes(v));
    return { isMaster, isAdmin, labels: candidates };
  }

  function sumMoneyLikeCentavos(row){
    const candidates = [row?.valor_centavos, row?.valor_cents, row?.amount_centavos, row?.amount_cents, row?.valor_pago_centavos, row?.paid_centavos];
    for(const v of candidates){ const n = Number(v); if(Number.isFinite(n) && n) return n; }
    const money = [row?.valor, row?.amount, row?.valor_pago, row?.paid_amount];
    for(const v of money){ const n = toNumPt(v); if(Number.isFinite(n) && n) return Math.round(n * 100); }
    return 0;
  }

  async function getTituloFinanceiro(db){
    if(!db || !hasStore(db, 'contas_receber')) return null;
    let titulo = null;
    if(ATD.cr_id) titulo = await idbGet(db, 'contas_receber', ATD.cr_id);
    if(titulo) return titulo;
    const all = await idbGetAll(db, 'contas_receber');
    return (Array.isArray(all) ? all : []).find(x => String(x?.ref_id || '') === String(ATD.atendimento_id || '')) || null;
  }

  async function buildPaymentAlertData(db){
    const titulo = await getTituloFinanceiro(db);
    if(!titulo) return { titulo:null, hasPayments:false, totalPaidCentavos:0, balanceCentavos:0, originalCentavos:0, entries:[] };
    const entries = (Array.isArray(titulo.recebimentos) ? titulo.recebimentos : []).map((row, idx) => ({ idx: idx + 1, when: pickFirstNonEmpty(row?.data_recebimento, row?.received_at, row?.date, row?.created_at), method: pickFirstNonEmpty(row?.forma_pagamento, row?.payment_method, row?.metodo, row?.method, 'Não informado'), note: pickFirstNonEmpty(row?.observacao, row?.obs, row?.note), amountCentavos: sumMoneyLikeCentavos(row) }));
    const totalPaidCentavos = entries.reduce((acc, row) => acc + Math.max(0, Number(row.amountCentavos || 0)), 0);
    const originalCentavos = Number(titulo.valor_original_centavos || 0);
    const balanceCentavos = Number(titulo.saldo_centavos ?? Math.max(0, originalCentavos - totalPaidCentavos));
    return { titulo, hasPayments: totalPaidCentavos > 0, totalPaidCentavos, balanceCentavos, originalCentavos, entries };
  }

  function formatCentavos(centavos){ return fmtBRL(Number(centavos || 0) / 100); }

  function askPaymentAlterationApproval(data, roleFlags){
    const modal = $('vscPaymentAlertModal');
    if(!modal) return Promise.resolve(window.confirm('Há pagamentos vinculados a este atendimento. Deseja continuar a alteração?'));
    const summary = $('paymentAlertSummary');
    const details = $('paymentAlertDetails');
    const intro = $('paymentAlertIntro');
    const title = data?.titulo || {};
    const statusTxt = (data?.totalPaidCentavos || 0) >= (data?.originalCentavos || 0) && (data?.originalCentavos || 0) > 0 ? 'Pagamento total já lançado neste título.' : (data?.hasPayments ? 'Pagamento parcial já lançado neste título.' : 'Este atendimento possui título financeiro vinculado, mas ainda sem recebimentos.');
    intro.textContent = data?.hasPayments ? (statusTxt + ' Revise abaixo antes de reabrir o atendimento para alteração.') : statusTxt;
    if(summary){ summary.innerHTML = `<div><b>Título:</b> ${esc(title.documento || ATD.numero || '—')}</div><div><b>Valor original:</b> ${esc(formatCentavos(data?.originalCentavos || 0))}</div><div><b>Total recebido:</b> ${esc(formatCentavos(data?.totalPaidCentavos || 0))}</div><div><b>Saldo atual:</b> ${esc(formatCentavos(data?.balanceCentavos || 0))}</div><div><b>Perfil atual:</b> ${roleFlags.isMaster ? 'Master' : roleFlags.isAdmin ? 'Administrador' : 'Usuário padrão'}</div>`; }
    if(details){ details.innerHTML = (data?.entries || []).length ? data.entries.map(row => `<div style="padding:10px 12px;border:1px solid #e2e8f0;border-radius:12px;background:#fff;"><div style="font-weight:800;">Pagamento ${row.idx} · ${esc(formatCentavos(row.amountCentavos || 0))}</div><div class="hint" style="margin-top:4px;">${esc(fmtDateTime(row.when))} · ${esc(row.method || 'Não informado')}</div>${row.note ? `<div class="hint" style="margin-top:4px;">${esc(row.note)}</div>` : ''}</div>`).join('') : '<div class="hint">Nenhum recebimento registrado neste título.</div>'; }
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden','false');
    return new Promise(resolve => {
      let done = false;
      const ok = $('btnPaymentAlertConfirm');
      const cancel = $('btnPaymentAlertCancel');
      const close = $('vscPaymentAlertClose');
      const finish = (value) => { if(done) return; done = true; modal.classList.add('hidden'); modal.setAttribute('aria-hidden','true'); ok?.removeEventListener('click', onOk); cancel?.removeEventListener('click', onCancel); close?.removeEventListener('click', onCancel); modal.removeEventListener('click', onBackdrop); document.removeEventListener('keydown', onEsc); resolve(value); };
      const onOk = () => finish(true);
      const onCancel = () => finish(false);
      const onBackdrop = (ev) => { if(ev.target === modal) finish(false); };
      const onEsc = (ev) => { if(ev.key === 'Escape') finish(false); };
      ok?.addEventListener('click', onOk); cancel?.addEventListener('click', onCancel); close?.addEventListener('click', onCancel); modal.addEventListener('click', onBackdrop); document.addEventListener('keydown', onEsc);
    });
  }

  async function reabrirFinalizadoParaAlteracao(db){
    const roles = getCurrentUserRoleFlags();
    const payData = await buildPaymentAlertData(db);
    if(payData.hasPayments && !roles.isAdmin){
      await askPaymentAlterationApproval(payData, roles);
      snack('Este atendimento possui pagamentos vinculados. Somente master e administradores podem alterá-lo.', 'err');
      return;
    }
    if(payData.titulo){
      const ok = await askPaymentAlterationApproval(payData, roles);
      if(!ok) return;
    }else{
      const ok = await confirm('Reabrir atendimento finalizado', 'O atendimento voltará para Em atendimento para permitir alterações. O vínculo financeiro existente será mantido.');
      if(!ok) return;
    }
    ATD.status = 'em_atendimento';
    updateStatusBadges('em_atendimento');
    $('status') && ($('status').value = 'em_atendimento');
    await salvar(db, false);
    await recarregarLista(db);
    renderExecutivePanels(db).catch(()=>{});
    snack(payData.hasPayments ? 'Atendimento reaberto para alteração com alerta de pagamentos exibido.' : 'Atendimento reaberto para alteração.', 'ok');
  }

  // ─── MUDANÇA DE STATUS (LÓGICA CENTRAL) ──────────────────────────────
  async function mudarStatus(db, novoStatus, force) {
    const statusAtual = ATD.status;
    if (novoStatus === statusAtual && !force) return;

    // Validações mínimas
    if (!ATD.atendimento_id) { snack("Salve o atendimento primeiro.", "err"); return; }

    // Transições permitidas
    const permitido = {
      orcamento: ["em_atendimento", "finalizado", "cancelado"],
      em_atendimento: ["finalizado", "orcamento", "cancelado"],
      finalizado: ["cancelado"],
      cancelado: []
    };
    const perm = permitido[statusAtual] || [];
    if (!perm.includes(novoStatus) && !force) {
      snack(`Transição ${statusLabel(statusAtual)} → ${statusLabel(novoStatus)} não permitida.`, "err");
      return;
    }

    // ── ORCAMENTO → EM ATENDIMENTO: movimenta estoque
    if (novoStatus === "em_atendimento" && !ATD.estoque_movimentado) {
      const ok = await confirm(
        "Mover para Em Atendimento",
        "Isso irá baixar o estoque dos produtos deste atendimento.\nO financeiro (Contas a Receber) ainda NÃO será gerado.\n\nDeseja continuar?"
      );
      if (!ok) return;
      const res = await movimentarEstoque(db, ATD.itens, "baixar");
      ATD.estoque_movimentado = true;
      snack(`Estoque movimentado (${res.movs} produto(s) baixado(s)).`, "ok");
      showBanner("✅ Status: Em Atendimento — Estoque movimentado. Financeiro ainda NÃO gerado.", "info");
    }

    // ── ORCAMENTO / EM ATENDIMENTO → FINALIZADO: decisão financeira obrigatória
    if (novoStatus === "finalizado" && (statusAtual === "orcamento" || statusAtual === "em_atendimento")) {
      const decision = await chooseFinanceDecision();
      if (!decision) return;

      ATD.financeiro_gerado = false;
      ATD.financeiro_fechamento_modo = decision;
      ATD.financeiro_fechamento_label = mapFinanceDecisionLabel(decision);
      ATD.financeiro_observacao = ($('financeDecisionObs')?.value || '').trim();
      ATD.financeiro_tipo_pagamento = ($('financeDecisionPaymentMethod')?.value || '').trim() || 'definir_depois';
      ATD.financeiro_preferencia_pagamento = ATD.financeiro_tipo_pagamento;
      ATD.financeiro_condicao_pagamento = ($('financeDecisionTerms')?.value || 'avista').trim();
      ATD.financeiro_baixa_modo = ($('financeDecisionSettlementMode')?.value || 'manual').trim();
      ATD.financeiro_vencimento = ($('financeDecisionDueDate')?.value || ATD.data_atendimento || todayYMD()).trim();
      ATD.financeiro_parcelas = Math.max(1, Math.min(24, Number(($('financeDecisionInstallments')?.value || 1)) || 1));
      ATD.financeiro_intervalo_dias = Math.max(0, Math.min(365, Number(($('financeDecisionInstallmentInterval')?.value || 30)) || 0));
      ATD.financeiro_valor_entrada = Math.max(0, toNumPt(($('financeDecisionEntryAmount')?.value || 0)));
      ATD.financeiro_tipo_cobranca = ($('financeDecisionChargeType')?.value || 'avulsa').trim();
      ATD.financeiro_aceita_parcial = ($('financeDecisionAllowPartial')?.value || 'sim').trim();
      ATD.financeiro_prazo_custom_dias = Math.max(0, Number(($('financeDecisionCustomDays')?.value || 0)) || 0);

      if (statusAtual === "orcamento" && !ATD.estoque_movimentado) {
        const res = await movimentarEstoque(db, ATD.itens, "baixar");
        ATD.estoque_movimentado = true;
        snack(`Estoque movimentado (${res.movs} produto(s)).`, "ok");
      }

      if (decision === 'gerar_agora') {
        const resCR = await gerarContasAReceber(db);
        ATD.financeiro_gerado = !!resCR.ok;
        ATD.financeiro_fechamento_label = resCR.ok ? mapFinanceDecisionLabel(decision) : 'Falha ao gerar financeiro';
        showBanner(
          statusAtual === 'orcamento'
            ? ("✅ Finalizado — Estoque movimentado + Contas a Receber gerado" + (resCR.ok ? "." : " (falhou — verifique o módulo)."))
            : ("✅ Finalizado — Contas a Receber gerado" + (resCR.ok ? "." : " (falhou — verifique o módulo).")),
          resCR.ok ? "ok" : "warn"
        );
      } else {
        showBanner(
          statusAtual === 'orcamento'
            ? `✅ Finalizado — Estoque movimentado e financeiro mantido em aberto (${ATD.financeiro_fechamento_label.toLowerCase()}).`
            : `✅ Finalizado — Financeiro mantido em aberto (${ATD.financeiro_fechamento_label.toLowerCase()}).`,
          "info"
        );
      }
    }

    // ── QUALQUER → CANCELADO: estornar estoque e cancelar C/R
    if (novoStatus === "cancelado") {
      const ok = await confirm("Cancelar atendimento", "Esta ação irá estornar o estoque (se movimentado) e cancelar o título financeiro.\nNão pode ser desfeita. Confirmar?");
      if (!ok) return;
      if (ATD.estoque_movimentado) {
        await movimentarEstoque(db, ATD.itens, "estornar");
        ATD.estoque_movimentado = false;
      }
      if (ATD.financeiro_gerado) {
        await cancelarContasAReceber(db);
        ATD.financeiro_gerado = false;
        ATD.financeiro_fechamento_modo = "aberto";
        ATD.financeiro_fechamento_label = "Em aberto";
        ATD.financeiro_tipo_pagamento = "definir_depois";
        ATD.financeiro_preferencia_pagamento = "definir_depois";
        ATD.financeiro_condicao_pagamento = "avista";
        ATD.financeiro_baixa_modo = "manual";
      }
      showBanner("⛔ Atendimento cancelado — estoque estornado e financeiro cancelado.", "warn");
    }

    // ── EM ATENDIMENTO → ORÇAMENTO: reverter estoque
    if (novoStatus === "orcamento" && statusAtual === "em_atendimento" && ATD.estoque_movimentado) {
      const ok = await confirm("Reverter para Orçamento", "Isso irá estornar as baixas de estoque realizadas ao iniciar o atendimento.\n\nDeseja continuar?");
      if (!ok) return;
      await movimentarEstoque(db, ATD.itens, "estornar");
      ATD.estoque_movimentado = false;
      showBanner("↩ Revertido para Orçamento — estoque estornado. Financeiro não foi afetado.", "warn");
    }

    ATD.status = novoStatus;
    updateStatusBadges(novoStatus);
    $("status") && ($("status").value = novoStatus);
    renderExecutivePanels(db).catch(()=>{});

    // Salvar estado atualizado
    await salvar(db, false);
    await recarregarLista(db);
  }

  // ─── CONSTRUIR PAYLOAD PARA SALVAR ───────────────────────────────────
  function buildPayload() {
    const base = itensSubtotal();
    const desc = calcDesconto(base);
    const desl = ATD.deslocamento || 0;
    const totalGeral = Math.max(0, base - desc + desl);

    return {
      id: ATD.atendimento_id,
      numero: ATD.numero,
      status: ATD.status,
      data_atendimento: toYMD($("data_atendimento")?.value || ATD.data_atendimento || ATD.created_at || isoNow()) || todayYMD(),
      cliente_id: ATD.cliente_id,
      cliente_label: ATD.cliente_label,
      _cliente_nome: ATD.cliente_label,
      animal_ids: ATD.animal_ids || [],
      _animal_names: (() => {
        return (ATD.animal_ids || []).map(id => {
          const a = MODAL_ALL.find(x => String(x.id) === String(id));
          return a ? String(a.nome || id) : String(id);
        });
      })(),
      vitals_by_animal: ATD.vitals_by_animal || {},
      vitals_active_animal_id: ATD.vitals_active_animal_id || "",
      observacoes: String($("observacoes")?.value || ""),
      cli_diagnostico: String($("cli_diagnostico")?.value || ""),
      cli_evolucao: String($("cli_evolucao")?.value || ""),
      itens: ATD.itens || [],
      attachments: ATD.attachments || [],
      vaccine_events: ATD.vaccine_events || [],
      totals: {
        total_itens: Math.max(0, base),
        desconto_tipo: ATD.desconto_tipo || "R$",
        desconto_valor: Math.max(0, ATD.desconto_valor || 0),
        desconto_calc: Math.max(0, desc),
        desl_km: ATD.desl_km || 0,
        desl_valor_km: ATD.desl_valor_km || 0,
        deslocamento: Math.max(0, desl),
        total_geral: totalGeral
      },
      estoque_movimentado: !!ATD.estoque_movimentado,
      financeiro_gerado: !!ATD.financeiro_gerado,
      financeiro_fechamento_modo: ATD.financeiro_fechamento_modo || (ATD.financeiro_gerado ? "gerar_agora" : "aberto"),
      financeiro_fechamento_label: ATD.financeiro_fechamento_label || (ATD.financeiro_gerado ? "Gerado agora" : "Em aberto"),
      financeiro_observacao: ATD.financeiro_observacao || "",
      financeiro_tipo_pagamento: ATD.financeiro_tipo_pagamento || ATD.financeiro_preferencia_pagamento || "definir_depois",
      financeiro_preferencia_pagamento: ATD.financeiro_preferencia_pagamento || ATD.financeiro_tipo_pagamento || "definir_depois",
      financeiro_condicao_pagamento: ATD.financeiro_condicao_pagamento || "avista",
      financeiro_baixa_modo: ATD.financeiro_baixa_modo || "manual",
      financeiro_vencimento: ATD.financeiro_vencimento || ATD.data_atendimento || todayYMD(),
      financeiro_parcelas: Math.max(1, Number(ATD.financeiro_parcelas || 1)),
      financeiro_intervalo_dias: Math.max(0, Number(ATD.financeiro_intervalo_dias ?? 30)),
      financeiro_valor_entrada: Number(ATD.financeiro_valor_entrada || 0),
      financeiro_tipo_cobranca: ATD.financeiro_tipo_cobranca || "avulsa",
      financeiro_aceita_parcial: ATD.financeiro_aceita_parcial || "sim",
      financeiro_prazo_custom_dias: Math.max(0, Number(ATD.financeiro_prazo_custom_dias || 0)),
      cr_id: ATD.cr_id || null,
      created_at: ATD.created_at || isoNow(),
      updated_at: isoNow()
    };
  }

  async function salvar(db, showMsg) {
    if (!ATD.atendimento_id) { snack("Inicie um novo atendimento primeiro.", "err"); return; }
    if (!hasStore(db, "atendimentos_master")) { snack("Store atendimentos_master não encontrada.", "err"); return; }

    try {
      await captureAllVitalsForSave(db);
      const payload = buildPayload();
      await idbPut(db, "atendimentos_master", payload);

      // ── SYNC: envia metadados ao D1 (sem attachments) e anexos ao R2 ──
      try {
        if (window.VSC_DB && typeof window.VSC_DB.upsertWithOutbox === "function") {
          // Payload para D1: sem dataUrl dos attachments (muito grande)
          const payloadD1 = Object.assign({}, payload, {
            attachments: (payload.attachments || []).map(a => ({
              id: a.id,
              name: a.name || a.filename || "",
              mime: a.mime || a.mime_type || "",
              size: a.size || 0,
              descricao: a.descricao || "",
              created_at: a.created_at || "",
              synced_to_r2: !!a.synced_to_r2
              // dataUrl removido intencionalmente
            })),
            __origin: "UI_EDIT"
          });
          await window.VSC_DB.upsertWithOutbox(
            "atendimentos_master",
            payloadD1,
            "atendimentos_master",
            String(payload.id),
            payloadD1
          );
        }

        // Envia attachments com dataUrl diretamente para R2
        const BASE_R2 = (location.hostname === "127.0.0.1" || location.hostname === "localhost")
          ? "https://app.vetsystemcontrol.com.br" : "";
        for (const att of (payload.attachments || [])) {
          if (!att || !att.id || !att.dataUrl) continue;
          try{
            if (window.VSC_ATTACHMENTS_RELAY && typeof window.VSC_ATTACHMENTS_RELAY.enqueue === "function") {
              await window.VSC_ATTACHMENTS_RELAY.enqueue(String(payload.id), att);
            }
          }catch(_queueErr){
            console.warn("[ATD] queue attachment warn:", att.name, _queueErr);
          }
          fetch(`${BASE_R2}/api/attachments?action=upload`, {
            method: "POST",
            headers: getAttachmentAuthHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({
              atendimento_id: payload.id,
              attachment_id: att.id,
              filename: att.name || att.id,
              mime_type: att.mime || "application/octet-stream",
              data_base64: att.dataUrl,
              descricao: att.descricao || "",
              created_at: att.created_at || isoNow()
            })
          }).then(async r => {
            if (!r.ok) {
              console.warn("[ATD] R2 upload falhou:", att.name, r.status);
              return;
            }
            att.synced_to_r2 = true;
            console.log("[ATD] R2 upload ok:", att.name);
            try{
              const live = await idbGet(db, "atendimentos_master", String(payload.id));
              if(live && Array.isArray(live.attachments)){
                live.attachments = live.attachments.map(item => String(item && item.id) === String(att.id) ? Object.assign({}, item, { synced_to_r2: true }) : item);
                await idbPut(db, "atendimentos_master", live);
              }
            }catch(_persistUploadStateErr){ }
          }).catch(e => console.warn("[ATD] R2 upload erro:", att.name, e));
        }
      } catch (_syncErr) {
        // sync nunca bloqueia o save local
        console.warn("[ATENDIMENTOS] sync error (não crítico):", _syncErr);
      }
      if(hasStore(db, "animal_vaccines") && Array.isArray(ATD.vaccine_events)){
        for(const ev of ATD.vaccine_events){
          try{ await idbPut(db, "animal_vaccines", ev); }catch(_e){}
        }
      }
      if (showMsg !== false) {
        const st = ATD.status;
        let msg = "";
        if (st === "orcamento") msg = "💾 Orçamento salvo — sem movimentação de estoque ou financeiro.";
        else if (st === "em_atendimento") msg = "💾 Em Atendimento salvo — estoque movimentado, financeiro ainda NÃO gerado.";
        else if (st === "finalizado") msg = "💾 Finalizado salvo — estoque e financeiro movimentados.";
        else msg = "💾 Salvo.";
        snack(msg, "ok");
      }
    } catch (e) {
      snack("Erro ao salvar: " + (e.message || "desconhecido"), "err");
    }
  }

  // ─── NOVO ATENDIMENTO ─────────────────────────────────────────────────
  async function startNew(db) {
    ATD.atendimento_id = uuidv4();
    ATD.numero = await gerarNumeroSequencial(db);
    ATD.status = "orcamento";
    ATD.data_atendimento = todayYMD();
    ATD.cliente_id = "";
    ATD.cliente_label = "";
    ATD._cliente_nome = "";
    ATD.animal_ids = [];
    ATD.vitals_by_animal = {};
    ATD.vitals_active_animal_id = "";
    ATD.vitals_prefill_by_animal = {};
    ATD.vitals_prefill_pending_by_animal = {};
    ATD.vitals_prefill_dirty_by_animal = {};
    ATD.itens = [];
    ATD.desconto_tipo = "R$";
    ATD.desconto_valor = 0;
    ATD.desl_km = 0;
    ATD.deslocamento = 0;
    ATD.estoque_movimentado = false;
    ATD.financeiro_gerado = false;
    ATD.financeiro_fechamento_modo = "aberto";
    ATD.financeiro_fechamento_label = "Em aberto";
    ATD.financeiro_tipo_pagamento = "definir_depois";
    ATD.financeiro_preferencia_pagamento = "definir_depois";
    ATD.financeiro_condicao_pagamento = "avista";
    ATD.financeiro_baixa_modo = "manual";
    ATD.financeiro_vencimento = ATD.data_atendimento || todayYMD();
    ATD.financeiro_parcelas = 1;
    ATD.financeiro_intervalo_dias = 30;
    ATD.financeiro_valor_entrada = 0;
    ATD.financeiro_tipo_cobranca = "avulsa";
    ATD.financeiro_aceita_parcial = "sim";
    ATD.financeiro_prazo_custom_dias = 0;
    ATD.cr_id = null;
    ATD.vaccine_events = [];

    // Responsável (default): médico logado
    try{
      var cu = ATD._currentUser || (window.VSC_AUTH ? await VSC_AUTH.getCurrentUser() : null);
      if(cu && cu.id){
        ATD.responsavel_user_id = cu.id;
        var p = cu.professional || {};
        var crmvTxt = (p.crmv_uf && p.crmv_num) ? ("CRMV-" + p.crmv_uf + " Nº " + p.crmv_num) : "";
        ATD.responsavel_snapshot = {
          user_id: cu.id,
          username: cu.username || "",
          full_name: p.full_name || "",
          crmv_uf: p.crmv_uf || "",
          crmv_num: p.crmv_num || "",
          phone: p.phone || "",
          email: p.email || "",
          signature_image_dataurl: p.signature_image_dataurl || null,
          icp_enabled: !!p.icp_enabled,
          captured_at: isoNow(),
          display_line: ((p.full_name||cu.username||"") + (crmvTxt ? (" — " + crmvTxt) : ""))
        };
      } else {
        ATD.responsavel_user_id = null;
        ATD.responsavel_snapshot = null;
      }
    }catch(e){
      ATD.responsavel_user_id = null;
      ATD.responsavel_snapshot = null;
    }

    ATD.created_at = isoNow();

    MODAL_ALL = [];
    MODAL_SEL = new Set();

    // Campos UI
    $("numero") && ($("numero").value = ATD.numero);
    $("status") && ($("status").value = "orcamento");
    $("data_atendimento") && ($("data_atendimento").value = ATD.data_atendimento || todayYMD());
    $("cliente_id") && ($("cliente_id").value = "");
    $("cliente_id_value") && ($("cliente_id_value").value = "");
    $("observacoes") && ($("observacoes").value = "");
    $("cli_diagnostico") && ($("cli_diagnostico").value = "");
    $("cli_evolucao") && ($("cli_evolucao").value = "");
    $("desconto_tipo") && ($("desconto_tipo").value = "R$");
    $("desconto_valor") && ($("desconto_valor").value = "0");
    $("desl_km") && ($("desl_km").value = "0");
    $("deslocamento") && ($("deslocamento").value = "0");

    uiSetCliente("—");
    uiSetAnimalResumo("—");
    $("uiNumeroSide") && ($("uiNumeroSide").textContent = ATD.numero);
    $("uiHeroNumero") && ($("uiHeroNumero").textContent = ATD.numero);
    $("editorNumeroDisplay") && ($("editorNumeroDisplay").textContent = ATD.numero);
    $("uiAnimalPick") && ($("uiAnimalPick").textContent = "Selecione um cliente para listar os animais.");
    $("uiClienteHint") && ($("uiClienteHint").textContent = "Digite para buscar. Selecione um item na lista.");

    clearVitalsUI();
    setVitalsVisible(false);
    setClinicosVisible(false);
    const tb = $("tb_animais");
    if (tb) tb.innerHTML = `<tr><td colspan="2" style="padding:16px;" class="hint">Selecione um cliente para listar os animais.</td></tr>`;

    renderItens();
    updateTotaisUI();
    updateStatusBadges("orcamento");
    updateEditorTitle();

    // Persistência imediata do rascunho: o botão "Novo atendimento" precisa
    // criar um registro local válido já no início do fluxo offline-first.
    try {
      const shell = buildPayload();
      shell.id = shell.id || ATD.atendimento_id || uuidv4();
      ATD.atendimento_id = shell.id;
      shell.numero = shell.numero || ATD.numero;
      shell.created_at = ATD.created_at || shell.created_at || isoNow();
      shell.updated_at = isoNow();
      await idbPut(db, "atendimentos_master", shell);
    } catch (e) {
      console.error("[ATD] Falha ao criar rascunho local do atendimento:", e);
      snack("Falha ao iniciar atendimento: " + (e?.message || e || "erro desconhecido"), "err");
      return;
    }

    renderLista(db);
    goDetailView();
    renderExecutivePanels(db).catch(()=>{});

    snack("Novo atendimento iniciado: " + ATD.numero, "ok");
  }

  function updateEditorTitle() {
    const title = $("editorTitle");
    if (title) title.textContent = ATD.numero ? `Atendimento: ${ATD.numero}` : "Novo atendimento";
    $("uiNumeroSide") && ($("uiNumeroSide").textContent = ATD.numero || "—");
    $("uiHeroNumero") && ($("uiHeroNumero").textContent = ATD.numero || "—");
    $("editorNumeroDisplay") && ($("editorNumeroDisplay").textContent = ATD.numero || "");
  }

  
  // ─── FLOORPLAN ENTERPRISE: LISTA → DETALHE (como clientes) ───────────────
  function setCmdActionsEnabled(enabled){
    ["btnSalvarTop","btnAprovarTop","btnFinalizarTop","btnAlterarFinalizadoTop","btnSalvar","btnAprovar","btnFinalizar","btnAlterarFinalizado","btnCancelarAtd","btnAnexosTop","btnImprimirTop","btnAnexos","btnImprimir"].forEach(id=>{
      const b = $(id);
      if(!b) return;
      b.disabled = !enabled;
      b.style.opacity = enabled ? "1" : "0.45";
      b.style.pointerEvents = enabled ? "auto" : "none";
    });
  }

  function goListView(){
    const lv = $("atdListView");
    const dv = $("atdDetailView");
    if(lv) lv.style.display = "";
    if(dv) dv.style.display = "none";
    setCmdActionsVisible(false);
    setCmdActionsEnabled(false);
    refreshFinalizadoActionButtons();
    // reset meta
    $("uiNumeroSide") && ($("uiNumeroSide").textContent = "—");
    $("uiHeroNumero") && ($("uiHeroNumero").textContent = "—");
    uiSetCliente("—");
    uiSetAnimalResumo("—");
    updateStatusBadges("orcamento");
  }

  function goDetailView(){
    const lv = $("atdListView");
    const dv = $("atdDetailView");
    if(lv) lv.style.display = "none";
    if(dv) dv.style.display = "";
    setCmdActionsVisible(true);
    setCmdActionsEnabled(true);
    refreshFinalizadoActionButtons();
    // mostrar conteúdo do detalhe
    const empty = $("atdDetailEmpty");
    const content = $("atdDetailContent");
    if(empty) empty.style.display = "none";
    if(content) content.style.display = "";
    setCmdActionsEnabled(true);
  }

  function goDetailEmpty(){
    const lv = $("atdListView");
    const dv = $("atdDetailView");
    if(lv) lv.style.display = "none";
    if(dv) dv.style.display = "";
    const empty = $("atdDetailEmpty");
    const content = $("atdDetailContent");
    if(empty) empty.style.display = "";
    if(content) content.style.display = "none";
    setCmdActionsVisible(false);
    setCmdActionsEnabled(false);
    refreshFinalizadoActionButtons();
  }
// ─── WIRING DOS BOTÕES DE AÇÃO ────────────────────────────────────────
  function wireAcoes(db) {
    if (wireAcoes.__wired) return;
    wireAcoes.__wired = true;

    // Novo
    ["btnNovoTop"].forEach(id => {
      $(id)?.addEventListener("click", async (ev) => { ev.preventDefault(); await startNew(db); goDetailView(); });
    });

    // Voltar à lista (detail → list)
    $("btnVoltarLista")?.addEventListener("click", (ev)=>{ ev.preventDefault(); goListView(); });

    // Estado vazio do detalhe (opcional)
    $("btnEmptyNovoAtd")?.addEventListener("click", async (ev)=>{ ev.preventDefault(); await startNew(db); goDetailView(); });

    // Salvar
    ["btnSalvarTop", "btnSalvar"].forEach(id => {
      $(id)?.addEventListener("click", (ev) => { ev.preventDefault(); salvar(db, true); });
    });

    // Anexos
    ["btnAnexosTop","btnAnexos"].forEach(id => {
      $(id)?.addEventListener("click", (ev) => { ev.preventDefault(); openAttachModal(); });
    });

    // Imprimir
    ["btnImprimirTop","btnImprimir"].forEach(id => {
      $(id)?.addEventListener("click", (ev) => { ev.preventDefault(); openPrintModal(); });
    });

    // Modal de impressão
    $("vscPrintModalClose")?.addEventListener("click", (ev)=>{ ev.preventDefault(); closePrintModal(); });
    $("btnPrintCancel")?.addEventListener("click", (ev)=>{ ev.preventDefault(); closePrintModal(); });
    $("btnPrintClinico")?.addEventListener("click", async (ev)=>{ ev.preventDefault(); closePrintModal(); await imprimirAtendimento(db, "clinico"); });
    $("btnPrintPrescricao")?.addEventListener("click", async (ev)=>{ ev.preventDefault(); closePrintModal(); await imprimirAtendimento(db, "prescricao"); });
    $("btnPrintFinanceiro")?.addEventListener("click", async (ev)=>{ ev.preventDefault(); closePrintModal(); await imprimirAtendimento(db, "financeiro"); });
    $("btnPrintClinicoFinanceiro")?.addEventListener("click", async (ev)=>{ ev.preventDefault(); closePrintModal(); await imprimirAtendimento(db, "clinico_financeiro"); });
    $("btnPrintCompleto")?.addEventListener("click", async (ev)=>{ ev.preventDefault(); closePrintModal(); await imprimirAtendimento(db, "clinico_financeiro"); });

    // Binding robusto (IDs podem variar entre versões do HTML)
    bindPrintModalButtons(db);


    // Aprovar (Orçamento → Em Atendimento)
    ["btnAprovarTop", "btnAprovar"].forEach(id => {
      $(id)?.addEventListener("click", async (ev) => {
        ev.preventDefault();
        await salvar(db, false);
        await mudarStatus(db, "em_atendimento");
      });
    });

    async function handleFinalizeAction(ev){
      ev?.preventDefault?.();
      try {
        await salvar(db, false);
        await mudarStatus(db, "finalizado");
      } catch (e) {
        console.error("[ATD] Falha ao finalizar atendimento:", e);
        snack("Falha ao abrir a finalização: " + (e?.message || e || "erro desconhecido"), "err");
      }
    }

    // Finalizar
    ["btnFinalizarTop", "btnFinalizar"].forEach(id => {
      $(id)?.addEventListener("click", handleFinalizeAction);
    });

    ["btnAlterarFinalizadoTop", "btnAlterarFinalizado"].forEach(id => {
      $(id)?.addEventListener("click", async (ev) => {
        ev.preventDefault();
        await reabrirFinalizadoParaAlteracao(db);
      });
    });

    // Cancelar atendimento
    ["btnCancelarAtd"].forEach(id => {
      $(id)?.addEventListener("click", async (ev) => {
        ev.preventDefault();
        await mudarStatus(db, "cancelado");
      });
    });

    // Botões do fluxo de status no card
    $("btnSetOrcamento")?.addEventListener("click", async (ev) => {
      ev.preventDefault();
      await salvar(db, false);
      await mudarStatus(db, "orcamento");
    });
    $("btnSetEmAtendimento")?.addEventListener("click", async (ev) => {
      ev.preventDefault();
      await salvar(db, false);
      await mudarStatus(db, "em_atendimento");
    });
    $("btnSetFinalizado")?.addEventListener("click", handleFinalizeAction);


    
// Modal anexos
    $("vscAttachModalClose")?.addEventListener("click", (ev)=>{ ev.preventDefault(); closeAttachModal(); });
    $("btnAttachClose")?.addEventListener("click", (ev)=>{ ev.preventDefault(); closeAttachModal(); });

    // Salvar descrições (persistir no atendimento)
    $("btnAttachSave")?.addEventListener("click", async (ev)=>{
      ev.preventDefault();
      try{
        // valida apenas fotos
        const missing = validateAttachDescriptionsBeforeFinalize();
        if(missing.length){
          snack("Existem anexo(s) sem descrição. Preencha antes de salvar.", "err");
          renderAttachList();
          const first = missing[0];
          const ta = document.querySelector(`textarea[data-attach-desc][data-idx="${first}"]`);
          if(ta){ ta.classList.add("missing"); ta.scrollIntoView({block:"center"}); ta.focus(); }
          return;
        }
        await salvar(db, true);
        snack("Descrições salvas.", "ok");
        $("btnAttachSave") && ($("btnAttachSave").disabled = true);
      }catch(e){
        snack("Falha ao salvar descrições: " + (e.message||"erro"), "err");
      }
    });

    $("attachInput")?.addEventListener("change", async (ev)=>{
      await handleAttachFiles(ev.target.files);
      ev.target.value = ""; // permite reenviar o mesmo arquivo
    });

    // Interações enterprise (ver/remover + descrição)
    wireAttachListInteractions(db);


    // Data do atendimento (automática por padrão, mas editável)
    $("data_atendimento")?.addEventListener("change", () => {
      const v = toYMD($("data_atendimento")?.value) || todayYMD();
      ATD.data_atendimento = v;
      $("data_atendimento") && ($("data_atendimento").value = v);
      // Atualiza seleção/ordem na lista
      recarregarLista(db);
    });


    // Status dropdown manual (só informativo — não dispara movimentação automática)
    $("status")?.addEventListener("change", () => {
      const v = String($("status")?.value || "orcamento");
      ATD.status = v;
      updateStatusBadges(v);
    });
  }

  // ─── BOOT ─────────────────────────────────────────────────────────────
  async function boot() {
    try {
      const db = await openDb();

      // Padronização enterprise de inputs (máscaras/normalização)
      wireEnterpriseMasks();


      // Usuário atual (para responsável do atendimento / emissão de documentos)
      try{
        if(window.VSC_AUTH && typeof VSC_AUTH.getCurrentUser === "function"){
          ATD._currentUser = await VSC_AUTH.getCurrentUser();
        } else {
          ATD._currentUser = null;
        }
      }catch(e){
        ATD._currentUser = null;
        console.warn("[ATD] getCurrentUser failed:", e);
      }

      _dbRef = db;

      // Carregar valor/km do deslocamento
      ATD.desl_valor_km = await carregarValorKm(db);

      if (ATD.desl_valor_km > 0) {
        $("desl_valor_km") && ($("desl_valor_km").value = String(ATD.desl_valor_km.toFixed(2)).replace(".", ","));
        $("uiDeslHint") && ($("uiDeslHint").textContent = `R$ ${ATD.desl_valor_km.toFixed(2).replace(".", ",")} por km configurado.`);
      } else {
        // Enterprise: deixar claro o motivo (sem alert, sem som)
        $("desl_valor_km") && ($("desl_valor_km").value = "—");
        $("uiDeslHint") && ($("uiDeslHint").textContent = "Configure o valor do km em Configurações → Financeiro para calcular o deslocamento automaticamente.");
      }

      // Se já houver km digitado/carregado, recalcular imediatamente o total de deslocamento
      updateDeslocamento();

      // Carregar cache clientes
      await loadClientesCache(db);

      // Wiring
      wireLookup(() => db);
      wireModalOnce(() => db);
      wireItensOnce(() => db);
      wireAcoes(db);
      wireFiltros(db);
      $("uiRecentAtendimentos")?.addEventListener("click", async (ev) => {
        const row = ev.target?.closest?.("[data-atd-id]");
        const id = row?.getAttribute?.("data-atd-id");
        if(!id) return;
        await abrirAtendimento(db, id);
      });

      // Carregar lista de atendimentos
      await recarregarLista(db);

      const launch = await resolveLaunchContext(db);
      if (launch && launch.rec) {
        await carregarNoFormulario(db, launch.rec);
        goDetailView();
        consumeLaunchContext();
        window.scrollTo({ top: 0, behavior: "auto" });
      } else {
        // Padrão enterprise: abrir em LISTA quando não houver contexto válido
        goListView();
        if (launch && !launch.rec) {
          snack("Atendimento solicitado não foi localizado. Lista geral exibida.", "warn");
        }
      }

      window.__VSC_ATENDIMENTOS_READY = true;
      snack("Módulo Atendimentos v3 carregado.", "ok");

    } catch (e) {
      window.__VSC_ATENDIMENTOS_READY = false;
      snack("Falha crítica no boot: " + (e.message || e), "err");
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();


  function setCmdActionsVisible(visible){
    ["btnSalvarTop","btnAprovarTop","btnFinalizarTop","btnAlterarFinalizadoTop","btnSalvar","btnAprovar","btnFinalizar","btnAlterarFinalizado","btnCancelarAtd","btnAnexosTop","btnImprimirTop","btnAnexos","btnImprimir"].forEach(id=>{
      const b = $(id);
      if(!b) return;
      b.style.display = visible ? "" : "none";
    });
  }
})();
