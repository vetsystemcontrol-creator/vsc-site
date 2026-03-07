(function () {
  const toggle = document.querySelector('[data-nav-toggle]');
  const mobile = document.querySelector('[data-nav-mobile]');

  if (toggle && mobile) {
    toggle.addEventListener('click', function () {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!expanded));
      mobile.hidden = expanded;
    });
  }

  document.addEventListener('click', function (e) {
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;

    const id = a.getAttribute('href').slice(1);
    const el = document.getElementById(id);
    if (!el) return;

    e.preventDefault();
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    history.pushState(null, '', '#' + id);
  });

  const carouselRoot = document.querySelector('[data-vsc-carousel]');
  if (!carouselRoot) return;

  const track = carouselRoot.querySelector('.vsc-carousel__track');
  const slides = Array.from(carouselRoot.querySelectorAll('[data-vsc-slide]'));
  const btnPrev = carouselRoot.querySelector('[data-vsc-prev]');
  const btnNext = carouselRoot.querySelector('[data-vsc-next]');
  const dotsWrap = carouselRoot.querySelector('[data-vsc-dots]');
  let idx = 0;
  let timer = null;

  if (!track || !slides.length) return;

  const updateDots = function () {
    if (!dotsWrap) return;
    dotsWrap.querySelectorAll('.vsc-dot').forEach((d, di) => {
      d.setAttribute('aria-current', di === idx ? 'true' : 'false');
    });
  };

  const scrollToIndex = function (i) {
    idx = (i + slides.length) % slides.length;
    const el = slides[idx];
    track.scrollTo({ left: el.offsetLeft, behavior: 'smooth' });
    updateDots();
  };

  if (dotsWrap) {
    dotsWrap.innerHTML = '';
    slides.forEach((_, di) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'vsc-dot';
      b.setAttribute('aria-label', 'Ir para tela ' + (di + 1));
      b.setAttribute('aria-current', di === 0 ? 'true' : 'false');
      b.addEventListener('click', () => scrollToIndex(di));
      dotsWrap.appendChild(b);
    });
  }

  if (btnPrev) btnPrev.addEventListener('click', () => scrollToIndex(idx - 1));
  if (btnNext) btnNext.addEventListener('click', () => scrollToIndex(idx + 1));

  const stop = function () {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const start = function () {
    stop();
    timer = setInterval(() => scrollToIndex(idx + 1), 5200);
  };

  carouselRoot.addEventListener('mouseenter', stop);
  carouselRoot.addEventListener('mouseleave', start);
  carouselRoot.addEventListener('focusin', stop);
  carouselRoot.addEventListener('focusout', function (e) {
    if (!carouselRoot.contains(e.relatedTarget)) start();
  });

  let raf = null;
  track.addEventListener('scroll', function () {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(function () {
      const x = track.scrollLeft + (track.clientWidth / 2);
      let best = 0;
      let bestDist = Infinity;

      slides.forEach((s, si) => {
        const mid = s.offsetLeft + (s.clientWidth / 2);
        const d = Math.abs(mid - x);
        if (d < bestDist) {
          bestDist = d;
          best = si;
        }
      });

      idx = best;
      updateDots();
    });
  }, { passive: true });

  start();
})();
