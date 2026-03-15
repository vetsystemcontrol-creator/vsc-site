(function(){
  'use strict';
  function toCents(n){ n=Number(n||0); return Number.isFinite(n)?Math.round(n):0; }
  function fmtBRLFromCents(c){
    try{ return (Number(c||0)/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'}); }catch(_){ return 'R$ 0,00'; }
  }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }
  function parseYMD(v){
    if(!v) return null;
    const s=String(v).slice(0,10);
    const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if(!m) return null;
    return new Date(Number(m[1]), Number(m[2])-1, Number(m[3]));
  }
  function ymd(d){
    if(!(d instanceof Date)) return '';
    return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  }
  function monthKey(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'); }
  function monthLabel(k){
    if(!k) return '—';
    const m=/^(\d{4})-(\d{2})$/.exec(String(k));
    if(!m) return String(k);
    const dt=new Date(Number(m[1]), Number(m[2])-1, 1);
    return dt.toLocaleDateString('pt-BR',{month:'short', year:'2-digit'}).replace('.', '');
  }
  function startOfToday(){ const d=new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function addDays(d, n){ const x=new Date(d); x.setDate(x.getDate()+n); return x; }
  function addMonths(d, n){ const x=new Date(d.getFullYear(), d.getMonth(), 1); x.setMonth(x.getMonth()+n); return x; }
  function sameMonth(d1,d2){ return d1 && d2 && d1.getFullYear()===d2.getFullYear() && d1.getMonth()===d2.getMonth(); }

  function normalizeAP(t){
    const total=toCents(t&&t.valor_centavos);
    const paid=toCents(t&&t.pago_centavos);
    const saldo=Math.max(0, total-paid);
    return {
      id: t&&t.id || '',
      kind:'ap',
      entity: (t&&t.fornecedor_nome) || 'Sem fornecedor',
      entityDoc: (t&&t.fornecedor_doc) || '',
      total, paid, saldo,
      due: parseYMD(t&&t.vencimento),
      settledAt: parseYMD(t&&t.pagamento_data),
      status: String(t&&t.status || (saldo<=0?'pago':'aberto')).toLowerCase(),
      source: String(t&&t.origem || 'manual'),
      raw: t || {}
    };
  }
  function normalizeAR(t){
    const total=toCents(t&&t.valor_original_centavos);
    const saldo=Math.max(0, toCents(t&&((t.saldo_centavos!=null?t.saldo_centavos:total))));
    const recebimentos=Array.isArray(t&&t.recebimentos)?t.recebimentos:[];
    const paid=Math.max(0, total-saldo);
    let lastReceived=null;
    const forms={};
    recebimentos.forEach(r=>{
      const d=parseYMD(r&&r.data);
      if(d && (!lastReceived || d>lastReceived)) lastReceived=d;
      const form=String(r&&r.forma_pagamento||'não informado');
      forms[form]=(forms[form]||0)+toCents(r&&r.valor_centavos);
    });
    return {
      id: t&&t.id || '',
      kind:'ar',
      entity: (t&&t.cliente_nome) || 'Sem cliente',
      entityDoc: (t&&t.cliente_doc) || '',
      total, paid, saldo,
      due: parseYMD(t&&t.vencimento),
      settledAt: lastReceived,
      status: String(t&&t.status || (saldo<=0?'recebido':'aberto')).toLowerCase(),
      source: String(t&&t.origem || 'manual'),
      paymentForms: forms,
      cycle: String(t&&t.billing_cycle || ''),
      raw: t || {}
    };
  }

  function agingBucket(diffDays){
    if(diffDays < 0) return 'A vencer';
    if(diffDays <= 30) return '0-30';
    if(diffDays <= 60) return '31-60';
    if(diffDays <= 90) return '61-90';
    return '90+';
  }

  function summarizePortfolio(records, kind){
    const today=startOfToday();
    const next30=addDays(today, 30);
    const next7=addDays(today, 7);
    const summary={
      count:0,total:0,open:0,overdue:0,partial:0,settledMonth:0,upcoming30:0,upcoming7:0,
      settledCount:0, overdueCount:0, upcoming30Count:0,
      aging:{'A vencer':0,'0-30':0,'31-60':0,'61-90':0,'90+':0},
      topEntities:[],
      monthlyDue:[],
      monthlySettled:[],
      statusCount:{},
      paymentMethods:[]
    };
    const entityMap={}; const payForms={};
    const months={}; const settledMonths={};
    const baseMonth=new Date(today.getFullYear(), today.getMonth(), 1);
    for(let i=-5;i<=0;i++){
      const k=monthKey(addMonths(baseMonth,i));
      months[k]=0; settledMonths[k]=0;
    }
    (Array.isArray(records)?records:[]).forEach(r=>{
      const x=(kind==='ap'?normalizeAP(r):normalizeAR(r));
      summary.count += 1;
      summary.total += x.total;
      summary.statusCount[x.status]=(summary.statusCount[x.status]||0)+1;
      if(x.saldo>0) summary.open += x.saldo;
      if(x.entity){ entityMap[x.entity]=(entityMap[x.entity]||0)+x.total; }
      if(kind==='ar' && x.paymentForms){ Object.keys(x.paymentForms).forEach(k=>{ payForms[k]=(payForms[k]||0)+x.paymentForms[k]; }); }
      if(x.saldo>0 && x.due){
        const diff=Math.floor((today - x.due)/86400000);
        summary.aging[agingBucket(diff)] += x.saldo;
        if(x.due < today){ summary.overdue += x.saldo; summary.overdueCount += 1; }
        if(x.due >= today && x.due <= next30){ summary.upcoming30 += x.saldo; summary.upcoming30Count += 1; }
        if(x.due >= today && x.due <= next7){ summary.upcoming7 += x.saldo; }
      }
      if(x.status==='parcial') summary.partial += x.saldo;
      if(x.settledAt && sameMonth(x.settledAt, today)) { summary.settledMonth += x.paid || x.total; summary.settledCount += 1; }
      if(x.due){ const mk=monthKey(new Date(x.due.getFullYear(), x.due.getMonth(), 1)); if(mk in months) months[mk]+=x.total; }
      if(x.settledAt){ const mk=monthKey(new Date(x.settledAt.getFullYear(), x.settledAt.getMonth(), 1)); if(mk in settledMonths) settledMonths[mk]+=x.paid || x.total; }
    });
    summary.topEntities=Object.entries(entityMap).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([label,value])=>({label,value}));
    summary.paymentMethods=Object.entries(payForms).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([label,value])=>({label,value}));
    summary.monthlyDue=Object.keys(months).sort().map(k=>({key:k,label:monthLabel(k),value:months[k]}));
    summary.monthlySettled=Object.keys(settledMonths).sort().map(k=>({key:k,label:monthLabel(k),value:settledMonths[k]}));
    return summary;
  }

  function summarizeExecutive(apRecords, arRecords){
    const ap=summarizePortfolio(apRecords,'ap');
    const ar=summarizePortfolio(arRecords,'ar');
    const today=startOfToday();
    const baseMonth=new Date(today.getFullYear(), today.getMonth(), 1);
    const cashflow=[];
    for(let i=0;i<6;i++){
      const ref=addMonths(baseMonth,i);
      const key=monthKey(ref);
      let inflow=0, outflow=0;
      (Array.isArray(arRecords)?arRecords:[]).forEach(r=>{ const x=normalizeAR(r); if(x.saldo>0 && x.due && monthKey(new Date(x.due.getFullYear(),x.due.getMonth(),1))===key) inflow += x.saldo; });
      (Array.isArray(apRecords)?apRecords:[]).forEach(r=>{ const x=normalizeAP(r); if(x.saldo>0 && x.due && monthKey(new Date(x.due.getFullYear(),x.due.getMonth(),1))===key) outflow += x.saldo; });
      cashflow.push({ key, label: monthLabel(key), inflow, outflow, net: inflow-outflow });
    }
    return {
      ap, ar,
      openReceivable: ar.open,
      openPayable: ap.open,
      overdueReceivable: ar.overdue,
      overduePayable: ap.overdue,
      projectedNet30: ar.upcoming30 - ap.upcoming30,
      projectedInflows30: ar.upcoming30,
      projectedOutflows30: ap.upcoming30,
      settledResultMonth: ar.settledMonth - ap.settledMonth,
      monthlyCashflow: cashflow
    };
  }

  function clearCanvas(cv){ if(!cv) return null; const ctx=cv.getContext('2d'); if(!ctx) return null; const ratio=window.devicePixelRatio||1; const rect=cv.getBoundingClientRect(); const w=Math.max(260, Math.floor(rect.width||cv.width||300)); const h=Math.max(180, Math.floor(rect.height||cv.height||220)); cv.width=w*ratio; cv.height=h*ratio; ctx.setTransform(ratio,0,0,ratio,0,0); ctx.clearRect(0,0,w,h); return {ctx,w,h}; }
  function drawEmpty(cv, txt){ const p=clearCanvas(cv); if(!p) return; const {ctx,w,h}=p; ctx.fillStyle='#64748b'; ctx.font='600 13px system-ui'; ctx.textAlign='center'; ctx.fillText(txt||'Sem dados', w/2, h/2); }
  function drawBars(cv, data, opts){
    const p=clearCanvas(cv); if(!p) return; const {ctx,w,h}=p; data=Array.isArray(data)?data:[]; if(!data.length){ drawEmpty(cv,'Sem dados'); return; }
    const pad={l:42,r:12,t:16,b:34}; const cw=w-pad.l-pad.r; const ch=h-pad.t-pad.b; const max=Math.max(...data.map(d=>Math.abs(Number(d.value||0))),1);
    ctx.strokeStyle='rgba(15,25,35,.10)'; ctx.lineWidth=1; for(let i=0;i<4;i++){ const y=pad.t + (ch/3)*i; ctx.beginPath(); ctx.moveTo(pad.l,y); ctx.lineTo(w-pad.r,y); ctx.stroke(); }
    const bw=Math.max(18, Math.min(42, cw/(data.length*1.6))); const gap=(cw - bw*data.length)/Math.max(1,data.length-1);
    data.forEach((d,i)=>{ const x=pad.l + i*(bw+gap); const v=Number(d.value||0); const bh=(Math.abs(v)/max)*(ch-10); const y=v>=0 ? (pad.t+ch-bh) : (pad.t+ch/2); ctx.fillStyle=v>=0?'rgba(29,158,92,.86)':'rgba(220,38,38,.82)'; ctx.fillRect(x,y,bw,bh); ctx.fillStyle='#64748b'; ctx.font='600 11px system-ui'; ctx.textAlign='center'; ctx.fillText(String(d.label||''), x+bw/2, h-12); });
    ctx.fillStyle='#0f1923'; ctx.font='700 11px system-ui'; ctx.textAlign='left'; ctx.fillText(opts&&opts.yLabel?opts.yLabel:'R$', 8, 14);
  }
  function drawLine(cv, data){
    const p=clearCanvas(cv); if(!p) return; const {ctx,w,h}=p; data=Array.isArray(data)?data:[]; if(!data.length){ drawEmpty(cv,'Sem dados'); return; }
    const pad={l:36,r:10,t:16,b:30}; const cw=w-pad.l-pad.r; const ch=h-pad.t-pad.b; const vals=data.map(d=>Number(d.value||0)); const max=Math.max(...vals,1);
    ctx.strokeStyle='rgba(15,25,35,.10)'; for(let i=0;i<4;i++){ const y=pad.t + (ch/3)*i; ctx.beginPath(); ctx.moveTo(pad.l,y); ctx.lineTo(w-pad.r,y); ctx.stroke(); }
    ctx.strokeStyle='rgba(37,99,235,.9)'; ctx.lineWidth=2; ctx.beginPath();
    data.forEach((d,i)=>{ const x=pad.l + (cw/Math.max(1,data.length-1))*i; const y=pad.t + ch - ((Number(d.value||0)/max)*(ch-8)); if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); }); ctx.stroke();
    data.forEach((d,i)=>{ const x=pad.l + (cw/Math.max(1,data.length-1))*i; const y=pad.t + ch - ((Number(d.value||0)/max)*(ch-8)); ctx.fillStyle='rgba(37,99,235,.95)'; ctx.beginPath(); ctx.arc(x,y,3,0,Math.PI*2); ctx.fill(); ctx.fillStyle='#64748b'; ctx.font='600 11px system-ui'; ctx.textAlign='center'; ctx.fillText(String(d.label||''), x, h-10); });
  }
  function drawDonut(cv, data){
    const p=clearCanvas(cv); if(!p) return; const {ctx,w,h}=p; data=Array.isArray(data)?data.filter(d=>Number(d.value||0)>0):[]; if(!data.length){ drawEmpty(cv,'Sem dados'); return; }
    const total=data.reduce((s,d)=>s+Number(d.value||0),0)||1; const cx=w*0.32, cy=h*0.5, r=Math.min(w,h)*0.24; let a=-Math.PI/2; const colors=['#1d9e5c','#2563eb','#d97706','#dc2626','#7c3aed'];
    data.forEach((d,i)=>{ const slice=(Number(d.value||0)/total)*Math.PI*2; ctx.strokeStyle=colors[i%colors.length]; ctx.lineWidth=r*0.55; ctx.beginPath(); ctx.arc(cx,cy,r,a,a+slice); ctx.stroke(); a+=slice; });
    ctx.fillStyle='#0f1923'; ctx.font='800 15px system-ui'; ctx.textAlign='center'; ctx.fillText(String(data.length), cx, cy+5);
    let ly=26; data.forEach((d,i)=>{ ctx.fillStyle=colors[i%colors.length]; ctx.fillRect(w*0.58, ly-8, 10, 10); ctx.fillStyle='#334155'; ctx.font='600 12px system-ui'; ctx.textAlign='left'; const pct=((Number(d.value||0)/total)*100).toFixed(0)+'%'; ctx.fillText(String(d.label||'')+' · '+pct, w*0.58+16, ly); ly += 22; });
  }
  function renderList(el, items, valueFmt){ if(!el) return; items=Array.isArray(items)?items:[]; if(!items.length){ el.innerHTML='<div class="vsc-fin-empty">Sem dados suficientes.</div>'; return; } el.innerHTML=items.map((it,idx)=>'<div class="vsc-fin-list-item"><span class="vsc-fin-rank">'+(idx+1)+'</span><span class="vsc-fin-label">'+esc(it.label||'—')+'</span><strong class="vsc-fin-value">'+esc(valueFmt?valueFmt(it.value):fmtBRLFromCents(it.value))+'</strong></div>').join(''); }

  // ============================================================
  // normalizeTituloUniversal — BUG-5 FIX
  // Adaptador que aceita qualquer um dos 3 schemas financeiros
  // do VSC e retorna estrutura canônica unificada com centavos.
  //
  // Schemas suportados:
  //   AP  (contasapagar.js):    valor_centavos + pago_centavos
  //   AR  (contasareceber.js):  valor_original_centavos + saldo_centavos + recebimentos[]
  //   CORE (vsc-core.js):       valor_original_cents + valor_pago_cents
  //
  // Retorna:
  //   { id, kind, total_cents, pago_cents, saldo_cents, status, vencimento, raw }
  // ============================================================
  function normalizeTituloUniversal(t) {
    if (!t || typeof t !== 'object') return null;

    // Detectar schema por presença de campos canônicos
    const isAP   = t.valor_centavos != null || t.pago_centavos != null;
    const isCore = t.valor_original_cents != null || t.valor_pago_cents != null;
    // AR é o default quando tem valor_original_centavos ou nenhum dos outros

    let total_cents, pago_cents, saldo_cents;

    if (isCore) {
      // vsc-core.js: _cents (sem "avos" no sufixo)
      total_cents = toCents(t.valor_original_cents || 0);
      pago_cents  = toCents(t.valor_pago_cents || 0);
      saldo_cents = Math.max(0, total_cents - pago_cents);
    } else if (isAP) {
      // contasapagar.js: valor_centavos + pago_centavos
      total_cents = toCents(t.valor_centavos || 0);
      pago_cents  = toCents(t.pago_centavos || 0);
      saldo_cents = Math.max(0, total_cents - pago_cents);
    } else {
      // contasareceber.js (default): valor_original_centavos + saldo_centavos
      total_cents = toCents(t.valor_original_centavos || 0);
      saldo_cents = toCents(t.saldo_centavos != null ? t.saldo_centavos : total_cents);
      pago_cents  = Math.max(0, total_cents - saldo_cents);
    }

    const kind = isAP ? 'ap' : (isCore ? 'core' : 'ar');

    return {
      id:          t.id || '',
      kind,
      total_cents,
      pago_cents,
      saldo_cents,
      status:      String(t.status || (saldo_cents <= 0 ? (kind === 'ap' ? 'pago' : 'recebido') : 'aberto')).toLowerCase(),
      vencimento:  t.vencimento || null,
      entity:      t.cliente_nome || t.fornecedor_nome || t.entity || '',
      origem:      t.origem || t.source || 'manual',
      raw:         t
    };
  }

  window.VSC_FINANCE_ANALYTICS={ fmtBRLFromCents, parseYMD, ymd, normalizeAP, normalizeAR, normalizeTituloUniversal, summarizePortfolio, summarizeExecutive, drawBars, drawLine, drawDonut, renderList };
})();
