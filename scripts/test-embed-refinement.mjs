#!/usr/bin/env node

// Cold browser navigation and zoom-refinement regression check. Files are read
// and gzipped before navigation so atlas preparation is never part of timing.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { normalizePlaceName, placeBucket } from '../src/place-names.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(root, process.env.OUTPUT_DIR || 'outputs/embed-refinement');
const baselineRef = process.env.BASELINE_REF || 'd883c187beb35c871e7d53e7e000e2d10b01ec58';
const samples = Math.max(1, Number(process.env.PERF_SAMPLES || 3));
const consumerRoot = path.resolve(process.env.CONSUMER_ROOT || path.join(root, '../williamzheng0711.github.io'));
const mime = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', json: 'application/json', css: 'text/css; charset=utf-8', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
const scenarios = [
  { key: 'hong-kong', code: 'HKG', place: 'Hong Kong', id: 'HKG:ADM0:HKG', center: [22.3,114.15], zoom: 9 },
  { key: 'japan-islands', code: 'JPN', place: 'JPN:ADM2:22064153B46179239075141', id: 'JPN:ADM2:22064153B46179239075141', center: [33.14,129.6], zoom: 9 },
  { key: 'norway-fjords', code: 'NOR', place: 'NOR:ADM2:86288312B18429617226236', id: 'NOR:ADM2:86288312B18429617226236', center: [60.4,5.25], zoom: 9 },
  { key: 'alaska', code: 'USA', place: 'USA:ADM2:52423323B58185108898', id: 'USA:ADM2:52423323B58185108898', center: [61.15,-149.8], zoom: 7 },
];
const startupPlaces = ['Shanghai', 'Hong Kong', 'Singapore'];
let consumerPlaces = [];
let consumerHtml = null;
try {
  consumerHtml = await readFile(path.join(consumerRoot, 'index.html'), 'utf8');
  consumerPlaces = JSON.parse(await readFile(path.join(consumerRoot, 'data/travel-places.json'), 'utf8'));
} catch {}

const aliasText = await readFile(path.join(root, 'data/embed/aliases.js'), 'utf8');
const aliases = JSON.parse(aliasText.replace(/^export default\s*/, '').replace(/;\s*$/, ''));
const chunks = new Set();
const buckets = new Set();
for (const input of [...startupPlaces, ...scenarios.map(s => s.place), ...consumerPlaces]) {
  const comma = input.lastIndexOf(',');
  const qualifier = comma >= 0 && /^[A-Za-z]{3}$/.test(input.slice(comma + 1).trim()) ? input.slice(comma + 1).trim() : null;
  const key = normalizePlaceName(qualifier ? input.slice(0, comma).trim() : input);
  let candidates = aliases[key];
  if (!candidates) {
    const bucket = placeBucket(key);
    buckets.add(bucket);
    candidates = JSON.parse(await readFile(path.join(root, `data/embed/names/${bucket}.json`), 'utf8'))[key];
  }
  if (qualifier) candidates = candidates?.filter(candidate => candidate.country === qualifier);
  assert.equal(candidates?.length, 1, `fixture place resolves unambiguously: ${input}`);
  for (const chunk of candidates[0].chunks) chunks.add(chunk);
}

const baselineRoot = await mkdtemp(path.join(os.tmpdir(), 'journey-sphere-embed-baseline-'));
const archivePaths = ['src', 'embed.js', 'vendor', 'data/compiled/manifest.js', 'data/embed/aliases.js', 'data/embed/world.json',
  ...[...buckets].map(bucket => `data/embed/names/${bucket}.json`), ...[...chunks].map(chunk => `data/embed/${chunk}`)];
