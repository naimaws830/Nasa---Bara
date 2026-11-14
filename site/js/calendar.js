// Hotspot calendar (C2): years x months heatmap of the selected series for the selected area.
// Missing months (no full sensor coverage) are hatched and say "no data"; zero is a plain light cell with "0".
// Click or keyboard (arrows, Home/End, Page Up/Down, Enter) selects a month for the map and status panels.

import { getState, setState, subscribe } from './store.js';
import { addInfo } from './ui.js';
import { loadCalendar, loadMeta } from './data.js';
import {
  MONTH_SHORT, VIEW_NAME, calendarEdges, edgeBin, edgeLabels, fireStep, fmtCount, monthLabel, valuesFor,
} from './series.js';

let ui = null;

export async function mount(root) {
  const meta = await loadMeta();
  root.innerHTML = `
    <header class="panel-head">
      <div class="panel-title">
        <p class="eyebrow" id="cal-eyebrow">Calendar</p>
        <h2 class="panel-heading" id="cal-title">Hotspots month by month</h2>
      </div>
      <p class="small-text cal-howto">Each box is one month. Darker = more hotspots. Click a box to see that month.</p>
    </header>
    <div class="cal-scroll">
      <div class="cal-grid" id="cal-grid" role="grid" aria-labelledby="cal-title"></div>
    </div>
    <p class="cal-detail" id="cal-detail" aria-live="polite"></p>
    <div class="cal-legend" id="cal-legend"></div>`;
  const info = addInfo(root, 'How to read the calendar', `
    <p>Rows are years (newest at the top), columns are months. The number in each box is how many hotspots
      satellites saw that month. Darker boxes had more.</p>
    <p><strong>Striped box</strong>: no full satellite record that month. <strong>0</strong>: the satellite was watching and saw none.</p>
    <p><strong>Small triangle</strong> (top right): an estimate, because the newer satellite only started in 2012.</p>
    <p><strong>Small square</strong> (top left): a month that was much busier than that month usually is.</p>
    <p class="cal-anom-note"></p>
    <p>Keyboard: arrow keys move between months, Enter picks one.</p>`);
  ui = {
    root, meta, info,
    grid: root.querySelector('#cal-grid'),
    detail: root.querySelector('#cal-detail'),
    legend: root.querySelector('#cal-legend'),
    title: root.querySelector('#cal-title'),
    eyebrow: root.querySelector('#cal-eyebrow'),
    cal: null, cells: new Map(), focusMonth: null, token: 0,
  };

  ui.grid.addEventListener('click', (e) => {
    const cell = e.target.closest('[data-month]');
    if (cell && cell.dataset.state !== 'unprocessed') select(cell.dataset.month);
  });
  ui.grid.addEventListener('keydown', onKey);
  ui.grid.addEventListener('focusin', (e) => {
    const cell = e.target.closest('[data-month]');
    if (cell) showDetail(cell.dataset.month);
  });
  ui.grid.addEventListener('pointerover', (e) => {
    const cell = e.target.closest('[data-month]');
    if (cell) showDetail(cell.dataset.month);
  });
  ui.grid.addEventListener('pointerleave', () => showDetail(getState().selectedMonth));

  subscribe((s, changed) => {
    if (changed.some((k) => ['areaId', 'sensorView', 'startMonth', 'endMonth'].includes(k))) render();
    else if (changed.includes('selectedMonth')) markSelected();
  });
  await render();
}

function select(month) {
  setState({ selectedMonth: month });
  moveFocus(month, false);
}

