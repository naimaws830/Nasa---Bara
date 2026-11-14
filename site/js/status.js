// Selected month (C2). Plain summary first, details on request.
// Every number comes from calendar/<area>.json or harmonize.json. Comparisons use the harmonized series.
// Wording is descriptive history, never an emergency warning or a forecast.

import { getState, setState, subscribe } from './store.js';
import { loadCalendar, loadHarmonize, loadMeta } from './data.js';
import {
  APIMS_URL, VIEW_NAME, anomalyText, busiestYear, compareText, estimateRange, fireSeason, fmtCount, isProvisional,
  levelOf, monthLabel, monthName, monthsInRange, periodLabel, plainSummary, preparedness, referenceText,
} from './series.js';
import { addInfo } from './ui.js';

let ui = null;

export async function mount(root) {
  const [meta, harm] = await Promise.all([loadMeta(), loadHarmonize().catch(() => null)]);
  root.innerHTML = `
    <header class="panel-head">
      <div class="panel-title">
        <p class="eyebrow" id="st-eyebrow">Selected month</p>
        <h2 class="panel-heading" id="st-title"></h2>
      </div>
    </header>
    <div id="st-body"></div>`;
  addInfo(root, 'What is a hotspot?', `
    <p>A <strong>hotspot</strong> is a spot where a satellite saw unusual heat, almost always a fire.
      One fire can be seen more than once, and fires under thick cloud can be missed.</p>
    <p><strong>Normal</strong> means the middle value for the same month in past years.
      Pick any month in the calendar below to see it here.</p>`);
  ui = { root, meta, harm, title: root.querySelector('#st-title'), eyebrow: root.querySelector('#st-eyebrow'),
    body: root.querySelector('#st-body'), token: 0, detailsOpen: false };
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

function facts(pairs) {
  const dl = el('dl', 'st-facts');
  for (const [k, v] of pairs) {
    const d = el('div');
    d.append(el('dt', null, k), el('dd', null, v));
    dl.append(d);
  }
  return dl;
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
  const latest = m === meta.lastCompleteMonth;
  ui.eyebrow.textContent = latest ? 'Latest full month' : 'Selected month';
  ui.title.textContent = `${monthLabel(m)}, ${cal.name}`;

  if (i < 0) {
    const b = el('button', 'button', 'Go to latest month');
    b.type = 'button';
    b.addEventListener('click', () => setState({ selectedMonth: meta.lastCompleteMonth }));
    ui.body.replaceChildren(el('p', 'st-plain', `No data yet for ${monthLabel(m)}. The latest full month is ${monthLabel(meta.lastCompleteMonth)}.`), b);
    return;
  }

  const h = cal.harmonizedCount[i];
  const median = cal.seasonalMedian[i];
  const status = cal.status[i];
  const provisional = isProvisional(meta, m);
  const out = [];

  // 1. Plain summary.
  const plain = el('div', 'st-plain');
  for (const line of plainSummary({ area: cal.name, month: m, value: h, median, status, provisional })) {
    plain.append(el('p', null, line));
  }
  out.push(plain);

  // 2. Number, level, two key facts.
  const hero = el('div', 'st-hero');
  hero.append(el('p', 'big-number st-number', fmtCount(h) ?? '-'), el('p', 'st-unit', 'hotspots'));
  const lvl = levelOf(h, median);
  if (lvl) {
    const tag = el('p', `level level-${lvl.key}`);
    tag.append(el('span', 'level-icon'), document.createTextNode(lvl.word));
    hero.append(tag);
  }
  out.push(hero);
  const best = busiestYear(cal, 'harmonized', m);
  out.push(facts([
    [`Normal ${monthName(m)}`, median == null ? 'Not enough years' : `about ${fmtCount(median)}`],
    [`Worst ${monthName(m)} on record`, best ? `${best.year} (${fmtCount(best.value)})` : 'None'],
  ]));

  // 3. Be prepared: from the area's own history and today's month, with the official live source for haze.
  out.push(await prepBox(cal, s.areaId, lvl, m));
  if (token !== ui.token) return;

  // 4. Details on request.
  const det = el('details', 'st-details');
  det.open = ui.detailsOpen;
  det.addEventListener('toggle', () => { ui.detailsOpen = det.open; });
  det.append(el('summary', null, 'More detail'));
  const chips = el('ul', 'chips');
  const chip = (text, kind) => chips.append(el('li', `chip chip-${kind}`, text));
  if (status === 'observed') chip('Counted by the newer satellite (VIIRS)', 'observed');
  else if (status === 'estimated') chip('Estimated from the older satellite (MODIS)', 'estimated');
  else chip('No data', 'missing');
  if (provisional) chip('Provisional: near real-time data', 'provisional');
  det.append(chips);
  if (status === 'estimated' && harm?.uncertainty) {
    const [lo, hi] = estimateRange(h, harm.uncertainty);
    det.append(el('p', 'st-line', `Likely between ${fmtCount(lo)} and ${fmtCount(hi)}, judging by how far past estimates were off.`));
  }
  det.append(el('p', 'st-line', compareText(h, median, m)));
  const anom = anomalyText(cal.anomalyScore[i], m);
  if (anom) det.append(el('p', 'st-line', anom));
  det.append(facts([
    ['Older satellite (MODIS) saw', fmtCount(cal.rawModisCount[i]) ?? 'No data'],
    ['Newer satellite (VIIRS) saw', fmtCount(cal.rawViirsCount[i]) ?? 'Not running yet'],
  ]));
  const idx = monthsInRange(cal, s.startMonth, s.endMonth);
  const withData = idx.filter((k) => cal.harmonizedCount[k] != null);
  const total = withData.reduce((a, k) => a + cal.harmonizedCount[k], 0);
  const peak = withData.reduce((b, k) => (b == null || cal.harmonizedCount[k] > cal.harmonizedCount[b] ? k : b), null);
  det.append(el('h3', 'st-subhead', `Your date range: ${periodLabel(s.startMonth, s.endMonth)}`));
  det.append(facts([
    ['Hotspots in total', fmtCount(total)],
    ['Busiest month', peak == null ? 'None' : `${monthLabel(cal.months[peak])} (${fmtCount(cal.harmonizedCount[peak])})`],
  ]));
  const notes = el('div', 'st-notes small-text');
  notes.append(el('p', null, referenceText(cal)));
  if (s.sensorView !== 'harmonized') {
    notes.append(el('p', null, `The map and calendar show ${VIEW_NAME[s.sensorView]}; this panel uses the adjusted (harmonized) numbers.`));
  }
  if (latest && meta.generatedAt.slice(0, 7) > m) {
    notes.append(el('p', null, `${monthLabel(meta.generatedAt.slice(0, 7))} was not finished when the data was prepared, so it is not shown.`));
  }
  det.append(notes);
  out.push(det);

  ui.body.replaceChildren(...out);
}

/** Season of the area, or of its division / Sarawak when the area has too few hotspots to have one. */
async function seasonFor(cal, areaId) {
  const own = fireSeason(cal);
  if (own) return { season: own, name: cal.name, rare: false };
  const area = ui.meta.areas.find((a) => a.id === areaId);
  for (const parent of [area?.division, 'sarawak'].filter(Boolean)) {
    if (parent === areaId) continue;
    try {
      const pc = await loadCalendar(parent);
      const sea = fireSeason(pc);
      if (sea) return { season: sea, name: pc.name, rare: true };
    } catch { /* try the next one */ }
  }
  return { season: null, name: cal.name, rare: true };
}

async function prepBox(cal, areaId, lvl, month) {
  const { season, name, rare } = await seasonFor(cal, areaId);
  const nowMonth = new Date().getMonth() + 1;
  const busier = !!lvl && (lvl.key === 'higher' || lvl.key === 'much');
  const prep = preparedness(season, nowMonth, { area: name, busier, selectedLabel: monthLabel(month) });

  const box = el('section', `prep prep-${prep.phase}`);
  box.setAttribute('aria-label', 'Be prepared');
  const h = el('h3', 'prep-title');
  h.innerHTML = '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M10 2.5l8 14H2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><rect x="9.2" y="7.5" width="1.6" height="4.6" fill="currentColor"/><rect x="9.2" y="13.3" width="1.6" height="1.6" fill="currentColor"/></svg>';
  h.append(document.createTextNode(prep.phase === 'in' ? 'Fire season: be prepared' : 'Be prepared'));
  box.append(h);
  if (rare) box.append(el('p', null, `Hotspots are rare in ${cal.name} itself.`));
  for (const line of prep.lines) box.append(el('p', null, line));

  const apims = () => {
    const a = el('a', null, 'APIMS');
    a.href = APIMS_URL;
    a.target = '_blank';
    a.rel = 'noopener';
    return a;
  };
  if (prep.checklist) {
    const ul = el('ul', 'prep-list');
    ul.append(el('li', null, 'Keep face masks (N95) at home for haze days.'));
    const li = el('li');
    li.append("Check today's air quality on ", apims(), ' (Department of Environment). Above 100 is unhealthy: spend less time outdoors.');
    ul.append(li);
    ul.append(el('li', null, 'Do not burn rubbish or land. In an emergency, call 999.'));
    box.append(ul);
  } else {
    const p = el('p');
    p.append("For today's air quality, check ", apims(), ' (Department of Environment).');
    box.append(p);
  }
  box.append(el('p', 'prep-foot small-text',
    "Based on past satellite records, not today's haze. Haze can also blow in from fires outside Sarawak."));
  return box;
}
