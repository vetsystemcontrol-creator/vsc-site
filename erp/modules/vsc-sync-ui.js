/*
 * VSC-SYNC-UI — Botão único de sincronização (Premium)
 * ---------------------------------------------------
 * Mostra:
 *  - Online/Offline (dot)
 *  - Pendências (count)
 *  - Progresso (enviando X ops/s)
 *
 * Integra com:
 *  - window.VSC_RELAY.syncNow()
 *  - evento window 'vsc:sync-progress'
 */
(() => {
  'use strict';

  function $(sel) { return document.querySelector(sel); }

  function _findEls() {
    // Prefer ids (se existirem)
    const btn = $('#vscSyncBtn') || document.querySelector('[data-vsc-sync-btn]') || null;
    const dot = $('#vscSyncDot') || document.querySelector('[data-vsc-sync-dot]') || null;
    const count = $('#vscSyncCount') || document.querySelector('[data-vsc-sync-count]') || null;
    const note = $('#vscSyncNote') || document.querySelector('[data-vsc-sync-note]') || null;

    // Fallback: tenta achar pelo texto do botão
    let btn2 = btn;
    if (!btn2) {
      const candidates = Array.from(document.querySelectorAll('button,a')).filter(el =>
        (el.textContent || '').toLowerCase().includes('sincron')
      );
      btn2 = candidates[0] || null;
    }

    return { btn: btn2, dot, count, note };
  }

  const UI = {
    _els: null,
    _last: { pending: 0, running: false, rate: 0, batch: 0 },

    init() {
      this._els = _findEls();
      this._bind();
      this._render();
    },

    _bind() {
      const { btn } = this._els;
      if (btn) {
        btn.addEventListener('click', async (ev) => {
          try {
            ev.preventDefault();
            if (window.VSC_RELAY && typeof window.VSC_RELAY.syncNow === 'function') {
              await window.VSC_RELAY.syncNow();
            }
          } catch (_) {}
        });
      }

      // Network indicator
      window.addEventListener('online', () => this._render());
      window.addEventListener('offline', () => this._render());

      // Progress from relay
      window.addEventListener('vsc:sync-progress', (e) => {
        if (!e || !e.detail) return;
        this.onProgress(e.detail);
      });
    },

    onProgress(detail) {
      this._last.pending = Number(detail.pending ?? this._last.pending) || 0;
      this._last.running = !!detail.running;
      this._last.rate = Number(detail.lastRateOps ?? 0) || 0;
      this._last.batch = Number(detail.lastBatchSize ?? 0) || 0;
      this._last.error = detail.error || null;
      this._render();
    },

    _render() {
      if (!this._els) this._els = _findEls();
      const { dot, count, note, btn } = this._els;

      const online = navigator.onLine;
      if (dot) {
        dot.style.opacity = online ? '1' : '0.35';
        dot.title = online ? 'Online' : 'Offline';
      }

      if (count) {
        count.textContent = String(this._last.pending || 0);
      }

      // Mensagem compacta (sem poluir layout)
      const msg = this._last.running
        ? (this._last.rate > 0
            ? `Enviando… ${this._last.rate} ops/s`
            : 'Enviando…')
        : (this._last.error
            ? 'Falha ao sincronizar (veja console)'
            : '');

      if (note) {
        note.textContent = msg;
      } else if (btn) {
        // Tooltip se não existir label extra
        btn.title = msg || (online ? 'Sincronizar agora' : 'Offline: sincronização pendente');
      }
    }
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
