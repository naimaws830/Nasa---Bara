// Next-month outlook and rainfall (C-05). Reads forecast.json and rain.json (optional: the panel hides when
// they are absent) and calendar/<area>.json. Every number comes from those files.
// It estimates HOTSPOTS for the coming month. It is not a rain, weather or haze forecast.

import { getState, subscribe } from './store.js';
import { loadCalendar, loadForecast, loadMeta, loadRain } from './data.js';
import {
  MONTH_NAMES, MONTH_SHORT, fireSeason, fmtCount, levelOf, meaningOfNext, meaningOfRainYear, monthLabel,
} from './series.js';
import { addInfo, meaningBox } from './ui.js';

export const METMALAYSIA_URL = 'https://www.met.gov.my/en/';
const SVG = 'http://www.w3.org/2000/svg';
let ui = null;

/** Area the outlook is made for: districts use their division (too few hotspots on their own). */
export function outlookArea(meta, forecast, areaId) {
  if (forecast.areas[areaId]) return { id: areaId, viaDivision: false };
  const a = meta.areas.find((x) => x.id === areaId);
  if (a?.division && forecast.areas[a.division]) return { id: a.division, viaDivision: true };
  return { id: 'sarawak', viaDivision: true };
}

/** What the panel shows as the headline: the model only where it won the test, else the typical month. */
export function headline(o) {
  const src = o.show === 'model' ? o : o.typical;
  return { expected: src.expected, low: src.low, high: src.high, fromModel: o.show === 'model' };
}

/** Everyday sentences for the headline. Exported for tests. */
export function outlookSentences({ target, area, h, o }) {
  const tName = MONTH_NAMES[Number(target.slice(5, 7)) - 1];
  const n = Math.round(h.expected);
  const out = [
    `In ${monthLabel(target)}, expect about ${fmtCount(h.expected)} hotspot${n === 1 ? '' : 's'} in ${area}.`,
    `Most likely somewhere between ${fmtCount(h.low)} and ${fmtCount(h.high)}.`,
  ];
  if (h.fromModel) {
    const lvl = levelOf(o.expected, o.typical.expected);
    const say = { lower: 'fewer than', normal: 'about the same as', higher: 'more than', much: 'well above' }[lvl?.key];
    if (say) out.push(`That is ${say} recent ${tName}s.`);
  } else {
    out.push(`That is what recent ${tName}s looked like.`);
  }
  const p = o.rainLast2Pct;
  if (p != null) {
    out.push(Math.abs(p) < 10 ? 'The last two months had about normal rain.'
      : p < 0 ? `The last two months were drier than normal (about ${Math.round(-p)}% less rain).`
        : `The last two months were wetter than normal (about ${Math.round(p)}% more rain).`);
  }
  return out;
}

