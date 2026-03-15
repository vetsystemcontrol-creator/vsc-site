/* ============================================================
   VSC — ESTOQUE CORE (Enterprise) — v30
   Fonte da verdade: estoque_movimentos (imutável, append-only)
   Saldos: estoque_saldos (derivado/materializado)

   API pública: window.VSC_ESTOQUE
     .getStockMap()            → { produto_id: saldo }
     .getSaldo(produto_id)     → number
     .registrarSaida(opts)     → { ok, mov_id }
     .registrarEntrada(opts)   → { ok, mov_id }
     .estornar(mov_id)         → { ok }
     .getHistorico(produto_id) → [ movimentos ]
     .recalcularSaldos()       → { ok, recalculados }

   Alinhamento:
     - Mesmo schema de importacaoxml.js (estoque_saldos.id = produto_id+":"+lote_id)
     - Mesmo schema de atendimentos.js (produto_id, tipo SAIDA/ENTRADA)
     - Usa VSC_DB.upsertWithOutbox quando disponível (sync D1)
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
  var STORE_PRODS  = "produtos_master";

  function nowISO(){ return new Date().toISOString(); }

  function uuid(){
    try{
      if(window.VSC_UTILS && typeof window.VSC_UTILS.uuidv4 === "function") return window.VSC_UTILS.uuidv4();
    }catch(_){}
    try{ if(typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID(); }catch(_){}
    try{
      if(typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function"){
        const buf = new Uint8Array(16);
        crypto.getRandomValues(buf);
        buf[6] = (buf[6] & 0x0f) | 0x40;
        buf[8] = (buf[8] & 0x3f) | 0x80;
        const hex = Array.from(buf).map(b=>b.toString(16).padStart(2,"0")).join("");
        return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join("-");
      }
    }catch(_){}
    throw new TypeError("[ESTOQUE] ambiente sem CSPRNG para gerar UUID v4.");
  }

  function saldoKey(produtoId, loteId){
    return String(produtoId) + ":" + (loteId || "sem-lote");
  }

  // ── Helpers IDB ──────────────────────────────────────────
  async function openDB(){
    return await DB.openDB();
  }

  function hasStore(db, name){
    try{ return db.objectStoreNames.contains(name); }catch(_){ return false; }
  }

  async function idbGet(db, store, key){
    if(!hasStore(db, store)) return null;
    return new Promise(function(resolve, reject){
      var tx = db.transaction([store], "readonly");
      var req = tx.objectStore(store).get(key);
      req.onsuccess = function(){ resolve(req.result || null); };
      req.onerror   = function(){ reject(req.error); };
    });
  }

  async function idbPut(db, store, rec){
    if(!hasStore(db, store)) return;
    return new Promise(function(resolve, reject){
      var tx = db.transaction([store], "readwrite");
      var req = tx.objectStore(store).put(rec);
      req.onsuccess = function(){ resolve(req.result); };
      req.onerror   = function(){ reject(req.error); };
    });
  }

  async function idbGetAll(db, store){
    if(!hasStore(db, store)) return [];
    return new Promise(function(resolve, reject){
      var tx = db.transaction([store], "readonly");
      var req = tx.objectStore(store).getAll();
      req.onsuccess = function(){ resolve(req.result || []); };
      req.onerror   = function(){ reject(req.error); };
    });
  }

  // Usar upsertWithOutbox quando disponível (para sync com D1)
  async function syncPut(store, rec, entity, entityId){
    try{
      if(DB.upsertWithOutbox && typeof DB.upsertWithOutbox === "function"){
        await DB.upsertWithOutbox(store, rec, entity, entityId, rec);
        if(window.VSC_RELAY && typeof window.VSC_RELAY.kick === "function") window.VSC_RELAY.kick();
        return;
      }
    }catch(_){}
    // fallback direto
    var db = await openDB();
    try{ await idbPut(db, store, rec); }finally{ db.close(); }
  }

  // ── API PÚBLICA ───────────────────────────────────────────

  /**
   * Retorna mapa { produto_id: saldo } a partir de estoque_saldos.
   */
  async function getStockMap(){
    var db = await openDB();
    try{
      if(!hasStore(db, STORE_SALDOS)) return {};
      var recs = await idbGetAll(db, STORE_SALDOS);
      var map = Object.create(null);
      recs.forEach(function(v){
        var pid = String(v.produto_id || "");
        if(pid) map[pid] = (Number(map[pid]||0) + Number(v.saldo||0));
      });
      return map;
    }finally{
      db.close();
    }
  }

  /**
   * Retorna saldo total de um produto específico.
   */
  async function getSaldo(produtoId){
    var map = await getStockMap();
    return Number(map[String(produtoId)] || 0);
  }

  /**
   * Registra saída de estoque (ex: atendimento, venda manual).
   * opts: { produto_id, qtd, origem, ref_id, ref_numero, responsavel_user_id, custo_unit_cents, lote_id? }
   */
  async function registrarSaida(opts){
    return _registrar("SAIDA", opts);
  }

  /**
   * Registra entrada de estoque (ex: compra avulsa, ajuste).
   * opts: { produto_id, qtd, origem, ref_id, ref_numero, responsavel_user_id, custo_unit_cents, lote_id? }
   */
  async function registrarEntrada(opts){
    return _registrar("ENTRADA", opts);
  }

  async function _registrar(tipo, opts){
    opts = opts || {};
    var produtoId = String(opts.produto_id || "");
    var qtd       = Number(opts.qtd || 0);
    if(!produtoId) return { ok:false, msg:"produto_id obrigatório" };
    if(qtd <= 0)   return { ok:false, msg:"qtd deve ser > 0" };

    var db = await openDB();
    try{
      var now  = nowISO();
      var lote = opts.lote_id || null;
      var sk   = saldoKey(produtoId, lote);

      // Lê saldo atual
      var saldoRec = hasStore(db, STORE_SALDOS) ? (await idbGet(db, STORE_SALDOS, sk)) : null;
      var saldoBase = Number((saldoRec && saldoRec.saldo) || 0);
      var delta     = tipo === "SAIDA" ? -qtd : qtd;
      var novoSaldo = Math.max(0, saldoBase + delta);

      // 1. Atualiza estoque_saldos
      var novoSaldoRec = Object.assign({}, saldoRec || {}, {
        id: sk,
        produto_id: produtoId,
        lote_id: lote,
        saldo: novoSaldo,
        updated_at: now,
        _origem: String(opts.origem || "manual")
      });
      await syncPut(STORE_SALDOS, novoSaldoRec, "estoque_saldos", sk);

      // 2. Atualiza cache saldo_estoque no produto
      if(hasStore(db, STORE_PRODS)){
        try{
          var prod = await idbGet(db, STORE_PRODS, produtoId);
          if(prod){
            // Soma todos os saldos deste produto (pode ter múltiplos lotes)
            var allSaldos = hasStore(db, STORE_SALDOS) ? (await idbGetAll(db, STORE_SALDOS)) : [];
            var totalProd = allSaldos
              .filter(function(r){ return String(r.produto_id||"") === produtoId; })
              .reduce(function(acc, r){ return acc + Number(r.saldo||0); }, 0);
            // Ajusta com o novo saldo deste lote
            prod.saldo_estoque = Math.max(0, totalProd);
            prod.updated_at = now;
            await syncPut(STORE_PRODS, prod, "produtos", produtoId);
          }
        }catch(_){}
      }

      // 3. Registra movimento (append-only)
      var movId = uuid();
      var mov = {
        id: movId,
        produto_id: produtoId,
        produto_nome: opts.produto_nome || "",
        lote_id: lote,
        tipo: tipo,
        origem: String(opts.origem || "MANUAL"),
        ref_id: opts.ref_id || null,
        ref_numero: opts.ref_numero || null,
        responsavel_user_id: opts.responsavel_user_id || null,
        qtd_delta: delta,
        qtd_abs: qtd,
        saldo_antes: saldoBase,
        saldo_depois: novoSaldo,
        saldo_delta: novoSaldo - saldoBase,
        custo_unit_cents: Number(opts.custo_unit_cents || 0),
        custo_total_cents: Math.round(Number(opts.custo_unit_cents || 0) * qtd),
        estornado: false,
        estorno_de: null,
        created_at: now,
        updated_at: now,
        _origem: String(opts.origem || "manual")
      };
      await syncPut(STORE_MOVS, mov, "estoque_movimentos", movId);

      return { ok:true, mov_id: movId, saldo_antes: saldoBase, saldo_depois: novoSaldo };
    }finally{
      db.close();
    }
  }

  /**
   * Estorna um movimento (gera contra-lançamento).
   * Não apaga o original (ledger imutável).
   */
  async function estornar(movId){
    var db = await openDB();
    try{
      var mov = hasStore(db, STORE_MOVS) ? (await idbGet(db, STORE_MOVS, movId)) : null;
      if(!mov) return { ok:false, msg:"Movimento não encontrado: " + movId };
      if(mov.estornado) return { ok:false, msg:"Movimento já estornado." };

      // Marca original como estornado
      mov.estornado = true;
      mov.updated_at = nowISO();
      await syncPut(STORE_MOVS, mov, "estoque_movimentos", movId);

      // Gera contra-lançamento
      var tipoEstorno = mov.tipo === "SAIDA" ? "ENTRADA" : "SAIDA";
      var result = await _registrar(tipoEstorno, {
        produto_id: mov.produto_id,
        produto_nome: mov.produto_nome || "",
        qtd: Math.abs(mov.qtd_abs || Math.abs(mov.qtd_delta || 0)),
        origem: "ESTORNO",
        ref_id: movId,
        ref_numero: "ESTORNO-" + (mov.ref_numero || movId.slice(0,8)),
        responsavel_user_id: mov.responsavel_user_id || null,
        custo_unit_cents: mov.custo_unit_cents || 0,
        lote_id: mov.lote_id || null
      });

      if(result.ok){
        // Marca o estorno com referência ao original
        var db2 = await openDB();
        try{
          var estornoMov = await idbGet(db2, STORE_MOVS, result.mov_id);
          if(estornoMov){
            estornoMov.estorno_de = movId;
            await syncPut(STORE_MOVS, estornoMov, "estoque_movimentos", result.mov_id);
          }
        }finally{ db2.close(); }
      }

      return { ok:true, estorno_mov_id: result.mov_id };
    }finally{
      db.close();
    }
  }

  /**
   * Retorna histórico de movimentos de um produto.
   * Ordenado por created_at desc.
   */
  async function getHistorico(produtoId){
    var db = await openDB();
    try{
      if(!hasStore(db, STORE_MOVS)) return [];
      var all = await idbGetAll(db, STORE_MOVS);
      return all
        .filter(function(m){ return String(m.produto_id||"") === String(produtoId||""); })
        .sort(function(a, b){ return String(b.created_at||"").localeCompare(String(a.created_at||"")); });
    }finally{
      db.close();
    }
  }

  /**
   * Recalcula estoque_saldos a partir do ledger de movimentos.
   * Use em caso de inconsistência (ex: após restore de backup).
   */
  async function recalcularSaldos(){
    var db = await openDB();
    try{
      if(!hasStore(db, STORE_MOVS) || !hasStore(db, STORE_SALDOS)){
        return { ok:false, msg:"Stores não encontradas." };
      }
      var movs = await idbGetAll(db, STORE_MOVS);
      // Agrupa por saldoKey
      var mapa = Object.create(null);
      movs.forEach(function(m){
        if(m.estornado) return; // ignora estornados
        var pid = String(m.produto_id || "");
        if(!pid) return;
        var lote = m.lote_id || null;
        var sk = saldoKey(pid, lote);
        if(!mapa[sk]) mapa[sk] = { produto_id: pid, lote_id: lote, saldo: 0 };
        mapa[sk].saldo += Number(m.qtd_delta || 0);
      });
      var now = nowISO();
      var recalculados = 0;
      for(var sk in mapa){
        var item = mapa[sk];
        item.saldo = Math.max(0, item.saldo);
        var rec = {
          id: sk,
          produto_id: item.produto_id,
          lote_id: item.lote_id,
          saldo: item.saldo,
          updated_at: now,
          _origem: "recalculo"
        };
        await idbPut(db, STORE_SALDOS, rec);
        recalculados++;
      }
      // Atualiza cache saldo_estoque nos produtos
      if(hasStore(db, STORE_PRODS)){
        var prodMap = Object.create(null);
        for(var sk in mapa){
          var pid = mapa[sk].produto_id;
          prodMap[pid] = (Number(prodMap[pid]||0)) + mapa[sk].saldo;
        }
        for(var pid in prodMap){
          try{
            var prod = await idbGet(db, STORE_PRODS, pid);
            if(prod){ prod.saldo_estoque = prodMap[pid]; prod.updated_at = now; await idbPut(db, STORE_PRODS, prod); }
          }catch(_){}
        }
      }
      return { ok:true, recalculados: recalculados };
    }finally{
      db.close();
    }
  }

  // ── Exportação ───────────────────────────────────────────
  window.VSC_ESTOQUE = {
    version: 30,
    getStockMap:       getStockMap,
    getSaldo:          getSaldo,
    registrarSaida:    registrarSaida,
    registrarEntrada:  registrarEntrada,
    estornar:          estornar,
    getHistorico:      getHistorico,
    recalcularSaldos:  recalcularSaldos
  };

  console.log("[VSC_ESTOQUE] ready v30", { stores: [STORE_MOVS, STORE_SALDOS] });
})();
