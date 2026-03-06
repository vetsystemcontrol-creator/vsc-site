/**
 * login.js — VSC Login Handler
 * - Aguarda VSC_AUTH estar pronto
 * - Popula select de usuários
 * - Após login bem-sucedido, honra ?next= (retorna à página solicitada)
 * - Fallback: /dashboard
 */
(function () {
  "use strict";

  var DASHBOARD = "/dashboard";

  // Lê parâmetro da query string
  function qs(key) {
    try {
      var params = new URLSearchParams(location.search);
      return params.get(key) || "";
    } catch (_) {
      var m = location.search.match(new RegExp("[?&]" + key + "=([^&]*)"));
      return m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : "";
    }
  }

  // Destino após login: ?next= se for do mesmo domínio, senão dashboard
  function getRedirectTarget() {
    var next = qs("next");
    if (!next) return DASHBOARD;
    try {
      var url = new URL(decodeURIComponent(next));
      // Só aceita mesmo domínio (segurança: evita open redirect)
      if (url.hostname !== location.hostname) return DASHBOARD;
      return url.pathname + (url.search || "") + (url.hash || "");
    } catch (_) {
      // Caminho relativo (ex: /clientes)
      if (next.startsWith("/") && !next.startsWith("//")) return next;
      return DASHBOARD;
    }
  }

  function setStatus(msg, type) {
    var el = document.getElementById("loginStatus");
    if (!el) return;
    el.textContent = msg;
    el.className = "status " + (type || "info");
  }

  function setLoading(loading) {
    var btn = document.getElementById("btnLogin");
    if (btn) {
      btn.disabled = loading;
      btn.textContent = loading ? "Entrando…" : "Entrar";
    }
  }

  // Popula select com usuários ativos
  async function populateUsers() {
    try {
      await window.__VSC_AUTH_READY;
      var users = await window.VSC_AUTH.listLoginUsers();
      var sel = document.getElementById("username");
      if (!sel) return;

      // Limpa opções exceto placeholder
      while (sel.options.length > 1) sel.remove(1);

      if (!users || !users.length) {
        setStatus("Nenhum usuário cadastrado. DB vazio — aguarde bootstrap.", "warn");
        return;
      }

      users.forEach(function (u) {
        var opt = document.createElement("option");
        opt.value = u.username;
        opt.textContent = u.username;
        sel.appendChild(opt);
      });

      // Se só há 1 usuário, pré-seleciona
      if (users.length === 1) sel.value = users[0].username;

      setStatus("Selecione o usuário e digite a senha.", "info");
    } catch (e) {
      setStatus("Erro ao carregar usuários: " + (e && e.message || e), "error");
    }
  }

  // Executa login
  async function doLogin() {
    var username = (document.getElementById("username") || {}).value || "";
    var password = (document.getElementById("password") || {}).value || "";

    if (!username) { setStatus("Selecione o usuário.", "warn"); return; }
    if (!password) { setStatus("Digite a senha.", "warn"); return; }

    setLoading(true);
    setStatus("Autenticando…", "info");

    try {
      await window.__VSC_AUTH_READY;
      var result = await window.VSC_AUTH.login(username, password);

      if (result && result.ok) {
        var target = getRedirectTarget();
        setStatus("Login OK! Redirecionando…", "ok");
        setTimeout(function () { location.replace(target); }, 300);
      } else {
        setLoading(false);
        setStatus("Falha no login. Verifique as credenciais.", "error");
      }
    } catch (e) {
      setLoading(false);
      setStatus((e && e.message) || "Erro ao autenticar.", "error");
    }
  }

  // Recuperação de acesso (apenas localhost)
  async function doRecover() {
    try {
      await window.__VSC_AUTH_READY;
      var result = await window.VSC_AUTH.devResetBootstrapUsers();
      if (result && result.ok) {
        setStatus(
          "Acesso recuperado. master / " + (result.master_password || "Master@1234") +
          " — troque a senha após login.",
          "warn"
        );
        await populateUsers();
      }
    } catch (e) {
      setStatus((e && e.message) || "Recuperação bloqueada fora de localhost.", "error");
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    // Botão login
    var btnLogin = document.getElementById("btnLogin");
    if (btnLogin) btnLogin.addEventListener("click", doLogin);

    // Enter no campo senha
    var pwInput = document.getElementById("password");
    if (pwInput) pwInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") doLogin();
    });

    // Recuperação
    var btnRecover = document.getElementById("btnRecover");
    if (btnRecover) btnRecover.addEventListener("click", doRecover);

    // Se já tem sessão válida, redireciona direto
    try {
      var sid = localStorage.getItem("vsc_session_id");
      if (sid) {
        var target = getRedirectTarget();
        if (target !== location.pathname) {
          setStatus("Sessão ativa. Redirecionando…", "ok");
          location.replace(target);
          return;
        }
      }
    } catch (_) {}

    setStatus("Carregando…", "info");
    populateUsers();
  });

})();