export async function mount(root) {
  const [meta, forecast, rain] = await Promise.all([loadMeta(), loadForecast(), loadRain()]);
  if (!forecast) {
    root.hidden = true; // extra feature: no file, no panel, no gap
    root.closest('.layout')?.classList.add('no-forecast');
    return;
  }
  const target = forecast.target;
  const tName = MONTH_NAMES[Number(target.slice(5, 7)) - 1];
  root.innerHTML = `
    <header class="panel-head">
      <div class="panel-title">
        <p class="eyebrow">Next month</p>
        <h2 class="panel-heading">What to expect in ${monthLabel(target)}</h2>
      </div>
    </header>
    <div class="fc-grid">
      <section class="fc-main" id="fc-main" aria-live="polite"></section>
      <section class="fc-scen" id="fc-scen" aria-label="How rain could change this"></section>
    </div>
    <section class="fc-chart-wrap">
      <h3 class="st-subhead" id="fc-chart-title"></h3>
      <div id="fc-chart-meaning"></div>
      <p class="small-text fc-chart-sub">How to read it: red line = hotspots each month. Bars: rain that month (the black tick is a normal
        amount). <strong>Orange bars are dry months</strong>, and dry months often come with more hotspots.</p>
      <ul class="pf-legend" aria-label="Chart key">
        <li><svg width="22" height="10" aria-hidden="true"><line x1="1" y1="5" x2="21" y2="5" class="fc-line"/></svg>Hotspots</li>
        <li><svg width="12" height="12" aria-hidden="true"><rect width="12" height="12" class="fc-bar"/></svg>Rain</li>
        <li><svg width="12" height="12" aria-hidden="true"><rect width="12" height="12" class="fc-bar fc-bar-dry"/></svg>Dry month</li>
        <li><svg width="16" height="10" aria-hidden="true"><line x1="0" y1="5" x2="16" y2="5" class="fc-normal"/></svg>Normal rain</li>
      </ul>
      <div class="fc-chart" id="fc-chart"><div class="pf-tip" id="fc-tip" hidden></div></div>
      <details class="pf-table">
        <summary>Show the numbers</summary>
        <div class="table-scroll" id="fc-table"></div>
      </details>
    </section>
    <details class="pf-methods fc-more">
      <summary>How accurate is this?</summary>
      <div id="fc-test"></div>
    </details>`;
  addInfo(root, 'What is this?', `
    <p>An estimate of how many <strong>hotspots</strong> (spots of fire heat seen from space) to expect next month,
      worked out from past years.</p>
    <p>It is <strong>not</strong> a weather or haze forecast. For rain in the coming days, see
      <a href="${METMALAYSIA_URL}" target="_blank" rel="noopener">MetMalaysia</a>; for today's haze, see APIMS.</p>
    <p>Rain matters: when it rains less, land dries out and fires start and spread more easily. Since nobody knows
      next month's rain yet, Bara shows what usually happens if it turns out drier, normal or wetter.</p>
    <p>Districts have too few hotspots for their own estimate, so they use their division's.</p>`);
  ui = {
    root, meta, forecast, rain, target, tName, token: 0,
    main: root.querySelector('#fc-main'), scen: root.querySelector('#fc-scen'),
    chart: root.querySelector('#fc-chart'), tip: root.querySelector('#fc-tip'), table: root.querySelector('#fc-table'),
    chartTitle: root.querySelector('#fc-chart-title'), test: root.querySelector('#fc-test'),
    chartMeaning: root.querySelector('#fc-chart-meaning'),
  };
  new ResizeObserver(() => drawChart()).observe(ui.chart);
  subscribe((s, changed) => {
    if (changed.includes('areaId')) render();
    else if (changed.includes('selectedMonth')) renderChart();
  });
  await render();
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

async function render() {
  const s = getState();
  const { forecast, meta, tName, target } = ui;
  const area = outlookArea(meta, forecast, s.areaId);
  const o = forecast.areas[area.id];
  const name = meta.areas.find((a) => a.id === area.id)?.name ?? area.id;
  const picked = meta.areas.find((a) => a.id === s.areaId)?.name ?? s.areaId;
  ui.outlookId = area.id;
  ui.outlookName = name;
  const h = headline(o);

  // 1. Plain summary and the number.
  const main = [];
  const plain = el('div', 'st-plain');
  for (const line of outlookSentences({ target, area: name, h, o })) plain.append(el('p', null, line));
  main.push(plain);
  const ocal = await loadCalendar(area.id);
  const peakMedian = Math.max(0, ...(fireSeason(ocal, { minPeak: 0 })?.medians ?? [0]));
  main.push(meaningBox(meaningOfNext({
    area: name, monthName: tName, expected: h.expected, peakMedian,
    dryExpected: o.scenarios.dry.expected, rainMattered: o.rainMattered,
  })));
  const hero = el('div', 'st-hero');
  hero.append(el('p', 'big-number st-number', fmtCount(h.expected)),
    el('p', 'st-unit', `hotspot${Math.round(h.expected) === 1 ? '' : 's'} expected (${fmtCount(h.low)} to ${fmtCount(h.high)})`));
  main.push(hero);
  if (area.viaDivision) main.push(el('p', 'small-text fc-note', `${picked} is too small for its own estimate, so this is for ${name}.`));
  ui.main.replaceChildren(...main);

  // 2. Rain can change this.
  const scen = [el('h3', 'st-subhead', 'Rain can change this')];
  const max = Math.max(o.scenarios.dry.expected, o.scenarios.normal.expected, o.scenarios.wet.expected, 1);
  const list = el('ul', 'fc-scen-list');
  const rows = [
    ['dry', `If ${tName} is drier than usual`],
    ['normal', `If ${tName} has normal rain`],
    ['wet', `If ${tName} is wetter than usual`],
  ];
  for (const [key, label] of rows) {
    const sc = o.scenarios[key];
    const li = el('li', `fc-scen-${key}`);
    const bar = el('span', 'fc-scen-bar');
    const fill = el('span', 'fc-scen-fill');
    fill.style.width = `${Math.max(3, (sc.expected / max) * 100)}%`;
    bar.append(fill);
    const val = el('span', 'fc-scen-val', `about ${fmtCount(sc.expected)}`);
    const pct = Math.round(((sc.factor ?? 1) - 1) * 100);
    if (key !== 'normal' && pct !== 0) {
      val.append(el('span', 'fc-scen-pct', ` (${Math.abs(pct)}% ${pct > 0 ? 'more' : 'fewer'})`));
    }
    li.append(el('span', 'fc-scen-label', label), bar, val);
    list.append(li);
  }
  scen.push(list);
  scen.push(el('p', 'small-text', o.rainMattered
    ? 'Less rain dries the land, so fires start and spread more easily.'
    : `In past ${tName}s, rain made little difference here.`));
  const p = el('p', 'small-text');
  const a = el('a', null, 'MetMalaysia');
  a.href = METMALAYSIA_URL;
  a.target = '_blank';
  a.rel = 'noopener';
  p.append('Want to know if rain is coming? Check ', a, '.');
  scen.push(p);
  ui.scen.replaceChildren(...scen);

  // 3. Accuracy and the technical details, folded away.
  const ev = o.evaluation;
  const shown = Math.round((h.fromModel ? ev.model.WAPE : ev.typicalMonth.WAPE) * 100);
  const other = Math.round((h.fromModel ? ev.typicalMonth.WAPE : ev.model.WAPE) * 100);
  const yrs = o.typical.years;
  const t = ui.test;
  t.replaceChildren();
  t.append(
    el('p', null, `Treat this as a rough guide. We tested it on ${ev.testYear} without letting it see ${ev.testYear}: on a typical month it was off by about ${shown}%. Monthly numbers here are small, so they jump around.`),
    el('p', null, h.fromModel
      ? `This number comes from a model that uses the usual ${tName} pattern, the long-term trend (fewer hotspots than 10 years ago) and last month's count. In the test it did better than simply averaging recent years (${other}% off).`
      : `This number is the average of ${tName} in ${yrs[0]} to ${yrs[1]}. Bara also has a model, but in the test it did worse (${other}% off), so Bara shows the simple average instead.`),
    el('p', null, `Rain in the two months before did not make the estimate more accurate. Rain during ${tName} itself matters a lot, which is why the drier / normal / wetter rows are shown.`),
    el('p', 'small-text', `Drier, normal and wetter mean about ${fmtCount(o.scenarios.dry.rainMm)}, ${fmtCount(o.scenarios.normal.rainMm)} and ${fmtCount(o.scenarios.wet.rainMm)} mm of rain in ${tName}, from 25 years of records. Rain data: ${forecast.rainSource.name} (${forecast.rainSource.basis}), up to ${monthLabel(forecast.basedOn)}.`),
  );

  await renderChart();
}

// ---------- rain + hotspots chart (two stacked charts, one month axis) ----------

/** Monthly rows for one area and year. Exported for tests. */
export function yearRows(cal, rain, areaId, year) {
  const r = rain?.areas?.[areaId];
  return MONTH_SHORT.map((label, k) => {
    const m = `${year}-${String(k + 1).padStart(2, '0')}`;
    const ci = cal.months.indexOf(m);
    const ri = rain ? rain.months.indexOf(m) : -1;
    const mm = ri >= 0 && r ? r.rainMm[ri] : null;
    const normal = r ? r.normalMm[k] : null;
    return {
      month: m, label,
      hotspots: ci >= 0 ? cal.harmonizedCount[ci] : null,
      rainMm: mm,
      normalMm: normal,
      pct: mm != null && normal ? Math.round((mm / normal) * 100) : null,
    };
  });
}

async function renderChart() {
  const token = ++ui.token;
  const s = getState();
  const year = Number(s.selectedMonth.slice(0, 4));
  const cal = await loadCalendar(ui.outlookId);
  if (token !== ui.token) return;
  ui.rows = yearRows(cal, ui.rain, ui.outlookId, year);
  ui.chartTitle.textContent = `Rain and hotspots, month by month: ${year}, ${ui.outlookName}`;
  ui.chartMeaning.replaceChildren(meaningBox(meaningOfRainYear(ui.rows, year)));
  ui.table.innerHTML = `<table class="data-table"><thead><tr><th scope="col">Month</th><th scope="col">Hotspots</th>
    <th scope="col">Rain (mm)</th><th scope="col">Normal rain (mm)</th><th scope="col">Rain vs normal</th></tr></thead><tbody>${
  ui.rows.map((r) => `<tr><th scope="row">${monthLabel(r.month)}</th><td>${fmtCount(r.hotspots) ?? 'no data'}</td>
    <td>${fmtCount(r.rainMm) ?? 'no data'}</td><td>${fmtCount(r.normalMm) ?? '-'}</td><td>${r.pct == null ? '-' : `${r.pct}%`}</td></tr>`).join('')}
    </tbody></table>`;
  drawChart();
}

function svgEl(name, attrs, parent) {
  const e = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  if (parent) parent.append(e);
  return e;
}

function nice(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function drawChart() {
  if (!ui?.rows) return;
  ui.chart.querySelector('svg')?.remove();
  const rows = ui.rows;
  const W = ui.chart.clientWidth;
  const M = { left: 52, right: 12 };
  const top = { y: 14, h: 110 };
  const bottom = { y: 160, h: 90 };
  const H = 280;
  const iw = W - M.left - M.right;
  const step = iw / 12;
  const x = (k) => M.left + step * (k + 0.5);
  const hMax = nice(Math.max(1, ...rows.map((r) => r.hotspots ?? 0)));
  const rMax = nice(Math.max(1, ...rows.flatMap((r) => [r.rainMm ?? 0, r.normalMm ?? 0])));
  const yh = (v) => top.y + top.h - (v / hMax) * top.h;
  const yr = (v) => bottom.y + bottom.h - (v / rMax) * bottom.h;

  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'pf-svg', tabindex: '0', role: 'img' });
  svg.setAttribute('aria-label', `Two charts for ${ui.chartTitle.textContent}: hotspots per month on top, rainfall per month below. Use left and right arrow keys to read each month; the numbers are also in the table.`);
  // Axes and labels.
  for (const [y0, h, max, label] of [[top.y, top.h, hMax, 'Hotspots'], [bottom.y, bottom.h, rMax, 'Rain, mm']]) {
    for (const f of [0, 0.5, 1]) {
      const yy = y0 + h - f * h;
      svgEl('line', { x1: M.left, x2: M.left + iw, y1: yy, y2: yy, class: f ? 'pf-grid' : 'pf-axis' }, svg);
      const t = svgEl('text', { x: M.left - 8, y: yy + 4, class: 'pf-tick', 'text-anchor': 'end' }, svg);
      t.textContent = fmtCount(max * f);
    }
    const t = svgEl('text', { x: M.left, y: y0 - 4, class: 'pf-note' }, svg);
    t.textContent = label;
  }
  rows.forEach((r, k) => {
    const t = svgEl('text', { x: x(k), y: H - 6, class: 'pf-tick', 'text-anchor': 'middle' }, svg);
    t.textContent = W < 420 ? r.label[0] : r.label;
  });
  // Rain bars with normal ticks.
  const bw = Math.max(4, step * 0.6);
  rows.forEach((r, k) => {
    if (r.rainMm != null) {
      svgEl('rect', { x: x(k) - bw / 2, y: yr(r.rainMm), width: bw, height: bottom.y + bottom.h - yr(r.rainMm),
        class: r.pct != null && r.pct < 75 ? 'fc-bar fc-bar-dry' : 'fc-bar' }, svg);
    }
    if (r.normalMm != null) {
      svgEl('line', { x1: x(k) - bw / 2 - 3, x2: x(k) + bw / 2 + 3, y1: yr(r.normalMm), y2: yr(r.normalMm), class: 'fc-normal' }, svg);
    }
  });
  // Hotspot line.
  let d = '';
  let pen = false;
  rows.forEach((r, k) => {
    if (r.hotspots == null) { pen = false; return; }
    d += `${pen ? 'L' : 'M'}${x(k).toFixed(1)},${yh(r.hotspots).toFixed(1)}`;
    pen = true;
  });
  if (d) svgEl('path', { d, class: 'fc-line' }, svg);
  rows.forEach((r, k) => { if (r.hotspots != null) svgEl('circle', { cx: x(k), cy: yh(r.hotspots), r: 3, class: 'fc-pt' }, svg); });

  // Hover / keyboard.
  const cross = svgEl('rect', { y: top.y, height: bottom.y + bottom.h - top.y, width: step, class: 'fc-hover', visibility: 'hidden' }, svg);
  const show = (k) => {
    if (k == null) { cross.setAttribute('visibility', 'hidden'); ui.tip.hidden = true; return; }
    ui.idx = k;
    const r = rows[k];
    cross.setAttribute('x', M.left + step * k);
    cross.setAttribute('visibility', 'visible');
    ui.tip.innerHTML = '';
    for (const [tag, text] of [['strong', monthLabel(r.month)], ['span', `Hotspots: ${fmtCount(r.hotspots) ?? 'no data'}`],
      ['span', `Rain: ${r.rainMm == null ? 'no data' : `${fmtCount(r.rainMm)} mm`}`],
      ['span', r.pct == null ? '' : `${r.pct}% of a normal ${MONTH_NAMES[k]}`]]) {
      if (text) { const e = document.createElement(tag); e.textContent = text; ui.tip.append(e); }
    }
    ui.tip.hidden = false;
    const tw = ui.tip.offsetWidth;
    const left = x(k) + step / 2 + 8 + tw > W ? x(k) - step / 2 - 8 - tw : x(k) + step / 2 + 8;
    ui.tip.style.transform = `translate(${Math.round(Math.max(0, left))}px, ${top.y}px)`;
  };
  svgEl('rect', { x: M.left, y: top.y, width: iw, height: bottom.y + bottom.h - top.y, fill: 'transparent' }, svg)
    .addEventListener('pointermove', (e) => {
      const rect = svg.getBoundingClientRect();
      show(Math.max(0, Math.min(11, Math.floor((e.clientX - rect.left - M.left) / step))));
    });
  svg.addEventListener('pointerleave', () => show(null));
  svg.addEventListener('blur', () => show(null));
  svg.addEventListener('keydown', (e) => {
    const cur = ui.idx ?? 0;
    if (e.key === 'ArrowLeft') show(Math.max(0, cur - 1));
    else if (e.key === 'ArrowRight') show(Math.min(11, cur + 1));
    else if (e.key === 'Escape') show(null);
    else return;
    e.preventDefault();
  });
  ui.chart.prepend(svg);
}
