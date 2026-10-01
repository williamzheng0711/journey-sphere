import test from 'node:test';
import assert from 'node:assert/strict';

import { loadChunks, parsePlaces } from '../src/embed.js';

test('bootstrap preloads one default world with fetch credentials and skips custom data maps', async () => {
  const originalDocument = globalThis.document;
  let run = 0;
  const bootstrap = async dataUrls => {
    const links = [];
    globalThis.document = {
      head: { append: link => links.push(link) },
      createElement: tag => ({ tag }),
      querySelectorAll: selector => {
        assert.equal(selector, 'journey-sphere');
        return dataUrls.map(url => ({ getAttribute: name => {
          assert.equal(name, 'data-base-url');
          return url;
        } }));
      },
    };
    await import(`../embed.js?bootstrap-test=${++run}`);
    return links;
  };
  try {
    for (const inputs of [[null], ['', null, null], ['https://other.test/embed/', null]]) {
      const links = await bootstrap(inputs);
      const engine = links.find(link => link.rel === 'modulepreload');
      const world = links.filter(link => link.rel === 'preload');
      assert.ok(engine.href.endsWith('/vendor/leaflet/leaflet.esm.min.js'));
      assert.equal(world.length, 1, 'multiple default maps share a single preload hint');
      assert.equal(world[0].as, 'fetch');
      assert.equal(world[0].crossOrigin, 'anonymous');
      assert.equal(world[0].href, new URL('../data/embed/world.json', import.meta.url).href);
    }
    for (const inputs of [[], ['https://other.test/embed/'], ['../custom/embed/', 'https://other.test/embed/']]) {
      assert.equal((await bootstrap(inputs)).filter(link => link.rel === 'preload').length, 0,
        'a page without a default-data map does not request the bundled world');
    }
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('embed place syntax accepts JSON arrays and semicolon-separated names', () => {
  assert.deepEqual(parsePlaces('["上海", "Hong Kong, China"]'), ['上海', 'Hong Kong, China']);
  assert.deepEqual(parsePlaces('上海;香港\nSingapore'), ['上海', '香港', 'Singapore']);
});

test('embed chunks merge selected region shards by country', async () => {
  const responses = new Map([
    ['regions/CHN/0000.json', { format: 1, version: 'v', extent: 1, fingerprint: [1, 2], features: [{ id: 'CHN:a' }], admin1: [] }],
    ['regions/CHN/0001.json', { format: 1, version: 'v', extent: 1, fingerprint: [1, 2], features: [{ id: 'CHN:b' }], admin1: [{ id: 'CHN:p' }] }],
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => ({ ok: true, json: async () => responses.get(new URL(url).pathname.split('/data/embed/')[1]) });
  try {
    const merged = await loadChunks(['regions/CHN/0000.json', 'regions/CHN/0001.json'], new URL('https://example.test/data/embed/'));
    assert.deepEqual(merged.CHN.features.map(feature => feature.id), ['CHN:a', 'CHN:b']);
    assert.deepEqual(merged.CHN.admin1.map(feature => feature.id), ['CHN:p']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('overlapping city groups deduplicate exact geometry and reject mismatched shard identity', async () => {
  const originalFetch = globalThis.fetch;
  const identity = { format: 1, version: 'v', extent: 1, fingerprint: [1, 2] };
  const feature = { id: 'CHN:a', index: 1, d: 'M0 0l1 0l0 1z' };
  let invalid = false;
  globalThis.fetch = async url => ({ ok: true, json: async () => ({ ...identity,
    version: invalid && String(url).includes('0001') ? 'wrong' : 'v', features: [feature], admin1: [] }) });
  try {
    const paths = ['groups/CHN/0000.json', 'regions/CHN/0001.json'];
    const merged = await loadChunks(paths, new URL('https://example.test/'), undefined, identity);
    assert.deepEqual(merged.CHN.features, [feature]);
    invalid = true;
    await assert.rejects(loadChunks(paths, new URL('https://example.test/'), undefined, identity), /does not match/);
  } finally { globalThis.fetch = originalFetch; }
});
