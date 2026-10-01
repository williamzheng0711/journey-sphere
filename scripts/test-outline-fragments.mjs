#!/usr/bin/env node

// Real browser coverage for selective, lossless USA outline fragments.
// Administrative data is preloaded so held responses isolate the outline layer.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeOutlinePath } from '../src/outline-detail.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(root, process.env.OUTPUT_DIR || 'outputs/outline-fragments');
const manifest = JSON.parse(await readFile(path.join(root, 'data/compiled/manifest.json'), 'utf8'));
const world = JSON.parse(await readFile(path.join(root, 'data/compiled/world.json'), 'utf8'));
const usa = JSON.parse(await readFile(path.join(root, 'data/compiled/countries/USA.json'), 'utf8'));
const coarse = world.features.find(record => record.countryCode === 'USA');
const entry = manifest.outlines?.countries?.USA;
assert.ok(entry && coarse, 'USA outline and coarse world record are available');
assert.ok(Array.isArray(entry.fragments) && entry.fragments.length > 1, 'compiled USA manifest declares selective fragments');
const fragments = entry.fragments;
const fragmentStrokeWidths = new Map();
const fragmentPaths = new Map(await Promise.all(fragments.map(async fragment => {
  const payload = JSON.parse(await readFile(path.resolve(root, 'data/compiled', fragment.file), 'utf8'));
  assert.equal(payload.fragment, fragment.id, 'fragment payload identity matches its manifest');
  fragmentStrokeWidths.set(fragment.id, payload.features[0].strokeWidths);
  return [fragment.id, decodeOutlinePath(payload.features[0])];
})));

// Keep the ordinary atlas/catalog intact, but isolate the deferred country.
const fixtureManifest = { ...manifest, outlines: { ...manifest.outlines, countries: { USA: entry } } };
const scenarios = [
  { key: 'mainland', center: [37.77, -122.44], zoom: 9, name: 'San Francisco' },
  { key: 'alaska', center: [61.2, -149.85], zoom: 8, name: 'Anchorage' },
  { key: 'pacific', center: [13.45, 144.75], zoom: 9, name: 'Guam' },
  { key: 'aleutian', center: [52.1, 179.6], zoom: 8, name: 'Aleutians West' },
];
for (const scenario of scenarios) {
  scenario.canonical = usa.features.find(record => record.name === scenario.name);
  assert.ok(scenario.canonical, `${scenario.key}: canonical administrative region exists`);
}
const selectedIds = scenarios.map(scenario => scenario.canonical.id);
const pacificFragment = fragments.find(fragment => fragment.id === 3);
assert.ok(pacificFragment, 'western Pacific fragment exists');
const bufferedZoom = 9;
const gridPerPixel = manifest.extent / (256 * 2 ** bufferedZoom);
const bufferedScenario = { key: 'buffer-only', zoom: bufferedZoom, center: [13.45,
  (pacificFragment.bounds[0] - (1200 / 2 + 128) * gridPerPixel) / manifest.extent * 360 - 180] };
const alaskaFragment = fragments.find(fragment => fragment.id === 0);
const resizeScenario = { key: 'resize', zoom: 9, center: [52.1,
  (alaskaFragment.bounds[0] + manifest.extent - (512 + (390 / 2 + 1200 / 2) / 2) * gridPerPixel) / manifest.extent * 360 - 180] };
const shanghaiScenario = { key: 'shanghai', zoom: 4, center: [31.5, 121.8] };
const mime = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', json: 'application/json', css: 'text/css' };
const fixtureHead = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/vendor/leaflet/leaflet.css"><link rel="stylesheet" href="/src/style.css"><style>html,body,#map{margin:0;width:100%;height:100%}</style></head><body><div id="map"></div><script>
window.__fixtureManifest=${JSON.stringify(fixtureManifest)};window.__world=${JSON.stringify(world)};window.__usa=${JSON.stringify(usa)};window.__coarse=${JSON.stringify(coarse)};window.__selectedIds=${JSON.stringify(selectedIds)};
window.__errors=[];window.__requests=[];window.__firstPaint=null;
const NativePath2D=window.Path2D;window.Path2D=class extends NativePath2D{constructor(d){super(d);this.__journeyPath=typeof d==='string'?d:null}};
const originalFill=CanvasRenderingContext2D.prototype.fill;CanvasRenderingContext2D.prototype.fill=function(path,...args){if(path?.__journeyPath)(this.canvas.__journeyDrawnPaths||=new Set()).add(path.__journeyPath);return originalFill.call(this,path,...args)};
// Bitmap copies replace visible tile pixels during an in-place refresh. Track
// their source paths, and discard old paths whenever a canvas bitmap is reset.
for(const property of ['width','height']){const descriptor=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,property);Object.defineProperty(HTMLCanvasElement.prototype,property,{...descriptor,set(value){descriptor.set.call(this,value);this.__journeyDrawnPaths=new Set()}})}
const originalClear=CanvasRenderingContext2D.prototype.clearRect;CanvasRenderingContext2D.prototype.clearRect=function(x,y,width,height){const result=originalClear.call(this,x,y,width,height);if(x===0&&y===0&&width>=this.canvas.width&&height>=this.canvas.height)this.canvas.__journeyDrawnPaths=new Set();return result};
const originalDrawImage=CanvasRenderingContext2D.prototype.drawImage;CanvasRenderingContext2D.prototype.drawImage=function(source,...args){const result=originalDrawImage.call(this,source,...args);if(this.globalCompositeOperation==='copy')this.canvas.__journeyDrawnPaths=new Set(source.__journeyDrawnPaths||[]);else if(this.globalCompositeOperation==='source-over'&&this.globalAlpha>0)for(const path of source.__journeyDrawnPaths||[])(this.canvas.__journeyDrawnPaths||=new Set()).add(path);return result};
const originalFetch=window.fetch;window.fetch=function(input,options){const url=String(input instanceof Request?input.url:input);if(url.includes('/data/outlines/'))window.__requests.push({url,time:performance.now(),firstPaint:window.__firstPaint});return originalFetch.call(this,input,options)};
</script>`;
function fixture(scenario, unselected = false) {
  return `${fixtureHead}<script type="module">import * as L from '/vendor/leaflet/leaflet.esm.min.js';import {createCompiledJourneySphere} from '/src/compiled.js';window.L=L;
