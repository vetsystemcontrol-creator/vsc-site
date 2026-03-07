/* ============================================================
 * VSC — product_enrich.js (Enriquecimento Web por EAN/GTIN)
 * Offline-first + governança (não sobrescreve sem confirmação)
 *
 * Fontes (best-effort):
 * - Open Food Facts (API pública, CORS) — principalmente alimentos, mas pode trazer marca/imagens/categorias
 * - GS1 Brasil CNP (recomendado/mais completo) — exige credenciais e normalmente precisa de proxy server-side
 *   Portal/Docs: https://apicnp.gs1br.org/  (configurar endpoint interno do ERP)
 *
 * Interface pública:
 *   await VSC_ENRICH.lookupByEAN(ean, { gs1Endpoint, anvisaEndpoint })
 *   -> { ok, fields, provenance, providersUsed, raw }
 * ============================================================ */
(function(){
  "use strict";

  function normText(v){ return String(v || "").trim(); }
  function safeStr(v, max){
    var s = normText(v);
    if(!s) return "";
    if(max && s.length > max) s = s.slice(0, max);
    return s;
  }

  function isOnline(){
    try{ return navigator.onLine === true; }catch(_e){ return false; }
  }

  async function fetchJson(url, opts, allowStatuses){
  opts = opts || {};
  allowStatuses = Array.isArray(allowStatuses) ? allowStatuses : [];
  var r = await fetch(url, Object.assign({ cache:"no-store" }, opts));
  if(!r.ok) {
    // se status permitido (ex.: 404), retorna null para o caller decidir
    if(allowStatuses.indexOf(r.status) >= 0) return null;
    var t = "";
    try{ t = await r.text(); }catch(_e){}
    var err = new Error("HTTP " + r.status + " em " + url + (t ? (" :: " + t.slice(0,200)) : ""));
    err.status = r.status;
    throw err;
  }
  return await r.json();
}


  // ---------- Provider: Open Food Facts ----------
  async function fromOpenFoodFacts(ean){
    var code = safeStr(ean, 32).replace(/\D+/g,"");
    if(!code) return { ok:false, reason:"EAN vazio" };

    // API v2 product endpoint (docs oficiais)
    var url = "https://world.openfoodfacts.org/api/v2/product/" + encodeURIComponent(code) +
      ".json?fields=product_name,brands,categories,quantity,image_url,selected_images,images";

    var json = await fetchJson(url, null, [404]);
    if(json === null) return { ok:false, reason:"proxy_404" };
    if(!json || json.status !== 1 || !json.product){
      return { ok:false, reason:"Produto não encontrado no OFF" };
    }
    var p = json.product || {};

    var img = safeStr(p.image_url, 400);
    // tenta melhor imagem se existir selected_images
    try{
      if(p.selected_images && p.selected_images.front && p.selected_images.front.display && p.selected_images.front.display.en){
        img = safeStr(p.selected_images.front.display.en, 400) || img;
      }
    }catch(_e){}

    var fields = {
      nome: safeStr(p.product_name, 120),
      marca: safeStr(p.brands, 80),
      categoria: safeStr(p.categories, 120),
      img_url: img
    };

    // remove vazios
    Object.keys(fields).forEach(function(k){ if(!fields[k]) delete fields[k]; });

    return {
      ok:true,
      provider:"openfoodfacts",
      fields: fields,
      raw: json
    };
  }

  // ---------- Provider: GS1 Brasil CNP (via proxy interno) ----------
  async function fromGS1Proxy(ean, gs1Endpoint){
    // gs1Endpoint esperado: "/api/gs1/gtin/" (exemplo) — evita expor client_secret no front e evita CORS
    var ep = normText(gs1Endpoint || "");
    if(!ep) return { ok:false, reason:"GS1 endpoint não configurado" };

    var code = safeStr(ean, 32).replace(/\D+/g,"");
    if(!code) return { ok:false, reason:"EAN vazio" };

    var url = ep.replace(/\/+$/,"") + "/" + encodeURIComponent(code);
    var json = await fetchJson(url, null, [404]);
    if(json === null) return { ok:false, reason:"proxy_404" };

    // Normalização: este contrato depende da sua implementação server-side
    // Esperado: { ok:true, gtin, description, brand, ncm, cest, image_url, category }
    if(!json || json.ok !== true) return { ok:false, reason:"GS1 proxy retornou sem ok" };

    var fields = {
      nome: safeStr(json.description || json.nome || "", 120),
      marca: safeStr(json.brand || json.marca || "", 80),
      categoria: safeStr(json.category || json.categoria || "", 120),
      ncm: safeStr(json.ncm || "", 12),
      cest: safeStr(json.cest || "", 12),
      img_url: safeStr(json.image_url || json.imagem || "", 400)
    };
    Object.keys(fields).forEach(function(k){ if(!fields[k]) delete fields[k]; });

    return { ok:true, provider:"gs1", fields: fields, raw: json };
  }

  // ---------- Provider: ANVISA/MAPA (via proxy interno) ----------
  async function fromAnvisaProxy(ean, anvisaEndpoint){
    var ep = normText(anvisaEndpoint || "");
    if(!ep) return { ok:false, reason:"ANVISA endpoint não configurado" };

    var code = safeStr(ean, 32).replace(/\D+/g,"");
    if(!code) return { ok:false, reason:"EAN vazio" };

    var url = ep.replace(/\/+$/,"") + "?ean=" + encodeURIComponent(code);
    var json = await fetchJson(url, null, [404]);
    if(json === null) return { ok:false, reason:"proxy_404" };
    // Esperado: { ok:true, registro, principio_ativo, controlado, lab }
    if(!json || json.ok !== true) return { ok:false, reason:"ANVISA proxy retornou sem ok" };

    var fields = {
      registro: safeStr(json.registro || "", 40),
      principio: safeStr(json.principio_ativo || json.principio || "", 120),
      marca: safeStr(json.laboratorio || json.lab || "", 80)
    };
    Object.keys(fields).forEach(function(k){ if(!fields[k]) delete fields[k]; });

    return { ok:true, provider:"anvisa", fields: fields, raw: json };
  }

  // ---------- Merge strategy (governança) ----------
  function mergeFields(results){
    var fields = {};
    var prov = {}; // field -> provider
    var providersUsed = [];

    results.forEach(function(r){
      if(!r || !r.ok || !r.fields) return;
      providersUsed.push(r.provider);
      Object.keys(r.fields).forEach(function(k){
        var v = r.fields[k];
        if(!v) return;

        // precedence: GS1 > ANVISA > OFF (porque GS1 é a base mais estruturada para GTIN)
        var rank = (r.provider === "gs1") ? 3 : (r.provider === "anvisa") ? 2 : 1;
        var cur = fields[k];
        var curRank = prov[k] ? ((prov[k] === "gs1") ? 3 : (prov[k] === "anvisa") ? 2 : 1) : 0;

        if(!cur || rank > curRank){
          fields[k] = v;
          prov[k] = r.provider;
        }
      });
    });

    return { fields: fields, provenance: prov, providersUsed: providersUsed };
  }

  async function lookupByEAN(ean, opts){
    opts = opts || {};
    if(!isOnline()){
      return { ok:false, reason:"offline", fields:{}, provenance:{}, providersUsed:[], raw:{} };
    }

    var code = safeStr(ean, 32).replace(/\D+/g,"");
    if(!code) return { ok:false, reason:"ean_vazio", fields:{}, provenance:{}, providersUsed:[], raw:{} };

    var raw = {};
    var results = [];

    // 1) GS1 (se existir proxy)
    try{
      var gs1 = await fromGS1Proxy(code, opts.gs1Endpoint);
      results.push(gs1);
      raw.gs1 = gs1.raw || null;
    }catch(e){
      raw.gs1_err = String(e && (e.message||e));
    }

    // 2) ANVISA/MAPA (proxy interno)
    try{
      var av = await fromAnvisaProxy(code, opts.anvisaEndpoint);
      results.push(av);
      raw.anvisa = av.raw || null;
    }catch(e){
      raw.anvisa_err = String(e && (e.message||e));
    }

    // 3) Open Food Facts (público)
    try{
      var off = await fromOpenFoodFacts(code);
      results.push(off);
      raw.off = off.raw || null;
    }catch(e){
      raw.off_err = String(e && (e.message||e));
    }

    var merged = mergeFields(results);
    var ok = Object.keys(merged.fields || {}).length > 0;

    return {
      ok: ok,
      reason: ok ? "" : "sem_dados",
      fields: merged.fields || {},
      provenance: merged.provenance || {},
      providersUsed: merged.providersUsed || [],
      raw: raw
    };
  }

  window.VSC_ENRICH = {
    isOnline: isOnline,
    lookupByEAN: lookupByEAN
  };
})();