#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8765);
const DATA_DELAY_MS = 100;
const SAMPLES = 5;
const BASELINE_REF = process.env.BASELINE_REF || 'HEAD';
if (!/^[A-Za-z0-9_./@-]+$/.test(BASELINE_REF) || BASELINE_REF.startsWith('-')) {
  throw new Error('BASELINE_REF must be a simple git ref name');
}

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

function baselineSource(name) {
  try {
    const source = execFileSync('git', ['show', `${BASELINE_REF}:src/${name}`], { cwd: ROOT, encoding: 'utf8' });
    if (!source.trim()) throw new Error(`git ref ${BASELINE_REF} returned empty src/${name}`);
    return source;
  } catch (error) {
    throw new Error(`Unable to read baseline src/${name} from git ${BASELINE_REF}: ${error.message}`);
  }
}

const baseline = new Map(['index.js', 'geometry.js', 'state.js'].map(name => [name, baselineSource(name)]));

const PREVIEW_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JourneySphere preview</title><link rel="stylesheet" href="/node_modules/leaflet/dist/leaflet.css"><link rel="stylesheet" href="/current/src/style.css"><style>body{margin:24px;font:16px system-ui;color:#243446}#map{height:70vh}button{margin:12px 8px 12px 0;padding:8px}output{display:block}</style></head>
<body><h1>JourneySphere preview</h1><div id="map"></div><button id="reset">Reset visits</button><button id="clear">Clear visits</button><button id="wrapped">Wrapped world</button><button id="usa">USA</button><button id="word">Restore codeword</button><output id="state">Loading…</output>
<script src="/node_modules/leaflet/dist/leaflet.js"></script><script type="module">
const output = document.querySelector('#state');
try {
  const visited = ['SGP:ADM0:SGP'];
  const { createCompiledJourneySphere } = await import('/current/src/compiled.js');
  const map = await createCompiledJourneySphere('#map', { dataUrl: '/current/data/', visited, center: [1.35, 103.82], zoom: 10,
    onChange: state => { output.textContent = state.visited.length + ' visited regions'; } });
  const word = map.getCodeword();
  document.querySelector('#wrapped').onclick = () => map.map.setView([1.35, 463.82], 10);
  document.querySelector('#usa').onclick = async () => {
    const catalog = await map.loadCatalog();
    await map.setVisited(catalog.regionIds.filter(id => id.startsWith('USA:')).slice(0, 40));
    map.map.setView([39, -98], 4);
  };
  document.querySelector('#word').onclick = async () => { await map.setCodeword(word); map.map.setView([1.35, 103.82], 10); };
  document.querySelector('#reset').onclick = () => map.reset();
  document.querySelector('#clear').onclick = () => map.setVisited([]);
  output.textContent = map.getVisited().length + ' visited regions';
} catch (error) { output.textContent = error.message; }
</script></body></html>`;

const BENCHMARK_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>JourneySphere startup benchmark</title>
<link rel="stylesheet" href="/node_modules/leaflet/dist/leaflet.css">
<style>
body{margin:24px;max-width:1100px;font:15px/1.45 system-ui,sans-serif;color:#243446}
button{padding:8px 14px;margin-right:8px}#maps{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:16px}
.map{height:250px;border:1px solid #cbd5e1}.run{padding:8px 0;border-bottom:1px solid #e2e8f0}
pre{white-space:pre-wrap;background:#f8fafc;padding:12px;border-radius:6px}output{display:block;margin:12px 0}
</style>
</head>
<body>
<h1>JourneySphere startup benchmark</h1>
<p>USA, first catalog region, cold no-store data responses with a fixed ${DATA_DELAY_MS} ms response delay. Each variant has one warmup and ${SAMPLES} measured runs.</p>
<button id="run">Run benchmark</button><output id="status" aria-live="polite">Ready.</output>
<div id="maps"><div id="baseline-map" class="map"></div><div id="current-map" class="map"></div></div>
<pre id="results">No runs yet.</pre>
<script src="/node_modules/leaflet/dist/leaflet.js"></script>
<script type="module">
const results = document.querySelector('#results');
const status = document.querySelector('#status');
const runButton = document.querySelector('#run');
const variants = ['baseline', 'current', 'compiled'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function moduleFor(variant) {
  if (variant === 'compiled') return import('/current/src/compiled.js');
  return import('/' + variant + '/src/index.js');
}

function countryTiming(started) {
  const entries = performance.getEntriesByType('resource');
  const world = entries.filter(entry => /\\/(?:baseline|current)\\/data\\/(?:compiled\\/)?world\\.(?:geojson|json)/.test(entry.name));
  const country = entries.filter(entry => /\\/(?:baseline|current)\\/data\\/(?:compiled\\/)?countries\\//.test(entry.name));
  const worldEnd = world.length ? Math.max(...world.map(entry => entry.responseEnd)) : null;
  const countryStart = country.length ? Math.min(...country.map(entry => entry.startTime)) : null;
  return { worldEnd: worldEnd == null ? null : worldEnd - started,
    countryStartMinusWorldEnd: countryStart == null || worldEnd == null ? null : countryStart - worldEnd,
    country: country.map(entry => ({
    name: entry.name.split('/').pop(), start: entry.startTime - started, end: entry.responseEnd - started,
    duration: entry.duration,
  })) };
}

const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

async function runOne(variant, sample, firstUSA) {
  const mod = await moduleFor(variant);
  const container = document.querySelector('#' + (variant === 'compiled' ? 'current' : variant) + '-map');
  container.replaceChildren();
  performance.clearResourceTimings();
  let createElementCount = 0;
  let spanCount = 0;
  const originalCreateElement = document.createElement;
  document.createElement = function(name, options) {
    createElementCount += 1;
    if (String(name).toLowerCase() === 'span') spanCount += 1;
    return originalCreateElement.call(this, name, options);
  };
  const errors = [];
  const started = performance.now();
  let map;
  try {
    const create = mod.createCompiledJourneySphere || mod.createJourneySphere;
    map = await create(container, {
      dataUrl: '/' + (variant === 'compiled' ? 'current' : variant) + '/data/', visited: [firstUSA], center: [39, -98], zoom: 4,
      onError: error => errors.push(String(error?.message || error)),
    });
  } finally {
    document.createElement = originalCreateElement;
  }
  const readyMs = performance.now() - started;
  const timing = countryTiming(started);
  const paintReadyMs = (await nextFrame(), performance.now() - started);
  let smoke = { ok: true, states: [] };
  try {
    const initial = map.getVisited();
    if (initial.length !== 1 || initial[0] !== firstUSA) throw new Error('initial visited state mismatch');
    smoke.states.push({ action: 'initial', visited: initial });
    await map.setVisited([]);
    const cleared = map.getVisited();
    if (cleared.length !== 0) throw new Error('clear state mismatch');
    smoke.states.push({ action: 'clear', visited: cleared });
    await map.setVisited([firstUSA]);
    const restored = map.getVisited();
    if (restored.length !== 1 || restored[0] !== firstUSA) throw new Error('set state mismatch');
    smoke.states.push({ action: 'set', visited: restored });
    await map.reset();
    const reset = map.getVisited();
    if (reset.length !== 1 || reset[0] !== firstUSA) throw new Error('reset state mismatch');
    smoke.states.push({ action: 'reset', visited: reset });
    map.destroy();
    map.destroy();
    let rejectedAfterDestroy = false;
    try { await map.setVisited([]); }
    catch (error) { if (!/destroyed/i.test(error.message)) throw error; rejectedAfterDestroy = true; }
    if (!rejectedAfterDestroy) throw new Error('destroyed map accepted setVisited');
  } catch (error) {
    smoke = { ok: false, error: String(error?.message || error), states: smoke.states };
    map?.destroy();
  }
  const record = { variant, sample, firstUSA, readyMs, createElementCount,
    spanCount, paintReadyMs, worldEndMs: timing.worldEnd,
    countryStartMinusWorldEnd: timing.countryStartMinusWorldEnd,
    country: timing.country, errors, smoke };
  container.replaceChildren();
  return record;
}

function summary(records) {
  return variants.map(variant => {
    const rows = records.filter(row => row.variant === variant);
    const stats = field => {
      const values = rows.map(row => row[field]).filter(value => Number.isFinite(value)).sort((a, b) => a - b);
      return { mean: values.reduce((sum, value) => sum + value, 0) / values.length,
        median: values[Math.floor(values.length / 2)] };
    };
    return { variant, runs: rows.length, readyMs: stats('readyMs'), paintReadyMs: stats('paintReadyMs'),
      createElementCount: stats('createElementCount'), spanCount: stats('spanCount'), rows };
  });
}

async function run() {
  runButton.disabled = true;
  status.textContent = 'Running…';
  const records = [];
  try {
    const catalog = await fetch('/current/data/catalog.json').then(response => {
      if (!response.ok) throw new Error('Catalog request failed: ' + response.status);
      return response.json();
    });
    const firstUSA = catalog.regionIds.find(id => id.startsWith('USA:'));
    if (!firstUSA) throw new Error('Catalog has no USA region');
    for (const variant of variants) {
      status.textContent = 'Warmup ' + variant + '…';
      const warmup = await runOne(variant, 'warmup', firstUSA);
      if (warmup.errors.length || !warmup.smoke.ok) {
        throw new Error('Warmup ' + variant + ' failed: ' + JSON.stringify({ errors: warmup.errors, smoke: warmup.smoke }));
      }
    }
    for (let sample = 1; sample <= ${SAMPLES}; sample += 1) {
      const order = sample % 2 === 1 ? [...variants].reverse() : variants;
      for (const variant of order) {
        status.textContent = 'Running ' + variant + ' sample ' + sample + '…';
        records.push(await runOne(variant, sample, firstUSA));
        await sleep(50);
      }
    }
    results.textContent = JSON.stringify({ baselineRef: '${BASELINE_REF}', dataDelayMs: ${DATA_DELAY_MS},
      measuredRuns: ${SAMPLES}, warmups: 1, firstUSA, records, summary: summary(records) }, null, 2);
    const failures = records.filter(record => record.errors.length || !record.smoke.ok);
    status.textContent = failures.length ? 'Failed: ' + failures.length + ' runs had errors. See results.' : 'Complete.';
  } catch (error) {
    status.textContent = 'Failed: ' + error.message;
    results.textContent = error.stack || String(error);
  } finally {
    runButton.disabled = false;
  }
}
runButton.addEventListener('click', run);
</script>
</body></html>`;

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath);
  if (decoded.includes('\0') || decoded.split('/').includes('..')) return null;
  return decoded;
}

