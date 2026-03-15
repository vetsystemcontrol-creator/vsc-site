const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const STORE_NAME_MAP = Object.freeze({
  produtos: 'produtos_master',
  produtos_master: 'produtos_master',
  produtos_lotes: 'produtos_lotes',
  servicos: 'servicos_master',
  servicos_master: 'servicos_master',
  exames: 'exames_master',
  exames_master: 'exames_master',
  clientes: 'clientes_master',
  clientes_master: 'clientes_master',
  animais: 'animais_master',
  animais_master: 'animais_master',
  atendimentos: 'atendimentos_master',
  atendimentos_master: 'atendimentos_master',
  contas_pagar: 'contas_pagar',
  contas_receber: 'contas_receber',
  fornecedores: 'fornecedores_master',
  fornecedores_master: 'fornecedores_master',
  fechamentos: 'fechamentos',
  repro_cases: 'repro_cases',
  repro_exams: 'repro_exams',
  repro_protocols: 'repro_protocols',
  repro_events: 'repro_events',
  repro_pregnancy: 'repro_pregnancy',
  repro_foaling: 'repro_foaling',
  repro_tasks: 'repro_tasks',
  config_params: 'config_params',
  config_audit_log: 'config_audit_log',
  auth_users: 'auth_users',
  auth_roles: 'auth_roles',
  auth_role_permissions: 'auth_role_permissions',
  auth_sessions: 'auth_sessions',
  auth_audit_log: 'auth_audit_log',
  user_profiles: 'user_profiles',
  business_audit_log: 'business_audit_log',
  ux_audit_log: 'ux_audit_log',
  estoque_movimentos: 'estoque_movimentos',
  estoque_saldos: 'estoque_saldos',
  import_ledger: 'import_ledger',
  estoque_reasons: 'estoque_reasons',
  tenant_subscription: 'tenant_subscription',
  billing_events: 'billing_events',
  animais_racas: 'animais_racas',
  animais_pelagens: 'animais_pelagens',
  animais_especies: 'animais_especies',
  animal_vitals_history: 'animal_vitals_history',
  animal_vaccines: 'animal_vaccines',
  documentos: 'documents',
  documents: 'documents',
  empresa: 'empresa',
});

const SNAPSHOT_IMPORT_EXCLUDED_STORES = new Set([
  'auth_users',
  'auth_roles',
  'auth_role_permissions',
  'auth_sessions',
  'auth_audit_log',
  'backup_events',
  'db_backups',
  'attachments_queue',
]);

const SNAPSHOT_IMPORT_ALLOWED_STORES = Array.from(new Set(Object.values(STORE_NAME_MAP)))
  .filter((store) => !SNAPSHOT_IMPORT_EXCLUDED_STORES.has(store));


function normalizeRequestedStoreToken(rawStore) {
  const token = normStr(rawStore, 120).toLowerCase();
  if (!token) return '';
  return STORE_NAME_MAP[token] || '';
}

function parseRequestedStoreNames(rawValues) {
  const values = Array.isArray(rawValues) ? rawValues : [rawValues];
  const out = [];
  const seen = new Set();

  for (const raw of values) {
    if (raw == null) continue;
    const parts = Array.isArray(raw) ? raw : String(raw).split(',');
    for (const part of parts) {
      const normalized = normalizeRequestedStoreToken(part);
      if (!normalized) continue;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }
  }

  return out;
}

function inspectRequestedStoreScope(rawValues) {
  const values = Array.isArray(rawValues) ? rawValues : [rawValues];
  const rawTokens = [];
  const requestedStores = [];
  const seenStores = new Set();
  const invalidTokens = [];
  let scopeRequested = false;

  for (const raw of values) {
    if (raw == null) continue;
    scopeRequested = true;
    const parts = Array.isArray(raw) ? raw : String(raw).split(',');
    for (const part of parts) {
      const token = normStr(part, 120);
      if (!token) continue;
      rawTokens.push(token);
      const normalized = normalizeRequestedStoreToken(token);
      if (!normalized) {
        invalidTokens.push(token);
        continue;
      }
      if (seenStores.has(normalized)) continue;
      seenStores.add(normalized);
      requestedStores.push(normalized);
    }
  }

  if (scopeRequested && rawTokens.length === 0) {
    invalidTokens.push('');
  }

  return {
    scopeRequested,
    rawTokens,
    requestedStores,
    invalidTokens,
    hasInvalidScope: invalidTokens.length > 0,
  };
}


