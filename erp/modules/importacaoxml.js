/* ==========================================================================
   VSC — Importação XML NF-e (Enterprise v3.1.0)
   -------------------------------------------------------------------------
   FLUXO UX CORRETO (SAP B1 / TOTVS Protheus MATA461 entrada NF-e):
   
   1. Usuário seleciona XML → clica ANALISAR
   2. Tela lista IMEDIATAMENTE: resumo NF-e + fornecedor + contas + todos os itens
   3. Cada item tem status visual claro + botões inline na própria linha:
      - VERDE  (✓ EAN exato / Mapeado): auto-vinculado, botão "Alterar" se quiser mudar
      - AMARELO (⚠ Confirmar): similaridade ≥ 95%, botão "Confirmar" ou "Outro"
      - AZUL   (🔗 Vínculo manual): botão "Alterar"
      - AZUL   (+ Criar produto): marcado para criação, botão "Vincular existente"
      - CINZA  (○ Pendente): sem match, botões "Vincular" + "Criar produto"
   4. Modal de ajuste NUNCA abre automaticamente — só via clique do usuário
   5. "Criar produto" inline cria diretamente sem modal
   6. Finalizar: grava tudo (estoque, contas a pagar, custos, CMPM)
   7. Revisão de preços: modal APÓS finalizar (não durante análise)
   
   LITERATURA:
   - NF-e SEFAZ layout 4.00 (Manual de Orientação ao Contribuinte)
   - SAP B1: Compras → Entrada de Mercadorias (grid itens, ação inline)
   - TOTVS Protheus MATA461: vínculos explícitos na grade de NF-e
   - Fowler (2018) Patterns of Enterprise App Architecture
   - FEFO (First Expired First Out) — rastreabilidade por lote/validade
   - CMPM (CPC 16 / IAS 2) — Custo Médio Ponderado Móvel
   - Transactional Outbox Pattern (offline-first, IDB + sync_queue)
   ========================================================================== */
