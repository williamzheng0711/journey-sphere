#!/usr/bin/env node

// Browser regression for overlapping atlas polygons. Pixel samples are taken
// well inside paths, away from outlines, so they measure fill opacity directly.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(root, process.env.OUTPUT_DIR || 'outputs/map-fills');
const baselineRef = process.env.BASELINE_REF || '7f1f06c7';
const baselineRoot = await mkdtemp(path.join(os.tmpdir(), 'journey-fills-baseline-'));
const archive = execFileSync('git', ['archive', baselineRef, 'src', 'vendor', 'data/compiled/manifest.json', 'data/compiled/manifest.js',
  'data/compiled/countries/CHN.json', 'data/compiled/countries/MAC.json', 'data/embed/world.json', 'data/outlines'],
{ cwd: root, maxBuffer: 64 * 1024 * 1024 });
execFileSync('tar', ['-xf', '-', '-C', baselineRoot], { input: archive });
const fixtures = new Map();
const selectedIds = ['CHN:ADM2:440400', 'MAC:ADM0:MAC'];
for (const [variant, base] of [['baseline', baselineRoot], ['current', root]]) {
  const load = async file => JSON.parse(await readFile(path.join(base, file), 'utf8'));
  const manifest = await load('data/compiled/manifest.json');
  const china = await load('data/compiled/countries/CHN.json');
  const macao = await load('data/compiled/countries/MAC.json');
  const zhuhai = china.features.find(record => record.id === selectedIds[0]);
  assert.ok(zhuhai, `${variant}: canonical Zhuhai record exists`);
  fixtures.set(variant, { base, manifest: { ...manifest, outlines: { ...manifest.outlines,
    countries: Object.fromEntries(['CHN', 'MAC'].map(code => [code, manifest.outlines.countries[code]])) } },
  china: { ...china, features: [zhuhai], admin1: china.admin1.filter(record => record.id === zhuhai.parentId) },
  macao, world: await load('data/embed/world.json') });
}
const head = variant => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/${variant}/vendor/leaflet/leaflet.css"><link rel="stylesheet" href="/${variant}/src/style.css"><style>html,body,#map{margin:0;width:100%;height:100%}</style></head><body><div id="map"></div>`;
function fixture(variant, synthetic) {
  if (synthetic) return `${head(variant)}<script type="module">
import * as L from '/${variant}/vendor/leaflet/leaflet.esm.min.js';
import {createCompiledLayer} from '/${variant}/src/compiled-layer.js';
window.synthetic=({kind='selected',opacity=.44,colors=['#000095','#000095'],overlap=true}={})=>{
 const rect=(id,d,bounds)=>({id,countryCode:id.split(':')[0],name:id,d,bounds});
 const first=rect('AAA:ADM0:A','M20 20l160 0l0 160l-160 0l0 -160z M70 70l60 0l0 60l-60 0l0 -60z',[20,20,180,180]);
 const second=rect('BBB:ADM0:B',overlap?'M100 40l120 0l0 120l-120 0l0 -120z':'M190 40l40 0l0 120l-40 0l0 -120z',overlap?[100,40,220,160]:[190,40,230,160]);
 const records=[first,second];
 const layer=createCompiledLayer(L,{extent:256,world:{features:kind==='world'?records:[]},getCountries:()=>kind==='world'?[]:[{features:records}],getVisited:()=>records.map(record=>record.id),colorFor:code=>colors[code==='AAA'?0:1],fillOpacity:opacity,interactive:false});
 const tile=layer.createTile({x:0,y:0,z:0},()=>{});document.body.replaceChildren(tile);
 const context=tile.getContext('2d');const ratio=tile.width/256;
 const sample=(x,y)=>Array.from(context.getImageData(Math.floor(x*ratio),Math.floor(y*ratio),1,1).data);
 return {first:sample(40,40),overlap:sample(140,60),second:sample(200,60),uncoveredHole:sample(85,85),coveredHole:sample(115,85)};
};window.__ready=true;</script></body></html>`;
  const { manifest, world, china, macao } = fixtures.get(variant);
  return `${head(variant)}<script type="module">
import * as L from '/${variant}/vendor/leaflet/leaflet.esm.min.js';
import {createCompiledJourneySphere} from '/${variant}/src/compiled.js';
window.__errors=[];window.__ready=createCompiledJourneySphere('#map',{leaflet:L,manifest:${JSON.stringify(manifest)},worldData:${JSON.stringify(world)},initialCountries:${JSON.stringify({ CHN: china, MAC: macao })},dataUrl:'/${variant}/data/',backgroundDetails:false,visited:${JSON.stringify(selectedIds)},center:[22.18,113.53],zoom:12,mapOptions:{worldCopyJump:false},onError:error=>window.__errors.push(error.message)}).then(async api=>{window.api=api;api.map.eachLayer(layer=>{if(layer._hitRecord)window.layer=layer});await api.loadOutlineDetails();return true;});
</script></body></html>`;
}
const mime = { js: 'text/javascript', json: 'application/json', css: 'text/css' };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    const [, variant, ...parts] = url.pathname.split('/');
    const value = fixtures.get(variant);
    if (!value || parts.includes('..')) throw new Error('Invalid fixture path');
    response.setHeader('Cache-Control', 'no-store');
    if (parts.join('/') === 'fixture.html') {
      response.setHeader('Content-Type', 'text/html'); response.end(fixture(variant, url.searchParams.has('synthetic'))); return;
    }
    const filename = path.join(value.base, ...parts);
    response.setHeader('Content-Type', mime[filename.split('.').pop()] || 'application/octet-stream');
    response.end(await readFile(filename));
  } catch { response.writeHead(404); response.end(); }
});
await mkdir(output, { recursive: true });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const checks = [];
const pageErrors = [];
const contexts = [];
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function open(variant, dpr, synthetic = false) {
  const context = await browser.newContext({ viewport: { width: 1006, height: 778 }, deviceScaleFactor: dpr });
  contexts.push(context);
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${origin}/${variant}/fixture.html${synthetic ? '?synthetic=1' : ''}`, { waitUntil: 'domcontentloaded' });
  try { await page.waitForFunction(() => window.__ready, undefined, { timeout: 30000 }); }
  catch (error) { throw new Error(`${variant}: fixture failed to initialize; ${pageErrors.join('; ')}`, { cause: error }); }
  await page.evaluate(async () => { await window.__ready; });
  await frames(page);
  return page;
}
function nearPixel(actual, expected, label, tolerance = 2) {
  assert.equal(actual.length, 4, `${label}: RGBA sample exists`);
  for (let index = 0; index < 4; index++) assert.ok(Math.abs(actual[index] - expected[index]) <= tolerance,
    `${label}: channel ${index} expected ${expected[index]}, got ${actual[index]} (${actual})`);
}
async function syntheticChecks(dpr) {
  const page = await open('current', dpr, true);
  for (const opacity of [0, 0.44, 1]) {
    const value = await page.evaluate(opacity => synthetic({ opacity }), opacity);
    const expected = opacity === 0 ? [0, 0, 0, 0] : [0, 0, 149, Math.round(opacity * 255)];
    for (const key of ['first', 'overlap', 'second', 'coveredHole']) nearPixel(value[key], expected, `DPR${dpr} opacity${opacity} ${key}`);
    nearPixel(value.uncoveredHole, [0, 0, 0, 0], `DPR${dpr} opacity${opacity}: unfilled hole stays transparent`);
    checks.push({ type: 'synthetic-same-color', dpr, opacity, pixels: value });
  }
  const different = await page.evaluate(() => synthetic({ colors: ['#000095', '#d02d2d'] }));
  nearPixel(different.first, [0, 0, 149, 112], `DPR${dpr}: first record retains its color`);
  for (const key of ['overlap', 'second', 'coveredHole']) nearPixel(different[key], [208, 45, 45, 112], `DPR${dpr}: ${key} uses the last record color once`);
  checks.push({ type: 'synthetic-different-colors', dpr, pixels: different });
  const translucent = await page.evaluate(() => synthetic({ colors: ['rgba(0,0,149,.5)', 'rgba(0,0,149,.5)'] }));
  for (const key of ['first', 'overlap', 'second', 'coveredHole']) nearPixel(translucent[key], [0, 0, 149, 56], `DPR${dpr}: ${key} preserves custom CSS color alpha without stacking`);
  checks.push({ type: 'synthetic-css-alpha', dpr, pixels: translucent });
  const world = await page.evaluate(() => synthetic({ kind: 'world' }));
  for (const key of ['first', 'overlap', 'second', 'coveredHole']) nearPixel(world[key], [248, 250, 252, 214], `DPR${dpr}: ${key} world land opacity is applied once`);
  nearPixel(world.uncoveredHole, [0, 0, 0, 0], `DPR${dpr}: world hole stays transparent`);
  checks.push({ type: 'synthetic-world-union', dpr, pixels: world });
  await page.close();
}

async function realSamples(page) {
  return page.evaluate(ids => {
    const map = api.map, extent = 2 ** 24;
    const records = layer._sceneAt(map.getZoom()).activeRecords;
    const selected = ids.map(id => records.find(record => record.id === id));
    const paths = selected.map(record => new Path2D(record.d));
    const context = document.createElement('canvas').getContext('2d');
    const classify = (point, radius = 4) => paths.map(p => [[0, 0], [radius, 0], [-radius, 0], [0, radius], [0, -radius]].map(([dx, dy]) => {
      const latlng = map.containerPointToLatLng([point.x + dx, point.y + dy]);
      const projected = map.project(latlng, 0);
      const x = ((projected.x % 256) + 256) % 256 * extent / 256, y = projected.y * extent / 256;
      return [-1, 0, 1].some(shift => context.isPointInPath(p, x + shift * extent, y, 'evenodd'));
    }));
    const known = [[22.127485, 113.54909933074396], [22.196505, 113.53331771403492]].map((latlng, index) => {
      const point = map.latLngToContainerPoint(latlng);
      const inside = classify(point, 2);
      if (!inside.every(values => values.every(Boolean))) throw new Error(`Overlap ${index} lacks interior clearance`);
      return { name: `overlap-${index}`, lat: latlng[0], lng: latlng[1], x: point.x, y: point.y };
    });
    const results = [...known];
    for (const [name, signature] of [['zhuhai-only', [true, false]], ['macao-only', [false, true]]]) {
      let found;
      for (let y = 50; !found && y < map.getSize().y - 50; y += 3) for (let x = 50; !found && x < map.getSize().x - 50; x += 3) {
        const point = { x, y }, states = classify(point);
        if (!states.every((values, index) => values.every(value => value === signature[index]))) continue;
        const latlng = map.containerPointToLatLng(point);
        const hit = layer._hitRecord({ latlng });
        if (hit?.id !== ids[signature[0] ? 0 : 1]) continue;
        found = { name, lat: latlng.lat, lng: latlng.lng, x, y };
      }
      if (!found) throw new Error(`${name}: no stable interior sample found`);
      results.push(found);
    }
    return results;
  }, selectedIds);
}
async function pixels(page, samples) {
  return page.evaluate(samples => samples.map(sample => {
    const position = api.map.latLngToContainerPoint([sample.lat, sample.lng]);
    const mapRect = api.map.getContainer().getBoundingClientRect();
    const x = position.x + mapRect.left, y = position.y + mapRect.top;
    const values = [...document.querySelectorAll('#map canvas.leaflet-tile-loaded')].flatMap(tile => {
      const rect = tile.getBoundingClientRect();
      if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom || getComputedStyle(tile).visibility === 'hidden') return [];
      const px = Math.floor((x - rect.left) * tile.width / rect.width), py = Math.floor((y - rect.top) * tile.height / rect.height);
      return [Array.from(tile.getContext('2d').getImageData(px, py, 1, 1).data)];
    });
    if (!values.length) throw new Error(`${sample.name}: no visible tile covers sample`);
    return { name: sample.name, pixels: values };
  }), samples);
}
async function selection(page, ids) {
  await page.evaluate(async ids => { await api.setVisited(ids); }, ids);
  await frames(page);
}
async function realChecks(variant, dpr) {
  const page = await open(variant, dpr);
  const samples = await realSamples(page);
  const both = await pixels(page, samples);
  await page.screenshot({ path: path.join(output, `${variant}-zhuhai-macao-dpr${dpr}.png`) });
  const original = await page.evaluate(() => ({ codeword: api.getCodeword(), tiles: Object.values(layer._tiles).map(tile => { tile.el.__identity = crypto.randomUUID(); return tile.el.__identity; }) }));
  await selection(page, [selectedIds[0]]);
  const zhuhai = await pixels(page, samples);
  await selection(page, [selectedIds[1]]);
  const macao = await pixels(page, samples);
  await selection(page, []);
  const neutral = await pixels(page, samples);
  for (const index of [0, 1]) {
    if (variant === 'baseline') {
      assert.ok(both[index].pixels[0][0] + 20 < zhuhai[index].pixels[0][0], `DPR${dpr}: baseline overlaps are visibly darker`);
      assert.ok(neutral[index].pixels[0][3] > 240, `DPR${dpr}: baseline world overlap also stacks opacity`);
    } else {
      for (const actual of both[index].pixels) {
        nearPixel(actual, zhuhai[index].pixels[0], `DPR${dpr} ${samples[index].name}: two selected records match one Zhuhai fill`);
        nearPixel(actual, macao[index].pixels[0], `DPR${dpr} ${samples[index].name}: two selected records match one Macao fill`);
      }
      nearPixel(neutral[index].pixels[0], [248, 250, 252, 214], `DPR${dpr} ${samples[index].name}: overlapping world fill is neutral once`);
    }
  }
  if (variant === 'current') for (const index of [2, 3]) for (const value of both[index].pixels) {
    nearPixel(value, both[0].pixels[0], `DPR${dpr} ${samples[index].name}: isolated and overlapping land share one fill opacity`);
  }
  checks.push({ type: 'real-geometry', variant, dpr, samples, both, zhuhai, macao, neutral });
  if (variant === 'current') {
    await selection(page, selectedIds);
    assert.deepEqual(await page.evaluate(() => Object.values(layer._tiles).map(tile => tile.el.__identity)), original.tiles, `DPR${dpr}: selection repaints preserve native tile ownership`);
    assert.equal(await page.evaluate(() => api.getCodeword()), original.codeword, `DPR${dpr}: selection round trip preserves visit bits`);
    await selection(page, [selectedIds[0]]);
    assert.deepEqual(await page.evaluate(() => api.getVisited()), [selectedIds[0]], `DPR${dpr}: programmatic update removes Macao alone`);
    await page.evaluate(async () => { await api.reset(); });
    await frames(page);
    assert.deepEqual(await page.evaluate(() => api.getVisited()), selectedIds, `DPR${dpr}: reset restores canonical visits`);
    for (const zoom of [11.5, 12]) {
      await page.evaluate(zoom => api.map.setView([22.18, 113.53], zoom, { animate: false }), zoom);
      await frames(page);
      const result = await pixels(page, samples);
      for (const index of [0, 1]) for (const value of result[index].pixels) nearPixel(value, both[index].pixels[0], `DPR${dpr} zoom${zoom}: overlap retains uniform fill`);
      checks.push({ type: 'fractional-zoom', dpr, zoom, pixels: result });
    }
    await page.evaluate(() => { api.map.setView([22.18, 833.53], 12, { animate: false }); layer.refresh(); });
    await frames(page);
    const wrapped = await pixels(page, samples.map(sample => ({ ...sample, lng: sample.lng + 720 })));
    for (const index of [0, 1]) for (const value of wrapped[index].pixels) nearPixel(value, both[index].pixels[0], `DPR${dpr}: wrapped world copy retains uniform fill`);
    checks.push({ type: 'wrapped-world', dpr, pixels: wrapped });
    await page.evaluate(async () => { await api.reset(); });
    await frames(page);
    assert.equal(await page.evaluate(() => api.getCodeword()), original.codeword, `DPR${dpr}: reset after wrapped view retains visit bits`);
    assert.deepEqual(await page.evaluate(() => [api.map.getCenter().lat, api.map.getCenter().lng, api.map.getZoom()]), [22.18, 113.53, 12], `DPR${dpr}: reset restores original view`);
  }
  assert.deepEqual(await page.evaluate(() => window.__errors), [], `${variant} DPR${dpr}: no renderer errors`);
  await page.close();
}
try {
  for (const dpr of [1, 2]) {
    await realChecks('baseline', dpr);
    await syntheticChecks(dpr);
    await realChecks('current', dpr);
  }
  assert.deepEqual(pageErrors, [], 'No uncaught browser errors');
  await writeFile(path.join(output, 'fills-test.json'), JSON.stringify({ baselineRef, checks, pageErrors }, null, 2) + '\n');
  console.log(JSON.stringify({ output, checks: checks.length, result: 'passed' }));
} finally {
  await Promise.allSettled(contexts.map(context => context.close()));
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  await rm(baselineRoot, { recursive: true, force: true });
}
