import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createOutlineDetail } from '../src/outline-detail.js';

const manifest = {
  version: 'fixture', extent: 2 ** 24, fingerprint: [1, 2],
  outlines: { minZoom: 6, countries: {
    HKG: { file: 'HKG.json', bounds: [13_500_000, 5_500_000, 14_000_000, 6_500_000], regionIds: ['HKG:ADM0:HKG'] },
    CHN: { file: 'CHN.json', bounds: [12_000_000, 4_000_000, 15_000_000, 7_000_000], regionIds: [] },
    FAR: { file: 'FAR.json', bounds: [100, 100, 200, 200], regionIds: [] },
  } },
};
function map({ zoom = 8, west = 110, east = 116 } = {}) {
  const handlers = new Map();
  return {
    getZoom: () => zoom,
    getBounds: () => ({ getSouthWest: () => ({ lat: 10, lng: west }), getNorthEast: () => ({ lat: 30, lng: east }) }),
    project: ({ lat, lng }) => ({ x: (lng + 180) * 256 / 360, y: (90 - lat) * 256 / 180 }),
    on: (event, handler) => handlers.set(event, handler), off: (event, handler) => { if (handlers.get(event) === handler) handlers.delete(event); },
    emit: event => handlers.get(event)?.(), setZoom: value => { zoom = value; },
  };
}
function payload(code) { return { format: 1, version: 'fixture', extent: 2 ** 24, fingerprint: [1, 2], features: [{ id: `${code}:ADM0:${code}`, countryCode: code, d: 'M0 0l1 0l0 1l-1 -1z', bounds: [1, 2, 3, 4] }] }; }
async function withFetch(files, fn) {
  const old = globalThis.fetch; const calls = [];
  globalThis.fetch = async url => { calls.push(String(url)); const key = String(url).split('/').pop(); const value = files[key]; return value instanceof Error ? Promise.reject(value) : new Response(JSON.stringify(value), { status: value ? 200 : 404 }); };
  try { return await fn(calls); } finally { globalThis.fetch = old; }
}

test('loads only intersecting detail, sorts small bounds first, and deduplicates', async () => {
  await withFetch({ 'HKG.json': payload('HKG'), 'CHN.json': payload('CHN') }, async calls => {
    const changes = []; const controller = createOutlineDetail({ map: map(), manifest, dataUrl: '/fixture/', onChange: record => changes.push(record) });
    const records = await controller.load();
    assert.deepEqual(records.map(record => record.countryCode), ['HKG', 'CHN']);
    await Promise.all([controller.load(), controller.load()]);
    assert.equal(calls.filter(url => url.endsWith('/HKG.json')).length, 1);
    assert.equal(changes.length, 2); controller.destroy();
  });
});

test('disjoint island bounds exclude empty space and support wrapped components', async () => {
  const extent = 2 ** 24;
  const countries = {
    HKG: manifest.outlines.countries.HKG,
    FAR: { file: 'FAR.json', bounds: [0, 0, extent, extent], parts: [
      [100, 100, 200, 200], [extent - 200, extent - 200, extent - 100, extent - 100],
    ] },
    WRAP: { file: 'WRAP.json', bounds: [0, 0, 3 * extent, extent], parts: [
      [13_500_000 + 2 * extent, 5_500_000, 14_000_000 + 2 * extent, 6_500_000],
    ] },
  };
  await withFetch({ 'HKG.json': payload('HKG'), 'WRAP.json': payload('WRAP') }, async calls => {
    const controller = createOutlineDetail({ map: map(), manifest: { ...manifest, outlines: { minZoom: 6, countries } }, dataUrl: '/fixture/' });
    assert.deepEqual((await controller.load()).map(record => record.countryCode), ['HKG', 'WRAP']);
    assert.equal(calls.some(url => url.endsWith('FAR.json')), false, 'empty space between distant islands does not trigger a download');
    controller.destroy();
  });
});

test('does not fetch below threshold and retries malformed failures', async () => {
  const low = map({ zoom: 5 });
  await withFetch({ 'HKG.json': payload('HKG') }, async calls => {
    const controller = createOutlineDetail({ map: low, manifest, dataUrl: '/fixture/' });
    assert.deepEqual(await controller.load(), []); assert.equal(calls.length, 0); controller.destroy();
  });
  let bad = true;
  await withFetch({ 'HKG.json': () => {} }, async calls => {
    globalThis.fetch = async url => { calls.push(String(url)); return new Response(JSON.stringify(bad ? { ...payload('CHN') } : payload('HKG'))); };
    const controller = createOutlineDetail({ map: map(), manifest, dataUrl: '/fixture/' });
    await assert.rejects(controller.load(), /invalid detailed outline/);
    bad = false; assert.equal((await controller.load())[0].countryCode, 'HKG'); controller.destroy();
  });
});

