const APP_URL = "https://app.vetsystemcontrol.com.br";

/*
  Quando existir um ambiente demo real, coloque a URL aqui.
  Exemplo:
  const DEMO_URL = "https://vsc-erp-demo-app.vetsystemcontrol.workers.dev/?resetDemo=1";
*/
const DEMO_URL = "https://vsc-erp-demo-app.vetsystemcontrol.workers.dev/?resetDemo=1";

const modal = document.querySelector("[data-modal]");
const openButtons = document.querySelectorAll("[data-open-demo]");
const closeButton = document.querySelector("[data-close-demo]");
const demoLink = document.querySelector("[data-demo-link]");
const menuButton = document.querySelector("[data-menu-button]");
const nav = document.querySelector("[data-nav]");
const demoSteps = document.querySelectorAll("[data-demo-step]");
const previewTag = document.querySelector("[data-preview-tag]");
const previewTitle = document.querySelector("[data-preview-title]");
const previewText = document.querySelector("[data-preview-text]");
const previewList = document.querySelector("[data-preview-list]");
const previewSectionButton = document.querySelector("[data-preview-section]");
const demoNewTabLink = document.querySelector("[data-demo-newtab]");
const demoRouteTitle = document.querySelector("[data-demo-route-title]");
const demoRouteText = document.querySelector("[data-demo-route-text]");

let activeDemoSection = "#atendimentos";

const demoContent = {
  atendimentos: {
    tag: "Módulo real do ERP",
    route: "atendimentos",
    section: "#atendimentos",
    title: "Atendimentos",
    text: "Abra a tela real de atendimentos do ERP em uma base demo com clientes, animais e registros fictícios.",
    routeText: "Atendimento com cliente e animal, itens, retorno e salvamento offline.",
    items: [
      "Usar proprietário e animal fictícios já cadastrados.",
      "Criar novos registros de teste quando necessário.",
      "Registrar atendimento, itens e retorno.",
      "Trabalhar offline e sincronizar quando houver internet."
    ]
  },
  dashboard: {
    tag: "Módulo real do ERP",
    route: "dashboard",
    section: "#modulos",
    title: "Dashboard",
    text: "Abra a visão geral real do ERP com indicadores, alertas e rotina fictícia já preenchida.",
    routeText: "Visão central da operação demo, com alertas e próximos atendimentos.",
    items: [
      "Ver próximos atendimentos.",
      "Acompanhar alertas de estoque.",
      "Visualizar financeiro operacional.",
      "Identificar pendências de sincronização."
    ]
  },
  clientes: {
    tag: "Módulo real do ERP",
    route: "clientes",
    section: "#atendimentos",
    title: "Clientes e proprietários",
    text: "Abra o cadastro real de proprietários para consultar ou criar registros fictícios.",
    routeText: "Cadastro de proprietários vinculado aos animais e atendimentos.",
    items: [
      "Consultar proprietários já cadastrados.",
      "Criar novo proprietário de teste.",
      "Ver vínculo com animais.",
      "Usar o cadastro no atendimento."
    ]
  },
  animais: {
    tag: "Módulo real do ERP",
    route: "animais",
    section: "#atendimentos",
    title: "Animais",
    text: "Abra o módulo real de animais para cadastrar equinos fictícios e consultar históricos.",
    routeText: "Cadastro de equinos com vínculo ao proprietário e histórico operacional.",
    items: [
      "Cadastrar animal fictício.",
      "Vincular ao proprietário.",
      "Consultar histórico.",
      "Usar em agenda e atendimento."
    ]
  },
  agenda: {
    tag: "Módulo real do ERP",
    route: "agenda",
    section: "#atendimentos",
    title: "Agenda",
    text: "Abra a agenda real para testar compromissos, retornos e rotina de campo.",
    routeText: "Organização de compromissos e retornos da operação demo.",
    items: [
      "Ver compromissos próximos.",
      "Criar agendamento de teste.",
      "Relacionar agenda com atendimento.",
      "Acompanhar rotina semanal."
    ]
  },
  estoque: {
    tag: "Módulo real do ERP",
    route: "catalogo",
    section: "#estoque",
    title: "Estoque e produtos",
    text: "Abra o módulo real de produtos para demonstrar lote, validade, estoque e reposição.",
    routeText: "Produtos, estoque, lote e validade com dados fictícios.",
    items: [
      "Consultar produtos cadastrados.",
      "Ver lote e validade.",
      "Identificar itens que exigem atenção.",
      "Relacionar uso ao atendimento."
    ]
  },
  financeiro: {
    tag: "Módulo real do ERP",
    route: "financeiro",
    section: "#financeiro",
    title: "Financeiro",
    text: "Abra o financeiro real para demonstrar contas, valores e organização operacional fictícia.",
    routeText: "Contas a receber e visão financeira da operação demo.",
    items: [
      "Ver valores previstos.",
      "Consultar contas fictícias.",
      "Relacionar atendimento ao financeiro.",
      "Evitar cobrança esquecida."
    ]
  },
  xml: {
    tag: "Módulo real do ERP",
    route: "importacaoxml",
    section: "#xml",
    title: "Importação XML",
    text: "Abra o módulo real de Importação XML para mostrar como reduz digitação manual e apoia o estoque.",
    routeText: "Conferência de XML, produtos e entrada operacional.",
    items: [
      "Importar documento de teste.",
      "Conferir produtos.",
      "Reduzir digitação repetida.",
      "Apoiar o controle de estoque."
    ]
  },
  offline: {
    tag: "Diferencial real",
    route: "dashboard",
    section: "#offline",
    title: "Offline e sincronização",
    text: "Abra o ambiente demo para demonstrar o uso offline-first: registrar a rotina e sincronizar quando a internet voltar.",
    routeText: "Fluxo offline-first demonstrado com base fictícia.",
    items: [
      "Registrar dados sem conexão.",
      "Guardar informações no dispositivo.",
      "Sincronizar ao voltar a internet.",
      "Preservar o sistema real separado."
    ]
  }
};

