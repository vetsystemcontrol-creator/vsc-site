import {
  json,
  corsHeaders,
  getDB,
  getTenant,
  getUserLabel,
  ensureSchema,
  ingestOperation,
  isSyncAuthorized,
  buildUnauthorizedResponse,
} from '../_lib/sync-store.js';

function optionsHeaders(request) {
  return {
    ...corsHeaders(request),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Accept, Authorization, If-None-Match, If-Match, Origin, X-Requested-With, X-VSC-Tenant, X-VSC-User, X-VSC-Token, X-VSC-Client-Session',
    'Access-Control-Expose-Headers': 'Content-Type, Content-Length, ETag, X-VSC-State-Revision',
    'Access-Control-Max-Age': '86400',
    'cache-control': 'no-store',
    Vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
  };
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: optionsHeaders(context.request) });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = await isSyncAuthorized(request, env);
  if (!auth.ok) return buildUnauthorizedResponse(request);

  try {
    const db = getDB(env);
    if (!db) {
      return json({ ok: false, error: 'missing_d1_binding', remote_sync_allowed: false }, 501, request);
    }

    const body = await request.json().catch(() => ({}));
    const operations = Array.isArray(body?.operations) ? body.operations : [];

    if (!operations.length) {
      return json({ ok: false, error: 'operations_required' }, 400, request);
    }

    if (operations.length > 200) {
      return json({ ok: false, error: 'batch_too_large', limit: 200 }, 413, request);
    }

    const tenant = getTenant(request);
    const userLabel = getUserLabel(request);
    await ensureSchema(db);

    const ack_ids = [];
    const duplicates = [];
    const rejected = [];
    let stateRevision = null;

    for (const rawOp of operations) {
      const result = await ingestOperation(db, tenant, userLabel, rawOp);
      if (!result.ok) {
        rejected.push({ code: result.code, op_id: result.operation?.op_id || '' });
        continue;
      }
      ack_ids.push(result.ack_id);
      if (result.duplicate) duplicates.push(result.ack_id);
      if (Number.isFinite(Number(result.state_revision))) stateRevision = Number(result.state_revision);
    }

    const ok = ack_ids.length > 0 && rejected.length === 0;
    const status = rejected.length ? 207 : 200;

    return json(
      {
        ok,
        tenant,
        received: operations.length,
        acked: ack_ids.length,
        ack_ids,
        duplicates,
        rejected,
        state_revision: stateRevision,
      },
      status,
      request
    );
  } catch (error) {
    return json(
      {
        ok: false,
        error: 'sync_push_failed',
        detail: String(error?.message || error || 'unknown_error'),
      },
      500,
      request
    );
  }
}