async function render() {
  const token = ++ui.token;
  const s = getState();
  let cal;
  try {
    cal = await loadCalendar(s.areaId);
  } catch (err) {
    ui.grid.textContent = `The calendar for this area could not be loaded: ${err.message}`;
    return;
  }
  if (token !== ui.token) return;
  ui.cal = cal;
  const values = valuesFor(cal, s.sensorView);
  const inRange = cal.months.map((m) => m >= s.startMonth && m <= s.endMonth);
  const edges = calendarEdges(values.filter((_, i) => inRange[i]));
  ui.edges = edges;

  ui.title.textContent = `Hotspots month by month, ${cal.name}`;
  ui.eyebrow.textContent = s.sensorView === 'harmonized' ? 'Calendar' : `Calendar, ${VIEW_NAME[s.sensorView]} only`;

  const firstYear = Number(s.startMonth.slice(0, 4));
  const lastYear = Number(s.endMonth.slice(0, 4));
  const index = new Map(cal.months.map((m, i) => [m, i]));
  const frag = document.createDocumentFragment();

  const head = row();
  head.append(cellEl('columnheader', '', 'cal-corner'));
  MONTH_SHORT.forEach((m) => head.append(cellEl('columnheader', m, 'cal-mhead')));
  frag.append(head);

  ui.cells = new Map();
  for (let y = lastYear; y >= firstYear; y--) {
    const r = row();
    r.append(cellEl('rowheader', String(y), 'cal-year'));
    for (let mm = 1; mm <= 12; mm++) {
      const month = `${y}-${String(mm).padStart(2, '0')}`;
      const i = index.get(month);
      const td = cellEl('gridcell', '', 'cal-cell');
      td.dataset.month = month;
      td.tabIndex = -1;
      if (i === undefined) {
        td.dataset.state = 'unprocessed';
        td.setAttribute('aria-label', `${monthLabel(month)}: not processed yet`);
        td.setAttribute('aria-disabled', 'true');
      } else {
        const v = values[i];
        const out = !inRange[i];
        if (out) td.classList.add('is-outside');
        if (v == null) {
          td.dataset.state = 'missing';
          td.textContent = 'no data';
        } else if (v === 0) {
          td.dataset.state = 'zero';
          td.textContent = '0';
        } else {
          const step = fireStep(edgeBin(v, edges), edges);
          td.dataset.state = 'value';
          td.dataset.step = String(step);
          td.textContent = fmtCount(v);
        }
        if (s.sensorView === 'harmonized' && cal.status[i] === 'estimated') td.classList.add('is-estimated');
        const a = cal.anomalyScore[i];
        if (s.sensorView === 'harmonized' && a != null && a >= 2) td.classList.add('is-unusual');
        td.setAttribute('aria-label', cellLabel(i, s.sensorView, out));
      }
      ui.cells.set(month, td);
      r.append(td);
    }
    frag.append(r);
  }
  ui.grid.replaceChildren(frag);
  ui.grid.setAttribute('aria-rowcount', String(lastYear - firstYear + 2));
  renderLegend(edges, s.sensorView);
  markSelected();
}

function row() {
  const r = document.createElement('div');
  r.setAttribute('role', 'row');
  r.className = 'cal-row';
  return r;
}

function cellEl(role, text, cls) {
  const el = document.createElement('div');
  el.setAttribute('role', role);
  el.className = cls;
  el.textContent = text;
  return el;
}

function cellLabel(i, view, outside) {
  const { cal } = ui;
  const m = cal.months[i];
  const v = valuesFor(cal, view)[i];
  const parts = [monthLabel(m)];
  if (v == null) parts.push('no data: the sensor did not cover the whole month');
  else parts.push(`${fmtCount(v)} hotspot detection${Math.round(v) === 1 ? '' : 's'}`);
  if (view === 'harmonized') parts.push(cal.status[i] === 'estimated' ? 'estimated from MODIS' : 'observed by VIIRS');
  const a = cal.anomalyScore[i];
  if (view === 'harmonized' && a != null && a >= 2) parts.push('unusually high');
  if (outside) parts.push('outside the selected date range');
  return parts.join(', ');
}

function showDetail(month) {
  const { cal } = ui;
  if (!cal) return;
  const i = cal.months.indexOf(month);
  if (i < 0) {
    ui.detail.textContent = `${monthLabel(month)}: not processed yet.`;
    return;
  }
  const h = cal.harmonizedCount[i];
  if (h == null) {
    ui.detail.textContent = `${monthLabel(month)}: no data.`;
    return;
  }
  const how = cal.status[i] === 'estimated' ? 'an estimate' : 'counted by the newer satellite';
  const n = Math.round(h);
  ui.detail.textContent = `${monthLabel(month)}: ${fmtCount(h)} hotspot${n === 1 ? '' : 's'} (${how}).`;
}

