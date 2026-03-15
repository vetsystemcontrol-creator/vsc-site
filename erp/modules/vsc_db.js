/* ============================================================
   VSC — DB + OUTBOX CANÔNICA (IDB) — v1
   Literatura (Transactional Outbox): dado + evento na MESMA base e transação.
   - Storage: IndexedDB (vsc_db)
   - Outbox: store "sync_queue"
   - Fail-closed: sem endpoint, sem envio automático
   ============================================================ */
(() => {
  "use strict";

  

// ============================================================
// ESOS 5.2 — DB READY (Promise + evento) — determinístico
// - Consumidores (auth/auth_guard/etc) aguardam window.__VSC_DB_READY
// - Compat: mantém __VSC_DB_READY__ (boolean) e evento "VSC_DB_READY"
// ============================================================
try{
  if(!window.__VSC_DB_READY || typeof window.__VSC_DB_READY.then !== "function"){
    window.__VSC_DB_READY_FIRED = false;
    window.__VSC_DB_READY_RESOLVE = null;
    window.__VSC_DB_READY = new Promise((resolve)=>{
      window.__VSC_DB_READY_RESOLVE = resolve;
    });
  }
}catch(_){}
const DB_NAME = "vsc_db";
  const DB_VERSION = 39;// v39: ux_audit_log + auditoria operacional/erros/usabilidade | v38: retry scheduling / stale sending recovery indexes + SW registration | v37: documents_store + attachments_queue stores canônicos para anexos/documentos offline-first | v36: empresa cadastral/fiscal store (CNPJ, Razão Social, IE, IM, CNAE, endereço) | v35: fornecedores_master schema alignment for cloud snapshot sync | v34: Sync hardening (op_id/device_id/revision metadata) // v32: Fechamentos/Faturamento em lote (STORE_FECHAMENTOS) // v30: Subscription/Billing control (tenant_subscription + billing_events) | v29: Estoque ledger/saldos/import_ledger | v26: Reprodução Equina | v25: Fornecedores | v24: Produtos Lotes | v23: Config + RBAC + Auditoria
  const STORE_OUTBOX = "sync_queue";
  const STORE_ATTACHMENTS_QUEUE = "attachments_queue";
  const STORE_DOCUMENTS = "documents_store";

  // Empresa (cadastro fiscal/legal) — v36
  const STORE_EMPRESA = "empresa";

  const STORE_FECHAMENTOS = "fechamentos";
  const STORE_SYS_META = "sys_meta";
  const STORE_BACKUP_EVENTS = "backup_events";
  const STORE_DB_BACKUPS = "db_backups";

  // Política Fase 1 (proteção imediata)
  const AUTO_BACKUP_EDITS = 20;                      // a cada 20 writes canônicas
  const AUTO_BACKUP_TIME_MS = 24 * 60 * 60 * 1000;   // a cada 24h
  const AUTO_BACKUP_MAX_INTERNAL = 3;                // manter últimos N snapshots internos

  // Stores mestres (compat com atendimentos.js)
  const STORE_EXAMES_MASTER   = "exames_master";
  const STORE_PRODUTOS_MASTER = "produtos_master";
  const STORE_PRODUTOS_LOTES  = "produtos_lotes";

  // Estoque Enterprise (v29): ledger imutável + saldos materializados + idempotência
  const STORE_ESTOQUE_MOVIMENTOS = "estoque_movimentos";
  const STORE_ESTOQUE_SALDOS     = "estoque_saldos";
  const STORE_IMPORT_LEDGER      = "import_ledger";
  // Subscription/Billing (enterprise SaaS)
  const STORE_TENANT_SUBSCRIPTION = "tenant_subscription";
  const STORE_BILLING_EVENTS      = "billing_events";
  const STORE_ESTOQUE_REASONS    = "estoque_reasons";
 // v24: lote/validade/qtd/custo por lote (FEFO)
  const STORE_SERVICOS_MASTER = "servicos_master";
  const STORE_CLIENTES_MASTER = "clientes_master";
  const STORE_FORNECEDORES_MASTER = "fornecedores_master";
  const STORE_ANIMAIS_MASTER  = "animais_master";
  const STORE_CONTAS_PAGAR    = "contas_pagar";
  const STORE_CONTAS_RECEBER  = "contas_receber"; // R-01: IDB canônico para AR

  // Catálogos do módulo Animais (migrando de localStorage → IndexedDB)
  const STORE_ANIMAIS_RACAS    = "animais_racas";
  const STORE_ANIMAIS_PELAGENS = "animais_pelagens";
  const STORE_ANIMAIS_ESPECIES = "animais_especies";

  const STORE_ATENDIMENTOS_MASTER = "atendimentos_master";
  const STORE_ANIMAL_VITALS_HISTORY = "animal_vitals_history";
  const STORE_ANIMAL_VACCINES = "animal_vaccines";

  // ==============================
  // CONFIG (date-effective) + RBAC
  // ==============================
  const STORE_CONFIG_PARAMS = "config_params";
  const STORE_CONFIG_AUDIT  = "config_audit_log";

  // RBAC Enterprise (offline-first)
  const STORE_AUTH_USERS      = "auth_users";
  const STORE_AUTH_ROLES      = "auth_roles";
  const STORE_AUTH_ROLE_PERMS = "auth_role_permissions";
  const STORE_AUTH_SESSIONS   = "auth_sessions";
  const STORE_AUTH_AUDIT      = "auth_audit_log";

  // Perfil Profissional (CRMV) — v28
  const STORE_USER_PROFILES = "user_profiles";

  // Auditoria Business (SAP-like Change Documents)
  const STORE_BUSINESS_AUDIT = "business_audit_log";
  const STORE_UX_AUDIT = "ux_audit_log";

  // ========================
  // REPRODUÇÃO EQUINA (v26)
  // ========================
  const STORE_REPRO_CASES    = "repro_cases";      // Caso reprodutivo (capa/temporada)
  const STORE_REPRO_EXAMS    = "repro_exams";      // Exames/controle folicular/USG
  const STORE_REPRO_PROTOCOLS = "repro_protocols"; // Protocolos hormonais
  const STORE_REPRO_EVENTS   = "repro_events";     // Cobertura/IA/Monta/TE
  const STORE_REPRO_PREGNANCY = "repro_pregnancy"; // Gestação (diagnóstico → parto)
  const STORE_REPRO_FOALING  = "repro_foaling";    // Registro de parto
  const STORE_REPRO_TASKS    = "repro_tasks";      // Agenda/Tarefas do dia (geradas ou manuais)

  // Whitelist de campos relevantes por store (padrão-ouro enterprise)
  // Ajuste/expanda conforme módulos evoluírem.
  const BUSINESS_AUDIT_WHITELIST = Object.freeze({
    // Produtos (UoM, EAN, custo)
    produtos_master: [
      "nome", "ean", "ean_list",
      "un_estoque", "un_compra_padrao", "conv_fator_compra_para_estoque",
      "custo", "custo_medio", "preco", "preco_venda",
      "status", "deleted_at"
    ],
    // Fornecedores
    fornecedores_master: [
      "nome", "cnpj", "ie", "telefone", "email", "endereco", "cidade", "uf",
      "status", "deleted_at"
    ],
    // Clientes
    clientes_master: [
      "nome", "doc", "telefone", "email", "endereco", "cidade", "uf",
      "status", "deleted_at"
    ],
    // Animais (dados críticos mínimos)
    animais_master: [
      "nome", "especie", "raca", "pelagem", "sexo", "nascimento", "cliente_id",
      "status", "deleted_at"
    ],
  // Serviços
servicos_master: [
  "nome", "codigo", "desc",
  "categoria", "tipo",
  "preco_base_cents",
  "ativo", "deleted_at"
],
// Exames
exames_master: [
  "nome", "codigo", "desc",
  "tipo",
  "custo_base_cents", "preco_venda_cents",
  "ativo", "deleted_at"
],
// Empresa (cadastro fiscal/legal)
empresa: [
  "cnpj", "razao_social", "nome_fantasia",
  "ie", "im", "cnae_principal",
  "cep", "logradouro", "numero", "complemento", "bairro", "cidade", "uf",
  "telefone", "email", "site",
  "regime_tributario", "updated_at"
],
});

  function vscCurrentUserId(){
    try{ return (window.VSC_AUTH && window.VSC_AUTH.currentUser && window.VSC_AUTH.currentUser.id) ? String(window.VSC_AUTH.currentUser.id) : ""; }catch(_){ return ""; }
  }

  function vscNormAuditVal(v){
    if(v === undefined) return null;
    if(v === null) return null;
    // arrays: ordenar representação para comparação determinística
    if(Array.isArray(v)){
      try{
        return v.map(x=> (x===undefined||x===null)?null:String(x)).sort();
      }catch(_){
        return v;
      }
    }
    // objects: stringify estável por chaves ordenadas (somente raso, suficiente p/ ean_pack_map se usado)
    if(typeof v === "object"){
      try{
        const keys = Object.keys(v).sort();
        const o = {};
        for(let i=0;i<keys.length;i++) o[keys[i]] = v[keys[i]];
        return o;
      }catch(_){
        return v;
      }
    }
    return v;
  }

  function vscAuditDiffs(storeName, entity, entity_id, beforeObj, afterObj){
    const fields = BUSINESS_AUDIT_WHITELIST[storeName];
    if(!fields || !fields.length) return [];
    const diffs = [];
    for(let i=0;i<fields.length;i++){
      const f = fields[i];
      const b = vscNormAuditVal(beforeObj ? beforeObj[f] : undefined);
      const a = vscNormAuditVal(afterObj ? afterObj[f] : undefined);
      let same = false;
      try{ same = JSON.stringify(b) === JSON.stringify(a); }catch(_){ same = (b === a); }
      if(!same){
        diffs.push({ field:f, before:b, after:a });
      }
    }
    if(!diffs.length) return [];
    const when = nowISO();
    const user_id = vscCurrentUserId();
    // 1 registro por campo (CDPOS-like)
    return diffs.map(d => ({
      id: uuidv4(),
      when,
      entity: String(entity||""),
      entity_id: String(entity_id||""),
      store: String(storeName||""),
      action: "UPSERT",
      field: d.field,
      before: d.before,
      after: d.after,
      user_id,
    }));
  }

  function nowISO(){ return new Date().toISOString(); }

  function uuidv4(){
    // UUID v4 — CSPRNG only (Contrato 4.6 / OWASP ASVS 2.9.1 / RFC 4122 §4.4)
    // Prioridade: VSC_UTILS.uuidv4() → crypto.randomUUID() → crypto.getRandomValues()
    try{
      if(window.VSC_UTILS && typeof window.VSC_UTILS.uuidv4 === "function"){
        return window.VSC_UTILS.uuidv4();
      }
    }catch(_){}

    try{
      if(typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"){
        return crypto.randomUUID();
      }
    }catch(_){}

    try{
      if(typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function"){
        const buf = new Uint8Array(16);
        crypto.getRandomValues(buf);
        buf[6] = (buf[6] & 0x0f) | 0x40; // versão 4
        buf[8] = (buf[8] & 0x3f) | 0x80; // variante RFC 4122
        const hex = Array.from(buf).map(b => b.toString(16).padStart(2,"0")).join("");
        return [
          hex.slice(0,8),
          hex.slice(8,12),
          hex.slice(12,16),
          hex.slice(16,20),
          hex.slice(20)
        ].join("-");
      }
    }catch(_){}

    throw new TypeError("[VSC_DB] uuidv4(): ambiente sem CSPRNG (crypto.randomUUID/getRandomValues). UUID NÃO gerado.");
  }

  // ============================================================
// SYNC HARDENING (v34)
// - device_id estável por instalação
// - dedupe key por entidade/operação
// - base/entity revision para reconciliação futura
// ============================================================
  function getOrCreateSyncDeviceId(){
    const KEY = "vsc_sync_device_id";
    try{
      const ls = window.localStorage;
      if(ls){
        let cur = String(ls.getItem(KEY) || "").trim();
        if(cur) return cur;
        cur = uuidv4();
        ls.setItem(KEY, cur);
        return cur;
      }
    }catch(_){}
    return uuidv4();
  }

  function nextEntityRevision(payload){
    try{
      const p = payload && typeof payload === "object" ? payload : null;
      const cur = Number(p && (p.sync_rev ?? p.entity_revision ?? p.base_revision ?? p.revision)) || 0;
      return cur + 1;
    }catch(_){}
    return 1;
  }

  function buildOutboxMetadata(entity, action, entity_id, payload){
    const body = payload && typeof payload === "object" ? payload : null;
    const deviceId = getOrCreateSyncDeviceId();
    const baseRevision = Number(body && (body.sync_rev ?? body.base_revision ?? body.entity_revision ?? body.revision)) || 0;
    const entityRevision = nextEntityRevision(body);
    const opId = uuidv4();
    const dedupeKey = [String(entity||""), String(entity_id||""), String(action||"upsert").toLowerCase(), String(baseRevision), String(entityRevision)].join(":");
    return {
      op_id: opId,
      device_id: deviceId,
      base_revision: baseRevision,
      entity_revision: entityRevision,
      dedupe_key: dedupeKey
    };
  }

  function attachSyncMetadata(recordLike, meta, action){
    if(!recordLike || typeof recordLike !== "object") return recordLike;
    const normalizedAction = String(action || "upsert").toLowerCase();
    const next = { ...recordLike };
    next.base_revision = Number(meta && meta.base_revision) || 0;
    next.entity_revision = Math.max(1, Number(meta && meta.entity_revision) || 1);
    next.sync_rev = next.entity_revision;
    next.last_synced_op_id = String(meta && meta.op_id || "");
    next.sync_device_id = String(meta && meta.device_id || "");
    next.updated_at = String(next.updated_at || nowISO());
    if(normalizedAction === "delete"){
      next.deleted_at = String(next.deleted_at || next.updated_at || nowISO());
    }
    return next;
  }

  function compareSyncPriority(currentRecord, incomingRecord){
    const curRev = Number(currentRecord && (currentRecord.sync_rev ?? currentRecord.entity_revision ?? currentRecord.base_revision ?? currentRecord.revision)) || 0;
    const incRev = Number(incomingRecord && (incomingRecord.sync_rev ?? incomingRecord.entity_revision ?? incomingRecord.base_revision ?? incomingRecord.revision)) || 0;
    if(incRev !== curRev) return incRev > curRev ? 1 : -1;

    const curAt = Date.parse(_pickUpdatedAt(currentRecord) || '');
    const incAt = Date.parse(_pickUpdatedAt(incomingRecord) || '');
    if(Number.isFinite(incAt) && Number.isFinite(curAt) && incAt !== curAt) return incAt > curAt ? 1 : -1;
    if(Number.isFinite(incAt) && !Number.isFinite(curAt)) return 1;
    if(!Number.isFinite(incAt) && Number.isFinite(curAt)) return -1;
    return 0;
  }

// ============================================================
  // OUTBOX REPAIR (compat/anti-regressão)
  // - Normaliza registros antigos/incompletos em sync_queue.
  // - Rodar UMA vez por schema via SYS_META para não impactar performance.
  // ============================================================
  function _repairOutboxOnce(db){
    return new Promise((resolve)=>{
      try{
        if(!db || !db.objectStoreNames.contains(STORE_OUTBOX) || !db.objectStoreNames.contains(STORE_SYS_META)){
          return resolve({ ok:false, skipped:true, reason:"missing_stores" });
        }

        const tx0 = db.transaction([STORE_SYS_META, STORE_OUTBOX], "readwrite");
        const meta = tx0.objectStore(STORE_SYS_META);
        const outb = tx0.objectStore(STORE_OUTBOX);

        const flagKey = "outbox_repair_v34";
        const rqFlag = meta.get(flagKey);

        const stats = { ok:true, skipped:false, scanned:0, fixed:0 };

        rqFlag.onsuccess = () => {
          const done = rqFlag.result && rqFlag.result.value === true;
          if(done){
            stats.skipped = true;
            return;
          }

          const now = nowISO();
          const cur = outb.openCursor();
          cur.onsuccess = () => {
            const c = cur.result;
            if(!c) return;
            const v = c.value || {};
            stats.scanned++;

            let changed = false;
            // Campos mínimos exigidos pelo contrato ESOS/outbox.
            if(!v.id){ v.id = uuidv4(); changed = true; }
            if(!v.status){ v.status = "PENDING"; changed = true; }
            if(!v.entity){ v.entity = v.entity_type || v.type || "UNKNOWN"; changed = true; }
            if(!v.store){ v.store = v.store_name || v.entity || v.entity_type || "UNKNOWN"; changed = true; }
            if(!v.action){ v.action = v.op || v.kind || "upsert"; changed = true; }
            if(!v.entity_id){ v.entity_id = v.ref_id || v.target_id || v.id; changed = true; }
            if(!v.created_at){ v.created_at = now; changed = true; }
            if(!v.updated_at){ v.updated_at = now; changed = true; }
            if(!v.op_id){ v.op_id = uuidv4(); changed = true; }
            if(!v.device_id){ v.device_id = getOrCreateSyncDeviceId(); changed = true; }
            if(typeof v.base_revision !== "number"){ v.base_revision = Number(v.base_revision) || 0; changed = true; }
            if(typeof v.entity_revision !== "number"){ v.entity_revision = Math.max(1, Number(v.entity_revision) || (Number(v.base_revision) || 0) + 1); changed = true; }
            if(v.next_attempt_at == null){ v.next_attempt_at = 0; changed = true; }
            if(v.retry_after_ms == null){ v.retry_after_ms = 0; changed = true; }
            if(!v.dedupe_key){
              v.dedupe_key = [String(v.entity||""), String(v.entity_id||""), String(v.action||"upsert").toLowerCase(), String(v.base_revision||0), String(v.entity_revision||1)].join(":");
              changed = true;
            }

            if(changed){
              stats.fixed++;
              try{ c.update(v); }catch(_){ try{ outb.put(v); }catch(__){} }
            }
            c.continue();
          };
        };

        tx0.oncomplete = () => {
          try{
            // Marca reparo executado.
            const tx1 = db.transaction([STORE_SYS_META], "readwrite");
            tx1.objectStore(STORE_SYS_META).put({ key:"outbox_repair_v34", value:true, at: nowISO() });
          }catch(_){ }
          resolve(stats);
        };
        tx0.onerror = () => resolve({ ok:false, error: String(tx0.error || "tx error") });
      }catch(e){
        resolve({ ok:false, error: String(e && (e.message||e)) });
      }
    });
  }

  function openDB(){
    return new Promise((resolve, reject) => {
            // Robust open: never fail when local DB is already at a higher version.
      // If DB_VERSION is lower than an existing version, IDB throws VersionError.
      // In that case, reopen WITHOUT specifying a version to attach to the existing schema.
      const req = indexedDB.open(DB_NAME, DB_VERSION);
req.onupgradeneeded = (e) => {
        const db = req.result;

        // Outbox canônica (IDB)
        if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
          const outbox = db.createObjectStore(STORE_OUTBOX, { keyPath: "id" });
          outbox.createIndex("status", "status", { unique: false });
          outbox.createIndex("entity", "entity", { unique: false });
          outbox.createIndex("created_at", "created_at", { unique: false });
          outbox.createIndex("op_id", "op_id", { unique: false });
          outbox.createIndex("dedupe_key", "dedupe_key", { unique: false });
          outbox.createIndex("status_created", ["status", "created_at"], { unique: false });
          outbox.createIndex("next_attempt_at", "next_attempt_at", { unique: false });
          outbox.createIndex("status_next_attempt", ["status", "next_attempt_at"], { unique: false });
        } else {
          const outbox = req.transaction.objectStore(STORE_OUTBOX);
          if (!outbox.indexNames.contains("op_id")) outbox.createIndex("op_id", "op_id", { unique: false });
          if (!outbox.indexNames.contains("dedupe_key")) outbox.createIndex("dedupe_key", "dedupe_key", { unique: false });
          if (!outbox.indexNames.contains("status_created")) outbox.createIndex("status_created", ["status", "created_at"], { unique: false });
          if (!outbox.indexNames.contains("next_attempt_at")) outbox.createIndex("next_attempt_at", "next_attempt_at", { unique: false });
          if (!outbox.indexNames.contains("status_next_attempt")) outbox.createIndex("status_next_attempt", ["status", "next_attempt_at"], { unique: false });
        }

        // SYS_META (governança/contadores/backup policy)
        if (!db.objectStoreNames.contains(STORE_SYS_META)) {
          const st = db.createObjectStore(STORE_SYS_META, { keyPath: "key" });
          st.createIndex("key", "key", { unique: true });
        }

        // BACKUP_EVENTS (fila interna para disparos de backup; evita travar UI)
        if (!db.objectStoreNames.contains(STORE_BACKUP_EVENTS)) {
          const st = db.createObjectStore(STORE_BACKUP_EVENTS, { keyPath: "id" });
          st.createIndex("status", "status", { unique: false });
          st.createIndex("created_at", "created_at", { unique: false });
          st.createIndex("status_created", ["status","created_at"], { unique: false });
        }

        // DB_BACKUPS (snapshots internos limitados — Fase 1)
        if (!db.objectStoreNames.contains(STORE_DB_BACKUPS)) {
          const st = db.createObjectStore(STORE_DB_BACKUPS, { keyPath: "id" });
          st.createIndex("created_at", "created_at", { unique: false });
          st.createIndex("kind", "kind", { unique: false });
        }

        // Masters (compat com atendimentos.js)
        if (!db.objectStoreNames.contains(STORE_EXAMES_MASTER)) {
          db.createObjectStore(STORE_EXAMES_MASTER, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_SERVICOS_MASTER)) {
          db.createObjectStore(STORE_SERVICOS_MASTER, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_PRODUTOS_MASTER)) {
          // atendimentos.js usa "produto_id"; mantemos por compatibilidade
          db.createObjectStore(STORE_PRODUTOS_MASTER, { keyPath: "produto_id" });
        }

        // Produtos Lotes (lote/validade) — FEFO e rastreabilidade
        if (!db.objectStoreNames.contains(STORE_PRODUTOS_LOTES)) {
          const st = db.createObjectStore(STORE_PRODUTOS_LOTES, { keyPath: "id" });
          st.createIndex("produto_id", "produto_id", { unique: false });
          st.createIndex("ean", "ean", { unique: false });
          st.createIndex("lote", "lote", { unique: false });
          st.createIndex("vencimento", "vencimento", { unique: false }); // ISO YYYY-MM-DD
          st.createIndex("produto_venc", ["produto_id","vencimento"], { unique: false });
          st.createIndex("status", "status", { unique: false }); // ATIVO/INATIVO (ou null)
          st.createIndex("updated_at", "updated_at", { unique: false });
        }
        // ============================================================
        // v29 — ESTOQUE ENTERPRISE: ledger + saldos + idempotência
        // Fonte da verdade: estoque_movimentos (imutável) → estoque_saldos (derivado)
        // Migração (Opção B): baseline a partir de produtos_lotes.qtd (v28) em movimentos ENTRADA.
        // ============================================================

        if (!db.objectStoreNames.contains(STORE_ESTOQUE_MOVIMENTOS)) {
          const st = db.createObjectStore(STORE_ESTOQUE_MOVIMENTOS, { keyPath: "id" });
          st.createIndex("produto_id", "produto_id", { unique: false });
          st.createIndex("produto_lote", "produto_lote", { unique: false });
          st.createIndex("created_at", "created_at", { unique: false });
          st.createIndex("source_sig", "source_sig", { unique: true });
        }

        if (!db.objectStoreNames.contains(STORE_ESTOQUE_SALDOS)) {
          const st = db.createObjectStore(STORE_ESTOQUE_SALDOS, { keyPath: "id" });
          st.createIndex("produto_id", "produto_id", { unique: false });
          st.createIndex("produto_lote", "produto_lote", { unique: false });
          st.createIndex("updated_at", "updated_at", { unique: false });
        }

        if (!db.objectStoreNames.contains(STORE_IMPORT_LEDGER)) {
          const st = db.createObjectStore(STORE_IMPORT_LEDGER, { keyPath: "id" });
          st.createIndex("source_system", "source_system", { unique: false });
          st.createIndex("source_record_key", "source_record_key", { unique: false });
          st.createIndex("source_document_hash", "source_document_hash", { unique: false });
          st.createIndex("imported_at", "imported_at", { unique: false });
          st.createIndex("sig", "sig", { unique: true });
        }

        // ============================================================
        // v30 — SUBSCRIPTION/BILLING (enterprise SaaS)
        // Domínio separado de Auth: bloqueio por mensalidade é por TENANT,
        // com máquina de estados e ledger de eventos.
        // ============================================================

        if (!db.objectStoreNames.contains(STORE_TENANT_SUBSCRIPTION)) {
          const st = db.createObjectStore(STORE_TENANT_SUBSCRIPTION, { keyPath: "tenant_id" });
          st.createIndex("status", "status", { unique: false });
          st.createIndex("current_period_end", "current_period_end", { unique: false });
          st.createIndex("next_due_at", "next_due_at", { unique: false });
          st.createIndex("updated_at", "updated_at", { unique: false });
        }

        if (!db.objectStoreNames.contains(STORE_BILLING_EVENTS)) {
          const st = db.createObjectStore(STORE_BILLING_EVENTS, { keyPath: "id" });
          st.createIndex("tenant_id", "tenant_id", { unique: false });
          st.createIndex("type", "type", { unique: false });
          st.createIndex("created_at", "created_at", { unique: false });
          st.createIndex("tenant_created", ["tenant_id","created_at"], { unique: false });
          st.createIndex("sig", "sig", { unique: true });
        }

        if (!db.objectStoreNames.contains(STORE_ESTOQUE_REASONS)) {
          const st = db.createObjectStore(STORE_ESTOQUE_REASONS, { keyPath: "code" });
          st.createIndex("active", "active", { unique: false });

          // seed reasons (enterprise mínimo)
          try{
            st.put({ code:"RECEBIMENTO", label:"Recebimento/Compra", active:true });
            st.put({ code:"VENDA_USO", label:"Venda/Consumo/Aplicação", active:true });
            st.put({ code:"AJUSTE_INVENTARIO", label:"Ajuste de Inventário", active:true });
            st.put({ code:"PERDA_VENCIMENTO", label:"Perda/Vencimento", active:true });
            st.put({ code:"TRANSFERENCIA", label:"Transferência", active:true });
          }catch(_e){}
        }

        // Migração Opção B: apenas quando abrindo DB < 29 e ainda não marcado em sys_meta.
        try{
          const tx = e.target.transaction; // upgrade tx
          if(tx && db.objectStoreNames.contains(STORE_SYS_META) &&
             db.objectStoreNames.contains(STORE_PRODUTOS_LOTES) &&
             db.objectStoreNames.contains(STORE_ESTOQUE_MOVIMENTOS) &&
             db.objectStoreNames.contains(STORE_ESTOQUE_SALDOS)) {

            const sys = tx.objectStore(STORE_SYS_META);
            const metaGet = sys.get("estoque_migrated_v29");
            metaGet.onsuccess = function(){
              const already = !!(metaGet.result && metaGet.result.value);
              if(already) return;

              const lotes = tx.objectStore(STORE_PRODUTOS_LOTES);
              const movs  = tx.objectStore(STORE_ESTOQUE_MOVIMENTOS);
              const saldos= tx.objectStore(STORE_ESTOQUE_SALDOS);

              const now = new Date().toISOString();

              // Rebuild baseline: sum por (produto_id,lote_id)
              const acc = Object.create(null);

              const cur = lotes.openCursor();
              cur.onsuccess = function(ev){
                const c = ev.target.result;
                if(!c){
                  // Persist saldos + mark migrated
                  try{
                    Object.keys(acc).forEach(function(k){
                      const it = acc[k];
                      const sid = it.produto_id + "|" + (it.produto_lote || "");
                      saldos.put({
                        id: sid,
                        produto_id: it.produto_id,
                        produto_lote: it.produto_lote || null,
                        saldo: it.saldo,
                        updated_at: now,
                        origin: "MIGRATION_V28_LOTES"
                      });
                    });
                    sys.put({ key:"estoque_migrated_v29", value:true, when: now });
                  }catch(_e2){}
                  return;
                }
                const v = c.value || {};
                const pid = String(v.produto_id || "");
                if(!pid){ c.continue(); return; }
                const q = Number(v.qtd != null ? v.qtd : v.quantidade);
                if(!(q > 0)){ c.continue(); return; }

                const loteKey = String(v.id || v.lote || "");
                const key = pid + "|" + loteKey;

                // Movimento determinístico (idempotente por ID e source_sig)
                const mid = "MIG29_" + loteKey;
                const sig = "MIGRATION_V28_LOTES|" + key + "|" + String(q) + "|" + String(v.updated_at || "");

                try{
                  movs.put({
                    id: mid,
                    produto_id: pid,
                    produto_lote: loteKey || null,
                    qty_delta: q,
                    uom: String(v.unidade || v.uom || "un"),
                    kind: "ENTRADA",
                    reason_code: "MIGRATION",
                    created_at: now,
                    source_type: "MIGRATION_V28_LOTES",
                    source_id: loteKey || null,
                    source_sig: sig
                  });
                }catch(_e3){}

                if(!acc[key]) acc[key] = { produto_id: pid, produto_lote: loteKey || null, saldo: 0 };
                acc[key].saldo += q;

                c.continue();
              };
            };
          }
        }catch(_e){}

        if (!db.objectStoreNames.contains(STORE_ANIMAIS_MASTER)) {
          const st = db.createObjectStore(STORE_ANIMAIS_MASTER, { keyPath: "id" });
          st.createIndex("cliente_id", "cliente_id", { unique: false });
          st.createIndex("nome_norm", "nome_norm", { unique: false });
          st.createIndex("status", "status", { unique: false });
          st.createIndex("updated_at", "updated_at", { unique: false });
        }

        // Catálogos Animais (raças/pelagens/espécies) — canônico no IDB
        if (!db.objectStoreNames.contains(STORE_ANIMAIS_RACAS)) {
          const st = db.createObjectStore(STORE_ANIMAIS_RACAS, { keyPath: "id" });
          st.createIndex("nome_norm", "nome_norm", { unique: false });
          st.createIndex("status", "status", { unique: false });
          st.createIndex("updated_at", "updated_at", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_ANIMAIS_PELAGENS)) {
          const st = db.createObjectStore(STORE_ANIMAIS_PELAGENS, { keyPath: "id" });
          st.createIndex("nome_norm", "nome_norm", { unique: false });
          st.createIndex("status", "status", { unique: false });
          st.createIndex("updated_at", "updated_at", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_ANIMAIS_ESPECIES)) {
          const st = db.createObjectStore(STORE_ANIMAIS_ESPECIES, { keyPath: "id" });
          st.createIndex("nome_norm", "nome_norm", { unique: false });
          st.createIndex("status", "status", { unique: false });
          st.createIndex("updated_at", "updated_at", { unique: false });
        }

        // Contas a Pagar (AP) — canônico no IDB (vsc_db)
        if (!db.objectStoreNames.contains(STORE_CONTAS_PAGAR)) {
          const st = db.createObjectStore(STORE_CONTAS_PAGAR, { keyPath: "id" });
          st.createIndex("status", "status", { unique: false });
          st.createIndex("vencimento", "vencimento", { unique: false });
          st.createIndex("fornecedor_doc", "fornecedor_doc", { unique: false });
          st.createIndex("updated_at", "updated_at", { unique: false });
        }

        // Contas a Receber (AR) — canônico IDB
        if (!db.objectStoreNames.contains(STORE_CONTAS_RECEBER)) {
          const st = db.createObjectStore(STORE_CONTAS_RECEBER, { keyPath: "id" });
          st.createIndex("status", "status", { unique: false });
          st.createIndex("vencimento", "vencimento", { unique: false });
          st.createIndex("cliente_id", "cliente_id", { unique: false });
          st.createIndex("updated_at", "updated_at", { unique: false });
        }

        // Fechamentos (faturamento em lote/statement) — canônico IDB (v32)
        if (!db.objectStoreNames.contains(STORE_FECHAMENTOS)) {
          const st = db.createObjectStore(STORE_FECHAMENTOS, { keyPath: "id" });
          st.createIndex("status", "status", { unique: false });
          st.createIndex("cliente_id", "cliente_id", { unique: false });
          st.createIndex("competencia", "competencia", { unique: false });
          st.createIndex("vencimento", "vencimento", { unique: false });
          st.createIndex("updated_at", "updated_at", { unique: false });
          st.createIndex("created_at", "created_at", { unique: false });
        }

        // Fornecedores (canônico — alinhamento com snapshot cloud)
        if (!db.objectStoreNames.contains(STORE_FORNECEDORES_MASTER)) {
          const st = db.createObjectStore(STORE_FORNECEDORES_MASTER, { keyPath: "id" });
          st.createIndex("cnpj_digits", "cnpj_digits", { unique: false });
          st.createIndex("nome_norm", "nome_norm", { unique: false });
          st.createIndex("status", "status", { unique: false });
          st.createIndex("updated_at", "updated_at", { unique: false });
        }

        // Clientes (canônico — continuidade)
        if (!db.objectStoreNames.contains(STORE_CLIENTES_MASTER)) {
          const st = db.createObjectStore(STORE_CLIENTES_MASTER, { keyPath: "id" });
          st.createIndex("doc_digits", "doc_digits", { unique: false });
          st.createIndex("nome_norm", "nome_norm", { unique: false });
          st.createIndex("status", "status", { unique: false });
          st.createIndex("updated_at", "updated_at", { unique: false });
        }

        // Atendimentos (canônico)
        if (!db.objectStoreNames.contains(STORE_ATENDIMENTOS_MASTER)) {
          const st = db.createObjectStore(STORE_ATENDIMENTOS_MASTER, { keyPath: "id" });
          st.createIndex("status", "status", { unique: false });
          st.createIndex("cliente_id", "cliente_id", { unique: false });
          st.createIndex("updated_at", "updated_at", { unique: false });
          st.createIndex("created_at", "created_at", { unique: false });
        }

        if (!db.objectStoreNames.contains(STORE_ANIMAL_VITALS_HISTORY)) {
          const st = db.createObjectStore(STORE_ANIMAL_VITALS_HISTORY, { keyPath: "id" });
          st.createIndex("animal_id", "animal_id", { unique: false });
          st.createIndex("atendimento_id", "atendimento_id", { unique: false });
          st.createIndex("recorded_at", "recorded_at", { unique: false });
          st.createIndex("animal_recorded", ["animal_id","recorded_at"], { unique: false });
        }

        if (!db.objectStoreNames.contains(STORE_ANIMAL_VACCINES)) {
          const st = db.createObjectStore(STORE_ANIMAL_VACCINES, { keyPath: "id" });
          st.createIndex("animal_id", "animal_id", { unique: false });
          st.createIndex("produto_id", "produto_id", { unique: false });
          st.createIndex("atendimento_id", "atendimento_id", { unique: false });
          st.createIndex("data_aplicacao", "data_aplicacao", { unique: false });
          st.createIndex("proxima_dose", "proxima_dose", { unique: false });
          st.createIndex("animal_aplicacao", ["animal_id","data_aplicacao"], { unique: false });
        }

                // ============================================================
        // v23 — CONFIG (date-effective) + RBAC enterprise + auditoria
        // ============================================================

        // --- CONFIG PARAMS (date-effective) ---
        if (!db.objectStoreNames.contains(STORE_CONFIG_PARAMS)) {
          const st = db.createObjectStore(STORE_CONFIG_PARAMS, { keyPath: "id" });
          st.createIndex("key", "key", { unique: false });
          st.createIndex("section", "section", { unique: false });
          st.createIndex("valid_from", "valid_from", { unique: false });
          st.createIndex("valid_to", "valid_to", { unique: false });
          st.createIndex("key_valid_from", ["key","valid_from"], { unique: false });
          st.createIndex("updated_at", "updated_at", { unique: false });
        }

        // --- CONFIG AUDIT LOG ---
        if (!db.objectStoreNames.contains(STORE_CONFIG_AUDIT)) {
          const st = db.createObjectStore(STORE_CONFIG_AUDIT, { keyPath: "id" });
          st.createIndex("when", "when", { unique: false });
          st.createIndex("section", "section", { unique: false });
          st.createIndex("key", "key", { unique: false });
          st.createIndex("valid_from", "valid_from", { unique: false });
        }

        // --- RBAC: ROLES ---
        if (!db.objectStoreNames.contains(STORE_AUTH_ROLES)) {
          const st = db.createObjectStore(STORE_AUTH_ROLES, { keyPath: "id" });
          st.createIndex("name", "name", { unique: true });
          st.createIndex("updated_at", "updated_at", { unique: false });
        }

        // --- RBAC: USERS ---
        if (!db.objectStoreNames.contains(STORE_AUTH_USERS)) {
          const st = db.createObjectStore(STORE_AUTH_USERS, { keyPath: "id" });
          st.createIndex("username", "username", { unique: true });
          st.createIndex("role_id", "role_id", { unique: false });
          st.createIndex("status", "status", { unique: false });
          st.createIndex("updated_at", "updated_at", { unique: false });
        }

        // --- RBAC: ROLE PERMISSIONS ---
        if (!db.objectStoreNames.contains(STORE_AUTH_ROLE_PERMS)) {
          const st = db.createObjectStore(STORE_AUTH_ROLE_PERMS, { keyPath: "id" });
          st.createIndex("role_id", "role_id", { unique: false });
          st.createIndex("module", "module", { unique: false });
          st.createIndex("role_module", ["role_id","module"], { unique: false });
          st.createIndex("updated_at", "updated_at", { unique: false });
        }

        // --- RBAC: SESSIONS ---
        if (!db.objectStoreNames.contains(STORE_AUTH_SESSIONS)) {
          const st = db.createObjectStore(STORE_AUTH_SESSIONS, { keyPath: "id" });
          st.createIndex("user_id", "user_id", { unique: false });
          st.createIndex("status", "status", { unique: false }); // ACTIVE/REVOKED/EXPIRED
          st.createIndex("created_at", "created_at", { unique: false });
          st.createIndex("expires_at", "expires_at", { unique: false });
        }

        // --- RBAC: AUTH AUDIT ---
        if (!db.objectStoreNames.contains(STORE_AUTH_AUDIT)) {
          const st = db.createObjectStore(STORE_AUTH_AUDIT, { keyPath: "id" });
          st.createIndex("when", "when", { unique: false });
          st.createIndex("user_id", "user_id", { unique: false });
          st.createIndex("event", "event", { unique: false });
        }
        // Auditoria Business (Change Documents) — SAP-like
        if (!db.objectStoreNames.contains(STORE_BUSINESS_AUDIT)) {
          const aud = db.createObjectStore(STORE_BUSINESS_AUDIT, { keyPath: "id" });
          aud.createIndex("when", "when", { unique: false });
          aud.createIndex("entity", "entity", { unique: false });
          aud.createIndex("entity_id", "entity_id", { unique: false });
          aud.createIndex("field", "field", { unique: false });
          aud.createIndex("user_id", "user_id", { unique: false });
          aud.createIndex("entity_when", ["entity","when"], { unique: false });
        }

        // Auditoria operacional/UX — trilha de navegação, sync, erros e comportamento diário
        if (!db.objectStoreNames.contains(STORE_UX_AUDIT)) {
          const st = db.createObjectStore(STORE_UX_AUDIT, { keyPath: "id" });
          st.createIndex("when", "when", { unique: false });
          st.createIndex("kind", "kind", { unique: false });
          st.createIndex("category", "category", { unique: false });
          st.createIndex("level", "level", { unique: false });
          st.createIndex("user_id", "user_id", { unique: false });
          st.createIndex("path", "path", { unique: false });
          st.createIndex("kind_when", ["kind","when"], { unique: false });
          st.createIndex("category_when", ["category","when"], { unique: false });
        }

        // ========================
        // REPRODUÇÃO EQUINA (v26)
        // ========================
        if (!db.objectStoreNames.contains(STORE_REPRO_CASES)) {
          const st = db.createObjectStore(STORE_REPRO_CASES, { keyPath: "id" });
          st.createIndex("by_animal", "animal_id", { unique: false });
          st.createIndex("by_season", "season_year", { unique: false });
          st.createIndex("by_status", "status", { unique: false });
          st.createIndex("by_cliente", "cliente_id", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_REPRO_EXAMS)) {
          const st = db.createObjectStore(STORE_REPRO_EXAMS, { keyPath: "id" });
          st.createIndex("by_case", "case_id", { unique: false });
          st.createIndex("by_data", "data_hora", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_REPRO_PROTOCOLS)) {
          const st = db.createObjectStore(STORE_REPRO_PROTOCOLS, { keyPath: "id" });
          st.createIndex("by_case", "case_id", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_REPRO_EVENTS)) {
          const st = db.createObjectStore(STORE_REPRO_EVENTS, { keyPath: "id" });
          st.createIndex("by_case", "case_id", { unique: false });
          st.createIndex("by_data", "data_hora", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_REPRO_PREGNANCY)) {
          const st = db.createObjectStore(STORE_REPRO_PREGNANCY, { keyPath: "id" });
          st.createIndex("by_case", "case_id", { unique: false });
          st.createIndex("by_status", "status", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_REPRO_FOALING)) {
          const st = db.createObjectStore(STORE_REPRO_FOALING, { keyPath: "id" });
          st.createIndex("by_case", "case_id", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_REPRO_TASKS)) {
          const st = db.createObjectStore(STORE_REPRO_TASKS, { keyPath: "id" });
          st.createIndex("by_case", "case_id", { unique: false });
          st.createIndex("by_data", "data_hora", { unique: false });
          st.createIndex("by_status", "status", { unique: false });
        }

        // =========================
        // PERFIL PROFISSIONAL (CRMV) — v28
        // =========================
        if (!db.objectStoreNames.contains(STORE_USER_PROFILES)) {
          const st = db.createObjectStore(STORE_USER_PROFILES, { keyPath: "id" });
          st.createIndex("user_id", "user_id", { unique: true });
          st.createIndex("updated_at", "updated_at", { unique: false });
        } else {
          // Upgrade defensivo: store existe, garantir índices
          try{
            const tx = e.target && e.target.transaction ? e.target.transaction : null;
            if(tx){
              const st = tx.objectStore(STORE_USER_PROFILES);
              if(st && st.indexNames){
                if(!st.indexNames.contains("user_id")) st.createIndex("user_id", "user_id", { unique: true });
                if(!st.indexNames.contains("updated_at")) st.createIndex("updated_at", "updated_at", { unique: false });
              }
            }
          }catch(_){}
        }

        // =========================
        // EMPRESA CADASTRAL/FISCAL — v36
        // Armazena dados da empresa: CNPJ, Razão Social, Nome Fantasia,
        // IE, IM, CNAE, endereço completo, contatos, dados bancários e logo.
        // keyPath "id" = tenant_id (string) para suporte multi-tenant futuro.
        // =========================
        if (!db.objectStoreNames.contains(STORE_EMPRESA)) {
          const st = db.createObjectStore(STORE_EMPRESA, { keyPath: "id" });
          st.createIndex("cnpj_digits", "cnpj_digits", { unique: false });
          st.createIndex("razao_social_norm", "razao_social_norm", { unique: false });
          st.createIndex("updated_at", "updated_at", { unique: false });
        }

        if (!db.objectStoreNames.contains(STORE_DOCUMENTS)) {
          const st = db.createObjectStore(STORE_DOCUMENTS, { keyPath: "id" });
          st.createIndex("entity_type_id", ["entity_type", "entity_id"], { unique: false });
          st.createIndex("entity_id", "entity_id", { unique: false });
          st.createIndex("updated_at", "updated_at", { unique: false });
        }

        if (!db.objectStoreNames.contains(STORE_ATTACHMENTS_QUEUE)) {
          const st = db.createObjectStore(STORE_ATTACHMENTS_QUEUE, { keyPath: "id" });
          st.createIndex("status", "status", { unique: false });
          st.createIndex("atendimento_id", "atendimento_id", { unique: false });
          st.createIndex("attachment_id", "attachment_id", { unique: false });
          st.createIndex("created_at", "created_at", { unique: false });
        }

      };

      req.onsuccess = () => {
        const db = req.result;
        // Repair compat: normaliza outbox antiga (não deve falhar o open).
        _repairOutboxOnce(db).then(()=>resolve(db)).catch(()=>resolve(db));
      };
      req.onerror = () => {
  const err = req.error;
  if (err && err.name === "VersionError") {
    // Attach to existing DB version (do not attempt downgrade).
    const req2 = indexedDB.open(DB_NAME);
    req2.onsuccess = () => resolve(req2.result);
    req2.onerror   = () => reject(req2.error || new Error("Falha ao abrir IndexedDB (fallback)"));
    return;
  }
  reject(err || new Error("Falha ao abrir IndexedDB"));
};
});
  }
  async function tx(storeNames, mode, fn){
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeNames, mode);
      const stores = {};
      for (const s of storeNames) stores[s] = t.objectStore(s);

      let done = false;
      t.oncomplete = () => { if(!done){ done = true; resolve(true); } };
      t.onerror = () => { if(!done){ done = true; reject(t.error || new Error("Tx falhou")); } };
      t.onabort = () => { if(!done){ done = true; reject(t.error || new Error("Tx abortada")); } };

      try {
        fn(stores);
      } catch (err) {
        try { t.abort(); } catch(_){}
        if(!done){ done = true; reject(err); }
      }
    });
  }

  function makeOutboxEvent(storeName, entity, action, entity_id, payload){
    const meta = buildOutboxMetadata(entity, action, entity_id, payload);
    const payloadWithSync = attachSyncMetadata(payload && typeof payload === "object" ? payload : null, meta, action);
    const ts = String(payloadWithSync && payloadWithSync.updated_at || nowISO());
    return {
      id: uuidv4(),
      status: "PENDING",
      store: String(storeName || entity || "UNKNOWN"),
      entity,
      action,
      entity_id,
      payload: payloadWithSync || payload || null,
      created_at: ts,
      updated_at: ts,
      op_id: meta.op_id,
      device_id: meta.device_id,
      base_revision: meta.base_revision,
      entity_revision: meta.entity_revision,
      dedupe_key: meta.dedupe_key,
      next_attempt_at: 0,
      retry_after_ms: 0,
      sending_at: null,
      dead_at: null,
      done_at: null,
      last_error: null
    };
  }

  async function _countPendingOutbox(){
    try{
      const db = await openDB();
      return await new Promise((resolve) => {
        try{
          const tx = db.transaction([STORE_OUTBOX], "readonly");
          const st = tx.objectStore(STORE_OUTBOX);
          let req = null;
          if (st.indexNames && st.indexNames.contains("status")) req = st.index("status").count("PENDING");
          else req = st.getAll();
          req.onsuccess = () => {
            try{
              const result = req.result;
              if (typeof result === "number") resolve(result || 0);
              else {
                const now = Date.now();
                resolve((Array.isArray(result) ? result : []).filter(x => {
                  const st = String((x && x.status) || '').trim().toUpperCase();
                  if(!(st === 'PENDING' || st === 'PENDENTE')) return false;
                  const nextAt = Number(x && x.next_attempt_at || 0) || 0;
                  return !nextAt || nextAt <= now;
                }).length);
              }
            }catch(_){ resolve(0); }
          };
          req.onerror = () => resolve(0);
        }catch(_){ resolve(0); }
      });
    }catch(_){ return 0; }
  }

  async function _emitOutboxChanged(){
    const pending = await _countPendingOutbox();
    try{ window.dispatchEvent(new CustomEvent("vsc:outbox-changed", { detail:{ pending } })); }catch(_){ }
    try{ window.dispatchEvent(new CustomEvent("vsc:sync-progress", { detail:{ pending, running:false } })); }catch(_){ }
    return pending;
  }

  async function outboxEnqueue(entity, action, entity_id, payload){
    const evt = makeOutboxEvent(entity, entity, action, entity_id, payload);
    await tx([STORE_OUTBOX], "readwrite", (s) => {
      s[STORE_OUTBOX].add(evt);
    });
    return { ok:true, outbox_id: evt.id };
  }

  // Canônico: UPSERT dado + OUTBOX na mesma transação
  async function _upsertWithOutbox_v25(storeName, obj, entity, entity_id, payload){
    if (!obj) throw new Error("upsertWithOutbox: obj obrigatório");
    if (!storeName) throw new Error("upsertWithOutbox: storeName obrigatório");
    if (!entity) throw new Error("upsertWithOutbox: entity obrigatório");
    if (!entity_id) throw new Error("upsertWithOutbox: entity_id obrigatório");

    const syncMeta = buildOutboxMetadata(entity, "upsert", entity_id, payload);
    const objWithSync = attachSyncMetadata(obj, syncMeta, "upsert");
    const payloadBase = payload && typeof payload === "object" ? payload : objWithSync;
    const payloadWithSync = attachSyncMetadata(payloadBase, syncMeta, "upsert");
    const evt = {
      id: uuidv4(),
      status: "PENDING",
      store: String(storeName || entity || "UNKNOWN"),
      entity,
      action: "upsert",
      entity_id,
      payload: payloadWithSync || null,
      created_at: objWithSync.updated_at || nowISO(),
      updated_at: objWithSync.updated_at || nowISO(),
      op_id: syncMeta.op_id,
      device_id: syncMeta.device_id,
      base_revision: syncMeta.base_revision,
      entity_revision: syncMeta.entity_revision,
      dedupe_key: syncMeta.dedupe_key,
      next_attempt_at: 0,
      retry_after_ms: 0,
      sending_at: null,
      dead_at: null,
      done_at: null,
      last_error: null
    };

    await tx([storeName, STORE_OUTBOX, STORE_SYS_META, STORE_BACKUP_EVENTS, STORE_BUSINESS_AUDIT], "readwrite", (s) => {
      const main = s[storeName];

      const commit = (beforeObj) => {
        // AUDIT (SAP-like) — somente alteração manual de Master Data
        try{

          const origin = payload && payload.__origin ? String(payload.__origin) : "";

          const isMasterEdit =
            origin === "MASTER_EDIT" ||
            origin === "CADASTRO_MANUAL" ||
            origin === "UI_EDIT";

          if(isMasterEdit){

            const audits = vscAuditDiffs(
              storeName,
              entity,
              entity_id,
              beforeObj || null,
              objWithSync
            );

            if(audits && audits.length){
              const audst = s[STORE_BUSINESS_AUDIT];
              for(let i=0;i<audits.length;i++){
                audst.add(audits[i]);
              }
            }

          }

        }catch(_){
          // fail-closed: auditoria nunca deve quebrar fluxo
        }

        main.put(objWithSync);
        s[STORE_OUTBOX].add(evt);


      // contador de mudanças (governança) + trigger de backup (fila interna)
      try{
        const meta = s[STORE_SYS_META];
        const evst = s[STORE_BACKUP_EVENTS];

        const rqCC = meta.get("change_counter");
        rqCC.onsuccess = () => {
          const cur = rqCC.result && typeof rqCC.result.value === "number" ? rqCC.result.value : 0;
          const next = cur + 1;
          meta.put({ key:"change_counter", value: next });

          const now = Date.now();

          const rqLB = meta.get("last_backup_at");
          rqLB.onsuccess = () => {
            const lastIso = rqLB.result && rqLB.result.value ? String(rqLB.result.value) : null;
            const lastMs = lastIso ? Date.parse(lastIso) : 0;

            const needEdits = (AUTO_BACKUP_EDITS > 0) && (next % AUTO_BACKUP_EDITS === 0);
            const needTime  = (!lastMs) || (now - lastMs >= AUTO_BACKUP_TIME_MS);

            if(needEdits || needTime){
              // Coalesce premium: nunca empilhar múltiplos backups PENDING
              try{
                const ixP = evst.index("status");
                const rqP = ixP.count(IDBKeyRange.only("PENDING"));
                rqP.onsuccess = () => {
                  const pendingCount = rqP.result || 0;
                  if(pendingCount > 0) return; // já existe PENDING → não cria outro
                  const kind = needEdits ? "auto_edits" : "auto_time";
                  evst.add({
                    id: uuidv4(),
                    status: "PENDING",
                    kind,
                    reason: needEdits ? ("edits_" + next) : "time",
                    created_at: nowISO()
                  });
                };
              }catch(_){
                // fallback: comportamento anterior (sem quebrar)
                const kind = needEdits ? "auto_edits" : "auto_time";
                evst.add({
                  id: uuidv4(),
                  status: "PENDING",
                  kind,
                  reason: needEdits ? ("edits_" + next) : "time",
                  created_at: nowISO()
                });
              }
            }
          };
        };
      }catch(_){}
      }; // end commit

      // lê estado anterior e aplica commit com auditoria (SAP-like)
      try{
        const rqPrev = main.get(entity_id);
        rqPrev.onsuccess = () => { try{ commit(rqPrev.result || null); }catch(_){ /* noop */ } };
        rqPrev.onerror   = () => { try{ commit(null); }catch(_){ /* noop */ } };
      }catch(_){
        try{ commit(null); }catch(__){}
      }
    });

    // pós-commit: processa fila de backup sem travar UI
    _kickBackupWorker();
    await _emitOutboxChanged();

    return { ok:true, outbox_id: evt.id };
  }
