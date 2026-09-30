import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createOutlineDetail, decodeOutlinePath } from '../src/outline-detail.js';

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

test('progresses from compact overview to exact detail and reuses detail when zooming out', async () => {
  const tiered = { ...manifest, outlines: { minZoom: 4, detailZoom: 6, countries: {
    HKG: { ...manifest.outlines.countries.HKG, overviewFile: 'HKG-overview.json' },
  } } };
  const overview = payload('HKG');
  overview.features[0].d = 'M10 10l2 0l0 2l-2 -2z';
  await withFetch({ 'HKG-overview.json': overview, 'HKG.json': payload('HKG') }, async calls => {
    const m = map({ zoom: 4 });
    const controller = createOutlineDetail({ map: m, manifest: tiered, dataUrl: '/fixture/' });
    try {
      assert.equal((await controller.load())[0].d, overview.features[0].d);
      assert.deepEqual(calls.map(url => url.split('/').pop()), ['HKG-overview.json']);
      assert.equal(controller.get('HKG', 7).d, overview.features[0].d, 'compact coast stays visible during exact download');
      m.setZoom(7);
      const [fine] = await controller.load();
      assert.equal(controller.get('HKG', 7), fine);
      m.setZoom(4);
      assert.equal((await controller.load())[0], fine, 'zooming out reuses cached exact detail');
      assert.equal(controller.get('HKG', 4), fine);
      assert.equal(calls.length, 2);
      assert.equal(controller.get('HKG', 3), null);
    } finally { controller.destroy(); }
  });
});

test('an exact-tier failure leaves compact detail visible and can retry', async () => {
  const tiered = { ...manifest, outlines: { minZoom: 4, detailZoom: 6, countries: {
    HKG: { ...manifest.outlines.countries.HKG, overviewFile: 'HKG-overview.json' },
  } } };
  const files = { 'HKG-overview.json': payload('HKG'), 'HKG.json': new Error('temporary detail failure') };
  await withFetch(files, async calls => {
    const m = map({ zoom: 4 });
    const controller = createOutlineDetail({ map: m, manifest: tiered, dataUrl: '/fixture/' });
    try {
      const [compact] = await controller.load();
      m.setZoom(7);
      await assert.rejects(controller.load(), /temporary detail failure/);
      assert.equal(controller.get('HKG', 7), compact);
      files['HKG.json'] = payload('HKG');
      await controller.load();
      assert.equal(calls.length, 3);
    } finally { controller.destroy(); }
  });
});

test('a wide viewport keeps all visible country outlines without cache churn', async () => {
  const codes = Array.from({ length: 40 }, (_, index) => `A${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + index % 26)}`);
  const countries = Object.fromEntries(codes.map(code => [code, {
    ...manifest.outlines.countries.HKG, file: `${code}.json`, regionIds: [],
  }]));
  await withFetch(Object.fromEntries(codes.map(code => [`${code}.json`, payload(code)])), async calls => {
    const controller = createOutlineDetail({ map: map(), manifest: { ...manifest, outlines: { minZoom: 6, countries } }, dataUrl: '/fixture/' });
    try {
      assert.equal((await controller.load()).length, 40);
      assert.ok(codes.every(code => controller.get(code, 8)), 'visible countries beyond the cache limit retain detail');
      await controller.load();
      assert.equal(calls.length, 40, 'loading the same viewport never downloads evicted visible countries');
    } finally { controller.destroy(); }
  });
});
async function withFetch(files, fn) {
  const old = globalThis.fetch; const calls = [];
  globalThis.fetch = async url => { calls.push(String(url)); const key = String(url).split('/').pop(); const value = files[key]; return value instanceof Error ? Promise.reject(value) : new Response(JSON.stringify(value), { status: value ? 200 : 404 }); };
  try { return await fn(calls); } finally { globalThis.fetch = old; }
}

test('relative delta rings restore exact origins, deltas, closure, and legacy paths', () => {
  const d = 'M100 -200l5 0l0 8l-5 -8z M-20 30l0 0l-3 5l3 -5z';
  const encoded = { pathEncoding: 'relative-delta-v1', paths: [[100, -200, 5, 0, 0, 8], [-120, 230, 0, 0, -3, 5]] };
  assert.equal(decodeOutlinePath(encoded), d);
  assert.equal(decodeOutlinePath({ d, pathData: 'unrelated metadata' }), d);
  assert.equal(decodeOutlinePath({ ...encoded, pathData: 'unrelated metadata' }), d);
});

test('rejects ambiguous, incomplete, noninteger, and overflowing transport rings', () => {
  const encoded = { pathEncoding: 'relative-delta-v1', paths: [[0, 0, 1, 0, 0, 1]] };
  const maximum = Number.MAX_SAFE_INTEGER;
  const invalid = [
    null, {}, [], { paths: encoded.paths }, { ...encoded, pathEncoding: 'unknown' },
    { ...encoded, d: 'M0 0l1 0l0 1l-1 -1z' }, { ...encoded, d: undefined },
    { d: 'M0 0l1 0l0 1l-1 -1z', paths: undefined },
    { d: 'M0 0l1 0l0 1l-1 -1z', pathEncoding: undefined },
    ...[undefined, null, {}, [], [null], [[0, 0, 1, 0]], [[0, 0, 1, 0, 0, 1, 2]],
      [[0, 0, 0.5, 0, 0, 1]], [[0, 0, Infinity, 0, 0, 1]], [[0, 0, NaN, 0, 0, 1]],
      [[0, 0, '1', 0, 0, 1]], [[0, 0, null, 0, 0, 1]],
      [[maximum, 0, 1, 0, 0, 1]],
      [[maximum, 0, 0, 1, 0, -1], [1, 0, 1, 0, 0, 1]],
      [[maximum, 0, -maximum, 0, -1, 1]],
    ].map(paths => ({ ...encoded, paths })),
  ];
  for (const feature of invalid) assert.throws(() => decodeOutlinePath(feature), /invalid detailed outline path encoding/);
});

