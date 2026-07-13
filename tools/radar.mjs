/**
 * radar.mjs — monta o "Radar equino" do site a partir de feeds RSS públicos.
 *
 * O QUE ESTE ROBÔ FAZ (e o que ele NUNCA faz):
 *   • Guarda apenas MANCHETE + FONTE + DATA + LINK para o original.
 *   • NÃO copia o texto da matéria. Quem quiser ler é levado ao site da fonte.
 * Essa fronteira não é um detalhe de implementação: reproduzir o conteúdo de
 * terceiros seria violação de direito autoral (Lei 9.610/98) e, para o Google,
 * "scraped content" — que é motivo de rebaixamento. Publicar só a manchete com
 * link é exatamente o uso para o qual o feed RSS existe.
 *
 * FILTRO DE RELEVÂNCIA (o motivo de este arquivo não ser trivial): um agregador
 * ingênuo despeja lixo no site. Nos testes reais, o Google News devolveu
 * "Prefeitura de Riacho dos Cavalos" (nome de cidade!) e o WOAH, gripe aviária.
 * Por isso a manchete precisa passar em DOIS crivos: falar de equino E de saúde /
 * veterinária — com uma lista de exceções para os falsos positivos conhecidos.
 *
 * Sem dependências de propósito: roda com o Node puro no CI, sem npm install.
 */

import { writeFile, readFile } from 'node:fs/promises';

const UA =
  'Mozilla/5.0 (compatible; VetSystemControlRadar/1.0; +https://www.vetsystemcontrol.com.br)';

const MAX_ITEMS = 24;
const MAX_AGE_DAYS = 120;
/** Teto por fonte: sem isso, um periódico com 36 itens afoga todo o resto. */
const MAX_PER_SOURCE = 6;

/**
 * `match` define o crivo de cada fonte:
 *   'strict'     — precisa falar de equino E de saúde/veterinária (imprensa geral).
 *   'profession' — equino OU assunto da profissão (o feed já é só de veterinária).
 *   'source'     — a fonte inteira é do assunto (periódico só de equinos).
 */
const FEEDS = [
  {
    source: 'CFMV',
    label: 'Conselho Federal de Medicina Veterinária',
    kind: 'profissao',
    url: 'https://www.cfmv.gov.br/feed/',
    lang: 'pt',
    match: 'profession',
  },
  {
    source: 'Imprensa brasileira',
    label: 'Notícias (via Google Notícias)',
    kind: 'imprensa',
    url: 'https://news.google.com/rss/search?q=(equinos+OR+equideos+OR+%22cavalos%22)+(veterin%C3%A1rio+OR+veterin%C3%A1ria+OR+sanidade+OR+%22sa%C3%BAde+animal%22+OR+haras)&hl=pt-BR&gl=BR&ceid=BR:pt-419',
    lang: 'pt',
    match: 'strict',
  },
  {
    source: 'WOAH',
    label: 'Organização Mundial de Saúde Animal',
    kind: 'sanidade',
    url: 'https://www.woah.org/en/rss/',
    lang: 'en',
    match: 'strict',
  },
  {
    source: 'Journal of Equine Veterinary Science',
    label: 'Ciência (Elsevier)',
    kind: 'ciencia',
    url: 'https://rss.sciencedirect.com/publication/science/07370806',
    lang: 'en',
    match: 'source',
  },
];

const EQUINE_WORDS = [
  'equin', 'equíde', 'equide', 'cavalo', 'cavalos', 'égua', 'egua', 'éguas',
  'potro', 'potra', 'garanhão', 'garanhao', 'muar', 'asinin', 'haras',
  'equine', 'equid', 'horse', 'horses', 'mare', 'foal', 'stallion', 'donkey',
];

const HEALTH_WORDS = [
  'veterinár', 'veterinar', 'sanidade', 'saúde', 'saude', 'doença', 'doenca',
  'surto', 'vacina', 'vacinação', 'vacinacao', 'mormo', 'anemia infecciosa',
  'aie', 'influenza', 'raiva', 'febre', 'clínic', 'clinic', 'cirurgi',
  'tratamento', 'diagnóstic', 'diagnostic', 'zoonose', 'crmv', 'medicina',
  'health', 'disease', 'outbreak', 'vaccin', 'surveillance', 'welfare',
  'glanders', 'colic', 'cólica', 'colica', 'lameness', 'therapy',
];

/**
 * Assuntos da profissão que mudam a vida de quem CLINICA. Termos genéricos
 * ('cfmv', 'conselho', 'profissão') foram deliberadamente deixados de fora: eles
 * casam com o comunicado administrativo do conselho ("Diretriz de Gestão para os
 * Conselhos Regionais"), que não serve a quem atende cavalo.
 */
const PROFESSION_WORDS = [
  'exercício ilegal', 'exercicio ilegal', 'resolução', 'resolucao',
  'legislação', 'legislacao', 'fiscalização', 'fiscalizacao', 'especialista',
  'residência', 'residencia', 'anuidade', 'receituário', 'receituario',
  'responsabilidade técnica', 'responsabilidade tecnica', 'bem-estar animal',
];

/**
 * Falsos positivos vistos em produção — cada linha aqui saiu de um teste real,
 * não de suposição:
 *   • "Riacho dos Cavalos" é município da PB: a manchete casava com "cavalos" e
 *     com "saúde" (campanha contra a dengue) e entrava.
 *   • "Noiva veterinária viraliza ao chegar a cavalo em casamento": casava com
 *     "cavalo" + "veterinária". É viral, não é conteúdo técnico.
 */