// ============================================================
// UPSERT COMPAT (v25 + legado)
// - v25+: upsertWithOutbox(storeName, obj, entity, entity_id, payload)
// - legado: upsertWithOutbox(storeName, entity_id, obj, entity)
// Objetivo: impedir regressão por divergência de assinatura (enterprise hardening).
// ============================================================
async function upsertWithOutbox(storeName, a, b, c, d){
  if (!storeName) throw new Error("upsertWithOutbox: storeName obrigatório");

  let obj, entity, entity_id, payload;

  // v25+: 2º argumento é objeto
  if (a && typeof a === "object") {
    obj = a;
    entity = b;
    entity_id = c;
    payload = d;
  } else {
    // legado: (storeName, id, obj, entity)
    entity_id = a;
    obj = b;
    entity = c;
    payload = b;
  }

  return await _upsertWithOutbox_v25(storeName, obj, entity, entity_id, payload);
}

// ============================================================
// CHANGE DOCUMENTS (SAP-like) — leitura do business_audit_log
// ============================================================
async function listChangeDocuments(entity, entity_id, opts){
  opts = opts || {};
  const limit = (opts.limit && Number(opts.limit) > 0) ? Number(opts.limit) : 50;
  if (!entity) throw new Error("listChangeDocuments: entity obrigatório");
  if (!entity_id) throw new Error("listChangeDocuments: entity_id obrigatório");

  const db = await openDB();
  try{
    return await new Promise((resolve, reject) => {
      const out = [];
      const tx0 = db.transaction([STORE_BUSINESS_AUDIT], "readonly");
      const st0 = tx0.objectStore(STORE_BUSINESS_AUDIT);
      const ix = st0.index("entity_when");

      const range = IDBKeyRange.bound([String(entity), ""], [String(entity), "\uffff"]);
      const rq = ix.openCursor(range, "prev"); // mais recentes primeiro

      rq.onsuccess = () => {
        const cur = rq.result;
        if(!cur) return resolve(out);
        const v = cur.value;
        if(v && String(v.entity_id) === String(entity_id)){
          out.push(v);
          if(out.length >= limit) return resolve(out);
        }
        cur.continue();
      };
      rq.onerror = () => reject(rq.error || new Error("listChangeDocuments: cursor error"));
    });
  } finally { try{ db.close(); }catch(_){ } }
}

