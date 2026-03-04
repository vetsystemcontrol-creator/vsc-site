/* ============================================================
 * UI GLOBAL — ENTERPRISE FEEDBACK (Contrato 4.6)
 * - Toast central (não-bloqueante, auto-hide) para sucesso/info/aviso
 * - Modal confirm/critical (bloqueante) para ações destrutivas / erro crítico
 * - Sem alert()/confirm() nativos
 * - Console limpo (sem console.*)
 * ============================================================ */
(function(){
  "use strict";

  // Idempotente: não redeclara
  if (window.VSC_UI && window.VSC_UI.__enterprise_v1) return;

  var UI = window.VSC_UI || {};
  UI.__enterprise_v1 = true;

  function el(id){ return document.getElementById(id); }

  function ensureToast(){
    var t = el("vscToastCenter");
    if (t) return t;

    t = document.createElement("div");
    t.id = "vscToastCenter";
    t.setAttribute("aria-live","polite");
    t.setAttribute("role","status");
    t.style.cssText = [
      "position:fixed",
      "left:12px","right:12px","top:18px",
      "z-index:99999",
      "max-width:720px",
      "margin:0 auto",
      "display:none",
      "padding:12px 14px",
      "border-radius:14px",
      "border:1px solid rgba(0,0,0,.10)",
      "box-shadow:0 18px 60px rgba(0,0,0,.18)",
      "font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif",
      "font-weight:800",
      "letter-spacing:.2px"
    ].join(";");
    document.body.appendChild(t);
    return t;
  }

  function toastStyle(kind){
    // kind: ok | info | warn | err
    if (kind === "ok")  return { bg:"#ecfdf5", bd:"#86efac", fg:"#065f46", icon:"✓" };
    if (kind === "warn")return { bg:"#fffbeb", bd:"#fde68a", fg:"#92400e", icon:"!" };
    if (kind === "err") return { bg:"#fef2f2", bd:"#fecaca", fg:"#991b1b", icon:"×" };
    return { bg:"#eff6ff", bd:"#bfdbfe", fg:"#1e3a8a", icon:"i" }; // info
  }

  var toastTimer = null;

  UI.toast = function(kind, message, opts){
    try{
      var o = opts || {};
      var t = ensureToast();
      var s = toastStyle(kind || "info");
      t.style.background = s.bg;
      t.style.borderColor = s.bd;
      t.style.color = s.fg;

      t.innerHTML = "<span style='display:inline-flex;align-items:center;gap:10px;'>"
        + "<span style='width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;border-radius:999px;border:1px solid rgba(0,0,0,.10);background:#fff;font-weight:900;'>"+ s.icon +"</span>"
        + "<span style='font-weight:900;'>" + escapeHtml(String(message || "")) + "</span>"
        + "</span>";

      t.style.display = "block";

      if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
      if (!o.persist){
        toastTimer = setTimeout(function(){
          t.style.display = "none";
        }, Math.max(1200, o.ms || 2600));
      }
    }catch(_e){}
  };

  function ensureConfirm(){
    var ov = el("vscConfirmOverlay");
    var md = el("vscConfirmModal");
    if (ov && md) return { ov:ov, md:md };

    ov = document.createElement("div");
    ov.id = "vscConfirmOverlay";
    ov.style.cssText = [
      "position:fixed","inset:0",
      "background:rgba(0,0,0,.35)",
      "z-index:99998",
      "display:none",
      "align-items:center",
      "justify-content:center",
      "padding:18px"
    ].join(";");

    md = document.createElement("div");
    md.id = "vscConfirmModal";
    md.setAttribute("role","dialog");
    md.setAttribute("aria-modal","true");
    md.style.cssText = [
      "width:min(720px, 100%)",
      "background:#fff",
      "border-radius:18px",
      "border:1px solid rgba(0,0,0,.10)",
      "box-shadow:0 18px 60px rgba(0,0,0,.22)",
      "overflow:hidden",
      "font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif"
    ].join(";");

    md.innerHTML = ""
      + "<div id='vscConfirmHead' style='padding:14px 16px;border-bottom:1px solid rgba(0,0,0,.08);display:flex;justify-content:space-between;gap:10px;align-items:flex-start;'>"
      + "  <div>"
      + "    <div id='vscConfirmTitle' style='font-size:16px;font-weight:900;'>Confirmação</div>"
      + "    <div id='vscConfirmSub' style='margin-top:4px;font-size:12px;opacity:.75;font-weight:700;'>Ação requer confirmação</div>"
      + "  </div>"
      + "  <button id='vscConfirmX' type='button' style='width:40px;height:40px;border-radius:12px;border:1px solid rgba(0,0,0,.10);background:#fff;cursor:pointer;font-weight:900;'>×</button>"
      + "</div>"
      + "<div id='vscConfirmBody' style='padding:16px; font-size:14px; line-height:1.35; font-weight:700;'></div>"
      + "<div id='vscConfirmFoot' style='padding:14px 16px;border-top:1px solid rgba(0,0,0,.08);display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;'>"
      + "  <button id='vscConfirmCancel' type='button' style='height:44px;border-radius:12px;border:1px solid rgba(0,0,0,.12);background:#fff;padding:0 14px;cursor:pointer;font-weight:900;'>Cancelar</button>"
      + "  <button id='vscConfirmOk' type='button' style='height:44px;border-radius:12px;border:1px solid rgba(31,143,74,.25);background:#1f8f4a;color:#fff;padding:0 14px;cursor:pointer;font-weight:900;'>Confirmar</button>"
      + "</div>";

    ov.appendChild(md);
    document.body.appendChild(ov);

    return { ov:ov, md:md };
  }

  function showConfirm(cfg, onDone){
    var ui = ensureConfirm();
    var ov = ui.ov;

    var title = (cfg && cfg.title) ? String(cfg.title) : "Confirmação";
    var body  = (cfg && cfg.body)  ? String(cfg.body)  : "Deseja confirmar esta ação?";
    var okTxt = (cfg && cfg.okText)? String(cfg.okText): "Confirmar";
    var ccTxt = (cfg && cfg.cancelText)? String(cfg.cancelText): "Cancelar";
    var kind  = (cfg && cfg.kind) ? String(cfg.kind) : "warn"; // warn | err | ok | info

    el("vscConfirmTitle").textContent = title;
    el("vscConfirmBody").textContent = body;
    el("vscConfirmOk").textContent = okTxt;
    el("vscConfirmCancel").textContent = ccTxt;

    // Estilo do botão OK por severidade
    var okBtn = el("vscConfirmOk");
    if (kind === "err"){
      okBtn.style.background = "#b91c1c";
      okBtn.style.borderColor = "rgba(185,28,28,.35)";
    } else if (kind === "ok"){
      okBtn.style.background = "#1f8f4a";
      okBtn.style.borderColor = "rgba(31,143,74,.35)";
    } else {
      okBtn.style.background = "#b45309";
      okBtn.style.borderColor = "rgba(180,83,9,.35)";
    }

    function cleanup(result){
      ov.style.display = "none";
      document.removeEventListener("keydown", onKey);
      // remove handlers
      el("vscConfirmX").onclick = null;
      el("vscConfirmCancel").onclick = null;
      el("vscConfirmOk").onclick = null;
      ov.onclick = null;
      if (typeof onDone === "function") onDone(!!result);
    }

    function onKey(e){
      if (e.key === "Escape") { e.preventDefault(); cleanup(false); }
      if (e.key === "Enter")  { e.preventDefault(); cleanup(true); }
    }

    el("vscConfirmX").onclick = function(){ cleanup(false); };
    el("vscConfirmCancel").onclick = function(){ cleanup(false); };
    el("vscConfirmOk").onclick = function(){ cleanup(true); };
    ov.onclick = function(ev){
      if (ev && ev.target === ov) cleanup(false);
    };

    document.addEventListener("keydown", onKey);

    ov.style.display = "flex";
    try{ el("vscConfirmOk").focus(); }catch(_e){}
  }

  UI.confirm = function(cfg, cb){
    showConfirm(cfg, function(ok){
      try{ if (typeof cb === "function") cb(!!ok); }catch(_e){}
    });
  };

  UI.confirmAsync = function(cfg){
    return new Promise(function(resolve){
      UI.confirm(cfg, function(ok){ resolve(!!ok); });
    });
  };

  // Erro crítico: modal persistente com botão único OK
  UI.critical = function(title, body){
    showConfirm(
      { title: title || "Erro crítico", body: body || "Ocorreu um erro crítico.", okText:"OK", cancelText:"", kind:"err" },
      function(_ok){ /* OK */ }
    );
    // some screens want to fail-closed: caller decides throw
  };

  function escapeHtml(s){
    return s.replace(/[&<>"']/g, function(c){
      return ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" })[c] || c;
    });
  }

  window.VSC_UI = UI;
})();
