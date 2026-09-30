import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompiledJourneySphere, loadCompiledAtlas } from '../src/compiled.js';

const manifest = {
  format: 1, version: 'embed-fixture', extent: 2 ** 24, regionCount: 2, fingerprint: [1, 2],
  worldFile: 'world.json', catalogFile: '../catalog.json',
  countries: { AAA: { file: 'countries/AAA.json', start: 0, count: 2, color: '#123456' } },
};
const feature = index => ({ id: `AAA:r${index}`, countryCode: 'AAA', index,
  d: 'M0 0l10 0l0 10l-10 -10z', bounds: [0, 0, 10, 10] });
const payload = features => ({ format: 1, version: manifest.version, extent: manifest.extent,
  fingerprint: manifest.fingerprint, features, admin1: [] });

test('optional refinement tiers reject invalid zooms and asset paths before downloads', () => {
  const entry = { file: '../outlines/AAA.json', bounds: [0, 0, 10, 10], regionIds: [] };
  for (const outlines of [
    ...[null, NaN, 3].map(detailZoom => ({ minZoom: 4, detailZoom, countries: { AAA: entry } })),
    ...[null, '', 1].map(overviewFile => ({ minZoom: 4, detailZoom: 6, countries: { AAA: { ...entry, overviewFile } } })),
  ]) {
    assert.throws(() => loadCompiledAtlas('/fixture/', { manifest: { ...manifest, outlines } }), /invalid detailed outline manifest/);
  }
  const outlines = { minZoom: 4, detailZoom: 6, countries: { AAA: { ...entry, overviewFile: '../outlines/overview/AAA.json' } } };
  assert.doesNotThrow(() => loadCompiledAtlas('/fixture/', { manifest: { ...manifest, outlines }, worldData: payload([]) }));
});

test('an overlapped overview promise is validated without another world request', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('duplicate world download'); };
  try {
    const world = payload([]);
    const atlas = loadCompiledAtlas('/fixture/', { manifest, worldData: Promise.resolve(world) });
    assert.equal(await atlas.world, world);
    await assert.rejects(loadCompiledAtlas('/fixture/', {
      manifest, worldData: { ...world, version: 'obsolete' },
    }).world, /files do not match/);
    const controller = new AbortController();
    const aborted = loadCompiledAtlas('/fixture/', { manifest, worldData: Promise.resolve(world), signal: controller.signal });
    controller.abort(new Error('map disconnected'));
    await assert.rejects(aborted.world, /map disconnected/);
  } finally { globalThis.fetch = original; }
});

function leafletStub() {
  class GridLayer {
    onAdd() {}
    onRemove() {}
    addTo(map) { map.layer = this; this.onAdd(map); return this; }
    redraw() { this.redraws = (this.redraws || 0) + 1; }
  }
  GridLayer.extend = methods => {
    class Layer extends GridLayer {}
    Object.assign(Layer.prototype, methods);
    return Layer;
  };
  return {
    GridLayer, CRS: { EPSG3857: {} },
    map() {
      return {
        setView(_center, zoom) { this.zoom = zoom; return this; }, getZoom() { return this.zoom; },
        on() {}, off() {}, remove() { this.layer?.onRemove(this); }, removeLayer() {},
      };
    },
    control: () => ({ addTo(map) { this.onAdd(map); } }),
    DomUtil: { create: () => ({ setAttribute() {} }) }, DomEvent: { disableClickPropagation() {} },
  };
}

test('selected chunks paint without full countries, and explicit details deduplicate and retry failures', async () => {
  const original = { document: globalThis.document, Path2D: globalThis.Path2D, fetch: globalThis.fetch };
  globalThis.document = { createElement: () => ({ textContent: '' }) };
  globalThis.Path2D = class {};
  let countryRequests = 0;
  let unavailable = true;
  globalThis.fetch = async url => {
    assert.ok(String(url).endsWith('/countries/AAA.json'));
    countryRequests++;
    return unavailable ? new Response('offline', { status: 503 }) : new Response(JSON.stringify(payload([feature(0), feature(1)])));
  };
  let sphere;
  try {
    sphere = await createCompiledJourneySphere({ clientWidth: 640, clientHeight: 400, classList: { add() {}, remove() {} } }, {
      leaflet: leafletStub(), manifest, worldData: payload([]), visited: ['AAA:r0'],
      initialCountries: { AAA: payload([feature(0)]) }, backgroundDetails: false,
    });
    await Promise.all([sphere.detailsReady, sphere.outlineDetailsReady]);
    assert.equal(countryRequests, 0, 'background country loading must stay disabled');
    assert.deepEqual(sphere.getVisited(), ['AAA:r0']);
    const failed = sphere.loadDetails();
    assert.equal(sphere.loadDetails(), failed, 'concurrent explicit requests share the same work');
    await assert.rejects(failed, /503/);
    assert.deepEqual(sphere.getVisited(), ['AAA:r0'], 'a detail failure keeps selected chunks usable');
    unavailable = false;
    await sphere.loadDetails();
    assert.equal(countryRequests, 2, 'failed explicit details can retry');
    await sphere.setVisited(['AAA:r1']);
    assert.deepEqual(sphere.getVisited(), ['AAA:r1'], 'full details unlock adjacent selectable regions');
    sphere.destroy();
    await assert.rejects(sphere.loadDetails(), /destroyed/);
  } finally {
    sphere?.destroy();
    Object.assign(globalThis, original);
  }
});
