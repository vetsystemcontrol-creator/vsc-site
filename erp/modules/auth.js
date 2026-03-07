/* ============================================================
   VSC_AUTH — RBAC enterprise + Sessão + Auditoria (offline-first)
   Base (boas práticas):
   - RBAC (roles -> permissions) + fail-closed
   - Senha: PBKDF2 (WebCrypto) com salt e iterations
   - Sessão: token aleatório, expiração, multi-aba via localStorage
   - Auditoria: auth_audit_log (login ok/fail, logout, change pass etc.)
   ============================================================ */
(() => {
  "use strict";

  window.__VSC_AUTH_BUILD = "ERP2.0.1|auth.js|RBAC|2026-02-23|BOOTSTRAP_WAIT_DB";

  // ============================================================
  // ESOS 5.3 — AUTH READY (Promise + evento) — anti-race
  // - Consumidores (auth_guard/login/etc) podem aguardar window.__VSC_AUTH_READY
  // - READY só dispara após window.VSC_AUTH ser publicado.
  // ============================================================
  try{
    if(!window.__VSC_AUTH_READY || typeof window.__VSC_AUTH_READY.then !== "function"){
      window.__VSC_AUTH_READY_FIRED = false;
      window.__VSC_AUTH_READY_RESOLVE = null;
      window.__VSC_AUTH_READY = new Promise((resolve)=>{ window.__VSC_AUTH_READY_RESOLVE = resolve; });
    }
  }catch(_){ }

  // Stores (já criadas no vsc_db v23)
  const S_USERS    = "auth_users";
  const S_ROLES    = "auth_roles";
  const S_PERMS    = "auth_role_permissions";
  const S_SESSIONS = "auth_sessions";
  const S_AUDIT    = "auth_audit_log";

  // Sistema/meta (existente no vsc_db)
  const S_SYS_META = "sys_meta";

  // Sessão em multi-aba
  const LS_SESSION_ID = "vsc_session_id";

  // KDF: PBKDF2 (WebCrypto)
  const KDF_NAME = "PBKDF2";
  const HASH_NAME = "SHA-256";

  // Iterações: valor seguro e realista p/ browser (pode ajustar depois)
  const PBKDF2_ITERATIONS = 120000;


// ============================================================
// Password Policy (NIST 800-63B + OWASP) — offline-first
// - mínimo 8 chars, máximo 128 (suporte a passphrases)
// - sem regras de composição obrigatória
// - bloqueio de senhas comuns/esperadas (denylist local)
// - lockout/rate-limit por tentativas falhas (anti-bruteforce)
// ============================================================
const PW_MIN_LEN = 8;
const PW_MAX_LEN = 128;

// Denylist mínima local (pode expandir via Config futuramente)
// NOTE: "Master@1234" é permitida por ordem do dono do sistema (ambiente interno).
const PW_DENYLIST = new Set([
  "admin","admin123","password","123456","12345678","qwerty",
  "master","master123","vet","vetsystem","vsc",
  "equine","equinos","kado","torres"
]);

// Anti-bruteforce (OWASP): lock progressivo por usuário
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS_1 = 5 * 60 * 1000;   // 5 min
const LOGIN_LOCK_MS_2 = 30 * 60 * 1000;  // 30 min
const LOGIN_LOCK_MS_3 = 12 * 60 * 60 * 1000; // 12 h

function pwNormalize(pw){
  // NIST: permitir espaços e caracteres imprimíveis; aqui só normaliza whitespace externo
  return String(pw||"").trim();
}

function pwIsWeak(pw){
  const p = pwNormalize(pw);
  if(p.length < PW_MIN_LEN) return "Senha muito curta (mín. " + PW_MIN_LEN + ").";
  if(p.length > PW_MAX_LEN) return "Senha muito longa (máx. " + PW_MAX_LEN + ").";
  const low = p.toLowerCase();
  if(PW_DENYLIST.has(p) || PW_DENYLIST.has(low)) return "Senha fraca/banida (muito comum).";
  return null;
}

function calcLockMs(fails){
  const n = Number(fails||0) || 0;
  if(n < LOGIN_MAX_FAILS) return 0;
  if(n === LOGIN_MAX_FAILS) return LOGIN_LOCK_MS_1;
  if(n === LOGIN_MAX_FAILS + 1) return LOGIN_LOCK_MS_2;
  return LOGIN_LOCK_MS_3;
}

  // Expiração da sessão
  const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h

  // Roles canônicas
  const ROLE_MASTER = "MASTER";
  const ROLE_ADMIN  = "ADMIN";
  const ROLE_USER   = "USER";

  // IDs fixos (facilita bootstrap e perm lookup)
  const ROLE_ID_MASTER = "role_master";
  const ROLE_ID_ADMIN  = "role_admin";
  const ROLE_ID_USER   = "role_user";

  // Permissões por módulo (mínimo enterprise)
  // module: "configuracoes" -> { view/edit/admin }
  // MASTER ignora e sempre permite.
  const MODULE_CONFIG = "configuracoes";

  function nowISO(){ return new Date().toISOString(); }
  function nowMs(){ return Date.now(); }

  function uuid(){
    try{ if(crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID(); }catch(_){}
    // fallback não-cripto (último recurso). Ideal: crypto.randomUUID().
try{
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  buf[6] = (buf[6] & 0x0f) | 0x40;
  buf[8] = (buf[8] & 0x3f) | 0x80;
  const hex = Array.from(buf).map(b=>b.toString(16).padStart(2,"0")).join("");
  return [
    hex.slice(0,8),
    hex.slice(8,12),
    hex.slice(12,16),
    hex.slice(16,20),
    hex.slice(20)
  ].join("-");
}catch(_){}
return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c)=>{
  const r = Math.random()*16|0, v = (c==="x") ? r : (r&0x3|0x8);
  return v.toString(16);
});
  }

  function $(id){ return document.getElementById(id); }

  function b64Encode(bytes){
    let bin = "";
    const arr = new Uint8Array(bytes);
    for(let i=0;i<arr.length;i++) bin += String.fromCharCode(arr[i]);
    return btoa(bin);
  }

  function b64Decode(b64){
    const bin = atob(String(b64||""));
    const out = new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function ctEqual(aBytes, bBytes){
    // constant-time-ish compare (JS best-effort)
    const a = (aBytes instanceof Uint8Array) ? aBytes : new Uint8Array(aBytes||[]);
    const b = (bBytes instanceof Uint8Array) ? bBytes : new Uint8Array(bBytes||[]);
    if(a.length !== b.length) return false;
    let diff = 0;
    for(let i=0;i<a.length;i++) diff |= (a[i] ^ b[i]);
    return diff === 0;
  }

  // ============================================================
// HARDENING — Ordem de carregamento determinística (anti-race)
// Problema observado: auth.js pode iniciar bootstrap antes de vsc_db.js
// expor window.VSC_DB.openDB (corrida em alguns loads/caches).
// Solução enterprise: aguardar dependência com timeout (fail-closed com log).
// ============================================================
async function waitForVSC_DBOpenDB(timeoutMs){
  const timeout = Number(timeoutMs||8000);
  const step = 50;
  const start = Date.now();
  while(true){
    try{
      if(window.VSC_DB && typeof window.VSC_DB.openDB === "function") return true;
    }catch(_){}
    if(Date.now() - start >= timeout) return false;
    await new Promise(r=>setTimeout(r, step));
  }
}

// ============================================================
// ESOS 5.2 — DB READY (event/promise) — anti-timeout
// Preferir aguardar o sinal de pronto do vsc_db.js:
// window.__VSC_DB_READY (Promise) ou evento "VSC_DB_READY".
// ============================================================
async function waitForDBReady(timeoutMs){
  const timeout = Number(timeoutMs||30000);
  const start = Date.now();

  // Se houver Promise global, aguarda (com timeout)
  try{
    if(window.__VSC_DB_READY && typeof window.__VSC_DB_READY.then === "function"){
      const race = await Promise.race([
        window.__VSC_DB_READY,
        new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout")), timeout))
      ]);
      if(race === true || race === undefined) return true;
    }
  }catch(_){}

  // Fallback: polling + evento
  let done = false;
  function mark(){ done = true; }
  try{ window.addEventListener("VSC_DB_READY", mark, { once:true }); }catch(_){}

  while(true){
    try{
      if(window.VSC_DB && typeof window.VSC_DB.openDB === "function"){
        // openDB exposta -> considera OK (mas ainda pode estar abrindo internamente)
        // o evento/promise cobre o "pronto".
        if(window.__VSC_DB_READY_FIRED === true) return true;
      }
    }catch(_){}
    if(done) return true;
    if(Date.now() - start >= timeout) return false;
    await new Promise(r=>setTimeout(r, 50));
  }
}


// ============================================================
// COMPAT ALIASES (anti-regressão)
// JavaScript é case-sensitive; qualquer divergência de caixa no
// nome da função quebra o bootstrap (ReferenceError).
// Mantemos aliases para tolerar variações antigas/typos sem
// reintroduzir corrida/timeout.
// ============================================================
function waitforVSC_DBopenDB(timeoutMs){ return waitForVSC_DBOpenDB(timeoutMs); }
function waitforVSC_DBOpenDB(timeoutMs){ return waitForVSC_DBOpenDB(timeoutMs); }
function waitForVSC_DBopenDB(timeoutMs){ return waitForVSC_DBOpenDB(timeoutMs); }

async function openDB(){
  const ok = await waitForDBReady(30000);
  if(!ok){
    throw new Error("VSC_DB não ficou pronto após timeout (VSC_DB_READY).");
  }
  return await window.VSC_DB.openDB();
}
  async function tx(storeNames, mode, fn){
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const t = db.transaction(storeNames, mode);
      const stores = {};
      for(const s of storeNames) stores[s] = t.objectStore(s);

      let done = false;
      t.oncomplete = () => { if(!done){ done=true; resolve(true); } };
      t.onerror = () => { if(!done){ done=true; reject(t.error || new Error("Tx falhou")); } };
      t.onabort = () => { if(!done){ done=true; reject(t.error || new Error("Tx abortada")); } };

      try{ fn(stores); }
      catch(e){
        try{ t.abort(); }catch(_){}
        if(!done){ done=true; reject(e); }
      }
    }).finally(() => { try{ db.close(); }catch(_){ } });
  }

  async function kdfPbkdf2(password, saltBytes, iterations){
    if(!crypto || !crypto.subtle) throw new Error("WebCrypto indisponível (crypto.subtle).");

    const enc = new TextEncoder();
    const pwKey = await crypto.subtle.importKey(
      "raw",
      enc.encode(String(password||"")),
      { name: KDF_NAME },
      false,
      ["deriveBits"]
    );

    const bits = await crypto.subtle.deriveBits(
      {
        name: KDF_NAME,
        salt: saltBytes,
        iterations: iterations,
        hash: HASH_NAME
      },
      pwKey,
      256 // 32 bytes
    );
    return new Uint8Array(bits);
  }

  function randomBytes(n){
    const u = new Uint8Array(n);
    crypto.getRandomValues(u);
    return u;
  }

  async function audit(event, user_id, detail){
    const rec = {
      id: uuid(),
      when: nowISO(),
      event: String(event||""),
      user_id: user_id || null,
      detail: detail ? String(detail) : null
    };
    await tx([S_AUDIT], "readwrite", (s) => {
      s[S_AUDIT].add(rec);
    });
    return rec.id;
  }

  function roleRank(roleName){
    // ranking simples p/ check >= ADMIN etc.
    const r = String(roleName||"").toUpperCase();
    if(r === ROLE_MASTER) return 3;
    if(r === ROLE_ADMIN) return 2;
    if(r === ROLE_USER) return 1;
    return 0;
  }

  // [continua na PARTE 2/4]
  async function ensureRoles(){
    await tx([S_ROLES], "readwrite", (s) => {
      const st = s[S_ROLES];

      st.put({ id: ROLE_ID_MASTER, name: ROLE_MASTER, updated_at: nowISO() });
      st.put({ id: ROLE_ID_ADMIN,  name: ROLE_ADMIN,  updated_at: nowISO() });
      st.put({ id: ROLE_ID_USER,   name: ROLE_USER,   updated_at: nowISO() });
    });
  }

  async function ensureDefaultPermissions(){
    await tx([S_PERMS], "readwrite", (s) => {
      const st = s[S_PERMS];

      // MASTER → acesso total (não precisa perm específica)

      // ADMIN → pode acessar Configurações (edit)
      st.put({
        id: "perm_admin_config",
        role_id: ROLE_ID_ADMIN,
        module: MODULE_CONFIG,
        can_view: true,
        can_edit: true,
        updated_at: nowISO()
      });

      // USER → somente visualização
      st.put({
        id: "perm_user_config",
        role_id: ROLE_ID_USER,
        module: MODULE_CONFIG,
        can_view: true,
        can_edit: false,
        updated_at: nowISO()
      });
    });
  }

  async function countUsers(){
    const db = await openDB();
    try{
      return await new Promise((resolve, reject) => {
        const tx0 = db.transaction([S_USERS], "readonly");
        const rq = tx0.objectStore(S_USERS).count();
        rq.onsuccess = () => resolve(rq.result || 0);
        rq.onerror = () => reject(rq.error);
      });
    } finally { try{ db.close(); }catch(_){ } }
  }

  async function createUser(username, password, role_id, opts){
if(!username || !password) throw new Error("createUser: username/password obrigatórios");
opts = opts || {};
const forceChange = (opts.force_change_password === true);
const status = opts.status ? String(opts.status) : "ACTIVE";

const weakMsg = pwIsWeak(password);
if(weakMsg) throw new Error(weakMsg);

    const salt = randomBytes(16);
    const hash = await kdfPbkdf2(password, salt, PBKDF2_ITERATIONS);

    const rec = {
      id: uuid(),
      username: String(username).trim(),
      role_id: role_id,
      status: status,
      password_hash: b64Encode(hash),
      password_salt: b64Encode(salt),
      password_iter: PBKDF2_ITERATIONS,
      force_change_password: forceChange,
      failed_attempts: 0,
      lock_until: null,
      last_login_at: null,
      last_failed_at: null,
      created_at: nowISO(),      professional: {
        is_vet: false,
        full_name: "",
        crmv_uf: "",
        crmv_num: "",
        phone: "",
        email: "",
        signature_image_dataurl: null,
        icp_enabled: false,
        updated_at: nowISO()
      },

      updated_at: nowISO()
    };

    await tx([S_USERS], "readwrite", (s) => {
      s[S_USERS].add(rec);
    });

    await audit("USER_CREATE", rec.id, rec.username);

    return rec.id;
  }

  


