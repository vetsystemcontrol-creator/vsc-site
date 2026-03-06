(function(){
  "use strict";
  // VSC AUTH GUARD (enterprise-safe, fail-safe) — CORRIGIDO v2
  // Suporte a Pretty URLs (/clientes, /dashboard, etc.) + URLs com .html
  // Compatível com Cloudflare Pages + wrangler deploy
  try{
    var LOGIN_PAGE_PATH  = "/login";
    var LOGIN_PAGE_HTML  = "login.html";
    var KEY = "vsc_session_id";
    var html = document.documentElement;

    function reveal(){
      try{ html.style.visibility = "visible"; }catch(_){}
    }

    function getSid(){
      try{ return localStorage.getItem(KEY); }catch(_){ return null; }
    }

    // Detecta se é a página de login (aceita /login, /login.html e variações)
    function isLogin(){
      try{
        var p = String(location.pathname || "").toLowerCase().replace(/\/+$/, "");
        var h = String(location.href || "").toLowerCase();
        return (
          p === "/login" ||
          p.endsWith("/login.html") ||
          h.indexOf("login.html") !== -1
        );
      }catch(_){ return false; }
    }

    // Redireciona para login preservando ?next= para retorno após autenticação
    function goLogin(){
      try{
        var cur = String(location && location.href ? location.href : "");
        location.replace(LOGIN_PAGE_PATH + "?next=" + encodeURIComponent(cur));
      }catch(_){
        try{ location.replace(LOGIN_PAGE_HTML); }catch(__){ }
      }
    }

    // Fail-safe: sempre revela HTML (evita tela branca)
    reveal();
    setTimeout(reveal, 200);
    document.addEventListener("DOMContentLoaded", reveal, { once:true });

    var sid = getSid();
    if(!sid && !isLogin()){
      goLogin();
      return;
    }

    // Sincronização multi-aba: logout em outra aba redireciona aqui também
    window.addEventListener("storage", function(ev){
      if(!ev) return;
      if(ev.key === KEY){
        var v = getSid();
        if(!v && !isLogin()) goLogin();
      }
    });

  }catch(_){
    try{ document.documentElement.style.visibility = "visible"; }catch(__){ }
  }
})();
