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

test('setView preserves the map and visits while updating the reset view', async () => {
  await withCompiledDom(async ({ leaflet }) => {
    await withFactoryFetch({ AAA: payload([feature('AAA:r1', 'AAA', 0)]), BBB: payload([feature('BBB:r1', 'BBB', 1)]) }, async calls => {
      const sphere = await createCompiledJourneySphere(createContainer(), {
        leaflet, dataUrl: '/fixture/', manifest, visited: ['AAA:r1'], center: [31, 121], zoom: 4,
      });
      await sphere.setVisited(['BBB:r1']);
      const codeword = sphere.getCodeword();
      const requestCount = calls.length;
      const center = [22, 720];
      assert.equal(sphere.setView(center, 7), sphere.map);
      center[0] = 0;
      assert.deepEqual(sphere.getVisited(), ['BBB:r1']);
      assert.equal(sphere.getCodeword(), codeword);
      assert.deepEqual(sphere.map.getCenter(), { lat: 22, lng: 720 });
      assert.equal(sphere.map.getZoom(), 7);
      assert.equal(leaflet.maps.length, 1);
      assert.equal(sphere.map.removed, undefined);
      assert.equal(calls.length, requestCount, 'changing view does not reload administrative geometry');
      await sphere.setVisited([]);
      sphere.map.setView([0, 0], 2);
      await sphere.reset();
      assert.deepEqual(sphere.getVisited(), ['AAA:r1']);
      assert.deepEqual(sphere.map.getCenter(), { lat: 22, lng: 720 });
      assert.equal(sphere.map.getZoom(), 7);
      sphere.destroy();
      assert.throws(() => sphere.setView([0, 0], 4), /destroyed/);
    });
  });
});

test('invalid views and failed Leaflet view changes preserve the reset target', async () => {
  await withCompiledDom(async ({ leaflet }) => {
    await withFactoryFetch({ AAA: payload([feature('AAA:r1', 'AAA', 0)]) }, async () => {
      const sphere = await createCompiledJourneySphere(createContainer(), {
        leaflet, dataUrl: '/fixture/', manifest, visited: ['AAA:r1'], center: [10, 20], zoom: 4,
      });
      sphere.setView([-90, 1080], 5);
      for (const [center, zoom] of [[null, 4], [[], 4], [[0], 4], [[0, 0, 0], 4], [Array(2), 4], [[NaN, 0], 4],
        [[0, Infinity], 4], [['22', 120], 4], [[91, 0], 4], [[-91, 0], 4], [[0, 0], NaN],
        [[0, 0], Infinity], [[0, 0], '4'], [[0, 0], undefined]]) {
        assert.throws(() => sphere.setView(center, zoom), /center|latitude|zoom/);
      }
      assert.deepEqual(sphere.map.getCenter(), { lat: -90, lng: 1080 });
      assert.equal(sphere.map.getZoom(), 5);
      const setView = sphere.map.setView;
      sphere.map.setView = () => { throw new Error('view unavailable'); };
      assert.throws(() => sphere.setView([30, 40], 6), /view unavailable/);
      sphere.map.setView = setView;
      await sphere.setVisited([]);
      sphere.map.setView([0, 0], 2);
      await sphere.reset();
      assert.deepEqual(sphere.getVisited(), ['AAA:r1']);
      assert.deepEqual(sphere.map.getCenter(), { lat: -90, lng: 1080 });
      assert.equal(sphere.map.getZoom(), 5);
      sphere.destroy();
    });
  });
});

function subsetFixture() {
  const ids = ['AAA:r1', 'AAA:r2', 'BBB:r1'];
  const identity = describeCatalog({ version: 'fixture', regionIds: ids });
  const localManifest = { ...manifest, regionCount: ids.length, fingerprint: identity.fingerprint, countries: {
    AAA: { ...manifest.countries.AAA, count: 2 }, BBB: { ...manifest.countries.BBB, start: 2 },
  } };
  const envelope = features => ({ ...payload(features), fingerprint: identity.fingerprint });
  return { localManifest, envelope,
    a1: feature('AAA:r1', 'AAA', 0), a2: feature('AAA:r2', 'AAA', 1), b1: feature('BBB:r1', 'BBB', 2) };
}

