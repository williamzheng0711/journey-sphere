import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolvePlaces, normalizePlaceName, placeBucket } from '../src/places.js';

const root = new URL('../', import.meta.url);
const embed = new URL('../data/embed/', import.meta.url);
const originalFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = originalFetch; });
globalThis.fetch = async url => ({
  ok: true,
  status: 200,
  json: async () => JSON.parse(await readFile(new URL(String(url)))),
});

test('place normalization and buckets are deterministic', () => {
  assert.equal(normalizePlaceName('  Shanghai\u3000 '), 'shanghai');
  assert.equal(placeBucket('Shanghai'), placeBucket(' shanghai '));
  assert.match(placeBucket('Shanghai'), /^[0-9a-f]{3}$/);
});

test('resolvePlaces loads only the name buckets and returns deduplicated exact region ids', async () => {
  const result = await resolvePlaces(['Shanghai', '上海市, CHN', 'Tokyo, JPN'], { baseUrl: embed });
  assert.equal(result.visited.includes('CHN:ADM2:310000'), true);
  assert.ok(result.visited.length > 1);
  assert.equal(result.labels['CHN:ADM2:310000'], '上海市, CHN');
  assert.ok(result.chunks.every(chunk => /^(?:regions|groups)\/[A-Z]{3}\/[a-f0-9]+\.json$/.test(chunk)));
});

test('qualified aliases disambiguate same-name regions', async () => {
  const result = await resolvePlaces(['Middlesex County, Massachusetts, USA'], { baseUrl: embed });
  assert.deepEqual(result.visited, ['USA:ADM2:52423323B1907827935694']);
  await assert.rejects(resolvePlaces(['Middlesex County, Atlantis, USA'], { baseUrl: embed }), /Unknown place/);
});

test('ambiguous and unknown names fail loudly with actionable errors', async () => {
  await assert.rejects(resolvePlaces(['Sauce'], { baseUrl: embed }), /Ambiguous place/);
  await assert.rejects(resolvePlaces(['Atlantis'], { baseUrl: embed }), /Unknown place/);
  await assert.rejects(resolvePlaces(['constructor'], { baseUrl: embed }), /Unknown place/);
});

test('generated chunk preserves exact compiled geometry for Shanghai', async () => {
  const compiled = JSON.parse(await readFile(new URL('./data/compiled/countries/CHN.json', root)));
  const result = await resolvePlaces(['Shanghai'], { baseUrl: embed });
  const chunk = JSON.parse(await readFile(new URL(`./data/embed/${result.chunks[0]}`, root)));
  const selected = chunk.features.find(feature => feature.id === 'CHN:ADM2:310000');
  const expected = compiled.features.find(feature => feature.id === selected.id);
  assert.deepEqual(selected, expected);
});

test('every generated region shard is a complete, exact catalog partition', async () => {
  const catalog = JSON.parse(await readFile(new URL('./data/catalog.json', root)));
  const expected = new Map(catalog.regionIds.map((id, index) => [id, index]));
  const seen = new Set();
  for (const code of await readdir(new URL('./data/embed/regions/', root))) {
    const source = JSON.parse(await readFile(new URL(`./data/compiled/countries/${code}.json`, root)));
    const sourceById = new Map(source.features.map(candidate => [candidate.id, candidate]));
    for (const file of await readdir(new URL(`./data/embed/regions/${code}/`, root))) {
      const shard = JSON.parse(await readFile(new URL(`./data/embed/regions/${code}/${file}`, root)));
      for (const feature of shard.features) {
        assert.equal(feature.countryCode, code);
        assert.equal(expected.get(feature.id), feature.index);
        assert.equal(seen.has(feature.id), false, `duplicate ${feature.id}`);
        seen.add(feature.id);
        const original = sourceById.get(feature.id);
        assert.deepEqual(feature, original);
      }
      assert.deepEqual(shard.admin1, []);
    }
  }
  assert.equal(seen.size, catalog.regionIds.length);
});

