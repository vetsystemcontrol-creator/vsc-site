// vsc-cloud-sync.js — sincronização manual robusta (offline-first)
(() => {
  'use strict';

  const SYNC_KEY = 'vsc_last_sync';
  const SNAPSHOT_CACHE_KEY = 'vsc_last_snapshot_meta';
  const REMOTE_BASE = 'https://app.vetsystemcontrol.com.br';
  const SYNC_TARGET_MODE_KEY = 'vsc_sync_target_mode';
  const SNAPSHOT_TIMEOUT_MS = 20_000;
  const MANUAL_PUSH_BUDGET_MS = 45_000;
  const AUTO_SYNC_COOLDOWN_MS = 45_000;
  const AUTO_SYNC_VISIBLE_INTERVAL_MS = 120_000;
  const AUTO_SYNC_STARTUP_DELAY_MS = 4_000;
  const AUTO_SYNC_LOCK_KEY = "vsc_auto_sync_lock";

  let isSyncing = false;
  let autoSyncTimer = null;
  let autoSyncInterval = null;
  let lastAutoSyncAt = 0;

  function nowIso() {
    return new Date().toISOString();
  }

  function notifyUI(status, message = '', extra = {}) {
    try {
      window.dispatchEvent(new CustomEvent('vsc:sync:status', {
        detail: {
          status,
          message,
          timestamp: nowIso(),
          ...extra,
        },
      }));
    } catch (_) {}
  }

  function notifyProgress(pct, label, extra = {}) {
    notifyUI('progress', label || '', { progressPct: Math.max(0, Math.min(100, Number(pct) || 0)), progressLabel: label || '', ...extra });
  }

  async function auditUx(kind, record = {}) {
    try {
      if (window.VSC_DB && typeof window.VSC_DB.appendUxAudit === 'function') {
        await window.VSC_DB.appendUxAudit({ kind, category: 'sync', level: record.level || 'info', ...record });
      }
    } catch (_) {}
  }

  let queuedManualSync = false;

  function shouldShowUserToast(extra) {
    return !(extra && extra.interactive === false);
  }

  function markAutoSyncLock() {
    try { localStorage.setItem(AUTO_SYNC_LOCK_KEY, String(Date.now())); } catch (_) {}
  }

  function recentlyAutoSynced() {
    try {
      const ts = Number(localStorage.getItem(AUTO_SYNC_LOCK_KEY) || '0') || 0;
      return ts > 0 && (Date.now() - ts) < AUTO_SYNC_COOLDOWN_MS;
    } catch (_) {
      return false;
    }
  }

  async function waitForCoreReady(timeoutMs = 20000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        const dbReady = !!(window.__VSC_DB_READY_FIRED || window.VSC_DB?.openDB);
        const authReady = !!(window.__VSC_AUTH_READY_FIRED || window.VSC_AUTH);
        if (dbReady && authReady) return true;
      } catch (_) {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  async function autoSyncNow(reason = 'background', options = {}) {
    if (!navigator.onLine || document.visibilityState === 'hidden') {
      return { ok: false, skipped: true, reason: 'offline_or_hidden' };
    }
    if (isSyncing) return { ok: false, skipped: true, reason: 'sync_in_progress' };
    if (!options.force && (recentlyAutoSynced() || (Date.now() - lastAutoSyncAt) < AUTO_SYNC_COOLDOWN_MS)) {
      return { ok: false, skipped: true, reason: 'cooldown' };
    }

    markAutoSyncLock();
    lastAutoSyncAt = Date.now();

    try {
      const result = await manualSync({ interactive: false, reason });
      return result;
    } catch (err) {
      notifyUI('error', String(err && (err.message || err) || 'auto_sync_failed'), { interactive: false, reason, background: true });
      return { ok: false, error: String(err && (err.message || err) || err), reason };
    }
  }

  function scheduleAutoSync(reason = 'background', options = {}) {
    if (autoSyncTimer) clearTimeout(autoSyncTimer);
    const delayMs = Math.max(0, Number(options.delayMs || 0));
    autoSyncTimer = setTimeout(() => {
      autoSyncNow(reason, options).catch(() => {});
    }, delayMs);
  }

  function setupAutoSync() {
    if (window.__VSC_AUTO_SYNC_INIT__) return;
    window.__VSC_AUTO_SYNC_INIT__ = true;

    waitForCoreReady().then((ready) => {
      if (!ready) return;
      scheduleAutoSync('startup', { delayMs: AUTO_SYNC_STARTUP_DELAY_MS, force: true });
    }).catch(() => {});

    window.addEventListener('online', () => scheduleAutoSync('online', { delayMs: 1500, force: true }));
    window.addEventListener('focus', () => scheduleAutoSync('focus', { delayMs: 1000 }));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') scheduleAutoSync('visible', { delayMs: 1200 });
    });

    autoSyncInterval = setInterval(() => {
      if (!navigator.onLine) return;
      if (document.visibilityState === 'hidden') return;
      scheduleAutoSync('interval');
    }, AUTO_SYNC_VISIBLE_INTERVAL_MS);
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

  function getHost() {
    try {
      return String(location.hostname || '').toLowerCase();
    } catch (_) {
      return '';
    }
  }

  function isLocalDev() {
    const host = getHost();
    return host === '127.0.0.1' || host === 'localhost';
  }

  function getSyncTargetMode() {
    try {
      return String(localStorage.getItem(SYNC_TARGET_MODE_KEY) || '').trim().toLowerCase();
    } catch (_) {
      return '';
    }
  }

  function resolveRemoteBase() {
    try {
      const proto = String(location.protocol || '').toLowerCase();
      if (proto === 'file:') return REMOTE_BASE;
      if (proto === 'http:' && isLocalDev()) {
        return getSyncTargetMode() === 'remote' ? REMOTE_BASE : location.origin;
      }
    } catch (_) {}
    return location.origin;
  }

  async function getRuntimeContext() {
    try {
      if (window.VSC_DB && typeof window.VSC_DB.getRuntimeContext === 'function') {
        return await window.VSC_DB.getRuntimeContext();
      }
    } catch (_) {}
    try {
      return {
        tenant: normalizeTenantId(localStorage.getItem('vsc_tenant') || sessionStorage.getItem('vsc_tenant') || 'tenant-default'),
        token: String(localStorage.getItem('vsc_local_token') || sessionStorage.getItem('vsc_local_token') || localStorage.getItem('vsc_token') || sessionStorage.getItem('vsc_token') || '').trim(),
        sessionId: String(localStorage.getItem('vsc_session_id') || sessionStorage.getItem('vsc_session_id') || '').trim(),
        userLabel: 'anonymous',
      };
    } catch (_) {
      return { tenant: 'tenant-default', token: '', sessionId: '', userLabel: 'anonymous' };
    }
  }

  async function status() {
    const ctx = await getRuntimeContext();
    return {
      tenant: normalizeTenantId(ctx.tenant || 'tenant-default'),
      syncing: !!isSyncing,
      last_sync: localStorage.getItem(SYNC_KEY) || null,
      api_base: resolveRemoteBase(),
      target_mode: getSyncTargetMode() || (isLocalDev() ? 'local' : 'same-origin'),
      authorized: !!(ctx.token || ctx.sessionId),
    };
  }

  async function buildCommonHeaders() {
    const ctx = await getRuntimeContext();
    const headers = {
      Accept: 'application/json',
      'X-VSC-Tenant': normalizeTenantId(ctx.tenant || 'tenant-default'),
    };
    if (ctx.userLabel) headers['X-VSC-User'] = ctx.userLabel;
    if (ctx.token) {
      headers['X-VSC-Token'] = ctx.token;
      headers['Authorization'] = `Bearer ${ctx.token}`;
    }
    if (ctx.sessionId) headers['X-VSC-Client-Session'] = ctx.sessionId;
    return headers;
  }

  function isCrossOriginUrl(url) {
    try {
      return new URL(url, location.href).origin !== location.origin;
    } catch (_) {
      return false;
    }
  }

  function withTenantParam(url, tenant) {
    try {
      const u = new URL(url, location.href);
      if (!u.searchParams.get('tenant')) u.searchParams.set('tenant', normalizeTenantId(tenant || 'tenant-default'));
      return u.toString();
    } catch (_) {
      return url;
    }
  }

  const STORE_ALIAS_MAP = Object.freeze({
    produtos: 'produtos_master',
    produtos_master: 'produtos_master',
    produtos_lotes: 'produtos_lotes',
    servicos: 'servicos_master',
    servicos_master: 'servicos_master',
    exames: 'exames_master',
    exames_master: 'exames_master',
    clientes: 'clientes_master',
    clientes_master: 'clientes_master',
    animais: 'animais_master',
    animais_master: 'animais_master',
    atendimentos: 'atendimentos_master',
    atendimentos_master: 'atendimentos_master',
    contas_pagar: 'contas_pagar',
    contas_receber: 'contas_receber',
    fornecedores: 'fornecedores_master',
    fornecedores_master: 'fornecedores_master',
    fechamentos: 'fechamentos',
    repro_cases: 'repro_cases',
    repro_exams: 'repro_exams',
    repro_protocols: 'repro_protocols',
    repro_events: 'repro_events',
    repro_pregnancy: 'repro_pregnancy',
    repro_foaling: 'repro_foaling',
    repro_tasks: 'repro_tasks',
    config_params: 'config_params',
    config_audit_log: 'config_audit_log',
    auth_users: 'auth_users',
    auth_roles: 'auth_roles',
    auth_role_permissions: 'auth_role_permissions',
    auth_sessions: 'auth_sessions',
    auth_audit_log: 'auth_audit_log',
    user_profiles: 'user_profiles',
    business_audit_log: 'business_audit_log',
  ux_audit_log: 'ux_audit_log',
    estoque_movimentos: 'estoque_movimentos',
    estoque_saldos: 'estoque_saldos',
    import_ledger: 'import_ledger',
    estoque_reasons: 'estoque_reasons',
    tenant_subscription: 'tenant_subscription',
    billing_events: 'billing_events',
    animais_racas: 'animais_racas',
    animais_pelagens: 'animais_pelagens',
    animais_especies: 'animais_especies',
    animal_vitals_history: 'animal_vitals_history',
    animal_vaccines: 'animal_vaccines',
    documentos: 'documents',
    documents: 'documents',
    empresa: 'empresa',
  });

  function normalizeRequestedStores(rawValues) {
    const values = Array.isArray(rawValues) ? rawValues : [rawValues];
    const out = [];
    const seen = new Set();

    for (const raw of values) {
      if (raw == null) continue;
      const parts = Array.isArray(raw) ? raw : String(raw).split(',');
      for (const part of parts) {
        const cleaned = String(part || '').trim();
        if (!cleaned) continue;
        const key = cleaned.toLowerCase();
        const normalized = STORE_ALIAS_MAP[key] || STORE_ALIAS_MAP[cleaned] || '';
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        out.push(normalized);
      }
    }

    return out;
  }

  function buildStoreScopeKey(storeNames = []) {
    const normalized = normalizeRequestedStores(storeNames);
    return normalized.length ? normalized.join(',') : '*';
  }

  function withRequestedStores(url, storeNames = []) {
    const normalized = normalizeRequestedStores(storeNames);
    try {
      const u = new URL(url, location.href);
      u.searchParams.delete('store');
      u.searchParams.delete('stores');
      if (normalized.length) u.searchParams.set('stores', normalized.join(','));
      return u.toString();
    } catch (_) {
      return url;
    }
  }

  function buildSnapshotRequestOptions(url, headers = {}) {
    const crossOrigin = isCrossOriginUrl(url);
    const baseHeaders = { Accept: 'application/json', ...headers };
    return {
      method: 'GET',
      headers: baseHeaders,
      cache: 'no-store',
      credentials: crossOrigin ? 'omit' : 'include',
      mode: crossOrigin ? 'cors' : 'same-origin',
    };
  }

  async function apiCandidates(storeNames = []) {
    const requestedStores = normalizeRequestedStores(storeNames);
    const base = resolveRemoteBase();
    const urls = [];
    const preferLocalOnly = isLocalDev() && getSyncTargetMode() === 'local';
    const ctx = await getRuntimeContext();
    const tenant = normalizeTenantId(ctx.tenant || 'tenant-default');

    if (base) {
      urls.push(withRequestedStores(withTenantParam(`${base}/api/sync/pull`, tenant), requestedStores));
      urls.push(withRequestedStores(withTenantParam(`${base}/api/state?action=pull`, tenant), requestedStores));
    }

    if (!preferLocalOnly && location.origin && base !== location.origin && !isLocalDev()) {
      urls.push(withRequestedStores(withTenantParam(`${location.origin}/api/sync/pull`, tenant), requestedStores));
      urls.push(withRequestedStores(withTenantParam(`${location.origin}/api/state?action=pull`, tenant), requestedStores));
    }

    if (preferLocalOnly || !isLocalDev()) {
      urls.push(withRequestedStores(withTenantParam('/api/sync/pull', tenant), requestedStores));
      urls.push(withRequestedStores(withTenantParam('/api/state?action=pull', tenant), requestedStores));
    }

    return Array.from(new Set(urls));
  }

  function makeTimeoutController(timeoutMs) {
    const controller = new AbortController();
    const safeTimeout = Math.max(1, Number(timeoutMs) || 1);
    const timer = setTimeout(() => {
      try {
        controller.abort(new Error(`timeout_${safeTimeout}ms`));
      } catch (_) {
        try { controller.abort(); } catch (__){}
      }
    }, safeTimeout);
    return {
      controller,
      clear() { clearTimeout(timer); },
    };
  }

  async function fetchWithTimeout(url, options, timeoutMs, label) {
    const wrapped = makeTimeoutController(timeoutMs);
    try {
      const credentials = options && Object.prototype.hasOwnProperty.call(options, 'credentials') ? options.credentials : 'include';
      return await fetch(url, { ...options, credentials, signal: wrapped.controller.signal });
    } catch (err) {
      const name = err && err.name ? String(err.name) : '';
      if (name === 'AbortError' || String(err || '').includes('timeout_')) {
        throw new Error(label || `timeout_${timeoutMs}ms`);
      }
      throw err;
    } finally {
      wrapped.clear();
    }
  }

  function snapshotMetrics(body) {
    const data = body && body.snapshot && body.snapshot.data && typeof body.snapshot.data === 'object'
      ? body.snapshot.data
      : {};
    const stores = Object.keys(data);
    let rows = 0;
    for (const storeName of stores) {
      const list = data[storeName];
      if (Array.isArray(list)) rows += list.length;
    }
    const revision = Number(
      body && body.revision ||
      body && body.meta && body.meta.state_revision ||
      0
    ) || 0;

    return {
      rows,
      stores: stores.length,
      revision,
      score: (rows * 1000000) + (revision * 1000) + stores.length,
    };
  }

  function readSnapshotCacheMeta() {
    try {
      return JSON.parse(localStorage.getItem(SNAPSHOT_CACHE_KEY) || '{}') || {};
    } catch (_) {
      return {};
    }
  }

  function writeSnapshotCacheMeta(meta) {
    try {
      localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify(meta || {}));
    } catch (_) {}
  }

  async function fetchCandidate(url, options = {}) {
    const scopeKey = buildStoreScopeKey(options.storeNames || []);
    const cacheMeta = readSnapshotCacheMeta();
    const cacheBucket = cacheMeta[url] && typeof cacheMeta[url] === 'object' ? cacheMeta[url] : {};
    const scopeCache = cacheBucket[scopeKey] && typeof cacheBucket[scopeKey] === 'object' ? cacheBucket[scopeKey] : {};
    const knownEtag = scopeCache.etag ? String(scopeCache.etag) : '';
    const headers = await buildCommonHeaders();
    if (knownEtag) headers['If-None-Match'] = knownEtag;
    const requestOptions = buildSnapshotRequestOptions(url, headers);

    const response = await fetchWithTimeout(
      url,
      requestOptions,
      SNAPSHOT_TIMEOUT_MS,
      `snapshot_timeout_${SNAPSHOT_TIMEOUT_MS}ms`
    );

    if (response.status === 304) {
      return {
        url,
        body: null,
        not_modified: true,
        metrics: {
          rows: Number(scopeCache.rows || 0) || 0,
          stores: Number(scopeCache.stores || 0) || 0,
          revision: Number(scopeCache.revision || 0) || 0,
          score: Number(scopeCache.score || 0) || 0,
        },
      };
    }

    if (!response.ok) {
      throw new Error(`pull_http_${response.status}`);
    }

    const body = await response.json();
    if (!(body && body.ok && body.snapshot && body.snapshot.data)) {
      throw new Error('pull_invalid_payload');
    }

    const metrics = snapshotMetrics(body);
    writeSnapshotCacheMeta({
      ...cacheMeta,
      [url]: {
        ...cacheBucket,
        [scopeKey]: {
          etag: response.headers.get('ETag') || null,
          rows: metrics.rows,
          stores: metrics.stores,
          revision: metrics.revision,
          score: metrics.score,
        },
      },
    });

    return {
      url,
      body,
      not_modified: false,
      metrics,
    };
  }

  async function fetchSnapshot(options = {}) {
    const requestedStores = normalizeRequestedStores(options.storeNames || []);
    const urls = await apiCandidates(requestedStores);
    let lastErr = null;
    let best = null;
    let saw304 = false;

    for (const url of urls) {
      try {
        const candidate = await fetchCandidate(url, { storeNames: requestedStores });

        if (candidate.not_modified) {
          saw304 = true;
          try {
            console.info('[VSC_SYNC] snapshot não modificado', {
              url: candidate.url,
              revision: candidate.metrics.revision,
            });
          } catch (_) {}
          if (!best || candidate.metrics.score > best.metrics.score) best = candidate;
          continue;
        }

        try {
          console.info('[VSC_SYNC] snapshot candidato', {
            url: candidate.url,
            rows: candidate.metrics.rows,
            stores: candidate.metrics.stores,
            revision: candidate.metrics.revision,
          });
        } catch (_) {}

        if (!best || candidate.metrics.score > best.metrics.score) best = candidate;

        if (!isLocalDev()) {
          return { ok: true, payload: candidate.body, source: candidate.url, not_modified: false };
        }
      } catch (err) {
        lastErr = err;
        try {
          console.warn('[VSC_SYNC] snapshot falhou', { url, error: String(err && (err.message || err) || err) });
        } catch (_) {}
      }
    }

    if (best && best.body) {
      try {
        console.info('[VSC_SYNC] snapshot escolhido', {
          url: best.url,
          rows: best.metrics.rows,
          stores: best.metrics.stores,
          revision: best.metrics.revision,
        });
      } catch (_) {}
      return { ok: true, payload: best.body, source: best.url, not_modified: false };
    }

    if ((best && best.not_modified) || saw304) {
      return { ok: true, payload: null, source: best && best.url || null, not_modified: true };
    }

    throw lastErr || new Error('pull_failed');
  }

  async function applySnapshot(snapshot, options = {}) {
    if (!snapshot || !snapshot.data) {
      return { ok: true, importedStores: [] };
    }

    const db = await window.VSC_DB.openDB();
    try {
      const localStores = Array.from(db.objectStoreNames || []);
      const requestedStores = normalizeRequestedStores(options.storeNames || []);
      const requestedStoreSet = new Set(requestedStores);
      const requireScopeMatch = requestedStoreSet.size > 0;
      const protectedStores = new Set([
        'auth_users',
        'auth_sessions',
        'auth_audit_log',
        'auth_role_permissions',
        'auth_roles',
        'backup_events',
        'db_backups',
        'attachments_queue',
      ]);

      const filteredData = {};
      for (const [store, rows] of Object.entries(snapshot.data || {})) {
        if (!localStores.includes(store) || protectedStores.has(store)) continue;
        if (requireScopeMatch && !requestedStoreSet.has(store)) continue;
        filteredData[store] = Array.isArray(rows) ? rows : [];
      }

      if (requireScopeMatch) {
        const payloadStores = Object.keys(filteredData);
        const missingStores = requestedStores.filter((store) => !Object.prototype.hasOwnProperty.call(filteredData, store));
        const unexpectedStores = Object.keys(snapshot.data || {}).filter((store) => localStores.includes(store) && !protectedStores.has(store) && !requestedStoreSet.has(store));
        if (missingStores.length || unexpectedStores.length || payloadStores.length !== requestedStores.length) {
          throw new Error(`pull_scope_mismatch:${JSON.stringify({ requested: requestedStores, payload: payloadStores, missing: missingStores, unexpected: unexpectedStores })}`);
        }
      }

      const filteredSchema = {
        ...(snapshot.schema || {}),
        db_name: (snapshot.schema && snapshot.schema.db_name) || 'vsc_db',
        stores: Object.keys(filteredData),
      };

      await window.VSC_DB.importDump(
        {
          meta: snapshot.meta || {},
          schema: filteredSchema,
          data: filteredData,
        },
        { mode: 'merge_newer' }
      );

      try {
        const empresaRows = filteredData.empresa;
        if (Array.isArray(empresaRows) && empresaRows.length) {
          if (window.VSC_DB && typeof window.VSC_DB.mirrorEmpresaSnapshotToLocalStorage === 'function') {
            window.VSC_DB.mirrorEmpresaSnapshotToLocalStorage(empresaRows[0]);
          } else {
            localStorage.setItem('vsc_empresa_v1', JSON.stringify(empresaRows[0]));
          }
        }
      } catch (_) {}

      return { ok: true, importedStores: Object.keys(filteredData) };
    } finally {
      try { db.close(); } catch (_) {}
    }
  }

  async function pullNow(options = {}) {
    const interactive = options && options.interactive !== false;
    if (isSyncing) { notifyUI('queued', 'Sincronização já em andamento. A próxima rodada foi enfileirada.', { interactive }); queuedManualSync = true; return { ok: true, queued: true, reason: 'sync_in_progress' }; }
    if (!navigator.onLine) {
      notifyUI('offline', '', { interactive });
      return { ok: false, error: 'offline' };
    }

    isSyncing = true;
    notifyUI('syncing', '', { interactive, phase: 'push+pull' });

    try {
      const requestedStores = normalizeRequestedStores(options.storeNames || []);
      const result = await fetchSnapshot({ storeNames: requestedStores });
      if (result.not_modified) {
        localStorage.setItem(SYNC_KEY, nowIso());
        notifyUI('success', '', { phase: 'pull', not_modified: true, interactive });
        return { ok: true, pulled: false, not_modified: true };
      }

      const applied = await applySnapshot(result.payload.snapshot, { storeNames: requestedStores });
      localStorage.setItem(SYNC_KEY, nowIso());
      notifyUI('success', '', { phase: 'pull', applied, source: result.source, interactive });
      return { ok: true, pulled: true, applied, source: result.source };
    } catch (err) {
      notifyUI('error', String(err && (err.message || err) || 'pull_failed'), { interactive, phase: 'pull' });
      throw err;
    } finally {
      isSyncing = false;
    }
  }

  async function resolveRelay() {
    let relay = (window.VSC_RELAY && typeof window.VSC_RELAY.syncNow === 'function') ? window.VSC_RELAY : null;
    if (!relay && typeof window.VSC_LOAD_RELAY === 'function') {
      try {
        relay = await window.VSC_LOAD_RELAY();
      } catch (_) {
        relay = null;
      }
    }
    return relay;
  }

  async function manualSync(options = {}) {
    const interactive = options && options.interactive !== false;
    if (isSyncing) { notifyUI('queued', 'Sincronização já em andamento. A próxima rodada foi enfileirada.', { interactive }); queuedManualSync = true; return { ok: true, queued: true, reason: 'sync_in_progress' }; }
    if (!navigator.onLine) {
      notifyUI('offline', '', { interactive });
      return { ok: false, error: 'offline' };
    }

    isSyncing = true;
    notifyUI('syncing', '', { interactive, phase: 'push+pull' });
    notifyProgress(5, 'Preparando sincronização', { interactive, phase: 'prepare' });
    await auditUx('sync_started', { message: 'Sincronização iniciada', interactive: !!interactive, path: location.pathname });

    try {
      notifyProgress(15, 'Inicializando relay e analisando fila local', { interactive, phase: 'prepare' });
      const relay = await resolveRelay();
      let pushResult = null;

      if (relay && typeof relay.syncNow === 'function') {
        notifyProgress(40, 'Enviando pendências locais', { interactive, phase: 'push' });
        pushResult = await relay.syncNow({
          budgetMs: MANUAL_PUSH_BUDGET_MS,
          keepAliveOnBudget: true,
        });
      }

      const relayStatus = relay && typeof relay.status === 'function' ? relay.status() : null;
      const openItems = Number(relayStatus && (relayStatus.total_open ?? relayStatus.pending) || 0) || 0;

      if (openItems > 0) {
        localStorage.setItem(SYNC_KEY, nowIso());
        notifyProgress(65, `Push parcial concluído. ${openItems} item(ns) seguem em segundo plano.`, { interactive, phase: 'push' });
        notifyUI(
          'partial',
          `Envio parcial concluído. ${openItems} item(ns) seguem em segundo plano.`,
          { phase: 'push', pushResult, pending: openItems, interactive }
        );
        await auditUx('sync_partial', { level: 'warn', message: `Push parcial concluído. ${openItems} pendência(s) seguem em segundo plano.`, pending: openItems, path: location.pathname });
        return {
          ok: false,
          error: 'push_pending',
          partial: true,
          pushed: !!(pushResult && (pushResult.ackedDelta || pushResult.acked || pushResult.last_sent)),
          pushResult,
          pending: openItems,
        };
      }

      notifyProgress(75, 'Buscando snapshot remoto', { interactive, phase: 'pull' });
      const result = await fetchSnapshot();
      if (result.not_modified) {
        localStorage.setItem(SYNC_KEY, nowIso());
        notifyProgress(100, 'Sincronização concluída. Snapshot sem alterações.', { interactive, phase: 'done' });
        notifyUI('success', '', { phase: 'push+pull', pushResult, not_modified: true, interactive });
        await auditUx('sync_success', { message: 'Sincronização concluída sem alterações remotas.', path: location.pathname, not_modified: true });
        return {
          ok: true,
          pushed: !!(pushResult && pushResult.ackedDelta),
          pushResult,
          not_modified: true,
        };
      }

      notifyProgress(88, 'Aplicando snapshot local', { interactive, phase: 'merge' });
      const applied = await applySnapshot(result.payload.snapshot);
      localStorage.setItem(SYNC_KEY, nowIso());
      notifyProgress(100, 'Sincronização concluída', { interactive, phase: 'done', applied });
      notifyUI('success', '', { phase: 'push+pull', pushResult, applied, source: result.source, interactive });
      await auditUx('sync_success', { message: 'Sincronização concluída com snapshot aplicado.', path: location.pathname, importedStores: applied && applied.importedStores ? applied.importedStores.length : 0 });
      return {
        ok: true,
        pushed: !!(pushResult && pushResult.ackedDelta),
        pushResult,
        applied,
        source: result.source,
      };
    } catch (err) {
      notifyUI('error', String(err && (err.message || err) || 'manual_sync_failed'), { interactive });
      notifyProgress(100, 'Falha na sincronização', { interactive, phase: 'error' });
      await auditUx('sync_error', { level: 'error', message: String(err && (err.message || err) || 'manual_sync_failed'), path: location.pathname });
      throw err;
    } finally {
      isSyncing = false;
      if (queuedManualSync) {
        queuedManualSync = false;
        setTimeout(() => { manualSync({ interactive: false, reason: 'queued_followup' }).catch(() => {}); }, 250);
      }
    }
  }

  window.VSC_CLOUD_SYNC = {
    status,
    pullNow,
    manualSync,
    syncNow: manualSync,
    getLastSync: () => localStorage.getItem(SYNC_KEY) || null,
  };
})();