test('aborts stale viewport requests and never inserts after destroy', async () => {
  let resolve;
  await withFetch({}, async () => {
    globalThis.fetch = async () => new Promise((res, rej) => { resolve = () => res(new Response(JSON.stringify(payload('HKG')))); });
    const m = map(); const controller = createOutlineDetail({ map: m, manifest: { ...manifest, outlines: { ...manifest.outlines, countries: { HKG: manifest.outlines.countries.HKG } } }, dataUrl: '/fixture/' });
    const request = controller.load(); controller.destroy(); resolve(); await assert.rejects(request, /destroyed|aborted/i); assert.equal(controller.get('HKG', 8), null);
  });
});

test('caps fetch concurrency and deduplicates queued codes', async () => {
  const countries = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`C${i}`, { file: `C${i}.json`, bounds: [13_500_000, 5_500_000, 14_000_000, 6_500_000] }]));
  const localManifest = { ...manifest, outlines: { ...manifest.outlines, countries } };
  const pending = []; let active = 0; let maximum = 0; const old = globalThis.fetch;
  globalThis.fetch = async () => { active += 1; maximum = Math.max(maximum, active); return new Promise(resolve => pending.push(() => { active -= 1; resolve(new Response(JSON.stringify(payload('C0')))); })); };
  try {
    const controller = createOutlineDetail({ map: map(), manifest: localManifest, dataUrl: '/fixture/' });
    const first = controller.load(); const second = controller.load();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(pending.length, 3); assert.equal(maximum, 3);
    while (pending.length) pending.shift()();
    await Promise.allSettled([first, second]);
    assert.equal(maximum, 3); controller.destroy();
  } finally { globalThis.fetch = old; }
});

test('honors already-aborted signals and accepts outlines beyond one wrapped world', async () => {
  let requests = 0; const old = globalThis.fetch; globalThis.fetch = async () => { requests += 1; return new Response(JSON.stringify(payload('HKG'))); };
  try {
    const signalController = new AbortController(); signalController.abort(new Error('already stopped'));
    const stopped = createOutlineDetail({ map: map(), manifest, dataUrl: '/fixture/', signal: signalController.signal });
    await assert.rejects(stopped.load(), /already stopped/); assert.equal(requests, 0);
    const wrappedManifest = { ...manifest, outlines: { ...manifest.outlines, countries: {
      HKG: { ...manifest.outlines.countries.HKG, bounds: [13_500_000 + 2 * 2 ** 24, 5_500_000, 14_000_000 + 2 * 2 ** 24, 6_500_000] },
    } } };
    const controller = createOutlineDetail({ map: map(), manifest: wrappedManifest, dataUrl: '/fixture/' });
    assert.equal((await controller.load()).length, 1); controller.destroy();
  } finally { globalThis.fetch = old; }
});

test('keeps a 32-entry LRU and removes malformed path syntax', async () => {
  const countries = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`C${i}`, { file: `C${i}.json`, bounds: [13_500_000, 5_500_000, 14_000_000, 6_500_000] }]));
  const localManifest = { ...manifest, outlines: { ...manifest.outlines, countries } };
  const old = globalThis.fetch; globalThis.fetch = async url => new Response(JSON.stringify(payload(String(url).split('/').pop().slice(0, -5))));
  try {
    const controller = createOutlineDetail({ map: map(), manifest: localManifest, dataUrl: '/fixture/' });
    await controller.load(); assert.equal(controller.get('C0', 8), null); assert.ok(controller.get('C32', 8)); controller.destroy();
  } finally { globalThis.fetch = old; }
  await withFetch({ 'HKG.json': { ...payload('HKG'), features: [{ ...payload('HKG').features[0], d: 'Mgarbage1' }] } }, async () => {
    const onlyHkg = { ...manifest, outlines: { ...manifest.outlines, countries: { HKG: manifest.outlines.countries.HKG } } };
    const controller = createOutlineDetail({ map: map(), manifest: onlyHkg, dataUrl: '/fixture/' });
    await assert.rejects(controller.load(), /invalid detailed outline/); controller.destroy();
  });
});

test('settles canceled load immediately when fetch ignores abort and never caches late data', async () => {
  let resolveFetch; const old = globalThis.fetch;
  globalThis.fetch = async () => new Promise(resolve => { resolveFetch = resolve; });
  try {
    const controller = createOutlineDetail({ map: map(), manifest: { ...manifest, outlines: { ...manifest.outlines, countries: { HKG: manifest.outlines.countries.HKG } } }, dataUrl: '/fixture/' });
    const request = controller.load(); controller.destroy(); await assert.rejects(request, /destroyed|aborted/i);
    resolveFetch(new Response(JSON.stringify(payload('HKG')))); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(controller.get('HKG', 8), null);
  } finally { globalThis.fetch = old; }
});

