/* VSC CEP AUTO v1 (externo)
   - Dispara ao completar 8 dï¿½gitos
   - Tenta usar viaCepLookup(cep) se existir na pï¿½gina
   - Fallback: fetch direto no ViaCEP
*/
(function(){
  "use strict";

  function onlyDigits(s){ return String(s||"").replace(/\D/g,""); }

  function setVal(id, val){
    var el = document.getElementById(id);
    if (el) el.value = val || "";
  }

  async function fetchViaCep(clean){
    var r = await fetch("https://viacep.com.br/ws/" + clean + "/json/", { cache: "no-store" });
    if (!r.ok) throw new Error("ViaCEP HTTP " + r.status);
    var j = await r.json();
    if (!j || j.erro) return null;
    return j;
  }

  async function applyCep(clean){
    // Se a pï¿½gina tiver viaCepLookup, usa ela
    if (typeof window.viaCepLookup === "function") {
      try {
        var ok = await window.viaCepLookup(clean);
        return ok || null;
      } catch(e) {
        // cai no fallback
      }
    }

    var j = await fetchViaCep(clean);
    if (!j) return null;

    setVal("logradouro", j.logradouro);
    setVal("bairro", j.bairro);
    setVal("cidade", j.localidade);
    setVal("uf", (j.uf || "").toUpperCase());
    setVal("ibge", j.ibge);
    return j;
  }

  function setStatusSafe(msg, kind){
    if (typeof window.setStatus === "function") {
      window.setStatus(msg, kind);
    }
  }

  function boot(){
    var elCep = document.getElementById("cep");
    if (!elCep) return;

    var last = "";
    var timer = 0;

    async function tryAuto(){
      var clean = onlyDigits(elCep.value);
      if (clean.length !== 8) return;
      if (clean === last) return;
      last = clean;

      try {
        var ok = await applyCep(clean);
        if (ok) setStatusSafe("CEP localizado e endereï¿½o preenchido.", "ok");
        else setStatusSafe("CEP nï¿½o localizado (verifique).", "err");
      } catch(e) {
        setStatusSafe("Erro ao consultar CEP (ViaCEP).", "err");
      }
    }

    elCep.addEventListener("input", function(){
      if (timer) clearTimeout(timer);
      timer = setTimeout(tryAuto, 250);
    }, { passive: true });

    elCep.addEventListener("blur", function(){
      tryAuto();
    }, { passive: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();