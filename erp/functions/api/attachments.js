import {
  getDB,
  isD1Like,
  isSyncAuthorized,
  getClientSessionId,
  findActiveSessionAuth,
  getRequestToken,
} from './_lib/sync-store.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const AUDIT_PREFIX = '[attachments-api]';
const ALLOWED_METHODS = 'GET, POST, OPTIONS';
const ALLOWED_HEADERS = 'Content-Type, Accept, Authorization, X-VSC-Tenant, X-VSC-User, X-VSC-Token, X-VSC-Client-Session';
const ATTENDIMENTO_STORES = ['atendimentos_master', 'atendimentos'];

function corsHeaders(request) {
  const origin = request?.headers?.get('Origin') || '';
  if (/^https:\/\/app\.vetsystemcontrol\.com\.br$/i.test(origin)) return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  return { 'Access-Control-Allow-Origin': 'https://app.vetsystemcontrol.com.br', Vary: 'Origin' };
}

function json(data, status = 200, request = null, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...(request ? corsHeaders(request) : {}), ...extraHeaders },
  });
}

function buildOptionsResponse(request) {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(request),
      'access-control-allow-methods': ALLOWED_METHODS,
      'access-control-allow-headers': ALLOWED_HEADERS,
      'access-control-max-age': '86400',
      'cache-control': 'no-store',
    },
  });
}

function getBucket(env) {
  return env?.R2 || env?.BACKUPS_BUCKET || env?.ATTACHMENTS_BUCKET || null;
}

function normalizeTenant(raw) {
  const value = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').slice(0, 180);
  return value || 'tenant-default';
}

function effectiveDefaultTenant(env) {
  return normalizeTenant(env?.VSC_DEFAULT_TENANT || env?.DEFAULT_TENANT || 'tenant-default');
}

function readRequestedTenant(request) {
  const url = new URL(request.url);
  const headerTenant = request.headers.get('X-VSC-Tenant') || request.headers.get('X-Tenant') || '';
  const queryTenant = url.searchParams.get('tenant') || '';
  const normalizedHeader = normalizeTenant(headerTenant);
  const normalizedQuery = normalizeTenant(queryTenant);

  if (headerTenant && queryTenant && normalizedHeader !== normalizedQuery) {
    return { ok: false, error: 'tenant_mismatch' };
  }

  return {
    ok: true,
    tenant: headerTenant || queryTenant ? (normalizedHeader || normalizedQuery) : null,
  };
}

function r2Key(tenant, atendimentoId, attachmentId) {
  return `attachments/${normalizeTenant(tenant)}/${String(atendimentoId || '').trim()}/${String(attachmentId || '').trim()}`;
}

