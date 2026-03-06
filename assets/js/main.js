(function(){
  const toggle = document.querySelector('[data-nav-toggle]');
  const mobile = document.querySelector('[data-nav-mobile]');
  if(toggle && mobile){
    toggle.addEventListener('click', function(){
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!expanded));
      mobile.hidden = expanded;
    });
  }

  // Smooth anchor (small enhancement; doesn't hurt CWV much)
  document.addEventListener('click', function(e){
    const a = e.target.closest('a[href^="#"]');
    if(!a) return;
    const id = a.getAttribute('href').slice(1);
    const el = document.getElementById(id);
    if(!el) return;
    e.preventDefault();
    el.scrollIntoView({behavior:'smooth', block:'start'});
    history.pushState(null, '', '#'+id);
  });
  // === VSC Screens Carousel + Fullscreen Lightbox (site only; no ERP interaction) ===
  const carouselRoot = document.querySelector('[data-vsc-carousel]');
  if(carouselRoot){
    const viewport = carouselRoot.querySelector('.vsc-carousel__viewport') || carouselRoot;
    const track = carouselRoot.querySelector('.vsc-carousel__track');
    const slides = Array.from(carouselRoot.querySelectorAll('[data-vsc-slide]'));
    const btnPrev = carouselRoot.querySelector('[data-vsc-prev]');
    const btnNext = carouselRoot.querySelector('[data-vsc-next]');
    const dotsWrap = carouselRoot.querySelector('[data-vsc-dots]');
    let idx = 0;
    let timer = null;
    let lastFocusedTrigger = null;

    if(!track || !slides.length){
      return;
    }

    const scrollToIndex = (i) => {
      if(!slides.length) return;
      idx = (i + slides.length) % slides.length;
      const el = slides[idx];
      const left = el.offsetLeft;
      track.scrollTo({ left, behavior: 'smooth' });
      if(dotsWrap){
        dotsWrap.querySelectorAll('.vsc-dot').forEach((d, di) => d.setAttribute('aria-current', di===idx ? 'true' : 'false'));
      }
    };

    // Dots
    if(dotsWrap){
      dotsWrap.innerHTML = '';
      slides.forEach((_, di) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'vsc-dot';
        b.setAttribute('aria-label', 'Ir para tela ' + (di+1));
        b.setAttribute('aria-current', di===0 ? 'true' : 'false');
        b.addEventListener('click', () => scrollToIndex(di));
        dotsWrap.appendChild(b);
      });
    }

    // Buttons
    if(btnPrev) btnPrev.addEventListener('click', () => scrollToIndex(idx-1));
    if(btnNext) btnNext.addEventListener('click', () => scrollToIndex(idx+1));

    // Autoplay (pausa em hover/foco)
    const start = () => {
      stop();
      timer = setInterval(() => scrollToIndex(idx+1), 5200);
    };
    const stop = () => { if(timer){ clearInterval(timer); timer = null; } };

    carouselRoot.addEventListener('mouseenter', stop);
    carouselRoot.addEventListener('mouseleave', start);
    carouselRoot.addEventListener('focusin', stop);
    carouselRoot.addEventListener('focusout', (e) => {
      if(!carouselRoot.contains(e.relatedTarget)) start();
    });
    viewport.addEventListener('mouseenter', stop);
    viewport.addEventListener('mouseleave', start);

    // Update idx on scroll (snap)
    let raf = null;
    track.addEventListener('scroll', () => {
      if(raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const x = track.scrollLeft + (track.clientWidth/2);
        let best = 0, bestDist = Infinity;
        slides.forEach((s, si) => {
          const mid = s.offsetLeft + (s.clientWidth/2);
          const d = Math.abs(mid - x);
          if(d < bestDist){ bestDist = d; best = si; }
        });
        idx = best;
        if(dotsWrap){
          dotsWrap.querySelectorAll('.vsc-dot').forEach((d, di) => d.setAttribute('aria-current', di===idx ? 'true' : 'false'));
        }
      });
    }, {passive:true});

    // Kickoff
    start();

    // Lightbox
    const lightbox = document.querySelector('.vsc-lightbox');
    const lbPanel = lightbox ? lightbox.querySelector('.vsc-lightbox__panel') : null;
    const lbImg = document.getElementById('vscLightboxImg');
    const lbTitle = document.getElementById('vscLightboxTitle');
    const closeAll = () => {
      if(!lightbox) return;
      stop();
      lightbox.hidden = true;
      lightbox.setAttribute('aria-hidden','true');
      document.body.classList.remove('vsc-no-scroll');
      if(lbImg){
        lbImg.removeAttribute('src');
        lbImg.alt = '';
      }
      if(lastFocusedTrigger && typeof lastFocusedTrigger.focus === 'function') {
        lastFocusedTrigger.focus();
      }
      start();
    };
    const open = (src, title, triggerEl) => {
      if(!lightbox || !lbImg) return;
      stop();
      lastFocusedTrigger = triggerEl || document.activeElement;
      lbImg.src = src;
      lbImg.alt = title ? ('Tela: ' + title) : 'Tela do sistema';
      if(lbTitle) lbTitle.textContent = title || 'Tela';
      lightbox.hidden = false;
      lightbox.setAttribute('aria-hidden','false');
      document.body.classList.add('vsc-no-scroll');
      const closeBtn = lightbox.querySelector('[data-vsc-close]');
      if(closeBtn) closeBtn.focus();
    };

    if(lightbox && lbPanel){
      lightbox.addEventListener('click', (e) => {
        if(e.target.closest('[data-vsc-close]') || (!lbPanel.contains(e.target) && e.target === lightbox)) {
          e.preventDefault();
          closeAll();
        }
      });
      const backdrop = lightbox.querySelector('.vsc-lightbox__backdrop');
      if(backdrop){
        backdrop.addEventListener('click', (e) => {
          e.preventDefault();
          closeAll();
        });
      }
      lbPanel.addEventListener('click', (e) => e.stopPropagation());
    }

    document.addEventListener('click', (e) => {
      const opener = e.target.closest('[data-vsc-open]');
      if(opener){
        e.preventDefault();
        const src = opener.getAttribute('data-src');
        const title = opener.getAttribute('data-title') || opener.getAttribute('aria-label') || 'Tela';
        if(src) open(src, title, opener);
        return;
      }
      if(e.target.closest('[data-vsc-close]')){
        e.preventDefault();
        closeAll();
      }
    });

    document.addEventListener('keydown', (e) => {
      if(e.key === 'Escape' && lightbox && !lightbox.hidden) closeAll();
    });
  }

})();
