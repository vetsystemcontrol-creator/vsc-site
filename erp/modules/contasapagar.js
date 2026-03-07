/* =====================================================================================
   VET SYSTEM CONTROL – EQUINE
   Módulo: CONTAS A PAGAR (AP)
   Refatoração canônica (UFC) — arquivo ÚNICO, sem hotfix em cascata
   Regras: Offline-first + Outbox (sync_queue) + UUID v4 + centavos + console limpo

   CORREÇÃO R-01 (Auditoria 2026-02-18):
     Persistência migrada de localStorage → IndexedDB canônico (VSC_DB.contas_pagar).
     A função _migrateLStoIDB() executa migração one-shot na primeira carga:
       - Lê contas_pagar do localStorage (legado)
       - Grava no IDB via upsertWithOutbox (atômico)
       - Marca flag "vsc_ap_migrated_v1" para não repetir
     Literatura: Fowler (2018) "StranglerFigApplication" — migração incremental
     sem downtime; Martin (2008) "Clean Code" — uma única responsabilidade por módulo.

   CORREÇÃO R-04/R-05: utilitários delegados a VSC_UTILS (sem duplicação, sem Math.random)
   ===================================================================================== */

(() => {
  "use strict";

  const VSC_AP_VERSION = "2.0.0"; // bump: IDB canônico

  // ---------------------------
  // Delegação a VSC_UTILS (R-04)
  // ---------------------------
  // VSC_UTILS deve ser carregado ANTES deste módulo via <script src="vsc-utils.js">
  const _u = window.VSC_UTILS;
  if (!_u) {
    console.error("[VSC_AP] VSC_UTILS não encontrado. Carregue vsc-utils.js antes de contasapagar.js");
    return;
  }
  const nowISO        = _u.nowISO;
  const todayYMD      = _u.todayYMD;
  const uuidv4        = _u.uuidv4;       // CSPRNG-only (R-05)
  const clampInt      = _u.clampInt;
  const safeJSONParse = _u.safeJSONParse;
  const normalizeStr  = _u.normalizeString;

  // VSC_DB deve estar disponível (vsc_db.js carregado antes)
  const _db = window.VSC_DB;
  if (!_db) {
    console.error("[VSC_AP] VSC_DB não encontrado. Carregue vsc_db.js antes de contasapagar.js");
    return;
  }

  // ---------------------------
  // Storage Keys (legado — somente para migração)
  // ---------------------------
  const KEY_AP_LS      = "contas_pagar";      // localStorage (legado)
  const MIGRATION_FLAG = "vsc_ap_migrated_v1"; // flag de migração one-shot

  // Nota: KEY_OUTBOX agora é o store IDB "sync_queue" via upsertWithOutbox()

  // Shim de safeJSONParse (só para leitura do LS legado durante migração)
  function _safeJSONParse(txt, fallback) {
    try { return JSON.parse(txt); } catch (_) { return fallback; }
  }

  // Delegação a VSC_UTILS (R-04) — funções monetárias e normalização
  const moneyToCentsBR = _u.moneyToCentsBR;
  const centsToMoneyBR = _u.centsToMoneyBR;

  function normalizeString(s) {
    return String(s ?? "").trim();
  }

  // ---------------------------
  // Modelo canônico (AP)
  // ---------------------------
  // status derivado:
  // - pago: dt_pagamento preenchida OU saldo==0 (para compatibilidade)
  // - vencido: saldo>0 e vencimento < hoje
  // - aberto: saldo>0 e não vencido
  // - cancelado: flag cancelado=true
  function computeStatus(t) {
    if (!t) return "aberto";
    if (t.cancelado) return "cancelado";

    const total = clampInt(t.valor_centavos ?? 0, 0, 2147483647);
    const pagoCent = clampInt(t.pago_centavos ?? 0, 0, 2147483647);
    const saldo = Math.max(0, total - pagoCent);

    const dtPag = normalizeString(t.pagamento_data);
    if (dtPag || saldo === 0) return "pago";

    const vcto = normalizeString(t.vencimento);
    const hoje = todayYMD();
    const vencido = vcto && vcto < hoje;
    if (vencido) return "vencido";
    return "aberto";
  }

  function normalizeTitulo(x) {
    const obj = (x && typeof x === "object") ? x : {};
    const id = normalizeString(obj.id) || uuidv4();

    const valor_centavos = clampInt(obj.valor_centavos ?? obj.valor_original_centavos ?? 0, 0, 2147483647);
    const pago_centavos = clampInt(obj.pago_centavos ?? 0, 0, 2147483647);

    const t = {
      id,
      // fornecedor
      fornecedor_nome: normalizeString(obj.fornecedor_nome ?? obj.mFornecedorNome ?? obj.fornecedor ?? ""),
      fornecedor_doc: normalizeString(obj.fornecedor_doc ?? obj.mFornecedorDoc ?? obj.documento_fornecedor ?? ""),
      // documento do título
      documento: normalizeString(obj.documento),

      // datas
      competencia: normalizeString(obj.competencia ?? obj.dt_comp ?? ""), // "MM/AAAA" (compat) ou "YYYY-MM" (futuro)
      vencimento: normalizeString(obj.vencimento ?? obj.dt_venc ?? ""),   // "YYYY-MM-DD"
      pagamento_data: normalizeString(obj.pagamento_data ?? obj.dt_pag ?? ""), // "YYYY-MM-DD" (opcional)

      // valores
      valor_centavos,
      pago_centavos,

      // metadados
      origem: normalizeString(obj.origem ?? "manual"),
      obs: normalizeString(obj.obs ?? obj.observacao ?? ""),

      // cancelamento
      cancelado: !!obj.cancelado,
      cancelado_at: normalizeString(obj.cancelado_at),
      cancelado_motivo: normalizeString(obj.cancelado_motivo),

      // auditoria/timestamps
      created_at: normalizeString(obj.created_at) || nowISO(),
      updated_at: normalizeString(obj.updated_at) || nowISO(),
      last_sync: normalizeString(obj.last_sync) || ""
    };

    t.status = computeStatus(t);
    return t;
  }

  // ================================================================
  // Repositório IDB canônico (R-01 — substituição do localStorage)
  // ================================================================

  const STORE_AP = _db.stores.contas_pagar; // "contas_pagar"

  /**
   * Carrega todos os títulos AP do IDB.
   * @returns {Promise<Array>}
   */
  async function loadAP() {
    const db = await _db.openDB();
    return new Promise((resolve, reject) => {
      const tx0 = db.transaction([STORE_AP], "readonly");
      const st0  = tx0.objectStore(STORE_AP);
      const out  = [];
      const rq   = st0.openCursor();
      rq.onsuccess = () => {
        const cur = rq.result;
        if (cur) { out.push(normalizeTitulo(cur.value)); cur.continue(); }
        else resolve(out);
      };
      rq.onerror = () => reject(rq.error);
    });
  }

  /**
   * Grava (upsert) um título AP no IDB de forma atômica com o Outbox.
   * Usa VSC_DB.upsertWithOutbox → dado + evento na MESMA transação IDB.
   * Literatur: Richardson (2018) "Transactional Outbox Pattern".
   * @param {object} input
   * @returns {Promise<{ok:boolean, outbox_id:string}>}
   */
  async function upsertTitulo(input) {
    const t = normalizeTitulo(input);
    t.updated_at = nowISO();
    t.status     = computeStatus(t);
    if (!t.created_at) t.created_at = nowISO();

    const result = await _db.upsertWithOutbox(
      STORE_AP,
      t,
      "contas_pagar",  // entity
      t.id,            // entity_id
      t                // payload para o outbox
    );

    // Dispara relay imediatamente após gravação (R-02)
    if (window.VSC_RELAY && typeof window.VSC_RELAY.kick === "function") {
      window.VSC_RELAY.kick();
    }

    return result;
  }

  /**
   * Migração one-shot: localStorage → IDB (R-01).
   * Executa apenas uma vez por dispositivo (flag em localStorage).
   * Preserva dados do LS; não apaga até confirmação manual do usuário.
   * Literatur: Fowler (2018) StranglerFigApplication — migração incremental.
   */
  async function _migrateLStoIDB() {
    if (localStorage.getItem(MIGRATION_FLAG) === "1") return; // já migrado

    const raw = localStorage.getItem(KEY_AP_LS);
    if (!raw) {
      localStorage.setItem(MIGRATION_FLAG, "1");
      return;
    }

    const arr = _safeJSONParse(raw, []);
    if (!Array.isArray(arr) || arr.length === 0) {
      localStorage.setItem(MIGRATION_FLAG, "1");
      return;
    }

    let migrated = 0;
    for (const item of arr) {
      try {
        await upsertTitulo(item);
        migrated++;
      } catch (_) { /* fail-soft por item */ }
    }

    localStorage.setItem(MIGRATION_FLAG, "1");
    // Dados originais em localStorage preservados como backup transitório.
    // Para remover: localStorage.removeItem(KEY_AP_LS) após validação manual.
    if (migrated > 0) {
      // Avisa apenas em modo de desenvolvimento (não polui console em produção)
      if (window.__VSC_DEBUG__) {
        console.info(`[VSC_AP] Migração LS→IDB: ${migrated} título(s) migrado(s).`);
      }
    }
  }

  // ------------------------------------------
  // Compatibilidade: saveAP (mantém API pública)
  // Agora é um wrapper que persiste via IDB.
  // ------------------------------------------
  /**
   * @deprecated Prefira upsertTitulo(). saveAP persiste via IDB (não mais LS).
   * @param {Array} list
   * @returns {Promise<Array>}
   */
  async function saveAP(list) {
    const norm = (Array.isArray(list) ? list : []).map(normalizeTitulo);
    for (const t of norm) {
      await upsertTitulo(t);
    }
    return norm;
  }

  // ------------------------------------------
  // Inicialização assíncrona
  // ------------------------------------------
  _migrateLStoIDB().catch(() => { /* fail-closed — não interrompe inicialização */ });

  // Expor API (sem poluir além de VSC_AP)
  window.VSC_AP = {
    version: VSC_AP_VERSION,
    loadAP,    // agora async → retorna Promise<Array>
    saveAP,    // agora async (compat)
    upsertTitulo,
    _util: { centsToMoneyBR, moneyToCentsBR, computeStatus }
  };

})();
// =====================================================================================
// UI — MODAIS + GRID + FILTROS + KPIs (CONTAS A PAGAR)
// Compatível com contasapagar.html (IDs reais) e com API window.VSC_AP
// =====================================================================================
(() => {
  "use strict";
  if (!window.VSC_AP) return;

  // ---------------------------
  // DOM helpers (seguro)
  // ---------------------------
  const $ = (id) => document.getElementById(id);

  const elTblBody = $("tblBody");
  const elTblEmpty = $("tblEmpty");

  // KPIs
  const kpiAberto = $("kpiAberto");
  const kpiAbertoHint = $("kpiAbertoHint");
  const kpiVencendo = $("kpiVencendo");
  const kpiVencendoHint = $("kpiVencendoHint");
  const kpiAtraso = $("kpiAtraso");
  const kpiAtrasoHint = $("kpiAtrasoHint");
  const kpiPagoMes = $("kpiPagoMes");
  const kpiPagoMesHint = $("kpiPagoMesHint");

  // filtros
  const fFornecedor = $("fFornecedor");
  const fFornecedorMeta = $("fFornecedorMeta");
  const fStatus = $("fStatus");
  const fPeriodo = $("fPeriodo");
  const fBusca = $("fBusca");

  // side resumo fornecedor
  const sideFornecedorNome = $("sideFornecedorNome");
  const sideFornecedorDoc = $("sideFornecedorDoc");
  const sideFornecedorObs = $("sideFornecedorObs");

  // botões toolbar
  const btnNovo = $("btnNovo");
  const btnRecalcular = $("btnRecalcular");
  const btnExportar = $("btnExportar");
  const btnImportarXml = $("btnImportarXml");

  // modal título
  const modal = $("modal");
  const btnModalClose = $("btnModalClose");
  const btnCancelar = $("btnCancelar");
  const btnExcluir = $("btnExcluir");
  const btnSalvar = $("btnSalvar");

  const mFornecedorNome = $("mFornecedorNome");
  const mFornecedorDoc = $("mFornecedorDoc");
  const mDocumento = $("mDocumento");
  const mOrigem = $("mOrigem");
  const mCompetencia = $("mCompetencia");
  const mVencimento = $("mVencimento");
  const mValor = $("mValor");
  const mPagamento = $("mPagamento");
  const mObs = $("mObs");
  const mWarn = $("mWarn");

  // modal fornecedor
  const modalFornecedor = $("modalFornecedor");
  const btnFornecedorClose = $("btnFornecedorClose");
  const btnFornecedorLimpar = $("btnFornecedorLimpar");
  const btnFornecedorAplicar = $("btnFornecedorAplicar");
  const fornBusca = $("fornBusca");
  const fornBody = $("fornBody");
  const fornEmpty = $("fornEmpty");

  // ---------------------------
  // Estado UI (premium)
  // ---------------------------
  const UI = {
    selectedFornecedor: null,  // { nome, doc, obs? }
    selectedFornecedorTmp: null,
    editingId: null
  };

  // ---------------------------
  // Modal helpers (contasapagar.html usa .modal.open)
  // ---------------------------
  function openModal(el) {
    if (!el) return;
    el.classList.add("open");
    el.setAttribute("aria-hidden", "false");
  }
  function closeModal(el) {
    if (!el) return;
    el.classList.remove("open");
    el.setAttribute("aria-hidden", "true");
  }

  function showWarn(msg) {
    if (!mWarn) return;
    mWarn.textContent = msg || "";
    mWarn.style.display = msg ? "block" : "none";
  }
  function clearWarn() { showWarn(""); }

  // ---------------------------
  // Datas/format (seguro)
  // ---------------------------
  function todayYMD() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${da}`;
  }

  function addDaysYMD(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${da}`;
  }

  function monthKeyFromYMD(ymd) {
    const s = String(ymd || "").trim();
    if (s.length >= 7) return s.slice(0, 7); // YYYY-MM
    return "";
  }

  function safeLower(s) { return String(s ?? "").toLowerCase(); }

  // ---------------------------
  // Fornecedor list (robusto, sem assumir VSC_DB)
  // - prioridade: se existir VSC_DB.fornecedores.list() (somente se existir)
  // - fallback: localStorage heurístico mínimo
  // ---------------------------
  function safeJSONParse(txt, fallback) {
    try { return JSON.parse(txt); } catch (_) { return fallback; }
  }

  async function tryListFornecedoresFromVSCDB() {
    try {
      if (!window.VSC_DB) return null;
      // tentativas conservadoras (sem supor estrutura além do nome óbvio)
      if (window.VSC_DB.fornecedores && typeof window.VSC_DB.fornecedores.list === "function") {
        const r = await window.VSC_DB.fornecedores.list();
        if (Array.isArray(r)) return r;
      }
    } catch (_) {}
    return null;
  }

  function listFornecedoresFromLocalStorage() {
    const keys = ["fornecedores", "fornecedores_data", "cad_fornecedores", "dados_fornecedores"];
    for (let i = 0; i < keys.length; i++) {
      const raw = localStorage.getItem(keys[i]);
      const arr = safeJSONParse(raw || "[]", []);
      if (Array.isArray(arr) && arr.length) return arr;
    }
    return [];
  }

  function normFornecedorRow(x) {
    const obj = (x && typeof x === "object") ? x : {};
    const nome = String(obj.nome ?? obj.razao_social ?? obj.fornecedor ?? obj.nome_fornecedor ?? obj.fantasia ?? "").trim();
    const doc = String(obj.cnpj ?? obj.cpf ?? obj.documento ?? obj.cnpjcpf ?? obj.cnpj_cpf ?? "").trim();
    const obs = String(obj.obs ?? obj.observacao ?? obj.observações ?? "").trim();
    const cidade = String(obj.cidade ?? "").trim();
    const uf = String(obj.uf ?? obj.estado ?? "").trim();
    return { nome, doc, obs, cidade, uf };
  }

  async function getFornecedoresIndex() {
    const fromDB = await tryListFornecedoresFromVSCDB();
    const src = Array.isArray(fromDB) ? fromDB : listFornecedoresFromLocalStorage();
    const out = [];
    for (let i = 0; i < src.length; i++) {
      const f = normFornecedorRow(src[i]);
      if (f.nome) out.push(f);
    }
    out.sort((a, b) => a.nome.localeCompare(b.nome));
    return out;
  }

  // ---------------------------
  // Render fornecedor modal
  // ---------------------------
  function renderFornecedorTable(list) {
    if (!fornBody) return;

    fornBody.innerHTML = "";
    const arr = Array.isArray(list) ? list : [];

    if (!arr.length) {
      if (fornEmpty) fornEmpty.style.display = "block";
      return;
    }
    if (fornEmpty) fornEmpty.style.display = "none";

    for (let i = 0; i < arr.length; i++) {
      const f = arr[i];

      const tr = document.createElement("tr");
      tr.setAttribute("data-id", String(i));
      tr.style.cursor = "pointer";

      tr.innerHTML = `
        <td><div style="font-weight:800;">${escapeHtml(f.nome)}</div></td>
        <td>${escapeHtml(f.doc || "-")}</td>
        <td>${escapeHtml((f.cidade ? f.cidade : "-") + (f.uf ? ("/" + f.uf) : ""))}</td>
      `;

      tr.addEventListener("click", () => {
        UI.selectedFornecedorTmp = f;
        // destaque visual simples
        const rows = fornBody.querySelectorAll("tr");
        for (let k = 0; k < rows.length; k++) rows[k].style.background = "";
        tr.style.background = "#f5f7f6";
      });

      fornBody.appendChild(tr);
    }
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // ---------------------------
  // Seleção fornecedor (aplica no filtro e no lado direito)
  // ---------------------------
  function applySelectedFornecedor(f) {
    UI.selectedFornecedor = f || null;

    const nome = f ? (f.nome || "") : "";
    const doc = f ? (f.doc || "") : "";
    const obs = f ? (f.obs || "") : "";

    if (fFornecedor) fFornecedor.value = nome;
    if (fFornecedorMeta) fFornecedorMeta.textContent = f ? (`Selecionado: ${nome}${doc ? (" · " + doc) : ""}`) : "Nenhum fornecedor selecionado";

    if (sideFornecedorNome) sideFornecedorNome.textContent = f ? (nome || "—") : "—";
    if (sideFornecedorDoc) sideFornecedorDoc.textContent = f ? (doc || "—") : "—";
    if (sideFornecedorObs) sideFornecedorObs.textContent = f ? (obs || "—") : "—";
  }

  // ---------------------------
  // Modal título: preencher/ler
  // ---------------------------
  function clearTituloForm() {
    UI.editingId = null;
    clearWarn();

    if (mFornecedorNome) mFornecedorNome.value = UI.selectedFornecedor ? (UI.selectedFornecedor.nome || "") : "";
    if (mFornecedorDoc) mFornecedorDoc.value = UI.selectedFornecedor ? (UI.selectedFornecedor.doc || "") : "";
    if (mDocumento) mDocumento.value = "";
    if (mOrigem) mOrigem.value = "manual";
    if (mCompetencia) mCompetencia.value = "";
    if (mVencimento) mVencimento.value = "";
    if (mValor) mValor.value = "";
    if (mPagamento) mPagamento.value = "";
    if (mObs) mObs.value = "";
  }

  function fillTituloForm(t) {
    const x = t || {};
    UI.editingId = x.id || null;
    clearWarn();

    if (mFornecedorNome) mFornecedorNome.value = x.fornecedor_nome || "";
    if (mFornecedorDoc) mFornecedorDoc.value = x.fornecedor_doc || "";
    if (mDocumento) mDocumento.value = x.documento || "";
    if (mOrigem) mOrigem.value = x.origem || "manual";
    if (mCompetencia) mCompetencia.value = x.competencia || "";
    if (mVencimento) mVencimento.value = x.vencimento || "";
    if (mValor) mValor.value = (typeof x.valor_centavos === "number") ? (window.VSC_AP._util.centsToMoneyBR(x.valor_centavos)) : "";
    if (mPagamento) mPagamento.value = x.pagamento_data || "";
    if (mObs) mObs.value = x.obs || "";
  }

  function readTituloFormBase() {
    const fornecedor_nome = String(mFornecedorNome?.value || "").trim();
    const fornecedor_doc = String(mFornecedorDoc?.value || "").trim();
    const documento = String(mDocumento?.value || "").trim();
    const origem = String(mOrigem?.value || "manual").trim() || "manual";
    const competencia = String(mCompetencia?.value || "").trim();
    const vencimento = String(mVencimento?.value || "").trim();
    const pagamento_data = String(mPagamento?.value || "").trim();
    const valor_centavos = window.VSC_AP._util.moneyToCentsBR(String(mValor?.value || "").trim());
    const obs = String(mObs?.value || "").trim();

    return {
      fornecedor_nome,
      fornecedor_doc,
      documento,
      origem,
      competencia,
      vencimento,
      pagamento_data,
      valor_centavos,
      obs
    };
  }

  // ---------------------------
  // Grid: filtros e render
  // ---------------------------
  function inPeriod(venc, mode) {
    const v = String(venc || "").trim();
    if (!v) return false;

    if (mode === "all") return true;

    const n = Number(mode);
    if (!Number.isFinite(n) || n <= 0) return true;

    const start = addDaysYMD(-n);
    const end = addDaysYMD(n);
    return v >= start && v <= end;
  }

  function matchesFornecedor(t, selected, text) {
    const nome = safeLower(t.fornecedor_nome || "");
    const doc = safeLower(t.fornecedor_doc || "");
    const q = safeLower(text || "");

    if (selected && selected.nome) {
      // match premium: se há selecionado, exige match por nome exato (evita "parecido")
      return String(t.fornecedor_nome || "").trim() === String(selected.nome || "").trim();
    }

    if (!q) return true;
    return nome.includes(q) || doc.includes(q);
  }

  function matchesBusca(t, q) {
    const s = safeLower(q || "");
    if (!s) return true;
    const doc = safeLower(t.documento || "");
    const obs = safeLower(t.obs || "");
    return doc.includes(s) || obs.includes(s);
  }

  function statusOk(t, f) {
    const st = String((t && t.status) || "").trim(); // já normalizado
    const fs = String(f || "todos").trim();
    if (fs === "todos") return true;
    return st === fs;
  }

  function sortByVenc(a, b) {
    const av = String(a.vencimento || "");
    const bv = String(b.vencimento || "");
    return av.localeCompare(bv);
  }

  function renderGrid(list) {
    if (!elTblBody) return;
    elTblBody.innerHTML = "";

    const arr = Array.isArray(list) ? list : [];
    if (!arr.length) {
      if (elTblEmpty) elTblEmpty.style.display = "block";
      return;
    }
    if (elTblEmpty) elTblEmpty.style.display = "none";

    for (let i = 0; i < arr.length; i++) {
      const t = arr[i];
      const tr = document.createElement("tr");

      const st = String(t.status || "aberto");
      const pillClass =
        st === "pago" ? "ok" :
        st === "vencido" ? "danger" :
        st === "cancelado" ? "warn" :
        "warn";

      tr.innerHTML = `
        <td><span class="pill ${pillClass}">${escapeHtml(st)}</span></td>
        <td>${escapeHtml(t.vencimento || "-")}</td>
        <td>${escapeHtml(t.competencia || "-")}</td>
        <td>
          <div style="font-weight:800;">${escapeHtml(t.fornecedor_nome || "-")}</div>
          <div class="muted">${escapeHtml(t.documento || "")}</div>
        </td>
        <td>${"R$ " + escapeHtml(window.VSC_AP._util.centsToMoneyBR(t.valor_centavos || 0))}</td>
        <td>${escapeHtml(t.pagamento_data || "-")}</td>
        <td>${escapeHtml(t.origem || "manual")}</td>
        <td style="text-align:right;">
          <div class="row-actions">
            <button class="btn mini" type="button" data-act="editar" data-id="${escapeHtml(t.id)}">Editar</button>
            <button class="btn mini" type="button" data-act="pagar" data-id="${escapeHtml(t.id)}">Pagar</button>
            <button class="btn mini btn-danger" type="button" data-act="cancelar" data-id="${escapeHtml(t.id)}">Cancelar</button>
          </div>
        </td>
      `;
      elTblBody.appendChild(tr);
    }
  }

  function computeKpis(all) {
    const lista = Array.isArray(all) ? all : [];
    const hoje = todayYMD();
    const em7 = addDaysYMD(7);

    let abertoCent = 0, abertoN = 0;
    let vencendoCent = 0, vencendoN = 0;
    let atrasoCent = 0, atrasoN = 0;
    let pagoMesCent = 0, pagoMesN = 0;

    const mesAtual = monthKeyFromYMD(hoje); // YYYY-MM

    for (let i = 0; i < lista.length; i++) {
      const t = lista[i];
      const st = String(t.status || "");

      const total = clampInt(t.valor_centavos ?? 0, 0, 2147483647);
      const pago = clampInt(t.pago_centavos ?? 0, 0, 2147483647);
      const saldo = Math.max(0, total - pago);

      const vcto = String(t.vencimento || "").trim();
      const pagDt = String(t.pagamento_data || "").trim();

      if (st === "aberto") {
        abertoCent += saldo; abertoN++;
        if (vcto && vcto >= hoje && vcto <= em7) { vencendoCent += saldo; vencendoN++; }
        if (vcto && vcto < hoje) { atrasoCent += saldo; atrasoN++; }
      }

      if (st === "vencido") {
        atrasoCent += saldo; atrasoN++;
      }

      if (st === "pago") {
        const mk = monthKeyFromYMD(pagDt);
        if (mk && mk === mesAtual) { pagoMesCent += total; pagoMesN++; }
      }
    }

    if (kpiAberto) kpiAberto.textContent = "R$ " + window.VSC_AP._util.centsToMoneyBR(abertoCent);
    if (kpiAbertoHint) kpiAbertoHint.textContent = `${abertoN} títulos`;

    if (kpiVencendo) kpiVencendo.textContent = "R$ " + window.VSC_AP._util.centsToMoneyBR(vencendoCent);
    if (kpiVencendoHint) kpiVencendoHint.textContent = `${vencendoN} títulos`;

    if (kpiAtraso) kpiAtraso.textContent = "R$ " + window.VSC_AP._util.centsToMoneyBR(atrasoCent);
    if (kpiAtrasoHint) kpiAtrasoHint.textContent = `${atrasoN} títulos`;

    if (kpiPagoMes) kpiPagoMes.textContent = "R$ " + window.VSC_AP._util.centsToMoneyBR(pagoMesCent);
    if (kpiPagoMesHint) kpiPagoMesHint.textContent = `${pagoMesN} títulos`;
  }

  async function applyFiltersAndRender() {
    const all = (await window.VSC_AP.loadAP()).slice().sort(sortByVenc);

    const qFornecedor = String(fFornecedor?.value || "").trim();
    const st = String(fStatus?.value || "todos").trim();
    const per = String(fPeriodo?.value || "30").trim();
    const qBusca = String(fBusca?.value || "").trim();

    const filtered = all.filter(t => {
      if (!inPeriod(t.vencimento, per)) return false;
      if (!statusOk(t, st)) return false;
      if (!matchesFornecedor(t, UI.selectedFornecedor, qFornecedor)) return false;
      if (!matchesBusca(t, qBusca)) return false;
      return true;
    });

    computeKpis(all);
    renderGrid(filtered);
  }

  // clampInt local (para KPIs) — sem expor global
  function clampInt(n, min, max) {
    n = Number.isFinite(n) ? Math.trunc(n) : 0;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  // ---------------------------
  // Eventos: toolbar / filtros
  // ---------------------------
  function bindEvents() {
    if (btnNovo) {
      btnNovo.addEventListener("click", () => {
        clearTituloForm();
        openModal(modal);
        // foco premium
        try { mFornecedorNome && mFornecedorNome.focus(); } catch (_) {}
      });
    }

    if (btnRecalcular) btnRecalcular.addEventListener("click", applyFiltersAndRender);

    // Exportar: apenas baixa JSON (sem console)
    if (btnExportar) {
      btnExportar.addEventListener("click", async () => {
        const all = (await window.VSC_AP.loadAP()).slice().sort(sortByVenc);
        const blob = new Blob([JSON.stringify(all, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `contasapagar_${todayYMD()}.json`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
      });
    }

    // Importação XML: navega para importacaoxml.html (sem supor mais nada)
    if (btnImportarXml) {
      btnImportarXml.addEventListener("click", () => {
        window.location.href = "importacaoxml.html";
      });
    }

    // filtros
    if (fStatus) fStatus.addEventListener("change", applyFiltersAndRender);
    if (fPeriodo) fPeriodo.addEventListener("change", applyFiltersAndRender);
    if (fBusca) fBusca.addEventListener("input", applyFiltersAndRender);

    if (fFornecedor) {
      fFornecedor.addEventListener("input", () => {
        // se o usuário digitar manualmente, remove seleção (evita falso exato)
        UI.selectedFornecedor = null;
        if (fFornecedorMeta) fFornecedorMeta.textContent = "Nenhum fornecedor selecionado";
        if (sideFornecedorNome) sideFornecedorNome.textContent = "—";
        if (sideFornecedorDoc) sideFornecedorDoc.textContent = "—";
        if (sideFornecedorObs) sideFornecedorObs.textContent = "—";
        applyFiltersAndRender();
      });

      // Enter abre busca fornecedor (regra do próprio placeholder)
      fFornecedor.addEventListener("keydown", async (ev) => {
        if (ev.key !== "Enter") return;
        ev.preventDefault();

        UI.selectedFornecedorTmp = null;
        if (fornBusca) fornBusca.value = String(fFornecedor.value || "").trim();

        openModal(modalFornecedor);

        const idx = await getFornecedoresIndex();
        const q = safeLower(fornBusca?.value || "");
        const list = !q ? idx : idx.filter(f => safeLower(f.nome).includes(q) || safeLower(f.doc).includes(q));
        renderFornecedorTable(list);

        try { fornBusca && fornBusca.focus(); } catch (_) {}
      });
    }

    // Fechamento modal título
    if (btnModalClose) btnModalClose.addEventListener("click", () => closeModal(modal));
    if (btnCancelar) btnCancelar.addEventListener("click", () => closeModal(modal));

    // Fechamento modal fornecedor
    if (btnFornecedorClose) btnFornecedorClose.addEventListener("click", () => closeModal(modalFornecedor));

    if (btnFornecedorLimpar) {
      btnFornecedorLimpar.addEventListener("click", () => {
        UI.selectedFornecedorTmp = null;
        applySelectedFornecedor(null);
        closeModal(modalFornecedor);
        applyFiltersAndRender();
      });
    }

    if (btnFornecedorAplicar) {
      btnFornecedorAplicar.addEventListener("click", () => {
        applySelectedFornecedor(UI.selectedFornecedorTmp);
        closeModal(modalFornecedor);
        applyFiltersAndRender();
      });
    }

    if (fornBusca) {
      fornBusca.addEventListener("input", async () => {
        const idx = await getFornecedoresIndex();
        const q = safeLower(fornBusca.value || "");
        const list = !q ? idx : idx.filter(f => safeLower(f.nome).includes(q) || safeLower(f.doc).includes(q));
        renderFornecedorTable(list);
      });
    }

    // Esc fecha modais (premium)
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      if (modal && modal.classList.contains("open")) closeModal(modal);
      if (modalFornecedor && modalFornecedor.classList.contains("open")) closeModal(modalFornecedor);
    }, true);
  }

  // ---------------------------
  // Boot (determinístico)
  // ---------------------------
  function boot() {
    // estado inicial
    applySelectedFornecedor(null);
    bindEvents();
    applyFiltersAndRender();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

})();
// =====================================================================================
// UI — AÇÕES (Editar / Pagar / Cancelar) + SALVAR (premium, sem console)
// =====================================================================================
(() => {
  "use strict";
  if (!window.VSC_AP) return;

  const $ = (id) => document.getElementById(id);

  const elTblBody = $("tblBody");

  // modal título (IDs reais)
  const modal = $("modal");
  const modalTitle = $("modalTitle");
  const btnExcluir = $("btnExcluir");
  const btnSalvar = $("btnSalvar");

  const mFornecedorNome = $("mFornecedorNome");
  const mFornecedorDoc = $("mFornecedorDoc");
  const mDocumento = $("mDocumento");
  const mOrigem = $("mOrigem");
  const mCompetencia = $("mCompetencia");
  const mVencimento = $("mVencimento");
  const mValor = $("mValor");
  const mPagamento = $("mPagamento");
  const mObs = $("mObs");
  const mWarn = $("mWarn");

  // UI state compartilhado via window (sem expor muito)
  // (definido na parte 2/4; aqui só usa se existir)
  const UI = (window.__VSC_AP_UI__ = window.__VSC_AP_UI__ || { editingId: null });

  // Modal helpers (.modal.open)
  function openModal(el) {
    if (!el) return;
    el.classList.add("open");
    el.setAttribute("aria-hidden", "false");
  }
  function closeModal(el) {
    if (!el) return;
    el.classList.remove("open");
    el.setAttribute("aria-hidden", "true");
  }

  function showWarn(msg) {
    if (!mWarn) return;
    mWarn.textContent = msg || "";
    mWarn.style.display = msg ? "block" : "none";
  }
  function clearWarn() { showWarn(""); }

  function norm(s) { return String(s ?? "").trim(); }

  function readForm() {
    const fornecedor_nome = norm(mFornecedorNome?.value);
    const fornecedor_doc = norm(mFornecedorDoc?.value);
    const documento = norm(mDocumento?.value);
    const origem = norm(mOrigem?.value) || "manual";
    const competencia = norm(mCompetencia?.value);
    const vencimento = norm(mVencimento?.value);       // YYYY-MM-DD
    const pagamento_data = norm(mPagamento?.value);    // YYYY-MM-DD (opcional)
    const valor_centavos = window.VSC_AP._util.moneyToCentsBR(norm(mValor?.value));
    const obs = norm(mObs?.value);

    return {
      fornecedor_nome,
      fornecedor_doc,
      documento,
      origem,
      competencia,
      vencimento,
      pagamento_data,
      valor_centavos,
      obs
    };
  }

  // ---------------------------
  // Helpers repository
  // ---------------------------
  async function getById(id) {
    const list = await window.VSC_AP.loadAP();
    for (let i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) return list[i];
    }
    return null;
  }

  async function saveAndRefresh(obj) {
    await window.VSC_AP.upsertTitulo(obj);
    // refresh grid (disparar click em Recalcular se existir)
    const btnRecalc = $("btnRecalcular");
    if (btnRecalc) btnRecalc.click();
  }

  // ---------------------------
  // Validação premium (inline)
  // ---------------------------
  function validateForm(d) {
    if (!d.fornecedor_nome) return "Fornecedor é obrigatório.";
    if (!d.vencimento) return "Vencimento é obrigatório.";
    if (!d.valor_centavos || d.valor_centavos <= 0) return "Valor inválido.";
    return "";
  }

  // ---------------------------
  // Abrir modal em modo edição (View ≠ Edit)
  // - Aqui seguimos o contrato enterprise: clique em linha abre VIEW (travado)
  // - Editar é ação consciente (botão Editar)
  // Implementação: modal abre sempre editável, mas título muda e badge será no HTML futuro.
  // (Sem alterar HTML agora: mínimo diff no escopo do JS)
  // ---------------------------
  function fillForm(t) {
    const x = t || {};
    UI.editingId = x.id || null;
    clearWarn();

    if (mFornecedorNome) mFornecedorNome.value = x.fornecedor_nome || "";
    if (mFornecedorDoc) mFornecedorDoc.value = x.fornecedor_doc || "";
    if (mDocumento) mDocumento.value = x.documento || "";
    if (mOrigem) mOrigem.value = x.origem || "manual";
    if (mCompetencia) mCompetencia.value = x.competencia || "";
    if (mVencimento) mVencimento.value = x.vencimento || "";
    if (mValor) mValor.value = window.VSC_AP._util.centsToMoneyBR(x.valor_centavos || 0);
    if (mPagamento) mPagamento.value = x.pagamento_data || "";
    if (mObs) mObs.value = x.obs || "";
  }

  function openEdit(t) {
    if (modalTitle) modalTitle.textContent = "Editar título";
    if (btnExcluir) btnExcluir.style.display = "inline-flex";
    fillForm(t);
    openModal(modal);
    try { mFornecedorNome && mFornecedorNome.focus(); } catch (_) {}
  }

  function openNew(prefillFornecedor) {
    UI.editingId = null;
    clearWarn();
    if (modalTitle) modalTitle.textContent = "Novo título";
    if (btnExcluir) btnExcluir.style.display = "none";

    // limpa
    if (mFornecedorNome) mFornecedorNome.value = prefillFornecedor?.nome || "";
    if (mFornecedorDoc) mFornecedorDoc.value = prefillFornecedor?.doc || "";
    if (mDocumento) mDocumento.value = "";
    if (mOrigem) mOrigem.value = "manual";
    if (mCompetencia) mCompetencia.value = "";
    if (mVencimento) mVencimento.value = "";
    if (mValor) mValor.value = "";
    if (mPagamento) mPagamento.value = "";
    if (mObs) mObs.value = "";

    openModal(modal);
    try { mFornecedorNome && mFornecedorNome.focus(); } catch (_) {}
  }

  // ---------------------------
  // Ação: pagar (premium)
  // regra segura: pagar = preencher pagamento_data e marcar pago_centavos = valor_centavos
  // (sem exigir campo "data pagamento" no cadastro novo)
  // ---------------------------
  async function pagar(id) {
    const t = await getById(id);
    if (!t) return;

    // modal padrão para ação crítica (aqui, confirmação nativa; modal premium será padronizado depois)
    const ok = confirm("Confirmar pagamento deste título?");
    if (!ok) return;

    const hoje = new Date().toISOString().slice(0, 10);

    const novo = {
      ...t,
      pagamento_data: t.pagamento_data || hoje,
      pago_centavos: t.valor_centavos || 0,
      updated_at: new Date().toISOString()
    };
    // status derivado internamente no normalize
    await saveAndRefresh(novo);
  }

  // ---------------------------
  // Ação: cancelar (soft-delete)
  // ---------------------------
  async function cancelar(id) {
    const t = await getById(id);
    if (!t) return;

    const ok = confirm("Cancelar este título? (soft-delete)");
    if (!ok) return;

    const motivo = prompt("Motivo do cancelamento (opcional):") || "";

    const novo = {
      ...t,
      cancelado: true,
      cancelado_at: new Date().toISOString(),
      cancelado_motivo: String(motivo || "").trim(),
      updated_at: new Date().toISOString()
    };
    await saveAndRefresh(novo);
  }

  // ---------------------------
  // Delegação grid: ações
  // ---------------------------
  function bindGridActions() {
    if (!elTblBody) return;
    if (elTblBody.__vscBoundActions) return;
    elTblBody.__vscBoundActions = true;

    elTblBody.addEventListener("click", async (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest("button[data-act]") : null;
      if (!btn) return;

      const act = btn.getAttribute("data-act");
      const id = btn.getAttribute("data-id");
      if (!id) return;

      if (act === "editar") {
        const t = await getById(id);
        if (t) openEdit(t);
      }
      if (act === "pagar") await pagar(id);
      if (act === "cancelar") await cancelar(id);
    });
  }

  // ---------------------------
  // Salvar (novo/editar)
  // ---------------------------
  function bindSave() {
    if (!btnSalvar) return;
    if (btnSalvar.__vscBoundSave) return;
    btnSalvar.__vscBoundSave = true;

    btnSalvar.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();

      clearWarn();

      const d = readForm();
      const err = validateForm(d);
      if (err) { showWarn(err); return; }

      if (!UI.editingId) {
        // novo
        const obj = {
          id: (crypto?.randomUUID ? crypto.randomUUID() : undefined),
          fornecedor_nome: d.fornecedor_nome,
          fornecedor_doc: d.fornecedor_doc,
          documento: d.documento,
          origem: d.origem,
          competencia: d.competencia,
          vencimento: d.vencimento,
          pagamento_data: "",        // novo nasce em aberto (pagamento só no "Pagar")
          pago_centavos: 0,
          valor_centavos: d.valor_centavos,
          obs: d.obs,
          cancelado: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        await window.VSC_AP.upsertTitulo(obj);
      } else {
        // editar
        const base = await getById(UI.editingId);
        if (!base) { showWarn("Registro não encontrado."); return; }

        const obj = {
          ...base,
          fornecedor_nome: d.fornecedor_nome,
          fornecedor_doc: d.fornecedor_doc,
          documento: d.documento,
          origem: d.origem,
          competencia: d.competencia,
          vencimento: d.vencimento,
          valor_centavos: d.valor_centavos,
          obs: d.obs,
          // pagamento/pago_centavos só são alterados pelo fluxo "Pagar"
          updated_at: new Date().toISOString()
        };
        await window.VSC_AP.upsertTitulo(obj);
      }

      closeModal(modal);

      const btnRecalc = $("btnRecalcular");
      if (btnRecalc) btnRecalc.click();
    }, true);
  }

  // ---------------------------
  // Excluir (soft-delete via cancelar)
  // ---------------------------
  function bindExcluir() {
    if (!btnExcluir) return;
    if (btnExcluir.__vscBoundExcluir) return;
    btnExcluir.__vscBoundExcluir = true;

    btnExcluir.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();

      if (!UI.editingId) return;
      cancelar(UI.editingId);
      closeModal(modal);
      UI.editingId = null;
    }, true);
  }

  // ---------------------------
  // Hook: botão "+ Novo título" do HTML abre via evento já na parte 2,
  // mas aqui garantimos fallback se alguém chamar diretamente
  // ---------------------------
  function bindFallbackNovo() {
    const btnNovo = $("btnNovo");
    if (!btnNovo) return;
    if (btnNovo.__vscBoundFallbackNovo) return;
    btnNovo.__vscBoundFallbackNovo = true;

    btnNovo.addEventListener("click", () => {
      // não assume fornecedor selecionado aqui
      openNew(null);
    });
  }

  function boot() {
    bindGridActions();
    bindSave();
    bindExcluir();
    bindFallbackNovo();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

})();
// =====================================================================================
// KUX — Camada Premium de Teclado (data-entry) + Auditoria mínima (local-only)
// - Console limpo (não loga)
// - ENTER navega apenas em data-entry
// - Auditoria em localStorage (audit_log), retenção 500
// =====================================================================================
(() => {
  "use strict";
  if (!window.VSC_AP) return;

  const qs = (s, el = document) => el.querySelector(s);
  const qsa = (s, el = document) => Array.from(el.querySelectorAll(s));

  // ---------------------------
  // Auditoria mínima (AT) — local-only
  // ---------------------------
  const KEY_AUDIT = "audit_log";

  function safeJSONParse(txt, fallback) { try { return JSON.parse(txt); } catch (_) { return fallback; } }

  function loadAudit() {
    const raw = localStorage.getItem(KEY_AUDIT);
    const v = safeJSONParse(raw || "[]", []);
    return Array.isArray(v) ? v : [];
  }

  function saveAudit(list) {
    localStorage.setItem(KEY_AUDIT, JSON.stringify(Array.isArray(list) ? list : []));
  }

  function audit(evt) {
    const e = (evt && typeof evt === "object") ? evt : {};
    const row = {
      id: (crypto?.randomUUID ? crypto.randomUUID() : ("A-" + Date.now())),
      when: new Date().toISOString(),
      who: (localStorage.getItem("user_id") || "local"),
      where: location.pathname || "contasapagar",
      what: String(e.what || ""),
      entity_id: String(e.entity_id || ""),
      result: String(e.result || "ok")
    };
    const a = loadAudit();
    a.push(row);
    while (a.length > 500) a.shift();
    saveAudit(a);
  }

  // Wrap upsertTitulo para auditoria (sem quebrar API)
  if (!VSC_AP.__auditWrapped) {
    const _upsert = VSC_AP.upsertTitulo;
    VSC_AP.upsertTitulo = async function (obj) {
      const ok = await _upsert(obj);
      try { audit({ what: "AP_UPSERT", entity_id: obj?.id || "" }); } catch (_) {}
      return ok;
    };
    VSC_AP.__auditWrapped = true;
  }

  // ---------------------------
  // KUX — ENTER navega SOMENTE em data-entry
  // ---------------------------
  function isTextarea(el) { return el && el.tagName === "TEXTAREA"; }

  function isButtonLike(el) {
    if (!el) return false;
    const tag = (el.tagName || "").toUpperCase();
    if (tag === "BUTTON") return true;
    if (tag === "A") return true;
    if (tag === "SELECT") return true;
    const type = String(el.getAttribute?.("type") || "").toLowerCase();
    if (tag === "INPUT" && ["button","submit","checkbox","radio","file","range","color","date","time","datetime-local"].includes(type)) return true;
    return false;
  }

  function isComboboxLike(el) {
    if (!el) return false;
    const role = String(el.getAttribute?.("role") || "").toLowerCase();
    const aria = String(el.getAttribute?.("aria-autocomplete") || "").toLowerCase();
    if (role === "combobox") return true;
    if (aria) return true;
    return false;
  }

  function inGridContext(el) {
    const grid = el && el.closest ? el.closest('[data-kux="grid"]') : null;
    return !!grid;
  }

  function inDataEntryContext(el) {
    const de = el && el.closest ? el.closest('[data-kux="data-entry"]') : null;
    return !!de;
  }

  function focusNextField(fromEl) {
    const root = fromEl.closest('[data-kux="data-entry"]') || document;
    const focusables = qsa('input, select, textarea, button', root)
      .filter(x => !x.disabled && x.tabIndex !== -1 && x.offsetParent !== null);

    const idx = focusables.indexOf(fromEl);
    if (idx < 0) return;

    for (let i = idx + 1; i < focusables.length; i++) {
      const el = focusables[i];
      if (isButtonLike(el)) continue; // pular botões por padrão
      if (typeof el.focus === "function") { el.focus(); return; }
    }
  }

  if (!window.__VSC_AP_KUX_INSTALLED) {
    window.__VSC_AP_KUX_INSTALLED = true;

    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;

      const el = ev.target;
      if (!el) return;

      if (isTextarea(el)) return;
      if (isButtonLike(el)) return;
      if (isComboboxLike(el)) return;
      if (inGridContext(el)) return;
      if (!inDataEntryContext(el)) return;

      ev.preventDefault();
      focusNextField(el);
    }, true);
  }

  // ---------------------------
  // Foco premium: ao abrir modal, foco no 1º campo (reforço)
  // ---------------------------
  function focusFirstInModal(modalId, formId) {
    const m = document.getElementById(modalId);
    const f = document.getElementById(formId);
    if (!m || !f) return;
    const first = f.querySelector("input,select,textarea");
    if (first && typeof first.focus === "function") first.focus();
  }

  const mo = new MutationObserver((muts) => {
    for (const mu of muts) {
      if (mu.type !== "attributes" || mu.attributeName !== "class") continue;
      const el = mu.target;
      if (!(el instanceof HTMLElement)) continue;
      if (!el.classList.contains("open")) continue;

      if (el.id === "modal") focusFirstInModal("modal", "frmTitulo");
      if (el.id === "modalFornecedor") focusFirstInModal("modalFornecedor", "frmFornecedor");
    }
  });

  try {
    const m1 = document.getElementById("modal");
    const m2 = document.getElementById("modalFornecedor");
    m1 && mo.observe(m1, { attributes: true });
    m2 && mo.observe(m2, { attributes: true });
  } catch (_) {}

})();