function sanitizeFileName(name, fallback = 'arquivo') {
  const clean = String(name || fallback).replace(/[\r\n"]/g, '_').trim();
  return clean || fallback;
}

function redact(value, max = 12) {
  const str = String(value || '');
  if (!str) return '';
  return str.length <= max ? str : `${str.slice(0, max)}…`;
}

function safeDeny(status = 404, request = null) {
  return json({ ok: false, error: status === 401 ? 'unauthorized' : 'not_found' }, status, request);
}

function auditLog(level, action, data = {}) {
  const payload = {
    action,
    tenant: data.tenant || '',
    atendimento_id: redact(data.atendimento_id || ''),
    attachment_id: redact(data.attachment_id || ''),
    user_id: redact(data.user_id || ''),
    session_id: redact(data.session_id || ''),
    mode: data.mode || '',
    allowed: !!data.allowed,
    reason: data.reason || '',
  };
  const line = `${AUDIT_PREFIX} ${JSON.stringify(payload)}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}

async function resolveAuthContext(request, env) {
  const auth = await isSyncAuthorized(request, env);
  if (!auth?.ok || auth.mode === 'open' || auth.enforced === false) {
    return { ok: false, response: safeDeny(401, request), reason: auth?.error || 'unauthorized' };
  }

  const db = getDB(env);
  let session = null;
  const sessionId = getClientSessionId(request);
  if (sessionId && db && isD1Like(db)) {
    session = await findActiveSessionAuth(db, sessionId);
  }

  return {
    ok: true,
    mode: auth.mode || (session ? 'session' : 'token'),
    enforced: !!auth.enforced,
    session_id: sessionId || auth.session_id || '',
    user_id: session?.user_id || auth.user_id || '',
    token_present: !!getRequestToken(request),
  };
}

async function resolveTenantContext(request, env, authContext) {
  const requested = readRequestedTenant(request);
  if (!requested.ok) {
    return { ok: false, response: safeDeny(404, request), reason: requested.error || 'tenant_mismatch' };
  }

  const defaultTenant = effectiveDefaultTenant(env);
  if (authContext.mode === 'token') {
    return { ok: true, tenant: requested.tenant || defaultTenant, source: requested.tenant ? 'request' : 'default' };
  }

  if (!requested.tenant) {
    return { ok: true, tenant: defaultTenant, source: 'default' };
  }

  if (defaultTenant && requested.tenant !== defaultTenant) {
    return { ok: false, response: safeDeny(404, request), reason: 'tenant_forbidden' };
  }

  return { ok: true, tenant: requested.tenant, source: 'request' };
}

async function lookupCanonicalAtendimento(db, tenant, atendimentoId) {
  if (!isD1Like(db) || !tenant || !atendimentoId) return null;

  for (const storeName of ATTENDIMENTO_STORES) {
    try {
      const row = await db.prepare(`
        SELECT store_name, record_id, payload_json, deleted, updated_at
        FROM canonical_records
        WHERE tenant = ?1 AND store_name = ?2 AND record_id = ?3
        LIMIT 1
      `).bind(tenant, storeName, String(atendimentoId)).first();

      if (!row) continue;
      if (Number(row.deleted) === 1) return null;

      let payload = null;
      try { payload = row.payload_json ? JSON.parse(row.payload_json) : null; } catch (_) { payload = null; }

      return {
        store_name: row.store_name || storeName,
        record_id: row.record_id || String(atendimentoId),
        updated_at: row.updated_at || null,
        payload,
      };
    } catch (_) {
      // continua tentando próximo store conhecido
    }
  }

  return null;
}

function extractAttachmentIds(record) {
  const payload = record?.payload;
  const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
  const ids = new Set();
  for (const item of attachments) {
    const id = String(item?.id || item?.attachment_id || '').trim();
    if (id) ids.add(id);
  }
  return ids;
}

async function requireAttachmentContext(request, env, { requireExistingAttachment = false } = {}) {
  const authContext = await resolveAuthContext(request, env);
  if (!authContext.ok) return authContext;

  const tenantContext = await resolveTenantContext(request, env, authContext);
  if (!tenantContext.ok) {
    auditLog('warn', 'tenant_denied', {
      tenant: readRequestedTenant(request).tenant || '',
      user_id: authContext.user_id,
      session_id: authContext.session_id,
      mode: authContext.mode,
      allowed: false,
      reason: tenantContext.reason,
    });
    return tenantContext;
  }

  const method = String(request.method || 'GET').toUpperCase();
  const url = new URL(request.url);
  const body = method === 'POST' ? await request.clone().json().catch(() => ({})) : {};
  const atendimentoId = String(body?.atendimento_id || url.searchParams.get('atendimento_id') || '').trim();
  const attachmentId = String(body?.attachment_id || url.searchParams.get('attachment_id') || '').trim();

  if (!atendimentoId || !attachmentId) {
    return { ok: false, response: json({ ok: false, error: 'atendimento_id e attachment_id são obrigatórios' }, 400, request), reason: 'missing_identifiers' };
  }

  const db = getDB(env);
  const canonical = await lookupCanonicalAtendimento(db, tenantContext.tenant, atendimentoId);
  const attachmentIds = extractAttachmentIds(canonical);
  const canonicalHasAttachment = attachmentIds.has(attachmentId);

  if (requireExistingAttachment && !canonicalHasAttachment) {
    auditLog('warn', 'attachment_denied', {
      tenant: tenantContext.tenant,
      atendimento_id: atendimentoId,
      attachment_id: attachmentId,
      user_id: authContext.user_id,
      session_id: authContext.session_id,
      mode: authContext.mode,
      allowed: false,
      reason: canonical ? 'attachment_not_linked' : 'atendimento_not_found',
    });
    return { ok: false, response: safeDeny(404, request), reason: canonical ? 'attachment_not_linked' : 'atendimento_not_found' };
  }

  return {
    ok: true,
    requestBody: body,
    auth: authContext,
    tenant: tenantContext.tenant,
    atendimento_id: atendimentoId,
    attachment_id: attachmentId,
    canonical,
    canonical_attachment_known: canonicalHasAttachment,
  };
}

async function loadAttachmentObject(bucket, tenant, atendimentoId, attachmentId) {
  const key = r2Key(tenant, atendimentoId, attachmentId);
  const obj = await bucket.get(key);
  if (!obj) return null;

  const meta = obj.customMetadata || {};
  if (normalizeTenant(meta.tenant || tenant) !== normalizeTenant(tenant)) return null;
  if (String(meta.atendimento_id || '') !== String(atendimentoId)) return null;
  if (String(meta.attachment_id || '') !== String(attachmentId)) return null;

  return { key, obj, meta };
}

async function handleUpload(request, env) {
  const bucket = getBucket(env);
  if (!bucket) return json({ ok: false, error: 'r2_not_configured' }, 501, request);

  const ctx = await requireAttachmentContext(request, env, { requireExistingAttachment: false });
  if (!ctx.ok) return ctx.response;

  const { tenant, atendimento_id, attachment_id, requestBody, auth } = ctx;
  const { filename, mime_type, data_base64, descricao, created_at } = requestBody;

  if (!data_base64) {
    return json({ ok: false, error: 'data_base64 é obrigatório' }, 400, request);
  }

  let bytes;
  try {
    const clean = String(data_base64).replace(/^data:[^;]+;base64,/, '');
    const binary = atob(clean);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch (e) {
    return json({ ok: false, error: 'base64_decode_failed', detail: String(e) }, 400, request);
  }

  const key = r2Key(tenant, atendimento_id, attachment_id);
  const meta = {
    tenant,
    atendimento_id,
    attachment_id,
    filename: sanitizeFileName(filename, attachment_id),
    mime_type: String(mime_type || 'application/octet-stream'),
    descricao: String(descricao || '').slice(0, 500),
    created_at: String(created_at || '').slice(0, 64),
    uploaded_at: new Date().toISOString(),
    bytes: String(bytes.length),
    auth_mode: auth.mode,
    auth_user_id: String(auth.user_id || '').slice(0, 120),
    auth_session_id: String(auth.session_id || '').slice(0, 120),
  };

  await bucket.put(key, bytes, {
    httpMetadata: { contentType: meta.mime_type },
    customMetadata: meta,
  });

  auditLog('info', 'upload', {
    tenant,
    atendimento_id,
    attachment_id,
    user_id: auth.user_id,
    session_id: auth.session_id,
    mode: auth.mode,
    allowed: true,
    reason: ctx.canonical ? 'canonical_match' : 'canonical_pending',
  });

  return json({ ok: true, key, bytes: bytes.length, meta }, 200, request);
}

async function handleDownload(request, env, url) {
  const bucket = getBucket(env);
  if (!bucket) return json({ ok: false, error: 'r2_not_configured' }, 501, request);

  const ctx = await requireAttachmentContext(request, env, { requireExistingAttachment: false });
  if (!ctx.ok) return ctx.response;

  const found = await loadAttachmentObject(bucket, ctx.tenant, ctx.atendimento_id, ctx.attachment_id);
  if (!found) {
    auditLog('warn', 'download_denied', {
      tenant: ctx.tenant,
      atendimento_id: ctx.atendimento_id,
      attachment_id: ctx.attachment_id,
      user_id: ctx.auth.user_id,
      session_id: ctx.auth.session_id,
      mode: ctx.auth.mode,
      allowed: false,
      reason: 'object_not_found_or_mismatch',
    });
    return safeDeny(404, request);
  }

  if (!ctx.canonical_attachment_known && !ctx.canonical) {
    auditLog('info', 'download_pending_canonical', {
      tenant: ctx.tenant,
      atendimento_id: ctx.atendimento_id,
      attachment_id: ctx.attachment_id,
      user_id: ctx.auth.user_id,
      session_id: ctx.auth.session_id,
      mode: ctx.auth.mode,
      allowed: true,
      reason: 'r2_object_metadata_match',
    });
  }

  const disposition = String(url.searchParams.get('disposition') || 'attachment').toLowerCase() === 'inline' ? 'inline' : 'attachment';
  const rawName = sanitizeFileName(found.meta.filename || ctx.attachment_id, 'arquivo');
  const headers = new Headers({
    ...corsHeaders(request),
    'content-type': found.meta.mime_type || 'application/octet-stream',
    'content-disposition': `${disposition}; filename="${rawName}"`,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  });

  auditLog('info', 'download', {
    tenant: ctx.tenant,
    atendimento_id: ctx.atendimento_id,
    attachment_id: ctx.attachment_id,
    user_id: ctx.auth.user_id,
    session_id: ctx.auth.session_id,
    mode: ctx.auth.mode,
    allowed: true,
    reason: 'authorized',
  });

  return new Response(found.obj.body, { status: 200, headers });
}

async function handleList(request, env, url) {
  const bucket = getBucket(env);
  if (!bucket) return json({ ok: false, error: 'r2_not_configured' }, 501, request);

  const authContext = await resolveAuthContext(request, env);
  if (!authContext.ok) return authContext.response;

  const tenantContext = await resolveTenantContext(request, env, authContext);
  if (!tenantContext.ok) return tenantContext.response;

  const atendimentoId = String(url.searchParams.get('atendimento_id') || '').trim();
  if (!atendimentoId) {
    return json({ ok: false, error: 'atendimento_id é obrigatório' }, 400, request);
  }

  const db = getDB(env);
  const canonical = await lookupCanonicalAtendimento(db, tenantContext.tenant, atendimentoId);
  if (!canonical) {
    auditLog('warn', 'list_denied', {
      tenant: tenantContext.tenant,
      atendimento_id: atendimentoId,
      user_id: authContext.user_id,
      session_id: authContext.session_id,
      mode: authContext.mode,
      allowed: false,
      reason: 'atendimento_not_found',
    });
    return safeDeny(404, request);
  }

  const prefix = `attachments/${tenantContext.tenant}/${atendimentoId}/`;
  const listed = await bucket.list({ prefix, limit: 1000 });
  const allowedIds = extractAttachmentIds(canonical);
  const items = (listed.objects || []).map((obj) => {
    const parts = String(obj.key || '').split('/');
    const attachmentId = parts[3] || '';
    return {
      key: obj.key,
      size: obj.size,
      uploaded_at: obj.uploaded || null,
      meta: {
        tenant: tenantContext.tenant,
        atendimento_id: atendimentoId,
        attachment_id: attachmentId,
        filename: attachmentId,
      },
    };
  }).filter((item) => allowedIds.has(String(item?.meta?.attachment_id || '')));

  auditLog('info', 'list', {
    tenant: tenantContext.tenant,
    atendimento_id: atendimentoId,
    user_id: authContext.user_id,
    session_id: authContext.session_id,
    mode: authContext.mode,
    allowed: true,
    reason: `returned_${items.length}`,
  });

  return json({ ok: true, tenant: tenantContext.tenant, atendimento_id: atendimentoId, items, total: items.length }, 200, request);
}

async function handleDelete(request, env) {
  const bucket = getBucket(env);
  if (!bucket) return json({ ok: false, error: 'r2_not_configured' }, 501, request);

  const ctx = await requireAttachmentContext(request, env, { requireExistingAttachment: false });
  if (!ctx.ok) return ctx.response;

  const found = await loadAttachmentObject(bucket, ctx.tenant, ctx.atendimento_id, ctx.attachment_id);
  if (!found) {
    auditLog('warn', 'delete_denied', {
      tenant: ctx.tenant,
      atendimento_id: ctx.atendimento_id,
      attachment_id: ctx.attachment_id,
      user_id: ctx.auth.user_id,
      session_id: ctx.auth.session_id,
      mode: ctx.auth.mode,
      allowed: false,
      reason: 'object_not_found_or_mismatch',
    });
    return safeDeny(404, request);
  }

  await bucket.delete(found.key);

  auditLog('info', 'delete', {
    tenant: ctx.tenant,
    atendimento_id: ctx.atendimento_id,
    attachment_id: ctx.attachment_id,
    user_id: ctx.auth.user_id,
    session_id: ctx.auth.session_id,
    mode: ctx.auth.mode,
    allowed: true,
    reason: 'authorized',
  });

  return json({ ok: true, key: found.key }, 200, request);
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') return buildOptionsResponse(request);

  try {
    const action = url.searchParams.get('action') || (method === 'GET' ? 'list' : 'upload');

    if (method === 'GET') {
      if (action === 'ping') return json({ ok: true, service: 'attachments', time: new Date().toISOString() }, 200, request);
      if (action === 'download') return await handleDownload(request, env, url);
      if (action === 'list') return await handleList(request, env, url);
      return json({ ok: false, error: 'unknown_action' }, 400, request);
    }

    if (method === 'POST') {
      if (action === 'upload') return await handleUpload(request, env);
      if (action === 'delete') return await handleDelete(request, env);
      return json({ ok: false, error: 'unknown_action' }, 400, request);
    }

    return json({ ok: false, error: 'method_not_allowed' }, 405, request, { allow: ALLOWED_METHODS });
  } catch (error) {
    console.error(`${AUDIT_PREFIX} fatal`, error);
    return json({ ok: false, error: 'attachments_failed', detail: String(error?.message || error) }, 500, request);
  }
}