(function () {
  "use strict";

  window.VSC_XML = window.VSC_XML || {};
  const VSC_XML = window.VSC_XML;

  // ============================================================
  // UTILITÁRIOS
  // ============================================================
  function uuidv4() {
    try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (_) {}
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = crypto.getRandomValues(new Uint8Array(1))[0] & 15;
      return (c === "x" ? r : (r & 3) | 8).toString(16);
    });
  }
  function nowISO() { return new Date().toISOString(); }
  function $(id) { return document.getElementById(id); }
  function safeTrim(s) { return s == null ? "" : String(s).trim(); }
  function onlyDigits(s) { return safeTrim(s).replace(/\D+/g, ""); }
  function normStr(s) { return safeTrim(s).toLowerCase().replace(/\s+/g, " "); }
  function escHtml(s) {
    return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }
  function normUn(u) { return safeTrim(u).toUpperCase(); }
  function toCents(v) {
    const raw = safeTrim(v); if (!raw) return 0;
    let s = raw.replace(/\s+/g,"");
    if (s.includes(".") && s.includes(",")) s = s.replace(/\./g,"").replace(",",".");
    else if (s.includes(",")) s = s.replace(",",".");
    const n = Number(s);
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
  }
  function fromCents(c) { return (Number(c||0)/100).toFixed(2).replace(".",","); }
  function toNumXML(v) { const n = Number(String(v||"").trim()); return Number.isFinite(n)?n:0; }
  function fmtBRL(cents) { return "R$\u00a0" + fromCents(cents); }
  function fmtCnpj(d) {
    const x = onlyDigits(d).slice(0,14);
    if (x.length !== 14) return x;
    return x.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
  }

  // ============================================================
  // SIMILARITY (Levenshtein)
  // ============================================================
  function levenshtein(a, b) {
    a = normStr(a); b = normStr(b);
    const m = a.length, n = b.length;
    if (!m && !n) return 0;
    const dp = Array.from({length: n+1}, (_,i) => i);
    for (let i=1; i<=m; i++) {
      let prev = dp[0]; dp[0] = i;
      for (let j=1; j<=n; j++) {
        const tmp = dp[j];
        dp[j] = Math.min(dp[j]+1, dp[j-1]+1, prev + (a[i-1]===b[j-1]?0:1));
        prev = tmp;
      }
    }
    return dp[n];
  }
  function similarity(a, b) {
    const x = normStr(a), y = normStr(b);
    const mx = Math.max(x.length, y.length);
    if (!mx) return 1;
    return (mx - levenshtein(x, y)) / mx;
  }

  // ============================================================
  // ESTADO
  // ============================================================
  const State = {
    nfe: null,
    items: [],
    fornecedorId: null,
    _editingItemIdx: null,
    _priceQueue: [],
    _priceQueueIdx: null,
  };

  // ============================================================
  // IDB / STORAGE
  // ============================================================
  async function idbGetAll(store) {
    const db = await window.VSC_DB.openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction([store], "readonly");
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => res(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => rej(req.error);
    });
  }
  async function idbUpsert(store, obj, entity, eid, origin) {
    // payload carrega metadados (origem) sem contaminar o objeto persistido
    const o = origin ? String(origin) : "NF_IMPORT";
    const payload = Object.assign({ __origin: o }, obj);
    return window.VSC_DB.upsertWithOutbox(store, obj, entity, eid, payload);
  }
  function loadLS(key) {
    try { return JSON.parse(localStorage.getItem(key) || "[]") || []; } catch(_) { return []; }
  }
  function saveLS(key, arr) {
    try { localStorage.setItem(key, JSON.stringify(arr)); return true; } catch(_) { return false; }
  }

  // ============================================================
  // VMAP — EAN → produto_id (persistido, nunca mais vincular manualmente)
  // Literatura: SAP B1 "Critério de correspondência automática"
  // ============================================================
  const VMAP_KEY = "vsc_xml_ean_map_v1";
  function vmapLoad() { try { return JSON.parse(localStorage.getItem(VMAP_KEY)||"{}") || {}; } catch(_) { return {}; } }
  function vmapSet(ean, pid) {
    if (!ean || !pid) return;
    const m = vmapLoad(); m[safeTrim(ean)] = safeTrim(pid);
    localStorage.setItem(VMAP_KEY, JSON.stringify(m));
  }
  function vmapGet(ean) {
    if (!ean) return null;
    return vmapLoad()[safeTrim(ean)] || null;
  }

  // ============================================================
  // PRODUTOS
  // ============================================================
  async function loadProdutos() {
    try { return await idbGetAll("produtos_master"); }
    catch(_) { return loadLS("vsc_produtos_v1"); }
  }
  function getProdId(p) { return safeTrim(p && (p.produto_id || p.id) || ""); }
  function findProdByEAN(list, ean) {
    const e = safeTrim(ean); if (!e) return null;
    for (const p of list) {
      if (!p || p.deleted_at) continue;
      if (safeTrim(p.ean) === e) return p;
      const extra = Array.isArray(p.ean_list) ? p.ean_list : [];
      if (extra.some(ee => safeTrim(ee) === e)) return p;
    }
    return null;
  }
  function findProdById(list, id) {
    const pid = safeTrim(id);
    return list.find(p => p && (safeTrim(p.produto_id) === pid || safeTrim(p.id) === pid)) || null;
  }
  function findBestSim(list, nome, thr = 0.95) {
    let best = null, bestS = 0;
    for (const p of list) {
      if (!p || p.deleted_at) continue;
      const s = similarity(nome, p.nome || p.descricao || "");
      if (s >= thr && s > bestS) { bestS = s; best = p; }
    }
    return best ? { produto: best, sim: bestS } : null;
  }

  // ============================================================
  // CMPM (CPC 16 / IAS 2)
  // ============================================================
  function calcCMPM(prod, novaQtd, novoCusto) {
    const lotes = Array.isArray(prod.lotes) ? prod.lotes : [];
    let tq = 0, tc = 0;
    for (const l of lotes) {
      if (!l || l.deleted_at) continue;
      tq += Number(l.qtd || 0);
      tc += Number(l.qtd || 0) * Number(l.custo_cents || 0);
    }
    tq += Number(novaQtd || 0);
    tc += Number(novaQtd || 0) * Number(novoCusto || 0);
    return tq > 0 ? Math.round(tc / tq) : Number(novoCusto || 0);
  }

  // ============================================================
  // FRACIONAMENTO
  // ============================================================
  function defaultUnEst(u) {
    const x = normUn(u);
    if (x === "KG") return "G";
    if (x === "L") return "ML";
    if (x === "CX" || x === "PCT" || x === "EMB") return "UN";
    if (x === "FR") return "ML";
    return x;
  }
  function aplicarConversao(it, prod) {

    // ============================================================
    // ENTERPRISE GOLD — Conversão SOMENTE com produto conhecido
    // Regra: u_nf (NF-e) vs u_base (produto.un_estoque)
    // Sem heurística antes do vínculo (evita FR->ML errado).
    // ============================================================
    it.unCompra = normUn(it.unidade || it.unCompra || "");

    // Sem produto vinculado: não há unidade base conhecida => não decide conversão
    if (!prod) {
      it.unEstoque = "";
      it.convFator = 1;
      it.qtdNum = Number(it.qtdNum || it.qtd || 0) || 0;
      it.qtdEstoqueNum = it.qtdNum;
      it.vUnEstoqueCents = Number(it.vUnCents || 0) || 0;
      it.convRequired = false;
      it.convOk = true;
      it._convWhy = "SEM_PRODUTO";
      return;
    }

    const uBase = prod && prod.un_estoque ? normUn(prod.un_estoque) : "";
    const uNF   = it.unCompra;

    // Se produto não tem unidade base, assume NF como base (rascunho incompleto), sem exigir conversão
    if (!uBase) {
      it.unEstoque = uNF || "";
      it.convFator = 1;
      it.qtdNum = Number(it.qtdNum || it.qtd || 0) || 0;
      it.qtdEstoqueNum = it.qtdNum;
      it.vUnEstoqueCents = Number(it.vUnCents || 0) || 0;
      it.convRequired = false;
      it.convOk = true;
      it._convWhy = "PROD_SEM_UN_BASE";
      return;
    }

    it.unEstoque = uBase;

    // Mesma unidade => sem conversão
    if (uNF && uNF === uBase) {
      it.convFator = 1;
      it.qtdNum = Number(it.qtdNum || it.qtd || 0) || 0;
      it.qtdEstoqueNum = it.qtdNum;
      it.vUnEstoqueCents = Number(it.vUnCents || 0) || 0;
      it.convRequired = false;
      it.convOk = true;
      it._convWhy = "MESMA_UNIDADE";
      return;
    }

    // Unidades divergem: precisa de fator do produto
    const fat = prod && Number(prod.conv_fator_compra_para_estoque) > 0 ? Number(prod.conv_fator_compra_para_estoque) : null;
    it.convFator = fat || 0;

    it.qtdNum = Number(it.qtdNum || it.qtd || 0) || 0;

    if (fat && isFinite(fat) && fat > 0) {
      // Compra -> Estoque: ex. 1 CT = 10 UN
      it.qtdEstoqueNum = it.qtdNum * fat;
      // custo por unidade de estoque
      it.vUnEstoqueCents = fat ? Math.round(Number(it.vUnCents || 0) / fat) : Number(it.vUnCents || 0);
      it.convRequired = false;
      it.convOk = true;
      it._convWhy = "FATOR_OK";
      return;
    }

    // Sem fator: pendente (bloqueia finalizar)
    it.qtdEstoqueNum = it.qtdNum;
    it.vUnEstoqueCents = Number(it.vUnCents || 0) || 0;
    it.convRequired = true;
    it.convOk = false;
    it._convWhy = "FATOR_PENDENTE";
  }

  // ============================================================
  // RATEIO (proporcional ao vProd — padrão SEFAZ/TOTVS/SAP)
  // ============================================================
  function calcRateio(items, rateioCents) {
    if (!rateioCents || rateioCents <= 0) {
      items.forEach(it => { it.rateioCents = 0; it.custoRealCents = it.vUnEstoqueCents || it.vUnCents || 0; });
      return;
    }
    const soma = items.reduce((a, it) => a + Number(it.vTotCents || 0), 0);
    if (!soma) {
      items.forEach(it => { it.rateioCents = 0; it.custoRealCents = it.vUnEstoqueCents || it.vUnCents || 0; });
      return;
    }
    let acc = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      it.rateioCents = i === items.length - 1 ? rateioCents - acc : Math.round((it.vTotCents / soma) * rateioCents);
      acc += it.rateioCents;
      const qtd = it.convOk && it.qtdEstoqueNum ? it.qtdEstoqueNum : (it.qtdCompraNum || it.qtdNum || 1);
      const rUn = qtd > 0 ? Math.round(it.rateioCents / qtd) : 0;
      it.custoRealCents = (it.vUnEstoqueCents || it.vUnCents || 0) + rUn;
    }
  }

  // ============================================================
  // PARSER NF-e
  // ============================================================
  function parseXml(txt) {
    const doc = new DOMParser().parseFromString(txt, "application/xml");
    if (doc.querySelector("parsererror")) return null;
    return doc;
  }
  function tf(node, sel) { const el = node.querySelector(sel); return el ? safeTrim(el.textContent) : ""; }

  function extractNfe(doc) {
    const infNFe = doc.querySelector("infNFe");
    const ide = doc.querySelector("ide"), emit = doc.querySelector("emit");
    const total = doc.querySelector("ICMSTot"), cobr = doc.querySelector("cobr");
    const chave = infNFe ? safeTrim(infNFe.getAttribute("Id")||"").replace(/^NFe/i,"") : "";
    const nNF = ide ? tf(ide,"nNF") : "";
    const dhEmi = ide ? (tf(ide,"dhEmi") || tf(ide,"dEmi")) : "";
    const emitCNPJ = emit ? (tf(emit,"CNPJ") || tf(emit,"CPF")) : "";
    const emitNome = emit ? tf(emit,"xNome") : "";
    const emitFant = emit ? tf(emit,"xFant") : "";
    const emitIE = emit ? tf(emit,"IE") : "";
    const emitEnd = emit ? emit.querySelector("enderEmit") : null;
    const vNF = total ? toNumXML(tf(total,"vNF")) : 0;
    const vFrete = total ? toNumXML(tf(total,"vFrete")) : 0;
    const vSeg = total ? toNumXML(tf(total,"vSeg")) : 0;
    const vOutro = total ? toNumXML(tf(total,"vOutro")) : 0;
    const rateioCents = Math.round((vFrete + vSeg + vOutro) * 100);
    let vencimento = "";
    const dup = cobr ? cobr.querySelector("dup") : null;
    if (dup) vencimento = tf(dup,"dVenc");

    const detNodes = Array.from(doc.querySelectorAll("det"));
    const items = detNodes.map((det, idx) => {
      const prod = det.querySelector("prod");
      const nItem = det.getAttribute("nItem") || String(idx + 1);
      const ean = prod ? (tf(prod,"cEAN") || tf(prod,"cEANTrib") || "") : "";
      const vUnCom = prod ? tf(prod,"vUnCom") : "";
      const vProdItem = prod ? tf(prod,"vProd") : "";
      const qCom = prod ? tf(prod,"qCom") : "";
      const vUnCents = toCents(vUnCom);
      const qtdNum = toNumXML(qCom);
      return {
        nItem: safeTrim(nItem),
        cProd: prod ? tf(prod,"cProd") : "",
        nome: prod ? tf(prod,"xProd") : "",
        ean: safeTrim(ean) === "SEM GTIN" ? "" : safeTrim(ean),
        unidade: prod ? tf(prod,"uCom") : "",
        qtd: safeTrim(qCom), qtdNum,
        vUnCents, vTotCents: toCents(vProdItem),
        lote: prod ? (tf(prod,"nLote") || tf(prod,"cLote")) : "",
        dFab: prod ? tf(prod,"dFab") : "",
        dVal: prod ? tf(prod,"dVal") : "",
        _raw: { vUnCom: safeTrim(vUnCom) },
        vinculoProdutoId: null, vinculoAuto: false,
        vinculoTipo: null,
        _simProdutoId: null, _simScore: 0,
        _vinculoNome: "",
        _convFatorManual: null, _venderComoEmbalagem: null, _eanAdicional: null,
        rateioCents: 0, custoRealCents: 0,
        unCompra: "", unEstoque: "", convFator: 1, convOk: true, convRequired: false,
        qtdCompraNum: 0, qtdEstoqueNum: null, vUnEstoqueCents: null,
      };
    });

    return {
      chave, numero: nNF, emissao: safeTrim(dhEmi), vencimento: safeTrim(vencimento),
      emitente: {
        cnpj: onlyDigits(emitCNPJ), nome: safeTrim(emitNome), fantasia: safeTrim(emitFant), ie: safeTrim(emitIE),
        telefone: emitEnd ? tf(emitEnd,"fone") : "", email: emit ? tf(emit,"email") : "",
        logradouro: emitEnd ? tf(emitEnd,"xLgr") : "", numero: emitEnd ? tf(emitEnd,"nro") : "",
        bairro: emitEnd ? tf(emitEnd,"xBairro") : "", cidade: emitEnd ? tf(emitEnd,"xMun") : "",
        uf: emitEnd ? tf(emitEnd,"UF") : "", cep: emitEnd ? tf(emitEnd,"CEP") : "",
      },
      totais: { vNF, vFrete, vSeg, vOutro, rateioCents },
      items,
    };
  }

  // ============================================================
  // FORNECEDOR
  // ============================================================
  async function resolveFornecedor(emit) {
    if (!emit || !emit.cnpj) return null;
    if (window.VSC && window.VSC.fornecedores && typeof window.VSC.fornecedores.getOrCreateFromExternal === "function") {
      const f = await window.VSC.fornecedores.getOrCreateFromExternal({
        cnpj: emit.cnpj, razao: emit.nome, fantasia: emit.fantasia, ie: emit.ie,
        telefone: emit.telefone, email: emit.email, endereco: emit.logradouro,
        numero: emit.numero, bairro: emit.bairro, cidade: emit.cidade, uf: emit.uf, cep: emit.cep
      });
      return f ? (f.id || f.uuid || null) : null;
    }
    try {
      const arr = loadLS("vsc_fornecedores_v1");
      const ex = arr.find(x => x && !x.deleted_at && onlyDigits(x.cnpj_digits||x.cnpj||"") === emit.cnpj);
      if (ex) return ex.id;
      const now = nowISO();
      const novo = {
        id: uuidv4(), razao: emit.nome||emit.cnpj, fantasia: emit.fantasia||"",
        cnpj_digits: emit.cnpj, cnpj: fmtCnpj(emit.cnpj), ie: emit.ie||"",
        telefone: emit.telefone||"", email: emit.email||"", endereco: emit.logradouro||"",
        numero: emit.numero||"", bairro: emit.bairro||"", cidade: emit.cidade||"",
        uf: emit.uf||"", cep: emit.cep||"",
        obs: "Criado automaticamente pela importação XML",
        status: "ativo", created_at: now, updated_at: now, deleted_at: null
      };
      arr.push(novo); saveLS("vsc_fornecedores_v1", arr);
      return novo.id;
    } catch(_) { return null; }
  }

  function nfeDateToISO(d) {
    d = safeTrim(d);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    if (/^\d{4}-\d{2}$/.test(d)) return d + "-01";
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(d)) return d.slice(6)+"-"+d.slice(3,5)+"-"+d.slice(0,2);
    return "";
  }

  // ============================================================
  // CRIAR PRODUTO
  // ============================================================
  async function criarProdutoFromItem(it, opts) {
    opts = opts || {};
    const now = nowISO(), id = uuidv4();
    const obj = {
      produto_id: id, id,
      nome: it.nome || it.cProd || "Produto importado", nome_norm: normStr(it.nome||""),
      // EAN: se base==NF, usa como principal; se base!=NF, guarda como EAN alternativo (embalagem)
      ean: (opts.eanPrincipal || ""), ean_list: (opts.eanList || []),
      custo_base_cents: Number(it.vUnCents||0),
      custo_real_cents: Number(it.custoRealCents||it.vUnCents||0),
      custo_medio_cents: Number(it.custoRealCents||it.vUnCents||0),
      venda_cents: 0,
      un_estoque: safeTrim(opts.unEstoque || it.unCompra || it.unidade || "UN"),
      un_compra_padrao: safeTrim(opts.unCompraPadrao || it.unCompra || it.unidade || "UN"),
      conv_fator_compra_para_estoque: Number(opts.convFator || 1),
      ean_pack_map: opts.eanPackMap || {},
      estoque: 0, estoque_qtd: 0,
      lotes: it.lote ? [{
        lote_id: uuidv4(), lote: it.lote,
        vencimento: nfeDateToISO(it.dVal), qtd: it.qtdEstoqueNum||it.qtdNum||0,
        custo_cents: it.custoRealCents||it.vUnEstoqueCents||it.vUnCents||0,
        created_at: now, updated_at: now, deleted_at: null
      }] : [],
      created_at: now, updated_at: now, deleted_at: null, _origem: "importacao_xml"
    };
    try { await idbUpsert("produtos_master", obj, "produtos", obj.produto_id); }
    catch(_) { const a = loadLS("vsc_produtos_v1"); a.push(obj); saveLS("vsc_produtos_v1", a); }
    return obj;
  }

  // ============================================================
  // ATUALIZAR PRODUTO após finalizar
  // ============================================================
  async function atualizarProduto(it) {
    let prods; try { prods = await idbGetAll("produtos_master"); } catch(_) { prods = loadLS("vsc_produtos_v1"); }
    const p = findProdById(prods, it.vinculoProdutoId); if (!p) return false;
    const now = nowISO();
    const qtd = it.qtdEstoqueNum || it.qtdNum || 0;
    const custo = it.custoRealCents || it.vUnEstoqueCents || it.vUnCents || 0;
    p.custo_base_cents = Number(it.vUnCents||0);
    p.custo_real_cents = custo;
    p.custo_medio_cents = calcCMPM(p, qtd, custo);
    if (it.unEstoque) p.un_estoque = it.unEstoque;
    if (it.unCompra) p.un_compra_padrao = it.unCompra;
    if (it.convFator && it.convFator > 0) p.conv_fator_compra_para_estoque = it.convFator;
    const qAt = Number(p.estoque_qtd ?? p.estoque ?? 0);
    p.estoque_qtd = qAt + qtd; p.estoque = p.estoque_qtd;
    if (it._eanAdicional) {
      if (!Array.isArray(p.ean_list)) p.ean_list = p.ean ? [p.ean] : [];
      if (!p.ean_list.includes(it._eanAdicional)) p.ean_list.push(it._eanAdicional);
    }
    if (it.lote) {
      if (!Array.isArray(p.lotes)) p.lotes = [];
      const ex = p.lotes.find(l => l && !l.deleted_at && l.lote === it.lote);
      if (ex) { ex.qtd = Number(ex.qtd||0) + qtd; ex.custo_cents = custo; ex.updated_at = now; }
      else p.lotes.push({ lote_id: uuidv4(), lote: it.lote, vencimento: nfeDateToISO(it.dVal), qtd, custo_cents: custo, created_at: now, updated_at: now, deleted_at: null });
    }
    p.updated_at = now;
    try { await idbUpsert("produtos_master", p, "produtos", getProdId(p), "AUTO"); }
    catch(_) { const a = loadLS("vsc_produtos_v1"); const i = a.findIndex(x => getProdId(x) === getProdId(p)); if (i>=0) a[i]=p; else a.push(p); saveLS("vsc_produtos_v1", a); }
    return true;
  }

  // ============================================================
  // CONTA A PAGAR
  // ============================================================
  async function criarContaPagar(nfe, fornId) {
    const v = Math.round((nfe.totais && nfe.totais.vNF || 0) * 100); if (!v) return null;
    const now = nowISO();
    const venc = nfeDateToISO(nfe.vencimento) || now.slice(0,10);
    const conta = {
      id: uuidv4(), tipo: "pagar",
      descricao: "NF-e " + safeTrim(nfe.numero) + " — " + (nfe.emitente&&nfe.emitente.nome||""),
      fornecedor_id: safeTrim(fornId||""),
      fornecedor_doc: nfe.emitente ? onlyDigits(nfe.emitente.cnpj||"") : "",
      fornecedor_nome: nfe.emitente ? safeTrim(nfe.emitente.nome||"") : "",
      numero_doc: safeTrim(nfe.numero), chave_nfe: safeTrim(nfe.chave),
      valor_centavos: v, valor_original_centavos: v, pago_centavos: 0,
      status: "aberto", vencimento: venc, emissao: nfe.emissao ? nfe.emissao.slice(0,10) : now.slice(0,10),
      pagamento_data: null, cancelado: false,
      created_at: now, updated_at: now, deleted_at: null, _origem: "importacao_xml"
    };
    try { await idbUpsert("contas_pagar", conta, "contas_pagar", conta.id); }
    catch(_) { const a = loadLS("contas_pagar"); a.push(conta); saveLS("contas_pagar", a); }
    return conta;
  }

  // ============================================================
  // TOAST
  // ============================================================
  function toast(msg, dur = 3500) {
    const el = $("toast"); if (!el) return;
    el.innerHTML = escHtml(String(msg||""));
    el.style.display = "block";
    clearTimeout(el.__t);
    el.__t = setTimeout(() => el.style.display = "none", dur);
  }



  // ============================================================
  // ENTERPRISE ALERT (centralizado + overlay) — PADRAO OURO
  // Tipos: "success" | "info" | "warn" | "error"
  // success pode auto-hide; error nunca auto-hide
  // ============================================================
  function ensureEnterpriseAlertStyle() {
    if (document.getElementById("vscEnterpriseAlertStyle")) return;
    const css = `
#vscEnterpriseAlertOverlay{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:99999}
#vscEnterpriseAlertOverlay .vsc-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.35)}
#vscEnterpriseAlertOverlay .vsc-dialog{position:relative;max-width:720px;width:min(720px,92vw);background:#fff;border-radius:18px;
  border:1px solid rgba(0,0,0,.12);box-shadow:0 18px 44px rgba(0,0,0,.18);padding:14px 16px}
#vscEnterpriseAlertOverlay .vsc-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
#vscEnterpriseAlertOverlay .vsc-title{font-weight:950;font-size:15px;letter-spacing:.2px;margin:0}
#vscEnterpriseAlertOverlay .vsc-sub{color:#64748b;font-size:12.5px;line-height:1.35;margin-top:6px;white-space:pre-wrap}
#vscEnterpriseAlertOverlay .vsc-actions{display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end;margin-top:12px}
#vscEnterpriseAlertOverlay .vsc-btn{appearance:none;border-radius:12px;padding:10px 12px;font-weight:950;cursor:pointer;border:1px solid rgba(0,0,0,.14);background:#fff}
#vscEnterpriseAlertOverlay .vsc-btn-primary{background:var(--green);border-color:rgba(0,0,0,0);color:#fff}
#vscEnterpriseAlertOverlay .vsc-btn-primary:hover{background:var(--green2)}
#vscEnterpriseAlertOverlay .vsc-btn-danger{background:#fef2f2;border-color:rgba(220,38,38,.30);color:#991b1b}
#vscEnterpriseAlertOverlay .vsc-kicker{display:inline-flex;align-items:center;gap:8px;font-weight:950;font-size:12px;padding:4px 10px;border-radius:999px;border:1px solid rgba(0,0,0,.10)}
#vscEnterpriseAlertOverlay .k-success{background:#f0fff5;color:var(--green2);border-color:rgba(22,163,74,.35)}
#vscEnterpriseAlertOverlay .k-info{background:#eff6ff;color:#1d4ed8;border-color:rgba(37,99,235,.35)}
#vscEnterpriseAlertOverlay .k-warn{background:#fffbeb;color:#a16207;border-color:rgba(245,158,11,.35)}
#vscEnterpriseAlertOverlay .k-error{background:#fef2f2;color:#991b1b;border-color:rgba(220,38,38,.30)}
.vsc-row-focus{outline:3px solid rgba(245,158,11,.55);outline-offset:-3px}
`;
    const st = document.createElement("style");
    st.id = "vscEnterpriseAlertStyle";
    st.textContent = css;
    document.head.appendChild(st);
  }

  function ensureEnterpriseAlertDom() {
    let ov = document.getElementById("vscEnterpriseAlertOverlay");
    if (ov) return ov;
    ensureEnterpriseAlertStyle();
    ov = document.createElement("div");
    ov.id = "vscEnterpriseAlertOverlay";
    ov.innerHTML = `
      <div class="vsc-backdrop"></div>
      <div class="vsc-dialog" role="dialog" aria-modal="true" aria-live="polite">
        <div class="vsc-head">
          <div>
            <div id="vscEA_kicker" class="vsc-kicker k-info">INFO</div>
            <p id="vscEA_title" class="vsc-title"></p>
            <div id="vscEA_body" class="vsc-sub"></div>
          </div>
          <button id="vscEA_closeX" class="vsc-btn" type="button" aria-label="Fechar">X</button>
        </div>
        <div id="vscEA_actions" class="vsc-actions"></div>
      </div>
    `;
    document.body.appendChild(ov);

    ov.querySelector(".vsc-backdrop").addEventListener("click", () => { if (!ov.__blocking) hideEnterpriseAlert(); });
    ov.querySelector("#vscEA_closeX").addEventListener("click", () => { if (!ov.__blocking) hideEnterpriseAlert(); });

    return ov;
  }

  function hideEnterpriseAlert() {
    const ov = document.getElementById("vscEnterpriseAlertOverlay");
    if (!ov) return;
    ov.__blocking = false;
    ov.style.display = "none";
    if (ov.__t) { clearTimeout(ov.__t); ov.__t = null; }
  }

  // actions: [{label, kind:"primary"|"danger"|"default", onClick}]
  function showEnterpriseAlert(type, title, body, actions, opts) {
    const ov = ensureEnterpriseAlertDom();
    const kicker = ov.querySelector("#vscEA_kicker");
    const tEl = ov.querySelector("#vscEA_title");
    const bEl = ov.querySelector("#vscEA_body");
    const aEl = ov.querySelector("#vscEA_actions");

    const tp = String(type||"info").toLowerCase();
    kicker.className = "vsc-kicker " + (tp==="success"?"k-success":tp==="warn"?"k-warn":tp==="error"?"k-error":"k-info");
    kicker.textContent = (tp==="success"?"SUCESSO":tp==="warn"?"ATENCAO":tp==="error"?"ERRO CRITICO":"STATUS");

    tEl.textContent = String(title||"");
    bEl.textContent = String(body||"");

    aEl.innerHTML = "";
    (actions||[]).forEach(a => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "vsc-btn " + (a.kind==="primary"?"vsc-btn-primary":a.kind==="danger"?"vsc-btn-danger":"");
      btn.textContent = a.label || "OK";
      btn.addEventListener("click", () => { try { a.onClick && a.onClick(); } finally { if (!ov.__blocking) hideEnterpriseAlert(); }});
      aEl.appendChild(btn);
    });

    const blocking = !!(opts && opts.blocking);
    const autoHideMs = (opts && typeof opts.autoHideMs==="number") ? opts.autoHideMs : null;

    ov.__blocking = blocking || (tp === "error");
    ov.style.display = "flex";

    if (ov.__t) { clearTimeout(ov.__t); ov.__t = null; }
    if (!ov.__blocking && autoHideMs && autoHideMs > 0) {
      ov.__t = setTimeout(() => hideEnterpriseAlert(), autoHideMs);
    }
  }

  function focusItemRow(idx) {
    try {
      const tr = document.querySelector('tr[data-idx="'+String(idx)+'"]');
      if (!tr) return;
      tr.classList.add("vsc-row-focus");
      tr.scrollIntoView({behavior:"smooth", block:"center"});
      setTimeout(() => tr.classList.remove("vsc-row-focus"), 1800);
    } catch(e){}
  }

  // ============================================================
  // DUPLICATA
  // ============================================================
  function isDuplicate(chave) {
    return loadLS("vsc_importacoes_xml_v1").some(r => r && r.nfe && r.nfe.chave === chave);
  }

  // ============================================================
  // RENDER — Resumo NF-e (bloco completo: fornecedor + NF-e + valores + conta)
  // ============================================================
  function renderResumo(nfe, fornId) {
    const e = nfe.emitente || {};
    const wrap = $("resumoNfe"); if (!wrap) return;
    const isNovo = !fornId;
    const fornBadge = isNovo
      ? '<span class="r-badge r-badge-warn">+ Criado automaticamente</span>'
      : '<span class="r-badge r-badge-ok">✓ Fornecedor cadastrado</span>';
    const ratVal = nfe.totais.rateioCents;
    const vencStr = nfeDateToISO(nfe.vencimento) || "—";
    wrap.innerHTML = `
      <div class="resumo-grid">
        <div class="r-card">
          <div class="r-card-title">📦 Fornecedor ${fornBadge}</div>
          <div class="r-card-main">${escHtml(e.nome || "—")}</div>
          ${e.fantasia ? `<div class="r-card-sub">${escHtml(e.fantasia)}</div>` : ""}
          <div class="r-card-sub">CNPJ: <b>${escHtml(fmtCnpj(e.cnpj||""))}</b>${e.ie ? " &nbsp;·&nbsp; IE: "+escHtml(e.ie) : ""}</div>
          ${e.cidade ? `<div class="r-card-sub">${escHtml(e.cidade)}${e.uf ? " / "+escHtml(e.uf) : ""}</div>` : ""}
        </div>
        <div class="r-card">
          <div class="r-card-title">🧾 NF-e nº <b>${escHtml(nfe.numero||"—")}</b></div>
          <div class="r-card-sub">Emissão: <b>${(nfe.emissao||"—").slice(0,10)}</b></div>
          <div class="r-card-sub" style="font-size:11px;word-break:break-all;">Chave: ${escHtml(nfe.chave||"—")}</div>
        </div>
        <div class="r-card">
          <div class="r-card-title">💰 Valores</div>
          <div class="r-card-main">${fmtBRL(Math.round((nfe.totais.vNF||0)*100))}</div>
          ${ratVal > 0 ? `<div class="r-card-sub">Rateio (frete/seg): ${fmtBRL(ratVal)}</div>` : ""}
        </div>
        <div class="r-card">
          <div class="r-card-title">📅 Conta a Pagar</div>
          <div class="r-card-main">Vencimento: <b>${escHtml(vencStr)}</b></div>
          <div class="r-card-sub r-badge r-badge-warn" style="margin-top:6px;display:inline-block;">Será criada ao Finalizar</div>
        </div>
      </div>
    `;
    wrap.style.display = "block";
  }

  // ============================================================
  // RENDER — Tabela de itens (literatura: SAP B1 / TOTVS grade NF-e)
  // Status visual por cor de linha + badge + botões INLINE
  // NUNCA abre modal automaticamente
  // ============================================================
  function renderItens() {
    const items = State.items;
    const wrap = $("itensWrap"); if (!wrap) return;

    const autoN = items.filter(i => i.vinculoAuto).length;
    const simN = items.filter(i => i.vinculoTipo === "PENDENTE_SIM").length;
    const pendN = items.filter(i => !i.vinculoProdutoId && i.vinculoTipo !== "PENDENTE_SIM").length;

    wrap.innerHTML = `
      <div class="itens-header">
        <span class="itens-title">Itens da Nota Fiscal (${items.length})</span>
        <span class="itens-legend">
          <span class="ldot ldot-green"></span> Auto-vinculado (${autoN})
          <span class="ldot ldot-yellow"></span> Confirmar (${simN})
          <span class="ldot ldot-gray"></span> Pendente (${pendN})
        </span>
      </div>
      <div class="tbl-scroll">
        <table class="itens-tbl">
          <thead>
            <tr>
              <th style="width:36px">#</th>
              <th>Produto (NF-e)</th>
              <th style="width:145px">EAN</th>
              <th style="width:90px">Qtd / Un.</th>
              <th style="width:105px">Custo Un.</th>
              <th style="width:115px">Custo Real</th>
              <th style="width:190px">Status / Vínculo</th>
              <th style="width:175px">Ações</th>
            </tr>
          </thead>
          <tbody id="tblItensBody"></tbody>
        </table>
      </div>
    `;

    wrap.style.display = "block";

    const tbody = $("tblItensBody"); if (!tbody) return;
    for (let i = 0; i < items.length; i++) {
      const tr = document.createElement("tr");
      tr.className = "irow " + getRowCls(items[i]);
      tr.setAttribute("data-idx", String(i));
      tr.innerHTML = buildRow(items[i], i);
      tbody.appendChild(tr);
    }

    atualizarBtnFinalizar();
  }

  function getRowCls(it) {
    if (it.vinculoAuto) return "irow-green";
    if (it.vinculoTipo === "PENDENTE_SIM") return "irow-yellow";
    if (it.vinculoTipo === "MANUAL") return "irow-indigo";
    if (it.vinculoTipo === "CRIADO") return "irow-blue";
    return "irow-gray";
  }

  function buildRow(it, i) {
    // Badge de status
    let badge = "";
    if (it.vinculoTipo === "EAN_EXATO") badge = '<span class="ibadge bg-green">✓ EAN exato</span>';
    else if (it.vinculoTipo === "VMAP") badge = '<span class="ibadge bg-green">✓ Mapeado</span>';
    else if (it.vinculoTipo === "CRIADO") badge = '<span class="ibadge bg-blue">＋ Criar produto</span>';
    else if (it.vinculoTipo === "PENDENTE_SIM") badge = '<span class="ibadge bg-yellow">⚠ Confirmar ('+Math.round((it._simScore||0)*100)+'%)</span>';
    else if (it.vinculoTipo === "MANUAL") badge = '<span class="ibadge bg-indigo">🔗 Manual</span>';
    else badge = '<span class="ibadge bg-gray">○ Pendente</span>';

    // Info do produto vinculado
    let vincInfo = "";
    if (it._vinculoNome) vincInfo = `<div class="vinfo">${escHtml(it._vinculoNome)}</div>`;

    // Conv / fracionamento
    let convTag = "";
    if (it.convRequired) convTag = '<span class="ibadge bg-red" style="margin-top:3px">⚠ Fração pendente</span>';
    else if (it.convFator > 1) convTag = `<span class="ibadge bg-orange" style="margin-top:3px">×${it.convFator} ${it.unCompra}→${it.unEstoque}</span>`;

    // BOTÕES INLINE (ação explícita, nunca auto-modal)
    let acoes = "";
    if (it.vinculoAuto || it.vinculoTipo === "MANUAL") {
      // já vinculado: só "Alterar" se quiser mudar
      acoes = `<button class="ibtn ibtn-ghost" data-act="ajustar" data-idx="${i}">Alterar vínculo</button>`;
    } else if (it.vinculoTipo === "PENDENTE_SIM") {
      // sugestão por similaridade: confirmar (abre modal pré-preenchido) ou escolher outro
      acoes = `<button class="ibtn ibtn-yellow" data-act="ajustar" data-idx="${i}">Confirmar / Ajustar</button>`;
    } else if (it.vinculoTipo === "CRIADO") {
      // marcado para criação: pode ainda vincular a existente se quiser
      acoes = `<button class="ibtn ibtn-ghost" data-act="ajustar" data-idx="${i}">Vincular existente</button>`;
    } else {
      // totalmente pendente: duas ações claras e separadas
      acoes = `<button class="ibtn ibtn-primary" data-act="ajustar" data-idx="${i}">Vincular</button>`
             + `<button class="ibtn ibtn-blue" data-act="criar" data-idx="${i}">Criar produto</button>`;
    }

    const custoReal = it.custoRealCents > 0 ? fmtBRL(it.custoRealCents) : fmtBRL(it.vUnCents||0);
    const temRateio = it.rateioCents > 0;

    return `
      <td class="td-num">${escHtml(it.nItem)}</td>
      <td class="td-nome">
        <div class="item-nome">${escHtml(it.nome || "—")}</div>
        <div class="item-meta">
          ${it.cProd ? escHtml(it.cProd)+" · " : ""}${it.lote ? "Lote: "+escHtml(it.lote) : ""}${it.dVal ? " Val: "+escHtml(it.dVal) : ""}
        </div>
        ${vincInfo}
      </td>
      <td class="td-ean td-mono">${it.ean ? escHtml(it.ean) : '<span class="muted">sem EAN</span>'}</td>
      <td class="td-qtd">${escHtml(it.qtd||"—")} <span class="muted">${escHtml(it.unidade||"")}</span></td>
      <td class="td-custo">${fmtBRL(it.vUnCents||0)}</td>
      <td class="td-custoreal">
        ${custoReal}
        ${temRateio ? `<div class="item-meta">rateio +${fmtBRL(it.rateioCents)}</div>` : ""}
      </td>
      <td class="td-status">${badge}${convTag}</td>
      <td class="td-acoes">${acoes}</td>
    `;
  }

  function updateRow(idx) {
    const tbody = $("tblItensBody"); if (!tbody) return;
    const tr = tbody.querySelector(`tr[data-idx="${idx}"]`); if (!tr) return;
    const it = State.items[idx];
    tr.className = "irow " + getRowCls(it);
    tr.innerHTML = buildRow(it, idx);
    atualizarBtnFinalizar();
  }

  function atualizarBtnFinalizar() {
    const btn = $("btnFinalizar"); if (!btn) return;
    const items = State.items;
    if (!items.length) { btn.style.display = "none"; return; }
    const sem = items.filter(it => !it.vinculoProdutoId).length;
    const convPend = items.filter(it => it.convRequired).length;
    const total = sem + convPend;
    btn.style.display = "inline-flex";
    if (total > 0) {
      btn.className = "btn-fin btn-fin-warn";
      btn.textContent = `FINALIZAR IMPORTAÇÃO  ·  ${total} pendente${total > 1 ? "s" : ""}`;
    } else {
      btn.className = "btn-fin btn-fin-ok";
      btn.textContent = "✓  FINALIZAR IMPORTAÇÃO";
    }
  }

  // ============================================================
  // MODAL DE VÍNCULO — SOMENTE via clique do usuário
  // ============================================================
  async function openModalVinculo(idx) {
    const it = State.items[idx]; if (!it) return;
    State._editingItemIdx = idx;
    const produtos = await loadProdutos();
    const sel = $("mvProduto"); if (!sel) return;

    sel.innerHTML = '<option value="">— selecionar produto do sistema —</option>';
    produtos.filter(p => p && !p.deleted_at)
      .sort((a,b) => (a.nome||"").localeCompare(b.nome||"","pt-BR"))
      .forEach(p => {
        const opt = document.createElement("option");
        opt.value = getProdId(p);
        opt.textContent = (p.nome||"(sem nome)") + (p.ean ? " — EAN " + p.ean : "");
        if (it.vinculoProdutoId && getProdId(p) === it.vinculoProdutoId) opt.selected = true;
        sel.appendChild(opt);
      });

    // Pré-seleciona sugestão por similaridade
    const sugEl = $("mvSugestao");
    if (sugEl) {
      if (it.vinculoTipo === "PENDENTE_SIM" && it._simProdutoId) {
        const ps = findProdById(produtos, it._simProdutoId);
        if (ps) { sugEl.textContent = `${ps.nome||""} (${Math.round((it._simScore||0)*100)}% similar)`; sel.value = getProdId(ps); }
      } else if (it.ean) {
        const pe = findProdByEAN(produtos, it.ean);
        sugEl.textContent = pe ? `EAN exato: ${pe.nome||""}` : "Sem sugestão automática";
      } else {
        sugEl.textContent = "Sem EAN";
      }
    }

    const mvIn = $("mvItemNome"); if (mvIn) mvIn.textContent = `#${it.nItem} — ${it.nome||"—"}`;
    const mvQtd = $("mvQtd"), mvCusto = $("mvCusto"), mvFator = $("mvFator"), mvEan = $("mvEanAdicional");
    if (mvQtd) mvQtd.value = safeTrim(it.qtd)||"";
    if (mvCusto) mvCusto.value = fromCents(it.vUnCents);
    if (mvFator) mvFator.value = it.convFator > 1 ? String(it.convFator) : "";
    const mvUnNF = $("mvUnCompraNF"); if (mvUnNF) mvUnNF.value = it.unCompra || it.unidade || "";
    const mvUE = $("mvUnEstoque");
    if (mvUE) {
      const baseOpts = ["UN","COMP","FR","ML","L","MG","G","KG","CX","CT","PCT","FD","KIT","DZ"];
      const uNF = normUn(it.unCompra||it.unidade||"");
      const set = new Set(baseOpts);
      if (uNF) set.add(uNF);
      const cur = normUn(it.unEstoque || "");
      mvUE.innerHTML = "";
      [...set].forEach(u => {
        const opt = document.createElement("option");
        opt.value = u;
        opt.textContent = u;
        if (cur && u===cur) opt.selected = true;
        mvUE.appendChild(opt);
      });
      if (State._createMode && !cur) {
        const sug = (uNF==="CT"||uNF==="CX"||uNF==="PCT"||uNF==="FD"||uNF==="KIT"||uNF==="DZ") ? "UN" : uNF;
        mvUE.value = sug;
      }
    }
    if (mvEan) mvEan.value = it._eanAdicional || "";

    const unInfo = $("mvUnidadesInfo");
    if (unInfo) unInfo.textContent = it.unCompra ? `NF-e: ${it.unCompra} → Estoque: ${it.unEstoque||"?"} | Fator atual: ${it.convFator||1}` : "";

    const mvcx = $("mvModoVendaWrap");
    if (mvcx) {
      const isCx = normUn(it.unCompra) === "CX" || normUn(it.unidade) === "CX";
      mvcx.style.display = isCx ? "block" : "none";
      const rE = $("mvVenderEmbalagem"), rU = $("mvVenderUnidade");
      if (rE) rE.checked = it._venderComoEmbalagem === true;
      if (rU) rU.checked = it._venderComoEmbalagem !== true;
    }

    const modal = $("modalVinculo");
    if (modal) modal.style.display = "flex";
  }

  VSC_XML.closeModal = function() {
    const m = $("modalVinculo"); if (m) m.style.display = "none";
    State._editingItemIdx = null;

    // reset modo criação
    State._createMode = false;
    State._focusFator = false;

    const modalTitle = $("mvTitulo"); if (modalTitle) modalTitle.textContent = "Ajustar vínculo do item";
    const btnOk = $("mvConfirmar"); if (btnOk) btnOk.textContent = "Confirmar vínculo";
  };

  VSC_XML.confirmarVinculo = async function() {
    const idx = State._editingItemIdx; if (idx == null) return;
    const it = State.items[idx]; if (!it) { VSC_XML.closeModal(); return; }

    const sel = $("mvProduto");
    let produtoId = sel ? safeTrim(sel.value) : "";

    const mvQtd = $("mvQtd"), mvCusto = $("mvCusto"), mvFator = $("mvFator"), mvEan = $("mvEanAdicional");
    const mvUE = $("mvUnEstoque");
    const uNF = normUn(it.unCompra || it.unidade || "");

    if (mvQtd && mvQtd.value) it.qtd = safeTrim(mvQtd.value);
    if (mvCusto && mvCusto.value) it.vUnCents = toCents(mvCusto.value);

    // unidade base escolhida (obrigatória no modo criação / recomendada no modo vínculo)
    const uBase = mvUE ? normUn(safeTrim(mvUE.value)) : "";

    // fator informado (somente exigido quando uNF != uBase)
    const fatorInformado = mvFator && mvFator.value ? Number(mvFator.value) : 0;

    // EAN adicional (opcional)
    if (mvEan && mvEan.value) it._eanAdicional = safeTrim(mvEan.value);

    const rE = $("mvVenderEmbalagem"); it._venderComoEmbalagem = rE ? rE.checked : false;

    // ============================================================
    // MODO CRIAÇÃO (produto não existe) — padrão-ouro enterprise
    // - define unidade base (estoque) e, se divergir, fator
    // - grava permanente no produto
    // - EAN da embalagem vira EAN alternativo quando base != NF
    // ============================================================
    if (State._createMode) {
      if (!uNF) { toast("Unidade da NF-e não identificada."); return; }
      if (!uBase) { toast("Selecione a unidade base (Estoque)."); return; }
      if (uBase !== uNF) {
        if (!(fatorInformado > 0)) { toast("Informe o fator de conversão (Compra → Estoque)."); return; }
      }

      const convF = (uBase === uNF) ? 1 : Number(fatorInformado);
      const e = safeTrim(it.ean) || "";
      const eList = e ? [e] : [];
      const ePack = (e && uBase !== uNF) ? { [e]: { u_nf: uNF, u_base: uBase, fator: convF } } : {};

      const opts = {
        unEstoque: uBase,
        unCompraPadrao: uNF,
        convFator: convF,
        eanPrincipal: (uBase === uNF) ? e : "",
        eanList: eList,
        eanPackMap: ePack
      };

      calcRateio(State.items, State.nfe.totais.rateioCents);
      const prod = await criarProdutoFromItem(it, opts);
      produtoId = getProdId(prod);

      it.vinculoProdutoId = produtoId;
      it.vinculoAuto = false;
      it.vinculoTipo = "CRIADO";
      it._vinculoNome = prod.nome || "";

      if (e) vmapSet(e, produtoId);

      // sai do modo criação
      State._createMode = false;
    }

    // ============================================================
    // MODO VÍNCULO (produto existente)
    // ============================================================
    if (!produtoId) { toast("Selecione um produto do sistema."); return; }

    it.vinculoProdutoId = produtoId;
    if (it.vinculoTipo !== "CRIADO") {
      it.vinculoAuto = false;
      it.vinculoTipo = "MANUAL";
    }

    const produtos = await loadProdutos();
    const p = findProdById(produtos, produtoId);

    // Persistência enterprise: grava unidade base e fator no produto
    if (p) {
      const now = nowISO();
      const upd = Object.assign({}, p);

      if (uBase) upd.un_estoque = uBase;
      if (uNF) upd.un_compra_padrao = uNF;

      if (uBase && uNF && uBase !== uNF) {
        const convF = (fatorInformado > 0) ? Number(fatorInformado) : (Number(upd.conv_fator_compra_para_estoque) || 0);
        if (!(convF > 0)) { toast("Informe o fator de conversão (Compra → Estoque)."); return; }
        upd.conv_fator_compra_para_estoque = convF;
        // se EAN da NF-e for embalagem e diferente do EAN principal, mantém como alternativo
        const e = safeTrim(it.ean) || "";
        if (e) {
          upd.ean_pack_map = upd.ean_pack_map || {};
          upd.ean_pack_map[e] = { u_nf: uNF, u_base: uBase, fator: convF };
          upd.ean_list = Array.isArray(upd.ean_list) ? upd.ean_list : [];
          if (!upd.ean_list.some(ee => safeTrim(ee) === e)) upd.ean_list.push(e);
        }
      } else {
        // mesma unidade => fator 1
        upd.conv_fator_compra_para_estoque = 1;
      }

      // EAN adicional vira alternativo permanente
      if (it._eanAdicional) {
        upd.ean_list = Array.isArray(upd.ean_list) ? upd.ean_list : [];
        if (!upd.ean_list.some(ee => safeTrim(ee) === it._eanAdicional)) upd.ean_list.push(it._eanAdicional);
      }

      upd.updated_at = now;
      try { await idbUpsert("produtos_master", upd, "produtos", getProdId(upd), "UI_EDIT"); }
      catch(_) { /* fallback local já existe no idbUpsert interno */ }
    }

    it._vinculoNome = p ? (p.nome||"") : (it._vinculoNome||"");
    aplicarConversao(it, p || null);
    if (it.ean) vmapSet(it.ean, produtoId);
    calcRateio(State.items, State.nfe.totais.rateioCents);

    // reset ui texts
    const btnOk = $("mvConfirmar"); if (btnOk) btnOk.textContent = "Confirmar vínculo";

    VSC_XML.closeModal();
    updateRow(idx);
    toast("Vínculo confirmado.");
  };

  
  function isPackUn(u) {
    const x = normUn(u||"");
    return x === "CT" || x === "CX" || x === "PCT" || x === "FD" || x === "KIT" || x === "DZ";
  }
