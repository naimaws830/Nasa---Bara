// Section navigation bar: links to each panel, highlights the section in view, hides links to hidden panels.
// Plain anchor links, so it works without JavaScript too; this only adds the highlight.

export function initNav() {
  const nav = document.querySelector('.section-nav');
  if (!nav) return;
  const links = [...nav.querySelectorAll('a[href^="#"]')];
  const targets = new Map();
  for (const a of links) {
    const target = document.querySelector(a.getAttribute('href'));
    if (!target || target.hidden) {
      a.closest('li').hidden = true; // e.g. the outlook panel when forecast.json is not published
      continue;
    }
    targets.set(target, a);
  }

  const setActive = (a) => {
    for (const l of links) l.removeAttribute('aria-current');
    if (a) {
      a.setAttribute('aria-current', 'true');
      // keep the active link visible when the bar scrolls sideways on phones
      const box = nav.querySelector('ul');
      const r = a.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      if (r.left < b.left || r.right > b.right) box.scrollBy({ left: r.left - b.left - 16, behavior: 'auto' });
    }
  };

  if (!('IntersectionObserver' in window)) return;
  const visible = new Map();
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) visible.set(e.target, e.isIntersecting ? e.intersectionRect.height : 0);
    let best = null;
    let bestH = 0;
    for (const [t, h] of visible) if (h > bestH) { best = t; bestH = h; }
    setActive(best ? targets.get(best) : null);
  }, { rootMargin: '-56px 0px -35% 0px', threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] });
  for (const t of targets.keys()) io.observe(t);
}
