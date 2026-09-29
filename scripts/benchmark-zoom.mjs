#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineRef = process.env.BASELINE_REF || '65d417c1';
const baselineCommit = execFileSync('git', ['rev-parse', baselineRef], { cwd: root, encoding: 'utf8' }).trim();
const samples = Number(process.env.SAMPLES || 5);
assert.ok(Number.isInteger(samples) && samples >= 5, 'At least five samples are required for a passing benchmark.');
const scenarios = [
  { name: 'east-asia', center: [22.3, 114.15] },
  { name: 'europe', center: [50, 10] },
  { name: 'pacific', center: [-25, 175] },
];
const outputDir = path.join(root, 'outputs/zoom-detail');
await mkdir(outputDir, { recursive: true });
const cache = new Map();
const types = { '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };
function gitFile(file) {
  return execFileSync('git', ['show', `${baselineCommit}:${file}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
}
async function asset(url) {
  if (!cache.has(url)) {
    const [, variant, ...parts] = url.split('/');
    const file = parts.join('/');
    if (!['baseline', 'current', 'shared'].includes(variant) || file.includes('..')) throw new Error('Invalid asset');
    const body = variant === 'baseline' ? gitFile(file) : await readFile(path.join(root, file));
    cache.set(url, { raw: body, gzip: gzipSync(body), type: types[path.extname(file)] || 'application/octet-stream' });
  }
  return cache.get(url);
}
// Preload all measured assets so disk/git/gzip work cannot bias either variant.
for (const variant of ['baseline', 'current']) {
  for (const file of ['src/compiled.js', 'src/compiled-layer.js', 'src/state.js', 'src/style.css',
    'data/compiled/manifest.js', 'data/compiled/world.json', 'data/compiled/countries/HKG.json',
    ...(variant === 'current' ? ['src/outline-detail.js', 'data/outlines/HKG.json', 'data/outlines/CHN.json', 'data/outlines/MAC.json'] : [])]) {
    await asset(`/${variant}/${file}`);
  }
}
for (const file of ['leaflet.js', 'leaflet.css']) await asset(`/shared/node_modules/leaflet/dist/${file}`);
const html = (variant, scenario) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/shared/node_modules/leaflet/dist/leaflet.css"><link rel="stylesheet" href="/${variant}/src/style.css"><style>html,body{margin:0}#map{width:100vw;height:100vh}</style></head><body><div id="map"></div><script src="/shared/node_modules/leaflet/dist/leaflet.js"></script><script type="module">
import { createCompiledJourneySphere } from '/${variant}/src/compiled.js';
window.errors=[];
window.frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
window.boot=(async()=>{
  window.journey=await createCompiledJourneySphere('#map',{dataUrl:'/${variant}/data/',center:${JSON.stringify(scenario.center)},zoom:4,visited:['HKG:ADM0:HKG'],onError:e=>window.errors.push(String(e.message||e))});
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
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
try {
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
} finally { await browser.close(); server.close(); }
