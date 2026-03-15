import { corsHeaders } from './_lib/sync-store.js';

function json(body, request) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...corsHeaders(request),
    },
  });
}

export async function onRequestOptions(context) {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(context.request),
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, X-VSC-Tenant, X-VSC-User, X-VSC-Token, X-VSC-Client-Session',
      'Access-Control-Expose-Headers': 'Content-Type, Content-Length',
      'Access-Control-Max-Age': '86400',
      'cache-control': 'no-store',
      Vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
    },
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  return json({
    ok: true,
    ts: new Date().toISOString(),
    service: 'Vet System Control – Equine',
    bindings: {
      d1: !!(env?.DB || env?.D1 || env?.VSC_DB),
    },
  }, request);
}
