// Bara M-03.5. Standalone, local-only browser regression diagnostic.
// Does not modify source, fetch directly, or change persistent files.
import { getState, setState } from '../store.js';
import { loadMeta, loadCalendar, loadMap, loadAreas, isMock } from '../data.js';
import { monthlyRows, MONTHLY_COLUMNS, toCSV } from '../series.js';
import { squareRows } from '../export.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const timeLimit = async (fn, ms = 10000) => Promise.race([
  fn(), new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms} ms`)), ms))
]);
function assert(condition, message) { if (!condition) throw new Error(message); }
function monthShift(ym, n) {
  const t = Number(ym.slice(0,4))*12 + Number(ym.slice(5,7))-1+n;
  return `${Math.floor(t/12)}-${String(t%12+1).padStart(2,'0')}`;
}
async function until(check, message, timeout=6000) {
  const start = performance.now();
  while (performance.now()-start < timeout) {
    if (check()) return;
    await sleep(80);
  }
  throw new Error(message);
}
function download(name, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
  const a=document.createElement('a'); a.href=url; a.download=name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),2000);
}
const node = selector => document.querySelector(selector);
const all = selector => [...document.querySelectorAll(selector)];

export function mount() {
  window.__baraRegressionAudit?.destroy?.();
  const root = document.createElement('section');
  root.setAttribute('aria-label','Bara regression test');
  root.style.cssText = 'position:fixed;z-index:10000;right:12px;bottom:12px;width:min(480px,calc(100vw - 24px));max-height:78vh;overflow:auto;background:var(--haze);color:var(--peat);border:2px solid var(--blackwater);padding:16px;font:14px/1.5 Archivo,sans-serif';
  root.innerHTML = `<h2 style="font-size:18px;margin:0 0 6px">M-03.5 Regression test</h2>
    <p style="margin:0 0 8px">Checks integrated A+B+C panels without replacing application files. The selected month, sensor and map view will briefly change and then be restored.</p>
    <p data-status role="status" aria-live="polite">Ready. Keep this Chrome tab visible.</p>
    <button type="button" data-run>Run regression tests</button>
    <button type="button" data-save disabled>Save JSON report</button>
    <button type="button" data-close>Close</button>
    <div data-results aria-live="polite"></div>`;
  for(const b of root.querySelectorAll('button')) b.style.cssText='margin:4px;padding:8px 10px;min-height:42px;border-radius:4px;border:1px solid var(--blackwater);background:var(--haze-deep);color:var(--peat);font:inherit;cursor:pointer';
  document.body.append(root);
  const runBtn=root.querySelector('[data-run]');
  const saveBtn=root.querySelector('[data-save]');
  const status=root.querySelector('[data-status]');
  const resultEl=root.querySelector('[data-results]');
  let report=null, destroyed=false, running=false;
  function destroy(){destroyed=true;root.remove(); if(window.__baraRegressionAudit?.destroy===destroy) delete window.__baraRegressionAudit;}
  root.querySelector('[data-close]').addEventListener('click',destroy);
  saveBtn.addEventListener('click',()=>report&&download(`bara_M03_5_regression_${Date.now()}.json`,report));
  window.__baraRegressionAudit={destroy,getReport:()=>report};
  runBtn.addEventListener('click', async()=>{
    if(running) return;
    running=true;runBtn.disabled=true;saveBtn.disabled=true;resultEl.replaceChildren();
    const before=getState();
    const viewBefore=node('#map input[name="map-view"]:checked')?.value || '2d';
    const scopeBefore=node('#map input[name="map-scope"]:checked')?.value || 'month';
    const results=[];const started=performance.now();
    const check=async(name,task)=>{
      if(destroyed) return;
      status.textContent=`Checking: ${name}`;
      const t=performance.now();
      try {const detail=await timeLimit(task,15000); results.push({name,status:'pass',durationMs:Math.round(performance.now()-t),detail:detail||''});}
      catch(e){results.push({name,status:'fail',durationMs:Math.round(performance.now()-t),error:e?.message||String(e)});}
      const last=results.at(-1);
      if(!destroyed){const p=document.createElement('p');p.style.margin='4px 0';p.textContent=`${last.status==='pass'?'Pass':'Fail'}: ${name}${last.error?' — '+last.error:''}`;resultEl.append(p);}
    };
    try {
      const meta=await loadMeta();
      const safe=meta.defaultArea;
      const testMonth=meta.lastCompleteMonth;
      const prevMonth=monthShift(testMonth,-1);
      // Do not allow a currently playing timeline to fight this test.
      setState({playing:false});
      await check('A: real and demo data are labelled correctly',async()=>{
        assert(meta.mode===(isMock?'mock':'real'),'Unexpected meta mode');
        assert(meta.coverage.start <= prevMonth && meta.lastCompleteMonth >= testMonth,'Invalid coverage');
        return `${meta.mode}, ${meta.coverage.start} to ${meta.lastCompleteMonth}`;
      });
      await check('A: 12-month data and missing values',async()=>{
        const cal=await loadCalendar(safe);
        assert(cal.months.length === cal.harmonizedCount.length,'Harmonized series length mismatch');
        for(const field of ['rawModisCount','rawViirsCount','status','seasonalMedian']) assert(cal[field].length===cal.months.length,`${field} length mismatch`);
        assert(cal.months.includes(testMonth),'Latest month absent');
        assert(cal.harmonizedCount.every(v=>v===null || (Number.isFinite(v)&&v>=0)),'Invalid count');
        return `${cal.months.length} monthly records validated`;
      });
      await check('A+B: observed yearly map data',async()=>{
        const year=Number(testMonth.slice(0,4));
        const [data,areas]=await Promise.all([loadMap(year),loadAreas()]);
        assert(data.year===year,'Year mismatch');
        assert(data.cell===0.05,'Unexpected grid cell size');
        assert(Array.isArray(data.cells)&&Array.isArray(areas.features),'Missing grid or boundaries');
        assert(data.cells.every(c=>Number.isFinite(c.lon)&&Number.isFinite(c.lat)&&c.month>=1&&c.month<=12&&c.count>=0),'Invalid cell data');
        return `${data.cells.length} observed cells in ${year}`;
      });
      await check('A+C: monthly CSV columns and row fidelity',async()=>{
        const cal=await loadCalendar(safe);
        const rows=monthlyRows(cal,meta,prevMonth,testMonth);
        assert(rows.length===2,'Expected exactly two monthly rows');
        assert(rows[0].month===prevMonth&&rows[1].month===testMonth,'CSV month order mismatch');
        assert(rows.every(r=>r.harmonizedCount===cal.harmonizedCount[cal.months.indexOf(r.month)]),'CSV differs from NASA calendar');
        const csv=toCSV(MONTHLY_COLUMNS,rows);
        assert(csv.startsWith(MONTHLY_COLUMNS.join(',')),'CSV headers incorrect');
        assert(csv.trimEnd().split('\n').length===3,'CSV line count incorrect');
        return '2 source-faithful monthly CSV rows';
      });
      await check('A+B+C: observed squares export',async()=>{
        const year=Number(testMonth.slice(0,4));
        const [map,areas]=await Promise.all([loadMap(year),loadAreas()]);
        const rows=squareRows([map],areas,safe,prevMonth,testMonth);
        assert(Array.isArray(rows),'Squares export returned no array');
        assert(rows.every(r=>r.month>=prevMonth&&r.month<=testMonth&&r.detections>=0),'Squares export range invalid');
        assert(rows.every(r=>r.sensor==='MODIS'||r.sensor==='VIIRS'),'Unexpected sensor in export');
        return `${rows.length} observed square rows`;
      });
      await check('C: required panels mounted',async()=>{
        for(const id of ['controls','map','status','calendar','proof','export']){
          const el=node(`#${id}`);assert(el,`Missing #${id}`);
          assert(el.dataset.mounted==='true',`#${id} not mounted (${el.dataset.mounted||'unknown'})`);
        }
        return 'Six panels mounted';
      });
      await check('B+C: month synchronises map, calendar and status',async()=>{
        const r=node('#map input[name="map-scope"][value="month"]');
        if(r&&!r.checked){r.checked=true;r.dispatchEvent(new Event('change',{bubbles:true}));}
        setState({areaId:safe,selectedMonth:prevMonth,sensorView:'harmonized'});
        await until(()=>node(`#calendar [data-month="${prevMonth}"]`)?.getAttribute('aria-selected')==='true','Calendar failed to highlight month');
        await until(()=>node('#st-title')?.textContent?.includes(prevMonth.slice(0,4)),'Status panel did not update');
        await until(()=>node('#map-fact-period')?.textContent?.includes(prevMonth.slice(0,4)),'Map month did not update');
        return `${prevMonth} consistent across three panels`;
      });
      await check('B+C: sensor view sync',async()=>{
        setState({sensorView:'raw-modis'});
        await until(()=>node('#cal-eyebrow')?.textContent?.includes('MODIS'),'Calendar did not reflect MODIS');
        await until(()=>node('#map-fact-sensor')?.textContent?.includes('MODIS'),'Map did not reflect MODIS');
        setState({sensorView:'raw-viirs'});
        await until(()=>node('#cal-eyebrow')?.textContent?.includes('VIIRS'),'Calendar did not reflect VIIRS');
        return 'MODIS and VIIRS labels synchronized';
      });
      await check('B: map switches between 2D and 3D',async()=>{
        for(const view of ['3d','2d']){
          const radio=node(`#map input[name="map-view"][value="${view}"]`);
          assert(radio,`Missing ${view} toggle`);
          if(!radio.checked){radio.checked=true;radio.dispatchEvent(new Event('change',{bubbles:true}));}
          await until(()=>node(`#map input[name="map-view"][value="${view}"]`)?.checked===true && !!node('#map-stage canvas'),`${view} map unavailable`,11000);
          // 3D asynchronous load must finish, not only have radio checked.
          if(view==='3d') await sleep(650);
        }
        return '3D canvas and 2D fallback visible';
      });
      await check('C: proof panel and CSV buttons available',async()=>{
        assert(node('#pf-chart')&&node('#pf-table'),'Proof graph or data table absent');
        assert(node('#ex-monthly')&&!node('#ex-monthly').disabled,'Monthly CSV control unavailable');
        assert(node('#ex-squares'),'Observed squares CSV control absent');
        return 'Proof panel and both export controls present';
      });
      await check('M-03: replay controller and state contract',async()=>{
        const replay=node('#map .bara-replay');
        assert(replay,'Automatic replay controls absent');
        const btn=replay.querySelector('[data-replay-play]');
        const range=replay.querySelector('input[type=range]');
        const speed=replay.querySelector('select');
        assert(btn&&range&&speed,'Replay play, range or speed control missing');
        assert(['1','2','4'].every(n=>[...speed.options].some(o=>o.value===n)),'Replay speeds incomplete');
        assert(typeof getState().selectedMonth==='string' && typeof getState().playing==='boolean','Store shape changed');
        return 'Replay UI and shared state available';
      });
    } catch(err) {results.push({name:'Test setup',status:'fail',error:err.message});}
    finally {
      status.textContent='Restoring your original selections…';
      try {
        setState({...before,playing:false});
        const scope=node(`#map input[name="map-scope"][value="${scopeBefore}"]`);
        if(scope&&!scope.checked){scope.checked=true;scope.dispatchEvent(new Event('change',{bubbles:true}));}
        const view=node(`#map input[name="map-view"][value="${viewBefore}"]`);
        if(view&&!view.checked){view.checked=true;view.dispatchEvent(new Event('change',{bubbles:true}));}
        await sleep(500);
      }catch(err){results.push({name:'State restoration',status:'fail',error:err.message});}
      report={audit:'Bara M-03.5',createdAt:new Date().toISOString(),url:location.href,mode:isMock?'mock':'real',results,passed:results.filter(r=>r.status==='pass').length,failed:results.filter(r=>r.status!=='pass').length,durationSeconds:Math.round((performance.now()-started)/1000*10)/10,notes:['This test covers live module/data integration; user interaction details and real file downloads need manual acceptance.','M-03.4 full replay performance was audited separately.','Canvas switching and controls are smoke-tested; deep GPU leak testing remains outside this audit.']};
      if(!destroyed){status.textContent=`Finished: ${report.passed} passed, ${report.failed} failed. Save the JSON report for review.`;saveBtn.disabled=false;}
      runBtn.disabled=false;running=false;
    }
  });
  return {destroy,getReport:()=>report};
}
