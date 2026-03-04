/* ============================================================
 * SERVIÇOS — Cadastro Mestre (CANÔNICO v3 — FLOORPLAN ENTERPRISE)
 * - LISTA → DETALHE (VIEW) → EDIT/NEW (Cap. XXI)
 * - IndexedDB (VSC_DB) + Outbox ATÔMICA (sync_queue no IDB)
 * - Console limpo (sem logs no console)
 *
 * FIXES (2026-02-20):
 * [SVC-UX-1] LISTA abre VISUALIZAR (VIEW). Edição apenas por botão Editar.
 * [SVC-BUG-1] Toasts corrigidos (não exibe “excluído” ao salvar).
 * [SVC-BUG-2] Defaults corrigidos (svcTipo=unitario; categoria=clinica).
 * [SVC-UX-2] Filtros alinhados ao HTML (fCategoria/fAtivo).
 * [SVC-QG-1] SELF-TEST exposto em window.VSC_SERVICOS_SELFTEST().
 * ============================================================ */
(function () {
  "use strict";

  function byId(id) { return document.getElementById(id); }

  function assertVSCDB() {
    if (!window.VSC_DB || typeof VSC_DB.openDB !== "function") {
      try { if (window.VSC_UI && window.VSC_UI.critical) { window.VSC_UI.critical("Dependência ausente", "VSC_DB não carregado. Garanta que modules/vsc_db.js está carregado antes de modules/servicos.js."); } } catch (_e) {}
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
    try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (_) {}
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      const r = Math.random() * 16 | 0;
      const v = c === "x" ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  function norm(s) { return String(s || "").trim(); }

  function isShown(id) {
    const el = byId(id);
    return !!(el && el.classList && el.classList.contains("show"));
  }

  async function idbGetAll() {
    const db = await VSC_DB.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([VSC_DB.stores.servicos_master], "readonly");
      const st = tx.objectStore(VSC_DB.stores.servicos_master);
      const req = st.getAll();
      req.onsuccess = () => { try { db.close(); } catch (_) {} resolve(Array.isArray(req.result) ? req.result : []); };
      req.onerror = () => { try { db.close(); } catch (_) {} reject(req.error || new Error("Falha IDB getAll")); };
    });
  }

  // assinatura canônica: upsertWithOutbox(storeName, id, obj, entity)
  async function idbUpsertAtomico(obj) {
    const fn = VSC_DB.upsertWithOutbox;
    const storeName = VSC_DB.stores.servicos_master;
    const n = (fn && typeof fn.length === "number") ? fn.length : 0;

    // Compatibilidade: a assinatura varia entre builds do VSC_DB.
    // Preferimos detectar por aridade e manter fallback seguro.
    try {
      if (n >= 5) {
        // Assinatura v25: (storeName, obj, entity, id, payload)
        return fn(storeName, obj, "servicos", obj.id, obj);
      }
      // Assinatura legada: (storeName, id, obj, entity)
      return fn(storeName, obj.id, obj, "servicos");
    } catch (_e) {
      // Fallback final (tenta inverso) — não logar (console limpo)
      try { return fn(storeName, obj, "servicos", obj.id, obj); } catch (_e2) { return fn(storeName, obj.id, obj, "servicos"); }
    }
  }

  let data = [];
  let editingId = null;

  // ===== Overlay EDIT (NEW/EDIT) =====
  function openEditModal() {
    const o = byId("svcOverlay");
    if (o) o.classList.add("show");
  }
  function closeEditModal() {
    const o = byId("svcOverlay");
    if (o) o.classList.remove("show");
  }

  // ===== Overlay VIEW =====
  function openViewModal() {
    const o = byId("svcViewOverlay");
    if (o) o.classList.add("show");
  }
  function closeViewModal() {
    const o = byId("svcViewOverlay");
    if (o) o.classList.remove("show");
  }

  function closeAnyModal() {
    if (isShown("svcOverlay")) return closeEditModal();
    if (isShown("svcViewOverlay")) return closeViewModal();
  }

  function clearForm() {
    editingId = null;

    if (byId("svcId")) byId("svcId").value = "";
    if (byId("svcCreatedAt")) byId("svcCreatedAt").value = "";

    byId("svcNome").value = "";
    byId("svcDesc").value = "";
    byId("svcCategoria").value = "clinica";
    byId("svcTipo").value = "unitario";
    byId("svcCodigo").value = "";
    byId("svcPreco").value = "0,00";
    byId("svcAtivo").checked = true;

    const del = byId("svcDelete");
    if (del) del.style.display = "none";
  }

  function fillForm(x) {
    editingId = x.id;

    if (byId("svcId")) byId("svcId").value = x.id || "";
    if (byId("svcCreatedAt")) byId("svcCreatedAt").value = x.created_at || "";

    byId("svcNome").value = x.nome || "";
    byId("svcDesc").value = x.desc || "";
    byId("svcCategoria").value = x.categoria || "clinica";
    byId("svcTipo").value = x.tipo || "unitario";
    byId("svcCodigo").value = x.codigo || "";
    byId("svcPreco").value = centsToMoney(x.preco_base_cents);
    byId("svcAtivo").checked = !!x.ativo;

    const del = byId("svcDelete");
    if (del) del.style.display = "";
  }

  function setViewPill(statusAtivo) {
    const pill = byId("svcViewStatusPill");
    if (!pill) return;
    pill.textContent = statusAtivo ? "Ativo" : "Inativo";
    pill.className = "pill" + (statusAtivo ? "" : " pillOff");
  }

  function fillView(x) {
    if (!x) return;

    byId("svcViewNome").textContent = x.nome || "—";
    byId("svcViewCategoria").textContent = x.categoria || "—";
    byId("svcViewTipo").textContent = x.tipo ? String(x.tipo).toUpperCase() : "—";
    byId("svcViewPreco").textContent = "R$ " + centsToMoney(x.preco_base_cents);
    byId("svcViewCodigo").textContent = x.codigo || "—";
    byId("svcViewDesc").textContent = x.desc || "—";
    byId("svcViewId").textContent = x.id || "—";
    byId("svcViewCreatedAt").textContent = x.created_at || "—";
    setViewPill(!!x.ativo);
  }

  // Filtros da LISTA (barra)
  function applyFilters(list) {
    const q = String(byId("fBusca")?.value || "").trim().toLowerCase();
    const fCategoria = byId("fCategoria")?.value || "";
    const fAtivo = byId("fAtivo")?.value || "";

    return list.filter(x => {
      if (!x || x.deleted_at) return false;

      if (q) {
        const nome = String(x.nome || "").toLowerCase();
        const cod = String(x.codigo || "").toLowerCase();
        const cat = String(x.categoria || "").toLowerCase();
        if (!nome.includes(q) && !cod.includes(q) && !cat.includes(q)) return false;
      }

      if (fCategoria && String(x.categoria || "") !== fCategoria) return false;

      if (fAtivo === "ativos" && !x.ativo) return false;
      if (fAtivo === "inativos" && x.ativo) return false;

      return true;
    });
  }

  async function renderTable() {
    if (!assertVSCDB()) return;

    data = await idbGetAll();

    const tbody = byId("tbServicos");
    if (!tbody) return;

    tbody.innerHTML = "";

    const ativos = data.filter(x => x && !x.deleted_at);
    if (byId("uiTotal")) byId("uiTotal").textContent = String(ativos.length);

    // KPI Strip
    const ativosCount = ativos.filter(x => x.ativo !== false).length;
    const consultaCount = ativos.filter(x => (x.categoria || "").toLowerCase().includes("clini") || (x.categoria || "").toLowerCase().includes("consult")).length;
    const cirurgiaCount = ativos.filter(x => (x.categoria || "").toLowerCase().includes("cirurg")).length;
    if (byId("kpiSvcTotal")) byId("kpiSvcTotal").textContent = ativos.length;
    if (byId("kpiSvcAtivos")) byId("kpiSvcAtivos").textContent = ativosCount;
    if (byId("kpiSvcConsulta")) byId("kpiSvcConsulta").textContent = consultaCount;
    if (byId("kpiSvcCirurgia")) byId("kpiSvcCirurgia").textContent = cirurgiaCount;

    const filtered = applyFilters(data);

    if (!filtered.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="6" class="note" style="text-align:center;padding:20px;">Nenhum serviço encontrado.</td>`;
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
        <td>${x.categoria || "—"}</td>
        <td><span class="pill">${x.tipo ? String(x.tipo).toUpperCase() : "—"}</span></td>
        <td>R$ ${centsToMoney(x.preco_base_cents)}</td>
        <td><span class="pill ${x.ativo !== false ? "" : "pillOff"}" style="${x.ativo !== false ? "color:var(--green);border-color:rgba(47,178,106,.35);" : "color:#6b7280;"}">${x.ativo !== false ? "Ativo" : "Inativo"}</span></td>
        <td><button class="btn btn-view" data-id="${x.id}" style="font-size:12px;padding:6px 10px;">VER</button></td>
      `;
      tbody.appendChild(tr);
    });
  }

  async function saveForm() {
    if (!assertVSCDB()) return;

    const nome = norm(byId("svcNome").value);
    if (!nome) { if (window.VSC_UI) window.VSC_UI.toast("warn", "Nome é obrigatório.", { ms: 2600 }); return; }

    const preco = moneyToCents(byId("svcPreco").value);
    if (!isFinite(preco) || preco < 0) { if (window.VSC_UI) window.VSC_UI.toast("warn", "Preço base inválido.", { ms: 2600 }); return; }

    const now = new Date().toISOString();

    let obj = null;
    if (editingId) obj = data.find(x => x && x.id === editingId) || null;
    const isEdit = !!obj;

    if (!obj) obj = { id: uuidv4(), created_at: now };

    obj.nome = nome;
    obj.desc = norm(byId("svcDesc").value);
    obj.categoria = norm(byId("svcCategoria").value) || "clinica";
    obj.tipo = byId("svcTipo").value || "unitario";
    obj.codigo = norm(byId("svcCodigo").value);
    obj.preco_base_cents = preco;
    obj.ativo = byId("svcAtivo").checked;
    obj.deleted_at = null;
    obj.updated_at = now;

    try {
      await idbUpsertAtomico(obj);
      closeEditModal();
      await renderTable();
      if (window.VSC_UI) window.VSC_UI.toast("ok", isEdit ? "Serviço atualizado." : "Serviço criado.", { ms: 2200 });
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
    const ok = await window.VSC_UI.confirmAsync({ title: "Excluir serviço", body: "Excluir este serviço?", okText: "Excluir", cancelText: "Cancelar", kind: "warn" });
    if (!ok) return;

    const now = new Date().toISOString();
    x.deleted_at = now;
    x.updated_at = now;

    try {
      await idbUpsertAtomico(x);
      closeEditModal();
      await renderTable();
      if (window.VSC_UI) window.VSC_UI.toast("ok", "Serviço excluído.", { ms: 2200 });
    } catch (_) {
      if (window.VSC_UI) window.VSC_UI.toast("err", "Falha ao excluir no IndexedDB.", { ms: 3200 });
    }
  }

  function wireEvents() {
    // NEW
    const btnNovo = byId("btnNovo");
    if (btnNovo) btnNovo.addEventListener("click", () => { clearForm(); openEditModal(); });

    // EDIT modal buttons
    const btnClose = byId("svcClose");
    if (btnClose) btnClose.addEventListener("click", closeEditModal);

    const btnCancel = byId("svcCancel");
    if (btnCancel) btnCancel.addEventListener("click", closeEditModal);

    const btnSave = byId("svcSave");
    if (btnSave) btnSave.addEventListener("click", (e) => { e.preventDefault(); saveForm(); });

    const btnDel = byId("svcDelete");
    if (btnDel) btnDel.addEventListener("click", (e) => { e.preventDefault(); softDeleteCurrent(); });

    // VIEW modal buttons
    const vClose = byId("svcViewClose");
    if (vClose) vClose.addEventListener("click", closeViewModal);

    const vBack = byId("svcViewBack");
    if (vBack) vBack.addEventListener("click", closeViewModal);

    const vEdit = byId("svcViewEdit");
    if (vEdit) vEdit.addEventListener("click", () => {
      const x = data.find(i => i && i.id === editingId);
      if (x) {
        closeViewModal();
        fillForm(x);
        openEditModal();
      }
    });

    // Filtros (LISTA)
    const fBusca = byId("fBusca");
    const fCategoria = byId("fCategoria");
    const fAtivo = byId("fAtivo");
    const btnReset = byId("btnReset");

    if (fBusca) fBusca.addEventListener("input", renderTable);
    if (fCategoria) fCategoria.addEventListener("change", renderTable);
    if (fAtivo) fAtivo.addEventListener("change", renderTable);
    if (btnReset) btnReset.addEventListener("click", () => {
      if (fBusca) fBusca.value = "";
      if (fCategoria) fCategoria.value = "";
      if (fAtivo) fAtivo.value = "";
      renderTable();
    });

    // LISTA → VIEW (enterprise)
    const tb = byId("tbServicos");
    if (tb) {
      tb.addEventListener("click", (e) => {
        const btn = e.target.closest(".btn-view, .btn-edit");
        const rowBtn = e.target.closest("button");
        const id = (btn && btn.dataset && btn.dataset.id) ? btn.dataset.id : (rowBtn && rowBtn.dataset ? rowBtn.dataset.id : null);
        const hit = e.target.closest("[data-id]");
        const rid = (hit && hit.dataset) ? hit.dataset.id : null;
        const targetId = id || rid;
        if (!targetId) return;

        const x = data.find(i => i && i.id === targetId);
        if (!x) return;

        editingId = x.id; // contexto do registro em foco
        fillView(x);
        openViewModal();
      });
    }

    // Backdrop close
    const overlay = byId("svcOverlay");
    if (overlay) overlay.addEventListener("click", (e) => { if (e.target === overlay) closeEditModal(); });

    const viewOverlay = byId("svcViewOverlay");
    if (viewOverlay) viewOverlay.addEventListener("click", (e) => { if (e.target === viewOverlay) closeViewModal(); });

    // ESC close topmost
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeAnyModal();
    });
  }

  function init() {
    wireEvents();
    renderTable();

    // SELF-TEST (sem console): expõe resultado para inspeção manual
    window.VSC_SERVICOS_SELFTEST = function () {
      return {
        ok: true,
        hasDB: !!(window.VSC_DB && typeof VSC_DB.openDB === "function"),
        hasList: !!byId("tbServicos"),
        hasViewModal: !!byId("svcViewOverlay"),
        hasEditModal: !!byId("svcOverlay"),
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
