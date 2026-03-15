"use strict";

const el = (id)=>document.getElementById(id);
const out = (x)=> el("out").textContent = (typeof x==="string"?x:JSON.stringify(x,null,2));
const status = (t, ok)=> { const s=el("status"); s.className= ok? "ok":"bad"; s.textContent=t; };

async function listPkgs(){
  status("Consultando...", true);
  const r = await fetch("/api/updates/list", {cache:"no-store"});
  const j = await r.json();
  out(j);
  const sel = el("pkg");
  sel.innerHTML = "";
  (j.packages||[]).forEach(p=>{
    const o=document.createElement("option");
    o.value=p; o.textContent=p;
    sel.appendChild(o);
  });
  status((j.packages||[]).length ? "Atualizações encontradas." : "Nenhum pacote na inbox.", true);
}

async function applyPkg(){
  const pkg = el("pkg").value;
  if(!pkg){ status("Selecione um pacote.", false); return; }
  status("Aplicando (backup + apply + rollback automático se falhar)...", true);
  const r = await fetch("/api/updates/apply", {
    method:"POST",
    headers:{ "content-type":"application/json" },
    body: JSON.stringify({ package: pkg })
  });
  const j = await r.json();
  out(j);
  if(j.ok) status("SUCESSO. Atualização aplicada.", true);
  else status("FALHOU. Rollback executado. Veja log.", false);
}

el("btnList").addEventListener("click", (e)=>{ e.preventDefault(); listPkgs(); });
el("btnApply").addEventListener("click", (e)=>{ e.preventDefault(); applyPkg(); });

listPkgs().catch(err=>{ status("Erro ao listar: "+err, false); out(String(err)); });