async function reconcileLegacyUsers(){
  // Reconciliar usuários de stores antigas para auth_users.
  // Objetivo: migrar dados sem criar "usuários fantasmas".
  // Regra: só considera store legado se existir pelo menos 1 linha com campo de username.
  const META_KEY = "auth_legacy_reconciled_v3";

  const db = await openDB();
  try{
    const names = Array.from(db.objectStoreNames || []);

    // Nunca tratar stores CANÔNICAS como legado
    const CANONICAL_BLOCKLIST = new Set([
      String(S_USERS),
      String(S_ROLES),
      String(S_ROLE_PERMS),
      String(S_SESSIONS),
      String(S_AUDIT),
      String(S_SYS_META),
      // Perfil profissional (não é store de usuários)
      "user_profiles"
    ]);

    // Candidatos legados (ordem importa). Evite nomes genéricos que batem com stores modernas.
    const CANDIDATES = [
      "usuarios_master","usuarios_v1","usuarios_v2","usuarios",
      "vsc_users","vsc_user","users_master","users_v1","users_v2","users",
      "auth_users_legacy"
    ].filter((n) => !CANONICAL_BLOCKLIST.has(String(n)));

    function pickUsername(row){
      if(!row) return "";
      const cand = row.username || row.user || row.user_name || row.login || row.usuario || row.nome_usuario;
      return (cand == null) ? "" : String(cand);
    }

    async function sampleStoreHasUserRows(storeName){
      if(!storeName) return false;
      if(CANONICAL_BLOCKLIST.has(String(storeName))) return false;
      if(names.indexOf(storeName) === -1) return false;

      try{
        return await new Promise((resolve) => {
          const tx0 = db.transaction([storeName], "readonly");
          const st = tx0.objectStore(storeName);
          const rq = st.openCursor();
          let seen = 0;
          rq.onerror = () => resolve(false);
          rq.onsuccess = () => {
            const cur = rq.result;
            if(!cur) return resolve(false);
            const v = cur.value;
            const u = pickUsername(v);
            if(u && String(u).trim()) return resolve(true);
            seen++;
            if(seen >= 12) return resolve(false);
            cur.continue();
          };
        });
      }catch(_){
        return false;
      }
    }

    // 1) tenta achar store legado válido
    let legacyStore = null;
    for(const n of CANDIDATES){
      if(await sampleStoreHasUserRows(n)) { legacyStore = n; break; }
    }

    // 2) fallback: tenta adivinhar por regex (mas valida)
    if(!legacyStore){
      const guess = names.find((n) => /(^|_)(users?|usuarios?)(_|$)/i.test(String(n||"")));
      if(guess && !CANONICAL_BLOCKLIST.has(String(guess))){
        if(await sampleStoreHasUserRows(String(guess))) legacyStore = String(guess);
      }
    }

    if(!legacyStore){
      return { ok:true, skipped:true, reason:"no_legacy_store" };
    }

    // 3) lê todas as linhas do legado
    const legacyRows = await new Promise((resolve, reject) => {
      const tx0 = db.transaction([legacyStore], "readonly");
      const st = tx0.objectStore(legacyStore);
      const out = [];
      const rq = st.openCursor();
      rq.onerror = () => reject(rq.error || new Error("cursor error"));
      rq.onsuccess = () => {
        const cur = rq.result;
        if(!cur) return resolve(out);
        out.push(cur.value);
        cur.continue();
      };
    });

    // Mapa por username (case-insensitive)
    const legacyMap = {};
    for(const r of (legacyRows || [])){
      const username = String(pickUsername(r) || "").trim();
      if(!username) continue;
      legacyMap[username.toLowerCase()] = r;
    }

    if(!Object.keys(legacyMap).length){
      // Store existe mas não é de usuários (ex: perfis). Não considerar.
      return { ok:true, skipped:true, reason:"legacy_no_userrows", legacyStore };
    }

    // 4) migra/atualiza para auth_users
    let added = 0;
    let updated = 0;

    for(const key of Object.keys(legacyMap)){
      const r = legacyMap[key];
      const username = String(pickUsername(r) || "").trim();
      if(!username) continue;

      const already = await getUserByUsername(username);
      if(already && already.id){
        // Atualiza compat legada (password_plain) se necessário
        try{
          const hasKdf = !!(already.password_hash && already.password_salt);
          const hasPlain = (typeof already.password_plain === "string" && already.password_plain);
          const legacyPw = (typeof r.password === "string" && r.password) ? r.password
            : (typeof r.senha === "string" && r.senha) ? r.senha
            : (typeof r.pass === "string" && r.pass) ? r.pass
            : null;

          if(!hasKdf && !hasPlain && legacyPw){
            already.password_plain = String(legacyPw);
            already.force_change_password = true;
            already.updated_at = nowISO();
            await updateUser(already);
            updated++;
            await audit("LEGACY_USER_COMPAT_INJECTED", already.id, "from=" + legacyStore);
          }
        }catch(_){ }
        continue;
      }

      let roleName = String(r.role || r.role_name || r.perfil || r.tipo || "").toUpperCase();
      let roleId = ROLE_ID_USER;
      if(roleName === "MASTER") roleId = ROLE_ID_MASTER;
      else if(roleName === "ADMIN") roleId = ROLE_ID_ADMIN;

      const legacyPw = (typeof r.password === "string" && r.password) ? r.password
        : (typeof r.senha === "string" && r.senha) ? r.senha
        : (typeof r.pass === "string" && r.pass) ? r.pass
        : null;

      const rec = {
        id: uuid(),
        username: username,
        role_id: roleId,
        status: "ACTIVE",
        password_hash: null,
        password_salt: null,
        password_iter: null,
        password_plain: legacyPw ? String(legacyPw) : null,
        force_change_password: true,
        failed_attempts: 0,
        lock_until: null,
        last_login_at: null,
        last_failed_at: null,
        created_at: nowISO(),
        updated_at: nowISO()
      };

      await tx([S_USERS], "readwrite", (s) => { s[S_USERS].add(rec); });
      added++;
      await audit("LEGACY_USER_MIGRATED", rec.id, "from=" + legacyStore);
    }

    // 5) Se admin foi criado por bootstrap mas NÃO existe no legado, desativa
    try{
      const adm = await getUserByUsername("admin");
      if(adm && String(adm.status||"ACTIVE").toUpperCase() === "ACTIVE"){
        if(!legacyMap["admin"]){
          adm.status = "INACTIVE";
          adm.updated_at = nowISO();
          await updateUser(adm);
          await audit("LEGACY_RECONCILE_DEACTIVATE_BOOTSTRAP_ADMIN", adm.id, "admin_not_in_legacy");
        }
      }
    }catch(_){ }

    // 6) registra execução (best-effort)
    try{
      await tx([S_SYS_META], "readwrite", (st) => {
        st[S_SYS_META].put({ key: META_KEY, value: { ok:true, legacyStore, added, updated, at: nowISO() }, updated_at: nowISO() });
      });
    }catch(_){ }

    if(added > 0 || updated > 0){
      try{ console.warn("[VSC_AUTH] Reconciliado legado:", { legacyStore, added, updated }); }catch(_){ }
    }

    return { ok:true, legacyStore, added, updated };
  } finally {
    try{ db.close(); }catch(_){ }
  }
}

