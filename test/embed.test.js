import test from 'node:test';
import assert from 'node:assert/strict';

import { loadChunks, parsePlaces } from '../src/embed.js';

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
