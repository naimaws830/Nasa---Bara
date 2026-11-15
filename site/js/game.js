// Commander mode (G-01): a practice game on past months. Place 5 patrol trucks on the 3D map, then see how
// many of that month's real hotspots were within 5 km of a truck, next to the best possible placement.
// It is historical training, not advice for real patrols.
//
// The pure functions at the top (distances, scoring, best placement) have no DOM or WebGL, so they are tested
// in Node against the real data. mount() builds the page; Three.js is loaded only there.

import { loadAreas, loadCalendar, loadMap, loadMeta, isMock } from './data.js';
import {
  CELL, fitDistance, project, sensorCoverage, sensorFor, squareAreaAt, unproject, inSelectedArea,
} from './map.js';
import { fmtCount, monthLabel } from './series.js';

export const TRUCKS = 5;
export const RADIUS_KM = 20;
export const CLUSTER_KM = 10; // hotspot squares this close together form one fire area
export const WORST_AREAS = 5;
const EARTH_KM = 6371.0088;

// ---------- Pure helpers (tested) ----------

/** Great-circle distance in km between two lon/lat points. */
export function distanceKm(lon1, lat1, lon2, lat2) {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Hotspot squares of one month and sensor inside an area. mapJson: map/<year>.json.
 * Returns [{ key, lon, lat, count }]; a square belongs to the area it mostly lies in (as on the map).
 */
export function gameCells(mapJson, month, sensor, areaId, areas, divisionOf) {
  const mm = Number(month.slice(5, 7));
  const out = [];
  for (const c of mapJson.cells) {
    if (c.month !== mm || c.sensor !== sensor) continue;
    // The map files hold only hotspots inside Sarawak, so "all of Sarawak" keeps every square (even a coastal
    // one whose centre is in the sea); other areas keep the squares that mostly lie in them.
    if (areaId !== 'sarawak') {
      const district = squareAreaAt(c.lon, c.lat, areas);
      if (!district || !inSelectedArea(areaId, district, divisionOf)) continue;
    }
    out.push({ key: `${c.lon.toFixed(3)},${c.lat.toFixed(3)}`, lon: c.lon, lat: c.lat, count: c.count });
  }
  return out;
}

/** Share of hotspots within radius of any truck. trucks: [{lon, lat}]. */
export function coverage(trucks, cells, radiusKm = RADIUS_KM) {
  let covered = 0;
  let total = 0;
  const coveredKeys = new Set();
  for (const c of cells) {
    total += c.count;
    if (trucks.some((t) => distanceKm(t.lon, t.lat, c.lon, c.lat) <= radiusKm)) {
      covered += c.count;
      coveredKeys.add(c.key);
    }
  }
  return { covered, total, share: total ? covered / total : 0, coveredKeys };
}

/**
 * Best possible placement by the greedy rule: place trucks one at a time, each where it covers the most
 * hotspots not yet covered. Candidate spots are the hotspot squares themselves.
 */
export function bestPlacement(cells, k = TRUCKS, radiusKm = RADIUS_KM) {
  const near = cells.map((a) => cells.map((b, j) => (distanceKm(a.lon, a.lat, b.lon, b.lat) <= radiusKm ? j : -1))
    .filter((j) => j >= 0));
  const taken = new Array(cells.length).fill(false);
  const trucks = [];
  for (let t = 0; t < k; t++) {
    let best = -1;
    let gain = 0;
    near.forEach((list, i) => {
      const g = list.reduce((s, j) => s + (taken[j] ? 0 : cells[j].count), 0);
      if (g > gain) { gain = g; best = i; }
    });
    if (best < 0) break;
    for (const j of near[best]) taken[j] = true;
    trucks.push({ lon: cells[best].lon, lat: cells[best].lat });
  }
  return { trucks, ...coverage(trucks, cells, radiusKm) };
}

/** Default month: the month with the most hotspots in the area (harmonized calendar). */
export function worstMonth(cal) {
  let best = null;
  cal.months.forEach((m, i) => {
    const v = cal.harmonizedCount[i];
    if (v != null && (best == null || v > cal.harmonizedCount[best])) best = i;
  });
  return best == null ? cal.months.at(-1) : cal.months[best];
}

/**
 * The worst fire areas of the month: starting from the hottest square, squares within clusterKm of it are
 * grouped into one area; areas are ranked by total hotspots. Returns [{ rank, lon, lat, peak, count, squares,
 * keys }], where lon/lat is the area's hottest square, the spot a truck drives to.
 */
export function fireAreas(cells, k = WORST_AREAS, clusterKm = CLUSTER_KM) {
  const order = [...cells].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const used = new Set();
  const areas = [];
  for (const seed of order) {
    if (used.has(seed.key)) continue;
    const members = order.filter((c) => !used.has(c.key) && distanceKm(seed.lon, seed.lat, c.lon, c.lat) <= clusterKm);
    for (const c of members) used.add(c.key);
    const count = members.reduce((t, c) => t + c.count, 0);
    // The truck drives to the area's hottest square (its darkest stack): the seed, as cells are sorted by count.
    areas.push({ lon: seed.lon, lat: seed.lat, peak: seed.count, count, squares: members.length,
      keys: members.map((c) => c.key) });
  }
  return areas.sort((a, b) => b.count - a.count).slice(0, k).map((a, i) => ({ rank: i + 1, ...a }));
}

/**
 * Send trucks to the fire areas, worst area first. Each area gets the nearest truck that is still free; a
 * truck that has been sent is busy, so two bad areas close together get two different trucks, even if the
 * second one has to come from more than RADIUS_KM away. One truck per area. Straight-line km.
 * Returns { legs: [{area, truck, km, outside}], avgKm }; legs are in area rank order.
 */
export function dispatch(trucks, areas) {
  const busy = new Set();
  const legs = [...areas].sort((a, b) => a.rank - b.rank).map((area) => {
    let truck = -1;
    let km = Infinity;
    trucks.forEach((t, i) => {
      if (busy.has(i)) return;
      const d = distanceKm(t.lon, t.lat, area.lon, area.lat);
      if (d < km) { km = d; truck = i; }
    });
    if (truck >= 0) busy.add(truck);
    return { area, truck, km: truck >= 0 ? km : null, outside: truck >= 0 && km > RADIUS_KM };
  });
  const sent = legs.filter((l) => l.truck >= 0);
  return { legs, avgKm: sent.length ? sent.reduce((t, l) => t + l.km, 0) / sent.length : 0 };
}

export function fmtKm(km) {
  return km < 1 ? 'under 1 km' : `${Math.round(km).toLocaleString('en-GB')} km`;
}

/** Main score sentence: how far the trucks had to go to the worst fire areas. */
export function scoreSentence(myKm, bestKm, n = WORST_AREAS) {
  return `Your trucks reached the ${n} worst fire areas in an average of ${fmtKm(myKm)}. `
    + `The plan that covers the most hotspots: ${fmtKm(bestKm)}.`;
}

/** Second score: share of hotspots within RADIUS_KM of a truck. */
export function coverageSentence(mine, best, radiusKm = RADIUS_KM) {
  const pct = (x) => `${Math.round(x * 100)}%`;
  return `Within ${radiusKm} km of a truck: ${pct(mine)} of hotspots (best possible: ${pct(best)}).`;
}

function listAnd(items) {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/**
 * "What happened": the round in a few everyday sentences, built only from the round's numbers.
 * trip / planTrip: dispatch() of the player's trucks and of the coverage plan; mine / plan: coverage().
 */
export function roundSummary({ trip, planTrip, mine, plan, radiusKm = RADIUS_KM }) {
  const out = [];
  const my = trip.avgKm;
  const other = planTrip.avgKm;
  if (my < other * 0.8) {
    out.push(`Your trucks got to the worst fires faster than the computer's plan (${fmtKm(my)} against ${fmtKm(other)} on average).`);
  } else if (my <= other * 1.2) {
    out.push(`Your trucks got to the worst fires about as fast as the computer's plan (${fmtKm(my)} against ${fmtKm(other)} on average).`);
  } else {
    out.push(`Your trucks took longer to get to the worst fires than the computer's plan (${fmtKm(my)} against ${fmtKm(other)} on average).`);
  }
  const first = trip.legs.find((l) => l.area.rank === 1 && l.truck >= 0);
  if (first) {
    out.push(first.km <= radiusKm
      ? `The worst fire area, with ${fmtCount(first.area.count)} hotspots, was only ${fmtKm(first.km)} from a truck.`
      : `The worst fire area, with ${fmtCount(first.area.count)} hotspots, had no truck nearby: the nearest was ${fmtKm(first.km)} away.`);
  }
  const far = trip.legs.filter((l) => l.outside && l.area.rank !== 1);
  if (far.length) {
    out.push(`${far.length === 1 ? 'Fire area' : 'Fire areas'} ${listAnd(far.map((l) => l.area.rank))} had no truck nearby, `
      + `so ${far.length === 1 ? 'a truck' : 'trucks'} came from ${listAnd(far.map((l) => fmtKm(l.km)))} away.`);
  }
  const pctMine = Math.round(mine.share * 100);
  const pctPlan = Math.round(plan.share * 100);
  out.push(`Your trucks were within ${radiusKm} km of ${pctMine} out of 100 hotspots${pctPlan > pctMine ? ` (computer plan: ${pctPlan})` : ''}.`);
  const longest = trip.legs.filter((l) => l.truck >= 0).reduce((a, b) => (a && a.km >= b.km ? a : b), null);
  if (far.length || (first && first.km > radiusKm)) {
    out.push(`Tip: put a truck closer to fire area ${longest.area.rank}, the longest trip.`);
  } else if (pctPlan - pctMine >= 10) {
    out.push('Tip: spread your trucks out a little to cover more of the smaller fires.');
  } else {
    out.push('Well placed: every worst fire area had a truck nearby.');
  }
  return out;
}

// ---------- Page ----------

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export async function mount(root) {
  const [meta, areas] = await Promise.all([loadMeta(), loadAreas()]);
  const params = new URLSearchParams(window.location.search);
  const ids = new Set(meta.areas.map((a) => a.id));
  const divisionOf = new Map(areas.features.filter((f) => f.properties.division)
    .map((f) => [f.properties.id, f.properties.division]));
  const viirs = sensorCoverage(meta.sensorProducts || [], 'VIIRS');
  const g = {
    meta, areas, divisionOf, viirs,
    areaId: ids.has(params.get('area')) ? params.get('area') : meta.defaultArea,
    month: null, sensor: 'VIIRS', cells: [], trucks: [], scored: null, view: null,
  };

  root.innerHTML = `
    <section class="panel game-panel">
      <div class="game-head">
        <div>
          <p class="eyebrow">Commander mode</p>
          <h2 class="panel-heading" id="g-title">Where would you send 5 fire trucks?</h2>
          <p class="game-lead">Pick a past month and place 5 trucks where you think fires will be. Then the month's real
            hotspots appear. Starting with the worst fire area, each of the ${WORST_AREAS} worst areas gets its nearest free truck:
            one truck per area, so a busy truck can't go twice. Shorter trips mean a faster response.</p>
        </div>
        <div class="game-pick">
          <div class="field"><label for="g-area">Area</label><select id="g-area"></select></div>
          <div class="field"><label for="g-month">Month</label>
            <div class="stepper"><input type="month" id="g-month" min="${meta.coverage.start}" max="${meta.lastCompleteMonth}">
              <button type="button" class="button" id="g-worst">Worst month</button></div></div>
        </div>
      </div>
      <p class="game-month-note small-text" id="g-note"></p>
      <div class="game-stage" id="g-stage">
        <p class="game-overlay" id="g-overlay" hidden></p>
      </div>
      <div class="game-bar">
        <p class="game-count" id="g-count" aria-live="polite"></p>
        <div class="game-buttons">
          <button type="button" class="pixel-button" id="g-undo">Remove last truck</button>
          <button type="button" class="pixel-button pixel-button-primary" id="g-check" disabled>Check my patrols</button>
        </div>
      </div>
      <section class="game-score" id="g-score" hidden aria-live="polite">
        <div class="meaning game-summary" id="g-summary"><p class="meaning-label">What happened</p><div id="g-summary-text"></div></div>
        <p class="game-score-number" id="g-score-number"></p>
        <p class="game-score-text" id="g-score-text"></p>
        <p class="game-score-cover" id="g-score-cover"></p>
        <ol class="game-legs small-text" id="g-legs"></ol>
        <p class="small-text" id="g-score-detail"></p>
        <div class="game-buttons">
          <label class="game-toggle"><input type="checkbox" id="g-show-best"> Show the plan that covers the most hotspots</label>
          <button type="button" class="pixel-button" id="g-again">Try again</button>
        </div>
      </section>
      <p class="small-text game-help">Click the land inside the highlighted area to place a truck (the circle shows ${RADIUS_KM} km around it);
        click a truck to remove it.
        Drag to turn the map, scroll or pinch to zoom. With the map selected, arrow keys move the white marker and Enter places a truck.</p>
      <p class="small-text game-note">Practice with past satellite records only. It is not advice for where to send real patrols.
        Distances are straight lines; real routes by road or river are longer.</p>
    </section>`;
  const $ = (id) => root.querySelector(`#${id}`);
  Object.assign(g, {
    root, title: $('g-title'), note: $('g-note'), stage: $('g-stage'), overlay: $('g-overlay'),
    count: $('g-count'), checkBtn: $('g-check'), undoBtn: $('g-undo'), score: $('g-score'),
  });

  // Area choices: Sarawak, divisions, districts.
  const sel = $('g-area');
  for (const a of meta.areas.filter((x) => x.type === 'sarawak')) sel.append(new Option(a.name, a.id));
  for (const div of meta.areas.filter((x) => x.type === 'division')) {
    const grp = document.createElement('optgroup');
    grp.label = div.name;
    grp.append(new Option(`${div.name}, all districts`, div.id));
    for (const d of meta.areas.filter((x) => x.division === div.id)) grp.append(new Option(d.name, d.id));
    sel.append(grp);
  }
  sel.value = g.areaId;

  sel.addEventListener('change', async () => {
    g.areaId = sel.value;
    await setMonth(g, null);
  });
  $('g-month').addEventListener('change', (e) => {
    const v = e.target.value;
    if (/^\d{4}-\d{2}$/.test(v) && v >= meta.coverage.start && v <= meta.lastCompleteMonth) setMonth(g, v);
  });
  $('g-worst').addEventListener('click', () => setMonth(g, null));
  g.undoBtn.addEventListener('click', () => { g.trucks.pop(); afterTrucksChanged(g); });
  g.checkBtn.addEventListener('click', () => check(g));
  $('g-again').addEventListener('click', () => { g.trucks = []; g.scored = null; $('g-show-best').checked = false; afterTrucksChanged(g); });
  $('g-show-best').addEventListener('change', (e) => {
    if (!g.scored) return;
    g.view?.showBest(e.target.checked ? g.scored.best.trucks : [], e.target.checked ? g.scored.bestTrip.legs : []);
  });

  try {
    g.view = await create3D(g);
  } catch (err) {
    console.warn('[Commander] 3D unavailable:', err);
    g.overlay.hidden = false;
    g.overlay.textContent = `Commander mode needs 3D graphics (WebGL), which this browser could not start: ${err.message}`;
    g.checkBtn.disabled = true;
    g.undoBtn.disabled = true;
    return;
  }
  await setMonth(g, ids.has(params.get('area')) && /^\d{4}-\d{2}$/.test(params.get('month') || '') ? params.get('month') : null);
}

async function setMonth(g, month) {
  const cal = await loadCalendar(g.areaId);
  g.month = month || worstMonth(cal);
  g.root.querySelector('#g-month').value = g.month;
  g.sensor = sensorFor('harmonized', g.month, g.viirs);
  const map = await loadMap(Number(g.month.slice(0, 4)));
  g.cells = gameCells(map, g.month, g.sensor, g.areaId, g.areas, g.divisionOf);
  g.trucks = [];
  g.scored = null;
  g.root.querySelector('#g-show-best').checked = false;
  const name = g.meta.areas.find((a) => a.id === g.areaId)?.name ?? g.areaId;
  g.areaName = name;
  const total = g.cells.reduce((s, c) => s + c.count, 0);
  const sat = g.sensor === 'VIIRS' ? 'the newer satellite (VIIRS)' : 'the older satellite (MODIS)';
  g.note.textContent = total
    ? `${monthLabel(g.month)} in ${name}: ${fmtCount(total)} hotspots were seen from space by ${sat}. They stay hidden until you check.`
    : `${monthLabel(g.month)} in ${name}: no hotspots were seen. Pick another month, or press "Worst month".`;
  g.view.setArea(g.areaId);
  afterTrucksChanged(g);
}

function afterTrucksChanged(g) {
  if (g.scored && g.trucks.length < TRUCKS) g.scored = null;
  const n = g.trucks.length;
  const hasFires = g.cells.length > 0;
  g.count.textContent = g.scored ? `${TRUCKS} trucks placed.` : `Trucks placed: ${n} of ${TRUCKS}.${n === TRUCKS ? ' Ready to check.' : ''}`;
  g.checkBtn.disabled = !hasFires || n < TRUCKS || !!g.scored;
  g.undoBtn.disabled = n === 0 || !!g.scored;
  g.score.hidden = !g.scored;
  g.view.setTrucks(g.trucks);
  g.view.setFires(g.scored ? g.cells : []);
  if (!g.scored) g.view.showBest([], []);
}

function check(g) {
  if (g.trucks.length < TRUCKS || !g.cells.length) return;
  const mine = coverage(g.trucks, g.cells);
  const best = bestPlacement(g.cells);
  const areasHit = fireAreas(g.cells);
  const trip = dispatch(g.trucks, areasHit);
  const bestTrip = dispatch(best.trucks, areasHit);
  g.scored = { mine, best, trip, bestTrip };
  g.root.querySelector('#g-score-number').textContent = fmtKm(trip.avgKm);
  g.root.querySelector('#g-score-text').textContent = scoreSentence(trip.avgKm, bestTrip.avgKm, areasHit.length);
  g.root.querySelector('#g-score-cover').textContent = coverageSentence(mine.share, best.share);
  g.root.querySelector('#g-summary-text').replaceChildren(...roundSummary({ trip, planTrip: bestTrip, mine, plan: best })
    .map((line) => el('p', line.startsWith('Tip:') || line.startsWith('Well placed') ? 'meaning-text game-tip' : 'meaning-text', line)));
  const legs = g.root.querySelector('#g-legs');
  legs.replaceChildren(...trip.legs.map((l) => el('li', null,
    l.truck < 0 ? `Fire area ${l.area.rank} (${fmtCount(l.area.count)} hotspots): no free truck.`
      : `Fire area ${l.area.rank} (${fmtCount(l.area.count)} hotspots): truck ${l.truck + 1} drove ${fmtKm(l.km)}`
        + `${l.outside ? `, from outside its ${RADIUS_KM} km circle` : ''}.`)));
  g.root.querySelector('#g-score-detail').textContent = `${monthLabel(g.month)}, ${g.areaName}: ${fmtCount(mine.total)} hotspots. `
    + `Taller, darker stacks had more hotspots. Distances are straight lines.`;
  afterTrucksChanged(g);
  g.view.drive(trip.legs);
}

// ---------- 3D scene ----------

const LAND_H = 0.03;
const AREA_H = 0.055;
const BLOCK_H = 0.014;
const KM_PER_UNIT = 111.2; // 1 map unit = 1 degree of latitude

async function create3D(g) {
  const probe = document.createElement('canvas');
  if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) throw new Error('WebGL is turned off or not supported');
  const THREE = await import('three');
  const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
  const C = {
    haze: css('--haze'), hazeDeep: css('--haze-deep'), peat: css('--peat'), peatSoft: css('--peat-soft'),
    blackwater: css('--blackwater'), landSelect: css('--land-select') || '#C2CBBF',
    fire: [1, 2, 3, 4, 5, 6].map((i) => css(`--fire-${i}`)),
  };
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const canvas = renderer.domElement;
  canvas.className = 'game-canvas';
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'application');
  canvas.setAttribute('aria-label', 'Map for placing fire trucks. Arrow keys move the marker, Enter places a truck.');
  g.stage.prepend(canvas);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(C.haze);
  scene.fog = new THREE.Fog(new THREE.Color(C.haze), 6, 18);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(-4, 8, -3);
  scene.add(sun);
  const controls = new OrbitControls(camera, canvas);
  controls.maxPolarAngle = 1.2;
  controls.minDistance = 0.3;
  controls.maxDistance = 12;

  const shapesOf = (f) => {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    return polys.map(([outer, ...holes]) => {
      const toV = (ring) => ring.map(([lon, lat]) => { const [x, y] = project(lon, lat); return new THREE.Vector2(x, -y); });
      const s = new THREE.Shape(toV(outer));
      s.holes = holes.map((h) => new THREE.Path(toV(h)));
      return s;
    });
  };
  const slab = (shapes, depth, color) => {
    const geo = new THREE.ExtrudeGeometry(shapes, { depth, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: new THREE.Color(color) }));
  };
  const outline = g.areas.features.find((f) => f.properties.id === 'sarawak');
  scene.add(slab(outline ? shapesOf(outline) : g.areas.features.flatMap(shapesOf), LAND_H, C.hazeDeep));
  const linePts = [];
  for (const f of g.areas.features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) for (const ring of poly) for (let i = 1; i < ring.length; i++) {
      const [ax, ay] = project(...ring[i - 1]);
      const [bx, by] = project(...ring[i]);
      linePts.push(ax, LAND_H + 0.002, ay, bx, LAND_H + 0.002, by);
    }
  }
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePts, 3));
  scene.add(new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: new THREE.Color(C.peatSoft) })));

  // The selected area, raised: trucks can only be placed on it.
  let areaMesh = null;
  let areaFeatures = [];
  const featuresOf = (id) => {
    const f = g.areas.features;
    if (id === 'sarawak') return f.filter((x) => x.properties.id === 'sarawak');
    if (id.startsWith('div:')) return f.filter((x) => x.properties.division === id);
    return f.filter((x) => x.properties.id === id);
  };

  // Voxel fire truck: 7 cubes (body, cab, light bar, 4 wheels) in --blackwater and --peat. Original design.
  const cube = new THREE.BoxGeometry(1, 1, 1);
  const matBody = new THREE.MeshLambertMaterial({ color: new THREE.Color(C.blackwater) });
  const matDark = new THREE.MeshLambertMaterial({ color: new THREE.Color(C.peat) });
  const matGhost = new THREE.MeshLambertMaterial({ color: new THREE.Color(C.haze), transparent: true, opacity: 0.85 });
  const u = 0.011;
  function makeTruck(ghost = false) {
    const grp = new THREE.Group();
    const add = (sx, sy, sz, x, y, z, mat) => {
      const m = new THREE.Mesh(cube, ghost ? matGhost : mat);
      m.scale.set(sx * u, sy * u, sz * u);
      m.position.set(x * u, y * u, z * u);
      grp.add(m);
    };
    add(3, 1.4, 1.8, -0.4, 1.3, 0, matBody); // body
    add(1.3, 1.2, 1.6, 1.8, 1.2, 0, matBody); // cab
    add(0.6, 0.4, 1.0, -0.4, 2.2, 0, matDark); // light bar
    add(0.6, 0.6, 0.4, -1.4, 0.3, 0.8, matDark); // wheels
    add(0.6, 0.6, 0.4, -1.4, 0.3, -0.8, matDark);
    add(0.6, 0.6, 0.4, 1.6, 0.3, 0.8, matDark);
    add(0.6, 0.6, 0.4, 1.6, 0.3, -0.8, matDark);
    const ringR = RADIUS_KM / KM_PER_UNIT;
    const ring = new THREE.Mesh(new THREE.RingGeometry(ringR * 0.96, ringR, 64),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(ghost ? C.peat : C.blackwater), transparent: true, opacity: ghost ? 0.5 : 0.75, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.002;
    ring.userData.isRing = true; // the 20 km circle is not part of the truck for clicks
    grp.add(ring);
    return grp;
  }
  const truckLayer = new THREE.Group();
  const bestLayer = new THREE.Group();
  const tripLayer = new THREE.Group(); // dashed trails of the player's trucks
  const bestTripLayer = new THREE.Group();
  scene.add(truckLayer, bestLayer, tripLayer, bestTripLayer);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let anim = 0; // id of the running drive animation

  // Distance labels drawn as HTML over the canvas, kept in place on every render.
  const labelBox = document.createElement('div');
  labelBox.className = 'game-labels';
  labelBox.setAttribute('aria-hidden', 'true');
  g.stage.append(labelBox);
  let labels = []; // { el, pos: Vector3 }
  function placeLabels() {
    for (const l of labels) {
      const v = l.pos.clone().project(camera);
      const visible = v.z < 1 && Math.abs(v.x) <= 1.05 && Math.abs(v.y) <= 1.05;
      l.el.hidden = !visible;
      if (visible) l.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -130%)`;
    }
  }
  function clearLabels() {
    labels = [];
    labelBox.replaceChildren();
  }
  function addLabel(text, x, z, cls = '') {
    const e = document.createElement('span');
    e.className = `game-label ${cls}`;
    e.textContent = text;
    labelBox.append(e);
    labels.push({ el: e, pos: new THREE.Vector3(x, AREA_H + 0.05, z) });
  }
  function dashedLine(ax, az, bx, bz, colorHex) {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(ax, AREA_H + 0.006, az), new THREE.Vector3(bx, AREA_H + 0.006, bz)]);
    const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: new THREE.Color(colorHex), dashSize: 0.012, gapSize: 0.009 }));
    line.computeLineDistances();
    return line;
  }
  function clearGroup(grp) {
    grp.traverse((o) => { if (o !== grp) { o.geometry?.dispose?.(); if (o.material && !o.material.isShared) o.material.dispose?.(); } });
    grp.clear();
  }

  // Keyboard cursor.
  const cursor = new THREE.Mesh(new THREE.RingGeometry(0.008, 0.013, 24),
    new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
  cursor.rotation.x = -Math.PI / 2;
  cursor.visible = false;
  scene.add(cursor);
  let cursorXY = null;

  // Fire stacks (one InstancedMesh), shown only after "Check my patrols".
  const blockGeo = new THREE.BoxGeometry(CELL * 0.85 * Math.cos((2.8 * Math.PI) / 180), BLOCK_H, CELL * 0.85);
  blockGeo.translate(0, BLOCK_H / 2, 0);
  let fires = null;
  const tmp = new THREE.Object3D();
  const color = new THREE.Color();

  let w = 0;
  let h = 0;
  const render = () => { if (w && h) { renderer.render(scene, camera); placeLabels(); } };
  controls.addEventListener('change', render);
  function resize() {
    w = g.stage.clientWidth;
    h = g.stage.clientHeight;
    renderer.setSize(w, h, true);
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
    render();
  }
  new ResizeObserver(resize).observe(g.stage);
  resize();
  if (new URLSearchParams(window.location.search).get('debug') === '1') window.__commander = { camera, controls, scene, g };

  function bounds(feats) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const f of feats) {
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const poly of polys) for (const [lon, lat] of poly[0]) {
        const [x, y] = project(lon, lat);
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
    }
    return { x0, y0, x1, y1 };
  }

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function hitAt(e) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    // Only the truck's blocks count as the truck: clicking inside its 20 km circle places a new truck.
    const t = ray.intersectObjects(truckLayer.children, true).find((h) => !h.object.userData.isRing);
    if (t) {
      let obj = t.object;
      while (obj.parent && obj.parent !== truckLayer) obj = obj.parent;
      return { truckIndex: truckLayer.children.indexOf(obj) };
    }
    const land = areaMesh ? ray.intersectObject(areaMesh, false)[0] : null;
    return land ? { x: land.point.x, z: land.point.z } : {};
  }
  function place(x, z) {
    if (g.scored || g.trucks.length >= TRUCKS) return;
    const [lon, lat] = unproject(x, z);
    g.trucks.push({ lon, lat });
    afterTrucksChanged(g);
  }
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.abs(e.clientX - down[0]) + Math.abs(e.clientY - down[1]) > 5) { down = null; return; }
    down = null;
    const hit = hitAt(e);
    if (hit.truckIndex != null && hit.truckIndex >= 0 && !g.scored) {
      g.trucks.splice(hit.truckIndex, 1);
      afterTrucksChanged(g);
    } else if (hit.x != null) {
      place(hit.x, hit.z);
    } else if (!g.scored && g.trucks.length < TRUCKS) {
      g.count.textContent = `Place trucks inside ${g.areaName} (the raised, highlighted land). Trucks placed: ${g.trucks.length} of ${TRUCKS}.`;
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.buttons) return;
    const hit = hitAt(e);
    canvas.style.cursor = (hit.truckIndex != null && !g.scored) || (hit.x != null && !g.scored && g.trucks.length < TRUCKS) ? 'pointer' : 'grab';
  });
  canvas.addEventListener('keydown', (e) => {
    const b = bounds(areaFeatures);
    if (!cursorXY) cursorXY = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
    const step = Math.max(0.01, (b.x1 - b.x0) / 40);
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      cursorXY = [Math.min(b.x1, Math.max(b.x0, cursorXY[0] + moves[e.key][0])), Math.min(b.y1, Math.max(b.y0, cursorXY[1] + moves[e.key][1]))];
    } else if (e.key === 'Enter' || e.key === ' ') {
      const [lon, lat] = unproject(...cursorXY);
      const where = squareAreaAt(lon, lat, g.areas);
      const inside = where != null && inSelectedArea(g.areaId, where, g.divisionOf);
      if (inside) place(...cursorXY);
      else g.count.textContent = `That spot is outside ${g.areaName}. Move the marker onto the highlighted land.`;
    } else return;
    e.preventDefault();
    cursor.visible = true;
    cursor.position.set(cursorXY[0], AREA_H + 0.004, cursorXY[1]);
    render();
  });

  return {
    setArea(id) {
      if (areaMesh) { scene.remove(areaMesh); areaMesh.geometry.dispose(); areaMesh.material.dispose(); }
      areaFeatures = featuresOf(id);
      areaMesh = slab(areaFeatures.flatMap(shapesOf), AREA_H, C.landSelect);
      scene.add(areaMesh);
      cursorXY = null;
      cursor.visible = false;
      const b = bounds(areaFeatures);
      const cx = (b.x0 + b.x1) / 2;
      const cz = (b.y0 + b.y1) / 2;
      const dist = fitDistance(b.x1 - b.x0, b.y1 - b.y0, w / Math.max(h, 1), camera.fov, 1.15);
      controls.target.set(cx, 0, cz);
      camera.position.set(cx, dist * 0.78, cz + dist * 0.63); // looking down at about 50 degrees
      controls.update();
      render();
    },
    setTrucks(trucks) {
      anim++;
      truckLayer.clear();
      clearGroup(tripLayer);
      clearLabels();
      for (const t of trucks) {
        const m = makeTruck();
        const [x, y] = project(t.lon, t.lat);
        m.position.set(x, AREA_H, y);
        truckLayer.add(m);
      }
      render();
    },
    showBest(trucks, legs = []) {
      bestLayer.clear();
      clearGroup(bestTripLayer);
      for (const t of trucks) {
        const m = makeTruck(true);
        const [x, y] = project(t.lon, t.lat);
        m.position.set(x, AREA_H, y);
        bestLayer.add(m);
      }
      for (const l of legs) {
        const t = trucks[l.truck];
        if (!t) continue;
        const [ax, az] = project(t.lon, t.lat);
        const [bx, bz] = project(l.area.lon, l.area.lat);
        bestTripLayer.add(dashedLine(ax, az, bx, bz, C.peatSoft));
      }
      render();
    },
    // Each truck drives (straight line) to the most serious fire area it serves, leaving a dashed trail to every
    // area it serves; labels show the distance. Instant when the reader prefers reduced motion.
    drive(legs) {
      const id = ++anim;
      clearGroup(tripLayer);
      clearLabels();
      const byTruck = new Map();
      for (const l of legs) {
        if (l.truck < 0) continue;
        if (!byTruck.has(l.truck)) byTruck.set(l.truck, []);
        byTruck.get(l.truck).push(l);
      }
      const moves = [];
      for (const [ti, list] of byTruck) {
        const mesh = truckLayer.children[ti];
        if (!mesh) continue;
        const start = mesh.position.clone();
        list.sort((a, b) => a.area.rank - b.area.rank);
        for (const l of list) {
          const [bx, bz] = project(l.area.lon, l.area.lat);
          const line = dashedLine(start.x, start.z, start.x, start.z, C.blackwater);
          tripLayer.add(line);
          addLabel(`#${l.area.rank} · ${fmtKm(l.km)}`, bx, bz);
          moves.push({ line, start, end: new THREE.Vector3(bx, AREA_H, bz) });
        }
        const [tx, tz] = project(list[0].area.lon, list[0].area.lat);
        moves.push({ mesh, start, end: new THREE.Vector3(tx, AREA_H, tz) });
      }
      const DURATION = 1600;
      const t0 = performance.now();
      let done = false;
      const step = (force = false) => {
        if (id !== anim || done) return; // replaced by a newer action, or already finished
        const k = reducedMotion || force ? 1 : Math.min(1, Math.max(0, (performance.now() - t0) / DURATION));
        if (k >= 1) done = true;
        const e = 1 - (1 - k) ** 3; // ease out
        for (const m of moves) {
          const p = m.start.clone().lerp(m.end, e);
          if (m.mesh) {
            m.mesh.position.copy(p);
            m.mesh.children.at(-1).visible = false; // hide the circle while driving
          } else {
            m.line.geometry.setFromPoints([new THREE.Vector3(m.start.x, AREA_H + 0.006, m.start.z), new THREE.Vector3(p.x, AREA_H + 0.006, p.z)]);
            m.line.computeLineDistances();
          }
        }
        render();
        if (k < 1) requestAnimationFrame(() => step());
      };
      if (reducedMotion || document.hidden) step(true);
      else requestAnimationFrame(() => step());
      // If the browser stops sending frames (tab in the background, slow device), finish anyway.
      setTimeout(() => step(true), DURATION + 250);
    },
    setFires(cells) {
      if (fires) { scene.remove(fires); fires.dispose(); fires = null; }
      if (!cells.length) { render(); return; }
      const levels = cells.map((c) => Math.min(14, Math.max(1, Math.ceil(Math.sqrt(c.count)))));
      fires = new THREE.InstancedMesh(blockGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), levels.reduce((a, b) => a + b, 0));
      let i = 0;
      cells.forEach((c, k) => {
        const [x, y] = project(c.lon, c.lat);
        for (let lvl = 0; lvl < levels[k]; lvl++) {
          tmp.position.set(x, AREA_H + lvl * BLOCK_H, y);
          tmp.updateMatrix();
          fires.setMatrixAt(i, tmp.matrix);
          // Stepped flame: lighter at the bottom, the top block takes the colour of the stack height.
          // Colour and height show only the number of hotspots, so a stack looks the same whatever the truck
          // placement (the 20 km circles show which hotspots a truck covers).
          color.set(C.fire[Math.min(5, Math.round((lvl / 13) * 5) + (lvl === levels[k] - 1 ? 1 : 0))]);
          fires.setColorAt(i, color);
          i++;
        }
      });
      fires.instanceMatrix.needsUpdate = true;
      fires.instanceColor.needsUpdate = true;
      scene.add(fires);
      render();
    },
  };
}

// ---------- Page boot (commander.html) ----------

export async function boot() {
  const root = document.getElementById('game');
  const badge = document.getElementById('mode-badge');
  try {
    const meta = await loadMeta();
    if (badge) {
      badge.dataset.mode = meta.mode;
      badge.innerHTML = '';
      const s = document.createElement('strong');
      s.textContent = meta.mode === 'real' ? 'REAL' : 'DEMO';
      badge.append(s, document.createTextNode(meta.mode === 'real' ? ` NASA FIRMS data, ${meta.coverage.start} to ${meta.lastCompleteMonth}`
        : ' Synthetic data for testing, not NASA observations'));
      badge.hidden = false;
    }
    const back = document.getElementById('back-link');
    if (back && isMock) back.href = 'index.html?mock=1';
    await mount(root);
  } catch (err) {
    console.error('[Commander]', err);
    root.innerHTML = '';
    root.append(el('p', 'app-error', `Commander mode could not load its data. ${err.message}`));
  }
}
