#!/usr/bin/env node

// Exercise a cold exported embed while the oversized CDN package is unavailable.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportEmbed } from './export-embed.mjs';
import { resolvePlaces } from '../src/places.js';
import aliases from '../data/embed/aliases.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.env.OUTPUT_DIR || path.join(os.tmpdir(), 'journeysphere-embed-delivery'));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'journeysphere-delivery-'));
const runtime = path.join(temporary, 'packages/journey-sphere');
const revision = '5079212a661d9bd2b73dfcb7d1e2ca3adfb60633';
const revisionRoot = `https://raw.githubusercontent.com/williamzheng0711/journey-sphere/${revision}/`;
const dataBaseUrl = `${revisionRoot}data/embed/`;
const places = ['上海', '香港', 'Tokyo', 'Ayagawa, Kagawa Prefecture, JPN'];
const mime = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8',
  json: 'application/json', css: 'text/css', png: 'image/png' };
const manifest = JSON.parse(await readFile(path.join(root, 'data/compiled/manifest.json'), 'utf8'));

// Use canonical local data to keep this regression independent of remote uptime.
const provenance = await exportEmbed({ outputDir: runtime, dataBaseUrl,
  fetchImpl: async url => {
    if (String(url) === `${dataBaseUrl}aliases.js`) {
      return new Response(await readFile(path.join(root, 'data/embed/aliases.js')),
        { headers: { 'Content-Type': 'text/javascript' } });
    }
    assert.equal(String(url), `${revisionRoot}data/compiled/manifest.json`);
    return new Response(JSON.stringify(manifest), { headers: { 'Content-Type': 'application/json' } });
  },
});
const originalFetch = globalThis.fetch;
let expected;
try {
  globalThis.fetch = async url => {
    const target = new URL(url);
    assert.ok(target.href.startsWith(dataBaseUrl));
    return new Response(await readFile(path.join(root, target.href.slice(revisionRoot.length))));
  };
  expected = await resolvePlaces(places, { baseUrl: dataBaseUrl });
} finally { globalThis.fetch = originalFetch; }

