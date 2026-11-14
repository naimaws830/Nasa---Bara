// Hotspot map (B1). Mounted into #map by main.js; talks to the rest of the app only through
// data.js (loadMeta, loadAreas, loadMap) and store.js (getState, subscribe).
//
// What it shows: OBSERVED satellite hotspot detections from one sensor, grouped into 0.05-degree squares
// (about 5.5 km), for the selected month or the whole selected date range, over the real Sarawak and
// district boundaries. Harmonized estimates are totals per area and have no locations, so they are never
// drawn as points: in the "Harmonized" series the map shows the sensor actually observed that month.
//
// Two views:
//   2D (default): canvas, works everywhere, drag / Ctrl+scroll / pinch / keyboard / buttons.
//   3D (optional): Three.js instanced columns, loaded only when asked for. If Three.js or WebGL is
//                  unavailable it says so and stays on 2D.
//
// Pure helpers (project, areaAt, binsFor, sensorFor, monthsBetween, ...) are exported for tests.

import { getState, subscribe } from './store.js';
import { loadAreas, loadMap, loadMeta } from './data.js';
import { monthLabel } from './controls.js';
import { addInfo } from './ui.js';

// ---------- Pure helpers ----------

export const CELL = 0.05; // degrees, matches map/<year>.json "cell"
const LON0 = 112.5;
const LAT0 = 2.8;
const K = Math.cos((LAT0 * Math.PI) / 180);

/** WGS84 lon/lat to map units: x east, y DOWN (south), 1 unit = 1 degree of latitude. */
export function project(lon, lat) {
  return [(lon - LON0) * K, -(lat - LAT0)];
}

export function unproject(x, y) {
  return [x / K + LON0, LAT0 - y];
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** True if lon/lat is inside a GeoJSON Polygon or MultiPolygon (holes respected). */
export function pointInGeometry(lon, lat, geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polys.some(([outer, ...holes]) => pointInRing(lon, lat, outer) && !holes.some((h) => pointInRing(lon, lat, h)));
}

/** District feature id containing lon/lat, "sarawak" if only inside the state outline, or null. */
export function areaAt(lon, lat, geojson) {
  let inState = false;
  for (const f of geojson.features) {
    if (!pointInGeometry(lon, lat, f.geometry)) continue;
    if (f.properties.id !== 'sarawak') return f.properties.id;
    inState = true;
  }
  return inState ? 'sarawak' : null;
}

/**
 * Area of a 0.05-degree square: the area containing its centre; if the centre is outside every polygon (sea,
 * river mouth), the area most of its corners and edge midpoints fall in. Keeps coastal squares in their district.
 */
export function squareAreaAt(lon, lat, geojson, half = CELL * 0.48) {
  const centre = areaAt(lon, lat, geojson);
  if (centre) return centre;
  const votes = new Map();
  for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]) {
    const a = areaAt(lon + dx * half, lat + dy * half, geojson);
    if (a) votes.set(a, (votes.get(a) || 0) + 1);
  }
  let best = null;
  for (const [a, n] of votes) if (!best || n > best[1]) best = [a, n];
  return best ? best[0] : null;
}

/** Does a square whose centre is in district `districtId` belong to the selected area? */
export function inSelectedArea(selectedId, districtId, divisionOf) {
  if (selectedId === 'sarawak') return true;
  if (!districtId) return false;
  if (selectedId.startsWith('div:')) return divisionOf.get(districtId) === selectedId;
  return districtId === selectedId;
}

/** Colour bin lower bounds. A month uses fixed bins so months compare; a range scales with its total. */
export function binsFor(max, scope = 'month') {
  if (scope === 'month' || max <= 64) return [1, 2, 4, 8, 16, 32];
  if (max <= 320) return [1, 5, 10, 25, 50, 100];
  return [1, 10, 25, 50, 100, 250];
}

export function binIndex(count, bins) {
  let i = 0;
  while (i + 1 < bins.length && count >= bins[i + 1]) i++;
  return i;
}

export function binLabel(i, bins) {
  if (i === bins.length - 1) return `${bins[i]}+`;
  const hi = bins[i + 1] - 1;
  return hi === bins[i] ? `${hi}` : `${bins[i]} to ${hi}`;
}

export function monthsBetween(start, end) {
  const out = [];
  let y = Number(start.slice(0, 4));
  let m = Number(start.slice(5, 7));
  const endY = Number(end.slice(0, 4));
  const endM = Number(end.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

/** First and last month a sensor covers completely, from meta.sensorProducts. */
export function sensorCoverage(products, sensor) {
  const own = products.filter((p) => p.sensor === sensor);
  if (!own.length) return null;
  const start = own.map((p) => p.coverage.start).sort()[0];
  const end = own.map((p) => p.coverage.end).sort().at(-1);
  const startMonth = start.endsWith('-01') ? start.slice(0, 7) : shiftMonth(start.slice(0, 7), 1);
  const endDate = new Date(`${end}T00:00:00Z`);
  const lastDay = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth() + 1, 0)).getUTCDate();
  const endMonth = endDate.getUTCDate() === lastDay ? end.slice(0, 7) : shiftMonth(end.slice(0, 7), -1);
  return { start: startMonth, end: endMonth };
}