async function listRecentChanges(entity, opts){
  opts = opts || {};
  const limit = (opts.limit && Number(opts.limit) > 0) ? Number(opts.limit) : 50;
  if (!entity) throw new Error("listRecentChanges: entity obrigatório");

  const db = await openDB();
  try{
    return await new Promise((resolve, reject) => {
      const out = [];
      const tx0 = db.transaction([STORE_BUSINESS_AUDIT], "readonly");
      const st0 = tx0.objectStore(STORE_BUSINESS_AUDIT);
      const ix = st0.index("entity_when");

      const range = IDBKeyRange.bound([String(entity), ""], [String(entity), "\uffff"]);
      const rq = ix.openCursor(range, "prev");

      rq.onsuccess = () => {
        const cur = rq.result;
        if(!cur) return resolve(out);
        out.push(cur.value);
        if(out.length >= limit) return resolve(out);
        cur.continue();
      };
      rq.onerror = () => reject(rq.error || new Error("listRecentChanges: cursor error"));
    });
  } finally { try{ db.close(); }catch(_){ } }
}


  // ============================================================
  // BACKUP/RESTORE (Dump canônico do IndexedDB)
  // - exportDump(): retorna { meta, schema, data }
  // - importDump(): restaura dados (default: merge_newer)
  // ============================================================

  function _safeIso(v){
    try{ return new Date(v).toISOString(); }catch(_){ return null; }
  }

  function _asArray(x){
    return Array.isArray(x) ? x : [];
  }

  async function _getAllFromStore(db, storeName){
    return await new Promise((resolve, reject) => {
      const tx0 = db.transaction([storeName], "readonly");
      const st0 = tx0.objectStore(storeName);
      const out = [];
      const rq = st0.openCursor();
      rq.onsuccess = () => {
        const cur = rq.result;
        if(cur){
          out.push(cur.value);
          cur.continue();
        } else {
          resolve(out);
        }
      };
      rq.onerror = () => reject(rq.error);
    });
  }

  function _describeStore(db, storeName){
    const tx0 = db.transaction([storeName], "readonly");
    const st0 = tx0.objectStore(storeName);

    const idx = [];
    for (const ixName of st0.indexNames){
      const ix = st0.index(ixName);
      idx.push({
        name: ix.name,
        keyPath: ix.keyPath,
        unique: !!ix.unique,
        multiEntry: !!ix.multiEntry
      });
    }

    return {
      name: st0.name,
      keyPath: st0.keyPath,
      autoIncrement: !!st0.autoIncrement,
      indexes: idx
    };
  }

  async function exportDump(){
    const db = await openDB();
    try{
      const storeNames = Array.from(db.objectStoreNames);

      const schema = {
        db_name: DB_NAME,
        db_version: db.version,
        exported_at: _safeIso(Date.now()),
        stores: storeNames.map(s => _describeStore(db, s))
      };

      const data = {};
      for(const s of storeNames){
        data[s] = await _getAllFromStore(db, s);
      }

      const meta = {
        app: "Vet System Control – Equine",
        db_name: DB_NAME,
        db_version: db.version,
        exported_at: schema.exported_at,
        counts: storeNames.reduce((acc, s) => { acc[s] = _asArray(data[s]).length; return acc; }, {})
      };

      return { meta, schema, data };
    } finally {
      try{ db.close(); }catch(_){}
    }
  }

  function _pickUpdatedAt(o){
    if(!o) return null;
    return o.updated_at || o.updatedAt || o.last_update || null;
  }

  function _isTombstoneRecord(o){
    return !!(o && typeof o === 'object' && (o.__tombstone__ === true || o.deleted === true || o.__deleted__ === true || o.deleted_at));
  }

  function _getStoreKeyValue(storeHandle, row){
    if(!row || typeof row !== 'object') return null;
    const keyPath = storeHandle && storeHandle.keyPath;
    if(typeof keyPath === 'string' && keyPath){
      const direct = row[keyPath];
      if(direct != null && String(direct).trim()) return direct;
      if(row.__record_id__ != null && String(row.__record_id__).trim()) return row.__record_id__;
    }
    if(Array.isArray(keyPath) && keyPath.length){
      const values = keyPath.map((kp) => row[kp]);
      if(values.every((value) => value != null && String(value).trim())) return values;
      if(row.__record_id__ != null && String(row.__record_id__).trim()) return row.__record_id__;
    }
    const fallback = row.id ?? row.produto_id ?? row.uuid ?? row.key ?? row.code ?? row.tenant_id ?? row.lote_id ?? row.__record_id__ ?? null;
    return (fallback != null && String(fallback).trim()) ? fallback : null;
  }

  function _normalizeRemoteAuthorityEntry(row){
    if(!row || typeof row !== 'object') return null;
    return {
      entity_revision: Number(row.sync_rev ?? row.entity_revision ?? row.base_revision ?? row.revision) || 0,
      updated_at: _pickUpdatedAt(row) || null,
      deleted_at: row.deleted_at || null,
      tombstone: _isTombstoneRecord(row),
      op_id: String(row.last_synced_op_id || row.source_op_id || '').trim() || null,
    };
  }

  function _compareAuthorityAgainstOutbox(authority, outboxRec){
    const authorityRev = Number(authority && authority.entity_revision) || 0;
    const outboxRev = Number(outboxRec && (outboxRec.entity_revision ?? outboxRec.sync_rev ?? outboxRec.base_revision ?? outboxRec.revision)) || 0;
    if(authorityRev !== outboxRev) return authorityRev > outboxRev ? 1 : -1;

    const authorityMs = Date.parse(String(authority && authority.updated_at || authority && authority.deleted_at || ''));
    const outboxMs = Date.parse(String(outboxRec && (outboxRec.updated_at || outboxRec.created_at) || ''));
    if(Number.isFinite(authorityMs) && Number.isFinite(outboxMs) && authorityMs !== outboxMs) return authorityMs > outboxMs ? 1 : -1;
    if(Number.isFinite(authorityMs) && !Number.isFinite(outboxMs)) return 1;
    if(!Number.isFinite(authorityMs) && Number.isFinite(outboxMs)) return -1;
    return 0;
  }

  async function _reconcileOutboxWithImportedAuthorities(authorityByStore){
    const storeNames = authorityByStore ? Object.keys(authorityByStore) : [];
    if(!storeNames.length) return { done:0, dead:0, scanned:0 };

    let done = 0;
    let dead = 0;
    let scanned = 0;

    await tx([STORE_OUTBOX], 'readwrite', (stores) => {
      const outbox = stores[STORE_OUTBOX];
      const req = outbox.getAll();
      req.onsuccess = () => {
        const rows = Array.isArray(req.result) ? req.result : [];
        for(const rec of rows){
          if(!rec || !rec.id) continue;
          const status = String(rec.status || '').toUpperCase();
          if(status !== 'PENDING' && status !== 'SENDING') continue;
          scanned++;

          const storeName = String(rec.store || rec.store_name || rec.entity || '').trim();
          const entityId = String(rec.entity_id || '').trim();
          if(!storeName || !entityId) continue;
          const authorityStore = authorityByStore[storeName];
          const authority = authorityStore ? authorityStore[entityId] : null;
          if(!authority) continue;

          const authorityOpId = String(authority.op_id || '').trim();
          const recOpId = String(rec.op_id || '').trim();
          if(authorityOpId && recOpId && authorityOpId === recOpId){
            rec.status = 'DONE';
            rec.done_at = _safeIso(Date.now());
            rec.last_error = null;
            rec.last_ack = { ok:true, source:'snapshot_reconcile', op_id: recOpId };
            try{ outbox.put(rec); }catch(_){ }
            done++;
            continue;
          }

          const cmp = _compareAuthorityAgainstOutbox(authority, rec);
          if(cmp >= 0){
            rec.status = 'DEAD';
            rec.dead_at = _safeIso(Date.now());
            rec.last_error = authority.tombstone ? 'remote_delete_superseded_local_op' : 'remote_newer_revision_superseded_local_op';
            rec.remote_authority = {
              entity_revision: authority.entity_revision || 0,
              updated_at: authority.updated_at || authority.deleted_at || null,
              tombstone: !!authority.tombstone,
              op_id: authority.op_id || null,
            };
            try{ outbox.put(rec); }catch(_){ }
            dead++;
          }
        }
      };
    });

    return { done, dead, scanned };
  }

  async function importDump(dump, opts){
    opts = opts || {};
    const mode = (opts.mode || "merge_newer"); // merge_newer | merge_keep_existing | replace_store

    if(!dump || typeof dump !== "object") throw new Error("importDump: dump inválido");
    if(!dump.schema || !dump.data) throw new Error("importDump: schema/data ausentes");

    const db = await openDB();
    try{
      if(dump.schema.db_name && dump.schema.db_name !== DB_NAME){
        throw new Error("importDump: db_name divergente");
      }

      const storeNames = Array.from(db.objectStoreNames);
      const incomingStores = Object.keys(dump.data || {});
      for(const s of incomingStores){
        if(!storeNames.includes(s)){
          throw new Error("importDump: store inexistente no DB atual: " + s);
        }
      }

      const authorityByStore = {};

      for(const s of incomingStores){
        const rows = _asArray(dump.data[s]);
        authorityByStore[s] = authorityByStore[s] || {};

        await new Promise((resolve, reject) => {
          const tx0 = db.transaction([s], "readwrite");
          const st0 = tx0.objectStore(s);

          function softFail(req){
            if(!req) return;
            req.onerror = (ev) => {
              try{ ev.preventDefault(); }catch(_){ }
              try{ console.warn("[VSC_DB] importDump: item ignorado em", s, req.error); }catch(_){ }
            };
          }

          tx0.oncomplete = () => resolve();
          tx0.onerror = () => reject(tx0.error || new Error("importDump: tx error"));
          tx0.onabort = () => reject(tx0.error || new Error("importDump: tx abort"));

          if(mode === "replace_store"){
            const clr = st0.clear();
            clr.onerror = () => reject(clr.error);
            clr.onsuccess = () => {
              for(const r of rows){
                const key = _getStoreKeyValue(st0, r);
                if(key != null){
                  const authority = _normalizeRemoteAuthorityEntry(r);
                  if(authority) authorityByStore[s][String(key)] = authority;
                }
                if(_isTombstoneRecord(r)){
                  if(key != null){
                    try{ softFail(st0.delete(key)); }catch(_){ }
                  }
                  continue;
                }
                try{ softFail(st0.put(r)); }catch(_){ }
              }
            };
            return;
          }

          for(const r of rows){
            const key = _getStoreKeyValue(st0, r);
            const tombstone = _isTombstoneRecord(r);
            if(key != null){
              const authority = _normalizeRemoteAuthorityEntry(r);
              if(authority) authorityByStore[s][String(key)] = authority;
            }

            if(!key || mode === "merge_keep_existing"){
              if(!key){
                if(!tombstone){
                  try{ softFail(st0.put(r)); }catch(_){ }
                }
              }else if(!tombstone){
                const g = st0.get(key);
                softFail(g);
                g.onsuccess = () => {
                  if(!g.result){
                    try{ softFail(st0.put(r)); }catch(_){ }
                  }
                };
              }
              continue;
            }

            const g = st0.get(key);
            softFail(g);
            g.onsuccess = () => {
              const cur = g.result || null;
              if(!cur){
                if(tombstone){
                  try{ softFail(st0.delete(key)); }catch(_){ }
                }else{
                  try{ softFail(st0.put(r)); }catch(_){ }
                }
                return;
              }

              const precedence = compareSyncPriority(cur, r);
              if(precedence > 0 || (precedence === 0 && tombstone)){
                try{
                  if(tombstone) softFail(st0.delete(key));
                  else softFail(st0.put(r));
                }catch(_){ }
                return;
              }

              if(precedence === 0 && !tombstone){
                const a = _pickUpdatedAt(cur);
                const b = _pickUpdatedAt(r);
                const da = Date.parse(a || '');
                const dbb = Date.parse(b || '');
                if(Number.isFinite(dbb) && (!Number.isFinite(da) || dbb >= da)){
                  try{ softFail(st0.put(r)); }catch(_){ }
                }
              }
            };
          }
        });
      }

      const outboxReconciliation = await _reconcileOutboxWithImportedAuthorities(authorityByStore).catch((err) => ({ ok:false, error:String(err && (err.message || err) || err) }));
      return { ok:true, mode, importedStores: incomingStores, outboxReconciliation };
    } finally {
      try{ db.close(); }catch(_){ }
    }
  }


  // ============================================================
  // AUTO-BACKUP FASE 1 (PROTEÇÃO IMEDIATA)
  // ============================================================
  // META-ONLY (ENTERPRISE): auto-backup registra APENAS metadados.
  // Backup completo (dump) será manual via UI (gesto do usuário).
  // ============================================================

  async function _sha256Hex(text){
    try{
      if(!crypto || !crypto.subtle) return null;
      const enc = new TextEncoder();
      const buf = enc.encode(String(text || ""));
      const dig = await crypto.subtle.digest("SHA-256", buf);
      const arr = Array.from(new Uint8Array(dig));
      return arr.map(b=>b.toString(16).padStart(2,"0")).join("");
    }catch(_){
      return null;
    }
  }

  async function _countStore(db, storeName){
    return await new Promise((resolve, reject) => {
      const tx0 = db.transaction([storeName], "readonly");
      const st0 = tx0.objectStore(storeName);
      const rq = st0.count();
      rq.onsuccess = () => resolve(rq.result || 0);
      rq.onerror = () => reject(rq.error);
    });
  }

  async function _getCounts(db){
    const stores = Array.from(db.objectStoreNames);
    const counts = {};
    for(const s of stores){
      try{ counts[s] = await _countStore(db, s); }
      catch(_){ counts[s] = null; }
    }
    return counts;
  }

  async function _purgeBackupsOnce(db){
    // Purge definitivo anti-OOM (uma única vez): limpa db_backups e marca em sys_meta
    return await new Promise((resolve, reject) => {
      const tx0 = db.transaction([STORE_SYS_META, STORE_DB_BACKUPS], "readwrite");
      const meta = tx0.objectStore(STORE_SYS_META);
      const bkps = tx0.objectStore(STORE_DB_BACKUPS);

      const g = meta.get("purged_backups_v1");
      g.onsuccess = () => {
        const done = !!(g.result && g.result.value === true);
        if(done) return;
        try{ bkps.clear(); }catch(_){}
        meta.put({ key:"purged_backups_v1", value:true });
      };
      g.onerror = () => reject(g.error);

      tx0.oncomplete = () => resolve(true);
      tx0.onerror = () => reject(tx0.error || new Error("purge: tx error"));
      tx0.onabort = () => reject(tx0.error || new Error("purge: tx abort"));
    });
  }

  function _listBackups(db){
    return new Promise((resolve, reject) => {
      const tx0 = db.transaction([STORE_DB_BACKUPS], "readonly");
      const st0 = tx0.objectStore(STORE_DB_BACKUPS);
      const ix = st0.index("created_at");
      const out = [];
      const rq = ix.openCursor(null, "prev"); // mais novos primeiro
      rq.onsuccess = () => {
        const cur = rq.result;
        if(cur){ out.push(cur.value); cur.continue(); }
        else resolve(out);
      };
      rq.onerror = () => reject(rq.error);
    });
  }

  async function _saveBackupMetaOnly(db, ev){
    // Meta-only: counts + hash de resumo pequeno
    const counts = await _getCounts(db);
    const createdAt = nowISO();

    const summary = {
      db_name: DB_NAME,
      db_version: db.version,
      kind: (ev && ev.kind) ? ev.kind : "auto",
      created_at: createdAt,
      counts
    };

    const summaryJson = JSON.stringify(summary);
    const sha256 = await _sha256Hex(summaryJson);
    const sizeBytes = (new Blob([summaryJson], { type:"application/json" })).size;
    const backupId = uuidv4();

    await new Promise((resolve, reject) => {
      const tx0 = db.transaction([STORE_DB_BACKUPS, STORE_BACKUP_EVENTS, STORE_SYS_META], "readwrite");
      const stB = tx0.objectStore(STORE_DB_BACKUPS);
      const stE = tx0.objectStore(STORE_BACKUP_EVENTS);
      const stM = tx0.objectStore(STORE_SYS_META);

      tx0.oncomplete = () => resolve();
      tx0.onerror = () => reject(tx0.error || new Error("backup-meta: tx error"));
      tx0.onabort = () => reject(tx0.error || new Error("backup-meta: tx abort"));

      stB.put({
        id: backupId,
        kind: (ev && ev.kind) ? ev.kind : "auto",
        created_at: createdAt,
        size_bytes: sizeBytes,
        sha256: sha256 || null,
        format: "meta_only",
        counts: counts
      });

      stE.put({
        ...ev,
        status: "DONE",
        backup_id: backupId,
        size_bytes: sizeBytes,
        sha256: sha256 || null,
        finished_at: createdAt
      });

      stM.put({ key:"last_backup_at", value: createdAt });
    });

    // retenção (mantém últimos N metadados)
    const all = await _listBackups(db);
    if(all.length > AUTO_BACKUP_MAX_INTERNAL){
      const toDelete = all.slice(AUTO_BACKUP_MAX_INTERNAL);
      await new Promise((resolve, reject) => {
        const tx1 = db.transaction([STORE_DB_BACKUPS], "readwrite");
        const st1 = tx1.objectStore(STORE_DB_BACKUPS);
        tx1.oncomplete = () => resolve();
        tx1.onerror = () => reject(tx1.error || new Error("backup-meta: retenção tx error"));
        for(const b of toDelete){
          try{ st1.delete(b.id); }catch(_){}
        }
      });
    }

    return { ok:true, backup_id: backupId, size_bytes: sizeBytes, sha256: sha256 || null, created_at: createdAt };
  }

  // ============================================================
  // AUTO-BACKUP WORKER
  // ============================================================

  let _backupWorkerRunning = false;

  function _kickBackupWorker(){
    if(_backupWorkerRunning) return;
    _backupWorkerRunning = true;
    setTimeout(() => {
      _backupWorkerLoop()
        .catch(() => {}) // fail-closed: não derruba o app
        .finally(() => { _backupWorkerRunning = false; });
    }, 0);
  }

  function _getOnePendingEvent(db){
    return new Promise((resolve, reject) => {
      const tx0 = db.transaction([STORE_BACKUP_EVENTS], "readonly");
      const st0 = tx0.objectStore(STORE_BACKUP_EVENTS);
      const ix = st0.index("status_created");

      const range = IDBKeyRange.bound(["PENDING",""], ["PENDING","\uffff"]);
      const rq = ix.openCursor(range, "next");

      rq.onsuccess = () => {
        const cur = rq.result;
        if(!cur) return resolve(null);
        resolve(cur.value);
      };
      rq.onerror = () => reject(rq.error);
    });
  }

  async function _backupWorkerLoop(){
    const db = await openDB();
    try{
      try{ await _purgeBackupsOnce(db); }catch(_){}

      for(;;){
        const ev = await _getOnePendingEvent(db);
        if(!ev) break;
        await _saveBackupMetaOnly(db, ev);
      }
    } finally {
      try{ db.close(); }catch(_){}
    }
  }

  async function listInternalBackups(){
    const db = await openDB();
    try{ return await _listBackups(db); }
    finally{ try{ db.close(); }catch(_){ } }
  }

  async function getInternalBackup(backupId){
    const db = await openDB();
    try{
      return await new Promise((resolve, reject) => {
        const tx0 = db.transaction([STORE_DB_BACKUPS], "readonly");
        const st0 = tx0.objectStore(STORE_DB_BACKUPS);
        const rq = st0.get(backupId);
        rq.onsuccess = () => resolve(rq.result || null);
        rq.onerror = () => reject(rq.error);
      });
    } finally { try{ db.close(); }catch(_){ } }
  }

  async function restoreInternalBackup(){
    throw new Error("restoreInternalBackup: indisponível. Restore enterprise somente via arquivo (gesto do usuário).");
  }

  // ============================================================
  // BACKUP INTEGRAL EM ARQUIVO (PREMIUM — por gesto do usuário)
  // ============================================================

  function _pad2(n){ return String(n).padStart(2,"0"); }

  function _backupFilename(){
    const d = new Date();
    const y = d.getFullYear();
    const m = _pad2(d.getMonth()+1);
    const da = _pad2(d.getDate());
    const hh = _pad2(d.getHours());
    const mm = _pad2(d.getMinutes());
    const ss = _pad2(d.getSeconds());
    return `vsc_backup_${DB_NAME}_v${DB_VERSION}_${y}${m}${da}_${hh}${mm}${ss}.json`;
  }

  function _downloadBlob(blob, filename){
    const url = URL.createObjectURL(blob);
    try{
      const a = document.createElement("a");
      a.href = url;
      a.download = filename || "backup.json";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        try{ document.body.removeChild(a); }catch(_){}
        try{ URL.revokeObjectURL(url); }catch(_){}
      }, 0);
      return true;
    }catch(_){
      try{ URL.revokeObjectURL(url); }catch(_){}
      return false;
    }
  }

  // [continua na PARTE 3/4]
  async function downloadBackupFile(){
    const dump = await exportDump();
    const json = JSON.stringify(dump, null, 2);
    const blob = new Blob([json], { type:"application/json" });
    const filename = _backupFilename();
    const ok = _downloadBlob(blob, filename);
    if(!ok) throw new Error("Falha ao iniciar download do backup.");
    return { ok:true, filename, bytes: blob.size, meta: dump.meta };
  }

  
  async function importBackupFile(fileOrBlob, opts){
    if(!fileOrBlob) throw new Error("Arquivo de backup ausente.");
    // Aceita File/Blob. Espera JSON (ex.: .json ou .vscbak contendo JSON).
    let txt = "";
    try{
      if(typeof fileOrBlob.text === "function"){
        txt = await fileOrBlob.text();
      }else{
        // fallback FileReader (ambientes legados)
        txt = await new Promise((res, rej) => {
          try{
            const fr = new FileReader();
            fr.onerror = () => rej(fr.error || new Error("Falha ao ler arquivo."));
            fr.onload  = () => res(String(fr.result || ""));
            fr.readAsText(fileOrBlob);
          }catch(e){ rej(e); }
        });
      }
    }catch(e){
      throw new Error("Falha ao ler arquivo de backup.");
    }

    // SHA-256 local (best-effort; não bloqueia restore se indisponível)
    let sha256_hex = null;
    try{
      if(window.crypto && window.crypto.subtle && typeof TextEncoder === "function"){
        const u8 = new TextEncoder().encode(txt);
        const dig = await window.crypto.subtle.digest("SHA-256", u8);
        const arr = Array.from(new Uint8Array(dig));
        sha256_hex = arr.map(b => b.toString(16).padStart(2,"0")).join("");
      }
    }catch(_){ sha256_hex = null; }

    const r = await importBackupFromJson(txt, opts || { mode:"merge_newer" });
    // r é retorno de importDump. Acrescenta metadados.
    if(r && typeof r === "object"){
      r.sha256 = sha256_hex;
      r.sha_ok = null; // só é possível validar contra manifest/servidor se fornecido externamente
    }
    return r;
  }