async function ensureBootstrapUsers(){

    // Sempre tenta reconciliar com o legado antes de decidir bootstrap defaults.
    let rec = null;
    try{ rec = await reconcileLegacyUsers(); }catch(_){ rec = null; }

    let total = await countUsers();
    if(total > 0){
      // Sanear usuário fantasma: versões antigas criavam 'admin' automaticamente.
      // Se já existem usuários reais (além de master/admin), desativamos 'admin' bootstrap.
      try{
        const adm = await getUserByUsername("admin");
        if(adm && String(adm.status||"ACTIVE").toUpperCase() === "ACTIVE"){
          const db2 = await openDB();
          try{
            const hasRealUser = await new Promise((resolve) => {
              const tx0 = db2.transaction([S_USERS], "readonly");
              const st = tx0.objectStore(S_USERS);
              const rq = st.openCursor();
              rq.onerror = () => resolve(false);
              rq.onsuccess = () => {
                const cur = rq.result;
                if(!cur) return resolve(false);
                const v = cur.value || {};
                const un = String(v.username||"").trim().toLowerCase();
                const stt = String(v.status||"ACTIVE").toUpperCase();
                if(stt === "ACTIVE" && un && un !== "master" && un !== "admin"){
                  return resolve(true);
                }
                cur.continue();
              };
            });
            if(hasRealUser){
              adm.status = "INACTIVE";
              adm.updated_at = nowISO();
              await updateUser(adm);
              await audit("BOOTSTRAP_ADMIN_DEACTIVATED", adm.id, "real_users_present");
            }
          } finally { try{ db2.close(); }catch(_){} }
        }
      }catch(_){ }
      return { created:false, migrated:false, reconcile:rec };
    }

  await ensureRoles();
  await ensureDefaultPermissions();

  // Por ordem do dono do sistema (ambiente interno), master deve ter senha padrão conhecida.
  // Admin não deve ser criado automaticamente (evita usuário fantasma no dropdown).
  const masterTemp = "Master@1234";

  let masterId = null;
  let adminId  = null;

  try{
    masterId = await createUser("master", masterTemp, ROLE_ID_MASTER, { force_change_password:true });
    await audit("BOOTSTRAP_MASTER_CREATED", masterId, "temp_password_set");
  }catch(e){
    console.warn("[VSC_AUTH] Bootstrap master falhou/duplicado:", String(e && (e.message||e)));
  }

  console.warn(
    "[VSC_AUTH] Bootstrap inicial criado (APENAS 1ª execução / DB vazio).",
    "\n- master (MASTER): " + (masterId ? "criado" : "não criado"),
    "\nSenha padrão (master): " + masterTemp,
    "\nSe houver usuários legados, serão reconciliados automaticamente no bootstrap."
  );

  return { created:true, masterId };
}

  // Mutex do bootstrap (anti-corrida multi-chamada / multi-aba)
  let _bootstrapPromise = null;

  async function bootstrap(){
    if(_bootstrapPromise) return _bootstrapPromise;

    _bootstrapPromise = (async () => {
      await ensureRoles();
      await ensureDefaultPermissions();
      await ensureBootstrapUsers();
      return true;
    })().catch((e) => {
      // permite retry futuro se falhar
      _bootstrapPromise = null;
      throw e;
    });

    return _bootstrapPromise;
  }

  async function getUserByUsername(username){
    username = String(username||"").trim();
    if(!username) return null;
    const target = username.toLowerCase();

    const db = await openDB();
    try{
      // Primeiro tenta index/get exato (rápido)
      try{
        const tx0 = db.transaction([S_USERS], "readonly");
        const st = tx0.objectStore(S_USERS);
        const ix = st.index("username");
        const exact = await new Promise((resolve) => {
          const rq = ix.get(username);
          rq.onsuccess = () => resolve(rq.result || null);
          rq.onerror = () => resolve(null);
        });
        if(exact) return exact;
      }catch(_){ /* sem índice -> cai para scan */ }

      // Scan case-insensitive (garante encontrar "kado torres" vs "Kado Torres")
      return await new Promise((resolve, reject) => {
        const tx0 = db.transaction([S_USERS], "readonly");
        const st = tx0.objectStore(S_USERS);
        const rq = st.openCursor();
        rq.onerror = () => reject(rq.error || new Error("cursor error"));
        rq.onsuccess = () => {
          const cur = rq.result;
          if(!cur) return resolve(null);
          const v = cur.value;
          const u = (v && v.username) ? String(v.username) : "";
          if(u && u.toLowerCase() === target) return resolve(v);
          cur.continue();
        };
      });
    } finally { try{ db.close(); }catch(_){ } }
  }

