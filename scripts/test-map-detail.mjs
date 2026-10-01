#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeOutlinePath } from '../src/outline-detail.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(root, process.env.OUTPUT_DIR || 'outputs/zoom-detail');
const manifest = JSON.parse(await readFile(path.join(root, 'data/compiled/manifest.json'), 'utf8'));
assert.ok(manifest.outlines?.countries?.HKG, 'compiled manifest has no HKG detail outline');
const coarse = JSON.parse(execFileSync('git', ['show', '65d417c1:data/compiled/countries/HKG.json'], { cwd: root, encoding: 'utf8' })).features[0];
const hkgPath = '/data/outlines/HKG.json';
const overviewWorld = JSON.parse(await readFile(path.join(root, 'data/compiled/world.json'), 'utf8'));
const baselineManifest = JSON.parse(execFileSync('git', ['show', '65d417c1:data/compiled/manifest.json'], { cwd: root, encoding: 'utf8' }));
const globalScenarios = [
  { key: 'japan-islands', code: 'JPN', selectedId: 'JPN:ADM2:22064153B46179239075141', center: [33.14,129.6], zoom: 9, screenshot: true },
  { key: 'norway-fjords', code: 'NOR', selectedId: 'NOR:ADM2:86288312B18429617226236', center: [60.4,5.25], zoom: 9, screenshot: true },
  { key: 'germany-france-border', code: 'DEU', selectedId: 'DEU:ADM2:24449704B45383119464661', center: [49.2,6.95], zoom: 12 },
  { key: 'alaska', code: 'USA', selectedId: 'USA:ADM2:52423323B58185108898', center: [61.15,-149.8], zoom: 7 },
  { key: 'aleutian-dateline', code: 'USA', selectedId: 'USA:ADM2:52423323B14067598441828', center: [52.4,179.6], zoom: 9, screenshot: true },
];
for (const scenario of globalScenarios) {
  const countryFile = `data/compiled/countries/${scenario.code}.json`;
  const current = JSON.parse(await readFile(path.join(root, countryFile), 'utf8'));
  const baseline = JSON.parse(execFileSync('git', ['show', `65d417c1:${countryFile}`], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  assert.deepEqual(current, baseline, `${scenario.code}: canonical administrative data, IDs, indices and labels stay unchanged`);
  assert.equal(manifest.countries[scenario.code].color, baselineManifest.countries[scenario.code].color, `${scenario.code}: country palette is preserved`);
  scenario.canonical = current.features.find(record => record.id === scenario.selectedId);
  scenario.coarseWorld = overviewWorld.features.find(record => record.countryCode === scenario.code);
  assert.ok(scenario.canonical && scenario.coarseWorld, `${scenario.key}: representative region and world outline exist`);
}

const mime = { html: 'text/html; charset=utf-8', js: 'text/javascript', json: 'application/json', css: 'text/css' };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/fixture.html') {
      const scenario = globalScenarios.find(item => item.key === url.searchParams.get('scenario'));
      const zoom = scenario?.zoom ?? Number(url.searchParams.get('zoom') || 9);
      const selectedId = scenario?.selectedId || 'HKG:ADM0:HKG';
      const center = scenario?.center || [22.3,114.15];
      response.writeHead(200, { 'Content-Type': mime.html, 'Cache-Control': 'no-store' });
      response.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/node_modules/leaflet/dist/leaflet.css"><link rel="stylesheet" href="/src/style.css"><style>html,body,#map{margin:0;width:100%;height:100%}</style></head><body><div id="map"></div><script src="/node_modules/leaflet/dist/leaflet.js"></script><script>
window.__coarse=${JSON.stringify(coarse)};window.__scenario=${JSON.stringify(scenario || null)};
window.__firstTilePaintAt=null;window.__tileDraws=0;window.__outlineRequests=[];window.__errors=[];
const originalExtend=L.GridLayer.extend;
L.GridLayer.extend=function(properties){const createTile=properties.createTile;return originalExtend.call(this,{...properties,createTile:function(coords){const tile=createTile.call(this,coords);window.__tileDraws++;if(!window.__paintScheduled){window.__paintScheduled=true;requestAnimationFrame(()=>requestAnimationFrame(()=>{if(document.querySelector('#map canvas.leaflet-tile'))window.__firstTilePaintAt=performance.now()}))}return tile}})};
const originalFetch=window.fetch;window.fetch=function(input,options){const url=String(input);if(url.includes('/data/outlines/'))window.__outlineRequests.push({url,startTime:performance.now()});return originalFetch.call(this,input,options)};
</script><script type="module">import { createCompiledJourneySphere } from '/src/compiled.js';import manifest from '/data/compiled/manifest.js';window.__mapPromise=createCompiledJourneySphere('#map',{dataUrl:'/data/',manifest,visited:[${JSON.stringify(selectedId)}],center:${JSON.stringify(center)},zoom:${zoom},onError:error=>window.__errors.push({name:error.name,message:error.message})}).then(api=>{window.journeySphere=api;window.__initialCodeword=api.getCodeword();api.map.eachLayer(layer=>{if(layer._hitRecord)window.__layer=layer});return api});</script></body></html>`);
      return;
    }
    const pathname = decodeURIComponent(url.pathname).replace(/^\//, '');
    if (!pathname || pathname.includes('..')) throw new Error('invalid path');
    const body = await readFile(path.join(root, pathname));
    response.writeHead(200, { 'Content-Type': mime[pathname.split('.').pop()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(body);
  } catch { response.writeHead(404); response.end(); }
});
await mkdir(output, { recursive: true });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true,
  ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
});
const contexts = [];
const checks = [];
const pageErrors = [];
const globalScreenshots = [];
const waitFor = (page, expression, arg) => page.waitForFunction(expression, arg, { timeout: 30000 });
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function newPage(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1, ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  return page;
}
async function open(page, zoom = 9) {
  await page.goto(`${origin}/fixture.html?zoom=${zoom}`, { waitUntil: 'domcontentloaded' });
  await waitFor(page, () => window.journeySphere && window.__layer && window.__firstTilePaintAt !== null);
  assert.ok(await page.locator('#map canvas.leaflet-tile').count() > 0, 'first paint has actual map tiles');
}
async function fineReady(page) {
  const countries = await page.evaluate(async () => (await window.journeySphere.loadOutlineDetails()).map(record => record.countryCode));
  assert.ok(countries.includes('HKG'), 'visible outline loading returns HKG');
  await waitFor(page, () => window.__layer._sceneAt(window.journeySphere.map.getZoom()).activeRecords.some(record => record.id === 'HKG:ADM0:HKG' && record.d !== window.__coarse.d));
  await frames(page);
}
async function checkFineScene(page, expectedFine) {
  const state = await page.evaluate(() => {
    const scene = window.__layer._sceneAt(window.journeySphere.map.getZoom());
    return { region: scene.activeRecords.find(record => record.id === 'HKG:ADM0:HKG')?.d, world: scene.worldRecords.find(record => record.countryCode === 'HKG')?.d, parent: scene.adminRecords.find(record => record.countryCode === 'HKG')?.d, coarse: window.__coarse.d };
  });
  assert.ok(state.region, 'HKG selectable geometry is present');
  if (expectedFine) {
    assert.notEqual(state.region, state.coarse, 'selected outline uses genuine detail');
    assert.equal(state.world, state.region, 'world land and selected coastline use identical detail');
    assert.equal(state.parent, state.region, 'parent outline has no leftover coarse triangle');
  } else assert.equal(state.region, state.coarse, 'zoomed out selectable geometry returns to the coarse path');
}
async function findPoint(page, kind = 'fineOnly') {
  const point = await page.evaluate(({ kind, extent }) => {
    const map = window.journeySphere.map;
    const ctx = document.createElement('canvas').getContext('2d');
    const coarsePath = new Path2D(window.__coarse.d);
    const record = window.__layer._sceneAt(map.getZoom()).activeRecords.find(record => record.id === 'HKG:ADM0:HKG');
    const finePath = new Path2D(record.d);
    const size = map.getSize();
    const rect = map.getContainer().getBoundingClientRect();
    function inside(x, y) {
      const latlng = map.containerPointToLatLng([x, y]);
      const p = map.project(latlng, 0);
      const px = ((p.x % 256) + 256) % 256 * extent / 256;
      const py = p.y * extent / 256;
      return { fine: ctx.isPointInPath(finePath, px, py, 'evenodd'), coarse: ctx.isPointInPath(coarsePath, px, py, 'evenodd'), lat: latlng.lat, lng: latlng.lng };
    }
    for (let y = 80; y < size.y - 100; y += 3) for (let x = 55; x < size.x - 55; x += 3) {
      const p = inside(x, y);
      const canonicalLng = ((p.lng + 180) % 360 + 360) % 360 - 180;
      if (kind === 'fineOnly' && (p.lat < 22.18 || p.lat > 22.31 || canonicalLng < 114.08 || canonicalLng > 114.28)) continue;
      if (!(kind === 'fineOnly' ? p.fine && !p.coarse : p.coarse)) continue;
      // Four pixels of interior clearance makes clicks and pixel samples meaningful.
      if (![[4,0],[-4,0],[0,4],[0,-4]].every(([dx,dy]) => {
        const q = inside(x + dx, y + dy);
        return kind === 'fineOnly' ? q.fine && !q.coarse : q.coarse;
      })) continue;
      return { x: rect.left + x, y: rect.top + y, lat: p.lat, lng: p.lng, fine: p.fine, coarse: p.coarse };
    }
    return null;
  }, { kind, extent: manifest.extent });
  assert.ok(point, `find a visible ${kind} interior point with four pixels of clearance`);
  if (kind === 'fineOnly') { assert.equal(point.fine, true); assert.equal(point.coarse, false); }
  return point;
}
async function visiblePixel(page, point) {
  const pixels = await page.evaluate(({ x, y }) => [...document.querySelectorAll('#map canvas.leaflet-tile-loaded')].flatMap(canvas => {
    const rect = canvas.getBoundingClientRect();
    if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom || getComputedStyle(canvas).visibility === 'hidden') return [];
    return [Array.from(canvas.getContext('2d').getImageData(Math.floor((x-rect.left)*canvas.width/rect.width),Math.floor((y-rect.top)*canvas.height/rect.height),1,1).data)];
  }), point);
  assert.ok(pixels.some(([r,g,b,a]) => a > 180 && b > r + 15 && g > r), `fine HKG interior is visibly blue on canvas: ${JSON.stringify(pixels)}`);
  return pixels;
}
async function hoverAndClick(page, point) {
  await page.mouse.move(point.x, point.y);
  await page.locator('.leaflet-tooltip').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.leaflet-tooltip').count(), 1, 'exactly one hover label is visible');
  assert.equal(await page.locator('.leaflet-tooltip').innerText(), 'Hong Kong', 'fine-only land has the HKG hover label');
  await page.mouse.click(point.x, point.y);
  await waitFor(page, () => window.journeySphere.getVisited().length === 0);
  assert.deepEqual(await page.evaluate(() => window.journeySphere.getVisited()), [], 'real fine-only click toggles HKG off');
  await page.evaluate(() => window.journeySphere.setVisited(['HKG:ADM0:HKG']));
  assert.equal(await page.evaluate(() => window.journeySphere.getCodeword() === window.__initialCodeword), true, 'selection codeword is stable after detail and real clicks');
  await page.mouse.move(10, 10);
  await frames(page);
}
async function resetAndCheck(page, zoom = 9) {
  await page.evaluate(() => window.journeySphere.reset());
  await waitFor(page, zoom => {
    const map = window.journeySphere.map; const center = map.getCenter();
    return map.getZoom() === zoom && map.project(center).distanceTo(map.project([22.3,114.15])) <= 1;
  }, zoom);
  assert.deepEqual(await page.evaluate(() => window.journeySphere.getVisited()), ['HKG:ADM0:HKG'], 'reset restores original selection');
  assert.equal(await page.evaluate(() => window.journeySphere.getCodeword() === window.__initialCodeword), true, 'reset restores original codeword');
  await frames(page);
}
async function destroyAndCheck(page) {
  await page.evaluate(() => window.journeySphere.destroy());
  assert.equal(await page.locator('#map canvas').count(), 0, 'destroy removes all canvases');
  assert.equal(await page.locator('.leaflet-tooltip').count(), 0, 'destroy removes hover labels');
}
async function genericSelectedPoint(page) {
  const point = await page.evaluate(extent => {
    const { canonical, coarseWorld } = window.__scenario;
    const selected = new Path2D(canonical.d); const coarseLand = new Path2D(coarseWorld.d);
    const context = document.createElement('canvas').getContext('2d');
    const map = window.journeySphere.map; const size = map.getSize();
    const rect = map.getContainer().getBoundingClientRect();
    function inside(x, y) {
      const latlng = map.containerPointToLatLng([x,y]); const p = map.project(latlng,0);
      const px = ((p.x % 256) + 256) % 256 * extent / 256; const py = p.y * extent / 256;
      return context.isPointInPath(selected,px,py,'evenodd') && context.isPointInPath(coarseLand,px,py,'evenodd');
    }
    for (let y = 85; y < size.y - 100; y += 3) for (let x = 55; x < size.x - 55; x += 3) {
      if (![[0,0],[4,0],[-4,0],[0,4],[0,-4]].every(([dx,dy]) => inside(x+dx,y+dy))) continue;
      const latlng = map.containerPointToLatLng([x,y]);
      if (window.__layer._hitRecord({latlng})?.id !== canonical.id) continue;
      return {x:x+rect.left,y:y+rect.top,lat:latlng.lat,lng:latlng.lng};
    }
    return null;
  }, manifest.extent);
  assert.ok(point, 'a visible canonical selected-region interior has a genuine map hit');
  return point;
}
async function selectedPixel(page, point) {
  const pixels = await page.evaluate(({x,y}) => [...document.querySelectorAll('#map canvas.leaflet-tile-loaded')].flatMap(canvas => {
    const rect = canvas.getBoundingClientRect();
    if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) return [];
    return [Array.from(canvas.getContext('2d').getImageData(Math.floor((x-rect.left)*canvas.width/rect.width),Math.floor((y-rect.top)*canvas.height/rect.height),1,1).data)];
  }), point);
  assert.ok(pixels.length > 0 && pixels.some(pixel => pixel[3] > 180), 'selected region has a painted canvas interior');
  return pixels;
}
// These fixed geographic probes lie on the dark seam edges found during
// visual review. Test actual canvas pixels, independently of stroke metadata.
async function checkSeamStrokes(page) {
  for(const zoom of [9,12])for(const [label,center,probe] of [['seam-area',[33.6,130.65],[33.64658193478108,130.85000038146973]],['wide-mark',[33.3,130.7],[33.30381113517198,130.7089912891388]]]){
    await page.evaluate(({center,zoom})=>window.journeySphere.map.setView(center,zoom,{animate:false}),{center,zoom});
    await page.evaluate(()=>window.journeySphere.loadOutlineDetails());await frames(page);
    const pixels = await page.evaluate(latlng=>{
      const p=window.journeySphere.map.latLngToContainerPoint(latlng);let dark=0,count=0;
      for(const canvas of document.querySelectorAll('#map canvas.leaflet-tile-loaded')){
        const rect=canvas.getBoundingClientRect();if(p.x<rect.left||p.x>=rect.right||p.y<rect.top||p.y>=rect.bottom)continue;
        const x=Math.floor((p.x-rect.left)*canvas.width/rect.width),y=Math.floor((p.y-rect.top)*canvas.height/rect.height);
        const sx=Math.max(0,x-4),sy=Math.max(0,y-4),w=Math.min(9,canvas.width-sx),h=Math.min(9,canvas.height-sy);
        const rgba=canvas.getContext('2d').getImageData(sx,sy,w,h).data;
        for(let i=0;i<rgba.length;i+=4){count++;if(rgba[i]<210&&rgba[i+1]<220&&rgba[i+2]<235&&rgba[i+3]>40)dark++;}
      }
      return {dark,count,point:p};
    },probe);
    assert.ok(pixels.count>=25, 'known former seam edge was sampled from actual painted tiles');
    assert.equal(pixels.dark,0,`unsupported seam has no dark stroke at zoom ${zoom}`);
    const file=`japan-${label}-zoom${zoom}.png`;globalScreenshots.push(file);await page.screenshot({path:path.join(output,file)});
    checks.push({case:`unsupported seam ${label}`,zoom,pixels});
  }
}
async function globalScenario(scenario) {
  const page = await newPage(); const heldRoutes = []; let holdOutlines = true;
  await page.route('**/data/outlines/**', route => { if (holdOutlines) heldRoutes.push(route); else return route.continue(); });
  await page.goto(`${origin}/fixture.html?scenario=${scenario.key}`, {waitUntil:'domcontentloaded'});
  await waitFor(page, () => window.journeySphere && window.__layer && window.__firstTilePaintAt !== null && window.__outlineRequests.length > 0);
  await frames(page);
  const before = await page.evaluate(() => {
    const config = window.__scenario; const scene = window.__layer._sceneAt(window.journeySphere.map.getZoom());
    return {record:scene.activeRecords.find(record=>record.id===config.selectedId),world:scene.worldRecords.find(record=>record.countryCode===config.code),codeword:window.journeySphere.getCodeword()};
  });
  assert.deepEqual(before.record, scenario.canonical, `${scenario.key}: selected ADM2 path is canonical before refinement`);
  assert.deepEqual(before.world, scenario.coarseWorld, `${scenario.key}: held response keeps the coarse world usable`);
  const point = await genericSelectedPoint(page);
  const beforePixel = await selectedPixel(page, point);
  if (scenario.screenshot) {
    const file = `${scenario.key}-coarse.png`; globalScreenshots.push(file);
    await page.screenshot({path:path.join(output,file)});
  }
  holdOutlines = false;
  await Promise.all(heldRoutes.map(route=>route.continue()));
  await page.unroute('**/data/outlines/**');
  const loaded = await page.evaluate(async () => (await window.journeySphere.loadOutlineDetails()).map(record=>record.countryCode));
  assert.ok(loaded.includes(scenario.code), `${scenario.key}: this viewport receives its country's fine outline`);
  await waitFor(page, () => {
    const config=window.__scenario; const scene=window.__layer._sceneAt(window.journeySphere.map.getZoom());
    return scene.worldRecords.find(record=>record.countryCode===config.code).d!==config.coarseWorld.d;
  });
  await frames(page);
  const after = await page.evaluate(() => {
    const config=window.__scenario; const scene=window.__layer._sceneAt(window.journeySphere.map.getZoom());
    return {record:scene.activeRecords.find(record=>record.id===config.selectedId),world:scene.worldRecords.find(record=>record.countryCode===config.code),codeword:window.journeySphere.getCodeword(),requests:window.__outlineRequests,firstPaint:window.__firstTilePaintAt,bounds:{west:window.journeySphere.map.getBounds().getWest(),east:window.journeySphere.map.getBounds().getEast()}};
  });
  assert.deepEqual(after.record, scenario.canonical, `${scenario.key}: finer country outline preserves canonical ADM2 geometry, index, label and ID`);
  assert.equal(after.codeword,before.codeword, `${scenario.key}: refinement does not change the visit codeword`);
  const vertices=record=>(record.d.match(/l/g)||[]).length;
  assert.ok(vertices(after.world)>vertices(before.world), `${scenario.key}: detailed country geometry contains more vertices than overview`);
  assert.ok(after.requests.every(request=>request.startTime>=after.firstPaint), `${scenario.key}: refinement waits for first tile paint`);
  const afterPixel=await selectedPixel(page,point);
  assert.deepEqual(afterPixel,beforePixel, `${scenario.key}: the selected interior retains its actual rendered palette`);
  await page.mouse.move(point.x,point.y);
  await page.locator('.leaflet-tooltip').waitFor({state:'visible'});
  assert.equal(await page.locator('.leaflet-tooltip').innerText(),scenario.canonical.name,`${scenario.key}: canonical region hover label remains correct`);
  await page.mouse.click(point.x,point.y);
  await waitFor(page,()=>window.journeySphere.getVisited().length===0);
  await page.evaluate(id=>window.journeySphere.setVisited([id]),scenario.selectedId);
  assert.equal(await page.evaluate(()=>window.journeySphere.getCodeword()),before.codeword,`${scenario.key}: real click plus selection restore preserves the codeword`);
  await page.mouse.move(10,10);await frames(page);
  if(scenario.screenshot){const file=`${scenario.key}-fine.png`;globalScreenshots.push(file);await page.screenshot({path:path.join(output,file)});}
  if(scenario.key==='aleutian-dateline')assert.ok(after.bounds.west<180&&after.bounds.east>180,'Aleutian test viewport genuinely straddles the dateline');
  const requestedCodes=[...new Set(after.requests.map(request=>new URL(request.url).pathname
    .match(/\/outlines\/(?:overview\/|fragments\/)?([A-Z]{3})(?:\/|\.json)/)?.[1]).filter(Boolean))];
  if(scenario.code!=='USA')assert.ok(!requestedCodes.includes('USA'),`${scenario.key}: disconnected USA bounds do not trigger an unrelated fetch`);
  if(scenario.key==='germany-france-border')assert.ok(!requestedCodes.includes('RUS'),'European border view does not fetch distant Russia');
  if(scenario.key==='germany-france-border'){
    await page.evaluate(()=>window.journeySphere.map.setView([51.5074,-0.1278],7,{animate:false}));
    const londonLoaded=await page.evaluate(async()=>(await window.journeySphere.loadOutlineDetails()).map(record=>record.countryCode));
    assert.ok(londonLoaded.includes('GBR'),'London pan loads the visible British outline');
    const londonRequests=await page.evaluate(()=>window.__outlineRequests.map(request=>request.url));
    assert.ok(londonRequests.every(url=>!url.endsWith('/USA.json')&&!url.endsWith('/RUS.json')),'London does not fetch geographically unrelated USA or Russia');
  }
  if(scenario.key==='japan-islands')await checkSeamStrokes(page);
  assert.deepEqual(await page.evaluate(()=>window.__errors),[],`${scenario.key}: application has no errors`);
  await destroyAndCheck(page);
  checks.push({case:`global ${scenario.key}`,zoom:scenario.zoom,selectedId:scenario.selectedId,label:scenario.canonical.name,point,worldVertices:{coarse:vertices(before.world),fine:vertices(after.world)},requestedCodes,administrativeGeometry:'unchanged canonical ADM2',palette:'identical painted interior',codewordPreserved:true});
}
try {
  const desktop = await newPage();
  await open(desktop);
  await fineReady(desktop);
  await checkFineScene(desktop, true);
  const timing = await desktop.evaluate(() => ({ firstPaint: window.__firstTilePaintAt, requests: window.__outlineRequests, initialCodeword: window.__initialCodeword, currentCodeword: window.journeySphere.getCodeword() }));
  const hkgRequests = timing.requests.filter(request => request.url.endsWith('/outlines/HKG.json'));
  assert.ok(hkgRequests.length >= 1, 'HKG outline request was observed');
  assert.ok(timing.requests.every(request => request.startTime >= timing.firstPaint), 'all outline fetches begin after the first tile has had a paint opportunity');
  assert.equal(timing.currentCodeword, timing.initialCodeword, 'automatic outline refinement preserves the original codeword');
  const fineOnlyPoint = await findPoint(desktop);
  const pixel = await visiblePixel(desktop, fineOnlyPoint);
  await hoverAndClick(desktop, fineOnlyPoint);
  await desktop.screenshot({ path: path.join(output, 'desktop-zoom9-dpr1.png') });
  checks.push({ case: 'desktop fine-only coast, first paint, hover, click and codeword', point: fineOnlyPoint, pixel, firstPaintMs: timing.firstPaint, firstDetailMs: Math.min(...timing.requests.map(request => request.startTime)) });
  for (const zoom of [9, 12]) {
    await desktop.evaluate(({lat,lng,zoom}) => window.journeySphere.map.setView([lat,lng+720],zoom,{animate:false}), { ...fineOnlyPoint, zoom });
    await fineReady(desktop);
    await checkFineScene(desktop, true);
    const center = await desktop.evaluate(() => ({ ...window.journeySphere.map.getCenter(), zoom: window.journeySphere.map.getZoom() }));
    assert.ok(center.lng > 720, 'the map actually remains two full world wraps east');
    assert.equal(center.zoom, zoom);
    const wrappedPoint = await findPoint(desktop);
    await visiblePixel(desktop, wrappedPoint);
    await hoverAndClick(desktop, wrappedPoint);
    checks.push({ case: `two world wraps at zoom ${zoom}`, point: wrappedPoint });
  }
  await desktop.evaluate(({lat,lng}) => window.journeySphere.map.setView([lat,lng],12,{animate:false}), fineOnlyPoint);
  await fineReady(desktop);
  await desktop.screenshot({ path: path.join(output, 'desktop-zoom12-dpr1.png') });
  const requestCount = await desktop.evaluate(() => window.__outlineRequests.length);
  await desktop.evaluate(() => window.journeySphere.map.setZoom(3,{animate:false}));
  await frames(desktop);
  await desktop.waitForTimeout(150);
  await checkFineScene(desktop, false);
  assert.equal(await desktop.evaluate(() => window.__outlineRequests.length), requestCount, 'zooming out starts no detailed outline requests');
  await resetAndCheck(desktop);
  await fineReady(desktop);
  await checkFineScene(desktop, true);
  assert.deepEqual(await desktop.evaluate(() => window.__errors), [], 'normal desktop interactions produce no application errors');
  await destroyAndCheck(desktop);
  checks.push({ case: 'zoom-out coarse fallback, reset, and destroy' });

  const overview = await newPage();
  await open(overview, 4);
  await fineReady(overview);
  const overviewState = await overview.evaluate(() => ({
    requests: window.__outlineRequests, firstPaint: window.__firstTilePaintAt,
    hkg: window.__layer._sceneAt(window.journeySphere.map.getZoom()).worldRecords.find(record => record.countryCode === 'HKG').d,
  }));
  assert.ok(overviewState.requests.length > 0, 'cold zoom-4 overview refines visible countries');
  const tierAssets = new Set(Object.values(manifest.outlines.countries).flatMap(entry =>
    (entry.fragments ? entry.fragments.map(fragment => fragment.file) : [entry.overviewFile])
      .map(file => new URL(file, `${origin}/data/compiled/`).href)));
  assert.ok(overviewState.requests.every(request => tierAssets.has(request.url)),
    'cold zoom-4 overview requests only the declared compact tier or its exact safe fallbacks');
  assert.ok(overviewState.requests.every(request => request.startTime >= overviewState.firstPaint),
    'compact refinement waits for the first tile paint');
  const compactHkg = JSON.parse(await readFile(path.resolve(root, 'data/compiled', manifest.outlines.countries.HKG.overviewFile), 'utf8'));
  assert.equal(overviewState.hkg, decodeOutlinePath(compactHkg.features[0]), 'zoom-4 land uses the published compact outline');
  await checkFineScene(overview, true);
  await destroyAndCheck(overview);
  checks.push({ case: 'cold zoom-4 overview refines after paint using compact assets only', requests: overviewState.requests.length });

  const lowOverview = await newPage();
  await open(lowOverview, 3);
  await lowOverview.waitForTimeout(180);
  assert.deepEqual(await lowOverview.evaluate(() => window.__outlineRequests), [], 'cold zoom-3 overview downloads no refinement assets');
  await checkFineScene(lowOverview, false);
  await destroyAndCheck(lowOverview);
  checks.push({ case: 'cold zoom-3 overview has zero refinement requests' });

  const mobile = await newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await open(mobile);
  assert.equal(await mobile.evaluate(() => innerWidth), 390, 'mobile viewport is genuinely 390 CSS pixels');
  assert.equal(await mobile.evaluate(() => devicePixelRatio), 2);
  await fineReady(mobile);
  const mobilePoint = await findPoint(mobile);
  await visiblePixel(mobile, mobilePoint);
  await mobile.touchscreen.tap(mobilePoint.x, mobilePoint.y);
  await waitFor(mobile, () => window.journeySphere.getVisited().length === 0);
  await resetAndCheck(mobile);
  await fineReady(mobile);
  await mobile.screenshot({ path: path.join(output, 'mobile-zoom9-dpr2.png') });
  await mobile.evaluate(({lat,lng}) => window.journeySphere.map.setView([lat,lng+720],12,{animate:false}), mobilePoint);
  await fineReady(mobile);
  const mobileWrapped = await findPoint(mobile);
  assert.ok((await mobile.evaluate(() => window.journeySphere.map.getCenter().lng)) > 720);
  await visiblePixel(mobile, mobileWrapped);
  await mobile.touchscreen.tap(mobileWrapped.x, mobileWrapped.y);
  await waitFor(mobile, () => window.journeySphere.getVisited().length === 0);
  await mobile.evaluate(() => window.journeySphere.setVisited(['HKG:ADM0:HKG']));
  await frames(mobile);
  await mobile.screenshot({ path: path.join(output, 'mobile-zoom12-dpr2.png') });
  assert.deepEqual(await mobile.evaluate(() => window.__errors), [], 'mobile touch and wrap produce no application errors');
  await destroyAndCheck(mobile);
  checks.push({ case: 'DPR2 mobile real touch and two world wraps at zoom 12', point: mobilePoint, wrappedPoint: mobileWrapped });

  const held = await newPage();
  let heldRoute;
  let requestFailed = false;
  held.on('requestfailed', request => { if (new URL(request.url()).pathname === hkgPath) requestFailed = true; });
  await held.route(`**${hkgPath}`, route => { heldRoute = route; });
  await open(held);
  await waitFor(held, () => window.__outlineRequests.some(request => request.url.endsWith('/outlines/HKG.json')));
  assert.ok(heldRoute, 'HKG detail network response is genuinely held');
  await checkFineScene(held, false);
  const heldPoint = await findPoint(held, 'coarse');
  await hoverAndClick(held, heldPoint);
  await held.evaluate(() => {
    window.__pendingSettled = false;
    window.__pending = window.journeySphere.loadOutlineDetails().then(() => { window.__pendingSettled = true; window.__pendingOutcome = 'resolved'; }, error => { window.__pendingSettled = true; window.__pendingOutcome = error.message; });
  });
  assert.equal(await held.evaluate(() => window.__pendingSettled), false, 'held detail promise is pending before destroy');
  await destroyAndCheck(held);
  await waitFor(held, () => window.__pendingSettled);
  assert.match(await held.evaluate(() => window.__pendingOutcome), /abort|destroy/i, 'destroy rejects the pending detail wait');
  for (let attempt = 0; !requestFailed && attempt < 100; attempt++) await held.waitForTimeout(10);
  assert.equal(requestFailed, true, 'destroy aborts the held HKG network request before the test releases its response');
  await heldRoute.abort('aborted');
  assert.deepEqual(await held.evaluate(() => window.__errors), [], 'expected cancellation does not report a user-facing error');
  await held.unroute(`**${hkgPath}`);
  await open(held);
  await fineReady(held);
  await checkFineScene(held, true);
  await destroyAndCheck(held);
  checks.push({ case: 'held HKG remains interactive; destroy settles and aborts; fresh map loads detail' });

  const heldModule = await newPage();
  let moduleRoute;
  await heldModule.route('**/src/outline-detail.js', route => { moduleRoute = route; });
  await open(heldModule);
  for (let attempt = 0; !moduleRoute && attempt < 100; attempt++) await heldModule.waitForTimeout(10);
  assert.ok(moduleRoute, 'deferred module response is genuinely held');
  await heldModule.evaluate(() => {
    window.__moduleSettled = false;
    window.__moduleWait = window.journeySphere.loadOutlineDetails().then(() => { window.__moduleSettled = true; window.__moduleOutcome = 'resolved'; }, error => { window.__moduleSettled = true; window.__moduleOutcome = error.message; });
  });
  assert.equal(await heldModule.evaluate(() => window.__moduleSettled), false);
  await destroyAndCheck(heldModule);
  await heldModule.waitForFunction(() => window.__moduleSettled, null, { timeout: 1000 });
  assert.match(await heldModule.evaluate(() => window.__moduleOutcome), /abort|destroy/i, 'destroy promptly rejects the public wait for a held module');
  await moduleRoute.continue();
  await heldModule.waitForTimeout(100);
  assert.equal(await heldModule.locator('#map canvas').count(), 0, 'late module response cannot recreate a destroyed map');
  assert.deepEqual(await heldModule.evaluate(() => window.__errors), [], 'late module response causes no application errors');
  checks.push({ case: 'held deferred module settles public detail promise on destroy within one second' });

  const retry = await newPage();
  let failHkg = true;
  let hkgAttempts = 0;
  await retry.route(`**${hkgPath}`, route => {
    hkgAttempts++;
    return failHkg ? route.fulfill({ status: 503, contentType: 'text/plain', body: 'intentional HKG detail failure' }) : route.continue();
  });
  await open(retry);
  await waitFor(retry, () => window.__errors.some(error => /503.*HKG/.test(error.message)));
  await checkFineScene(retry, false);
  const attemptsBeforeRetry = hkgAttempts;
  const explicitFailure = await retry.evaluate(async () => {
    try { await window.journeySphere.loadOutlineDetails(); return { resolved: true }; }
    catch (error) { return { resolved: false, message: error.message }; }
  });
  assert.equal(explicitFailure.resolved, false, 'explicit retry rejects while the targeted HKG response still fails');
  assert.match(explicitFailure.message, /503.*HKG/);
  assert.ok(hkgAttempts > attemptsBeforeRetry, 'explicit retry issues a new HKG request');
  failHkg = false;
  await fineReady(retry);
  await checkFineScene(retry, true);
  assert.ok(hkgAttempts >= 3, 'initial failure, failed explicit retry, and successful explicit retry all requested HKG');
  const retryPoint = await findPoint(retry);
  await visiblePixel(retry, retryPoint);
  await hoverAndClick(retry, retryPoint);
  const expectedErrors = await retry.evaluate(() => window.__errors);
  assert.ok(expectedErrors.length >= 1 && expectedErrors.every(error => /503.*HKG/.test(error.message)), 'only the injected HKG failure is reported');
  await destroyAndCheck(retry);
  checks.push({ case: 'targeted HKG 503 is reported; explicit retry rejects then recovers', attempts: hkgAttempts, observedErrors: expectedErrors });

  for (const scenario of globalScenarios) await globalScenario(scenario);
  assert.ok(!timing.requests.some(request=>request.url.endsWith('/outlines/USA.json')),'Hong Kong does not fetch unrelated USA geometry');
  assert.deepEqual(pageErrors, [], 'all contexts are free of uncaught browser errors');
  const result = { ok: true, baseline: '65d417c1', checks, screenshots: ['desktop-zoom9-dpr1.png', 'desktop-zoom12-dpr1.png', 'mobile-zoom9-dpr2.png', 'mobile-zoom12-dpr2.png', ...globalScreenshots], pageErrors };
  await writeFile(path.join(output, 'detail-test.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await Promise.all(contexts.map(context => context.close()));
  await browser.close();
  server.close();
}
