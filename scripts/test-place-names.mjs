#!/usr/bin/env node

// Exercise actual Leaflet hit testing and browser mouse/touch events with a
// tiny local atlas in both renderers and an embedded shadow-DOM container.
// No network, large atlas downloads, or saved output.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extent = 2 ** 24;
const identity = { format: 1, version: 'place-name-fixture', extent, fingerprint: [1, 2] };
const selectedId = 'AAA:ADM2:VISITED';
const otherId = 'AAA:ADM2:OTHER';
function rectangle(id, name, index, x1, y1, x2, y2) {
  const bounds = [x1, y1, x2, y2].map(value => value * extent / 256);
  const [left, top, right, bottom] = bounds;
  return { id, name, index, countryCode: 'AAA', parentId: 'AAA:ADM1:PARENT', bounds,
    d: `M${left} ${top}L${right} ${top}L${right} ${bottom}L${left} ${bottom}Z` };
}
const country = { ...identity, features: [
  rectangle(selectedId, 'Visited Harbor', 0, 124, 124, 128, 132),
  rectangle(otherId, 'Unvisited Harbor', 1, 128, 124, 132, 132),
], admin1: [] };
const manifest = { ...identity, regionCount: 2, worldFile: 'world.json', catalogFile: 'catalog.json',
  countries: { AAA: { start: 0, count: 2, file: 'country.json', color: '#305fa8' } } };
