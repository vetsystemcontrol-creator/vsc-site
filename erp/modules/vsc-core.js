/*!
 * VSC CORE — Contract + Domain + Persistence (Offline-first)
 * Contract Version: VSC-CANON-V1
 * Scope: Core-only (no UI/DOM dependencies)
 * Encoding: UTF-8 (no BOM)
 */
(function(){
  "use strict";

  // =========================
  // Contract constants (V1)
  // =========================
  const CONTRACT_VERSION = "VSC-CANON-V1";
  const SCHEMA_VERSION   = 1;

  // Single local DB key (atomic snapshot approach)
  const DB_KEY = "vsc_db_v1";

  // Outbox key kept inside snapshot (but also mirrored for legacy compat if needed)
  const ENTITY_KEYS = [
    "empresa",
    "usuario",
    "cliente",
    "fornecedor",
    "animal",
    "produto",
    "estoque_item",
    "nfe_doc",
    "nfe_item",
    "titulo",
    "pagamento",
    "sync_queue"
  ];

  // =========================
  // Utilities
  // =========================
  function nowMs(){ return Date.now(); }

  function isObject(x){ return x !== null && typeof x === "object" && !Array.isArray(x); }

  function deepClone(x){ return JSON.parse(JSON.stringify(x)); }

  function assert(cond, msg){
    if(!cond) throw new Error(String(msg || "assertion failed"));
  }

  function pad2(n){ return String(n).padStart(2,"0"); }
  function todayYMD(){
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
  }

  function isValidYMD(s){
    if(typeof s !== "string") return false;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y,m,d] = s.split("-").map(n=>parseInt(n,10));
    if(!(y>=1900 && y<=2500)) return false;
    if(!(m>=1 && m<=12)) return false;
    if(!(d>=1 && d<=31)) return false;
    const dt = new Date(Date.UTC(y, m-1, d));
    return dt.getUTCFullYear()===y && (dt.getUTCMonth()+1)===m && dt.getUTCDate()===d;
  }

  function normalizeDoc(doc){
    if(doc==null) return null;
    const s = String(doc).replace(/\D+/g,"").trim();
    return s.length ? s : null;
  }

  function isUUIDv4(s){
    return typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
  }

  function uuidv4(){
    // RFC4122 v4 (browser-safe)
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    const rnd = (n)=>Math.floor(Math.random()*n);
    const hex = (n)=>n.toString(16).padStart(2,"0");
    const arr = new Uint8Array(16);
    for(let i=0;i<16;i++) arr[i]=rnd(256);
    arr[6] = (arr[6] & 0x0f) | 0x40;
    arr[8] = (arr[8] & 0x3f) | 0x80;
    const b = Array.from(arr).map(hex).join("");
    return `${b.slice(0,8)}-${b.slice(8,12)}-${b.slice(12,16)}-${b.slice(16,20)}-${b.slice(20)}`;
  }

  function cents(n){
    // canonical money type: int cents
    assert(Number.isFinite(n), "money must be finite");
    const v = Math.trunc(n);
    assert(v >= 0, "money cents must be >= 0");
    return v;
  }

  // =========================
  // DB Snapshot (atomic style)
  // =========================
  function emptyDB(){
    const db = {
      contract_version: CONTRACT_VERSION,
      schema_version: SCHEMA_VERSION,
      created_at: nowMs(),
      updated_at: nowMs(),
      data: {}
    };
    for(const k of ENTITY_KEYS) db.data[k] = [];
    return db;
  }

  function loadDB(){
    const raw = localStorage.getItem(DB_KEY);
    if(!raw){
      const db = emptyDB();
      saveDB(db, {silent:true});
      return db;
    }
    let db;
    try{
      db = JSON.parse(raw);
    }catch(e){
      // hard fail: corrupted snapshot
      throw new Error("DB snapshot inválido (JSON parse falhou)");
    }
    // minimal validation
    assert(isObject(db), "DB inválido (obj esperado)");
    assert(db.contract_version === CONTRACT_VERSION, "DB contract_version divergente");
    assert(db.schema_version === SCHEMA_VERSION, "DB schema_version divergente");
    assert(isObject(db.data), "DB.data inválido");
    for(const k of ENTITY_KEYS){
      if(!Array.isArray(db.data[k])) db.data[k]=[];
    }
    return db;
  }

  function saveDB(db, opts){
    opts = opts || {};
    db.updated_at = nowMs();
    const txt = JSON.stringify(db);
    // Atomic-ish for LS: single setItem write
    localStorage.setItem(DB_KEY, txt);
    if(!opts.silent){
      // optional hook for debugging
    }
  }

  function withTx(fn){
    // deterministic transaction: load -> apply -> validate -> save
    const db = loadDB();
    const next = deepClone(db);
    const res = fn(next);
    // final sanity
    assert(next.contract_version === CONTRACT_VERSION, "contract_version alterado indevidamente");
    assert(next.schema_version === SCHEMA_VERSION, "schema_version alterado indevidamente");
    saveDB(next);
    return res;
  }

  // =========================
  // Generic Repository
  // =========================
  function list(entity){
    assert(ENTITY_KEYS.includes(entity), "entity inválida");
    const db = loadDB();
    return deepClone(db.data[entity]);
  }

  function get(entity, id){
    assert(ENTITY_KEYS.includes(entity), "entity inválida");
    assert(isUUIDv4(id), "id inválido");
    const db = loadDB();
    return deepClone(db.data[entity].find(x=>x && x.id===id) || null);
  }

  function upsert(entity, obj, meta){
    assert(ENTITY_KEYS.includes(entity), "entity inválida");
    assert(isObject(obj), "obj inválido");
    meta = meta || {};
    return withTx((db)=>{
      const arr = db.data[entity];
      const now = nowMs();
      const id  = obj.id && isUUIDv4(obj.id) ? obj.id : uuidv4();
      const idx = arr.findIndex(x=>x && x.id===id);

      const base = idx>=0 ? arr[idx] : null;
      const created_at = base && typeof base.created_at==="number" ? base.created_at : now;

      const next = Object.assign({}, base||{}, obj, {
        id,
        created_at,
        updated_at: now,
        last_sync: base ? (base.last_sync ?? null) : null,
        deleted_at: obj.deleted_at ?? (base ? (base.deleted_at ?? null) : null)
      });

      // minimal invariants
      assert(isUUIDv4(next.id), "id não é UUIDv4");
      assert(typeof next.created_at==="number" && typeof next.updated_at==="number", "timestamps inválidos");
      assert(next.updated_at >= next.created_at, "updated_at < created_at");

      if(idx>=0) arr[idx]=next; else arr.push(next);

      // outbox (infra)
      if(meta.outbox !== false){
        outboxPushTx(db, "upsert", entity, next.id, next);
      }

      return deepClone(next);
    });
  }

  function softDelete(entity, id){
    assert(ENTITY_KEYS.includes(entity), "entity inválida");
    assert(isUUIDv4(id), "id inválido");
    return withTx((db)=>{
      const arr = db.data[entity];
      const idx = arr.findIndex(x=>x && x.id===id);
      if(idx<0) return null;
      const now = nowMs();
      const next = Object.assign({}, arr[idx], { deleted_at: now, updated_at: now });
      arr[idx]=next;
      outboxPushTx(db, "delete", entity, id, { id, deleted_at: now });
      return deepClone(next);
    });
  }

  // =========================
  // Outbox (sync_queue)
  // =========================
  function outboxPushTx(db, op, entity, entity_id, payload){
    const q = db.data.sync_queue;
    const now = nowMs();
    const item = {
      id: uuidv4(),
      op: String(op),
      entity: String(entity),
      entity_id: String(entity_id),
      payload_json: JSON.stringify(payload),
      attempts: 0,
      status: "pendente",
      last_error: null,
      created_at: now,
      updated_at: now,
      last_sync: null,
      deleted_at: null
    };
    q.push(item);
    return item.id;
  }

  // =========================
  // Domain: Finance (Titulo + Pagamento)
  // =========================
  function calcLiquido(t){
    const v0 = cents(t.valor_original_cents||0);
    const d  = cents(t.desconto_cents||0);
    const j  = cents(t.juros_cents||0);
    const m  = cents(t.multa_cents||0);
    const liq = Math.max(0, (v0 - d + j + m));
    return liq;
  }

  function recalcTitulo(t){
    assert(isObject(t), "titulo inválido");
    const liq = calcLiquido(t);
    const pago = cents(t.valor_pago_cents||0);
    assert(pago <= liq, "valor_pago_cents > valor_liquido_cents");
    let status = "aberto";
    if(pago === 0) status = "aberto";
    else if(pago < liq) status = "parcial";
    else status = "pago";
    return Object.assign({}, t, {
      valor_liquido_cents: liq,
      status
    });
  }

  function createTitulo(input){
    assert(isObject(input), "input inválido");
    const kind = String(input.kind||"AP");
    assert(kind==="AP" || kind==="AR", "kind inválido");
    const competencia = String(input.competencia_ymd||"");
    const venc = String(input.vencimento_ymd||"");
    assert(isValidYMD(competencia), "competencia_ymd inválida");
    assert(isValidYMD(venc), "vencimento_ymd inválida");

    const t = {
      id: uuidv4(),
      empresa_id: String(input.empresa_id||""),
      kind,
      status: "aberto",
      fornecedor_id: kind==="AP" ? String(input.fornecedor_id||"") : null,
      cliente_id:   kind==="AR" ? String(input.cliente_id||"") : null,
      documento_ref: input.documento_ref ?? null,
      descricao: input.descricao ?? "",
      competencia_ymd: competencia,
      vencimento_ymd: venc,
      emissao_ymd: input.emissao_ymd ?? null,

      valor_original_cents: cents(input.valor_original_cents||0),
      desconto_cents: cents(input.desconto_cents||0),
      juros_cents: cents(input.juros_cents||0),
      multa_cents: cents(input.multa_cents||0),
      valor_pago_cents: 0,
      valor_liquido_cents: 0,

      nfe_id: input.nfe_id ?? null,
      atendimento_id: input.atendimento_id ?? null,

      created_at: nowMs(),
      updated_at: nowMs(),
      last_sync: null,
      deleted_at: null
    };

    // referential requirements (domain-level minimal)
    if(kind==="AP") assert(isUUIDv4(t.fornecedor_id), "fornecedor_id obrigatório (UUID)");
    if(kind==="AR") assert(isUUIDv4(t.cliente_id), "cliente_id obrigatório (UUID)");
    assert(isUUIDv4(t.empresa_id), "empresa_id obrigatório (UUID)");

    return recalcTitulo(t);
  }

  function applyPagamento(titulo_id, pagamentoInput){
    assert(isUUIDv4(titulo_id), "titulo_id inválido");
    assert(isObject(pagamentoInput), "pagamento inválido");

    return withTx((db)=>{
      const titArr = db.data.titulo;
      const idx = titArr.findIndex(x=>x && x.id===titulo_id && !x.deleted_at);
      assert(idx>=0, "Título não encontrado");
      const t0 = titArr[idx];
      assert(t0.status!=="cancelado", "Título cancelado");
      assert(t0.status!=="pago", "Título já pago");

      const t = recalcTitulo(t0);
      const liq = cents(t.valor_liquido_cents||0);
      const pagoAntes = cents(t.valor_pago_cents||0);
      const vpg = cents(pagamentoInput.valor_pago_cents||0);
      assert(vpg>0, "valor_pago_cents deve ser > 0");
      assert(pagoAntes + vpg <= liq, "Pagamento excede saldo");

      const data_pag = String(pagamentoInput.data_pagamento_ymd||todayYMD());
      assert(isValidYMD(data_pag), "data_pagamento_ymd inválida");

      const meio = String(pagamentoInput.meio||"outro");

      // append-only payment event
      const pay = {
        id: uuidv4(),
        empresa_id: t.empresa_id,
        titulo_id: t.id,
        data_pagamento_ymd: data_pag,
        valor_pago_cents: vpg,
        meio,
        observacao: pagamentoInput.observacao ?? null,
        created_at: nowMs(),
        updated_at: nowMs(),
        last_sync: null,
        deleted_at: null
      };
      db.data.pagamento.push(pay);
      outboxPushTx(db, "upsert", "pagamento", pay.id, pay);

      // update title
      const novoPago = pagoAntes + vpg;
      const t1 = recalcTitulo(Object.assign({}, t, {
        valor_pago_cents: novoPago,
        updated_at: nowMs()
      }));
      titArr[idx]=t1;
      outboxPushTx(db, "upsert", "titulo", t1.id, t1);

      return { titulo: deepClone(t1), pagamento: deepClone(pay) };
    });
  }

  function cancelarTitulo(titulo_id){
    assert(isUUIDv4(titulo_id), "titulo_id inválido");
    return withTx((db)=>{
      const arr = db.data.titulo;
      const idx = arr.findIndex(x=>x && x.id===titulo_id && !x.deleted_at);
      assert(idx>=0, "Título não encontrado");
      const t0 = arr[idx];
      assert(t0.status!=="pago", "Título pago não pode ser cancelado");
      const now = nowMs();
      const t1 = Object.assign({}, t0, { status:"cancelado", updated_at: now });
      arr[idx]=t1;
      outboxPushTx(db, "upsert", "titulo", t1.id, t1);
      return deepClone(t1);
    });
  }

  // =========================
  // Public API
  // =========================
  const CORE = {
    CONTRACT_VERSION,
    SCHEMA_VERSION,
    DB_KEY,

    // utils
    nowMs,
    todayYMD,
    uuidv4,
    isUUIDv4,
    isValidYMD,
    normalizeDoc,

    // repo
    loadDB,
    list,
    get,
    upsert,
    softDelete,

    // finance domain
    finance: {
      calcLiquido,
      recalcTitulo,
      createTitulo,
      applyPagamento,
      cancelarTitulo
    }
  };

  // attach
  window.VSC_CORE = CORE;
})();