function shiftMonth(m, n) {
  const total = Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1 + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/** Which sensor's observations to draw. Harmonized has no locations, so use the sensor observed that month. */
export function sensorFor(view, month, viirsCoverage) {
  if (view === 'raw-modis') return 'MODIS';
  if (view === 'raw-viirs') return 'VIIRS';
  return viirsCoverage && month >= viirsCoverage.start && month <= viirsCoverage.end ? 'VIIRS' : 'MODIS';
}

/**
 * Sensor for a whole period. Raw views use their own sensor. Harmonized uses VIIRS whenever any month of
 * the period has full VIIRS coverage (the sharper sensor), otherwise MODIS. Never mixes sensors in one map.
 */
export function sensorForPeriod(view, months, viirsCoverage) {
  if (view !== 'harmonized') return sensorFor(view, months[0], viirsCoverage);
  return months.some((m) => sensorFor('harmonized', m, viirsCoverage) === 'VIIRS') ? 'VIIRS' : 'MODIS';
}

function cellKey(lon, lat) {
  return `${lon.toFixed(3)},${lat.toFixed(3)}`;
}

/** Sum cells of one sensor over a list of months. byMonth: Map("YYYY-MM|SENSOR" -> cells[]). */
export function collectCells(byMonth, months, sensor) {
  const sums = new Map();
  for (const m of months) {
    for (const c of byMonth.get(`${m}|${sensor}`) || []) {
      const key = cellKey(c.lon, c.lat);
      const cur = sums.get(key);
      if (cur) {
        cur.count += c.count;
        cur.processing.add(c.processing);
      } else {
        sums.set(key, { key, lon: c.lon, lat: c.lat, count: c.count, processing: new Set([c.processing]) });
      }
    }
  }
  return [...sums.values()];
}

// ---------- Module state ----------

const VIEW_KEY = 'bara.map.view';

let ctx = null; // shared context for both views, filled in mount()

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function palette() {
  return {
    haze: css('--haze'),
    hazeDeep: css('--haze-deep'),
    peat: css('--peat'),
    peatSoft: css('--peat-soft'),
    blackwater: css('--blackwater'),
    landSelect: css('--land-select') || '#C5CCC2',
    fire: [1, 2, 3, 4, 5, 6].map((i) => css(`--fire-${i}`)),
  };
}

function readPref() {
  try { return localStorage.getItem(VIEW_KEY) === '3d' ? '3d' : '2d'; } catch { return '2d'; }
}

function writePref(v) {
  try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode: fine */ }
}

// ---------- Mount ----------

export async function mount(root) {
  const [meta, areas] = await Promise.all([loadMeta(), loadAreas()]);
  if (!areas.features.some((f) => f.properties.id === 'sarawak')) {
    console.warn('[map] areas.geojson has no Sarawak outline; only districts are drawn.');
  }

  const zoomIcon = (d) => `<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"/></svg>`;
  root.innerHTML = `
    <header class="panel-head">
      <div class="panel-title">
        <p class="eyebrow">Map</p>
        <h2 class="panel-heading" id="map-title">Where were the hotspots?</h2>
      </div>
      <div class="panel-tools">
        <fieldset class="seg">
          <legend class="visually-hidden">Period on the map</legend>
          <label class="seg-opt"><input type="radio" name="map-scope" value="month" checked><span>Selected month</span></label>
          <label class="seg-opt"><input type="radio" name="map-scope" value="range"><span>Date range</span></label>
        </fieldset>
        <fieldset class="seg">
          <legend class="visually-hidden">Map view</legend>
          <label class="seg-opt"><input type="radio" name="map-view" value="2d"><span>Flat</span></label>
          <label class="seg-opt"><input type="radio" name="map-view" value="3d"><span>3D</span></label>
        </fieldset>
      </div>
    </header>
    <dl class="map-facts" id="map-facts">
      <div><dt>Showing</dt><dd id="map-fact-period">-</dd></div>
      <div><dt>Hotspots in Sarawak</dt><dd id="map-fact-total">-</dd></div>
      <div><dt>Places with hotspots</dt><dd id="map-fact-cells">-</dd></div>
      <div><dt>Seen by</dt><dd id="map-fact-sensor">-</dd></div>
    </dl>
    <div class="map-stage" id="map-stage">
      <div class="map-zoom" role="group" aria-label="Zoom">
        <button type="button" class="icon-btn" data-zoom="in" aria-label="Zoom in">${zoomIcon('M10 4v12M4 10h12')}</button>
        <button type="button" class="icon-btn" data-zoom="out" aria-label="Zoom out">${zoomIcon('M4 10h12')}</button>
        <button type="button" class="icon-btn" data-zoom="reset" aria-label="Show the whole selected area">${zoomIcon('M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4')}</button>
      </div>
      <p class="map-overlay" id="map-overlay" hidden></p>
      <div class="map-tooltip" id="map-tooltip" role="status" hidden></div>
    </div>
    <p class="map-summary" id="map-summary" aria-live="polite"></p>
    <div class="map-foot">
      <div class="map-legend" id="map-legend" aria-label="Colour key"></div>
      <details class="map-top">
        <summary>Busiest places in your area</summary>
        <ol id="map-top-list"></ol>
      </details>
    </div>
    <p class="map-hint small-text" id="map-hint"></p>`;
  addInfo(root, 'How to read this map', `
    <p>Each coloured square is an area about 5 km wide where satellites saw hotspots. <strong>Darker = more hotspots.</strong>
      The area you picked is outlined; everything else is faded.</p>
    <p>A hotspot is a spot of unusual heat seen from space, almost always a fire. One fire can be seen more than once,
      and fires under thick cloud can be missed.</p>
    <p>The map shows what a satellite actually saw: the newer satellite (VIIRS) from 2012, the older one (MODIS) before that.
      The adjusted numbers used elsewhere are totals for an area, so they cannot be put on a map.</p>
    <p><strong>Moving around:</strong> drag the map; zoom with the + and - buttons, a pinch, or Ctrl + scroll.
      Tap or hover a square for its details. With the map selected, arrow keys move it and Enter shows the square in the middle.</p>`);

  const $ = (id) => root.querySelector(`#${id}`);
  const divisionOf = new Map(areas.features.filter((f) => f.properties.division)
    .map((f) => [f.properties.id, f.properties.division]));
  const areaNames = new Map(meta.areas.map((a) => [a.id, a.name]));
  const districtNames = new Map(areas.features.map((f) => [f.properties.id, f.properties.name]));

  ctx = {
    root, meta, areas, divisionOf, areaNames, districtNames,
    viirs: sensorCoverage(meta.sensorProducts || [], 'VIIRS'),
    modis: sensorCoverage(meta.sensorProducts || [], 'MODIS'),
    stage: $('map-stage'), summaryEl: $('map-summary'), overlayEl: $('map-overlay'), tooltipEl: $('map-tooltip'),
    legendEl: $('map-legend'), topList: $('map-top-list'), hintEl: $('map-hint'),
    facts: { sensor: $('map-fact-sensor'), period: $('map-fact-period'), total: $('map-fact-total'), cells: $('map-fact-cells') },
    scope: 'month', viewName: '2d', view: null,
    byMonth: new Map(), loadedYears: new Set(),
    cells: [], cellIndex: new Map(), bins: binsFor(0), sensor: 'VIIRS', selectedKey: null,
    districtOfCell: new Map(), token: 0,
    colors: palette(),
  };

  root.querySelectorAll('input[name="map-scope"]').forEach((r) => r.addEventListener('change', () => {
    ctx.scope = r.value;
    refreshData();
  }));
  root.querySelectorAll('input[name="map-view"]').forEach((r) => r.addEventListener('change', () => switchView(r.value)));
  root.querySelectorAll('[data-zoom]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.zoom === 'reset') ctx.view?.fitArea(getState().areaId);
    else ctx.view?.zoomBy(b.dataset.zoom === 'in' ? 1.5 : 1 / 1.5);
  }));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTooltip(); });

  subscribe((state, changed) => {
    if (changed.includes('areaId')) {
      ctx.view?.setArea(state.areaId);
      updateSummary();
      updateTopList();
    }
    if (changed.some((k) => ['selectedMonth', 'startMonth', 'endMonth', 'sensorView'].includes(k))) refreshData();
  });

  await switchView(readPref(), { initial: true });
  await refreshData();
}

