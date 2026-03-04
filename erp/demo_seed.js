/* VSC SITE DEMO — seed determinístico (somente leitura)
   Objetivo: permitir visualização 1:1 das telas reais com dados fictícios.
   - NÃO envia nada para servidor.
   - Escreve apenas no IndexedDB/localStorage do navegador do visitante.
   - Só roda quando URL contém ?demo=1 ou ?print=1.
*/
(function(){
  "use strict";

  const qs = (() => { try { return new URLSearchParams(location.search); } catch(_) { return new URLSearchParams(); } })();
  const IS_DEMO = qs.get("demo") === "1" || qs.get("print") === "1";
  if (!IS_DEMO) return;

  const DEMO_FLAG_KEY = "vsc_demo_seed_v2_done";
  const DB_NAME = "vsc_db";
  const DB_VERSION = 5;

  function nowISO(){
    try { return new Date().toISOString(); } catch(_) { return "2026-03-04T00:00:00.000Z"; }
  }

  function openDB(){
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;

        const ensure = (name, keyPath) => {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath });
          }
        };

        // Stores mínimos do ERP
        ensure("clientes_master", "id");
        ensure("animais_master", "id");
        ensure("atendimentos_master", "id");
        ensure("animais_especies", "id");
        ensure("animais_racas", "id");
        ensure("animais_pelagens", "id");
        ensure("catalogs_master", "id");
        ensure("sync_queue", "id");

        // Importação XML
        ensure("produtos_master", "id");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("Falha ao abrir IndexedDB"));
    });
  }

  function txPutAll(db, storeName, rows){
    return new Promise((resolve, reject) => {
      const tx = db.transaction([storeName], "readwrite");
      const st = tx.objectStore(storeName);
      (rows || []).forEach(r => { try { st.put(r); } catch(_){} });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error("Falha em transação IDB"));
      tx.onabort = () => reject(tx.error || new Error("Transação abortada"));
    });
  }

  function safeSetLS(key, val){
    try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch(_) { return false; }
  }

  function seedData(){
    const t = nowISO();

    // Blindagem demo: nada de endereços reais / domínios reais
    const clientes = [
      { id: "CLI-DEMO-0001", nome: "Haras Modelo (DEMO)",  documento: "00.000.000/0001-00", telefone: "(00) 00000-0001", email: "contato@example.com", cidade: "Cidade Exemplo/BR", criado_em: t },
      { id: "CLI-DEMO-0002", nome: "Fazenda Demonstração (DEMO)", documento: "00.000.000/0001-00", telefone: "(00) 00000-0002", email: "financeiro@example.com", cidade: "Cidade Exemplo/BR", criado_em: t },
      { id: "CLI-DEMO-0003", nome: "Tutor Fictício (DEMO)", documento: "000.000.000-00",     telefone: "(00) 00000-0003", email: "tutor@example.com",  cidade: "Cidade Exemplo/BR", criado_em: t }
    ];

    const especies = [
      { id:"ESP-EQUINO", nome:"Equino", ativo:true },
      { id:"ESP-OVINO",  nome:"Ovino",  ativo:true }
    ];

    const racas = [
      { id:"RAC-MANG", nome:"Mangalarga Marchador", especie_id:"ESP-EQUINO", ativo:true },
      { id:"RAC-QM",   nome:"Quarto de Milha",      especie_id:"ESP-EQUINO", ativo:true },
      { id:"RAC-PSI",  nome:"Puro Sangue Inglês",   especie_id:"ESP-EQUINO", ativo:true }
    ];

    const pelagens = [
      { id:"PEL-ALAZA", nome:"Alazã", ativo:true },
      { id:"PEL-CAST",  nome:"Castanha", ativo:true },
      { id:"PEL-BAIA",  nome:"Baia", ativo:true },
      { id:"PEL-TOR",   nome:"Tordilha", ativo:true }
    ];

    const animais = [
      { id:"ANI-DEMO-0001", nome:"Eclipse",   especie_id:"ESP-EQUINO", raca_id:"RAC-MANG", pelagem_id:"PEL-CAST", sexo:"M", nascimento:"2018-09-12", cliente_id:"CLI-DEMO-0001", chip:"DEMO-0001", observacoes:"Dados demonstrativos.", criado_em:t },
      { id:"ANI-DEMO-0002", nome:"Safira",    especie_id:"ESP-EQUINO", raca_id:"RAC-QM",   pelagem_id:"PEL-BAIA", sexo:"F", nascimento:"2019-01-22", cliente_id:"CLI-DEMO-0002", chip:"DEMO-0002", observacoes:"Dados demonstrativos.", criado_em:t },
      { id:"ANI-DEMO-0003", nome:"Trovão",    especie_id:"ESP-EQUINO", raca_id:"RAC-PSI",  pelagem_id:"PEL-TOR",  sexo:"M", nascimento:"2017-03-05", cliente_id:"CLI-DEMO-0002", chip:"DEMO-0003", observacoes:"Dados demonstrativos.", criado_em:t }
    ];

    const atendimentos = [
      { id:"ATD-2026-00001", atendimento_id:"ATD-2026-00001", data:"2026-03-03", status:"concluido", cliente_id:"CLI-DEMO-0001", animal_id:"ANI-DEMO-0001", procedimento:"Exame clínico", responsavel:"Dra. Demo", valor_total:350.00, pagamentos:[{valor:350.00, data:"2026-03-03", forma:"Cartão"}], criado_em:t },
      { id:"ATD-2026-00002", atendimento_id:"ATD-2026-00002", data:"2026-03-02", status:"em_atendimento", cliente_id:"CLI-DEMO-0002", animal_id:"ANI-DEMO-0002", procedimento:"Ultrassom", responsavel:"Dr. Demo", valor_total:520.00, pagamentos:[{valor:200.00, data:"2026-03-02", forma:"Pix"}], criado_em:t },
      { id:"ATD-2026-00003", atendimento_id:"ATD-2026-00003", data:"2026-03-01", status:"orcamento", cliente_id:"CLI-DEMO-0002", animal_id:"ANI-DEMO-0003", procedimento:"Avaliação", responsavel:"Dra. Demo", valor_total:780.00, pagamentos:[], criado_em:t }
    ];

    const catalogs_master = [
      { id:"animais_especies", items: especies, updated_at:t },
      { id:"animais_racas",    items: racas,    updated_at:t },
      { id:"animais_pelagens", items: pelagens, updated_at:t }
    ];

    // Importação XML — catálogo mínimo de produtos (para vinculação automática/semelhante)
    const produtos = [
      { id:"PRD-DEMO-0001", produto_id:"PRD-DEMO-0001", nome:"Vacina Influenza Equina (DEMO)", ean:"7890000000001", ean_list:[], un_estoque:"UN", un_compra_padrao:"UN", conv_fator_compra_para_estoque:1, custo_base_cents: 12500, custo_real_cents:12500, custo_medio_cents:12500, venda_cents: 0, lotes:[], created_at:t, updated_at:t, deleted_at:null },
      { id:"PRD-DEMO-0002", produto_id:"PRD-DEMO-0002", nome:"Progesterona 300mg (DEMO)", ean:"7890000000002", ean_list:[], un_estoque:"UN", un_compra_padrao:"UN", conv_fator_compra_para_estoque:1, custo_base_cents: 9800, custo_real_cents:9800, custo_medio_cents:9800, venda_cents: 0, lotes:[], created_at:t, updated_at:t, deleted_at:null },
      { id:"PRD-DEMO-0003", produto_id:"PRD-DEMO-0003", nome:"Seringa 10ml (DEMO)", ean:"7890000000003", ean_list:[], un_estoque:"UN", un_compra_padrao:"UN", conv_fator_compra_para_estoque:1, custo_base_cents: 220, custo_real_cents:220, custo_medio_cents:220, venda_cents: 0, lotes:[], created_at:t, updated_at:t, deleted_at:null }
    ];

    // Fornecedores (usado via localStorage no módulo XML quando não há backend)
    const fornecedores = [
      { id:"FDEMO-0001", razao:"Fornecedor Demonstração (DEMO)", fantasia:"Distribuidora Exemplo", cnpj_digits:"00000000000000", cnpj:"00.000.000/0000-00", ie:"ISENTO", telefone:"(00) 00000-0000", email:"nfe@example.com", endereco:"Rua Demonstrativa", numero:"123", bairro:"Bairro Exemplo", cidade:"Cidade Exemplo", uf:"EX", cep:"00000-000", status:"ativo", created_at:t, updated_at:t, deleted_at:null }
    ];

    return { clientes, especies, racas, pelagens, animais, atendimentos, catalogs_master, produtos, fornecedores };
  }

  async function run(){
    try{ if (localStorage.getItem(DEMO_FLAG_KEY) === "1") return; }catch(_){}

    // Aguarda VSC_DB se existir
    try{
      if (window.__VSC_DB_READY && typeof window.__VSC_DB_READY.then === "function") {
        await window.__VSC_DB_READY.catch(()=>{});
      }
    }catch(_){}

    const db = await openDB();
    const d = seedData();

    await txPutAll(db, "animais_especies", d.especies);
    await txPutAll(db, "animais_racas", d.racas);
    await txPutAll(db, "animais_pelagens", d.pelagens);

    await txPutAll(db, "clientes_master", d.clientes);
    await txPutAll(db, "animais_master", d.animais);
    await txPutAll(db, "atendimentos_master", d.atendimentos);
    await txPutAll(db, "catalogs_master", d.catalogs_master);

    // XML
    await txPutAll(db, "produtos_master", d.produtos);
    safeSetLS("vsc_fornecedores_v1", d.fornecedores);

    try{ localStorage.setItem(DEMO_FLAG_KEY, "1"); }catch(_){}
    try{ db.close(); }catch(_){ }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => run().catch(()=>{}));
  } else {
    run().catch(()=>{});
  }
})();
