/* ============================================================
   LOGIN AUTOSEED (DEV ONLY) — legado "users" store
   ------------------------------------------------------------
   Este patch existia como auto-seed automático e causava confusão
   operacional (ex.: "admin" aparecendo sem estar no cadastro real).

   Nova regra (segura):
   - Só executa em localhost/127.0.0.1
   - Só executa se URL tiver ?autoseed=1
   - Só executa se store "users" existir e estiver vazia
   - Senhas temporárias fortes são exibidas UMA vez no console
   ============================================================ */

function safeUuidV4(){
  if(window.VSC_UTILS && typeof window.VSC_UTILS.uuidv4 === "function") return window.VSC_UTILS.uuidv4();
  if(typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  if(typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function"){
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    buf[6] = (buf[6] & 0x0f) | 0x40;
    buf[8] = (buf[8] & 0x3f) | 0x80;
    const hex = Array.from(buf).map(b=>b.toString(16).padStart(2,"0")).join("");
    return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join("-");
  }
  throw new TypeError("[AUTOSEED] ambiente sem CSPRNG para gerar UUID v4.");
}

(async function autoSeedUsersDevOnly(){
  try{
    const host = String(location.hostname||"").toLowerCase();
    const isLocal = (host === "localhost" || host === "127.0.0.1" || host === "[::1]");
    if(!isLocal) return;

    let autoseed = false;
    try{
      const u = new URL(location.href);
      autoseed = (u.searchParams.get("autoseed") === "1");
    }catch(_){ autoseed = false; }
    if(!autoseed) return;

    if(!window.VSC_DB || typeof window.VSC_DB.openDB !== "function") return;
    const db = await window.VSC_DB.openDB();
    try{
      const names = Array.from(db.objectStoreNames || []);
      if(names.indexOf("users") === -1) return;

      const count = await new Promise((resolve, reject) => {
        const tx = db.transaction(["users"], "readonly");
        const st = tx.objectStore("users");
        const rq = st.count();
        rq.onsuccess = () => resolve(Number(rq.result||0));
        rq.onerror = () => reject(rq.error || new Error("count error"));
      });

      if(count > 0) return;

      const now = new Date().toISOString();
      const b64 = (bytes)=>{
        let bin="";
        const arr = new Uint8Array(bytes);
        for(let i=0;i<arr.length;i++) bin += String.fromCharCode(arr[i]);
        return btoa(bin).replace(/[^a-zA-Z0-9]/g, "");
      };
      const rb = (n)=>{
        const a = new Uint8Array(n);
        crypto.getRandomValues(a);
        return a;
      };

      const masterPass = "M@" + b64(rb(12)).slice(0,10) + "!";
      const adminPass  = "A@" + b64(rb(12)).slice(0,10) + "!";

      await new Promise((resolve, reject) => {
        const tx = db.transaction(["users"], "readwrite");
        const st = tx.objectStore("users");

        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error || new Error("tx error"));

        st.add({
          id: safeUuidV4(),
          username: "master",
          password: masterPass,
          role: "master",
          created_at: now
        });

        st.add({
          id: safeUuidV4(),
          username: "admin",
          password: adminPass,
          role: "admin",
          created_at: now
        });
      });

      console.warn("[LOGIN_AUTOSEED] (DEV) usuários padrão criados no legado store 'users' (apenas DB vazio).\n"+
        "- master / " + masterPass + "\n"+
        "- admin  / " + adminPass + "\n"+
        "Remova ?autoseed=1 após usar.");
    } finally {
      try{ db.close(); }catch(_){ }
    }
  }catch(e){
    console.error("[LOGIN_AUTOSEED] erro:", e);
  }
})();
