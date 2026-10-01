import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createOutlineDetail } from '../src/outline-detail.js';

const data = new URL('../data/', import.meta.url);
const actual = JSON.parse(await readFile(new URL('compiled/manifest.json', data), 'utf8'));
const usa = actual.outlines.countries.USA;
const fragments = new Map(await Promise.all(usa.fragments.map(async fragment => [fragment.id,
  await readFile(new URL(fragment.file, new URL('compiled/', data)), 'utf8')])));
const extent = actual.extent;
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture({ lat = 13.45, lng = 144.75, zoom = 4, neighbors = 6, width = 800 } = {}) {
  const countries = { USA: usa };
  for (let index = 0; index < neighbors; index++) countries[`C${index}`] = {
    file: `C${index}.json`, bounds: [0, 6_500_000, extent, extent], regionIds: [],
  };
  const manifest = { ...actual, outlines: { ...actual.outlines, countries } };
  const inverseY = y => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / extent))) * 180 / Math.PI;
  const map = {
    getZoom: () => zoom,
    getBounds() {
      const scale = extent / (256 * 2 ** zoom);
      const sin = Math.sin(lat * Math.PI / 180);
      const x = (lng + 180) / 360 * extent;
      const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * extent;
      return {
        getSouthWest: () => ({ lat: inverseY(y + 400 * scale), lng: (x - width / 2 * scale) / extent * 360 - 180 }),
        getNorthEast: () => ({ lat: inverseY(y - 400 * scale), lng: (x + width / 2 * scale) / extent * 360 - 180 }),
      };
    },
    on() {}, off() {},
    move(nextLat, nextLng, nextZoom) { lat = nextLat; lng = nextLng; zoom = nextZoom; },
  };
  return { map, manifest };
}
function heldFetch(manifest, { immediateAlaska = false, failFirstNeighbor = false } = {}) {
  const calls = []; const pending = new Map(); let failed = false; let maximum = 0;
  const fetch = url => {
    const file = String(url).split('/').pop();
    const fragment = String(url).includes('/fragments/USA/') ? Number(file.slice(0, -5)) : null;
    const key = fragment === null ? file.slice(0, -5) : `USA:${fragment}`;
    calls.push(key);
    const body = fragment === null ? JSON.stringify({ format: 1, version: manifest.version, extent, fingerprint: manifest.fingerprint,
      features: [{ id: key, countryCode: key, d: 'M0 0l1 0l0 1l-1 -1z', bounds: [0, 0, 1, 1] }] }) : fragments.get(fragment);
    if (immediateAlaska && fragment === 0) return Promise.resolve(new Response(body));
    if (failFirstNeighbor && key === 'C0' && !failed) { failed = true; return Promise.resolve(new Response('', { status: 503 })); }
    return new Promise(resolve => {
      assert.ok(!pending.has(key), `${key} has only one active fetch`);
      pending.set(key, () => { pending.delete(key); resolve(new Response(body)); });
      maximum = Math.max(maximum, pending.size);
    });
  };
  const drain = async () => {
    for (let iteration = 0; iteration < 20; iteration++) {
      for (const resolve of [...pending.values()]) resolve();
      await flush();
      if (!pending.size) return;
    }
    assert.fail('queued outline requests did not settle');
  };
  return { fetch, calls, pending, drain, get maximum() { return maximum; } };
}

