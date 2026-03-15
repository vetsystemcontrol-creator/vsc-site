/*
 * VSC-SYNC-PANEL — Painel modal de sincronização
 * Abre ao clicar no botão sync da topbar
 * Mostra: status, última sync, fila pendente, histórico, erros
 */
(() => {
  'use strict';

  const MAX_HISTORY = 20;
  const HISTORY_KEY = 'vsc_sync_history';

  let _progress = { pct: 0, label: 'Aguardando sincronização', phase: 'idle' };

  // ── Histórico ────────────────────────────────────────────
  function _loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch(_) { return []; }
  }

  function _saveHistory(h) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, MAX_HISTORY))); } catch(_) {}
  }

  function _addHistory(entry) {
    const h = _loadHistory();
    h.unshift({ ...entry, ts: new Date().toISOString() });
    _saveHistory(h);
  }

  // ── CSS ──────────────────────────────────────────────────
  function _injectCSS() {
    if (document.getElementById('vsc-sync-panel-css')) return;
    const style = document.createElement('style');
    style.id = 'vsc-sync-panel-css';
    style.textContent = `
      #vscSyncPanelOverlay {
        position: fixed; inset: 0; z-index: 99999;
        background: rgba(0,0,0,.45); backdrop-filter: blur(3px);
        display: flex; align-items: center; justify-content: center;
        animation: vscFadeIn .18s ease;
      }
      @keyframes vscFadeIn { from { opacity:0 } to { opacity:1 } }
      @keyframes vscSlideUp { from { transform:translateY(24px); opacity:0 } to { transform:translateY(0); opacity:1 } }

      #vscSyncPanel {
        background: #fff; border-radius: 18px;
        width: min(520px, 96vw); max-height: 86vh;
        box-shadow: 0 24px 64px rgba(0,0,0,.18), 0 4px 16px rgba(0,0,0,.08);
        display: flex; flex-direction: column;
        animation: vscSlideUp .22s ease;
        overflow: hidden;
        font-family: 'DM Sans', system-ui, sans-serif;
      }

      #vscSyncPanel .sp-header {
        padding: 22px 24px 16px;
        border-bottom: 1px solid #f0f0f0;
        display: flex; align-items: center; justify-content: space-between;
      }
      #vscSyncPanel .sp-title {
        font-size: 17px; font-weight: 800; color: #111; letter-spacing: -.3px;
        display: flex; align-items: center; gap: 10px;
      }
      #vscSyncPanel .sp-close {
        width: 32px; height: 32px; border-radius: 50%;
        border: none; background: #f5f5f5; cursor: pointer;
        font-size: 16px; display: flex; align-items: center; justify-content: center;
        color: #666; transition: background .15s;
      }
      #vscSyncPanel .sp-close:hover { background: #ebebeb; }

      #vscSyncPanel .sp-body {
        padding: 20px 24px; overflow-y: auto; flex: 1;
        display: flex; flex-direction: column; gap: 14px;
      }

      /* Cards de status */
      #vscSyncPanel .sp-cards {
        display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
      }
      #vscSyncPanel .sp-card {
        border-radius: 12px; padding: 14px 16px;
        display: flex; flex-direction: column; gap: 4px;
      }
      #vscSyncPanel .sp-card.green  { background: #f0fdf4; border: 1.5px solid #bbf7d0; }
      #vscSyncPanel .sp-card.blue   { background: #eff6ff; border: 1.5px solid #bfdbfe; }
      #vscSyncPanel .sp-card.orange { background: #fff7ed; border: 1.5px solid #fed7aa; }
      #vscSyncPanel .sp-card.red    { background: #fef2f2; border: 1.5px solid #fecaca; }
      #vscSyncPanel .sp-card.gray   { background: #f9fafb; border: 1.5px solid #e5e7eb; }

      #vscSyncPanel .sp-card-label {
        font-size: 11px; font-weight: 700; text-transform: uppercase;
        letter-spacing: .6px; color: #6b7280;
      }
      #vscSyncPanel .sp-card-value {
        font-size: 20px; font-weight: 800; color: #111; line-height: 1.1;
      }
      #vscSyncPanel .sp-card-value.small { font-size: 13px; font-weight: 600; }
      #vscSyncPanel .sp-card-sub {
        font-size: 11px; color: #9ca3af; margin-top: 2px;
      }

      /* Botão sync */
      #vscSyncPanel .sp-sync-btn {
        width: 100%; padding: 14px;
        border-radius: 12px; border: none;
        background: #2fb26a; color: #fff;
        font-size: 15px; font-weight: 800;
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        gap: 8px; transition: background .15s, transform .1s;
        letter-spacing: -.2px;
      }
      #vscSyncPanel .sp-sync-btn:hover:not(:disabled) { background: #27a05e; transform: translateY(-1px); }
      #vscSyncPanel .sp-sync-btn:disabled { background: #9ca3af; cursor: not-allowed; transform: none; }
      #vscSyncPanel .sp-sync-btn.syncing { background: #3b82f6; }
      #vscSyncPanel .sp-sync-btn.error   { background: #ef4444; }

      /* Progresso */
      #vscSyncPanel .sp-progress-wrap {
        border: 1px solid #dbeafe; background: #f8fbff; border-radius: 12px; padding: 12px 14px;
      }
      #vscSyncPanel .sp-progress-top { display:flex; justify-content:space-between; gap:10px; margin-bottom:8px; }
      #vscSyncPanel .sp-progress-label { font-size:12px; color:#1d4ed8; font-weight:700; }
      #vscSyncPanel .sp-progress-pct { font-size:12px; color:#1d4ed8; font-weight:800; }
      #vscSyncPanel .sp-progress-bar { height:10px; border-radius:999px; background:#dbeafe; overflow:hidden; }
      #vscSyncPanel .sp-progress-fill { height:100%; width:0%; background:linear-gradient(90deg,#3b82f6,#2fb26a); transition:width .2s ease; }
      #vscSyncPanel .sp-progress-sub { margin-top:8px; font-size:11px; color:#6b7280; }

      /* Erro */
      #vscSyncPanel .sp-error-box {
        background: #fef2f2; border: 1.5px solid #fecaca;
        border-radius: 10px; padding: 12px 14px;
        font-size: 12px; color: #dc2626; font-family: monospace;
        word-break: break-all; display: none;
      }
      #vscSyncPanel .sp-error-box.visible { display: block; }

      /* Histórico */
      #vscSyncPanel .sp-section-title {
        font-size: 12px; font-weight: 700; color: #6b7280;
        text-transform: uppercase; letter-spacing: .5px;
        margin-bottom: 6px;
      }
      #vscSyncPanel .sp-history {
        display: flex; flex-direction: column; gap: 6px;
      }
      #vscSyncPanel .sp-hist-item {
        display: flex; align-items: center; gap: 10px;
        padding: 8px 12px; border-radius: 8px; background: #f9fafb;
        font-size: 12px;
      }
      #vscSyncPanel .sp-hist-dot {
        width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
      }
      #vscSyncPanel .sp-hist-dot.ok  { background: #22c55e; }
      #vscSyncPanel .sp-hist-dot.err { background: #ef4444; }
      #vscSyncPanel .sp-hist-time { color: #6b7280; font-size: 11px; margin-left: auto; white-space: nowrap; }
      #vscSyncPanel .sp-hist-msg  { color: #374151; flex: 1; }
      #vscSyncPanel .sp-empty { color: #9ca3af; font-size: 13px; text-align: center; padding: 12px 0; }

      @media (max-width: 480px) {
        #vscSyncPanel .sp-cards { grid-template-columns: 1fr 1fr; }
        #vscSyncPanel .sp-card-value { font-size: 16px; }
      }
    `;
    document.head.appendChild(style);
  }

  // ── Helpers ──────────────────────────────────────────────
  function _fmtTime(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch(_) { return iso; }
  }

  function _fmtDate(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      const hoje = new Date();
      if (d.toDateString() === hoje.toDateString()) return 'Hoje ' + _fmtTime(iso);
      return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + _fmtTime(iso);
    } catch(_) { return iso; }
  }

  function _getPending(cb) {
    try {
      const req = indexedDB.open('vsc_db');
      req.onsuccess = e => {
        try {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('sync_queue')) { cb(0); return; }
          const tx = db.transaction('sync_queue', 'readonly');
          const store = tx.objectStore('sync_queue');
          const all = store.getAll();
          all.onsuccess = e => {
            const now = Date.now();
            const pending = (e.target.result || []).filter(r => { const st = String((r && r.status) || '').trim().toUpperCase(); if (!(st === 'PENDING' || st === 'PENDENTE')) return false; const nextAt = Number((r && r.next_attempt_at) || 0) || 0; return !nextAt || nextAt <= now; }).length;
            cb(pending);
          };
          all.onerror = () => cb(0);
        } catch(_) { cb(0); }
      };
      req.onerror = () => cb(0);
    } catch(_) { cb(0); }
  }

  function _getVSC_RELAY() {
    if (window.VSC_RELAY) return window.VSC_RELAY;
    try {
      for (const f of document.querySelectorAll('iframe')) {
        if (f.contentWindow && f.contentWindow.VSC_RELAY) return f.contentWindow.VSC_RELAY;
      }
    } catch(_) {}
    return null;
  }

  function _getVSC_CLOUD_SYNC() {
    if (window.VSC_CLOUD_SYNC) return window.VSC_CLOUD_SYNC;
    try {
      for (const f of document.querySelectorAll('iframe')) {
        if (f.contentWindow && f.contentWindow.VSC_CLOUD_SYNC) return f.contentWindow.VSC_CLOUD_SYNC;
      }
    } catch(_) {}
    return null;
  }

  // ── HTML do painel ───────────────────────────────────────
  function _buildHTML() {
    return `
      <div id="vscSyncPanelOverlay">
        <div id="vscSyncPanel">
          <div class="sp-header">
            <div class="sp-title">
              <span style="font-size:20px">⟳</span>
              Sincronização
            </div>
            <button class="sp-close" id="vscSyncPanelClose">✕</button>
          </div>
          <div class="sp-body">
            <div class="sp-cards" id="vscSyncCards">
              <div class="sp-card gray">
                <div class="sp-card-label">Conexão</div>
                <div class="sp-card-value" id="spStatus">—</div>
              </div>
              <div class="sp-card gray">
                <div class="sp-card-label">Última Sync</div>
                <div class="sp-card-value small" id="spLastSync">—</div>
              </div>
              <div class="sp-card gray">
                <div class="sp-card-label">Pendentes</div>
                <div class="sp-card-value" id="spPending">—</div>
                <div class="sp-card-sub">itens na fila</div>
              </div>
              <div class="sp-card gray">
                <div class="sp-card-label">Sincronizados</div>
                <div class="sp-card-value" id="spSent">—</div>
                <div class="sp-card-sub">nesta sessão</div>
              </div>
            </div>

            <div class="sp-progress-wrap">
              <div class="sp-progress-top">
                <div class="sp-progress-label" id="spProgressLabel">Aguardando sincronização</div>
                <div class="sp-progress-pct" id="spProgressPct">0%</div>
              </div>
              <div class="sp-progress-bar"><div class="sp-progress-fill" id="spProgressFill"></div></div>
              <div class="sp-progress-sub" id="spProgressSub">O percentual representa as etapas concluídas do fluxo local → push → pull → aplicação.</div>
            </div>

            <div class="sp-error-box" id="spErrorBox"></div>

            <button class="sp-sync-btn" id="spSyncBtn">
              <span id="spSyncBtnIcon">⟳</span>
              <span id="spSyncBtnText">Sincronizar Agora</span>
            </button>

            <div>
              <div class="sp-section-title">Histórico recente</div>
              <div class="sp-history" id="spHistory">
                <div class="sp-empty">Nenhuma sincronização ainda.</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ── Renderização ─────────────────────────────────────────
  function _render(state) {
    const online = navigator.onLine;
    const relay  = _getVSC_RELAY();

    // Status card
    const statusEl = document.getElementById('spStatus');
    const statusCard = statusEl && statusEl.closest('.sp-card');
    if (statusEl) {
      statusEl.textContent = state.syncing ? 'Sincronizando…' : (online ? 'Online' : 'Offline');
      if (statusCard) {
        statusCard.className = 'sp-card ' + (state.syncing ? 'blue' : (online ? 'green' : 'orange'));
      }
    }

    // Última sync
    const lastSyncEl = document.getElementById('spLastSync');
    const lastSyncCard = lastSyncEl && lastSyncEl.closest('.sp-card');
    const lastSync = (() => { try { return localStorage.getItem('vsc_last_sync') || (window.parent !== window ? window.parent.document.querySelector('iframe').contentWindow.localStorage.getItem('vsc_last_sync') : null); } catch(_) { return null; } })()
      || (() => { try { for (const f of document.querySelectorAll('iframe')) { const v = f.contentWindow.localStorage.getItem('vsc_last_sync'); if (v) return v; } } catch(_) {} return null; })();

    if (lastSyncEl) {
      lastSyncEl.textContent = lastSync ? _fmtDate(lastSync) : 'Nunca';
      if (lastSyncCard) lastSyncCard.className = 'sp-card ' + (lastSync ? 'green' : 'gray');
    }

    // Pendentes
    _getPending(count => {
      const pendEl = document.getElementById('spPending');
      const pendCard = pendEl && pendEl.closest('.sp-card');
      if (pendEl) {
        pendEl.textContent = count;
        if (pendCard) pendCard.className = 'sp-card ' + (count > 0 ? 'orange' : 'green');
      }
    });

    // Enviados (sessão)
    const sentEl = document.getElementById('spSent');
    const sentCard = sentEl && sentEl.closest('.sp-card');
    const sent = relay ? (relay.status().sent || 0) : 0;
    if (sentEl) {
      sentEl.textContent = sent;
      if (sentCard) sentCard.className = 'sp-card ' + (sent > 0 ? 'green' : 'gray');
    }

    // Progresso
    const progressPct = document.getElementById('spProgressPct');
    const progressFill = document.getElementById('spProgressFill');
    const progressLabel = document.getElementById('spProgressLabel');
    const progressSub = document.getElementById('spProgressSub');
    if (progressPct) progressPct.textContent = Math.max(0, Math.min(100, Number(_progress.pct) || 0)) + '%';
    if (progressFill) progressFill.style.width = Math.max(0, Math.min(100, Number(_progress.pct) || 0)) + '%';
    if (progressLabel) progressLabel.textContent = _progress.label || (state.syncing ? 'Sincronizando…' : 'Aguardando sincronização');
    if (progressSub) progressSub.textContent = state.syncing
      ? 'Fluxo determinístico: preparação local → push → pull → merge local.'
      : ((_progress.phase === 'done' || _progress.pct >= 100) ? 'Última execução concluída.' : 'O percentual representa as etapas concluídas do fluxo local → push → pull → aplicação.');

    // Erro
    const errBox = document.getElementById('spErrorBox');
    if (errBox) {
      if (state.error) {
        errBox.textContent = '⚠ ' + state.error;
        errBox.classList.add('visible');
      } else {
        errBox.classList.remove('visible');
      }
    }

    // Botão
    const btn = document.getElementById('spSyncBtn');
    const btnIcon = document.getElementById('spSyncBtnIcon');
    const btnText = document.getElementById('spSyncBtnText');
    if (btn) {
      btn.disabled = state.syncing;
      btn.className = 'sp-sync-btn' + (state.syncing ? ' syncing' : (state.error ? ' error' : ''));
      if (btnIcon) btnIcon.textContent = state.syncing ? '⏳' : '⟳';
      if (btnText) btnText.textContent = state.syncing ? 'Sincronizando…' : (state.error ? 'Tentar Novamente' : 'Sincronizar Agora');
    }

    // Histórico
    _renderHistory();
  }

  function _renderHistory() {
    const container = document.getElementById('spHistory');
    if (!container) return;
    const history = _loadHistory();
    if (!history.length) {
      container.innerHTML = '<div class="sp-empty">Nenhuma sincronização ainda.</div>';
      return;
    }
    container.innerHTML = history.map(h => `
      <div class="sp-hist-item">
        <div class="sp-hist-dot ${h.ok ? 'ok' : 'err'}"></div>
        <div class="sp-hist-msg">${h.ok ? (h.msg || 'Sincronizado com sucesso') : ('Erro: ' + (h.error || 'falha'))}</div>
        <div class="sp-hist-time">${_fmtDate(h.ts)}</div>
      </div>
    `).join('');
  }

  // ── Sync ─────────────────────────────────────────────────
  let _syncing = false;
  async function _doSync() {
    if (_syncing) return;
    _syncing = true;
    _progress = { pct: 5, label: 'Preparando sincronização', phase: 'prepare' };
    _render({ syncing: true });

    try {
      const sync = _getVSC_CLOUD_SYNC();
      if (!sync) throw new Error('VSC_CLOUD_SYNC não disponível');
      const result = await sync.manualSync();
      if (result && result.queued) {
        _addHistory({ ok: true, msg: 'Sincronização já em andamento. Nova rodada enfileirada.' });
        _progress = { pct: Math.max(_progress.pct || 0, 25), label: 'Rodada adicional enfileirada', phase: 'queued' };
        _render({ syncing: false, error: null });
        return;
      }
      if (result && result.partial) {
        const msg = 'Push parcial · pendentes: ' + String(result.pending || 0);
        _addHistory({ ok: true, msg });
        _progress = { pct: 65, label: 'Push parcial concluído', phase: 'push' };
        _render({ syncing: false, error: null });
        return;
      }
      if (!result || result.ok === false) {
        throw new Error((result && result.error) || 'sync_failed');
      }
      const pushed = !!(result && result.pushed);
      const stores = result && result.applied && result.applied.importedStores;
      const deadRetried = Number(result && result.pushResult && (result.pushResult.deadRetried || result.pushResult.stats && result.pushResult.stats.deadRetried) || 0) || 0;
      const msg =
        (result && result.partial)
          ? ('Push parcial · pendentes: ' + String(result.pending || 0))
          : ('Push: ' + (pushed ? 'enviado' : 'sem pendências') +
             (deadRetried ? (' · Retry DEAD: ' + deadRetried) : '') +
             ((result && result.not_modified) ? ' · Pull: sem alterações' : (stores ? ' · Pull: ' + stores.length + ' stores' : '')));
      _addHistory({ ok: true, msg });
      _progress = { pct: 100, label: 'Sincronização concluída', phase: 'done' };
      _render({ syncing: false, error: null });
    } catch(e) {
      const err = String(e && (e.message || e));
      _addHistory({ ok: false, error: err });
      _progress = { pct: 100, label: 'Falha na sincronização', phase: 'error' };
      _render({ syncing: false, error: err });
    } finally {
      _syncing = false;
    }
  }

  // ── Abrir/Fechar ─────────────────────────────────────────
  function open() {
    if (document.getElementById('vscSyncPanelOverlay')) return;
    _injectCSS();
    document.body.insertAdjacentHTML('beforeend', _buildHTML());

    document.getElementById('vscSyncPanelClose').addEventListener('click', close);
    document.getElementById('vscSyncPanelOverlay').addEventListener('click', e => {
      if (e.target.id === 'vscSyncPanelOverlay') close();
    });
    document.getElementById('spSyncBtn').addEventListener('click', _doSync);

    window.__vscSyncPanelStatusHandler = (ev) => {
      const d = ev && ev.detail ? ev.detail : {};
      if (typeof d.progressPct === 'number' || d.progressLabel) {
        _progress = { pct: Number(d.progressPct || _progress.pct || 0), label: d.progressLabel || d.message || _progress.label, phase: d.phase || _progress.phase || 'progress' };
      } else if (d.status === 'syncing') {
        _progress = { pct: Math.max(_progress.pct || 0, 8), label: d.message || 'Sincronizando…', phase: d.phase || 'syncing' };
      } else if (d.status === 'success') {
        _progress = { pct: 100, label: 'Sincronização concluída', phase: 'done' };
      } else if (d.status === 'partial') {
        _progress = { pct: Math.max(_progress.pct || 0, 65), label: d.message || 'Push parcial concluído', phase: d.phase || 'push' };
      } else if (d.status === 'queued') {
        _progress = { pct: Math.max(_progress.pct || 0, 20), label: d.message || 'Rodada enfileirada', phase: 'queued' };
      } else if (d.status === 'error') {
        _progress = { pct: 100, label: d.message || 'Falha na sincronização', phase: 'error' };
      }
      _render({ syncing: _syncing, error: d.status === 'error' ? (d.message || null) : null });
    };
    window.addEventListener('vsc:sync:status', window.__vscSyncPanelStatusHandler);

    _render({ syncing: false, error: null });

    // Atualizar a cada 3s enquanto aberto
    window._vscSyncPanelTimer = setInterval(() => {
      if (!document.getElementById('vscSyncPanelOverlay')) { clearInterval(window._vscSyncPanelTimer); return; }
      _render({ syncing: _syncing });
    }, 3000);
  }

  function close() {
    const el = document.getElementById('vscSyncPanelOverlay');
    if (el) el.remove();
    clearInterval(window._vscSyncPanelTimer);
    if (window.__vscSyncPanelStatusHandler) {
      window.removeEventListener('vsc:sync:status', window.__vscSyncPanelStatusHandler);
      window.__vscSyncPanelStatusHandler = null;
    }
  }

  // ── Expor ─────────────────────────────────────────────────
  window.VSC_SYNC_PANEL = { open, close };

  // Escutar evento do topbar para abrir o painel
  window.addEventListener('message', e => {
    if (e.data && e.data.type === 'VSC_SYNC_PANEL_OPEN') open();
  });

})();
