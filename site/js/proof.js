// Sensor proof (C3): raw MODIS, raw VIIRS and harmonized series for the selected area, plus the method
// comparison with independent held-out errors. Every number comes from calendar/<area>.json and harmonize.json.
// Annual view: full history, complete years only (a year counts only if all 12 months have data).
// Monthly view: the selected date range.

import { getState, subscribe } from './store.js';
import { loadCalendar, loadHarmonize, loadMeta } from './data.js';
import { MONTH_SHORT, fmtCount, monthLabel, periodLabel } from './series.js';
import { addInfo } from './ui.js';

// Drawing order matters: from VIIRS's first month the harmonized value IS the VIIRS count, so harmonized is
// drawn wide underneath and raw VIIRS thin on top, keeping both visible where they coincide.
const SERIES = [
  { key: 'rawModisCount', name: 'Older satellite (MODIS)', short: 'MODIS', css: '--series-modis', dash: '6 4', width: 2 },
  { key: 'harmonizedCount', name: 'Adjusted, used by Bara', short: 'Adjusted', css: '--series-harmonized', dash: null, width: 4.5 },
  { key: 'rawViirsCount', name: 'Newer satellite (VIIRS)', short: 'VIIRS', css: '--series-viirs', dash: null, width: 1.5 },
];
const SVG = 'http://www.w3.org/2000/svg';
let ui = null;

