/*! 
 * VSC-OUTBOX-RELAY — Transactional Outbox Message Relay (Premium)
 * ============================================================
 * SGQT 8.0 — Confiabilidade Máxima
 *
 * Objetivo:
 *  - Drenar a fila IDB (sync_queue) rapidamente quando há backlog (ex.: pós-restore)
 *  - Fail-closed (não derruba o app)
 *  - Idempotência no receptor (op_id) → safe retry
 *  - Lotes adaptativos + backoff apenas em erro
 *
 * Compatibilidade:
 *  - Preferencial: POST /api/sync/push  { operations: [...] }
 *  - Fallback legado: POST /api/outbox { entity, entity_id, op, payload }
 *
 * Depende de:
 *  - IndexedDB: DB "vsc_db" (ou definido em window.VSC_DB_NAME)
 *  - Store: sync_queue
 *
 * Expõe:
 *  - window.VSC_RELAY.start()
 *  - window.VSC_RELAY.stop()
 *  - window.VSC_RELAY.status()
 *  - window.VSC_RELAY.syncNow()
 */
(() => {
  'use strict';

  // ──────────────────────────────────────────────────────────
  // Config (enterprise defaults)
  // ──────────────────────────────────────────────────────────
  const DB_NAME      = (window.VSC_DB_NAME || 'vsc_db');
  const STORE_OUTBOX = 'sync_queue';
  const API_CAPABILITIES_URL = '/api/state?action=capabilities';
  const REMOTE_BASE = 'https://app.vetsystemcontrol.com.br';
  const SYNC_TARGET_MODE_KEY = 'vsc_sync_target_mode';
  const NETWORK_TIMEOUT_MS = 20_000;

  // Ritmo: rápido com backlog, econômico quando ocioso
  const ACTIVE_TICK_MS = 250;   // quando há pendências
  const IDLE_TICK_MS   = 15_000; // quando não há pendências

  // Lote adaptativo (pós-restore precisa drenar rápido)
  const MIN_BATCH = 10;
  const MAX_BATCH = 150;

  // Erros → backoff (somente quando falha)
  const BASE_BACKOFF_MS = 500;
  const MAX_BACKOFF_MS  = 10_000;

  // Limite de retries por evento (auditoria)
  const MAX_RETRIES = 7;
  const STALE_SENDING_MS = 45_000;
  const DEAD_RETRY_MAX_AGE_MS = 72 * 60 * 60 * 1000;
  const DEAD_RETRY_LIMIT = 50;
  const LEASE_KEY = 'vsc_sync_relay_lease';
  const WAKE_KEY = 'vsc_sync_relay_wake';
  const LEASE_TTL_MS = 20_000;
  const LEASE_RENEW_MS = 5_000;

  // ──────────────────────────────────────────────────────────
  // Estado
  // ──────────────────────────────────────────────────────────
  let _enabled = true;
  let _running = false;
  let _stopRequested = false;
  let _lastError = null;
  let _lastCycleAt = null;
  let _inFlight = null; // promise
  let _capabilities = null;
  let _capabilitiesCheckedAt = 0;
  const INSTANCE_ID = (() => {
    try {
      const key = 'vsc_sync_relay_instance_id';
      const existing = sessionStorage.getItem(key);
      if (existing) return String(existing);
      const created = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
        ? crypto.randomUUID()
        : ('relay-' + Math.random().toString(36).slice(2));
      sessionStorage.setItem(key, created);
      return String(created);
    } catch (_) {
      return 'relay-' + Math.random().toString(36).slice(2);
    }
  })();

  let _stats = {
    pending: 0,
    sent: 0,
    acked: 0,
    failedBatches: 0,
    lastRateOps: 0,
    lastBatchSize: 0,
    lastDurationMs: 0,
    recoveredSending: 0,
    retriedDead: 0,
    lastBatchIds: [],
  };

  // ──────────────────────────────────────────────────────────
  // Small helpers
  // ──────────────────────────────────────────────────────────
  function _now() { return Date.now(); }
  function _randInt(maxExclusive) {
    const n = Number(maxExclusive) || 0;
    if (n <= 1) return 0;
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
        const arr = new Uint32Array(1);
        crypto.getRandomValues(arr);
        return Number(arr[0] % n);
      }
    } catch (_) {}
    return Math.floor(Math.random() * n);
  }
  function normalizeTenantId(raw) {
    try {
      const value = String(raw || 'tenant-default')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._:-]+/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 120);
      return value || 'tenant-default';
    } catch (_) {
      return 'tenant-default';
    }
  }


  async function _getRuntimeContext() {
    try {
      if (window.VSC_DB && typeof window.VSC_DB.getRuntimeContext === 'function') {
        return await window.VSC_DB.getRuntimeContext();
      }
    } catch (_) {}
    try {
      const raw = localStorage.getItem('vsc_user') || sessionStorage.getItem('vsc_user') || 'null';
      const u = JSON.parse(raw);
      return {
        tenant: normalizeTenantId(localStorage.getItem('vsc_tenant') || sessionStorage.getItem('vsc_tenant') || 'tenant-default'),
        userLabel: String((u && (u.username || u.nome || u.name || u.id || u.email)) || 'anonymous').slice(0, 120),
        sessionId: String(localStorage.getItem('vsc_session_id') || sessionStorage.getItem('vsc_session_id') || '').slice(0, 120),
        token: String(localStorage.getItem('vsc_local_token') || sessionStorage.getItem('vsc_local_token') || localStorage.getItem('vsc_token') || sessionStorage.getItem('vsc_token') || '').trim(),
      };
    } catch (_) {
      return { tenant: 'tenant-default', userLabel: 'anonymous', sessionId: '', token: '' };
    }
  }

  function _getSyncTargetMode() {
    try {
      return String(localStorage.getItem(SYNC_TARGET_MODE_KEY) || '').trim().toLowerCase();
    } catch (_) {
      return '';
    }
  }

  function _isCrossOriginUrl(url) {
    try {
      return new URL(url, location.href).origin !== location.origin;
    } catch (_) {
      return false;
    }
  }

  function _withTenantParam(url, tenant) {
    try {
      const u = new URL(url, location.href);
      if (!u.searchParams.get('tenant')) u.searchParams.set('tenant', normalizeTenantId(tenant || 'tenant-default'));
      return u.toString();
    } catch (_) {
      return url;
    }
  }

  async function _fetchWithTimeout(url, options = {}, timeoutMs = NETWORK_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      try { controller.abort(); } catch (_) {}
    }, Math.max(1, Number(timeoutMs) || 1));
    try {
      const credentials = Object.prototype.hasOwnProperty.call(options, 'credentials') ? options.credentials : 'include';
      return await fetch(url, { ...options, credentials, signal: controller.signal });
    } catch (err) {
      if (String(err && err.name || '') === 'AbortError') {
        throw new Error(`network_timeout_${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function _emitProgress(extra = {}) {
    const detail = {
      ok: !_lastError,
      error: _lastError ? String(_lastError) : null,
      running: _running,
      ..._stats,
      ...extra,
    };

    // Prefer UI adapter if present
    if (window.VSC_SYNC_UI && typeof window.VSC_SYNC_UI.onProgress === 'function') {
      try { window.VSC_SYNC_UI.onProgress(detail); } catch (_) {}
    }

    // Also emit DOM event for any listeners
    try {
      window.dispatchEvent(new CustomEvent('vsc:sync-progress', { detail }));
    } catch (_) {}
  }

  let _sleepWake = null;

  function _sleep(ms) {
    const waitMs = Math.max(0, Number(ms) || 0);
    return new Promise((resolve) => {
      let done = false;
      let timer = null;

      const finish = () => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        if (_sleepWake === wake) _sleepWake = null;
        resolve();
      };

      const wake = () => finish();
      _sleepWake = wake;
      timer = setTimeout(finish, waitMs);
    });
  }

  function _wakeLoop() {
    try {
      const wake = _sleepWake;
      _sleepWake = null;
      if (typeof wake === 'function') wake();
    } catch (_) {}
  }

  function _isLocalStaticMode() {
    try {
      const proto = String(location.protocol || '').toLowerCase();
      if (proto === 'file:') return true;
    } catch (_) {}
    return false;
  }

  function _isWranglerDev() {
    try {
      const host = String(location.hostname || '').toLowerCase();
      const proto = String(location.protocol || '').toLowerCase();
      // wrangler pages dev serve via http em 127.0.0.1 ou localhost com porta
      return proto === 'http:' && (host === '127.0.0.1' || host === 'localhost');
    } catch (_) {}
    return false;
  }

  function _apiBase() {
    const mode = _getSyncTargetMode();
    if (_isLocalStaticMode()) return REMOTE_BASE;
    if (_isWranglerDev()) {
      if (mode === 'remote') return REMOTE_BASE;
      return '';
    }
    return '';
  }

  function _apiUrl(path) {
    return `${_apiBase()}${path}`;
  }


  function _readLease() {
    try {
      const raw = localStorage.getItem(LEASE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return {
        owner: String(parsed.owner || ''),
        until: Number(parsed.until || 0) || 0,
        ts: Number(parsed.ts || 0) || 0,
      };
    } catch (_) {
      return null;
    }
  }

  function _writeLease(lease) {
    try {
      localStorage.setItem(LEASE_KEY, JSON.stringify(lease || null));
    } catch (_) {}
  }

  function _isLeaseActive(lease, now = _now()) {
    return !!(lease && lease.owner && Number(lease.until || 0) > now);
  }

  function _leaseOwner() {
    const lease = _readLease();
    return lease && lease.owner ? String(lease.owner) : null;
  }

  function _hasLeadership() {
    const lease = _readLease();
    return !!(lease && lease.owner === INSTANCE_ID && _isLeaseActive(lease));
  }

  function _tryAcquireLease() {
    const now = _now();
    const current = _readLease();
    if (_isLeaseActive(current, now) && String(current.owner || '') !== INSTANCE_ID) {
      return false;
    }
    const next = { owner: INSTANCE_ID, until: now + LEASE_TTL_MS, ts: now };
    _writeLease(next);
    const confirm = _readLease();
    return !!(confirm && confirm.owner === INSTANCE_ID && _isLeaseActive(confirm, now));
  }

  function _renewLease() {
    const now = _now();
    const current = _readLease();
    if (!(current && current.owner === INSTANCE_ID)) return false;
    if ((Number(current.until || 0) - now) > LEASE_RENEW_MS) return true;
    _writeLease({ owner: INSTANCE_ID, until: now + LEASE_TTL_MS, ts: now });
    return true;
  }

  function _releaseLease() {
    try {
      const current = _readLease();
      if (current && current.owner === INSTANCE_ID) {
        localStorage.removeItem(LEASE_KEY);
      }
    } catch (_) {}
  }

  function _signalWake(reason = 'wake') {
    try {
      localStorage.setItem(WAKE_KEY, JSON.stringify({ owner: INSTANCE_ID, reason: String(reason || 'wake'), ts: _now() }));
    } catch (_) {}
  }

  function _computeBackoffWithJitter(attempt) {
    const safeAttempt = Math.max(1, Number(attempt || 1));
    const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, safeAttempt - 1));
    return Math.max(BASE_BACKOFF_MS, _randInt(Math.max(BASE_BACKOFF_MS + 1, ceiling + 1)));
  }

  async function _readCapabilities() {
    const now = _now();
    if (_capabilities && (now - _capabilitiesCheckedAt) < 15000) return _capabilities;

    try {
      const ctx = await _getRuntimeContext();
      const tenant = normalizeTenantId(ctx.tenant || 'tenant-default');
      const capabilitiesUrl = _withTenantParam(_apiUrl(API_CAPABILITIES_URL), tenant);
      const crossOrigin = _isCrossOriginUrl(capabilitiesUrl);
      const userLabel = ctx.userLabel || 'anonymous';
      const clientSession = ctx.sessionId || '';
      const syncToken = ctx.token || '';
      const headers = {
        'Accept': 'application/json',
        'X-VSC-Tenant': tenant,
        'X-VSC-User': userLabel,
        'X-VSC-Client-Session': clientSession,
      };
      if (syncToken) headers['X-VSC-Token'] = syncToken;

      const res = await _fetchWithTimeout(capabilitiesUrl, {
        method: 'GET',
        headers,
        cache: 'no-store',
        credentials: crossOrigin ? 'omit' : 'include',
      }, NETWORK_TIMEOUT_MS);
      if (!res.ok) {
        _capabilities = {
          ok: false,
          available: false,
          remote_sync_allowed: false,
          local_static_mode: false,
          reason: 'capabilities-http-' + res.status,
          status: res.status,
        };
      } else {
        const body = await res.json().catch(() => ({}));
        const authorized = body.authorized !== false;
        _capabilities = {
          ok: body.ok !== false && authorized,
          available: body.available !== false,
          remote_sync_allowed: body.remote_sync_allowed !== false && authorized,
          local_static_mode: !!body.local_static_mode,
          reason: body.reason || body.auth_error || '',
          status: res.status,
          authorized,
          auth_required: !!body.auth_required,
          auth_mode: body.auth_mode || null,
          degraded_auth: !!body.degraded_auth,
          body,
        };
      }
    } catch (err) {
      _capabilities = {
        ok: false,
        available: false,
        remote_sync_allowed: false,
        local_static_mode: false,
        reason: String(err || 'capabilities-fetch-failed'),
      };
    }
    _capabilitiesCheckedAt = now;
    return _capabilities;
  }

  function _openDB() {
    return new Promise((resolve, reject) => {
      try {
        if (window.VSC_DB && typeof window.VSC_DB.openDB === 'function') {
          Promise.resolve(window.VSC_DB.openDB()).then(resolve).catch(reject);
          return;
        }
      } catch (_) {}

      const req = indexedDB.open(DB_NAME);
      req.onerror = () => reject(req.error || new Error('IDB open failed'));
      req.onsuccess = () => resolve(req.result);
    });
  }

  function _tx(db, mode = 'readonly') {
    return db.transaction([STORE_OUTBOX], mode).objectStore(STORE_OUTBOX);
  }

  function _reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IDB request failed'));
    });
  }

  function _normalizeStatus(value) {
    return String(value || '').trim().toUpperCase();
  }

  function _isPendingStatus(value) {
    const st = _normalizeStatus(value);
    return st === 'PENDING' || st === 'PENDENTE';
  }

  function _isSendingStatus(value) {
    return _normalizeStatus(value) === 'SENDING';
  }

  function _parseEventTimeMs(rec) {
    const candidates = [rec && rec.sending_at, rec && rec.dead_at, rec && rec.updated_at, rec && rec.created_at];
    for (const value of candidates) {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string' && value.trim()) {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return 0;
  }

  function _isRetryableDeadError(errValue) {
    const msg = String(errValue || '').toLowerCase();
    if (!msg) return false;
    if (msg.includes('remote_delete_superseded_local_op')) return false;
    if (msg.includes('remote_newer_revision_superseded_local_op')) return false;
    if (msg.includes('sync_rejected')) return false;
    if (msg.includes('validation')) return false;
    if (msg.includes('conflict')) return false;
    return (
      msg.includes('failed to fetch') ||
      msg.includes('network_timeout_') ||
      msg.includes('networkerror') ||
      msg.includes('load failed') ||
      msg.includes('fetch failed') ||
      msg.includes('timeout') ||
      msg.includes('aborterror') ||
      msg.includes('temporar') ||
      msg.includes('503') ||
      msg.includes('502') ||
      msg.includes('504')
    );
  }

  async function _recoverStuckSending(db, { staleMs = STALE_SENDING_MS } = {}) {
    const store = _tx(db, 'readwrite');
    const all = await _reqToPromise(store.getAll());
    const now = _now();
    let recovered = 0;
    let dead = 0;

    for (const rec of (all || [])) {
      if (!rec || !rec.id || !_isSendingStatus(rec.status)) continue;
      const sendingStartedAt = _parseEventTimeMs(rec);
      const ageMs = sendingStartedAt > 0 ? (now - sendingStartedAt) : (staleMs + 1);
      if (ageMs < staleMs) continue;
      rec.retry_count = Number(rec.retry_count || 0) + 1;
      rec.last_error = rec.last_error || 'stale_sending_recovered';
      rec.sending_at = null;
      if (rec.retry_count >= MAX_RETRIES) {
        rec.status = 'DEAD';
        rec.dead_at = now;
        dead += 1;
      } else {
        rec.status = 'PENDING';
        recovered += 1;
      }
      await _reqToPromise(store.put(rec));
    }

    return { recovered, dead, scanned: Array.isArray(all) ? all.length : 0 };
  }

  async function _retryEligibleDead(db, { limit = DEAD_RETRY_LIMIT, maxAgeMs = DEAD_RETRY_MAX_AGE_MS } = {}) {
    const store = _tx(db, 'readwrite');
    const all = await _reqToPromise(store.getAll());
    const now = _now();
    let retried = 0;
    let skipped = 0;

    const ordered = (all || []).filter(Boolean).sort((a, b) => _parseEventTimeMs(b) - _parseEventTimeMs(a));
    for (const rec of ordered) {
      if (!rec || !rec.id || _normalizeStatus(rec.status) !== 'DEAD') continue;
      if (!_isRetryableDeadError(rec.last_error)) { skipped += 1; continue; }
      const ageMs = now - _parseEventTimeMs(rec);
      if (maxAgeMs > 0 && ageMs > maxAgeMs) { skipped += 1; continue; }
      if (rec.remote_authority && (rec.remote_authority.tombstone || rec.remote_authority.entity_revision != null)) { skipped += 1; continue; }
      rec.status = 'PENDING';
      rec.dead_at = null;
      rec.sending_at = null;
      rec.last_retry_at = now;
      rec.last_error = null;
      await _reqToPromise(store.put(rec));
      retried += 1;
      if (retried >= limit) break;
    }

    return { retried, skipped, scanned: Array.isArray(all) ? all.length : 0 };
  }

  async function _countPending(db) {
    const store = _tx(db, 'readonly');
    // Prefer index if exists
    if (store.indexNames && store.indexNames.contains('status')) {
      const idx = store.index('status');
      const countReq = idx.count('PENDING');
      return await _reqToPromise(countReq);
    }
    // Fallback: scan (slower but safe)
    const all = await _reqToPromise(store.getAll());
    return (all || []).filter(e => e && _isPendingStatus(e.status)).length;
  }

  async function _refreshPendingStats(db = null) {
    let handle = db;
    let shouldClose = false;
    try {
      if (!handle) {
        handle = await _openDB();
        shouldClose = true;
      }
      const pending = await _countPending(handle);
      _stats.pending = pending;
      _stats.totalOpen = pending;
      return pending;
    } finally {
      if (shouldClose && handle) {
        try { handle.close(); } catch (_) {}
      }
    }
  }

  async function _readPendingBatch(db, limit) {
    const store = _tx(db, 'readonly');

    // Ideal: status index + cursor
    if (store.indexNames && store.indexNames.contains('status')) {
      const idx = store.index('status');
      const out = [];
      return await new Promise((resolve, reject) => {
        const req = idx.openCursor('PENDING');
        req.onerror = () => reject(req.error || new Error('cursor failed'));
        req.onsuccess = (ev) => {
          const cursor = ev.target.result;
          if (!cursor || out.length >= limit) return resolve(out);
          out.push(cursor.value);
          cursor.continue();
        };
      });
    }

    // Fallback: getAll + filter
    const all = await _reqToPromise(store.getAll());
    const pending = (all || []).filter(e => e && _isPendingStatus(e.status));
    // Sort stable by created_at/id to keep deterministic drain
    pending.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
    return pending.slice(0, limit);
  }

  async function _markBatch(db, ids, patch) {
    const store = _tx(db, 'readwrite');
    for (const id of ids) {
      const rec = await _reqToPromise(store.get(id));
      if (!rec) continue;
      Object.assign(rec, patch);
      await _reqToPromise(store.put(rec));
    }
  }

  async function _applyPushResult(db, batch, resp) {
    const rows = Array.isArray(batch) ? batch : [];
    if (!rows.length) return { acked: 0, rejected: 0, pending: 0 };

    const ackIds = new Set(((resp && Array.isArray(resp.ack_ids)) ? resp.ack_ids : []).map((v) => String(v || '')));
    const rejectedRaw = (resp && Array.isArray(resp.rejected)) ? resp.rejected : [];
    const rejectedByOpId = new Map(
      rejectedRaw
        .filter((item) => item && (item.op_id || item.id))
        .map((item) => [String(item.op_id || item.id), item])
    );

    const granularAckAvailable = ackIds.size > 0 || rejectedRaw.length > 0;
    const canAckWholeBatch = !granularAckAvailable && resp && resp.ok === true;

    const store = _tx(db, 'readwrite');
    const now = _now();
    let acked = 0;
    let rejected = 0;
    let pending = 0;

    for (const ev of rows) {
      if (!ev || !ev.id) continue;
      const rec = await _reqToPromise(store.get(ev.id));
      if (!rec) continue;

      const ackedById = ackIds.has(String(ev.op_id || ev.id || ''));
      const rejectedMeta = rejectedByOpId.get(String(ev.op_id || ev.id || '')) || null;

      if (ackedById || canAckWholeBatch) {
        rec.status = 'DONE';
        rec.done_at = now;
        rec.last_ack = resp || null;
        rec.last_error = null;
        acked += 1;
      } else if (rejectedMeta) {
        rec.retry_count = Number(rec.retry_count || 0) + 1;
        rec.last_error = String(rejectedMeta.code || rejectedMeta.error || 'sync_rejected');
        rec.last_rejected = rejectedMeta;
        if (rec.retry_count >= MAX_RETRIES) {
          rec.status = 'DEAD';
          rec.dead_at = now;
        } else {
          rec.status = 'PENDING';
        }
        rejected += 1;
      } else {
        // Resposta parcial/indeterminada: nunca confirmar como DONE.
        rec.status = 'PENDING';
        rec.last_error = 'sync_ack_indeterminate';
        rec.last_ack = resp || null;
        pending += 1;
      }

      await _reqToPromise(store.put(rec));
    }

    return { acked, rejected, pending };
  }

  function _computeBatchSize(pending) {
    if (pending <= 0) return 0;
    // Heurística simples: mais backlog → lote maior
    if (pending >= 2000) return MAX_BATCH;
    if (pending >= 500) return Math.min(MAX_BATCH, 120);
    if (pending >= 200) return Math.min(MAX_BATCH, 80);
    if (pending >= 50)  return Math.min(MAX_BATCH, 40);
    return Math.max(MIN_BATCH, 20);
  }

  // ──────────────────────────────────────────────────────────
  // Network: push
  // ──────────────────────────────────────────────────────────
  async function _pushBatchSyncPush(batch) {
    const ctx = await _getRuntimeContext();
    const tenant = normalizeTenantId(ctx.tenant || 'tenant-default');
    const userLabel = ctx.userLabel || 'anonymous';
    const clientSession = ctx.sessionId || '';
    const syncToken = ctx.token || '';

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-VSC-Tenant': tenant,
      'X-VSC-User': userLabel,
      'X-VSC-Client-Session': clientSession,
    };
    if (syncToken) headers['X-VSC-Token'] = syncToken;

    const pushUrl = _withTenantParam(_apiUrl('/api/sync/push'), tenant);
    const crossOrigin = _isCrossOriginUrl(pushUrl);
    const res = await _fetchWithTimeout(pushUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ operations: batch }),
      credentials: crossOrigin ? 'omit' : 'include',
    }, NETWORK_TIMEOUT_MS);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`sync/push failed ${res.status} ${text}`);
    }

    return await res.json().catch(() => ({ ok: true }));
  }

  async function _pushBatchLegacyOutbox(batch) {
    const ctx = await _getRuntimeContext();
    const tenant = normalizeTenantId(ctx.tenant || 'tenant-default');
    const userLabel = ctx.userLabel || 'anonymous';
    const clientSession = ctx.sessionId || '';
    const syncToken = ctx.token || '';

    for (const ev of batch) {
      const body = {
        entity: ev.entity,
        entity_id: ev.entity_id,
        op: ev.op,
        payload: ev.payload,
        op_id: ev.op_id,
      };
      const legacyUrl = _withTenantParam(_apiUrl('/api/outbox'), tenant);
      const crossOrigin = _isCrossOriginUrl(legacyUrl);
      const res = await _fetchWithTimeout(legacyUrl, {
        method: 'POST',
        headers: (() => { const h = {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-VSC-Tenant': tenant,
          'X-VSC-User': userLabel,
          'X-VSC-Client-Session': clientSession,
        }; if (syncToken) h['X-VSC-Token'] = syncToken; return h; })(),
        body: JSON.stringify(body),
        credentials: crossOrigin ? 'omit' : 'include',
      }, NETWORK_TIMEOUT_MS);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`outbox failed ${res.status} ${text}`);
      }
    }
    return { ok: true };
  }

  async function _pushBatch(batch) {
    const caps = await _readCapabilities();
    if (!caps || caps.remote_sync_allowed === false) {
      const reason = (caps && caps.reason) ? caps.reason : 'remote-sync-disabled';
      throw new Error(reason);
    }
    // Prefer /api/sync/push
    try {
      return await _pushBatchSyncPush(batch);
    } catch (e) {
      const msg = String(e || '');
      const recoverable = msg.includes(' 404 ') || msg.includes(' 405 ') || msg.includes(' 501 ') || msg.includes('unsupported_action') || msg.includes('Cannot');
      if (recoverable) {
        return await _pushBatchLegacyOutbox(batch);
      }
      throw e;
    }
  }

  async function _waitForDrain({ budgetMs = 0 } = {}) {
    const safeBudget = Math.max(0, Number(budgetMs) || 0);
    const deadline = safeBudget > 0 ? (_now() + safeBudget) : 0;

    while (true) {
      const pending = await _refreshPendingStats().catch(() => Number(_stats.pending || 0) || 0);
      if (pending <= 0) return { pending: 0, timedOut: false };
      if (_lastError) return { pending, timedOut: false, error: _lastError };

      if (!_inFlight) {
        _drainLoop({ force: false }).catch(() => {});
      }
      _wakeLoop();

      if (safeBudget > 0 && _now() >= deadline) {
        return { pending, timedOut: true };
      }

      const remaining = safeBudget > 0 ? Math.max(25, deadline - _now()) : 250;
      await _sleep(Math.min(250, remaining));
    }
  }

  // ──────────────────────────────────────────────────────────
  // Core loop
  // ──────────────────────────────────────────────────────────
  async function _drainLoop({ force = false } = {}) {
    if (_inFlight) return _inFlight;
    if (!_tryAcquireLease()) {
      _emitProgress({ leader: false, lease_owner: _leaseOwner() });
      return { ok: false, follower: true, lease_owner: _leaseOwner() };
    }

    _inFlight = (async () => {
      _stopRequested = false;
      _running = true;
      _lastError = null;
      _emitProgress();

      let backoffMs = 0;
      let failureCount = 0;

      try {
        while (_enabled && !_stopRequested) {
          _renewLease();
          _lastCycleAt = _now();
          const t0 = _now();

          const db = await _openDB();
          try {
            const recoveredSending = await _recoverStuckSending(db).catch(() => ({ recovered: 0, dead: 0 }));
            const retriedDead = await _retryEligibleDead(db).catch(() => ({ retried: 0 }));
            const pending = await _countPending(db);
            _stats.pending = pending;
            _stats.totalOpen = pending;
            _stats.recoveredSending = Number(recoveredSending && recoveredSending.recovered || 0) || 0;
            _stats.retriedDead = Number(retriedDead && retriedDead.retried || 0) || 0;

            if (pending <= 0) {
              _stats.lastBatchSize = 0;
              _stats.lastRateOps = 0;
              _stats.lastDurationMs = _now() - t0;
              _emitProgress({ idle: true });
              if (force) break;
              await _sleep(IDLE_TICK_MS);
              continue;
            }

            const caps = await _readCapabilities();
            if (!caps || caps.remote_sync_allowed === false) {
              _stats.lastBatchSize = 0;
              _stats.lastRateOps = 0;
              _stats.lastDurationMs = _now() - t0;
              _emitProgress({
                idle: true,
                capabilities: caps || null,
                local_static_mode: !!(caps && caps.local_static_mode),
                remote_sync_allowed: false,
              });
              if (force) break;
              await _sleep(IDLE_TICK_MS);
              continue;
            }

            // Se tiver pendência, drena rápido
            const batchSize = _computeBatchSize(pending);
            const batch = await _readPendingBatch(db, batchSize);
            const ids = batch.map(e => e.id).filter(Boolean);

            _stats.lastBatchSize = batch.length;

            // Mark SENDING (opcional, mas bom para auditoria)
            _stats.lastBatchIds = ids.slice();
            if (ids.length) {
              await _markBatch(db, ids, { status: 'SENDING', sending_at: _now() });
              _stats.totalOpen = Math.max(Number(_stats.pending || pending || 0), ids.length);
            }

            const resp = await _pushBatch(batch);
            const applyResult = await _applyPushResult(db, batch, resp);

            _stats.sent += batch.length;
            _stats.acked += Number(applyResult.acked || 0);

            const dt = _now() - t0;
            _stats.lastDurationMs = dt;
            _stats.lastRateOps = dt > 0 ? Math.round((batch.length * 1000) / dt) : batch.length;

            failureCount = 0;
            backoffMs = 0;
            _stats.lastBatchIds = [];
            await _refreshPendingStats(db).catch(() => {});
            _emitProgress({ pushed: batch.length });

            // Tick ativo pequeno para não travar UI
            await _sleep(ACTIVE_TICK_MS);

          } finally {
            try { db.close(); } catch (_) {}
          }
        }
      } catch (err) {
        _lastError = err;
        _stats.failedBatches += 1;

        // Reverter apenas o lote em voo para PENDING/DEAD
        try {
          const db = await _openDB();
          try {
            if (Array.isArray(_stats.lastBatchIds) && _stats.lastBatchIds.length) {
              const store = _tx(db, 'readwrite');
              for (const id of _stats.lastBatchIds) {
                const rec = await _reqToPromise(store.get(id));
                if (!rec || !_isSendingStatus(rec.status)) continue;
                rec.retry_count = Number(rec.retry_count || 0) + 1;
                rec.last_error = String(err || '');
                rec.sending_at = null;
                if (rec.retry_count >= MAX_RETRIES) {
                  rec.status = 'DEAD';
                  rec.dead_at = _now();
                } else {
                  rec.status = 'PENDING';
                }
                await _reqToPromise(store.put(rec));
              }
            }
          } finally {
            try { db.close(); } catch (_) {}
          }
        } catch (_) {
          // ignore
        }

        // Backoff only on errors (exponential + jitter)
        failureCount += 1;
        backoffMs = _computeBackoffWithJitter(failureCount);
        _emitProgress({ error: String(err || ''), backoffMs, capabilities: _capabilities || null, local_static_mode: !!(_capabilities && _capabilities.local_static_mode), remote_sync_allowed: !!(_capabilities && _capabilities.remote_sync_allowed) });
        await _sleep(backoffMs);

      } finally {
        _releaseLease();
        _running = false;
        _stopRequested = false;
        _inFlight = null;
        _emitProgress();
      }
    })();

    return _inFlight;
  }

  // ──────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────
  const VSC_RELAY = {
    start() {
      _enabled = true;
      // Kick background drain (non-forced)
      _drainLoop({ force: false }).catch(() => {});
      return true;
    },

    stop() {
      _stopRequested = true;
      _enabled = false;
      return true;
    },

    async syncNow(options = {}) {
      // Forced drain until idle once (useful for manual button)
      _enabled = true;
      const budgetMs = Math.max(0, Number(options && options.budgetMs) || 0);
      const startedAt = _now();
      const ackedBefore = Number(_stats.acked || 0) || 0;
      const retryDead = options && options.retryDead !== false;
      let retriedDead = 0;

      if (retryDead) {
        try {
          const db = await _openDB();
          try {
            const retryResult = await _retryEligibleDead(db, {
              limit: Math.max(1, Number(options && options.retryDeadLimit) || DEAD_RETRY_LIMIT),
              maxAgeMs: Math.max(0, Number(options && options.retryDeadMaxAgeMs) || DEAD_RETRY_MAX_AGE_MS),
            });
            retriedDead = Number(retryResult && retryResult.retried || 0) || 0;
            _stats.retriedDead = retriedDead;
          } finally {
            try { db.close(); } catch (_) {}
          }
        } catch (_) {}
      }

      await _refreshPendingStats().catch(() => {});
      if (!_inFlight) {
        _signalWake('sync-now');
        _drainLoop({ force: false }).catch(() => {});
      }
      _wakeLoop();

      const waitResult = await _waitForDrain({ budgetMs });
      const pending = await _refreshPendingStats().catch(() => Number(_stats.pending || 0) || 0);
      const status = this.status();
      const elapsedMs = _now() - startedAt;
      const ackedAfter = Number(status.acked || 0) || 0;
      const keepAliveOnBudget = !(options && options.keepAliveOnBudget === false);

      if (!keepAliveOnBudget && waitResult.timedOut) {
        this.stop();
      }

      return {
        ...status,
        ok: !status.lastError && pending === 0,
        pending,
        total_open: pending,
        elapsedMs,
        budgetMs,
        budgetExceeded: !!waitResult.timedOut,
        ackedDelta: Math.max(0, ackedAfter - ackedBefore),
        retriedDead,
      };
    },

    async retryDead(options = {}) {
      const db = await _openDB();
      try {
        const result = await _retryEligibleDead(db, {
          limit: Math.max(1, Number(options && options.limit) || DEAD_RETRY_LIMIT),
          maxAgeMs: Math.max(0, Number(options && options.maxAgeMs) || DEAD_RETRY_MAX_AGE_MS),
        });
        _stats.retriedDead = Number(result && result.retried || 0) || 0;
        await _refreshPendingStats(db).catch(() => {});
        return result;
      } finally {
        try { db.close(); } catch (_) {}
      }
    },

    // Compatibilidade retroativa: módulos legados ainda chamam relay.kick()
    kick() {
      return this.syncNow();
    },

    status() {
      const lastError = _lastError ? String(_lastError) : null;
      return {
        enabled: _enabled,
        running: _running,
        lastError,
        last_error: lastError,
        lastCycleAt: _lastCycleAt,
        last_run: _lastCycleAt,
        last_sent: Number(_stats.acked || _stats.sent || 0) || 0,
        pending: Number(_stats.pending || 0) || 0,
        total_open: Number(_stats.totalOpen || _stats.pending || 0) || 0,
        api_base: _apiBase(),
        sent: Number(_stats.sent || 0) || 0,
        acked: Number(_stats.acked || 0) || 0,
        last_batch: Number(_stats.lastBatchSize || 0) || 0,
        last_batch_size: Number(_stats.lastBatchSize || 0) || 0,
        last_duration_ms: Number(_stats.lastDurationMs || 0) || 0,
        recovered_sending: Number(_stats.recoveredSending || 0) || 0,
        retried_dead: Number(_stats.retriedDead || 0) || 0,
        local_static_mode: !!(_capabilities && _capabilities.local_static_mode),
        remote_sync_allowed: !!(_capabilities && _capabilities.remote_sync_allowed),
        capabilities: _capabilities ? { ..._capabilities } : null,
        leader: _hasLeadership(),
        lease_owner: _leaseOwner(),
        instance_id: INSTANCE_ID,
        stats: { ..._stats },
      };
    },
  };

  window.VSC_RELAY = VSC_RELAY;

  
  function _autoStartRelay() {
    try {
      if (!_enabled) _enabled = true;
      VSC_RELAY.start();
    } catch (_) {}
  }

  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _autoStartRelay, { once: true });
    } else {
      _autoStartRelay();
    }
  } catch (_) {
    _autoStartRelay();
  }

  try {
    window.addEventListener('storage', (event) => {
      if (!event) return;
      if (event.key === WAKE_KEY || event.key === LEASE_KEY) {
        _wakeLoop();
        _autoStartRelay();
      }
    });
    window.addEventListener('online', _autoStartRelay);
    window.addEventListener('focus', _autoStartRelay);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') _autoStartRelay();
    });
  } catch (_) {}

  try {
    window.addEventListener('beforeunload', _releaseLease);
    window.addEventListener('pagehide', _releaseLease);
  } catch (_) {}

  try {
    setInterval(() => {
      try {
        const st = VSC_RELAY.status();
        if (st && st.enabled && !st.running) {
          VSC_RELAY.start();
        }
      } catch (_) {}
    }, 30000);
  } catch (_) {}

})();
