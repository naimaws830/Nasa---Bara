// Downloads (C3).
//  1. Monthly CSV: one row per month of the selected area and date range, copied from calendar/<area>.json.
//  2. Observed squares CSV: raw detections grouped into 0.05-degree squares (from map/<year>.json), for the
//     same area and range. These are observations, not harmonized estimates, and are labelled as such.
// Files are built in the browser (Blob), so the links work locally and on GitHub Pages.

import { getState, subscribe } from './store.js';
import { dataURL, loadAreas, loadCalendar, loadForecast, loadMap, loadMeta, loadRain } from './data.js';
import {
  MONTHLY_COLUMNS, OUTLOOK_COLUMNS, SQUARE_COLUMNS, monthLabel, monthlyRows, outlookRows, periodLabel, toCSV,
} from './series.js';
import { CELL, inSelectedArea, squareAreaAt } from './map.js';
import { addInfo } from './ui.js';

let ui = null;

export async function mount(root) {
  const meta = await loadMeta();
  root.innerHTML = `
    <header class="panel-head">
      <div class="panel-title">
        <p class="eyebrow">Download</p>
        <h2 class="panel-heading">Download the numbers</h2>
      </div>
    </header>
    <p class="small-text" id="ex-scope"></p>
    <div class="ex-item">
      <div>
        <h3 class="st-subhead">Monthly numbers</h3>
        <p class="small-text" id="ex-monthly-info"></p>
      </div>
      <button type="button" class="button button-primary" id="ex-monthly">Download CSV</button>
    </div>
    <div class="ex-item">
      <div>
        <h3 class="st-subhead">Hotspot locations</h3>
        <p class="small-text">Where the satellites saw hotspots, in squares about 5 km wide. Raw counts, not adjusted.</p>
      </div>
      <button type="button" class="button" id="ex-squares">Download CSV</button>
    </div>
    <div class="ex-item" id="ex-outlook-item" hidden>
      <div>
        <h3 class="st-subhead">Next-month outlook</h3>
        <p class="small-text" id="ex-outlook-info"></p>
      </div>
      <button type="button" class="button" id="ex-outlook">Download CSV</button>
    </div>
    <p class="ex-status small-text" id="ex-status" role="status"></p>
    <details class="ex-files">
      <summary>Files for developers (JSON)</summary>
      <ul id="ex-links"></ul>
    </details>`;
  addInfo(root, 'About these files', `
    <p>Both files open in Excel or Google Sheets. They follow the area and dates chosen at the top of the page.</p>
    <p><strong>Monthly numbers</strong>: one row per month with the adjusted count Bara shows, what each satellite saw,
      whether the month is counted or estimated, and which NASA product it came from. Empty cells mean no data.</p>
    <p><strong>Hotspot locations</strong>: what the satellites actually saw, grouped into ${CELL}-degree squares (about 5.5 km).
      A square is given to the district it mostly lies in, so district totals can differ slightly from the monthly numbers,
      which place every hotspot at its exact position. For the whole of Sarawak they match exactly.</p>`);
  ui = {
    root, meta,
    scope: root.querySelector('#ex-scope'),
    info: root.querySelector('#ex-monthly-info'),
    status: root.querySelector('#ex-status'),
    links: root.querySelector('#ex-links'),
    squaresBtn: root.querySelector('#ex-squares'),
  };
  root.querySelector('#ex-monthly').addEventListener('click', downloadMonthly);
  root.querySelector('#ex-outlook').addEventListener('click', downloadOutlook);
  const forecast = await loadForecast().catch(() => null);
  if (forecast) {
    root.querySelector('#ex-outlook-item').hidden = false;
    root.querySelector('#ex-outlook-info').textContent = `The hotspot outlook for ${monthLabel(forecast.target)}, with the
      dry / normal / wet cases, for each division and Sarawak.`;
  }
  ui.squaresBtn.addEventListener('click', downloadSquares);
  subscribe((s, changed) => {
    if (changed.some((k) => ['areaId', 'startMonth', 'endMonth'].includes(k))) render();
  });
  await render();
}

