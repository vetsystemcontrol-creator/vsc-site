/**
 * vsc-topbar.js — Integração da topbar iframe com a página host
 * Garante que o iframe topbar.html fique sincronizado com a navegação
 * e que a altura seja ajustada corretamente.
 */
(function(){
  "use strict";

  var TOPBAR_FRAME_ID = "vscTopbarFrame";
  var TOPBAR_HEIGHT   = 86; // px

  function getFrame(){
    return document.getElementById(TOPBAR_FRAME_ID);
  }

  function ensureFrameStyles(){
    var f = getFrame();
    if(!f) return;
    f.style.width   = "100%";
    f.style.height  = TOPBAR_HEIGHT + "px";
    f.style.border  = "0";
    f.style.display = "block";
    f.style.background = "#fff";
  }

  // Notifica a topbar para remarcar o link ativo após navegação SPA
  function notifyActive(){
    try{
      var f = getFrame();
      if(!f || !f.contentWindow) return;
      f.contentWindow.postMessage({ type: "VSC_NAV_UPDATE", path: location.pathname }, "*");
    }catch(_){}
  }

  document.addEventListener("DOMContentLoaded", function(){
    ensureFrameStyles();
    notifyActive();
  });

  window.addEventListener("popstate", notifyActive);

  // Escuta mensagens da topbar (ex: logout solicitado pelo iframe)
  window.addEventListener("message", function(ev){
    try{
      if(!ev || !ev.data) return;
      var d = ev.data;
      if(d.type === "VSC_LOGOUT"){
        if(window.VSC_AUTH && typeof window.VSC_AUTH.logout === "function"){
          window.VSC_AUTH.logout().then(function(){
            location.replace("/login");
          }).catch(function(){
            localStorage.removeItem("vsc_session_id");
            location.replace("/login");
          });
        } else {
          localStorage.removeItem("vsc_session_id");
          location.replace("/login");
        }
      }
      if(d.type === "VSC_NAVIGATE" && d.href){
        location.href = d.href;
      }
    }catch(_){}
  });

})();