async function getRole(role_id){
    if(!role_id) return null;
    const db = await openDB();
    try{
      return await new Promise((resolve, reject) => {
        const tx0 = db.transaction([S_ROLES], "readonly");
        const st = tx0.objectStore(S_ROLES);
        const rq = st.get(role_id);
        rq.onsuccess = () => resolve(rq.result || null);
        rq.onerror = () => reject(rq.error);
      });
    } finally { try{ db.close(); }catch(_){ } }
  }

  async function getPermission(role_id, moduleName){
    if(!role_id || !moduleName) return null;
    const db = await openDB();
    try{
      return await new Promise((resolve, reject) => {
        const tx0 = db.transaction([S_PERMS], "readonly");
        const st = tx0.objectStore(S_PERMS);

        // tenta índice composto role_module
        try{
          const ix = st.index("role_module");
          const rq = ix.get([role_id, moduleName]);
          rq.onsuccess = () => resolve(rq.result || null);
          rq.onerror = () => reject(rq.error);
          return;
        }catch(_){}

        // fallback: varre
        const out = { found: null };
        const rq2 = st.openCursor();
        rq2.onsuccess = () => {
          const cur = rq2.result;
          if(!cur) return resolve(null);
          const v = cur.value;
          if(v && v.role_id === role_id && v.module === moduleName){
            out.found = v;
            return resolve(out.found);
          }
          cur.continue();
        };
        rq2.onerror = () => reject(rq2.error);
      });
    } finally { try{ db.close(); }catch(_){ } }
  }

  function makeSessionId(){
    // sessão id aleatório — suficiente para offline-first
    return uuid();
  }

  async function createSession(user_id){
    const sid = makeSessionId();
    const created = nowISO();
    const expires = new Date(nowMs() + SESSION_TTL_MS).toISOString();

    await tx([S_SESSIONS], "readwrite", (s) => {
      s[S_SESSIONS].put({
        id: sid,
        user_id: user_id,
        status: "ACTIVE",
        created_at: created,
        expires_at: expires
      });
    });

    // multi-aba: persiste id da sessão
    localStorage.setItem(LS_SESSION_ID, sid);

    await audit("SESSION_CREATE", user_id, "expires_at=" + expires);
    return { session_id: sid, expires_at: expires };
  }

  async function revokeSession(session_id, reason){
    if(!session_id) return false;

    await tx([S_SESSIONS], "readwrite", (s) => {
      const st = s[S_SESSIONS];
      const g = st.get(session_id);
      g.onsuccess = () => {
        const cur = g.result || null;
        if(!cur) return;
        cur.status = "REVOKED";
        cur.revoked_at = nowISO();
        cur.revoked_reason = reason || "logout";
        st.put(cur);
      };
    });

    return true;
  }

  async function getSession(session_id){
    if(!session_id) return null;

    const db = await openDB();
    try{
      return await new Promise((resolve, reject) => {
        const tx0 = db.transaction([S_SESSIONS], "readonly");
        const st = tx0.objectStore(S_SESSIONS);
        const rq = st.get(session_id);
        rq.onsuccess = () => resolve(rq.result || null);
        rq.onerror = () => reject(rq.error);
      });
    } finally { try{ db.close(); }catch(_){ } }
  }

  async function getUserById(user_id){
    if(!user_id) return null;
    const db = await openDB();
    try{
      return await new Promise((resolve, reject) => {
        const tx0 = db.transaction([S_USERS], "readonly");
        const st = tx0.objectStore(S_USERS);
        const rq = st.get(user_id);
        rq.onsuccess = () => resolve(rq.result || null);
        rq.onerror = () => reject(rq.error);
      });
    } finally { try{ db.close(); }catch(_){ } }
  }

  async function getCurrentSessionId(){
    return localStorage.getItem(LS_SESSION_ID) || null;
  }

  async function getCurrentUser(){
    // fail-closed: sem sessão => null
    const sid = await getCurrentSessionId();
    if(!sid) return null;

    const s = await getSession(sid);
    if(!s || s.status !== "ACTIVE"){
      return null;
    }

    const expMs = Date.parse(s.expires_at || "");
    if(isFinite(expMs) && nowMs() > expMs){
      // expirada => revoga
      try{
        await revokeSession(sid, "expired");
        localStorage.removeItem(LS_SESSION_ID);
        await audit("SESSION_EXPIRED", s.user_id, sid);
      }catch(_){}
      return null;
    }

    const u = await getUserById(s.user_id);
    if(!u || u.status !== "ACTIVE"){
      return null;
    }

    const role = await getRole(u.role_id);
    const roleName = role && role.name ? String(role.name) : "";

    return {
      id: u.id,
      username: u.username,
      role_id: u.role_id,
      role: roleName,
      professional: (u && u.professional) ? {
        is_vet: !!u.professional.is_vet,
        full_name: u.professional.full_name || "",
        crmv_uf: u.professional.crmv_uf || "",
        crmv_num: u.professional.crmv_num || "",
        phone: u.professional.phone || "",
        email: u.professional.email || "",
        signature_image_dataurl: u.professional.signature_image_dataurl || null,
        icp_enabled: !!u.professional.icp_enabled,
        updated_at: u.professional.updated_at || null
      } : {
        is_vet:false, full_name:"", crmv_uf:"", crmv_num:"", phone:"", email:"", signature_image_dataurl:null, icp_enabled:false, updated_at:null
      }
    };
  }

  
