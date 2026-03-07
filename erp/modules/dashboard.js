;(function(){
    "use strict";

    // Anti-lixo antes do DOCTYPE: garantido por refatoramento integral.
    // Aqui só fazemos validações leves sem mexer em layout.

    function hasBadChars(){
  const t = document.body ? (document.body.innerText || "") : "";
  return t.indexOf("\uFFFD") !== -1;
}
    try{
      if(hasBadChars()){
        console.warn("[VSC] Aviso: detectado caractere inválido ( ) no texto renderizado.");
      }
    }catch(_){}

  })();
