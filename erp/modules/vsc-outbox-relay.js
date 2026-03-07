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
  const DB_VERSION   = (window.VSC_DB_VERSION || 1);
  const STORE_OUTBOX = 'sync_queue';

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

  // ──────────────────────────────────────────────────────────
  // Estado
  // ──────────────────────────────────────────────────────────
  let _enabled = true;
  let _running = false;
  let _stopRequested = false;
  let _lastError = null;
  let _lastCycleAt = null;
  let _inFlight = null; // promise
  let _stats = {
    pending: 0,
    sent: 0,
    acked: 0,
    failedBatches: 0,
    lastRateOps: 0,
    lastBatchSize: 0,
    lastDurationMs: 0,
  };

  // ──────────────────────────────────────────────────────────
  // Small helpers
  // ──────────────────────────────────────────────────────────
  function _now() { return Date.now(); }

  function _getToken() {
    return (
      localStorage.getItem('vsc_local_token') ||
      sessionStorage.getItem('vsc_local_token') ||
      ''
    );
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

  function _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function _openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
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
    return (all || []).filter(e => e && e.status === 'PENDING').length;
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
    const pending = (all || []).filter(e => e && e.status === 'PENDING');
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
    const token = _getToken();
    const res = await fetch('/api/sync/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-VSC-Token': token,
      },
      body: JSON.stringify({ operations: batch }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`sync/push failed ${res.status} ${text}`);
    }

    return await res.json().catch(() => ({ ok: true }));
  }

  async function _pushBatchLegacyOutbox(batch) {
    // Envia 1 a 1 no endpoint antigo
    const token = _getToken();
    for (const ev of batch) {
      const body = {
        entity: ev.entity,
        entity_id: ev.entity_id,
        op: ev.op,
        payload: ev.payload,
        op_id: ev.op_id,
      };
      const res = await fetch('/api/outbox', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-VSC-Token': token,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`outbox failed ${res.status} ${text}`);
      }
    }
    return { ok: true };
  }

  async function _pushBatch(batch) {
    // Prefer /api/sync/push
    try {
      return await _pushBatchSyncPush(batch);
    } catch (e) {
      // Fallback only if endpoint missing (404) or not implemented
      const msg = String(e || '');
      if (msg.includes('404') || msg.includes('Cannot') || msg.includes('sync/push')) {
        // try legacy
        return await _pushBatchLegacyOutbox(batch);
      }
      throw e;
    }
  }

  // ──────────────────────────────────────────────────────────
  // Core loop
  // ──────────────────────────────────────────────────────────
  async function _drainLoop({ force = false } = {}) {
    if (_inFlight) return _inFlight;

    _inFlight = (async () => {
      _stopRequested = false;
      _running = true;
      _lastError = null;
      _emitProgress();

      let backoffMs = 0;

      try {
        while (_enabled && !_stopRequested) {
          _lastCycleAt = _now();
          const t0 = _now();

          const db = await _openDB();
          try {
            const pending = await _countPending(db);
            _stats.pending = pending;

            if (pending <= 0) {
              _stats.lastBatchSize = 0;
              _stats.lastRateOps = 0;
              _stats.lastDurationMs = _now() - t0;
              _emitProgress({ idle: true });
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
            if (ids.length) {
              await _markBatch(db, ids, { status: 'SENDING', sending_at: _now() });
            }

            const resp = await _pushBatch(batch);

            // Ack
            if (ids.length) {
              await _markBatch(db, ids, { status: 'DONE', done_at: _now(), last_ack: resp || null });
            }

            _stats.sent += batch.length;
            _stats.acked += batch.length;

            const dt = _now() - t0;
            _stats.lastDurationMs = dt;
            _stats.lastRateOps = dt > 0 ? Math.round((batch.length * 1000) / dt) : batch.length;

            backoffMs = 0;
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

        // Reverter status SENDING → PENDING com retry++ quando possível
        try {
          const db = await _openDB();
          try {
            const store = _tx(db, 'readwrite');
            // scan small: convert any SENDING back to PENDING (best-effort)
            const all = await _reqToPromise(store.getAll());
            for (const rec of (all || [])) {
              if (!rec) continue;
              if (rec.status !== 'SENDING') continue;
              rec.retry_count = (rec.retry_count || 0) + 1;
              rec.last_error = String(err || '');
              if (rec.retry_count >= MAX_RETRIES) {
                rec.status = 'DEAD';
                rec.dead_at = _now();
              } else {
                rec.status = 'PENDING';
              }
              await _reqToPromise(store.put(rec));
            }
          } finally {
            try { db.close(); } catch (_) {}
          }
        } catch (_) {
          // ignore
        }

        // Backoff only on errors
        backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(BASE_BACKOFF_MS, (backoffMs || BASE_BACKOFF_MS) * 2));
        _emitProgress({ error: String(err || ''), backoffMs });
        await _sleep(backoffMs);

      } finally {
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

    syncNow() {
      // Forced drain until idle once (useful for manual button)
      _enabled = true;
      return _drainLoop({ force: true });
    },

    status() {
      return {
        enabled: _enabled,
        running: _running,
        lastError: _lastError ? String(_lastError) : null,
        lastCycleAt: _lastCycleAt,
        stats: { ..._stats },
      };
    },
  };

  window.VSC_RELAY = VSC_RELAY;

  // Auto-start when app loads
  try {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      VSC_RELAY.start();
    } else {
      window.addEventListener('DOMContentLoaded', () => VSC_RELAY.start(), { once: true });
    }
  } catch (_) {}

})();