async function login(username, password){
  username = String(username||"").trim();
  password = String(password||"");

  if(!username || !password){
    await audit("LOGIN_FAIL", null, "missing_credentials");
    throw new Error("Usuário/senha obrigatórios.");
  }

  const u = await getUserByUsername(username);
  if(!u || String(u.status||"ACTIVE").toUpperCase() !== "ACTIVE"){
    await audit("LOGIN_FAIL", (u && u.id) ? u.id : null, "user_not_found_or_inactive");
    throw new Error("Usuário ou senha inválidos.");
  }

  // lockout check (anti-bruteforce)
  // IMPORTANTE: se a senha estiver correta, devemos permitir o login e limpar o lock.
  // Caso contrário o usuário fica preso mesmo após inserir a credencial correta.
  const lockUntilMs = u.lock_until ? Date.parse(u.lock_until) : 0;
  const isLocked = (lockUntilMs && isFinite(lockUntilMs) && nowMs() < lockUntilMs);

  // LEGACY PASSWORD COMPAT (migração automática para PBKDF2)
  try{
    const hasKdf = !!(u.password_hash && u.password_salt);
    if(!hasKdf){
      const legacy = (typeof u.password === "string" && u.password) ? u.password
        : (typeof u.senha === "string" && u.senha) ? u.senha
        : (typeof u.password_plain === "string" && u.password_plain) ? u.password_plain
        : (typeof u.password_temp === "string" && u.password_temp) ? u.password_temp
        : (typeof u.pass === "string" && u.pass) ? u.pass
        : null;

      if(legacy && String(legacy) === String(password)){
        const salt2 = randomBytes(16);
        const hash2 = await kdfPbkdf2(password, salt2, PBKDF2_ITERATIONS);
        u.password_hash = b64Encode(hash2);
        u.password_salt = b64Encode(salt2);
        u.password_iter = PBKDF2_ITERATIONS;
        u.force_change_password = true;
        u.failed_attempts = 0;
        u.lock_until = null;

        try{ delete u.password; }catch(_){}
        try{ delete u.senha; }catch(_){}
        try{ delete u.password_plain; }catch(_){}
        try{ delete u.password_temp; }catch(_){}
        try{ delete u.pass; }catch(_){}

        await updateUser(u);
        const sessL = await createSession(u.id);
        await audit("LOGIN_OK", u.id, "legacy_password_migrated");
        return { ok:true, user_id: u.id, session_id: sessL.session_id, expires_at: sessL.expires_at };
      }
    }
  }catch(e){
    console.warn("[VSC_AUTH] legacy password compat falhou (seguindo PBKDF2):", e && (e.message||e));
  }

  // PBKDF2 normal
  const salt = b64Decode(u.password_salt || "");
  const iter = Number(u.password_iter || PBKDF2_ITERATIONS) || PBKDF2_ITERATIONS;

  const derived = await kdfPbkdf2(password, salt, iter);
  const stored = b64Decode(u.password_hash || "");

  if(!ctEqual(derived, stored)){
    if(isLocked){
      await audit("LOGIN_FAIL", u.id, "locked_until=" + u.lock_until);
      throw new Error("Conta temporariamente bloqueada. Tente novamente mais tarde.");
    }
    try{
      u.failed_attempts = Number(u.failed_attempts||0) + 1;
      u.last_failed_at = nowISO();
      const lockMs = calcLockMs(u.failed_attempts);
      if(lockMs > 0){
        u.lock_until = new Date(nowMs() + lockMs).toISOString();
      }
      await updateUser(u);
    }catch(_){}
    await audit("LOGIN_FAIL", u.id, "bad_password");
    throw new Error("Usuário ou senha inválidos.");
  }

  try{
    u.failed_attempts = 0;
    u.lock_until = null;
    u.last_login_at = nowISO();
    await updateUser(u);
  }catch(_){}

  const sess = await createSession(u.id);
  await audit("LOGIN_OK", u.id, "session=" + sess.session_id);

  return { ok:true, user_id: u.id, session_id: sess.session_id, expires_at: sess.expires_at };
}
  async function logout(){
    const sid = await getCurrentSessionId();
    if(!sid){
      return { ok:true, no_session:true };
    }

    const s = await getSession(sid);
    const uid = s ? s.user_id : null;

    try{ await revokeSession(sid, "logout"); }catch(_){}
    try{ localStorage.removeItem(LS_SESSION_ID); }catch(_){}

    await audit("LOGOUT", uid, sid);
    return { ok:true };
  }

  async function requireRole(minRoleName){
    // fail-closed
    const u = await getCurrentUser();
    if(!u) throw new Error("Acesso negado: sessão não autenticada.");

    const have = roleRank(u.role);
    const need = roleRank(minRoleName);

    if(have < need){
      await audit("ACCESS_DENY_ROLE", u.id, "need=" + minRoleName + " have=" + u.role);
      throw new Error("Acesso negado: requer perfil " + minRoleName + ".");
    }
    return true;
  }

  async function requirePermission(moduleName, action){
    // action: "view" | "edit"
    const u = await getCurrentUser();
    if(!u) throw new Error("Acesso negado: sessão não autenticada.");

    // MASTER sempre permite
    if(String(u.role||"").toUpperCase() === ROLE_MASTER) return true;

    const p = await getPermission(u.role_id, moduleName);
    if(!p){
      await audit("ACCESS_DENY_PERM", u.id, "no_perm module=" + moduleName);
      throw new Error("Acesso negado: permissão ausente para " + moduleName + ".");
    }

    const act = String(action||"").toLowerCase();
    if(act === "view"){
      if(p.can_view === true) return true;
    } else if(act === "edit"){
      if(p.can_edit === true) return true;
    } else {
      throw new Error("Ação inválida em requirePermission.");
    }

    await audit("ACCESS_DENY_PERM", u.id, "deny action=" + act + " module=" + moduleName);
    throw new Error("Acesso negado: sem permissão (" + act + ").");
  }


