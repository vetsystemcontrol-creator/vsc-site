/* ============================================================
   VSC — CONFIGURAÇÕES DE USUÁRIOS (IAM/RBAC) — v1
   - Padrão enterprise: Self-service + Administração + Master
   - Fail-closed: sem sessão => bloqueia UI
   - RBAC: ADMIN/MASTER para gestão, MASTER para governança
   - Perfil Profissional (CRMV/Assinatura): self e admin (auditado via VSC_AUTH)
   ============================================================ */
(function(){
  "use strict";

  function $(id){ return document.getElementById(id); }

  function setTopMsg(kind, text){
    var box = $("msgTop");
    if(!box) return;
    if(!kind){ box.className="msg"; box.style.display="none"; box.textContent=""; return; }
    box.style.display="block";
    box.className = "msg msg--" + (kind === "ok" ? "ok" : (kind === "warn" ? "warn" : "danger"));
    box.textContent = text || "";
  }

  function setPill(el, kind, text){
    if(!el) return;
    el.className = "pill" + (kind ? (" pill--" + kind) : "");
    el.textContent = text || "—";
  }

  function showPane(name){
    var panes = document.querySelectorAll("section[data-pane]");
    for(var i=0;i<panes.length;i++){
      panes[i].style.display = (panes[i].getAttribute("data-pane") === name) ? "" : "none";
    }
    var tabs = document.querySelectorAll("button.tab[data-pane]");
    for(var j=0;j<tabs.length;j++){
      var on = (tabs[j].getAttribute("data-pane") === name);
      tabs[j].setAttribute("aria-selected", on ? "true" : "false");
    }
  }

  // -----------------------------
  // Modal: Perfil Profissional
  // -----------------------------
  var __profState = { sigDataUrl: null, mode: "SELF" }; // SELF | ADMIN

  function profMsg(kind, text){
    var box = $("profMsg");
    if(!box) return;
    if(!kind){ box.style.display="none"; box.className="msg"; box.textContent=""; return; }
    box.style.display="block";
    box.className = "msg msg--" + (kind === "ok" ? "ok" : (kind === "warn" ? "warn" : "danger"));
    box.textContent = text || "";
  }

  function openOverlay(){
    var ov = $("vscModalOverlayProf");
    if(ov) ov.style.display = "flex";
  }
  function closeOverlay(){
    var ov = $("vscModalOverlayProf");
    if(ov) ov.style.display = "none";
  }

  function fillProfFromUser(u){
    $("profUserId").value = u.id;
    $("profUsername").value = u.username || "";
    $("profRole").value = u.role || u.role_id || "";

    var p = (u.professional || {});
    $("profFullName").value = p.full_name || "";
    $("profCrmvUf").value = (p.crmv_uf || "").toUpperCase();
    $("profCrmvNum").value = p.crmv_num || "";
    $("profPhone").value = p.phone || "";
    $("profEmail").value = p.email || "";
    $("profIsVet").checked = !!p.is_vet;
    $("profIcp").checked = !!p.icp_enabled;

    var prev = $("profSigPreview");
    if(prev){
      if(p.signature_image_dataurl){
        prev.src = p.signature_image_dataurl;
        prev.style.display = "inline-block";
        __profState.sigDataUrl = p.signature_image_dataurl;
      }else{
        prev.removeAttribute("src");
        prev.style.display = "none";
        __profState.sigDataUrl = null;
      }
    }

    var file = $("profSigFile");
    if(file) file.value = "";
  }

  async function openProfModalSelf(){
    if(!window.VSC_AUTH) throw new Error("VSC_AUTH indisponível.");
    profMsg(null,"");
    __profState.mode = "SELF";
    __profState.sigDataUrl = null;

    var u = await VSC_AUTH.getCurrentUser();
    if(!u) throw new Error("Usuário não autenticado.");

    fillProfFromUser(u);
    openOverlay();
  }

  async function openProfModalAdmin(userId){
    if(!window.VSC_AUTH) throw new Error("VSC_AUTH indisponível.");
    profMsg(null,"");
    __profState.mode = "ADMIN";
    __profState.sigDataUrl = null;

    var u = await VSC_AUTH.adminGetUser(userId);
    fillProfFromUser(u);
    openOverlay();
  }

  async function saveProfModal(){
    if(!window.VSC_AUTH) throw new Error("VSC_AUTH indisponível.");

    var userId = $("profUserId").value;
    if(!userId) throw new Error("Usuário inválido.");

    var payload = {
      is_vet: $("profIsVet").checked,
      full_name: ($("profFullName").value || "").trim(),
      crmv_uf: ($("profCrmvUf").value || "").trim().toUpperCase(),
      crmv_num: ($("profCrmvNum").value || "").trim(),
      phone: ($("profPhone").value || "").trim(),
      email: ($("profEmail").value || "").trim(),
      icp_enabled: $("profIcp").checked,
      signature_image_dataurl: __profState.sigDataUrl
    };

    // regra enterprise: se for emissor, nome completo obrigatório
    if(payload.is_vet || (payload.crmv_uf && payload.crmv_num)){
      if(!payload.full_name) throw new Error("Nome completo é obrigatório para Médico-Veterinário emissor.");
    }

    var r;
    if(__profState.mode === "ADMIN"){
      r = await VSC_AUTH.adminUpdateProfessionalProfile(userId, payload);
    } else {
      r = await VSC_AUTH.updateMyProfessionalProfile(payload);
    }

    profMsg("ok", "Perfil salvo. Campos alterados: " + ((r && r.changed && r.changed.length) ? r.changed.join(", ") : "nenhum"));

    // refresh UI
    try{ await refreshSelfSummary(); }catch(_){}
    try{ await reloadUsersTable(); }catch(_){}
  }

  function wireProfModal(){
    var closeBtns = ["btnProfClose","btnProfCancel"].map($).filter(Boolean);
    closeBtns.forEach(function(b){
      b.addEventListener("click", function(ev){ ev.preventDefault(); closeOverlay(); });
    });

    var ov = $("vscModalOverlayProf");
    if(ov){
      ov.addEventListener("click", function(ev){
        if(ev.target === ov) closeOverlay();
      });
    }

    var clear = $("btnProfSigClear");
    if(clear){
      clear.addEventListener("click", function(ev){
        ev.preventDefault();
        __profState.sigDataUrl = null;
        var prev = $("profSigPreview");
        if(prev){ prev.removeAttribute("src"); prev.style.display="none"; }
        var file = $("profSigFile");
        if(file) file.value = "";
      });
    }

    var file = $("profSigFile");
    if(file){
      file.addEventListener("change", function(){
        profMsg(null,"");
        var f = (file.files && file.files[0]) ? file.files[0] : null;
        if(!f) return;

        if(f.size > 350*1024){
          profMsg("warn", "Imagem grande (" + Math.round(f.size/1024) + "KB). Recomendo reduzir para melhor performance.");
        }

        var rd = new FileReader();
        rd.onload = function(){
          __profState.sigDataUrl = String(rd.result || "");
          var prev = $("profSigPreview");
          if(prev){
            prev.src = __profState.sigDataUrl;
            prev.style.display = "inline-block";
          }
        };
        rd.onerror = function(){
          profMsg("danger", "Falha ao ler imagem da assinatura.");
        };
        rd.readAsDataURL(f);
      });
    }

    var save = $("btnProfSave");
    if(save){
      save.addEventListener("click", async function(ev){
        ev.preventDefault();
        profMsg(null,"");
        try{
          await saveProfModal();
        }catch(e){
          profMsg("danger", e && e.message ? e.message : String(e));
        }
      });
    }
  }

  // -----------------------------
  // Admin list
  // -----------------------------
  function fmtCRMV(p){
    p = p || {};
    var uf = (p.crmv_uf || "").toUpperCase();
    var num = (p.crmv_num || "");
    if(!uf && !num) return "-";
    return (uf ? ("CRMV-" + uf) : "CRMV") + (num ? (" " + num) : "");
  }
  function fmtContato(p){
    p = p || {};
    var a = [];
    if(p.phone) a.push(p.phone);
    if(p.email) a.push(p.email);
    return a.length ? a.join(" · ") : "-";
  }
  function fmtWhen(p){
    p = p || {};
    return p.updated_at ? String(p.updated_at).replace("T"," ").replace("Z","") : "-";
  }

  async function reloadUsersTable(){
    var body = $("usersBody");
    if(!body) return;

    body.innerHTML = '<tr><td colspan="8" style="color:var(--muted); font-weight:800;">Carregando…</td></tr>';

    var rows = await VSC_AUTH.listUsers({ limit: 200 });
    if(!rows || rows.length === 0){
      body.innerHTML = '<tr><td colspan="8" style="color:var(--muted); font-weight:800;">(vazio)</td></tr>';
      return;
    }

    body.innerHTML = "";

    // Carregar detalhes (professional) com limite de concorrência (evita travamento)
    var q = rows.slice(0);
    var out = [];
    var maxConc = 6;

    async function worker(){
      while(q.length){
        var r = q.shift();
        try{
          var u = await VSC_AUTH.adminGetUser(r.id);
          out.push({ base:r, full:u });
        }catch(e){
          out.push({ base:r, full:null, err:e });
        }
      }
    }
    var ws = [];
    for(var i=0;i<maxConc;i++) ws.push(worker());
    await Promise.all(ws);

    // manter ordem original
    var byId = {};
    for(var k=0;k<out.length;k++){
      byId[out[k].base.id] = out[k];
    }

    for(var j=0;j<rows.length;j++){
      var r0 = rows[j];
      var pack = byId[r0.id];
      var u0 = pack && pack.full ? pack.full : null;
      var p = u0 && u0.professional ? u0.professional : {};

      var tr = document.createElement("tr");
      function td(txt){
        var x = document.createElement("td");
        x.textContent = txt == null ? "" : String(txt);
        return x;
      }

      tr.appendChild(td(r0.username));
      tr.appendChild(td(u0 ? (u0.role || u0.role_id || r0.role_id) : r0.role_id));
      tr.appendChild(td(r0.status));
      tr.appendChild(td(p.full_name || "-"));
      tr.appendChild(td(fmtCRMV(p)));
      tr.appendChild(td(fmtContato(p)));
      tr.appendChild(td(fmtWhen(p)));

      var tdA = document.createElement("td");

      var btnEdit = document.createElement("button");
      btnEdit.className = "btn";
      btnEdit.textContent = "Editar perfil";
      btnEdit.addEventListener("click", (function(userId){
        return function(ev){
          ev.preventDefault();
          setTopMsg(null,"");
          openProfModalAdmin(userId).catch(function(e){
            setTopMsg("danger", e && e.message ? e.message : String(e));
          });
        };
      })(r0.id));

      var btnRevoke = document.createElement("button");
      btnRevoke.className = "btn";
      btnRevoke.style.marginLeft = "8px";
      btnRevoke.textContent = "Revogar sessões";
      btnRevoke.addEventListener("click", (function(userId){
        return async function(ev){
          ev.preventDefault();
          setTopMsg(null,"");
          try{
            await VSC_AUTH.revokeAllSessionsForUser(userId, "admin_revoke");
            setTopMsg("ok", "Sessões revogadas.");
          }catch(e){
            setTopMsg("danger", e && e.message ? e.message : String(e));
          }
        };
      })(r0.id));

      tdA.appendChild(btnEdit);
      tdA.appendChild(btnRevoke);
      tr.appendChild(tdA);

      body.appendChild(tr);
    }
  }

  // -----------------------------
  // Self summary
  // -----------------------------
  async function refreshSelfSummary(){
    var u = await VSC_AUTH.getCurrentUser();
    if(!u) return;

    $("curUsername").value = u.username || "";
    $("curRole").value = u.role || u.role_id || "";
    setPill($("pillUser"), null, (u.username || "—"));
    setPill($("pillStatus"), "ok", "✅ ATIVO");

    var isAdmin = (String(u.role||"").toUpperCase() === "ADMIN" || String(u.role||"").toUpperCase() === "MASTER");
    var isMaster = (String(u.role||"").toUpperCase() === "MASTER");

    if(isAdmin){
      $("adminBox").style.display = "";
      setPill($("pillAdmin"), "ok", "✅ LIBERADO");
    }else{
      $("adminBox").style.display = "none";
      setPill($("pillAdmin"), "danger", "⛔ RESTRITO");
    }

    if(isMaster){
      setPill($("pillMaster"), "ok", "✅ LIBERADO");
    }else{
      setPill($("pillMaster"), "danger", "⛔ RESTRITO");
    }

    // Resumo do perfil
    var p = u.professional || {};
    var resumo = [];
    if(p.full_name) resumo.push(p.full_name);
    var crmv = fmtCRMV(p);
    if(crmv && crmv !== "-") resumo.push(crmv);
    var cont = fmtContato(p);
    if(cont && cont !== "-") resumo.push(cont);
    $("perfilResumo").value = resumo.length ? resumo.join(" · ") : "—";
    setPill($("pillPerfil"), p && (p.crmv_uf||p.crmv_num||p.full_name) ? "ok" : null, (p && (p.crmv_uf||p.crmv_num)) ? "CRMV OK" : "—");
  }

  // -----------------------------
  // Wire buttons
  // -----------------------------
  function wireTabs(){
    var tabs = document.querySelectorAll("button.tab[data-pane]");
    for(var i=0;i<tabs.length;i++){
      tabs[i].addEventListener("click", (function(btn){
        return function(ev){
          ev.preventDefault();
          setTopMsg(null,"");
          showPane(btn.getAttribute("data-pane"));
        };
      })(tabs[i]));
    }
  }

  function wireActions(){
    var bLogout = $("btnLogout");
    if(bLogout){
      bLogout.addEventListener("click", async function(ev){
        ev.preventDefault();
        setTopMsg(null,"");
        try{
          await VSC_AUTH.logout();
          setTopMsg("ok", "Sessão encerrada.");
          location.href = "login.html";
        }catch(e){
          setTopMsg("danger", e && e.message ? e.message : String(e));
        }
      });
    }

    var bTrocar = $("btnTrocarSenha");
    var box = $("boxTrocarSenha");
    if(bTrocar && box){
      bTrocar.addEventListener("click", function(ev){
        ev.preventDefault();
        box.style.display = (box.style.display === "none" || !box.style.display) ? "" : "none";
      });
    }

    var bCancel = $("btnCancelarSenha");
    if(bCancel && box){
      bCancel.addEventListener("click", function(ev){
        ev.preventDefault();
        box.style.display = "none";
        $("pwNova").value = "";
        $("pwConfirm").value = "";
      });
    }

    var bSalvarSenha = $("btnSalvarSenha");
    if(bSalvarSenha){
      bSalvarSenha.addEventListener("click", async function(ev){
        ev.preventDefault();
        setTopMsg(null,"");
        try{
          var u = await VSC_AUTH.getCurrentUser();
          if(!u) throw new Error("Usuário não autenticado.");
          var p1 = ($("pwNova").value || "");
          var p2 = ($("pwConfirm").value || "");
          if(p1.length < 8) throw new Error("Senha muito curta (mínimo 8 caracteres).");
          if(p1 !== p2) throw new Error("Confirmação não confere.");
          await VSC_AUTH.changePassword(u.id, p1);
          $("boxTrocarSenha").style.display = "none";
          $("pwNova").value = "";
          $("pwConfirm").value = "";
          setTopMsg("ok", "Senha atualizada com sucesso.");
        }catch(e){
          setTopMsg("danger", e && e.message ? e.message : String(e));
        }
      });
    }

    var bMeuPerfil = $("btnAbrirMeuPerfil");
    if(bMeuPerfil){
      bMeuPerfil.addEventListener("click", function(ev){
        ev.preventDefault();
        setTopMsg(null,"");
        openProfModalSelf().catch(function(e){
          setTopMsg("danger", e && e.message ? e.message : String(e));
        });
      });
    }
    var bMeuPerfil2 = $("btnAbrirPerfil2");
    if(bMeuPerfil2){
      bMeuPerfil2.addEventListener("click", function(ev){
        ev.preventDefault();
        setTopMsg(null,"");
        openProfModalSelf().catch(function(e){
          setTopMsg("danger", e && e.message ? e.message : String(e));
        });
      });
    }

    var bReload = $("btnReloadUsers");
    if(bReload){
      bReload.addEventListener("click", async function(ev){
        ev.preventDefault();
        setTopMsg(null,"");
        try{
          await reloadUsersTable();
          setTopMsg("ok", "Usuários recarregados.");
        }catch(e){
          setTopMsg("danger", e && e.message ? e.message : String(e));
        }
      });
    }

    var bCreate = $("btnCriarUser");
    if(bCreate){
      bCreate.addEventListener("click", async function(ev){
        ev.preventDefault();
        setTopMsg(null,"");
        try{
          var u = ($("newUser").value || "").trim();
          var role = ($("newRole").value || "USER").trim();
          var p1 = ($("newPass").value || "");
          var p2 = ($("newPass2").value || "");
          if(!u) throw new Error("Usuário é obrigatório.");
          if(p1.length < 8) throw new Error("Senha temporária muito curta (mínimo 8).");
          if(p1 !== p2) throw new Error("Confirmação de senha não confere.");
          await VSC_AUTH.adminCreateUser(u, p1, role);
          $("newUser").value = "";
          $("newPass").value = "";
          $("newPass2").value = "";
          await reloadUsersTable();
          setTopMsg("ok", "Usuário criado com sucesso (forçar troca no 1º login).");
        }catch(e){
          setTopMsg("danger", e && e.message ? e.message : String(e));
        }
      });
    }
  }

  async function bootstrap(){
    setTopMsg(null,"");

    if(!window.VSC_AUTH){
      setTopMsg("danger", "VSC_AUTH não carregou. Verifique scripts.");
      setPill($("pillStatus"), "danger", "⛔ BLOQUEADO");
      return;
    }

    var u = await VSC_AUTH.getCurrentUser();
    if(!u){
      setTopMsg("warn", "Nenhuma sessão ativa. Faça login.");
      setPill($("pillStatus"), "danger", "⛔ BLOQUEADO");
      // fail-closed: redireciona para login
      try{ location.href = "login.html"; }catch(_){}
      return;
    }

    await refreshSelfSummary();

    // Gate para abas (deny-by-default)
    var role = String(u.role||"").toUpperCase();
    var isAdmin = (role === "ADMIN" || role === "MASTER");
    var isMaster = (role === "MASTER");

    // Aba Admin
    $("tabBtn-admin").style.display = isAdmin ? "" : "none";
    // Aba Master
    $("tabBtn-master").style.display = isMaster ? "" : "none";

    // default pane
    showPane("meu");

    if(isAdmin){
      try{ await reloadUsersTable(); }catch(e){ setTopMsg("danger", e && e.message ? e.message : String(e)); }
    }
  }

  document.addEventListener("DOMContentLoaded", function(){
    wireTabs();
    wireProfModal();
    wireActions();
    bootstrap().catch(function(e){
      setTopMsg("danger", e && e.message ? e.message : String(e));
      setPill($("pillStatus"), "danger", "⛔ BLOQUEADO");
    });
  });

})();
