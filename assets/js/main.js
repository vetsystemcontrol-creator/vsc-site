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
})();