async function updateUser(user){
  if(!user || !user.id) throw new Error("updateUser: user inválido");
  user.updated_at = nowISO();
  await tx([S_USERS], "readwrite", (s) => { s[S_USERS].put(user); });
  return true;
}

async function revokeAllSessionsForUser(user_id, reason){
  if(!user_id) return 0;
  const db = await openDB();
  try{
    return await new Promise((resolve, reject) => {
      const tx0 = db.transaction([S_SESSIONS], "readwrite");
      const st = tx0.objectStore(S_SESSIONS);
      let count = 0;
      const rq = st.openCursor();
      rq.onsuccess = () => {
        const cur = rq.result;
        if(!cur) return resolve(count);
        const v = cur.value;
        if(v && v.user_id === user_id && v.status === "ACTIVE"){
          v.status = "REVOKED";
          v.revoked_at = nowISO();
          v.revoked_reason = reason || "revoke_all";
          try{ st.put(v); count++; }catch(_){}
        }
        cur.continue();
      };
      rq.onerror = () => reject(rq.error);
    });
  } finally { try{ db.close(); }catch(_){ } }
}

async function changePassword(user_id, newPassword){
  if(!user_id) throw new Error("changePassword: user_id obrigatório");
  const weakMsg = pwIsWeak(newPassword);
  if(weakMsg) throw new Error(weakMsg);

  const u = await getUserById(user_id);
  if(!u || u.status !== "ACTIVE") throw new Error("Usuário inexistente/inativo.");

  const salt = randomBytes(16);
  const hash = await kdfPbkdf2(newPassword, salt, PBKDF2_ITERATIONS);

  u.password_hash = b64Encode(hash);
  u.password_salt = b64Encode(salt);
  u.password_iter = PBKDF2_ITERATIONS;
  u.force_change_password = false;
  u.failed_attempts = 0;
  u.lock_until = null;

  await updateUser(u);
  await audit("PASSWORD_CHANGE", u.id, "self_or_admin");

  await revokeAllSessionsForUser(u.id, "password_change");
  return { ok:true };
}

async function adminCreateUser(username, password, roleName){
  await requireRole(ROLE_ADMIN); // ADMIN ou MASTER
  const role = String(roleName||ROLE_USER).toUpperCase();
  const role_id = (role === ROLE_MASTER) ? ROLE_ID_MASTER : (role === ROLE_ADMIN) ? ROLE_ID_ADMIN : ROLE_ID_USER;

  const ex = await getUserByUsername(username);
  if(ex && ex.id) throw new Error("Usuário já existe.");

  const uid = await createUser(username, password, role_id, { force_change_password:true });
  await audit("ADMIN_USER_CREATE", uid, role);
  return { ok:true, user_id: uid };
}