test('prepared selection replacement merges exact subsets without rebuilding or fetching, updates labels and reset', async () => {
  await withCompiledDom(async ({ leaflet }) => {
    const { localManifest, envelope, a1, a2 } = subsetFixture();
    const changes = [];
    await withFactoryFetch({}, async calls => {
      const sphere = await createCompiledJourneySphere(createContainer(), {
        leaflet, dataUrl: '/fixture/', manifest: localManifest, worldData: envelope([]),
        visited: [a1.id], initialCountries: { AAA: envelope([a1]) }, labels: { [a1.id]: 'Original' },
        backgroundDetails: false, center: [10, 20], zoom: 4, onChange: value => changes.push(value),
      });
      const layer = sphere.map.layers[0];
      const requestCount = calls.length;
      const labels = { [a2.id]: 'Updated place' };
      const center = [30, 40];
      sphere.replaceSelection({ visited: [a2.id], initialCountries: { AAA: envelope([a1, a2]) }, labels, center, zoom: 6 });
      labels[a2.id] = 'Caller mutation'; center[0] = 0;
      assert.deepEqual(sphere.getVisited(), [a2.id]);
      assert.deepEqual(layer._sceneAt(6).activeRecords.map(record => record.id), [a1.id, a2.id]);
      layer._hitRecord = () => a2;
      layer._compiledHover({ latlng: [0, 0] });
      assert.equal(layer._compiledLabel.textContent, 'Updated place');
      assert.equal(calls.length, requestCount);
      assert.equal(leaflet.maps.length, 1);
      assert.equal(sphere.map.removed, undefined);
      assert.equal(changes.length, 1);
      await sphere.setVisited([a1.id]);
      sphere.map.setView([0, 0], 2);
      await sphere.reset();
      assert.deepEqual(sphere.getVisited(), [a2.id]);
      assert.deepEqual(sphere.map.getCenter(), { lat: 30, lng: 40 });
      assert.equal(sphere.map.getZoom(), 6);
      assert.equal(calls.length, requestCount, 'merged subset also supports later setVisited and reset');
      sphere.destroy();
      assert.throws(() => sphere.replaceSelection({ visited: [] }), /destroyed/);
    });
  });
});

test('invalid prepared replacements preserve selection, labels, view, reset and callbacks', async () => {
  await withCompiledDom(async ({ leaflet }) => {
    const { localManifest, envelope, a1, a2 } = subsetFixture();
    const changes = [];
    await withFactoryFetch({}, async () => {
      const sphere = await createCompiledJourneySphere(createContainer(), {
        leaflet, dataUrl: '/fixture/', manifest: localManifest, worldData: envelope([]),
        visited: [a1.id], initialCountries: { AAA: envelope([a1]) }, labels: { [a1.id]: 'Kept label' },
        backgroundDetails: false, center: [10, 20], zoom: 4, onChange: value => changes.push(value),
      });
      const candidate = { visited: [a2.id], initialCountries: { AAA: envelope([a2]) },
        labels: { [a1.id]: 'Rejected label' }, center: [30, 40], zoom: 6 };
      const invalid = [
        { ...candidate, visited: [a2.id, a2.id] },
        { ...candidate, visited: ['AAA:missing'] },
        { ...candidate, initialCountries: null },
        { ...candidate, initialCountries: { AAA: { ...envelope([a2]), version: 'other' } } },
        { ...candidate, initialCountries: { AAA: envelope([{ ...a2, d: 'invalid' }]) } },
        { ...candidate, initialCountries: { AAA: envelope([{ ...a2, index: a1.index }]) } },
        { ...candidate, initialCountries: { AAA: envelope([a2, { ...a1, d: 'M0 0l2 0l0 2z' }]) } },
        { ...candidate, initialCountries: { AAA: { ...envelope([a2]), admin1: [{ d: a1.d, bounds: a1.bounds }] } } },
        { ...candidate, labels: null }, { ...candidate, center: [91, 0] }, { ...candidate, zoom: NaN },
      ];
      const codeword = sphere.getCodeword();
      const layer = sphere.map.layers[0];
      for (const snapshot of invalid) {
        assert.throws(() => sphere.replaceSelection(snapshot));
        assert.deepEqual(sphere.getVisited(), [a1.id]);
        assert.equal(sphere.getCodeword(), codeword);
        assert.deepEqual(sphere.map.getCenter(), { lat: 10, lng: 20 });
        assert.equal(sphere.map.getZoom(), 4);
        assert.deepEqual(layer._sceneAt(4).activeRecords.map(record => record.id), [a1.id]);
        assert.equal(changes.length, 0);
      }
      layer._hitRecord = () => a1;
      layer._compiledHover({ latlng: [0, 0] });
      assert.equal(layer._compiledLabel.textContent, 'Kept label');
      await sphere.setVisited([]);
      sphere.map.setView([0, 0], 2);
      await sphere.reset();
      assert.deepEqual(sphere.getVisited(), [a1.id]);
      assert.deepEqual(sphere.map.getCenter(), { lat: 10, lng: 20 });
      sphere.destroy();
    });
  });
});

test('prepared replacements reject conflicts with already loaded complete countries', async () => {
  await withCompiledDom(async ({ leaflet }) => {
    const { localManifest, envelope, a1, a2 } = subsetFixture();
    await withFactoryFetch({ AAA: envelope([a1, a2]) }, async () => {
      const sphere = await createCompiledJourneySphere(createContainer(), {
        leaflet, dataUrl: '/fixture/', manifest: localManifest, worldData: envelope([]),
        visited: [a1.id], backgroundDetails: false,
      });
      assert.throws(() => sphere.replaceSelection({ visited: [a2.id],
        initialCountries: { AAA: envelope([{ ...a2, d: 'M0 0l2 0l0 2z' }]) } }), /conflicting compiled geometry/);
      assert.throws(() => sphere.replaceSelection({ visited: [a2.id], initialCountries: {
        AAA: { ...envelope([a2]), admin1: [{ id: 'AAA:parent', countryCode: 'AAA', d: a2.d, bounds: a2.bounds }] },
      } }), /conflicting compiled geometry/);
      assert.deepEqual(sphere.getVisited(), [a1.id]);
      sphere.replaceSelection({ visited: [a2.id], initialCountries: { AAA: envelope([a2]) } });
      assert.deepEqual(sphere.getVisited(), [a2.id]);
      sphere.destroy();
    });
  });
});

