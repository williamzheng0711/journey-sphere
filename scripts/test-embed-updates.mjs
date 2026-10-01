#!/usr/bin/env node

// Browser contracts for live updates to the standalone reusable component.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import aliases from '../data/embed/aliases.js';
import { normalizePlaceName, placeBucket } from '../src/place-names.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(root, process.env.OUTPUT_DIR || 'outputs/embed-updates');
const initialIds = aliases.singapore[0].ids;
const shanghaiIds = aliases.shanghai[0].ids;
const hongKongIds = aliases['hong kong'][0].ids;
const lookupPlace = 'Ayagawa, Kagawa Prefecture, JPN';
const lookupPath = `/data/embed/names/${placeBucket(normalizePlaceName('Ayagawa, Kagawa Prefecture'))}.json`;
assert.equal(Object.hasOwn(aliases, normalizePlaceName('Ayagawa, Kagawa Prefecture')), false, 'lookup fixture genuinely needs a name-index request');
const sgpChunk = `/data/embed/${aliases.singapore[0].chunks[0]}`;
const hongKongChunk = `/data/embed/${aliases['hong kong'][0].chunks[0]}`;
const shanghaiChunk = `/data/embed/${aliases.shanghai[0].chunks[0]}`;
const malformedSGP = JSON.parse(await readFile(path.join(root, sgpChunk.slice(1)), 'utf8'));
malformedSGP.features[0].d = 'invalid prepared geometry';
const fixture = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0}journey-sphere{display:block;width:100%;--journey-sphere-height:580px;--journey-sphere-radius:0}</style></head><body><journey-sphere places='["Singapore"]'></journey-sphere><script>
window.__events=[];window.__rejections=[];window.__element=document.querySelector('journey-sphere');
document.addEventListener('journey-ready',event=>window.__events.push({type:'ready',visited:event.detail.getVisited(),time:performance.now()}));
document.addEventListener('journey-error',event=>window.__events.push({type:'error',message:event.detail?.message||String(event.detail),time:performance.now()}));
window.addEventListener('unhandledrejection',event=>window.__rejections.push(String(event.reason?.message||event.reason)));
</script><script type="module" src="/embed.js"></script></body></html>`;
const mime = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', json: 'application/json', css: 'text/css' };
function createFixtureServer() {
  return createServer(async (request, response) => {
    try {
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Cache-Control', 'no-store');
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/fixture.html') {
        response.setHeader('Content-Type', mime.html); response.end(fixture); return;
      }
      const pathname = decodeURIComponent(url.pathname).replace(/^\//, '');
      if (!pathname || pathname.split('/').includes('..')) throw new Error('invalid path');
      const body = await readFile(path.join(root, pathname));
      response.setHeader('Content-Type', mime[pathname.split('.').pop()] || 'application/octet-stream');
      response.end(body);
    } catch { response.writeHead(404); response.end(); }
  });
}
const server = createFixtureServer(); const dataServer = createFixtureServer();
await mkdir(output, { recursive: true });
await Promise.all([new Promise(resolve => server.listen(0, '127.0.0.1', resolve)), new Promise(resolve => dataServer.listen(0, '127.0.0.1', resolve))]);
const origin = `http://127.0.0.1:${server.address().port}`;
const dataOrigin = `http://127.0.0.1:${dataServer.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const contexts = []; const checks = []; const pageErrors = [];
const waitFor = (page, expression, arg) => page.waitForFunction(expression, arg, { timeout: 30000 });
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1000, height: 620 } }); contexts.push(context);
  const page = await context.newPage(); page.requests = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => page.requests.push({ origin: new URL(request.url()).origin, path: new URL(request.url()).pathname }));
  // Outline downloads do not participate in place transactions. Holding them
  // keeps comparison of the already displayed canvas free of refinement redraws.
  await page.route('**/data/outlines/**', () => {});
  return page;
}
async function open(page, expectReady = true) {
  await page.goto(`${origin}/fixture.html`, { waitUntil: 'domcontentloaded' });
  await waitFor(page, () => customElements.get('journey-sphere'));
  if (expectReady) { await ready(page, initialIds); await remember(page); }
}
async function state(page) {
  return page.evaluate(() => {
    const element = window.__element; const api = element.journey;
    return { connected: element.isConnected, journey: !!api, sameJourney: api === window.__baseJourney,
      canvases: element.shadowRoot.querySelectorAll('canvas').length,
      retainedCanvases: (window.__baseCanvases || []).filter(canvas => canvas.isConnected).length,
      visited: api?.getVisited() || null, codeword: api?.getCodeword() || null,
      center: api ? [api.map.getCenter().lat, api.map.getCenter().lng] : null, zoom: api?.map.getZoom() ?? null,
      message: element.shadowRoot.querySelector('.message').textContent, events: window.__events,
      rejections: window.__rejections, blankFrames: window.__blankFrames || [] };
  });
}
async function ready(page, expected) {
  assert.equal(await page.evaluate(async () => Boolean(await window.__element.ready)), true, 'current update resolves to a usable API');
  await frames(page);
  const current = await state(page);
  assert.deepEqual(current.visited, expected, 'committed visited IDs match the requested places');
  assert.ok(current.canvases > 0, 'a committed map has actual canvas tiles');
  return current;
}
async function remember(page) {
  await page.evaluate(() => {
    window.__baseJourney = window.__element.journey;
    window.__baseCanvases = [...window.__element.shadowRoot.querySelectorAll('canvas')];
    window.__baseCodeword = window.__baseJourney.getCodeword();
    window.__blankFrames = [];
    if (!window.__watching) {
      window.__watching = true;
      const watch = () => {
        const element = window.__element;
        if (element.isConnected && !element.shadowRoot.querySelector('canvas')) window.__blankFrames.push(performance.now());
        requestAnimationFrame(watch);
      }; requestAnimationFrame(watch);
    }
  });
}
async function preserves(page, expected, label, retainedCanvas = false) {
  const current = await state(page);
  assert.equal(current.sameJourney, true, `${label}: the displayed API/map instance is retained`);
  assert.ok(current.canvases > 0, `${label}: the displayed canvas remains usable`);
  if (retainedCanvas) assert.ok(current.retainedCanvases > 0, `${label}: original displayed tiles remain connected during preparation`);
  assert.deepEqual(current.visited, expected, `${label}: current visits are preserved`);
  assert.deepEqual(current.blankFrames, [], `${label}: no animation frame loses the displayed map`);
  return current;
}
async function nearView(page, center, zoom, label) {
  await waitFor(page, zoom => {
    const map = window.__element.journey.map;
    return map.getZoom() === zoom && !map._animatingZoom && !map._panAnim?._inProgress;
  }, zoom);
  assert.equal(await page.evaluate(({ center, zoom }) => {
    const map = window.__element.journey.map;
    return map.getZoom() === zoom && map.project(map.getCenter()).distanceTo(map.project(center)) <= 1.5;
  }, { center, zoom }), true, `${label}: view matches within one canvas pixel`);
}
async function rejected(page, pattern) {
  const result = await page.evaluate(async () => { try { await window.__element.ready; return { resolved: true }; } catch (error) { return { resolved: false, message: error.message }; } });
  assert.equal(result.resolved, false, 'invalid or failed update rejects its readiness promise');
  assert.match(result.message, pattern);
  return result.message;
}
function gate(page, pattern, mode = 'hold') {
  const routes = []; const requests = []; let currentMode = mode;
  const install = page.route(pattern, route => {
    requests.push(new URL(route.request().url()).pathname);
    if (currentMode === 'hold') { routes.push(route); return; }
    if (currentMode === 'fail') return route.fulfill({ status: 503, contentType: 'text/plain', body: 'intentional update failure' });
    return route.continue();
  });
  return { install, routes, requests, set mode(value) { currentMode = value; },
    async release() { await Promise.all(routes.splice(0).map(async route => { try { await route.continue(); } catch (error) { if (!/already handled|Target.*closed|Invalid InterceptionId|interception.*not found/i.test(error.message)) throw error; } })); },
  };
}
async function held(page, responseGate) {
  for (let attempt = 0; attempt < 300 && !responseGate.routes.length; attempt++) await page.waitForTimeout(10);
  assert.ok(responseGate.routes.length > 0, 'a required response is genuinely held');
}
function resourceCounts(page) {
  return { world: page.requests.filter(request => request.path.endsWith('/data/embed/world.json')).length,
    chunks: page.requests.filter(request => /\/data\/embed\/(groups|regions)\//.test(request.path)).length,
    fullCountries: page.requests.filter(request => request.path.includes('/data/compiled/countries/')).length };
}
async function selectedPoint(page, id) {
  const result = await page.evaluate(id => {
    const api = window.__element.journey; let layer;
    api.map.eachLayer(candidate => { if (candidate._hitRecord) layer = candidate; });
    const record = layer._sceneAt(api.map.getZoom()).activeRecords.find(candidate => candidate.id === id);
    const context = document.createElement('canvas').getContext('2d'); const geometry = new Path2D(record.d);
    const size = api.map.getSize(); const rect = api.map.getContainer().getBoundingClientRect();
    const inside = (x, y) => {
      const point = api.map.project(api.map.containerPointToLatLng([x, y]), 0);
      const px = ((point.x % 256) + 256) % 256 * 2 ** 24 / 256;
      return context.isPointInPath(geometry, px, point.y * 2 ** 24 / 256, 'evenodd');
    };
    for (let y = 50; y < size.y - 85; y += 2) for (let x = 50; x < size.x - 50; x += 2) {
      if (![[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3]].every(([dx, dy]) => inside(x + dx, y + dy))) continue;
      const latlng = api.map.containerPointToLatLng([x, y]);
      if (layer._hitRecord({ latlng })?.id === id) return { x: rect.left + x, y: rect.top + y };
    } return null;
  }, id);
  assert.ok(result, 'selected land has a genuine hit point inside the visible map'); return result;
}
async function coloredPixel(page, point) {
  const pixels = await page.evaluate(({ x, y }) => [...window.__element.shadowRoot.querySelectorAll('canvas.leaflet-tile')].flatMap(canvas => {
    const rect = canvas.getBoundingClientRect(); if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) return [];
    return [Array.from(canvas.getContext('2d').getImageData(Math.floor((x - rect.left) * canvas.width / rect.width), Math.floor((y - rect.top) * canvas.height / rect.height), 1, 1).data)];
  }), point);
  assert.ok(pixels.some(([r, g, b, a]) => a > 80 && Math.max(r, g, b) - Math.min(r, g, b) > 20), `selected land remains painted: ${JSON.stringify(pixels)}`); return pixels;
}

try {
  const view = await newPage(); await open(view); const counts = resourceCounts(view); const originalView = await state(view);
  await view.evaluate(async () => { await window.__element.journey.setVisited([]); window.__element.journey.map.setView([51.5, -0.12], 7, { animate: false }); });
  const beforeView = await state(view);
  await view.evaluate(() => window.__element.setAttribute('zoom', '8')); await view.evaluate(async () => { await window.__element.ready; }); await frames(view);
  await preserves(view, [], 'zoom-only update'); await nearView(view, beforeView.center, 8, 'zoom-only update');
  await view.evaluate(() => window.__element.setAttribute('center', '22.3,114.15')); await view.evaluate(async () => { await window.__element.ready; }); await frames(view);
  await preserves(view, [], 'center-only update'); await nearView(view, [22.3, 114.15], 8, 'center-only update');
  assert.deepEqual(resourceCounts(view), counts, 'view-only attributes refetch neither world nor selected/full-country geometry');
  await view.evaluate(() => window.__element.journey.map.setView([10, 10], 4, { animate: false }));
  await view.evaluate(async () => { await window.__element.reset(); }); await frames(view);
  await preserves(view, initialIds, 'reset after view attributes'); await nearView(view, [22.3, 114.15], 8, 'reset latest configured view');
  await view.evaluate(() => { window.__element.removeAttribute('center'); window.__element.removeAttribute('zoom'); }); await ready(view, initialIds);
  await nearView(view, originalView.center, originalView.zoom, 'removing overrides restores automatic place view');
  assert.deepEqual(resourceCounts(view), counts, 'removing view overrides also avoids data transfers');
  checks.push({ case: 'view-only center/zoom retain map and manual visits, avoid transfers, and update reset view', requests: resourceCounts(view) }); await view.close();

  const chunks = await newPage(); await open(chunks); const countsBefore = resourceCounts(chunks);
  const chunkGate = gate(chunks, `**${hongKongChunk}`); await chunkGate.install;
  const originalPoint = await selectedPoint(chunks, initialIds[0]); const beforePixel = await coloredPixel(chunks, originalPoint);
  await chunks.evaluate(() => { window.__element.places = ['香港']; }); await held(chunks, chunkGate);
  await preserves(chunks, initialIds, 'held geometry update', true);
  assert.deepEqual(await coloredPixel(chunks, originalPoint), beforePixel, 'held transaction keeps the displayed land palette');
  await chunks.mouse.click(originalPoint.x, originalPoint.y); await waitFor(chunks, () => window.__element.journey.getVisited().length === 0);
  await chunks.evaluate(async ids => { await window.__element.journey.setVisited(ids); }, initialIds);
  await chunks.evaluate(() => { window.__element.setAttribute('center', '22.3,114.15'); window.__element.setAttribute('zoom', '9'); });
  assert.equal(chunkGate.requests.length, 1, 'view attributes do not restart a pending places geometry request');
  chunkGate.mode = 'pass'; await chunkGate.release(); await ready(chunks, hongKongIds);
  await preserves(chunks, hongKongIds, 'successful prepared selection'); await nearView(chunks, [22.3, 114.15], 9, 'pending transaction reads latest view attributes');
  const currentPoint = await selectedPoint(chunks, hongKongIds[0]); await coloredPixel(chunks, currentPoint);
  await chunks.mouse.move(currentPoint.x, currentPoint.y);
  await chunks.locator('journey-sphere').locator('.leaflet-tooltip').waitFor({ state: 'visible' });
  assert.equal(await chunks.locator('journey-sphere').locator('.leaflet-tooltip').innerText(), '香港', 'same-map selection replaces user-facing hover labels');
  await chunks.evaluate(async () => { await window.__element.journey.setVisited([]); window.__element.journey.map.setView([10, 10], 4, { animate: false }); await window.__element.reset(); }); await frames(chunks);
  await preserves(chunks, hongKongIds, 'reset after prepared places commit'); await nearView(chunks, [22.3, 114.15], 9, 'new places reset baseline');
  const afterCounts = resourceCounts(chunks);
  assert.equal(afterCounts.world, countsBefore.world, 'same-data places update reuses the existing world'); assert.equal(afterCounts.fullCountries, 0, 'prepared selection and reset require no full-country download');
  await chunks.screenshot({ path: path.join(output, 'places-updated.png') });
  checks.push({ case: 'held places remain interactive; same-map commit uses latest view and labels; reset uses new baseline', beforePixel, requests: afterCounts }); await chunks.close();

  const lookup = await newPage(); await open(lookup);
  const lookupGate = gate(lookup, `**${lookupPath}`); await lookupGate.install;
  await lookup.evaluate(place => { window.__element.places = [place]; window.__firstSettled = false; window.__element.ready.then(value => { window.__firstSettled = true; window.__firstOutcome = value ? 'journey' : 'null'; }, error => { window.__firstSettled = true; window.__firstOutcome = `${error.name}:${error.message}`; }); }, lookupPlace);
  await held(lookup, lookupGate); await preserves(lookup, initialIds, 'held name lookup', true);
  await lookup.evaluate(() => { window.__element.places = ['Hong Kong']; }); await ready(lookup, hongKongIds); await preserves(lookup, hongKongIds, 'latest update wins');
  await waitFor(lookup, () => window.__firstSettled);
  const superseded = await lookup.evaluate(() => window.__firstOutcome); assert.match(superseded, /null|abort|supersed/i, 'superseded readiness settles without returning a stale map');
  lookupGate.mode = 'pass'; await lookupGate.release(); await frames(lookup);
  await preserves(lookup, hongKongIds, 'late obsolete name response');
  const lookupEvents = (await state(lookup)).events;
  assert.equal(lookupEvents.filter(event => event.type === 'ready').length, 2, 'only initial and latest selection emit ready'); assert.equal(lookupEvents.filter(event => event.type === 'error').length, 0, 'expected supersession emits no error');
  checks.push({ case: 'held name lookup retains map; rapid latest-wins suppresses stale success/error', superseded, events: lookupEvents }); await lookup.close();

  const invalid = await newPage(); await open(invalid); const stable = await state(invalid);
  await invalid.evaluate(() => { window.__element.places = ['Definitely not a real place']; }); const unknown = await rejected(invalid, /Unknown place/);
  await preserves(invalid, initialIds, 'unknown places');
  await invalid.evaluate(() => { window.__element.setAttribute('center', '[22.3,"bad"]'); }); const badCenter = await rejected(invalid, /center|coordinate|finite|LatLng/i);
  await preserves(invalid, initialIds, 'invalid center'); await nearView(invalid, stable.center, stable.zoom, 'invalid center retains view');
  await invalid.evaluate(() => { window.__element.removeAttribute('center'); }); await invalid.evaluate(async () => { await window.__element.ready; });
  await invalid.evaluate(() => { window.__element.setAttribute('zoom', 'not-a-number'); }); const badZoom = await rejected(invalid, /zoom|finite|number/i);
  await preserves(invalid, initialIds, 'invalid zoom'); await nearView(invalid, stable.center, stable.zoom, 'invalid zoom retains view');
  assert.equal(resourceCounts(invalid).fullCountries, 0, 'invalid input does not force a full-country fallback');
  checks.push({ case: 'unknown places and invalid center/zoom reject while prior map and visits remain usable', unknown, badCenter, badZoom }); await invalid.close();

  const failure = await newPage(); await open(failure);
  const failureGate = gate(failure, `**${hongKongChunk}`, 'fail'); await failureGate.install;
  await failure.evaluate(() => { window.__element.places = ['Hong Kong']; }); const failedChunk = await rejected(failure, /503/);
  await preserves(failure, initialIds, 'failed selected chunk');
  await failure.evaluate(() => { window.__element.setAttribute('zoom', '7'); }); await failure.evaluate(async () => { await window.__element.ready; });
  await preserves(failure, initialIds, 'successful view update after failed places');
  failureGate.mode = 'pass'; await failure.evaluate(() => { window.__element.places = ['Hong Kong']; }); await ready(failure, hongKongIds); await preserves(failure, hongKongIds, 'identical places retry');
  assert.equal(failureGate.requests.length, 2, 'identical failed places retry only the failed selected chunk');
  const validCounts = resourceCounts(failure);
  await failure.evaluate(() => { window.__element.places = ['Hong Kong']; }); await ready(failure, hongKongIds);
  assert.deepEqual(resourceCounts(failure), validCounts, 'an identical successful assignment reuses the committed map/data');
  checks.push({ case: 'failed chunk retains map; zoom success preserves identical places retry; repeated success avoids transfers', failedChunk, requests: failureGate.requests }); await failure.close();

  const disconnected = await newPage(); await open(disconnected);
  const disconnectGate = gate(disconnected, `**${shanghaiChunk}`); await disconnectGate.install;
  await disconnected.evaluate(() => { window.__element.places = ['Shanghai']; window.__disconnectSettled = false; window.__element.ready.then(value => { window.__disconnectSettled = true; window.__disconnectOutcome = value ? 'journey' : 'null'; }, error => { window.__disconnectSettled = true; window.__disconnectOutcome = `${error.name}:${error.message}`; }); });
  await held(disconnected, disconnectGate); await preserves(disconnected, initialIds, 'pending before disconnect');
  await disconnected.evaluate(() => window.__element.remove()); await waitFor(disconnected, () => window.__disconnectSettled);
  const removed = await state(disconnected); assert.equal(removed.journey, false, 'disconnect releases the displayed API'); assert.equal(removed.canvases, 0, 'disconnect removes every canvas');
  disconnectGate.mode = 'pass'; await disconnectGate.release(); await frames(disconnected);
  assert.equal((await state(disconnected)).journey, false, 'late update response cannot recreate a disconnected map');
  await disconnected.evaluate(() => document.body.append(window.__element)); await ready(disconnected, shanghaiIds);
  assert.equal((await state(disconnected)).events.filter(event => event.type === 'ready').length, 2, 'reconnect commits the latest places once without a stale success');
  checks.push({ case: 'disconnect cancels pending transaction; late response cannot recreate map; reconnect uses latest places', removed }); await disconnected.close();

  const styles = await newPage(); let failSheet = true; let sheetAttempts = 0;
  await styles.route('**/src/embed.css', route => { sheetAttempts++; return failSheet ? route.fulfill({ status: 503, contentType: 'text/css', body: 'intentional stylesheet failure' }) : route.continue(); });
  await open(styles, false); const stylesheetError = await rejected(styles, /stylesheet/i);
  assert.equal((await state(styles)).journey, false, 'initial stylesheet failure does not expose a partially styled map');
  failSheet = false; await styles.evaluate(() => { window.__element.places = ['Singapore']; }); await ready(styles, initialIds);
  assert.equal(sheetAttempts, 2, 'retry reloads the failed stylesheet');
  for (const pathname of ['/vendor/leaflet/leaflet.css', '/src/style.css']) assert.equal(styles.requests.filter(request => request.path === pathname).length, 1, 'retry retains each successfully loaded stylesheet');
  checks.push({ case: 'stylesheet failure can retry same places and reloads only the failed sheet', stylesheetError, sheetAttempts }); await styles.close();

  const custom = await newPage(); await open(custom); let customStage = 'world-failure';
  await custom.route(`${dataOrigin}/data/embed/world.json`, route => customStage === 'world-failure' ? route.fulfill({ status: 503, contentType: 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' }, body: 'intentional custom world failure' }) : route.continue());
  await custom.route(`${dataOrigin}${sgpChunk}`, route => customStage === 'geometry-failure' ? route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(malformedSGP) }) : route.continue());
  await custom.evaluate(url => window.__element.setAttribute('data-base-url', url), `${dataOrigin}/data/embed/`); const customWorldError = await rejected(custom, /503/); await preserves(custom, initialIds, 'failed custom-origin world');
  customStage = 'geometry-failure'; await custom.evaluate(() => { window.__element.places = ['Singapore']; }); const customGeometryError = await rejected(custom, /geometry|path/i); await preserves(custom, initialIds, 'malformed custom-origin geometry');
  customStage = 'success'; await custom.evaluate(() => { window.__element.places = ['Singapore']; }); await ready(custom, initialIds);
  assert.equal((await state(custom)).sameJourney, false, 'successful origin change swaps in the prepared source map');
  assert.deepEqual((await state(custom)).blankFrames, [], 'custom-origin success never exposes an empty map frame');
  assert.equal(resourceCounts(custom).fullCountries, 0, 'custom origin prepares selected subsets without full-country downloads');
  checks.push({ case: 'custom-origin world/geometry failures retain old map; identical retry commits prepared replacement', customWorldError, customGeometryError, requests: resourceCounts(custom) }); await custom.close();

  const unload = await newPage(); await open(unload);
  await unload.evaluate(() => {
    window.__unloadInvoked = false;
    window.__element.journey.map.on('unload', () => {
      window.__unloadInvoked = true;
      window.__journeyAtUnload = window.__element.journey;
      window.__ownedLiveMapAtUnload = window.__journeyAtUnload !== window.__baseJourney && window.__journeyAtUnload.map.getContainer().isConnected;
      window.__element.places = ['Hong Kong'];
    });
  });
  await unload.evaluate(url => { window.__element.setAttribute('data-base-url', url); window.__originSettled = false; window.__element.ready.then(value => { window.__originSettled = true; window.__originOutcome = value ? 'journey' : 'null'; }, error => { window.__originSettled = true; window.__originOutcome = error.message; }); }, `${dataOrigin}/data/embed/`);
  await waitFor(unload, () => window.__unloadInvoked);
  await ready(unload, hongKongIds); await waitFor(unload, () => window.__originSettled);
  assert.equal(await unload.evaluate(() => window.__ownedLiveMapAtUnload), true, 'origin swap transfers active ownership before old unload callbacks run');
  assert.equal(await unload.evaluate(() => window.__element.journey === window.__journeyAtUnload), true, 'reentrant unload places update commits on the new live map');
  assert.equal(await unload.evaluate(() => window.__originOutcome), 'null', 'superseded outer origin readiness cannot publish its obsolete success');
  await coloredPixel(unload, await selectedPoint(unload, hongKongIds[0]));
  assert.equal((await state(unload)).events.filter(event => event.type === 'error').length, 0, 'reentrant unload update produces no stale error');
  assert.deepEqual((await state(unload)).blankFrames, [], 'reentrant unload keeps the map continuously displayed');
  checks.push({ case: 'old-map unload reentrantly updates places after atomic origin ownership transfer', outcome: await unload.evaluate(() => window.__originOutcome), requests: resourceCounts(unload) }); await unload.close();

  const observer = await newPage(); await open(observer);
  await observer.evaluate(() => {
    const oldContainer = window.__element.journey.map.getContainer(); window.__observerInvoked = false;
    const watch = new MutationObserver(() => {
      if (oldContainer.isConnected) return;
      watch.disconnect(); window.__observerInvoked = true;
      window.__journeyAtObserver = window.__element.journey;
      window.__ownedLiveMapAtObserver = window.__journeyAtObserver !== window.__baseJourney && window.__journeyAtObserver.map.getContainer().isConnected;
      window.__element.places = ['Hong Kong'];
    }); watch.observe(window.__element.shadowRoot, { childList: true, subtree: true });
  });
  await observer.evaluate(url => { window.__element.setAttribute('data-base-url', url); }, `${dataOrigin}/data/embed/`);
  await waitFor(observer, () => window.__observerInvoked); await ready(observer, hongKongIds);
  assert.equal(await observer.evaluate(() => window.__ownedLiveMapAtObserver), true, 'DOM removal observers see the newly owned live map');
  assert.equal(await observer.evaluate(() => window.__element.journey === window.__journeyAtObserver), true, 'observer-triggered places update does not abort or replace the new active map');
  await coloredPixel(observer, await selectedPoint(observer, hongKongIds[0]));
  assert.equal((await state(observer)).events.filter(event => event.type === 'error').length, 0, 'observer-triggered update has no stale error');
  assert.deepEqual((await state(observer)).blankFrames, [], 'observer-triggered update never exposes a blank map');
  checks.push({ case: 'MutationObserver places update after origin DOM swap preserves new active ownership', requests: resourceCounts(observer) }); await observer.close();

  assert.deepEqual(pageErrors, [], 'all scenarios have no uncaught browser errors');
  const result = { ok: true, checks, pageErrors }; await writeFile(path.join(output, 'updates-test.json'), `${JSON.stringify(result, null, 2)}\n`); console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const active = contexts.flatMap(context => context.pages()).at(-1); if (active) await active.screenshot({ path: path.join(output, 'failure.png') });
  await writeFile(path.join(output, 'updates-test.json'), `${JSON.stringify({ ok: false, error: error.message, checks, pageErrors }, null, 2)}\n`); throw error;
} finally {
  await Promise.all(contexts.map(context => context.close())); await browser.close();
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => dataServer.close(resolve))]);
}
