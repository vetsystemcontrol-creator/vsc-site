/* ============================================================
   VSC_UI_CORE — Enterprise UX Core (Fiori-like)
   Projeto: Vet System Control – Equine (ERP 2.0.1)
   Build: 2026-02-24 | SGQT 8.0 MAX-RELIABILITY

   Objetivos (camada única):
   - Máscaras determinísticas (data, dinheiro, doc, telefone, CEP)
   - Normalização e validação fail-closed
   - API pequena e estável para uso em todos os módulos

   Uso:
   - Marque inputs com data-vsc-mask="date-br|money-br|cpfcnpj-br|phone-br|cep-br"
   - Opcional: data-vsc-required="true" para validação simples
   - O core aplica automaticamente no DOMContentLoaded
   ============================================================ */

(function(){
  "use strict";

  const BUILD = "ERP2.0.1|vsc_ui_core.js|ENTERPRISE_UX_CORE|2026-02-24";

  // -----------------------------
  // Helpers
  // -----------------------------
  const onlyDigits = (v) => String(v||"").replace(/\D+/g, "");
  const clamp = (s, n) => String(s||"").slice(0, n);

  function pad2(n){ return String(n).padStart(2,"0"); }

  function isValidDateParts(d, m, y){
    if(!(y>=1000 && y<=9999)) return false;
    if(!(m>=1 && m<=12)) return false;
    if(!(d>=1 && d<=31)) return false;
    const dt = new Date(Date.UTC(y, m-1, d));
    return dt.getUTCFullYear()===y && (dt.getUTCMonth()+1)===m && dt.getUTCDate()===d;
  }

  // -----------------------------
  // Date (BR) — display: dd/mm/aaaa | storage: ISO yyyy-mm-dd
  // -----------------------------
  function parseDateAnyToISO(input){
    const raw = String(input||"").trim();
    if(!raw) return "";

    // ISO: YYYY-MM-DD
    let m = raw.match(/^\s*(\d{4})-(\d{2})-(\d{2})\s*$/);
    if(m){
      const y = +m[1], mo = +m[2], d = +m[3];
      return isValidDateParts(d, mo, y) ? `${m[1]}-${m[2]}-${m[3]}` : "";
    }

    // BR: DD/MM/YYYY
    m = raw.match(/^\s*(\d{2})\/(\d{2})\/(\d{4})\s*$/);
    if(m){
      const d = +m[1], mo = +m[2], y = +m[3];
      return isValidDateParts(d, mo, y) ? `${m[3]}-${m[2]}-${m[1]}` : "";
    }

    // 8 digits: DDMMYYYY
    const dig = onlyDigits(raw);
    if(dig.length === 8){
      const d = +dig.slice(0,2), mo = +dig.slice(2,4), y = +dig.slice(4,8);
      return isValidDateParts(d, mo, y) ? `${dig.slice(4,8)}-${dig.slice(2,4)}-${dig.slice(0,2)}` : "";
    }

    return "";
  }

  function isoToBR(iso){
    const raw = String(iso||"").trim();
    if(!raw) return "";
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if(!m) return "";
    const y = +m[1], mo = +m[2], d = +m[3];
    if(!isValidDateParts(d, mo, y)) return "";
    return `${m[3]}/${m[2]}/${m[1]}`;
  }

  function normalizeDateToBR(input){
    const iso = parseDateAnyToISO(input);
    return iso ? isoToBR(iso) : "";
  }

  function maskDateBR(value){
    const dig = onlyDigits(value).slice(0, 8);
    if(dig.length <= 2) return dig;
    if(dig.length <= 4) return `${dig.slice(0,2)}/${dig.slice(2)}`;
    return `${dig.slice(0,2)}/${dig.slice(2,4)}/${dig.slice(4)}`;
  }

  // -----------------------------
  // Money (BR) — display: 0,00
  // -----------------------------
  function parseMoneyBRToNumber(input){
    const raw = String(input||"").trim();
    if(!raw) return 0;
    // aceita "1.234,56" | "1234,56" | "1234.56"
    const cleaned = raw
      .replace(/\s+/g, "")
      .replace(/R\$?/gi, "")
      .replace(/\./g, "")
      .replace(/,/g, ".")
      .replace(/[^0-9\.-]/g, "");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  }

  function formatMoneyBR(input){
    const n = (typeof input === "number") ? input : parseMoneyBRToNumber(input);
    try{
      return n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }catch(_){
      // fallback
      const fixed = (Number.isFinite(n) ? n : 0).toFixed(2);
      return fixed.replace(".", ",");
    }
  }

  // máscara progressiva simples: mantém números e uma vírgula
  function maskMoneyBR(value){
    let raw = String(value||"");
    raw = raw.replace(/\s+/g, "");
    raw = raw.replace(/[^0-9,\.\-]/g, "");
    // normaliza para , decimal e remove pontos de milhar
    raw = raw.replace(/\./g, ",");
    const parts = raw.split(",");
    const int = onlyDigits(parts[0]).slice(0, 12); // limite razoável
    const dec = onlyDigits(parts[1] || "").slice(0, 2);
    if(parts.length === 1) return int;
    return `${int},${dec}`;
  }

  // -----------------------------
  // CPF/CNPJ
  // -----------------------------
  function maskCpfCnpjBR(value){
    const d = onlyDigits(value).slice(0, 14);
    if(d.length <= 11){
      // CPF: 000.000.000-00
      const p1 = d.slice(0,3);
      const p2 = d.slice(3,6);
      const p3 = d.slice(6,9);
      const p4 = d.slice(9,11);
      let out = p1;
      if(p2) out += "."+p2;
      if(p3) out += "."+p3;
      if(p4) out += "-"+p4;
      return out;
    }
    // CNPJ: 00.000.000/0000-00
    const p1 = d.slice(0,2);
    const p2 = d.slice(2,5);
    const p3 = d.slice(5,8);
    const p4 = d.slice(8,12);
    const p5 = d.slice(12,14);
    let out = p1;
    if(p2) out += "."+p2;
    if(p3) out += "."+p3;
    if(p4) out += "/"+p4;
    if(p5) out += "-"+p5;
    return out;
  }

  function validateCPF(cpf){
    const d = onlyDigits(cpf);
    if(d.length !== 11) return false;
    if(/^([0-9])\1+$/.test(d)) return false;
    let sum = 0;
    for(let i=0;i<9;i++) sum += (+d[i]) * (10-i);
    let r = (sum * 10) % 11;
    if(r === 10) r = 0;
    if(r !== +d[9]) return false;
    sum = 0;
    for(let i=0;i<10;i++) sum += (+d[i]) * (11-i);
    r = (sum * 10) % 11;
    if(r === 10) r = 0;
    return r === +d[10];
  }

  function validateCNPJ(cnpj){
    const d = onlyDigits(cnpj);
    if(d.length !== 14) return false;
    if(/^([0-9])\1+$/.test(d)) return false;
    const w1 = [5,4,3,2,9,8,7,6,5,4,3,2];
    const w2 = [6].concat(w1);
    const calc = (base, w) => {
      let s = 0;
      for(let i=0;i<w.length;i++) s += (+base[i]) * w[i];
      const mod = s % 11;
      return (mod < 2) ? 0 : (11 - mod);
    };
    const d1 = calc(d, w1);
    if(d1 !== +d[12]) return false;
    const d2 = calc(d, w2);
    return d2 === +d[13];
  }

  function validateCpfCnpj(doc){
    const d = onlyDigits(doc);
    if(!d) return true; // opcional
    if(d.length === 11) return validateCPF(d);
    if(d.length === 14) return validateCNPJ(d);
    return false;
  }

  // -----------------------------
  // Phone (BR)
  // -----------------------------
  function maskPhoneBR(value){
    const d = onlyDigits(value).slice(0, 11);
    if(!d) return "";
    const ddd = d.slice(0,2);
    const rest = d.slice(2);
    if(d.length <= 2) return `(${ddd}`;
    if(rest.length <= 4) return `(${ddd}) ${rest}`;
    if(rest.length <= 8) return `(${ddd}) ${rest.slice(0,4)}-${rest.slice(4)}`;
    // 9 dígitos: 9xxxx-xxxx
    return `(${ddd}) ${rest.slice(0,5)}-${rest.slice(5)}`;
  }

  // -----------------------------
  // CEP
  // -----------------------------
  function maskCepBR(value){
    const d = onlyDigits(value).slice(0, 8);
    if(d.length <= 5) return d;
    return `${d.slice(0,5)}-${d.slice(5)}`;
  }

  // -----------------------------
  // Field errors (inline, Fiori-like)
  // - Não cria HTML novo; só usa classes e aria
  // -----------------------------
  function setInvalid(el, isInvalid, msg){
    try{
      if(!el) return;
      el.setAttribute("aria-invalid", isInvalid ? "true" : "false");
      el.classList.toggle("vsc-invalid", !!isInvalid);
      // Se existir um elemento .err logo após, atualiza
      if(msg){
        const err = el.parentElement && el.parentElement.querySelector(".err");
        if(err){ err.textContent = msg; err.classList.add("show"); }
      }
    }catch(_){ }
  }

  // -----------------------------
  // Apply masks by data-vsc-mask
  // -----------------------------
  function bindMask(input){
    if(!input || input.__vscMaskBound) return;
    const kind = String(input.getAttribute("data-vsc-mask")||"").trim();
    if(!kind) return;
    input.__vscMaskBound = true;

    const onInput = () => {
      const v = input.value;
      if(kind === "date-br") input.value = maskDateBR(v);
      else if(kind === "money-br") input.value = maskMoneyBR(v);
      else if(kind === "cpfcnpj-br") input.value = maskCpfCnpjBR(v);
      else if(kind === "phone-br") input.value = maskPhoneBR(v);
      else if(kind === "cep-br") input.value = maskCepBR(v);
    };

    const onBlur = () => {
      const v = String(input.value||"").trim();
      if(kind === "date-br"){
        if(!v){ setInvalid(input, false); return; }
        const norm = normalizeDateToBR(v);
        if(!norm){
          setInvalid(input, true, "Data inválida. Use dd/mm/aaaa.");
        }else{
          input.value = norm;
          setInvalid(input, false);
        }
      }
      if(kind === "money-br"){
        if(!v){ input.value = "0,00"; setInvalid(input,false); return; }
        input.value = formatMoneyBR(v);
        setInvalid(input,false);
      }
      if(kind === "cpfcnpj-br"){
        if(!v){ setInvalid(input,false); return; }
        const ok = validateCpfCnpj(v);
        setInvalid(input, !ok, ok?"":"Documento inválido.");
        if(ok) input.value = maskCpfCnpjBR(v);
      }
      if(kind === "phone-br"){
        if(!v){ setInvalid(input,false); return; }
        const dig = onlyDigits(v);
        const ok = (dig.length >= 10 && dig.length <= 11);
        setInvalid(input, !ok, ok?"":"Telefone inválido.");
        if(ok) input.value = maskPhoneBR(v);
      }
      if(kind === "cep-br"){
        if(!v){ setInvalid(input,false); return; }
        const dig = onlyDigits(v);
        const ok = (dig.length === 8);
        setInvalid(input, !ok, ok?"":"CEP inválido.");
        if(ok) input.value = maskCepBR(v);
      }
    };

    input.addEventListener("input", onInput, {passive:true});
    input.addEventListener("blur", onBlur);
  }

  function apply(root){
    try{
      const r = root || document;
      const nodes = r.querySelectorAll("[data-vsc-mask]");
      for(const n of nodes) bindMask(n);
    }catch(_){ }
  }

  // auto-apply
  if(typeof document !== "undefined"){
    document.addEventListener("DOMContentLoaded", () => apply(document));
  }

  window.VSC_UI_CORE = {
    BUILD,
    onlyDigits,
    // date
    parseDateAnyToISO,
    isoToBR,
    normalizeDateToBR,
    // money
    parseMoneyBRToNumber,
    formatMoneyBR,
    // docs
    validateCpfCnpj,
    maskCpfCnpjBR,
    // masks
    maskDateBR,
    maskMoneyBR,
    maskPhoneBR,
    maskCepBR,
    // apply
    apply
  };
})();
