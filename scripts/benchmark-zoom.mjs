#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.env.BENCHMARK_MODE || 'legacy';
assert.ok(['legacy', 'refinement'].includes(mode), 'BENCHMARK_MODE must be legacy or refinement.');
const refinement = mode === 'refinement';
const baselineRef = process.env.BASELINE_REF || (refinement ? 'aa5dcc7e' : '65d417c1');
const baselineCommit = execFileSync('git', ['rev-parse', baselineRef], { cwd: root, encoding: 'utf8' }).trim();
const samples = Number(process.env.SAMPLES || 5);
assert.ok(Number.isInteger(samples) && samples >= 5, 'At least five samples are required for a passing benchmark.');
const scenarios = refinement ? [
  { name: 'east-asia', center: [22.3, 114.15], detailZoom: 10, visited: ['HKG:ADM0:HKG'], expected: ['HKG', 'CHN'] },
  { name: 'norway', center: [60.4, 5.25], detailZoom: 9, visited: ['NOR:ADM2:86288312B18429617226236'], expected: ['NOR'] },
  { name: 'pacific', center: [52.4, 179.6], detailZoom: 9, visited: ['USA:ADM2:52423323B14067598441828'], expected: ['USA', 'RUS'] },
] : [
  { name: 'east-asia', center: [22.3, 114.15] },
  { name: 'europe', center: [50, 10] },
  { name: 'pacific', center: [-25, 175] },
];
const outputDir = path.resolve(root, process.env.OUTPUT_DIR || (refinement ? 'outputs/map-refinement-2' : 'outputs/zoom-detail'));
const limits = {
  firstDisplayRelative: Number(process.env.MAX_FIRST_DISPLAY_REGRESSION || 0.05),
  firstDisplayAbsoluteMs: Number(process.env.MAX_FIRST_DISPLAY_REGRESSION_MS || 100),
  corpusByteReduction: Number(process.env.MIN_CORPUS_BYTE_REDUCTION || 0.10),
  detailByteReduction: Number(process.env.MIN_DETAIL_BYTE_REDUCTION || 0.05),
  detailLatencyReduction: Number(process.env.MIN_DETAIL_LATENCY_REDUCTION || 0.05),
};
assert.ok(Object.values(limits).every(value => Number.isFinite(value) && value >= 0), 'Benchmark limits must be finite nonnegative numbers.');
await mkdir(outputDir, { recursive: true });
const cache = new Map();
let assetsPrepared = false;
const types = { '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };
function gitFile(file) {
  return execFileSync('git', ['show', `${baselineCommit}:${file}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
}
async function asset(url) {
  if (!cache.has(url)) {
    if (refinement && assetsPrepared) throw new Error(`Unprepared measured asset: ${url}`);
    const [, variant, ...parts] = url.split('/');
    const file = parts.join('/');
    if (!['baseline', 'current', 'shared'].includes(variant) || file.includes('..')) throw new Error('Invalid asset');
    const body = variant === 'baseline' ? gitFile(file) : await readFile(path.join(root, file));
    cache.set(url, { raw: body, gzip: gzipSync(body), type: types[path.extname(file)] || 'application/octet-stream' });
  }
  return cache.get(url);
}
async function currentFiles(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory()
    ? currentFiles(`${directory}/${entry.name}`) : [`${directory}/${entry.name}`]));
  return nested.flat();
}
// All source modules and outlines are prepared before timing. A cache miss in
// refinement mode fails instead of doing Git, disk, or gzip work during a run.
for (const variant of ['baseline', 'current']) {
  let files;
  if (refinement) {
    files = variant === 'baseline'
      ? execFileSync('git', ['ls-tree', '-r', '--name-only', baselineCommit, '--', 'src', 'data/outlines'], { cwd: root, encoding: 'utf8' }).trim().split('\n')
      : [...await currentFiles('src'), ...await currentFiles('data/outlines')];
    const countries = [...new Set(scenarios.flatMap(scenario => scenario.visited.map(id => id.split(':')[0])))];
    files.push('data/compiled/manifest.js', 'data/compiled/world.json', ...countries.map(code => `data/compiled/countries/${code}.json`));
  } else {
    files = ['src/compiled.js', 'src/compiled-layer.js', 'src/state.js', 'src/style.css',
      'data/compiled/manifest.js', 'data/compiled/world.json', 'data/compiled/countries/HKG.json',
      ...(variant === 'current' ? ['src/outline-detail.js', 'data/outlines/HKG.json', 'data/outlines/CHN.json', 'data/outlines/MAC.json'] : [])];
  }
  for (const file of new Set(files)) await asset(`/${variant}/${file}`);
}
for (const file of ['leaflet.js', 'leaflet.css']) await asset(`/shared/node_modules/leaflet/dist/${file}`);
assetsPrepared = true;
const corpus = refinement ? Object.fromEntries(['baseline', 'current'].map(variant => {
  const payloads = [...cache].filter(([url]) => new RegExp(`^/${variant}/data/outlines/[A-Z]{3}\\.json$`).test(url));
  assert.equal(payloads.length, 259, `${variant} must prepare the complete 259-country outline corpus`);
  return [variant, { countries: payloads.length, gzipBytes: payloads.reduce((total, [, data]) => total + data.gzip.length, 0) }];
})) : undefined;
function installInstrumentation() {
  const phases = new Map();
  const names = new Map();
  const prefixes = new WeakMap();
  let phaseName = 'startup';
  let lastFrame;
  let frameHandle;
  const phase = () => {
    if (!phases.has(phaseName)) phases.set(phaseName, { tileCount: 0, tileCpuMs: 0, maxTileMs: 0,
      redrawCount: 0, refreshRequests: 0, pathCount: 0, parsedPathBytes: 0, drawCounts: {},
      framesOver50ms: 0, maxFrameGapMs: 0 });
    return phases.get(phaseName);
  };
  window.benchBegin = name => { phaseName = name; lastFrame = undefined; phase(); };
  window.benchStats = () => structuredClone(Object.fromEntries(phases));
  const pathKey = value => `${value.length}:${value.slice(0, 100)}`;
  window.benchTrack = records => {
    for (const record of records) {
      if (typeof record.d !== 'string') continue;
      names.set(pathKey(record.d), record.countryCode);
      if (record.strokeWidths) {
        const rings = record.d.match(/M[^M]+/g);
        for (const zoom of [9, 10]) {
          const minimumWidth = 0.5 * (2 ** 24) / (256 * 2 ** zoom);
          const stroke = rings.filter((_, index) => record.strokeWidths[index] === null || record.strokeWidths[index] >= minimumWidth).join(' ');
          names.set(pathKey(stroke), record.countryCode);
        }
      }
    }
  };
  const NativePath = window.Path2D;
  window.Path2D = new Proxy(NativePath, { construct(target, args) {
    const result = Reflect.construct(target, args, target);
    if (typeof args[0] === 'string') {
      prefixes.set(result, pathKey(args[0]));
      phase().pathCount++; phase().parsedPathBytes += args[0].length;
    }
    return result;
  } });
  for (const operation of ['fill', 'stroke']) {
    const original = CanvasRenderingContext2D.prototype[operation];
    CanvasRenderingContext2D.prototype[operation] = function (...args) {
      const country = names.get(prefixes.get(args[0]));
      if (country) phase().drawCounts[country] = (phase().drawCounts[country] || 0) + 1;
      return original.apply(this, args);
    };
  }
  const originalRedraw = L.GridLayer.prototype.redraw;
  L.GridLayer.prototype.redraw = function (...args) { phase().redrawCount++; return originalRedraw.apply(this, args); };
  const originalExtend = L.GridLayer.extend;
  L.GridLayer.extend = function (properties) {
    const originalTile = properties.createTile;
    const requestRefresh = properties.requestRefresh;
    const measureTile = (layer, args) => {
      const start = performance.now();
      const tile = originalTile.apply(layer, args);
      const elapsed = performance.now() - start;
      const current = phase(); current.tileCount++; current.tileCpuMs += elapsed; current.maxTileMs = Math.max(current.maxTileMs, elapsed);
      return tile;
    };
    // Leaflet uses this arity to decide who marks a drawn tile ready.
    const createTile = originalTile.length >= 2
      ? function(coords, done) { return measureTile(this, [coords, done]); }
      : function(coords) { return measureTile(this, [coords]); };
    return originalExtend.call(this, { ...properties,
      ...(requestRefresh ? { requestRefresh(...args) { phase().refreshRequests++; return requestRefresh.apply(this, args); } } : {}),
      createTile,
    });
  };
  function frame(now) {
    if (lastFrame !== undefined) {
      const gap = now - lastFrame;
      phase().maxFrameGapMs = Math.max(phase().maxFrameGapMs, gap);
      if (gap > 50) phase().framesOver50ms++;
    }
    lastFrame = now; frameHandle = requestAnimationFrame(frame);
  }
  frameHandle = requestAnimationFrame(frame);
  window.benchStop = () => cancelAnimationFrame(frameHandle);
}
const html = (variant, scenario) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/shared/node_modules/leaflet/dist/leaflet.css"><link rel="stylesheet" href="/${variant}/src/style.css"><style>html,body{margin:0}#map{width:100vw;height:100vh}</style></head><body><div id="map"></div><script src="/shared/node_modules/leaflet/dist/leaflet.js"></script><script>${refinement ? `(${installInstrumentation.toString()})();` : ''}</script><script type="module">
import { createCompiledJourneySphere } from '/${variant}/src/compiled.js';
window.errors=[];
window.frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
window.boot=(async()=>{
  window.journey=await createCompiledJourneySphere('#map',{dataUrl:'/${variant}/data/',center:${JSON.stringify(scenario.center)},zoom:4,visited:${JSON.stringify(scenario.visited || ['HKG:ADM0:HKG'])},onError:e=>window.errors.push(String(e.message||e))});
  await window.frame();
  window.firstDisplay=performance.now();
})();
window.boot.catch(e=>window.bootError=String(e.stack||e));
</script></body></html>`;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') {
      const variant = url.searchParams.get('variant');
      if (!['baseline', 'current'].includes(variant)) throw new Error('Invalid variant');
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      const scenario = scenarios.find(item => item.name === url.searchParams.get('scenario'));
      if (!scenario) throw new Error('Invalid scenario');
      res.end(html(variant, scenario)); return;
    }
    const data = await asset(url.pathname);
    const gzip = req.headers['accept-encoding']?.includes('gzip');
    res.writeHead(200, { 'Content-Type': data.type, 'Cache-Control': 'no-store',
      'Content-Length': (gzip ? data.gzip : data.raw).length, ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) });
    res.end(gzip ? data.gzip : data.raw);
  } catch (error) { res.writeHead(404); res.end(String(error.message)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
async function run(variant, sample, scenario, capture = false) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 200000, uploadThroughput: 200000 });
    await page.goto(`${origin}/?variant=${variant}&scenario=${scenario.name}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.firstDisplay || window.bootError);
    const result = await page.evaluate(() => {
      if (window.bootError) throw new Error(window.bootError);
      const resources = performance.getEntriesByType('resource').filter(e => e.responseEnd <= window.firstDisplay);
      return { firstDisplayMs: window.firstDisplay, transferBytes: resources.reduce((n, e) => n + e.transferSize, 0),
        encodedBytes: resources.reduce((n, e) => n + e.encodedBodySize, 0),
        detailRequestsBeforeDisplay: resources.filter(e => e.name.includes('/outlines/')).length };
    });
    assert.equal(result.detailRequestsBeforeDisplay, 0);
    if (capture) {
      await page.screenshot({ path: path.join(outputDir, `${variant}-overview.png`) });
      result.zoomDetailMs = await page.evaluate(async () => {
        const start = performance.now();
        window.journey.map.setView([22.3, 114.15], 10, { animate: false });
        if (window.journey.loadOutlineDetails) await window.journey.loadOutlineDetails();
        await window.frame();
        return performance.now() - start;
      });
      await page.screenshot({ path: path.join(outputDir, `${variant}-hong-kong-z10.png`) });
      await page.evaluate(async () => {
        window.journey.map.setView([22.265, 114.16], 12, { animate: false });
        if (window.journey.loadOutlineDetails) await window.journey.loadOutlineDetails();
        await window.frame();
      });
      await page.screenshot({ path: path.join(outputDir, `${variant}-hong-kong-z12.png`) });
    }
    errors.push(...await page.evaluate(() => window.errors));
    assert.deepEqual(errors, [], `${variant} browser errors`);
    await page.evaluate(() => window.journey.destroy());
    assert.equal(await page.locator('#map canvas').count(), 0);
    return { variant, sample, scenario: scenario.name, ...result };
  } finally { await context.close(); }
}
const captures = new Map();
async function runRefinement(variant, sample, scenario, capture = false) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 200000, uploadThroughput: 200000 });
    await page.goto(`${origin}/?variant=${variant}&scenario=${scenario.name}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.firstDisplay || window.bootError);
    const startup = await page.evaluate(async () => {
      if (window.bootError) throw new Error(window.bootError);
      const resources = performance.getEntriesByType('resource').filter(entry => entry.responseEnd <= window.firstDisplay);
      await window.journey.detailsReady;
      return { firstDisplayMs: window.firstDisplay, transferBytes: resources.reduce((sum, entry) => sum + entry.transferSize, 0),
        encodedBytes: resources.reduce((sum, entry) => sum + entry.encodedBodySize, 0),
        detailRequestsBeforeDisplay: performance.getEntriesByType('resource').filter(entry => entry.name.includes('/outlines/') && entry.startTime < window.firstDisplay).length };
    });
    assert.equal(startup.detailRequestsBeforeDisplay, 0, 'overview must not download detailed outlines before first display');
    const detail = await page.evaluate(async scenario => {
      window.benchBegin('detail');
      const start = performance.now();
      window.journey.map.setView(scenario.center, scenario.detailZoom, { animate: false });
      const records = await window.journey.loadOutlineDetails();
      await window.frame();
      const end = performance.now();
      // Country identification for later draw counters stays outside the timed phase.
      window.benchTrack(records);
      const resources = performance.getEntriesByType('resource').filter(entry => entry.name.includes('/data/outlines/') && entry.startTime >= start);
      return { zoomDetailMs: end - start, detailEncodedBytes: resources.reduce((sum, entry) => sum + entry.encodedBodySize, 0),
        detailTransferBytes: resources.reduce((sum, entry) => sum + entry.transferSize, 0), detailRequestCount: resources.length,
        detailCountries: records.map(record => record.countryCode).sort(), codeword: window.journey.getCodeword(), selected: window.journey.getVisited() };
    }, scenario);
    assert.ok(detail.detailEncodedBytes > 0 && detail.detailRequestCount > 0, 'the timed detail phase must contain actual network responses');
    assert.deepEqual(detail.selected, scenario.visited, 'refinement preserves the selection');
    for (const code of scenario.expected) assert.ok(detail.detailCountries.includes(code), `${scenario.name} must refine ${code}`);
    const measured = await page.evaluate(() => window.benchStats());
    if (capture) {
      const screenshot = await page.locator('#map').screenshot({ path: path.join(outputDir, `${variant}-${scenario.name}-detail.png`), animations: 'disabled' });
      captures.set(`${scenario.name}/${variant}`, screenshot);
    }
    let warm;
    if (scenario.name === 'pacific') {
      // USA and Russia are already cached. Prepare both European pan positions
      // so the measured pan/zoom sequence performs no network fetches.
      await page.evaluate(async () => {
        window.benchBegin('prepare-warm');
        for (const center of [[50, 10], [50, 10.7], [50, 10]]) {
          window.journey.map.setView(center, 9, { animate: false });
          window.benchTrack(await window.journey.loadOutlineDetails());
          await window.frame();
        }
      });
      warm = await page.evaluate(async () => {
        window.benchBegin('warm-pan-zoom');
        const start = performance.now();
        for (const [center, zoom] of [[[50, 10.7], 9], [[50, 10], 9], [[50, 10.7], 10], [[50, 10], 9]]) {
          window.journey.map.setView(center, zoom, { animate: false });
          await window.journey.loadOutlineDetails();
          await window.frame();
        }
        const end = performance.now();
        const outlineRequests = performance.getEntriesByType('resource').filter(entry => entry.name.includes('/data/outlines/') && entry.startTime >= start).length;
        return { elapsedMs: end - start, outlineRequests, ...window.benchStats()['warm-pan-zoom'] };
      });
      assert.equal(warm.outlineRequests, 0, 'warm pan/zoom must not hide additional outline requests');
    }
    errors.push(...await page.evaluate(() => window.errors));
    assert.deepEqual(errors, [], `${variant}/${scenario.name} browser errors`);
    await page.evaluate(() => { window.benchStop(); window.journey.destroy(); });
    assert.equal(await page.locator('#map canvas').count(), 0);
    return { variant, sample, scenario: scenario.name, ...startup, ...detail,
      rendering: { startup: measured.startup, detail: measured.detail }, ...(warm ? { warm } : {}) };
  } finally { await context.close(); }
}
async function compareScreenshots() {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const results = {};
    for (const scenario of scenarios) {
      const baseline = captures.get(`${scenario.name}/baseline`);
      const current = captures.get(`${scenario.name}/current`);
      assert.ok(baseline && current, `${scenario.name} needs both screenshot captures`);
      // Decode both PNGs and compare RGBA pixels: PNG metadata/compression does
      // not affect this equality check. This runs outside all timed phases.
      results[scenario.name] = await page.evaluate(async ({ baseline, current }) => {
        async function pixels(encoded) {
          const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
          const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
          const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
          const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
          const result = { width: image.width, height: image.height, rgba: context.getImageData(0, 0, image.width, image.height).data };
          image.close(); return result;
        }
        const a = await pixels(baseline); const b = await pixels(current);
        if (a.width !== b.width || a.height !== b.height) return { equal: false, dimensionsMatch: false };
        let differentPixels = 0; let maxChannelDifference = 0;
        for (let i = 0; i < a.rgba.length; i += 4) {
          let different = false;
          for (let channel = 0; channel < 4; channel++) {
            const delta = Math.abs(a.rgba[i + channel] - b.rgba[i + channel]);
            if (delta) different = true;
            maxChannelDifference = Math.max(maxChannelDifference, delta);
          }
          if (different) differentPixels++;
        }
        return { equal: differentPixels === 0, width: a.width, height: a.height, differentPixels, maxChannelDifference };
      }, { baseline: baseline.toString('base64'), current: current.toString('base64') });
    }
    return results;
  } finally { await context.close(); }
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
try {
  if (refinement) {
    const records = [];
    for (const scenario of scenarios) {
      await runRefinement('baseline', 0, scenario); await runRefinement('current', 0, scenario);
      for (let i = 1; i <= samples; i++) {
        for (const variant of i % 2 ? ['baseline', 'current'] : ['current', 'baseline']) {
          const row = await runRefinement(variant, i, scenario, i === 1);
          records.push(row);
          console.log(`${scenario.name} ${variant} ${i}: first ${row.firstDisplayMs.toFixed(1)} ms; detail ${row.zoomDetailMs.toFixed(1)} ms / ${row.detailEncodedBytes} bytes; ${row.rendering.detail.tileCount} tiles / ${row.rendering.detail.tileCpuMs.toFixed(1)} ms CPU`);
        }
      }
    }
    const byScenario = Object.fromEntries(scenarios.map(scenario => {
      const pair = Object.fromEntries(['baseline', 'current'].map(variant => {
        const rows = records.filter(row => row.scenario === scenario.name && row.variant === variant);
        return [variant, {
          firstDisplayMs: median(rows.map(row => row.firstDisplayMs)),
          firstDisplayTransferBytes: median(rows.map(row => row.transferBytes)),
          zoomDetailMs: median(rows.map(row => row.zoomDetailMs)),
          detailEncodedBytes: median(rows.map(row => row.detailEncodedBytes)),
          detailTransferBytes: median(rows.map(row => row.detailTransferBytes)),
          detailRequestCount: median(rows.map(row => row.detailRequestCount)),
          startupTileCount: median(rows.map(row => row.rendering.startup.tileCount)),
          startupTileCpuMs: median(rows.map(row => row.rendering.startup.tileCpuMs)),
          startupRedrawCount: median(rows.map(row => row.rendering.startup.redrawCount)),
          detailTileCount: median(rows.map(row => row.rendering.detail.tileCount)),
          detailTileCpuMs: median(rows.map(row => row.rendering.detail.tileCpuMs)),
          detailRedrawCount: median(rows.map(row => row.rendering.detail.redrawCount)),
          ...(scenario.name === 'pacific' ? { warm: {
            elapsedMs: median(rows.map(row => row.warm.elapsedMs)),
            tileCpuMs: median(rows.map(row => row.warm.tileCpuMs)),
            tileCount: median(rows.map(row => row.warm.tileCount)),
            parsedPathBytes: median(rows.map(row => row.warm.parsedPathBytes)),
            distantCountryDraws: median(rows.map(row => (row.warm.drawCounts.USA || 0) + (row.warm.drawCounts.RUS || 0))),
          } } : {}),
        }];
      }));
      const firstDisplayBudgetMs = Math.max(pair.baseline.firstDisplayMs * limits.firstDisplayRelative, limits.firstDisplayAbsoluteMs);
      const detailByteReduction = 1 - pair.current.detailEncodedBytes / pair.baseline.detailEncodedBytes;
      const detailLatencyReduction = 1 - pair.current.zoomDetailMs / pair.baseline.zoomDetailMs;
      const codewords = new Set(records.filter(row => row.scenario === scenario.name).map(row => row.codeword));
      assert.equal(codewords.size, 1, `${scenario.name} codeword must match across every baseline/current sample`);
      return [scenario.name, { ...pair, firstDisplayBudgetMs, detailByteReduction, detailLatencyReduction,
        pass: pair.current.firstDisplayMs <= pair.baseline.firstDisplayMs + firstDisplayBudgetMs &&
          detailByteReduction >= limits.detailByteReduction && detailLatencyReduction >= limits.detailLatencyReduction }];
    }));
    const pixels = await compareScreenshots();
    const warm = byScenario.pacific;
    const cullingPass = warm.baseline.warm.distantCountryDraws > 0 && warm.current.warm.distantCountryDraws === 0;
    const corpusByteReduction = 1 - corpus.current.gzipBytes / corpus.baseline.gzipBytes;
    const corpusPass = corpusByteReduction >= limits.corpusByteReduction;
    const pass = corpusPass && Object.values(byScenario).every(scenario => scenario.pass) && Object.values(pixels).every(result => result.equal) && cullingPass;
    const output = { mode, baselineCommit, scenarios, samples, limits,
      settings: '1200x800 DPR1; cold zoom-4 first display, then every-sample fine detail; warm Pacific-to-Europe pan/zoom; one warmup then alternating variants',
      network: { latencyMs: 150, bitsPerSecond: 1_600_000, gzip: true, coldCache: true },
      metricNotes: 'Detail bytes are encoded response bodies for outline requests. Tile CPU is synchronous createTile execution with identical instrumentation, not GPU raster time. Warm elapsed time includes real animation-frame presentation fences, never fixed sleeps.',
      preparedAssets: { count: cache.size, allOutlinePayloads: true, measuredCacheMissAllowed: false },
      corpus: { ...corpus, byteReduction: corpusByteReduction, pass: corpusPass }, byScenario, pixels, cullingPass, records, pass };
    await writeFile(path.join(outputDir, 'benchmark.json'), `${JSON.stringify(output, null, 2)}\n`);
    console.log(JSON.stringify({ corpus: output.corpus, byScenario, pixels, cullingPass, pass }, null, 2));
    assert.ok(pass, 'Refinement must materially improve bytes and latency in every view, preserve first display and exact pixels, and eliminate distant cached-country draws.');
  } else {
    const records = [];
    for (const scenario of scenarios) {
      await run('baseline', 0, scenario); await run('current', 0, scenario);
      for (let i = 1; i <= samples; i++) {
        for (const variant of i % 2 ? ['baseline', 'current'] : ['current', 'baseline']) {
          const row = await run(variant, i, scenario, i === 1 && scenario.name === 'east-asia');
          records.push(row);
          console.log(`${scenario.name} ${variant} ${i}: ${row.firstDisplayMs.toFixed(1)} ms, ${row.transferBytes} bytes`);
        }
      }
    }
    const summary = Object.fromEntries(['baseline', 'current'].map(variant => {
      const rows = records.filter(row => row.variant === variant);
      return [variant, { firstDisplayMs: median(rows.map(r => r.firstDisplayMs)), transferBytes: median(rows.map(r => r.transferBytes)) }];
    }));
    const worldBytes = Object.fromEntries(['baseline', 'current'].map(v => [v, cache.get(`/${v}/data/compiled/world.json`).gzip.length]));
    const byScenario = Object.fromEntries(scenarios.map(scenario => [scenario.name, Object.fromEntries(['baseline', 'current'].map(variant => {
      const rows = records.filter(r => r.scenario === scenario.name && r.variant === variant);
      return [variant, { firstDisplayMs: median(rows.map(r => r.firstDisplayMs)), transferBytes: median(rows.map(r => r.transferBytes)) }];
    }))]));
    const pass = Object.values(byScenario).every(result => result.current.firstDisplayMs < result.baseline.firstDisplayMs && result.current.transferBytes < result.baseline.transferBytes);
    const output = { baselineCommit, scenarios, settings: 'Zoom 4, 1200x800 DPR1; HKG visit retained in all views, same compiled renderer entry point',
      network: { latencyMs: 150, bitsPerSecond: 1_600_000, gzip: true, coldCache: true }, samples, worldGzipBytes: worldBytes,
      summary, byScenario, records, pass };
    await writeFile(path.join(outputDir, 'benchmark.json'), `${JSON.stringify(output, null, 2)}\n`);
    console.log(JSON.stringify({ summary, byScenario, worldBytes, pass: output.pass }, null, 2));
    assert.ok(output.pass, 'Every geographic view must improve both first-display median and transferred bytes over the pinned baseline.');
  }
} finally { await browser.close(); server.close(); }
