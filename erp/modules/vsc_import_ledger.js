"use strict";

/**
 * ============================================================
 * VSC IMPORT LEDGER (Idempotent Consumer) — PREMIUM ENTERPRISE
 * Store: import_ledger
 * Regra: mesma origem + mesma chave + mesmo hash => NO-OP
 * ============================================================
 *
 * NOTA TÉCNICA (determinismo):
 * - Hash do payload precisa ser estável e RECURSIVO.
 * - JSON.stringify com "replacer array" NÃO ordena objetos aninhados.
 */

window.VSC_IMPORT_LEDGER = (function(){
  async function _db(){ return await VSC_DB.openDB(); }

  function _sha256HexFromText(txt){
    const enc = new TextEncoder();
    return crypto.subtle.digest("SHA-256", enc.encode(txt))
      .then(buf => [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,"0")).join(""));
  }

  function _stableStringify(x){
    if (x === null || typeof x !== "object") return JSON.stringify(x);
    if (Array.isArray(x)) return "[" + x.map(_stableStringify).join(",") + "]";
    const keys = Object.keys(x).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + _stableStringify(x[k])).join(",") + "}";
  }

  async function makePayloadHash(payload){
    const stable = _stableStringify(payload || {});
    return await _sha256HexFromText(stable);
  }

  async function get(key){
    const db = await _db();
    try{
      return await new Promise((res,rej)=>{
        const tx = db.transaction(["import_ledger"], "readonly");
        const os = tx.objectStore("import_ledger");
        const r = os.get(key);
        r.onsuccess = ()=>res(r.result || null);
        r.onerror = ()=>rej(r.error);
      });
    } finally { db.close(); }
  }

  async function existsSame(key, payload_hash){
    const row = await get(key);
    return !!(row && row.payload_hash === payload_hash);
  }

  async function markImported({ key, source_system, source_record_key, source_document_hash, payload_hash, result_ids }){
    const db = await _db();
    const now = new Date().toISOString();
    const row = {
      id: key,
      key,
      source_system,
      source_record_key,
      source_document_hash: source_document_hash || null,
      payload_hash,
      imported_at: now,
      result_ids: result_ids || []
    };

    try{
      await new Promise((res,rej)=>{
        const tx = db.transaction(["import_ledger"], "readwrite");
        tx.oncomplete = ()=>res(true);
        tx.onerror = ()=>rej(tx.error || new Error("tx error"));
        tx.objectStore("import_ledger").put(row);
      });
      return row;
    } finally { db.close(); }
  }

  /**
   * API premium para uso em QUALQUER importação:
   * - calcula hash do payload (estável e recursivo)
   * - checa ledger
   * - se já existe igual => NO-OP
   * - senão executa action(payload) e grava ledger
   */
  async function runIdempotent({ source_system, source_record_key, source_document_hash, payload, action }){
    if(!source_system || !source_record_key) throw new Error("runIdempotent: source_system/source_record_key obrigatórios");
    if(typeof action !== "function") throw new Error("runIdempotent: action(payload) obrigatório");

    const payload_hash = await makePayloadHash(payload || {});
    const key = `${source_system}::${source_record_key}`;

    if(await existsSame(key, payload_hash)){
      return { ok:true, noop:true, key, payload_hash };
    }

    const result = await action(payload);
    await markImported({
      key,
      source_system,
      source_record_key,
      source_document_hash,
      payload_hash,
      result_ids: Array.isArray(result?.result_ids) ? result.result_ids : []
    });

    return { ok:true, noop:false, key, payload_hash, result };
  }

  return {
    makePayloadHash,
    existsSame,
    markImported,
    runIdempotent
  };
})(); 