async function listUsers(opts){
  opts = opts || {};
  await requireRole(ROLE_ADMIN);
  const limit = (opts.limit && Number(opts.limit)>0) ? Number(opts.limit) : 200;

  const db = await openDB();
  try{
    return await new Promise((resolve, reject) => {
      const out = [];
      const tx0 = db.transaction([S_USERS], "readonly");
      const st = tx0.objectStore(S_USERS);
      const rq = st.openCursor();
      rq.onsuccess = () => {
        const cur = rq.result;
        if(!cur) return resolve(out);
        const v = cur.value;
        if(v){
          out.push({
            id: v.id,
            username: v.username,
            role_id: v.role_id,
            status: v.status,
            force_change_password: !!v.force_change_password,
            failed_attempts: Number(v.failed_attempts||0),
            lock_until: v.lock_until || null,
            updated_at: v.updated_at || null
          });
          if(out.length >= limit) return resolve(out);
        }
        cur.continue();
      };
      rq.onerror = () => reject(rq.error);
    });
  } finally { try{ db.close(); }catch(_){ } }
}

  // ============================================================
  // PROFESSIONAL PROFILE (CRMV/Assinatura) — Enterprise
  // - USER (credencial) ≠ PROFISSIONAL (identidade legal)
  // - Alterações são auditadas (auth_audit_log)
  // ============================================================

  function normUF(v){
    v = String(v||"").trim().toUpperCase();
    if(!v) return "";
    // UF BR (2 letras)
    if(!/^[A-Z]{2}$/.test(v)) throw new Error("CRMV-UF inválido (use 2 letras).");
    return v;
  }
  function normPhone(v){
    v = String(v||"").trim();
    return v;
  }
  function normEmail(v){
    v = String(v||"").trim();
    if(!v) return "";
    // validação leve (não bloqueia e-mail corporativo incomum)
    if(v.length > 254) throw new Error("Email muito longo.");
    return v;
  }
  function normName(v){
    v = String(v||"").trim();
    if(!v) return "";
    if(v.length > 160) throw new Error("Nome muito longo.");
    return v;
  }
  function normCRMVNum(v){
    v = String(v||"").trim();
    if(!v) return "";
    if(v.length > 32) throw new Error("Número do CRMV muito longo.");
    // aceita letras/dígitos/.-/ (alguns conselhos usam variações em registros)
    if(!/^[0-9A-Za-z\.\-\/ ]+$/.test(v)) throw new Error("Número do CRMV inválido.");
    return v.replace(/\s+/g," ");
  }

  async function adminGetUser(userId){
    await requireRole(ROLE_ADMIN);
    const u = await getUserById(userId);
    if(!u) throw new Error("Usuário não encontrado.");
    // nunca expor hash/salt para UI
    return {
      id: u.id,
      username: u.username,
      role_id: u.role_id,
      status: u.status,
      force_change_password: !!u.force_change_password,
      failed_attempts: Number(u.failed_attempts||0),
      lock_until: u.lock_until || null,
      last_login_at: u.last_login_at || null,
      created_at: u.created_at || null,
      updated_at: u.updated_at || null,
      professional: (u.professional) ? {
        is_vet: !!u.professional.is_vet,
        full_name: u.professional.full_name || "",
        crmv_uf: u.professional.crmv_uf || "",
        crmv_num: u.professional.crmv_num || "",
        phone: u.professional.phone || "",
        email: u.professional.email || "",
        signature_image_dataurl: u.professional.signature_image_dataurl || null,
        icp_enabled: !!u.professional.icp_enabled,
        updated_at: u.professional.updated_at || null
      } : {
        is_vet:false, full_name:"", crmv_uf:"", crmv_num:"", phone:"", email:"", signature_image_dataurl:null, icp_enabled:false, updated_at:null
      }
    };
  }

  async function adminUpdateProfessionalProfile(userId, prof){
    await requireRole(ROLE_ADMIN);

    prof = prof || {};
    const full_name = normName(prof.full_name);
    const crmv_uf   = prof.crmv_uf ? normUF(prof.crmv_uf) : "";
    const crmv_num  = normCRMVNum(prof.crmv_num);
    const phone     = normPhone(prof.phone);
    const email     = normEmail(prof.email);
    const is_vet    = !!prof.is_vet || (!!crmv_uf && !!crmv_num); // se informou CRMV, assume vet
    const icp_enabled = !!prof.icp_enabled;

    // assinatura imagem opcional (DataURL)
    var sig = prof.signature_image_dataurl;
    if(sig != null){
      sig = String(sig);
      if(sig && sig.indexOf("data:image/") !== 0) throw new Error("Assinatura inválida (esperado imagem).");
      if(sig && sig.length > 400000) throw new Error("Assinatura muito grande. Use imagem menor.");
    } else {
      sig = null;
    }

    const u = await getUserById(userId);
    if(!u) throw new Error("Usuário não encontrado.");

    const before = (u.professional || {});
    const after = {
      is_vet: is_vet,
      full_name: full_name || "",
      crmv_uf: crmv_uf || "",
      crmv_num: crmv_num || "",
      phone: phone || "",
      email: email || "",
      signature_image_dataurl: sig,
      icp_enabled: icp_enabled,
      updated_at: nowISO()
    };

    // Auditar somente diffs relevantes
    function diffField(k){
      const a = (before && before[k] != null) ? String(before[k]) : "";
      const b = (after && after[k] != null) ? String(after[k]) : "";
      return (a !== b);
    }
    const changed = ["is_vet","full_name","crmv_uf","crmv_num","phone","email","icp_enabled","signature_image_dataurl"].filter(diffField);
    if(changed.length === 0){
      return { ok:true, changed:[], user_id:userId };
    }

    await tx([S_USERS], "readwrite", (s) => {
      const rq = s[S_USERS].get(userId);
      rq.onsuccess = () => {
        const v = rq.result;
        if(!v) return;
        v.professional = after;
        v.updated_at = nowISO();
        s[S_USERS].put(v);
      };
    });

    await audit("ADMIN_PROF_UPDATE", userId, "fields=" + changed.join(","));
    return { ok:true, changed: changed, user_id: userId };
  }


  
  // ============================================================
  // PROFESSIONAL PROFILE (CRMV/Assinatura) — SELF-SERVICE
  // - Permite o usuário manter seu próprio perfil profissional
  // - Alterações são auditadas (auth_audit_log)
  // - Fail-closed: exige sessão válida
  // ============================================================
  async function updateMyProfessionalProfile(prof){
    prof = prof || {};
    const cur = await getCurrentUser();
    if(!cur || !cur.id) throw new Error("Usuário não autenticado.");

    const full_name = normName(prof.full_name);
    const crmv_uf   = prof.crmv_uf ? normUF(prof.crmv_uf) : "";
    const crmv_num  = normCRMVNum(prof.crmv_num);
    const phone     = normPhone(prof.phone);
    const email     = normEmail(prof.email);
    const is_vet    = !!prof.is_vet || (!!crmv_uf && !!crmv_num);
    const icp_enabled = !!prof.icp_enabled;

    var sig = prof.signature_image_dataurl;
    if(sig != null){
      sig = String(sig);
      if(sig && sig.indexOf("data:image/") !== 0) throw new Error("Assinatura inválida (esperado imagem).");
      if(sig && sig.length > 400000) throw new Error("Assinatura muito grande. Use imagem menor.");
    } else {
      sig = null;
    }

    const u = await getUserById(cur.id);
    if(!u) throw new Error("Usuário não encontrado.");

    const before = (u.professional || {});
    const after = {
      is_vet: is_vet,
      full_name: full_name || "",
      crmv_uf: crmv_uf || "",
      crmv_num: crmv_num || "",
      phone: phone || "",
      email: email || "",
      signature_image_dataurl: sig,
      icp_enabled: icp_enabled,
      updated_at: nowISO()
    };

    function diffField(k){
      const a = (before && before[k] != null) ? String(before[k]) : "";
      const b = (after && after[k] != null) ? String(after[k]) : "";
      return (a !== b);
    }
    const changed = ["is_vet","full_name","crmv_uf","crmv_num","phone","email","icp_enabled","signature_image_dataurl"].filter(diffField);
    if(changed.length === 0){
      return { ok:true, changed:[], user_id:cur.id };
    }

    await tx([S_USERS], "readwrite", (s) => {
      const rq = s[S_USERS].get(cur.id);
      rq.onsuccess = () => {
        const v = rq.result;
        if(!v) return;
        v.professional = after;
        v.updated_at = nowISO();
        s[S_USERS].put(v);
      };
    });

    await audit("SELF_PROF_UPDATE", cur.id, "fields=" + changed.join(","));
    return { ok:true, changed: changed, user_id:cur.id };
  }


async function listLoginUsers(){
  // Lista pública mínima para a tela de login (não expõe dados sensíveis)
  const db = await openDB();
  try{
    return await new Promise((resolve, reject) => {
      const out = [];
      const tx0 = db.transaction([S_USERS], "readonly");
      const st = tx0.objectStore(S_USERS);
      const rq = st.openCursor();
      rq.onerror = () => reject(rq.error || new Error("cursor error"));
      rq.onsuccess = () => {
        const cur = rq.result;
        if(!cur) return resolve(out);
        const v = cur.value;
        if(v && v.username){
          const status = (v.status || "ACTIVE");
          if(String(status).toUpperCase() === "ACTIVE"){
            out.push({ username: v.username });
          }
        }
        cur.continue();
      };
    });
  }finally{
    try{ db.close(); }catch(_){}
  }
}



