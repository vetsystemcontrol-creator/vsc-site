/* ============================================================
   LOGIN — Vet System Control – Equine (offline-first)
   - Usa VSC_AUTH (PBKDF2 + sessão IDB)
   - Primeiro acesso: senhas temporárias são exibidas no console no 1º bootstrap
   ============================================================ */
(() => {
  "use strict";

  function qs(sel){ return document.querySelector(sel); }
  function setStatus(msg, kind){
    const el = qs("#loginStatus");
    if(!el) return;
    el.textContent = msg || "";
    el.className = "status " + (kind||"");
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


      // Se já está logado, vai direto
      const cur = await window.VSC_AUTH.getCurrentUser();
      if(cur){
        const nxt = getNextUrl();
        location.replace(nxt || "dashboard.html");
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

      setStatus("Pronto. Informe usuário e senha.", "ok");
    }catch(e){
      console.error("[LOGIN] init error:", e);
      setStatus("Falha ao inicializar autenticação. Abra o console (F12).", "error");
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
      return;
    }

    setStatus("Autenticando...", "info");
    try{
      const r = await window.VSC_AUTH.login(user, pass);
      if(r && r.ok){
        setStatus("Login OK. Redirecionando...", "ok");
        const nxt = getNextUrl();
        location.replace(nxt || "dashboard.html");
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
})();