// ---------- Data ----------

function addYear(json) {
  for (const c of json.cells) {
    const key = `${json.year}-${String(c.month).padStart(2, '0')}|${c.sensor}`;
    if (!ctx.byMonth.has(key)) ctx.byMonth.set(key, []);
    ctx.byMonth.get(key).push(c);
  }
  ctx.loadedYears.add(json.year);
}

async function ensureYears(months, token) {
  const years = [...new Set(months.map((m) => Number(m.slice(0, 4))))].filter((y) => !ctx.loadedYears.has(y));
  let done = 0;
  await Promise.all(years.map(async (y) => {
    addYear(await loadMap(y));
    done++;
    if (years.length > 2 && token === ctx.token) {
      ctx.summaryEl.textContent = `Loading map data: ${done} of ${years.length} years.`;
    }
  }));
}

async function refreshData() {
  const token = ++ctx.token;
  const s = getState();
  const wanted = ctx.scope === 'month' ? [s.selectedMonth] : monthsBetween(s.startMonth, s.endMonth);
  const sensor = sensorForPeriod(s.sensorView, wanted, ctx.viirs);
  const cov = sensor === 'VIIRS' ? ctx.viirs : ctx.modis;
  const months = wanted.filter((m) => cov && m >= cov.start && m <= cov.end);

  try {
    await ensureYears(months, token);
  } catch (err) {
    if (token !== ctx.token) return;
    console.error('[map]', err);
    ctx.summaryEl.textContent = `Map data could not be loaded: ${err.message}`;
    return;
  }
  if (token !== ctx.token) return; // a newer request replaced this one

  ctx.sensor = sensor;
  ctx.months = months;
  ctx.wanted = wanted;
  ctx.cells = collectCells(ctx.byMonth, months, sensor);
  ctx.cellIndex = new Map(ctx.cells.map((c) => [c.key, c]));
  for (const c of ctx.cells) {
    if (!ctx.districtOfCell.has(c.key)) ctx.districtOfCell.set(c.key, squareAreaAt(c.lon, c.lat, ctx.areas));
    c.district = ctx.districtOfCell.get(c.key);
  }
  const max = ctx.cells.reduce((a, c) => Math.max(a, c.count), 0);
  ctx.bins = binsFor(max, ctx.scope);
  if (ctx.selectedKey && !ctx.cellIndex.has(ctx.selectedKey)) ctx.selectedKey = null;

  ctx.overlayEl.hidden = months.length > 0;
  if (!months.length) {
    const name = sensor === 'VIIRS' ? 'VIIRS (Suomi NPP)' : 'MODIS';
    ctx.overlayEl.textContent = cov
      ? `No complete ${name} coverage for ${periodText(wanted)}. ${name} covers ${monthLabel(cov.start)} to ${monthLabel(cov.end)}.`
      : `No ${name} data in this export.`;
  }

  updateSummary();
  updateLegend();
  updateTopList();
  ctx.view?.setCells(ctx.cells, getState().areaId);
  refreshTooltip();
}

// ---------- Text ----------