async function devResetBootstrapUsers(){
  const host = String(location.hostname||"").toLowerCase();
  const isLocal = (host === "localhost" || host === "127.0.0.1" || host === "[::1]");
  if(!isLocal) throw new Error("Recuperação bloqueada fora de ambiente local.");

  await bootstrap();

  const master = await getUserByUsername("master");
  const admin  = await getUserByUsername("admin");

  const out = { ok:true, master:false, admin:false, master_password:null, admin_password:null };

  async function resetOne(u, fixedPassword){
    if(!u) return null;
    const temp = String(fixedPassword||"");
    const salt = randomBytes(16);
    const hash = await kdfPbkdf2(temp, salt, PBKDF2_ITERATIONS);
    u.password_hash = b64Encode(hash);
    u.password_salt = b64Encode(salt);
    u.password_iter = PBKDF2_ITERATIONS;
    u.force_change_password = true;
    u.failed_attempts = 0;
    u.lock_until = null;
    u.updated_at = nowISO();
    try{ delete u.password_plain; }catch(_){}
    try{ delete u.password; }catch(_){}
    try{ delete u.senha; }catch(_){}
    try{ delete u.pass; }catch(_){}
    await updateUser(u);
    await audit("DEV_RESET_BOOTSTRAP_USER", u.id, "username=" + u.username);
    return temp;
  }

  if(master){
    const pw = await resetOne(master, "Master@1234");
    out.master = true;
    out.master_password = pw;
  }
  // admin não deve existir como usuário padrão: se existir, desativa.
  if(admin){
    try{
      admin.status = "INACTIVE";
      admin.failed_attempts = 0;
      admin.lock_until = null;
      admin.updated_at = nowISO();
      await updateUser(admin);
      await audit("DEV_DEACTIVATE_ADMIN", admin.id, "admin_disabled");
    }catch(_){ }
  }

  console.warn("[VSC_AUTH] RECOVERY DEV:",
    out.master ? ("\n  master: " + out.master_password) : "\n  master: (não existe)",
    "\n  admin : desativado (se existia)"
  );
  return out;
}

async function selfTest(){
    const out = {
      build: window.__VSC_AUTH_BUILD,
      hasVSC_DB: !!window.VSC_DB,
      hasCryptoSubtle: !!(crypto && crypto.subtle),
      session_id: null,
      currentUser: null,
      error: null
    };
    try{
      await bootstrap();
      out.session_id = await getCurrentSessionId();
      out.currentUser = await getCurrentUser();
    }catch(e){
      out.error = String(e && (e.message||e));
    }
    return out;
  }

  
// ============================================================
// ADMIN — Lock/Unlock (bloqueio de conta) — Enterprise
// - Permite ADMIN/MASTER limpar ou definir lock_until manualmente
// - Sempre reseta failed_attempts ao alterar lock
// ============================================================

function parseISOorNull(v){
  if(v == null) return null;
  v = String(v||"").trim();
  if(!v) return null;
  const ms = Date.parse(v);
  if(!isFinite(ms)) throw new Error("lock_until inválido (ISO esperado).");
  return new Date(ms).toISOString();
}

async function adminClearUserLock(userId, reason){
  await requireRole(ROLE_ADMIN); // ADMIN ou MASTER
  const u = await getUserById(userId);
  if(!u) throw new Error("Usuário não encontrado.");
  u.failed_attempts = 0;
  u.lock_until = null;
  u.updated_at = nowISO();
  await updateUser(u);
  await audit("ADMIN_LOCK_CLEAR", u.id, String(reason||"admin_clear"));
  return { ok:true };
}

async function adminSetUserLockUntil(userId, lockUntilISO, reason){
  await requireRole(ROLE_ADMIN); // ADMIN ou MASTER
  const u = await getUserById(userId);
  if(!u) throw new Error("Usuário não encontrado.");
  const iso = parseISOorNull(lockUntilISO);
  u.failed_attempts = 0;
  u.lock_until = iso;
  u.updated_at = nowISO();
  await updateUser(u);
  await audit("ADMIN_LOCK_SET", u.id, "lock_until=" + (iso||"null") + " reason=" + String(reason||"admin_set"));
  return { ok:true, lock_until: iso };
}


// Exposição pública (API canônica)
  window.VSC_AUTH = {
    bootstrap,
    selfTest,
    login,
    logout,
    getCurrentUser,
    requireRole,
    requirePermission,
    changePassword,
    adminCreateUser,
    listUsers,
    adminClearUserLock,
    adminSetUserLockUntil,
    listLoginUsers,
    devResetBootstrapUsers,
    adminGetUser,
    adminUpdateProfessionalProfile,
    updateMyProfessionalProfile,
    revokeAllSessionsForUser,
    CONST: {
      ROLE_MASTER, ROLE_ADMIN, ROLE_USER,
      ROLE_ID_MASTER, ROLE_ID_ADMIN, ROLE_ID_USER,
      MODULE_CONFIG
    }
  };

  console.log("[VSC_AUTH] ready", { build: window.__VSC_AUTH_BUILD });

  // Dispara READY (Promise + evento)
  try{
    window.__VSC_AUTH_READY_FIRED = true;
    if(typeof window.__VSC_AUTH_READY_RESOLVE === "function"){
      try{ window.__VSC_AUTH_READY_RESOLVE(true); }catch(_){ }
    }
    try{ window.dispatchEvent(new Event("VSC_AUTH_READY")); }catch(_){ }
  }catch(_){ }

  // [continua na PARTE 4/4]
  // Bootstrap automático (fail-closed: só prepara RBAC/MASTER, não loga ninguém)
  // Não derruba o app se falhar; registra no console.
  (async () => {
  // Bootstrap automático determinístico:
  // - Não depende só de "openDB existir"
  // - Aguarda DB pronto (event/promise) e, como fallback, tenta abrir o DB
  // - Evita abortar por corrida de carregamento/cache
  try {
    // 1) Preferência: aguardar sinal de DB pronto (quando existir)
    let ok = await waitForDBReady(120000);

    // 2) Fallback: se o sinal não existir/for falho, tenta abrir o DB de fato (retry curto)
    let lastErr = null;
    if(!ok){
      const start = Date.now();
      while(Date.now() - start < 120000){
        try{
          if(window.VSC_DB && typeof window.VSC_DB.openDB === "function"){
            const db = await window.VSC_DB.openDB();
            try{ db && db.close && db.close(); }catch(_){}
            ok = true;
            break;
          }
        }catch(e1){
          lastErr = e1;
          const msg = String(e1 && (e1.message||e1));
          if(msg.toLowerCase().includes("bloqueado") || msg.toLowerCase().includes("blocked")){
            console.error("[VSC_AUTH] IndexedDB bloqueado. Feche outras abas/janelas do ERP e recarregue (F5).", e1);
            break;
          }
        }
        await new Promise(r=>setTimeout(r, 250));
      }
    }

    if(!ok){
      console.error("[VSC_AUTH] bootstrap abortado: DB indisponível (timeout).", lastErr || "");
      return;
    }

    if(!ok){
      console.error("[VSC_AUTH] bootstrap abortado: DB indisponível após timeout (60s).");
      return;
    }

    await bootstrap();
  } catch (e) {
    console.error("[VSC_AUTH] bootstrap error:", e);
    try { await audit("BOOTSTRAP_ERROR", null, String(e && (e.message||e))); } catch(_){}
  }
})();
})();
