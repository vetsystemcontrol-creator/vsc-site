;(() => {
  /* ERP_TOPBAR_VSC_GUARD */
  function hasVscTopbar(){
    return !!document.querySelector('#vscTopbar, .vsc-topbar, #vscAppLogo');
  }

  // Se for topbar VSC, n?o permitir rotinas que reescrevem ".brand"
  const _origApply = window.__erpApplyLogoImg;
  window.__erpApplyLogoImg = function(brand){
    try {
      if (hasVscTopbar()) return false;
    } catch(e) {}
    if (typeof _origApply === "function") return _origApply(brand);
    return false;
  };
})();

;(() => {
  /* __ERP_TOPBAR_BRANDING_KILL_SWITCH__ */

  function __erpSkipActive() {
    try {
      return (sessionStorage.getItem('erp_branding_skip_logoA') === '1') || (localStorage.getItem('erp_branding_skip_logoA') === '1');
    } catch(e) { return false; }
  }

  function __erpHideRightBrandingOnce() {
    if (!__erpSkipActive()) return;

    // Header/topbar/nav mais prov?vel
    const header = document.querySelector('header') || document.querySelector('.topbar') || document.querySelector('nav');
    if (!header) return;

    const hb = header.getBoundingClientRect();
    const midX = hb.left + (hb.width / 2);

    // Candidatos visuais comuns dentro do header
    const nodes = Array.from(header.querySelectorAll('img, svg, object, picture, a, div, span'));

    // Regra: preservar a ?rea ESQUERDA (logo do sistema) e ocultar o que estiver claramente no lado DIREITO
    // Crit?rios (robustos):
    // - Elemento ocupa ?rea no lado direito (centerX > midX)
    // - Tem dimens?o visual relevante (w/h > 20) OU cont?m img/svg/object internamente
    // - N?o ? item t?pico de menu (links de navega??o) ??" tentamos evitar ocultar o menu
    nodes.forEach(el => {
      try {
        const r = el.getBoundingClientRect();
        const w = r.width, h = r.height;
        const centerX = r.left + (w / 2);

        const isVisibleBox = (w > 20 && h > 20);
        const hasMedia = !!(el.querySelector && el.querySelector('img,svg,object,picture'));
        const isNavItem = (el.closest && (el.closest('ul') || el.closest('li'))) ? true : false;

        // Queremos atingir o bloco de branding ? direita (logo da cl?nica), sem tocar na esquerda nem no menu
        if (centerX > midX && (isVisibleBox || hasMedia) && !isNavItem) {
          // Oculta com seguran?a
          el.style.display = 'none';
          // Se for m?dia direta, tamb?m remove fonte
          if (el.tagName === 'IMG') { el.removeAttribute('src'); el.src = ''; }
          if (el.tagName === 'OBJECT') { el.removeAttribute('data'); }
        }
      } catch(e) {}
    });

    console.info('[BRANDING] Kill-switch ativo: branding do lado direito ocultado (skip_logoA=1).');
  }

  // Executa em pontos determin?sticos (sem observer)
  document.addEventListener('DOMContentLoaded', __erpHideRightBrandingOnce);
  window.addEventListener('load', __erpHideRightBrandingOnce);
})();

;(() => {
  /* __ERP_BRANDING_SKIP_BLOCK__ */
  function __erpSkipLogoAActive() {
    try {
      return (sessionStorage.getItem('erp_branding_skip_logoA') === '1') || (localStorage.getItem('erp_branding_skip_logoA') === '1');
    } catch(e) { return false; }
  }

  function __erpRemoveBrandingKeys() {
    const keys = ['erp_branding_skip_logoA'];
    for (const k of keys) {
      try { localStorage.removeItem(k); } catch(e) {}
      try { sessionStorage.removeItem(k); } catch(e) {}
    }
  }

  function __erpClearTopbarLogoA() {
    // Limpa candidatos comuns
    const sels = [
      '#empresa-logo-topbar', '.empresa-logo-topbar',
      '#clientLogoTopbar', '.client-logo-topbar',
      '#client-logo', '.client-logo',
      'img[data-role="client-logo"]',
      'img[data-branding="client"]'
    ];
    sels.forEach(sel => {
      document.querySelectorAll(sel).forEach(img => {
        if (img && img.tagName === 'IMG') {
          img.src = '';
          img.removeAttribute('src');
          img.style.display = 'none';
        }
      });
    });

    // Fallback robusto: dentro do header/topbar, esconde imagens "extras" (mant?m a primeira ??" logo do sistema)
    const header = document.querySelector('header, .topbar, nav');
    if (header) {
      const imgs = Array.from(header.querySelectorAll('img'));
      if (imgs.length > 1) {
        imgs.slice(1).forEach(img => {
          img.src = '';
          img.removeAttribute('src');
          img.style.display = 'none';
        });
      }
    }
  }

  // EXECU???fO ANTES DO RESTO DO BRANDING:
  if (__erpSkipLogoAActive()) {
    __erpRemoveBrandingKeys();
    __erpClearTopbarLogoA();
    console.info('[BRANDING] Skip Logo A DEFINITIVO ativo: chaves removidas antes da aplica??o; topbar mantido vazio.');
  }
})();

