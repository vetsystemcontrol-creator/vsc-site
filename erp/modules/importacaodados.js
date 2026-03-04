/* ============================================================
 * IMPORTAÇÃO — EQUINOVET (PDF colado) — ENTERPRISE v3.0
 * Parser reescrito do zero baseado na análise real dos PDFs Equinovet.
 *
 * FORMATO REAL DETECTADO:
 *   Bloco médico (cabeçalho)
 *   → Nome cliente (linha livre, pode ter apelido entre parênteses)
 *   → "Telefone: ..." (opcional)
 *   → "Período: dd/mm/aaaa - dd/mm/aaaa"
 *   → "Nome Animal - Categoria"   +  "Serviço*  Materiais*"
 *   → dd/mm/aaaa  MOTIVO  V_SRV  V_MAT   (cabeçalho de atendimento)
 *      └ NOME_PRODUTO (qtd,00 un|ml) - VALOR   → material/produto ou exame
 *      └ (qtd,00) NOME_SERVIÇO  VALOR -          → serviço
 *      Exame Realizado: NOME -                   → exame realizado
 *   → + SERVIÇO   VALOR
 *   → + MATERIAIS VALOR
 *   → + DESLOCAMENTO VALOR  (opcional)
 *   → - DESCONTOS VALOR     (opcional)
 *   → Total: VALOR
 *   → Vencimento: dd/mm/aaaa
 *
 * REGRAS UFC:
 *   - Idempotência: SHA-256 do texto bruto. Bloqueia re-import.
 *   - Match 100% normalizado por módulo (cliente, produto, serviço, exame).
 *   - Fuzzy automático com score > 0.82 → sugere, não comete sozinho.
 *   - Fail-closed: qualquer item sem match bloqueia o commit.
 *   - Um PDF pode gerar N atendimentos (um por data) + 1 conta a receber.
 *   - Animal linkado por nome se encontrado em animais_master.
 *   - Sem alert(): feedback visual premium inline.
 * ============================================================ */