const world = { ...identity, features: [rectangle('AAA:ADM0:WORLD', 'Fixture country', 0, 120, 120, 136, 136)] };
const fixture = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/vendor/leaflet/leaflet.css">
<link rel="stylesheet" href="/src/style.css">
<style>html,body{margin:0;width:100%;height:100%}#map,#host{position:absolute;inset:24px}</style>
</head><body><div id="map"></div><script type="module">
import * as L from '/vendor/leaflet/leaflet.esm.min.js';
import { createCompiledJourneySphere } from '/src/compiled.js';
import { createJourneySphere } from '/src/index.js';
window.errors = []; window.changes = [];
window.ready = (async () => {
  const variant = new URL(location.href).searchParams.get('variant');
  let container = document.querySelector('#map');
  window.fixtureRoot = document;
  if (variant === 'shadow') {
    const host = document.createElement('div'); host.id = 'host';
    container.replaceWith(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<link rel="stylesheet" href="/vendor/leaflet/leaflet.css"><link rel="stylesheet" href="/src/style.css"><style>#map{width:100%;height:100%}</style><div id="map"></div>';
    await Promise.all([...shadow.querySelectorAll('link')].map(link => new Promise((resolve, reject) => {
      link.onload = resolve; link.onerror = reject;
    })));
    container = shadow.querySelector('#map'); window.fixtureRoot = shadow;
  }
  const options = {
    leaflet: L, visited: [${JSON.stringify(selectedId)}], center: [0, 0], zoom: 5,
    mapOptions: { inertia: false, zoomAnimation: false, worldCopyJump: false },
    onChange: value => window.changes.push(value), onError: error => window.errors.push(error.message),
  };
  const country = ${JSON.stringify(country)}, world = ${JSON.stringify(world)};
  if (variant === 'legacy') {
    const feature = record => {
      const [x1, y1, x2, y2] = record.bounds;
      const ring = [[x1,y1],[x2,y1],[x2,y2],[x1,y2],[x1,y1]].map(([x,y]) => {
        const point = L.CRS.EPSG3857.pointToLatLng(L.point(x * 256 / ${extent}, y * 256 / ${extent}), 0);
        return [point.lng, point.lat];
      });
      return { type: 'Feature', properties: record, geometry: { type: 'Polygon', coordinates: [ring] } };
    };
    options.atlas = {
      world: { type: 'FeatureCollection', features: world.features.map(feature) },
      catalog: { version: country.version, regionIds: country.features.map(record => record.id), countries: { AAA: {} } },
      palette: { AAA: { color: '#305fa8' } },
      loadCountry: async () => ({ type: 'FeatureCollection', features: country.features.map(feature) }),
    };
  } else Object.assign(options, {
    manifest: ${JSON.stringify(manifest)}, worldData: world,
    initialCountries: { AAA: country }, dataUrl: '/fixture-data/', backgroundDetails: false,
  });
  window.api = await (variant === 'legacy' ? createJourneySphere : createCompiledJourneySphere)(container, options);
  window.originalCodeword = api.getCodeword();
})();
</script></body></html>`;
const mime = { js: 'text/javascript', css: 'text/css', png: 'image/png' };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    response.setHeader('Cache-Control', 'no-store');
    if (pathname === '/fixture.html') {
      response.setHeader('Content-Type', 'text/html'); response.end(fixture); return;
    }
    if (pathname === '/fixture-data/compiled/country.json') {
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(country)); return;
    }
    const filename = path.resolve(root, `.${pathname}`);
    if (!filename.startsWith(`${root}${path.sep}`)) throw new Error('Invalid fixture path');
    response.setHeader('Content-Type', mime[path.extname(filename).slice(1)] || 'application/octet-stream');
    response.end(await readFile(filename));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const pageErrors = [];
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
// Keep distinct pointer movements outside Leaflet's 32ms canvas hover throttle.
const moveMouse = async (page, x, y) => {
  await page.waitForTimeout(40);
  await page.mouse.move(x, y);
};
async function open(variant, mobile = false) {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 700 } : { width: 800, height: 600 },
    hasTouch: mobile, isMobile: mobile, deviceScaleFactor: mobile ? 2 : 1,
  });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${origin}/fixture.html?variant=${variant}`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => window.ready);
  await frames(page);
  assert.deepEqual(await page.evaluate(() => window.errors), [], 'map initializes without data errors');
  return { context, page };
}
async function point(page, kind = 'visited') {
  return page.evaluate(kind => {
    const xy = kind === 'visited' ? [126, 128] : kind === 'unvisited' ? [130, 128] : [128, 121];
    const latlng = api.map.unproject(xy, 0);
    const position = api.map.latLngToContainerPoint(latlng);
    const bounds = api.map.getContainer().getBoundingClientRect();
    return { x: bounds.left + position.x, y: bounds.top + position.y };
  }, kind);
}
async function noName(page, reason) {
  await page.locator('.leaflet-tooltip').waitFor({ state: 'hidden', timeout: 2000 });
  assert.equal(await page.locator('.leaflet-tooltip:visible').count(), 0, reason);
}
async function hasName(page, reason) {
  await page.waitForFunction(() => window.fixtureRoot.querySelector('.leaflet-tooltip')?.textContent === 'Visited Harbor',
    undefined, { timeout: 2000 });
  assert.equal(await page.locator('.leaflet-tooltip:visible').textContent(), 'Visited Harbor', reason);
}
async function unchanged(page, reason) {
  const state = await page.evaluate(() => ({ visited: api.getVisited(), codeword: api.getCodeword(),
    originalCodeword, changes: window.changes, errors: window.errors }));
  assert.deepEqual(state.visited, [selectedId], `${reason}: visited locations stay unchanged`);
  assert.equal(state.codeword, state.originalCodeword, `${reason}: saved state stays unchanged`);
  assert.deepEqual(state.changes, [], `${reason}: no change event fires`);
  assert.deepEqual(state.errors, [], `${reason}: no map errors`);
}
async function desktopChecks(variant) {
  const { context, page } = await open(variant);
  const visited = await point(page);
  const unvisited = await point(page, 'unvisited');
  const blank = await point(page, 'blank');
  await moveMouse(page, visited.x, visited.y);
  await hasName(page, 'desktop hover identifies a visited region');
  await page.mouse.click(visited.x, visited.y);
  await moveMouse(page, unvisited.x, unvisited.y);
  await noName(page, 'unvisited region has no name tooltip');
  await page.mouse.click(unvisited.x, unvisited.y);
  await unchanged(page, 'clicks on visited and unvisited locations');
  await moveMouse(page, visited.x, visited.y);
  await hasName(page, 'hover still works after clicking');
  await moveMouse(page, blank.x, blank.y);
  await noName(page, 'moving off the visited geometry dismisses its name');
  await moveMouse(page, visited.x, visited.y);
  await hasName(page, 'hover can reopen a name');
  await moveMouse(page, 5, 5);
  await noName(page, 'leaving the map dismisses its name');
  await moveMouse(page, visited.x, visited.y);
  await hasName(page, 'name is present before programmatic selection change');
  await page.evaluate(() => api.setVisited([]));
  await noName(page, 'removing a visited location dismisses its name');
  await page.evaluate(() => api.destroy());
  await moveMouse(page, unvisited.x, unvisited.y);
  await noName(page, 'destroy removes tooltip and mouse handlers');
  await context.close();
}
async function mobileChecks(variant) {
  const { context, page } = await open(variant, true);
  const input = await context.newCDPSession(page);
  const touch = (type, points = []) => input.send('Input.dispatchTouchEvent', {
    type, touchPoints: points.map((value, index) => ({ ...value, id: index + 1, radiusX: 3, radiusY: 3, force: 1 })),
  });
  const end = () => touch('touchEnd');
  const resetView = async () => {
    await page.evaluate(() => api.map.setView([0, 0], 5, { animate: false }));
    await frames(page);
    return point(page);
  };
  let visited = await point(page);
  await touch('touchStart', [visited]);
  await page.waitForTimeout(100);
  await noName(page, 'a short touch does not show a name');
  await end();
  await page.waitForTimeout(550);
  await noName(page, 'short tap does not leave a delayed or synthetic mouse tooltip');
  await unchanged(page, 'short tap');

  await touch('touchStart', [visited]);
  await page.waitForTimeout(550);
  await hasName(page, 'holding a visited location for 500ms shows its name');
  await end();
  await noName(page, 'releasing the long press dismisses its name');

  const unvisited = await point(page, 'unvisited');
  await touch('touchStart', [unvisited]);
  await page.waitForTimeout(550);
  await noName(page, 'long press on an unvisited region has no tooltip');
  await end();

  await touch('touchStart', [visited]);
  await page.waitForTimeout(100);
  await touch('touchMove', [{ x: visited.x + 45, y: visited.y + 25 }]);
  await page.waitForTimeout(550);
  await noName(page, 'dragging cancels a pending long press');
  await end();
  visited = await resetView();

  await touch('touchStart', [visited]);
  await page.waitForTimeout(100);
  await touch('touchStart', [visited, { x: visited.x + 80, y: visited.y + 40 }]);
  await page.waitForTimeout(550);
  await noName(page, 'adding a second finger cancels a pending long press');
  await end();
  visited = await resetView();

  await touch('touchStart', [visited]);
  await page.waitForTimeout(100);
  await touch('touchCancel');
  await page.waitForTimeout(550);
  await noName(page, 'touch cancellation clears the pending timer');

  await touch('touchStart', [visited]);
  await page.waitForTimeout(550);
  await hasName(page, 'a new long press works after canceled gestures');
  await touch('touchMove', [{ x: visited.x + 45, y: visited.y + 25 }]);
  await noName(page, 'panning also dismisses an already visible name');
  await end();
  visited = await resetView();
  await unchanged(page, 'long presses, panning, and multitouch');

  await touch('touchStart', [visited]);
  await page.waitForTimeout(100);
  await page.evaluate(() => api.destroy());
  await page.waitForTimeout(550);
  await end();
  await noName(page, 'destroy cancels a pending long press');
  assert.equal(await page.locator('#map canvas').count(), 0, 'destroy removes map tiles');
  await context.close();
}
async function hybridChecks(variant) {
  const { context, page } = await open(variant, true);
  const visited = await point(page);
  await page.touchscreen.tap(visited.x, visited.y);
  await page.waitForTimeout(850);
  await noName(page, 'a tap does not leave a tooltip on a hybrid device');
  await moveMouse(page, visited.x + 1, visited.y);
  await hasName(page, 'a hybrid device can resume mouse hover in the same region after a tap');
  await moveMouse(page, 5, 5);
  await noName(page, 'hybrid mouse hover dismisses on map exit');
  await unchanged(page, 'switching between touch and mouse');
  await context.close();
}

try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  for (const variant of ['compiled', 'legacy', 'shadow']) {
    await desktopChecks(variant);
    await mobileChecks(variant);
    await hybridChecks(variant);
    console.log(`PASS ${variant}: hover, immutable clicks, long press, release, pan, multitouch, cancellation, and cleanup`);
  }
  assert.deepEqual(pageErrors, [], 'interaction and cleanup cause no uncaught browser errors');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
