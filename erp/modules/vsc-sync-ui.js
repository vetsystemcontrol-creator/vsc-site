/*
 * VSC-SYNC-UI — Botão único de sincronização (Premium)
 * ----------------------------------------------------
 * Correção anti-travamento visual do fluxo de sync.
 */
(() => {
  'use strict';

  function $(selector) {
    return document.querySelector(selector);
  }

  function findEls() {
    const btn = $('#vscSyncBtn') || document.querySelector('[data-vsc-sync-btn]') || null;
    const dot = $('#vscNetDot') || $('#vscSyncDot') || document.querySelector('[data-vsc-sync-dot]') || null;
    const count = $('#vscSyncPending') || $('#vscSyncCount') || document.querySelector('[data-vsc-sync-count]') || null;
    const note = $('#vscSyncNote') || document.querySelector('[data-vsc-sync-note]') || null;
    return { btn, dot, count, note };
  }

  function formatTime(iso) {
    if (!iso) return '';
    try {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      return date.toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch (_) {
      return '';
    }
  }

  const UI = {
    _els: null,
    _last: {
      pending: 0,
      sending: 0,
      running: false,
      rate: 0,
      batch: 0,
      error: null,
      note: null,
      mode: 'idle',
      lastSync: null,
    },
    _firstSyncDone: false,
    _manualSyncInFlight: false,

    init() {
      this._els = findEls();
      this._bind();
      try {
        this._last.lastSync = window.VSC_CLOUD_SYNC && typeof window.VSC_CLOUD_SYNC.getLastSync === 'function'
          ? window.VSC_CLOUD_SYNC.getLastSync()
          : localStorage.getItem('vsc_last_sync');
      } catch (_) {
        this._last.lastSync = null;
      }
      this._render();
    },

    _bind() {
      const { btn } = this._els;
      if (btn && !btn.__vscSyncBound) {
        btn.__vscSyncBound = true;
        btn.addEventListener('click', async (ev) => {
          ev.preventDefault();

          try {
            const parentWin = window.parent;
            if (parentWin && parentWin !== window) {
              if (typeof this.openOfficialPanel === 'function') {
                const opened = await this.openOfficialPanel(parentWin);
                if (opened) return;
              }
              parentWin.postMessage({ type: 'VSC_SYNC_PANEL_OPEN' }, '*');
              return;
            }
          } catch (_) {}

          await this._doSync();
        });
      }

      window.addEventListener('online', () => this._render());
      window.addEventListener('offline', () => this._render());

      window.addEventListener('vsc:sync-progress', (event) => {
        if (!event || !event.detail) return;
        this.onProgress(event.detail);
      });

      window.addEventListener('vsc:sync:status', (event) => {
        if (!event || !event.detail) return;
        const { status, message, pending } = event.detail;

        if (status === 'syncing') {
          this._last.running = true;
          this._last.error = null;
          this._last.note = 'Sincronizando…';
          this._render();
          return;
        }

        if (status === 'success') {
          this._last.running = false;
          this._last.error = null;
          this._last.note = null;
          try {
            this._last.lastSync = window.VSC_CLOUD_SYNC && typeof window.VSC_CLOUD_SYNC.getLastSync === 'function'
              ? window.VSC_CLOUD_SYNC.getLastSync()
              : localStorage.getItem('vsc_last_sync');
          } catch (_) {}

          this._render();
          return;
        }

        if (status === 'partial') {
          this._last.running = false;
          this._last.error = null;
          this._last.pending = Number(pending ?? this._last.pending) || 0;
          this._last.note = message || 'Sincronização parcial concluída.';
          try {
            this._last.lastSync = window.VSC_CLOUD_SYNC && typeof window.VSC_CLOUD_SYNC.getLastSync === 'function'
              ? window.VSC_CLOUD_SYNC.getLastSync()
              : localStorage.getItem('vsc_last_sync');
          } catch (_) {}
          this._render();
          return;
        }

        if (status === 'error') {
          this._last.running = false;
          this._last.error = message || 'Falha ao sincronizar';
          this._last.note = null;
          this._render();
          return;
        }

        if (status === 'offline') {
          this._last.running = false;
          this._last.note = 'Offline';
          this._render();
        }
      });
    },

    async openOfficialPanel(targetWindow) {
      const hostWindow = targetWindow || (() => {
        try {
          return window.parent && window.parent !== window ? window.parent : window;
        } catch (_) {
          return window;
        }
      })();

      try {
        if (hostWindow.VSC_SYNC_PANEL && typeof hostWindow.VSC_SYNC_PANEL.open === 'function') {
          hostWindow.VSC_SYNC_PANEL.open();
          return true;
        }
        const doc = hostWindow.document;
        if (!doc) return false;
        if (!doc.querySelector('script[data-vsc-sync-panel-loader="1"]')) {
          const s = doc.createElement('script');
          s.src = '/modules/vsc-sync-panel.js';
          s.dataset.vscSyncPanelLoader = '1';
          await new Promise((resolve, reject) => {
            s.onload = resolve;
            s.onerror = reject;
            doc.head.appendChild(s);
          });
        }
        if (hostWindow.VSC_SYNC_PANEL && typeof hostWindow.VSC_SYNC_PANEL.open === 'function') {
          hostWindow.VSC_SYNC_PANEL.open();
          return true;
        }
      } catch (_) {}
      return false;
    },

    async _doSync() {
      if (this._manualSyncInFlight) return;

      this._manualSyncInFlight = true;
      this._last.running = true;
      this._last.error = null;
      this._last.note = 'Sincronizando…';
      this._render();

      try {
        if (window.VSC_CLOUD_SYNC && typeof window.VSC_CLOUD_SYNC.manualSync === 'function') {
          await window.VSC_CLOUD_SYNC.manualSync();
        } else if (window.VSC_RELAY && typeof window.VSC_RELAY.syncNow === 'function') {
          await window.VSC_RELAY.syncNow();
        }
      } catch (err) {
        this._last.error = String(err && (err.message || err)) || 'Falha ao sincronizar';
      } finally {
        this._manualSyncInFlight = false;
        this._last.running = false;
        this._render();
      }
    },

    onProgress(detail) {
      this._last.pending = Number(detail.total_open ?? detail.pending ?? this._last.pending) || 0;
      this._last.sending = Number(detail.sending ?? this._last.sending) || 0;
      this._last.running = !!detail.running;
      this._last.rate = Number(detail.lastRateOps ?? detail.last_rate_ops ?? 0) || 0;
      this._last.batch = Number(detail.lastBatchSize ?? detail.last_batch_size ?? 0) || 0;
      this._last.mode = detail.mode || this._last.mode;
      this._last.error = detail.error || null;

      if (detail.continuedInBackground) {
        this._last.note = 'Envio em segundo plano.';
      } else if (detail.idle) {
        this._last.note = null;
      }

      this._render();
    },

    _render() {
      if (!this._els) this._els = findEls();
      const { dot, count, note, btn } = this._els;
      const online = navigator.onLine;

      if (dot) {
        dot.style.background = online
          ? (this._last.error ? 'var(--vsc-danger,#e53)' : 'var(--vsc-green,#2fb26a)')
          : '#aaa';
        dot.style.opacity = online ? '1' : '0.5';
        dot.title = online ? 'Online' : 'Offline';
      }

      if (count) {
        count.textContent = String(this._last.pending || 0);
      }

      const defaultMessage = (() => {
        if (!online) return 'Offline';
        if (this._last.error) return 'Falha ao sincronizar';
        if (this._last.running) {
          if (this._last.rate > 0) return `Enviando… ${this._last.rate} ops/s`;
          return 'Sincronizando…';
        }
        if (this._last.note) return this._last.note;
        const lastTime = formatTime(this._last.lastSync);
        return lastTime ? `Base sincronizada às ${lastTime}` : 'Pronto para sincronizar';
      })();

      if (note) {
        note.textContent = defaultMessage;
      } else if (btn) {
        btn.title = defaultMessage;
      }

      if (btn) {
        btn.disabled = this._manualSyncInFlight;
      }
    },
  };

  window.VSC_SYNC_UI = UI;

  try {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      UI.init();
    } else {
      window.addEventListener('DOMContentLoaded', () => UI.init(), { once: true });
    }
  } catch (_) {}
})();