export async function mount(root) {
  const [meta, harm] = await Promise.all([loadMeta(), loadHarmonize()]);
  root.innerHTML = `
    <header class="panel-head">
      <div class="panel-title">
        <p class="eyebrow">Sensor proof</p>
        <h2 class="panel-heading" id="pf-title">Can we compare old and new years fairly?</h2>
      </div>
      <div class="panel-tools">
        <fieldset class="seg">
          <legend class="visually-hidden">Chart period</legend>
          <label class="seg-opt"><input type="radio" name="pf-scale" value="annual" checked><span>By year</span></label>
          <label class="seg-opt"><input type="radio" name="pf-scale" value="monthly"><span>By month</span></label>
        </fieldset>
      </div>
    </header>
    <p class="pf-purpose">In 2012 a sharper satellite took over, and it sees about <strong id="pf-ratio">4</strong> times
      more hotspots. Without an adjustment, fires would seem to jump in 2012. This panel checks that our adjusted line
      lets you compare any year with any other.</p>
    <div class="pf-result" id="pf-result"></div>
    <p class="pf-sub small-text" id="pf-sub"></p>
    <ul class="pf-legend" aria-label="Series">
      ${SERIES.map((s) => `<li><svg width="26" height="10" aria-hidden="true"><line x1="1" y1="5" x2="25" y2="5"
        stroke="var(${s.css})" stroke-width="${s.width}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''}/></svg>${s.name}</li>`).join('')}
    </ul>
    <div class="pf-chart" id="pf-chart">
      <div class="pf-tip" id="pf-tip" hidden></div>
    </div>
    <details class="pf-table">
      <summary>Show the numbers</summary>
      <div class="table-scroll" id="pf-table"></div>
    </details>
    <details class="pf-methods">
      <summary>Technical details</summary>
      <div id="pf-methods"></div>
    </details>`;
  addInfo(root, 'How to read this chart', `
    <p><strong>Dashed line</strong>: what the older satellite (MODIS) counted. It has watched since 2000 but misses small fires.</p>
    <p><strong>Thin line</strong>: what the newer satellite (VIIRS) counted. It only started in 2012 but sees much more.</p>
    <p><strong>Thick line</strong>: the adjusted numbers Bara uses. Before 2012 it is an estimate of what the newer satellite
      would have seen; from 2012 it is the newer satellite's own count.</p>
    <p>If the adjustment works, the thick line has no sudden jump in 2012, and the test year (shaded) shows how close the estimate gets.</p>`);
  ui = {
    root, meta, harm, scale: 'annual', token: 0, idx: null,
    chart: root.querySelector('#pf-chart'), tip: root.querySelector('#pf-tip'),
    sub: root.querySelector('#pf-sub'), table: root.querySelector('#pf-table'),
  };
  root.querySelectorAll('input[name="pf-scale"]').forEach((r) => r.addEventListener('change', () => {
    ui.scale = r.value;
    render();
  }));
  renderMethods(root.querySelector('#pf-methods'), harm);
  renderResult(root.querySelector('#pf-result'), harm);
  new ResizeObserver(() => draw()).observe(ui.chart);
  subscribe((s, changed) => {
    if (changed.includes('areaId') || (ui.scale === 'monthly' && changed.some((k) => k === 'startMonth' || k === 'endMonth'))) render();
  });
  await render();
}

/** Annual sums over complete years; a series' year is null unless all 12 months have a value. Exported for tests. */
export function annualSeries(cal, lastYear) {
  const first = Number(cal.months[0].slice(0, 4));
  const years = [];
  for (let y = first; y <= lastYear; y++) years.push(y);
  const out = { labels: years.map(String), keys: years.map(String) };
  for (const s of SERIES) {
    out[s.key] = years.map((y) => {
      let sum = 0;
      for (let m = 1; m <= 12; m++) {
        const i = cal.months.indexOf(`${y}-${String(m).padStart(2, '0')}`);
        if (i < 0 || cal[s.key][i] == null) return null;
        sum += cal[s.key][i];
      }
      return sum;
    });
  }
  return out;
}

function monthlySeries(cal, start, end) {
  const idx = [];
  cal.months.forEach((m, i) => { if (m >= start && m <= end) idx.push(i); });
  const out = {
    labels: idx.map((i) => `${MONTH_SHORT[Number(cal.months[i].slice(5, 7)) - 1]} ${cal.months[i].slice(0, 4)}`),
    keys: idx.map((i) => cal.months[i]),
  };
  for (const s of SERIES) out[s.key] = idx.map((i) => cal[s.key][i]);
  return out;
}

async function render() {
  const token = ++ui.token;
  const s = getState();
  const cal = await loadCalendar(s.areaId);
  if (token !== ui.token) return;
  ui.cal = cal;
  const lastYear = cal.reference.completeYears[1];
  ui.data = ui.scale === 'annual' ? annualSeries(cal, lastYear) : monthlySeries(cal, s.startMonth, s.endMonth);
  ui.firstObserved = cal.months[cal.status.indexOf('observed')] || null;
  ui.sub.textContent = ui.scale === 'annual'
    ? `${cal.name}: hotspots per year, ${cal.months[0].slice(0, 4)} to ${lastYear}.`
    : `${cal.name}: hotspots per month, ${periodLabel(s.startMonth, s.endMonth)}.`;
  const ratio = overlapRatio(cal);
  ui.root.querySelector('#pf-ratio').textContent = ratio ? String(Math.round(ratio)) : 'several';
  ui.idx = null;
  renderTable();
  draw();
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

function el(name, attrs = {}, parent) {
  const e = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  if (parent) parent.append(e);
  return e;
}

function draw() {
  if (!ui?.data) return;
  ui.chart.querySelector('svg')?.remove();
  const d = ui.data;
  const n = d.keys.length;
  const W = ui.chart.clientWidth;
  const H = Math.max(240, Math.min(340, Math.round(W * 0.42)));
  const M = { top: 16, right: W < 520 ? 12 : 92, bottom: 28, left: 52 };
  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;
  const max = niceMax(Math.max(1, ...SERIES.flatMap((s) => d[s.key].filter((v) => v != null))));
  const x = (i) => M.left + (n <= 1 ? iw / 2 : (i * iw) / (n - 1));
  const y = (v) => M.top + ih - (v / max) * ih;
  ui.geom = { x, y, M, W, H, n };

  const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'pf-svg', tabindex: '0', role: 'img' });
  svg.setAttribute('aria-label', describe());

  // Test-year band and VIIRS start rule.
  const testYear = String(ui.harm.finalTestYear);
  const testIdx = d.keys.map((k, i) => (k.startsWith(testYear) ? i : -1)).filter((i) => i >= 0);
  if (testIdx.length) {
    const half = n > 1 ? iw / (n - 1) / 2 : 10;
    const x0 = Math.max(M.left, x(testIdx[0]) - half);
    const x1 = Math.min(M.left + iw, x(testIdx.at(-1)) + half);
    el('rect', { x: x0, y: M.top, width: x1 - x0, height: ih, class: 'pf-band' }, svg);
    const t = el('text', { x: (x0 + x1) / 2, y: M.top + 12, class: 'pf-note', 'text-anchor': 'middle' }, svg);
    t.textContent = `Test ${testYear}`;
  }
  const vKey = ui.scale === 'annual' ? ui.firstObserved?.slice(0, 4) : ui.firstObserved;
  const vIdx = vKey ? d.keys.indexOf(vKey) : -1;
  if (vIdx >= 0) {
    el('line', { x1: x(vIdx), x2: x(vIdx), y1: M.top, y2: M.top + ih, class: 'pf-rule' }, svg);
    const t = el('text', { x: x(vIdx) + 4, y: M.top + 12, class: 'pf-note' }, svg);
    t.textContent = `VIIRS starts (${monthLabel(ui.firstObserved)})`;
  }

  // Grid and axes (recessive).
  for (let k = 0; k <= 4; k++) {
    const v = (max * k) / 4;
    el('line', { x1: M.left, x2: M.left + iw, y1: y(v), y2: y(v), class: k ? 'pf-grid' : 'pf-axis' }, svg);
    const t = el('text', { x: M.left - 8, y: y(v) + 4, class: 'pf-tick', 'text-anchor': 'end' }, svg);
    t.textContent = fmtCount(v);
  }
  const step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 64))));
  for (let i = 0; i < n; i += step) {
    const t = el('text', { x: x(i), y: H - 8, class: 'pf-tick', 'text-anchor': 'middle' }, svg);
    t.textContent = ui.scale === 'annual' ? d.labels[i] : d.labels[i].replace(' ', ' ’').replace(/’\d\d(\d\d)/, '’$1');
  }

  // Lines with gaps for missing values.
  const ends = [];
  for (const s of SERIES) {
    let path = '';
    let pen = false;
    let last = null;
    d[s.key].forEach((v, i) => {
      if (v == null) { pen = false; return; }
      path += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
      last = i;
    });
    if (!path) continue;
    el('path', { d: path, class: 'pf-line', stroke: `var(${s.css})`, 'stroke-width': s.width, 'stroke-dasharray': s.dash }, svg);
    if (last != null) ends.push({ s, i: last, y: y(d[s.key][last]) });
  }
  // Direct labels at line ends, nudged apart.
  if (M.right > 40) {
    ends.sort((a, b) => a.y - b.y);
    for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 14) ends[k].y = ends[k - 1].y + 14;
    for (const e of ends) {
      const t = el('text', { x: x(e.i) + 8, y: e.y + 4, class: 'pf-label' }, svg);
      t.textContent = e.s.short;
    }
  }

  // Crosshair + hover/keyboard.
  const cross = el('line', { y1: M.top, y2: M.top + ih, class: 'pf-cross', visibility: 'hidden' }, svg);
  const dots = SERIES.map((s) => el('circle', { r: 4, fill: `var(${s.css})`, class: 'pf-dot', visibility: 'hidden' }, svg));
  const hit = el('rect', { x: M.left, y: M.top, width: iw, height: ih, fill: 'transparent' }, svg);
  const show = (i) => {
    if (i == null) {
      cross.setAttribute('visibility', 'hidden');
      dots.forEach((c) => c.setAttribute('visibility', 'hidden'));
      ui.tip.hidden = true;
      return;
    }
    ui.idx = i;
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    cross.setAttribute('visibility', 'visible');
    SERIES.forEach((s, k) => {
      const v = d[s.key][i];
      dots[k].setAttribute('visibility', v == null ? 'hidden' : 'visible');
      if (v != null) { dots[k].setAttribute('cx', x(i)); dots[k].setAttribute('cy', y(v)); }
    });
    ui.tip.innerHTML = '';
    const head = document.createElement('strong');
    head.textContent = ui.scale === 'annual' ? d.labels[i] : monthLabel(d.keys[i]);
    ui.tip.append(head);
    for (const s of [...SERIES].reverse()) {
      const row = document.createElement('span');
      const v = d[s.key][i];
      row.textContent = `${s.name}: ${v == null ? 'no data' : fmtCount(v)}`;
      ui.tip.append(row);
    }
    ui.tip.hidden = false;
    const tw = ui.tip.offsetWidth;
    const left = x(i) + 12 + tw > W ? x(i) - 12 - tw : x(i) + 12;
    ui.tip.style.transform = `translate(${Math.round(left)}px, ${M.top}px)`;
  };
  const nearest = (evt) => {
    const r = svg.getBoundingClientRect();
    const px = evt.clientX - r.left;
    return Math.max(0, Math.min(n - 1, Math.round(((px - M.left) / iw) * (n - 1))));
  };
  hit.addEventListener('pointermove', (e) => show(nearest(e)));
  hit.addEventListener('pointerdown', (e) => show(nearest(e)));
  svg.addEventListener('pointerleave', () => show(null));
  svg.addEventListener('keydown', (e) => {
    const cur = ui.idx ?? n - 1;
    if (e.key === 'ArrowLeft') show(Math.max(0, cur - 1));
    else if (e.key === 'ArrowRight') show(Math.min(n - 1, cur + 1));
    else if (e.key === 'Home') show(0);
    else if (e.key === 'End') show(n - 1);
    else if (e.key === 'Escape') show(null);
    else return;
    e.preventDefault();
  });
  svg.addEventListener('blur', () => show(null));
  ui.chart.prepend(svg);
}

function describe() {
  const d = ui.data;
  const h = d.harmonizedCount;
  const ok = h.map((v, i) => [v, i]).filter(([v]) => v != null);
  if (!ok.length) return 'No data to chart.';
  const [maxV, maxI] = ok.reduce((a, b) => (b[0] > a[0] ? b : a));
  return `Line chart of raw MODIS, raw VIIRS and harmonized hotspot detections for ${ui.cal.name}. `
    + `Highest harmonized value: ${fmtCount(maxV)} in ${ui.scale === 'annual' ? d.labels[maxI] : monthLabel(d.keys[maxI])}. `
    + 'Use the left and right arrow keys to read values. The numbers are also in the table below.';
}

function renderTable() {
  const d = ui.data;
  const head = `<tr><th scope="col">${ui.scale === 'annual' ? 'Year' : 'Month'}</th>${SERIES.map((s) => `<th scope="col">${s.name}</th>`).join('')}</tr>`;
  const rows = d.keys.map((k, i) => `<tr><th scope="row">${ui.scale === 'annual' ? k : monthLabel(k)}</th>${
    SERIES.map((s) => `<td>${d[s.key][i] == null ? 'no data' : fmtCount(d[s.key][i])}</td>`).join('')}</tr>`).join('');
  ui.table.innerHTML = `<table class="data-table"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

/** VIIRS / MODIS over months both sensors fully covered, for this area. Exported for tests. */
export function overlapRatio(cal) {
  let v = 0;
  let m = 0;
  cal.months.forEach((_, i) => {
    if (cal.rawViirsCount[i] != null && cal.rawModisCount[i] != null) { v += cal.rawViirsCount[i]; m += cal.rawModisCount[i]; }
  });
  return m > 0 ? v / m : null;
}

/** The test result in everyday words. All numbers from harmonize.json. */
function renderResult(box, h) {
  const m = h.metrics;
  const raw = h.methods.find((x) => x.id === 'raw-modis')?.test;
  const parts = [`<p><strong>Tested on ${h.finalTestYear}</strong>, a year the method never saw:</p><ul>`];
  if (m.biasPct != null) {
    const b = Math.abs(m.biasPct);
    parts.push(`<li>the year's total came out within <strong>${b < 1 ? 'less than 1' : Math.round(b)}%</strong> of the real count,</li>`);
  }
  if (m.WAPE != null) parts.push(`<li>single months were off by about <strong>${Math.round(m.WAPE * 100)}%</strong> on average,</li>`);
  if (raw?.biasPct != null) parts.push(`<li>using the older satellite alone would have counted <strong>${Math.abs(Math.round(raw.biasPct))}% too ${raw.biasPct < 0 ? 'few' : 'many'}</strong>.</li>`);
  parts.push('</ul><p class="small-text">So the adjusted numbers are good for comparing years and seasons; treat a single month as approximate.</p>');
  box.innerHTML = parts.join('');
}

function pct(v) {
  return v == null ? 'not computed' : `${Math.round(v * 100)}%`;
}

function signed(v) {
  return v == null ? 'not computed' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
}

function renderMethods(box, h) {
  const v = h.validationWindow;
  const t = h.testWindow;
  const rows = h.methods.map((m) => `
    <tr${m.id === h.method ? ' class="is-chosen"' : ''}>
      <th scope="row">${m.name}${m.id === h.method ? ' <span class="tag">Chosen</span>' : ''}</th>
      <td>${pct(m.validation?.WAPE)}</td>
      <td>${pct(m.test?.WAPE)}</td>
      <td>${signed(m.test?.biasPct)}</td>
      <td>${m.test?.MAE ?? 'not computed'}</td>
    </tr>`).join('');
  const m = h.metrics;
  box.innerHTML = `
    <p class="pf-verdict small-text">Three ways of turning old MODIS counts into VIIRS terms were compared. The method
      was chosen on ${h.validationWindow[0].slice(0, 4)} to ${h.validationWindow[1].slice(0, 4)}, then scored once on
      ${h.finalTestYear}, which it never saw.</p>
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr>
          <th scope="col">Method</th>
          <th scope="col">Error, ${v[0].slice(0, 4)} to ${v[1].slice(0, 4)} (used to choose)</th>
          <th scope="col">Error, ${t[0].slice(0, 4)} (held out)</th>
          <th scope="col">Bias, ${t[0].slice(0, 4)}</th>
          <th scope="col">Average miss per month, ${t[0].slice(0, 4)}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <ul class="pf-notes small-text">
      <li>Trained on ${monthLabel(h.trainWindow[0])} to ${monthLabel(h.trainWindow[1])}; chosen by ${h.chosenOn}; scored once on ${h.finalTestYear}.</li>
      <li>Error is WAPE: ${h.metricDefinitions?.WAPE ?? 'sum of absolute errors divided by the sum of observed counts'}. Bias: ${h.metricDefinitions?.biasPct ?? ''}.</li>
      <li>Measured on ${h.evaluationUnit ?? 'division-months'} (${m.n} months in ${h.finalTestYear}, ${m.sparseMonths} of them with fewer than 5 detections), so it describes the method overall, not this area alone.</li>
      ${h.uncertainty ? `<li>Range shown for estimated months: ${h.uncertainty.lowFactor} to ${h.uncertainty.highFactor} times the estimate, the ${h.uncertainty.basis}.</li>` : ''}
    </ul>`;
}