// ============================================================
  // CRIAR PRODUTO INLINE (botão na linha — sem modal)
  // ============================================================
  async function criarProdutoInline(idx) {
    const it = State.items[idx]; if (!it) return;

    // Se unidade aparenta ser embalagem (CT/CX/...), padrão enterprise exige decisão mínima:
    // escolher unidade base (estoque) e, se divergir, fator de conversão.
    if (isPackUn(it.unidade || it.unCompra)) {
      State._createMode = true;
      State._focusFator = true;
      await openModalVinculo(idx);
      // no modo criação, não exigimos selecionar produto
      const sel = $("mvProduto"); if (sel) sel.value = "";
      const modalTitle = $("mvTitulo"); if (modalTitle) modalTitle.textContent = "Criar produto e definir conversão";
      const btnOk = $("mvConfirmar"); if (btnOk) btnOk.textContent = "Criar + Vincular";
      return;
    }

    // Caso simples (não embalagem): cria rascunho com unidade base = unidade NF-e (u_nf), sem conversão
    const uNF = normUn(it.unidade || it.unCompra || "UN");
    const opts = {
      unEstoque: uNF,
      unCompraPadrao: uNF,
      convFator: 1,
      eanPrincipal: safeTrim(it.ean)||"",
      eanList: safeTrim(it.ean) ? [safeTrim(it.ean)] : [],
      eanPackMap: {}
    };

    calcRateio(State.items, State.nfe.totais.rateioCents);
    const prod = await criarProdutoFromItem(it, opts);

    it.vinculoProdutoId = getProdId(prod);
    it.vinculoAuto = true;
    it.vinculoTipo = "CRIADO";
    it._vinculoNome = prod.nome || "";

    if (it.ean) vmapSet(it.ean, getProdId(prod));

    const prods = await loadProdutos();
    aplicarConversao(it, findProdById(prods, getProdId(prod)));
    calcRateio(State.items, State.nfe.totais.rateioCents);
    updateRow(idx);
    toast(`✓ "${it.nome}" marcado para criação.`);
  }

  // ============================================================
  // MODAL DE REVISÃO DE PREÇOS (abre APÓS finalizar)
  // ============================================================
  function abrirModalPrecos(queue) {
    State._priceQueue = queue.slice(); State._priceQueueIdx = 0;
    renderModalPreco();
    const m = $("modalRevisaoPreco"); if (m) m.style.display = "flex";
  }
  function renderModalPreco() {
    const q = State._priceQueue, idx = State._priceQueueIdx;
    if (!q || idx == null || idx >= q.length) return;
    const { produto: p, custoAnterior, custoNovo } = q[idx];
    const rpNome = $("rpNomeProduto"); if (rpNome) rpNome.textContent = p.nome || "";
    const rpAnt = $("rpCustoAnterior"); if (rpAnt) rpAnt.textContent = fmtBRL(custoAnterior);
    const rpNov = $("rpCustoNovo"); if (rpNov) rpNov.textContent = fmtBRL(custoNovo);
    const rpVenda = $("rpVenda"); if (rpVenda) rpVenda.value = fromCents(p.venda_cents||0);
    syncPrecoLucro();
    const prog = $("rpProgresso"); if (prog) prog.textContent = `${idx+1} de ${q.length}`;
  }
  function syncPrecoLucro() {
    const rpV = $("rpVenda"), rpL = $("rpLucro"), q = State._priceQueue, idx = State._priceQueueIdx;
    if (!rpV || !rpL || !q || idx == null || idx >= q.length) return;
    const c = q[idx].custoNovo, v = toCents(rpV.value);
    rpL.value = v > 0 ? ((v-c)/v*100).toFixed(2).replace(".",",") : "0,00";
  }
  function syncPrecoVenda() {
    const rpV = $("rpVenda"), rpL = $("rpLucro"), q = State._priceQueue, idx = State._priceQueueIdx;
    if (!rpV || !rpL || !q || idx == null || idx >= q.length) return;
    const c = q[idx].custoNovo;
    const pct = Number(String(rpL.value).replace(",","."))/100;
    if (pct < 1) rpV.value = fromCents(Math.round(c/(1-pct)));
  }
  VSC_XML.salvarRevisaoPreco = async function() {
    const q = State._priceQueue, idx = State._priceQueueIdx;
    if (!q || idx == null || idx >= q.length) return;
    const { produto: p } = q[idx];
    const rpV = $("rpVenda");
    p.custo_real_cents = q[idx].custoNovo;
    p.venda_cents = toCents(rpV ? rpV.value : "0");
    p.updated_at = nowISO();
    try { await idbUpsert("produtos_master", p, "produtos", getProdId(p), "UI_EDIT"); }
    catch(_) { const a = loadLS("vsc_produtos_v1"); const i = a.findIndex(x => getProdId(x)===getProdId(p)); if(i>=0)a[i]=p; else a.push(p); saveLS("vsc_produtos_v1",a); }
    State._priceQueueIdx++;
    if (State._priceQueueIdx >= q.length) {
      const m = $("modalRevisaoPreco"); if (m) m.style.display = "none";
      toast("Preços atualizados!");
    } else renderModalPreco();
  };
  VSC_XML.pularRevisaoPreco = function() {
    State._priceQueueIdx = (State._priceQueueIdx||0) + 1;
    if (State._priceQueueIdx >= (State._priceQueue&&State._priceQueue.length||0)) {
      const m = $("modalRevisaoPreco"); if (m) m.style.display = "none";
    } else renderModalPreco();
  };

  // ============================================================
  // VERIFICAR CUSTO ALTERADO
  // ============================================================
  async function verificarCustos(items) {
    let prods; try { prods = await idbGetAll("produtos_master"); } catch(_) { prods = loadLS("vsc_produtos_v1"); }
    const alt = [];
    for (const it of items) {
      if (!it.vinculoProdutoId || it.vinculoTipo === "CRIADO") continue;
      const p = findProdById(prods, it.vinculoProdutoId); if (!p) continue;
      const ant = Number(p.custo_real_cents || p.custo_base_cents || 0);
      const nov = Number(it.custoRealCents || it.vUnCents || 0);
      if (Math.abs(nov - ant) > 1) alt.push({ produto: p, item: it, custoAnterior: ant, custoNovo: nov });
    }
    return alt;
  }

  // ============================================================
  // ANALISAR
  // ============================================================
  VSC_XML.analisar = async function() {
    const inp = $("inputXml"); const xml = inp ? safeTrim(inp.value) : "";
    if (!xml) { toast("Nenhum arquivo XML selecionado."); return; }
    const doc = parseXml(xml);
    if (!doc) { toast("XML inválido ou corrompido."); return; }
    const nfe = extractNfe(doc);
    if (!nfe || !nfe.items.length) { toast("NF-e sem itens detectados."); return; }
    if (nfe.chave && isDuplicate(nfe.chave)) {
      toast("⛔ NF-e já importada! Chave: ..." + nfe.chave.slice(-8)); return;
    }
    const btnA = $("btnAnalisar");
    if (btnA) { btnA.disabled = true; btnA.textContent = "Analisando…"; }
    try {
      State.nfe = nfe; State.items = nfe.items;
      State.fornecedorId = await resolveFornecedor(nfe.emitente);
      const produtos = await loadProdutos();
      for (const it of State.items) {
        aplicarConversao(it, null);
        // A) VMap
        if (it.ean) { const mp = vmapGet(it.ean); if (mp) { const p = findProdById(produtos, mp); if (p) { it.vinculoProdutoId = getProdId(p); it.vinculoAuto = true; it.vinculoTipo = "VMAP"; it._vinculoNome = p.nome||""; aplicarConversao(it,p); continue; } } }
        // B) EAN exato
        if (it.ean) { const p = findProdByEAN(produtos, it.ean); if (p) { it.vinculoProdutoId = getProdId(p); it.vinculoAuto = true; it.vinculoTipo = "EAN_EXATO"; it._vinculoNome = p.nome||""; vmapSet(it.ean, getProdId(p)); aplicarConversao(it,p); continue; } }
        // C) Similaridade ≥ 95% → pendente_sim (usuário confirma pelo botão na linha)
        const m = findBestSim(produtos, it.nome, 0.95);
        if (m) { it._simProdutoId = getProdId(m.produto); it._simScore = m.sim; it.vinculoTipo = "PENDENTE_SIM"; it._vinculoNome = m.produto.nome||""; continue; }
        // D) Sem match → pendente (2 botões inline na linha)
        it.vinculoTipo = null;
      }
      calcRateio(State.items, nfe.totais.rateioCents);
      renderResumo(nfe, State.fornecedorId);
      renderItens();
      const cr = $("cardResultados"); if (cr) cr.style.display = "block";
      const autoN = State.items.filter(i => i.vinculoAuto).length;
      const simN = State.items.filter(i => i.vinculoTipo === "PENDENTE_SIM").length;
      const pendN = State.items.filter(i => !i.vinculoProdutoId && i.vinculoTipo !== "PENDENTE_SIM").length;
      toast(`Analisado: ${nfe.items.length} itens — ${autoN} auto-vinculado(s), ${simN} para confirmar, ${pendN} pendente(s).`, 6000);
    } finally {
      if (btnA) { btnA.disabled = false; btnA.textContent = "ANALISAR NOTA FISCAL"; }
    }
  };

  // ============================================================
  // FINALIZAR
  // ============================================================
  VSC_XML.finalizar = async function() {
    const nfe = State.nfe;
    if (!nfe) {
      showEnterpriseAlert("warn", "Nenhuma NF-e analisada", "Clique em ANALISAR NOTA FISCAL antes de finalizar.", [
        { label: "OK", kind: "primary", onClick: () => { const ov=document.getElementById("vscEnterpriseAlertOverlay"); if(ov) ov.__blocking=false; } }
      ], { blocking: false, autoHideMs: 0 });
      return;
    }

    const items = State.items || [];

    // ============================================================
    // CHECKLIST SAP (PRE-POSTING) — exception-based
    // 1) Sem vinculo (produto inexistente/vinculo pendente) -> bloqueia
    // 2) Conversao pendente (u_nf != u_base e sem fator) -> bloqueia e guia o usuario
    // ============================================================
    const semIdx = [];
    const convIdx = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it || !it.vinculoProdutoId) semIdx.push(i);
      else if (it.convRequired && !(it.convFator > 0)) convIdx.push(i);
    }

    if (semIdx.length || convIdx.length) {
      const lines = [];
      if (semIdx.length) lines.push("- Itens sem vinculo: " + semIdx.length);
      if (convIdx.length) lines.push("- Conversao pendente: " + convIdx.length);
      lines.push("");
      lines.push("Regra enterprise: nao e permitido finalizar com pendencias.");

      showEnterpriseAlert("error", "Bloqueio operacional: pendencias antes de finalizar", lines.join("\n"), [
        semIdx.length ? { label: "Ir para 1o sem vinculo", kind: "primary", onClick: () => { const ov=document.getElementById("vscEnterpriseAlertOverlay"); if(ov) ov.__blocking=false; focusItemRow(semIdx[0]); } } : null,
        convIdx.length ? { label: "Abrir 1a conversao", kind: "primary", onClick: () => { const ov=document.getElementById("vscEnterpriseAlertOverlay"); if(ov) ov.__blocking=false; focusItemRow(convIdx[0]); try { openModalVinculo(convIdx[0]); } catch(e){} } } : null,
        { label: "OK, vou corrigir", kind: "default", onClick: () => { const ov=document.getElementById("vscEnterpriseAlertOverlay"); if(ov) ov.__blocking=false; } }
      ].filter(Boolean), { blocking: true, autoHideMs: 0 });

      return;
    }

    const btnF = $("btnFinalizar");
    if (btnF) { btnF.disabled = true; btnF.textContent = "Finalizando..."; }
    try {
      const alterados = await verificarCustos(items);
      // Grava histórico
      const reg = {
        id: uuidv4(), created_at: nowISO(), tipo: "importacao_xml_nfe",
        fornecedor_id: State.fornecedorId||null,
        nfe: { chave: nfe.chave, numero: nfe.numero, emissao: nfe.emissao, emitente: nfe.emitente, totais: nfe.totais },
        itens: items.map(it => ({
          nItem: it.nItem, produto_id: it.vinculoProdutoId, ean: it.ean, descricao_xml: it.nome,
          qtd: it.qtdNum, qtd_estoque: it.qtdEstoqueNum||it.qtdNum, unidade: it.unidade,
          un_estoque: it.unEstoque||it.unidade, conv_fator: it.convFator||1,
          custo_cents: it.vUnCents, custo_real_cents: it.custoRealCents||it.vUnCents,
          rateio_cents: it.rateioCents||0, total_cents: it.vTotCents,
          lote: it.lote||null, dVal: it.dVal||null, vinculo_tipo: it.vinculoTipo
        }))
      };
      const hist = loadLS("vsc_importacoes_xml_v1"); hist.unshift(reg); saveLS("vsc_importacoes_xml_v1", hist);
      for (const it of items) await atualizarProduto(it);
      await criarContaPagar(nfe, State.fornecedorId);
      // Reset
      State.nfe = null; State.items = []; State.fornecedorId = null;
      const inpXml = $("inputXml"); if (inpXml) inpXml.value = "";
      const fInp = $("xmlFile"); if (fInp) fInp.value = "";
      const rN = $("resumoNfe"); if (rN) { rN.style.display="none"; rN.innerHTML=""; }
      const iW = $("itensWrap"); if (iW) { iW.style.display="none"; iW.innerHTML=""; }
      const cR = $("cardResultados"); if (cR) cR.style.display = "none";
      const bF = $("btnFinalizar"); if (bF) bF.style.display = "none";
      if (alterados.length > 0) {
        abrirModalPrecos(alterados);
        showEnterpriseAlert("success","Importacao concluida","Importacao concluida. Ha "+alterados.length+" produto(s) com custo alterado para revisao.",[{label:"OK",kind:"primary",onClick:()=>{const ov=document.getElementById("vscEnterpriseAlertOverlay"); if(ov) ov.__blocking=false;}}],{blocking:false,autoHideMs:5000});
      } else {
        showEnterpriseAlert("success","Importacao concluida","Estoque, custos e conta a pagar atualizados.",[{label:"OK",kind:"primary",onClick:()=>{const ov=document.getElementById("vscEnterpriseAlertOverlay"); if(ov) ov.__blocking=false;}}],{blocking:false,autoHideMs:3500});
      }
    } catch(err) {
      console.error("ERRO_FINALIZAR:", err);
      showEnterpriseAlert("error","Erro critico ao finalizar","Ocorreu um erro ao finalizar. Acao: abra o console (F12) e envie o erro para correcao.",[
        {label:"OK",kind:"primary",onClick:()=>{const ov=document.getElementById("vscEnterpriseAlertOverlay"); if(ov) ov.__blocking=false;}}
      ],{blocking:true,autoHideMs:0});
    } finally {
      const bF = $("btnFinalizar");
      if (bF) { bF.disabled = false; atualizarBtnFinalizar(); }
    }
  };

  // ============================================================
  // INIT
  // ============================================================
  function init() {
    const btnA = $("btnAnalisar"); if (btnA) btnA.addEventListener("click", () => VSC_XML.analisar());
    const btnF = $("btnFinalizar"); if (btnF) btnF.addEventListener("click", () => VSC_XML.finalizar());

    // Delegação de ações inline na tabela
    document.addEventListener("click", e => {
      const btn = e.target.closest("[data-act][data-idx]"); if (!btn) return;
      const act = btn.getAttribute("data-act");
      const idx = parseInt(btn.getAttribute("data-idx"), 10);
      if (isNaN(idx)) return;
      if (act === "ajustar") openModalVinculo(idx);
      if (act === "criar") criarProdutoInline(idx);
    });

    const btnCV = $("btnConfirmarVinculo"); if (btnCV) btnCV.addEventListener("click", () => VSC_XML.confirmarVinculo());

    const rpV = $("rpVenda"), rpL = $("rpLucro");
    if (rpV) rpV.addEventListener("input", syncPrecoLucro);
    if (rpL) rpL.addEventListener("input", syncPrecoVenda);
    const bSP = $("btnSalvarRevisaoPreco"); if (bSP) bSP.addEventListener("click", () => VSC_XML.salvarRevisaoPreco());
    const bPP = $("btnPularRevisaoPreco"); if (bPP) bPP.addEventListener("click", () => VSC_XML.pularRevisaoPreco());

    document.addEventListener("keydown", e => {
      if (e.key !== "Escape") return;
      const mv = $("modalVinculo"); if (mv && mv.style.display === "flex") VSC_XML.closeModal();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.VSC_XML = VSC_XML;
})();
