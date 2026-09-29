#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = '/Users/williamzheng/Desktop/journey-sphere';
const output = path.join(root, 'outputs/zoom-detail/stroke-width-prototype');
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

for (const original of [...globalScenarios].filter(item => ['japan-islands','norway-fjords','aleutian-dateline'].includes(item.key))) {
  const centers={'japan-islands':[33.20,129.65],'norway-fjords':[60.39,5.29],'aleutian-dateline':[52.017,179.626]};
  globalScenarios.push({...original,key:original.key+'-zoom12',zoom:12,center:centers[original.key]});
}
const mime = { html: 'text/html; charset=utf-8', js: 'text/javascript', json: 'application/json', css: 'text/css' };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/fixture.html') {
      const scenario = globalScenarios.find(item => item.key === url.searchParams.get('scenario'));
      const zoom = scenario?.zoom ?? (url.searchParams.get('zoom') === '4' ? 4 : 9);
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
    const prototypeCode = /^data\/outlines\/(JPN|NOR|USA)\.json$/.exec(pathname)?.[1];
    const body = prototypeCode ? JSON.stringify({format:1,version:manifest.version,extent:manifest.extent,fingerprint:manifest.fingerprint,features:[JSON.parse(await readFile(`/tmp/journeysphere-outline-union/${prototypeCode}-children-widths.json`,'utf8'))]}) : await readFile(path.join(root, pathname));
    response.writeHead(200, { 'Content-Type': mime[pathname.split('.').pop()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(body);
  } catch { response.writeHead(404); response.end(); }
});
await mkdir(output, { recursive: true });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
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
async function measureCoastDisplacement(page) {
  return page.evaluate(() => {
    const map=window.journeySphere.map;const scene=window.__layer._sceneAt(map.getZoom());const wanted=window.__scenario;
    const region=scene.activeRecords.find(record=>record.id===wanted.selectedId);
    const outline=scene.worldRecords.find(record=>record.countryCode===wanted.code);
    function segments(d){
      const edges=[];let x=0,y=0,sx=0,sy=0;
      for(const token of d.matchAll(/([Mlz])(?:(-?\d+) (-?\d+))?/g)){
        if(token[1]==='M'){x=Number(token[2]);y=Number(token[3]);sx=x;sy=y;}
        else{const nx=token[1]==='z'?sx:x+Number(token[2]);const ny=token[1]==='z'?sy:y+Number(token[3]);if(nx!==x||ny!==y)edges.push([x,y,nx,ny]);x=nx;y=ny;}
      }
      return edges;
    }
    const ctx=document.createElement('canvas').getContext('2d');
    const candidates=scene.activeRecords.map(record=>({bounds:record.bounds,path:new Path2D(record.d)}));
    const inside=(x,y)=>candidates.some(record=>x>=record.bounds[0]&&x<=record.bounds[2]&&y>=record.bounds[1]&&y<=record.bounds[3]&&ctx.isPointInPath(record.path,x,y,'evenodd'));
    const detailEdges=segments(outline.d);let max=0,samples=0,coastalSegments=0,worst=null;
    const distance=(x,y,e)=>{const dx=e[2]-e[0],dy=e[3]-e[1];const t=Math.max(0,Math.min(1,((x-e[0])*dx+(y-e[1])*dy)/(dx*dx+dy*dy)));return Math.hypot(x-e[0]-t*dx,y-e[1]-t*dy)};
    for(const edge of segments(region.d)){
      const dx=edge[2]-edge[0],dy=edge[3]-edge[1],length=Math.hypot(dx,dy);const mx=(edge[0]+edge[2])/2,my=(edge[1]+edge[3])/2;
      const nx=-dy/length*2,ny=dx/length*2;
      if(inside(mx+nx,my+ny)===inside(mx-nx,my-ny))continue;
      coastalSegments++;
      for(const t of [0,0.5,1]){
        const x=edge[0]+t*dx,y=edge[1]+t*dy;if(inside(x+nx,y+ny)===inside(x-nx,y-ny))continue;let best=Infinity;
        for(const e of detailEdges){
          const bx=Math.max(Math.min(e[0],e[2])-x,0,x-Math.max(e[0],e[2]));const by=Math.max(Math.min(e[1],e[3])-y,0,y-Math.max(e[1],e[3]));
          if(Math.hypot(bx,by)>best)continue;
          best=Math.min(best,distance(x,y,e));if(best===0)break;
        }
        if(best>max){max=best;worst={x,y,edge,t,distance:best,latlng:map.unproject([x*256/(2**24),y*256/(2**24)],0)}}samples++;
      }
    }
    return {method:'canonical union side classification; edge endpoints and midpoints to detailed outline segments',coastalSegments,samples,worst,maxProjectedUnits:max,maxPixelsAtZoom12:max/16};
  });
}
async function globalScenario(scenario) {
  const page = await newPage(); const heldRoutes = []; let holdOutlines = true;
  await page.route('**/data/outlines/*.json', route => { if (holdOutlines) heldRoutes.push(route); else return route.continue(); });
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
  await page.unroute('**/data/outlines/*.json');
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
  const requestedCodes=[...new Set(after.requests.map(request=>new URL(request.url).pathname.split('/').pop().replace('.json','')))];
  if(scenario.code!=='USA')assert.ok(!requestedCodes.includes('USA'),`${scenario.key}: disconnected USA bounds do not trigger an unrelated fetch`);
  if(scenario.key==='germany-france-border')assert.ok(!requestedCodes.includes('RUS'),'European border view does not fetch distant Russia');
  if(scenario.key==='germany-france-border'){
    await page.evaluate(()=>window.journeySphere.map.setView([51.5074,-0.1278],7,{animate:false}));
    const londonLoaded=await page.evaluate(async()=>(await window.journeySphere.loadOutlineDetails()).map(record=>record.countryCode));
    assert.ok(londonLoaded.includes('GBR'),'London pan loads the visible British outline');
    const londonRequests=await page.evaluate(()=>window.__outlineRequests.map(request=>request.url));
    assert.ok(londonRequests.every(url=>!url.endsWith('/USA.json')&&!url.endsWith('/RUS.json')),'London does not fetch geographically unrelated USA or Russia');
  }
  assert.deepEqual(await page.evaluate(()=>window.__errors),[],`${scenario.key}: application has no errors`);
  const coastDisplacement = await measureCoastDisplacement(page);
  assert.ok(coastDisplacement.samples > 0, 'the selected region has classified coastline samples');
  console.error(JSON.stringify({scenario:scenario.key,coastDisplacement}));
  assert.ok(coastDisplacement.maxPixelsAtZoom12 < 0.5, 'sampled canonical coast aligns within half a CSS pixel at zoom 12');
  await destroyAndCheck(page);
  checks.push({coastDisplacement,case:`global ${scenario.key}`,zoom:scenario.zoom,selectedId:scenario.selectedId,label:scenario.canonical.name,point,worldVertices:{coarse:vertices(before.world),fine:vertices(after.world)},strokeRings:{total:after.world.strokeWidths.length,exterior:after.world.strokeWidths.filter(width=>width===null).length,retainedInterior:after.world.strokeWidths.filter(width=>width!==null&&width>=0.5*manifest.extent/(256*2**scenario.zoom)).length},requestedCodes,administrativeGeometry:'unchanged canonical ADM2',palette:'identical painted interior',codewordPreserved:true});
}
try {
  for (const scenario of globalScenarios.filter(item => ['japan-islands','norway-fjords','aleutian-dateline'].some(key=>item.key.startsWith(key)))) await globalScenario(scenario);
  assert.deepEqual(pageErrors, [], 'all contexts are free of uncaught browser errors');
  const result = { ok: true, baseline: '65d417c1', checks, screenshots: globalScreenshots, pageErrors };
  await writeFile(path.join(output, 'detail-test.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await Promise.all(contexts.map(context => context.close()));
  await browser.close();
  server.close();
}
