#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestModule = await import('../data/compiled/manifest.js');
const manifest = manifestModule.default;
const china = JSON.parse(await readFile(path.join(root, 'data/compiled/countries/CHN.json'), 'utf8'));
const singapore = JSON.parse(await readFile(path.join(root, 'data/compiled/countries/SGP.json'), 'utf8'));
const shanghai = china.features.find(feature => feature.id === 'CHN:ADM2:310000');
if (!shanghai) throw new Error('The compiled atlas has no Shanghai feature.');
const singaporeRegion = singapore.features[0];
if (!singaporeRegion) throw new Error('The compiled atlas has no Singapore feature.');
const visited = [shanghai.id, singaporeRegion.id];
const bootstrap = {
  CHN: {
    ...china,
    // Keep the bootstrap small while preserving the atlas identity and the
    // selected region needed for first paint and the click interaction.
    features: [shanghai], admin1: [],
  },
  SGP: { ...singapore, features: [singaporeRegion], admin1: [] },
};
const mime = { html: 'text/html', js: 'text/javascript', json: 'application/json', css: 'text/css' };

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname.replace(/^\//, '');
    if (!pathname || pathname.includes('..')) throw new Error('invalid path');
    const body = await readFile(path.join(root, pathname));
    response.writeHead(200, {
      'Content-Type': mime[pathname.split('.').pop()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const recordLiteral = JSON.stringify({ visited, bootstrap });
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/node_modules/leaflet/dist/leaflet.css"><style>#map{width:900px;height:600px}</style><div id="map"></div><script src="/node_modules/leaflet/dist/leaflet.js"></script><script type="module">
  import { createCompiledJourneySphere } from '/src/compiled.js';
  import manifest from '/data/compiled/manifest.js';
  const record = ${recordLiteral};
  if (window.__invalidBootstrap) record.bootstrap.CHN.fingerprint[0] ^= 1;
  window.__mapPromise = createCompiledJourneySphere(document.querySelector('#map'), {
    dataUrl: '/data/', manifest, visited: record.visited, initialCountries: record.bootstrap,
    center: [31.1, 121.4], zoom: 6,
  }).then(map => (window.journeySphere = map, map));
  window.__mapPromise.catch(() => {});
</script>`;

const originalHandler = server.listeners('request')[0];
server.removeListener('request', originalHandler);
server.on('request', async (request, response) => {
  if (new URL(request.url, origin).pathname === '/fixture.html') {
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    response.end(html);
    return;
  }
  await originalHandler(request, response);
});

const browser = await chromium.launch({ headless: true,
  ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
});
const waitFor = (page, expression, timeout = 30000) => page.waitForFunction(expression, null, { timeout });
const countryPath = /\/data\/compiled\/countries\//;
const releases = [];

async function open({ hold = false, fail = false, invalidBootstrap = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  releases.push(release);
  const requests = [];
  await page.route('**/*', async route => {
    if (!countryPath.test(route.request().url())) return route.continue();
    requests.push(route.request().url());
    if (fail) return route.fulfill({ status: 503, body: 'country unavailable' });
    if (hold) await gate;
    return route.continue();
  });
  if (invalidBootstrap) {
    await page.addInitScript(() => {
      window.__invalidBootstrap = true;
    });
  }
  await page.goto(`${origin}/fixture.html`, { waitUntil: 'domcontentloaded' });
  return { context, page, errors, requests, release };
}

try {
  const first = await open({ hold: true });
  const { page } = first;
  await waitFor(page, () => window.journeySphere && window.journeySphere.getVisited().length === 2);
  await waitFor(page, () => document.querySelectorAll('.leaflet-container canvas').length > 0);
  assert.deepEqual(await page.evaluate(() => window.journeySphere.getVisited()), visited);
  const originalWord = await page.evaluate(() => window.journeySphere.getCodeword());
  // Background work starts after two animation frames; CPU contention or a
  // hidden browser tab can delay those frames beyond a fixed 100 ms sleep.
  const requestDeadline = Date.now() + 10_000;
  while (!first.requests.length && Date.now() < requestDeadline) await page.waitForTimeout(25);
  assert.ok(first.requests.length > 0, 'full country details should be pending');
  console.log('Bootstrap ready while country details are held');

  const clickPoint = await page.evaluate(() => {
    const point = window.journeySphere.map.latLngToContainerPoint([31.1, 121.4]);
    const rect = document.querySelector('#map').getBoundingClientRect();
    return { x: point.x + rect.left, y: point.y + rect.top };
  });
  await page.mouse.click(clickPoint.x, clickPoint.y);
  await waitFor(page, () => !window.journeySphere.getVisited().includes('CHN:ADM2:310000'));
  assert.deepEqual(await page.evaluate(() => window.journeySphere.getVisited()), [visited[1]], 'clicking Shanghai should toggle it off');
  console.log('Click changed selection');
  await page.evaluate(id => window.journeySphere.setVisited([id]), visited[1]);
  assert.deepEqual(await page.evaluate(() => window.journeySphere.getVisited()), [visited[1]]);
  await page.evaluate(word => window.journeySphere.setCodeword(word), originalWord);
  assert.deepEqual(await page.evaluate(() => window.journeySphere.getVisited()), visited, 'codeword updates should work while detail requests are blocked');
  first.release();
  await page.evaluate(() => window.journeySphere.detailsReady);
  await page.evaluate(() => window.journeySphere.setVisited(['SGP:ADM0:SGP']));
  assert.deepEqual(await page.evaluate(() => window.journeySphere.getVisited()), [visited[1]], 'late details must not overwrite selection');
  await page.evaluate(() => window.journeySphere.map.setZoom(7));
  await waitFor(page, () => window.journeySphere.map.getZoom() === 7 && !window.journeySphere.map._animatingZoom);
  await page.evaluate(() => window.journeySphere.reset());
  await waitFor(page, () => window.journeySphere.map.getZoom() === 6 && window.journeySphere.getVisited().length === 2);
  assert.deepEqual(first.errors, []);
  await first.context.close();

  const failed = await open({ fail: true });
  await waitFor(failed.page, () => window.journeySphere && window.journeySphere.getVisited().length === 2);
  const settled = await failed.page.evaluate(async () => {
    try { await window.journeySphere.detailsReady; return 'resolved'; }
    catch (error) { return error.message; }
  });
  assert.match(settled, /country unavailable|details failed|503/);
  await failed.page.evaluate(() => window.journeySphere.setVisited([]));
  assert.equal(await failed.page.evaluate(() => window.journeySphere.getVisited().length), 0, 'selection remains editable after detail failure');
  await failed.page.evaluate(id => window.journeySphere.setVisited([id]), visited[1]);
  assert.deepEqual(await failed.page.evaluate(() => window.journeySphere.getVisited()), [visited[1]]);
  await failed.page.evaluate(() => window.journeySphere.reset());
  assert.equal(await failed.page.evaluate(() => window.journeySphere.getVisited().length), 2);
  assert.deepEqual(failed.errors, [], 'country detail failure must not become an unhandled rejection');
  await failed.context.close();

  const destroyed = await open({ hold: true });
  await waitFor(destroyed.page, () => !!window.journeySphere);
  await destroyed.page.waitForTimeout(100);
  await destroyed.page.evaluate(() => window.journeySphere.destroy());
  destroyed.release();
  await destroyed.page.evaluate(() => window.journeySphere.detailsReady.catch(() => {}));
  assert.equal(await destroyed.page.locator('#map canvas').count(), 0, 'destroy removes the pending map');
  assert.deepEqual(destroyed.errors, []);
  await destroyed.context.close();

  const invalid = await open({ invalidBootstrap: true });
  const rejected = await invalid.page.evaluate(async () => {
    try { await window.__mapPromise; return 'resolved'; }
    catch (error) { return error.message; }
  });
  assert.match(rejected, /compiled atlas files do not match/);
  await invalid.context.close();
  console.log(`PASS progressive bootstrap (${first.requests.length} held detail requests), failure recovery, interaction, and reset`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  releases.forEach(release => release());
  await browser.close();
  server.close();
}