test('zooming out cancels detail without reporting an obsolete error', async () => {
  let resolveFetch; let errors = 0; const old = globalThis.fetch;
  globalThis.fetch = async () => new Promise(resolve => { resolveFetch = resolve; });
  try {
    const m = map(); const onlyHkg = { ...manifest, outlines: { ...manifest.outlines, countries: { HKG: manifest.outlines.countries.HKG } } };
    const controller = createOutlineDetail({ map: m, manifest: onlyHkg, dataUrl: '/fixture/', onError: () => { errors += 1; } });
    const request = controller.load(); m.setZoom(5); m.emit('zoomend'); await new Promise(resolve => setTimeout(resolve, 70));
    await assert.rejects(request, /no longer visible/); assert.equal(errors, 0); resolveFetch(new Response(JSON.stringify(payload('HKG')))); controller.destroy();
  } finally { globalThis.fetch = old; }
});

test('pan cancellation can retry successfully after the obsolete fetch finishes', async () => {
  const responses = []; const old = globalThis.fetch;
  globalThis.fetch = async () => new Promise(resolve => responses.push(resolve));
  try {
    const m = map(); const onlyHkg = { ...manifest, outlines: { ...manifest.outlines, countries: { HKG: manifest.outlines.countries.HKG } } };
    const controller = createOutlineDetail({ map: m, manifest: onlyHkg, dataUrl: '/fixture/' });
    const first = controller.load(); m.getBounds = () => ({ getSouthWest: () => ({ lat: -10, lng: -20 }), getNorthEast: () => ({ lat: -5, lng: -10 }) }); m.emit('moveend');
    await new Promise(resolve => setTimeout(resolve, 70)); await assert.rejects(first, /no longer visible/);
    responses.shift()(new Response(JSON.stringify(payload('HKG'))));
    m.getBounds = () => ({ getSouthWest: () => ({ lat: 10, lng: 110 }), getNorthEast: () => ({ lat: 30, lng: 116 }) });
    const second = controller.load(); await new Promise(resolve => setTimeout(resolve, 0)); responses.shift()(new Response(JSON.stringify(payload('HKG'))));
    assert.equal((await second)[0].countryCode, 'HKG'); controller.destroy();
  } finally { globalThis.fetch = old; }
});

test('rejects invalid command arity and ordering in outline paths', async () => {
  for (const d of ['M1 2 3z', 'M1 2l3z', 'M!1 2l3 0l0 1l-3 -1z', 'M1 2l3 0l0 1l-3 -1z garbage']) {
    await withFetch({ 'HKG.json': { ...payload('HKG'), features: [{ ...payload('HKG').features[0], d }] } }, async () => {
      const onlyHkg = { ...manifest, outlines: { ...manifest.outlines, countries: { HKG: manifest.outlines.countries.HKG } } };
      const controller = createOutlineDetail({ map: map(), manifest: onlyHkg, dataUrl: '/fixture/' });
      await assert.rejects(controller.load(), /invalid detailed outline/); controller.destroy();
    });
  }
});


test('rejects malformed ring-width metadata without caching it', async () => {
  const onlyHkg = { ...manifest, outlines: { ...manifest.outlines, countries: { HKG: manifest.outlines.countries.HKG } } };
  for (const strokeWidths of [[], [null, 5], [-1], [0.5], ['wide']]) {
    const invalid = payload('HKG'); invalid.features[0].strokeWidths = strokeWidths;
    await withFetch({ 'HKG.json': invalid }, async () => {
      const controller = createOutlineDetail({ map: map(), manifest: onlyHkg, dataUrl: '/fixture/' });
      await assert.rejects(controller.load(), /invalid detailed outline/);
      assert.equal(controller.get('HKG', 8), null);
      controller.destroy();
    });
  }
});

test('all shipped country outlines pass the real loader including its largest paths', async () => {
  const dataUrl = new URL('../data/', import.meta.url);
  const actualManifest = JSON.parse(await readFile(new URL('compiled/manifest.json', dataUrl), 'utf8'));
  const oldFetch = globalThis.fetch;
  const worldMap = map({ zoom: 6, west: -180, east: 180 });
  worldMap.getBounds = () => ({
    getSouthWest: () => ({ lat: -90, lng: -180 }),
    getNorthEast: () => ({ lat: 90, lng: 180 }),
  });
  globalThis.fetch = async url => new Response(await readFile(url, 'utf8'));
  const controller = createOutlineDetail({ map: worldMap, manifest: actualManifest, dataUrl });
  try {
    const records = await controller.load();
    assert.deepEqual(records.map(record => record.countryCode).sort(), Object.keys(actualManifest.countries).sort());
    assert.equal(records.length, 259);
  } finally {
    controller.destroy();
    globalThis.fetch = oldFetch;
  }
});
