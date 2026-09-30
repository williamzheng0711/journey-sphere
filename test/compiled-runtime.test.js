import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompiledJourneySphere, loadCompiledAtlas } from '../src/compiled.js';
import { describeCatalog, encodeVisitedIndices } from '../src/state.js';

const manifest = {
  format: 1, version: 'fixture', extent: 2 ** 24, regionCount: 2, fingerprint: [0, 0],
  worldFile: 'world.json', catalogFile: '../catalog.json',
  countries: {
    AAA: { file: 'countries/AAA.json', start: 0, count: 1, color: '#123456' },
    BBB: { file: 'countries/BBB.json', start: 1, count: 1, color: '#654321' },
  },
};
// describeCatalog's fingerprint is only needed for manifest validation; use a
// fixture manifest with the real value produced by the state helper.
const catalog = { version: 'fixture', regionIds: ['AAA:r1', 'BBB:r1'] };
manifest.fingerprint = describeCatalog(catalog).fingerprint;
const payload = (features, admin1 = []) => ({ format: 1, version: 'fixture', extent: 2 ** 24, fingerprint: manifest.fingerprint, features, admin1 });
const feature = (id, countryCode, index) => ({ id, countryCode, index, d: 'M0 0l1 0l0 1z', bounds: [0, 0, 1, 1] });

async function withFetch(callback, files = {}) {
  const old = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    const key = String(url).split('/').pop();
    if (key === 'world.json') return new Response(JSON.stringify(payload([])));
    if (key === 'catalog.json') return new Response(JSON.stringify(catalog));
    if (files[key]) return new Response(JSON.stringify(files[key]));
    return new Response('missing', { status: 404 });
  };
  try { return await callback(calls); } finally { globalThis.fetch = old; }
}

test('loads world without fetching full catalog and deduplicates countries', async () => {
  const files = { 'AAA.json': payload([feature('AAA:r1', 'AAA', 0)]), 'BBB.json': payload([feature('BBB:r1', 'BBB', 1)]) };
  await withFetch(async calls => {
    const atlas = loadCompiledAtlas('/fixture/', { manifest });
    await Promise.all([atlas.world, atlas.loadCountry('AAA'), atlas.loadCountry('AAA'), atlas.loadCountry('BBB')]);
    assert.equal(calls.filter(call => call.url.endsWith('AAA.json')).length, 1);
    assert.equal(calls.some(call => call.url.endsWith('catalog.json')), false);
  }, files);
});

test('rejects invalid compiled indexes and retries after a failed request', async () => {
  let bad = true;
  await withFetch(async () => {
    const old = globalThis.fetch;
    globalThis.fetch = async url => {
      if (String(url).endsWith('world.json')) return new Response(JSON.stringify(payload([])));
      if (String(url).endsWith('AAA.json') && bad) { bad = false; return new Response(JSON.stringify(payload([feature('BBB:r1', 'BBB', 1)]))); }
      return new Response(JSON.stringify(payload([feature('AAA:r1', 'AAA', 0)])));
    };
    try {
      const atlas = loadCompiledAtlas('/fixture/', { manifest });
      await assert.rejects(atlas.loadCountry('AAA'), /invalid compiled region index/i);
      await assert.doesNotReject(atlas.loadCountry('AAA'));
    } finally { globalThis.fetch = old; }
  });
});

test('catalog is loaded only explicitly and abort is passed through', async () => {
  const controller = new AbortController();
  await withFetch(async calls => {
    const atlas = loadCompiledAtlas('/fixture/', { manifest, signal: controller.signal });
    assert.equal(calls.some(call => call.url.endsWith('catalog.json')), false);
    controller.abort(new Error('stop'));
    await assert.rejects(atlas.loadCountry('AAA'), /stop|aborted/i);
  }, { 'AAA.json': payload([feature('AAA:r1', 'AAA', 0)]) });
});

test('manifest validation rejects malformed identity, paths, and country ranges before fetch', () => {
  const invalid = [
    null,
    { ...manifest, version: '' },
    { ...manifest, regionCount: 0x100000000 },
    { ...manifest, worldFile: '' },
    { ...manifest, catalogFile: '' },
    { ...manifest, countries: [] },
    { ...manifest, countries: { AAA: { ...manifest.countries.AAA, start: -1 } } },
    { ...manifest, countries: { AAA: { ...manifest.countries.AAA, count: 3 } } },
    { ...manifest, countries: { AAA: { ...manifest.countries.AAA, file: '' } } },
  ];
  for (const candidate of invalid) assert.throws(() => loadCompiledAtlas('/fixture/', { manifest: candidate }), /unsupported compiled atlas|invalid compiled country ranges/i);
});

