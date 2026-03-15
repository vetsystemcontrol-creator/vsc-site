/* ============================================================
   LOGIN — Vet System Control – Equine (offline-first)
   - Usa VSC_AUTH (PBKDF2 + sessão IDB)
   - Primeiro acesso: senhas temporárias são exibidas no console no 1º bootstrap
   ============================================================ */
(() => {
  "use strict";

  const LOGIN_FILE = "/login.html";
  const DASH_FILE = "/dashboard.html";

  function qs(sel){ return document.querySelector(sel); }
  function setStatus(msg, kind){
    const el = qs("#loginStatus");
    if(!el) return;
    el.textContent = msg || "";
    el.className = "status " + (kind||"");
  }

  function showPage(){
    try{
      document.documentElement.style.visibility = "visible";
      window.__VSC_LOGIN_PREHIDE_DONE = true;
    }catch(_){}
  }


  // Anti-loop guard: se houver redirecionamento em ping-pong (login ↔ dashboard),
  // assume sessão "fantasma" e força limpeza para quebrar o ciclo.
  const BOUNCE_KEY = "vsc_auth_bounce";
  function getBounce(){
    try{ return JSON.parse(sessionStorage.getItem(BOUNCE_KEY) || "{}") || {}; }catch(_){ return {}; }
  }
  function setBounce(obj){
    try{ sessionStorage.setItem(BOUNCE_KEY, JSON.stringify(obj||{})); }catch(_){}
  }
  function resetBounce(){
    try{ sessionStorage.removeItem(BOUNCE_KEY); }catch(_){}
  }
  async function breakLoopIfNeeded(){
    const b = getBounce();
    const now = Date.now();
    // janela de 10s para detectar ping-pong
    if(b.ts && (now - b.ts) < 10000 && (b.n||0) >= 2){
      // 2 ou mais bounces em 10s -> limpa sessão
      try{
        if(window.VSC_AUTH?.logout) await window.VSC_AUTH.logout();
        else if(window.VSC_AUTH?.clearSession) await window.VSC_AUTH.clearSession();
      }catch(_){}
      resetBounce();
      setStatus("Sessão inválida detectada. Faça login novamente.", "warn");
      return true;
    }
    return false;
  }
  function markBounce(target){
    const b = getBounce();
    const now = Date.now();
    if(!b.ts || (now - b.ts) > 10000){
      setBounce({ts: now, n: 1, target: target||""});
      return;
    }
    setBounce({ts: b.ts, n: (b.n||0)+1, target: target||""});
  }


  function getNextUrl(){
    try{
      const u = new URL(location.href);
      const n = u.searchParams.get("next");
      if(!n) return null;
      const decoded = decodeURIComponent(n);
      // Proteção: nunca redirecionar para a própria tela de login (evita loop/pisca)
      const low = String(decoded).toLowerCase();
      if(low.includes("login.html")) return null;
      return decoded;
    }catch(_){ return null; }
  }

  async function init(){
    setStatus("Inicializando...", "info");

    if(!window.VSC_AUTH){
      setStatus("ERRO: VSC_AUTH não carregou. Verifique scripts.", "error");
      showPage();
      return;
    }

    try{
      await window.VSC_AUTH.bootstrap();

      // DEV RECOVERY (somente se solicitado explicitamente): login.html?recover=1
      try{
        const u = new URL(location.href);
        const recover = (u.searchParams.get("recover") === "1");
        if(recover && window.VSC_AUTH.devResetBootstrapUsers){
          setStatus("Recuperação DEV: gerando novas senhas temporárias (veja o Console F12)...", "warn");
          await window.VSC_AUTH.devResetBootstrapUsers();
          setStatus("Recuperação DEV concluída. Use as senhas do Console (F12) e REMOVA ?recover=1 da URL.", "ok");
        }
      }catch(_){}


      // Se detectarmos ping-pong recente, limpamos e permanecemos na tela de login
      if(await breakLoopIfNeeded()){ showPage(); return; }

      // Se já está logado, vai direto
      const cur = await window.VSC_AUTH.getCurrentUser();
      if(cur){
        showPage();
        const nxt = getNextUrl();
        const target = (nxt || DASH_FILE);
        markBounce(target);
        location.replace(target);
        return;
      }

      // preencher lista de usuários (se existir)
      const sel = qs("#username");
      try{
        const users = (window.VSC_AUTH.listLoginUsers)
          ? await window.VSC_AUTH.listLoginUsers()
          : await window.VSC_AUTH.listUsers();
        if(Array.isArray(users) && users.length){
          // coloca master/admin no topo se existirem
          users.sort((a,b)=>{
            const au=(a.username||"").toLowerCase(), bu=(b.username||"").toLowerCase();
            const pri = (u)=> (u==="master"?0:(u==="admin"?1:9));
            const pa=pri(au), pb=pri(bu);
            if(pa!==pb) return pa-pb;
            return au.localeCompare(bu);
          });
          for(const u of users){
            const opt = document.createElement("option");
            opt.value = u.username || "";
            opt.textContent = u.username || "(sem username)";
            sel.appendChild(opt);
          }
        }
      }catch(_){ /* ok */ }



      // Se não houver usuários no dropdown, orientar recuperação/bootstrapping
      try{
        if(sel && sel.options && sel.options.length <= 1){
          setStatus("Nenhum usuário encontrado no banco local. Clique em ‘Recuperar acesso’ (local) ou limpe os dados do site e recarregue.", "warn");
          return;
        }
      }catch(_){ }
      setStatus("Pronto. Informe usuário e senha.", "ok");
      showPage();
    }catch(e){
      console.error("[LOGIN] init error:", e);
      setStatus("Falha ao inicializar autenticação. Abra o console (F12).", "error");
      showPage();
    }
  }

  
  async function doRecover(){
    // Breakglass DEV: somente em ambiente local (localhost/127.0.0.1)
    const host = String(location.hostname||"").toLowerCase();
    const isLocal = (host === "localhost" || host === "127.0.0.1" || host === "[::1]");
    if(!isLocal){
      setStatus("Recuperação bloqueada fora de ambiente local.", "error");
      return;
    }
    if(!window.VSC_AUTH || !window.VSC_AUTH.devResetBootstrapUsers){
      setStatus("Recuperação indisponível (função não encontrada).", "error");
      return;
    }

    // Confirmação forte (evita clique acidental)
    const code = prompt("CONFIRMAÇÃO: digite RECOVER para gerar novas senhas temporárias (veja o Console F12).");
    if(String(code||"").trim().toUpperCase() !== "RECOVER"){
      setStatus("Recuperação cancelada.", "warn");
      return;
    }

    setStatus("Recuperação: gerando novas senhas temporárias (veja o Console F12)...", "warn");
    try{
      await window.VSC_AUTH.devResetBootstrapUsers();
      // limpa senha digitada
      try{ const p = qs("#password"); if(p) p.value = ""; }catch(_){}
      setStatus("Recuperação concluída. Use as senhas do Console (F12).", "ok");
      // repopula lista
      try{
        const sel = qs("#username");
        if(sel){
          // mantém 1ª opção "Selecione..."
          while(sel.options && sel.options.length > 1){ sel.remove(1); }
          const users = (window.VSC_AUTH.listLoginUsers)
            ? await window.VSC_AUTH.listLoginUsers()
            : await window.VSC_AUTH.listUsers();
          if(Array.isArray(users) && users.length){
            users.sort((a,b)=>{
              const au=(a.username||"").toLowerCase(), bu=(b.username||"").toLowerCase();
              const pri = (u)=> (u==="master"?0:(u==="admin"?1:9));
              const pa=pri(au), pb=pri(bu);
              if(pa!==pb) return pa-pb;
              return au.localeCompare(bu);
            });
            for(const u of users){
              const opt = document.createElement("option");
              opt.value = u.username || "";
              opt.textContent = u.username || "(sem username)";
              sel.appendChild(opt);
            }
          }
        }
      }catch(_){}
    }catch(e){
      console.error("[LOGIN] recover error:", e);
      setStatus("Falha na recuperação. Abra o console (F12).", "error");
    }
  }

async function doLogin(){
    const user = (qs("#username")?.value || "").trim();
    const pass = (qs("#password")?.value || "");
    if(!user || !pass){
      setStatus("Informe usuário e senha.", "warn");
      try{ window.__VSC_LOGIN_PREHIDE_DONE = true; }catch(_){}
      showPage();
      return;
    }

    setStatus("Autenticando...", "info");
    try{
      const r = await window.VSC_AUTH.login(user, pass);
      if(r && r.ok){
        setStatus("Login OK. Redirecionando...", "ok");
        resetBounce();
        const nxt = getNextUrl();
        location.replace(nxt || DASH_FILE);
        return;
      }
      setStatus((r && r.error) ? r.error : "Falha no login.", "error");
    }catch(e){
      console.error("[LOGIN] login error:", e);
      setStatus("Erro no login. Verifique o console (F12).", "error");
    }
  }

  function bind(){
    qs("#btnLogin")?.addEventListener("click", (e)=>{ e.preventDefault(); doLogin(); });
    qs("#btnRecover")?.addEventListener("click", (e)=>{ e.preventDefault(); doRecover(); });
    qs("#password")?.addEventListener("keydown", (e)=>{
      if(e.key === "Enter"){ e.preventDefault(); doLogin(); }
    });
  }

  window.addEventListener("DOMContentLoaded", ()=>{ bind(); init(); });
  window.addEventListener("pageshow", ()=>{ try{ if(!window.__VSC_LOGIN_PREHIDE_DONE) showPage(); }catch(_){} });
})();