async function importBackupFromJson(jsonText, opts){
	    let dump = null;
	    const raw = String(jsonText || "");
	    try{
	      dump = JSON.parse(raw);
	    }catch(_){
	      // Reparação best-effort: backups stream antigos podem ter sido gerados com
	      // fechamento indevido do objeto `data` a cada store (bug histórico).
	      // Ex.: ... "store":[... ]}\n"next_store": ...
	      // Aqui tentamos remover os `}` extras e revalidar.
	      if(raw.includes('"format":"vsc_backup_stream_v1"')){
	        let fixed = raw;
	        // Remove } logo após o fechamento de array dentro de `data`
	        fixed = fixed.replace(/\]\s*}\s*,\s*\n\s*"/g, '],\n"');
	        fixed = fixed.replace(/\]\s*}\s*\n\s*"/g, '],\n"');
	        // Corrige o caso do último store: ]}\n}}  -> ]\n}}
	        fixed = fixed.replace(/\]\s*}\s*(\r?\n)\s*}}\s*$/m, ']$1}}');
	        try{
	          dump = JSON.parse(fixed);
	        }catch(__){
	          throw new Error("Arquivo de backup inválido (JSON).");
	        }
	      }else{
	        throw new Error("Arquivo de backup inválido (JSON).");
	      }
	    }

    // Compatibilidade: alguns backups (.vscbak) podem estar no formato "stream".
    // Normaliza para o formato canônico esperado por importDump(): { schema, data }.
    // Ex.: { format:"vsc_backup_stream_v1", db_name:"vsc_db", db_version:30, data:{...} }
    if(dump && typeof dump === "object" && !dump.schema && dump.data && dump.format){
      dump = {
        meta: {
          format: dump.format,
          created_at: dump.created_at || null,
          note: "normalized_from_stream"
        },
        schema: {
          db_name: dump.db_name || DB_NAME,
          db_version: dump.db_version || null,
          stores: Object.keys(dump.data || {})
        },
        data: dump.data
      };
    }
    return await importDump(dump, opts || { mode:"merge_newer" });
  }


  const EMPRESA_LOCAL_KEY = "empresa_local";
  const EMPRESA_LS_KEY = "vsc_empresa_v1";
  const EMPRESA_LS_META_KEY = "vsc_empresa_v1_meta";

  function normalizeEmpresaSnapshot(raw){
    const src = raw && typeof raw === "object" ? raw : {};
    const pick = function(){
      for (let i = 0; i < arguments.length; i++) {
        const v = arguments[i];
        if (v !== undefined && v !== null && String(v).trim() !== "") return v;
      }
      return "";
    };
    const out = Object.assign({}, src, {
      id: String(src.id || EMPRESA_LOCAL_KEY),
      cnpj: String(pick(src.cnpj, src.doc, src.documento) || ""),
      razao_social: String(pick(src.razao_social, src.nome, src.razaoSocial) || ""),
      nome_fantasia: String(pick(src.nome_fantasia, src.fantasia, src.nomeFantasia, src.nome) || ""),
      ie: String(pick(src.ie, src.inscricao_estadual) || ""),
      im: String(pick(src.im, src.inscricao_municipal) || ""),
      cnae: String(pick(src.cnae, src.cnae_principal) || ""),
      abertura: String(src.abertura || ""),
      regime: String(pick(src.regime, src.regime_tributario) || ""),
      telefone: String(pick(src.telefone, src.fone) || ""),
      celular: String(src.celular || ""),
      email: String(src.email || ""),
      site: String(src.site || ""),
      pix_tipo: String(pick(src.pix_tipo, src.pixTipo) || ""),
      pix_nome: String(pick(src.pix_nome, src.pixNome, src.favorecido_pix) || ""),
      pix_chave: String(pick(src.pix_chave, src.chave_pix, src.pixKey, src.pix, src.pix_chave_copia_cola) || ""),
      pix_chave_norm: String(src.pix_chave_norm || ""),
      cep: String(src.cep || ""),
      uf: String(src.uf || ""),
      logradouro: String(src.logradouro || ""),
      numero: String(src.numero || ""),
      complemento: String(src.complemento || ""),
      bairro: String(src.bairro || ""),
      cidade: String(src.cidade || ""),
      ibge: String(src.ibge || ""),
      crmv: String(src.crmv || ""),
      crmv_uf: String(src.crmv_uf || ""),
      obs: String(src.obs || ""),
      __logoA: String(src.__logoA || src.logoA || ""),
      __logoB: String(src.__logoB || src.logoB || ""),
      updated_at: String(src.updated_at || nowISO())
    });
    out.cnpj_digits = String(out.cnpj || "").replace(/\D+/g, "");
    out.razao_social_norm = String(out.razao_social || "").toLowerCase().trim();
    return out;
  }

  function readEmpresaSnapshotFromLocalStorage(){
    try{
      const raw = localStorage.getItem(EMPRESA_LS_KEY);
      if(!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? normalizeEmpresaSnapshot(parsed) : null;
    }catch(_){ return null; }
  }

  function mirrorEmpresaSnapshotToLocalStorage(snapshot){
    try{
      const normalized = normalizeEmpresaSnapshot(snapshot || {});
      localStorage.setItem(EMPRESA_LS_KEY, JSON.stringify(normalized));
      localStorage.setItem(EMPRESA_LS_META_KEY, JSON.stringify({ version: 2, savedAt: nowISO(), source: "vsc_db" }));
      localStorage.setItem("empresa_configurada", "1");
      return normalized;
    }catch(_){ return normalizeEmpresaSnapshot(snapshot || {}); }
  }

  async function getEmpresaSnapshot(options){
    const opts = options && typeof options === "object" ? options : {};
    const preferIdb = opts.preferIdb !== false;
    const hydrateLocalStorage = opts.hydrateLocalStorage !== false;
    const lsSnapshot = readEmpresaSnapshotFromLocalStorage();
    if (!preferIdb && lsSnapshot) return lsSnapshot;

    try{
      const db = await openDB();
      const rec = await new Promise((resolve, reject) => {
        try{
          const tx = db.transaction([STORE_EMPRESA], "readonly");
          const st = tx.objectStore(STORE_EMPRESA);
          const req = st.get(EMPRESA_LOCAL_KEY);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error || new Error("empresa_get_failed"));
        }catch(e){ reject(e); }
      });
      try{ db.close(); }catch(_){ }
      if (rec && typeof rec === "object") {
        const normalized = normalizeEmpresaSnapshot(rec);
        if (hydrateLocalStorage) mirrorEmpresaSnapshotToLocalStorage(normalized);
        return normalized;
      }
    }catch(_){ }

    return lsSnapshot || normalizeEmpresaSnapshot({});
  }

  async function saveEmpresaSnapshot(snapshot, options){
    const opts = options && typeof options === "object" ? options : {};
    const enqueueSync = opts.enqueueSync !== false;
    const mirrorLocalStorage = opts.mirrorLocalStorage !== false;
    const normalized = normalizeEmpresaSnapshot(snapshot || {});
    normalized.id = EMPRESA_LOCAL_KEY;
    normalized.updated_at = nowISO();

    await tx([STORE_EMPRESA], "readwrite", (stores) => {
      stores[STORE_EMPRESA].put(normalized);
    });

    if (mirrorLocalStorage) mirrorEmpresaSnapshotToLocalStorage(normalized);
    if (enqueueSync) {
      try{ await outboxEnqueue("empresa", "upsert", EMPRESA_LOCAL_KEY, normalized); }catch(_){ }
    }
    try{ window.dispatchEvent(new CustomEvent("vsc:empresa-updated", { detail: { snapshot: normalized } })); }catch(_){ }
    return normalized;
  }

  function readRuntimeUserFromStorage(){
    try{
      const raw = localStorage.getItem("vsc_user") || sessionStorage.getItem("vsc_user") || "null";
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    }catch(_){ return null; }
  }

  function readRuntimeSessionIdFromStorage(){
    try{
      const sid = localStorage.getItem("vsc_session_id") || sessionStorage.getItem("vsc_session_id") || "";
      return String(sid || "").trim().slice(0, 160);
    }catch(_){ return ""; }
  }

  function readRuntimeTokenFromStorage(){
    try{
      const token =
        localStorage.getItem("vsc_local_token") ||
        sessionStorage.getItem("vsc_local_token") ||
        localStorage.getItem("vsc_token") ||
        sessionStorage.getItem("vsc_token") ||
        "";
      return String(token || "").trim();
    }catch(_){ return ""; }
  }

  function normalizeTenantId(raw){
    try{
      const value = String(raw || "tenant-default")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._:-]+/g, "-")
        .replace(/-+/g, "-")
        .slice(0, 120);
      return value || "tenant-default";
    }catch(_){ return "tenant-default"; }
  }

  function readRuntimeTenantFromStorage(){
    try{
      const raw =
        localStorage.getItem("vsc_tenant") ||
        sessionStorage.getItem("vsc_tenant") ||
        localStorage.getItem("VSC_TENANT") ||
        sessionStorage.getItem("VSC_TENANT") ||
        "tenant-default";
      return normalizeTenantId(raw || "tenant-default");
    }catch(_){ return "tenant-default"; }
  }

  async function getRuntimeContext(options){
    const opts = options && typeof options === "object" ? options : {};
    let authUser = null;
    if (opts.preferAuthApi !== false) {
      try{
        if (window.VSC_AUTH && typeof window.VSC_AUTH.getCurrentUser === "function") {
          authUser = await window.VSC_AUTH.getCurrentUser();
        }
      }catch(_){ authUser = null; }
    }

    const storedUser = readRuntimeUserFromStorage();
    const user = authUser && typeof authUser === "object" ? authUser : (storedUser && typeof storedUser === "object" ? storedUser : null);
    const tenantFromUser = user && (user.tenant || user.tenant_id || user.tenantId) ? normalizeTenantId(user.tenant || user.tenant_id || user.tenantId) : "";
    const tenant = normalizeTenantId(tenantFromUser || readRuntimeTenantFromStorage() || "tenant-default");
    const sessionId = readRuntimeSessionIdFromStorage();
    const token = readRuntimeTokenFromStorage();
    const userLabel = String(
      user && (user.username || user.nome || user.name || user.usuario || user.email || user.id) ||
      "anonymous"
    ).trim().slice(0, 120) || "anonymous";

    return {
      tenant,
      token,
      sessionId,
      user,
      userLabel,
      authorized: !!(token || sessionId),
    };
  }

  async function getSyncAuthHeaders(extraHeaders, options){
    const ctx = await getRuntimeContext(options);
    const headers = Object.assign({}, extraHeaders || {}, {
      "X-VSC-Tenant": String(ctx.tenant || "tenant-default"),
    });
    if (ctx.userLabel) headers["X-VSC-User"] = ctx.userLabel;
    if (ctx.sessionId) headers["X-VSC-Client-Session"] = ctx.sessionId;
    if (ctx.token) {
      headers["X-VSC-Token"] = ctx.token;
      headers["Authorization"] = `Bearer ${ctx.token}`;
    }
    return headers;
  }



  let __vscSwRegisterPromise = null;
  function registerServiceWorkerOnce(){
    try{
      if(__vscSwRegisterPromise) return __vscSwRegisterPromise;
      if(typeof window === "undefined" || !window.isSecureContext) return Promise.resolve(false);
      if(!("serviceWorker" in navigator)) return Promise.resolve(false);
      const proto = String(location.protocol || "").toLowerCase();
      if(proto === "file:") return Promise.resolve(false);
      __vscSwRegisterPromise = navigator.serviceWorker.register("/sw.js").then((reg) => {
        try{ if(reg && typeof reg.update === "function") reg.update().catch(()=>{}); }catch(_){ }
        return true;
      }).catch(() => false);
      return __vscSwRegisterPromise;
    }catch(_){ return Promise.resolve(false); }
  }


  async function appendAuditEvent(storeName, record){
    const id = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(16).slice(2);
    const runtime = getRuntimeContext();
    const rec = {
      id,
      when: nowIso(),
      user_id: runtime.user_id || runtime.username || null,
      tenant: runtime.tenant || 'tenant-default',
      ...Object(record || {}),
    };
    try{
      await tx([storeName], 'readwrite', (stores) => {
        stores[storeName].put(rec);
      });
      return rec;
    }catch(_){
      return null;
    }
  }

  async function appendUxAudit(record){
    return appendAuditEvent(STORE_UX_AUDIT, record);
  }

  async function listAuditEvents(storeName, limit = 200){
    const db = await openDB();
    try{
      return await new Promise((resolve, reject) => {
        const tx0 = db.transaction([storeName], 'readonly');
        const st = tx0.objectStore(storeName);
        const req = st.getAll();
        req.onsuccess = () => {
          const rows = Array.isArray(req.result) ? req.result.slice(0) : [];
          rows.sort((a,b) => String(b && b.when || '').localeCompare(String(a && a.when || '')));
          resolve(rows.slice(0, Math.max(1, Number(limit) || 200)));
        };
        req.onerror = () => reject(req.error || new Error('Falha audit getAll'));
      });
    } finally { try{ db.close(); }catch(_){ } }
  }

  // ============================================================
  // Exposição GLOBAL (API canônica)
  // ============================================================
  window.VSC_DB = {
    // core
    openDB,
    exportDump,
    importDump,

    // outbox
    outboxEnqueue,
    upsertWithOutbox,

    // auditoria SAP-like (Change Documents)
    listChangeDocuments,
    listRecentChanges,

    // backups internos (meta-only)
    listInternalBackups,
    getInternalBackup,
    restoreInternalBackup, // proibido nesta fase

    // backup em arquivo (gesto do usuário)
    downloadBackupFile,
    importBackupFromJson,
    importBackupFile,

    // empresa / branding / impressão (leitura canônica)
    getEmpresaSnapshot,
    saveEmpresaSnapshot,
    mirrorEmpresaSnapshotToLocalStorage,

    // contexto canônico de runtime (tenant / token / sessão / usuário)
    getRuntimeContext,
    getSyncAuthHeaders,
    registerServiceWorkerOnce,
    appendUxAudit,
    listAuditEvents,

    // stores (mapa canônico)
    stores: {
      sync_queue: STORE_OUTBOX,
      attachments_queue: STORE_ATTACHMENTS_QUEUE,
      documents_store: STORE_DOCUMENTS,

      sys_meta: STORE_SYS_META,
      backup_events: STORE_BACKUP_EVENTS,
      db_backups: STORE_DB_BACKUPS,

      exames_master: STORE_EXAMES_MASTER,
      servicos_master: STORE_SERVICOS_MASTER,
      produtos_master: STORE_PRODUTOS_MASTER,
      produtos_lotes: STORE_PRODUTOS_LOTES,
      clientes_master: STORE_CLIENTES_MASTER,
      fornecedores_master: STORE_FORNECEDORES_MASTER,
      animais_master: STORE_ANIMAIS_MASTER,

      animais_racas: STORE_ANIMAIS_RACAS,
      animais_pelagens: STORE_ANIMAIS_PELAGENS,
      animais_especies: STORE_ANIMAIS_ESPECIES,

      atendimentos_master: STORE_ATENDIMENTOS_MASTER,
      animal_vitals_history: STORE_ANIMAL_VITALS_HISTORY,
      animal_vaccines: STORE_ANIMAL_VACCINES,

      contas_pagar: STORE_CONTAS_PAGAR,
      contas_receber: STORE_CONTAS_RECEBER,

      // Configurações (date-effective)
      config_params: STORE_CONFIG_PARAMS,
      config_audit_log: STORE_CONFIG_AUDIT,

      // RBAC enterprise
      auth_users: STORE_AUTH_USERS,
      auth_roles: STORE_AUTH_ROLES,
      auth_role_permissions: STORE_AUTH_ROLE_PERMS,
      auth_sessions: STORE_AUTH_SESSIONS,
      auth_audit_log: STORE_AUTH_AUDIT,
      ux_audit_log: STORE_UX_AUDIT,

      // Reprodução Equina (v26)
      repro_cases:     STORE_REPRO_CASES,
      repro_exams:     STORE_REPRO_EXAMS,
      repro_protocols: STORE_REPRO_PROTOCOLS,
      repro_events:    STORE_REPRO_EVENTS,
      repro_pregnancy: STORE_REPRO_PREGNANCY,
      repro_foaling:   STORE_REPRO_FOALING,
      repro_tasks:     STORE_REPRO_TASKS,

      // Subscription/Billing (v30)
      tenant_subscription: STORE_TENANT_SUBSCRIPTION,
      billing_events: STORE_BILLING_EVENTS,

      // Empresa cadastral/fiscal (v36)
      empresa: STORE_EMPRESA
    }
  };

  // Self-test determinístico
  window.VSC_DB.selfTest = async function(){
    const out = {
      name: DB_NAME,
      version_expected: DB_VERSION,
      hasCryptoUUID: false,
      stores: null,
      error: null
    };
    try{
      out.hasCryptoUUID = !!(crypto && typeof crypto.randomUUID === "function");
      const db = await openDB();
      try{
        out.version_actual = db.version;
        out.stores = Array.from(db.objectStoreNames);
      } finally {
        try{ db.close(); }catch(_){}
      }
    }catch(e){
      out.error = String(e && (e.message||e));
    }
    return out;
  };


  

// ============================================================
// ESOS 5.3 — DB READY REAL (Promise + evento)
// Regra: READY só dispara após openDB() bem-sucedido (anti-falso-ready).
// ============================================================
(async () => {
  try{
    // Abre e fecha 1x para garantir que o schema está acessível agora.
    const db = await openDB();
    try{ db && db.close && db.close(); }catch(_){}
    try{ await registerServiceWorkerOnce(); }catch(_){ }

    window.__VSC_DB_READY__ = true;              // compat legado (boolean)
    window.__VSC_DB_READY_FIRED = true;          // flag canônica
    if(typeof window.__VSC_DB_READY_RESOLVE === "function"){
      try{ window.__VSC_DB_READY_RESOLVE(true); }catch(_){}
    }
    try{ window.dispatchEvent(new Event("VSC_DB_READY")); }catch(_){}
    console.log("[VSC_DB] ready", { name: DB_NAME, version: DB_VERSION });
  }catch(e){
    // Não marcamos READY. Consumidores devem fail-closed e orientar Clear site data.
    try{ window.__VSC_DB_READY_FIRED = false; }catch(_){}
    console.error("[VSC_DB] openDB falhou (READY não disparado):", e);
  }
})();
})();
