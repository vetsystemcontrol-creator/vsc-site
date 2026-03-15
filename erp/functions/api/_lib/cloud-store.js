function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/app\.vetsystemcontrol\.com\.br$/i,
  /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i,
];

const ACCESS_CONTROL_ALLOW_HEADERS = [
  'Content-Type',
  'Accept',
  'Authorization',
  'If-None-Match',
  'If-Match',
  'Origin',
  'X-Requested-With',
  'X-VSC-Tenant',
  'X-VSC-User',
  'X-VSC-Token',
  'X-VSC-Client-Session',
].join(', ');

const ACCESS_CONTROL_ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const ACCESS_CONTROL_EXPOSE_HEADERS = 'Content-Type, Content-Length, ETag, X-VSC-State-Revision';
const DEFAULT_VARY = 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers';

function resolveCorsConfig(request) {
  const origin = String(request?.headers?.get('Origin') || '').trim();
  if (!origin) {
    return { allowOrigin: 'https://app.vetsystemcontrol.com.br', allowCredentials: false };
  }
  if (ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin))) {
    return { allowOrigin: origin, allowCredentials: true };
  }
  return { allowOrigin: 'https://app.vetsystemcontrol.com.br', allowCredentials: false };
}

export function corsHeaders(request, methods = ACCESS_CONTROL_ALLOW_METHODS) {
  const { allowOrigin, allowCredentials } = resolveCorsConfig(request);
  const headers = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': ACCESS_CONTROL_ALLOW_HEADERS,
    'Access-Control-Expose-Headers': ACCESS_CONTROL_EXPOSE_HEADERS,
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    Vary: DEFAULT_VARY,
  };
  if (allowCredentials) {
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}