const BLOCKLIST = [
  'riacho dos cavalos',
  'cavalo de pau',
  'cavalo de batalha',
  'cavalo de tróia',
  'cavalo de troia',
  'viraliza',
  'viral nas redes',
  'casamento',
  'noiva',
  'horóscopo',
  'horoscopo',
];

const hasAny = (text, words) => words.some((word) => text.includes(word));

function isRelevant(title, feed) {
  const text = title.toLowerCase();
  if (BLOCKLIST.some((term) => text.includes(term))) return false;

  if (feed.match === 'source') return true;
  if (feed.match === 'profession') {
    return hasAny(text, EQUINE_WORDS) || hasAny(text, PROFESSION_WORDS);
  }
  return hasAny(text, EQUINE_WORDS) && hasAny(text, HEALTH_WORDS);
}

// ── Parsing (RSS 2.0 e Atom) ────────────────────────────────────────────────

function decodeEntities(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickTag(xml, name) {
  const match = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return match ? decodeEntities(match[1]) : '';
}

function pickLink(xml) {
  const rss = pickTag(xml, 'link');
  if (rss && /^https?:/i.test(rss)) return rss;
  const atom = xml.match(/<link[^>]*href="([^"]+)"/i);
  return atom ? atom[1] : '';
}

function parseFeed(xml, feed) {
  const chunks = xml.split(/<item[\s>]|<entry[\s>]/i).slice(1);
  const items = [];

  for (const chunk of chunks) {
    const title = pickTag(chunk, 'title');
    const link = pickLink(chunk);
    if (!title || !link) continue;

    const rawDate =
      pickTag(chunk, 'pubDate') || pickTag(chunk, 'updated') || pickTag(chunk, 'published');
    const date = rawDate ? new Date(rawDate) : null;
    const publishedAt = date && !Number.isNaN(date.valueOf()) ? date.toISOString() : null;

    // "Título - Veículo" é o formato do Google Notícias: separa o veículo real.
    let headline = title;
    let outlet = feed.source;
    if (feed.kind === 'imprensa') {
      const split = title.lastIndexOf(' - ');
      if (split > 20) {
        headline = title.slice(0, split).trim();
        outlet = title.slice(split + 3).trim();
      }
    }

    if (!isRelevant(headline, feed)) continue;

    items.push({
      title: headline,
      url: link,
      source: outlet,
      sourceKind: feed.kind,
      sourceLabel: feed.label,
      lang: feed.lang,
      publishedAt,
    });
  }

  return items;
}

/** Assinatura do título para deduplicar: sem acento, sem pontuação, 8 palavras. */
function fingerprint(title) {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .join(' ');
}

// ── Execução ────────────────────────────────────────────────────────────────

async function fetchFeed(feed) {
  const response = await fetch(feed.url, {
    headers: { 'user-agent': UA, accept: 'application/rss+xml, application/xml, text/xml' },
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseFeed(await response.text(), feed);
}

async function main() {
  const collected = [];
  const report = [];

  for (const feed of FEEDS) {
    try {
      const items = await fetchFeed(feed);
      collected.push(...items);
      report.push(`${feed.source}: ${items.length} relevante(s)`);
    } catch (error) {
      // Uma fonte fora do ar NÃO derruba o radar — as outras seguem, e o
      // radar.json anterior permanece publicado se nada novo for gerado.
      report.push(`${feed.source}: FALHOU (${error.message})`);
    }
  }

  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const seen = new Set();
  const perSource = new Map();

  const items = collected
    .filter((item) => !item.publishedAt || Date.parse(item.publishedAt) >= cutoff)
    .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))
    .filter((item) => {
      // Dedupe sem acento e sem pontuação: o mesmo press release sai em vários
      // veículos com títulos quase iguais ("...na Conferência" / "...durante a
      // Conferência"). Comparar o texto cru deixaria os dois passarem.
      const key = fingerprint(item.title);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .filter((item) => {
      const used = perSource.get(item.sourceKind) ?? 0;
      if (used >= MAX_PER_SOURCE) return false;
      perSource.set(item.sourceKind, used + 1);
      return true;
    })
    .slice(0, MAX_ITEMS);

  if (items.length === 0) {
    console.log(report.join('\n'));
    console.log('Nenhum item relevante. Mantendo o radar.json atual.');
    return;
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    notice:
      'Manchetes de fontes públicas. O conteúdo é do veículo de origem — clique para ler no site dele.',
    items,
  };

  const next = `${JSON.stringify(payload, null, 2)}\n`;

  // Só reescreve se a LISTA mudou: sem isso, o carimbo de data geraria um commit
  // por dia mesmo sem notícia nova, poluindo o histórico e o deploy.
  try {
    const current = JSON.parse(await readFile('radar.json', 'utf8'));
    const same = JSON.stringify(current.items) === JSON.stringify(items);
    if (same) {
      console.log(report.join('\n'));
      console.log('Sem novidade — radar.json inalterado.');
      return;
    }
  } catch {
    // Primeira execução: não existe radar.json ainda.
  }

  await writeFile('radar.json', next, 'utf8');
  console.log(report.join('\n'));
  console.log(`radar.json atualizado com ${items.length} manchete(s).`);
}

await main();