(function () {
  "use strict";

  // ─── Helpers UI ───────────────────────────────────────────────
  function $id(id) { return document.getElementById(id); }

  function setPill(kind, txt) {
    const el = $id("pillState");
    if (!el) return;
    el.className = "pill " + (kind || "warn");
    el.textContent = txt || "";
  }

  function setStatus(html) {
    const el = $id("status");
    if (el) el.innerHTML = html || "";
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"]/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // ─── Normalização de strings ───────────────────────────────────
  function norm(s) {
    return String(s || "").trim()
      .toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ");
  }

  // Score de similaridade (Jaro-Winkler simplificado para fuzzy)
  function jaroSim(s1, s2) {
    if (s1 === s2) return 1;
    const l1 = s1.length, l2 = s2.length;
    const matchDist = Math.floor(Math.max(l1, l2) / 2) - 1;
    if (matchDist < 0) return 0;
    const m1 = new Array(l1).fill(false);
    const m2 = new Array(l2).fill(false);
    let matches = 0, trans = 0;
    for (let i = 0; i < l1; i++) {
      const lo = Math.max(0, i - matchDist);
      const hi = Math.min(i + matchDist + 1, l2);
      for (let j = lo; j < hi; j++) {
        if (m2[j] || s1[i] !== s2[j]) continue;
        m1[i] = m2[j] = true; matches++; break;
      }
    }
    if (!matches) return 0;
    let k = 0;
    for (let i = 0; i < l1; i++) {
      if (!m1[i]) continue;
      while (!m2[k]) k++;
      if (s1[i] !== s2[k]) trans++;
      k++;
    }
    const jaro = (matches / l1 + matches / l2 + (matches - trans / 2) / matches) / 3;
    let prefix = 0;
    for (let i = 0; i < Math.min(4, l1, l2); i++) {
      if (s1[i] === s2[i]) prefix++; else break;
    }
    return jaro + prefix * 0.1 * (1 - jaro);
  }

  // Normaliza removendo prefixos comuns do Equinovet para melhorar o match
  // Ex: "Bioquímico - AST" → "ast" para buscar no cadastro como "AST"
  function normStrip(s) {
    return norm(s)
      .replace(/^bioquímico\s*[-–]\s*/i, "")
      .replace(/^bioquimica\s*[-–]\s*/i, "")
      .replace(/^bioquimico\s*[-–]\s*/i, "")
      .replace(/^hemato\s*[-–]\s*/i, "")
      .replace(/^exame\s+de\s+/i, "")
      .replace(/\s+\(.*?\)\s*$/, "")  // remove "(1,00 un)" do fim se sobrar
      .trim();
  }

  function bestMatch(needle, map) {
    const nk = norm(needle);
    const nkStripped = normStrip(needle);

    // 1. Exact match (full)
    if (map.has(nk)) return { score: 1, rec: map.get(nk) };

    // 2. Exact match (stripped prefix)
    if (nkStripped !== nk && map.has(nkStripped)) return { score: 1, rec: map.get(nkStripped) };

    // 3. Substring containment (full)
    for (const [k, rec] of map) {
      if (k === nk || k.includes(nk) || nk.includes(k)) return { score: 0.92, rec };
    }

    // 4. Substring containment (stripped)
    if (nkStripped !== nk) {
      for (const [k, rec] of map) {
        if (k === nkStripped || k.includes(nkStripped) || nkStripped.includes(k)) return { score: 0.91, rec };
      }
    }

    // 5. Fuzzy Jaro-Winkler — tenta full e stripped, fica com melhor
    let best = { score: 0, rec: null };
    for (const [k, rec] of map) {
      const s1 = jaroSim(nk, k);
      const s2 = nkStripped !== nk ? jaroSim(nkStripped, k) : 0;
      const sc = Math.max(s1, s2);
      if (sc > best.score) best = { score: sc, rec };
    }
    return best;
  }

  // ─── Formatação ───────────────────────────────────────────────
  function nowISO() { return new Date().toISOString(); }

  function uuidv4() {
    try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (_) { }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function toNumPt(s) {
    const t = String(s ?? "").trim().replace(/\./g, "").replace(",", ".");
    const n = Number(t);
    return isFinite(n) ? n : 0;
  }

  function fmtBRL(v) {
    return "R$ " + Number(v || 0).toFixed(2).replace(".", ",");
  }

  function toISODate(d) {
    const s = String(d || "").trim();
    const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m2) return s;
    return "";
  }

  // ─── SHA-256 fingerprint ───────────────────────────────────────
  async function sha256(txt) {
    try {
      const buf = new TextEncoder().encode(String(txt || ""));
      const dig = await crypto.subtle.digest("SHA-256", buf);
      return Array.from(new Uint8Array(dig)).map(b => b.toString(16).padStart(2, "0")).join("");
    } catch (_) { return null; }
  }

  // ─── IDB helpers ──────────────────────────────────────────────
  async function idbGetAll(db, store) {
    return new Promise(resolve => {
      try {
        const tx = db.transaction([store], "readonly");
        const req = tx.objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch (_) { resolve([]); }
    });
  }

  async function idbScanFind(db, store, pred) {
    return new Promise(resolve => {
      try {
        const tx = db.transaction([store], "readonly");
        const req = tx.objectStore(store).openCursor();
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) return resolve(null);
          try { if (pred(cur.value)) return resolve(cur.value); } catch (_) { }
          cur.continue();
        };
        req.onerror = () => resolve(null);
      } catch (_) { resolve(null); }
    });
  }

  // ─── Carregar mapas de referência do ERP ─────────────────────
  async function buildMaps(db) {
    const S = VSC_DB && VSC_DB.stores ? VSC_DB.stores : {};
    const [cli, pro, ser, exa, ani] = await Promise.all([
      idbGetAll(db, S.clientes_master || "clientes_master"),
      idbGetAll(db, S.produtos_master || "produtos_master"),
      idbGetAll(db, S.servicos_master || "servicos_master"),
      idbGetAll(db, S.exames_master || "exames_master"),
      idbGetAll(db, S.animais_master || "animais_master"),
    ]);

    function mapByNome(arr) {
      const m = new Map();
      (Array.isArray(arr) ? arr : []).forEach(o => {
        if (!o) return;
        const nm = norm(o.nome || o.descricao || "");
        if (nm && !m.has(nm)) m.set(nm, o);
      });
      return m;
    }

    return {
      mClientes: mapByNome(cli),
      mProdutos: mapByNome(pro),
      mServicos: mapByNome(ser),
      mExames: mapByNome(exa),
      mAnimais: mapByNome(ani),
      rawClientes: cli,
      rawAnimais: ani,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // PARSER EQUINOVET — Máquina de estados para formato real
  //
  // O Equinovet renderiza como tabela HTML. Ao copiar do navegador,
  // cada célula da tabela vira uma linha separada no texto colado.
  // Formato real (uma linha = uma célula):
  //
  //   Ricardo Henrique Torres         ← cabeçalho médico
  //   Médico Veterinário CRMV-SP...
  //   Florisvaldo Tomaz Júnior (Flo)  ← cliente (linha antes de "Telefone:")
  //   Telefone: 16997027553
  //   Período: 01/05/2025 - 31/08/2025
  //   Pássaro Preto - Castrado        ← animal
  //   Serviço*                        ← header coluna (ignorar)
  //   Materiais*                      ← header coluna (ignorar)
  //   03/05/2025                      ← DATA → início atendimento
  //   Suspeita de cólica              ← MOTIVO
  //   0,00                            ← V_SERVIÇO
  //   245,00                          ← V_MATERIAL
  //   └ Hemograma (1,00 un)           ← início item (material/exame)
  //   -                               ← col serviço = 0
  //   60,00                           ← col material = valor
  //   └ (1,00) Síndrome Cólica        ← início item (serviço)
  //   1.500,00                        ← col serviço = valor
  //   -                               ← col material = 0
  //   Exame Realizado: AIE - Mormo -  ← item especial (exame de serviço)
  //   + SERVIÇO                       ← início bloco totais
  //   1.500,00
  //   Total:                          ← total final
  //   2725,00
  //   Vencimento:
  //   05/05/2025
  // ═══════════════════════════════════════════════════════════════
  function parseEquinovet(raw) {
    const txt = String(raw || "").replace(/\r/g, "");
    const lines = txt.split("\n").map(l => l.trim()).filter(l => l.length > 0);

    // ── Padrões de reconhecimento ──────────────────────────────
    const RX_DATE       = /^(\d{2}\/\d{2}\/\d{4})$/;
    const RX_DATE_INLINE = /^(\d{2}\/\d{2}\/\d{4})\s+(.+)$/; // fallback: data+texto na mesma linha
    const RX_MONEY      = /^-?\d[\d.]*,\d{2}$/;  // "1.500,00" ou "2725,00" ou "0,00"
    const RX_DASH       = /^-$/;  // célula vazia de coluna
    const RX_ITEM_START = /^└\s*/i;        // linha com └ (com ou sem texto depois)
    const RX_ITEM_LONE  = /^└$/i;           // └ sozinho na linha (Adobe Acrobat)
    const RX_ITEM_SERV  = /^\((\d+(?:[,\.]\d+)?)\)\s+(.+)$/i;   // (qtd) DESC — pode vir na linha após └
    const RX_ITEM_MAT   = /^(.+?)\s+\((\d+(?:[,\.]\d+)?)\s+(?:un|ml|litro|litros|comp|comprimido|cartela|sache|sachê|frasco|ampola|dose|doses)\)$/i;
    const RX_ITEM_BARE  = /^(.+)$/;             // qualquer texto (fallback após └ solitário)
    const RX_TOTAL_HDR  = /^\+\s*(SERVIÇO|SERVI[CÇ]O|MATERIAIS|DESLOCAMENTO)$/i;
    const RX_DESCONTO   = /^-\s*DESCONTOS?$/i;
    const RX_PERIODO    = /^Período\s*:\s*(.+)$/i;
    const RX_TELEFONE   = /^Telefone\s*:/i;
    const RX_TOTAL_LBL  = /^Total\s*:?\s*([\d.,]*)$/i;
    const RX_VENC_LBL   = /^Vencimento\s*:?\s*(\d{2}\/\d{2}\/\d{4})?$/i;
    const RX_EXAME_REAL = /^Exame Realizado\s*:\s*(.+?)\s*-?\s*$/i;

    const MEDICO_SKIP = [
      /Médico Veterinário/i, /CRMV/i, /Clínica e cirurgi/i,
      /Vacinação de brucelos/i, /Chave PIX/i, /Ibitinga/i,
      /equinovet\.com\.br/i, /entrar\.equinovet/i,
      /Este relatório foi gerado/i, /^\d{2}\/\d{2}\/\d{4},\s+\d{2}:\d{2}/,  // timestamp
    ];
    const ANIMAL_CATS = /\b(castrado|potro|potra|egua|égua|garanhao|garanhão|matriz|macho|fêmea|femea|filhote|potro)\b/i;
    const EXAME_KW    = /^(hemograma|bioquímico|bioquimico|citolog|urinanal|copropar|sorol|pcr\b|elisa|cultiv|antibiogr|parasitol|eletrofor|hematocrit|plaqueta|leucocito|eritrocit|proteina total|fibrinogên|hormôni|hormoni|cortisol|insulina|progesterona|testosterona|aie\b|mormo\b|anemia infecciosa|teste de|exame de)/i;

    function isMedico(l) { return MEDICO_SKIP.some(rx => rx.test(l)); }
    function isMoney(l)  { return RX_MONEY.test(l); }
    function isDash(l)   { return RX_DASH.test(l); }
    function isMoneyOrDash(l) { return isMoney(l) || isDash(l); }
    function moneyVal(l) { return isDash(l) ? 0 : toNumPt(l); }

    // ── Extrair cabeçalho: cliente, animal, periodo ────────────
    let clienteRaw = "", animalRaw = "", periodoRaw = "", telefone = "";

    const iPeriodo = lines.findIndex(l => RX_PERIODO.test(l));
    const iTel     = lines.findIndex(l => RX_TELEFONE.test(l));

    if (iPeriodo >= 0) periodoRaw = lines[iPeriodo].replace(/^Período\s*:\s*/i, "").trim();
    if (iTel     >= 0) telefone   = lines[iTel].replace(/^Telefone\s*:\s*/i, "").trim();

    // Cliente: linha imediatamente antes de "Telefone:" ou "Período:"
    const iRef = iTel >= 0 ? iTel : iPeriodo;
    if (iRef > 0) {
      for (let i = iRef - 1; i >= 0; i--) {
        const l = lines[i];
        if (!isMedico(l) && !RX_DATE.test(l) && !RX_DATE_INLINE.test(l)) {
          clienteRaw = l; break;
        }
      }
    }
    // Fallback: primeira linha não-médica após bloco cabeçalho
    if (!clienteRaw) {
      let pastMed = false;
      for (const l of lines) {
        if (!pastMed) { if (isMedico(l)) pastMed = true; continue; }
        if (!isMedico(l) && !RX_TELEFONE.test(l) && !RX_PERIODO.test(l)) { clienteRaw = l; break; }
      }
    }

    // Animal: primeira linha após Período que seja categoria ou contenha " - "
    const iStart = iPeriodo >= 0 ? iPeriodo + 1 : 0;
    for (let i = iStart; i < lines.length; i++) {
      const l = lines[i];
      if (/^Serviço\*/i.test(l) || /^Materiais\*/i.test(l)) { break; }
      if (RX_DATE.test(l) || RX_DATE_INLINE.test(l)) break;
      if (ANIMAL_CATS.test(l) || (l.includes(" - ") && !l.startsWith("+") && !isMedico(l))) {
        animalRaw = l.replace(/Serviço\*.*/i, "").replace(/Materiais\*.*/i, "").trim();
        break;
      }
      // Animal sem categoria (ex: "Pássaro Preto - Castrado" em linha única)
      if (!isMedico(l) && !RX_TELEFONE.test(l) && !RX_PERIODO.test(l)
          && !RX_MONEY.test(l) && l !== clienteRaw && l.length > 2 && !animalRaw) {
        animalRaw = l;
      }
    }

    // ── Máquina de estados para parsing de atendimentos ────────
    //
    // Estados: IDLE | ATD_MOTIVO | ATD_VSERV | ATD_VMAT | ITEM_VSERV | ITEM_VMAT
    //          | TOTAL_VSERV | TOTAL_VMAT | TOTAL_DESL | DESCONTO_V
    //          | TOTAL_LBL | VENC_LBL

    const atendimentos = [];
    let currentAtd  = null;
    let currentItem = null;
    let state = "IDLE";

    // Totais globais
    let totalFinal = 0, vencimento = "", desconto = 0, deslocamento = 0;
    let _totalLblSeen = false, _vencLblSeen = false;
    let _descontoSeen = false, _deslSeen = false;

    // Finalizar item pendente no atendimento corrente
    function flushItem() {
      if (currentItem && currentAtd) {
        currentAtd.itens.push(currentItem);
      }
      currentItem = null;
    }

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];

      // ── Totais globais (qualquer estado) ──────────────────────
      if (RX_TOTAL_HDR.test(l)) {
        flushItem();
        currentAtd = null; currentItem = null;
        const hdr = norm(l.replace(/^\+\s*/,""));
        if (/servi/.test(hdr))  state = "TOTAL_VSERV";
        else if (/mater/.test(hdr)) state = "TOTAL_VMAT";
        else if (/desloc/.test(hdr)) state = "TOTAL_DESL";
        continue;
      }
      if (RX_DESCONTO.test(l)) {
        flushItem(); currentAtd = null; currentItem = null;
        state = "DESCONTO_V"; _descontoSeen = true; continue;
      }
      if (RX_TOTAL_LBL.test(l)) {
        flushItem(); currentAtd = null; currentItem = null;
        const m = l.match(RX_TOTAL_LBL);
        if (m && m[1]) { totalFinal = toNumPt(m[1]); state = "IDLE"; }
        else { state = "TOTAL_LBL"; }
        _totalLblSeen = true; continue;
      }
      if (RX_VENC_LBL.test(l)) {
        flushItem(); currentAtd = null; currentItem = null;
        const m = l.match(RX_VENC_LBL);
        if (m && m[1]) { vencimento = m[1]; state = "IDLE"; }
        else { state = "VENC_LBL"; }
        _vencLblSeen = true; continue;
      }
      if (RX_EXAME_REAL.test(l)) {
        // "Exame Realizado: NAME" — aparece após a linha de item de serviço
        // confirma que o atendimento é um exame; ignora "-" que segue
        const desc = l.match(RX_EXAME_REAL)[1].trim();
        if (currentAtd) {
          // Se não existe item com esse desc, criar
          const jaExiste = currentAtd.itens.find(it => norm(it.desc) === norm(desc));
          if (!jaExiste) {
            const tipo = "exame";
            const vu = currentAtd.v_servico || 0;
            currentAtd.itens.push({ tipo, desc, qtd: 1, vu, subtotal: vu, _src: l });
            currentAtd.v_servico = 0;
          }
        }
        state = "IDLE"; continue;
      }

      // ── Consumir valor em estados de totais ───────────────────
      if (state === "TOTAL_VSERV" && isMoney(l)) { state = "IDLE"; continue; }
      if (state === "TOTAL_VMAT"  && isMoney(l)) { state = "IDLE"; continue; }
      if (state === "TOTAL_DESL"  && isMoney(l)) { deslocamento = toNumPt(l); state = "IDLE"; continue; }
      if (state === "DESCONTO_V"  && isMoney(l)) { desconto = toNumPt(l); state = "IDLE"; continue; }
      if (state === "TOTAL_LBL"   && isMoney(l)) { totalFinal = toNumPt(l); state = "IDLE"; continue; }
      if (state === "VENC_LBL") {
        const dm = l.match(/^(\d{2}\/\d{2}\/\d{4})$/);
        if (dm) { vencimento = dm[1]; state = "IDLE"; }
        continue;
      }

      // ── Detectar início de atendimento: data isolada ──────────
      if (RX_DATE.test(l)) {
        flushItem();
        currentAtd = { data: l, motivo: "", v_servico: 0, v_material: 0, itens: [] };
        atendimentos.push(currentAtd);
        state = "ATD_MOTIVO";
        continue;
      }

      // Fallback: data inline (ex: "03/05/2025 Cólica")
      const mDateInline = l.match(RX_DATE_INLINE);
      if (mDateInline && !RX_ITEM_START.test(l)) {
        // Verificar que não é cabeçalho médico
        if (!isMedico(l)) {
          flushItem();
          currentAtd = { data: mDateInline[1], motivo: mDateInline[2].trim(), v_servico: 0, v_material: 0, itens: [] };
          atendimentos.push(currentAtd);
          state = "ATD_VSERV";
          continue;
        }
      }

      // ── Atendimento: motivo, v_serv, v_mat ───────────────────
      if (state === "ATD_MOTIVO") {
        if (isMoney(l)) {
          // Pular: pode ser valor anterior não consumido
          currentAtd.motivo = currentAtd.motivo || l;
          state = "ATD_VSERV"; continue;
        }
        currentAtd.motivo = l;
        state = "ATD_VSERV";
        continue;
      }
      if (state === "ATD_VSERV") {
        if (isMoney(l)) { currentAtd.v_servico = moneyVal(l); state = "ATD_VMAT"; }
        else if (RX_ITEM_START.test(l)) { state = "ITEM_START"; i--; } // re-process
        continue;
      }
      if (state === "ATD_VMAT") {
        if (isMoney(l)) { currentAtd.v_material = moneyVal(l); state = "ITEMS"; }
        else if (RX_ITEM_START.test(l)) { state = "ITEMS"; i--; }
        continue;
      }

      // ── Itens ─────────────────────────────────────────────────
      if (state === "ITEMS" || state === "ITEM_START" || state === "ITEM_PENDING"
          || state === "ITEM_VSERV" || state === "ITEM_VMAT") {

        // ── ITEM_PENDING: └ estava sozinho, próxima linha é a descrição ──
        if (state === "ITEM_PENDING") {
          if (isMoneyOrDash(l) || RX_ITEM_LONE.test(l)) {
            // valor inesperado — descartar item pendente vazio e re-processar
            flushItem(); state = "ITEMS"; i--; continue;
          }
          // Esta linha é a descrição do item
          const desc = l.replace(/^└\s*/i,"").trim(); // remover └ se vier junto
          const mServ = desc.match(RX_ITEM_SERV);
          const mMat  = desc.match(RX_ITEM_MAT);
          if (mServ) {
            const qtd = toNumPt(mServ[1]), d = mServ[2].trim();
            const tipo = EXAME_KW.test(norm(d)) ? "exame" : "servico";
            currentItem = { tipo, desc: d, qtd, vu: 0, subtotal: 0, _src: l };
          } else if (mMat) {
            const d = mMat[1].trim(), qtd = toNumPt(mMat[2]);
            const tipo = EXAME_KW.test(norm(d)) ? "exame" : "produto";
            currentItem = { tipo, desc: d, qtd, vu: 0, subtotal: 0, _src: l };
          } else {
            const d = desc.trim();
            const tipo = EXAME_KW.test(norm(d)) ? "exame" : "produto";
            currentItem = { tipo, desc: d, qtd: 1, vu: 0, subtotal: 0, _src: l };
          }
          state = "ITEM_VSERV";
          continue;
        }

        // Início de novo item — └ sozinho (Adobe Acrobat) ou └ DESC inline
        if (RX_ITEM_START.test(l)) {
          flushItem();

          // └ sozinho na linha → próxima linha será a descrição
          if (RX_ITEM_LONE.test(l)) {
            currentItem = null; // será criado em ITEM_PENDING
            state = "ITEM_PENDING";
            continue;
          }

          // └ inline: extrair descrição da mesma linha
          const inline = l.replace(/^└\s*/i, "").trim();

          // └ (qtd) DESC → serviço
          const mServ = inline.match(RX_ITEM_SERV);
          if (mServ) {
            const qtd = toNumPt(mServ[1]);
            const desc = mServ[2].trim();
            const tipo = EXAME_KW.test(norm(desc)) ? "exame" : "servico";
            currentItem = { tipo, desc, qtd, vu: 0, subtotal: 0, _src: l };
            state = "ITEM_VSERV";
            continue;
          }

          // └ DESC (qtd unit) → produto/exame
          const mMat = inline.match(RX_ITEM_MAT);
          if (mMat) {
            const desc = mMat[1].trim();
            const qtd  = toNumPt(mMat[2]);
            const tipo = EXAME_KW.test(norm(desc)) ? "exame" : "produto";
            currentItem = { tipo, desc, qtd, vu: 0, subtotal: 0, _src: l };
            state = "ITEM_VSERV";
            continue;
          }

          // └ DESC fallback
          if (inline) {
            const tipo = EXAME_KW.test(norm(inline)) ? "exame" : "produto";
            currentItem = { tipo, desc: inline, qtd: 1, vu: 0, subtotal: 0, _src: l };
            state = "ITEM_VSERV";
            continue;
          }
        }

        // Consumir 1ª célula de valor do item (col. serviço)
        if (state === "ITEM_VSERV" && isMoneyOrDash(l)) {
          if (currentItem) {
            const v = moneyVal(l);
            if (v > 0) { currentItem.subtotal = v; currentItem.vu = currentItem.qtd > 0 ? v / currentItem.qtd : v; }
          }
          state = "ITEM_VMAT";
          continue;
        }

        // Consumir 2ª célula de valor do item (col. material)
        if (state === "ITEM_VMAT" && isMoneyOrDash(l)) {
          if (currentItem) {
            const v = moneyVal(l);
            if (v > 0 && currentItem.subtotal === 0) {
              currentItem.subtotal = v;
              currentItem.vu = currentItem.qtd > 0 ? v / currentItem.qtd : v;
            }
          }
          state = "ITEMS"; // pronto para próximo item
          continue;
        }

        // Linha inesperada em ITEM_VSERV/ITEM_VMAT: pode ser início de novo item
        if ((state === "ITEM_VSERV" || state === "ITEM_VMAT") && !isMoneyOrDash(l) && !RX_ITEM_START.test(l)) {
          // Se é uma data → novo atendimento
          if (RX_DATE.test(l)) { flushItem(); i--; state = "IDLE"; continue; }
          // Caso contrário, ignorar linha de formatação (ex: quebra de linha longa)
          continue;
        }
      }

      // ── IDLE: linhas fora de atendimento ─────────────────────
      // Verificar se é data isolada que passamos despercebida
      if (state === "IDLE" && RX_DATE.test(l)) {
        flushItem();
        currentAtd = { data: l, motivo: "", v_servico: 0, v_material: 0, itens: [] };
        atendimentos.push(currentAtd);
        state = "ATD_MOTIVO";
      }
    }
    flushItem();

    // ── Atendimentos sem itens: criar item a partir do motivo ──
    for (const atd of atendimentos) {
      if (atd.itens.length === 0 && (atd.v_servico > 0 || atd.v_material > 0)) {
        const desc = atd.motivo.trim();
        if (desc) {
          const tipo = EXAME_KW.test(norm(desc)) ? "exame" : "servico";
          const val  = atd.v_servico || atd.v_material;
          atd.itens.push({ tipo, desc, qtd: 1, vu: val, subtotal: val, _src: "auto:" + desc });
        }
      }
    }

    const dataPrincipal = atendimentos.length > 0 ? atendimentos[0].data : "";
    const todosItens = atendimentos.flatMap(a => a.itens);

    return {
      raw,
      clienteRaw:  clienteRaw.trim(),
      animalRaw:   animalRaw.trim(),
      periodoRaw:  periodoRaw.trim(),
      telefone:    telefone.trim(),
      dataPrincipal,
      vencimento,
      totalFinal,
      desconto,
      deslocamento,
      atendimentos,
      todosItens,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // MATCH: correlacionar itens do PDF com registros do ERP
  // ═══════════════════════════════════════════════════════════════
  const FUZZY_THRESHOLD = 0.82;

  function matchItem(it, maps) {
    const desc = String(it.desc || "").trim();

    // Tentar no módulo correto primeiro
    const allMaps = [
      { tipo: "produto", map: maps.mProdutos },
      { tipo: "servico", map: maps.mServicos },
      { tipo: "exame",   map: maps.mExames   },
    ];

    // Módulo primário baseado no tipo detectado pelo parser
    const primaryTipo = (it.tipo === "produto" || it.tipo === "servico" || it.tipo === "exame")
      ? it.tipo : null;

    // Buscar no módulo primário
    let best = { score: 0, rec: null, tipo_matched: primaryTipo };
    if (primaryTipo) {
      const primaryMap = primaryTipo === "produto" ? maps.mProdutos
        : primaryTipo === "servico" ? maps.mServicos : maps.mExames;
      const r = bestMatch(desc, primaryMap);
      if (r.score > best.score) best = { ...r, tipo_matched: primaryTipo };
    }

    // Fallback cross-módulo: se não achou match perfeito no módulo primário,
    // tenta os outros módulos (item pode estar cadastrado em módulo diferente)
    if (best.score < 1) {
      for (const { tipo, map } of allMaps) {
        if (tipo === primaryTipo) continue; // já testou
        const r = bestMatch(desc, map);
        if (r.score > best.score) best = { ...r, tipo_matched: tipo };
      }
    }

    const tipoFinal = best.score > 0 ? (best.tipo_matched || primaryTipo || it.tipo) : it.tipo;
    return {
      ...it,
      tipo: tipoFinal,           // corrigir tipo se encontrou em módulo diferente
      tipo_original: it.tipo,    // preservar tipo original do parser
      match: best.rec,
      match_score: best.score,
      match_ok: best.score >= 1,
      match_fuzzy: best.score >= FUZZY_THRESHOLD && best.score < 1,
      match_fail: best.score < FUZZY_THRESHOLD,
      ref_id: best.rec ? best.rec.id : "",
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // PRÉ-VISUALIZAÇÃO
  // ═══════════════════════════════════════════════════════════════
  async function preview() {
    const raw = $id("pdfText")?.value || "";
    if (!raw.trim()) {
      setPill("warn", "Aguardando");
      setStatus("Cole o texto do PDF para iniciar.");
      $id("preview").textContent = "Cole o texto e clique em Pré-visualizar.";
      renderItensTable([]);
      $id("btnCommit").disabled = true;
      return;
    }

    setPill("warn", "Analisando…");
    setStatus("Executando parsing e auditoria de match…");

    const db = await VSC_DB.openDB();
    const maps = await buildMaps(db);
    const parsed = parseEquinovet(raw);

    // Fingerprint idempotência
    const fp = await sha256(raw);
    const fingerprint = fp || ("nohash_" + raw.length);

    // Match cliente
    const cliMatch = bestMatch(parsed.clienteRaw, maps.mClientes);
    const cli = cliMatch.score >= 1 ? cliMatch.rec :
      (cliMatch.score >= FUZZY_THRESHOLD ? cliMatch.rec : null);
    const cliFuzzy = cliMatch.score >= FUZZY_THRESHOLD && cliMatch.score < 1;

    // Match animal
    const aniMatch = bestMatch(parsed.animalRaw, maps.mAnimais);
    const ani = aniMatch.score >= FUZZY_THRESHOLD ? aniMatch.rec : null;

    // Match itens
    const rows = parsed.todosItens.map(it => matchItem(it, maps));

    // Issues
    const issues = [];
    // Detectar paste incompleto (falta cabeçalho com cliente/período)
    const hasHeader = /Período\s*:/i.test(raw) || /Telefone\s*:/i.test(raw);
    if (!hasHeader) {
      issues.push("⚠️ Texto parece incompleto — falta o cabeçalho do PDF. Cole o PDF completo (Ctrl+A no Equinovet → Ctrl+C → cole aqui). O texto deve incluir o nome do cliente, 'Período:', animal e todos os itens.");
    }
    if (!parsed.clienteRaw) issues.push("Cliente não identificado no PDF.");
    if (!cli) issues.push(`Cliente sem match no módulo Clientes: "${parsed.clienteRaw}" (melhor score: ${(cliMatch.score * 100).toFixed(0)}%)`);
    else if (cliFuzzy) issues.push(`Cliente com match FUZZY (${(cliMatch.score * 100).toFixed(0)}%): "${parsed.clienteRaw}" → "${cli.nome}" — confirme antes de commitar.`);
    if (!parsed.todosItens.length) issues.push("Nenhum item identificado no PDF.");

    for (const r of rows) {
      if (r.match_fail) issues.push(`Item sem match (${r.tipo}): "${r.desc}" — score máximo: ${(r.match_score * 100).toFixed(0)}%`);
      else if (r.match_fuzzy) issues.push(`Item com match FUZZY (${r.tipo}): "${r.desc}" → "${r.match?.nome}" (${(r.match_score * 100).toFixed(0)}%)`);

    }

    // Idempotência
    const STORE_ATD = (VSC_DB.stores?.atendimentos_master) || "atendimentos_master";
    const dup = await idbScanFind(db, STORE_ATD, o => o?.import_fingerprint === fingerprint);
    if (dup) issues.push("Este PDF já foi importado (fingerprint duplicado). Bloqueado.");

    // Resumo
    const nOk = rows.filter(r => r.match_ok).length;
    const nFuz = rows.filter(r => r.match_fuzzy).length;
    const nFail = rows.filter(r => r.match_fail).length;
    const dataFmt = toISODate(parsed.dataPrincipal) ? parsed.dataPrincipal : "—";
    const vencFmt = toISODate(parsed.vencimento) ? parsed.vencimento : "—";

    const summaryLines = [
      `[Fingerprint]  ${fingerprint}`,
      `[Cliente PDF]  ${parsed.clienteRaw || "(não identificado)"}`,
      `[Cliente ERP]  ${cli ? `${cli.nome} — id=${cli.id}` + (cliFuzzy ? " ⚠ FUZZY" : " ✓") : "(NÃO ENCONTRADO)"}`,
      `[Animal  PDF]  ${parsed.animalRaw || "(não identificado)"}`,
      `[Animal  ERP]  ${ani ? `${ani.nome} — id=${ani.id}` : "(não encontrado – será importado sem animal)"}`,
      `[Período]      ${parsed.periodoRaw || "—"}`,
      `[Data Princ.]  ${dataFmt}`,
      `[Vencimento]   ${vencFmt}`,
      `[Atendimentos] ${parsed.atendimentos.length} (datas: ${parsed.atendimentos.map(a => a.data).join(", ")})`,
      `[Itens]        ${rows.length} total | ${nOk} ✓ | ${nFuz} ~ fuzzy | ${nFail} ✗ sem match`,
      `[Total PDF]    ${fmtBRL(parsed.totalFinal)}`,
      `[Desconto]     ${fmtBRL(parsed.desconto)}`,
      `[Deslocamento] ${fmtBRL(parsed.deslocamento)}`,
    ];
    $id("preview").textContent = summaryLines.join("\n");

    renderItensTable(rows);

    const hardIssues = issues.filter(i => !i.includes("FUZZY"));
    const softIssues = issues.filter(i => i.includes("FUZZY"));

    if (hardIssues.length) {
      setPill("bad", "Bloqueado");
      const allIss = [...hardIssues, ...softIssues];
      setStatus(`<div class="err">Commit bloqueado (${hardIssues.length} problema(s)):</div><ul>${allIss.map(x => `<li>${esc(x)}</li>`).join("")}</ul>`);
      $id("btnCommit").disabled = true;
      window.__VSC_IMPORT_PREVIEW = null;
      return;
    }

    if (softIssues.length) {
      setPill("warn", "Fuzzy — confirme");
      setStatus(`<b>⚠ Matches fuzzy detectados — revise antes de commitar:</b><ul>${softIssues.map(x => `<li>${esc(x)}</li>`).join("")}</ul>`);
    } else {
      setPill("ok", "Pronto");
      setStatus("Pré-visualização OK. Commit liberado.");
    }

    $id("btnCommit").disabled = false;
    window.__VSC_IMPORT_PREVIEW = { fingerprint, parsed, rows, cli, ani, maps };
  }

  // ═══════════════════════════════════════════════════════════════
  // COMMIT — gravar atendimentos + conta a receber
  // ═══════════════════════════════════════════════════════════════
  async function commit() {
    const ctx = window.__VSC_IMPORT_PREVIEW;
    if (!ctx) {
      setPill("bad", "Bloqueado");
      setStatus("Sem pré-visualização válida. Execute Pré-visualizar primeiro.");
      return;
    }
    $id("btnCommit").disabled = true;
    setPill("warn", "Gravando…");
    setStatus("Gravando no ERP (atendimento + contas a receber)…");
    // ─── ESOS N4: IMPORT_LEDGER idempotente (NO-OP determinístico) ───
    const __ledger = window.VSC_IMPORT_LEDGER || null;
    const __source_system = "EQUINOVET";
    const __source_record_key = `PDF::${ctx.fingerprint}`;
    const __ledger_key = `${__source_system}::${__source_record_key}`;
    const __ledger_payload = {
      fingerprint: ctx.fingerprint,
      cliente: ctx.cli?.nome || ctx.parsed?.clienteRaw || "",
      animal: ctx.ani?.nome || ctx.parsed?.animalRaw || "",
      periodo: ctx.parsed?.periodoRaw || "",
      vencimento: ctx.parsed?.vencimento || "",
      totalFinal: ctx.parsed?.totalFinal || 0,
      atendimentos: (ctx.parsed?.atendimentos || []).length,
      rows: (ctx.rows || []).length
    };

    let __ledger_payload_hash = null;
    if(__ledger){
      __ledger_payload_hash = await __ledger.makePayloadHash(__ledger_payload);
      const __noop = await __ledger.existsSame(__ledger_key, __ledger_payload_hash);
      if(__noop){
        setPill("ok", "NO-OP ✓");
        setStatus(`Já importado (IMPORT_LEDGER).<br>Key: <code>${esc(__ledger_key)}</code><br>Hash: <code>${esc(__ledger_payload_hash)}</code>`);
        $id("btnCommit").disabled = false;
        return;
      }
    }


    const db = await VSC_DB.openDB();
    const STORE_ATD = (VSC_DB.stores?.atendimentos_master) || "atendimentos_master";
    const STORE_AR = (VSC_DB.stores?.contas_receber) || "contas_receber";
    const STORE_SQ = "sync_queue";

    // Race-safe idempotência
    const dup = await idbScanFind(db, STORE_ATD, o => o?.import_fingerprint === ctx.fingerprint);
    if (dup) {
      setPill("bad", "Duplicado");
      setStatus(`Bloqueado: PDF já importado. fingerprint=${esc(ctx.fingerprint)}`);
      try{ db.close(); }catch(_){ }
      $id("btnCommit").disabled = false;
      return;
    }

    const now = nowISO();
    const isoVenc = toISODate(ctx.parsed.vencimento) || now.slice(0, 10);
    const isoData = toISODate(ctx.parsed.dataPrincipal) || now.slice(0, 10);
    const comp = isoData.slice(0, 7);
    const short = String(ctx.fingerprint || "").slice(0, 8).toUpperCase();

    // Preparar atendimentos (um por data do PDF)
    const atdDocs = ctx.parsed.atendimentos.map((atd, idx) => {
      const atd_id = uuidv4();
      const numero = `IMP-EQV-${short}-${String(idx + 1).padStart(2, "0")}`;

      const itens = atd.itens.map(it => {
        const r = ctx.rows.find(r => norm(r.desc) === norm(it.desc) && r.tipo === it.tipo) || it;
        return {
          tipo: r.tipo,
          desc: r.desc,
          qtd: Number(r.qtd || 1),
          vu: Number(r.vu || 0),
          ref_id: r.ref_id || "",
          ref_store: r.tipo === "produto" ? "produtos_master" :
            r.tipo === "servico" ? "servicos_master" : "exames_master",
        };
      });

      const subtotal = itens.reduce((s, i) => s + i.qtd * i.vu, 0);

      return {
        id: atd_id,
        numero,
        status: "finalizado",
        cliente_id: ctx.cli?.id || "",
        cliente_label: ctx.cli?.nome || ctx.parsed.clienteRaw || "",
        _cliente_nome: ctx.cli?.nome || "",
        animal_ids: ctx.ani ? [ctx.ani.id] : [],
        vitals_by_animal: {},
        vitals_active_animal_id: ctx.ani?.id || "",
        itens,
        desconto_tipo: "R$",
        desconto_valor: idx === 0 ? Number(ctx.parsed.desconto || 0) : 0,
        desl_km: 0,
        desl_valor_km: 0,
        deslocamento: idx === 0 ? Number(ctx.parsed.deslocamento || 0) : 0,
        estoque_movimentado: false,
        financeiro_gerado: true,
        cr_id: null,
        created_at: now,
        updated_at: now,
        import_origem: "EQUINOVET_PDF",
        import_fingerprint: ctx.fingerprint,
        import_data_atd: atd.data,
        import_motivo: atd.motivo,
      };
    });

    // Conta a receber única para o total do PDF
    const cr_id = uuidv4();
    const valor_centavos = Math.round(Number(ctx.parsed.totalFinal || 0) * 100);
    const cr = {
      id: cr_id,
      documento: `IMP-EQV-${short}`,
      cliente_nome: ctx.cli?.nome || ctx.parsed.clienteRaw || "",
      cliente_doc: ctx.cli?.cpf || ctx.cli?.cnpj || "",
      competencia: comp,
      vencimento: isoVenc,
      valor_original_centavos: valor_centavos,
      saldo_centavos: valor_centavos,
      origem: "IMPORT_EQUINOVET",
      ref_tipo: "ATENDIMENTO",
      ref_id: atdDocs[0]?.id || "",
      observacoes: `Importado do Equinovet. Período: ${ctx.parsed.periodoRaw || "—"}. Animal: ${ctx.parsed.animalRaw || "—"}.`,
      cancelado: false,
      cancelado_em: "",
      cancelado_motivo: "",
      recebimentos: [],
      created_at: now,
      updated_at: now,
      last_sync: "",
      import_origem: "EQUINOVET_PDF",
      import_fingerprint: ctx.fingerprint,
    };

    // Vincular cr_id no primeiro atendimento
    if (atdDocs.length > 0) atdDocs[0].cr_id = cr_id;

    // Gravar em transação única
    try {
      const stores = [STORE_ATD, STORE_AR];
      let hasSQ = false;
      try {
        // Verificar se sync_queue existe
        db.transaction([STORE_SQ], "readonly");
        hasSQ = true;
      } catch (_) { }

      if (hasSQ) stores.push(STORE_SQ);

      const tx = db.transaction(stores, "readwrite");
      const stA = tx.objectStore(STORE_ATD);
      const stR = tx.objectStore(STORE_AR);
      const stQ = hasSQ ? tx.objectStore(STORE_SQ) : null;

      for (const atd of atdDocs) stA.put(atd);
      stR.put(cr);

      if (stQ) {
        for (const atd of atdDocs) {
          stQ.add({ id: uuidv4(), store: STORE_ATD, record_id: atd.id, op: "upsert", payload: atd, ts: now, synced: false });
        }
        stQ.add({ id: uuidv4(), store: STORE_AR, record_id: cr.id, op: "upsert", payload: cr, ts: now, synced: false });
      }

      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error || new Error("TX erro"));
        tx.onabort = () => reject(tx.error || new Error("TX abort"));
      });


      // ─── ESOS N4: registrar IMPORT_LEDGER (somente após TX OK) ───
      if(__ledger && __ledger_payload_hash){
        try{
          const __result_ids = []
            .concat((atdDocs||[]).map(a=>a.id))
            .concat([cr_id]);
          await __ledger.markImported({
            key: __ledger_key,
            source_system: __source_system,
            source_record_key: __source_record_key,
            source_document_hash: ctx.fingerprint,
            payload_hash: __ledger_payload_hash,
            result_ids: __result_ids
          });
        }catch(e){
          console.warn("[IMPORT_LEDGER] falha ao gravar ledger (TX já OK):", e);
        }
      }

      try{ db.close(); }catch(_){ }
      setPill("ok", "Concluído ✓");
      setStatus(`
        <b>✅ Importação concluída!</b><br>
        Cliente: <b>${esc(ctx.cli?.nome || ctx.parsed.clienteRaw)}</b><br>
        Animal: <b>${esc(ctx.ani?.nome || ctx.parsed.animalRaw || "—")}</b><br>
        Atendimentos gravados: <b>${atdDocs.length}</b> (${atdDocs.map(a => a.numero).join(", ")})<br>
        Conta a Receber: <b>${esc(cr.documento)}</b> — ${fmtBRL(ctx.parsed.totalFinal)} venc. ${esc(ctx.parsed.vencimento)}<br>
        Fingerprint: <code>${esc(ctx.fingerprint)}</code>
      `);
      window.__VSC_IMPORT_PREVIEW = null;
    } catch (e) {
      try{ if(typeof db!=="undefined" && db) db.close(); }catch(_){ }

      console.error("[IMPORT] commit fail", e);
      setPill("bad", "Erro");
      setStatus(`<span class="err">Falha ao gravar:</span> ${esc(String(e?.message || e))}`);
      $id("btnCommit").disabled = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // TABELA DE ITENS
  // ═══════════════════════════════════════════════════════════════
  function renderItensTable(rows) {
    const tb = $id("tbItens");
    if (!tb) return;
    if (!rows || !rows.length) {
      tb.innerHTML = `<tr><td colspan="7" class="muted" style="padding:12px;">Sem itens ainda.</td></tr>`;
      return;
    }
    tb.innerHTML = rows.map(r => {
      let matchCell;
      if (r.match_ok) {
        matchCell = `<span class="pill ok">✓ 100%</span> <span class="mono" style="font-size:11px;">${esc(r.ref_id || "")}</span>`;
      } else if (r.match_fuzzy) {
        matchCell = `<span class="pill warn">~ ${(r.match_score * 100).toFixed(0)}%</span> <span style="font-size:11px;">${esc(r.match?.nome || "")}</span>`;
      } else {
        matchCell = `<span class="pill bad">✗ sem match</span> <span class="err" style="font-size:11px;">${(r.match_score * 100).toFixed(0)}%</span>`;
      }
      const tipoIco = { produto: "📦", servico: "🛠️", exame: "🧪" }[r.tipo] || "❓";
      return `<tr>
        <td>${tipoIco} <span style="font-size:12px;">${esc(r.tipo)}</span></td>
        <td>${esc(r.desc)}</td>
        <td>${matchCell}</td>
        <td class="mono">${esc(String(r.qtd || 1))}</td>
        <td class="mono">${esc(fmtBRL(r.vu || 0))}</td>
        <td class="mono">${esc(fmtBRL(r.subtotal || 0))}</td>
      </tr>`;
    }).join("");
  }

  // ═══════════════════════════════════════════════════════════════
  // UI — DRAG & DROP DE PDF NATIVO (bonus: arrastar PDF direto)
  // ═══════════════════════════════════════════════════════════════
  function clearAll() {
    $id("pdfText").value = "";
    $id("preview").textContent = "Cole o texto e clique em Pré-visualizar.";
    renderItensTable([]);
    setPill("warn", "Aguardando");
    setStatus("");
    $id("btnCommit").disabled = true;
    window.__VSC_IMPORT_PREVIEW = null;
  }

  function boot() {
    const b1 = $id("btnPreview"), b2 = $id("btnCommit"), b3 = $id("btnClear");
    if (b1) b1.addEventListener("click", () => preview().catch(e => {
      console.error(e); setPill("bad", "Erro"); setStatus(`<span class="err">Erro:</span> ${esc(e.message || String(e))}`);
    }));
    if (b2) b2.addEventListener("click", () => commit().catch(e => {
      console.error(e); setPill("bad", "Erro"); setStatus(`<span class="err">Erro:</span> ${esc(e.message || String(e))}`);
    }));
    if (b3) b3.addEventListener("click", clearAll);

    // Auto-preview com debounce ao colar
    let to = null;
    const ta = $id("pdfText");
    if (ta) {
      ta.addEventListener("input", () => {
        clearTimeout(to);
        to = setTimeout(() => preview().catch(() => { }), 600);
      });
    }

    setPill("warn", "Aguardando");
    setStatus("Cole o texto copiado do PDF Equinovet e clique em <b>Pré-visualizar</b>.");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

})();