test('cached Alaska does not let queued neighbors overtake missing focal Pacific fragments', async () => {
  const { map, manifest } = fixture({ lat: 61.2, lng: -149.85, zoom: 8 });
  const network = heldFetch(manifest, { immediateAlaska: true, failFirstNeighbor: true });
  const originalFetch = globalThis.fetch; globalThis.fetch = network.fetch;
  const controller = createOutlineDetail({ map, manifest, dataUrl: data });
  try {
    await controller.load(); assert.deepEqual(network.calls, ['USA:0']);
    map.move(0, 0, 4);
    await assert.rejects(controller.load(), /503/); await flush();
    assert.deepEqual([...network.pending.keys()], ['C1', 'C2', 'C3']);
    map.move(13.45, 144.75, 4);
    const focal = controller.load();
    assert.equal(controller.get('USA', 4), null, 'cached Alaska alone does not complete the focal USA country');
    network.pending.get('C1')(); await flush();
    assert.equal(network.calls.at(-1), 'USA:1', 'first missing focal fragment takes the first freed slot');
    assert.ok(network.pending.has('C2') && network.pending.has('C3'), 'older visible neighbors remain genuinely held');
    assert.equal(network.calls.includes('C4'), false, 'queued neighbor cannot overtake the focal country');
    network.pending.get('USA:1')(); await flush();
    assert.equal(network.calls.at(-1), 'USA:3', 'the next missing focal fragment retains priority');
    await network.drain();
    assert.ok((await focal).some(record => record.countryCode === 'USA'));
    assert.ok(controller.get('USA', 4));
    assert.ok(network.maximum <= 3, 'at most three actual requests are held concurrently');
  } finally { controller.destroy(); globalThis.fetch = originalFetch; }
});

test('partial arrivals and a later-started fourth fragment cannot extend the focal country two-second budget', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const { map, manifest } = fixture();
  const network = heldFetch(manifest); const originalFetch = globalThis.fetch; globalThis.fetch = network.fetch;
  const controller = createOutlineDetail({ map, manifest, dataUrl: data });
  try {
    const initial = controller.load();
    assert.deepEqual(network.calls, ['USA:0', 'USA:1', 'USA:3']);
    t.mock.timers.tick(1500); network.pending.get('USA:0')(); await flush();
    assert.deepEqual(network.calls, ['USA:0', 'USA:1', 'USA:3', 'USA:4'], 'fourth fragment starts only after a slot is freed');
    t.mock.timers.tick(250);
    network.pending.get('USA:1')(); network.pending.get('USA:3')(); await flush();
    const repeated = controller.load();
    assert.equal(network.calls.some(key => key.startsWith('C')), false, 'incomplete focal country retains its remaining head start');
    t.mock.timers.tick(249); await flush();
    assert.equal(network.calls.some(key => key.startsWith('C')), false);
    t.mock.timers.tick(1); await flush();
    assert.deepEqual(network.calls.slice(-2), ['C0', 'C1'], 'neighbors start at the original country deadline, not the fourth fragment deadline');
    assert.ok(network.pending.has('USA:4'), 'late-started focal work still counts toward the total three slots');
    t.mock.timers.tick(100); const afterDeadline = controller.load();
    network.pending.get('C0')(); await flush();
    assert.equal(network.calls.at(-1), 'C2', 'another public load cannot reclose the expired country gate');
    await network.drain();
    const results = await Promise.all([initial, repeated, afterDeadline]);
    assert.ok(results.every(records => records.some(record => record.countryCode === 'USA')));
    assert.ok(network.maximum <= 3);
  } finally { controller.destroy(); globalThis.fetch = originalFetch; t.mock.timers.reset(); }
});

test('panning away settles fragmented waits and prevents late ignored-abort responses from entering the cache', async () => {
  const { map, manifest } = fixture({ neighbors: 0 });
  const network = heldFetch(manifest); const originalFetch = globalThis.fetch; globalThis.fetch = network.fetch;
  const errors = []; const controller = createOutlineDetail({ map, manifest, dataUrl: data, onError: error => errors.push(error) });
  try {
    const initial = controller.load();
    const obsolete = assert.rejects(initial, /visible|aborted/);
    assert.deepEqual(network.calls, ['USA:0', 'USA:1', 'USA:3']);
    map.move(0, 0, 4); assert.deepEqual(await controller.load(), []); await obsolete;
    await network.drain();
    map.move(13.45, 144.75, 4);
    assert.equal(controller.get('USA', 4), null, 'obsolete fragments cannot satisfy a later viewport');
    assert.equal(network.calls.includes('USA:4'), false, 'obsolete queued work never starts');
    assert.deepEqual(errors, []);
  } finally { controller.destroy(); globalThis.fetch = originalFetch; }
});