function corsHeaders(request, methods = 'GET, POST, PUT, PATCH, DELETE, OPTIONS') {
  const origin = String(request?.headers?.get('Origin') || '').trim();
  const allowed = /^https:\/\/app\.vetsystemcontrol\.com\.br$/i.test(origin) || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin);
  const headers = {
    'Access-Control-Allow-Origin': allowed && origin ? origin : 'https://app.vetsystemcontrol.com.br',
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, If-None-Match, If-Match, Origin, X-Requested-With, X-VSC-Tenant, X-VSC-User, X-VSC-Token, X-VSC-Client-Session',
    'Access-Control-Expose-Headers': 'Content-Type, Content-Length, ETag, X-VSC-State-Revision',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
  };
  if (allowed && origin) headers['Access-Control-Allow-Credentials'] = 'true';
  return headers;
}

function json(data, status = 200, request = null, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(request), ...extraHeaders },
  });
}

function isD1Like(db) {
  return !!(db && typeof db.prepare === 'function' && typeof db.exec === 'function');
}

function getDB(env) {
  const db = env?.DB || env?.D1 || env?.VSC_DB || null;
  return isD1Like(db) ? db : null;
}

function normalizeTenant(raw) {
  const value = String(raw || 'tenant-default')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 120);
  return value || 'tenant-default';
}

function getTenant(request) {
  let raw = '';
  try { raw = request?.headers?.get('X-VSC-Tenant') || ''; } catch (_) {}
  if (!raw) {
    try { raw = new URL(request.url).searchParams.get('tenant') || ''; } catch (_) {}
  }
  return normalizeTenant(raw || 'tenant-default');
}

function getUserLabel(request) {
  const raw = request.headers.get('X-VSC-User') || 'anonymous';
  return String(raw).trim().slice(0, 120) || 'anonymous';
}

function normStr(v, max = 200) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

