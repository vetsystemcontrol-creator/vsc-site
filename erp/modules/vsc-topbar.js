// topbar.js — CORRIGIDO
// Corrige: [VSC_TOPBAR] falha no sync manual TypeError: Failed to fetch (linha ~309-321)

const VSC_TOPBAR = (() => {

  let syncButton = null;
  let statusDot  = null;
  let auditInitDone = false;

  function init() {
    syncButton = document.querySelector('[data-action="sync"], .btn-sincronizar, #btn-sync');
    statusDot  = document.querySelector('.sync-status-dot, .status-indicator');

    if (syncButton) {
      // ✅ Remove listeners antigos antes de adicionar novo
      const newBtn = syncButton.cloneNode(true);
      syncButton.parentNode.replaceChild(newBtn, syncButton);
      syncButton = newBtn;

      syncButton.addEventListener('click', handleManualSync);
      console.log('[VSC_TOPBAR] Botão de sync inicializado.');
    }

    // ✅ Escuta eventos de status do sync
    window.addEventListener('vsc:sync:status', handleSyncStatus);

    // ✅ Monitora conectividade
    window.addEventListener('online',  () => updateOnlineIndicator(true));
    window.addEventListener('offline', () => updateOnlineIndicator(false));

    setupAuditMonitor();

    // Estado inicial
    updateOnlineIndicator(navigator.onLine);
  }

  // ✅ Handler do clique manual no botão SINCRONIZAR
  async function handleManualSync(event) {
    event.preventDefault();

    if (!navigator.onLine) {
      showToast('⚠️ Sem conexão com a internet.', 'warning');
      return;
    }

    setButtonState('loading');

    try {
      // ✅ Sync manual correto: push local -> cloud e depois pull cloud -> local
      let result = null;
      if (window.VSC_CLOUD_SYNC && typeof window.VSC_CLOUD_SYNC.manualSync === "function") {
        result = await window.VSC_CLOUD_SYNC.manualSync();
      } else if (window.VSC_CLOUD_SYNC && typeof window.VSC_CLOUD_SYNC.pullNow === "function") {
        result = await window.VSC_CLOUD_SYNC.pullNow();
      } else {
        throw new Error("manual_sync_unavailable");
      }

      if (result && result.partial) {
        showToast('⚠️ ' + (result.pending || 0) + ' item(ns) continuam sincronizando em segundo plano.', 'warning');
        setButtonState('idle');
        return;
      }

      if (result && result.ok === false) {
        throw new Error(result.error || 'sync_failed');
      }

    } catch (err) {
      console.error('[VSC_TOPBAR] falha no sync manual:', err.message);
      showToast('❌ Falha ao sincronizar: ' + err.message, 'error');
      setButtonState('error');
    }
  }

  // ✅ Reage aos eventos de status do sync
  function handleSyncStatus(event) {
    const { status, message, interactive } = event.detail || {};
    const shouldToast = interactive !== false;

    switch (status) {
      case 'syncing':
        setButtonState('loading');
        break;
      case 'success':
        setButtonState('success');
        if (shouldToast) showToast('✅ Sincronizado com sucesso!', 'success');
        setTimeout(() => setButtonState('idle'), 3000);
        break;
      case 'error':
        setButtonState('error');
        if (shouldToast) showToast('❌ Erro: ' + message, 'error');
        setTimeout(() => setButtonState('idle'), 5000);
        break;
      case 'queued':
        setButtonState('loading');
        if (shouldToast) showToast('ℹ️ ' + (message || 'Sincronização já está em andamento.'), 'info');
        break;
      case 'partial':
        setButtonState('idle');
        if (shouldToast) showToast('⚠️ ' + (message || 'Sincronização parcial em segundo plano.'), 'warning');
        break;
      case 'offline':
        updateOnlineIndicator(false);
        break;
    }
  }


  async function appendUxAudit(kind, payload = {}) {
    try {
      if (window.VSC_DB && typeof window.VSC_DB.appendUxAudit === 'function') {
        await window.VSC_DB.appendUxAudit({ kind, category: payload.category || 'ux', level: payload.level || 'info', path: location.pathname, ...payload });
      }
    } catch (_) {}
  }

  function setupAuditMonitor() {
    if (auditInitDone) return;
    auditInitDone = true;

    appendUxAudit('page_view', { message: document.title || 'page_view', visibility: document.visibilityState, online: navigator.onLine });

    window.addEventListener('online', () => appendUxAudit('network_online', { category: 'network', message: 'Conexão restaurada' }));
    window.addEventListener('offline', () => appendUxAudit('network_offline', { category: 'network', level: 'warn', message: 'Aplicação ficou offline' }));
    document.addEventListener('visibilitychange', () => appendUxAudit('visibility_change', { category: 'navigation', message: document.visibilityState, visibility: document.visibilityState }));
    window.addEventListener('error', (event) => {
      appendUxAudit('js_error', { category: 'error', level: 'error', message: String(event.message || 'js_error'), source: event.filename || null, line: event.lineno || null, column: event.colno || null });
    });
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event && event.reason;
      appendUxAudit('unhandled_rejection', { category: 'error', level: 'error', message: String(reason && (reason.message || reason) || 'unhandled_rejection') });
    });
    window.addEventListener('vsc:sync:status', (event) => {
      const d = event && event.detail ? event.detail : {};
      const status = String(d.status || 'unknown');
      if (status === 'progress') return;
      appendUxAudit('sync_' + status, { category: 'sync', level: status === 'error' ? 'error' : (status === 'partial' ? 'warn' : 'info'), message: d.message || status, phase: d.phase || null, interactive: d.interactive !== false, progressPct: d.progressPct || null });
    });
  }

  function setButtonState(state) {
    if (!syncButton) return;

    const states = {
      idle:    { text: 'SINCRONIZAR', disabled: false, class: '' },
      loading: { text: '⏳ Sincronizando...', disabled: true,  class: 'btn-loading' },
      success: { text: '✅ Sincronizado',    disabled: false, class: 'btn-success' },
      error:   { text: '❌ Erro no Sync',    disabled: false, class: 'btn-error'   }
    };

    const s = states[state] || states.idle;
    syncButton.textContent = s.text;
    syncButton.disabled    = s.disabled;
    syncButton.className   = syncButton.className
      .replace(/btn-(loading|success|error)/g, '')
      .trim() + (s.class ? ' ' + s.class : '');
  }

  function updateOnlineIndicator(isOnline) {
    const badge = document.querySelector('.online-badge, [data-online-status]');
    if (badge) {
      badge.textContent = isOnline ? 'ONLINE' : 'OFFLINE';
      badge.className   = badge.className
        .replace(/(online|offline)/gi, '')
        .trim() + (isOnline ? ' online' : ' offline');
    }

    // Atualiza o dot vermelho/verde
    if (statusDot) {
      statusDot.style.background = isOnline ? '#22c55e' : '#ef4444';
    }
  }

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `vsc-toast vsc-toast-${type}`;
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed; bottom: 20px; right: 20px;
      padding: 12px 20px; border-radius: 8px; z-index: 9999;
      font-weight: bold; color: white; min-width: 250px;
      background: ${{ success: '#22c55e', error: '#ef4444', warning: '#f59e0b', info: '#3b82f6' }[type]};
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      animation: slideIn 0.3s ease;
    `;

    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  // Inicializa quando DOM estiver pronto
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { init, handleManualSync };
})();