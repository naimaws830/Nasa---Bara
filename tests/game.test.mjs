// Commander mode (G-01): distances, scoring and best placement, against the real data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = { location: { search: '' } };
const G = await import('../site/js/game.js');
const M = await import('../site/js/map.js');

const read = (f) => JSON.parse(readFileSync(new URL(`../site/data/${f}`, import.meta.url), 'utf8'));
const meta = read('meta.json');
const areas = read('areas.geojson');
const divisionOf = new Map(areas.features.filter((f) => f.properties.division).map((f) => [f.properties.id, f.properties.division]));
const viirs = M.sensorCoverage(meta.sensorProducts, 'VIIRS');

function cellsFor(id) {
  const cal = read(`calendar/${id.replace(':', '_')}.json`);
  const month = G.worstMonth(cal);
  const sensor = M.sensorFor('harmonized', month, viirs);
  return { cal, month, sensor, cells: G.gameCells(read(`map/${month.slice(0, 4)}.json`), month, sensor, id, areas, divisionOf) };
}

test('distance in km is right (about 111 km per degree of latitude)', () => {
  assert.ok(Math.abs(G.distanceKm(112, 2, 112, 3) - 111.2) < 0.5);
  assert.equal(G.distanceKm(112.1, 2.7, 112.1, 2.7), 0);
  assert.ok(Math.abs(G.distanceKm(112, 2.8, 112.05, 2.8) - 5.55) < 0.1); // one 0.05-degree square
});

test('default month is the busiest month of the area', () => {
  const { cal, month } = cellsFor('div:mukah');
  const max = Math.max(...cal.harmonizedCount.filter((v) => v != null));
  assert.equal(cal.harmonizedCount[cal.months.indexOf(month)], max);
});

test('game hotspots are the real observed hotspots of that month and area', () => {
  // All of Sarawak: squares add up exactly to the calendar's observed count.
  const { cal, month, sensor, cells } = cellsFor('sarawak');
  const field = sensor === 'VIIRS' ? 'rawViirsCount' : 'rawModisCount';
  assert.equal(cells.reduce((s, c) => s + c.count, 0), cal[field][cal.months.indexOf(month)]);
});

test('coverage counts hotspots within 20 km of any truck', () => {
  assert.equal(G.RADIUS_KM, 20);
  const cells = [
    { key: 'a', lon: 112.0, lat: 2.0, count: 10 },
    { key: 'b', lon: 112.15, lat: 2.0, count: 5 }, // about 16.7 km from a
    { key: 'c', lon: 112.5, lat: 2.0, count: 5 }, // about 56 km away
  ];
  const one = G.coverage([{ lon: 112.0, lat: 2.0 }], cells);
  assert.equal(one.covered, 15);
  assert.equal(one.total, 20);
  assert.equal(one.share, 0.75);
  assert.deepEqual([...one.coveredKeys].sort(), ['a', 'b']);
  assert.equal(G.coverage([], cells).share, 0);
});

test('best placement covers at least as much as any other 5 trucks we try', () => {
  const { cells } = cellsFor('div:mukah');
  const best = G.bestPlacement(cells);
  assert.equal(best.trucks.length, 5);
  assert.ok(best.share > 0 && best.share <= 1);
  // Five trucks on the five busiest squares is a strong naive plan; greedy must not do worse.
  const top5 = [...cells].sort((a, b) => b.count - a.count).slice(0, 5);
  assert.ok(best.covered >= G.coverage(top5, cells).covered);
  // Random plans never beat it (seeded).
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let k = 0; k < 200; k++) {
    const pick = Array.from({ length: 5 }, () => cells[Math.floor(rnd() * cells.length)]);
    assert.ok(G.coverage(pick, cells).covered <= best.covered);
  }
});

test('score sentences are plain', () => {
  assert.equal(G.scoreSentence(18.4, 6.2, 5),
    'Your trucks reached the 5 worst fire areas in an average of 18 km. The plan that covers the most hotspots: 6 km.');
  assert.equal(G.coverageSentence(0.46, 0.71), 'Within 20 km of a truck: 46% of hotspots (best possible: 71%).');
  assert.equal(G.fmtKm(0.4), 'under 1 km');
});

test('fire areas group nearby squares and rank by total hotspots', () => {
  const cells = [
    { key: 'a', lon: 112.0, lat: 2.0, count: 10 },
    { key: 'b', lon: 112.05, lat: 2.0, count: 10 }, // 5.6 km from a: same area
    { key: 'c', lon: 112.6, lat: 2.0, count: 15 }, // its own area
    { key: 'd', lon: 113.2, lat: 2.0, count: 1 },
  ];
  const areas = G.fireAreas(cells, 5);
  assert.equal(areas.length, 3);
  assert.deepEqual(areas.map((a) => [a.rank, a.count, a.squares]), [[1, 20, 2], [2, 15, 1], [3, 1, 1]]);
  assert.equal(areas[0].lon, 112.0); // the area's hottest square (tie broken by key): where the truck goes
  assert.equal(areas[0].peak, 10);
  assert.deepEqual(areas[0].keys.sort(), ['a', 'b']);
  // On real data: never more than 5, all hotspots of an area counted once.
  const { cells: real } = cellsFor('div:mukah');
  const top = G.fireAreas(real);
  assert.equal(top.length, 5);
  for (let i = 1; i < top.length; i++) assert.ok(top[i - 1].count >= top[i].count);
  assert.ok(top.reduce((t, a) => t + a.count, 0) <= real.reduce((t, c) => t + c.count, 0));
});

