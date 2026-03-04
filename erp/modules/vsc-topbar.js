/* ==========================================================
   Vet System Control - Equine
   Topbar Auto Branding (offline-first)
   Fonte canï¿½nica: localStorage["vsc_empresa_v1"].__logoA
   ========================================================== */

(function () {
  "use strict";

  const LS_KEY = "vsc_empresa_v1";

  function safeParse(v) {
    try { return JSON.parse(v); } catch (e) { return null; }
  }

  function safeGetLS(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function getLogoADataUrl() {
    const raw = safeGetLS(LS_KEY);
    if (!raw) return null;

    const obj = safeParse(raw);
    if (!obj) return null;

    const v = obj.__logoA;
    if (typeof v !== "string") return null;
    if (!v.startsWith("data:image/")) return null;

    return v;
  }

  function ensureImg(target) {
    if (!target) return null;

    // Se jï¿½ for IMG, usamos ele
    if (target.tagName === "IMG") return target;

    // Se existir um IMG dentro, usa
    let img = target.querySelector("img");
    if (img) return img;

    // Cria um IMG novo dentro do container
    img = document.createElement("img");
    img.alt = "Logo do Cliente";
    img.decoding = "async";
    img.loading = "eager";

    // Estilo padrï¿½o (compatï¿½vel com topbar premium)
    img.style.height = "72px";
    img.style.width = "auto";
    img.style.maxWidth = "340px";
    img.style.objectFit = "contain";
    img.style.display = "none";

    target.appendChild(img);
    return img;
  }
  function findTargets() {
    // Suporta as variaï¿½ï¿½es existentes no projeto
    return [
      document.getElementById("vscLogoACliente"),        // topbar.html (atual)
      document.getElementById("vscLogoA"),               // compat antigo
      document.querySelector('img[data-vsc-logo="A"]'),  // compat antigo
      document.querySelector(".vsc-topbar__right"),      // fallback (container)
      document.querySelector("header.vsc-topbar .vsc-topbar__right")
    ];
  }

  function applyLogoA() {
    const logo = getLogoADataUrl();
    if (!logo) {
      // Se nï¿½o houver logo, apenas garante que nï¿½o ficarï¿½ um IMG "fantasma"
      const targets = findTargets();
      for (const t of targets) {
        if (!t) continue;
        const img = ensureImg(t);
        if (img && img.tagName === "IMG") {
          img.removeAttribute("src");
          img.style.display = "none";
        }
      }
      return false;
    }

    const targets = findTargets();
    for (const t of targets) {
      if (!t) continue;

      const img = ensureImg(t);
      if (!img) continue;

      // Evita reatribuir se jï¿½ estï¿½ igual
      if (img.getAttribute("src") !== logo) img.src = logo;

      img.style.display = "block";
      return true;
    }
    return false;
  }

  function start() {
    // 1) tenta direto
    if (applyLogoA()) return;

    // 2) observa DOM por atï¿½ 8s (caso layout-loader injete header depois)
    const obs = new MutationObserver(() => {
      if (applyLogoA()) obs.disconnect();
    });

    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 8000);
  }
  // Reaplica se a empresa for salva em outra aba/janela
  window.addEventListener("storage", function (e) {
    try {
      if (e && e.key === LS_KEY) applyLogoA();
    } catch (_e) {}
  });

  // Expor para o mï¿½dulo Empresa reaplicar apï¿½s SALVAR (se quiser)
  try { window.VSC_APPLY_BRANDING_TOPBAR = applyLogoA; } catch (_e) {}

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
/* EOF */

;try{window.VSC_TOPBAR=true;}catch(_e){}