function periodText(months) {
  if (!months.length) return 'this period';
  return months.length === 1 ? monthLabel(months[0]) : `${monthLabel(months[0])} to ${monthLabel(months.at(-1))}`;
}

function sensorName(sensor) {
  return sensor === 'VIIRS' ? 'VIIRS' : 'MODIS';
}

function sensorPlain(sensor) {
  return sensor === 'VIIRS' ? 'Newer satellite (VIIRS)' : 'Older satellite (MODIS)';
}

function updateSummary() {
  const s = getState();
  const total = ctx.cells.reduce((a, c) => a + c.count, 0);
  const area = ctx.areaNames.get(s.areaId) || s.areaId;
  const fmt = (n) => n.toLocaleString('en-GB');
  const has = ctx.months?.length > 0;
  const wanted = ctx.wanted || [];

  ctx.facts.sensor.textContent = sensorPlain(ctx.sensor);
  ctx.facts.period.textContent = has ? periodText(ctx.months) : periodText(wanted);
  ctx.facts.total.textContent = has ? fmt(total) : '-';
  ctx.facts.cells.textContent = has ? fmt(ctx.cells.length) : '-';

  const parts = [];
  parts.push(has
    ? `Darker squares had more hotspots. ${area} is outlined.`
    : `No map for ${periodText(wanted)}.`);
  if (ctx.scope === 'range' && has && ctx.months.length < wanted.length) {
    const other = ctx.sensor === 'VIIRS' ? 'Raw MODIS' : 'Raw VIIRS';
    parts.push(`This satellite only covers ${periodText(ctx.months)} of your dates; pick ${other} above to see the rest.`);
  }
  const text = parts.join(' ');
  ctx.summaryEl.textContent = text;
  ctx.view?.describe(`Map of Sarawak, ${sensorName(ctx.sensor)} detections, ${ctx.facts.period.textContent}. ${text}`);
}

function updateLegend() {
  const { bins } = ctx;
  const items = bins.map((_, i) => `
    <li><span class="map-swatch" style="background:var(--fire-${i + 1})"></span>${binLabel(i, bins)}</li>`).join('');
  const what = ctx.scope === 'month' ? 'Hotspots per square that month' : 'Hotspots per square over your dates';
  ctx.legendEl.innerHTML = `<p class="legend-title">${what}${ctx.viewName === '3d' ? ' (taller = more)' : ''}</p><ul>${items}</ul>`;
}

function updateTopList() {
  const s = getState();
  const top = [...ctx.cells]
    .filter((c) => inSelectedArea(s.areaId, c.district, ctx.divisionOf))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  ctx.topList.replaceChildren(...top.map((c) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'map-top-btn';
    b.textContent = `${placeName(c)}, ${coordText(c)}: ${c.count.toLocaleString('en-GB')} detections`;
    b.addEventListener('click', () => {
      ctx.selectedKey = c.key;
      ctx.view?.focusCell(c);
      showTooltip(c, ctx.view?.screenOf(c), true);
    });
    li.append(b);
    return li;
  }));
  if (!top.length) {
    const li = document.createElement('li');
    li.textContent = 'No detections in the highlighted area for this period.';
    ctx.topList.append(li);
  }
}

function coordText(c) {
  const ns = c.lat >= 0 ? 'N' : 'S';
  return `${Math.abs(c.lat).toFixed(3)}°${ns} ${c.lon.toFixed(3)}°E`;
}

function placeName(c) {
  if (c.district === 'sarawak') return 'Sarawak (outside the listed districts)';
  if (!c.district) return 'Square centre outside Sarawak';
  const n = ctx.districtNames.get(c.district) || c.district;
  const div = ctx.divisionOf.get(c.district);
  return div ? `${n} District, ${ctx.areaNames.get(div) || div}` : n;
}

// ---------- Tooltip ----------

