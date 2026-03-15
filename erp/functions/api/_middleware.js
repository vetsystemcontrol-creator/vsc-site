function resolveCorsConfig(request) {
  const origin = String(request?.headers?.get('Origin') || '').trim();
  if (!origin) return { allowOrigin: 'https://app.vetsystemcontrol.com.br', allowCredentials: false };
  if (/^https:\/\/app\.vetsystemcontrol\.com\.br$/i.test(origin)) return { allowOrigin: origin, allowCredentials: true };
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) return { allowOrigin: origin, allowCredentials: true };
  return { allowOrigin: 'https://app.vetsystemcontrol.com.br', allowCredentials: false };
}

function applyCors(request, headers, methods = 'GET, POST, PUT, PATCH, DELETE, OPTIONS') {
  const { allowOrigin, allowCredentials } = resolveCorsConfig(request);
  headers.set('Access-Control-Allow-Origin', allowOrigin);
  headers.set('Access-Control-Allow-Methods', methods);
  headers.set(
    'Access-Control-Allow-Headers',
    'Content-Type, Accept, Authorization, If-None-Match, If-Match, Origin, X-Requested-With, X-VSC-Tenant, X-VSC-User, X-VSC-Token, X-VSC-Client-Session'
  );
  headers.set('Access-Control-Expose-Headers', 'Content-Type, Content-Length, ETag, X-VSC-State-Revision');
  headers.set('Access-Control-Max-Age', '86400');
  headers.set('Cache-Control', 'no-store');
  headers.set('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
  if (allowCredentials) headers.set('Access-Control-Allow-Credentials', 'true');
  else headers.delete('Access-Control-Allow-Credentials');
  return headers;
}

export async function onRequest(context) {
  const { request, next } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: applyCors(request, new Headers()),
    });
  }

  const response = await next();
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: applyCors(request, new Headers(response.headers)),
  });
}