test('rejects invalid outline metadata before loading the atlas', () => {
  const entry = { file: '../outlines/AAA.json', bounds: [0, 0, 10, 10], regionIds: ['AAA:ADM0:AAA'] };
  for (const outlines of [null, { minZoom: 6, countries: [] },
    { minZoom: -1, countries: {} },
    ...[null, { ...entry, bounds: [10, 0, 0, 10] }, { ...entry, file: '' },
      { ...entry, parts: [] }, { ...entry, parts: [[0, 0, -1, 1]] },
      { ...entry, regionIds: ['BBB:ADM0:BBB'] }, { ...entry, regionIds: ['AAA:ADM2:region'] }]
      .map(value => ({ minZoom: 6, countries: { AAA: value } })),
  ]) {
    assert.throws(() => loadCompiledAtlas('/fixture/', { manifest: { ...manifest, outlines } }), /invalid detailed outline manifest/);
  }
});

test('factory gives codeword precedence over visited IDs and reset emits callbacks', async () => {
  await withCompiledDom(async ({ leaflet }) => {
    const changes = [];
    const codeword = encodeVisitedIndices([0], describeCatalog(catalog));
    await withFactoryFetch({ AAA: payload([feature('AAA:r1', 'AAA', 0)]), BBB: payload([feature('BBB:r1', 'BBB', 1)]) }, async () => {
      const sphere = await createCompiledJourneySphere(createContainer(), {
        leaflet, dataUrl: '/fixture/', manifest, codeword, visited: ['BBB:r1'], onChange: change => changes.push(change),
      });
      assert.deepEqual(sphere.getVisited(), ['AAA:r1']);
      await sphere.setVisited(['BBB:r1']);
      await sphere.reset();
      assert.deepEqual(sphere.getVisited(), ['AAA:r1']);
      assert.equal(changes.length, 2);
      sphere.destroy();
    });
  });
});

test('failed selection preserves committed state and a newer selection wins a slower request', async () => {
  await withCompiledDom(async ({ leaflet }) => {
    const failedRequest = deferred();
    const slowRequest = deferred();
    let bbbCalls = 0;
    await withFactoryFetch({ AAA: payload([feature('AAA:r1', 'AAA', 0)]), BBB: () => bbbCalls++ === 0 ? failedRequest.promise : slowRequest.promise }, async () => {
      const sphere = await createCompiledJourneySphere(createContainer(), {
        leaflet, dataUrl: '/fixture/', manifest, visited: ['AAA:r1'],
      });
      const failed = sphere.setVisited(['BBB:r1']);
      await assert.rejects(Promise.resolve().then(() => sphere.setVisited(['UNKNOWN:r1'])), /unknown region ID/i);
      failedRequest.reject(new Error('country unavailable'));
      await assert.rejects(failed, /country unavailable/i);
      assert.deepEqual(sphere.getVisited(), ['AAA:r1']);

      const slow = sphere.setVisited(['BBB:r1']);
      const winning = sphere.setVisited(['AAA:r1']);
      slowRequest.resolve(payload([feature('BBB:r1', 'BBB', 1)]));
      await winning;
      await slow;
      assert.deepEqual(sphere.getVisited(), ['AAA:r1']);
      const invalid = sphere.setVisited(['AAA:missing']);
      const newer = sphere.setVisited(['AAA:r1']);
      await assert.rejects(invalid, /Unknown region ID/);
      await newer;
      assert.deepEqual(sphere.getVisited(), ['AAA:r1']);
      sphere.destroy();
    });
  });
});