;(() => {
  function _clearTopbarClientLogo() {
    const sels = [
      '#empresa-logo-topbar', '.empresa-logo-topbar',
      '#clientLogoTopbar', '.client-logo-topbar',
      '#client-logo', '.client-logo',
      'img[data-role="client-logo"]',
      'img[data-branding="client"]'
    ];
    sels.forEach(sel => {
      document.querySelectorAll(sel).forEach(img => {
        if (img && img.tagName === 'IMG') {
          img.src = '';
          img.removeAttribute('src');
          img.style.display = 'none';
        }
      });
    });
  }

  // Se o usu?rio clicou em LIMPAR, bloqueia a aplica??o da Logo A e mant?m o topbar vazio
  try {
    const skip = (sessionStorage.getItem('erp_branding_skip_logoA') === '1') || (localStorage.getItem('erp_branding_skip_logoA') === '1');
    if (skip) {
      _clearTopbarClientLogo();
      console.info('[BRANDING] Skip Logo A ativo (erp_branding_skip_logoA=1). Topbar mantido vazio.');
    }
  } catch(e) {}
})();

/* ERP_BRANDING_APPLY_LOGO_IMG_V1 */
function __erpApplyLogoImg(brand){
/* ERP_BRANDING_GUARD_V1 */
try {
  if (typeof __erpApplyLogoImg === "function") {
    if (__erpApplyLogoImg(window.__ERP_BRAND__ || window.__brand || null)) {
      // Se aplicou a imagem, n?o sobrescreve com texto/badge.
      console.log("[BRANDING] logo IMG aplicada (guard ativo)");
      return;
    }
  }
} catch(e) { console.warn("[BRANDING] guard fail", e); }

  try {
    if (!brand || !brand.logoUrl) return false;
    const el = document.querySelector(".topbar .brand") || document.querySelector(".brand");
    if (!el) return false;

    // Se j? tem IMG com a mesma src, ok
    const cur = el.querySelector("img");
    if (cur && cur.getAttribute("src") === brand.logoUrl) return true;

    // Renderiza apenas IMG (sem texto), para padronizar
    el.innerHTML = "";
    const img = document.createElement("img");
    img.alt = brand.name || "ERP";
    img.src = brand.logoUrl;
    img.style.height = "32px";
    img.style.width = "auto";
    img.style.display = "block";
    el.appendChild(img);
    return true;
  } catch(e) {
    console.warn("[BRANDING] __erpApplyLogoImg fail", e);
    return false;
  }
}
(() => {
  "use strict";
  const KEY = "erp_empresa";

  function safeParse(s){ try { return JSON.parse(s); } catch { return null; } }
  function getEmpresa(){
    const raw = localStorage.getItem(KEY);
    const obj = raw ? safeParse(raw) : null;
    return obj && typeof obj === "object" ? obj : null;
  }
  function pickLogoPrincipal(empresa){
    // Regra: Campo A = principal sempre.
    // Se existir somente A, usa A. Se existir B tamb?f?m, A continua principal.
    const a = empresa?.branding?.logoA;
    if (a && a.dataUrl && a.mime && a.kind === "image") return a.dataUrl;
    return null;
  }

  function applyTopbarLogo(){
    const emp = getEmpresa();
    const url = emp ? pickLogoPrincipal(emp) : null;
    if (!url) return;

    // REGRA: N?fO mexer na logo do sistema (esquerda).
    // Aplicar Logo A somente no slot da direita, se existir.
    const rightImg = document.querySelector('#vscCompanyLogo');
    const rightSlot = document.querySelector('#vscCompanySlot');

    if (rightImg) {
      rightImg.src = url;
      rightImg.style.display = "block";
      if (rightSlot) rightSlot.style.display = "";
      return;
    }

    // Se n?o existir slot direito nesta tela, n?o faz nada.
    return;
  }

  document.addEventListener("DOMContentLoaded", () => {
    applyTopbarLogo();
    console.log("[BRANDING] aplicado (se logo A existir)");
  });
})();

