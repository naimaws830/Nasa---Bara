// Boots Bara (C1).
// 1. Load meta.json (fails closed on the wrong data mode).
// 2. Set the store's bounds and defaults from it, show the REAL / DEMO badge.
// 3. Mount every module. A module that is missing or throws shows "This panel failed to load"
//    in its own panel; the header, controls and other panels keep working.
// 4. Mount M-03 replay beneath the existing map after the normal panels have settled.

import { configure, getState, setState, subscribe } from './store.js';
import { isMock, loadMeta } from './data.js';

const MODULES = [
  { path: './controls.js', selector: '#controls' },
  { path: './map.js', selector: '#map' },
  { path: './status.js', selector: '#status' },
  { path: './calendar.js', selector: '#calendar' },
  { path: './forecast.js', selector: '#forecast' },
  { path: './proof.js', selector: '#proof' },
  { path: './export.js', selector: '#export' },
];

const DEBUG = isMock || new URLSearchParams(window.location.search).get('debug') === '1';

boot();

async function boot() {
  window.bara = { getState, setState, subscribe };
  if (DEBUG) {
    window.getState = getState;
    window.setState = setState;
  }

  let meta;
  try {
    meta = await loadMeta();
  } catch (err) {
    console.error(`[Bara] ${err.message}`);
    showAppError(err.message);
    return;
  }

  configure({ areaIds: meta.areas.map((a) => a.id), start: meta.coverage.start, end: meta.lastCompleteMonth });
  setState({
    areaId: meta.defaultArea,
    startMonth: meta.coverage.start,
    endMonth: meta.lastCompleteMonth,
    selectedMonth: meta.lastCompleteMonth,
  });
  showBadge(meta);
  if (DEBUG) console.info('[Bara] Try setState({ selectedMonth: "2015-09" }) in the console.');

  await Promise.allSettled(MODULES.map(mountModule));
<<<<<<< HEAD
  try {
    (await import('./nav.js')).initNav();
  } catch (err) {
    console.warn('[Bara] navigation bar failed:', err);
=======
  await mountReplay();
}

// Replay only appends its own controls; never replaces the already mounted map.
// A replay failure is isolated so the rest of Bara remains usable.
async function mountReplay() {
  const root = document.querySelector('#map');
  if (!root || root.dataset.mounted !== 'true') return;
  try {
    const { mount } = await import('./map/replay.js');
    if (typeof mount !== 'function') throw new Error('Replay module does not export mount(rootElement)');
    await mount(root);
  } catch (err) {
    console.warn('[Bara] Historical replay failed to load:', err);
    const note = document.createElement('p');
    note.className = 'panel-error';
    note.textContent = 'Historical replay is unavailable; the map still works.';
    root.append(note);
>>>>>>> origin/feature/raccocoon-m03-replay
  }
}

function showBadge(meta) {
  const badge = document.getElementById('mode-badge');
  const label = document.createElement('strong');
  const text = document.createElement('span');
  if (meta.mode === 'real') {
    label.textContent = 'REAL';
    text.textContent = `NASA FIRMS data, ${meta.coverage.start} to ${meta.lastCompleteMonth}`;
  } else {
    label.textContent = 'DEMO';
    text.textContent = 'Synthetic data for testing, not NASA observations';
  }
  badge.dataset.mode = meta.mode;
  badge.replaceChildren(label, text);
  badge.hidden = false;
}

function showAppError(message) {
  const box = document.getElementById('app-error');
  const main = document.createElement('p');
  main.textContent = `Bara could not load its data. ${message}`;
  const hint = document.createElement('p');
  hint.textContent = isMock
    ? 'Demo data is made with: python pipeline/make_mock.py'
    : 'Real data is made with the pipeline (see docs/methodology.md). To try the app with demo data, add ?mock=1 to the address.';
  box.replaceChildren(main, hint);
  box.hidden = false;

  for (const { selector } of MODULES) {
    const root = document.querySelector(selector);
    if (!root) continue;
    const p = document.createElement('p');
    p.className = 'panel-placeholder';
    p.textContent = 'No data to show.';
    root.replaceChildren(p);
  }
}

async function mountModule({ path, selector }) {
  const root = document.querySelector(selector);
  if (!root) {
    console.error(`[Bara] Mount point ${selector} is missing from index.html; ${path} was not loaded.`);
    return;
  }
  try {
    const mod = await import(path);
    if (typeof mod.mount !== 'function') throw new Error(`${path} does not export mount(rootElement)`);
    root.replaceChildren();
    await mod.mount(root);
    root.dataset.mounted = 'true';
  } catch (err) {
    const msg = document.createElement('p');
    msg.className = 'panel-error';
    msg.textContent = 'This panel failed to load.';
    root.replaceChildren(msg);
    if (DEBUG) {
      const detail = document.createElement('p');
      detail.className = 'panel-error-detail';
      detail.textContent = `js/${path.slice(2)}: ${err.message}`;
      root.append(detail);
    }
    root.dataset.mounted = 'failed';
    console.warn(`[Bara] ${path} failed to load:`, err);
  }
}
