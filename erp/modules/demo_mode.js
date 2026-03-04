/* ============================================================
   VSC — DEMO/PRINT MODE (no-backend, no-db-server)
   Objetivo:
   - Permitir prints e demonstração navegável SEM backend / SEM banco externo
   - Sem tocar no fluxo real: ativa apenas com ?demo=1
   - Semeia IndexedDB (vsc_db) + sessão demo (RBAC) de forma determinística
   ============================================================ */
(() => {
  "use strict";

  function qsDemo(){
    try{
      const q = new URLSearchParams(location.search || "");
      const v = q.get("demo") || q.get("print") || "";
      if(v === "1" || v.toLowerCase() === "true") return true;
    }catch(_){}
    try{
      return localStorage.getItem("vsc_demo_mode") === "1";
    }catch(_){ return false; }
  }

  const ENABLED = qsDemo();
  if(!ENABLED) return;

  // Persistir flag (para navegação entre módulos sem perder modo)
  try{ localStorage.setItem("vsc_demo_mode","1"); }catch(_){}

  // Expor para outros módulos (se quiserem adaptar UI)
  window.VSC_DEMO = window.VSC_DEMO || {};
  window.VSC_DEMO.enabled = true;

  function nowISO(){ return new Date().toISOString(); }
  function ymd(d){
    const dt = (d instanceof Date) ? d : new Date(d);
    if(Number.isNaN(dt.getTime())) return new Date().toISOString().slice(0,10);
    return dt.toISOString().slice(0,10);
  }
  function addDays(baseYmd, days){
    const d = new Date(baseYmd + "T12:00:00");
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0,10);
  }

  async function waitDBReady(timeoutMs){
    const t = Number(timeoutMs||15000);
    const start = Date.now();
    while(true){
      try{
        if(window.__VSC_DB_READY && typeof window.__VSC_DB_READY.then === "function"){
          await Promise.race([
            window.__VSC_DB_READY,
            new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout")), t))
          ]);
          return true;
        }
      }catch(_){}
      try{
        if(window.VSC_DB && typeof window.VSC_DB.openDB === "function") return true;
      }catch(_){}
      if(Date.now()-start>t) return false;
      await new Promise(r=>setTimeout(r,50));
    }
  }

  function idbTx(db, stores, mode, fn){
    return new Promise((resolve,reject)=>{
      let tx;
      try{
        tx = db.transaction(stores, mode);
        const os = {};
        stores.forEach(s => os[s]=tx.objectStore(s));
        fn(os, tx);
        tx.oncomplete=()=>resolve(true);
        tx.onerror=()=>reject(tx.error || new Error("tx error"));
        tx.onabort=()=>reject(tx.error || new Error("tx abort"));
      }catch(e){ reject(e); }
    });
  }

  async function seed(){
    // 1) aguarda DB
    const ok = await waitDBReady(20000);
    if(!ok || !window.VSC_DB || typeof window.VSC_DB.openDB !== "function") return;

    // 2) idempotência: sys_meta.demo_seed_v1
    const db = await window.VSC_DB.openDB();
    try{
      const metaKey = "demo_seed_v1";
      const metaHas = await new Promise((res)=>{
        try{
          const tx = db.transaction(["sys_meta"],"readonly");
          const st = tx.objectStore("sys_meta");
          const rq = st.get(metaKey);
          rq.onsuccess=()=>res(!!rq.result);
          rq.onerror=()=>res(false);
        }catch(_){ res(false); }
      });
      if(metaHas){
        // garante sessão demo mesmo que já esteja semeado
        await ensureSession(db);
        return;
      }

      // 3) dados fictícios (consistentes entre módulos)
      const now = nowISO();
      const hoje = ymd(new Date());
      const mes = hoje.slice(0,7);

      const clientes = [
        {id:"cli_001", nome:"Haras Santa Aurora", doc:"12.345.678/0001-90", telefone:"(16) 99111-2233", email:"contato@santaaurora.demo", endereco:"Rod. SP-215, Km 148", cidade:"São Carlos", uf:"SP", status:"ativo", created_at:now, updated_at:now, deleted_at:null},
        {id:"cli_002", nome:"Fazenda Vale Verde", doc:"45.678.901/0001-12", telefone:"(16) 99222-3344", email:"administrativo@valeverde.demo", endereco:"Estrada Municipal 220, s/n", cidade:"Ribeirão Bonito", uf:"SP", status:"ativo", created_at:now, updated_at:now, deleted_at:null},
        {id:"cli_003", nome:"Centro Hípico Imperial", doc:"28.901.234/0001-55", telefone:"(11) 98888-7766", email:"financeiro@hipicoimperial.demo", endereco:"Av. dos Campeões, 1200", cidade:"São Paulo", uf:"SP", status:"ativo", created_at:now, updated_at:now, deleted_at:null},
        {id:"cli_004", nome:"Haras Serra Azul", doc:"33.222.111/0001-09", telefone:"(19) 99333-4455", email:"serraazul@haras.demo", endereco:"Rua das Acácias, 55", cidade:"Campinas", uf:"SP", status:"ativo", created_at:now, updated_at:now, deleted_at:null},
        {id:"cli_005", nome:"Rancho Horizonte", doc:"09.876.543/0001-66", telefone:"(16) 99444-5566", email:"rancho@horizonte.demo", endereco:"Fazenda Horizonte, Lote 7", cidade:"Araraquara", uf:"SP", status:"ativo", created_at:now, updated_at:now, deleted_at:null},
      ];

      const animais = [
        {id:"ani_001", cliente_id:"cli_001", nome:"Aurora Bella", especie:"Equino", raca:"Mangalarga Marchador", pelagem:"Castanha", sexo:"F", nascimento:"2017-09-14", status:"ativo", created_at:now, updated_at:now, deleted_at:null},
        {id:"ani_002", cliente_id:"cli_001", nome:"Trovão do Sul", especie:"Equino", raca:"Quarto de Milha", pelagem:"Baia", sexo:"M", nascimento:"2018-03-02", status:"ativo", created_at:now, updated_at:now, deleted_at:null},
        {id:"ani_003", cliente_id:"cli_002", nome:"Lua Serena", especie:"Equino", raca:"PSI", pelagem:"Alazã", sexo:"F", nascimento:"2016-11-21", status:"ativo", created_at:now, updated_at:now, deleted_at:null},
        {id:"ani_004", cliente_id:"cli_003", nome:"Ícaro Prime", especie:"Equino", raca:"Brasileiro de Hipismo", pelagem:"Tordilha", sexo:"M", nascimento:"2015-05-09", status:"ativo", created_at:now, updated_at:now, deleted_at:null},
        {id:"ani_005", cliente_id:"cli_004", nome:"Safira do Campo", especie:"Equino", raca:"Campolina", pelagem:"Preta", sexo:"F", nascimento:"2019-01-30", status:"ativo", created_at:now, updated_at:now, deleted_at:null},
        {id:"ani_006", cliente_id:"cli_005", nome:"Vento Bravo", especie:"Equino", raca:"Crioulo", pelagem:"Gateada", sexo:"M", nascimento:"2017-07-08", status:"ativo", created_at:now, updated_at:now, deleted_at:null},
        {id:"ani_007", cliente_id:"cli_002", nome:"Dama de Prata", especie:"Equino", raca:"Mangalarga Marchador", pelagem:"Tordilha", sexo:"F", nascimento:"2018-10-17", status:"ativo", created_at:now, updated_at:now, deleted_at:null},
        {id:"ani_008", cliente_id:"cli_003", nome:"Neblina", especie:"Equino", raca:"PSI", pelagem:"Baia", sexo:"F", nascimento:"2020-02-12", status:"ativo", created_at:now, updated_at:now, deleted_at:null},
      ];

      const produtos = [
        {id:"prd_001", nome:"Ivermectina 1% 50ml", ean:"7890001112223", ean_list:["7890001112223"], un_estoque:"UN", un_compra_padrao:"UN", conv_fator_compra_para_estoque:1, custo_medio_cents: 2890, preco_venda_cents: 4990, ativo:true, status:"ativo", created_at:now, updated_at:now, deleted_at:null},
        {id:"prd_002", nome:"Seringa 20ml", ean:"7890003334445", ean_list:["7890003334445"], un_estoque:"UN", un_compra_padrao:"CX", conv_fator_compra_para_estoque:100, custo_medio_cents: 90, preco_venda_cents: 250, ativo:true, status:"ativo", created_at:now, updated_at:now, deleted_at:null},
        {id:"prd_003", nome:"Antibiótico LA 100ml", ean:"7890005556667", ean_list:["7890005556667"], un_estoque:"UN", un_compra_padrao:"UN", conv_fator_compra_para_estoque:1, custo_medio_cents: 11500, preco_venda_cents: 16900, ativo:true, status:"ativo", created_at:now, updated_at:now, deleted_at:null},
        {id:"prd_004", nome:"Solução Ringer Lactato 500ml", ean:"7890007778889", ean_list:["7890007778889"], un_estoque:"UN", un_compra_padrao:"CX", conv_fator_compra_para_estoque:12, custo_medio_cents: 820, preco_venda_cents: 1490, ativo:true, status:"ativo", created_at:now, updated_at:now, deleted_at:null},
      ];

      const servicos = [
        {id:"srv_001", nome:"Consulta Clínica Equina", codigo:"CONS-EQ", desc:"Avaliação clínica completa", categoria:"Clínica", tipo:"servico", preco_base_cents: 28000, ativo:true, status:"ativo", created_at:now, updated_at:now, deleted_at:null},
        {id:"srv_002", nome:"Atendimento de Urgência", codigo:"URG-EQ", desc:"Atendimento emergencial (plantão)", categoria:"Urgência", tipo:"servico", preco_base_cents: 45000, ativo:true, status:"ativo", created_at:now, updated_at:now, deleted_at:null},
        {id:"srv_003", nome:"Vacinação (Aplicação)", codigo:"VAC-APL", desc:"Aplicação de vacina + registro", categoria:"Preventivo", tipo:"servico", preco_base_cents: 8500, ativo:true, status:"ativo", created_at:now, updated_at:now, deleted_at:null},
      ];

      const exames = [
        {id:"exm_001", nome:"Ultrassom Reprodutivo", codigo:"USG-REP", desc:"USG transretal reprodutivo", tipo:"imagem", custo_base_cents: 6000, preco_venda_cents: 18000, ativo:true, status:"ativo", created_at:now, updated_at:now, deleted_at:null},
        {id:"exm_002", nome:"Hemograma Completo", codigo:"HEMO", desc:"Hemograma completo", tipo:"laboratorio", custo_base_cents: 4500, preco_venda_cents: 14000, ativo:true, status:"ativo", created_at:now, updated_at:now, deleted_at:null},
        {id:"exm_003", nome:"Bioquímica Sérica", codigo:"BIOQ", desc:"Painel bioquímico", tipo:"laboratorio", custo_base_cents: 7000, preco_venda_cents: 20000, ativo:true, status:"ativo", created_at:now, updated_at:now, deleted_at:null},
      ];

      // Atendimentos (alguns em orçamento, alguns finalizados)
      const atendimentos = [
        {
          id:"atd_001", numero:`ATD-${hoje.slice(0,4)}-00001`, status:"finalizado",
          cliente_id:"cli_001", cliente_label:"Haras Santa Aurora",
          animal_ids:["ani_001"], data_atendimento:addDays(hoje,-1),
          responsavel_user_id:"usr_demo", responsavel_snapshot:{ nome:"Dra. Camila Rocha (DEMO)", crmv:"SP-12345" },
          items:[
            {tipo:"servico", ref_id:"srv_001", desc:"Consulta Clínica Equina", qtd:1, unit_cents:28000, total_cents:28000},
            {tipo:"exame", ref_id:"exm_002", desc:"Hemograma Completo", qtd:1, unit_cents:14000, total_cents:14000},
          ],
          totals:{ subtotal:42000, descontos:0, acrescimos:0, total_geral:42000 },
          estoque_movimentado:false, financeiro_gerado:true, cr_id:"ar_001",
          created_at:now, updated_at:now, deleted_at:null, attachments:[]
        },
        {
          id:"atd_002", numero:`ATD-${hoje.slice(0,4)}-00002`, status:"em_atendimento",
          cliente_id:"cli_002", cliente_label:"Fazenda Vale Verde",
          animal_ids:["ani_003","ani_007"], data_atendimento:hoje,
          responsavel_user_id:"usr_demo", responsavel_snapshot:{ nome:"Dra. Camila Rocha (DEMO)", crmv:"SP-12345" },
          items:[
            {tipo:"servico", ref_id:"srv_002", desc:"Atendimento de Urgência", qtd:1, unit_cents:45000, total_cents:45000},
            {tipo:"produto", ref_id:"prd_004", desc:"Solução Ringer Lactato 500ml", qtd:2, unit_cents:1490, total_cents:2980},
          ],
          totals:{ subtotal:47980, descontos:0, acrescimos:0, total_geral:47980 },
          estoque_movimentado:true, financeiro_gerado:false, cr_id:null,
          created_at:now, updated_at:now, deleted_at:null, attachments:[]
        },
        {
          id:"atd_003", numero:`ATD-${hoje.slice(0,4)}-00003`, status:"orcamento",
          cliente_id:"cli_003", cliente_label:"Centro Hípico Imperial",
          animal_ids:["ani_004"], data_atendimento:addDays(hoje,-3),
          responsavel_user_id:"usr_demo", responsavel_snapshot:{ nome:"Dra. Camila Rocha (DEMO)", crmv:"SP-12345" },
          items:[
            {tipo:"exame", ref_id:"exm_001", desc:"Ultrassom Reprodutivo", qtd:1, unit_cents:18000, total_cents:18000},
          ],
          totals:{ subtotal:18000, descontos:0, acrescimos:0, total_geral:18000 },
          estoque_movimentado:false, financeiro_gerado:false, cr_id:null,
          created_at:now, updated_at:now, deleted_at:null, attachments:[]
        },
        {
          id:"atd_004", numero:`ATD-${hoje.slice(0,4)}-00004`, status:"finalizado",
          cliente_id:"cli_004", cliente_label:"Haras Serra Azul",
          animal_ids:["ani_005"], data_atendimento:addDays(hoje,-10),
          responsavel_user_id:"usr_demo", responsavel_snapshot:{ nome:"Dra. Camila Rocha (DEMO)", crmv:"SP-12345" },
          items:[
            {tipo:"servico", ref_id:"srv_003", desc:"Vacinação (Aplicação)", qtd:1, unit_cents:8500, total_cents:8500},
            {tipo:"produto", ref_id:"prd_001", desc:"Ivermectina 1% 50ml", qtd:1, unit_cents:4990, total_cents:4990},
          ],
          totals:{ subtotal:13490, descontos:0, acrescimos:0, total_geral:13490 },
          estoque_movimentado:true, financeiro_gerado:true, cr_id:"ar_002",
          created_at:now, updated_at:now, deleted_at:null, attachments:[]
        },
      ];

      // Contas a receber (AR) vinculado aos atendimentos finalizados
      const ar = [
        {
          id:"ar_001",
          documento:"NF-000321",
          cliente_nome:"Haras Santa Aurora",
          cliente_doc:"12.345.678/0001-90",
          competencia: mes,
          vencimento:addDays(hoje, 7),
          valor_original_centavos:42000,
          saldo_centavos:42000,
          origem:"Atendimento",
          ref_tipo:"ATENDIMENTO",
          ref_id:"atd_001",
          obs:"Título gerado automaticamente (DEMO).",
          cancelado:false,
          cancelado_at:"",
          cancelado_motivo:"",
          recebimentos:[],
          created_at:now,
          updated_at:now,
          deleted_at:null,
          status:"aberto"
        },
        {
          id:"ar_002",
          documento:"NF-000289",
          cliente_nome:"Haras Serra Azul",
          cliente_doc:"33.222.111/0001-09",
          competencia: mes,
          vencimento:addDays(hoje,-2),
          valor_original_centavos:13490,
          saldo_centavos:0,
          origem:"Atendimento",
          ref_tipo:"ATENDIMENTO",
          ref_id:"atd_004",
          obs:"Título pago (DEMO).",
          cancelado:false,
          cancelado_at:"",
          cancelado_motivo:"",
          recebimentos:[{id:"rec_001", valor_centavos:13490, data:addDays(hoje,-1), forma_pagamento:"PIX", obs:"Recebimento demo", created_at:now}],
          created_at:now,
          updated_at:now,
          deleted_at:null,
          status:"recebido"
        }
      ];

      // Reprodução: 1 caso completo + eventos/tarefas
      const repro_case = { id:"rep_001", animal_id:"ani_001", cliente_id:"cli_001", season_year:Number(hoje.slice(0,4)), objetivo:"ia", status:"coberta_ia", observacoes:"DEMO: acompanhamento reprodutivo completo.", created_at:now, updated_at:now, deleted_at:null };
      const repro_exam1 = { id:"rep_ex_001", case_id:"rep_001", data_hora:new Date(addDays(hoje,-12)+"T09:30:00").toISOString(), tipo:"usg", ovario:"E", foliculo_mm:35, ovario2:"D", foliculo2_mm:18, corpo_luteo:false, edema_uterino_score:3, cervix:"relaxado", uterus_fluid:false, uterus_fluid_mm:null, diagnostico_resumo:"Folículo dominante pronto para indução.", responsavel:"Dra. Camila Rocha (DEMO)", created_at:now, updated_at:now, deleted_at:null };
      const repro_event1 = { id:"rep_ev_001", case_id:"rep_001", data_hora:new Date(addDays(hoje,-11)+"T18:10:00").toISOString(), tipo:"IA", garanhao:"Ícaro Prime", semen_lote:"Lote DEMO-07", dose_ml:20, tecnica:"intrauterina", observacoes:"Aplicado conforme protocolo.", responsavel:"Dra. Camila Rocha (DEMO)", created_at:now, updated_at:now, deleted_at:null };
      const repro_preg = { id:"rep_pr_001", case_id:"rep_001", status:"confirmada", data_diagnostico:addDays(hoje,-1), idade_gestacional_dias:14, data_prevista_parto:addDays(hoje, 340-14), observacoes:"Gestação confirmada (DEMO).", created_at:now, updated_at:now, deleted_at:null };
      const repro_tasks = [
        { id:"rep_tk_001", case_id:"rep_001", data_hora:new Date(addDays(hoje,2)+"T08:00:00").toISOString(), tipo:"USG pós-cobertura", desc:"Avaliar útero pós-cobertura (fluid?)", done:false, done_at:null, created_at:now, updated_at:now, deleted_at:null },
        { id:"rep_tk_002", case_id:"rep_001", data_hora:new Date(addDays(hoje,14)+"T08:00:00").toISOString(), tipo:"Diagnóstico gestação", desc:"USG diagnóstico de gestação 14 dias", done:false, done_at:null, created_at:now, updated_at:now, deleted_at:null },
      ];

      // Config params mínimo usado em atendimentos (km, etc) — não atrapalha
      const config_params = [
        { key:"deslocamento_valor_por_km", value:"3.50", effective_from:hoje, effective_to:"", created_at:now, updated_at:now },
        { key:"empresa_nome", value:"Vet System Control | Equine (DEMO)", effective_from:hoje, effective_to:"", created_at:now, updated_at:now },
      ];

      // 4) persistência — multi-store tx (se store existir no DB)
      const allStores = [
        "sys_meta",
        "auth_roles","auth_role_permissions","auth_users","auth_sessions","auth_audit_log",
        "clientes_master","animais_master","atendimentos_master",
        "produtos_master","servicos_master","exames_master",
        "contas_receber",
        "config_params",
        "repro_cases","repro_exams","repro_events","repro_pregnancy","repro_tasks","repro_protocols","repro_foaling"
      ];
      const existing = allStores.filter(s => {
        try{ return db.objectStoreNames && db.objectStoreNames.contains(s); }catch(_){ return false; }
      });

      await idbTx(db, existing, "readwrite", (s) => {
        // auth
        if(s.auth_roles){
          s.auth_roles.put({ id:"role_master", name:"MASTER", status:"ACTIVE", created_at:now, updated_at:now });
          s.auth_roles.put({ id:"role_admin", name:"ADMIN", status:"ACTIVE", created_at:now, updated_at:now });
          s.auth_roles.put({ id:"role_user",  name:"USER",  status:"ACTIVE", created_at:now, updated_at:now });
        }
        if(s.auth_role_permissions){
          // Permissões mínimas (demo) — master ignora; ainda assim, mantém estrutura
          s.auth_role_permissions.put({ id:"perm_master_all", role_id:"role_master", module:"*", action:"*", created_at:now, updated_at:now });
          s.auth_role_permissions.put({ id:"perm_admin_dash", role_id:"role_admin", module:"dashboard", action:"view", created_at:now, updated_at:now });
          s.auth_role_permissions.put({ id:"perm_admin_atd",  role_id:"role_admin", module:"atendimentos", action:"edit", created_at:now, updated_at:now });
        }
        if(s.auth_users){
          s.auth_users.put({
            id:"usr_demo",
            username:"demo.admin",
            status:"ACTIVE",
            role_id:"role_master",
            professional:{ is_vet:true, full_name:"Dra. Camila Rocha (DEMO)", crmv_uf:"SP", crmv_num:"12345", phone:"(16) 99999-0000", email:"demo@vetsystemcontrol.demo", signature_image_dataurl:null, icp_enabled:false, updated_at:now },
            created_at:now, updated_at:now
          });
        }

        // core entities
        if(s.clientes_master){ clientes.forEach(c=>s.clientes_master.put(c)); }
        if(s.animais_master){ animais.forEach(a=>s.animais_master.put(a)); }
        if(s.produtos_master){ produtos.forEach(p=>s.produtos_master.put(p)); }
        if(s.servicos_master){ servicos.forEach(x=>s.servicos_master.put(x)); }
        if(s.exames_master){ exames.forEach(x=>s.exames_master.put(x)); }
        if(s.atendimentos_master){ atendimentos.forEach(a=>s.atendimentos_master.put(a)); }
        if(s.contas_receber){ ar.forEach(t=>s.contas_receber.put(t)); }
        if(s.config_params){ config_params.forEach(p=>s.config_params.put(p)); }

        // reprodução
        if(s.repro_cases){ s.repro_cases.put(repro_case); }
        if(s.repro_exams){ s.repro_exams.put(repro_exam1); }
        if(s.repro_events){ s.repro_events.put(repro_event1); }
        if(s.repro_pregnancy){ s.repro_pregnancy.put(repro_preg); }
        if(s.repro_tasks){ repro_tasks.forEach(t=>s.repro_tasks.put(t)); }

        // sys_meta flag
        if(s.sys_meta){ s.sys_meta.put({ key: metaKey, value:"1", created_at:now, updated_at:now }); }
      });

      // 5) fornecedores (LS usado na importação XML)
      try{
        const fornecedores = [
          { id:"for_001", razao:"Distribuidora AgroVet (DEMO)", fantasia:"AgroVet", cnpj_digits:"11222333000144", cnpj:"11.222.333/0001-44", ie:"123.456.789.000", telefone:"(16) 3333-2211", email:"nfe@agrovet.demo", endereco:"Rua das Indústrias, 100", numero:"100", bairro:"Distrito", cidade:"São Carlos", uf:"SP", cep:"13560-000", obs:"Fornecedor fictício para demonstração.", status:"ativo", created_at:now, updated_at:now, deleted_at:null }
        ];
        localStorage.setItem("vsc_fornecedores_v1", JSON.stringify(fornecedores));
      }catch(_){}

      // 6) sessão demo
      await ensureSession(db);

    } finally {
      try{ db.close(); }catch(_){}
    }
  }

  async function ensureSession(db){
    try{
      // cria sessão se não houver
      let sid = null;
      try{ sid = localStorage.getItem("vsc_session_id"); }catch(_){}
      if(sid && sid !== "demo") return true;

      const expires = new Date(Date.now() + 8*60*60*1000).toISOString();
      const created = nowISO();
      const session_id = "sid_demo_" + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);

      const stores = ["auth_sessions"];
      if(db.objectStoreNames && db.objectStoreNames.contains("auth_sessions")){
        await idbTx(db, stores, "readwrite", (s) => {
          s.auth_sessions.put({ id: session_id, user_id:"usr_demo", status:"ACTIVE", created_at: created, expires_at: expires });
        });
        try{ localStorage.setItem("vsc_session_id", session_id); }catch(_){}
      }else{
        // fallback mínimo para páginas que só checam localStorage
        try{ localStorage.setItem("vsc_session_id", "demo"); }catch(_){}
      }
      return true;
    }catch(_){ return false; }
  }

  // dispara
  seed().catch(()=>{ /* silent in demo */ });

})();
