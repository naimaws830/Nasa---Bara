// Bara M-03: monthly historical replay.
// Mount with mount(mapRoot). Appends controls beneath the map's existing content;
// does NOT replace the map. This module intentionally changes no other source files.
// The live C1 contract uses selectedMonth and loadMap(year), not the older PRD's
// year/month and loadGrid(year). Never write unknown store keys.
import { loadMeta, loadMap } from '../data.js';
import { getState, setState, subscribe } from '../store.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const styleId = 'bara-replay-styles';
let serial = 0;

function label(ym) {
  return `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
}
function monthIndex(ym) {
  return Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
}
function monthAt(index) {
  const year = Math.floor(index / 12);
  return `${year}-${String(index % 12 + 1).padStart(2, '0')}`;
}
function injectStyles() {
  if (document.getElementById(styleId)) return;
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    .bara-replay { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--haze-deep);
      color: var(--peat); font-family: var(--font-body, Archivo, sans-serif); }
    .bara-replay-controls { display:flex; flex-wrap:wrap; align-items:end; gap:12px; }
    .bara-replay label { display:flex; flex-direction:column; gap:4px; font-size:13px; color:var(--peat-soft); }
    .bara-replay button, .bara-replay select { min-height:40px; border-radius:4px; border:1px solid var(--blackwater);
      background:var(--haze); color:var(--peat); font:inherit; padding:7px 12px; }
    .bara-replay button { background:var(--blackwater); color:var(--haze); cursor:pointer; }
    .bara-replay input[type=range] { width:min(100%, 420px); min-width:155px; accent-color:var(--blackwater); }
    .bara-replay .bara-replay-slider { flex:1 1 250px; }
    .bara-replay output { color:var(--peat); font-weight:600; font-variant-numeric:tabular-nums; }
    .bara-replay button:focus-visible, .bara-replay select:focus-visible,
    .bara-replay input:focus-visible { outline:2px solid var(--blackwater); outline-offset:2px; }
    .bara-replay button:disabled, .bara-replay select:disabled, .bara-replay input:disabled { opacity:.65; cursor:wait; }
    .bara-replay-status { margin:10px 0 0; font-size:13px; color:var(--peat-soft); }
  `;
  document.head.append(style);
}

