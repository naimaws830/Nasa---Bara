// Tests for site/js/map.js (B1) against the REAL exported data in site/data.
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = { location: { search: '' } }; // store.js reads the query string on import
const map = await import('../site/js/map.js');

const DATA = new URL('../site/data/', import.meta.url);
const read = (f) => JSON.parse(readFileSync(new URL(f, DATA), 'utf8'));
const areas = read('areas.geojson');
const meta = read('meta.json');
const sarawakCal = read('calendar/sarawak.json');

test('known coordinates fall in the right boundaries', () => {
  // Real VIIRS detections (24 Jul 2025 and Aug 2019) checked against NASA FIRMS and OpenStreetMap.
  assert.equal(map.areaAt(112.1588, 2.7306, areas), 'dist:mukah');
  assert.equal(map.areaAt(111.3205, 2.4281, areas), 'dist:daro');
  assert.equal(map.areaAt(111.3167, 2.2040, areas), 'dist:tanjung-manis');
  // Kuching is in Sarawak but not in an exported district; the South China Sea is in neither.
  assert.equal(map.areaAt(110.35, 1.55, areas), 'sarawak');
  assert.equal(map.areaAt(111.0, 3.5, areas), null);
});

test('selected area membership follows divisions', () => {
  const divisionOf = new Map(areas.features.filter((f) => f.properties.division)
    .map((f) => [f.properties.id, f.properties.division]));
  assert.ok(map.inSelectedArea('div:mukah', 'dist:daro', divisionOf));
  assert.ok(!map.inSelectedArea('div:sibu', 'dist:daro', divisionOf));
  assert.ok(map.inSelectedArea('dist:daro', 'dist:daro', divisionOf));
  assert.ok(map.inSelectedArea('sarawak', 'sarawak', divisionOf));
  assert.ok(!map.inSelectedArea('div:mukah', 'sarawak', divisionOf));
});

function byMonthFor(years) {
  const byMonth = new Map();
  for (const y of years) {
    const json = read(`map/${y}.json`);
    for (const c of json.cells) {
      const key = `${y}-${String(c.month).padStart(2, '0')}|${c.sensor}`;
      if (!byMonth.has(key)) byMonth.set(key, []);
      byMonth.get(key).push(c);
    }
  }
  return byMonth;
}

const total = (cells) => cells.reduce((a, c) => a + c.count, 0);
const calValue = (field, month) => sarawakCal[field][sarawakCal.months.indexOf(month)];

test('changing the selected month changes the map, and totals match the calendar', () => {
  const byMonth = byMonthFor([2025]);
  const jul = map.collectCells(byMonth, ['2025-07'], 'VIIRS');
  const aug = map.collectCells(byMonth, ['2025-08'], 'VIIRS');
  assert.equal(total(jul), calValue('rawViirsCount', '2025-07'));
  assert.equal(total(aug), calValue('rawViirsCount', '2025-08'));
  assert.notEqual(total(jul), total(aug));
  assert.equal(total(map.collectCells(byMonth, ['2025-07'], 'MODIS')), calValue('rawModisCount', '2025-07'));
});

test('every month and sensor on the map adds up to the Sarawak calendar', () => {
  const first = Number(meta.coverage.start.slice(0, 4));
  const last = Number(meta.lastCompleteMonth.slice(0, 4));
  const years = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  const byMonth = byMonthFor(years);
  let checked = 0;
  for (const m of map.monthsBetween(meta.coverage.start, meta.lastCompleteMonth)) {
    for (const [sensor, field] of [['MODIS', 'rawModisCount'], ['VIIRS', 'rawViirsCount']]) {
      const expected = calValue(field, m);
      if (expected == null) continue;
      assert.equal(total(map.collectCells(byMonth, [m], sensor)), expected, `${m} ${sensor}`);
      checked++;
    }
  }
  assert.ok(checked > 400, `only ${checked} months checked`);
});

test('a date range sums its months', () => {
  const byMonth = byMonthFor([2024, 2025]);
  const months = map.monthsBetween('2024-11', '2025-02');
  assert.deepEqual(months, ['2024-11', '2024-12', '2025-01', '2025-02']);
  const expected = months.reduce((a, m) => a + calValue('rawViirsCount', m), 0);
  assert.equal(total(map.collectCells(byMonth, months, 'VIIRS')), expected);
});

test('harmonized view maps the sensor actually observed', () => {
  const viirs = map.sensorCoverage(meta.sensorProducts, 'VIIRS');
  assert.equal(viirs.start, '2012-02'); // VIIRS starts 20 Jan 2012, so January is partial
  assert.equal(map.sensorFor('harmonized', '2009-08', viirs), 'MODIS');
  assert.equal(map.sensorFor('harmonized', '2019-08', viirs), 'VIIRS');
  assert.equal(map.sensorFor('raw-modis', '2019-08', viirs), 'MODIS');
  assert.equal(map.sensorFor('raw-viirs', '2009-08', viirs), 'VIIRS');
});

test('a harmonized date range maps VIIRS whenever the range has VIIRS months', () => {
  const viirs = map.sensorCoverage(meta.sensorProducts, 'VIIRS');
  const all = map.monthsBetween('2001-01', '2026-10');
  assert.equal(map.sensorForPeriod('harmonized', all, viirs), 'VIIRS'); // was MODIS when Aug 2009 was selected
  assert.equal(map.sensorForPeriod('harmonized', map.monthsBetween('2002-01', '2009-12'), viirs), 'MODIS');
  assert.equal(map.sensorForPeriod('raw-modis', all, viirs), 'MODIS');
  assert.equal(map.sensorForPeriod('harmonized', ['2009-08'], viirs), 'MODIS');
});

test('projection round-trips and colour bins are ordered', () => {
  const [x, y] = map.project(112.1588, 2.7306);
  const [lon, lat] = map.unproject(x, y);
  assert.ok(Math.abs(lon - 112.1588) < 1e-9 && Math.abs(lat - 2.7306) < 1e-9);
  const bins = map.binsFor(10, 'month');
  assert.equal(map.binIndex(1, bins), 0);
  assert.equal(map.binIndex(3, bins), 1);
  assert.equal(map.binIndex(500, bins), bins.length - 1);
  assert.equal(map.binLabel(1, bins), '2 to 3');
  assert.equal(map.binLabel(bins.length - 1, bins), '32+');
});

test('clicking the map picks the district, else all of Sarawak, else nothing', () => {
  const ids = new Set(meta.areas.map((a) => a.id));
  assert.equal(map.areaForClick(111.3205, 2.4281, areas, ids), 'dist:daro');
  assert.equal(map.areaForClick(112.1588, 2.7306, areas, ids), 'dist:mukah');
  assert.equal(map.areaForClick(110.35, 1.55, areas, ids), 'sarawak'); // Kuching: Sarawak, not a listed district
  assert.equal(map.areaForClick(111.0, 3.5, areas, ids), null); // South China Sea
});