const archive = execFileSync('git', ['archive', baselineRef, ...archivePaths], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
execFileSync('tar', ['-xf', '-', '-C', baselineRoot], { input: archive });
const baselineWorld = JSON.parse(await readFile(path.join(baselineRoot, 'data/embed/world.json'), 'utf8'));
const outlineConfig = (await import('../data/compiled/manifest.js')).default.outlines;
const assets = new Map();
function cacheAsset(urlPath, body) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const extension = urlPath.split('.').pop();
  const type = mime[extension] || 'application/octet-stream';
  const compressed = ['html', 'js', 'json', 'css'].includes(extension);
  assets.set(urlPath, { body: compressed ? gzipSync(buffer, { level: 9 }) : buffer, type, compressed, originalBytes: buffer.length });
}
async function cacheFileTree(base, relative, prefix) {
  const entries = await readdir(path.join(base, relative), { withFileTypes: true });
  for (const entry of entries) {
    const filename = path.join(relative, entry.name);
    if (entry.isDirectory()) await cacheFileTree(base, filename, prefix);
    else cacheAsset(`${prefix}/${filename.split(path.sep).join('/')}`, await readFile(path.join(base, filename)));
  }
}
for (const [variant, base] of [['baseline', baselineRoot], ['current', root]]) {
  await cacheFileTree(base, 'src', `/${variant}`);
  await cacheFileTree(base, 'vendor', `/${variant}`);
  for (const filename of archivePaths.filter(filename => !['src', 'vendor'].includes(filename))) {
    cacheAsset(`/${variant}/${filename}`, await readFile(path.join(base, filename)));
  }
}
await cacheFileTree(root, 'data/outlines', '/current');
if (consumerHtml) {
  for (const [variant] of [['baseline'], ['current']]) {
    cacheAsset(`/consumer-${variant}/index.html`, consumerHtml.replace(/https:\/\/cdn\.jsdelivr\.net\/gh\/williamzheng0711\/journey-sphere@[^"']+\/embed\.js/g, `/${variant}/embed.js`));
    for (const filename of ['CSS/style.css', 'JS/site.js', 'data/travel-places.json']) {
      cacheAsset(`/consumer-${variant}/${filename}`, await readFile(path.join(consumerRoot, filename)));
    }
    // Keep the existing consumer images on the same simulated cold connection.
    await cacheFileTree(consumerRoot, 'img', `/consumer-${variant}`);
  }
}

function fixture(variant, scenario = null, initialZoom = 4) {
  const places = scenario ? [scenario.place] : startupPlaces;
  const center = scenario?.center || [31.5,121.8];
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>JourneySphere refinement benchmark</title><style>html,body{margin:0;height:100%;font:14px system-ui}journey-sphere{display:block;width:100%;--journey-sphere-height:100vh;--journey-sphere-radius:0}</style></head><body><journey-sphere places='${JSON.stringify(places)}' center='${JSON.stringify(center)}' zoom="${initialZoom}"></journey-sphere><script type="module" src="/${variant}/embed.js"></script></body></html>`;
}
for (const variant of ['baseline', 'current']) {
  cacheAsset(`/${variant}/fixture.html`, fixture(variant));
  for (const scenario of scenarios) {
    cacheAsset(`/${variant}/${scenario.key}.html`, fixture(variant, scenario));
  }
}
cacheAsset('/current/failure.html', fixture('current', scenarios[0], 9));
let failedHkgRequests = 0;
let holdOverviews = false;
const heldOverviews = [];
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
  if (pathname === '/current/data/outlines/HKG.json' && failedHkgRequests > 0) {
    failedHkgRequests--;
    response.writeHead(503, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    response.end('outline temporarily unavailable');
    return;
  }
  const asset = assets.get(pathname);
  if (!asset) { response.writeHead(404); response.end(); return; }
  const send = () => {
    if (response.destroyed) return;
    response.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': asset.body.length,
      'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Timing-Allow-Origin': '*',
      ...(asset.compressed ? { 'Content-Encoding': 'gzip' } : {}) });
    response.end(asset.body);
  };
  if (holdOverviews && pathname.includes('/data/outlines/overview/')) heldOverviews.push(send);
  else send();
});
await mkdir(output, { recursive: true });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const contexts = [];
const report = {
  baselineRef, baselineDescription: 'The immutable embed used by the sibling homepage before this change',
  network: { latencyMs: 150, downstreamBitsPerSecond: 1_600_000, cache: 'disabled', transport: 'preloaded gzip, HTTP/1.1 on localhost', cpuThrottle: 1 },
  measure: 'Navigation start to an attached, CSS-visible, non-empty land canvas after two animation frames; no preparation time included',
  performance: [], refinement: [], errors: [],
};
function instrument() {
  window.__firstMapVisibleAt = null;
  window.__mapReadyAt = null;
  window.__firstMapDrawAt = null;
  window.__centerCountryRefinedAt = null;
  window.__mapFetches = [];
  window.__journeyErrors = [];
  window.__paintPending = false;
  const originalFetch = window.fetch;
  window.fetch = function(input, options) {
    const url = String(input instanceof Request ? input.url : input);
    window.__mapFetches.push({ url, startTime: performance.now(), firstMapVisibleAt: window.__firstMapVisibleAt });
    return originalFetch.call(this, input, options);
  };
  document.addEventListener('journey-ready', event => {
    window.__mapReadyAt = performance.now();
    // Bring the homepage's below-the-fold map into the viewport immediately so
    // timing verifies visible land rather than merely an offscreen canvas.
    document.querySelector('journey-sphere')?.scrollIntoView({ block: 'center' });
    const api = event.detail;
    api.map.eachLayer(layer => {
      if (layer._sceneAt || layer._compiledScene) window.__initialScene = layer._sceneAt ? layer._sceneAt(api.map.getZoom()) : layer._compiledScene;
      const coarse = layer._compiledScene?.worldRecords?.find(record => record.countryCode === 'CHN');
      if (coarse && api.getVisited().some(id => id.startsWith('CHN:'))) {
        const watchRefinement = () => {
          if (!api.map._loaded) return;
          // requestRefresh clears the cached scene; createTile recreates it
          // while drawing. Its changed path therefore represents drawn tiles,
          // rather than merely a completed network request or parsed payload.
          const rendered = layer._compiledScene?.worldRecords?.find(record => record.countryCode === 'CHN');
          if (rendered && rendered.d !== coarse.d) {
            requestAnimationFrame(() => { window.__centerCountryRefinedAt = performance.now(); });
          } else requestAnimationFrame(watchRefinement);
        };
        requestAnimationFrame(watchRefinement);
      }
    });
  });
  document.addEventListener('journey-error', event => window.__journeyErrors.push(event.detail?.message || String(event.detail)));
  const fill = CanvasRenderingContext2D.prototype.fill;
  CanvasRenderingContext2D.prototype.fill = function(...args) {
    const result = fill.apply(this, args);
    // Leaflet attaches the tile class after its synchronous createTile draw.
    if (this.canvas.width < 256 || this.canvas.height < 256 || window.__firstMapVisibleAt !== null || window.__paintPending) return result;
    window.__firstMapDrawAt ??= performance.now();
    window.__paintPending = true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      window.__paintPending = false;
      const element = document.querySelector('journey-sphere');
      const canvases = [...(element?.shadowRoot?.querySelectorAll('canvas.leaflet-tile-loaded') || [])];
      const painted = canvases.some(canvas => {
        const box = canvas.getBoundingClientRect();
        if (!canvas.isConnected || !box.width || !box.height || box.right <= 0 || box.left >= innerWidth || box.bottom <= 0 || box.top >= innerHeight || getComputedStyle(canvas).visibility === 'hidden') return false;
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        // Land is opaque grey or colored, while ocean is the CSS background.
        for (let index = 3; index < pixels.length; index += 32) if (pixels[index] > 32) return true;
        return false;
      });
      if (painted) window.__firstMapVisibleAt = performance.now();
    }));
    return result;
  };
}
async function open(pathname, { mobile = false, throttled = false } = {}) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1200, height: 800 },
    deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  contexts.push(context);
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  const failedRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(new URL(request.url()).pathname));
  page.on('requestfailed', request => failedRequests.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText }));
  await page.addInitScript(instrument);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  if (throttled) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150,
    downloadThroughput: 1_600_000 / 8, uploadThroughput: 750_000 / 8, connectionType: 'cellular3g' });
  if (consumerHtml && pathname.startsWith('/consumer-')) {
    // External typography has no map dependency; exclude unpredictable internet
    // connections from the repeatable local benchmark without editing the site.
    await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    await page.route('https://fonts.gstatic.com/**', route => route.fulfill({ status: 200, body: '' }));
  }
  await page.goto(`${origin}${pathname}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('journey-sphere')?.journey && window.__firstMapVisibleAt !== null, null, { timeout: 60000 });
  assert.deepEqual(errors, [], `${pathname}: no page errors`);
  return { page, context, requests, errors, failedRequests };
}
async function timing(page) {
  return page.evaluate(() => {
    const firstPaint = window.__firstMapVisibleAt;
    const resources = performance.getEntriesByType('resource').filter(entry => entry.responseEnd > 0 && entry.responseEnd <= firstPaint);
    const mapResources = resources.filter(entry => /\/(?:current|baseline)\/(?:src\/|embed\.js|vendor\/|data\/)/.test(entry.name));
    const navigation = performance.getEntriesByType('navigation')[0];
    const sum = (items, key) => items.reduce((total, entry) => total + entry[key], 0);
    const detailRequests = window.__mapFetches.filter(request => /\/outlines\//.test(request.url));
    return { firstMapVisibleMs: firstPaint, firstDrawMs: window.__firstMapDrawAt, readyMs: window.__mapReadyAt,
      mapEncodedBytesBeforePaint: sum(mapResources, 'encodedBodySize'), mapTransferBytesBeforePaint: sum(mapResources, 'transferSize'),
      allEncodedBytesBeforePaint: sum(resources, 'encodedBodySize') + navigation.encodedBodySize,
      mapResourcesBeforePaint: mapResources.map(entry => ({ path: new URL(entry.name).pathname, startMs: entry.startTime, endMs: entry.responseEnd, encodedBytes: entry.encodedBodySize })),
      firstOutlineRequestMs: detailRequests[0]?.startTime ?? null,
      visited: document.querySelector('journey-sphere').journey.getVisited(),
      codeword: document.querySelector('journey-sphere').journey.getCodeword() };
  });
}
const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length / 2)];
async function scene(page, code, id, initial = false) {
  const value = await page.evaluate(({ code, id, initial }) => {
    const api = document.querySelector('journey-sphere').journey;
    let layer;
    api.map.eachLayer(candidate => { if (candidate._sceneAt || candidate._compiledScene) layer = candidate; });
    const state = initial ? window.__initialScene : layer._sceneAt ? layer._sceneAt(api.map.getZoom()) : layer._compiledScene;
    const selected = state.activeRecords.find(record => record.id === id);
    const parent = state.adminRecords.find(record => record.countryCode === code && (record.id === id || record.parentId === selected?.parentId));
    const world = state.worldRecords?.find(record => record.countryCode === code);
    return { selected: selected?.d, parent: parent?.d, world: world?.d, visited: api.getVisited(), codeword: api.getCodeword(), zoom: api.map.getZoom() };
  }, { code, id, initial });
  // The pinned pre-refinement renderer keeps world paths in its closure rather
  // than its scene. Read the same preloaded world payload for that version.
  if (!value.world && new URL(page.url()).pathname.startsWith('/baseline/')) value.world = baselineWorld.features.find(record => record.countryCode === code).d;
  return value;
}
async function frames(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function refine(page, scenario) {
  const startMs = await page.evaluate(() => performance.now());
  await page.evaluate(({ center, zoom }) => document.querySelector('journey-sphere').journey.map.setView(center, zoom, { animate: false }), scenario);
  const codes = await page.evaluate(async () => (await document.querySelector('journey-sphere').journey.loadOutlineDetails()).map(record => record.countryCode));
  assert.ok(codes.includes(scenario.code), `${scenario.key}: viewport fetch includes target country`);
  await frames(page);
  const endMs = await page.evaluate(() => performance.now());
  return { zoomStartedMs: startMs, detailedCanvasReadyMs: endMs, refinementDurationMs: endMs - startMs };
}
async function screenshot(page, filename) {
  await page.locator('journey-sphere').scrollIntoViewIfNeeded();
  await frames(page);
  await page.locator('journey-sphere').screenshot({ path: path.join(output, filename) });
}
async function clickRefinedHkg(page, coarsePath, { touch = false } = {}) {
  const point = await page.evaluate(coarsePath => {
    const api = document.querySelector('journey-sphere').journey;
    let layer;
    api.map.eachLayer(candidate => { if (candidate._sceneAt) layer = candidate; });
    const record = layer._sceneAt(api.map.getZoom()).activeRecords.find(record => record.id === 'HKG:ADM0:HKG');
    const coarse = new Path2D(coarsePath);
    const fine = new Path2D(record.d);
    const context = document.createElement('canvas').getContext('2d');
    const bounds = api.map.getContainer().getBoundingClientRect();
    const size = api.map.getSize();
    const isFineOnly = (x, y) => {
      const position = api.map.project(api.map.containerPointToLatLng([x,y]), 0);
      const px = ((position.x % 256) + 256) % 256 * 65536;
      const py = position.y * 65536;
      return context.isPointInPath(fine,px,py,'evenodd') && !context.isPointInPath(coarse,px,py,'evenodd');
    };
    for (let y = 90; y < size.y - 100; y += 3) for (let x = 45; x < size.x - 45; x += 3) {
      if (![[0,0],[3,0],[-3,0],[0,3],[0,-3]].every(([dx,dy]) => isFineOnly(x + dx, y + dy))) continue;
      return { x: bounds.left + x, y: bounds.top + y };
    }
    return null;
  }, coarsePath);
  assert.ok(point, 'detailed HKG includes a visible interior that the old coarse shape omitted');
  const originalWord = await page.evaluate(() => document.querySelector('journey-sphere').journey.getCodeword());
  if (touch) await page.touchscreen.tap(point.x, point.y);
  else {
    await page.mouse.move(point.x, point.y);
    const tooltip = page.locator('journey-sphere').locator('.leaflet-tooltip');
    await tooltip.waitFor({ state: 'visible' });
    assert.equal(await tooltip.innerText(), 'Hong Kong', 'refined HKG land shows the correct hover name');
    await page.mouse.click(point.x, point.y);
  }
  await page.waitForFunction(() => document.querySelector('journey-sphere').journey.getVisited().length === 0);
  await page.evaluate(word => document.querySelector('journey-sphere').journey.setCodeword(word), originalWord);
  assert.equal(await page.evaluate(() => document.querySelector('journey-sphere').journey.getCodeword()), originalWord, 'fine-only interaction restores the same visit codeword');
  if (!touch) await page.mouse.move(10, 10);
  await frames(page);
}

try {
  const perfCases = process.env.SKIP_PERF ? [] : [{ key: 'embed-desktop', mobile: false }, { key: 'embed-mobile', mobile: true },
    ...(consumerHtml ? [{ key: 'consumer-desktop', mobile: false, consumer: true }] : [])];
  for (const perfCase of perfCases) {
    const runs = { baseline: [], current: [] };
    for (const variant of ['baseline', 'current']) {
      const pathname = perfCase.consumer ? `/consumer-${variant}/index.html` : `/${variant}/fixture.html`;
      const warmup = await open(pathname, { ...perfCase, throttled: true });
      await warmup.context.close();
      console.log(`${perfCase.key} ${variant}: unmeasured warmup complete`);
    }
    // Alternate versions to reduce temperature/scheduling bias.
    for (let sample = 0; sample < samples; sample++) for (const variant of sample % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
      const pathname = perfCase.consumer ? `/consumer-${variant}/index.html` : `/${variant}/fixture.html`;
      const { page, context, requests } = await open(pathname, { ...perfCase, throttled: true });
      const result = await timing(page);
      assert.ok(result.mapEncodedBytesBeforePaint > 0, 'timing accounts for compressed map assets');
      assert.equal(requests.some(url => url.includes('/compiled/countries/')), false, 'embed avoids full country downloads');
      assert.equal(requests.filter(url => url.includes('/data/embed/world.json')).length, 1, 'overview is downloaded exactly once');
      const requestOrder = await page.evaluate(() => window.__mapFetches.filter(request => /\/outlines\//.test(request.url)));
      assert.ok(requestOrder.every(request => request.firstMapVisibleAt !== null), 'outline requests wait until overview gets a visible paint');
      if (sample === 0) await screenshot(page, `${perfCase.key}-${variant}-overview.png`);
      if (variant === 'current' && outlineConfig.detailZoom > outlineConfig.minZoom) {
        await page.waitForFunction(() => window.__centerCountryRefinedAt !== null, null, { timeout: 60000 });
        result.centerCountry = 'CHN';
        result.centerCountryRefinedAtMs = await page.evaluate(() => window.__centerCountryRefinedAt);
        result.centerCountryRefinementAfterFirstPaintMs = result.centerCountryRefinedAtMs - result.firstMapVisibleMs;
        if (sample === 0) await screenshot(page, `${perfCase.key}-current-centered-refinement.png`);
      }
      if (sample === 0 && variant === 'current' && outlineConfig.detailZoom > outlineConfig.minZoom) {
        await page.evaluate(() => document.querySelector('journey-sphere').journey.loadOutlineDetails());
        await frames(page);
        result.overviewRefinementReadyMs = await page.evaluate(() => performance.now());
        result.overviewRefinementAfterFirstPaintMs = result.overviewRefinementReadyMs - result.firstMapVisibleMs;
        result.overviewRefinementResourceBytes = await page.evaluate(() => performance.getEntriesByType('resource')
          .filter(entry => entry.name.includes('/outlines/')).reduce((sum, entry) => sum + entry.encodedBodySize, 0));
        await screenshot(page, `${perfCase.key}-current-refined-overview.png`);
      }
      runs[variant].push(result);
      console.log(`${perfCase.key} ${variant} ${sample + 1}/${samples}: ${Math.round(result.firstMapVisibleMs)} ms, ${Math.round(result.mapEncodedBytesBeforePaint / 1024)} KiB map body`);
      await context.close();
    }
    const baselineMs = median(runs.baseline.map(run => run.firstMapVisibleMs));
    const currentMs = median(runs.current.map(run => run.firstMapVisibleMs));
    for (const current of runs.current) {
      assert.deepEqual(current.visited, runs.baseline[0].visited, `${perfCase.key}: embed preserves the same initial visits as the pinned version`);
      assert.equal(current.codeword, runs.baseline[0].codeword, `${perfCase.key}: initial codeword remains compatible with the pinned version`);
    }
    const allowedRegressionMs = Math.max(100, baselineMs * 0.05);
    const record = { ...perfCase, runs, baselineMedianMs: baselineMs, currentMedianMs: currentMs,
      differenceMs: currentMs - baselineMs, differencePercent: (currentMs / baselineMs - 1) * 100, allowedRegressionMs,
      baselineMedianMapBytes: median(runs.baseline.map(run => run.mapEncodedBytesBeforePaint)),
      currentMedianMapBytes: median(runs.current.map(run => run.mapEncodedBytesBeforePaint)) };
    if (runs.current[0].centerCountryRefinementAfterFirstPaintMs !== undefined) {
      record.medianCenterCountryRefinementAfterFirstPaintMs = median(runs.current.map(run => run.centerCountryRefinementAfterFirstPaintMs));
    }
    record.initialStateAcrossVersionsVerified = true;
    report.performance.push(record);
    assert.ok(record.differenceMs <= allowedRegressionMs,
      `${perfCase.key}: first visible map regression ${Math.round(record.differenceMs)} ms exceeds ${Math.round(allowedRegressionMs)} ms budget`);
  }

  for (const scenario of scenarios) {
    const baseline = await open(`/baseline/${scenario.key}.html`);
    const baselineInitial = await scene(baseline.page, scenario.code, scenario.id, true);
    await screenshot(baseline.page, `${scenario.key}-baseline-overview.png`);
    await baseline.page.evaluate(({ center, zoom }) => document.querySelector('journey-sphere').journey.map.setView(center, zoom, { animate: false }), scenario);
    await screenshot(baseline.page, `${scenario.key}-baseline.png`);
    const baselineZoom = await scene(baseline.page, scenario.code, scenario.id);
    const current = await open(`/current/${scenario.key}.html`);
    const coarse = await scene(current.page, scenario.code, scenario.id, true);
    assert.equal(coarse.selected, baselineInitial.selected, `${scenario.key}: first selected geometry unchanged`);
    let medium;
    if (outlineConfig.detailZoom > outlineConfig.minZoom) {
      const codes = await current.page.evaluate(async () => (await document.querySelector('journey-sphere').journey.loadOutlineDetails()).map(record => record.countryCode));
      assert.ok(codes.includes(scenario.code), `${scenario.key}: normal overview loads target country`);
      await frames(current.page);
      medium = await scene(current.page, scenario.code, scenario.id);
      assert.notEqual(medium.world, baselineInitial.world, `${scenario.key}: normal zoom improves simplified country outline`);
      assert.equal(medium.codeword, coarse.codeword, `${scenario.key}: normal overview preserves codeword`);
      await screenshot(current.page, `${scenario.key}-current-overview.png`);
    }
    const refinementTiming = await refine(current.page, scenario);
    const fine = await scene(current.page, scenario.code, scenario.id);
    assert.notEqual(fine.world, baselineZoom.world, `${scenario.key}: detailed land replaces simplified embed world`);
    assert.deepEqual(fine.visited, coarse.visited, `${scenario.key}: refinement preserves visited IDs`);
    assert.equal(fine.codeword, coarse.codeword, `${scenario.key}: refinement preserves visit codeword`);
    if (scenario.code === 'HKG') {
      assert.notEqual(fine.selected, coarse.selected, 'HKG ADM0 selection is refined');
      assert.equal(fine.selected, fine.world, 'HKG selected coastline and world land align');
      assert.ok(fine.parent === undefined || fine.parent === fine.world, 'any HKG parent coastline aligns with detailed land');
      await clickRefinedHkg(current.page, coarse.selected);
    } else assert.equal(fine.selected, coarse.selected, `${scenario.key}: canonical ADM2 geometry is preserved`);
    await screenshot(current.page, `${scenario.key}-current.png`);
    await current.page.evaluate(async word => {
      const api = document.querySelector('journey-sphere').journey;
      await api.setVisited([]);
      await api.setCodeword(word);
    }, fine.codeword);
    assert.deepEqual((await scene(current.page, scenario.code, scenario.id)).visited, fine.visited, 'codeword restores selection after refinement');
    await current.page.evaluate(() => document.querySelector('journey-sphere').reset());
    await current.page.waitForFunction(() => {
      const map = document.querySelector('journey-sphere').journey.map;
      return map.getZoom() === 4 && !map._animatingZoom;
    });
    // The country overview can now refine zoom 4 too. Check the small global
    // overview by zooming below its refinement threshold after reset.
    await current.page.evaluate(() => document.querySelector('journey-sphere').journey.map.setZoom(3, { animate: false }));
    await current.page.waitForFunction(() => {
      const map = document.querySelector('journey-sphere').journey.map;
      return map.getZoom() === 3 && !map._animatingZoom;
    });
    const reset = await scene(current.page, scenario.code, scenario.id);
    assert.ok(reset.world === coarse.world, `${scenario.key}: resetting below detail threshold restores overview`);
    assert.equal(reset.codeword, coarse.codeword, 'reset preserves original codeword');
    assert.equal(current.requests.some(url => url.includes('/compiled/countries/')), false, `${scenario.key}: no full country download after zoom or restoring codeword`);
    const outlineRequests = await current.page.evaluate(() => window.__mapFetches.filter(request => /\/outlines\//.test(request.url)));
    assert.ok(outlineRequests.every(request => request.firstMapVisibleAt !== null), `${scenario.key}: details never block first map paint`);
    report.refinement.push({ key: scenario.key, selectedId: scenario.id, coarseWorldCharacters: coarse.world.length,
      mediumWorldCharacters: medium?.world.length, fineWorldCharacters: fine.world.length, selectedPathChanged: fine.selected !== coarse.selected,
      timingUnthrottled: refinementTiming,
      outlineRequests: outlineRequests.map(request => ({ path: new URL(request.url).pathname, startMs: request.startTime })),
      visitedPreserved: true, codewordPreserved: true, fullCountryDownloads: 0 });
    await baseline.context.close();
    await current.context.close();
    console.log(`PASS ${scenario.key}: world ${coarse.world.length} → ${fine.world.length} path characters, state preserved`);
  }

  if (outlineConfig.detailZoom > outlineConfig.minZoom) {
    holdOverviews = true;
    const cancellation = await open('/current/hong-kong.html');
    await cancellation.page.waitForFunction(() => window.__mapFetches.some(request => request.url.includes('/outlines/overview/')), null, { timeout: 10000 });
    const before = await scene(cancellation.page, 'HKG', 'HKG:ADM0:HKG', true);
    await refine(cancellation.page, scenarios[0]);
    holdOverviews = false;
    heldOverviews.splice(0).forEach(send => send());
    const after = await scene(cancellation.page, 'HKG', 'HKG:ADM0:HKG');
    assert.notEqual(after.world, before.world, 'zooming into detail while overview is blocked still loads exact country outline');
    assert.equal(after.selected, after.world, 'canceled overview cannot replace newer detailed ADM0 geometry');
    assert.equal(after.codeword, before.codeword, 'tier switch preserves selection');
    await cancellation.page.waitForFunction(() => window.__journeyErrors.length === 0);
    assert.ok(cancellation.failedRequests.some(request => request.path.includes('/outlines/overview/')), 'zooming into detail cancels obsolete overview network requests');
    report.tierCancellation = { obsoleteOverviewsCanceled: true, exactDetailReady: true, codewordPreserved: true,
      requests: cancellation.requests.filter(request => request.includes('/outlines/')), canceled: cancellation.failedRequests };
    await cancellation.context.close();
    console.log('PASS cancellation: blocked overview yields to exact detail after zoom');
  }

  failedHkgRequests = 1;
  const failure = await open('/current/failure.html');
  const failureWord = await failure.page.evaluate(() => document.querySelector('journey-sphere').journey.getCodeword());
  await failure.page.waitForFunction(() => window.__journeyErrors.some(error => /503.*HKG/.test(error)), null, { timeout: 10000 });
  assert.equal(await failure.page.evaluate(() => document.querySelector('journey-sphere').shadowRoot.querySelector('.message').hidden), true, 'outline failure leaves usable map visible without load-error overlay');
  await failure.page.evaluate(async () => {
    const api = document.querySelector('journey-sphere').journey;
    await api.setVisited([]);
    await api.reset();
  });
  await refine(failure.page, scenarios[0]);
  const recovered = await scene(failure.page, 'HKG', 'HKG:ADM0:HKG');
  assert.equal(recovered.codeword, failureWord, 'retry preserves original selection');
  assert.equal(recovered.world, recovered.selected, 'retry installs aligned detailed HKG land');
  assert.ok(failure.requests.filter(url => url === '/current/data/outlines/HKG.json').length >= 2, 'failed detail is fetched again');
  assert.deepEqual(failure.errors, [], 'optional detail failure has no unhandled error');
  report.failureRetry = { failures: await failure.page.evaluate(() => window.__journeyErrors), mapUsable: true, retrySucceeded: true, codewordPreserved: true };
  await screenshot(failure.page, 'hong-kong-retry.png');
  await failure.context.close();
  const mobile = await open('/current/hong-kong.html', { mobile: true, throttled: true });
  const mobileCoarse = await scene(mobile.page, 'HKG', 'HKG:ADM0:HKG', true);
  const mobileTiming = await refine(mobile.page, scenarios[0]);
  const mobileFine = await scene(mobile.page, 'HKG', 'HKG:ADM0:HKG');
  assert.equal(mobileFine.world, mobileFine.selected, 'mobile detailed land is aligned');
  await clickRefinedHkg(mobile.page, mobileCoarse.selected, { touch: true });
  await screenshot(mobile.page, 'hong-kong-mobile.png');
  await mobile.page.evaluate(() => document.querySelector('journey-sphere').journey.destroy());
  assert.equal(await mobile.page.evaluate(() => document.querySelector('journey-sphere').shadowRoot.querySelectorAll('canvas').length), 0, 'destroy removes mobile map tiles');
  report.mobileRefinement = { aligned: true, visitedPreserved: true, fineOnlyTouchTogglesVisit: true, destroyRemovesTiles: true, timingThrottled: mobileTiming };
  await mobile.context.close();
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.errors.push(error.stack || String(error));
  console.error(error);
  process.exitCode = 1;
} finally {
  holdOverviews = false;
  heldOverviews.splice(0).forEach(send => send());
  await writeFile(path.join(output, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(output, 'report.md'), [
    '# Embed navigation and refinement validation', '',
    `Status: ${report.passed ? 'PASS' : 'FAIL'}`, '',
    'Cold cache, gzip, 1.6 Mbps downstream, 150 ms latency, no CPU throttling. Timing starts at navigation and ends after actual attached land canvas tiles are painted. All files were read and compressed before navigation.', '',
    `First-map values are medians of ${samples} cold samples per version and page, after one unmeasured warmup per version and page. The regression budget is the larger of 100 ms or 5% of the pinned version.`, '',
    '| Page | Previous first map | Current first map | Difference | Map body before paint |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...report.performance.map(item => `| ${item.key} | ${Math.round(item.baselineMedianMs)} ms | ${Math.round(item.currentMedianMs)} ms | ${Math.round(item.differenceMs)} ms (${item.differencePercent.toFixed(1)}%) | ${Math.round(item.baselineMedianMapBytes / 1024)} → ${Math.round(item.currentMedianMapBytes / 1024)} KiB |`), '',
    'The map focuses on Shanghai at [31.5, 121.8]. China is the country under that view center; these medians measure its actual detailed land paint after the first map:', '',
    '| Page | Centered country refinement after first map |',
    '| --- | ---: |',
    ...report.performance.filter(item => item.medianCenterCountryRefinementAfterFirstPaintMs !== undefined)
      .map(item => `| ${item.key} | ${(item.medianCenterCountryRefinementAfterFirstPaintMs / 1000).toFixed(2)} s |`), '',
    'Visible countries refine progressively after the first map. The following values measure completion of every visible country at normal zoom on the first current cold sample:', '',
    '| Page | All visible outlines after first map | Compressed refinement body |',
    '| --- | ---: | ---: |',
    ...report.performance.filter(item => item.runs.current[0].overviewRefinementReadyMs).map(item => {
      const run = item.runs.current[0];
      return `| ${item.key} | ${(run.overviewRefinementAfterFirstPaintMs / 1000).toFixed(1)} s | ${(run.overviewRefinementResourceBytes / 1_000_000).toFixed(2)} MB |`;
    }), '',
    ...report.refinement.map(item => `- ${item.key}: detailed world ${item.coarseWorldCharacters.toLocaleString()} → ${item.fineWorldCharacters.toLocaleString()} path characters; visit IDs and codeword preserved; no full country downloads.`), '',
    ...(report.failureRetry ? ['Optional outline failure keeps the initial map usable. Explicit retry succeeds and preserves selected visits.', 'Mobile detailed land remains aligned and destroy removes all tiles.', ''] : []),
    ...(report.mobileRefinement ? [`Cold mobile zoom-in to fully aligned Hong Kong detail: ${(report.mobileRefinement.timingThrottled.refinementDurationMs / 1000).toFixed(2)} s. A real tap on newly detailed land toggles the visit and the original codeword restores it.`, ''] : []),
    ...(report.errors.length ? ['```', ...report.errors, '```', ''] : []),
    'The sibling homepage is served from an in-memory copy with only the remote embed URL replaced. Its files are not modified. The test scrolls its below-the-fold map into view immediately when ready. External fonts are excluded from this local repeatable performance check. These results measure the browser loader and compressed transfer; production CDN geography and TLS are not simulated.', '',
  ].join('\n'));
  await Promise.allSettled(contexts.map(context => context.close()));
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  await rm(baselineRoot, { recursive: true, force: true });
}
