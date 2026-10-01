import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutlineDetail } from '../src/outline-detail.js';

const extent = 2 ** 24;
const bounds = [[13_500_000, 5_500_000, 14_000_000, 6_500_000], [2_000_000, 5_500_000, 3_000_000, 6_500_000]];
const manifest = { version: 'fixture', extent, fingerprint: [1, 2], outlines: { minZoom: 4, detailZoom: 6, countries: {
  USA: { file: 'USA.json', bounds: [2_000_000, 5_500_000, 14_000_000, 6_500_000], parts: bounds, regionIds: [],
    fragments: bounds.map((bounds, id) => ({ id, file: `USA/${id}.json`, bounds })) },
} } };
function payload(fragment) {
  return { format: 1, version: manifest.version, extent, fingerprint: manifest.fingerprint, fragment,
    features: [{ id: 'USA:ADM0:USA', countryCode: 'USA', bounds: bounds[fragment], strokeWidths: [null],
      d: `M${fragment * 100} 0l10 0l0 10l-10 -10z` }] };
}
function makeMap() {
  let west = 110, east = 116, zoom = 8;
  const handlers = new Map();
  return {
    getZoom: () => zoom,
    getBounds: () => ({ getSouthWest: () => ({ lat: 10, lng: west }), getNorthEast: () => ({ lat: 30, lng: east }) }),
    project: ({ lat, lng }) => ({ x: (lng + 180) * 256 / 360, y: (90 - lat) * 256 / 180 }),
    setView: (w, e, z = zoom) => { west = w; east = e; zoom = z; },
    on: (event, fn) => handlers.set(event, fn), off: event => handlers.delete(event),
  };
}
async function fixture(callback) {
  const original = globalThis.fetch;
  const requests = [];
  const files = { '0.json': payload(0), '1.json': payload(1) };
  globalThis.fetch = async (url, options) => {
    const file = String(url).split('/').pop(); requests.push({ file, signal: options.signal });
    const value = typeof files[file] === 'function' ? await files[file]() : files[file];
    if (value instanceof Error) throw value;
    return new Response(JSON.stringify(value));
  };
  const map = makeMap(); const loader = createOutlineDetail({ map, manifest, dataUrl: '/fixture/' });
  try { await callback({ map, loader, files, requests }); }
  finally { loader.destroy(); globalThis.fetch = original; }
}

test('loads only visible whole polygons and checks current pan coverage before moveend', async () => {
  await fixture(async ({ map, loader, requests }) => {
    const [first] = await loader.load();
    assert.deepEqual(requests.map(request => request.file), ['0.json']);
    assert.equal(first.d, payload(0).features[0].d);
    map.setView(-135, -115);
    assert.equal(loader.get('USA'), null, 'uncached component uses whole-country coarse fallback immediately');
    const [both] = await loader.load();
    assert.notEqual(both, first, 'new geometry creates a new immutable renderer record');
    assert.equal(first.d, payload(0).features[0].d, 'an existing renderer path is never mutated');
    assert.equal(both.d, `${first.d} ${payload(1).features[0].d}`);
    assert.deepEqual(both.parts, bounds);
    assert.deepEqual(both.strokeWidths, [null, null]);
    map.setView(110, 116, 4);
    assert.equal(loader.get('USA'), both, 'exact fragment coverage can be reused at the overview tier');
    await loader.load();
    assert.equal(requests.length, 2);
    assert.equal(loader.get('USA', 3), null);
    map.setView(830, 836);
    assert.equal(loader.get('USA'), both, 'coverage supports repeated wrapped worlds');
  });
});

test('a tile buffer completes visible countries without activating offscreen countries', async () => {
  await fixture(async ({ map, loader, requests }) => {
    map.setView(102, 105, 4);
    assert.deepEqual(await loader.load(), []);
    assert.deepEqual(requests, [], 'nearby offscreen USA parts do not delay the mobile viewport');
    map.setView(110, 116, 4);
    assert.equal((await loader.load())[0].countryCode, 'USA');
    assert.deepEqual(requests.map(request => request.file), ['0.json']);
  });
});

test('missing or failed fragments keep the complete coarse fallback and can retry', async () => {
  await fixture(async ({ map, loader, files, requests }) => {
    const [first] = await loader.load();
    map.setView(-135, 116);
    let finish;
    files['1.json'] = () => new Promise(resolve => { finish = resolve; });
    const waiting = loader.load();
    assert.equal(loader.get('USA'), null, 'one cached fragment never hides a missing visible component');
    finish(new Error('fragment unavailable'));
    await assert.rejects(waiting, /fragment unavailable/);
    assert.equal(loader.get('USA'), null);
    map.setView(110, 116);
    assert.equal(loader.get('USA'), first, 'cached narrower view remains available after failure');
    map.setView(-135, 116);
    files['1.json'] = payload(1);
    const [complete] = await loader.load();
    assert.equal(loader.get('USA'), complete);
    assert.deepEqual(requests.map(request => request.file), ['0.json', '1.json', '1.json']);
  });
});

test('required focal-country fragments share download slots and publish only complete coverage', async () => {
  await fixture(async ({ map, loader, files, requests }) => {
    map.setView(-135, 116);
    const finish = [];
    for (const id of [0, 1]) files[`${id}.json`] = () => new Promise(resolve => { finish[id] = resolve; });
    const waiting = loader.load();
    assert.deepEqual(requests.map(request => request.file), ['0.json', '1.json'], 'one held part does not serialize the same focal country');
    finish[1](payload(1)); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(loader.get('USA'), null, 'finishing one part cannot hide the unfinished part');
    finish[0](payload(0));
    const records = await waiting;
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].parts, bounds);
  });
});

test('rejects fragment identity and spatial-index mismatches without caching', async () => {
  for (const corrupt of [data => { data.fragment = 1; }, data => { data.features[0].bounds = bounds[1]; }]) {
    await fixture(async ({ loader, files, requests }) => {
      const invalid = payload(0); corrupt(invalid); files['0.json'] = invalid;
      await assert.rejects(loader.load(), /invalid detailed outline fragment/);
      assert.equal(loader.get('USA'), null);
      files['0.json'] = payload(0);
      assert.equal((await loader.load())[0].d, payload(0).features[0].d);
      assert.equal(requests.length, 2);
    });
  }
});

test('destroy settles an ignored-abort fragment fetch and rejects its late cache insertion', async () => {
  await fixture(async ({ loader, files, requests }) => {
    let finish; files['0.json'] = () => new Promise(resolve => { finish = resolve; });
    const waiting = loader.load(); loader.destroy();
    await assert.rejects(waiting, /destroyed/);
    assert.equal(requests[0].signal.aborted, true);
    finish(payload(0)); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(loader.get('USA'), null);
  });
});