test('same-country duplicate names remain ambiguous and ID aliases remain exact', async () => {
  await assert.rejects(resolvePlaces(['Santa Maria'], { baseUrl: embed }), /Ambiguous place/);
  try { await resolvePlaces(['Santa Maria'], { baseUrl: embed }); } catch (error) {
    const suggestions = error.message.split('Use one of: ')[1].replace(/\.$/, '').split('; ');
    for (const suggestion of suggestions) assert.equal((await resolvePlaces([suggestion], { baseUrl: embed })).visited.length, 1);
  }
  const result = await resolvePlaces(['USA:ADM2:52423323B1907827935694'], { baseUrl: embed });
  assert.deepEqual(result.visited, ['USA:ADM2:52423323B1907827935694']);
});

test('Tokyo aliases expand only to valid selectable child regions', async () => {
  const catalog = JSON.parse(await readFile(new URL('./data/catalog.json', root)));
  const valid = new Set(catalog.regionIds);
  const result = await resolvePlaces(['Tokyo, JPN'], { baseUrl: embed });
  assert.ok(result.visited.length > 1);
  assert.ok(result.visited.every(id => valid.has(id)));
});

test('comma punctuation and cancellation are preserved through name fetches', async () => {
  const result = await resolvePlaces(['Washington, D.C.'], { baseUrl: embed });
  assert.deepEqual(result.visited, ['USA:ADM2:52423323B55530972166869']);
  const controller = new AbortController(); let received;
  const fetcher = globalThis.fetch;
  globalThis.fetch = async (url, options) => { received = options.signal; return fetcher(url, options); };
  try { await resolvePlaces(['CHN:ADM2:310000'], { baseUrl: embed, signal: controller.signal }); } finally { globalThis.fetch = fetcher; }
  assert.equal(received, controller.signal);
  controller.abort(new Error('cancelled'));
  await assert.rejects(resolvePlaces(['Shanghai'], { baseUrl: embed, signal: controller.signal }), /cancelled/);
});

test('qualified canonical county names resolve and common city groups preserve exact atlas geometry', async () => {
  assert.deepEqual((await resolvePlaces(['Middlesex, Massachusetts, USA'], { baseUrl: embed })).visited, ['USA:ADM2:52423323B1907827935694']);
  for (const code of await readdir(new URL('./data/embed/groups/', root))) {
    const source = JSON.parse(await readFile(new URL(`./data/compiled/countries/${code}.json`, root)));
    const originals = new Map(source.features.map(feature => [feature.id, feature]));
    for (const file of await readdir(new URL(`./data/embed/groups/${code}/`, root))) {
      const group = JSON.parse(await readFile(new URL(`./data/embed/groups/${code}/${file}`, root)));
      assert.deepEqual(group.fingerprint, source.fingerprint);
      assert.equal(new Set(group.features.map(feature => feature.id)).size, group.features.length);
      for (const feature of group.features) assert.deepEqual(feature, originals.get(feature.id));
    }
  }
});

test('compact world retains every country and valid closed paths', async () => {
  const worldText = await readFile(new URL('./data/embed/world.json', root), 'utf8');
  const originalText = await readFile(new URL('./data/compiled/world.json', root), 'utf8');
  const world = JSON.parse(worldText), original = JSON.parse(originalText);
  assert.deepEqual(world.features.map(feature => feature.countryCode), original.features.map(feature => feature.countryCode));
  assert.deepEqual(world.fingerprint, original.fingerprint);
  assert.ok(worldText.length < originalText.length);
  for (const feature of world.features) {
    assert.ok(feature.bounds.every(Number.isFinite));
    for (const [ring] of feature.d.matchAll(/M[^M]+/g)) {
      assert.ok(ring.trim().endsWith('z'));
      assert.ok([...ring.matchAll(/-?\d+/g)].length >= 8);
    }
  }
});


test('name lookup treats slashless base URLs as directories', async () => {
  const result = await resolvePlaces(['CHN:ADM2:310000'], { baseUrl: embed.href.replace(/\/$/, '') });
  assert.deepEqual(result.visited, ['CHN:ADM2:310000']);
});
