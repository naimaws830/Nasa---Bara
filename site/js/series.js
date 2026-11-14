// Pure helpers shared by the C2 and C3 panels (calendar, status, proof, export, about).
// No DOM and no fetch here, so everything can be tested in Node against the real JSON.

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
export const MONTH_SHORT = MONTH_NAMES.map((m) => m.slice(0, 3));

export const FIELD = { harmonized: 'harmonizedCount', 'raw-modis': 'rawModisCount', 'raw-viirs': 'rawViirsCount' };
export const VIEW_NAME = { harmonized: 'Harmonized', 'raw-modis': 'Raw MODIS', 'raw-viirs': 'Raw VIIRS' };

export function monthLabel(m) {
  return `${MONTH_NAMES[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
}

export function monthName(m) {
  return MONTH_NAMES[Number(m.slice(5, 7)) - 1];
}

export function periodLabel(start, end) {
  return start === end ? monthLabel(start) : `${monthLabel(start)} to ${monthLabel(end)}`;
}

/** Display a count the way every panel shows it: whole numbers, thousands separated. null stays null. */
export function fmtCount(v) {
  return v == null ? null : Math.round(v).toLocaleString('en-GB');
}

export function valuesFor(cal, view) {
  return cal[FIELD[view]];
}

export function indexOfMonth(cal, month) {
  return cal.months.indexOf(month);
}

/** Months of the calendar inside [start, end], with their index. */
export function monthsInRange(cal, start, end) {
  const out = [];
  cal.months.forEach((m, i) => { if (m >= start && m <= end) out.push(i); });
  return out;
}

function friendly(x) {
  if (x < 10) return Math.max(1, Math.ceil(x));
  if (x < 100) return Math.ceil(x / 5) * 5;
  if (x < 1000) return Math.ceil(x / 25) * 25;
  return Math.ceil(x / 250) * 250;
}

/**
 * Colour-bin upper edges for the calendar, from the non-zero values of one series (quantiles, rounded to
 * friendly numbers, strictly increasing). A value v falls in bin = number of edges <= v.
 */
export function calendarEdges(values) {
  const nz = values.filter((v) => v != null && v > 0).sort((a, b) => a - b);
  if (!nz.length) return [];
  const edges = [];
  for (let k = 1; k < 6; k++) {
    const q = nz[Math.min(nz.length - 1, Math.floor((k / 6) * nz.length))];
    const e = friendly(q);
    if (!edges.length || e > edges.at(-1)) edges.push(e);
  }
  return edges;
}

/** Bin 0..edges.length for a non-zero value. */
export function edgeBin(v, edges) {
  let i = 0;
  while (i < edges.length && v >= edges[i]) i++;
  return i;
}

/** Map a bin onto the six fire steps, spreading fewer bins across the whole ramp. */
export function fireStep(bin, edges) {
  const n = edges.length + 1;
  return n <= 1 ? 6 : Math.round(1 + (bin * 5) / (n - 1));
}

export function edgeLabels(edges) {
  if (!edges.length) return ['1 or more'];
  const out = [`under ${edges[0].toLocaleString('en-GB')}`];
  for (let i = 0; i < edges.length - 1; i++) {
    out.push(`${edges[i].toLocaleString('en-GB')} to under ${edges[i + 1].toLocaleString('en-GB')}`);
  }
  out.push(`${edges.at(-1).toLocaleString('en-GB')} or more`);
  return out;
}

/** Busiest year for the calendar month of `month`, among the reference's complete years. */
export function busiestYear(cal, view, month) {
  const mm = month.slice(5, 7);
  const [y0, y1] = cal.reference.completeYears;
  const vals = valuesFor(cal, view);
  let best = null;
  cal.months.forEach((m, i) => {
    const y = Number(m.slice(0, 4));
    if (m.slice(5, 7) !== mm || y < y0 || y > y1 || vals[i] == null) return;
    if (!best || vals[i] > best.value) best = { year: y, month: m, value: vals[i], status: cal.status[i] };
  });
  return best;
}

/** Plain comparison of a month with its seasonal median (harmonized series). */
export function compareText(value, median, month) {
  const name = monthName(month);
  if (value == null) return `No count for ${monthLabel(month)}.`;
  if (median == null) return `Not enough complete years to say what a usual ${name} is.`;
  if (median === 0) return value === 0 ? `Same as the usual ${name} (0).` : `Above the usual ${name}, which has a median of 0.`;
  const r = value / median;
  if (r >= 0.75 && r <= 1.25) return `About the same as the usual ${name} (median ${fmtCount(median)}).`;
  if (r > 1.25) return `${r < 10 ? r.toFixed(1) : Math.round(r)} times the usual ${name} (median ${fmtCount(median)}).`;
  return `Below the usual ${name}: ${Math.round(r * 100)}% of the median (${fmtCount(median)}).`;
}

/**
 * Simple level of a month against its usual value, for people who don't read statistics.
 * Returns { key, word } or null. Thresholds match compareText (within 25% = normal).
 */
export function levelOf(value, median) {
  if (value == null || median == null) return null;
  if (median === 0) return value === 0 ? { key: 'normal', word: 'Normal' } : { key: 'higher', word: 'Higher than normal' };
  const r = value / median;
  if (r < 0.75) return { key: 'lower', word: 'Lower than normal' };
  if (r <= 1.25) return { key: 'normal', word: 'Normal' };
  if (r < 2) return { key: 'higher', word: 'Higher than normal' };
  return { key: 'much', word: 'Much higher than normal' };
}

/** One or two everyday sentences about a month. No statistics words. */
export function plainSummary({ area, month, value, median, status, provisional }) {
  const name = monthName(month);
  if (value == null) return [`There is no full satellite record for ${area} in ${monthLabel(month)}.`];
  const n = Math.round(value);
  const out = [`Satellites spotted ${n.toLocaleString('en-GB')} hotspot${n === 1 ? '' : 's'} in ${area} in ${monthLabel(month)}.`];
  const lvl = levelOf(value, median);
  if (lvl) {
    const usual = `a normal ${name} has about ${fmtCount(median)}`;
    const phrase = {
      lower: `That is fewer than usual (${usual}).`,
      normal: `That is about normal (${usual}).`,
      higher: `That is more than usual (${usual}).`,
      much: `That is ${value / Math.max(median, 1e-9) >= 10 ? 'many' : `about ${Math.round(value / median)}`} times more than usual (${usual}).`,
    }[lvl.key];
    out.push(phrase);
  }
  if (status === 'estimated') out.push('This is an estimate, because the newer satellite only started in 2012.');
  if (provisional) out.push('Recent numbers may still change slightly.');
  return out;
}

// ---------- Preparedness (history-based, never a live alert) ----------

export const APIMS_URL = 'https://eqms.doe.gov.my/APIMS/main';

/**
 * Usual fire season of an area from its own history: median harmonized count per calendar month over the
 * complete reference years; the season is the run of months around the busiest one whose median is at least
 * `share` of the peak. Returns null when hotspots are too rare to speak of a season (peak median < minPeak).
 */
export function fireSeason(cal, { share = 0.25, minPeak = 3 } = {}) {
  const [y0, y1] = cal.reference.completeYears;
  const med = [];
  for (let mm = 1; mm <= 12; mm++) {
    const v = [];
    cal.months.forEach((m, i) => {
      const y = Number(m.slice(0, 4));
      if (Number(m.slice(5, 7)) === mm && y >= y0 && y <= y1 && cal.harmonizedCount[i] != null) v.push(cal.harmonizedCount[i]);
    });
    v.sort((a, b) => a - b);
    med.push(v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : 0);
  }
  const peakIdx = med.indexOf(Math.max(...med));
  const peak = med[peakIdx];
  if (peak < minPeak) return null;
  const inSeason = med.map((v) => v >= share * peak);
  let start = peakIdx;
  let end = peakIdx;
  for (let k = 0; k < 11 && inSeason[(start + 11) % 12] && (start + 11) % 12 !== end; k++) start = (start + 11) % 12;
  for (let k = 0; k < 11 && inSeason[(end + 1) % 12] && (end + 1) % 12 !== start; k++) end = (end + 1) % 12;
  const months = [];
  for (let k = start; ; k = (k + 1) % 12) { months.push(k + 1); if (k === end) break; }
  return { start: start + 1, end: end + 1, peak: peakIdx + 1, months, medians: med };
}

function monthsUntil(from, to) {
  return (to - from + 12) % 12;
}

/**
 * Preparedness notes for a month of the year (`nowMonth`, 1-12) given an area's season.
 * Returns { phase: 'in' | 'soon' | 'quiet', lines: [...], checklist: boolean }. Plain words, no alarm.
 */
export function preparedness(season, nowMonth, { area, busier = false, selectedLabel = '' } = {}) {
  const lines = [];
  let phase = 'quiet';
  if (season) {
    const name = (m) => MONTH_NAMES[m - 1];
    const range = season.start === season.end ? name(season.start) : `${name(season.start)} to ${name(season.end)}`;
    lines.push(`In ${area}, fire season usually runs ${range}, busiest in ${name(season.peak)}.`);
    if (season.months.includes(nowMonth)) {
      phase = 'in';
      lines.push(`It is ${name(nowMonth)} now, which is usually part of fire season.`);
    } else if (monthsUntil(nowMonth, season.start) <= 2) {
      phase = 'soon';
      lines.push(`Fire season usually starts in ${name(season.start)}, so now is a good time to prepare.`);
    } else {
      lines.push(`${name(nowMonth)} is usually a quiet month for fires here.`);
    }
  } else {
    lines.push(`Hotspots are rare in ${area}.`);
  }
  if (busier) {
    lines.push(`${selectedLabel || 'The month you picked'} was busier than usual. Fires nearby can bring haze.`);
  }
  return { phase, lines, checklist: phase !== 'quiet' || busier };
}

/** Descriptive anomaly wording. Never a warning: this is history, not a forecast. */
export function anomalyText(score, month) {
  const name = monthName(month);
  if (score == null) return null;
  const s = score.toFixed(1);
  if (score >= 3) return `Much higher than most ${name}s on record (anomaly score ${s}).`;
  if (score >= 2) return `Unusually high for ${name} (anomaly score ${s}).`;
  if (score > -1 && score < 1) return `Within the usual range for ${name} (anomaly score ${s}).`;
  if (score >= 1) return `Somewhat higher than a typical ${name} (anomaly score ${s}).`;
  return `Lower than a typical ${name} (anomaly score ${s}).`;
}

export function referenceText(cal) {
  const r = cal.reference;
  return `Usual = median of the same month in complete years ${r.completeYears[0]} to ${r.completeYears[1]}`
    + `${r.excludesTargetYear ? ', leaving out the year being compared' : ''}`
    + ` (at least ${r.minimumYears} years needed).`;
}

/** NASA FIRMS products whose coverage overlaps a month, per sensor. */
export function productsForMonth(meta, month) {
  const first = `${month}-01`;
  const last = `${month}-31`;
  return (meta.sensorProducts || []).filter((p) => p.coverage.start <= last && p.coverage.end >= first);
}

/** True when any product feeding the month is near-real-time (provisional, replaced later by standard). */
export function isProvisional(meta, month) {
  return productsForMonth(meta, month).some((p) => p.processing === 'nrt');
}

/** Uncertainty range for an estimated month, from harmonize.json. */
export function estimateRange(value, uncertainty) {
  if (value == null || !uncertainty) return null;
  return [value * uncertainty.lowFactor, value * uncertainty.highFactor];
}

// ---------- CSV ----------

export function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(columns, rows) {
  const lines = [columns.map(csvCell).join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

export const MONTHLY_COLUMNS = ['areaId', 'areaName', 'month', 'sourcePeriod', 'rawModisCount', 'rawViirsCount',
  'harmonizedCount', 'status', 'seasonalMedian', 'anomalyScore', 'units'];

/** One row per month of the selected range, copied from the calendar JSON (nothing computed but the source label). */
export function monthlyRows(cal, meta, start, end) {
  return monthsInRange(cal, start, end).map((i) => {
    const m = cal.months[i];
    const products = productsForMonth(meta, m)
      .map((p) => `${p.id} ${p.coverage.start > `${m}-01` ? `from ${p.coverage.start}` : ''}${p.coverage.end < `${m}-28` ? `to ${p.coverage.end}` : ''}`.trim());
    return {
      areaId: cal.areaId,
      areaName: cal.name,
      month: m,
      sourcePeriod: products.join('; '),
      rawModisCount: cal.rawModisCount[i],
      rawViirsCount: cal.rawViirsCount[i],
      harmonizedCount: cal.harmonizedCount[i],
      status: cal.status[i],
      seasonalMedian: cal.seasonalMedian[i],
      anomalyScore: cal.anomalyScore[i],
      units: cal.units,
    };
  });
}

export const SQUARE_COLUMNS = ['month', 'sensor', 'processing', 'cellCentreLon', 'cellCentreLat', 'cellSizeDeg',
  'detections', 'districtId'];
