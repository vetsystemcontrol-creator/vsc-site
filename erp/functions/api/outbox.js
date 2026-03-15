import { json, corsHeaders, getDB, getTenant, getUserLabel, ensureSchema, ingestOperation } from './_lib/sync-store.js';

function optionsHeaders(request) {
  return {
    ...corsHeaders(request),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, X-Requested-With, X-VSC-Tenant, X-VSC-User, X-VSC-Token, X-VSC-Client-Session',
    'Access-Control-Expose-Headers': 'Content-Type, Content-Length, ETag, X-VSC-State-Revision',
    'Access-Control-Max-Age': '86400',
    'cache-control': 'no-store',
    Vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
  };
}

export async function onRequestOptions(context) {
  return new Response(null, {
    status: 204,
    headers: optionsHeaders(context.request),
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const db = getDB(env);
    if (!db) {
      return json({ ok: false, error: 'missing_d1_binding', remote_sync_allowed: false }, 501, request);
    }

    const body = await request.json().catch(() => ({}));
    const tenant = getTenant(request);
    const userLabel = getUserLabel(request);

    await ensureSchema(db);

    const result = await ingestOperation(db, tenant, userLabel, {
      store: body?.store,
      entity: body?.entity,
      entity_id: body?.entity_id,
      record_id: body?.record_id,
      action: body?.action || body?.op,
      op: body?.op,
      op_id: body?.op_id,
      payload: body?.payload,
      device_id: body?.device_id,
      base_revision: body?.base_revision,
      entity_revision: body?.entity_revision,
      dedupe_key: body?.dedupe_key,
      created_at: body?.created_at,
      status: body?.status,
    });

    if (!result.ok) {
      return json({ ok: false, error: result.code }, 400, request);
    }

    return json(
      {
        ok: true,
        ack_id: result.ack_id,
        duplicate: !!result.duplicate,
        tenant,
        store_name: result.store_name || null,
      },
      200,
      request
    );
  } catch (error) {
    return json(
      { ok: false, error: 'legacy_outbox_failed', detail: String(error?.message || error || 'unknown_error') },
      500,
      request
    );
  }
}
