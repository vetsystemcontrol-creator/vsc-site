"use strict";

/**
 * ============================================================
 * COMMERCIAL GATE — ENTERPRISE VALIDATION PACK
 * - Teste negativo (produto sem nome => bloqueia)
 * - Prova Outbox (sync_queue incrementa quando existir)
 * - OK_REGISTRY (sha256 dos arquivos servidos por URL)
 * ============================================================
 */

window.VSC_COMMERCIAL_GATE = (function(){

  async function sha256HexFromUrl(url){
    const r = await fetch(url, { cache:"no-store" });
    if(!r.ok) throw new Error(`fetch ${url} => ${r.status}`);
    const buf = await r.arrayBuffer();
    const hash = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,"0")).join("");
  }

  async function countStore(store){
    const db = await VSC_DB.openDB();
    try{
      if(!db.objectStoreNames.contains(store)) return null;
      return await new Promise((res,rej)=>{
        const tx = db.transaction([store], "readonly");
        const os = tx.objectStore(store);
        const r = os.count();
        r.onsuccess = ()=>res(r.result);
        r.onerror = ()=>rej(r.error);
      });
    } finally { db.close(); }
  }

  async function negativeTestProdutoSemNome(){
    const produto = { nome:"   " };
    const fn = window.VSC__produtoSaveEnterprise || window.VSC__produtoSaveEnterprise || null;
    if(typeof fn !== "function") return { pass:false, result:{ ok:false, msg:"VSC__produtoSaveEnterprise não existe no escopo global." } };
    const r = await fn(produto);
    const pass = (r && r.ok === false);
    return { pass, result: r };
  }

  async function outboxProofProduto(){
    const before = await countStore("sync_queue");
    const fn = window.VSC__produtoSaveEnterprise || null;
    if(typeof fn !== "function") return { ok:false, before, after:before, delta:null, msg:"VSC__produtoSaveEnterprise não existe." };

    const produto = { nome: "TESTE_OUTBOX_PRODUTO_" + new Date().toISOString().slice(0,19) };
    const r = await fn(produto);
    const after = await countStore("sync_queue");

    const delta = (typeof before === "number" && typeof after === "number") ? (after - before) : null;
    return { ok: !!r?.ok, before, after, delta };
  }

  async function okRegistry(files){
    const now = new Date().toISOString();
    const out = [];
    for(const f of files){
      const h = await sha256HexFromUrl(f);
      out.push({ file: f, sha256: h });
    }
    const entry = {
      at: now,
      module: "COMMERCIAL_GATE",
      files: out
    };
    console.log("=== OK_REGISTRY ENTRY (cole no CHANGELOG/OK_REGISTRY.txt) ===");
    console.log(JSON.stringify(entry, null, 2));
    return entry;
  }

  async function runAll(){
    const selfTest = await VSC_DB.selfTest();
    const neg = await negativeTestProdutoSemNome();
    const outbox = await outboxProofProduto();

    console.log("=== COMMERCIAL GATE RESULTS ===");
    console.log({ selfTest, negative: neg, outbox });

    // DEVX: expõe o último resultado para facilitar validação manual no Console.
    // Ex.: await VSC_COMMERCIAL_GATE.runAll(); negative.pass; outbox.delta
    try{
      window.__VSC_COMMERCIAL_GATE_LAST = { selfTest, negative: neg, outbox };
      window.negative = neg;
      window.outbox = outbox;
    }catch(_){ /* noop */ }

    return { selfTest, negative: neg, outbox };
  }

  return { runAll, okRegistry };
})();