/** Mount replay controls under the existing map; returns cleanup function. */
export async function mount(root) {
  if (!(root instanceof Element)) throw new TypeError('Replay mount(root) needs a DOM element.');
  if (root._baraReplayCleanup) root._baraReplayCleanup();
  injectStyles();
  const meta = await loadMeta();
  const start = monthIndex(meta.coverage.start);
  const last = monthIndex(meta.lastCompleteMonth);
  if (last < start) throw new Error('Replay coverage has no complete months.');
  const years = Array.from({ length: Math.floor(last / 12) - Math.floor(start / 12) + 1 },
    (_, i) => Math.floor(start / 12) + i);
  const id = `bara-replay-${++serial}`;
  const wrap = document.createElement('section');
  wrap.className = 'bara-replay';
  wrap.setAttribute('aria-label', 'Historical hotspot replay');
  wrap.innerHTML = `
    <div class="bara-replay-controls">
      <button type="button" data-replay-play>Play replay</button>
      <label class="bara-replay-slider" for="${id}-month">Replay month
        <input id="${id}-month" type="range" min="${start}" max="${last}" step="1"
          value="${Math.max(start, Math.min(last, monthIndex(getState().selectedMonth)))}">
        <output for="${id}-month" id="${id}-value"></output>
      </label>
      <label for="${id}-speed">Replay speed
        <select id="${id}-speed">
          <option value="1">1 month per second</option>
          <option value="2">2 months per second</option>
          <option value="4">4 months per second</option>
        </select>
      </label>
    </div>
    <p class="bara-replay-status" role="status" aria-live="polite"></p>`;
  root.append(wrap);
  const playBtn = wrap.querySelector('[data-replay-play]');
  const slider = wrap.querySelector('input');
  const output = wrap.querySelector('output');
  const speed = wrap.querySelector('select');
  const status = wrap.querySelector('[role=status]');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let timeline = null;
  let gsap = null;
  let preloadPromise = null;
  let preloadDone = false;
  let preparing = false;
  let mounted = true;
  let ownUpdate = false;
  let generation = 0;

  function showMonth(ym) {
    slider.value = String(Math.max(start, Math.min(last, monthIndex(ym))));
    output.value = label(ym);
    output.textContent = label(ym);
  }
  showMonth(getState().selectedMonth);

  function publish(ym) {
    ownUpdate = true;
    try { setState({ selectedMonth: ym, playing: true }); }
    finally { ownUpdate = false; }
    showMonth(ym);
  }
  function stop(message = '') {
    ++generation;
    preparing = false;
    timeline?.kill();
    timeline = null;
    playBtn.textContent = 'Play replay';
    ownUpdate = true;
    try { if (getState().playing) setState({ playing: false }); }
    finally { ownUpdate = false; }
    if (message) status.textContent = message;
  }

  async function preload() {
    if (preloadDone) return;
    if (preloadPromise) return preloadPromise;
    const count = years.length;
    let loaded = 0;
    status.textContent = `Loading ${count} years of data: 0 of ${count}`;
    playBtn.disabled = true;
    slider.disabled = true;
    speed.disabled = true;
    preloadPromise = (async () => {
      // Bound concurrency: 3 map datasets at a time; data.js retains one cached Promise per year.
      let next = 0;
      async function worker() {
        while (mounted && next < years.length) {
          const year = years[next++];
          await loadMap(year);
          loaded++;
          if (mounted) status.textContent = `Loading ${count} years of data: ${loaded} of ${count}`;
        }
      }
      await Promise.all(Array.from({ length: Math.min(3, count) }, () => worker()));
      if (!mounted) return;
      preloadDone = true;
      status.textContent = `Ready: ${count} years of observed hotspot data loaded.`;
    })();
    try { await preloadPromise; }
    catch (error) {
      preloadPromise = null;
      if (mounted) status.textContent = `Could not load replay data: ${error.message}. Press Play replay to retry.`;
      throw error;
    } finally {
      if (mounted) { playBtn.disabled = false; slider.disabled = false; speed.disabled = false; }
    }
  }

  async function play() {
    if (!mounted || timeline) return;
    const token = ++generation;
    preparing = true;
    try {
      await preload();
      if (!mounted || token !== generation) return;
      // The import map already pins GSAP 3.12.5; no new CDN or external dependency.
      if (!gsap) {
        const module = await import('gsap');
        gsap = module.gsap || module.default?.gsap || module.default;
        if (!gsap?.timeline) throw new Error('GSAP timeline is unavailable.');
      }
      if (!mounted || token !== generation) return;
      preparing = false;
      const motionReduced = reduced.matches;
      const interval = motionReduced ? 1 : 1 / Number(speed.value);
      const current = Math.max(start, Math.min(last, monthIndex(getState().selectedMonth)));
      const from = current >= last ? start : current;
      if (from !== current) showMonth(monthAt(from));
      publish(monthAt(from));
      playBtn.textContent = 'Pause';
      status.textContent = motionReduced
        ? 'Replay running at one month per second, with reduced motion.'
        : `Replay running at ${speed.value} month${speed.value === '1' ? '' : 's'} per second.`;
      // A single timeline only schedules state changes; map owns drawing its reusable geometry.
      // Endpoints are not pre-rendered into separate 3D objects (constant scene memory).
      timeline = gsap.timeline({ paused: true, onComplete: () => stop('Replay complete.') });
      for (let index = from + 1, step = 1; index <= last; index++, step++) {
        const month = monthAt(index);
        timeline.call(() => publish(month), [], step * interval);
      }
      if (from === last) { stop('Replay complete.'); return; }
      timeline.play(0);
    } catch (error) {
      if (mounted && token === generation) stop(`Replay could not start: ${error.message}`);
    }
  }

  playBtn.addEventListener('click', () => {
    if (timeline || preparing || getState().playing) stop('Replay paused.');
    else void play();
  });
  slider.addEventListener('input', () => {
    stop(); // moving the slider pauses the replay quietly
    status.textContent = '';
    setState({ selectedMonth: monthAt(Number(slider.value)) });
  });
  speed.addEventListener('change', () => {
    if (timeline || getState().playing) stop('Replay paused after changing the speed.');
  });
  wrap.addEventListener('keydown', (event) => {
    if (event.code !== 'Space' || event.repeat) return;
    // Do not steal native Space behavior from the button/select or slider.
    if (event.target === playBtn) return;
    event.preventDefault();
    if (timeline || preparing || getState().playing) stop('Replay paused.');
    else void play();
  });
  const onVisibility = () => {
    if (document.hidden && (timeline || getState().playing)) stop('Replay paused because the tab is hidden.');
  };
  document.addEventListener('visibilitychange', onVisibility);
  const onMotion = () => {
    if (timeline || getState().playing) stop('Replay paused after motion preference changed.');
  };
  reduced.addEventListener?.('change', onMotion);
  const unsubscribe = subscribe((state, changed) => {
    if (!mounted || ownUpdate) return;
    if (changed.includes('selectedMonth')) {
      showMonth(state.selectedMonth);
      if (timeline || preparing || state.playing) {
        stop(); // a month picked elsewhere pauses the replay quietly
        status.textContent = '';
      }
    }
    if (changed.some(k => ['areaId', 'sensorView', 'startMonth', 'endMonth'].includes(k))) {
      if (timeline || preparing || state.playing) stop('Replay paused after changing another control.');
    }
    if (changed.includes('playing') && !state.playing && timeline) stop('Replay paused.');
  });
  const cleanup = () => {
    mounted = false;
    stop();
    unsubscribe();
    document.removeEventListener('visibilitychange', onVisibility);
    reduced.removeEventListener?.('change', onMotion);
    wrap.remove();
    if (root._baraReplayCleanup === cleanup) delete root._baraReplayCleanup;
  };
  root._baraReplayCleanup = cleanup;
  return cleanup;
}