test('each fire area is reached by its nearest truck', () => {
  const areas = [{ rank: 1, lon: 112.0, lat: 2.0, count: 20 }, { rank: 2, lon: 113.0, lat: 2.0, count: 5 }];
  const trucks = [{ lon: 112.9, lat: 2.0 }, { lon: 112.1, lat: 2.0 }];
  const trip = G.dispatch(trucks, areas);
  assert.deepEqual(trip.legs.map((l) => l.truck), [1, 0]);
  assert.ok(Math.abs(trip.legs[0].km - 11.1) < 0.2);
  assert.ok(Math.abs(trip.avgKm - (trip.legs[0].km + trip.legs[1].km) / 2) < 1e-9);
  assert.equal(G.dispatch([], areas).legs[0].truck, -1);
});

test('one truck per area: a busy truck is skipped and the next nearest free truck goes, even beyond 20 km', () => {
  // Two bad areas close together; truck 0 sits between them, truck 1 is 33 km away.
  const areas = [
    { rank: 1, lon: 112.00, lat: 2.0, count: 50 },
    { rank: 2, lon: 112.06, lat: 2.0, count: 40 },
  ];
  const trucks = [{ lon: 112.03, lat: 2.0 }, { lon: 112.36, lat: 2.0 }];
  const trip = G.dispatch(trucks, areas);
  assert.deepEqual(trip.legs.map((l) => l.truck), [0, 1]); // worst area takes the near truck
  assert.equal(trip.legs[0].outside, false);
  assert.ok(trip.legs[1].km > 20);
  assert.equal(trip.legs[1].outside, true);
  // Every truck is used at most once.
  const { cells } = cellsFor('div:mukah');
  const real = G.dispatch(G.bestPlacement(cells).trucks, G.fireAreas(cells));
  const used = real.legs.map((l) => l.truck);
  assert.equal(new Set(used).size, used.length);
});

test('more fire areas than trucks: the extra areas get no truck', () => {
  const areas = [1, 2, 3].map((r) => ({ rank: r, lon: 112 + r * 0.5, lat: 2, count: 10 - r }));
  const trip = G.dispatch([{ lon: 112.5, lat: 2 }], areas);
  assert.deepEqual(trip.legs.map((l) => l.truck), [0, -1, -1]);
  assert.equal(trip.legs[1].km, null);
});

test('on real data the best placement drives no further than trucks on the busiest squares', () => {
  const { cells } = cellsFor('div:mukah');
  const areas = G.fireAreas(cells);
  const best = G.dispatch(G.bestPlacement(cells).trucks, areas).avgKm;
  const far = G.dispatch([{ lon: 113.5, lat: 2.0 }, { lon: 113.5, lat: 2.1 }, { lon: 113.5, lat: 2.2 }, { lon: 113.5, lat: 2.3 }, { lon: 113.5, lat: 2.4 }], areas).avgKm;
  assert.ok(best < far);
});

test('"What happened" summary uses the round\'s real numbers and plain words', () => {
  const { cells } = cellsFor('div:mukah');
  const areas = G.fireAreas(cells);
  const plan = G.bestPlacement(cells);
  const trucks = [[111.65, 2.6], [111.4, 2.6], [112.35, 2.9], [111.55, 2.55], [112.05, 2.7]].map(([lon, lat]) => ({ lon, lat }));
  const trip = G.dispatch(trucks, areas);
  const lines = G.roundSummary({ trip, planTrip: G.dispatch(plan.trucks, areas), mine: G.coverage(trucks, cells), plan });
  assert.match(lines[0], /^Your trucks (got to|took longer to get to) the worst fires/);
  assert.ok(lines.some((l) => l.includes(`${G.fmtKm(trip.legs[0].km)} from a truck`) || l.includes('had no truck nearby')));
  const far = trip.legs.filter((l) => l.outside && l.area.rank !== 1);
  for (const l of far) assert.ok(lines.join(' ').includes(G.fmtKm(l.km)));
  assert.match(lines.at(-1), /^(Tip:|Well placed)/);
  for (const l of lines) assert.doesNotMatch(l, /WAPE|greedy|cluster|percentile|danger|warning|alert/i);
});

test('summary praises a round where every worst fire area had a truck nearby', () => {
  const { cells } = cellsFor('div:mukah');
  const areas = G.fireAreas(cells);
  const plan = G.bestPlacement(cells);
  const onTop = areas.map((a) => ({ lon: a.lon, lat: a.lat })); // a truck on each worst stack
  const lines = G.roundSummary({ trip: G.dispatch(onTop, areas), planTrip: G.dispatch(plan.trucks, areas), mine: G.coverage(onTop, cells), plan });
  assert.match(lines[0], /got to the worst fires faster/);
  assert.ok(lines.some((l) => /^Well placed|^Tip: spread/.test(l)));
});
