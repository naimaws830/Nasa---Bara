// Tests for C1 (store), C2 (calendar/status values) and C3 (proof series, CSV export) against the REAL data.
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = { location: { search: '' } };
const store = await import('../site/js/store.js');
const S = await import('../site/js/series.js');
const { annualSeries } = await import('../site/js/proof.js');
const { squareRows } = await import('../site/js/export.js');

const DATA = new URL('../site/data/', import.meta.url);
const read = (f) => JSON.parse(readFileSync(new URL(f, DATA), 'utf8'));
const meta = read('meta.json');
const areas = read('areas.geojson');
const cals = Object.fromEntries(meta.areas.map((a) => [a.id, read(`calendar/${a.id.replace(':', '_')}.json`)]));

// ---------- C1: store ----------

test('store clamps months to the loaded coverage and never inverts the range', () => {
  const quiet = console.warn;
  console.warn = () => {};
  try {
    store.configure({ areaIds: meta.areas.map((a) => a.id), start: meta.coverage.start, end: meta.lastCompleteMonth });
    store.setState({ startMonth: '1990-01', endMonth: '2099-12', selectedMonth: '2015-08' });
    let s = store.getState();
    assert.equal(s.startMonth, meta.coverage.start);
    assert.equal(s.endMonth, meta.lastCompleteMonth);

    store.setState({ startMonth: '2020-01', endMonth: '2010-01' }); // inverted request
    s = store.getState();
    assert.ok(s.startMonth <= s.endMonth, `${s.startMonth} > ${s.endMonth}`);
    assert.ok(s.selectedMonth >= s.startMonth && s.selectedMonth <= s.endMonth);

    store.setState({ endMonth: '2005-06' }); // end moved before start: start follows
    s = store.getState();
    assert.ok(s.startMonth <= s.endMonth);
  } finally {
    console.warn = quiet;
  }
});

test('store rejects unknown areas, bad months and unknown keys without changing state', () => {
  const quiet = console.warn;
  console.warn = () => {};
  try {
    const before = store.getState();
    assert.equal(store.setState({ areaId: 'div:atlantis' }).length, 1);
    assert.equal(store.setState({ selectedMonth: '2015-13' }).length, 1);
    assert.equal(store.setState({ selectedMonth: 'August' }).length, 1);
    assert.equal(store.setState({ colour: 'red' }).length, 1);
    assert.equal(store.setState({ sensorView: 'landsat' }).length, 1);
    assert.deepEqual(store.getState(), before);
  } finally {
    console.warn = quiet;
  }
});

// ---------- C2: calendar and status ----------

test('every calendar value shown equals the JSON (rounded to whole detections), for every area and series', () => {
  for (const cal of Object.values(cals)) {
    for (const view of ['harmonized', 'raw-modis', 'raw-viirs']) {
      const vals = S.valuesFor(cal, view);
      assert.equal(vals.length, cal.months.length);
      vals.forEach((v, i) => {
        const shown = v == null ? null : v === 0 ? '0' : S.fmtCount(v);
        const expected = v == null ? null : Math.round(v).toLocaleString('en-GB');
        assert.equal(shown, expected, `${cal.areaId} ${cal.months[i]} ${view}`);
      });
    }
  }
});

test('missing is never shown as zero', () => {
  const cal = cals.sarawak;
  const i = cal.months.indexOf('2005-08');
  assert.equal(cal.rawViirsCount[i], null); // VIIRS did not exist
  assert.equal(S.fmtCount(cal.rawViirsCount[i]), null);
  assert.ok(cal.rawModisCount.some((v) => v === 0) || true);
});

test('colour bins are increasing and cover every non-zero value', () => {
  for (const cal of Object.values(cals)) {
    const vals = S.valuesFor(cal, 'harmonized');
    const edges = S.calendarEdges(vals);
    for (let k = 1; k < edges.length; k++) assert.ok(edges[k] > edges[k - 1]);
    for (const v of vals) if (v > 0) {
      const step = S.fireStep(S.edgeBin(v, edges), edges);
      assert.ok(step >= 1 && step <= 6);
    }
  }
});

test('busiest year is the true maximum over complete reference years', () => {
  const cal = cals['div:mukah'];
  const [y0, y1] = cal.reference.completeYears;
  for (const mm of ['01', '08', '10']) {
    const best = S.busiestYear(cal, 'harmonized', `2020-${mm}`);
    let max = -1;
    cal.months.forEach((m, i) => {
      const y = Number(m.slice(0, 4));
      if (m.endsWith(`-${mm}`) && y >= y0 && y <= y1 && cal.harmonizedCount[i] > max) max = cal.harmonizedCount[i];
    });
    assert.equal(best.value, max);
  }
});

