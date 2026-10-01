#!/usr/bin/env node

// Compare the previously flashing renderer with the current standalone library.
// Interactive checks inspect CSS visibility and actual canvas pixels. Separate
// compositor checks capture real frames with canvas readbacks disabled: reading
// a map canvas during capture could itself change the browser's rendering path.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(root, process.env.OUTPUT_DIR || 'outputs/map-flashing');
const baselineRef = process.env.BASELINE_REF || '3503a3c77c684dcd9305f7f889b1044ed97a11d5';
const baselineRoot = await mkdtemp(path.join(os.tmpdir(), 'journey-flashing-baseline-'));
const archive = execFileSync('git', ['archive', baselineRef, 'src', 'vendor', 'data/outlines',
  'data/compiled/manifest.json', 'data/compiled/manifest.js', 'data/embed/world.json', 'data/compiled/countries/CHN.json',
  'data/compiled/countries/USA.json'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
execFileSync('tar', ['-xf', '-', '-C', baselineRoot], { input: archive });
const fixtures = new Map();
for (const [variant, base] of [['baseline', baselineRoot], ['current', root]]) {
  const manifest = JSON.parse(await readFile(path.join(base, 'data/compiled/manifest.json'), 'utf8'));
  const world = JSON.parse(await readFile(path.join(base, 'data/embed/world.json'), 'utf8'));
  const china = JSON.parse(await readFile(path.join(base, 'data/compiled/countries/CHN.json'), 'utf8'));
  const usa = JSON.parse(await readFile(path.join(base, 'data/compiled/countries/USA.json'), 'utf8'));
  const shanghai = china.features.find(record => record.id === 'CHN:ADM2:310000');
  assert.ok(shanghai, `${variant}: Shanghai test geometry exists`);
  fixtures.set(variant, { base, manifest, world, shanghai,
    china: { ...china, features: [shanghai] }, usa });
}
const scenarios = [
  { key: 'desktop', center: [31.5, 121.8], zoom: 4, width: 1200, height: 800 },
  { key: 'mobile', center: [31.5, 121.8], zoom: 4, width: 390, height: 844, touch: true },
  { key: 'wrapped-world', center: [13.45, 864.75], zoom: 9.5, width: 1200, height: 800, worldOnly: true },
];
function html(variant, scenario) {
  const { manifest, world, shanghai, china } = fixtures.get(variant);
  const outlineConfig = scenario.worldOnly ? { ...manifest.outlines,
    countries: { USA: manifest.outlines.countries.USA } } : manifest.outlines;
  const selected = scenario.worldOnly ? [] : [shanghai.id];
  const initialCountries = scenario.worldOnly ? {} : { CHN: china };
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/${variant}/vendor/leaflet/leaflet.css"><link rel="stylesheet" href="/${variant}/src/style.css"><style>html,body,#map{margin:0;width:100%;height:100%}</style></head><body><div id="map"></div><script type="module">
import * as L from '/${variant}/vendor/leaflet/leaflet.esm.min.js';
import { createCompiledJourneySphere } from '/${variant}/src/compiled.js';
window.__errors=[];window.__selectedId=${JSON.stringify(shanghai.id)};window.__coarseUSA=${JSON.stringify(world.features.find(record => record.countryCode === 'USA').d)};window.__coarseCHN=${JSON.stringify(world.features.find(record => record.countryCode === 'CHN').d)};
window.__ready=createCompiledJourneySphere('#map',{leaflet:L,manifest:${JSON.stringify({ ...manifest, outlines: outlineConfig })},worldData:${JSON.stringify(scenario.worldOnly ? { ...world, features: world.features.filter(record => record.countryCode === 'USA') } : world)},initialCountries:${JSON.stringify(initialCountries)},dataUrl:'/${variant}/data/',backgroundDetails:false,visited:${JSON.stringify(selected)},center:${JSON.stringify(scenario.center)},zoom:${scenario.zoom},mapOptions:{worldCopyJump:false},onError:error=>window.__errors.push(error.message)}).then(api=>{window.api=api;api.map.eachLayer(layer=>{if(layer._hitRecord)window.layer=layer;});return true;});
</script></body></html>`;
}
const mime = { js: 'text/javascript', css: 'text/css', json: 'application/json' };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    const [, variant, ...parts] = url.pathname.split('/');
    const fixture = fixtures.get(variant);
    if (!fixture || parts.includes('..')) throw new Error('invalid fixture path');
    response.setHeader('Cache-Control', 'no-store');
    if (parts.join('/') === 'fixture.html') {
      const scenario = scenarios.find(value => value.key === url.searchParams.get('case'));
      response.setHeader('Content-Type', 'text/html'); response.end(html(variant, scenario)); return;
    }
    const filename = path.join(fixture.base, ...parts);
    response.setHeader('Content-Type', mime[filename.split('.').pop()] || 'application/octet-stream');
    response.end(await readFile(filename));
  } catch { response.writeHead(404); response.end(); }
});
await mkdir(output, { recursive: true });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true,
  ...(process.env.PLAYWRIGHT_GPU_BACKEND ? { args: ['--enable-gpu', `--use-angle=${process.env.PLAYWRIGHT_GPU_BACKEND}`] } : {}),
  ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const contexts = [];
const checks = [];
const compositorChecks = [];
const pageErrors = [];
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const waitFor = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 30000 });
const browserSession = await browser.newBrowserCDPSession();
const { gpu } = await browserSession.send('SystemInfo.getInfo');
const compositorBackend = { renderer: gpu.auxAttributes.glRenderer, vendor: gpu.auxAttributes.glVendor,
  features: Object.fromEntries(['2d_canvas', 'gpu_compositing'].map(key => [key, gpu.featureStatus[key]])) };
await browserSession.detach();

async function runCompositorCase(variant) {
  const scenario = scenarios[0];
  const deviceScaleFactor = 2;
  const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height }, deviceScaleFactor });
  contexts.push(context);
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${origin}/${variant}/fixture.html?case=${scenario.key}`, { waitUntil: 'domcontentloaded' });
  await waitFor(page, () => window.__ready);
  await page.evaluate(async () => { await window.__ready; await api.loadOutlineDetails(); });
  await page.waitForTimeout(150); await frames(page);
  // This fresh page never installs the canvas-pixel monitor. Fail loudly if a
  // future fixture or renderer starts reading canvas pixels during the capture.
  const before = await page.evaluate(() => {
    window.__captureReadbacks = 0;
    const originals = [];
    const guard = (prototype, name) => {
      if (!prototype?.[name]) return;
      originals.push([prototype, name, prototype[name]]);
      prototype[name] = function () {
        window.__captureReadbacks++;
        throw new Error(`Canvas ${name} readback during compositor capture`);
      };
    };
    guard(CanvasRenderingContext2D.prototype, 'getImageData');
    guard(HTMLCanvasElement.prototype, 'toDataURL');
    guard(HTMLCanvasElement.prototype, 'toBlob');
    guard(window.OffscreenCanvasRenderingContext2D?.prototype, 'getImageData');
    guard(window.OffscreenCanvas?.prototype, 'convertToBlob');
    window.__restoreReadbacks = () => { for (const [prototype, name, value] of originals) prototype[name] = value; };
    return { visited: api.getVisited(), center: [api.map.getCenter().lat, api.map.getCenter().lng], zoom: api.map.getZoom() };
  });
  const capture = [];
  let phase = 'idle-before', firstFrame;
  const first = new Promise(resolve => { firstFrame = resolve; });
  const cdp = await context.newCDPSession(page);
  cdp.on('Page.screencastFrame', event => {
    capture.push({ data: event.data, time: event.metadata.timestamp, phase });
    firstFrame();
    cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'png', maxWidth: scenario.width * deviceScaleFactor,
    maxHeight: scenario.height * deviceScaleFactor, everyNthFrame: 1 });
  try {
    await Promise.race([first, page.waitForTimeout(5000).then(() => { throw new Error('No compositor frame received'); })]);
    await page.waitForTimeout(500);
    phase = 'redraw';
    const cycles = 60, targetDurationMs = 3000;
    const redrawDurationMs = await page.evaluate(async ({ cycles, targetDurationMs }) => {
      const started = performance.now();
      for (let index = 0; index < cycles; index++) {
        await new Promise(resolve => setTimeout(resolve, Math.max(0, started + index * targetDurationMs / cycles - performance.now())));
        await new Promise(resolve => requestAnimationFrame(() => { layer.refresh(); resolve(); }));
      }
      return performance.now() - started;
    }, { cycles, targetDurationMs });
    phase = 'idle-after';
    await page.waitForTimeout(500);
    await cdp.send('Page.stopScreencast');
    const after = await page.evaluate(() => {
      window.__restoreReadbacks();
      return { visited: api.getVisited(), center: [api.map.getCenter().lat, api.map.getCenter().lng], zoom: api.map.getZoom(),
        readbacks: window.__captureReadbacks, errors: window.__errors };
    });
    assert.equal(after.readbacks, 0, `${variant}: compositor capture performed no canvas readbacks`);
    assert.deepEqual(after.errors, [], `${variant}: fixed-state repaints have no renderer errors`);
    assert.deepEqual({ visited: after.visited, center: after.center, zoom: after.zoom }, before,
      `${variant}: repeated repaint preserves selection and view`);
    assert.ok(capture.filter(frame => frame.phase === 'redraw').length >= cycles / 2,
      `${variant}: compositor sampled the repeated repaint sequence`);

    // Decode screenshots only after capture stops and readback guards restore.
    // Deduplicate PNGs before decoding to bound work; compare decoded RGBA, not
    // PNG encoding, so metadata/compression changes cannot fake a pixel change.
    const encoded = [...new Set(capture.map(frame => frame.data))];
    const images = await page.evaluate(async ({ encoded, width, height }) => {
      const results = []; let reference;
      for (const data of encoded) {
        const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0));
        const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0); image.close();
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', pixels))]
          .map(value => value.toString(16).padStart(2, '0')).join('');
        let changedPixels = 0, maximumChannelDifference = 0, land = 0;
        if (!reference) reference = pixels;
        for (let index = 0; index < pixels.length; index += 4) {
          let changed = false;
          for (let channel = 0; channel < 4; channel++) {
            const difference = Math.abs(pixels[index + channel] - reference[index + channel]);
            maximumChannelDifference = Math.max(maximumChannelDifference, difference); changed ||= difference !== 0;
          }
          if (changed) changedPixels++;
        }
        const scaleX = canvas.width / width, scaleY = canvas.height / height;
        for (let y = 70; y < height - 100; y += 40) for (let x = 70; x < width - 70; x += 40) {
          const index = (Math.floor(y * scaleY) * canvas.width + Math.floor(x * scaleX)) * 4;
          if (Math.abs(pixels[index] - 238) > 2 || Math.abs(pixels[index + 1] - 247) > 2 || Math.abs(pixels[index + 2] - 251) > 2) land++;
        }
        results.push({ hash, width: canvas.width, height: canvas.height, blank: land === 0, changedPixels, maximumChannelDifference });
      }
      return results;
    }, { encoded, width: scenario.width, height: scenario.height });
    const byEncoding = new Map(encoded.map((data, index) => [data, images[index]]));
    const blankFrames = capture.filter(frame => byEncoding.get(frame.data).blank);
    const record = { variant, scenario: 'fixed-state-compositor', viewport: [scenario.width, scenario.height], deviceScaleFactor,
      redrawCycles: cycles, targetRedrawDurationMs: targetDurationMs, actualRedrawDurationMs: redrawDurationMs, idleBeforeMs: 500, idleAfterMs: 500,
      capturedFrames: capture.length, framesByPhase: Object.fromEntries(['idle-before', 'redraw', 'idle-after'].map(value =>
        [value, capture.filter(frame => frame.phase === value).length])), captureSpanMs: (capture.at(-1).time - capture[0].time) * 1000,
      screenshotSize: [images[0].width, images[0].height], uniquePixelImages: new Set(images.map(image => image.hash)).size,
      blankFrames: blankFrames.length, maximumChangedPixels: Math.max(...images.map(image => image.changedPixels)),
      maximumChannelDifference: Math.max(...images.map(image => image.maximumChannelDifference)), canvasReadbacksDuringCapture: after.readbacks,
      errors: after.errors, backend: compositorBackend };
    compositorChecks.push(record);
    if (variant === 'current') {
      await writeFile(path.join(output, 'compositor-current.png'), Buffer.from(capture[0].data, 'base64'));
      assert.equal(blankFrames.length, 0, 'current compositor never captures blank land during repeated fixed-state repaint');
      assert.equal(record.uniquePixelImages, 1, 'current compositor preserves every pixel when map state is unchanged');
    } else {
      assert.ok(blankFrames.length > 0, 'pinned baseline control captures actual blank compositor frames without canvas readbacks');
      assert.ok(blankFrames.length < capture.length, 'baseline control also captures normally painted land');
      await writeFile(path.join(output, 'compositor-baseline-blank.png'), Buffer.from(blankFrames[0].data, 'base64'));
    }
  } finally {
    await cdp.send('Page.stopScreencast').catch(() => {});
    await page.evaluate(() => window.__restoreReadbacks()).catch(() => {});
    await context.close();
  }
}