function showTooltip(cell, at, pinned = false) {
  if (!cell || !at) return hideTooltip();
  const period = periodText(ctx.months || []);
  ctx.tooltipEl.innerHTML = '';
  const lines = [
    ['strong', placeName(cell)],
    ['span', `${cell.count.toLocaleString('en-GB')} hotspot${cell.count === 1 ? '' : 's'} in ${period}`],
    ['span', `Seen by the ${ctx.sensor === 'VIIRS' ? 'newer' : 'older'} satellite (${sensorName(ctx.sensor)})${cell.processing.has('nrt') ? ', provisional' : ''}`],
    ['span', `About 5 km square near ${coordText(cell)}`],
  ];
  for (const [tag, text] of lines) {
    const el = document.createElement(tag);
    el.textContent = text;
    ctx.tooltipEl.append(el);
  }
  ctx.tooltipEl.hidden = false;
  ctx.tooltipEl.dataset.pinned = pinned ? 'true' : 'false';
  const w = ctx.stage.clientWidth;
  const tw = ctx.tooltipEl.offsetWidth;
  const th = ctx.tooltipEl.offsetHeight;
  let x = at[0] + 14;
  let y = at[1] + 14;
  if (x + tw > w - 8) x = Math.max(8, at[0] - tw - 14);
  if (y + th > ctx.stage.clientHeight - 8) y = Math.max(8, at[1] - th - 14);
  ctx.tooltipEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

function hideTooltip() {
  if (ctx?.tooltipEl) ctx.tooltipEl.hidden = true;
}

function refreshTooltip() {
  const c = ctx.selectedKey && ctx.cellIndex.get(ctx.selectedKey);
  if (c) showTooltip(c, ctx.view?.screenOf(c), true);
  else hideTooltip();
}

// Hover/tap handler shared by both views. `pinned` = a click/tap or Enter.
function pointAt(cell, at, pinned) {
  if (pinned) {
    ctx.selectedKey = cell ? cell.key : null;
    ctx.view?.redraw();
  }
  if (cell) showTooltip(cell, at, pinned);
  else if (pinned || ctx.tooltipEl.dataset.pinned !== 'true') {
    if (!pinned && ctx.selectedKey) refreshTooltip();
    else hideTooltip();
  }
}

// ---------- View switching ----------

async function switchView(name, { initial = false } = {}) {
  const radios = ctx.root.querySelectorAll('input[name="map-view"]');
  if (ctx.view) ctx.view.destroy();
  ctx.view = null;
  hideTooltip();
  if (name === '3d') {
    try {
      ctx.view = await create3D();
      ctx.viewName = '3d';
    } catch (err) {
      console.warn('[map] 3D view unavailable:', err);
      ctx.hintEl.textContent = `The 3D view could not start (${err.message}). Showing the flat map.`;
      name = '2d';
    }
  }
  if (!ctx.view) {
    ctx.view = create2D();
    ctx.viewName = '2d';
    if (name === '2d' && !initial) ctx.hintEl.textContent = '';
  }
  radios.forEach((r) => { r.checked = r.value === ctx.viewName; });
  if (!initial) writePref(ctx.viewName);
  if (!ctx.hintEl.textContent || ctx.hintEl.dataset.auto === 'true') {
    ctx.hintEl.dataset.auto = 'true';
    ctx.hintEl.textContent = ctx.viewName === '3d' ? 'Drag to turn the map. Scroll or pinch to zoom.' : '';
  }
  ctx.view.setArea(getState().areaId, { instant: true });
  ctx.view.setCells(ctx.cells, getState().areaId);
  updateLegend();
  updateSummary();
}

function boundsOf(features) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const f of features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) for (const [lon, lat] of poly[0]) {
      const [x, y] = project(lon, lat);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  return { x0, y0, x1, y1 };
}

function featuresOfArea(areaId) {
  const f = ctx.areas.features;
  if (areaId === 'sarawak') {
    const outline = f.filter((x) => x.properties.id === 'sarawak');
    return outline.length ? outline : f;
  }
  if (areaId.startsWith('div:')) return f.filter((x) => x.properties.division === areaId);
  return f.filter((x) => x.properties.id === areaId);
}

