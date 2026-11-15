// Section navigation bar: links to each panel, highlights the section you are in, hides links to hidden panels.
// Plain anchor links, so it works without JavaScript too; this only adds the highlight.
//
// "The section you are in" = the last section (in page order) whose top has scrolled up to just below the
// sticky bar. Short sections such as "Area & dates" are highlighted correctly this way; a "largest visible
// section" rule would always pick the tall map instead. A clicked link is highlighted at once.

/** Index of the active section, given each section's top (px from the viewport top) and the bar's bottom. */
export function activeIndex(tops, barBottom, atPageEnd = false) {
  if (!tops.length) return -1;
  if (atPageEnd) return tops.length - 1;
  let active = 0;
  tops.forEach((top, i) => { if (top <= barBottom + 24) active = i; });
  return active;
}

export function initNav() {
  const nav = document.querySelector('.section-nav');
  if (!nav) return;
  const entries = [];
  for (const a of nav.querySelectorAll('a[href^="#"]')) {
    const target = document.querySelector(a.getAttribute('href'));
    if (!target || target.hidden) {
      a.closest('li').hidden = true; // e.g. the forecast panel when forecast.json is not published
      continue;
    }
    entries.push({ a, target });
  }
  // Page order, so "last section above the line" is well defined even if the bar lists them differently.
  entries.sort((x, y) => (x.target.compareDocumentPosition(y.target) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));

  // Links to other pages (Commander mode) carry the current area, and demo mode. Not the month: the game starts
  // on the area's busiest month, as the PRD asks.
  for (const a of nav.querySelectorAll('a[data-carry-state]')) {
    a.addEventListener('click', () => {
      const s = window.bara?.getState?.();
      if (!s) return;
      const q = new URLSearchParams({ area: s.areaId });
      if (new URLSearchParams(window.location.search).get('mock') === '1') q.set('mock', '1');
      a.href = `${a.getAttribute('href').split('?')[0]}?${q}`;
    });
  }

  let current = null;
  const setActive = (a) => {
    if (a === current) return;
    current = a;
    for (const { a: l } of entries) l.removeAttribute('aria-current');
    if (!a) return;
    a.setAttribute('aria-current', 'true');
    // keep the active link visible when the bar scrolls sideways on phones
    const box = nav.querySelector('ul');
    const r = a.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    if (r.left < b.left || r.right > b.right) box.scrollBy({ left: r.left - b.left - 16, behavior: 'auto' });
  };

  let lockUntil = 0; // after a click, keep that link while the smooth scroll runs
  const update = () => {
    if (performance.now() < lockUntil) return;
    const barBottom = nav.getBoundingClientRect().bottom;
    const tops = entries.map(({ target }) => target.getBoundingClientRect().top);
    const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
    const i = activeIndex(tops, barBottom, atEnd);
    setActive(i >= 0 ? entries[i].a : null);
  };

  for (const { a } of entries) {
    a.addEventListener('click', () => {
      setActive(a);
      lockUntil = performance.now() + 900;
      setTimeout(update, 950);
    });
  }
  let queued = false;
  const onScroll = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; update(); });
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  update();
}
