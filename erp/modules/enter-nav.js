/* enter-nav SAFE (VSC)
   Nunca interfere com digitaï¿½ï¿½o (INPUT/TEXTAREA/contenteditable).
   Enter navega apenas fora de campos editï¿½veis.
*/
(function(){
  "use strict";
  document.addEventListener("keydown", function(ev){
    try {
      var t = ev && ev.target ? ev.target : null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

      if (!ev || ev.key !== "Enter") return;
      if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;

      ev.preventDefault();

      var focusables = Array.prototype.slice.call(
        document.querySelectorAll("a,button,input,select,textarea,[tabindex]")
      ).filter(function(el){
        if (!el || el.disabled) return false;
        var ti = el.getAttribute("tabindex");
        if (ti !== null && Number(ti) < 0) return false;
        return el.offsetParent !== null;
      });

      var idx = focusables.indexOf(document.activeElement);
      var next = focusables[idx + 1] || focusables[0];
      if (next && next.focus) next.focus();
      if (next && next.select) next.select();
    } catch(e) {}
  }, true);
})();