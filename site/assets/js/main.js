(function () {
  var doc = document;
  var body = doc.body;

  var topbar = doc.querySelector('[data-topbar]');
  if (topbar) {
    var syncTopbar = function () {
      topbar.classList.toggle('is-scrolled', window.scrollY > 8);
    };
    syncTopbar();
    window.addEventListener('scroll', syncTopbar, { passive: true });
  }

  var toggle = doc.querySelector('[data-nav-toggle]');
  var mobile = doc.querySelector('[data-nav-mobile]');
  if (toggle && mobile) {
    toggle.addEventListener('click', function () {
      var expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!expanded));
      mobile.hidden = expanded;
      body.classList.toggle('menu-open', !expanded);
    });

    mobile.addEventListener('click', function (event) {
      var link = event.target.closest('a');
      if (!link) return;
      mobile.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      body.classList.remove('menu-open');
    });
  }

  doc.addEventListener('click', function (event) {
    var anchor = event.target.closest('a[href^="#"]');
    if (!anchor) return;
    var id = anchor.getAttribute('href').slice(1);
    if (!id) return;
    var target = doc.getElementById(id);
    if (!target) return;
    event.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    history.replaceState(null, '', '#' + id);
  });

  var explorerData = {
    atendimentos: {
      title: 'Atendimentos / Ficha Clínica',
      description: 'Prontuário operacional com hero clínico do paciente, status de atendimento, resumo financeiro, itens lançados e linha do tempo clínica em uma visualização comercial fiel ao ERP.',
      thumb: '/assets/screens/explorer/atendimentos-thumb.webp',
      full: '/assets/screens/explorer/atendimentos-full.webp',
      previewPage: 'previews/atendimentos.html',
      alt: 'Tela real de atendimentos do Vet System Control com dados demonstrativos',
      facts: [
        'Hero clínico forte para apresentação comercial',
        'Itens, anexos e evolução no mesmo contexto',
        'Abertura ampliada da imagem real do módulo'
      ]
    },
    produtos: {
      title: 'Produtos / Cadastro, estoque e rastreabilidade',
      description: 'Visão operacional do módulo de produtos com indicadores de estoque, filtros, lotes, validade, itens críticos e integração com atendimento e fiscal.',
      thumb: '/assets/screens/explorer/produtos-thumb.webp',
      full: '/assets/screens/explorer/produtos-full.webp',
      previewPage: 'previews/produtos.html',
      alt: 'Tela demonstrativa do módulo de produtos do Vet System Control',
      facts: [
        'Cadastro com leitura rápida de estoque e preço',
        'Rastreabilidade por lote e validade',
        'Contexto visual premium para operação veterinária'
      ]
    },
    reproducao: {
      title: 'Reprodução Equina / Ciclo e agenda reprodutiva',
      description: 'Módulo especializado para matrizes, garanhões, status do ciclo, eventos recentes, agenda da estação e acompanhamento de gestação.',
      thumb: '/assets/screens/explorer/reproducao-thumb.webp',
      full: '/assets/screens/explorer/reproducao-full.webp',
      previewPage: 'previews/reproducao.html',
      alt: 'Tela demonstrativa do módulo de reprodução equina do Vet System Control',
      facts: [
        'Especialização equina visível na interface',
        'Eventos reprodutivos e agenda em uma única visão',
        'Visualização ampliada da tela real do módulo'
      ]
    },
    importacaoxml: {
      title: 'Importação XML / Entrada fiscal integrada',
      description: 'Fluxo fiscal com recepção de NF-e, conferência de itens, fornecedor conciliado, geração de conta a pagar e reflexo automático em produtos e estoque.',
      thumb: '/assets/screens/explorer/importacaoxml-thumb.webp',
      full: '/assets/screens/explorer/importacaoxml-full.webp',
      previewPage: 'previews/importacao-xml.html',
      alt: 'Tela demonstrativa de importação XML do Vet System Control',
      facts: [
        'Leitura comercial forte para o fluxo fiscal',
        'Itens da nota, totais e integrações no mesmo módulo',
        'Tela ampliada abre a imagem real do módulo'
      ]
    }
  };

  var currentScreenKey = 'atendimentos';
  var screenTabs = Array.prototype.slice.call(doc.querySelectorAll('[data-screen-tab]'));
  var screenTitle = doc.querySelector('[data-screen-title]');
  var screenDescription = doc.querySelector('[data-screen-description]');
  var screenFacts = doc.querySelector('[data-screen-facts]');
  var screenPreview = doc.getElementById('screen-preview-image');
  var screenOpenButtons = Array.prototype.slice.call(doc.querySelectorAll('[data-screen-open]'));

  var renderScreen = function (key) {
    var data = explorerData[key];
    if (!data || !screenTitle || !screenDescription || !screenFacts || !screenPreview) return;

    currentScreenKey = key;
    screenTitle.textContent = data.title;
    screenDescription.textContent = data.description;
    screenPreview.src = data.thumb;
    screenPreview.alt = data.alt;

    screenFacts.innerHTML = '';
    data.facts.forEach(function (fact) {
      var item = doc.createElement('li');
      item.textContent = fact;
      screenFacts.appendChild(item);
    });

    screenTabs.forEach(function (tab) {
      var active = tab.getAttribute('data-screen-tab') === key;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  };

  screenTabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      renderScreen(tab.getAttribute('data-screen-tab'));
    });
  });

  var lightbox = doc.querySelector('[data-lightbox]');
  if (!lightbox) {
    if (screenTabs.length) renderScreen(currentScreenKey);
    return;
  }

  var lightboxImage = lightbox.querySelector('.lightbox__image');
  var lightboxFrame = lightbox.querySelector('.lightbox__frame');
  var lightboxTitle = lightbox.querySelector('.lightbox__title');
  var closeButtons = lightbox.querySelectorAll('[data-lightbox-close]');
  var lastTrigger = null;

  var closeLightbox = function () {
    lightbox.hidden = true;
    if (lightboxImage) {
      lightboxImage.removeAttribute('src');
      lightboxImage.alt = '';
      lightboxImage.hidden = true;
    }
    if (lightboxFrame) {
      lightboxFrame.removeAttribute('src');
      lightboxFrame.hidden = true;
    }
    if (lightboxTitle) lightboxTitle.textContent = '';
    body.style.overflow = '';
    if (lastTrigger) lastTrigger.focus();
  };

  var openLightbox = function (trigger) {
    var src = trigger.getAttribute('data-lightbox-src');
    var title = trigger.getAttribute('data-lightbox-title') || 'Visualização ampliada';
    if (!lightboxTitle || !src || !lightboxImage) return;
    lastTrigger = trigger;
    lightboxTitle.textContent = title;

    lightboxImage.hidden = true;
    lightboxImage.removeAttribute('src');
    lightboxImage.alt = '';

    if (lightboxFrame) {
      lightboxFrame.hidden = true;
      lightboxFrame.removeAttribute('src');
    }

    lightboxImage.src = src;
    lightboxImage.alt = title;
    lightboxImage.hidden = false;

    lightbox.hidden = false;
    body.style.overflow = 'hidden';
    var closeButton = lightbox.querySelector('.lightbox__close');
    if (closeButton) closeButton.focus();
  };

  screenOpenButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      var data = explorerData[currentScreenKey];
      if (!data) return;
      button.setAttribute('data-lightbox-src', data.full);
      button.removeAttribute('data-lightbox-page');
      button.setAttribute('data-lightbox-title', data.title);
      openLightbox(button);
    });
  });

  doc.addEventListener('click', function (event) {
    var trigger = event.target.closest('[data-lightbox-src]');
    if (!trigger) return;
    event.preventDefault();
    openLightbox(trigger);
  });

  closeButtons.forEach(function (button) {
    button.addEventListener('click', closeLightbox);
  });

  doc.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !lightbox.hidden) {
      closeLightbox();
    }
  });

  if (screenTabs.length) renderScreen(currentScreenKey);
})();
