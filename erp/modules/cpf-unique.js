/* VSC CPF/CNPJ UNIQUE v1
   Regra: se CPF/CNPJ jï¿½ existir em algum armazenamento local (localStorage), bloqueia salvar.
   Implementaï¿½ï¿½o defensiva: varre chaves JSON que pareï¿½am lista de clientes.
*/
(function(){
  "use strict";

  function onlyDigits(s){ return String(s||"").replace(/\D/g,""); }

  function findSaveButtons(){
    var out = [];
    ["btnSalvar","salvar","save","saveCliente","btnSalvarCliente"].forEach(function(id){
      var el = document.getElementById(id);
      if (el) out.push(el);
    });
    // fallback por texto
    Array.prototype.slice.call(document.querySelectorAll("button,input[type=button],input[type=submit]")).forEach(function(b){
      var t = (b.innerText || b.value || "").toLowerCase();
      if (t.includes("salvar")) out.push(b);
    });
    // unique
    return Array.from(new Set(out));
  }

  function setSaveEnabled(enabled){
    var btns = findSaveButtons();
    btns.forEach(function(b){ b.disabled = !enabled; });
  }

  function setStatusSafe(msg, kind){
    if (typeof window.setStatus === "function") window.setStatus(msg, kind);
  }

  function scanLocalStorageForDoc(docDigits){
    if (!docDigits) return null;

    // varre chaves que pareï¿½am relacionadas a clientes
    for (var i=0; i<localStorage.length; i++){
      var k = localStorage.key(i);
      if (!k) continue;
      var kl = k.toLowerCase();

      // heurï¿½stica: chaves que contenham "cliente"
      if (!kl.includes("cliente")) continue;

      var raw = localStorage.getItem(k);
      if (!raw) continue;

      // tenta parsear JSON
      var data = null;
      try { data = JSON.parse(raw); } catch(e) { continue; }

      // se for array de objetos, procura campos provï¿½veis
      if (Array.isArray(data)) {
        for (var j=0; j<data.length; j++){
          var it = data[j];
          if (!it || typeof it !== "object") continue;

          var cand = it.cpfCnpj || it.cpfcnpj || it.cpf || it.cnpj || it.documento || it.doc || it.CPF || it.CNPJ;
          var dig = onlyDigits(cand);
          if (dig && dig === docDigits) return { key:k, item:it };
        }
      }

      // se for objeto com lista dentro
      if (data && typeof data === "object") {
        var arr = data.clientes || data.items || data.data || data.rows;
        if (Array.isArray(arr)) {
          for (var x=0; x<arr.length; x++){
            var it2 = arr[x];
            if (!it2 || typeof it2 !== "object") continue;
            var cand2 = it2.cpfCnpj || it2.cpfcnpj || it2.cpf || it2.cnpj || it2.documento || it2.doc;
            var dig2 = onlyDigits(cand2);
            if (dig2 && dig2 === docDigits) return { key:k, item:it2 };
          }
        }
      }
    }
    return null;
  }

  function boot(){
    var el = document.getElementById("cpfCnpj");
    if (!el) return;

    function check(){
      var dig = onlyDigits(el.value);
      if (dig.length < 11) { // ainda incompleto
        setSaveEnabled(true);
        return;
      }

      var found = scanLocalStorageForDoc(dig);
      if (found) {
        setStatusSafe("CPF/CNPJ jï¿½ cadastrado. Nï¿½o ï¿½ permitido duplicar.", "err");
        setSaveEnabled(false);
      } else {
        setSaveEnabled(true);
      }
    }

    el.addEventListener("blur", check, { passive:true });
    el.addEventListener("input", function(){
      // reabilita enquanto edita
      setSaveEnabled(true);
    }, { passive:true });

    // checagem inicial (caso carregue preenchido)
    setTimeout(check, 200);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once:true });
  } else {
    boot();
  }
})();