test('prepared replacement supersedes an older held setVisited request', async () => {
  await withCompiledDom(async ({ leaflet }) => {
    const { localManifest, envelope, a1, a2, b1 } = subsetFixture();
    const held = deferred();
    const changes = [];
    await withFactoryFetch({ BBB: held.promise }, async () => {
      const sphere = await createCompiledJourneySphere(createContainer(), {
        leaflet, dataUrl: '/fixture/', manifest: localManifest, worldData: envelope([]),
        visited: [a1.id], initialCountries: { AAA: envelope([a1]) }, backgroundDetails: false,
        onChange: value => changes.push(value),
      });
      const old = sphere.setVisited([b1.id]);
      sphere.replaceSelection({ visited: [a2.id], initialCountries: { AAA: envelope([a2]) } });
      held.resolve(envelope([b1]));
      await old;
      assert.deepEqual(sphere.getVisited(), [a2.id]);
      assert.equal(changes.length, 1);
      await sphere.setVisited([a1.id]);
      await sphere.reset();
      assert.deepEqual(sphere.getVisited(), [a2.id]);
      sphere.destroy();
    });
  });
});

test('explicit details follow replacement selection and reuse completed country data', async () => {
  await withCompiledDom(async ({ leaflet }) => {
    const { localManifest, envelope, a1, a2, b1 } = subsetFixture();
    await withFactoryFetch({ AAA: envelope([a1, a2]), BBB: envelope([b1]) }, async calls => {
      const sphere = await createCompiledJourneySphere(createContainer(), {
        leaflet, dataUrl: '/fixture/', manifest: localManifest, worldData: envelope([]),
        visited: [a1.id], initialCountries: { AAA: envelope([a1]) }, backgroundDetails: false,
      });
      await sphere.loadDetails();
      assert.equal(calls.filter(call => call.url.endsWith('/AAA.json')).length, 1);
      sphere.replaceSelection({ visited: [b1.id], initialCountries: { BBB: envelope([b1]) } });
      const bbb = sphere.loadDetails();
      assert.equal(sphere.loadDetails(), bbb, 'current selection shares one explicit completion promise');
      await bbb;
      assert.equal(calls.filter(call => call.url.endsWith('/BBB.json')).length, 1,
        'completed details for the old selection cannot prevent loading the new country');
      await sphere.setVisited([a1.id]);
      await sphere.loadDetails();
      assert.equal(calls.length, 2, 'returning to a previously completed country does not download it again');
      assert.deepEqual(sphere.map.layers[0]._sceneAt(4).activeRecords.map(record => record.id), [a1.id, a2.id]);
      sphere.destroy();
    });
  });
});

test('obsolete explicit-detail failure cannot clear a newer selection request and can retry', async () => {
  await withCompiledDom(async ({ leaflet }) => {
    const { localManifest, envelope, a1, a2, b1 } = subsetFixture();
    const heldA = deferred();
    const heldB = deferred();
    let aCalls = 0;
    await withFactoryFetch({ AAA: () => aCalls++ === 0 ? heldA.promise : envelope([a1, a2]), BBB: heldB.promise }, async calls => {
      const sphere = await createCompiledJourneySphere(createContainer(), {
        leaflet, dataUrl: '/fixture/', manifest: localManifest, worldData: envelope([]),
        visited: [a1.id], initialCountries: { AAA: envelope([a1]) }, backgroundDetails: false,
      });
      const old = sphere.loadDetails();
      sphere.replaceSelection({ visited: [b1.id], initialCountries: { BBB: envelope([b1]) } });
      const current = sphere.loadDetails();
      heldA.reject(new Error('old country unavailable'));
      await assert.rejects(old, /old country unavailable/);
      assert.equal(sphere.loadDetails(), current, 'old rejection cannot erase the current country completion promise');
      assert.deepEqual(sphere.getVisited(), [b1.id]);
      heldB.resolve(envelope([b1]));
      await current;
      sphere.replaceSelection({ visited: [a1.id] });
      await sphere.loadDetails();
      assert.equal(calls.filter(call => call.url.endsWith('/AAA.json')).length, 2);
      assert.equal(calls.filter(call => call.url.endsWith('/BBB.json')).length, 1);
      assert.deepEqual(sphere.map.layers[0]._sceneAt(4).activeRecords.map(record => record.id), [a1.id, a2.id]);
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
    setView(center, zoom) { map.center = [...center]; map.zoom = zoom; return map; }, getZoom: () => map.zoom ?? 4,
    invalidateSize() {}, setMinZoom() {}, getCenter: () => ({ lat: map.center?.[0] ?? 0, lng: map.center?.[1] ?? 0 }),
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
    try { return await callback(calls); } finally { globalThis.fetch = oldFetch; }
  });
}
