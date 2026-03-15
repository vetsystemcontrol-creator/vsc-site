const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const ALLOWED_HEADERS = [
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
const EXPOSE_HEADERS = ['Content-Type', 'Cache-Control', 'ETag', 'X-VSC-State-Revision'].join(', ');

function resolveCorsConfig(request) {
  const origin = String(request.headers.get('Origin') || '').trim();
  if (!origin) {
    return { allowOrigin: 'https://app.vetsystemcontrol.com.br', allowCredentials: false };
  }
  if (/^https:\/\/app\.vetsystemcontrol\.com\.br$/i.test(origin)) return { allowOrigin: origin, allowCredentials: true };
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) return { allowOrigin: origin, allowCredentials: true };
  return { allowOrigin: 'https://app.vetsystemcontrol.com.br', allowCredentials: false };
}

function buildCorsHeaders(request) {
  const { allowOrigin, allowCredentials } = resolveCorsConfig(request);
  const headers = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Expose-Headers': EXPOSE_HEADERS,
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
  };
  if (allowCredentials) headers['Access-Control-Allow-Credentials'] = 'true';
  return headers;
}

function mergeHeaders(target, source) {
  Object.entries(source).forEach(([key, value]) => {
    if (value != null && value !== '') target.set(key, value);
  });
}

export async function onRequest(context) {
  const { request, next } = context;
  const pathname = new URL(request.url).pathname;

  if (!pathname.startsWith('/api/')) {
    return next();
  }

  const corsHeaders = buildCorsHeaders(request);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders,
        'Cache-Control': 'no-store, max-age=0, must-revalidate',
      },
    });
  }

  const response = await next();
  const headers = new Headers(response.headers);
  mergeHeaders(headers, corsHeaders);
  headers.set('Cache-Control', headers.get('Cache-Control') || 'no-store, max-age=0, must-revalidate');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
