/* ============================================================
   VSC — MÓDULO REPRODUÇÃO EQUINA — v1.0
   Domínio: Casos reprodutivos (Ciclo → IA/Cobertura → Gestação → Parto)
   Padrão: offline-first, UUID v4, outbox, LISTA → DETALHE
   Literatura: Savana Equinos, Equinovet, EquinoMAX, HiMARK$,
               Stable Secretary, Crio Online + Reprodução equina CBRA
   ============================================================ */
(() => {
  "use strict";

  // ────── CONSTANTES ──────
  const STORE_CASES     = "repro_cases";
  const STORE_EXAMS     = "repro_exams";
  const STORE_PROTOCOLS = "repro_protocols";
  const STORE_EVENTS    = "repro_events";
  const STORE_PREGNANCY = "repro_pregnancy";
  const STORE_FOALING   = "repro_foaling";
  const STORE_TASKS     = "repro_tasks";
  const STORE_ANIMAIS   = "animais_master";
  const STORE_CLIENTES  = "clientes_master";

  // Gestação padrão equina = 340 dias (literatura CBRA)
  const GESTACAO_DIAS = 340;

  // Templates de tarefas automáticas pós-IA/cobertura
  const TASKS_POS_IA = [
    { dias: 2,  tipo: "USG pós-cobertura", desc: "Avaliar útero pós-cobertura (fluid?)" },
    { dias: 14, tipo: "Diagnóstico gestação", desc: "USG diagnóstico de gestação 14 dias" },
    { dias: 30, tipo: "Confirmação gestação", desc: "Confirmação USG 30 dias + batimento embrionário" },
    { dias: 45, tipo: "Reconfirmação gestação", desc: "Reconfirmação gestação 45 dias" },
  ];

  const TASKS_PRE_PARTO = [
    { dias: -30, tipo: "Vacina pré-parto", desc: "Vaccinar égua (Encefalomielite / Influenza / Hérpesvírus)" },
    { dias: -14, tipo: "Preparar parto", desc: "Verificar colostro e pré-disposição de parto" },
    { dias: -7,  tipo: "Monitoramento pré-parto", desc: "Vigilância noturna — lacto-score / secreção" },
  ];

  // ────── HELPERS ──────
  function uuid() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function now() { return new Date().toISOString(); }

  function addDays(dateStr, days) {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + days);
    return d.toISOString().split("T")[0];
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    const d = iso.includes("T") ? iso.split("T")[0] : iso;
    const [y, m, dy] = d.split("-");
    return `${dy}/${m}/${y}`;
  }

  function fmtDatetime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function diffDias(dataInicio, dataFim) {
    const a = new Date(dataInicio);
    const b = dataFim ? new Date(dataFim) : new Date();
    return Math.floor((b - a) / 86400000);
  }

  async function getDB() { return window.VSC_DB.openDB(); }

  async function dbGetAll(store) {
    const db = await getDB();
    return new Promise((res, rej) => {
      try {
        const tx = db.transaction([store], "readonly");
        const os = tx.objectStore(store);

        // Compat: alguns builds do VSC_DB não expõem helper getAll().
        if (typeof os.getAll === "function") {
          const req = os.getAll();
          req.onsuccess = () => res(req.result || []);
          req.onerror = () => rej(req.error);
          return;
        }

        const out = [];
        const cur = os.openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (c) { out.push(c.value); c.continue(); }
          else { res(out); }
        };
        cur.onerror = () => rej(cur.error);
      } catch (e) {
        rej(e);
      }
    });
  }

  async function dbPut(store, rec) {
    const db = await getDB();
    return new Promise((res, rej) => {
      const tx = db.transaction([store, "sync_queue", "sys_meta"], "readwrite");
      tx.objectStore(store).put(rec);
      // outbox
      tx.objectStore("sync_queue").add({
        id: uuid(), store, record_id: rec.id, op: "upsert",
        payload: rec, ts: now(), synced: false
      });
      tx.oncomplete = () => res(rec);
      tx.onerror = () => rej(tx.error);
    });
  }

  async function dbDelete(store, id) {
    const db = await getDB();
    return new Promise((res, rej) => {
      const tx = db.transaction([store, "sync_queue"], "readwrite");
      tx.objectStore(store).delete(id);
      tx.objectStore("sync_queue").add({
        id: uuid(), store, record_id: id, op: "delete", ts: now(), synced: false
      });
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  async function dbGet(store, id) {
    const db = await getDB();
    return new Promise((res, rej) => {
      const tx = db.transaction([store], "readonly");
      const req = tx.objectStore(store).get(id);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }

  async function getByIndex(store, indexName, value) {
    const db = await getDB();
    return new Promise((res, rej) => {
      const tx = db.transaction([store], "readonly");
      const idx = tx.objectStore(store).index(indexName);
      const req = idx.getAll(value);
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
  }

  // ────── ESTADO GLOBAL DO MÓDULO ──────
  let _state = {
    view: "list",          // list | detail
    detailTab: "timeline", // timeline | exames | protocolos | eventos | gestacao | tarefas
    caseId: null,
    cases: [],
    animais: [],
    clientes: [],
    searchTerm: "",
    filterStatus: "",
    filterSeason: "",
    filterAnimal: "",
    currentCase: null,
    caseExams: [],
    caseProtocols: [],
    caseEvents: [],
    casePregnancy: null,
    caseFoaling: null,
    caseTasks: [],
    editingId: null,
    editingType: null,
    toast: null,
    saving: false
  };

  function S() { return _state; }

  // ────── NOTIFICAÇÕES ──────
  function toast(msg, type = "success") {
    _state.toast = { msg, type, ts: Date.now() };
    render();
    setTimeout(() => { if (_state.toast) { _state.toast = null; render(); } }, 3500);
  }

  // ────── LÓGICA DE NEGÓCIO ──────

  async function createTasks(caseId, baseDate, templates) {
    for (const tmpl of templates) {
      const data = addDays(baseDate, tmpl.dias);
      const task = {
        id: uuid(), case_id: caseId,
        data_hora: data + "T08:00:00",
        tipo: tmpl.tipo,
        descricao: tmpl.desc || "",
        prioridade: "normal",
        status: "pendente",
        gerado_automatico: true,
        created_at: now(), updated_at: now()
      };
      await dbPut(STORE_TASKS, task);
    }
  }

  async function calcPrevisaoParto(dataCobertura) {
    return addDays(dataCobertura, GESTACAO_DIAS);
  }

  function statusLabel(s) {
    return {
      planejando: "Planejando",
      em_ciclo: "Em Ciclo",
      coberta_ia: "Coberta/IA",
      gestante: "Gestante",
      parida: "Parida",
      encerrada: "Encerrada",
      cancelada: "Cancelada"
    }[s] || s;
  }

  function statusColor(s) {
    return {
      planejando: "#6366f1",
      em_ciclo: "#f59e0b",
      coberta_ia: "#3b82f6",
      gestante: "#10b981",
      parida: "#8b5cf6",
      encerrada: "#6b7280",
      cancelada: "#ef4444"
    }[s] || "#6b7280";
  }

  function objetivoLabel(o) {
    return {
      cobrir: "Cobrir (Monta)", ia: "Inseminação Artificial",
      te: "Transferência de Embrião", icsi: "ICSI",
      diagnostico: "Diagnóstico", outro: "Outro"
    }[o] || o;
  }

  // ────── CARREGAMENTO DE DADOS ──────

  async function loadList() {
    const [cases, animais, clientes] = await Promise.all([
      dbGetAll(STORE_CASES),
      dbGetAll(STORE_ANIMAIS),
      dbGetAll(STORE_CLIENTES)
    ]);
    _state.cases = cases.filter(c => !c.deleted_at).sort((a, b) =>
      (b.created_at || "").localeCompare(a.created_at || ""));
    _state.animais = animais.filter(a => !a.deleted_at && (!a.sexo || a.sexo === "F" || a.sexo === "femea" || a.sexo === "fêmea"));
    _state.clientes = clientes.filter(c => !c.deleted_at);
  }

  async function loadDetail(caseId) {
    const [
      currentCase, exams, protocols, events,
      pregnancies, foapings, tasks
    ] = await Promise.all([
      dbGet(STORE_CASES, caseId),
      getByIndex(STORE_EXAMS, "by_case", caseId),
      getByIndex(STORE_PROTOCOLS, "by_case", caseId),
      getByIndex(STORE_EVENTS, "by_case", caseId),
      getByIndex(STORE_PREGNANCY, "by_case", caseId),
      getByIndex(STORE_FOALING, "by_case", caseId),
      getByIndex(STORE_TASKS, "by_case", caseId)
    ]);
    _state.currentCase = currentCase;
    _state.caseExams = exams.filter(x => !x.deleted_at).sort((a, b) => (b.data_hora || "").localeCompare(a.data_hora || ""));
    _state.caseProtocols = protocols.filter(x => !x.deleted_at);
    _state.caseEvents = events.filter(x => !x.deleted_at).sort((a, b) => (b.data_hora || "").localeCompare(a.data_hora || ""));
    _state.casePregnancy = pregnancies.filter(p => !p.deleted_at && p.status !== "perda" && p.status !== "aborto")[0] || null;
    _state.caseFoaling = foapings.filter(f => !f.deleted_at)[0] || null;
    _state.caseTasks = tasks.filter(t => !t.deleted_at).sort((a, b) => (a.data_hora || "").localeCompare(b.data_hora || ""));
  }

  // ────── AÇÕES (CRUD) ──────

  async function saveCase(form) {
    _state.saving = true; render();
    const isNew = !form.id;
    const rec = {
      id: form.id || uuid(),
      animal_id: form.animal_id,
      cliente_id: form.cliente_id || "",
      season_year: form.season_year || new Date().getFullYear(),
      objetivo: form.objetivo || "ia",
      status: form.status || "planejando",
      observacoes: form.observacoes || "",
      created_at: form.created_at || now(),
      updated_at: now()
    };
    await dbPut(STORE_CASES, rec);
    _state.saving = false;
    toast(isNew ? "Caso criado com sucesso!" : "Caso atualizado!");
    _state.caseId = rec.id;
    _state.editingId = null;
    _state.view = "detail";
    await loadDetail(rec.id);
    render();
  }

  async function saveExam(form) {
    _state.saving = true; render();
    const isNew = !form.id;
    const rec = {
      id: form.id || uuid(),
      case_id: _state.caseId,
      data_hora: form.data_hora || now(),
      tipo: form.tipo || "usg",
      ovario: form.ovario || "",
      foliculo_mm: parseFloat(form.foliculo_mm) || null,
      ovario2: form.ovario2 || "",
      foliculo2_mm: parseFloat(form.foliculo2_mm) || null,
      corpo_luteo: form.corpo_luteo || false,
      edema_uterino_score: parseInt(form.edema_uterino_score) || 0,
      cervix: form.cervix || "",
      uterus_fluid: form.uterus_fluid || false,
      uterus_fluid_mm: parseFloat(form.uterus_fluid_mm) || null,
      diagnostico_resumo: form.diagnostico_resumo || "",
      responsavel: form.responsavel || "",
      created_at: form.created_at || now(),
      updated_at: now()
    };
    await dbPut(STORE_EXAMS, rec);
    // Atualizar status do caso se exame mostra ovulação
    if (form.confirmar_ovulacao && _state.currentCase) {
      const c = { ..._state.currentCase, status: "coberta_ia", updated_at: now() };
      await dbPut(STORE_CASES, c);
    }
    _state.saving = false;
    _state.editingId = null;
    _state.editingType = null;
    toast(isNew ? "Exame registrado!" : "Exame atualizado!");
    await loadDetail(_state.caseId);
    render();
  }

  async function saveProtocol(form) {
    _state.saving = true; render();
    const isNew = !form.id;
    const rec = {
      id: form.id || uuid(),
      case_id: _state.caseId,
      nome_protocolo: form.nome_protocolo || "",
      droga: form.droga || "",
      dose: form.dose || "",
      via: form.via || "",
      frequencia: form.frequencia || "",
      data_inicio: form.data_inicio || "",
      data_fim: form.data_fim || "",
      gatilho: form.gatilho || "",
      responsavel: form.responsavel || "",
      status: form.status || "ativo",
      observacoes: form.observacoes || "",
      created_at: form.created_at || now(),
      updated_at: now()
    };
    await dbPut(STORE_PROTOCOLS, rec);
    _state.saving = false;
    _state.editingId = null;
    _state.editingType = null;
    toast(isNew ? "Protocolo registrado!" : "Protocolo atualizado!");
    await loadDetail(_state.caseId);
    render();
  }

  async function saveEvent(form) {
    _state.saving = true; render();
    const isNew = !form.id;
    const rec = {
      id: form.id || uuid(),
      case_id: _state.caseId,
      data_hora: form.data_hora || now(),
      metodo: form.metodo || "ia_refrigerado",
      garanhao_nome: form.garanhao_nome || "",
      garanhao_id: form.garanhao_id || "",
      semen_tipo: form.semen_tipo || "",
      semen_procedencia: form.semen_procedencia || "",
      dose_ml: parseFloat(form.dose_ml) || null,
      concentracao: form.concentracao || "",
      motilidade_perc: parseFloat(form.motilidade_perc) || null,
      local: form.local || "",
      responsavel: form.responsavel || "",
      observacoes: form.observacoes || "",
      created_at: form.created_at || now(),
      updated_at: now()
    };
    await dbPut(STORE_EVENTS, rec);
    // Atualizar status do caso + gerar tarefas automáticas pós-IA
    if (_state.currentCase) {
      const c = { ..._state.currentCase, status: "coberta_ia", updated_at: now() };
      await dbPut(STORE_CASES, c);
    }
    if (isNew) {
      await createTasks(_state.caseId, rec.data_hora.split("T")[0], TASKS_POS_IA);
    }
    _state.saving = false;
    _state.editingId = null;
    _state.editingType = null;
    toast(isNew ? "Cobertura/IA registrada! Tarefas geradas automaticamente." : "Evento atualizado!");
    await loadDetail(_state.caseId);
    render();
  }

  async function savePregnancy(form) {
    _state.saving = true; render();
    const isNew = !form.id;
    const prevParto = await calcPrevisaoParto(form.data_confirmacao);
    const rec = {
      id: form.id || uuid(),
      case_id: _state.caseId,
      data_confirmacao: form.data_confirmacao || "",
      metodo_confirmacao: form.metodo_confirmacao || "usg",
      data_prevista_parto: prevParto,
      status: form.status || "ativa",
      observacoes: form.observacoes || "",
      created_at: form.created_at || now(),
      updated_at: now()
    };
    await dbPut(STORE_PREGNANCY, rec);
    // Atualizar caso + gerar tarefas de pré-parto
    if (_state.currentCase) {
      const c = { ..._state.currentCase, status: "gestante", updated_at: now() };
      await dbPut(STORE_CASES, c);
    }
    if (isNew) {
      await createTasks(_state.caseId, prevParto, TASKS_PRE_PARTO);
    }
    _state.saving = false;
    _state.editingId = null;
    _state.editingType = null;
    toast(isNew ? `Gestação confirmada! Parto previsto: ${fmtDate(prevParto)}. Tarefas pré-parto geradas.` : "Gestação atualizada!");
    await loadDetail(_state.caseId);
    render();
  }

  async function saveFoaling(form) {
    _state.saving = true; render();
    const isNew = !form.id;
    const rec = {
      id: form.id || uuid(),
      case_id: _state.caseId,
      data_hora_parto: form.data_hora_parto || now(),
      tipo_parto: form.tipo_parto || "eutocico",
      potro_sexo: form.potro_sexo || "",
      potro_pelagem: form.potro_pelagem || "",
      potro_peso_kg: parseFloat(form.potro_peso_kg) || null,
      placenta_ok: form.placenta_ok || false,
      tempo_expulsao_placenta_min: parseFloat(form.tempo_expulsao_placenta_min) || null,
      apgar: form.apgar || "",
      complicacoes: form.complicacoes || "",
      observacoes: form.observacoes || "",
      created_at: form.created_at || now(),
      updated_at: now()
    };
    await dbPut(STORE_FOALING, rec);
    // Atualizar caso + gestação
    if (_state.currentCase) {
      const c = { ..._state.currentCase, status: "parida", updated_at: now() };
      await dbPut(STORE_CASES, c);
    }
    if (_state.casePregnancy) {
      const p = { ..._state.casePregnancy, status: "finalizada", updated_at: now() };
      await dbPut(STORE_PREGNANCY, p);
    }
    _state.saving = false;
    _state.editingId = null;
    _state.editingType = null;
    toast(isNew ? "Parto registrado com sucesso! 🐎" : "Registro atualizado!");
    await loadDetail(_state.caseId);
    render();
  }

  async function saveTask(form) {
    _state.saving = true; render();
    const isNew = !form.id;
    const rec = {
      id: form.id || uuid(),
      case_id: _state.caseId,
      data_hora: form.data_hora || now(),
      tipo: form.tipo || "",
      descricao: form.descricao || "",
      prioridade: form.prioridade || "normal",
      status: form.status || "pendente",
      gerado_automatico: form.gerado_automatico || false,
      created_at: form.created_at || now(),
      updated_at: now()
    };
    await dbPut(STORE_TASKS, rec);
    _state.saving = false;
    _state.editingId = null;
    _state.editingType = null;
    toast(isNew ? "Tarefa adicionada!" : "Tarefa atualizada!");
    await loadDetail(_state.caseId);
    render();
  }

  async function toggleTaskStatus(taskId) {
    const task = _state.caseTasks.find(t => t.id === taskId);
    if (!task) return;
    const updated = { ...task, status: task.status === "pendente" ? "feito" : "pendente", updated_at: now() };
    await dbPut(STORE_TASKS, updated);
    await loadDetail(_state.caseId);
    render();
  }

  async function deleteRec(store, id) {
    const rec = await dbGet(store, id);
    if (!rec) return;
    await dbPut(store, { ...rec, deleted_at: now(), updated_at: now() });
    await loadDetail(_state.caseId);
    toast("Registro removido.", "info");
    render();
  }

  // ────── RENDERIZAÇÃO ──────

  function getAnimalLabel(id) {
    const a = _state.animais.find(x => x.id === id) ||
              (async () => { return await dbGet(STORE_ANIMAIS, id); })();
    if (a && typeof a === "object" && a.nome) return a.nome;
    return id || "—";
  }

  function getClienteLabel(id) {
    const c = _state.clientes.find(x => x.id === id);
    return c ? c.nome : (id || "—");
  }

  function renderKpis(cases) {
    const total = cases.length;
    const gestantes = cases.filter(c => c.status === "gestante").length;
    const paridas = cases.filter(c => c.status === "parida").length;
    const emCiclo = cases.filter(c => c.status === "em_ciclo" || c.status === "coberta_ia").length;
    const season = new Date().getFullYear();

    return `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:14px 0;">
      <div class="card" style="padding:12px 14px;">
        <div style="font-size:11px;color:var(--muted);font-weight:800;text-transform:uppercase;">Casos Ativos</div>
        <div style="font-size:28px;font-weight:900;margin-top:4px;color:var(--primary);">${total}</div>
        <div style="font-size:12px;color:var(--muted);">Temporada ${season}</div>
      </div>
      <div class="card" style="padding:12px 14px;border-left:3px solid #f59e0b;">
        <div style="font-size:11px;color:var(--muted);font-weight:800;text-transform:uppercase;">Em Ciclo / IA</div>
        <div style="font-size:28px;font-weight:900;margin-top:4px;color:#f59e0b;">${emCiclo}</div>
        <div style="font-size:12px;color:var(--muted);">Aguardando diagnóstico</div>
      </div>
      <div class="card" style="padding:12px 14px;border-left:3px solid #10b981;">
        <div style="font-size:11px;color:var(--muted);font-weight:800;text-transform:uppercase;">Gestantes</div>
        <div style="font-size:28px;font-weight:900;margin-top:4px;color:#10b981;">${gestantes}</div>
        <div style="font-size:12px;color:var(--muted);">Em gestação confirmada</div>
      </div>
      <div class="card" style="padding:12px 14px;border-left:3px solid #8b5cf6;">
        <div style="font-size:11px;color:var(--muted);font-weight:800;text-transform:uppercase;">Paridas</div>
        <div style="font-size:28px;font-weight:900;margin-top:4px;color:#8b5cf6;">${paridas}</div>
        <div style="font-size:12px;color:var(--muted);">Partos realizados</div>
      </div>
    </div>`;
  }

  function renderList() {
    const S = _state;
    let filtered = S.cases;
    if (S.searchTerm) {
      const q = S.searchTerm.toLowerCase();
      filtered = filtered.filter(c =>
        (c.animal_id || "").toLowerCase().includes(q) ||
        getAnimalLabel(c.animal_id).toLowerCase().includes(q) ||
        getClienteLabel(c.cliente_id).toLowerCase().includes(q) ||
        (c.observacoes || "").toLowerCase().includes(q)
      );
    }
    if (S.filterStatus) filtered = filtered.filter(c => c.status === S.filterStatus);
    if (S.filterSeason) filtered = filtered.filter(c => String(c.season_year) === String(S.filterSeason));

    const seasons = [...new Set(S.cases.map(c => c.season_year))].sort((a, b) => b - a);

    return `
    <div class="repro-list">
      ${renderKpis(S.cases)}

      <div class="card" style="padding:14px 16px;margin-bottom:14px;">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
          <input type="text" id="reproSearch" placeholder="🔍 Buscar égua, cliente, obs..." value="${S.searchTerm}"
            style="flex:1;min-width:200px;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;"
            oninput="window.REPRO.onSearch(this.value)">
          <select style="padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px;" onchange="window.REPRO.onFilterStatus(this.value)">
            <option value="">Todos os status</option>
            <option value="planejando" ${S.filterStatus==="planejando"?"selected":""}>Planejando</option>
            <option value="em_ciclo" ${S.filterStatus==="em_ciclo"?"selected":""}>Em Ciclo</option>
            <option value="coberta_ia" ${S.filterStatus==="coberta_ia"?"selected":""}>Coberta/IA</option>
            <option value="gestante" ${S.filterStatus==="gestante"?"selected":""}>Gestante</option>
            <option value="parida" ${S.filterStatus==="parida"?"selected":""}>Parida</option>
            <option value="encerrada" ${S.filterStatus==="encerrada"?"selected":""}>Encerrada</option>
            <option value="cancelada" ${S.filterStatus==="cancelada"?"selected":""}>Cancelada</option>
          </select>
          <select style="padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px;" onchange="window.REPRO.onFilterSeason(this.value)">
            <option value="">Todas as temporadas</option>
            ${seasons.map(s => `<option value="${s}" ${S.filterSeason===String(s)?"selected":""}>${s}</option>`).join("")}
          </select>
          <button class="btn btn-primary" onclick="window.REPRO.openNew()"
            style="padding:8px 16px;font-size:13px;font-weight:700;white-space:nowrap;">
            + Novo Caso
          </button>
        </div>
      </div>

      ${filtered.length === 0 ? `
        <div class="card" style="padding:48px;text-align:center;color:var(--muted);">
          <div style="font-size:48px;margin-bottom:12px;">🐎</div>
          <div style="font-size:18px;font-weight:700;margin-bottom:8px;">Nenhum caso reprodutivo cadastrado</div>
          <div style="font-size:14px;margin-bottom:20px;">Inicie abrindo um novo caso para uma égua.</div>
          <button class="btn btn-primary" onclick="window.REPRO.openNew()">+ Abrir Primeiro Caso</button>
        </div>
      ` : `
        <div class="card" style="overflow:hidden;">
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr style="background:var(--surface);border-bottom:2px solid var(--border);">
                <th style="padding:10px 14px;text-align:left;font-size:11px;text-transform:uppercase;color:var(--muted);font-weight:800;">Égua</th>
                <th style="padding:10px 14px;text-align:left;font-size:11px;text-transform:uppercase;color:var(--muted);font-weight:800;">Cliente</th>
                <th style="padding:10px 14px;text-align:left;font-size:11px;text-transform:uppercase;color:var(--muted);font-weight:800;">Temporada</th>
                <th style="padding:10px 14px;text-align:left;font-size:11px;text-transform:uppercase;color:var(--muted);font-weight:800;">Objetivo</th>
                <th style="padding:10px 14px;text-align:left;font-size:11px;text-transform:uppercase;color:var(--muted);font-weight:800;">Status</th>
                <th style="padding:10px 14px;text-align:left;font-size:11px;text-transform:uppercase;color:var(--muted);font-weight:800;">Abertura</th>
              </tr>
            </thead>
            <tbody>
              ${filtered.map(c => {
                const cor = statusColor(c.status);
                return `<tr style="border-bottom:1px solid var(--border);cursor:pointer;transition:background 0.15s;"
                  onmouseover="this.style.background='var(--surface)'"
                  onmouseout="this.style.background=''"
                  onclick="window.REPRO.openDetail('${c.id}')">
                  <td style="padding:12px 14px;font-weight:700;">${getAnimalLabel(c.animal_id)}</td>
                  <td style="padding:12px 14px;color:var(--muted);">${getClienteLabel(c.cliente_id)}</td>
                  <td style="padding:12px 14px;color:var(--muted);">${c.season_year || "—"}</td>
                  <td style="padding:12px 14px;font-size:13px;">${objetivoLabel(c.objetivo)}</td>
                  <td style="padding:12px 14px;">
                    <span style="background:${cor}20;color:${cor};border:1px solid ${cor}55;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700;">${statusLabel(c.status)}</span>
                  </td>
                  <td style="padding:12px 14px;font-size:13px;color:var(--muted);">${fmtDate(c.created_at)}</td>
                </tr>`;
              }).join("")}
            </tbody>
          </table>
        </div>
      `}
    </div>`;
  }

  function renderCaseForm(existing) {
    const s = _state;
    const animaisTodos = s.animais.length > 0 ? s.animais : [];
    // Se não há animais fêmeas, mostrar todos os animais
    const animaisDisp = animaisTodos.length > 0 ? animaisTodos : (async () => await dbGetAll(STORE_ANIMAIS))();
    const todasAnimais = s.animais.concat(
      (window._REPRO_ALL_ANIMAIS || []).filter(a => !s.animais.find(x => x.id === a.id))
    );

    return `
    <div class="card" style="padding:24px;max-width:680px;">
      <h3 style="margin:0 0 20px;font-size:18px;font-weight:800;">${existing ? "✏️ Editar Caso Reprodutivo" : "🐎 Novo Caso Reprodutivo"}</h3>
      <form id="caseForm" onsubmit="return false;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
          <div style="grid-column:1/-1;">
            <label style="font-size:12px;font-weight:700;text-transform:uppercase;color:var(--muted);">Égua *</label>
            <select id="cf_animal_id" required style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;">
              <option value="">Selecione a égua...</option>
              ${todasAnimais.map(a => `<option value="${a.id}" ${existing?.animal_id===a.id?"selected":""}>${a.nome}${a.raca?" — "+a.raca:""}</option>`).join("")}
            </select>
          </div>
          <div>
            <label style="font-size:12px;font-weight:700;text-transform:uppercase;color:var(--muted);">Cliente / Proprietário</label>
            <select id="cf_cliente_id" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;">
              <option value="">Selecione...</option>
              ${s.clientes.map(c => `<option value="${c.id}" ${existing?.cliente_id===c.id?"selected":""}>${c.nome}</option>`).join("")}
            </select>
          </div>
          <div>
            <label style="font-size:12px;font-weight:700;text-transform:uppercase;color:var(--muted);">Temporada *</label>
            <input type="number" id="cf_season" value="${existing?.season_year || new Date().getFullYear()}" min="2000" max="2099"
              style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;box-sizing:border-box;">
          </div>
          <div>
            <label style="font-size:12px;font-weight:700;text-transform:uppercase;color:var(--muted);">Objetivo *</label>
            <select id="cf_objetivo" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;">
              <option value="ia" ${existing?.objetivo==="ia"?"selected":""}>Inseminação Artificial (IA)</option>
              <option value="cobrir" ${existing?.objetivo==="cobrir"?"selected":""}>Cobertura (Monta Natural)</option>
              <option value="te" ${existing?.objetivo==="te"?"selected":""}>Transferência de Embrião (TE)</option>
              <option value="icsi" ${existing?.objetivo==="icsi"?"selected":""}>ICSI</option>
              <option value="diagnostico" ${existing?.objetivo==="diagnostico"?"selected":""}>Diagnóstico Reprodutivo</option>
              <option value="outro" ${existing?.objetivo==="outro"?"selected":""}>Outro</option>
            </select>
          </div>
          <div>
            <label style="font-size:12px;font-weight:700;text-transform:uppercase;color:var(--muted);">Status Inicial</label>
            <select id="cf_status" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;">
              <option value="planejando" ${existing?.status==="planejando"?"selected":""}>Planejando</option>
              <option value="em_ciclo" ${existing?.status==="em_ciclo"?"selected":""}>Em Ciclo</option>
              <option value="coberta_ia" ${existing?.status==="coberta_ia"?"selected":""}>Coberta/IA</option>
              <option value="gestante" ${existing?.status==="gestante"?"selected":""}>Gestante</option>
              <option value="encerrada" ${existing?.status==="encerrada"?"selected":""}>Encerrada</option>
              <option value="cancelada" ${existing?.status==="cancelada"?"selected":""}>Cancelada</option>
            </select>
          </div>
          <div style="grid-column:1/-1;">
            <label style="font-size:12px;font-weight:700;text-transform:uppercase;color:var(--muted);">Observações</label>
            <textarea id="cf_obs" rows="3" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;resize:vertical;box-sizing:border-box;">${existing?.observacoes || ""}</textarea>
          </div>
        </div>
        <div style="display:flex;gap:10px;margin-top:20px;">
          <button class="btn btn-primary" onclick="window.REPRO.submitCase(${existing ? `'${existing.id}'` : 'null'})" ${s.saving?"disabled":""} style="padding:10px 24px;font-weight:700;">
            ${s.saving ? "Salvando..." : (existing ? "💾 Salvar Alterações" : "✅ Criar Caso")}
          </button>
          <button class="btn" onclick="window.REPRO.cancelEdit()" style="padding:10px 20px;">Cancelar</button>
        </div>
      </form>
    </div>`;
  }

  function renderExamForm(existing) {
    const dt = existing?.data_hora?.split("T");
    return `
    <div class="card" style="padding:24px;max-width:720px;">
      <h3 style="margin:0 0 20px;font-size:17px;font-weight:800;">🔬 ${existing ? "Editar" : "Novo"} Exame / Controle Folicular</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div>
          <label style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--muted);">Data / Hora *</label>
          <input type="datetime-local" id="ef_data" value="${existing?.data_hora?.substring(0,16) || new Date().toISOString().substring(0,16)}"
            style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--muted);">Tipo</label>
          <select id="ef_tipo" style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;">
            <option value="usg" ${existing?.tipo==="usg"?"selected":""}>USG Transretal</option>
            <option value="palpacao" ${existing?.tipo==="palpacao"?"selected":""}>Palpação Retal</option>
            <option value="citologia" ${existing?.tipo==="citologia"?"selected":""}>Citologia Uterina</option>
            <option value="cultura" ${existing?.tipo==="cultura"?"selected":""}>Cultura Uterina</option>
            <option value="coleta_ovocito" ${existing?.tipo==="coleta_ovocito"?"selected":""}>Coleta Oócito (OPU)</option>
            <option value="outro" ${existing?.tipo==="outro"?"selected":""}>Outro</option>
          </select>
        </div>
        <div style="grid-column:1/-1;font-size:12px;font-weight:800;text-transform:uppercase;color:var(--muted);padding-top:6px;border-top:1px solid var(--border);">Ovário Esquerdo (OE)</div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Folículo OE (mm)</label>
          <input type="number" id="ef_foliculo_mm" value="${existing?.foliculo_mm || ""}" placeholder="ex: 38" step="0.5" min="0" max="90"
            style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Corpo Lúteo OE</label>
          <select id="ef_corpo_luteo" style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;">
            <option value="">Não detectado</option>
            <option value="presente" ${existing?.corpo_luteo==="presente"?"selected":""}>Presente</option>
            <option value="em_regressao" ${existing?.corpo_luteo==="em_regressao"?"selected":""}>Em regressão</option>
          </select>
        </div>
        <div style="grid-column:1/-1;font-size:12px;font-weight:800;text-transform:uppercase;color:var(--muted);padding-top:6px;border-top:1px solid var(--border);">Ovário Direito (OD)</div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Folículo OD (mm)</label>
          <input type="number" id="ef_foliculo2_mm" value="${existing?.foliculo2_mm || ""}" placeholder="ex: 20" step="0.5" min="0" max="90"
            style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">CL OD</label>
          <select id="ef_corpo_luteo2" style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;">
            <option value="">Não detectado</option>
            <option value="presente" ${existing?.ovario2==="presente"?"selected":""}>Presente</option>
            <option value="em_regressao" ${existing?.ovario2==="em_regressao"?"selected":""}>Em regressão</option>
          </select>
        </div>
        <div style="grid-column:1/-1;font-size:12px;font-weight:800;text-transform:uppercase;color:var(--muted);padding-top:6px;border-top:1px solid var(--border);">Útero</div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Edema Uterino (0–4)</label>
          <select id="ef_edema" style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;">
            <option value="0" ${(existing?.edema_uterino_score||0)==0?"selected":""}>0 — Ausente (Diestro)</option>
            <option value="1" ${(existing?.edema_uterino_score)==1?"selected":""}>1 — Leve</option>
            <option value="2" ${(existing?.edema_uterino_score)==2?"selected":""}>2 — Moderado</option>
            <option value="3" ${(existing?.edema_uterino_score)==3?"selected":""}>3 — Intenso (pre-ovulatório)</option>
            <option value="4" ${(existing?.edema_uterino_score)==4?"selected":""}>4 — Excessivo</option>
          </select>
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Cérvix</label>
          <select id="ef_cervix" style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;">
            <option value="">—</option>
            <option value="aberta" ${existing?.cervix==="aberta"?"selected":""}>Aberta (Estro)</option>
            <option value="entreaberta" ${existing?.cervix==="entreaberta"?"selected":""}>Entreaberta</option>
            <option value="fechada" ${existing?.cervix==="fechada"?"selected":""}>Fechada (Diestro)</option>
          </select>
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Fluid Uterino</label>
          <select id="ef_fluid" style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;">
            <option value="" ${!existing?.uterus_fluid?"selected":""}>Não detectado</option>
            <option value="leve" ${existing?.uterus_fluid==="leve"?"selected":""}>Leve</option>
            <option value="moderado" ${existing?.uterus_fluid==="moderado"?"selected":""}>Moderado</option>
            <option value="intenso" ${existing?.uterus_fluid==="intenso"?"selected":""}>Intenso</option>
          </select>
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Responsável</label>
          <input type="text" id="ef_resp" value="${existing?.responsavel || ""}" placeholder="Nome do veterinário"
            style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;box-sizing:border-box;">
        </div>
        <div style="grid-column:1/-1;">
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Diagnóstico / Resumo</label>
          <textarea id="ef_diag" rows="3" style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;resize:vertical;box-sizing:border-box;">${existing?.diagnostico_resumo || ""}</textarea>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-top:16px;">
        <button class="btn btn-primary" onclick="window.REPRO.submitExam(${existing?`'${existing.id}'`:"null"})" style="padding:9px 20px;font-weight:700;">
          ${existing ? "💾 Salvar" : "✅ Registrar Exame"}
        </button>
        <button class="btn" onclick="window.REPRO.cancelEdit()" style="padding:9px 16px;">Cancelar</button>
      </div>
    </div>`;
  }

  function renderEventForm(existing) {
    return `
    <div class="card" style="padding:24px;max-width:680px;">
      <h3 style="margin:0 0 20px;font-size:17px;font-weight:800;">💉 ${existing ? "Editar" : "Registrar"} Cobertura / IA / Monta</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div>
          <label style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--muted);">Data / Hora *</label>
          <input type="datetime-local" id="ev_data" value="${existing?.data_hora?.substring(0,16) || new Date().toISOString().substring(0,16)}"
            style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--muted);">Método *</label>
          <select id="ev_metodo" style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;">
            <option value="ia_refrigerado" ${existing?.metodo==="ia_refrigerado"?"selected":""}>IA — Sêmen Refrigerado</option>
            <option value="ia_congelado" ${existing?.metodo==="ia_congelado"?"selected":""}>IA — Sêmen Congelado</option>
            <option value="ia_fresco" ${existing?.metodo==="ia_fresco"?"selected":""}>IA — Sêmen Fresco</option>
            <option value="monta_natural" ${existing?.metodo==="monta_natural"?"selected":""}>Monta Natural</option>
            <option value="te_lavado" ${existing?.metodo==="te_lavado"?"selected":""}>TE — Lavado Embrionário</option>
            <option value="icsi" ${existing?.metodo==="icsi"?"selected":""}>ICSI</option>
            <option value="opu_te" ${existing?.metodo==="opu_te"?"selected":""}>OPU + TE</option>
          </select>
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Garanhão</label>
          <input type="text" id="ev_garanhao" value="${existing?.garanhao_nome || ""}" placeholder="Nome do garanhão"
            style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Procedência do Sêmen</label>
          <input type="text" id="ev_procedencia" value="${existing?.semen_procedencia || ""}" placeholder="Central / Propriedade"
            style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Dose (ml)</label>
          <input type="number" id="ev_dose" value="${existing?.dose_ml || ""}" step="0.5" min="0"
            style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Motilidade (%)</label>
          <input type="number" id="ev_motilidade" value="${existing?.motilidade_perc || ""}" min="0" max="100"
            style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Concentração</label>
          <input type="text" id="ev_concentracao" value="${existing?.concentracao || ""}" placeholder="ex: 500×10⁶/ml"
            style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Local</label>
          <input type="text" id="ev_local" value="${existing?.local || ""}" placeholder="Propriedade / Clínica"
            style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Responsável</label>
          <input type="text" id="ev_resp" value="${existing?.responsavel || ""}"
            style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;box-sizing:border-box;">
        </div>
        <div style="grid-column:1/-1;">
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Observações</label>
          <textarea id="ev_obs" rows="2" style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;resize:vertical;box-sizing:border-box;">${existing?.observacoes || ""}</textarea>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-top:16px;">
        <button class="btn btn-primary" onclick="window.REPRO.submitEvent(${existing?`'${existing.id}'`:"null"})" style="padding:9px 20px;font-weight:700;">
          ${existing ? "💾 Salvar" : "✅ Registrar Cobertura/IA"}
        </button>
        <button class="btn" onclick="window.REPRO.cancelEdit()" style="padding:9px 16px;">Cancelar</button>
      </div>
    </div>`;
  }

  function renderProtocolForm(existing) {
    return `
    <div class="card" style="padding:24px;max-width:660px;">
      <h3 style="margin:0 0 20px;font-size:17px;font-weight:800;">💊 ${existing ? "Editar" : "Novo"} Protocolo Hormonal</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div style="grid-column:1/-1;">
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Nome do Protocolo *</label>
          <input type="text" id="pf_nome" value="${existing?.nome_protocolo || ""}" placeholder="ex: Indução de ovulação hCG / Sincronização P4+eCG"
            style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Droga / Produto</label>
          <input type="text" id="pf_droga" value="${existing?.droga || ""}" placeholder="ex: hCG 2500UI, Deslorelina, PGF2α"
            style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Dose</label>
          <input type="text" id="pf_dose" value="${existing?.dose || ""}" placeholder="ex: 2500 UI"
            style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Via</label>
          <select id="pf_via" style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;">
            <option value="">—</option>
            <option value="im" ${existing?.via==="im"?"selected":""}>IM (intramuscular)</option>
            <option value="iv" ${existing?.via==="iv"?"selected":""}>IV (intravenosa)</option>
            <option value="sc" ${existing?.via==="sc"?"selected":""}>SC (subcutânea)</option>
            <option value="intrauterino" ${existing?.via==="intrauterino"?"selected":""}>Intrauterino</option>
            <option value="oral" ${existing?.via==="oral"?"selected":""}>Oral</option>
            <option value="vaginal" ${existing?.via==="vaginal"?"selected":""}>Vaginal (dispositivo P4)</option>
          </select>
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Frequência</label>
          <input type="text" id="pf_freq" value="${existing?.frequencia || ""}" placeholder="ex: Dose única, BID, SID"
            style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Data Início</label>
          <input type="date" id="pf_inicio" value="${existing?.data_inicio || ""}"
            style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Data Fim</label>
          <input type="date" id="pf_fim" value="${existing?.data_fim || ""}"
            style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;box-sizing:border-box;">
        </div>
        <div style="grid-column:1/-1;">
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Gatilho / Condição</label>
          <input type="text" id="pf_gatilho" value="${existing?.gatilho || ""}" placeholder="ex: Aplicar quando folículo ≥ 35mm"
            style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Responsável</label>
          <input type="text" id="pf_resp" value="${existing?.responsavel || ""}"
            style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Status</label>
          <select id="pf_status" style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;">
            <option value="ativo" ${existing?.status==="ativo"?"selected":""}>Ativo</option>
            <option value="concluido" ${existing?.status==="concluido"?"selected":""}>Concluído</option>
            <option value="suspenso" ${existing?.status==="suspenso"?"selected":""}>Suspenso</option>
          </select>
        </div>
        <div style="grid-column:1/-1;">
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Observações</label>
          <textarea id="pf_obs" rows="2" style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;resize:vertical;box-sizing:border-box;">${existing?.observacoes || ""}</textarea>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-top:16px;">
        <button class="btn btn-primary" onclick="window.REPRO.submitProtocol(${existing?`'${existing.id}'`:"null"})" style="padding:9px 20px;font-weight:700;">
          ${existing ? "💾 Salvar" : "✅ Registrar Protocolo"}
        </button>
        <button class="btn" onclick="window.REPRO.cancelEdit()" style="padding:9px 16px;">Cancelar</button>
      </div>
    </div>`;
  }

  function renderPregnancyForm(existing) {
    return `
    <div class="card" style="padding:24px;max-width:580px;">
      <h3 style="margin:0 0 20px;font-size:17px;font-weight:800;">🤰 ${existing ? "Editar" : "Confirmar"} Gestação</h3>
      <p style="font-size:13px;color:var(--muted);margin:0 0 16px;">O sistema calculará automaticamente a data prevista de parto (gestação padrão: ${GESTACAO_DIAS} dias) e gerará tarefas de pré-parto.</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Data de Confirmação *</label>
          <input type="date" id="pg_data" value="${existing?.data_confirmacao || new Date().toISOString().split("T")[0]}"
            style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Método de Confirmação</label>
          <select id="pg_metodo" style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;">
            <option value="usg" ${existing?.metodo_confirmacao==="usg"?"selected":""}>USG Transretal</option>
            <option value="palpacao" ${existing?.metodo_confirmacao==="palpacao"?"selected":""}>Palpação Retal</option>
            <option value="hormonal" ${existing?.metodo_confirmacao==="hormonal"?"selected":""}>Dosagem Hormonal (eCG/P4)</option>
          </select>
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Status</label>
          <select id="pg_status" style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;">
            <option value="ativa" ${existing?.status==="ativa"?"selected":""}>Ativa</option>
            <option value="perda" ${existing?.status==="perda"?"selected":""}>Perda embrionária</option>
            <option value="aborto" ${existing?.status==="aborto"?"selected":""}>Aborto</option>
            <option value="finalizada" ${existing?.status==="finalizada"?"selected":""}>Finalizada (Parida)</option>
          </select>
        </div>
        <div style="grid-column:1/-1;">
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Observações</label>
          <textarea id="pg_obs" rows="2" style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;resize:vertical;box-sizing:border-box;">${existing?.observacoes || ""}</textarea>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-top:16px;">
        <button class="btn btn-primary" onclick="window.REPRO.submitPregnancy(${existing?`'${existing.id}'`:"null"})" style="padding:9px 20px;font-weight:700;">
          ${existing ? "💾 Salvar" : "✅ Confirmar Gestação"}
        </button>
        <button class="btn" onclick="window.REPRO.cancelEdit()" style="padding:9px 16px;">Cancelar</button>
      </div>
    </div>`;
  }

  function renderFoalingForm(existing) {
    return `
    <div class="card" style="padding:24px;max-width:620px;">
      <h3 style="margin:0 0 20px;font-size:17px;font-weight:800;">🐣 ${existing ? "Editar" : "Registrar"} Parto</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Data / Hora do Parto *</label>
          <input type="datetime-local" id="ff_data" value="${existing?.data_hora_parto?.substring(0,16) || new Date().toISOString().substring(0,16)}"
            style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Tipo de Parto</label>
          <select id="ff_tipo" style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;">
            <option value="eutocico" ${existing?.tipo_parto==="eutocico"?"selected":""}>Eutócico (Normal)</option>
            <option value="distocico" ${existing?.tipo_parto==="distocico"?"selected":""}>Distócico (Assistido)</option>
            <option value="cesarea" ${existing?.tipo_parto==="cesarea"?"selected":""}>Cesárea</option>
          </select>
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Sexo do Potro</label>
          <select id="ff_potro_sexo" style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;">
            <option value="">—</option>
            <option value="M" ${existing?.potro_sexo==="M"?"selected":""}>Macho</option>
            <option value="F" ${existing?.potro_sexo==="F"?"selected":""}>Fêmea</option>
          </select>
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Pelagem / Cor do Potro</label>
          <input type="text" id="ff_pelagem" value="${existing?.potro_pelagem || ""}" placeholder="ex: Alazão, Baio..."
            style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Peso ao Nascer (kg)</label>
          <input type="number" id="ff_peso" value="${existing?.potro_peso_kg || ""}" step="0.5" min="0"
            style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">APGAR neonatal</label>
          <select id="ff_apgar" style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;">
            <option value="">—</option>
            <option value="bom" ${existing?.apgar==="bom"?"selected":""}>Bom (≥7)</option>
            <option value="regular" ${existing?.apgar==="regular"?"selected":""}>Regular (4–6)</option>
            <option value="ruim" ${existing?.apgar==="ruim"?"selected":""}>Ruim (≤3)</option>
          </select>
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Placenta Expulsa</label>
          <select id="ff_placenta" style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;">
            <option value="" ${!existing?.placenta_ok?"selected":""}>Não / Retenção</option>
            <option value="ok" ${existing?.placenta_ok==="ok"?"selected":""}>Sim, completa</option>
            <option value="incompleta" ${existing?.placenta_ok==="incompleta"?"selected":""}>Incompleta</option>
          </select>
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Tempo Expulsão Placenta (min)</label>
          <input type="number" id="ff_tempo_plac" value="${existing?.tempo_expulsao_placenta_min || ""}" min="0"
            style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;box-sizing:border-box;">
        </div>
        <div style="grid-column:1/-1;">
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Complicações / Observações</label>
          <textarea id="ff_obs" rows="3" style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;resize:vertical;box-sizing:border-box;">${existing?.observacoes || ""}</textarea>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-top:16px;">
        <button class="btn btn-primary" onclick="window.REPRO.submitFoaling(${existing?`'${existing.id}'`:"null"})" style="padding:9px 20px;font-weight:700;">
          ${existing ? "💾 Salvar" : "✅ Registrar Parto"}
        </button>
        <button class="btn" onclick="window.REPRO.cancelEdit()" style="padding:9px 16px;">Cancelar</button>
      </div>
    </div>`;
  }

  function renderTimeline() {
    const S = _state;
    const events = [];

    // Montar timeline unificada
    S.caseExams.forEach(e => events.push({ ts: e.data_hora, tipo: "exam", rec: e }));
    S.caseProtocols.forEach(p => events.push({ ts: p.data_inicio || p.created_at, tipo: "protocol", rec: p }));
    S.caseEvents.forEach(e => events.push({ ts: e.data_hora, tipo: "event", rec: e }));
    if (S.casePregnancy) events.push({ ts: S.casePregnancy.data_confirmacao, tipo: "pregnancy", rec: S.casePregnancy });
    if (S.caseFoaling) events.push({ ts: S.caseFoaling.data_hora_parto, tipo: "foaling", rec: S.caseFoaling });

    events.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));

    if (events.length === 0) {
      return `<div style="padding:40px;text-align:center;color:var(--muted);">
        <div style="font-size:36px;margin-bottom:12px;">📋</div>
        <div style="font-weight:700;">Nenhum registro ainda</div>
        <div style="font-size:13px;margin-top:6px;">Adicione exames, protocolos, cobertura/IA ou gestação para ver a linha do tempo.</div>
      </div>`;
    }

    return `<div style="padding:0 4px;">
      ${events.map(ev => {
        if (ev.tipo === "exam") {
          const e = ev.rec;
          const folMax = Math.max(e.foliculo_mm || 0, e.foliculo2_mm || 0);
          const badge = e.tipo === "usg" ? "🔊" : e.tipo === "palpacao" ? "🖐" : e.tipo === "citologia" ? "🧫" : "🔬";
          return `<div style="display:flex;gap:14px;margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--border);">
            <div style="width:36px;height:36px;border-radius:50%;background:#6366f120;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">${badge}</div>
            <div style="flex:1;">
              <div style="font-weight:700;font-size:14px;">${{ usg:"USG Transretal", palpacao:"Palpação Retal", citologia:"Citologia", cultura:"Cultura", coleta_ovocito:"OPU", outro:"Exame" }[e.tipo]||e.tipo}
                <span style="font-size:12px;color:var(--muted);font-weight:400;margin-left:8px;">${fmtDatetime(e.data_hora)}</span>
              </div>
              ${folMax > 0 ? `<div style="font-size:13px;margin-top:4px;">
                <span style="background:${folMax>=35?"#f59e0b":"#6366f1"}20;color:${folMax>=35?"#f59e0b":"#6366f1"};padding:2px 8px;border-radius:12px;font-weight:700;">
                  Folículo: ${folMax} mm ${folMax>=35?"⚡ Pré-ovulatório":""}
                </span>
                ${e.edema_uterino_score >= 2 ? `<span style="background:#3b82f620;color:#3b82f6;padding:2px 8px;border-radius:12px;font-weight:600;margin-left:6px;">Edema ${e.edema_uterino_score}</span>` : ""}
              </div>` : ""}
              ${e.diagnostico_resumo ? `<div style="font-size:13px;color:var(--muted);margin-top:4px;">${e.diagnostico_resumo}</div>` : ""}
              ${e.responsavel ? `<div style="font-size:12px;color:var(--muted);margin-top:2px;">👨‍⚕️ ${e.responsavel}</div>` : ""}
            </div>
            <div>
              <button onclick="window.REPRO.editExam('${e.id}')" style="border:none;background:none;cursor:pointer;color:var(--muted);padding:4px;" title="Editar">✏️</button>
              <button onclick="window.REPRO.delExam('${e.id}')" style="border:none;background:none;cursor:pointer;color:#dc2626;padding:4px;" title="Excluir">🗑</button>
            </div>
          </div>`;
        }
        if (ev.tipo === "event") {
          const e = ev.rec;
          const metodoLabels = { ia_refrigerado:"IA Sêmen Refrigerado", ia_congelado:"IA Sêmen Congelado", ia_fresco:"IA Sêmen Fresco", monta_natural:"Monta Natural", te_lavado:"TE Lavado", icsi:"ICSI", opu_te:"OPU+TE" };
          return `<div style="display:flex;gap:14px;margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--border);">
            <div style="width:36px;height:36px;border-radius:50%;background:#3b82f620;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">💉</div>
            <div style="flex:1;">
              <div style="font-weight:700;font-size:14px;">${metodoLabels[e.metodo]||e.metodo}
                <span style="font-size:12px;color:var(--muted);font-weight:400;margin-left:8px;">${fmtDatetime(e.data_hora)}</span>
              </div>
              ${e.garanhao_nome ? `<div style="font-size:13px;margin-top:4px;">🐴 Garanhão: <strong>${e.garanhao_nome}</strong></div>` : ""}
              ${e.motilidade_perc ? `<div style="font-size:13px;color:var(--muted);">Motilidade: ${e.motilidade_perc}% | Dose: ${e.dose_ml||"—"} ml</div>` : ""}
              ${e.observacoes ? `<div style="font-size:13px;color:var(--muted);margin-top:2px;">${e.observacoes}</div>` : ""}
            </div>
            <div>
              <button onclick="window.REPRO.editEvent('${e.id}')" style="border:none;background:none;cursor:pointer;color:var(--muted);padding:4px;">✏️</button>
              <button onclick="window.REPRO.delEvent('${e.id}')" style="border:none;background:none;cursor:pointer;color:#dc2626;padding:4px;">🗑</button>
            </div>
          </div>`;
        }
        if (ev.tipo === "protocol") {
          const p = ev.rec;
          const statusColor = { ativo:"#10b981", concluido:"#6b7280", suspenso:"#f59e0b" }[p.status] || "#6b7280";
          return `<div style="display:flex;gap:14px;margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--border);">
            <div style="width:36px;height:36px;border-radius:50%;background:#10b98120;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">💊</div>
            <div style="flex:1;">
              <div style="font-weight:700;font-size:14px;">${p.nome_protocolo}
                <span style="background:${statusColor}20;color:${statusColor};padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;margin-left:8px;">${p.status||"ativo"}</span>
              </div>
              ${p.droga ? `<div style="font-size:13px;margin-top:4px;">💉 ${p.droga} ${p.dose||""} ${p.via||""} ${p.frequencia||""}</div>` : ""}
              ${p.gatilho ? `<div style="font-size:12px;color:#f59e0b;margin-top:2px;">⚡ ${p.gatilho}</div>` : ""}
              <div style="font-size:12px;color:var(--muted);margin-top:2px;">${fmtDate(p.data_inicio)}${p.data_fim?" → "+fmtDate(p.data_fim):""}</div>
            </div>
            <div>
              <button onclick="window.REPRO.editProtocol('${p.id}')" style="border:none;background:none;cursor:pointer;color:var(--muted);padding:4px;">✏️</button>
              <button onclick="window.REPRO.delProtocol('${p.id}')" style="border:none;background:none;cursor:pointer;color:#dc2626;padding:4px;">🗑</button>
            </div>
          </div>`;
        }
        if (ev.tipo === "pregnancy") {
          const p = ev.rec;
          const diasGest = diffDias(p.data_confirmacao);
          return `<div style="display:flex;gap:14px;margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--border);">
            <div style="width:36px;height:36px;border-radius:50%;background:#10b98120;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">🤰</div>
            <div style="flex:1;">
              <div style="font-weight:700;font-size:14px;">Gestação Confirmada
                <span style="font-size:12px;color:var(--muted);font-weight:400;margin-left:8px;">${fmtDate(p.data_confirmacao)}</span>
              </div>
              <div style="font-size:13px;margin-top:4px;">
                Dias de gestação: <strong>${diasGest}</strong>/${GESTACAO_DIAS} |
                Parto previsto: <strong style="color:#10b981;">${fmtDate(p.data_prevista_parto)}</strong>
              </div>
              <div style="margin-top:6px;background:var(--surface);border-radius:6px;height:6px;overflow:hidden;">
                <div style="height:100%;background:#10b981;width:${Math.min(100,Math.round(diasGest/GESTACAO_DIAS*100))}%;transition:width 0.4s;"></div>
              </div>
            </div>
            <div>
              <button onclick="window.REPRO.editPregnancy('${p.id}')" style="border:none;background:none;cursor:pointer;color:var(--muted);padding:4px;">✏️</button>
            </div>
          </div>`;
        }
        if (ev.tipo === "foaling") {
          const f = ev.rec;
          return `<div style="display:flex;gap:14px;margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--border);">
            <div style="width:36px;height:36px;border-radius:50%;background:#8b5cf620;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">🐣</div>
            <div style="flex:1;">
              <div style="font-weight:700;font-size:14px;">Parto Registrado
                <span style="font-size:12px;color:var(--muted);font-weight:400;margin-left:8px;">${fmtDatetime(f.data_hora_parto)}</span>
              </div>
              <div style="font-size:13px;margin-top:4px;">
                Tipo: ${f.tipo_parto||"—"} | Potro: ${f.potro_sexo==="M"?"♂ Macho":f.potro_sexo==="F"?"♀ Fêmea":"—"}
                ${f.potro_pelagem?` (${f.potro_pelagem})`:""}
                ${f.potro_peso_kg?` | ${f.potro_peso_kg} kg`:""}
              </div>
              ${f.placenta_ok==="ok"?`<div style="font-size:12px;color:#10b981;margin-top:2px;">✅ Placenta expulsa completa</div>`:`<div style="font-size:12px;color:#f59e0b;margin-top:2px;">⚠️ Placenta: ${f.placenta_ok||"verificar"}</div>`}
              ${f.observacoes?`<div style="font-size:13px;color:var(--muted);margin-top:2px;">${f.observacoes}</div>`:""}
            </div>
            <div>
              <button onclick="window.REPRO.editFoaling('${f.id}')" style="border:none;background:none;cursor:pointer;color:var(--muted);padding:4px;">✏️</button>
            </div>
          </div>`;
        }
        return "";
      }).join("")}
    </div>`;
  }

  function renderTasksPanel() {
    const tasks = _state.caseTasks;
    const pendentes = tasks.filter(t => t.status === "pendente");
    const feitas = tasks.filter(t => t.status === "feito");
    const today = new Date().toISOString().split("T")[0];

    return `
    <div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <div style="font-weight:700;">Agenda / Tarefas (${pendentes.length} pendentes)</div>
        <button class="btn btn-primary" onclick="window.REPRO.openTaskForm()" style="padding:6px 14px;font-size:12px;">+ Tarefa</button>
      </div>
      ${pendentes.length === 0 && feitas.length === 0 ? `
        <div style="padding:24px;text-align:center;color:var(--muted);">Nenhuma tarefa cadastrada.</div>
      ` : ""}
      ${pendentes.map(t => {
        const isVencida = t.data_hora && t.data_hora.split("T")[0] < today;
        const isHoje = t.data_hora && t.data_hora.split("T")[0] === today;
        return `<div style="display:flex;gap:10px;align-items:flex-start;padding:10px;border-radius:8px;margin-bottom:6px;background:${isVencida?"#fee2e2":isHoje?"#fef3c7":"var(--surface)"};">
          <input type="checkbox" onchange="window.REPRO.toggleTask('${t.id}')" style="margin-top:2px;cursor:pointer;">
          <div style="flex:1;">
            <div style="font-weight:700;font-size:13px;">${t.tipo} ${t.gerado_automatico?"<span style='font-size:10px;color:var(--muted);font-weight:400;'>(auto)</span>":""}</div>
            <div style="font-size:12px;color:var(--muted);">${t.descricao}</div>
            <div style="font-size:11px;margin-top:2px;color:${isVencida?"#ef4444":isHoje?"#f59e0b":"var(--muted)"};">
              ${isVencida?"⚠️ Vencida — ":""}${isHoje?"📌 Hoje — ":""}${fmtDatetime(t.data_hora)}
            </div>
          </div>
          <button onclick="window.REPRO.delTask('${t.id}')" style="border:none;background:none;cursor:pointer;color:#dc2626;padding:2px;">🗑</button>
        </div>`;
      }).join("")}
      ${feitas.length > 0 ? `
        <details style="margin-top:12px;">
          <summary style="font-size:12px;color:var(--muted);cursor:pointer;">Feitas (${feitas.length})</summary>
          ${feitas.map(t => `<div style="display:flex;gap:10px;align-items:center;padding:8px;opacity:0.6;text-decoration:line-through;">
            <input type="checkbox" checked onchange="window.REPRO.toggleTask('${t.id}')" style="cursor:pointer;">
            <div style="font-size:13px;">${t.tipo} — ${fmtDate(t.data_hora)}</div>
          </div>`).join("")}
        </details>
      ` : ""}
    </div>`;
  }

  function renderDetail() {
    const S = _state;
    const c = S.currentCase;
    if (!c) return `<div style="padding:40px;text-align:center;">Carregando...</div>`;

    const cor = statusColor(c.status);
    const animalNome = getAnimalLabel(c.animal_id);
    const clienteNome = getClienteLabel(c.cliente_id);
    const tasksPendentes = S.caseTasks.filter(t => t.status === "pendente" && !t.deleted_at).length;
    const today = new Date().toISOString().split("T")[0];
    const tasksHoje = S.caseTasks.filter(t => t.status === "pendente" && t.data_hora && t.data_hora.split("T")[0] === today).length;

    // Mostrar formulário de edição se ativo
    if (S.editingType === "case") return `<div style="padding:4px;">${renderCaseForm(c)}</div>`;
    if (S.editingType === "exam") return `<div style="padding:4px;">${renderExamForm(S.editingId ? S.caseExams.find(x=>x.id===S.editingId) : null)}</div>`;
    if (S.editingType === "exam_new") return `<div style="padding:4px;">${renderExamForm(null)}</div>`;
    if (S.editingType === "protocol") return `<div style="padding:4px;">${renderProtocolForm(S.editingId ? S.caseProtocols.find(x=>x.id===S.editingId) : null)}</div>`;
    if (S.editingType === "protocol_new") return `<div style="padding:4px;">${renderProtocolForm(null)}</div>`;
    if (S.editingType === "event") return `<div style="padding:4px;">${renderEventForm(S.editingId ? S.caseEvents.find(x=>x.id===S.editingId) : null)}</div>`;
    if (S.editingType === "event_new") return `<div style="padding:4px;">${renderEventForm(null)}</div>`;
    if (S.editingType === "pregnancy") return `<div style="padding:4px;">${renderPregnancyForm(S.editingId ? S.casePregnancy : null)}</div>`;
    if (S.editingType === "pregnancy_new") return `<div style="padding:4px;">${renderPregnancyForm(null)}</div>`;
    if (S.editingType === "foaling") return `<div style="padding:4px;">${renderFoalingForm(S.caseFoaling)}</div>`;
    if (S.editingType === "foaling_new") return `<div style="padding:4px;">${renderFoalingForm(null)}</div>`;
    if (S.editingType === "task_new") return `<div style="padding:4px;">${renderTaskForm()}</div>`;

    return `
    <div>
      <!-- Cabeçalho do Caso -->
      <div class="card" style="padding:18px 20px;margin-bottom:14px;">
        <div style="display:flex;align-items:flex-start;gap:16px;">
          <div style="width:52px;height:52px;border-radius:50%;background:${cor}20;display:flex;align-items:center;justify-content:center;font-size:26px;flex-shrink:0;">🐎</div>
          <div style="flex:1;">
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
              <h2 style="margin:0;font-size:20px;font-weight:900;">${animalNome}</h2>
              <span style="background:${cor}20;color:${cor};border:1px solid ${cor}55;padding:3px 12px;border-radius:20px;font-size:13px;font-weight:700;">${statusLabel(c.status)}</span>
            </div>
            <div style="margin-top:4px;font-size:14px;color:var(--muted);">
              ${clienteNome ? `👤 ${clienteNome} &nbsp;|&nbsp;` : ""}
              📅 Temporada ${c.season_year} &nbsp;|&nbsp;
              🎯 ${objetivoLabel(c.objetivo)}
            </div>
            ${c.observacoes ? `<div style="margin-top:8px;font-size:13px;padding:8px 12px;background:var(--surface);border-radius:6px;">${c.observacoes}</div>` : ""}
          </div>
          <div style="display:flex;gap:8px;flex-shrink:0;">
            <button class="btn" onclick="window.REPRO.editCase()" style="padding:7px 14px;font-size:13px;">✏️ Editar</button>
            <button class="btn" onclick="window.REPRO.backToList()" style="padding:7px 14px;font-size:13px;">← Voltar</button>
          </div>
        </div>
        <!-- Mini KPIs do caso -->
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:14px;padding-top:14px;border-top:1px solid var(--border);">
          <div style="text-align:center;">
            <div style="font-size:20px;font-weight:900;color:#6366f1;">${S.caseExams.length}</div>
            <div style="font-size:11px;color:var(--muted);">Exames</div>
          </div>
          <div style="text-align:center;">
            <div style="font-size:20px;font-weight:900;color:#3b82f6;">${S.caseEvents.length}</div>
            <div style="font-size:11px;color:var(--muted);">Cobertura/IA</div>
          </div>
          <div style="text-align:center;">
            <div style="font-size:20px;font-weight:900;color:#10b981;">${S.casePregnancy ? `${diffDias(S.casePregnancy.data_confirmacao)}d` : "—"}</div>
            <div style="font-size:11px;color:var(--muted);">Gestação</div>
          </div>
          <div style="text-align:center;">
            <div style="font-size:20px;font-weight:900;color:${tasksHoje>0?"#f59e0b":"var(--muted)"};">${tasksPendentes}</div>
            <div style="font-size:11px;color:var(--muted);">${tasksHoje>0?`${tasksHoje} hoje`:"Tarefas"}</div>
          </div>
        </div>
      </div>

      <!-- Ações Rápidas -->
      <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;">
        <button class="btn btn-primary" onclick="window.REPRO.openExamForm()" style="padding:8px 14px;font-size:13px;">🔊 + Exame/USG</button>
        <button class="btn" onclick="window.REPRO.openEventForm()" style="padding:8px 14px;font-size:13px;background:#3b82f6;color:#fff;">💉 + Cobertura/IA</button>
        <button class="btn" onclick="window.REPRO.openProtocolForm()" style="padding:8px 14px;font-size:13px;background:#10b981;color:#fff;">💊 + Protocolo</button>
        ${!S.casePregnancy ? `<button class="btn" onclick="window.REPRO.openPregnancyForm()" style="padding:8px 14px;font-size:13px;background:#8b5cf6;color:#fff;">🤰 Confirmar Gestação</button>` : ""}
        ${S.casePregnancy && !S.caseFoaling ? `<button class="btn" onclick="window.REPRO.openFoalingForm()" style="padding:8px 14px;font-size:13px;background:#8b5cf6;color:#fff;">🐣 Registrar Parto</button>` : ""}
      </div>

      <!-- Tabs do Detalhe -->
      <div style="display:flex;gap:0;border-bottom:2px solid var(--border);margin-bottom:14px;overflow-x:auto;">
        ${[
          ["timeline","📋 Linha do Tempo"],
          ["tarefas", `📅 Agenda ${tasksPendentes>0?`<span style='background:#ef4444;color:#fff;border-radius:10px;padding:0 6px;font-size:10px;'>${tasksPendentes}</span>`:"" }`],
          ["exames","🔬 Exames ("+S.caseExams.length+")"],
          ["protocolos","💊 Protocolos ("+S.caseProtocols.length+")"],
          ["eventos","💉 Coberturas ("+S.caseEvents.length+")"],
          ["gestacao","🤰 Gestação/Parto"],
        ].map(([tab, label]) => `
          <div onclick="window.REPRO.setTab('${tab}')" style="padding:10px 18px;cursor:pointer;white-space:nowrap;font-size:13px;font-weight:${S.detailTab===tab?"800":"500"};color:${S.detailTab===tab?"var(--primary)":"var(--muted)"};border-bottom:${S.detailTab===tab?"2px solid var(--primary)":"2px solid transparent"};margin-bottom:-2px;transition:all 0.15s;">
            ${label}
          </div>`).join("")}
      </div>

      <!-- Conteúdo das Tabs -->
      <div class="card" style="padding:16px 18px;">
        ${S.detailTab === "timeline" ? renderTimeline() : ""}
        ${S.detailTab === "tarefas" ? renderTasksPanel() : ""}
        ${S.detailTab === "exames" ? renderExamsTab() : ""}
        ${S.detailTab === "protocolos" ? renderProtocolsTab() : ""}
        ${S.detailTab === "eventos" ? renderEventsTab() : ""}
        ${S.detailTab === "gestacao" ? renderGestacaoTab() : ""}
      </div>
    </div>`;
  }

  function renderExamsTab() {
    const exams = _state.caseExams;
    return `
    <div>
      <div style="display:flex;justify-content:space-between;margin-bottom:12px;">
        <div style="font-weight:700;">Exames / Controle Folicular (${exams.length})</div>
        <button class="btn btn-primary" onclick="window.REPRO.openExamForm()" style="padding:6px 14px;font-size:12px;">+ Exame</button>
      </div>
      ${exams.length === 0 ? `<div style="padding:24px;text-align:center;color:var(--muted);">Nenhum exame registrado.</div>` : `
        <table style="width:100%;border-collapse:collapse;">
          <thead><tr style="background:var(--surface);">
            <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:var(--muted);">Data/Hora</th>
            <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:var(--muted);">Tipo</th>
            <th style="padding:8px 12px;text-align:center;font-size:11px;text-transform:uppercase;color:var(--muted);">Fol. OE</th>
            <th style="padding:8px 12px;text-align:center;font-size:11px;text-transform:uppercase;color:var(--muted);">Fol. OD</th>
            <th style="padding:8px 12px;text-align:center;font-size:11px;text-transform:uppercase;color:var(--muted);">Edema</th>
            <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:var(--muted);">Resumo</th>
            <th style="padding:8px 12px;"></th>
          </tr></thead>
          <tbody>
            ${exams.map(e => `<tr style="border-top:1px solid var(--border);">
              <td style="padding:8px 12px;font-size:13px;">${fmtDatetime(e.data_hora)}</td>
              <td style="padding:8px 12px;font-size:13px;">${{usg:"USG",palpacao:"Palpação",citologia:"Citologia",cultura:"Cultura",coleta_ovocito:"OPU",outro:"Outro"}[e.tipo]||e.tipo}</td>
              <td style="padding:8px 12px;text-align:center;font-size:13px;">
                ${e.foliculo_mm ? `<span style="background:${e.foliculo_mm>=35?"#f59e0b20":"#6366f120"};color:${e.foliculo_mm>=35?"#f59e0b":"#6366f1"};padding:2px 8px;border-radius:12px;font-weight:700;">${e.foliculo_mm}mm</span>` : "—"}
              </td>
              <td style="padding:8px 12px;text-align:center;font-size:13px;">
                ${e.foliculo2_mm ? `<span style="background:#6366f120;color:#6366f1;padding:2px 8px;border-radius:12px;font-weight:700;">${e.foliculo2_mm}mm</span>` : "—"}
              </td>
              <td style="padding:8px 12px;text-align:center;font-size:13px;">${e.edema_uterino_score ?? "—"}</td>
              <td style="padding:8px 12px;font-size:12px;color:var(--muted);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${e.diagnostico_resumo || "—"}</td>
              <td style="padding:8px 12px;text-align:right;">
                <button onclick="window.REPRO.editExam('${e.id}')" style="border:none;background:none;cursor:pointer;color:var(--muted);">✏️</button>
                <button onclick="window.REPRO.delExam('${e.id}')" style="border:none;background:none;cursor:pointer;color:#dc2626;">🗑</button>
              </td>
            </tr>`).join("")}
          </tbody>
        </table>
      `}
    </div>`;
  }

  function renderProtocolsTab() {
    const protocols = _state.caseProtocols;
    return `
    <div>
      <div style="display:flex;justify-content:space-between;margin-bottom:12px;">
        <div style="font-weight:700;">Protocolos Hormonais (${protocols.length})</div>
        <button class="btn btn-primary" onclick="window.REPRO.openProtocolForm()" style="padding:6px 14px;font-size:12px;">+ Protocolo</button>
      </div>
      ${protocols.length === 0 ? `<div style="padding:24px;text-align:center;color:var(--muted);">Nenhum protocolo registrado.</div>` : `
        ${protocols.map(p => {
          const cor = {ativo:"#10b981",concluido:"#6b7280",suspenso:"#f59e0b"}[p.status]||"#6b7280";
          return `<div style="padding:12px 14px;background:var(--surface);border-radius:8px;margin-bottom:8px;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;">
              <div>
                <div style="font-weight:700;">${p.nome_protocolo}
                  <span style="background:${cor}20;color:${cor};padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;margin-left:6px;">${p.status||"ativo"}</span>
                </div>
                <div style="font-size:13px;color:var(--muted);margin-top:4px;">💉 ${p.droga||"—"} ${p.dose||""} ${p.via||""} ${p.frequencia||""}</div>
                ${p.gatilho?`<div style="font-size:12px;color:#f59e0b;margin-top:2px;">⚡ ${p.gatilho}</div>`:""}
                <div style="font-size:12px;color:var(--muted);margin-top:2px;">${fmtDate(p.data_inicio)} → ${fmtDate(p.data_fim)||"Em andamento"}</div>
              </div>
              <div>
                <button onclick="window.REPRO.editProtocol('${p.id}')" style="border:none;background:none;cursor:pointer;color:var(--muted);">✏️</button>
                <button onclick="window.REPRO.delProtocol('${p.id}')" style="border:none;background:none;cursor:pointer;color:#dc2626;">🗑</button>
              </div>
            </div>
          </div>`;
        }).join("")}
      `}
    </div>`;
  }

  function renderEventsTab() {
    const events = _state.caseEvents;
    return `
    <div>
      <div style="display:flex;justify-content:space-between;margin-bottom:12px;">
        <div style="font-weight:700;">Coberturas / IA (${events.length})</div>
        <button class="btn btn-primary" onclick="window.REPRO.openEventForm()" style="padding:6px 14px;font-size:12px;">+ Cobertura/IA</button>
      </div>
      ${events.length === 0 ? `<div style="padding:24px;text-align:center;color:var(--muted);">Nenhum evento de cobertura/IA registrado.</div>` : `
        ${events.map(e => {
          const mlabels = {ia_refrigerado:"IA — Refrigerado",ia_congelado:"IA — Congelado",ia_fresco:"IA — Fresco",monta_natural:"Monta Natural",te_lavado:"TE Lavado",icsi:"ICSI",opu_te:"OPU+TE"};
          return `<div style="padding:12px 14px;background:var(--surface);border-radius:8px;margin-bottom:8px;">
            <div style="display:flex;justify-content:space-between;">
              <div>
                <div style="font-weight:700;">${mlabels[e.metodo]||e.metodo} <span style="font-size:12px;color:var(--muted);font-weight:400;">${fmtDatetime(e.data_hora)}</span></div>
                ${e.garanhao_nome?`<div style="font-size:13px;margin-top:3px;">🐴 ${e.garanhao_nome} ${e.semen_procedencia?"— "+e.semen_procedencia:""}</div>`:""}
                <div style="font-size:12px;color:var(--muted);margin-top:2px;">
                  ${e.dose_ml?"Dose: "+e.dose_ml+"ml | ":""}${e.motilidade_perc?"Mot.: "+e.motilidade_perc+"% | ":""}${e.local?e.local:""}
                </div>
              </div>
              <div>
                <button onclick="window.REPRO.editEvent('${e.id}')" style="border:none;background:none;cursor:pointer;color:var(--muted);">✏️</button>
                <button onclick="window.REPRO.delEvent('${e.id}')" style="border:none;background:none;cursor:pointer;color:#dc2626;">🗑</button>
              </div>
            </div>
          </div>`;
        }).join("")}
      `}
    </div>`;
  }

  function renderGestacaoTab() {
    const S = _state;
    const pg = S.casePregnancy;
    const pf = S.caseFoaling;

    return `
    <div>
      <!-- Gestação -->
      <div style="margin-bottom:20px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <div style="font-weight:800;font-size:14px;">🤰 Gestação</div>
          ${!pg ? `<button class="btn btn-primary" onclick="window.REPRO.openPregnancyForm()" style="padding:6px 14px;font-size:12px;">+ Confirmar Gestação</button>` : ""}
        </div>
        ${!pg ? `<div style="padding:24px;text-align:center;color:var(--muted);">Gestação ainda não confirmada.</div>` : `
          <div style="padding:16px;background:var(--surface);border-radius:10px;border-left:3px solid #10b981;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;">
              <div>
                <div style="font-size:18px;font-weight:900;color:#10b981;">✅ Gestação Ativa</div>
                <div style="font-size:14px;margin-top:6px;">Confirmada em: <strong>${fmtDate(pg.data_confirmacao)}</strong> via ${pg.metodo_confirmacao?.toUpperCase()||"—"}</div>
                <div style="font-size:15px;margin-top:8px;font-weight:700;">📅 Parto previsto: <span style="color:#8b5cf6;">${fmtDate(pg.data_prevista_parto)}</span></div>
                <div style="font-size:13px;color:var(--muted);margin-top:4px;">Dias de gestação: <strong>${diffDias(pg.data_confirmacao)}</strong> / ${GESTACAO_DIAS} dias (${Math.round(diffDias(pg.data_confirmacao)/GESTACAO_DIAS*100)}%)</div>
                <div style="margin-top:8px;background:#e5e7eb;border-radius:6px;height:8px;overflow:hidden;">
                  <div style="height:100%;background:#10b981;width:${Math.min(100,Math.round(diffDias(pg.data_confirmacao)/GESTACAO_DIAS*100))}%;"></div>
                </div>
              </div>
              <button onclick="window.REPRO.editPregnancy('${pg.id}')" style="border:none;background:none;cursor:pointer;color:var(--muted);">✏️</button>
            </div>
          </div>
        `}
      </div>

      <!-- Parto -->
      <div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <div style="font-weight:800;font-size:14px;">🐣 Parto (Foaling Record)</div>
          ${!pf && pg ? `<button class="btn" onclick="window.REPRO.openFoalingForm()" style="padding:6px 14px;font-size:12px;background:#8b5cf6;color:#fff;">+ Registrar Parto</button>` : ""}
        </div>
        ${!pf ? `<div style="padding:24px;text-align:center;color:var(--muted);">Parto ainda não registrado.</div>` : `
          <div style="padding:16px;background:var(--surface);border-radius:10px;border-left:3px solid #8b5cf6;">
            <div style="display:flex;justify-content:space-between;">
              <div>
                <div style="font-size:16px;font-weight:900;color:#8b5cf6;">🐣 Parto Registrado</div>
                <div style="margin-top:8px;display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                  <div><span style="font-size:11px;color:var(--muted);">DATA/HORA</span><br><strong>${fmtDatetime(pf.data_hora_parto)}</strong></div>
                  <div><span style="font-size:11px;color:var(--muted);">TIPO</span><br><strong>${{eutocico:"Eutócico",distocico:"Distócico",cesarea:"Cesárea"}[pf.tipo_parto]||pf.tipo_parto}</strong></div>
                  <div><span style="font-size:11px;color:var(--muted);">POTRO</span><br><strong>${pf.potro_sexo==="M"?"♂ Macho":pf.potro_sexo==="F"?"♀ Fêmea":"—"} ${pf.potro_pelagem?"("+pf.potro_pelagem+")":""}</strong></div>
                  <div><span style="font-size:11px;color:var(--muted);">PESO</span><br><strong>${pf.potro_peso_kg?pf.potro_peso_kg+" kg":"—"}</strong></div>
                  <div><span style="font-size:11px;color:var(--muted);">APGAR</span><br><strong>${pf.apgar||"—"}</strong></div>
                  <div><span style="font-size:11px;color:var(--muted);">PLACENTA</span><br><strong style="color:${pf.placenta_ok==="ok"?"#10b981":"#f59e0b"}">${pf.placenta_ok==="ok"?"✅ Ok":pf.placenta_ok||"Não registrado"}</strong></div>
                </div>
                ${pf.observacoes?`<div style="font-size:13px;color:var(--muted);margin-top:8px;">${pf.observacoes}</div>`:""}
              </div>
              <button onclick="window.REPRO.editFoaling('${pf.id}')" style="border:none;background:none;cursor:pointer;color:var(--muted);">✏️</button>
            </div>
          </div>
        `}
      </div>
    </div>`;
  }

  function renderTaskForm() {
    return `
    <div class="card" style="padding:24px;max-width:500px;">
      <h3 style="margin:0 0 16px;font-size:16px;font-weight:800;">📅 Nova Tarefa</h3>
      <div style="display:grid;gap:12px;">
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Tipo / Título *</label>
          <input type="text" id="tf_tipo" placeholder="ex: USG de controle, Aplicar hCG..."
            style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Data / Hora *</label>
          <input type="datetime-local" id="tf_data" value="${new Date().toISOString().substring(0,16)}"
            style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Descrição</label>
          <textarea id="tf_desc" rows="2" style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;resize:vertical;box-sizing:border-box;"></textarea>
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">Prioridade</label>
          <select id="tf_prio" style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-top:4px;font-size:14px;">
            <option value="normal">Normal</option>
            <option value="alta">Alta</option>
            <option value="urgente">Urgente</option>
          </select>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-top:14px;">
        <button class="btn btn-primary" onclick="window.REPRO.submitTask()" style="padding:9px 20px;font-weight:700;">✅ Adicionar</button>
        <button class="btn" onclick="window.REPRO.cancelEdit()" style="padding:9px 16px;">Cancelar</button>
      </div>
    </div>`;
  }

  // ────── RENDER PRINCIPAL ──────

  function render() {
    const root = document.getElementById("reproRoot");
    if (!root) return;

    const S = _state;
    const isNewCase = S.view === "list" && S.editingType === "new_case";

    let html = "";

    // Toast
    if (S.toast) {
      const bg = S.toast.type === "success" ? "#10b981" : S.toast.type === "info" ? "#6366f1" : "#ef4444";
      html += `<div id="reproToast" style="position:fixed;top:20px;right:20px;background:${bg};color:#fff;padding:12px 20px;border-radius:10px;font-weight:700;z-index:9999;box-shadow:0 4px 20px ${bg}55;font-size:14px;max-width:380px;">
        ${S.toast.msg}
      </div>`;
    }

    if (isNewCase) {
      html += renderCaseForm(null);
    } else if (S.view === "list") {
      html += renderList();
    } else if (S.view === "detail") {
      html += renderDetail();
    }

    root.innerHTML = html;
  }

  // ────── API PÚBLICA ──────
  window.REPRO = {
    // Navegação
    async init() {
      // Pré-carregar todos os animais (não só fêmeas) para o form
      try {
        window._REPRO_ALL_ANIMAIS = await dbGetAll(STORE_ANIMAIS).catch(() => []);
      } catch(_) {}
      await loadList();
      render();
    },
    async backToList() {
      _state.view = "list";
      _state.editingType = null;
      _state.editingId = null;
      _state.caseId = null;
      await loadList();
      render();
    },
    async openDetail(caseId) {
      _state.caseId = caseId;
      _state.view = "detail";
      _state.detailTab = "timeline";
      _state.editingType = null;
      await loadDetail(caseId);
      render();
    },
    openNew() {
      _state.editingType = "new_case";
      render();
    },
    setTab(tab) {
      _state.detailTab = tab;
      _state.editingType = null;
      render();
    },
    // Filtros
    onSearch(v) { _state.searchTerm = v; render(); },
    onFilterStatus(v) { _state.filterStatus = v; render(); },
    onFilterSeason(v) { _state.filterSeason = v; render(); },
    // Cancelar
    cancelEdit() {
      _state.editingType = null;
      _state.editingId = null;
      render();
    },
    // Forms de edição
    editCase() { _state.editingType = "case"; render(); },
    openExamForm() { _state.editingType = "exam_new"; _state.editingId = null; render(); },
    editExam(id) { _state.editingType = "exam"; _state.editingId = id; render(); },
    openEventForm() { _state.editingType = "event_new"; _state.editingId = null; render(); },
    editEvent(id) { _state.editingType = "event"; _state.editingId = id; render(); },
    openProtocolForm() { _state.editingType = "protocol_new"; _state.editingId = null; render(); },
    editProtocol(id) { _state.editingType = "protocol"; _state.editingId = id; render(); },
    openPregnancyForm() { _state.editingType = "pregnancy_new"; render(); },
    editPregnancy(id) { _state.editingType = "pregnancy"; _state.editingId = id; render(); },
    openFoalingForm() { _state.editingType = "foaling_new"; render(); },
    editFoaling(id) { _state.editingType = "foaling"; _state.editingId = id; render(); },
    openTaskForm() { _state.editingType = "task_new"; render(); },
    // Submissões
    async submitCase(existingId) {
      const form = {
        id: existingId || null,
        animal_id: document.getElementById("cf_animal_id")?.value,
        cliente_id: document.getElementById("cf_cliente_id")?.value,
        season_year: parseInt(document.getElementById("cf_season")?.value),
        objetivo: document.getElementById("cf_objetivo")?.value,
        status: document.getElementById("cf_status")?.value,
        observacoes: document.getElementById("cf_obs")?.value,
      };
      if (!form.animal_id) { toast("Selecione a égua!", "error"); return; }
      if (existingId) form.created_at = _state.currentCase?.created_at;
      await saveCase(form);
    },
    async submitExam(existingId) {
      const form = {
        id: existingId || null,
        data_hora: document.getElementById("ef_data")?.value?.replace("T"," ")+":00",
        tipo: document.getElementById("ef_tipo")?.value,
        foliculo_mm: document.getElementById("ef_foliculo_mm")?.value,
        foliculo2_mm: document.getElementById("ef_foliculo2_mm")?.value,
        corpo_luteo: document.getElementById("ef_corpo_luteo")?.value,
        ovario2: document.getElementById("ef_corpo_luteo2")?.value,
        edema_uterino_score: document.getElementById("ef_edema")?.value,
        cervix: document.getElementById("ef_cervix")?.value,
        uterus_fluid: document.getElementById("ef_fluid")?.value,
        diagnostico_resumo: document.getElementById("ef_diag")?.value,
        responsavel: document.getElementById("ef_resp")?.value,
      };
      if (existingId) form.created_at = _state.caseExams.find(x=>x.id===existingId)?.created_at;
      await saveExam(form);
    },
    async submitEvent(existingId) {
      const form = {
        id: existingId || null,
        data_hora: document.getElementById("ev_data")?.value?.replace("T"," ")+":00",
        metodo: document.getElementById("ev_metodo")?.value,
        garanhao_nome: document.getElementById("ev_garanhao")?.value,
        semen_procedencia: document.getElementById("ev_procedencia")?.value,
        dose_ml: document.getElementById("ev_dose")?.value,
        motilidade_perc: document.getElementById("ev_motilidade")?.value,
        concentracao: document.getElementById("ev_concentracao")?.value,
        local: document.getElementById("ev_local")?.value,
        responsavel: document.getElementById("ev_resp")?.value,
        observacoes: document.getElementById("ev_obs")?.value,
      };
      if (existingId) form.created_at = _state.caseEvents.find(x=>x.id===existingId)?.created_at;
      await saveEvent(form);
    },
    async submitProtocol(existingId) {
      const form = {
        id: existingId || null,
        nome_protocolo: document.getElementById("pf_nome")?.value,
        droga: document.getElementById("pf_droga")?.value,
        dose: document.getElementById("pf_dose")?.value,
        via: document.getElementById("pf_via")?.value,
        frequencia: document.getElementById("pf_freq")?.value,
        data_inicio: document.getElementById("pf_inicio")?.value,
        data_fim: document.getElementById("pf_fim")?.value,
        gatilho: document.getElementById("pf_gatilho")?.value,
        responsavel: document.getElementById("pf_resp")?.value,
        status: document.getElementById("pf_status")?.value,
        observacoes: document.getElementById("pf_obs")?.value,
      };
      if (existingId) form.created_at = _state.caseProtocols.find(x=>x.id===existingId)?.created_at;
      await saveProtocol(form);
    },
    async submitPregnancy(existingId) {
      const form = {
        id: existingId || null,
        data_confirmacao: document.getElementById("pg_data")?.value,
        metodo_confirmacao: document.getElementById("pg_metodo")?.value,
        status: document.getElementById("pg_status")?.value,
        observacoes: document.getElementById("pg_obs")?.value,
      };
      if (existingId) form.created_at = _state.casePregnancy?.created_at;
      await savePregnancy(form);
    },
    async submitFoaling(existingId) {
      const form = {
        id: existingId || null,
        data_hora_parto: document.getElementById("ff_data")?.value?.replace("T"," ")+":00",
        tipo_parto: document.getElementById("ff_tipo")?.value,
        potro_sexo: document.getElementById("ff_potro_sexo")?.value,
        potro_pelagem: document.getElementById("ff_pelagem")?.value,
        potro_peso_kg: document.getElementById("ff_peso")?.value,
        apgar: document.getElementById("ff_apgar")?.value,
        placenta_ok: document.getElementById("ff_placenta")?.value,
        tempo_expulsao_placenta_min: document.getElementById("ff_tempo_plac")?.value,
        observacoes: document.getElementById("ff_obs")?.value,
      };
      if (existingId) form.created_at = _state.caseFoaling?.created_at;
      await saveFoaling(form);
    },
    async submitTask() {
      const form = {
        tipo: document.getElementById("tf_tipo")?.value,
        data_hora: document.getElementById("tf_data")?.value?.replace("T"," ")+":00",
        descricao: document.getElementById("tf_desc")?.value,
        prioridade: document.getElementById("tf_prio")?.value,
      };
      if (!form.tipo) { toast("Informe o tipo/título da tarefa.", "error"); return; }
      await saveTask(form);
    },
    // Deletes
    async delExam(id) {
      if (!confirm("Remover este exame?")) return;
      await deleteRec(STORE_EXAMS, id);
    },
    async delEvent(id) {
      if (!confirm("Remover este evento de cobertura/IA?")) return;
      await deleteRec(STORE_EVENTS, id);
    },
    async delProtocol(id) {
      if (!confirm("Remover este protocolo?")) return;
      await deleteRec(STORE_PROTOCOLS, id);
    },
    async delTask(id) {
      await deleteRec(STORE_TASKS, id);
    },
    async toggleTask(id) {
      await toggleTaskStatus(id);
    }
  };

  console.log("[REPRO_EQUINA] módulo carregado");
})();