const fixture = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0}journey-sphere{display:block;width:100%;--journey-sphere-height:580px;--journey-sphere-radius:0}</style></head><body>
<journey-sphere data-base-url="${dataBaseUrl}" places='${JSON.stringify(places)}' center="31.5,121.8" zoom="4"></journey-sphere>
<script>window.element=document.querySelector('journey-sphere');window.events=[];window.rejections=[];
document.addEventListener('journey-ready',()=>window.events.push('ready'));
document.addEventListener('journey-error',event=>window.events.push(event.detail?.message||String(event.detail)));
window.addEventListener('unhandledrejection',event=>window.rejections.push(String(event.reason?.message||event.reason)));
</script><script type="module" src="/packages/journey-sphere/embed.js"></script></body></html>`;
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (pathname === '/' || pathname === '/fixture.html') {
      response.writeHead(200, { 'Content-Type': mime.html }); response.end(fixture); return;
    }
    const file = pathname.replace(/^\//, '');
    if (file.split('/').includes('..')) throw new Error('Invalid asset path');
    const body = await readFile(path.join(temporary, file));
    response.writeHead(200, { 'Content-Type': mime[file.split('.').pop()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(body);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const requests = [];
const pageErrors = [];
const unexpected = [];
let failSingapore = false;

try {
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1000, height: 620 } });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith(origin)) return route.continue();
    if (new URL(url).hostname.endsWith('jsdelivr.net')) {
      return route.fulfill({ status: 403, contentType: 'text/plain',
        body: 'Package size exceeded the configured limit of 50 MB.' });
    }
    if (!url.startsWith(revisionRoot)) {
      unexpected.push(url); return route.fulfill({ status: 403, body: 'Unexpected external dependency' });
    }
    const relative = url.slice(revisionRoot.length);
    assert.ok(relative.startsWith('data/') && relative.endsWith('.json'));
    const singaporeChunk = `data/embed/${aliases.singapore[0].chunks[0]}`;
    if (failSingapore && relative === singaporeChunk) {
      return route.fulfill({ status: 503, contentType: 'text/plain',
        headers: { 'Access-Control-Allow-Origin': '*' }, body: 'Intentional data outage' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' }, body: await readFile(path.join(root, relative)) });
  });
  await page.goto(`${origin}/fixture.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => customElements.get('journey-sphere'), null, { timeout: 15000 });
  assert.equal(await page.evaluate(async () => Boolean(await window.element.ready)), true);
  await page.waitForFunction(() => window.element.shadowRoot.querySelector('canvas.leaflet-tile'));
  assert.deepEqual(await page.evaluate(() => window.element.journey.getVisited()), expected.visited);
  await page.evaluate(() => window.element.journey.loadOutlineDetails());
  const initialErrors = await page.evaluate(() => window.events.filter(event => event !== 'ready'));
  assert.deepEqual(initialErrors, [], 'cold startup and refinement succeed with the CDN unavailable');
  const dataRequests = requests.filter(url => url.startsWith(revisionRoot));
  assert.ok(dataRequests.some(url => url.endsWith('/data/embed/world.json')));
  assert.ok(dataRequests.some(url => url.includes('/data/embed/groups/CHN/')));
  assert.ok(dataRequests.some(url => url.includes('/data/embed/names/')), 'non-alias names use the pinned name shard');
  assert.ok(dataRequests.some(url => url.includes('/data/outlines/')), 'zoom refinement uses the same pinned source');
  assert.equal(dataRequests.some(url => url.includes('/data/compiled/countries/')), false);
  assert.equal(requests.some(url => new URL(url).hostname.endsWith('jsdelivr.net')), false,
    'runtime, styles, engine and data need no CDN requests');
  assert.deepEqual(unexpected, []);
  await page.screenshot({ path: path.join(output, 'map-loaded.png') });

  await page.evaluate(() => {
    window.initialJourney = window.element.journey;
    window.initialCanvases = [...window.element.shadowRoot.querySelectorAll('canvas')];
  });
  failSingapore = true;
  const failure = await page.evaluate(async () => {
    window.element.places = ['Singapore'];
    try { await window.element.ready; return ''; } catch (error) { return error.message; }
  });
  assert.match(failure, /503 loading place data for SGP/);
  assert.equal(await page.evaluate(() => window.element.journey === window.initialJourney), true);
  assert.deepEqual(await page.evaluate(() => window.element.journey.getVisited()), expected.visited);
  assert.ok(await page.evaluate(() => window.initialCanvases.some(canvas => canvas.isConnected)),
    'an unavailable place update preserves the displayed map');
  failSingapore = false;
  await page.evaluate(() => { window.element.places = ['Singapore']; });
  assert.equal(await page.evaluate(async () => Boolean(await window.element.ready)), true);
  assert.deepEqual(await page.evaluate(() => window.element.journey.getVisited()), aliases.singapore[0].ids);
  assert.equal(await page.evaluate(() => window.element.journey === window.initialJourney), true);
  assert.equal(await page.evaluate(() => window.element.shadowRoot.querySelector('.message').hidden), true);
  assert.equal(requests.filter(url => url.endsWith('/data/embed/world.json')).length, 1,
    'updates and retries retain the initial world download');
  assert.deepEqual(await page.evaluate(() => window.rejections), []);
  assert.deepEqual(pageErrors, []);
  const report = { checks: ['cold exported embed without CDN', 'pinned world, groups, names and refinement',
    'failed update preserves map', 'same-place retry recovers'], exportedFiles: Object.keys(provenance.files).length,
    dataBaseUrl, initialVisitedCount: expected.visited.length,
    requests: requests.map(url => url.replaceAll(origin, '<local>')), pageErrors };
  await writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log('PASS exported embed loads pinned map data without the oversized CDN package; failed updates retain the map and retry successfully');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