function normNum(v, fb = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

function nowIso() {
  return new Date().toISOString();
}

function resolveStoreName(rawStore, rawEntity) {
  const raw = normStr(rawStore || rawEntity || 'UNKNOWN', 120).toLowerCase();
  return STORE_NAME_MAP[raw] || raw || 'UNKNOWN';
}

function normalizeOperation(op = {}) {
  const actionRaw = normStr(op.action || op.op || 'upsert', 40).toLowerCase() || 'upsert';
  const action = ({ create: 'upsert', insert: 'upsert', update: 'upsert', put: 'upsert', upsert: 'upsert', delete: 'delete', remove: 'delete' }[actionRaw] || actionRaw || 'upsert');
  const entity = normStr(op.entity || op.store || op.store_name || 'UNKNOWN', 120) || 'UNKNOWN';
  const storeName = resolveStoreName(op.store || op.store_name, entity);
  const payloadObj = op.payload && typeof op.payload === 'object' && !Array.isArray(op.payload) ? op.payload : null;
  const entityId = normStr(op.entity_id || op.record_id || op.target_id || op.ref_id || op.id || payloadObj?.id || payloadObj?.produto_id || payloadObj?.uuid || payloadObj?.key || '', 160);
  const opId = normStr(op.op_id || op.id || '', 160);
  const deviceId = normStr(op.device_id || '', 160);
  const baseRevision = normNum(op.base_revision, 0);
  const entityRevision = Math.max(1, normNum(op.entity_revision, baseRevision + 1));
  const dedupeKey = normStr(op.dedupe_key || [storeName, entityId, action, String(baseRevision), String(entityRevision)].join(':'), 300);
  const payload = op.payload ?? null;
  const createdAt = normStr(op.created_at || op.updated_at || nowIso(), 40) || nowIso();
  const status = normStr(op.status || 'PENDING', 40) || 'PENDING';
  return {
    op_id: opId,
    entity,
    store_name: storeName,
    entity_id: entityId,
    action,
    payload,
    created_at: createdAt,
    status,
    device_id: deviceId,
    base_revision: baseRevision,
    entity_revision: entityRevision,
    dedupe_key: dedupeKey,
  };
}

async function ensureSchema(db) {
  if (!isD1Like(db)) throw new Error('invalid_d1_binding');
  const stmts = [
    "CREATE TABLE IF NOT EXISTS sync_operations (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL, op_id TEXT NOT NULL, dedupe_key TEXT NOT NULL, entity TEXT NOT NULL, store_name TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL, payload_json TEXT, device_id TEXT, user_label TEXT, created_at_client TEXT, received_at TEXT NOT NULL, base_revision INTEGER NOT NULL DEFAULT 0, entity_revision INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'ACKED')",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_operations_tenant_op_id ON sync_operations (tenant, op_id)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_operations_tenant_dedupe_key ON sync_operations (tenant, dedupe_key)",
    "CREATE INDEX IF NOT EXISTS idx_sync_operations_tenant_store ON sync_operations (tenant, store_name, entity_id)",
    "CREATE INDEX IF NOT EXISTS idx_sync_operations_received_at ON sync_operations (received_at)",
    "CREATE TABLE IF NOT EXISTS canonical_records (tenant TEXT NOT NULL, store_name TEXT NOT NULL, record_id TEXT NOT NULL, payload_json TEXT, deleted INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, updated_at TEXT NOT NULL, source_op_id TEXT, device_id TEXT, entity_revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (tenant, store_name, record_id))",
    "CREATE INDEX IF NOT EXISTS idx_canonical_records_tenant_store ON canonical_records (tenant, store_name, updated_at)",
    "CREATE TABLE IF NOT EXISTS canonical_state_meta (tenant TEXT PRIMARY KEY, state_revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, last_op_id TEXT, last_store_name TEXT, last_record_id TEXT)",
  ];
  for (const sql of stmts) {
    try { await db.prepare(sql).run(); } catch (e) {
      if (!String(e?.message || e).includes('already exists')) throw e;
    }
  }
}

async function findDuplicate(db, tenant, op) {
  let row = null;
  if (op.op_id) {
    row = await db.prepare(`SELECT id, op_id, dedupe_key, received_at FROM sync_operations WHERE tenant = ?1 AND op_id = ?2 LIMIT 1`)
      .bind(tenant, op.op_id).first();
  }
  if (!row && op.dedupe_key) {
    row = await db.prepare(`SELECT id, op_id, dedupe_key, received_at FROM sync_operations WHERE tenant = ?1 AND dedupe_key = ?2 LIMIT 1`)
      .bind(tenant, op.dedupe_key).first();
  }
  return row || null;
}

function clonePayloadRecord(op) {
  const base = (op.payload && typeof op.payload === 'object' && !Array.isArray(op.payload))
    ? JSON.parse(JSON.stringify(op.payload))
    : { value: op.payload };
  const updatedAt = base.updated_at || base.updatedAt || op.created_at || nowIso();
  if (op.store_name === 'produtos_master' && !base.produto_id) {
    base.produto_id = op.entity_id;
  }
  if (!base.id && !base.produto_id && !base.key) {
    base.id = op.entity_id;
  }
  base.updated_at = updatedAt;
  base.sync_rev = op.entity_revision;
  base.entity_revision = op.entity_revision;
  base.base_revision = op.base_revision;
  base.last_synced_op_id = op.op_id;
  return base;
}

function parseIsoMs(value) {
  const ts = Date.parse(String(value || ''));
  return Number.isFinite(ts) ? ts : null;
}

function compareCanonicalVersions(currentRow, incoming) {
  const currentRevision = normNum(currentRow?.entity_revision || currentRow?.sync_rev || 0, 0);
  const incomingRevision = normNum(incoming?.entity_revision || incoming?.sync_rev || 0, 0);
  if (incomingRevision !== currentRevision) return incomingRevision > currentRevision ? 1 : -1;

  const currentMs = parseIsoMs(currentRow?.updated_at);
  const incomingMs = parseIsoMs(incoming?.updated_at);
  if (incomingMs != null && currentMs != null && incomingMs !== currentMs) return incomingMs > currentMs ? 1 : -1;
  if (incomingMs != null && currentMs == null) return 1;
  if (incomingMs == null && currentMs != null) return -1;
  return 0;
}

async function loadCanonicalRecordMeta(db, tenant, storeName, recordId) {
  return await db.prepare(`
    SELECT tenant, store_name, record_id, deleted, updated_at, entity_revision, source_op_id
    FROM canonical_records
    WHERE tenant = ?1 AND store_name = ?2 AND record_id = ?3
    LIMIT 1
  `).bind(tenant, storeName, recordId).first();
}

async function validateIncomingOperation(db, tenant, op) {
  const current = await loadCanonicalRecordMeta(db, tenant, op.store_name, op.entity_id);
  const currentRevision = normNum(current?.entity_revision || 0, 0);
  const expectedBaseRevision = current ? currentRevision : 0;

  if (normNum(op.base_revision, 0) !== expectedBaseRevision) {
    return {
      ok: false,
      code: 'conflict_base_revision',
      current_revision: currentRevision,
      expected_base_revision: expectedBaseRevision,
      deleted: current ? Number(current.deleted || 0) === 1 : false,
    };
  }

  const cmp = compareCanonicalVersions(current, op);
  if (current && cmp < 0) {
    return {
      ok: false,
      code: 'conflict_stale_entity_revision',
      current_revision: currentRevision,
      incoming_revision: normNum(op.entity_revision, 0),
      deleted: Number(current.deleted || 0) === 1,
    };
  }

  return {
    ok: true,
    current,
    current_revision: currentRevision,
  };
}

async function applyOperationToCanonical(db, tenant, op) {
  const receivedAt = nowIso();
  const payloadRecord = clonePayloadRecord(op);
  if (String(op.action).toLowerCase() === 'delete') {
    await db.prepare(`
      INSERT INTO canonical_records (
        tenant, store_name, record_id, payload_json, deleted, deleted_at, updated_at,
        source_op_id, device_id, entity_revision
      ) VALUES (?1, ?2, ?3, NULL, 1, ?4, ?4, ?5, ?6, ?7)
      ON CONFLICT(tenant, store_name, record_id) DO UPDATE SET
        payload_json = NULL,
        deleted = 1,
        deleted_at = excluded.deleted_at,
        updated_at = excluded.updated_at,
        source_op_id = excluded.source_op_id,
        device_id = excluded.device_id,
        entity_revision = excluded.entity_revision
    `).bind(
      tenant,
      op.store_name,
      op.entity_id,
      receivedAt,
      op.op_id,
      op.device_id,
      op.entity_revision,
    ).run();
  } else {
    await db.prepare(`
      INSERT INTO canonical_records (
        tenant, store_name, record_id, payload_json, deleted, deleted_at, updated_at,
        source_op_id, device_id, entity_revision
      ) VALUES (?1, ?2, ?3, ?4, 0, NULL, ?5, ?6, ?7, ?8)
      ON CONFLICT(tenant, store_name, record_id) DO UPDATE SET
        payload_json = excluded.payload_json,
        deleted = 0,
        deleted_at = NULL,
        updated_at = excluded.updated_at,
        source_op_id = excluded.source_op_id,
        device_id = excluded.device_id,
        entity_revision = excluded.entity_revision
    `).bind(
      tenant,
      op.store_name,
      op.entity_id,
      JSON.stringify(payloadRecord),
      payloadRecord.updated_at || receivedAt,
      op.op_id,
      op.device_id,
      op.entity_revision,
    ).run();
  }

  await db.prepare(`
    INSERT INTO canonical_state_meta (tenant, state_revision, updated_at, last_op_id, last_store_name, last_record_id)
    VALUES (?1, 1, ?2, ?3, ?4, ?5)
    ON CONFLICT(tenant) DO UPDATE SET
      state_revision = canonical_state_meta.state_revision + 1,
      updated_at = excluded.updated_at,
      last_op_id = excluded.last_op_id,
      last_store_name = excluded.last_store_name,
      last_record_id = excluded.last_record_id
  `).bind(tenant, receivedAt, op.op_id, op.store_name, op.entity_id).run();

  const meta = await db.prepare(`
    SELECT tenant, state_revision, updated_at, last_op_id, last_store_name, last_record_id
    FROM canonical_state_meta
    WHERE tenant = ?1
    LIMIT 1
  `).bind(tenant).first();

  return {
    ok: true,
    state_revision: Number(meta?.state_revision || 0) || 0,
    updated_at: meta?.updated_at || receivedAt,
  };
}


async function verifyCanonicalWrite(db, tenant, op) {
  const row = await db.prepare(`
    SELECT record_id, deleted, source_op_id, entity_revision
    FROM canonical_records
    WHERE tenant = ?1 AND store_name = ?2 AND record_id = ?3
    LIMIT 1
  `).bind(tenant, op.store_name, op.entity_id).first();

  if (String(op.action).toLowerCase() === 'delete') {
    if (!row || Number(row.deleted || 0) !== 1) {
      throw new Error('canonical_delete_verification_failed');
    }
    return row;
  }

  if (!row || Number(row.deleted || 0) === 1) {
    throw new Error('canonical_upsert_verification_failed');
  }
  return row;
}

async function ingestOperation(db, tenant, userLabel, rawOp) {
  const op = normalizeOperation(rawOp);
  if (!op.op_id) {
    return { ok: false, code: 'missing_op_id', operation: op };
  }
  if (!op.entity_id) {
    return { ok: false, code: 'missing_entity_id', operation: op };
  }
  if (!op.store_name || op.store_name === 'UNKNOWN') {
    return { ok: false, code: 'missing_store_name', operation: op };
  }

  const existing = await findDuplicate(db, tenant, op);
  if (existing) {
    return {
      ok: true,
      duplicate: true,
      ack_id: op.op_id,
      dedupe_key: op.dedupe_key,
      received_at: existing.received_at,
      state_revision: null,
      store_name: op.store_name,
    };
  }

  const validation = await validateIncomingOperation(db, tenant, op);
  if (!validation.ok) {
    return {
      ok: false,
      code: validation.code,
      operation: op,
      current_revision: validation.current_revision,
      expected_base_revision: validation.expected_base_revision,
    };
  }

  const receivedAt = nowIso();
  const payloadJson = JSON.stringify(op.payload ?? null);
  await db.prepare(`
    INSERT INTO sync_operations (
      tenant, op_id, dedupe_key, entity, store_name, entity_id, action, payload_json,
      device_id, user_label, created_at_client, received_at,
      base_revision, entity_revision, status
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'ACKED')
  `).bind(
    tenant,
    op.op_id,
    op.dedupe_key,
    op.entity,
    op.store_name,
    op.entity_id,
    op.action,
    payloadJson,
    op.device_id,
    userLabel,
    op.created_at,
    receivedAt,
    op.base_revision,
    op.entity_revision,
  ).run();

  const apply = await applyOperationToCanonical(db, tenant, op);
  await verifyCanonicalWrite(db, tenant, op);

  return {
    ok: true,
    duplicate: false,
    ack_id: op.op_id,
    dedupe_key: op.dedupe_key,
    received_at: receivedAt,
    state_revision: apply.state_revision,
    store_name: op.store_name,
  };
}

async function loadCanonicalSnapshot(db, tenant, options = {}) {
  await ensureSchema(db);
  const requestedStores = parseRequestedStoreNames(options?.storeNames || []);
  const hasRequestedScope = requestedStores.length > 0;
  const rowsStmt = hasRequestedScope
    ? db.prepare(`
        SELECT store_name, record_id, payload_json, deleted, deleted_at, updated_at, entity_revision, source_op_id
        FROM canonical_records
        WHERE tenant = ?1 AND store_name IN (${requestedStores.map((_, idx) => `?${idx + 2}`).join(', ')})
        ORDER BY store_name, updated_at, record_id
      `).bind(tenant, ...requestedStores)
    : db.prepare(`
        SELECT store_name, record_id, payload_json, deleted, deleted_at, updated_at, entity_revision, source_op_id
        FROM canonical_records
        WHERE tenant = ?1
        ORDER BY store_name, updated_at, record_id
      `).bind(tenant);
  const rows = await rowsStmt.all();

  const metaRow = await db.prepare(`
    SELECT tenant, state_revision, updated_at, last_op_id, last_store_name, last_record_id
    FROM canonical_state_meta
    WHERE tenant = ?1
    LIMIT 1
  `).bind(tenant).first();

  const allowedStores = hasRequestedScope
    ? requestedStores.slice()
    : Array.from(new Set(Object.values(STORE_NAME_MAP)));
  const allowedStoreSet = new Set(allowedStores);

  const data = {};
  for (const storeName of allowedStores) {
    data[storeName] = [];
  }
  for (const row of (rows?.results || rows || [])) {
    const rowStoreName = String(row.store_name || '').trim();
    if (hasRequestedScope && !allowedStoreSet.has(rowStoreName)) continue;
    const storeName = rowStoreName;
    if (!storeName) continue;
    if (!data[storeName]) data[storeName] = [];

    const entityRevision = Number(row.entity_revision || 1) || 1;
    const sourceOpId = normStr(row.source_op_id || '', 160) || null;
    const updatedAt = row.updated_at || row.deleted_at || nowIso();
    const isDeleted = Number(row.deleted || 0) === 1;

    let payload = null;
    if (isDeleted) {
      payload = {
        __tombstone__: true,
        __record_id__: row.record_id,
        id: row.record_id,
        updated_at: updatedAt,
        deleted_at: row.deleted_at || updatedAt,
        sync_rev: entityRevision,
        entity_revision: entityRevision,
      };
      if (sourceOpId) payload.last_synced_op_id = sourceOpId;
      if (storeName === 'produtos_master') payload.produto_id = row.record_id;
      if (storeName === 'tenant_subscription') payload.tenant_id = row.record_id;
      if (storeName === 'estoque_reasons') payload.code = row.record_id;
    } else {
      try {
        payload = row.payload_json ? JSON.parse(row.payload_json) : null;
      } catch (_) {
        payload = null;
      }
      if (!payload || typeof payload !== 'object') continue;
      if (!payload.updated_at) payload.updated_at = updatedAt;
      if (!payload.sync_rev) payload.sync_rev = entityRevision;
      if (!payload.entity_revision) payload.entity_revision = entityRevision;
      if (!payload.__record_id__) payload.__record_id__ = row.record_id;
      if (sourceOpId && !payload.last_synced_op_id) payload.last_synced_op_id = sourceOpId;
    }

    data[storeName].push(payload);
  }

  return {
    ok: true,
    exists: !!metaRow || Object.keys(data).length > 0,
    revision: Number(metaRow?.state_revision || 0) || 0,
    meta: {
      tenant,
      state_revision: Number(metaRow?.state_revision || 0) || 0,
      updated_at: metaRow?.updated_at || null,
      last_op_id: metaRow?.last_op_id || null,
      last_store_name: metaRow?.last_store_name || null,
      last_record_id: metaRow?.last_record_id || null,
    },
    snapshot: {
      meta: {
        app: 'Vet System Control – Equine',
        db_name: 'vsc_db',
        exported_at: nowIso(),
        source: 'cloud-master',
        state_revision: Number(metaRow?.state_revision || 0) || 0,
      },
      schema: {
        db_name: 'vsc_db',
        exported_at: nowIso(),
        stores: allowedStores.slice(),
      },
      data,
    },
  };
}

function pickRecordId(storeName, row) {
  if (!row || typeof row !== 'object') return '';
  if (row.id != null && String(row.id).trim()) return String(row.id).trim().slice(0, 160);
  if (storeName === 'produtos_lotes' && row.lote_id != null && String(row.lote_id).trim()) return String(row.lote_id).trim().slice(0, 160);
  if (row.produto_id != null && String(row.produto_id).trim()) return String(row.produto_id).trim().slice(0, 160);
  if (row.uuid != null && String(row.uuid).trim()) return String(row.uuid).trim().slice(0, 160);
  if (row.key != null && String(row.key).trim()) return String(row.key).trim().slice(0, 160);
  return '';
}

function normalizeSnapshotRecord(storeName, row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const recordId = pickRecordId(storeName, row);
  if (!recordId) return null;
  const clone = JSON.parse(JSON.stringify(row));
  if (!clone.id && storeName !== 'produtos_lotes') clone.id = recordId;
  if (storeName === 'produtos_master' && !clone.produto_id) clone.produto_id = recordId;
  if (!clone.updated_at) clone.updated_at = clone.updatedAt || nowIso();
  if (!clone.sync_rev) clone.sync_rev = normNum(clone.sync_rev || clone.entity_revision || 1, 1);
  if (!clone.entity_revision) clone.entity_revision = normNum(clone.entity_revision || clone.sync_rev || 1, 1);
  return { recordId, payload: clone };
}

async function importCanonicalSnapshot(db, tenant, snapshot, options = {}) {
  await ensureSchema(db);

  if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.data !== 'object' || snapshot.data === null) {
    throw new Error('invalid_snapshot_payload');
  }

  const replace = !!options.replace;
  const source = normStr(options.source || snapshot?.meta?.source || 'snapshot-import', 120) || 'snapshot-import';
  const deviceId = normStr(options.device_id || 'snapshot-import', 160) || 'snapshot-import';
  const userLabel = normStr(options.userLabel || 'snapshot-import', 120) || 'snapshot-import';
  const importedAt = nowIso();
  const currentMeta = await db.prepare(`
    SELECT tenant, state_revision
    FROM canonical_state_meta
    WHERE tenant = ?1
    LIMIT 1
  `).bind(tenant).first();
  const currentRevision = Number(currentMeta?.state_revision || 0) || 0;

  const importedStores = [];
  let importedRows = 0;

  for (const storeName of SNAPSHOT_IMPORT_ALLOWED_STORES) {
    if (!Object.prototype.hasOwnProperty.call(snapshot.data || {}, storeName)) continue;

    const rows = Array.isArray(snapshot.data[storeName]) ? snapshot.data[storeName] : [];

    if (replace) {
      await db.prepare(`DELETE FROM canonical_records WHERE tenant = ?1 AND store_name = ?2`).bind(tenant, storeName).run();
    }

    let storeImported = 0;
    for (const row of rows) {
      const normalized = normalizeSnapshotRecord(storeName, row);
      if (!normalized) continue;

      const payload = normalized.payload;
      const entityRevision = Math.max(1, normNum(payload.entity_revision || payload.sync_rev || 1, 1));
      const sourceOpId = `${source}:${storeName}:${normalized.recordId}:${payload.updated_at || importedAt}`.slice(0, 160);
      const currentRow = await loadCanonicalRecordMeta(db, tenant, storeName, normalized.recordId);
      const cmp = compareCanonicalVersions(currentRow, {
        entity_revision: entityRevision,
        updated_at: payload.updated_at || importedAt,
      });
      if (!replace && currentRow && cmp < 0) {
        continue;
      }

      await db.prepare(`
        INSERT INTO canonical_records (
          tenant, store_name, record_id, payload_json, deleted, deleted_at, updated_at,
          source_op_id, device_id, entity_revision
        ) VALUES (?1, ?2, ?3, ?4, 0, NULL, ?5, ?6, ?7, ?8)
        ON CONFLICT(tenant, store_name, record_id) DO UPDATE SET
          payload_json = excluded.payload_json,
          deleted = 0,
          deleted_at = NULL,
          updated_at = excluded.updated_at,
          source_op_id = excluded.source_op_id,
          device_id = excluded.device_id,
          entity_revision = excluded.entity_revision
      `).bind(
        tenant,
        storeName,
        normalized.recordId,
        JSON.stringify(payload),
        payload.updated_at || importedAt,
        sourceOpId,
        deviceId,
        entityRevision,
      ).run();

      await db.prepare(`
        INSERT OR IGNORE INTO sync_operations (
          tenant, op_id, dedupe_key, entity, store_name, entity_id, action, payload_json,
          device_id, user_label, created_at_client, received_at,
          base_revision, entity_revision, status
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'SNAPSHOT_IMPORT', ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'ACKED')
      `).bind(
        tenant,
        sourceOpId,
        `${source}:${storeName}:${normalized.recordId}`.slice(0, 300),
        storeName,
        storeName,
        normalized.recordId,
        JSON.stringify(payload),
        deviceId,
        userLabel,
        payload.updated_at || importedAt,
        importedAt,
        currentRevision,
        entityRevision,
      ).run();

      storeImported += 1;
      importedRows += 1;
    }

    if (storeImported > 0 || replace) importedStores.push(storeName);
  }

  const nextRevision = Math.max(currentRevision + 1, importedRows > 0 ? 1 : currentRevision);
  await db.prepare(`
    INSERT INTO canonical_state_meta (tenant, state_revision, updated_at, last_op_id, last_store_name, last_record_id)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    ON CONFLICT(tenant) DO UPDATE SET
      state_revision = excluded.state_revision,
      updated_at = excluded.updated_at,
      last_op_id = excluded.last_op_id,
      last_store_name = excluded.last_store_name,
      last_record_id = excluded.last_record_id
  `).bind(
    tenant,
    nextRevision,
    importedAt,
    `${source}:snapshot`.slice(0, 160),
    importedStores[importedStores.length - 1] || null,
    null,
  ).run();

  return {
    ok: true,
    imported_rows: importedRows,
    imported_stores: importedStores,
    state_revision: nextRevision,
    replace,
    source,
    imported_at: importedAt,
  };
}