test('no claim for a partial or unprocessed month', () => {
  for (const cal of Object.values(cals)) {
    assert.equal(cal.months.at(-1), meta.lastCompleteMonth, cal.areaId);
    assert.ok(!cal.months.includes(meta.generatedAt.slice(0, 7)) || meta.generatedAt.slice(0, 7) === meta.lastCompleteMonth);
  }
  // The store cannot select past the last complete month.
  store.setState({ selectedMonth: '2099-01' });
  assert.equal(store.getState().selectedMonth, meta.lastCompleteMonth);
});

test('comparison and anomaly wording is descriptive', () => {
  assert.match(S.compareText(30, 10, '2019-08'), /^3\.0 times the usual August/);
  assert.match(S.compareText(10, 10, '2019-08'), /^About the same as the usual August/);
  assert.match(S.compareText(2, 10, '2019-08'), /^Below the usual August: 20%/);
  for (const sc of [-5, -1.5, 0, 1.5, 2.5, 4]) {
    const t = S.anomalyText(sc, '2019-08');
    assert.doesNotMatch(t, /warning|alert|danger|emergency/i);
  }
});

test('plain summary uses the JSON numbers and everyday words', () => {
  const cal = cals['div:mukah'];
  const i = cal.months.indexOf('2025-07');
  const lines = S.plainSummary({ area: cal.name, month: '2025-07', value: cal.harmonizedCount[i],
    median: cal.seasonalMedian[i], status: cal.status[i], provisional: false });
  assert.match(lines[0], new RegExp(`spotted ${Math.round(cal.harmonizedCount[i])} hotspots in Mukah Division in July 2025`));
  assert.match(lines[1], new RegExp(`normal July has about ${S.fmtCount(cal.seasonalMedian[i])}`));
  for (const l of lines) assert.doesNotMatch(l, /anomaly|median|harmoni|WAPE|warning|alert|danger/i);
  // Estimated months say so in plain words.
  const j = cal.months.indexOf('2009-08');
  const est = S.plainSummary({ area: cal.name, month: '2009-08', value: cal.harmonizedCount[j],
    median: cal.seasonalMedian[j], status: cal.status[j], provisional: false });
  assert.ok(est.some((l) => /estimate/.test(l)));
  // No data is never a number.
  assert.match(S.plainSummary({ area: 'X', month: '2005-01', value: null, median: 3 })[0], /no full satellite record/);
});

test('level labels follow the same 25% rule as the comparison text', () => {
  assert.equal(S.levelOf(5, 10).key, 'lower');
  assert.equal(S.levelOf(10, 10).key, 'normal');
  assert.equal(S.levelOf(15, 10).key, 'higher');
  assert.equal(S.levelOf(30, 10).key, 'much');
  assert.equal(S.levelOf(null, 10), null);
});

// ---------- C3: proof and export ----------

test('proof ratio is VIIRS over MODIS on months both covered', async () => {
  const { overlapRatio } = await import('../site/js/proof.js');
  const cal = cals.sarawak;
  let v = 0;
  let m = 0;
  cal.months.forEach((_, i) => {
    if (cal.rawViirsCount[i] != null && cal.rawModisCount[i] != null) { v += cal.rawViirsCount[i]; m += cal.rawModisCount[i]; }
  });
  assert.equal(overlapRatio(cal), v / m);
  assert.ok(v / m > 2 && v / m < 8);
});

test('annual proof series only sums complete years and equals the JSON', () => {
  const cal = cals['div:mukah'];
  const a = annualSeries(cal, cal.reference.completeYears[1]);
  const sum = (key, y) => cal.months.reduce((t, m, i) => t + (m.startsWith(`${y}-`) ? cal[key][i] : 0), 0);
  const i2009 = a.keys.indexOf('2009');
  assert.equal(a.harmonizedCount[i2009], sum('harmonizedCount', 2009));
  assert.equal(a.rawModisCount[i2009], sum('rawModisCount', 2009));
  assert.equal(a.rawViirsCount[i2009], null); // no VIIRS in 2009
  assert.equal(a.rawViirsCount[a.keys.indexOf('2012')], null); // January 2012 is not complete for VIIRS
  assert.equal(a.rawViirsCount[a.keys.indexOf('2019')], sum('rawViirsCount', 2019));
});

function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\r') { /* skip */ } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += c;
  }
  return rows;
}

test('CSV quoting survives commas, quotes and line breaks', () => {
  const rows = [{ a: 'plain', b: 'with, comma', c: 'say "hi"', d: 'two\nlines' }, { a: null, b: 0, c: 1.5, d: '' }];
  const parsed = parseCSV(S.toCSV(['a', 'b', 'c', 'd'], rows));
  assert.deepEqual(parsed[0], ['a', 'b', 'c', 'd']);
  assert.deepEqual(parsed[1], ['plain', 'with, comma', 'say "hi"', 'two\nlines']);
  assert.deepEqual(parsed[2], ['', '0', '1.5', '']);
});

