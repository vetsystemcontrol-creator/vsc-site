/*
  ============================================================
  SGQT-Version: 12.7
  Module-Version: 12.7.3
  Change-Request: CR-2026-AUTHGUARD-003
  Date: 2026-03-06T08:50:00-03:00
  Author: VSC Engineering (proposta)
  ============================================================

  VSC_AUTH_GUARD — Correção estrutural (web/Cloudflare)

  Problemas corrigidos:
  - Guard anterior podia preservar o prehide do dashboard, causando tela branca
    mesmo com sessão válida e app inicializado.
  - Era necessário garantir reveal() em páginas públicas, timeout, iframe,
    sessão válida e falhas controladas.

  Estratégia:
  - Ignorar guard em iframe (topbar)
  - Não interferir em páginas públicas
  - Aguardar AUTH com timeout controlado
  - Redirecionar para /login somente sem sessão válida
  - Sempre revelar a UI quando a navegação puder prosseguir
  ============================================================ */
(() => {
  "use strict";

  const BUILD = "SGQT12.7|auth_guard.js|PREHIDE-FIX|2026-03-06";
  const LOGIN_PATH = "/login.html";
  const LOGIN_FILE = "/login.html";
  const DASH_PATH  = "/dashboard.html";
  const DASH_FILE  = "/dashboard.html";
  const LOGOUT_FLAG_KEY = "vsc_logout_in_progress";
  const SS_GUARD_LOCK = "vsc_auth_guard_lock";
  const LOCK_MS = 1500;

  function path() {
    try { return String(location.pathname || ""); } catch (_) { return ""; }
  }

  function isLoginPage() {
    const p = path().toLowerCase();
    return p === "/login" || p === "/login.html" || p.endsWith("/login/") || p.endsWith("/login.html");
  }

  // [FIX C-02] Lista de páginas públicas (não requerem sessão)
  const PUBLIC_PAGES = ["login", "offline", "404", "index"];
  function isPublicPage() {
    const p = path().toLowerCase();
    return PUBLIC_PAGES.some(pp => p === "/" + pp || p === "/" + pp + ".html" || p.endsWith("/" + pp + "/") || p.endsWith("/" + pp + ".html") || p === "/");
  }

  function isDashboardPage() {
    const p = path().toLowerCase();
    return p === "/dashboard" || p === "/dashboard.html" || p.endsWith("/dashboard/") || p.endsWith("/dashboard.html");
  }

  function reveal() {
    try { document.documentElement.style.visibility = "visible"; } catch (_) {}
  }

  function setLock() {
    try { sessionStorage.setItem(SS_GUARD_LOCK, String(Date.now())); } catch (_) {}
  }

  function isLocked() {
    try {
      const v = Number(sessionStorage.getItem(SS_GUARD_LOCK) || "0");
      return v > 0 && (Date.now() - v) < LOCK_MS;
    } catch (_) {
      return false;
    }
  }

  function safeReplace(url) {
    setLock();
    try { location.replace(url); }
    catch (_) {
      try { location.href = url; } catch (__){ /* noop */ }
    }
  }

  function isLogoutInProgress() {
    try {
      const v = Number(sessionStorage.getItem(LOGOUT_FLAG_KEY) || "0");
      return v > 0 && (Date.now() - v) < 15000;
    } catch (_) {
      return false;
    }
  }

  function canonicalLoginUrl(nextHref) {
    const base = LOGIN_FILE || LOGIN_PATH;
    const next = nextHref || String(location.href || "");
    return base + "?next=" + encodeURIComponent(next);
  }

  function waitFor(conditionFn, timeoutMs) {
    const timeout = Number(timeoutMs || 12000);
    const step = 50;
    const start = Date.now();

    return new Promise((resolve, reject) => {
      const tick = () => {
        let ok = false;
        try { ok = !!conditionFn(); } catch (_) { ok = false; }

        if (ok) return resolve(true);
        if (Date.now() - start >= timeout) return reject(new Error("timeout"));
        setTimeout(tick, step);
      };
      tick();
    });
  }

  async function waitForAuthReady() {
    try {
      if (window.__VSC_AUTH_READY && typeof window.__VSC_AUTH_READY.then === "function") {
        await Promise.race([
          window.__VSC_AUTH_READY,
          new Promise((_, rej) => setTimeout(() => rej(new Error("__VSC_AUTH_READY timeout")), 15000)),
        ]);
        return true;
      }
    } catch (_) {}

    let signaled = false;
    const onReady = () => { signaled = true; };

    try { window.addEventListener("VSC_AUTH_READY", onReady, { once: true }); } catch (_) {}

    try {
      await waitFor(() => signaled || !!window.VSC_AUTH, 15000);
      return true;
    } catch (_) {
      return false;
    }
  }

  async function ensureBootstrap() {
    if (!window.VSC_AUTH) return false;
    if (typeof window.VSC_AUTH.bootstrap !== "function") return true;
    await Promise.race([
      window.VSC_AUTH.bootstrap(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("bootstrap timeout")), 20000)),
    ]);
    return true;
  }

  async function getCurrentUserSafe() {
    if (!window.VSC_AUTH || typeof window.VSC_AUTH.getCurrentUser !== "function") return null;
    try {
      return await Promise.race([
        window.VSC_AUTH.getCurrentUser(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("getCurrentUser timeout")), 10000)),
      ]);
    } catch (_) {
      return null;
    }
  }

  async function runGuard() {
    if (window.self !== window.top) {
      reveal();
      return;
    }

    // [FIX C-02] Páginas públicas (login, offline, 404, index raiz) — libera sem verificar sessão
    if (isPublicPage()) {
      reveal();
      return;
    }

    if (isLocked()) {
      console.warn("[VSC_AUTH_GUARD] lock ativo (anti-loop).", { build: BUILD });
      reveal();
      return;
    }

    if (isLogoutInProgress()) {
      reveal();
      return;
    }

    const ready = await waitForAuthReady();
    if (!ready) {
      console.error("[VSC_AUTH_GUARD] AUTH não ficou pronto (timeout).", { build: BUILD });
      reveal();
      return;
    }

    try {
      await ensureBootstrap();
    } catch (e) {
      console.error("[VSC_AUTH_GUARD] bootstrap falhou:", e);
      // [FIX C-02] Qualquer página autenticada redireciona para login em falha de bootstrap
      safeReplace(canonicalLoginUrl());
      return;
    }

    const user = await getCurrentUserSafe();
    if (user) {
      reveal();
      return;
    }

    // [FIX C-02] Sem sessão válida — redirecionar para login em qualquer página autenticada
    console.warn("[VSC_AUTH_GUARD] Sem sessão válida. Indo para login.", { path: path(), build: BUILD });
    safeReplace(canonicalLoginUrl());
  }

  runGuard().catch((e) => {
    console.error("[VSC_AUTH_GUARD] erro fatal:", e, { build: BUILD });
    reveal();
  });
})();
