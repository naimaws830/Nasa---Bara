// Area and date controls (C1): area, start and end month, selected month, sensor series.
// Native form controls only, so everything works with the keyboard.

import { getBounds, getState, isMonth, setState, subscribe, SENSOR_VIEWS } from './store.js';
import { loadMeta } from './data.js';

const VIEW_LABELS = { harmonized: 'Harmonized', 'raw-modis': 'Raw MODIS', 'raw-viirs': 'Raw VIIRS' };
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];

export function monthLabel(m) {
  return `${MONTH_NAMES[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
}

function shiftMonth(m, n) {
  const total = Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1 + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

export async function mount(root) {
  const meta = await loadMeta();
  const { start, end } = getBounds();

  const chevron = (d) => `<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"/></svg>`;
  root.innerHTML = `
    <div class="toolbar-card">
      <form class="toolbar" novalidate>
        <div class="field field-area">
          <label for="ctl-area">Area</label>
          <select id="ctl-area"></select>
        </div>
        <fieldset class="field field-range">
          <legend>Date range</legend>
          <div class="range-pair">
            <label class="range-part"><span class="range-label">From</span>
              <input type="month" id="ctl-start" min="${start}" max="${end}" placeholder="YYYY-MM" pattern="\\d{4}-\\d{2}" required></label>
            <span class="range-sep" aria-hidden="true"></span>
            <label class="range-part"><span class="range-label">To</span>
              <input type="month" id="ctl-end" min="${start}" max="${end}" placeholder="YYYY-MM" pattern="\\d{4}-\\d{2}" required></label>
          </div>
        </fieldset>
        <div class="field field-month">
          <label for="ctl-month">Selected month</label>
          <div class="stepper">
            <button type="button" class="icon-btn" id="ctl-prev" aria-label="Previous month">${chevron('M12 4l-6 6 6 6')}</button>
            <input type="month" id="ctl-month" placeholder="YYYY-MM" pattern="\\d{4}-\\d{2}" required>
            <button type="button" class="icon-btn" id="ctl-next" aria-label="Next month">${chevron('M8 4l6 6-6 6')}</button>
          </div>
        </div>
        <fieldset class="field field-series">
          <legend>Series</legend>
          <div class="seg">
            ${SENSOR_VIEWS.map((v) => `
              <label class="seg-opt"><input type="radio" name="ctl-view" value="${v}"><span>${VIEW_LABELS[v]}</span></label>`).join('')}
          </div>
        </fieldset>
      </form>
      <div class="controls-messages">
        <p class="controls-error" id="ctl-error" role="alert"></p>
        <p class="controls-note" id="ctl-note" aria-live="polite"></p>
      </div>
    </div>`;

  const $ = (id) => root.querySelector(`#${id}`);
  const area = $('ctl-area');
  area.append(...areaOptions(meta.areas));

  const errorEl = $('ctl-error');
  const noteEl = $('ctl-note');
  const defaultNote = `Data covers ${monthLabel(start)} to ${monthLabel(end)}.`;

  function commit(partial, input) {
    const errors = setState(partial);
    errorEl.textContent = errors.join(' ');
    if (input) input.setAttribute('aria-invalid', errors.length ? 'true' : 'false');
    // Tell the user when a value was clamped or the range moved to stay valid.
    const s = getState();
    const [key, asked] = Object.entries(partial)[0];
    noteEl.textContent = !errors.length && typeof asked === 'string' && s[key] !== asked
      ? `${monthLabel(s[key])} is the nearest month with data. ${defaultNote}`
      : defaultNote;
    if (errors.length) render(s); // put the last valid value back in the field
  }

  function monthInput(input, key) {
    input.addEventListener('change', () => {
      const value = input.value.trim();
      if (!isMonth(value)) {
        errorEl.textContent = `Enter a month between ${start} and ${end}, as YYYY-MM.`;
        input.setAttribute('aria-invalid', 'true');
        return;
      }
      commit({ [key]: value }, input);
    });
  }

  area.addEventListener('change', () => commit({ areaId: area.value }, area));
  monthInput($('ctl-start'), 'startMonth');
  monthInput($('ctl-end'), 'endMonth');
  monthInput($('ctl-month'), 'selectedMonth');
  $('ctl-prev').addEventListener('click', () => commit({ selectedMonth: shiftMonth(getState().selectedMonth, -1) }));
  $('ctl-next').addEventListener('click', () => commit({ selectedMonth: shiftMonth(getState().selectedMonth, 1) }));
  root.querySelectorAll('input[name="ctl-view"]').forEach((radio) => {
    radio.addEventListener('change', () => radio.checked && commit({ sensorView: radio.value }));
  });

  function render(s) {
    if (area.value !== s.areaId) area.value = s.areaId;
    setValue($('ctl-start'), s.startMonth);
    setValue($('ctl-end'), s.endMonth);
    setValue($('ctl-month'), s.selectedMonth);
    $('ctl-end').min = s.startMonth;
    $('ctl-start').max = s.endMonth;
    $('ctl-month').min = s.startMonth;
    $('ctl-month').max = s.endMonth;
    $('ctl-prev').disabled = s.selectedMonth <= start;
    $('ctl-next').disabled = s.selectedMonth >= end;
    root.querySelectorAll('input[name="ctl-view"]').forEach((r) => { r.checked = r.value === s.sensorView; });
  }

  noteEl.textContent = defaultNote;
  render(getState());
  subscribe((s) => render(s));
}

function setValue(input, value) {
  if (input.value !== value) input.value = value;
  input.setAttribute('aria-invalid', 'false');
}

function areaOptions(areas) {
  const label = (a) => (a.verified === false ? `${a.name} (unverified)` : a.name);
  const nodes = [];
  for (const a of areas.filter((x) => x.type === 'sarawak')) nodes.push(new Option(label(a), a.id));
  for (const div of areas.filter((x) => x.type === 'division')) {
    const group = document.createElement('optgroup');
    group.label = div.name;
    group.append(new Option(`${label(div)}, all districts`, div.id));
    for (const d of areas.filter((x) => x.type === 'district' && x.division === div.id)) {
      group.append(new Option(label(d), d.id));
    }
    nodes.push(group);
  }
  return nodes;
}