test('destroy rejects pending work and external abort propagates before fetch', async () => {
  await withCompiledDom(async ({ leaflet }) => {
    const held = deferred();
    const updateHeld = deferred();
    await withFactoryFetch({ AAA: held.promise, BBB: updateHeld.promise }, async () => {
      const pending = createCompiledJourneySphere(createContainer(), {
        leaflet, dataUrl: '/fixture/', manifest, visited: ['AAA:r1'],
      });
      held.resolve(payload([feature('AAA:r1', 'AAA', 0)]));
      const sphere = await pending;
      const update = sphere.setVisited(['BBB:r1']);
      sphere.destroy();
      updateHeld.resolve(payload([feature('BBB:r1', 'BBB', 1)]));
      await assert.rejects(update, /destroyed|aborted/i);
    });
    await assert.rejects(withFactoryFetch({}, () => createCompiledJourneySphere(createContainer(), {
      leaflet, dataUrl: '/fixture/', manifest, visited: [], signal: AbortSignal.abort(new Error('external stop')),
    })), /external stop|aborted/i);
  });
});

test('factory rejects custom CRS before issuing data requests', async () => {
  await withCompiledDom(async ({ leaflet }) => {
    let requests = 0;
    await assert.rejects(withFactoryFetch({}, () => {
      globalThis.fetch = async () => { requests += 1; throw new Error('unexpected fetch'); };
      return createCompiledJourneySphere(createContainer(), { leaflet, dataUrl: '/fixture/', manifest, mapOptions: { crs: {} } });
    }), /EPSG3857/i);
    assert.equal(requests, 0);
  });
});

