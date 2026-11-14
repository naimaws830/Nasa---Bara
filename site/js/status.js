// Selected month vs normal (C2). Every number comes from calendar/<area>.json or harmonize.json.
// Comparisons always use the harmonized series (the one the seasonal median and anomaly score describe).
// Wording is descriptive history, never an emergency warning or a forecast.

import { getState, setState, subscribe } from './store.js';
import { loadCalendar, loadHarmonize, loadMeta } from './data.js';
import {
  VIEW_NAME, anomalyText, busiestYear, compareText, estimateRange, fmtCount, isProvisional, monthLabel,
  monthName, monthsInRange, periodLabel, referenceText,
} from './series.js';

let ui = null;

export async function mount(root) {
  const [meta, harm] = await Promise.all([loadMeta(), loadHarmonize().catch(() => null)]);
  root.innerHTML = `
    <header class="panel-head">
      <div class="panel-title">
        <p class="eyebrow">Selected month</p>
        <h2 class="panel-heading" id="st-title"></h2>
      </div>
    </header>
    <div id="st-body"></div>`;
  ui = { root, meta, harm, title: root.querySelector('#st-title'), body: root.querySelector('#st-body'), token: 0 };
  subscribe((s, changed) => {
    if (changed.some((k) => ['areaId', 'selectedMonth', 'startMonth', 'endMonth', 'sensorView'].includes(k))) render();
  });
  await render();
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function currentMonthOf(iso) {
  return iso.slice(0, 7);
}

async function render() {
  const token = ++ui.token;
  const s = getState();
  let cal;
  try {
    cal = await loadCalendar(s.areaId);
  } catch (err) {
    ui.body.textContent = `Could not load this area: ${err.message}`;
    return;
  }
  if (token !== ui.token) return;
  const { meta, harm } = ui;
  const m = s.selectedMonth;
  const i = cal.months.indexOf(m);
  ui.title.textContent = `${monthLabel(m)}, ${cal.name}`;
  const out = [];

  // A month the pipeline has not processed (or not completed): say so, never show a number.
  if (i < 0) {
    out.push(el('p', 'st-empty', `No data yet for ${monthLabel(m)}. Latest complete month: ${monthLabel(meta.lastCompleteMonth)}.`));
    const b = el('button', 'button', 'Go to latest month');
    b.type = 'button';
    b.addEventListener('click', () => setState({ selectedMonth: meta.lastCompleteMonth }));
    out.push(b);
    ui.body.replaceChildren(...out);
    return;
  }

  const h = cal.harmonizedCount[i];
  const status = cal.status[i];
  const hero = el('div', 'st-hero');
  const num = el('p', 'big-number st-number', fmtCount(h) ?? 'No data');
  num.id = 'st-number';
  const unit = el('p', 'st-unit', h == null ? 'The sensors did not cover the whole month.'
    : `hotspot detections${status === 'estimated' ? ' (estimate, in VIIRS terms)' : ''}`);
  hero.append(num, unit);
  out.push(hero);

  const chips = el('ul', 'chips');
  const chip = (text, kind) => { const c = el('li', `chip${kind ? ` chip-${kind}` : ''}`, text); chips.append(c); };
  if (status === 'observed') chip('Observed by VIIRS', 'observed');
  else if (status === 'estimated') chip('Estimated from MODIS', 'estimated');
  else chip('No data', 'missing');
  if (isProvisional(meta, m)) chip('Provisional: near real-time data', 'provisional');
  out.push(chips);

  if (status === 'estimated' && harm?.uncertainty) {
    const [lo, hi] = estimateRange(h, harm.uncertainty);
    out.push(el('p', 'st-line', `Likely between ${fmtCount(lo)} and ${fmtCount(hi)} (10th to 90th percentile of past estimate errors).`));
  }

  const facts = el('dl', 'st-facts');
  const fact = (k, v) => { const d = el('div'); d.append(el('dt', null, k), el('dd', null, v)); facts.append(d); };
  fact(`Usual ${monthName(m)}`, cal.seasonalMedian[i] == null ? 'Not enough years' : fmtCount(cal.seasonalMedian[i]));
  const best = busiestYear(cal, 'harmonized', m);
  fact(`Busiest ${monthName(m)}`, best ? `${best.year}: ${fmtCount(best.value)}` : 'None');
  fact('Raw MODIS', fmtCount(cal.rawModisCount[i]) ?? 'No data');
  fact('Raw VIIRS', fmtCount(cal.rawViirsCount[i]) ?? 'No data');
  out.push(facts);

  out.push(el('p', 'st-compare', compareText(h, cal.seasonalMedian[i], m)));
  const anom = anomalyText(cal.anomalyScore[i], m);
  if (anom) out.push(el('p', 'st-line', anom));
  if (best && best.status === 'estimated') {
    out.push(el('p', 'st-line small-text', `The busiest ${monthName(m)} (${best.year}) is an estimate from MODIS, before VIIRS existed.`));
  }

  // Selected date range.
  const idx = monthsInRange(cal, s.startMonth, s.endMonth);
  const withData = idx.filter((k) => cal.harmonizedCount[k] != null);
  const total = withData.reduce((a, k) => a + cal.harmonizedCount[k], 0);
  const peak = withData.reduce((b, k) => (b == null || cal.harmonizedCount[k] > cal.harmonizedCount[b] ? k : b), null);
  const range = el('section', 'st-range');
  range.append(el('h3', 'st-subhead', `Your date range: ${periodLabel(s.startMonth, s.endMonth)}`));
  const rl = el('dl', 'st-facts');
  const rfact = (k, v) => { const d = el('div'); d.append(el('dt', null, k), el('dd', null, v)); rl.append(d); };
  rfact('Total, harmonized', fmtCount(total));
  rfact('Months with data', `${withData.length} of ${idx.length}`);
  rfact('Busiest month', peak == null ? 'None' : `${monthLabel(cal.months[peak])}: ${fmtCount(cal.harmonizedCount[peak])}`);
  range.append(rl);
  out.push(range);

  const notes = el('div', 'st-notes small-text');
  notes.append(el('p', null, referenceText(cal)));
  if (s.sensorView !== 'harmonized') {
    notes.append(el('p', null, `The map and calendar show ${VIEW_NAME[s.sensorView]}; the comparison above uses the harmonized series.`));
  }
  if (m === meta.lastCompleteMonth) {
    const now = currentMonthOf(meta.generatedAt);
    if (now > m) notes.append(el('p', null, `This is the latest complete month. ${monthLabel(now)} was still in progress when the data was processed, so it is not shown.`));
  }
  notes.append(el('p', null, 'Counts are satellite hotspot detections, not distinct fires.'));
  out.push(notes);

  ui.body.replaceChildren(...out);
}