window.__mapPromise=createCompiledJourneySphere('#map',{leaflet:L,manifest:window.__fixtureManifest,dataUrl:'/data/',worldData:${unselected ? '{...window.__world,features:[window.__coarse]}' : 'window.__world'},initialCountries:{USA:window.__usa},backgroundDetails:false,visited:${unselected ? '[]' : 'window.__selectedIds'},center:${JSON.stringify(scenario.center)},zoom:${scenario.zoom},mapOptions:{worldCopyJump:false},onError:error=>window.__errors.push({name:error.name,message:error.message})}).then(api=>{window.journeySphere=api;window.__initialCodeword=api.getCodeword();api.map.eachLayer(layer=>{if(layer._hitRecord)window.__layer=layer});requestAnimationFrame(()=>{if(document.querySelector('#map canvas.leaflet-tile'))window.__firstPaint=performance.now()});return api});</script></body></html>`;
}
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/engine.html') {
      response.writeHead(200, { 'Content-Type': mime.html, 'Cache-Control': 'no-store' });
      response.end('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
      return;
    }
    if (url.pathname === '/fixture.html') {
      const scenario = [...scenarios, bufferedScenario, resizeScenario, shanghaiScenario].find(value => value.key === url.searchParams.get('case')) || scenarios[0];
      response.writeHead(200, { 'Content-Type': mime.html, 'Cache-Control': 'no-store' });
      response.end(fixture(scenario, url.searchParams.get('unselected') === '1'));
      return;
    }
    const pathname = decodeURIComponent(url.pathname).replace(/^\//, '');
    if (!pathname || pathname.split('/').includes('..')) throw new Error('invalid path');
    const body = await readFile(path.join(root, pathname));
    response.writeHead(200, { 'Content-Type': mime[pathname.split('.').pop()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(body);
  } catch { response.writeHead(404); response.end(); }
});
await mkdir(output, { recursive: true });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const contexts = [];
const checks = [];
const pageErrors = [];
const waitFor = (page, expression, arg) => page.waitForFunction(expression, arg, { timeout: 30000 });
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function newPage(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1, ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  return page;
}
async function open(page, scenario = scenarios[0], unselected = false) {
  await page.goto(`${origin}/fixture.html?case=${scenario.key}${unselected ? '&unselected=1' : ''}`, { waitUntil: 'domcontentloaded' });
  await waitFor(page, () => window.journeySphere && window.__layer && window.__firstPaint !== null);
  await frames(page);
}
async function pan(page, scenario, zoom = scenario.zoom, wrap = 0) {
  await page.evaluate(({ center, zoom, wrap }) => window.journeySphere.map.setView([center[0], center[1] + wrap], zoom, { animate: false }), { center: scenario.center, zoom, wrap });
  await frames(page);
}
async function sceneState(page) {
  return page.evaluate(() => {
    const api = window.journeySphere;
    const scene = window.__layer._sceneAt(api.map.getZoom());
    return { outline: scene.worldRecords.find(record => record.countryCode === 'USA'), worldUSACount: scene.worldRecords.filter(record => record.countryCode === 'USA').length, selected: scene.activeRecords.filter(record => window.__selectedIds.includes(record.id)), visited: api.getVisited(), codeword: api.getCodeword(), requests: window.__requests, errors: window.__errors, zoom: api.map.getZoom() };
  });
}
async function checkSelection(page, label) {
  const state = await sceneState(page);
  assert.equal(state.worldUSACount, 1, `${label}: one USA world record replaces the fallback without an overlay`);
  assert.equal(state.selected.length, selectedIds.length, `${label}: selectable regions are neither duplicated nor removed`);
  assert.deepEqual(state.visited, selectedIds, `${label}: selected IDs remain unchanged`);
  assert.equal(state.codeword, await page.evaluate(() => window.__initialCodeword), `${label}: visit codeword remains unchanged`);
  for (const scenario of scenarios) assert.deepEqual(state.selected.find(record => record.id === scenario.canonical.id), scenario.canonical, `${label}: ${scenario.name} retains exact canonical geometry, index, name, and parent`);
  return state;
}
async function checkFallback(page, label) {
  const state = await checkSelection(page, label);
  assert.equal(state.outline.d, coarse.d, `${label}: incomplete current-view coverage uses the whole coarse USA fallback`);
  return state;
}
async function ready(page, label) {
  const loaded = await page.evaluate(async () => (await window.journeySphere.loadOutlineDetails()).map(record => record.countryCode));
  assert.ok(loaded.includes('USA'), `${label}: explicit completion includes the visible USA outline`);
  await frames(page);
  const state = await checkSelection(page, label);
  assert.notEqual(state.outline.d, coarse.d, `${label}: completed coverage replaces the coarse outline`);
  const required = await requiredFragments(page);
  assert.ok(Array.isArray(state.outline.parts), `${label}: aggregate exposes conservative cached-fragment bounds`);
  const cached = fragments.filter(fragment => state.outline.parts.some(bounds => bounds.every((value, index) => value === fragment.bounds[index]))).map(fragment => fragment.id).sort((a, b) => a - b);
  assert.equal(cached.length, state.outline.parts.length, `${label}: aggregate parts identify distinct declared fragments`);
  assert.ok(required.every(id => cached.includes(id)), `${label}: every current-view and tile-buffer fragment is cached before replacement`);
  assert.equal(state.outline.d, cached.map(id => fragmentPaths.get(id)).join(' '), `${label}: aggregate contains cached lossless fragments in stable order`);
  const widths = cached.map(id => fragmentStrokeWidths.get(id));
  assert.deepEqual(state.outline.strokeWidths, widths.every(Array.isArray) ? widths.flat() : undefined, `${label}: aggregation preserves ring stroke eligibility`);
  return state;
}
async function requiredFragments(page, margin = 512) {
  return page.evaluate(({ fragments, extent, margin }) => {
    const map = window.journeySphere.map;
    const pixelBounds = map.getPixelBounds();
    const scale = extent / (256 * 2 ** map.getZoom());
    const padding = margin === 'normal' ? Math.max(256, (pixelBounds.max.x - pixelBounds.min.x) * scale * 0.04) : margin * scale;
    const left = pixelBounds.min.x * scale - padding;
    const right = pixelBounds.max.x * scale + padding;
    const top = pixelBounds.min.y * scale - padding;
    const bottom = pixelBounds.max.y * scale + padding;
    return fragments.filter(({ bounds: [minX, minY, maxX, maxY] }) => {
      if (maxY < top || minY > bottom) return false;
      const first = Math.ceil((left - maxX) / extent);
      const last = Math.floor((right - minX) / extent);
      return first <= last;
    }).map(fragment => fragment.id).sort((a, b) => a - b);
  }, { fragments, extent: manifest.extent, margin });
}
async function rememberOutline(page) {
  await page.evaluate(() => {
    window.__savedOutline = window.__layer._sceneAt(window.journeySphere.map.getZoom()).worldRecords.find(record => record.countryCode === 'USA');
    window.__savedOutlineJSON = JSON.stringify(window.__savedOutline);
  });
}
async function checkImmutable(page, label) {
  assert.equal(await page.evaluate(() => JSON.stringify(window.__savedOutline) === window.__savedOutlineJSON), true, `${label}: previously published outline record is immutable`);
}
async function selectedPoint(page, scenario) {
  const point = await page.evaluate(({ id, extent }) => {
    const map = window.journeySphere.map;
    const record = window.__usa.features.find(feature => feature.id === id);
    const canonical = new Path2D(record.d);
    const coarseLand = new Path2D(window.__coarse.d);
    const context = document.createElement('canvas').getContext('2d');
    const rect = map.getContainer().getBoundingClientRect();
    const size = map.getSize();
    const inside = (x, y, requireCoarse) => {
      const latlng = map.containerPointToLatLng([x, y]);
      const projected = map.project(latlng, 0);
      const px = ((projected.x % 256) + 256) % 256 * extent / 256;
      const py = projected.y * extent / 256;
      return [-1, 0, 1].some(shift => context.isPointInPath(canonical, px + shift * extent, py, 'evenodd') && (!requireCoarse || context.isPointInPath(coarseLand, px + shift * extent, py, 'evenodd')));
    };
    for (const requireCoarse of [true, false]) for (let y = 65; y < size.y - 85; y += 3) for (let x = 55; x < size.x - 55; x += 3) {
      if (![[0, 0], [4, 0], [-4, 0], [0, 4], [0, -4]].every(([dx, dy]) => inside(x + dx, y + dy, requireCoarse))) continue;
      const latlng = map.containerPointToLatLng([x, y]);
      if (window.__layer._hitRecord({ latlng })?.id !== id) continue;
      return { x: x + rect.left, y: y + rect.top, lat: latlng.lat, lng: latlng.lng, coarseUnderlay: requireCoarse };
    }
    return null;
  }, { id: scenario.canonical.id, extent: manifest.extent });
  assert.ok(point, `${scenario.key}: canonical land has a real hit with four pixels of interior clearance`);
  return point;
}
async function paintedPixel(page, point, kind = 'selected') {
  const pixels = await page.evaluate(({ x, y }) => [...document.querySelectorAll('#map canvas.leaflet-tile-loaded')].flatMap(canvas => {
    const rect = canvas.getBoundingClientRect();
    if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom || getComputedStyle(canvas).visibility === 'hidden') return [];
    return [Array.from(canvas.getContext('2d').getImageData(Math.floor((x - rect.left) * canvas.width / rect.width), Math.floor((y - rect.top) * canvas.height / rect.height), 1, 1).data)];
  }), point);
  if (kind === 'world') assert.ok(pixels.some(([r, g, b, a]) => a > 180 && r > 230 && g > 230 && b > 230), `unselected detailed land is painted on actual canvas tiles: ${JSON.stringify(pixels)}`);
  else assert.ok(pixels.some(([r, g, b, a]) => a > 80 && Math.max(r, g, b) - Math.min(r, g, b) > 20), `selected land is visibly colored on actual canvas tiles: ${JSON.stringify(pixels)}`);
  return pixels;
}
async function drawnOutlineTiles(page, finePath) {
  return page.evaluate(finePath => {
    const container = window.journeySphere.map.getContainer().getBoundingClientRect();
    const tiles = [...document.querySelectorAll('#map canvas.leaflet-tile-loaded')].filter(canvas => {
      const rect = canvas.getBoundingClientRect();
      return rect.right > container.left && rect.left < container.right && rect.bottom > container.top && rect.top < container.bottom;
    });
    return { visible: tiles.length, coarse: tiles.filter(canvas => canvas.__journeyDrawnPaths?.has(window.__coarse.d)).length, fine: tiles.filter(canvas => canvas.__journeyDrawnPaths?.has(finePath)).length };
  }, finePath);
}
async function inspectAndRestore(page, scenario, point, touch = false) {
  if (touch) await page.touchscreen.tap(point.x, point.y);
  else {
    await page.mouse.move(point.x, point.y);
    await page.locator('.leaflet-tooltip').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.leaflet-tooltip').innerText(), scenario.canonical.name, `${scenario.key}: real hover preserves the region label`);
    await page.mouse.click(point.x, point.y);
  }
  assert.deepEqual(await page.evaluate(() => window.journeySphere.getVisited()), selectedIds, `${scenario.key}: ${touch ? 'tap' : 'click'} preserves visits`);
  const remainingIds = selectedIds.filter(id => id !== scenario.canonical.id);
  await page.evaluate(ids => window.journeySphere.setVisited(ids), remainingIds);
  assert.deepEqual(await page.evaluate(() => window.journeySphere.getVisited()), remainingIds, `${scenario.key}: programmatic update removes exactly the canonical selected region`);
  await page.evaluate(ids => window.journeySphere.setVisited(ids), selectedIds);
  await checkSelection(page, `${scenario.key} restored after programmatic visit update`);
  if (!touch) await page.mouse.move(10, 10);
  await frames(page);
}

function responseGate(page, { hold = () => false, fail = () => false } = {}) {
  const held = [];
  const calls = [];
  const idsByPath = new Map(fragments.map(fragment => [new URL(fragment.file, `${origin}/data/compiled/`).pathname, fragment.id]));
  const install = page.route('**/data/outlines/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    const id = idsByPath.get(pathname);
    calls.push({ id, pathname });
    if (id !== undefined && hold(id)) { held.push({ id, route }); return; }
    if (id !== undefined && fail(id)) return route.fulfill({ status: 503, contentType: 'text/plain', body: `intentional USA fragment ${id} failure` });
    return route.continue();
  });
  return { install, calls, held,
    async release() {
      // A pan can abort a held route before it is released. Only that expected
      // cancellation may prevent continuation; the current-view wait checks it.
      await Promise.all(held.splice(0).map(async ({ route }) => {
        try { await route.continue(); } catch (error) {
          if (!/already handled|Target.*closed|Invalid InterceptionId|interception.*not found/i.test(error.message)) throw error;
        }
      }));
    },
  };
}
async function waitForHeld(page, gate, id) {
  for (let attempt = 0; attempt < 300 && !gate.held.some(value => value.id === id); attempt++) await page.waitForTimeout(10);
  assert.ok(gate.held.some(value => value.id === id), `fragment ${id} response is genuinely held`);
}
function checkSelectiveRequests(gate, required, label) {
  assert.deepEqual([...new Set(gate.calls.map(call => call.id))].sort((a, b) => a - b), required, `${label}: only current-view and two-tile-buffer fragments are requested`);
  assert.ok(gate.calls.every(call => call.id !== undefined), `${label}: no whole USA outline is downloaded`);
}
async function engineContract() {
  // Compare pristine namespaces. Real mouse interactions add runtime state
  // such as Draggable._dragging to the already-used production constructor.
  const page = await newPage();
  await page.goto(`${origin}/engine.html`, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async () => {
    const [source, production] = await Promise.all([import('/vendor/leaflet/leaflet-src.esm.js'), import('/vendor/leaflet/leaflet.esm.min.js')]);
    const describe = namespace => Object.fromEntries(Object.keys(namespace).map(name => {
      const value = namespace[name];
      const object = value !== null && ['object', 'function'].includes(typeof value);
      const properties = object ? Object.getOwnPropertyNames(value).filter(key => !['name', 'length', 'caller', 'arguments'].includes(key)).sort().map(key => [key, typeof value[key]]) : [];
      const prototype = typeof value === 'function' && value.prototype ? Object.getOwnPropertyNames(value.prototype).sort().map(key => [key, typeof value.prototype[key]]) : [];
      return [name, { type: typeof value, primitive: object ? null : value, properties, prototype }];
    }));
    return { source: describe(source), production: describe(production) };
  });
  assert.deepEqual(Object.keys(result.production), Object.keys(result.source), 'production Leaflet preserves named exports');
  const mismatches = Object.keys(result.source).filter(name => JSON.stringify(result.production[name]) !== JSON.stringify(result.source[name]));
  assert.deepEqual(mismatches, [], 'production Leaflet retains static/prototype property names and types, and primitive export values');
  checks.push({ case: 'minified Leaflet namespace and property compatibility', exports: Object.keys(result.source).length });
  await page.close();
}

try {
  await engineContract();
  for (const scenario of scenarios) {
    const page = await newPage();
    let hold = true;
    const gate = responseGate(page, { hold: () => hold }); await gate.install;
    await open(page, scenario);
    const required = await requiredFragments(page);
    assert.ok(required.length > 0 && required.length < fragments.length, `${scenario.key}: the viewport selects fewer pieces than the whole country`);
    for (const id of required) await waitForHeld(page, gate, id);
    await checkFallback(page, `${scenario.key} held`);
    const point = await selectedPoint(page, scenario);
    const before = await paintedPixel(page, point);
    checkSelectiveRequests(gate, required, scenario.key);
    const requests = (await sceneState(page)).requests;
    assert.ok(requests.every(request => request.firstPaint !== null && request.time >= request.firstPaint), `${scenario.key}: deferred fragment downloads start after the first painted map`);
    hold = false; await gate.release();
    await ready(page, `${scenario.key} completed`);
    const after = await paintedPixel(page, point);
    if (point.coarseUnderlay) assert.deepEqual(after, before, `${scenario.key}: deep selected land keeps its actual canvas palette`);
    await inspectAndRestore(page, scenario, point);
    if (scenario.key === 'aleutian') {
      assert.equal(await page.evaluate(() => { const bounds = window.journeySphere.map.getBounds(); return bounds.getWest() < 180 && bounds.getEast() > 180; }), true, 'Aleutian viewport genuinely crosses the dateline');
      await pan(page, scenario, scenario.zoom, 720);
      const wrappedRequired = await requiredFragments(page);
      assert.deepEqual(wrappedRequired, required, 'two world wraps select the same fragment identities');
      await ready(page, 'Aleutian two-world-wrap coverage');
      const wrappedPoint = await selectedPoint(page, scenario);
      await paintedPixel(page, wrappedPoint); await inspectAndRestore(page, scenario, wrappedPoint);
      assert.ok(wrappedPoint.lng > 720, 'real hit point remains two worlds east');
    }
    const screenshot = `${scenario.key}-complete.png`;
    await page.screenshot({ path: path.join(output, screenshot) });
    assert.deepEqual((await sceneState(page)).errors, [], `${scenario.key}: no user-facing errors`);
    checks.push({ case: `selective ${scenario.key}, held fallback, exact completion, real hit and palette`, required, requests: gate.calls, point, pixels: { before, after }, screenshot });
    await page.close();
  }

  const rapid = await newPage();
  let holdAlaska = true;
  const rapidGate = responseGate(rapid, { hold: id => id === 0 && holdAlaska }); await rapidGate.install;
  await open(rapid);
  await pan(rapid, scenarios[0], 8); const mainland = await ready(rapid, 'rapid-pan initial mainland');
  await rememberOutline(rapid);
  await pan(rapid, scenarios[1], 8); await waitForHeld(rapid, rapidGate, 0);
  await checkFallback(rapid, 'same-zoom pan to held Alaska');
  await paintedPixel(rapid, await selectedPoint(rapid, scenarios[1]));
  await rapid.evaluate(() => { window.__obsoleteSettled = false; window.journeySphere.loadOutlineDetails().then(() => { window.__obsoleteSettled = true; window.__obsoleteOutcome = 'resolved'; }, error => { window.__obsoleteSettled = true; window.__obsoleteOutcome = error.message; }); });
  await pan(rapid, scenarios[0], 8);
  assert.equal((await sceneState(rapid)).outline.d, mainland.outline.d, 'cached mainland coverage returns immediately at the same zoom');
  await ready(rapid, 'rapid-pan returned mainland');
  await waitFor(rapid, () => window.__obsoleteSettled);
  assert.match(await rapid.evaluate(() => window.__obsoleteOutcome), /visible|obsolete|abort/i, 'obsolete Alaska public wait settles on pan');
  await rapidGate.release();
  await checkImmutable(rapid, 'rapid A→B→A');
  await pan(rapid, scenarios[1], 8); await waitForHeld(rapid, rapidGate, 0);
  await checkFallback(rapid, 'retried Alaska still held');
  holdAlaska = false; await rapidGate.release();
  const alaska = await ready(rapid, 'Alaska retry completes');
  assert.notEqual(alaska.outline.d, mainland.outline.d, 'different coverage produces a different composite');
  await checkImmutable(rapid, 'Alaska arrival');
  await pan(rapid, scenarios[0], 8);
  assert.equal((await sceneState(rapid)).outline.d, alaska.outline.d, 'same-zoom cached mainland pan retains the complete immutable cached aggregate');
  const callsBefore = rapidGate.calls.length;
  await pan(rapid, scenarios[1], 8);
  assert.equal((await sceneState(rapid)).outline.d, alaska.outline.d, 'same-zoom cached Alaska pan refreshes the scene without a download callback');
  await ready(rapid, 'cached Alaska');
  assert.equal(rapidGate.calls.length, callsBefore, 'cached same-zoom pans issue no extra fragment downloads');
  assert.deepEqual((await sceneState(rapid)).errors, [], 'pan cancellations do not report user-facing errors');
  checks.push({ case: 'held same-zoom mainland→Alaska→mainland, cancellation, retry, immutable composites and cached scene coverage', requests: rapidGate.calls });
  await rapid.close();

  const retry = await newPage();
  let holdOldAlaska = true; let failPacific = true;
  const retryGate = responseGate(retry, { hold: id => id === 0 && holdOldAlaska, fail: id => id === 3 && failPacific }); await retryGate.install;
  await open(retry); await ready(retry, 'tier-pan mainland');
  await pan(retry, scenarios[1], 4); await waitForHeld(retry, retryGate, 0);
  await checkFallback(retry, 'zoom4 Alaska with held fragment');
  await pan(retry, scenarios[2], 6);
  const failure = await retry.evaluate(async () => { try { await window.journeySphere.loadOutlineDetails(); return { resolved: true }; } catch (error) { return { resolved: false, message: error.message }; } });
  assert.equal(failure.resolved, false, 'an explicit visible-fragment failure rejects completion');
  assert.match(failure.message, /503/, 'failed fragment identifies the HTTP failure');
  await checkFallback(retry, 'zoom6 Pacific failed fragment');
  await pan(retry, scenarios[2], 9);
  await checkFallback(retry, 'failed Pacific remains usable at fine zoom');
  const retryPoint = await selectedPoint(retry, scenarios[2]); await paintedPixel(retry, retryPoint);
  failPacific = false; holdOldAlaska = false; await retryGate.release();
  await ready(retry, 'explicit Pacific retry');
  await paintedPixel(retry, retryPoint); await inspectAndRestore(retry, scenarios[2], retryPoint);
  await pan(retry, scenarios[2], 4); await ready(retry, 'zoom4 after exact Pacific');
  assert.ok(retryGate.calls.filter(call => call.id === 3).length >= 2, 'only failed work needs a fresh Pacific request');
  const expectedErrors = (await sceneState(retry)).errors;
  assert.ok(expectedErrors.length > 0 && expectedErrors.every(error => /503/.test(error.message)), 'only injected fragment failures are reported');
  checks.push({ case: 'zoom4→6→9→4 with obsolete held Alaska, failed Pacific fallback and successful retry', failure, requests: retryGate.calls, errors: expectedErrors });
  await retry.close();

  const buffered = await newPage(); let holdBuffer = true;
  const bufferGate = responseGate(buffered, { hold: () => holdBuffer }); await bufferGate.install;
  await open(buffered, bufferedScenario);
  const withoutBuffer = await requiredFragments(buffered, 0);
  const withBuffer = await requiredFragments(buffered);
  assert.equal(withoutBuffer.includes(3), false, 'western Pacific component is outside the visible viewport');
  assert.equal(withBuffer.includes(3), true, 'western Pacific component is inside the two-tile buffer');
  assert.deepEqual(await requiredFragments(buffered, 'normal'), [], 'USA is outside the normal activation viewport');
  const offscreenLoaded = await buffered.evaluate(async () => (await window.journeySphere.loadOutlineDetails()).map(record => record.countryCode));
  assert.deepEqual(offscreenLoaded, [], 'offscreen USA tile coverage does not activate country refinement');
  assert.deepEqual(bufferGate.calls, [], 'offscreen USA buffer triggers no fragment download');
  await checkFallback(buffered, 'offscreen buffer keeps complete coarse coverage');
  await buffered.evaluate(() => { window.__dragStartScene = window.__layer._sceneAt(window.journeySphere.map.getZoom()); });
  await buffered.mouse.move(600, 400); await buffered.mouse.down();
  await buffered.mouse.move(200, 400, { steps: 10 });
  await buffered.waitForTimeout(250); await frames(buffered);
  assert.equal(await buffered.evaluate(() => window.__layer._sceneAt(window.journeySphere.map.getZoom()) !== window.__dragStartScene), true, 'live dragging refreshes scene coverage before moveend or a download callback');
  await checkFallback(buffered, 'real drag before deferred visible-country request');
  await paintedPixel(buffered, await selectedPoint(buffered, scenarios[2]));
  await buffered.mouse.up();
  await waitForHeld(buffered, bufferGate, 3);
  await checkFallback(buffered, 'newly visible USA fragment held after drag');
  holdBuffer = false; await bufferGate.release(); await ready(buffered, 'completed buffer-only coverage');
  const callsBeforeBufferPan = bufferGate.calls.length;
  await pan(buffered, scenarios[2]);
  await ready(buffered, 'pan into buffered Pacific land');
  await paintedPixel(buffered, await selectedPoint(buffered, scenarios[2]));
  assert.equal(bufferGate.calls.length, callsBeforeBufferPan, 'buffered land pans into view without another download');
  checks.push({ case: 'offscreen buffer stays deferred; live drag activates complete buffered coverage with held fallback', withoutBuffer, withBuffer, requests: bufferGate.calls });
  await buffered.close();

  const mobile = await newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await open(mobile, scenarios[2]); await ready(mobile, 'mobile Pacific');
  const mobilePoint = await selectedPoint(mobile, scenarios[2]); await paintedPixel(mobile, mobilePoint);
  await inspectAndRestore(mobile, scenarios[2], mobilePoint, true);
  await pan(mobile, scenarios[3], 9, 720); await ready(mobile, 'mobile wrapped Aleutian');
  const mobileWrapped = await selectedPoint(mobile, scenarios[3]); await paintedPixel(mobile, mobileWrapped);
  await inspectAndRestore(mobile, scenarios[3], mobileWrapped, true);
  assert.deepEqual((await sceneState(mobile)).errors, [], 'mobile touch and wrapping have no errors');
  await mobile.screenshot({ path: path.join(output, 'mobile-wrapped.png') });
  checks.push({ case: 'mobile DPR2 real touch, Pacific→Aleutian two-world-wrap pan', mobilePoint, mobileWrapped, screenshot: 'mobile-wrapped.png' });
  await mobile.close();

  const fractional = await newPage();
  await open(fractional, scenarios[2]);
  await pan(fractional, scenarios[2], 4);
  const atFour = await ready(fractional, 'fractional zoom initial4');
  assert.ok((await drawnOutlineTiles(fractional, atFour.outline.d)).fine > 0, 'zoom4 has genuinely painted detailed USA tiles');
  await fractional.evaluate(() => window.journeySphere.map.setZoom(3.5, { animate: true }));
  await waitFor(fractional, () => window.journeySphere.map.getZoom() === 3.5 && !window.journeySphere.map._animatingZoom);
  await frames(fractional);
  await checkFallback(fractional, 'fractional zoom below minZoom');
  const below = await drawnOutlineTiles(fractional, atFour.outline.d);
  assert.equal(below.fine, 0, `crossing below minZoom repaints retained tiles to coarse coverage: ${JSON.stringify(below)}`);
  await fractional.evaluate(() => window.journeySphere.map.setZoom(4, { animate: true }));
  await waitFor(fractional, () => window.journeySphere.map.getZoom() === 4 && !window.journeySphere.map._animatingZoom);
  const returnedFour = await ready(fractional, 'fractional zoom returns4');
  const above = await drawnOutlineTiles(fractional, returnedFour.outline.d);
  assert.equal(above.coarse, 0, `cached detail repaints retained coarse tiles after crossing minZoom: ${JSON.stringify(above)}`);
  assert.ok(above.fine > 0, 'cached USA detail paints without a fresh download after animated zoom returns4');
  await pan(fractional, scenarios[3], 8.5, 720); await ready(fractional, 'fractional wrapped fragment arrival');
  const fractionalPoint = await selectedPoint(fractional, scenarios[3]);
  await paintedPixel(fractional, fractionalPoint); await inspectAndRestore(fractional, scenarios[3], fractionalPoint);
  assert.ok(fractionalPoint.lng > 720, 'fractional wrapped hit remains two worlds east');
  checks.push({ case: 'animated fractional minZoom crossing both directions and wrapped8.5 detail-arrival redraw', below, above, fractionalPoint });
  await fractional.close();

  const worldOnly = await newPage(); let holdWorld = true;
  const worldGate = responseGate(worldOnly, { hold: () => holdWorld }); await worldGate.install;
  await open(worldOnly, scenarios[2], true); await waitForHeld(worldOnly, worldGate, 3);
  await pan(worldOnly, scenarios[2], 9.5, 720);
  holdWorld = false; await worldGate.release();
  const worldLoaded = await worldOnly.evaluate(async () => (await window.journeySphere.loadOutlineDetails()).map(record => record.countryCode));
  assert.ok(worldLoaded.includes('USA'), 'fractional wrapped world-only view loads USA');
  await frames(worldOnly);
  assert.deepEqual(await worldOnly.evaluate(() => window.journeySphere.getVisited()), [], 'world-only probe cannot be covered by a selected administrative fill');
  const worldPoint = await worldOnly.evaluate(() => {
    const map = window.journeySphere.map; const rect = map.getContainer().getBoundingClientRect();
    const point = map.latLngToContainerPoint([13.45, 864.75]);
    return { x: point.x + rect.left, y: point.y + rect.top };
  });
  const worldPixel = await paintedPixel(worldOnly, worldPoint, 'world');
  checks.push({ case: 'unselected wrapped9.5 Guam land after held fragment arrival and redraw', worldPixel, requests: worldGate.calls });
  await worldOnly.close();

  const resized = await newPage({ viewport: { width: 390, height: 600 } }); let holdResize = true;
  const resizeGate = responseGate(resized, { hold: id => id === 0 && holdResize }); await resizeGate.install;
  await open(resized, resizeScenario);
  const beforeResizeIds = await requiredFragments(resized);
  assert.equal(beforeResizeIds.includes(0), false, 'narrow dateline view excludes the Alaska-side fragment');
  const beforeResize = await ready(resized, 'narrow dateline coverage');
  await rememberOutline(resized);
  await resized.setViewportSize({ width: 1200, height: 800 });
  await waitFor(resized, () => window.journeySphere.map.getSize().x === 1200);
  await waitForHeld(resized, resizeGate, 0); await frames(resized);
  const afterResizeIds = await requiredFragments(resized);
  assert.ok(afterResizeIds.includes(0), 'expanded viewport and buffer require a new fragment');
  await checkFallback(resized, 'resize with new fragment held');
  const resizedTiles = await drawnOutlineTiles(resized, beforeResize.outline.d);
  assert.equal(resizedTiles.fine, 0, 'resize repaints retained partial-detail tiles to complete fallback');
  await paintedPixel(resized, await selectedPoint(resized, scenarios[3]));
  await checkImmutable(resized, 'held resize');
  holdResize = false; await resizeGate.release(); await ready(resized, 'resized coverage completes');
  await checkImmutable(resized, 'resize fragment arrival');
  checks.push({ case: 'resize exposes held fragment and repaints retained tiles to fallback', beforeResizeIds, afterResizeIds, resizedTiles, requests: resizeGate.calls });
  await resized.close();

  const shanghai = await newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const shanghaiGate = responseGate(shanghai); await shanghaiGate.install;
  await open(shanghai, shanghaiScenario);
  const shanghaiNormal = await requiredFragments(shanghai, 'normal');
  const shanghaiBuffer = await requiredFragments(shanghai);
  assert.deepEqual(shanghaiNormal, [], 'default Shanghai mobile view has no USA part in its normal viewport');
  assert.ok(shanghaiBuffer.length > 0, 'Shanghai regression genuinely contains USA pieces only in its distant tile buffer');
  const shanghaiLoaded = await shanghai.evaluate(async () => (await window.journeySphere.loadOutlineDetails()).map(record => record.countryCode));
  assert.deepEqual(shanghaiLoaded, [], 'default Shanghai mobile view does not load USA coverage');
  await shanghai.waitForTimeout(150);
  assert.deepEqual(shanghaiGate.calls, [], 'default Shanghai mobile view sends no USA fragment requests');
  await checkFallback(shanghai, 'default Shanghai mobile offscreen USA');
  assert.deepEqual((await sceneState(shanghai)).errors, [], 'mobile activation policy has no errors');
  checks.push({ case: 'default Shanghai mobile avoids USA downloads for offscreen-only tile-buffer pieces', normal: shanghaiNormal, buffered: shanghaiBuffer, requests: shanghaiGate.calls });
  await shanghai.close();

  assert.deepEqual(pageErrors, [], 'all contexts are free of uncaught browser errors');
  const result = { ok: true, fragmentSchema: 'whole-polygon USA fragments', checks, pageErrors };
  await writeFile(path.join(output, 'fragment-test.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const activePage = contexts.flatMap(context => context.pages()).at(-1);
  if (activePage) await activePage.screenshot({ path: path.join(output, 'failure.png') });
  await writeFile(path.join(output, 'fragment-test.json'), `${JSON.stringify({ ok: false, error: error.message, checks, pageErrors, screenshot: activePage ? 'failure.png' : null }, null, 2)}\n`);
  throw error;
} finally {
  await Promise.all(contexts.map(context => context.close()));
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
