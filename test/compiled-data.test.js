import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describeCatalog } from '../src/state.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = file => readFile(path.join(root, 'data/compiled', file), 'utf8').then(JSON.parse);
const run = promisify(execFile);
const build = dir => run(process.execPath, [path.join(root, 'scripts/build-compiled-atlas.mjs'), '--data-dir', dir]);

function vertices(d) {
  const points = [];
  let x = 0, y = 0;
  for (const [, command, a, b] of d.matchAll(/([Ml])(-?\d+) (-?\d+)/g)) {
    x = command === 'M' ? Number(a) : x + Number(a);
    y = command === 'M' ? Number(b) : y + Number(b);
    points.push([x, y]);
  }
  return points;
}

function assertBounds(record) {
  const points = vertices(record.d);
  const bounds = points.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
  assert.deepEqual(record.bounds, bounds, record.id);
}

test('compiled atlas identity and every country index match the source catalog', async () => {
  const manifest = await read('manifest.json');
  const catalog = JSON.parse(await readFile(path.join(root, 'data/catalog.json')));
  const { version, regionCount, fingerprint } = manifest;
  assert.deepEqual({ version, regionCount, fingerprint }, describeCatalog(catalog));
  assert.equal(manifest.format, 1);
  assert.equal(manifest.extent, 2 ** 24);
  const world = await read('world.json');
  assert.deepEqual(world.fingerprint, manifest.fingerprint);
  assert.equal(world.features.length, 259);
  for (const record of world.features) assertBounds(record);
  let count = 0;
  for (const [code, entry] of Object.entries(manifest.countries)) {
    if (!entry.file) { assert.equal(entry.count, 0); continue; }
    const country = await read(entry.file);
    assert.deepEqual(country.fingerprint, manifest.fingerprint);
    assert.equal(country.features.length, entry.count);
    for (const [offset, record] of country.features.entries()) {
      assert.equal(record.index, entry.start + offset);
      assert.equal(catalog.regionIds[record.index], record.id);
      assert.equal(record.countryCode, code);
      assert.match(record.d, /^M-?\d+ -?\d+(?:l-?\d+ -?\d+)*z(?: M-?\d+ -?\d+(?:l-?\d+ -?\d+)*z)*$/);
      count++;
    }
  }
  assert.equal(count, catalog.regionIds.length);
});