async function installMonitor(page) {
  await page.evaluate(() => {
    window.__frames = []; window.__events = []; window.__phase = 'settled';
    const ids = new WeakMap(); let nextId = 1;
    const initial = new Set(document.querySelectorAll('canvas.leaflet-tile-loaded'));
    window.__initialTiles = initial;
    window.__probe = null;
    window.__snapshot = () => {
      const box = api.map.getContainer().getBoundingClientRect();
      const tiles = []; let visibleArea = 0, retainedLoaded = 0, pixelAlpha = window.__probe ? 0 : null, selectedPixel = false;
      for (const tile of document.querySelectorAll('canvas.leaflet-tile')) {
        const rect = tile.getBoundingClientRect();
        const area = Math.max(0, Math.min(rect.right, box.right) - Math.max(rect.left, box.left)) *
          Math.max(0, Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top));
        if (!area) continue;
        if (!ids.has(tile)) ids.set(tile, nextId++);
        const style = getComputedStyle(tile);
        const shown = style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0;
        const loaded = tile.classList.contains('leaflet-tile-loaded');
        if (shown) visibleArea += area;
        if (initial.has(tile) && loaded) retainedLoaded++;
        tiles.push({ id: ids.get(tile), loaded, shown });
        const probe = window.__probe;
        const local = probe && 'lat' in probe ? api.map.latLngToContainerPoint([probe.lat,
          probe.lng + 360 * Math.round((api.map.getCenter().lng - probe.lng) / 360)]) : null;
        const point = local ? { x: local.x + box.left, y: local.y + box.top } : probe;
        if (shown && point && point.x >= rect.left && point.x < rect.right && point.y >= rect.top && point.y < rect.bottom) {
          const rgba = tile.getContext('2d').getImageData(Math.floor((point.x - rect.left) * tile.width / rect.width),
            Math.floor((point.y - rect.top) * tile.height / rect.height), 1, 1).data;
          pixelAlpha = Math.max(pixelAlpha || 0, rgba[3]);
          selectedPixel ||= rgba[3] > 80 && Math.max(...rgba.slice(0, 3)) - Math.min(...rgba.slice(0, 3)) > 20;
        }
      }
      return { time: performance.now(), phase: window.__phase, tiles,
        coverage: Math.min(1, visibleArea / (box.width * box.height)), retainedLoaded, pixelAlpha, selectedPixel };
    };
    const redraw = layer.redraw;
    layer.redraw = function (...args) {
      const before = window.__snapshot(); const value = redraw.apply(this, args); const after = window.__snapshot();
      window.__events.push({ before, after }); return value;
    };
    const monitor = () => { window.__frames.push(window.__snapshot()); requestAnimationFrame(monitor); };
    requestAnimationFrame(monitor);
  });
}
async function setPhase(page, phase) {
  await page.evaluate(phase => { window.__phase = phase; }, phase);
}
async function selectedPoint(page) {
  const point = await page.evaluate(() => {
    const map = api.map; const box = map.getContainer().getBoundingClientRect(); const size = map.getSize();
    for (let y = 65; y < size.y - 80; y += 2) for (let x = 55; x < size.x - 40; x += 2) {
      const latlng = map.containerPointToLatLng([x, y]);
      if (layer._hitRecord({ latlng })?.id !== window.__selectedId) continue;
      const px = x + box.left, py = y + box.top;
      for (const tile of document.querySelectorAll('canvas.leaflet-tile-loaded')) {
        const rect = tile.getBoundingClientRect();
        if (px < rect.left || px >= rect.right || py < rect.top || py >= rect.bottom) continue;
        const rgba = tile.getContext('2d').getImageData(Math.floor((px - rect.left) * tile.width / rect.width),
          Math.floor((py - rect.top) * tile.height / rect.height), 1, 1).data;
        if (rgba[3] > 100 && Math.max(...rgba.slice(0, 3)) - Math.min(...rgba.slice(0, 3)) > 20) {
          return { x: px, y: py, lat: latlng.lat, lng: latlng.lng, id: window.__selectedId };
        }
      }
    } return null;
  });
  assert.ok(point, 'selected Shanghai region has a real hit and painted pixel');
  await page.evaluate(point => { window.__probe = point; }, point);
  return point;
}
async function assertPainted(page, kind = 'selected') {
  const value = await page.evaluate(() => window.__snapshot());
  assert.ok(value.coverage > 0, 'map retains visible tile coverage');
  assert.ok(value.pixelAlpha > 100, 'actual land pixels are painted');
  if (kind === 'selected') assert.equal(value.selectedPixel, true, 'actual selected land retains its color');
  return { alpha: value.pixelAlpha, selected: value.selectedPixel };
}
async function screenIsBlank(page, data) {
  return page.evaluate(async data => {
    const binary = atob(data); const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0); image.close();
    let land = 0;
    for (let y = 70; y < canvas.height - 100; y += 40) for (let x = 70; x < canvas.width - 70; x += 40) {
      const pixel = context.getImageData(x, y, 1, 1).data;
      if (Math.abs(pixel[0] - 238) > 2 || Math.abs(pixel[1] - 247) > 2 || Math.abs(pixel[2] - 251) > 2) land++;
    }
    return land === 0;
  }, data);
}
async function runCase(variant, scenario) {
  const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height },
    deviceScaleFactor: 1, ...(scenario.touch ? { isMobile: true, hasTouch: true } : {}) });
  contexts.push(context);
  const page = await context.newPage();
  const held = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/data/outlines/**', route => held.push({ route, url: route.request().url(), released: false }));
  await page.goto(`${origin}/${variant}/fixture.html?case=${scenario.key}`, { waitUntil: 'domcontentloaded' });
  await waitFor(page, () => window.__ready);
  await page.evaluate(() => window.__ready);
  await waitFor(page, () => document.querySelector('canvas.leaflet-tile-loaded'));
  await page.waitForTimeout(100); await installMonitor(page); await frames(page);
  let point;
  if (scenario.worldOnly) {
    await page.evaluate(() => { window.__probe = { lat: 13.45, lng: 864.75 }; });
  } else point = await selectedPoint(page);
  const capture = [];
  let cdp;
  if (variant === 'baseline') {
    cdp = await context.newCDPSession(page);
    cdp.on('Page.screencastFrame', event => {
      capture.push(event.data); cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'png', maxWidth: scenario.width, maxHeight: scenario.height, everyNthFrame: 1 });
  }
  await setPhase(page, 'staggered-outlines');
  const arrivals = scenario.worldOnly ? 1 : 5;
  const released = [];
  for (let index = 0; index < arrivals; index++) {
    await waitFor(page, () => window.api && window.layer);
    const deadline = Date.now() + 5000;
    while (!held.some(value => !value.released) && Date.now() < deadline) await page.waitForTimeout(20);
    const item = held.find(value => !value.released);
    assert.ok(item, 'deferred visible outline request is available');
    item.released = true;
    const url = new URL(item.url); const relative = url.pathname.slice(`/${variant}/`.length);
    await item.route.fulfill({ status: 200, contentType: 'application/json', body: await readFile(path.join(fixtures.get(variant).base, relative)) });
    released.push(relative); await page.waitForTimeout(140);
  }
  await frames(page);
  if (scenario.worldOnly) {
    await waitFor(page, () => layer._sceneAt(api.map.getZoom()).worldRecords[0].d !== window.__coarseUSA);
    await assertPainted(page, 'world');
    await setPhase(page, 'wrapped-refresh');
    await page.evaluate(() => layer.refresh()); await frames(page);
    await assertPainted(page, 'world');
    await setPhase(page, 'fractional-zoom');
    await page.evaluate(() => api.map.setView([13.45, 864.75], 8.5, { animate: false }));
    await frames(page); await assertPainted(page, 'world');
    assert.equal(await page.evaluate(() => layer._tileZoom), 9, 'fractional zoom retains the integer native tile grid');
  } else {
    await assertPainted(page);
    if (variant === 'current' && scenario.key === 'desktop') await page.screenshot({ path: path.join(output, 'current-refined.png') });
    await setPhase(page, 'real-click');
    if (scenario.touch) await page.touchscreen.tap(point.x, point.y); else await page.mouse.click(point.x, point.y);
    await waitFor(page, () => !api.getVisited().includes(window.__selectedId)); await frames(page);
    await setPhase(page, 'reset');
    await page.evaluate(() => api.reset()); await frames(page); await assertPainted(page);
    await setPhase(page, 'cached-below-detail-threshold');
    await page.evaluate(() => api.map.setView([31.5, 121.8], 3.5, { animate: true }));
    await page.waitForTimeout(450); await frames(page); await assertPainted(page);
    assert.equal(await page.evaluate(() => layer._sceneAt(api.map.getZoom()).worldRecords.find(record => record.countryCode === 'CHN').d === window.__coarseCHN),
      true, 'cached outlines fall back below their minimum zoom');
    await setPhase(page, 'cached-above-detail-threshold');
    await page.evaluate(() => api.map.setView([31.5, 121.8], 4, { animate: true }));
    await page.waitForTimeout(450); await frames(page); await assertPainted(page);
    assert.equal(await page.evaluate(() => layer._sceneAt(api.map.getZoom()).worldRecords.find(record => record.countryCode === 'CHN').d !== window.__coarseCHN),
      true, 'cached outlines return above the threshold without a new download');
    await setPhase(page, 'instant-normal-view');
    await page.evaluate(() => api.map.setView([31.5, 121.8], 5, { animate: false }));
    await frames(page); point = await selectedPoint(page); await assertPainted(page);
    await setPhase(page, 'instant-fractional-view');
    await page.evaluate(() => api.map.setView([31.5, 121.8], 4.5, { animate: false }));
    await frames(page); point = await selectedPoint(page); await assertPainted(page);
    await setPhase(page, 'normal-zoom');
    await page.evaluate(() => api.map.setView([31.5, 121.8], 5, { animate: true }));
    await page.waitForTimeout(450); await frames(page); point = await selectedPoint(page); await assertPainted(page);
    await setPhase(page, 'fractional-zoom');
    await page.evaluate(() => api.map.setView([31.5, 121.8], 4.5, { animate: true }));
    await page.waitForTimeout(450); await frames(page); point = await selectedPoint(page); await assertPainted(page);
    await setPhase(page, 'wrapped-view');
    await page.evaluate(() => api.map.setView([31.5, 841.8], 4.5, { animate: false }));
    await frames(page); point = await selectedPoint(page); await assertPainted(page);
    await setPhase(page, 'wrapped-refresh');
    await page.evaluate(() => layer.refresh()); await frames(page); await assertPainted(page);
  }
  if (cdp) {
    await cdp.send('Page.stopScreencast');
    const blank = [];
    for (const data of capture) if (await screenIsBlank(page, data)) blank.push(data);
    assert.ok(blank.length, 'pinned baseline has an actual captured blank ocean frame');
    await writeFile(path.join(output, 'baseline-blank.png'), Buffer.from(blank[0], 'base64'));
  }
  const result = await page.evaluate(() => ({ frames: window.__frames, events: window.__events,
    errors: window.__errors, fadeAnimated: api.map._fadeAnimated }));
  const phases = Object.fromEntries([...new Set(result.frames.map(frame => frame.phase))].map(phase => {
    const values = result.frames.filter(frame => frame.phase === phase);
    const alpha = values.map(frame => frame.pixelAlpha).filter(Number.isFinite);
    return [phase, { sampledFrames: values.length, blankFrames: values.filter(frame => frame.coverage === 0).length,
      minimumCoverage: Math.min(...values.map(frame => frame.coverage)),
      ...(alpha.length ? { minimumLandPixelAlpha: Math.min(...alpha) } : {}) }];
  }));
  const fixedPhases = new Set(['staggered-outlines', 'real-click', 'reset', 'wrapped-refresh']);
  const fixedEvents = result.events.filter(event => fixedPhases.has(event.before.phase));
  const stable = fixedEvents.every(({ before, after }) => before.tiles.every(tile =>
    after.tiles.some(next => next.id === tile.id && next.loaded === tile.loaded && next.shown === tile.shown)) &&
    before.tiles.length === after.tiles.length);
  if (variant === 'current') {
    if (result.frames.some(frame => frame.coverage === 0)) console.error(JSON.stringify({ variant, scenario: scenario.key,
      phases, blankFrames: result.frames.filter(frame => frame.coverage === 0).map(({ time, phase, coverage, pixelAlpha }) =>
        ({ time, phase, coverage, pixelAlpha })) }, null, 2));
    assert.ok(result.frames.length > 0, 'current frame monitor ran');
    assert.ok(result.frames.every(frame => frame.coverage > 0), 'current map never has a blank displayed animation frame');
    assert.ok(stable, 'current refinement, clicks, reset and wrapped repaint retain loaded DOM tile identity/visibility');
    assert.ok(fixedEvents.every(event => event.after.coverage > 0), 'current synchronous redraw leaves the painted map visible');
    // The tiny Guam island is absent from the small coarse overview at this
    // probe, so require its actual land only once the fine fragment is ready.
    const paintedPhases = scenario.worldOnly ? new Set(['wrapped-refresh']) : fixedPhases;
    assert.ok(result.frames.filter(frame => paintedPhases.has(frame.phase)).every(frame => frame.pixelAlpha > 100),
      'current refinement, click, reset and wrapped repaint retain actual painted land on every sampled frame');
    if (!scenario.worldOnly) assert.ok(result.frames.filter(frame => ['staggered-outlines', 'wrapped-refresh'].includes(frame.phase))
      .every(frame => frame.selectedPixel), 'refinement and wrapped repaint retain actual selected color on every sampled frame');
    assert.deepEqual(result.errors, [], 'current fixture has no renderer errors');
  } else {
    for (const phase of ['staggered-outlines', 'real-click', 'reset']) {
      assert.ok(phases[phase]?.blankFrames > 0, `pinned baseline reproduces blank ${phase} frames`);
    }
    assert.equal(stable, false, 'pinned baseline discards its loaded canvas tiles');
  }
  const record = { variant, scenario: scenario.key, phases, redraws: result.events.length,
    retainedLoadedTileIdentity: stable, outlineRequestsReleased: released, fadeAnimated: result.fadeAnimated,
    finalPixel: await assertPainted(page, scenario.worldOnly ? 'world' : 'selected'), errors: result.errors };
  checks.push(record); await context.close();
}
let ok = false;
try {
  await runCompositorCase('baseline');
  await runCompositorCase('current');
  await runCase('baseline', scenarios[0]);
  for (const scenario of scenarios) await runCase('current', scenario);
  assert.deepEqual(pageErrors, [], 'fixtures have no uncaught browser errors');
  ok = true;
  console.log(JSON.stringify({ ok, baselineRef, compositorChecks, checks, pageErrors }, null, 2));
} finally {
  await writeFile(path.join(output, 'flashing-test.json'), JSON.stringify({ ok, baselineRef, compositorChecks, checks, pageErrors }, null, 2));
  await Promise.allSettled(contexts.map(context => context.close()));
  await browser.close(); await new Promise(resolve => server.close(resolve));
  await rm(baselineRoot, { recursive: true, force: true });
}
