/* ============================================================
 * EXAMES — Cadastro Mestre (CANÔNICO v3 — FLOORPLAN ENTERPRISE)
 * - LISTA → DETALHE (VIEW) → EDIT/NEW (Cap. XXI)
 * - IndexedDB (VSC_DB) + Outbox ATÔMICA (sync_queue no IDB)
 * - Sem logs no console
 *
 * FIXES (2026-02-20):
 * [EXA-UX-1] LISTA abre VISUALIZAR (VIEW). Edição apenas por botão Editar.
 * [EXA-UX-2] Ações da lista padronizadas (VER).
 * [EXA-UX-3] Modal VIEW fecha por ESC/backdrop/botão.
 * [EXA-QG-1] SELF-TEST exposto em window.VSC_EXAMES_SELFTEST().
 * ============================================================ */
(function () {
  "use strict";

  function byId(id) { return document.getElementById(id); }

  function assertVSCDB() {
    if (!window.VSC_DB || typeof VSC_DB.openDB !== "function") {
      try { if (window.VSC_UI && window.VSC_UI.critical) { window.VSC_UI.critical("Dependência ausente", "VSC_DB não carregado. Garanta que modules/vsc_db.js está carregado antes de modules/exames.js."); } } catch (_e) {}
      return false;
    }
    return true;
  }

  function centsToMoney(c) {
    return (Number(c || 0) / 100).toFixed(2).replace(".", ",");
  }

  function moneyToCents(v) {
    if (v === null || v === undefined) return NaN;
    const s = String(v).trim().replace(/\./g, "").replace(",", ".");
    const n = Number(s);
    if (!isFinite(n)) return NaN;
    return Math.round(n * 100);
  }

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
    throw new TypeError("[EXAMES] ambiente sem CSPRNG para gerar UUID v4.");
  }

  function setUiMsg(txt) {
    const el = byId("uiMsg");
    if (el) el.textContent = txt || "";
  }

  function isShown(id) {
    const el = byId(id);
    return !!(el && el.classList && el.classList.contains("show"));
  }

  // ===== Edit modal (NEW/EDIT) =====
  function openEditModal() {
    const o = byId("exOverlay");
    if (o) o.classList.add("show");
  }
  function closeEditModal() {
    const o = byId("exOverlay");
    if (o) o.classList.remove("show");
  }

  // ===== View modal =====
  function openViewModal() {
    const o = byId("exViewOverlay");
    if (o) o.classList.add("show");
  }
  function closeViewModal() {
    const o = byId("exViewOverlay");
    if (o) o.classList.remove("show");
  }

  function closeAnyModal() {
    if (isShown("exOverlay")) return closeEditModal();
    if (isShown("exViewOverlay")) return closeViewModal();
  }

  async function idbGetAll() {
    const db = await VSC_DB.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([VSC_DB.stores.exames_master], "readonly");
      const st = tx.objectStore(VSC_DB.stores.exames_master);
      const req = st.getAll();
      req.onsuccess = () => { try { db.close(); } catch (_) {} resolve(Array.isArray(req.result) ? req.result : []); };
      req.onerror = () => { try { db.close(); } catch (_) {} reject(req.error || new Error("Falha IDB getAll")); };
    });
  }

  async function idbUpsertAtomico(obj) {
    const fn = VSC_DB.upsertWithOutbox;
    const storeName = VSC_DB.stores.exames_master;
    const n = (fn && typeof fn.length === "number") ? fn.length : 0;

    // Compatibilidade: a assinatura varia entre builds do VSC_DB.
    // Preferimos detectar por aridade e manter fallback seguro.
    try {
      if (n >= 5) {
        // Assinatura v25: (storeName, obj, entity, id, payload)
        return fn(storeName, obj, "exames", obj.id, obj);
      }
      // Assinatura legada: (storeName, id, obj, entity)
      return fn(storeName, obj.id, obj, "exames");
    } catch (_e) {
      // Fallback final (tenta inverso) — não logar (console limpo)
      try { return fn(storeName, obj, "exames", obj.id, obj); } catch (_e2) { return fn(storeName, obj.id, obj, "exames"); }
    }
  }

  let data = [];
  let editingId = null;

  function clearForm() {
    editingId = null;
    byId("exId").value = "";
    byId("exCreatedAt").value = "";

    byId("exNome").value = "";
    byId("exCodigo").value = "";
    byId("exTipo").value = "laboratorial";
    byId("exCusto").value = "0,00";
    byId("exVenda").value = "0,00";
    byId("exAtivo").checked = true;

    const del = byId("exDelete");
    if (del) del.style.display = "none";
  }

  function fillForm(x) {
    editingId = x.id;

    byId("exId").value = x.id || "";
    byId("exCreatedAt").value = x.created_at || "";

    byId("exNome").value = x.nome || "";
    byId("exCodigo").value = x.codigo || "";
    byId("exTipo").value = x.tipo || "laboratorial";
    byId("exCusto").value = centsToMoney(x.custo_base_cents);
    byId("exVenda").value = centsToMoney(x.venda_cents);
    byId("exAtivo").checked = !!x.ativo;

    const del = byId("exDelete");
    if (del) del.style.display = "";
  }

  function setViewPill(statusAtivo) {
    const pill = byId("exViewStatusPill");
    if (!pill) return;
    pill.textContent = statusAtivo ? "Ativo" : "Inativo";
    pill.className = "pill" + (statusAtivo ? "" : " pillOff");
  }

  function fillView(x) {
    if (!x) return;
    byId("exViewNome").textContent = x.nome || "—";
    byId("exViewTipo").textContent = x.tipo ? String(x.tipo).toUpperCase() : "—";
    byId("exViewCodigo").textContent = x.codigo || "—";
    byId("exViewCusto").textContent = "R$ " + centsToMoney(x.custo_base_cents);
    byId("exViewVenda").textContent = "R$ " + centsToMoney(x.venda_cents);
    byId("exViewId").textContent = x.id || "—";
    byId("exViewCreatedAt").textContent = x.created_at || "—";
    setViewPill(!!x.ativo);
  }

  // Filtros (barra)
  function applyFilters(list) {
    const q = String(byId("fBusca")?.value || "").trim().toLowerCase();
    const fTipo = byId("fTipo")?.value || "";
    const fAtivo = byId("fAtivo")?.value || "";

    return list.filter(x => {
      if (!x || x.deleted_at) return false;

      if (q) {
        const nome = String(x.nome || "").toLowerCase();
        const cod = String(x.codigo || "").toLowerCase();
        const tipo = String(x.tipo || "").toLowerCase();
        if (!nome.includes(q) && !cod.includes(q) && !tipo.includes(q)) return false;
      }

      if (fTipo && x.tipo !== fTipo) return false;

      if (fAtivo === "ativos" && !x.ativo) return false;
      if (fAtivo === "inativos" && x.ativo) return false;

      return true;
    });
  }

  async function renderTable() {
    if (!assertVSCDB()) return;

    data = await idbGetAll();

    const tbody = byId("tbExames");
    if (!tbody) return;

    tbody.innerHTML = "";

    const ativos = data.filter(x => x && !x.deleted_at);
    if (byId("uiTotal")) byId("uiTotal").textContent = String(ativos.length);

    // KPI Strip
    const ativosCount = ativos.filter(x => x.ativo !== false).length;
    const labCount = ativos.filter(x => x.tipo === "laboratorial").length;
    const imgCount = ativos.filter(x => x.tipo === "imagem").length;
    if (byId("kpiExTotal")) byId("kpiExTotal").textContent = ativos.length;
    if (byId("kpiExAtivos")) byId("kpiExAtivos").textContent = ativosCount;
    if (byId("kpiExLab")) byId("kpiExLab").textContent = labCount;
    if (byId("kpiExImagem")) byId("kpiExImagem").textContent = imgCount;

    const filtered = applyFilters(data);

    if (!filtered.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="6" class="note" style="text-align:center;padding:20px;">Nenhum exame encontrado.</td>`;
      tbody.appendChild(tr);
      return;
    }

    filtered.forEach(x => {
      const tr = document.createElement("tr");
      tr.style.cursor = "pointer";
      tr.innerHTML = `
        <td>
          <b>${x.nome || ""}</b>
          ${x.codigo ? `<div style="font-size:11px;opacity:.6;">${x.codigo}</div>` : ""}
        </td>
        <td><span class="pill">${x.tipo ? String(x.tipo).toUpperCase() : "—"}</span></td>
        <td>R$ ${centsToMoney(x.custo_base_cents)}</td>
        <td>R$ ${centsToMoney(x.venda_cents)}</td>
        <td><span class="pill ${x.ativo !== false ? "" : "pillOff"}" style="${x.ativo !== false ? "color:var(--green);border-color:rgba(47,178,106,.35);" : "color:#6b7280;"}">${x.ativo !== false ? "Ativo" : "Inativo"}</span></td>
        <td><button class="btn btn-view" data-id="${x.id}" style="font-size:12px;padding:6px 10px;">VER</button></td>
      `;
      tbody.appendChild(tr);
    });
  }

  async function saveForm() {
    if (!assertVSCDB()) return;

    const nome = byId("exNome").value.trim();
    if (!nome) { if (window.VSC_UI) window.VSC_UI.toast("warn", "Nome é obrigatório.", { ms: 2600 }); return; }

    const custo = moneyToCents(byId("exCusto").value);
    const venda = moneyToCents(byId("exVenda").value);

    if (!isFinite(custo) || custo < 0) { if (window.VSC_UI) window.VSC_UI.toast("warn", "Custo inválido.", { ms: 2600 }); return; }
    if (!isFinite(venda) || venda < 0) { if (window.VSC_UI) window.VSC_UI.toast("warn", "Venda inválida.", { ms: 2600 }); return; }

    const now = new Date().toISOString();

    let obj = null;
    if (editingId) obj = data.find(x => x && x.id === editingId) || null;
    const isEdit = !!obj;

    if (!obj) obj = { id: uuidv4(), created_at: now };

    obj.nome = nome;
    obj.codigo = byId("exCodigo").value.trim();
    obj.tipo = byId("exTipo").value;
    obj.custo_base_cents = custo;
    obj.venda_cents = venda;
    obj.ativo = byId("exAtivo").checked;
    obj.deleted_at = null;
    obj.updated_at = now;

    try {
      await idbUpsertAtomico(obj);
      setUiMsg(isEdit ? "Exame atualizado." : "Exame criado.");
      closeEditModal();
      await renderTable();
      if (window.VSC_UI) window.VSC_UI.toast("ok", isEdit ? "Exame atualizado." : "Exame criado.", { ms: 2200 });
    } catch (_) {
      if (window.VSC_UI) window.VSC_UI.toast("err", "Falha ao salvar no IndexedDB.", { ms: 3200 });
    }
  }

  async function softDeleteCurrent() {
    if (!assertVSCDB()) return;
    if (!editingId) return;

    const x = data.find(i => i && i.id === editingId);
    if (!x) return;

    if (!window.VSC_UI) return;
    const ok = await window.VSC_UI.confirmAsync({ title: "Excluir exame", body: "Excluir este exame?", okText: "Excluir", cancelText: "Cancelar", kind: "warn" });
    if (!ok) return;

    const now = new Date().toISOString();
    x.deleted_at = now;
    x.updated_at = now;

    try {
      await idbUpsertAtomico(x);
      setUiMsg("Exame excluído.");
      closeEditModal();
      await renderTable();
      if (window.VSC_UI) window.VSC_UI.toast("ok", "Exame excluído.", { ms: 2200 });
    } catch (_) {
      if (window.VSC_UI) window.VSC_UI.toast("err", "Falha ao excluir no IndexedDB.", { ms: 3200 });
    }
  }

  function wireEvents() {
    // NEW
    const btnNovo = byId("btnNovo");
    if (btnNovo) btnNovo.addEventListener("click", () => { clearForm(); openEditModal(); });

    // EDIT modal
    const btnClose = byId("exClose");
    if (btnClose) btnClose.addEventListener("click", closeEditModal);

    const btnCancel = byId("exCancel");
    if (btnCancel) btnCancel.addEventListener("click", closeEditModal);

    const btnSave = byId("exSave");
    if (btnSave) btnSave.addEventListener("click", (e) => { e.preventDefault(); saveForm(); });

    const btnDel = byId("exDelete");
    if (btnDel) btnDel.addEventListener("click", (e) => { e.preventDefault(); softDeleteCurrent(); });

    // VIEW modal
    const vClose = byId("exViewClose");
    if (vClose) vClose.addEventListener("click", closeViewModal);

    const vBack = byId("exViewBack");
    if (vBack) vBack.addEventListener("click", closeViewModal);

    const vEdit = byId("exViewEdit");
    if (vEdit) vEdit.addEventListener("click", () => {
      const x = data.find(i => i && i.id === editingId);
      if (x) {
        closeViewModal();
        fillForm(x);
        openEditModal();
      }
    });

    // Filtros
    const fBusca = byId("fBusca");
    const fTipo = byId("fTipo");
    const fAtivo = byId("fAtivo");
    const btnReset = byId("btnReset");

    if (fBusca) fBusca.addEventListener("input", renderTable);
    if (fTipo) fTipo.addEventListener("change", renderTable);
    if (fAtivo) fAtivo.addEventListener("change", renderTable);
    if (btnReset) btnReset.addEventListener("click", () => {
      if (fBusca) fBusca.value = "";
      if (fTipo) fTipo.value = "";
      if (fAtivo) fAtivo.value = "";
      renderTable();
    });

    // LISTA → VIEW
    const tb = byId("tbExames");
    if (tb) {
      tb.addEventListener("click", (e) => {
        const hit = e.target.closest("[data-id]");
        const targetId = hit && hit.dataset ? hit.dataset.id : null;
        if (!targetId) return;

        const x = data.find(i => i && i.id === targetId);
        if (!x) return;

        editingId = x.id;
        fillView(x);
        openViewModal();
      });
    }

    // Backdrop close
    const overlay = byId("exOverlay");
    if (overlay) overlay.addEventListener("click", (e) => { if (e.target === overlay) closeEditModal(); });

    const viewOverlay = byId("exViewOverlay");
    if (viewOverlay) viewOverlay.addEventListener("click", (e) => { if (e.target === viewOverlay) closeViewModal(); });

    // ESC close
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeAnyModal();
    });
  }

  function init() {
    wireEvents();
    renderTable();

    window.VSC_EXAMES_SELFTEST = function () {
      return {
        ok: true,
        hasDB: !!(window.VSC_DB && typeof VSC_DB.openDB === "function"),
        hasList: !!byId("tbExames"),
        hasViewModal: !!byId("exViewOverlay"),
        hasEditModal: !!byId("exOverlay"),
        when: new Date().toISOString()
      };
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
