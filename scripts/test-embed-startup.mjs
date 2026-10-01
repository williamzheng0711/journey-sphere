#!/usr/bin/env node

// Cross-origin startup contracts that a modulepreload/fetch preload must retain.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mime = { js: 'text/javascript', json: 'application/json', css: 'text/css' };
const worldRequests = [];
const heldResponses = new Set();
let holdWorld = false;
const dataServer = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const file = pathname.startsWith('/custom/') ? `data/${pathname.slice('/custom/'.length)}` : pathname.slice(1);
  try {
    if (!file || file.split('/').includes('..')) throw new Error('Invalid asset path');
    const body = await readFile(path.join(root, file));
    const world = pathname.endsWith('/embed/world.json');
    if (world) worldRequests.push({ path: pathname, cookie: request.headers.cookie });
    const send = () => {
      heldResponses.delete(send);
      if (response.destroyed) return;
      response.writeHead(200, { 'Content-Type': mime[file.split('.').pop()] || 'application/octet-stream',
        'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      response.end(body);
    };
    if (world && holdWorld) heldResponses.add(send);
    else send();
  } catch { response.writeHead(404); response.end(); }
});
let fixture = '';
const pageServer = createServer((request, response) => {
  if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(fixture);
});
await Promise.all([dataServer, pageServer].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
const dataOrigin = `http://127.0.0.1:${dataServer.address().port}`;
const pageOrigin = `http://127.0.0.1:${pageServer.address().port}`;
const browser = await chromium.launch({ headless: true,
  ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
});
const contexts = [];
function markup(elements) {
  return `<!doctype html><meta charset="utf-8"><style>journey-sphere{display:block;width:800px;--journey-sphere-height:450px}</style>
    ${elements}<script type="module" src="${dataOrigin}/embed.js"></script>`;
}
async function open(elements) {
  worldRequests.length = 0;
  fixture = markup(elements);
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  contexts.push(context);
  // Cookies are shared between localhost ports. Cross-origin world requests
  // still omit them, matching fetch's default same-origin credentials.
  await context.addCookies([{ name: 'credential-probe', value: 'present', url: dataOrigin }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await page.goto(pageOrigin, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!customElements.get('journey-sphere'));
  return { context, page, errors };
}
async function ready(page) {
  await page.waitForFunction(() => [...document.querySelectorAll('journey-sphere')].every(element => element.journey));
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('journey-sphere')]
    .map(element => element.journey.getVisited())), [['SGP:ADM0:SGP']]);
}

try {
  const single = await open(`<journey-sphere places='["Singapore"]'></journey-sphere>`);
  await ready(single.page);
  assert.equal(worldRequests.length, 1, 'the cross-origin default fetch consumes the preload without another download');
  assert.equal(worldRequests[0].cookie, undefined, 'preload uses the same credentials as the cross-origin fetch');
  assert.deepEqual(single.errors, []);
  await single.context.close();

  const custom = await open(`<journey-sphere places='["Singapore"]' data-base-url="${dataOrigin}/custom/embed/"></journey-sphere>`);
  await ready(custom.page);
  assert.deepEqual(worldRequests.map(request => request.path), ['/custom/embed/world.json'], 'custom-only maps skip the bundled world preload');
  assert.equal(await custom.page.evaluate(() => document.head.querySelectorAll('link[rel="preload"][as="fetch"]').length), 0);
  assert.deepEqual(custom.errors, []);
  await custom.context.close();

  const multiple = await open(`<journey-sphere places='["Singapore"]'></journey-sphere>
    <journey-sphere places='["Singapore"]'></journey-sphere>
    <journey-sphere places='["Singapore"]' data-base-url="${dataOrigin}/custom/embed/"></journey-sphere>`);
  await multiple.page.waitForFunction(() => [...document.querySelectorAll('journey-sphere')].every(element => element.journey));
  assert.equal(await multiple.page.evaluate(() => document.head.querySelectorAll('link[rel="preload"][as="fetch"]').length), 1);
  // With no-store, each element retains its own cancelable overview request;
  // one default fetch consumes the preload and the other starts normally.
  assert.deepEqual(worldRequests.map(request => request.path).sort(),
    ['/custom/embed/world.json', '/data/embed/world.json', '/data/embed/world.json'],
    'the preload adds no download beyond the three elements own overview requests');
  assert.deepEqual(multiple.errors, []);
  await multiple.context.close();

  holdWorld = true;
  const disconnected = await open(`<journey-sphere places='["Singapore"]'></journey-sphere>`);
  await disconnected.page.waitForFunction(() => !!document.querySelector('journey-sphere')._overview);
  await disconnected.page.evaluate(() => {
    window.element = document.querySelector('journey-sphere');
    window.element.remove();
  });
  assert.equal(await disconnected.page.evaluate(() => window.element.ready), null, 'disconnect settles the abandoned initialization');
  holdWorld = false;
  for (const send of [...heldResponses]) send();
  await disconnected.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await disconnected.page.evaluate(() => window.element.journey), null);
  assert.equal(await disconnected.page.evaluate(() => window.element.shadowRoot.querySelectorAll('canvas').length), 0);
  await disconnected.page.evaluate(() => document.body.append(window.element));
  await ready(disconnected.page);
  assert.deepEqual(disconnected.errors, [], 'aborted initialization cannot produce an unhandled error or stale map');
  await disconnected.context.close();
  console.log('PASS cross-origin world preload reuse, credentials, custom data, multiple maps and pending disconnect/reconnect');
} finally {
  holdWorld = false;
  for (const send of [...heldResponses]) send();
  await Promise.allSettled(contexts.map(context => context.close()));
  await browser.close();
  await Promise.all([dataServer, pageServer].map(server => new Promise(resolve => server.close(resolve))));
}