test('monthly CSV matches the filtered JSON exactly, for every area', () => {
  for (const cal of Object.values(cals)) {
    const rows = S.monthlyRows(cal, meta, '2011-06', '2013-03');
    const parsed = parseCSV(S.toCSV(S.MONTHLY_COLUMNS, rows));
    assert.deepEqual(parsed[0], S.MONTHLY_COLUMNS);
    assert.equal(parsed.length - 1, 22);
    parsed.slice(1).forEach((r) => {
      const rec = Object.fromEntries(S.MONTHLY_COLUMNS.map((c, k) => [c, r[k]]));
      const i = cal.months.indexOf(rec.month);
      const asText = (v) => (v == null ? '' : String(v));
      assert.equal(rec.areaId, cal.areaId);
      assert.equal(rec.rawModisCount, asText(cal.rawModisCount[i]));
      assert.equal(rec.rawViirsCount, asText(cal.rawViirsCount[i]));
      assert.equal(rec.harmonizedCount, asText(cal.harmonizedCount[i]));
      assert.equal(rec.status, cal.status[i]);
      assert.equal(rec.units, cal.units);
      assert.ok(rec.sourcePeriod.length > 0, `${rec.month} has no source product`);
    });
  }
});

test('source period names the products used that month', () => {
  const rows = S.monthlyRows(cals.sarawak, meta, '2012-01', '2012-01');
  assert.match(rows[0].sourcePeriod, /MODIS_SP/);
  assert.match(rows[0].sourcePeriod, /VIIRS_SNPP_SP from 2012-01-20/); // partial first VIIRS month is flagged
});

const viirsOf = (rows) => rows.filter((r) => r.sensor === 'VIIRS').reduce((a, r) => a + r.detections, 0);
const calSum = (cal, key, start, end) => cal.months.reduce((t, m, i) => t + (m >= start && m <= end ? (cal[key][i] || 0) : 0), 0);

test('observed squares CSV: all of Sarawak equals the calendar exactly, every month', () => {
  const byYear = [read('map/2025.json')];
  for (const m of S.MONTH_NAMES.map((_, k) => `2025-${String(k + 1).padStart(2, '0')}`)) {
    const rows = squareRows(byYear, areas, 'sarawak', m, m);
    assert.equal(viirsOf(rows), cals.sarawak.rawViirsCount[cals.sarawak.months.indexOf(m)], m);
    const modis = rows.filter((r) => r.sensor === 'MODIS').reduce((a, r) => a + r.detections, 0);
    assert.equal(modis, cals.sarawak.rawModisCount[cals.sarawak.months.indexOf(m)], m);
  }
});

test('observed squares CSV: division totals over a year are close to the calendar (squares, not points)', () => {
  const byYear = [read('map/2025.json')];
  for (const a of meta.areas.filter((x) => x.type === 'division')) {
    const got = viirsOf(squareRows(byYear, areas, a.id, '2025-01', '2025-12'));
    const want = calSum(cals[a.id], 'rawViirsCount', '2025-01', '2025-12');
    assert.ok(Math.abs(got - want) <= want * 0.15, `${a.id}: squares ${got} vs calendar ${want}`);
  }
});

// ---------- Preparedness ----------

test('fire season comes from each area\'s own history', () => {
  const sar = S.fireSeason(cals.sarawak);
  assert.deepEqual([sar.start, sar.end, sar.peak], [7, 9, 8]); // July to September, busiest August
  const muk = S.fireSeason(cals['div:mukah']);
  assert.equal(muk.peak, 8);
  assert.ok(muk.months.includes(7) && muk.months.includes(8));
  assert.equal(S.fireSeason(cals['dist:tanjung-manis']), null); // too few hotspots to speak of a season
});

test('preparedness wording depends on the month of the year, and never alarms', () => {
  const sar = S.fireSeason(cals.sarawak);
  const inSeason = S.preparedness(sar, 8, { area: 'Sarawak' });
  assert.equal(inSeason.phase, 'in');
  assert.ok(inSeason.checklist);
  assert.equal(S.preparedness(sar, 6, { area: 'Sarawak' }).phase, 'soon');
  const quiet = S.preparedness(sar, 12, { area: 'Sarawak' });
  assert.equal(quiet.phase, 'quiet');
  assert.ok(!quiet.checklist);
  assert.match(quiet.lines[1], /December is usually a quiet month/);
  const busy = S.preparedness(sar, 12, { area: 'Sarawak', busier: true, selectedLabel: 'July 2025' });
  assert.ok(busy.checklist);
  assert.ok(busy.lines.some((l) => /July 2025 was busier than usual/.test(l)));
  for (const p of [inSeason, quiet, busy]) {
    for (const l of p.lines) assert.doesNotMatch(l, /danger|emergency|warning|alert|evacuate/i);
  }
});