function markSelected() {
  const sel = getState().selectedMonth;
  for (const [m, el] of ui.cells) {
    const on = m === sel;
    el.classList.toggle('is-selected', on);
    el.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  moveFocus(sel, false);
  showDetail(sel);
}

// Roving tabindex: exactly one cell is in the tab order.
function moveFocus(month, focus = true) {
  const target = ui.cells.get(month) || ui.cells.get(getState().selectedMonth) || [...ui.cells.values()].find((c) => c.dataset.state !== 'unprocessed');
  if (!target) return;
  for (const el of ui.cells.values()) el.tabIndex = -1;
  target.tabIndex = 0;
  ui.focusMonth = target.dataset.month;
  if (focus) target.focus();
}

function shift(month, years, months) {
  const total = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + years * 12 + months;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

function onKey(e) {
  const cur = ui.focusMonth || getState().selectedMonth;
  const moves = {
    ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [1, 0], ArrowDown: [-1, 0], // newest year is on top
    PageUp: [1, 0], PageDown: [-1, 0],
  };
  let next = null;
  if (moves[e.key]) next = shift(cur, ...moves[e.key]);
  else if (e.key === 'Home') next = `${cur.slice(0, 4)}-01`;
  else if (e.key === 'End') next = `${cur.slice(0, 4)}-12`;
  else if (e.key === 'Enter' || e.key === ' ') {
    const cell = ui.cells.get(cur);
    if (cell && cell.dataset.state !== 'unprocessed') select(cur);
    e.preventDefault();
    return;
  } else return;
  e.preventDefault();
  const cell = ui.cells.get(next);
  if (cell && cell.dataset.state !== 'unprocessed') moveFocus(next);
}

function renderLegend(edges, view) {
  const labels = edgeLabels(edges);
  const sw = labels.map((l, b) => `<li><span class="cal-swatch" data-step="${fireStep(b, edges)}"></span>${l}</li>`).join('');
  const marks = view === 'harmonized'
    ? `<li><span class="cal-swatch cal-swatch-est"></span>Estimate (before 2012)</li>
       <li><span class="cal-swatch cal-swatch-unusual"></span>Much busier than usual</li>`
    : '';
  ui.legend.innerHTML = `
    <p class="legend-title">Hotspots per month</p>
    <ul>${sw}
      <li><span class="cal-swatch" data-state="zero"></span>None seen</li>
      <li><span class="cal-swatch" data-state="missing"></span>No data</li>
      ${marks}
    </ul>
    `;
  const note = ui.info.querySelector('.cal-anom-note');
  note.textContent = view === 'harmonized' ? unusualNote() : '';
  note.hidden = view !== 'harmonized';
}

/** Explains how many months are flagged and when, from the data, so a cluster of dots is not misread. */
function unusualNote() {
  const { cal } = ui;
  const s = getState();
  const idx = cal.months.map((m, i) => i).filter((i) => cal.months[i] >= s.startMonth && cal.months[i] <= s.endMonth);
  const flagged = idx.filter((i) => cal.anomalyScore[i] != null && cal.anomalyScore[i] >= 2);
  const [y0, y1] = cal.reference.completeYears;
  if (!flagged.length) return `None of the months you picked was much busier than usual (compared with ${y0} to ${y1}).`;
  const years = flagged.map((i) => Number(cal.months[i].slice(0, 4))).sort((a, b) => a - b);
  const mid = years[Math.floor(years.length / 2)];
  const early = flagged.filter((i) => cal.status[i] === 'estimated').length;
  let text = `${flagged.length} of the ${idx.length} months you picked were much busier than usual (compared with ${y0} to ${y1}); half of them were in ${mid} or earlier.`;
  if (early / flagged.length > 0.5) {
    text += " Fires were far more common before 2012, so many older months stand out next to today's quieter years.";
  }
  return text;
}