function buildDemoRoute(route) {
  const base = DEMO_URL.replace(/\/$/, "");
  return `${base}/#${route}`;
}

function updateDemoPreview(key) {
  const content = demoContent[key] || demoContent.atendimentos;
  activeDemoSection = content.section;
  const url = buildDemoRoute(content.route);

  if (previewTag) previewTag.textContent = content.tag;
  if (previewTitle) previewTitle.textContent = content.title;
  if (previewText) previewText.textContent = content.text;
  if (demoRouteTitle) demoRouteTitle.textContent = content.title;
  if (demoRouteText) demoRouteText.textContent = content.routeText;
  if (demoLink) demoLink.href = url;
  if (demoNewTabLink) demoNewTabLink.href = url;

  if (previewList) {
    previewList.innerHTML = "";
    content.items.forEach((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      previewList.appendChild(li);
    });
  }

  demoSteps.forEach((step) => {
    step.classList.toggle("is-active", step.dataset.demoStep === key);
  });
}

let lastFocusedBeforeModal = null;

function getModalFocusable() {
  if (!modal) return [];
  return Array.from(
    modal.querySelectorAll(
      'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => el.offsetParent !== null);
}

function openDemo() {
  if (!modal || !closeButton) return;
  lastFocusedBeforeModal =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modal.hidden = false;
  document.body.style.overflow = "hidden";
  updateDemoPreview("atendimentos");
  closeButton.focus();

  if (demoLink) {
    demoLink.removeAttribute("aria-disabled");
    demoLink.textContent = "Abrir módulo demo";
    demoLink.target = "_blank";
    demoLink.rel = "noopener noreferrer";
  }
}

function closeDemo() {
  if (!modal) return;
  modal.hidden = true;
  document.body.style.overflow = "";
  // Acessibilidade: devolve o foco a quem abriu o modal.
  if (lastFocusedBeforeModal && document.contains(lastFocusedBeforeModal)) {
    lastFocusedBeforeModal.focus();
  }
  lastFocusedBeforeModal = null;
}

// Foco preso dentro do modal (Tab cicla apenas nos elementos do diálogo).
function trapModalFocus(event) {
  if (!modal || modal.hidden || event.key !== "Tab") return;
  const focusable = getModalFocusable();
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

openButtons.forEach((button) => {
  button.addEventListener("click", openDemo);
});

if (closeButton) {
  closeButton.addEventListener("click", closeDemo);
}

if (modal) {
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeDemo();
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (modal && !modal.hidden) {
      closeDemo();
      return;
    }
    if (nav && nav.classList.contains("is-open")) {
      nav.classList.remove("is-open");
      if (menuButton) menuButton.setAttribute("aria-expanded", "false");
    }
    return;
  }
  trapModalFocus(event);
});

demoSteps.forEach((step) => {
  step.addEventListener("click", () => {
    updateDemoPreview(step.dataset.demoStep);
  });
});

if (previewSectionButton) {
  previewSectionButton.addEventListener("click", () => {
    closeDemo();
    const target = document.querySelector(activeDemoSection);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
}

if (menuButton && nav) {
  menuButton.addEventListener("click", () => {
    const isOpen = nav.classList.toggle("is-open");
    menuButton.setAttribute("aria-expanded", String(isOpen));
  });

  nav.querySelectorAll("a, button").forEach((item) => {
    item.addEventListener("click", () => {
      nav.classList.remove("is-open");
      menuButton.setAttribute("aria-expanded", "false");
    });
  });
}