/* =================== VSC_COMPANY_LOGO_A ===================
   Mostra a Logo A (empresa.html) na topbar quando existir.
   - N?o altera layout da topbar aprovada
   - Apenas preenche #vscCompanyLogo e exibe #vscCompanySlot
   ========================================================== */
(function(){
  function isDataImage(v){
    return typeof v === "string" && /^data:image\/(png|jpeg|jpg|webp);base64,/i.test(v.trim());
  }

  function tryJsonParse(s){
    if (typeof s !== "string") return null;
    const t = s.trim();
    if (!(t.startsWith("{") || t.startsWith("["))) return null;
    try { return JSON.parse(t); } catch(e) { return null; }
  }

  // Procura profundamente em objetos por poss?veis campos de logo A
  function deepFindLogoA(obj){
    if (!obj) return null;

    // chaves comuns
    const directKeys = [
      "logoA","logo_a","logoADataUrl","logoADataURL","logoA_dataUrl","logoA_base64",
      "logoPrincipal","logo_principal","empresaLogoA","empresa_logo_a"
    ];

    for (const k of directKeys){
      if (obj && Object.prototype.hasOwnProperty.call(obj, k) && isDataImage(obj[k])) return obj[k];
    }

    // padr?es comuns dentro de "empresa"
    if (obj.empresa){
      const got = deepFindLogoA(obj.empresa);
      if (got) return got;
    }

    // varre recursivamente
    if (Array.isArray(obj)){
      for (const it of obj){
        const got = deepFindLogoA(it);
        if (got) return got;
      }
    } else if (typeof obj === "object"){
      for (const k of Object.keys(obj)){
        const v = obj[k];
        if (isDataImage(v) && /logo.*a|principal/i.test(k)) return v;
        if (typeof v === "object" && v){
          const got = deepFindLogoA(v);
          if (got) return got;
        }
      }
    }
    return null;
  }

  // Procura em localStorage por:
  // - chaves expl?citas (logoA etc.)
  // - JSONs que contenham um data:image em campo relacionado a logo A
  function findLogoAFromLocalStorage(){
    try{
      const explicitKeys = [
        "logoA","logo_a","logoADataUrl","logoADataURL","empresa.logoA","empresa_logoA","empresa_logo_a",
        "vsc_logoA","vsc_empresa_logoA","VSC_LOGO_A"
      ];
      for (const k of explicitKeys){
        const v = localStorage.getItem(k);
        if (isDataImage(v)) return v;

        const j = tryJsonParse(v);
        const got = deepFindLogoA(j);
        if (got) return got;
      }

      // varredura geral (robusta)
      for (let i=0; i<localStorage.length; i++){
        const key = localStorage.key(i);
        if (!key) continue;

        const val = localStorage.getItem(key);
        if (isDataImage(val) && /logo.*a|principal/i.test(key)) return val;

        const j = tryJsonParse(val);
        const got = deepFindLogoA(j);
        if (got) return got;
      }
    } catch(e){}
    return null;
  }

  function applyCompanyLogoA(){
    const slot = document.getElementById("vscCompanySlot");
    const img  = document.getElementById("vscCompanyLogo");
    if (!slot || !img) return;

    const dataUrl = findLogoAFromLocalStorage();
    if (isDataImage(dataUrl)){
      img.src = dataUrl;
      slot.style.display = "flex";
      try { console.log("[VSC] Logo A aplicada na topbar."); } catch(e){}
    } else {
      // Sem logo: mant?m oculto (como aprovado)
      slot.style.display = "none";
    }
  }

  // roda ao carregar e tamb?m ap?s pequenas mudan?as
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyCompanyLogoA);
  } else {
    applyCompanyLogoA();
  }

  // tenta novamente ap?s um curto delay (caso branding/setups rodem depois)
  setTimeout(applyCompanyLogoA, 250);
  setTimeout(applyCompanyLogoA, 1000);

  // exp?e para uso manual (debug)
  try { window.__vscApplyCompanyLogoA = applyCompanyLogoA; } catch(e){}
})();
 /* =================== /VSC_COMPANY_LOGO_A =================== */
