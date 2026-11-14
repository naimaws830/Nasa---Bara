// M-03.4 diagnostic only: adds a removable audit panel, does not edit Bara source/data.
// Launch: import('./js/map/replay-audit.js').then(m => m.mount())
import { getState, setState, subscribe } from '../store.js';
import { loadMeta } from '../data.js';

const pad = (n) => String(n).padStart(2, '0');
const monthNumber = (ym) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
const toYM = (n) => `${Math.floor(n / 12)}-${pad(n % 12 + 1)}`;
const quantile = (sorted, p) => sorted.length ? sorted[Math.floor((sorted.length - 1) * p)] : null;
const sampleHeap = () => {
  const m = performance.memory;
  return m && Number.isFinite(m.usedJSHeapSize) ? Math.round(m.usedJSHeapSize / 1048576 * 10) / 10 : null;
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function download(name, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

export async function mount() {
  if (window.__baraReplayAudit?.destroy) window.__baraReplayAudit.destroy();
  const meta = await loadMeta();
  const first = monthNumber(meta.coverage.start);
  const last = monthNumber(meta.lastCompleteMonth);
  const total = last - first + 1;
  const root = document.createElement('section');
  root.setAttribute('aria-label', 'Replay performance audit');
  root.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:10000;max-width:min(460px,calc(100vw - 24px));max-height:70vh;overflow:auto;background:var(--haze,#E3E5DF);color:var(--peat,#2A221B);border:2px solid var(--blackwater,#24474A);padding:16px;font:14px/1.5 Archivo,system-ui,sans-serif;box-shadow:0 2px 12px #0002';
  root.innerHTML = `<h2 style="margin:0 0 8px;font-size:17px">M-03.4 Replay audit</h2>
    <p style="margin:0 0 8px">Checks all ${total} months (${meta.coverage.start} to ${meta.lastCompleteMonth}) at 4 months/second. Leave Chrome visible.</p>
    <p data-audit-status role="status" aria-live="polite">Ready. Switch the map to 3D before starting.</p>
    <button type="button" data-audit-start>Run full replay audit</button>
    <button type="button" data-audit-save disabled>Save JSON report</button>
    <button type="button" data-audit-close>Close</button>
    <pre data-audit-results style="font:12px/1.4 ui-monospace,monospace;white-space:pre-wrap;max-height:30vh;overflow:auto"></pre>`;
  root.querySelectorAll('button').forEach(b => b.style.cssText = 'margin:4px 4px 4px 0;padding:8px 12px;border:1px solid var(--blackwater,#24474A);border-radius:4px;background:var(--haze,#E3E5DF);color:var(--peat,#2A221B);cursor:pointer;min-height:40px;');
  document.body.append(root);
  const status = root.querySelector('[data-audit-status]');
  const resultEl = root.querySelector('[data-audit-results]');
  const startBtn = root.querySelector('[data-audit-start]');
  const saveBtn = root.querySelector('[data-audit-save]');
  let report = null;
  let busy = false;
  let abort = false;
  const destroyed = () => abort || !root.isConnected;
  const destroy = () => { abort = true; root.remove(); if (window.__baraReplayAudit?.destroy === destroy) delete window.__baraReplayAudit; };
  root.querySelector('[data-audit-close]').addEventListener('click', destroy);
  saveBtn.addEventListener('click', () => report && download(`bara_replay_audit_${Date.now()}.json`, report));
  window.__baraReplayAudit = { destroy, getReport: () => report };

  startBtn.addEventListener('click', async () => {
    if (busy) return;
    const replay = document.querySelector('#map .bara-replay');
    const playBtn = replay?.querySelector('[data-replay-play]');
    const speed = replay?.querySelector('select');
    const slider = replay?.querySelector('input[type=range]');
    if (!replay || !playBtn || !speed || !slider) { status.textContent = 'Replay controls are missing. Check M-03.2 integration.'; return; }
    if (getState().playing) { status.textContent = 'Pause the replay before starting an audit.'; return; }
    if (!document.querySelector('#map input[name="map-view"][value="3d"]:checked')) {
      status.textContent = 'Please select 3D on the map first, then run the audit.';
      return;
    }
    if (document.hidden) { status.textContent = 'Keep this browser tab visible before running the audit.'; return; }
    busy = true;
    abort = false;
    startBtn.disabled = true;
    saveBtn.disabled = true;
    report = null;
    resultEl.textContent = '';
    const stateBefore = getState();
    const speedBefore = speed.value;
    const observed = [];
    const calendarMisses = [];
    const frameIntervals = [];
    const memory = [];
    const interruptions = [];
    let rafId = null;
    let running = false;
    let rafPrev = 0;
    let lastSnapshot = null;
    let unsub = null;
    let began = 0;
    let finalReason = '';
    const memoryCapture = () => {
      const heapMB = sampleHeap();
      memory.push({ tSeconds: Math.round((performance.now() - began) / 1000), heapMB });
    };
    function frame(now) {
      if (!running || destroyed()) return;
      if (rafPrev && frameIntervals.length < 50000) frameIntervals.push(now - rafPrev);
      rafPrev = now;
      rafId = requestAnimationFrame(frame);
    }
    try {
      // User-facing inputs rather than internal replay APIs: test the actual integration.
      speed.value = '4';
      speed.dispatchEvent(new Event('change', { bubbles: true }));
      setState({ selectedMonth: toYM(first) });
      // The calendar rerenders asynchronously on date-range changes.
      await pause(200);
      began = performance.now();
      memoryCapture();
      let nextMemory = began + 5000;
      unsub = subscribe((state, changed) => {
        if (changed.includes('selectedMonth') && state.playing) {
          observed.push({ month: state.selectedMonth, tMS: Math.round(performance.now() - began) });
          // Allow other subscribed panels and their DOM updates to complete before checking.
          requestAnimationFrame(() => {
            if (destroyed()) return;
            const selected = document.querySelector('#calendar [data-month].is-selected');
            if (!selected || selected.dataset.month !== state.selectedMonth) {
              calendarMisses.push({ expected: state.selectedMonth, actual: selected?.dataset.month || null });
            }
          });
        }
        if (changed.includes('playing') && !state.playing && running) lastSnapshot = { ...state };
      });
      status.textContent = `Starting full replay (${total} months). Initial preload may take time.`;
      playBtn.click();
      // Wait for preloading + replay start; keep all timing data only for active playback.
      const preloadDeadline = performance.now() + 120000;
      while (!getState().playing && performance.now() < preloadDeadline && !destroyed()) {
        if (!playBtn.disabled && /could not|unavailable|failed/i.test(replay.querySelector('[role=status]')?.textContent || '')) break;
        await pause(200);
      }
      if (!getState().playing) throw new Error(`Replay did not start: ${replay.querySelector('[role=status]')?.textContent || 'timeout or interrupted'}`);
      running = true;
      rafPrev = 0;
      rafId = requestAnimationFrame(frame);
      const replayStart = performance.now();
      memoryCapture();
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const expectedSeconds = total / (reduced ? 1 : 4);
      const deadline = replayStart + Math.max(60000, expectedSeconds * 3000);
      while (performance.now() < deadline && !destroyed()) {
        if (document.hidden) { interruptions.push('Browser tab became hidden'); break; }
        if (performance.now() >= nextMemory) { memoryCapture(); nextMemory = performance.now() + 5000; }
        const s = getState();
        if (!s.playing) { finalReason = replay.querySelector('[role=status]')?.textContent || 'playback stopped'; break; }
        status.textContent = `Playing ${s.selectedMonth}; observed ${observed.length}/${total} month updates.`;
        await pause(200);
      }
      if (getState().playing && !destroyed()) {
        interruptions.push('Timed out before replay completed');
        playBtn.click();
      }
      const elapsed = Math.round((performance.now() - replayStart) / 1000 * 10) / 10;
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      await pause(150);
      memoryCapture();
      const expected = Array.from({ length: total }, (_, i) => toYM(first + i));
      const played = observed.map(x => x.month);
      const unique = new Set(played);
      const missing = expected.filter(x => !unique.has(x));
      const outOfOrder = played.filter((x, i) => i > 0 && monthNumber(x) <= monthNumber(played[i - 1]));
      const deltas = frameIntervals.filter(x => x > 0).sort((a, b) => a - b);
      const heap = memory.map(x => x.heapMB).filter(x => x !== null);
      const completed = !!lastSnapshot && lastSnapshot.selectedMonth === meta.lastCompleteMonth && !interruptions.length;
      report = {
        audit: 'Bara M-03.4', createdAt: new Date().toISOString(), source: location.href,
        coverage: { start: meta.coverage.start, end: meta.lastCompleteMonth, totalMonths: total },
        settings: { speed: reduced ? 'reduced motion 1 month/s' : '4 months/s', map: '3d' },
        completion: { completed, durationSeconds: elapsed, lastMonth: lastSnapshot?.selectedMonth || getState().selectedMonth,
          replayStatus: finalReason, observedUpdates: played.length, uniqueMonths: unique.size, missingMonths: missing,
          outOfOrder, calendarMismatches: calendarMisses, interruptions },
        rendering: { sampledFrames: deltas.length, p50FrameMS: quantile(deltas, .5), p95FrameMS: quantile(deltas, .95),
          p99FrameMS: quantile(deltas, .99), framesOver50MS: deltas.filter(x => x > 50).length,
          meanFrameMS: deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null },
        memory: { note: heap.length ? 'Chromium usedJSHeapSize sampling (no GPU memory); noisy, not proof of absence of leaks' : 'Chromium heap API unavailable; inspect Chrome Task Manager manually',
          samples: memory, startMB: heap[0] ?? null, endMB: heap.at(-1) ?? null,
          deltaMB: heap.length > 1 ? Math.round((heap.at(-1) - heap[0]) * 10) / 10 : null },
        verdict: completed && missing.length === 0 && outOfOrder.length === 0 && calendarMisses.length === 0
          ? 'Functional full-sequence pass; review frame and memory metrics manually' : 'Needs investigation',
      };
      resultEl.textContent = JSON.stringify({ verdict: report.verdict, completion: report.completion, rendering: report.rendering,
        memory: { startMB: report.memory.startMB, endMB: report.memory.endMB, deltaMB: report.memory.deltaMB } }, null, 2);
      status.textContent = `Audit finished. ${report.verdict}. Save the JSON report.`;
      saveBtn.disabled = false;
    } catch (err) {
      status.textContent = `Audit could not complete: ${err.message}`;
      report = { audit: 'Bara M-03.4', error: err.message, observed, calendarMisses, memory };
      saveBtn.disabled = false;
    } finally {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      if (unsub) unsub();
      speed.value = speedBefore;
      speed.dispatchEvent(new Event('change', { bubbles: true }));
      // Avoid restoring the month while replay runs (would trigger abrupt manual pause).
      if (!getState().playing && !destroyed()) setState({ selectedMonth: stateBefore.selectedMonth });
      busy = false;
      startBtn.disabled = false;
    }
  });
  return { destroy, getReport: () => report };
}