async function sha256HexFromString(str) {
  const bytes = new TextEncoder().encode(String(str || ''));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function normalizeTenant(raw) {
  const v = String(raw || 'tenant-default').trim().toLowerCase();
  return v.replace(/[^a-z0-9._:-]+/g, '-').slice(0, 180) || 'tenant-default';
}

export function isD1Like(db) {
  return !!(db && typeof db.prepare === 'function' && typeof db.exec === 'function');
}

function getBinding(env) {
  if (!env) return null;
  const db = env.DB || env.D1 || env.VSC_DB || null;
  return isD1Like(db) ? db : null;
}

async function ensureD1Schema(db) {
  const stmts = [
    'CREATE TABLE IF NOT EXISTS vsc_state_snapshots (tenant TEXT PRIMARY KEY, revision TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, saved_at TEXT NOT NULL, exported_at TEXT, source TEXT, snapshot_json TEXT NOT NULL)',
    'CREATE INDEX IF NOT EXISTS idx_vsc_state_saved_at ON vsc_state_snapshots(saved_at)',
  ];

  for (const sql of stmts) {
    try {
      await db.prepare(sql).run();
    } catch (e) {
      if (!String(e?.message || e).includes('already exists')) throw e;
    }
  }
}

export async function getCapabilities(env) {
  return {
    ok: true,
    available: true,
    local_static_mode: false,
    remote_sync_allowed: !!(
      getBinding(env) ||
      env?.VSC_STATE_BUCKET ||
      env?.STATE_BUCKET ||
      env?.R2
    ),
    storage_mode: getBinding(env)
      ? 'd1'
      : (env?.VSC_STATE_BUCKET || env?.STATE_BUCKET || env?.R2)
      ? 'object-store'
      : 'none',
  };
}

export async function saveSnapshot(env, tenant, snapshot, meta = {}) {
  const normTenant = normalizeTenant(tenant);
  const savedAt = new Date().toISOString();
  const exportedAt = snapshot?.meta?.exported_at || meta.exported_at || savedAt;
  const snapshotJson = JSON.stringify(snapshot || {});
  const sha256 = await sha256HexFromString(snapshotJson);
  const bytes = new TextEncoder().encode(snapshotJson).length;
  const revision = meta.revision || `${savedAt.replace(/[-:.TZ]/g, '')}-${sha256.slice(0, 12)}`;
  const source = String(meta.source || 'manual-sync').slice(0, 120);
  const db = getBinding(env);

  if (db) {
    await ensureD1Schema(db);
    await db
      .prepare(`
        INSERT INTO vsc_state_snapshots
          (tenant, revision, sha256, bytes, saved_at, exported_at, source, snapshot_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant) DO UPDATE SET
          revision=excluded.revision,
          sha256=excluded.sha256,
          bytes=excluded.bytes,
          saved_at=excluded.saved_at,
          exported_at=excluded.exported_at,
          source=excluded.source,
          snapshot_json=excluded.snapshot_json
      `)
      .bind(normTenant, revision, sha256, bytes, savedAt, exportedAt, source, snapshotJson)
      .run();

    return {
      ok: true,
      exists: true,
      meta: {
        tenant: normTenant,
        revision,
        sha256,
        bytes,
        saved_at: savedAt,
        exported_at: exportedAt,
        source,
      },
    };
  }

  const bucket = env?.VSC_STATE_BUCKET || env?.STATE_BUCKET || env?.R2 || null;
  if (bucket && typeof bucket.put === 'function') {
    const key = `vsc-state/${normTenant}.json`;
    const payload = JSON.stringify({
      meta: {
        tenant: normTenant,
        revision,
        sha256,
        bytes,
        saved_at: savedAt,
        exported_at: exportedAt,
        source,
      },
      snapshot,
    });

    await bucket.put(key, payload, {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    });

    return {
      ok: true,
      exists: true,
      meta: {
        tenant: normTenant,
        revision,
        sha256,
        bytes,
        saved_at: savedAt,
        exported_at: exportedAt,
        source,
      },
    };
  }

  return { ok: false, error: 'storage_not_configured' };
}

export async function loadSnapshot(env, tenant, metaOnly = false) {
  const normTenant = normalizeTenant(tenant);
  const db = getBinding(env);

  if (db) {
    await ensureD1Schema(db);
    const row = await db
      .prepare(`
        SELECT tenant, revision, sha256, bytes, saved_at, exported_at, source, snapshot_json
        FROM vsc_state_snapshots
        WHERE tenant = ?
        LIMIT 1
      `)
      .bind(normTenant)
      .first();

    if (!row) return { ok: true, exists: false, meta: { tenant: normTenant } };

    const meta = {
      tenant: row.tenant,
      revision: row.revision,
      sha256: row.sha256,
      bytes: row.bytes,
      saved_at: row.saved_at,
      exported_at: row.exported_at,
      source: row.source,
    };

    return {
      ok: true,
      exists: true,
      meta,
      snapshot: metaOnly ? null : JSON.parse(row.snapshot_json || '{}'),
    };
  }

  const bucket = env?.VSC_STATE_BUCKET || env?.STATE_BUCKET || env?.R2 || null;
  if (bucket && typeof bucket.get === 'function') {
    const obj = await bucket.get(`vsc-state/${normTenant}.json`);
    if (!obj) return { ok: true, exists: false, meta: { tenant: normTenant } };

    const text = await obj.text();
    const payload = JSON.parse(text || '{}');

    return {
      ok: true,
      exists: !!payload?.meta,
      meta: payload?.meta || { tenant: normTenant },
      snapshot: metaOnly ? null : payload?.snapshot || null,
    };
  }

  return { ok: false, error: 'storage_not_configured', meta: { tenant: normTenant } };
}

export function buildJsonResponse(request, body, status = 200, extraHeaders = {}, methods = ACCESS_CONTROL_ALLOW_METHODS) {
  return json(body, status, {
    ...corsHeaders(request, methods),
    ...extraHeaders,
    'cache-control': 'no-store',
  });
}

export function buildOptionsResponse(request, methods = ACCESS_CONTROL_ALLOW_METHODS) {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(request, methods),
      'cache-control': 'no-store',
    },
  });
}

export function buildSnapshotMetaHeaders(meta = {}) {
  const headers = {};
  if (meta?.sha256) {
    headers.ETag = `"${String(meta.sha256)}"`;
  } else if (meta?.revision != null && meta?.revision !== '') {
    headers.ETag = `W/"vsc-state-${String(meta.revision)}"`;
  }
  if (meta?.revision != null && meta?.revision !== '') {
    headers['X-VSC-State-Revision'] = String(meta.revision);
  }
  return headers;
}

export function matchesIfNoneMatch(request, etag) {
  const raw = String(request?.headers?.get('If-None-Match') || '').trim();
  if (!raw || !etag) return false;
  if (raw === '*') return true;
  return raw
    .split(',')
    .map((value) => value.trim())
    .includes(etag);
}
