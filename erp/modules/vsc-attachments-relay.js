/* =====================================================================
 * VSC-ATTACHMENTS-RELAY — Sincronização de Anexos com R2
 * =====================================================================
 * Drena a fila IDB (attachments_queue) enviando cada anexo para
 * POST /api/attachments?action=upload no R2.
 *
 * Expõe:
 *   window.VSC_ATTACHMENTS_RELAY.syncNow()
 *   window.VSC_ATTACHMENTS_RELAY.status()
 *   window.VSC_ATTACHMENTS_RELAY.enqueue(atendimento_id, attachment)
 * ===================================================================== */
(() => {
  'use strict';

  const DB_NAME        = window.VSC_DB_NAME || 'vsc_db';
  const STORE_QUEUE    = 'attachments_queue';
  const REMOTE_BASE    = 'https://app.vetsystemcontrol.com.br';
  const MAX_RETRIES    = 5;
  const IDLE_TICK_MS   = 20000;
  const ACTIVE_TICK_MS = 500;

  let _stats = { pending: 0, sent: 0, failed: 0 };
  let _running = false;
  let _lastError = null;
  let _capabilities = null;

  // ── Helpers ─────────────────────────────────────────────────────────
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


  function _isLocalWithRemoteForced() {
    try {
      const host = String(location.hostname || '').toLowerCase();
      if (host === '127.0.0.1' || host === 'localhost') {
        const f = String(localStorage.getItem('vsc_allow_local_sync_api') || '').toLowerCase();
        return f === '1' || f === 'true' || f === 'yes';
      }
    } catch (_) {}
    return false;
  }

  function _apiBase() {
    try {
      const proto = String(location.protocol || '').toLowerCase();
      const host  = String(location.hostname || '').toLowerCase();
      if (proto === 'file:') return REMOTE_BASE;
      if ((host === '127.0.0.1' || host === 'localhost') && !_isLocalWithRemoteForced()) return REMOTE_BASE;
      if (_isLocalWithRemoteForced()) return REMOTE_BASE;
    } catch (_) {}
    return '';
  }

  function _apiUrl(path) { return `${_apiBase()}${path}`; }

  async function _getRuntimeContext() {
    try {
      if (window.VSC_DB && typeof window.VSC_DB.getRuntimeContext === 'function') {
        return await window.VSC_DB.getRuntimeContext();
      }
    } catch (_) {}
    try {
      const raw = localStorage.getItem('vsc_user') || sessionStorage.getItem('vsc_user') || '';
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch (_) { parsed = null; }
      return {
        tenant: normalizeTenantId(localStorage.getItem('vsc_tenant') || sessionStorage.getItem('vsc_tenant') || 'tenant-default'),
        userLabel: String((parsed && (parsed.username || parsed.nome || parsed.name || parsed.id || parsed.email)) || '').trim().slice(0, 120),
        sessionId: String(localStorage.getItem('vsc_session_id') || sessionStorage.getItem('vsc_session_id') || '').trim().slice(0, 120),
        token: String(localStorage.getItem('vsc_local_token') || sessionStorage.getItem('vsc_local_token') || localStorage.getItem('vsc_token') || sessionStorage.getItem('vsc_token') || '').trim(),
      };
    } catch (_) {
      return { tenant: 'tenant-default', userLabel: '', sessionId: '', token: '' };
    }
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
      req.onerror   = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_QUEUE)) {
          const st = db.createObjectStore(STORE_QUEUE, { keyPath: 'id' });
          st.createIndex('status', 'status', { unique: false });
        }
      };
    });
  }

  async function _ensureStore(db) {
    // Se o store não existe, precisamos reabrir com upgrade
    if (!db.objectStoreNames.contains(STORE_QUEUE)) {
      db.close();
      const newVersion = db.version + 1;
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, newVersion);
        req.onupgradeneeded = (e) => {
          const d = e.target.result;
          if (!d.objectStoreNames.contains(STORE_QUEUE)) {
            const st = d.createObjectStore(STORE_QUEUE, { keyPath: 'id' });
            st.createIndex('status', 'status', { unique: false });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
      });
    }
    return db;
  }

  function _req(r) {
    return new Promise((res, rej) => {
      r.onsuccess = () => res(r.result);
      r.onerror   = () => rej(r.error);
    });
  }

  async function _getPending(db) {
    const tx = db.transaction(STORE_QUEUE, 'readonly');
    const st = tx.objectStore(STORE_QUEUE);
    const all = await _req(st.getAll());
    return (all || []).filter(x => x && x.status === 'PENDING');
  }

  async function _updateRecord(db, id, patch) {
    const tx = db.transaction(STORE_QUEUE, 'readwrite');
    const st = tx.objectStore(STORE_QUEUE);
    const rec = await _req(st.get(id));
    if (!rec) return;
    Object.assign(rec, patch);
    await _req(st.put(rec));
  }

  async function _readCapabilities() {
    if (_capabilities) return _capabilities;
    try {
      const ctx = await _getRuntimeContext();
      const res = await fetch(_apiUrl('/api/state?action=capabilities'), {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'X-VSC-Tenant': ctx.tenant || 'tenant-default',
          ...(ctx.userLabel ? { 'X-VSC-User': ctx.userLabel } : {}),
          ...(ctx.sessionId ? { 'X-VSC-Client-Session': ctx.sessionId } : {}),
          ...(ctx.token ? { 'X-VSC-Token': ctx.token, 'Authorization': `Bearer ${ctx.token}` } : {}),
        },
        cache: 'no-store'
      });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        const authorized = body.authorized !== false;
        _capabilities = { ok: authorized, remote_sync_allowed: body.remote_sync_allowed !== false && authorized, authorized };
      } else {
        _capabilities = { ok: false, remote_sync_allowed: false };
      }
    } catch (_) {
      _capabilities = { ok: false, remote_sync_allowed: false };
    }
    // Reset cache após 30s
    setTimeout(() => { _capabilities = null; }, 30000);
    return _capabilities;
  }

  // ── Upload ───────────────────────────────────────────────────────────

  async function _uploadOne(item) {
    const caps = await _readCapabilities();
    if (!caps || !caps.remote_sync_allowed) throw new Error('remote_sync_not_allowed');

    const ctx = await _getRuntimeContext();
    const res = await fetch(_apiUrl('/api/attachments?action=upload'), {
      method: 'POST',
      headers: (() => {
        const headers = {
          'Content-Type': 'application/json',
          'X-VSC-Tenant': ctx.tenant || 'tenant-default',
        };
        const userLabel = ctx.userLabel || '';
        const sessionId = ctx.sessionId || '';
        const syncToken = ctx.token || '';
        if (userLabel) headers['X-VSC-User'] = userLabel;
        if (sessionId) headers['X-VSC-Client-Session'] = sessionId;
        if (syncToken) {
          headers['X-VSC-Token'] = syncToken;
          headers['Authorization'] = `Bearer ${syncToken}`;
        }
        return headers;
      })(),
      body: JSON.stringify({
        atendimento_id: item.atendimento_id,
        attachment_id:  item.attachment_id,
        filename:       item.filename,
        mime_type:      item.mime_type,
        data_base64:    item.data_base64,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`upload_failed_${res.status}: ${text.slice(0, 100)}`);
    }

    return await res.json().catch(() => ({ ok: true }));
  }

  // ── Drain loop ───────────────────────────────────────────────────────

  async function _drain({ force = false } = {}) {
    if (_running) return;
    _running = true;
    _lastError = null;

    try {
      while (true) {
        let db;
        try {
          db = await _openDB();
          db = await _ensureStore(db);
        } catch (e) {
          _lastError = e;
          break;
        }

        let pending;
        try {
          pending = await _getPending(db);
          _stats.pending = pending.length;
        } finally {
          try { db.close(); } catch (_) {}
        }

        if (!pending.length) {
          if (force) break;
          await new Promise(r => setTimeout(r, IDLE_TICK_MS));
          continue;
        }

        for (const item of pending) {
          let db2;
          try {
            db2 = await _openDB();
            await _updateRecord(db2, item.id, { status: 'SENDING', sending_at: new Date().toISOString() });
          } finally {
            try { db2.close(); } catch (_) {}
          }

          try {
            await _uploadOne(item);
            let db3 = await _openDB();
            await _updateRecord(db3, item.id, { status: 'DONE', done_at: new Date().toISOString() });
            db3.close();
            _stats.sent++;
            _stats.pending = Math.max(0, _stats.pending - 1);
          } catch (e) {
            _lastError = e;
            _stats.failed++;
            const retries = (item.retry_count || 0) + 1;
            const newStatus = retries >= MAX_RETRIES ? 'DEAD' : 'PENDING';
            let db3 = await _openDB();
            await _updateRecord(db3, item.id, {
              status: newStatus,
              retry_count: retries,
              last_error: String(e),
            });
            db3.close();
          }

          await new Promise(r => setTimeout(r, ACTIVE_TICK_MS));
        }

        if (force) break;
      }
    } finally {
      _running = false;
    }
  }

  // ── API pública ──────────────────────────────────────────────────────

  async function enqueue(atendimento_id, attachment) {
    if (!atendimento_id || !attachment || !attachment.id) return { ok: false, error: 'invalid_params' };

    const db = await _openDB().then(d => _ensureStore(d));
    try {
      const tx = db.transaction(STORE_QUEUE, 'readwrite');
      const st = tx.objectStore(STORE_QUEUE);
      const record = {
        id:             `att_${atendimento_id}_${attachment.id}`,
        atendimento_id: String(atendimento_id),
        attachment_id:  String(attachment.id),
        filename:       String(attachment.name || attachment.filename || attachment.id),
        mime_type:      String(attachment.mime || attachment.mime_type || 'application/octet-stream'),
        data_base64:    String(attachment.dataUrl || attachment.data_base64 || ''),
        status:         'PENDING',
        created_at:     new Date().toISOString(),
        retry_count:    0,
      };
      await _req(st.put(record));
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
      return { ok: true, id: record.id };
    } finally {
      try { db.close(); } catch (_) {}
    }
  }

  async function syncNow() {
    return _drain({ force: true });
  }

  function status() {
    return {
      running:    _running,
      lastError:  _lastError ? String(_lastError) : null,
      stats:      { ..._stats },
    };
  }

  // ── Init ─────────────────────────────────────────────────────────────

  window.VSC_ATTACHMENTS_RELAY = { enqueue, syncNow, status };

  // Auto-drain em background (não bloqueante)
  _drain({ force: false }).catch(() => {});

})();
