/* ============================================================
   VSC — ESTOQUE CORE (Enterprise) — v29
   Fonte da verdade: estoque_movimentos (imutável)
   Saldos: estoque_saldos (derivado/materializado)
   ============================================================ */
(function(){
  "use strict";

  var DB = window.VSC_DB;
  if(!DB){
    console.warn("[VSC_ESTOQUE] VSC_DB não carregado.");
    return;
  }

  var STORE_SALDOS = "estoque_saldos";
  var STORE_MOVS   = "estoque_movimentos";

  function nowISO(){ return new Date().toISOString(); }

  async function openDB(){
    return await DB.openDB();
  }

  async function getStockMap(){
    const db = await openDB();
    try{
      if(!db.objectStoreNames.contains(STORE_SALDOS)){
        return {};
      }
      return await new Promise((resolve,reject)=>{
        const tx = db.transaction([STORE_SALDOS],"readonly");
        const st = tx.objectStore(STORE_SALDOS);
        const req = st.openCursor();
        const map = Object.create(null);
        req.onsuccess = (e)=>{
          const c = e.target.result;
          if(!c){ resolve(map); return; }
          const v = c.value || {};
          const pid = String(v.produto_id || "");
          if(pid){
            map[pid] = (Number(map[pid]||0) + Number(v.saldo||0));
          }
          c.continue();
        };
        req.onerror = ()=>reject(req.error);
      });
    } finally {
      db.close();
    }
  }

  // API mínima (para UI)
  window.VSC_ESTOQUE = {
    version: 29,
    getStockMap: getStockMap
  };

  console.log("[VSC_ESTOQUE] ready", { version: 29, stores: [STORE_MOVS, STORE_SALDOS] });
})();
