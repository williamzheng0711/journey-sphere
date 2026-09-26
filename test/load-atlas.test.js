import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeVisited, loadAtlas } from '../src/index.js';

const BASE_URL = 'https://journeysphere.test/assets/';
const EMPTY_WORLD = { type: 'FeatureCollection', features: [] };
const EMPTY_PALETTE = {};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function response(value) {
  return { ok: true, status: 200, json: async () => value };
}

function catalog({ file = 'countries/AA.json' } = {}) {
  return {
    version: 'test-1',
    regionIds: ['AA:r1', 'AA:r2', 'BB:r1'],
    countries: {
      AA: { file },
      BB: { file: 'countries/BB.json' },
      CC: { file: 'countries/CC.json' },
    },
  };
}

function payloadFor(url, dataCatalog) {
  if (url.endsWith('/catalog.json')) return dataCatalog;
  if (url.endsWith('/world.geojson')) return EMPTY_WORLD;
  if (url.endsWith('/palette.json')) return EMPTY_PALETTE;
  return { type: 'FeatureCollection', features: [], url };
}

async function flushMicrotasks(count = 8) {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

async function withFetch(fetchMock, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('normal loadAtlas fetches only world, catalog, and palette', { concurrency: false }, async () => {
  const calls = [];
  const dataCatalog = catalog();
  await withFetch(async (url, options) => {
    const requestUrl = String(url);
    calls.push({ url: requestUrl, options });
    return response(payloadFor(requestUrl, dataCatalog));
  }, async () => {
    const atlas = await loadAtlas(BASE_URL);
    assert.deepEqual(atlas.catalog, dataCatalog);
  });

  assert.deepEqual(calls.map(call => call.url).sort(), [
    `${BASE_URL}catalog.json`,
    `${BASE_URL}palette.json`,
    `${BASE_URL}world.geojson`,
  ]);
  assert.equal(calls.some(call => call.url.includes('/countries/')), false);
});

test('selected countries start as soon as the catalog arrives and are unique', { concurrency: false }, async () => {
  const calls = [];
  const heldWorld = deferred();
  const dataCatalog = catalog();
  await withFetch(async (url) => {
    const requestUrl = String(url);
    calls.push(requestUrl);
    if (requestUrl.endsWith('/world.geojson')) return heldWorld.promise;
    return response(payloadFor(requestUrl, dataCatalog));
  }, async () => {
    const atlasPromise = loadAtlas(BASE_URL, { visited: ['AA:r1', 'AA:r2', 'BB:r1'] });
    await flushMicrotasks();
    assert.deepEqual(calls.filter(url => url.includes('/countries/')).sort(), [
      `${BASE_URL}countries/AA.json`,
      `${BASE_URL}countries/BB.json`,
    ]);
    assert.equal(calls.includes(`${BASE_URL}countries/CC.json`), false);
    heldWorld.resolve(response(EMPTY_WORLD));
    await atlasPromise;
  });
});

test('a preloaded country request is reused once by loadCountry', { concurrency: false }, async () => {
  const calls = [];
  const heldCountry = deferred();
  const dataCatalog = catalog();
  await withFetch(async (url) => {
    const requestUrl = String(url);
    calls.push(requestUrl);
    if (requestUrl.endsWith('/countries/AA.json')) return heldCountry.promise;
    return response(payloadFor(requestUrl, dataCatalog));
  }, async () => {
    const atlas = await loadAtlas(BASE_URL, { visited: ['AA:r1'] });
    const countryPromise = atlas.loadCountry('AA');
    assert.equal(calls.filter(url => url.endsWith('/countries/AA.json')).length, 1);
    heldCountry.resolve(response({ type: 'FeatureCollection', features: [{ id: 'AA:r1' }] }));
    assert.deepEqual(await countryPromise, { type: 'FeatureCollection', features: [{ id: 'AA:r1' }] });
    await atlas.loadCountry('AA');
    assert.equal(calls.filter(url => url.endsWith('/countries/AA.json')).length, 2);
  });
});

test('a delayed selected shard never blocks world and atlas completion', { concurrency: false }, async () => {
  const heldCountry = deferred();
  const dataCatalog = catalog();
  await withFetch(async (url) => {
    const requestUrl = String(url);
    if (requestUrl.endsWith('/countries/AA.json')) return heldCountry.promise;
    return response(payloadFor(requestUrl, dataCatalog));
  }, async () => {
    const atlas = await loadAtlas(BASE_URL, { visited: ['AA:r1'] });
    assert.equal(atlas.world, EMPTY_WORLD);
    heldCountry.resolve(response({ type: 'FeatureCollection', features: [] }));
  });
});

test('codeword selection overrides visited selection', { concurrency: false }, async () => {
  const calls = [];
  const dataCatalog = catalog();
  const codeword = encodeVisited(['BB:r1'], dataCatalog);
  await withFetch(async (url) => {
    const requestUrl = String(url);
    calls.push(requestUrl);
    return response(payloadFor(requestUrl, dataCatalog));
  }, async () => {
    await loadAtlas(BASE_URL, { visited: ['AA:r1'], codeword });
  });
  assert.deepEqual(calls.filter(url => url.includes('/countries/')), [`${BASE_URL}countries/BB.json`]);
});

test('invalid visited and codeword inputs reject before any country fetch', { concurrency: false }, async () => {
  const dataCatalog = catalog();
  for (const options of [{ visited: ['unknown:r1'] }, { codeword: 'js1_invalid' }]) {
    const countryCalls = [];
    await withFetch(async (url) => {
      const requestUrl = String(url);
      if (requestUrl.includes('/countries/')) countryCalls.push(requestUrl);
      return response(payloadFor(requestUrl, dataCatalog));
    }, async () => {
      await assert.rejects(loadAtlas(BASE_URL, options));
    });
    assert.deepEqual(countryCalls, []);
  }
});

test('a failed preloaded shard rejects loadCountry and a later call retries', { concurrency: false }, async () => {
  const calls = [];
  const dataCatalog = catalog();
  await withFetch(async (url) => {
    const requestUrl = String(url);
    if (requestUrl.endsWith('/countries/AA.json')) {
      calls.push(requestUrl);
      if (calls.length === 1) throw new Error('temporary shard failure');
      return response({ type: 'FeatureCollection', features: [] });
    }
    return response(payloadFor(requestUrl, dataCatalog));
  }, async () => {
    const atlas = await loadAtlas(BASE_URL, { visited: ['AA:r1'] });
    await assert.rejects(atlas.loadCountry('AA'), /temporary shard failure/);
    await atlas.loadCountry('AA');
  });
  assert.equal(calls.length, 2);
});

test('forwards the base signal and lets a consumer signal override it', { concurrency: false }, async () => {
  const calls = [];
  const baseController = new AbortController();
  const consumerController = new AbortController();
  const heldCountry = deferred();
  const dataCatalog = catalog();
  await withFetch(async (url, options) => {
    const requestUrl = String(url);
    calls.push({ url: requestUrl, signal: options.signal });
    if (requestUrl.endsWith('/countries/AA.json')) {
      options.signal.addEventListener('abort', () => heldCountry.reject(options.signal.reason), { once: true });
      return heldCountry.promise;
    }
    return response(payloadFor(requestUrl, dataCatalog));
  }, async () => {
    const atlas = await loadAtlas(BASE_URL, { signal: baseController.signal });
    const countryPromise = atlas.loadCountry('AA', { signal: consumerController.signal });
    assert.equal(calls.find(call => call.url.endsWith('/catalog.json')).signal, baseController.signal);
    assert.equal(calls.find(call => call.url.endsWith('/world.geojson')).signal, baseController.signal);
    assert.equal(calls.find(call => call.url.endsWith('/palette.json')).signal, baseController.signal);
    assert.equal(calls.find(call => call.url.endsWith('/countries/AA.json')).signal, consumerController.signal);
    const reason = new Error('consumer cancelled');
    consumerController.abort(reason);
    await assert.rejects(countryPromise, error => error === reason);
  });
});

test('consumer cancellation wraps a preloaded request without aborting its base signal', { concurrency: false }, async () => {
  const calls = [];
  const baseController = new AbortController();
  const consumerController = new AbortController();
  const heldCountry = deferred();
  const dataCatalog = catalog();
  await withFetch(async (url, options) => {
    const requestUrl = String(url);
    calls.push({ url: requestUrl, signal: options.signal });
    if (requestUrl.endsWith('/countries/AA.json')) return heldCountry.promise;
    return response(payloadFor(requestUrl, dataCatalog));
  }, async () => {
    try {
      const atlas = await loadAtlas(BASE_URL, { signal: baseController.signal, visited: ['AA:r1'] });
      const preloadedSignal = calls.find(call => call.url.endsWith('/countries/AA.json')).signal;
      assert.equal(preloadedSignal, baseController.signal);

      const reason = new Error('consumer cancelled');
      const countryPromise = atlas.loadCountry('AA', { signal: consumerController.signal });
      consumerController.abort(reason);
      await assert.rejects(countryPromise, error => error === reason);
      assert.equal(baseController.signal.aborted, false);

      const alreadyAborted = new AbortController();
      alreadyAborted.abort(new Error('already cancelled'));
      await assert.rejects(
        atlas.loadCountry('AA', { signal: alreadyAborted.signal }),
        error => error === alreadyAborted.signal.reason,
      );
    } finally {
      heldCountry.resolve(response({ type: 'FeatureCollection', features: [] }));
    }
  });
});

test('respects a nonstandard country file path from the catalog', { concurrency: false }, async () => {
  const calls = [];
  const dataCatalog = catalog({ file: 'shards/custom-aa.geojson' });
  await withFetch(async (url) => {
    const requestUrl = String(url);
    calls.push(requestUrl);
    return response(payloadFor(requestUrl, dataCatalog));
  }, async () => {
    const atlas = await loadAtlas(BASE_URL);
    await atlas.loadCountry('AA');
  });
  assert.equal(calls.includes(`${BASE_URL}shards/custom-aa.geojson`), true);
  assert.equal(calls.includes(`${BASE_URL}countries/AA.json`), false);
});