function getSyncSecret(env) {
  return normStr(env?.VSC_SYNC_SECRET || env?.SYNC_SECRET || '', 512);
}

function getRequestToken(request) {
  const bearer = normStr(request?.headers?.get('Authorization') || request?.headers?.get('authorization') || '', 1024);
  const bearerToken = /^Bearer\s+(.+)$/i.test(bearer) ? bearer.replace(/^Bearer\s+/i, '').trim() : '';
  return normStr(
    bearerToken || request?.headers?.get('X-VSC-Token') || request?.headers?.get('x-vsc-token') || '',
    512
  );
}

function getClientSessionId(request) {
  return normStr(
    request?.headers?.get('X-VSC-Client-Session') ||
    request?.headers?.get('x-vsc-client-session') ||
    '',
    160
  );
}

async function findActiveSessionAuth(db, sessionId) {
  if (!isD1Like(db) || !sessionId) return null;
  try {
    const row = await db.prepare(`
      SELECT
        s.id,
        s.user_id,
        s.status AS session_status,
        s.expires_at,
        u.status AS user_status
      FROM auth_sessions s
      LEFT JOIN auth_users u ON u.id = s.user_id
      WHERE s.id = ?1
      LIMIT 1
    `).bind(sessionId).first();

    if (!row) return null;
    const sessionStatus = normStr(row.session_status || row.status || 'INACTIVE', 40).toUpperCase();
    if (sessionStatus !== 'ACTIVE') return null;

    const userStatus = normStr(row.user_status || 'ACTIVE', 40).toUpperCase();
    if (row.user_id && userStatus !== 'ACTIVE') return null;

    const expiresAt = normStr(row.expires_at || '', 64);
    if (expiresAt) {
      const expiresMs = Date.parse(expiresAt);
      if (Number.isFinite(expiresMs) && Date.now() > expiresMs) return null;
    }

    return row;
  } catch (_) {
    return null;
  }
}