async function fileResponse(res, filePath, type, delayed = false) {
  if (delayed) await new Promise(resolve => setTimeout(resolve, DATA_DELAY_MS));
  const body = await readFile(filePath);
  res.statusCode = 200;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Accept-Encoding');
  if (body.length > 0 && /gzip/.test(String(res.req.headers['accept-encoding'] || ''))) {
    res.setHeader('Content-Encoding', 'gzip');
    await pipeline(Readable.from(body), createGzip(), res);
  } else res.end(body);
}

async function respond(req, res) {
  const parsed = new URL(req.url, 'http://127.0.0.1');
  const requestPath = safePath(parsed.pathname);
  if (!requestPath) { res.writeHead(400); res.end('Bad path'); return; }
  try {
    if (requestPath === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(BENCHMARK_HTML);
      return;
    }
    if (requestPath === '/preview') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(PREVIEW_HTML);
      return;
    }
    if (requestPath === '/current/examples/index.html') {
      const example = await readFile(path.join(ROOT, 'examples/index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      res.end(example.replaceAll('https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/', '/node_modules/leaflet/dist/'));
      return;
    }
    if (requestPath === '/health') { res.writeHead(200); res.end('ok'); return; }
    const sourceMatch = requestPath.match(/^\/(baseline|current)\/src\/(index|geometry|state|compiled|compiled-layer)\.js$/);
    if (sourceMatch) {
      const [, variant, name] = sourceMatch;
      const body = variant === 'baseline' ? baseline.get(`${name}.js`) : await readFile(path.join(ROOT, 'src', `${name}.js`));
      res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }
    if (requestPath === '/current/src/style.css') {
      await fileResponse(res, path.join(ROOT, 'src', 'style.css'), MIME['.css']);
      return;
    }
    if (requestPath === '/current/data/compiled/manifest.js') {
      await fileResponse(res, path.join(ROOT, 'data', 'compiled', 'manifest.js'), MIME['.js']);
      return;
    }
    const dataMatch = requestPath.match(/^\/(baseline|current)\/data\/(.+)$/);
    if (dataMatch && /^[-\w./]+\.(?:json|geojson)$/.test(dataMatch[2])) {
      const relative = dataMatch[2];
      const filePath = path.resolve(ROOT, 'data', relative);
      if (!filePath.startsWith(path.resolve(ROOT, 'data') + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error('Not a file');
      await fileResponse(res, filePath, MIME[path.extname(filePath)] || 'application/octet-stream', true);
      return;
    }
    const assetMatch = requestPath.match(/^\/node_modules\/leaflet\/dist\/(leaflet(?:\.css|\.js)|images\/(?:layers(?:-2x)?|marker-icon(?:-2x)?|marker-shadow)\.png)$/);
    if (assetMatch) {
      const filePath = path.join(ROOT, 'node_modules', 'leaflet', 'dist', assetMatch[1]);
      await fileResponse(res, filePath, MIME[path.extname(filePath)] || 'application/octet-stream');
      return;
    }
    res.writeHead(404); res.end('Not found');
  } catch (error) {
    res.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(error.code === 'ENOENT' ? 'Not found' : error.stack || String(error));
  }
}

const server = createServer(respond);
server.listen(PORT, '127.0.0.1', () => {
  const address = server.address();
  console.log(`JourneySphere startup benchmark ready at http://127.0.0.1:${address.port}/`);
  console.log(`Run in a browser, then click “Run benchmark”. Data responses are delayed ${DATA_DELAY_MS}ms and gzip-enabled.`);
});

function shutdown() { server.close(() => process.exit(0)); }
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