function fileBase(s) {
  return `bara_${s.areaId.replace(':', '-')}_${s.startMonth}_${s.endMonth}`;
}

async function render() {
  const s = getState();
  const cal = await loadCalendar(s.areaId);
  const rows = monthlyRows(cal, ui.meta, s.startMonth, s.endMonth);
  ui.scope.textContent = `For ${cal.name}, ${periodLabel(s.startMonth, s.endMonth)}.`;
  ui.info.textContent = `A spreadsheet with one row for each of the ${rows.length} months: hotspots and rainfall.`;
  const files = [
    [`calendar/${s.areaId.replace(':', '_')}.json`, `Calendar for ${cal.name}`],
    ['harmonize.json', 'Harmonization method and errors'],
    ['meta.json', 'Coverage, sources and areas'],
    ['areas.geojson', 'Boundaries'],
  ];
  ui.links.replaceChildren(...files.map(([f, label]) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = dataURL(f);
    a.textContent = label;
    a.setAttribute('download', f.split('/').pop());
    li.append(a, document.createTextNode(` (${f})`));
    return li;
  }));
}

function save(name, text) {
  const blob = new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' }); // BOM so Excel reads UTF-8
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadMonthly() {
  const s = getState();
  const cal = await loadCalendar(s.areaId);
  const rain = await loadRain().catch(() => null);
  const rows = monthlyRows(cal, ui.meta, s.startMonth, s.endMonth, rain);
  save(`${fileBase(s)}_monthly.csv`, toCSV(MONTHLY_COLUMNS, rows));
  ui.status.textContent = `Saved ${rows.length} months for ${cal.name}.`;
}

async function downloadOutlook() {
  const forecast = await loadForecast();
  if (!forecast) return;
  const rows = outlookRows(forecast, ui.meta);
  save(`bara_outlook_${forecast.target}.csv`, toCSV(OUTLOOK_COLUMNS, rows));
  ui.status.textContent = `Saved the ${monthLabel(forecast.target)} outlook for ${rows.length} areas.`;
}

/** Observed squares in the area and range. Exported for tests. */
export function squareRows(byYear, areas, areaId, start, end) {
  const divisionOf = new Map(areas.features.filter((f) => f.properties.division)
    .map((f) => [f.properties.id, f.properties.division]));
  const where = new Map();
  const rows = [];
  for (const json of byYear) {
    for (const c of json.cells) {
      const month = `${json.year}-${String(c.month).padStart(2, '0')}`;
      if (month < start || month > end) continue;
      const key = `${c.lon},${c.lat}`;
      if (!where.has(key)) where.set(key, squareAreaAt(c.lon, c.lat, areas));
      const district = where.get(key);
      if (!inSelectedArea(areaId, district, divisionOf)) continue;
      rows.push({
        month, sensor: c.sensor, processing: c.processing, cellCentreLon: c.lon, cellCentreLat: c.lat,
        cellSizeDeg: json.cell ?? CELL, detections: c.count, districtId: district === 'sarawak' ? '' : district,
      });
    }
  }
  rows.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : a.sensor < b.sensor ? -1 : a.sensor > b.sensor ? 1 : 0));
  return rows;
}

async function downloadSquares() {
  const s = getState();
  ui.squaresBtn.disabled = true;
  try {
    const years = [];
    for (let y = Number(s.startMonth.slice(0, 4)); y <= Number(s.endMonth.slice(0, 4)); y++) years.push(y);
    let done = 0;
    const [areas, ...byYear] = await Promise.all([loadAreas(), ...years.map(async (y) => {
      const j = await loadMap(y);
      ui.status.textContent = `Loading map data: ${++done} of ${years.length} years.`;
      return j;
    })]);
    const rows = squareRows(byYear, areas, s.areaId, s.startMonth, s.endMonth);
    save(`${fileBase(s)}_observed_squares.csv`, toCSV(SQUARE_COLUMNS, rows));
    ui.status.textContent = `Saved ${rows.length} square-months of observed detections.`;
  } catch (err) {
    ui.status.textContent = `Could not build the file: ${err.message}`;
  } finally {
    ui.squaresBtn.disabled = false;
  }
}
