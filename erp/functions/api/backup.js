
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const INDEX_KEY = "backups/index.json";
const AUDIT_KEY = "backups/audit.json";
const SESSION_PREFIX = "backups/sessions/";
const FILE_PREFIX = "backups/files/";
const MAX_AUDIT = 500;
const MAX_KEEP_LAST = 200;
const DEFAULT_CHUNK_MAX = 256 * 1024;


function corsHeaders(request) {
  const origin = request?.headers?.get("Origin") || "";
  if (/^https:\/\/app\.vetsystemcontrol\.com\.br$/i.test(origin))
    return { "Access-Control-Allow-Origin": origin, "Vary": "Origin" };
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin))
    return { "Access-Control-Allow-Origin": origin, "Vary": "Origin" };
  return { "Access-Control-Allow-Origin": "*" };
}

function json(data, status = 200, request = null) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...(request ? corsHeaders(request) : {}) } });
}

function badRequest(message, status = 400, request = null) {
  return json({ ok: false, error: message }, status, request);
}

function getBucket(env) {
  return env && env.BACKUPS_BUCKET ? env.BACKUPS_BUCKET : null;
}

async function sha256Hex(buffer) {
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readJsonObject(bucket, key, fallback) {
  const obj = await bucket.get(key);
  if (!obj) return fallback;
  try {
    return await obj.json();
  } catch (_) {
    return fallback;
  }
}

async function writeJsonObject(bucket, key, value) {
  await bucket.put(key, JSON.stringify(value, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

function padSeq(seq) {
  return String(Number(seq) || 0).padStart(9, "0");
}

function makeId() {
  const raw = crypto.randomUUID().replace(/-/g, "");
  return `bk_${raw}`;
}

function filenameFor(id) {
  return `${id}.vscbak`;
}

function sortNewest(items) {
  return [...items].sort((a, b) => String(b.finished_at || "").localeCompare(String(a.finished_at || "")));
}

async function readIndex(bucket) {
  const parsed = await readJsonObject(bucket, INDEX_KEY, { version: 1, items: [] });
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  return { version: 1, items };
}

async function writeIndex(bucket, indexObj) {
  await writeJsonObject(bucket, INDEX_KEY, { version: 1, items: sortNewest(indexObj.items || []) });
}

async function appendAudit(bucket, event) {
  const parsed = await readJsonObject(bucket, AUDIT_KEY, { version: 1, events: [] });
  const events = Array.isArray(parsed?.events) ? parsed.events : [];
  events.unshift({
    ts: new Date().toISOString(),
    ...event,
  });
  await writeJsonObject(bucket, AUDIT_KEY, { version: 1, events: events.slice(0, MAX_AUDIT) });
}

async function deleteByPrefix(bucket, prefix) {
  let cursor;
  for (;;) {
    const listed = await bucket.list({ prefix, cursor });
    const keys = (listed.objects || []).map((o) => o.key);
    if (keys.length) await bucket.delete(keys);
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
}

async function readSessionMeta(bucket, sid) {
  return await readJsonObject(bucket, `${SESSION_PREFIX}${sid}/meta.json`, null);
}

async function writeSessionMeta(bucket, sid, meta) {
  await writeJsonObject(bucket, `${SESSION_PREFIX}${sid}/meta.json`, meta);
}

async function listSessionChunks(bucket, sid) {
  const listed = await bucket.list({ prefix: `${SESSION_PREFIX}${sid}/chunks/` });
  return (listed.objects || []).map((o) => o.key).sort();
}

async function handleCapabilities(env, request) {
  const bucket = getBucket(env);
  if (!bucket) {
    return json({
      ok: true,
      available: false,
      storage: "browser",
      reason: "missing_BACKUPS_BUCKET_binding",
    }, 200, request);
  }
  return json({
    ok: true,
    available: true,
    storage: "r2",
    chunk_max_bytes: DEFAULT_CHUNK_MAX,
  }, 200, request);
}

async function handleStart(request, env) {
  const bucket = getBucket(env);
  if (!bucket) return json({ ok: false, error: "BACKUPS_BUCKET binding ausente." }, 501, request);
  const body = await request.json().catch(() => ({}));
  const sid = makeId();
  const createdAt = new Date().toISOString();
  await writeSessionMeta(bucket, sid, {
    id: sid,
    created_at: createdAt,
    source: String(body?.source || "dashboard"),
    chunk_max_bytes: DEFAULT_CHUNK_MAX,
    state: "open",
  });
  await appendAudit(bucket, { type: "session_start", sid, source: String(body?.source || "dashboard") });
  return json({ ok: true, id: sid, chunk_max_bytes: DEFAULT_CHUNK_MAX }, 200, request);
}

async function handleChunk(request, env, url) {
  const bucket = getBucket(env);
  if (!bucket) return json({ ok: false, error: "BACKUPS_BUCKET binding ausente." }, 501, request);
  const sid = String(url.searchParams.get("sid") || "").trim();
  const seq = String(url.searchParams.get("seq") || "").trim();
  if (!sid) return badRequest("sid ausente.", 400, request);
  if (seq === "") return badRequest("seq ausente.", 400, request);
  const meta = await readSessionMeta(bucket, sid);
  if (!meta || meta.state !== "open") return badRequest("sessão inválida.", 404, request);
  const data = await request.arrayBuffer();
  await bucket.put(`${SESSION_PREFIX}${sid}/chunks/${padSeq(seq)}.bin`, data, {
    httpMetadata: { contentType: "application/octet-stream" },
  });
  return json({ ok: true, sid, seq: Number(seq), bytes: data.byteLength }, 200, request);
}

async function handleAbort(env, url, request) {
  const bucket = getBucket(env);
  if (!bucket) return json({ ok: false, error: "BACKUPS_BUCKET binding ausente." }, 501, request);
  const sid = String(url.searchParams.get("sid") || "").trim();
  if (!sid) return badRequest("sid ausente.", 400, request);
  await deleteByPrefix(bucket, `${SESSION_PREFIX}${sid}/`);
  await appendAudit(bucket, { type: "session_abort", sid });
  return json({ ok: true, aborted: sid }, 200, request);
}

async function handleFinish(request, env, url) {
  const bucket = getBucket(env);
  if (!bucket) return json({ ok: false, error: "BACKUPS_BUCKET binding ausente." }, 501, request);
  const sid = String(url.searchParams.get("sid") || "").trim();
  if (!sid) return badRequest("sid ausente.", 400, request);
  const body = await request.json().catch(() => ({}));
  const meta = await readSessionMeta(bucket, sid);
  if (!meta || meta.state !== "open") return badRequest("sessão inválida.", 404, request);

  const chunkKeys = await listSessionChunks(bucket, sid);
  if (!chunkKeys.length) return badRequest("nenhum chunk recebido.", 400, request);
  const chunks = [];
  let total = 0;
  for (const key of chunkKeys) {
    const obj = await bucket.get(key);
    if (!obj) continue;
    const buf = await obj.arrayBuffer();
    total += buf.byteLength;
    chunks.push(new Uint8Array(buf));
  }
  const joined = new Uint8Array(total);
  let off = 0;
  for (const part of chunks) {
    joined.set(part, off);
    off += part.byteLength;
  }
  const id = makeId();
  const now = new Date().toISOString();
  const fileKey = `${FILE_PREFIX}${filenameFor(id)}`;
  const sha256 = await sha256Hex(joined.buffer);
  await bucket.put(fileKey, joined, {
    httpMetadata: {
      contentType: "application/octet-stream",
      contentDisposition: `attachment; filename="${filenameFor(id)}"`,
    },
    customMetadata: {
      sha256,
      bytes: String(joined.byteLength),
      created_at: now,
      source: String(meta.source || "dashboard"),
    },
  });

  const indexObj = await readIndex(bucket);
  const item = {
    id,
    sid,
    file: filenameFor(id),
    file_key: fileKey,
    finished_at: now,
    bytes: joined.byteLength,
    sha256,
    source: String(meta.source || "dashboard"),
    sent_bytes: Number(body?.meta?.sent_bytes || joined.byteLength),
    seq_final: Number(body?.seq_final ?? chunkKeys.length - 1),
  };
  indexObj.items = sortNewest([item, ...(indexObj.items || []).filter((x) => x.id !== id)]);
  await writeIndex(bucket, indexObj);
  await deleteByPrefix(bucket, `${SESSION_PREFIX}${sid}/`);
  await appendAudit(bucket, { type: "backup_finish", id, sid, bytes: joined.byteLength, sha256 });
  return json({ ok: true, id, file: item.file, bytes: item.bytes, sha256 }, 200, request);
}

async function handleList(env, request) {
  const bucket = getBucket(env);
  if (!bucket) return json({ ok: true, backups: [], available: false, storage: "browser" }, 200, request);
  const indexObj = await readIndex(bucket);
  const backups = sortNewest(indexObj.items || []).map((item) => ({
    id: item.id,
    finished_at: item.finished_at,
    bytes: item.bytes,
    sha256: item.sha256,
    file: item.file,
    source: item.source || "dashboard",
  }));
  return json({ ok: true, backups, available: true, storage: "r2" }, 200, request);
}

async function findItem(bucket, id) {
  const indexObj = await readIndex(bucket);
  const item = (indexObj.items || []).find((entry) => entry.id === id);
  return { indexObj, item };
}

async function handleVerify(env, url, request) {
  const bucket = getBucket(env);
  if (!bucket) return json({ ok: false, error: "BACKUPS_BUCKET binding ausente." }, 501, request);
  const id = String(url.searchParams.get("id") || "").trim();
  if (!id) return badRequest("id ausente.", 400, request);
  const { item } = await findItem(bucket, id);
  if (!item) return badRequest("backup não encontrado.", 404, request);
  return json({ ok: true, id: item.id, bytes: item.bytes, sha256: item.sha256, file: item.file, finished_at: item.finished_at }, 200, request);
}

async function handleDownload(env, url, request) {
  const bucket = getBucket(env);
  if (!bucket) return json({ ok: false, error: "BACKUPS_BUCKET binding ausente." }, 501, request);
  const id = String(url.searchParams.get("id") || "").trim();
  if (!id) return badRequest("id ausente.", 400, request);
  const { item } = await findItem(bucket, id);
  if (!item) return badRequest("backup não encontrado.", 404, request);
  const obj = await bucket.get(item.file_key);
  if (!obj) return badRequest("arquivo não encontrado.", 404, request);
  const headers = new Headers();
  headers.set("content-type", obj.httpMetadata?.contentType || "application/octet-stream");
  headers.set("content-disposition", `attachment; filename="${item.file || filenameFor(id)}"`);
  headers.set("cache-control", "no-store");
  headers.set("x-vsc-backup-id", item.id);
  headers.set("x-vsc-sha256", item.sha256 || "");
  return new Response(obj.body, { status: 200, headers });
}

async function handleDelete(request, env, url) {
  const bucket = getBucket(env);
  if (!bucket) return json({ ok: false, error: "BACKUPS_BUCKET binding ausente." }, 501, request);
  const id = String(url.searchParams.get("id") || "").trim();
  if (!id) return badRequest("id ausente.", 400, request);
  const { indexObj, item } = await findItem(bucket, id);
  if (!item) return badRequest("backup não encontrado.", 404, request);
  await bucket.delete(item.file_key);
  const removed = [item.file_key];
  indexObj.items = (indexObj.items || []).filter((entry) => entry.id !== id);
  await writeIndex(bucket, indexObj);
  await appendAudit(bucket, { type: "backup_delete", id, file: item.file });
  return json({ ok: true, removed }, 200, request);
}

async function handleRetention(request, env) {
  const bucket = getBucket(env);
  if (!bucket) return json({ ok: false, error: "BACKUPS_BUCKET binding ausente." }, 501, request);
  const body = await request.json().catch(() => ({}));
  const keepLast = Math.max(1, Math.min(MAX_KEEP_LAST, Number(body?.keep_last || 10)));
  const indexObj = await readIndex(bucket);
  const items = sortNewest(indexObj.items || []);
  const keep = items.slice(0, keepLast);
  const remove = items.slice(keepLast);
  if (remove.length) await bucket.delete(remove.map((item) => item.file_key));
  await writeIndex(bucket, { version: 1, items: keep });
  await appendAudit(bucket, { type: "retention_apply", keep_last: keepLast, removed: remove.map((x) => x.id) });
  return json({ ok: true, keep_last: keepLast, removed: remove.map((x) => x.id), deleted: remove.map((x) => x.id) }, 200, request);
}

async function handleAudit(env, url, request) {
  const bucket = getBucket(env);
  if (!bucket) return json({ ok: true, lines: [], available: false, storage: "browser" }, 200, request);
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") || 50)));
  const parsed = await readJsonObject(bucket, AUDIT_KEY, { version: 1, events: [] });
  const events = Array.isArray(parsed?.events) ? parsed.events.slice(0, limit) : [];
  const lines = events.map((event) => JSON.stringify(event));
  return json({ ok: true, lines, available: true, storage: "r2" }, 200, request);
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const action = String(url.searchParams.get("action") || "").trim().toLowerCase();

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(request),
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type, x-vsc-tenant, x-vsc-user, x-vsc-token",
        "access-control-max-age": "86400",
        "cache-control": "no-store",
      },
    });
  }

  try {
    if (request.method === "GET") {
      if (action === "capabilities") return await handleCapabilities(env, request);
      if (action === "list") return await handleList(env, request);
      if (action === "verify") return await handleVerify(env, url, request);
      if (action === "download") return await handleDownload(env, url, request);
      if (action === "audit") return await handleAudit(env, url, request);
      return badRequest("ação GET inválida.", 400, request);
    }

    if (request.method === "POST") {
      if (action === "start") return await handleStart(request, env);
      if (action === "chunk") return await handleChunk(request, env, url);
      if (action === "finish") return await handleFinish(request, env, url);
      if (action === "abort") return await handleAbort(env, url, request);
      if (action === "delete") return await handleDelete(request, env, url);
      if (action === "retention") return await handleRetention(request, env);
      return badRequest("ação POST inválida.", 400, request);
    }

    return badRequest("método não suportado.", 405, request);
  } catch (error) {
    return json({
      ok: false,
      error: String(error?.message || error || "erro interno"),
    }, 500, request);
  }
}
