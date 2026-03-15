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

  try{ document.documentElement.classList.add("vsc-premium-root"); document.body && document.body.classList.add("vsc-premium"); }catch(_e){}

  function ensureCanonicalStyles(){
    try{
      var href = "modules/vsc-ui.css?v=20260307f";
      var already = document.querySelector('link[data-vsc-ui="canonical"]');
      if(already) return;
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.setAttribute('data-vsc-ui', 'canonical');
      (document.head || document.documentElement).appendChild(link);
    }catch(_e){}
  }

  function detectPageName(){
    try{
      var p = String(location.pathname || '').split('?')[0].split('#')[0];
      p = p.substring(p.lastIndexOf('/') + 1) || 'dashboard.html';
      return p.toLowerCase().replace(/\.html$/,'');
    }catch(_e){ return 'app'; }
  }

  function enhancePageShell(){
    try{
      var page = detectPageName();
      document.body && document.body.setAttribute('data-page', page);
      document.documentElement.classList.add('vsc-premium-root');
      if(document.body){
        document.body.classList.add('vsc-premium');
        document.body.classList.add('vsc-page-' + page.replace(/[^a-z0-9_-]/g,''));
      }
      ['wrap','module','page','container'].forEach(function(cls){
        document.querySelectorAll('.' + cls).forEach(function(el){ el.classList.add('vsc-shell'); });
      });
      var shell = document.querySelector('.page, .wrap, .module, .container');
      if(shell) shell.classList.add('vsc-shell');
      document.querySelectorAll('.card').forEach(function(el){ el.classList.add('vsc-card'); });
      document.querySelectorAll('table').forEach(function(tbl){ tbl.classList.add('vsc-data-table'); });
      document.querySelectorAll('.tableShell,.list-table,.table-wrap').forEach(function(el){ el.classList.add('vsc-table-shell'); });
      document.querySelectorAll('.panel-hd').forEach(function(el){ el.classList.add('page-header'); });
      document.querySelectorAll('.sub').forEach(function(el){ el.classList.add('page-header__sub'); });
      var h1 = document.querySelector('.panel-hd h1, .page-header h1, h1');
      if(h1 && shell && !shell.querySelector('.page-header') && h1.parentElement){ h1.parentElement.classList.add('page-header'); }
      var topbar = document.getElementById('vscTopbarFrame');
      if(topbar){ topbar.style.height = '86px'; topbar.style.display = 'block'; topbar.classList.add('vsc-topbar-frame'); }
      if(page === 'contasapagar'){
        var panel = document.querySelector('.panel');
        var hd = panel && panel.querySelector('.panel-hd');
        if(panel && hd && !panel.querySelector('.ap-hero')){
          var hero = document.createElement('section');
          hero.className = 'card-hero ap-hero';
          hero.innerHTML = ''
            + '<div class="page-hero">'
            + '  <div style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap;">'
            + '    <div><div style="font-size:.76rem;font-weight:900;letter-spacing:.08em;text-transform:uppercase;color:#5f746a;">Financeiro · contas a pagar</div><h2 style="margin:6px 0 8px;font-size:1.7rem;">Central premium de obrigações</h2><div class="sub">Fornecedor, XML, recebimento, estoque e título financeiro tratados no mesmo fluxo operacional.</div></div>'
            + '    <div class="toolbar"><span class="pill ok">Workflow auditável</span><span class="pill warn">Duplicidade protegida</span><span class="pill">Offline-first</span></div>'
            + '  </div>'
            + '  <div class="page-hero__meta">'
            + '    <div class="metric-card"><div class="lbl">Matching</div><div class="val" id="apHeroMatch">2-way / 3-way</div><div class="hint">pedido · recebimento · fatura</div></div>'
            + '    <div class="metric-card"><div class="lbl">Controle</div><div class="val" id="apHeroControle">Lotes + XML</div><div class="hint">chave fiscal, fornecedor e estoque</div></div>'
            + '    <div class="metric-card"><div class="lbl">Exceções</div><div class="val" id="apHeroExcecoes">Fila controlada</div><div class="hint">pendências rastreáveis para revisão</div></div>'
            + '    <div class="metric-card"><div class="lbl">Pagamentos</div><div class="val" id="apHeroPagamentos">Programação</div><div class="hint">baixa, estorno e auditoria mínima</div></div>'
            + '  </div>'
            + '</div>';
          hd.insertAdjacentElement('afterend', hero);
        }
      }
    }catch(_e){}
  }



  function bindTopbarAutoFit(){
    try{
      if(window.__vscTopbarAutoFitBound) return;
      window.__vscTopbarAutoFitBound = true;

      var fit = function(){
        try{
          var frame = document.getElementById('vscTopbarFrame');
          if(!frame) return;
          var d = frame.contentDocument;
          if(!d) return;
          var h = Math.max(
            d.documentElement ? d.documentElement.scrollHeight : 0,
            d.body ? d.body.scrollHeight : 0,
            86
          );
          frame.style.height = h + 'px';
          frame.style.display = 'block';
          frame.classList.add('vsc-topbar-frame');
          var hdr = document.querySelector('.cmdbar');
          if(hdr) hdr.style.top = h + 'px';
        }catch(_e){}
      };

      var bind = function(){
        var frame = document.getElementById('vscTopbarFrame');
        if(!frame || frame.__vscAutoFitBound) return;
        frame.__vscAutoFitBound = true;
        frame.addEventListener('load', fit);
        setTimeout(fit, 80);
        setTimeout(fit, 220);
        setTimeout(fit, 600);
      };

      if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once:true });
      else bind();
      window.addEventListener('resize', fit);
    }catch(_e){}
  }

  function bindGlobalEscapeClose(){
    try{
      if(window.__vscEscapeCloseBound) return;
      window.__vscEscapeCloseBound = true;
      document.addEventListener('keydown', function(ev){
        if(!ev || ev.key !== 'Escape') return;
        ['vscAnimalModal','vscItemModal','vscAttachModal','vscPrintModal'].forEach(function(id){
          try{
            var m = document.getElementById(id);
            if(!m) return;
            if(m.classList.contains('hidden')) return;
            m.classList.add('hidden');
            m.setAttribute('aria-hidden','true');
          }catch(_e){}
        });
      });
    }catch(_e){}
  }


  function standardizeOperationalUI(){
    try{
      var page = detectPageName();
      if(document.body) document.body.classList.add('vsc-standardized');
      document.querySelectorAll('table').forEach(function(tbl){
        tbl.classList.add('vsc-standardized');
        var heads = Array.from(tbl.querySelectorAll('thead th'));
        heads.forEach(function(th){
          var txt = String(th.textContent || '').trim().toLowerCase();
          if(txt === 'animal(is)'){
            th.textContent = 'Paciente';
            th.setAttribute('data-vsc-col','animalis');
          }
          if(txt === 'animal') th.setAttribute('data-vsc-col','animal');
          if(/n[ºo]|número|código/.test(txt)) th.setAttribute('data-vsc-col','numero');
          if(/cliente|proprietário|tutor/.test(txt)) th.setAttribute('data-vsc-col','cliente');
          if(/data/.test(txt)) th.setAttribute('data-vsc-col','data');
          if(/total|valor/.test(txt)) th.setAttribute('data-vsc-col','valor');
          if(/status/.test(txt)) th.setAttribute('data-vsc-col','status');
        });
        tbl.querySelectorAll('tbody tr').forEach(function(tr){
          var tds = Array.from(tr.children || []);
          tds.forEach(function(td, idx){
            var col = heads[idx] ? String(heads[idx].getAttribute('data-vsc-col') || '') : '';
            var text = String(td.textContent || '').trim();
            if(idx === 0 || col === 'numero' || col === 'valor' || col === 'status') td.classList.add('vsc-value-cell');
            else if(col === 'cliente' || col === 'animal' || col === 'animalis' || col === 'data') td.classList.add('vsc-value-soft');
            if(/^(r\$|atd-|imp-|orcamento|em atendimento|finalizado|cancelado)/i.test(text)) td.classList.add('vsc-value-cell');
          });
        });
      });
      document.querySelectorAll('input, textarea, select').forEach(function(el){
        var on = function(){
          var v = '';
          try{ v = (el.type === 'checkbox' || el.type === 'radio') ? (el.checked ? '1' : '') : String(el.value || '').trim(); }catch(_e){}
          if(v) el.classList.add('vsc-has-value'); else el.classList.remove('vsc-has-value');
        };
        if(!el.__vscValueBound){
          el.__vscValueBound = true;
          el.addEventListener('input', on);
          el.addEventListener('change', on);
        }
        on();
      });
      document.querySelectorAll('.card.head,.head').forEach(function(el){ el.classList.add('page-head-card'); });
    }catch(_e){}
  }

  ensureCanonicalStyles();
  bindTopbarAutoFit();
  bindGlobalEscapeClose();
  if(document.readyState === 'loading'){ document.addEventListener('DOMContentLoaded', function(){ enhancePageShell(); standardizeOperationalUI(); }, {once:true}); } else { enhancePageShell(); standardizeOperationalUI(); }

  function ensureChoice(){
    var ov = document.getElementById("vscChoiceOverlay");
    if(ov) return ov;
    ov = document.createElement("div");
    ov.id = "vscChoiceOverlay";
    ov.style.cssText = [
      "position:fixed","inset:0","background:rgba(0,0,0,.35)","display:none",
      "align-items:center","justify-content:center","padding:18px","z-index:99997"
    ].join(";");
    ov.innerHTML = ""
      + "<div style='width:min(760px,100%);background:#fff;border-radius:18px;border:1px solid rgba(0,0,0,.10);box-shadow:0 18px 60px rgba(0,0,0,.22);overflow:hidden;'>"
      + "  <div style='padding:14px 16px;border-bottom:1px solid rgba(0,0,0,.08);display:flex;justify-content:space-between;gap:10px;align-items:flex-start;'>"
      + "    <div><div id='vscChoiceTitle' style='font-size:16px;font-weight:900;'>Escolha uma opção</div><div id='vscChoiceSub' style='margin-top:4px;font-size:12px;opacity:.75;font-weight:700;'></div></div>"
      + "    <button id='vscChoiceClose' type='button' style='width:40px;height:40px;border-radius:12px;border:1px solid rgba(0,0,0,.10);background:#fff;cursor:pointer;font-weight:900;'>×</button>"
      + "  </div>"
      + "  <div id='vscChoiceBody' style='padding:16px;display:grid;gap:10px;'></div>"
      + "  <div style='padding:14px 16px;border-top:1px solid rgba(0,0,0,.08);display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;'>"
      + "    <button id='vscChoiceCancel' type='button' style='height:44px;border-radius:12px;border:1px solid rgba(0,0,0,.12);background:#fff;padding:0 14px;cursor:pointer;font-weight:900;'>Cancelar</button>"
      + "  </div>"
      + "</div>";
    document.body.appendChild(ov);
    return ov;
  }

  UI.choiceAsync = function(cfg){
    return new Promise(function(resolve){
      var ov = ensureChoice();
      var title = document.getElementById("vscChoiceTitle");
      var sub = document.getElementById("vscChoiceSub");
      var body = document.getElementById("vscChoiceBody");
      title.textContent = String((cfg && cfg.title) || "Escolha uma opção");
      sub.textContent = String((cfg && cfg.subtitle) || "");
      body.innerHTML = "";
      var options = (cfg && Array.isArray(cfg.options)) ? cfg.options : [];
      options.forEach(function(opt){
        var btn = document.createElement("button");
        btn.type = "button";
        btn.style.cssText = [
          "text-align:left","padding:14px 16px","border-radius:14px","border:1px solid rgba(0,0,0,.10)",
          "background:#fff","cursor:pointer","display:grid","gap:4px"
        ].join(";");
        btn.innerHTML = "<span style='font-weight:900;color:#0f172a;'>" + escapeHtml(String(opt.label||"Opção")) + "</span>"
          + (opt.description ? "<span style='font-size:12px;color:#64748b;font-weight:700;'>" + escapeHtml(String(opt.description)) + "</span>" : "");
        btn.onclick = function(){ cleanup(opt.value); };
        body.appendChild(btn);
      });

      function cleanup(value){
        ov.style.display = "none";
        document.getElementById("vscChoiceClose").onclick = null;
        document.getElementById("vscChoiceCancel").onclick = null;
        ov.onclick = null;
        document.removeEventListener("keydown", onKey);
        resolve(value === undefined ? null : value);
      }
      function onKey(e){ if(e.key === "Escape"){ e.preventDefault(); cleanup(null); } }
      document.getElementById("vscChoiceClose").onclick = function(){ cleanup(null); };
      document.getElementById("vscChoiceCancel").onclick = function(){ cleanup(null); };
      ov.onclick = function(ev){ if(ev.target === ov) cleanup(null); };
      document.addEventListener("keydown", onKey);
      ov.style.display = "flex";
    });
  };

  window.VSC_UI = UI;
})();