test('builder is deterministic, sorts by catalog index, preserves holes and absolute bounds', async () => {
  const dir = await fixture();
  try {
    await build(dir);
    const files = ['manifest.json', 'manifest.js', 'world.json', 'countries/AAA.json'];
    const contents = () => Promise.all(files.map(file => readFile(path.join(dir, 'compiled', file), 'utf8')));
    const first = await contents();
    await build(dir);
    assert.deepEqual(await contents(), first);
    const country = JSON.parse(first[3]);
    assert.deepEqual(country.features.map(record => record.id), ['AAA:r1', 'AAA:r2']);
    assert.deepEqual(country.features.map(record => record.index), [0, 1]);
    for (const record of [...country.features, ...country.admin1]) assertBounds(record);
    assert.equal((country.features[0].d.match(/M/g) || []).length, 2, 'Region hole remains a separate ring');
    assert.equal((country.admin1[0].d.match(/M/g) || []).length, 1, 'Parent outline omits internal holes');
    assert.deepEqual(vertices(country.features[0].d)[0], [2 ** 23, 2 ** 23], 'Origin projects to world center');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('invalid region input fails without replacing the previous compiled atlas', async () => {
  const dir = await fixture();
  try {
    await build(dir);
    const output = path.join(dir, 'compiled/countries/AAA.json');
    const before = await readFile(output, 'utf8');
    const shardPath = path.join(dir, 'countries/AAA.json');
    const shard = JSON.parse(await readFile(shardPath, 'utf8'));
    shard.features[0].properties.id = 'AAA:unknown';
    await writeFile(shardPath, JSON.stringify(shard));
    await assert.rejects(build(dir), /Invalid or duplicate catalog region/);
    assert.equal(await readFile(output, 'utf8'), before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a valid compact outline tier is published alongside exact geometry and catalog identity', async () => {
  const dir = await fixture();
  try {
    const { exact, overview } = await outlineFixture(dir);
    await build(dir);
    const compiled = JSON.parse(await readFile(path.join(dir, 'compiled/manifest.json'), 'utf8'));
    assert.deepEqual(compiled.outlines, {
      ...exact, minZoom: overview.minZoom, detailZoom: overview.detailZoom,
      countries: { AAA: { ...exact.countries.AAA, overviewFile: overview.countries.AAA.file } },
    });
    assert.equal(compiled.regionCount, 2);
    assert.deepEqual(compiled.fingerprint, exact.fingerprint);
    const first = await readFile(path.join(dir, 'compiled/manifest.js'), 'utf8');
    await build(dir);
    assert.equal(await readFile(path.join(dir, 'compiled/manifest.js'), 'utf8'), first, 'the combined manifest is deterministic');
    await writeFile(path.join(dir, 'outlines/overview/AAA.json'), await readFile(path.join(dir, 'outlines/AAA.json')));
    await build(dir);
    const fallback = JSON.parse(await readFile(path.join(dir, 'compiled/manifest.json'), 'utf8'));
    assert.equal(fallback.outlines.countries.AAA.overviewFile, fallback.outlines.countries.AAA.file,
      'an unchanged safe fallback shares the exact URL instead of downloading duplicate data');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('invalid, incomplete, or stale outline tiers leave every previous compiled file intact', async () => {
  const dir = await fixture();
  const emitted = ['manifest.json', 'manifest.js', 'world.json', 'countries/AAA.json'];
  const snapshot = () => Promise.all(emitted.map(file => readFile(path.join(dir, 'compiled', file), 'utf8')));
  try {
    await build(dir);
    const previous = await snapshot();
    const overviewManifest = path.join(dir, 'outlines/overview/manifest.json');
    const overviewData = path.join(dir, 'outlines/overview/AAA.json');
    const write = (file, value) => writeFile(file, JSON.stringify(value));
    const cases = [
      { name: 'manifest identity', pattern: /Overview outline manifest does not match/,
        corrupt: async ({ overview }) => write(overviewManifest, { ...overview, fingerprint: [0, 0] }) },
      { name: 'payload identity', pattern: /Overview outline data does not match/,
        corrupt: async ({ payload }) => write(overviewData, { ...payload, version: 'older-atlas' }) },
      { name: 'missing payload', pattern: /ENOENT/,
        corrupt: async () => rm(overviewData) },
      { name: 'stale source hash', pattern: /Overview outline is stale/,
        corrupt: async ({ payload }) => write(path.join(dir, 'outlines/AAA.json'), { ...payload, revision: 'changed-coastline' }) },
      { name: 'invalid asset path', pattern: /Invalid overview outline path/,
        corrupt: async ({ overview }) => write(overviewManifest, { ...overview,
          countries: { AAA: { ...overview.countries.AAA, file: '../outside.json' } } }) },
    ];
    for (const candidate of cases) {
      const tier = await outlineFixture(dir);
      await candidate.corrupt(tier);
      await assert.rejects(build(dir), candidate.pattern, candidate.name);
      assert.deepEqual(await snapshot(), previous, `${candidate.name} must not partially replace the working atlas`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function outlineFixture(dir) {
  const catalog = JSON.parse(await readFile(path.join(dir, 'catalog.json'), 'utf8'));
  const identity = describeCatalog(catalog);
  const envelope = { format: 1, version: identity.version, extent: 2 ** 24, fingerprint: identity.fingerprint };
  const bounds = [0, 0, 10, 10];
  const exact = { ...envelope, minZoom: 6, countries: {
    AAA: { file: '../outlines/AAA.json', bounds, parts: [bounds], regionIds: [] },
  } };
  const payload = { ...envelope, features: [{ countryCode: 'AAA', bounds,
    pathEncoding: 'relative-delta-v1', paths: [[0, 0, 10, 0, 0, 10]], strokeWidths: [null] }] };
  const source = { ...payload, features: [{ ...payload.features[0], paths: [[0, 0, 10, 0, 0, 10, -10, 0]] }] };
  const sourceText = JSON.stringify(source);
  const overview = { ...envelope, minZoom: 4, detailZoom: 6, countries: {
    AAA: { file: '../outlines/overview/AAA.json', sourceSha256: createHash('sha256').update(sourceText).digest('hex') },
  } };
  await mkdir(path.join(dir, 'outlines/overview'), { recursive: true });
  await Promise.all([
    writeFile(path.join(dir, 'outlines/manifest.json'), JSON.stringify(exact)),
    writeFile(path.join(dir, 'outlines/AAA.json'), sourceText),
    writeFile(path.join(dir, 'outlines/overview/manifest.json'), JSON.stringify(overview)),
    writeFile(path.join(dir, 'outlines/overview/AAA.json'), JSON.stringify(payload)),
  ]);
  return { exact, overview, payload };
}

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'journeysphere-compiled-'));
  await mkdir(path.join(dir, 'countries'));
  const rings = [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]], [[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]];
  const feature = id => ({ type: 'Feature', properties: { id, name: id, countryCode: 'AAA', parentId: 'AAA:p' }, geometry: { type: 'Polygon', coordinates: rings } });
  const files = {
    'catalog.json': { version: 'fixture-1', regionIds: ['AAA:r1', 'AAA:r2'], countries: { AAA: { file: 'countries/AAA.json' }, BBB: { file: null } } },
    'palette.json': { countries: { AAA: { color: '#123456' } } },
    'world.geojson': { type: 'FeatureCollection', features: [feature('AAA')] },
    'countries/AAA.json': { type: 'FeatureCollection', features: [feature('AAA:r2'), feature('AAA:r1')], admin1: { features: [feature('AAA:p')] } },
  };
  await Promise.all(Object.entries(files).map(([file, value]) => writeFile(path.join(dir, file), JSON.stringify(value))));
  return dir;
}