function muted(hex, amount, toward) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const a = p(hex);
  const b = p(toward);
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * amount)).join(',')})`;
}

// ---------- 2D view ----------

function create2D() {
  const canvas = document.createElement('canvas');
  canvas.className = 'map-canvas';
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  ctx.stage.prepend(canvas);
  const g = canvas.getContext('2d');
  const C = ctx.colors;

  const paths = ctx.areas.features.map((f) => {
    const p = new Path2D();
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) for (const ring of poly) {
      ring.forEach(([lon, lat], i) => {
        const [x, y] = project(lon, lat);
        if (i === 0) p.moveTo(x, y); else p.lineTo(x, y);
      });
      p.closePath();
    }
    return { f, p, id: f.properties.id, division: f.properties.division };
  });
  const full = boundsOf(ctx.areas.features);

  let view = { cx: (full.x0 + full.x1) / 2, cy: (full.y0 + full.y1) / 2, scale: 100 };
  let areaId = getState().areaId;
  let cells = [];
  let w = 0, h = 0;
  let userMoved = false; // until the user pans or zooms, a resize re-fits the selected area
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  function resize() {
    const changed = w !== ctx.stage.clientWidth || h !== ctx.stage.clientHeight;
    w = ctx.stage.clientWidth;
    h = ctx.stage.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    if (changed && !userMoved && w && h) fit(boundsOf(featuresOfArea(areaId)));
    draw();
  }

  const toScreen = (x, y) => [(x - view.cx) * view.scale + w / 2, (y - view.cy) * view.scale + h / 2];
  const toWorld = (sx, sy) => [(sx - w / 2) / view.scale + view.cx, (sy - h / 2) / view.scale + view.cy];

  function fit(b, pad = 20) {
    const right = 60; // keep the zoom buttons clear of the area
    const bw = Math.max(b.x1 - b.x0, 0.2);
    const bh = Math.max(b.y1 - b.y0, 0.2);
    const scale = Math.min((w - pad - right) / bw, (h - pad * 2) / bh);
    view = { cx: (b.x0 + b.x1) / 2 + (right - pad) / 2 / scale, cy: (b.y0 + b.y1) / 2, scale };
  }

  function clampView() {
    const minScale = Math.min(w / (full.x1 - full.x0), h / (full.y1 - full.y0)) * 0.6;
    view.scale = Math.min(Math.max(view.scale, minScale), minScale * 60);
    view.cx = Math.min(Math.max(view.cx, full.x0), full.x1);
    view.cy = Math.min(Math.max(view.cy, full.y0), full.y1);
  }

  function draw() {
    if (!w || !h) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = C.haze;
    g.fillRect(0, 0, w, h);
    g.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * (w / 2 - view.cx * view.scale), dpr * (h / 2 - view.cy * view.scale));
    const px = 1 / view.scale;

    const selected = (p) => p.id !== 'sarawak' && inSelectedArea(areaId, p.id, ctx.divisionOf);
    // Land
    for (const p of paths) if (p.id === 'sarawak') { g.fillStyle = C.hazeDeep; g.fill(p.p, 'evenodd'); }
    for (const p of paths) {
      if (p.id === 'sarawak') continue;
      g.fillStyle = selected(p) ? C.landSelect : C.hazeDeep;
      g.fill(p.p, 'evenodd');
    }
    // Squares
    const cw = CELL * K;
    const ch = CELL;
    const minPx = 2.5 * px;
    for (const c of cells) {
      const [x, y] = project(c.lon, c.lat);
      const inside = inSelectedArea(areaId, c.district, ctx.divisionOf);
      const color = C.fire[binIndex(c.count, ctx.bins)];
      g.fillStyle = inside ? color : muted(color, 0.6, C.haze);
      const sw = Math.max(cw, minPx);
      const sh = Math.max(ch, minPx);
      g.fillRect(x - sw / 2, y - sh / 2, sw, sh);
    }
    // Boundaries
    g.lineJoin = 'round';
    for (const p of paths) {
      g.lineWidth = (p.id === 'sarawak' ? 1 : 0.75) * px;
      g.strokeStyle = C.peatSoft;
      g.stroke(p.p);
    }
    const sel = paths.filter((p) => (areaId === 'sarawak' ? p.id === 'sarawak' : selected(p)));
    g.lineWidth = 2 * px;
    g.strokeStyle = C.blackwater;
    for (const p of sel) g.stroke(p.p);
    // Selected square
    const s = ctx.selectedKey && ctx.cellIndex.get(ctx.selectedKey);
    if (s) {
      const [x, y] = project(s.lon, s.lat);
      const sw = Math.max(cw, minPx);
      const sh = Math.max(ch, minPx);
      g.lineWidth = 2 * px;
      g.strokeStyle = C.blackwater;
      g.strokeRect(x - sw / 2 - px, y - sh / 2 - px, sw + 2 * px, sh + 2 * px);
    }
    // District labels for the highlighted area
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.font = `600 12px ${css('--font-body')}`;
    g.textAlign = 'center';
    g.fillStyle = C.peat;
    if (areaId !== 'sarawak') {
      for (const p of paths.filter(selected)) {
        const b = boundsOf([p.f]);
        const bw = (b.x1 - b.x0) * view.scale;
        if (bw < 50) continue;
        const [sx, sy] = toScreen((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
        g.lineWidth = 3;
        g.strokeStyle = C.haze;
        g.strokeText(p.f.properties.name, sx, sy);
        g.fillText(p.f.properties.name, sx, sy);
      }
    }
  }

  function cellAtScreen(sx, sy) {
    const [x, y] = toWorld(sx, sy);
    const [lon, lat] = unproject(x, y);
    const key = cellKey((Math.floor(lon / CELL) + 0.5) * CELL, (Math.floor(lat / CELL) + 0.5) * CELL);
    const hit = ctx.cellIndex.get(key);
    if (hit) return hit;
    // Squares are drawn at least 2.5 px wide when zoomed out; allow picking within that.
    const tol = 3 / view.scale;
    let best = null;
    let bestD = Infinity;
    for (const c of cells) {
      const [cx, cy] = project(c.lon, c.lat);
      const d = Math.max(Math.abs(cx - x), Math.abs(cy - y));
      if (d < tol && d < bestD) { best = c; bestD = d; }
    }
    return best;
  }

  // Pointer: drag to pan, two fingers to pinch, tap/click to pin a square, hover for a tooltip.
  const pointers = new Map();
  let drag = null;
  let pinch = null;
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    if (pointers.size === 1) drag = { start: local(e), view: { ...view }, moved: false };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), view: { ...view }, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
      drag = null;
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = local(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const anchor = toWorldFrom(pinch.view, pinch.mid);
      userMoved = true;
      view.scale = pinch.view.scale * (d / pinch.d);
      clampView();
      view.cx = anchor[0] - (pinch.mid[0] - w / 2) / view.scale;
      view.cy = anchor[1] - (pinch.mid[1] - h / 2) / view.scale;
      clampView();
      draw();
      return;
    }
    if (drag) {
      const dx = p[0] - drag.start[0];
      const dy = p[1] - drag.start[1];
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) {
        userMoved = true;
        view.cx = drag.view.cx - dx / view.scale;
        view.cy = drag.view.cy - dy / view.scale;
        clampView();
        draw();
        hideTooltip();
      }
      return;
    }
    if (e.pointerType === 'mouse') {
      const c = cellAtScreen(p[0], p[1]);
      canvas.style.cursor = c ? 'pointer' : 'grab';
      pointAt(c, p, false);
    }
  });
  const end = (e) => {
    const wasTap = drag && !drag.moved && pointers.size === 1;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (wasTap) {
      const p = local(e);
      pointAt(cellAtScreen(p[0], p[1]), p, true);
    }
    if (!pointers.size) drag = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); drag = null; pinch = null; });
  canvas.addEventListener('pointerleave', () => { if (ctx.tooltipEl.dataset.pinned !== 'true') hideTooltip(); });

  function toWorldFrom(v, [sx, sy]) {
    return [(sx - w / 2) / v.scale + v.cx, (sy - h / 2) / v.scale + v.cy];
  }

  function zoomAt(factor, [sx, sy] = [w / 2, h / 2]) {
    userMoved = true;
    const before = toWorld(sx, sy);
    view.scale *= factor;
    clampView();
    view.cx = before[0] - (sx - w / 2) / view.scale;
    view.cy = before[1] - (sy - h / 2) / view.scale;
    clampView();
    draw();
    refreshTooltip();
  }

  // Ctrl/Cmd + wheel zooms (trackpad pinch sends this too); a plain wheel scrolls the page.
  canvas.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) {
      ctx.hintEl.dataset.auto = 'false';
      ctx.hintEl.textContent = 'To zoom the map, hold Ctrl and scroll, pinch, or use the + and - buttons.';
      return;
    }
    e.preventDefault();
    zoomAt(Math.exp(-e.deltaY * 0.0025), local(e));
  }, { passive: false });
  canvas.addEventListener('dblclick', (e) => zoomAt(2, local(e)));

  canvas.addEventListener('keydown', (e) => {
    const step = 80 / view.scale;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      userMoved = true;
      view.cx += moves[e.key][0];
      view.cy += moves[e.key][1];
      clampView();
      draw();
      refreshTooltip();
    } else if (e.key === '+' || e.key === '=') zoomAt(1.5);
    else if (e.key === '-' || e.key === '_') zoomAt(1 / 1.5);
    else if (e.key === '0') api.fitArea(areaId);
    else if (e.key === 'Enter' || e.key === ' ') {
      const c = cellAtScreen(w / 2, h / 2) || nearestTo(toWorld(w / 2, h / 2));
      if (c) { api.focusCell(c); pointAt(c, api.screenOf(c), true); }
    } else return;
    e.preventDefault();
  });

  function nearestTo([x, y]) {
    let best = null;
    let bestD = Infinity;
    for (const c of cells) {
      if (!inSelectedArea(areaId, c.district, ctx.divisionOf)) continue;
      const [cx, cy] = project(c.lon, c.lat);
      const d = Math.hypot(cx - x, cy - y);
      if (d < bestD) { best = c; bestD = d; }
    }
    return best;
  }

  const ro = new ResizeObserver(() => resize());
  ro.observe(ctx.stage);
  resize();

  const api = {
    setCells(next, area) { cells = next; areaId = area; draw(); },
    setArea(id) {
      areaId = id;
      api.fitArea(id);
    },
    fitArea(id) {
      if (!w) resize();
      userMoved = false;
      fit(boundsOf(featuresOfArea(id)));
      clampView();
      draw();
      refreshTooltip();
    },
    zoomBy(f) { zoomAt(f); },
    focusCell(c) {
      userMoved = true;
      const [x, y] = project(c.lon, c.lat);
      view.cx = x;
      view.cy = y;
      if (view.scale < 600) view.scale = 600;
      clampView();
      draw();
    },
    screenOf(c) { return toScreen(...project(c.lon, c.lat)); },
    redraw() { draw(); },
    describe(text) { canvas.setAttribute('aria-label', text); },
    destroy() { ro.disconnect(); canvas.remove(); },
  };
  return api;
}

// ---------- 3D view (Three.js, optional) ----------

async function create3D() {
  const probe = document.createElement('canvas');
  if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) throw new Error('WebGL is turned off or not supported');
  const THREE = await import('three');
  const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
  const C = ctx.colors;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(new THREE.Color(C.haze));
  const canvas = renderer.domElement;
  canvas.className = 'map-canvas';
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  ctx.stage.prepend(canvas);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(C.haze);
  scene.fog = new THREE.Fog(new THREE.Color(C.haze), 8, 22);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(-4, 8, -3);
  scene.add(sun);

  const controls = new OrbitControls(camera, canvas);
  controls.maxPolarAngle = 1.25;
  controls.minDistance = 0.4;
  controls.maxDistance = 14;
  controls.listenToKeyEvents(canvas);
  controls.keyPanSpeed = 20;

  // Land: shapes in (x, north) so that after rotateX(-90deg) they lie in x/z with z = south.
  const LAND_H = 0.03;
  const AREA_H = 0.055;
  const shapesOf = (f) => {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    return polys.map(([outer, ...holes]) => {
      const toV = (ring) => ring.map(([lon, lat]) => { const [x, y] = project(lon, lat); return new THREE.Vector2(x, -y); });
      const s = new THREE.Shape(toV(outer));
      s.holes = holes.map((hRing) => new THREE.Path(toV(hRing)));
      return s;
    });
  };
  const disposables = [];
  const slab = (shapes, depth, color) => {
    const geo = new THREE.ExtrudeGeometry(shapes, { depth, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(color) });
    disposables.push(geo, mat);
    return new THREE.Mesh(geo, mat);
  };
  const outline = ctx.areas.features.find((f) => f.properties.id === 'sarawak');
  const landShapes = outline ? shapesOf(outline) : ctx.areas.features.flatMap(shapesOf);
  scene.add(slab(landShapes, LAND_H, C.hazeDeep));

  // District edges as lines just above the land.
  const linePts = [];
  for (const f of ctx.areas.features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) for (const ring of poly) {
      for (let i = 1; i < ring.length; i++) {
        const [ax, ay] = project(...ring[i - 1]);
        const [bx, by] = project(...ring[i]);
        linePts.push(ax, LAND_H + 0.002, ay, bx, LAND_H + 0.002, by);
      }
    }
  }
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePts, 3));
  const lineMat = new THREE.LineBasicMaterial({ color: new THREE.Color(C.peatSoft) });
  disposables.push(lineGeo, lineMat);
  scene.add(new THREE.LineSegments(lineGeo, lineMat));

  let areaGroup = null;
  function buildArea(id) {
    if (areaGroup) {
      scene.remove(areaGroup);
      areaGroup.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    }
    areaGroup = new THREE.Group();
    if (id !== 'sarawak') {
      const feats = featuresOfArea(id);
      const mesh = slab(feats.flatMap(shapesOf), AREA_H, C.landSelect);
      disposables.pop(); disposables.pop(); // owned by areaGroup, disposed above
      areaGroup.add(mesh);
      const pts = [];
      for (const f of feats) {
        const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
        for (const poly of polys) for (let i = 1; i < poly[0].length; i++) {
          const [ax, ay] = project(...poly[0][i - 1]);
          const [bx, by] = project(...poly[0][i]);
          pts.push(ax, AREA_H + 0.003, ay, bx, AREA_H + 0.003, by);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      areaGroup.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: new THREE.Color(C.blackwater) })));
    }
    scene.add(areaGroup);
  }

  // Columns: ONE InstancedMesh for every square.
  const colGeo = new THREE.BoxGeometry(CELL * K * 0.85, 1, CELL * 0.85);
  colGeo.translate(0, 0.5, 0);
  const colMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  disposables.push(colGeo, colMat);
  let columns = null;
  let cells = [];
  let areaId = getState().areaId;
  const tmp = new THREE.Object3D();
  const color = new THREE.Color();

  function heightOf(count, max) {
    // Month: fixed scale so months compare (100 detections = 0.6 units). Range: scaled to the busiest square.
    return ctx.scope === 'month' ? 0.02 + 0.06 * Math.sqrt(count) : 0.02 + 0.7 * Math.sqrt(count / Math.max(max, 1));
  }

  function buildColumns() {
    if (columns) { scene.remove(columns); columns.dispose(); }
    columns = new THREE.InstancedMesh(colGeo, colMat, Math.max(cells.length, 1));
    columns.count = cells.length;
    const max = cells.reduce((a, c) => Math.max(a, c.count), 0);
    cells.forEach((c, i) => {
      const [x, y] = project(c.lon, c.lat);
      const base = inSelectedArea(areaId, c.district, ctx.divisionOf) && areaId !== 'sarawak' ? AREA_H : LAND_H;
      tmp.position.set(x, base, y);
      tmp.scale.set(1, heightOf(c.count, max), 1);
      tmp.updateMatrix();
      columns.setMatrixAt(i, tmp.matrix);
      const hex = C.fire[binIndex(c.count, ctx.bins)];
      const inside = inSelectedArea(areaId, c.district, ctx.divisionOf);
      color.set(inside ? hex : muted(hex, 0.6, C.haze));
      if (c.key === ctx.selectedKey) color.set(C.blackwater);
      columns.setColorAt(i, color);
    });
    columns.instanceMatrix.needsUpdate = true;
    if (columns.instanceColor) columns.instanceColor.needsUpdate = true;
    scene.add(columns);
    render();
  }

  let w = 0, h = 0;
  function resize() {
    w = ctx.stage.clientWidth;
    h = ctx.stage.clientHeight;
    renderer.setSize(w, h, true);
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
    render();
  }
  function render() { if (w && h) renderer.render(scene, camera); }
  controls.addEventListener('change', render);

  function fitArea(id) {
    const b = boundsOf(featuresOfArea(id));
    const cx = (b.x0 + b.x1) / 2;
    const cz = (b.y0 + b.y1) / 2;
    const size = Math.max(b.x1 - b.x0, (b.y1 - b.y0) * (w / Math.max(h, 1)), 0.3);
    const dist = Math.min(size * 2.4 + 0.8, 12);
    controls.target.set(cx, 0, cz);
    camera.position.set(cx, dist * 0.8, cz + dist * 0.75);
    controls.update();
    render();
  }

  // Hover and tap via raycasting the instanced columns.
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function pick(e) {
    const r = canvas.getBoundingClientRect();
    const at = [e.clientX - r.left, e.clientY - r.top];
    ndc.set((at[0] / r.width) * 2 - 1, -(at[1] / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = columns ? ray.intersectObject(columns, false)[0] : null;
    return { cell: hit ? cells[hit.instanceId] : null, at };
  }
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', (e) => {
    if (down && Math.abs(e.clientX - down[0]) + Math.abs(e.clientY - down[1]) < 5) {
      const { cell, at } = pick(e);
      pointAt(cell, at, true);
      buildColumns();
    }
    down = null;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || e.buttons) return;
    const { cell, at } = pick(e);
    canvas.style.cursor = cell ? 'pointer' : 'grab';
    pointAt(cell, at, false);
  });
  controls.addEventListener('start', () => { if (ctx.tooltipEl.dataset.pinned !== 'true') hideTooltip(); });
  controls.addEventListener('end', () => refreshTooltip());

  const ro = new ResizeObserver(() => resize());
  ro.observe(ctx.stage);
  resize();
  buildArea(areaId);

  return {
    setCells(next, area) { cells = next; areaId = area; buildColumns(); },
    setArea(id) { areaId = id; buildArea(id); fitArea(id); buildColumns(); },
    fitArea,
    zoomBy(f) {
      const offset = camera.position.clone().sub(controls.target).multiplyScalar(1 / f);
      camera.position.copy(controls.target).add(offset);
      controls.update();
      render();
      refreshTooltip();
    },
    focusCell(c) {
      const [x, y] = project(c.lon, c.lat);
      const offset = camera.position.clone().sub(controls.target);
      if (offset.length() > 2.5) offset.setLength(2.5);
      controls.target.set(x, 0, y);
      camera.position.copy(controls.target).add(offset);
      controls.update();
      buildColumns();
    },
    screenOf(c) {
      const [x, y] = project(c.lon, c.lat);
      const v = new THREE.Vector3(x, 0.1, y).project(camera);
      return [((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h];
    },
    redraw() { buildColumns(); },
    describe(text) { canvas.setAttribute('aria-label', text); },
    destroy() {
      ro.disconnect();
      controls.dispose();
      if (columns) columns.dispose();
      if (areaGroup) areaGroup.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
      for (const d of disposables) d.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}
