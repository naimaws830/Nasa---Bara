// Data loading for Bara (C1). The only file that calls fetch().
// loadMeta(), loadAreas(), loadCalendar(areaId), loadMap(year), loadHarmonize()
// Each returns a cached Promise.
//
// Fail closed: the normal page reads data/ and refuses anything not marked mode "real".
// ?mock=1 reads data/mock/ and requires mode "mock". So demo data can never appear as NASA data.
// Every loader waits for a valid meta.json first.

const params = new URLSearchParams(window.location.search);

export const isMock = params.get('mock') === '1';

const FOLDER = isMock ? 'data/mock/' : 'data/';
const BASE = new URL(`../${FOLDER}`, import.meta.url);
const cache = new Map();

export class DataError extends Error {
  constructor(message, file = null) {
    super(message);
    this.name = 'DataError';
    this.file = file;
  }
}

export function loadMeta() {
  return cached('meta.json', async () => checkMeta(await fetchJSON('meta.json')));
}

export async function loadAreas() {
  await loadMeta();
  return cached('areas.geojson', () => fetchJSON('areas.geojson'));
}

export async function loadCalendar(areaId) {
  const meta = await loadMeta();
  if (!meta.areas.some((a) => a.id === areaId)) {
    throw new DataError(`Unknown area "${areaId}". It is not listed in ${FOLDER}meta.json.`);
  }
  const file = `calendar/${areaId.replace(':', '_')}.json`;
  return cached(file, () => fetchJSON(file));
}

export async function loadMap(year) {
  const meta = await loadMeta();
  const first = Number(meta.coverage.start.slice(0, 4));
  const last = Number(meta.coverage.end.slice(0, 4));
  if (!Number.isInteger(year) || year < first || year > last) {
    throw new DataError(`No map data for ${year}. Data covers ${first} to ${last}.`);
  }
  const file = `map/${year}.json`;
  return cached(file, () => fetchJSON(file));
}

export async function loadHarmonize() {
  await loadMeta();
  return cached('harmonize.json', () => fetchJSON('harmonize.json'));
}

/** Optional extra (D-05): next-month outlook. Resolves to null when the file is not published. */
export async function loadForecast() {
  await loadMeta();
  return cached('forecast.json', () => fetchOptional('forecast.json'));
}

/** Optional extra (D-05): monthly rainfall per division and Sarawak. Resolves to null when absent. */
export async function loadRain() {
  await loadMeta();
  return cached('rain.json', () => fetchOptional('rain.json'));
}

async function fetchOptional(file) {
  try {
    return await fetchJSON(file);
  } catch (err) {
    if (/HTTP 404/.test(err.message)) return null;
    throw err;
  }
}

/** Address of a published data file (for download links). Respects ?mock=1. Does not fetch. */
export function dataURL(file) {
  return new URL(file, BASE).href;
}

function checkMeta(meta) {
  const name = `${FOLDER}meta.json`;
  const expected = isMock ? 'mock' : 'real';
  if (meta.mode !== expected) {
    const msg = isMock
      ? `${name} is not marked as demo data (mode is "${meta.mode}").`
      : meta.mode === 'mock'
        ? 'The published data is demo data, not NASA observations, so Bara will not show it as real. Run the data export, or open the page with ?mock=1 to see the demo.'
        : `${name} is not marked as real data (mode is "${meta.mode}").`;
    throw new DataError(msg, name);
  }
  for (const key of ['coverage', 'lastCompleteMonth', 'areas', 'defaultArea']) {
    if (meta[key] == null) throw new DataError(`${name} has no "${key}".`, name);
  }
  if (!meta.areas.length) throw new DataError(`${name} lists no areas.`, name);
  return Object.freeze(meta);
}

function cached(file, load) {
  if (!cache.has(file)) {
    const promise = load();
    cache.set(file, promise);
    promise.catch(() => cache.delete(file)); // allow a retry after a failure
  }
  return cache.get(file);
}

async function fetchJSON(file) {
  const name = `${FOLDER}${file}`;
  let response;
  try {
    response = await fetch(new URL(file, BASE));
  } catch (err) {
    throw new DataError(`Could not reach ${name}: ${err.message}`, name);
  }
  if (!response.ok) {
    throw new DataError(`Missing data file ${name} (HTTP ${response.status}).`, name);
  }
  try {
    return await response.json();
  } catch {
    throw new DataError(`${name} is not valid JSON.`, name);
  }
}
