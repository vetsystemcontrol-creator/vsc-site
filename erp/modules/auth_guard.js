(function(){
  "use strict";
  // VSC AUTH GUARD (enterprise-safe, fail-safe):
  // - Evita tela branca: sempre garante que o HTML fique visível.
  // - Se não houver sessão, redireciona para login.html preservando ?next=
  // - Não depende de framework / bundler.
  try{
    var LOGIN_PAGE = "login.html";
    var KEY = "vsc_session_id";
    var html = document.documentElement;

    function isDemo(){
      try{
        var q = new URLSearchParams(location.search || "");
        var v = q.get("demo") || q.get("print") || "";
        if(v === "1" || String(v).toLowerCase() === "true") return true;
      }catch(_){}
      try{ return localStorage.getItem("vsc_demo_mode") === "1"; }catch(_){ return false; }
      return false;
    }


    function reveal(){
      try{ html.style.visibility = "visible"; }catch(_){}
    }

    function getSid(){
      try{ return localStorage.getItem(KEY); }catch(_){ return null; }
    }

    function isLogin(){
      try{
        return String(location.pathname || "").toLowerCase().endsWith("/" + LOGIN_PAGE)
          || String(location.href || "").toLowerCase().indexOf(LOGIN_PAGE) !== -1;
      }catch(_){ return false; }
    }

    function goLogin(){
      try{
        var cur = String(location && location.href ? location.href : "");
        location.replace(LOGIN_PAGE + "?next=" + encodeURIComponent(cur));
      }catch(_){}
    }

    // Fail-safe sempre
    reveal();
    setTimeout(reveal, 200);
    document.addEventListener("DOMContentLoaded", reveal, { once:true });

    var sid = getSid();

    // DEMO/PRINT MODE: não redireciona para login (apenas para apresentação/prints)
    if(isDemo()){
      try{ localStorage.setItem("vsc_demo_mode","1"); }catch(_){}
      reveal();
      setTimeout(reveal, 200);
      document.addEventListener("DOMContentLoaded", reveal, { once:true });
      return;
    }

    if(!sid && !isLogin()){
      goLogin();
      return;
    }

    // Se a sessão cair (logout em outra aba), volta pro login
    window.addEventListener("storage", function(ev){
      if(!ev) return;
      if(ev.key === KEY){
        var v = getSid();
        if(!v && !isLogin()) goLogin();
      }
    });

  }catch(_){
    try{ document.documentElement.style.visibility = "visible"; }catch(__){}
  }
})();