test('clear invalidates old country responses and does not resurrect cache', async () => {
  const first = deferred();
  const second = deferred();
  await withFetch(async calls => {
    const oldFetch = globalThis.fetch;
    let countryCalls = 0;
    globalThis.fetch = async (url, options) => {
      const name = String(url).split('/').pop();
      calls.push({ url: String(url), options });
      if (name === 'world.json') return new Response(JSON.stringify(payload([])));
      if (name === 'AAA.json') return (countryCalls++ === 0 ? first : second).promise.then(value => new Response(JSON.stringify(value)));
      return new Response('missing', { status: 404 });
    };
    try {
      const atlas = loadCompiledAtlas('/fixture/', { manifest });
      const oldRequest = atlas.loadCountry('AAA');
      atlas.clear();
      const newRequest = atlas.loadCountry('AAA');
      first.resolve(payload([feature('AAA:r1', 'AAA', 0)]));
      await oldRequest;
      assert.equal(atlas.loaded.has('AAA'), false, 'Old response cannot repopulate a cleared cache');
      const deduplicated = atlas.loadCountry('AAA');
      assert.equal(countryCalls, 2, 'Old response cannot delete the newer in-flight request');
      second.resolve(payload([feature('AAA:r1', 'AAA', 0)]));
      await Promise.all([newRequest, deduplicated]);
      assert.equal(countryCalls, 2);
      assert.equal(atlas.loaded.has('AAA'), true);
      atlas.clear();
      const afterClear = atlas.loadCountry('AAA');
      second.resolve(payload([feature('AAA:r1', 'AAA', 0)]));
      await afterClear;
      assert.equal(countryCalls, 3);
    } finally { globalThis.fetch = oldFetch; }
  });
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

function createContainer() {
  return { clientWidth: 640, clientHeight: 400, classList: { add() {}, remove() {} } };
}

function makeCanvas() {
  const context = { save() {}, restore() {}, setTransform() {}, translate() {}, fill() {}, stroke() {}, isPointInPath() { return false; } };
  return { style: {}, getContext: () => context };
}

function makeMap() {
  const handlers = new Map();
  const map = {
    handlers,
    attributionControl: { addAttribution() {} },
    dragging: { moving: () => false },
    on(name, handler, context) { handlers.set(name, { handler, context }); return map; },
    off(name) { handlers.delete(name); return map; },
    addLayer(layer) { layer.onAdd?.(map); return map; },
    removeLayer(layer) { layer.onRemove?.(map); return map; },
    remove() { for (const layer of [...map.layers || []]) layer.onRemove?.(map); map.removed = true; },
    setView(_center, zoom) { map.zoom = zoom; return map; }, getZoom: () => map.zoom ?? 4,
    invalidateSize() {}, setMinZoom() {}, getCenter: () => ({ lat: 0, lng: 0 }),
    getPixelWorldBounds: () => ({ min: { y: 0 }, max: { y: 256 } }), getSize: () => ({ y: 256 }),
    project: () => ({ x: 128, y: 128 }), unproject: value => value,
  };
  return map;
}

function makeLeaflet() {
  class GridLayer {
    getTileSize() { return { x: 256, y: 256 }; }
    onAdd() {}
    onRemove() {}
    addTo(map) { (map.layers ||= []).push(this); this.onAdd(map); return this; }
    redraw() { this.redrawCount = (this.redrawCount || 0) + 1; return this; }
  }
  GridLayer.extend = methods => { class Layer extends GridLayer {} Object.assign(Layer.prototype, methods); return Layer; };
  const leaflet = {
    GridLayer, CRS: { EPSG3857: {} }, maps: [],
    map() { const value = makeMap(); leaflet.maps.push(value); return value; },
    control() { return { onAdd() {}, addTo(map) { this.onAdd(map); return this; } }; },
    DomUtil: { create: () => ({ setAttribute() {}, textContent: '' }) },
    DomEvent: { disableClickPropagation() {} },
    tooltip: () => ({ setLatLng() { return this; }, setContent() { return this; }, addTo(map) { map.addLayer(this); return this; } }),
  };
  return leaflet;
}

test('full-country startup does not redraw the same countries after first display', async () => {
  await withCompiledDom(async ({ leaflet }) => {
    await withFactoryFetch({ AAA: payload([feature('AAA:r1', 'AAA', 0)]), BBB: payload([feature('BBB:r1', 'BBB', 1)]) }, async () => {
      const sphere = await createCompiledJourneySphere(createContainer(), {
        leaflet, dataUrl: '/fixture/', manifest, visited: ['AAA:r1', 'BBB:r1'],
      });
      await sphere.detailsReady;
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(sphere.map.layers[0].redrawCount || 0, 0);
      sphere.destroy();
    });
  });
});

test('progressive startup still repaints when the full country replaces a subset', async () => {
  await withCompiledDom(async ({ leaflet }) => {
    const identity = describeCatalog({ version: 'fixture', regionIds: ['AAA:r1', 'AAA:r2'] });
    const localManifest = { ...manifest, fingerprint: identity.fingerprint, countries: {
      AAA: { ...manifest.countries.AAA, count: 2 }, BBB: { ...manifest.countries.BBB, start: 2, count: 0 },
    } };
    const envelope = features => ({ ...payload(features), fingerprint: identity.fingerprint });
    const selected = feature('AAA:r1', 'AAA', 0);
    const full = deferred();
    await withFactoryFetch({ AAA: full.promise }, async () => {
      const oldFetch = globalThis.fetch;
      globalThis.fetch = (url, options) => String(url).endsWith('world.json')
        ? Promise.resolve(new Response(JSON.stringify(envelope([])))) : oldFetch(url, options);
      try {
        const sphere = await createCompiledJourneySphere(createContainer(), {
          leaflet, dataUrl: '/fixture/', manifest: localManifest, visited: ['AAA:r1'],
          initialCountries: { AAA: envelope([selected]) },
        });
        const layer = sphere.map.layers[0];
        assert.equal(layer._sceneAt(4).activeRecords.length, 1);
        full.resolve(envelope([selected, feature('AAA:r2', 'AAA', 1)]));
        await sphere.detailsReady;
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(layer.redrawCount, 1);
        assert.equal(layer._sceneAt(4).activeRecords.length, 2);
        sphere.destroy();
      } finally { globalThis.fetch = oldFetch; }
    });
  });
});

async function withCompiledDom(callback) {
  const oldDocument = globalThis.document;
  const oldPath2D = globalThis.Path2D;
  const leaflet = makeLeaflet();
  globalThis.Path2D = class Path {};
  globalThis.document = { querySelector: () => createContainer(), createElement: name => name === 'canvas' ? makeCanvas() : { textContent: '' } };
  try { return await callback({ leaflet }); } finally { globalThis.document = oldDocument; globalThis.Path2D = oldPath2D; }
}

async function withFactoryFetch(files, callback) {
  return withFetch(async calls => {
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      const key = String(url).split('/').pop();
      calls.push({ url: String(url), options });
      if (key === 'world.json') return new Response(JSON.stringify(payload([])));
      if (key === 'catalog.json') return new Response(JSON.stringify(catalog));
      const fileEntry = files[key] ?? files[key.replace(/\.json$/, '')];
      const file = typeof fileEntry === 'function' ? fileEntry() : fileEntry;
      if (file?.then) return file.then(value => new Response(JSON.stringify(value)));
      if (file) return new Response(JSON.stringify(file));
      return new Response('missing', { status: 404 });
    };
    try { return await callback(); } finally { globalThis.fetch = oldFetch; }
  });
}