test('decodes packed detail once, preserves metadata, and attaches only matching manifest parts', async () => {
  const parts = [[13_500_000, 5_500_000, 13_600_000, 5_700_000], [13_800_000, 6_000_000, 14_000_000, 6_500_000]];
  const bounds = manifest.outlines.countries.HKG.bounds;
  const feature = { id: 'HKG:ADM0:HKG', name: 'fixture', countryCode: 'HKG', bounds,
    strokeWidths: [null, 0], pathEncoding: 'relative-delta-v1', paths: [[0, 0, 1, 0, 0, 1], [5, 5, -1, 0, 0, -1]],
    parts: [[-1, -1, -1, -1]] };
  for (const validParts of [true, false]) {
    const indexParts = validParts ? parts : [parts[0]];
    const localManifest = { ...manifest, outlines: { ...manifest.outlines, countries: {
      HKG: { ...manifest.outlines.countries.HKG, parts: indexParts },
    } } };
    await withFetch({ 'HKG.json': { ...payload('HKG'), features: [feature] } }, async calls => {
      const controller = createOutlineDetail({ map: map(), manifest: localManifest, dataUrl: '/fixture/' });
      try {
        const [record] = await controller.load();
        assert.equal(record.d, 'M0 0l1 0l0 1l-1 -1z M5 5l-1 0l0 -1l1 1z');
        assert.deepEqual(record.strokeWidths, feature.strokeWidths);
        assert.equal(record.id, feature.id); assert.equal(record.name, feature.name);
        assert.deepEqual(record.bounds, bounds);
        assert.equal(Object.hasOwn(record, 'paths'), false);
        assert.equal(Object.hasOwn(record, 'pathEncoding'), false);
        if (validParts) {
          assert.deepEqual(record.parts, parts);
          assert.notEqual(record.parts, parts); assert.notEqual(record.parts[0], parts[0]);
        } else assert.equal(Object.hasOwn(record, 'parts'), false, 'inconsistent manifest parts use full bounds');
        assert.equal((await controller.load())[0], record);
        assert.equal(calls.length, 1);
      } finally { controller.destroy(); }
    });
  }
});

test('rejects malformed packed detail without caching and retries the same country', async () => {
  const onlyHkg = { ...manifest, outlines: { ...manifest.outlines, countries: { HKG: manifest.outlines.countries.HKG } } };
  const data = payload('HKG');
  delete data.features[0].d;
  Object.assign(data.features[0], { pathEncoding: 'relative-delta-v1', paths: [[0, 0, 1, 0, 0.5, 1]] });
  await withFetch({ 'HKG.json': data }, async calls => {
    const controller = createOutlineDetail({ map: map(), manifest: onlyHkg, dataUrl: '/fixture/' });
    try {
      await assert.rejects(controller.load(), /invalid detailed outline path encoding/);
      assert.equal(controller.get('HKG', 8), null);
      data.features[0].paths[0][4] = 0;
      assert.equal((await controller.load())[0].d, 'M0 0l1 0l0 1l-1 -1z');
      assert.equal(calls.length, 2);
    } finally { controller.destroy(); }
  });
});

test('loads only intersecting detail, prioritizes the viewport center, and deduplicates', async () => {
  await withFetch({ 'HKG.json': payload('HKG'), 'CHN.json': payload('CHN') }, async calls => {
    const changes = []; const controller = createOutlineDetail({ map: map(), manifest, dataUrl: '/fixture/', onChange: record => changes.push(record) });
    const records = await controller.load();
    assert.deepEqual(records.map(record => record.countryCode), ['CHN', 'HKG']);
    assert.ok(calls[0].endsWith('/CHN.json'), 'country covering the focal area starts before a smaller country farther away');
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
    bad = false; assert.ok((await controller.load()).some(record => record.countryCode === 'HKG')); controller.destroy();
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

test('trims nonvisible outlines to a 32-entry LRU and removes malformed path syntax', async () => {
  const countries = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`C${i}`, { file: `C${i}.json`, bounds: [13_500_000, 5_500_000, 14_000_000, 6_500_000] }]));
  const localManifest = { ...manifest, outlines: { ...manifest.outlines, countries } };
  const old = globalThis.fetch; globalThis.fetch = async url => new Response(JSON.stringify(payload(String(url).split('/').pop().slice(0, -5))));
  try {
    const m = map();
    const controller = createOutlineDetail({ map: m, manifest: localManifest, dataUrl: '/fixture/' });
    await controller.load(); assert.ok(controller.get('C32', 8));
    m.setZoom(5); await controller.load();
    assert.equal(controller.get('C0', 8), null); assert.ok(controller.get('C32', 8)); controller.destroy();
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
    for (const record of records) {
      assert.equal(typeof record.d, 'string');
      assert.equal(Object.hasOwn(record, 'paths'), false);
      assert.equal(Object.hasOwn(record, 'pathEncoding'), false);
      assert.deepEqual(record.parts, actualManifest.outlines.countries[record.countryCode].parts);
    }
  } finally {
    controller.destroy();
    globalThis.fetch = oldFetch;
  }
});
