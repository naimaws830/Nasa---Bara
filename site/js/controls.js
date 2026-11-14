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

  root.innerHTML = `
    <form class="controls-form" novalidate>
      <div class="field">
        <label for="ctl-area">Area</label>
        <select id="ctl-area"></select>
      </div>
      <div class="field">
        <label for="ctl-start">From</label>
        <input type="month" id="ctl-start" min="${start}" max="${end}" placeholder="YYYY-MM" pattern="\\d{4}-\\d{2}" required>
      </div>
      <div class="field">
        <label for="ctl-end">To</label>
        <input type="month" id="ctl-end" min="${start}" max="${end}" placeholder="YYYY-MM" pattern="\\d{4}-\\d{2}" required>
      </div>
      <div class="field">
        <label for="ctl-month">Selected month</label>
        <div class="stepper">
          <button type="button" class="button" id="ctl-prev" aria-label="Previous month">Previous</button>
          <input type="month" id="ctl-month" placeholder="YYYY-MM" pattern="\\d{4}-\\d{2}" required>
          <button type="button" class="button" id="ctl-next" aria-label="Next month">Next</button>
        </div>
      </div>
      <fieldset class="field segmented">
        <legend>Series</legend>
        ${SENSOR_VIEWS.map((v) => `
          <label><input type="radio" name="ctl-view" value="${v}"> ${VIEW_LABELS[v]}</label>`).join('')}
      </fieldset>
    </form>
    <div class="controls-messages">
      <p class="controls-error" id="ctl-error" role="alert"></p>
      <p class="controls-note" id="ctl-note" aria-live="polite"></p>
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
