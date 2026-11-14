// Small shared UI pieces for the panels (DOM only, no data).

let count = 0;

/**
 * An "i" button that shows or hides a short plain-language explanation under the panel heading.
 * Returns { button, box }: put the button next to the heading and the box right after the header.
 */
export function infoToggle(label, html) {
  const id = `info-${++count}`;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'info-btn';
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', id);
  button.setAttribute('aria-label', label);
  button.title = label;
  button.innerHTML = '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="9.1" y="8.5" width="1.8" height="6" fill="currentColor"/><rect x="9.1" y="5.2" width="1.8" height="1.8" fill="currentColor"/></svg>';
  const box = document.createElement('div');
  box.className = 'info-box';
  box.id = id;
  box.hidden = true;
  box.innerHTML = html;
  button.addEventListener('click', () => {
    const open = box.hidden;
    box.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  });
  return { button, box };
}

/** A highlighted "What this means" box with one plain takeaway. */
export function meaningBox(text) {
  const box = document.createElement('div');
  box.className = 'meaning';
  const label = document.createElement('p');
  label.className = 'meaning-label';
  label.textContent = 'What this means';
  const p = document.createElement('p');
  p.className = 'meaning-text';
  p.textContent = text;
  box.append(label, p);
  return box;
}

/** Attach an info toggle to a panel: button after the heading, box after the panel header. */
export function addInfo(root, label, html) {
  const { button, box } = infoToggle(label, html);
  const heading = root.querySelector('.panel-heading');
  const row = document.createElement('div');
  row.className = 'heading-row';
  heading.replaceWith(row);
  row.append(heading, button);
  root.querySelector('.panel-head').after(box);
  return box;
}
