/**
 * radar.js — pinta o "Radar equino" a partir de `radar.json`.
 *
 * O JSON é gerado pelo robô (`tools/radar.mjs`), que roda uma vez por dia e guarda
 * APENAS manchete, fonte, data e link. Nada de texto de terceiros: quem quiser ler
 * é levado ao site da fonte. Ver o cabeçalho de `tools/radar.mjs` para o porquê
 * (direito autoral + política de spam do Google sobre conteúdo raspado).
 *
 * O arquivo é servido pela própria origem — sem CORS, sem worker, sem custo.
 */

const list = document.querySelector('[data-radar-list]');
const updatedLabel = document.querySelector('[data-radar-updated]');

const KIND_LABEL = {
  profissao: 'Profissão',
  imprensa: 'Imprensa',
  sanidade: 'Sanidade animal',
  ciencia: 'Ciência',
};

function formatDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return '';
  return date.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function render(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];

  if (items.length === 0) {
    list.innerHTML =
      '<p class="radar-empty">Nenhuma manchete no momento. Volte em breve.</p>';
    return;
  }

  if (updatedLabel && payload.updatedAt) {
    updatedLabel.textContent = `Atualizado em ${formatDate(payload.updatedAt)}`;
    updatedLabel.hidden = false;
  }

  // `textContent` em vez de innerHTML nos campos vindos do feed: título de
  // terceiros é conteúdo NÃO CONFIÁVEL — montá-lo como HTML seria abrir XSS.
  list.textContent = '';

  for (const item of items) {
    const card = document.createElement('a');
    card.className = 'radar-item';
    card.href = item.url;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';

    const meta = document.createElement('p');
    meta.className = 'radar-meta';

    const kind = document.createElement('span');
    kind.className = 'radar-kind';
    kind.textContent = KIND_LABEL[item.sourceKind] ?? 'Notícia';
    meta.appendChild(kind);

    const source = document.createElement('span');
    source.textContent = item.source ?? '';
    meta.appendChild(source);

    const date = formatDate(item.publishedAt);
    if (date) {
      const time = document.createElement('span');
      time.textContent = date;
      meta.appendChild(time);
    }

    const title = document.createElement('strong');
    title.textContent = item.title;

    const cue = document.createElement('span');
    cue.className = 'radar-cue';
    cue.textContent = 'Ler no site da fonte →';

    card.append(meta, title, cue);
    list.appendChild(card);
  }
}

fetch('radar.json', { cache: 'no-cache' })
  .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
  .then(render)
  .catch(() => {
    list.innerHTML =
      '<p class="radar-empty">Não foi possível carregar as manchetes agora.</p>';
  });
