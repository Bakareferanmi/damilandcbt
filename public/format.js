// Turns question text into safe HTML with simple science/maths formatting.
//   x^2  -> x squared      x^(n+1) -> longer superscript     10^-3 -> negative power
//   H_2O -> H with subscript 2      x_(max) -> longer subscript
//   frac(a,b) -> stacked fraction   sqrt(x+1) -> square root
// Everything else is shown as plain text. Symbols such as π θ Δ ° × ÷ ≤ ≥ → can be typed or pasted directly.
(function () {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  window.fmt = function (text) {
    let h = esc(text);
    h = h.replace(/frac\(([^(),]+),([^()]+)\)/g, '<span class="frac"><span>$1</span><span>$2</span></span>');
    h = h.replace(/sqrt\(([^()]+)\)/g, '√<span class="radic">$1</span>');
    h = h.replace(/\^\(([^()]+)\)/g, '<sup>$1</sup>').replace(/\^([+\-−]?\d+|[A-Za-z])/g, '<sup>$1</sup>');
    h = h.replace(/_\(([^()]+)\)/g, '<sub>$1</sub>').replace(/_(\d+|[A-Za-z](?![A-Za-z]))/g, '<sub>$1</sub>');
    return h;
  };
  const css = document.createElement('style');
  css.textContent = `
    sup, sub { font-size:.75em; line-height:0 }
    .frac { display:inline-flex; flex-direction:column; align-items:center; vertical-align:middle; margin:0 4px; font-size:.9em; line-height:1.2 }
    .frac > span:first-child { border-bottom:1.5px solid currentColor; padding:0 4px }
    .frac > span:last-child { padding:0 4px }
    .radic { border-top:1.5px solid currentColor; padding:0 2px }`;
  document.head.appendChild(css);
})();
