/*!
 * VSC-UTILS — Biblioteca Utilitária Compartilhada
 * ============================================================
 * Correção R-04 + R-05 (Auditoria 2026-02-18)
 *
 * R-04: elimina duplicação de helpers em todos os módulos
 * R-05: remove fallback Math.random() do UUID — usa apenas
 *       crypto.randomUUID() ou crypto.getRandomValues().
 *       Falha explicitamente se o navegador não suportar
 *       nenhuma das APIs de entropia segura.
 *
 * Literatura:
 *   - RFC 4122 §4.4: UUID v4 exige bytes aleatórios de CSPRNG
 *   - OWASP ASVS 2.9.1: proibido usar PRNG para geração de IDs
 *   - Martin, R.C. (2008) Clean Code, cap. 17: DRY principle
 * ============================================================
 * Expõe: window.VSC_UTILS (objeto imutável via Object.freeze)
 */
(() => {
  "use strict";

  // ──────────────────────────────────────────────────────────
  // 1. UUID v4 — CSPRNG exclusivo (RFC 4122, OWASP ASVS 2.9.1)
  // ──────────────────────────────────────────────────────────

  /**
   * Gera UUID v4 usando exclusivamente CSPRNG do navegador.
   *
   * Prioridade:
   *   1. crypto.randomUUID()           — moderno, Chrome 92+, FF 95+, Safari 15.4+
   *   2. crypto.getRandomValues()      — suporte amplo (IE 11+)
   *
   * Lança TypeError se nenhuma API estiver disponível.
   * NÃO usa Math.random() como fallback (violaria OWASP ASVS 2.9.1).
   *
   * @returns {string} UUID v4 no formato xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
   * @throws  {TypeError} quando o ambiente não suporta CSPRNG
   */
  function uuidv4() {
    // Caminho 1: API nativa — mais eficiente e mais suportada
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }

    // Caminho 2: getRandomValues — disponível desde IE 11
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      const buf = new Uint8Array(16);
      crypto.getRandomValues(buf);
      // Ajuste de versão e variante conforme RFC 4122 §4.4
      buf[6] = (buf[6] & 0x0f) | 0x40; // versão 4
      buf[8] = (buf[8] & 0x3f) | 0x80; // variante RFC 4122
      const hex = Array.from(buf).map(b => b.toString(16).padStart(2, "0")).join("");
      return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20)
      ].join("-");
    }

    // Sem fallback inseguro — falha explícita e auditável
    throw new TypeError(
      "[VSC-UTILS] uuidv4(): ambiente sem suporte a CSPRNG (crypto.randomUUID / crypto.getRandomValues). " +
      "Atualize o navegador. UUID NÃO gerado para preservar integridade dos dados."
    );
  }

  // ──────────────────────────────────────────────────────────
  // 2. Data / Tempo
  // ──────────────────────────────────────────────────────────

  /** @returns {string} Timestamp ISO 8601 UTC */
  function nowISO() {
    return new Date().toISOString();
  }

  /**
   * Data de hoje no formato YYYY-MM-DD (fuso local).
   * @returns {string}
   */
  function todayYMD() {
    const d = new Date();
    return [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0")
    ].join("-");
  }

  /**
   * Valida se uma string é uma data YYYY-MM-DD calendariamente válida.
   * @param {string} s
   * @returns {boolean}
   */
  function isValidYMD(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split("-").map(Number);
    if (y < 1900 || y > 2500 || m < 1 || m > 12 || d < 1 || d > 31) return false;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === m && dt.getUTCDate() === d;
  }

  // ──────────────────────────────────────────────────────────
  // 3. String / Documento
  // ──────────────────────────────────────────────────────────

  /**
   * Remove todos os caracteres não-dígito.
   * @param {*} s
   * @returns {string}
   */
  function onlyDigits(s) {
    return String(s ?? "").replace(/\D+/g, "");
  }

  /**
   * Normaliza string: trim + trunca em max caracteres.
   * @param {*}      s
   * @param {number} [max]
   * @returns {string}
   */
  function clampStr(s, max) {
    s = String(s ?? "").trim();
    return (max && s.length > max) ? s.slice(0, max) : s;
  }

  /**
   * Normaliza string para persistência: trim + null se vazio.
   * @param {*} s
   * @returns {string|null}
   */
  function normalizeString(s) {
    const v = String(s ?? "").trim();
    return v.length ? v : null;
  }

  /**
   * JSON.parse seguro com fallback.
   * @param {string} txt
   * @param {*}      fallback
   * @returns {*}
   */
  function safeJSONParse(txt, fallback) {
    try { return JSON.parse(txt); } catch (_) { return fallback; }
  }

  /**
   * Valida formato UUID v4.
   * @param {*} s
   * @returns {boolean}
   */
  function isUUIDv4(s) {
    return (
      typeof s === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)
    );
  }

  // ──────────────────────────────────────────────────────────
  // 4. Aritmética monetária (centavos inteiros — sem float)
  // ──────────────────────────────────────────────────────────

  /**
   * Clamp de inteiro.
   * @param {number} n
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  function clampInt(n, min, max) {
    n = Number.isFinite(n) ? Math.trunc(n) : 0;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  /**
   * Converte string BRL para centavos inteiros.
   * Aceita "1.234,56", "1234,56", "1234.56".
   * @param {*} input
   * @returns {number} centavos (int ≥ 0)
   */
  function moneyToCentsBR(input) {
    const s = String(input ?? "").trim();
    if (!s) return 0;
    const normalized = s.replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
    const v = Number(normalized);
    if (!Number.isFinite(v)) return 0;
    return Math.round(v * 100);
  }

  /**
   * Converte centavos inteiros para string BRL ("1.234,56").
   * @param {number} cents
   * @returns {string}
   */
  function centsToMoneyBR(cents) {
    cents = clampInt(cents, 0, 2_147_483_647);
    return (cents / 100)
      .toFixed(2)
      .replace(".", ",")
      .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }

  // ──────────────────────────────────────────────────────────
  // 5. DOM helpers (seguros — no-op se elemento ausente)
  // ──────────────────────────────────────────────────────────

  /**
   * Define textContent de um elemento pelo id, sem lançar exceção.
   * @param {string} id
   * @param {*}      txt
   */
  function setText(id, txt) {
    const el = document.getElementById(id);
    if (el) el.textContent = txt;
  }

  /**
   * Mostra/esconde elemento pelo id.
   * @param {string}  id
   * @param {boolean} on
   */
  function showEl(id, on) {
    const el = document.getElementById(id);
    if (el) el.style.display = on ? "" : "none";
  }

  /**
   * Escapa HTML para uso seguro em innerHTML.
   * @param {*} s
   * @returns {string}
   */
  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ──────────────────────────────────────────────────────────
  // 6. localStorage helpers (transitório — usar IDB em módulos novos)
  // ──────────────────────────────────────────────────────────

  /**
   * Carrega array do localStorage com fallback seguro.
   * @param {string} key
   * @returns {Array}
   */
  function loadLSArray(key) {
    const v = safeJSONParse(localStorage.getItem(key) || "[]", []);
    return Array.isArray(v) ? v : [];
  }

  /**
   * Salva array no localStorage.
   * @param {string} key
   * @param {Array}  arr
   */
  function saveLSArray(key, arr) {
    localStorage.setItem(key, JSON.stringify(Array.isArray(arr) ? arr : []));
  }

  // ──────────────────────────────────────────────────────────
  // API pública — imutável por Object.freeze
  // ──────────────────────────────────────────────────────────
  window.VSC_UTILS = Object.freeze({
    // UUID (CSPRNG-only)
    uuidv4,
    isUUIDv4,

    // Data/Tempo
    nowISO,
    todayYMD,
    isValidYMD,

    // String
    onlyDigits,
    clampStr,
    normalizeString,
    safeJSONParse,

    // Monetário
    clampInt,
    moneyToCentsBR,
    centsToMoneyBR,

    // DOM
    setText,
    showEl,
    escapeHtml,

    // localStorage (transitório)
    loadLSArray,
    saveLSArray,
  });

})();
