// Shared state for Bara (C1). Shape is fixed by the PRD:
//   { areaId, startMonth, endMonth, selectedMonth, sensorView, playing }
// getState()        -> frozen copy
// setState(partial) -> validates, updates, notifies once; returns a list of rejected inputs (empty if all ok)
// subscribe(fn)     -> fn(state, changedKeys[]); returns unsubscribe()
// configure(bounds) -> called once by main.js after meta.json loads: { areaIds, start, end }

export const SENSOR_VIEWS = ['harmonized', 'raw-modis', 'raw-viirs'];
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

let state = {
  areaId: 'div:mukah',
  startMonth: '2019-01',
  endMonth: '2025-12',
  selectedMonth: '2025-08',
  sensorView: 'harmonized',
  playing: false,
};

const KEYS = new Set(Object.keys(state));
const params = new URLSearchParams(window.location.search);
const DEBUG = params.get('mock') === '1' || params.get('debug') === '1';

let bounds = null; // { areaIds: Set, start: 'YYYY-MM', end: 'YYYY-MM' }
const subscribers = new Map(); // fn -> module label (debug logs only)
let notifying = false;
const queue = [];

export function isMonth(value) {
  return typeof value === 'string' && MONTH_RE.test(value);
}

export function configure({ areaIds, start, end }) {
  if (!isMonth(start) || !isMonth(end) || start > end) {
    throw new Error(`store.configure: coverage must be YYYY-MM with start <= end, got ${start} to ${end}`);
  }
  bounds = { areaIds: new Set(areaIds), start, end };
}

export function getBounds() {
  return bounds ? { areaIds: [...bounds.areaIds], start: bounds.start, end: bounds.end } : null;
}

export function getState() {
  return Object.freeze({ ...state });
}

export function setState(partial) {
  if (partial === null || typeof partial !== 'object') {
    return [`setState expects an object, got ${String(partial)}`];
  }
  if (notifying) {
    queue.push(partial);
    return [];
  }
  const errors = apply(partial);
  while (queue.length) apply(queue.shift());
  return errors;
}

export function subscribe(fn) {
  if (typeof fn !== 'function') throw new TypeError('subscribe expects a function');
  subscribers.set(fn, callerLabel());
  return () => subscribers.delete(fn);
}

function clampMonth(m) {
  if (!bounds) return m;
  if (m < bounds.start) return bounds.start;
  if (m > bounds.end) return bounds.end;
  return m;
}

// Validate one batch of changes. Bad values are rejected (state keeps its old value for that key);
// months outside the loaded coverage are clamped; the range is always kept start <= selected <= end.
function validate(partial) {
  const next = { ...state };
  const errors = [];

  for (const [key, value] of Object.entries(partial)) {
    if (!KEYS.has(key)) {
      errors.push(`"${key}" is not part of the shared state.`);
      continue;
    }
    switch (key) {
      case 'areaId':
        if (typeof value !== 'string' || (bounds && !bounds.areaIds.has(value))) {
          errors.push(`Unknown area "${value}".`);
        } else {
          next.areaId = value;
        }
        break;
      case 'startMonth':
      case 'endMonth':
      case 'selectedMonth':
        if (!isMonth(value)) {
          errors.push(`"${value}" is not a month. Use the form YYYY-MM, for example 2019-08.`);
        } else {
          next[key] = clampMonth(value);
        }
        break;
      case 'sensorView':
        if (!SENSOR_VIEWS.includes(value)) {
          errors.push(`Unknown sensor view "${value}". Use one of: ${SENSOR_VIEWS.join(', ')}.`);
        } else {
          next.sensorView = value;
        }
        break;
      case 'playing':
        if (typeof value !== 'boolean') errors.push('playing must be true or false.');
        else next.playing = value;
        break;
    }
  }

  // Never an inverted range: the side the user just moved wins, the other side follows.
  if (next.startMonth > next.endMonth) {
    if ('endMonth' in partial && !('startMonth' in partial)) next.startMonth = next.endMonth;
    else next.endMonth = next.startMonth;
  }
  // The selected month always sits inside the range. If the user moved the selection, the range grows to
  // include it; if the user moved the range, the selection is pulled inside.
  if ('selectedMonth' in partial && !('startMonth' in partial) && !('endMonth' in partial)) {
    if (next.selectedMonth < next.startMonth) next.startMonth = next.selectedMonth;
    if (next.selectedMonth > next.endMonth) next.endMonth = next.selectedMonth;
  } else {
    if (next.selectedMonth < next.startMonth) next.selectedMonth = next.startMonth;
    if (next.selectedMonth > next.endMonth) next.selectedMonth = next.endMonth;
  }
  return { next, errors };
}

function apply(partial) {
  const { next, errors } = validate(partial);
  for (const e of errors) console.warn(`[store] ${e}`);

  const changed = [...KEYS].filter((k) => !Object.is(state[k], next[k]));
  if (changed.length === 0) return errors;
  state = next;

  const snapshot = getState();
  const notified = new Set();
  notifying = true;
  try {
    for (const [fn, label] of [...subscribers]) {
      try {
        fn(snapshot, changed);
        notified.add(label);
      } catch (err) {
        console.error(`[store] subscriber in ${label} threw while handling ${changed.join(', ')}:`, err);
      }
    }
  } finally {
    notifying = false;
  }
  if (DEBUG) {
    console.log(`[store] changed ${changed.join(', ')}. Re-rendered: ${notified.size ? [...notified].join(', ') : 'no modules'}`);
  }
  return errors;
}

function callerLabel() {
  for (const line of (new Error().stack || '').split('\n')) {
    const match = line.match(/\/js\/([\w./-]+?\.js)/);
    if (match && !match[1].endsWith('store.js')) return match[1];
  }
  return 'unknown module';
}
