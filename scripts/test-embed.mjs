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
const mime = { html: 'text/html', js: 'text/javascript', json: 'application/json', css: 'text/css' };

function serve({ cors = false } = {}) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname.replace(/^\//, '') || 'examples/embed.html';
      if (!pathname || pathname.includes('..')) throw new Error('invalid path');
      const body = await readFile(path.join(root, pathname));
      response.writeHead(200, {
        'Content-Type': mime[pathname.split('.').pop()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        ...(cors ? { 'Access-Control-Allow-Origin': '*' } : {}),
      });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  return server;
}

let fixture;
const pageServer = createServer((request, response) => {
  if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
  if (request.url !== '/fixture.html') { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(fixture);
});
const dataServer = serve({ cors: true });
await Promise.all([
  new Promise(resolve => pageServer.listen(0, '127.0.0.1', resolve)),
  new Promise(resolve => dataServer.listen(0, '127.0.0.1', resolve)),
]);
const pageOrigin = `http://127.0.0.1:${pageServer.address().port}`;
const dataOrigin = `http://127.0.0.1:${dataServer.address().port}`;
const browser = await chromium.launch({ headless: true,
  ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
});

try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error('PAGE',error.stack || error.message); });
  page.on('response', response => { if(response.status()>=400)console.error(response.status(),response.url()); });
  page.on('requestfailed', request => console.error('FAILED',request.url(),request.failure()));
  page.on('console', message => { if (message.type() === 'error') {errors.push(message.text()); console.error('CONSOLE',message.text());} });
  const dataRequests = [];
  page.on('request', request => { if (request.url().startsWith(dataOrigin)) dataRequests.push(new URL(request.url()).pathname); });
  fixture = `<!doctype html><meta charset="utf-8"><style>journey-sphere{display:block;width:900px;height:580px}</style>
    <journey-sphere></journey-sphere>
    <journey-sphere places='["Singapore"]'></journey-sphere>
    <script type="module" src="${dataOrigin}/embed.js"></script>`;
  await page.goto(`${pageOrigin}/fixture.html`, { waitUntil: 'domcontentloaded', timeout: 10000 });
  await page.waitForFunction(() => !!customElements.get('journey-sphere'),null,{timeout:10000});
  await page.waitForFunction(() => document.querySelector('journey-sphere')._overview !== null);
  assert.equal(await page.evaluate(() => document.querySelector('journey-sphere').journey), null);
  await page.evaluate(() => { document.querySelector('journey-sphere').places = ['上海', '香港']; });
  await page.evaluate(() => Promise.race([
    Promise.all([...document.querySelectorAll('journey-sphere')].map(element => element.ready)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('embed ready timeout')), 10000)),
  ]));
  await page.waitForFunction(() => [...document.querySelectorAll('journey-sphere')].every(element => element.shadowRoot?.querySelector('canvas')));
  assert.deepEqual(await page.evaluate(() => document.querySelector('journey-sphere').journey.getVisited()), ['CHN:ADM2:310000', 'HKG:ADM0:HKG']);
  assert.deepEqual(await page.evaluate(() => document.querySelectorAll('journey-sphere')[1].journey.getVisited()), ['SGP:ADM0:SGP']);
  assert.ok(dataRequests.some(pathname => pathname.endsWith('/embed/world.json')));
  assert.equal(dataRequests.some(pathname => pathname.includes('/embed/names/')), false, 'common names need no extra lookup request');
  assert.ok(dataRequests.some(pathname => pathname.includes('/embed/groups/')));
  assert.equal(dataRequests.some(pathname => pathname.includes('/compiled/countries/')), false);
  const overviewRequests = dataRequests.filter(pathname => pathname.endsWith('/embed/world.json')).length;
  await page.evaluate(() => { document.querySelectorAll('journey-sphere')[0].places = ['上海']; });
  await page.evaluate(() => document.querySelector('journey-sphere').ready);
  assert.deepEqual(await page.evaluate(() => document.querySelector('journey-sphere').journey.getVisited()), ['CHN:ADM2:310000']);
  assert.equal(dataRequests.filter(pathname => pathname.endsWith('/embed/world.json')).length, overviewRequests,
    'changing places reuses prefetched world context');
  await page.evaluate(() => {
    window.second = document.querySelectorAll('journey-sphere')[1];
    window.second.remove();
  });
  assert.equal(await page.evaluate(() => window.second.journey), null);
  assert.equal(await page.evaluate(() => window.second.shadowRoot.querySelectorAll('canvas').length), 0);
  await page.evaluate(() => document.body.append(window.second));
  await page.evaluate(() => window.second.ready);
  assert.deepEqual(await page.evaluate(() => window.second.journey.getVisited()), ['SGP:ADM0:SGP']);
  const unknown = await page.evaluate(async () => {
    const element = document.querySelector('journey-sphere');
    window.embedErrors = [];
    element.addEventListener('journey-error', event => window.embedErrors.push(event.detail.message));
    element.places = ['Definitely not a real place'];
    try { await element.ready; return ''; } catch (error) { return error.message; }
  });
  assert.match(unknown, /Unknown place/);
  assert.match(await page.locator('journey-sphere').first().locator('.message').textContent(), /Unknown place/);
  assert.equal(await page.evaluate(() => window.embedErrors.length), 1);
  await page.evaluate(() => { const el = document.querySelector('journey-sphere'); el.places = ['上海']; });
  await page.evaluate(() => document.querySelector('journey-sphere').ready);
  assert.equal(await page.evaluate(() => document.querySelector('journey-sphere').journey.map.getBounds().contains([31.1,121.4])), true, 'default view must show the supplied place');
  const initialZoom = await page.evaluate(() => document.querySelector('journey-sphere').journey.map.getZoom());
  await page.locator('journey-sphere').first().locator('.leaflet-control-zoom-in').click();
  await page.waitForFunction(zoom => document.querySelector('journey-sphere').journey.map.getZoom() > zoom && !document.querySelector('journey-sphere').journey.map._animatingZoom, initialZoom);
  await page.evaluate(() => document.querySelector('journey-sphere').reset());
  await page.waitForFunction(zoom => document.querySelector('journey-sphere').journey.map.getZoom() === zoom, initialZoom);
  await page.evaluate(url => { window.second.setAttribute('data-base-url', url); }, `${dataOrigin}/data/embed`);
  await page.evaluate(() => window.second.ready);
  assert.deepEqual(await page.evaluate(() => window.second.journey.getVisited()), ['SGP:ADM0:SGP']);
  await page.screenshot({path: '/tmp/journeysphere-embed.png'});
  assert.deepEqual(errors, []);
  console.log('PASS cross-origin single-script embed with selected chunks and no consumer map files');
} finally {
  await browser.close();
  pageServer.close();
  dataServer.close();
}