async function isSyncAuthorized(request, env) {
  const secret = getSyncSecret(env);
  const token = getRequestToken(request);
  if (secret && token && token === secret) {
    return { ok: true, enforced: true, mode: 'token' };
  }

  const db = getDB(env);
  const clientSessionId = getClientSessionId(request);
  if (clientSessionId && db) {
    const session = await findActiveSessionAuth(db, clientSessionId);
    if (session) {
      return { ok: true, enforced: true, mode: 'session', session_id: clientSessionId, user_id: session.user_id || null };
    }
  }

  if (!secret) {
    // Dev/local fallback when no secret is configured in the environment.
    return { ok: true, enforced: false, mode: 'open' };
  }

  return { ok: false, enforced: true, error: 'unauthorized' };
}

function buildUnauthorizedResponse(request) {
  return json({ ok: false, error: 'unauthorized' }, 401, request);
}

export {
  JSON_HEADERS,
  json,
  corsHeaders,
  isD1Like,
  getDB,
  getTenant,
  getUserLabel,
  ensureSchema,
  ingestOperation,
  loadCanonicalSnapshot,
  importCanonicalSnapshot,
  parseRequestedStoreNames,
  inspectRequestedStoreScope,
  getSyncSecret,
  getRequestToken,
  getClientSessionId,
  findActiveSessionAuth,
  isSyncAuthorized,
  buildUnauthorizedResponse,
  normalizeTenant,
};
