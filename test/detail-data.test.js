import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { decodeOutlinePath } from '../src/outline-detail.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);
const build = (dir, source) => run(process.execPath, [
  path.join(root, 'scripts/build-detail-atlas.mjs'), '--data-dir', dir,
  '--source-world', source,
  '--source-url', 'https://example.test/world.geojson', '--source-version', 'fixture',
]);

test('detail builder preserves catalog identity and materially improves HKG geometry', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'journeysphere-detail-'));
  try {
    const catalog = { version: 'fixture', regionIds: ['AAA:ADM0:AAA', 'HKG:ADM0:HKG'], countries: {
      AAA: { source: 'naturalEarth' }, HKG: { source: 'naturalEarth' },
    } };
    const square = { type: 'Feature', properties: { countryCode: 'AAA', name: 'A' }, geometry: {
      type: 'MultiPolygon', coordinates: [-170, -70, 160].map(longitude => [[
        [longitude, 0], [longitude + 1, 0], [longitude + 1, 1], [longitude, 1], [longitude, 0],
      ]]),
    } };
    const ring = Array.from({ length: 1200 }, (_, index) => {
      const angle = index / 1200 * Math.PI * 2;
      return [114.1 + Math.cos(angle) * 0.2, 22.3 + Math.sin(angle) * 0.2];
    });
    ring.push(ring[0]);
    const world = { type: 'FeatureCollection', features: [square, {
      type: 'Feature', properties: { countryCode: 'HKG', name: 'Hong Kong' },
      geometry: { type: 'Polygon', coordinates: [ring] },
    }] };
    await writeFile(path.join(dir, 'catalog.json'), JSON.stringify(catalog));
    const source = path.join(dir, 'world.geojson');
    await writeFile(source, JSON.stringify(world));
    await assert.rejects(run(process.execPath, [path.join(root, 'scripts/build-detail-atlas.mjs'),
      '--data-dir', dir, '--source-world', source, '--source-url', 'https://example.test/world.geojson']),
    /provide --source-url and --source-version/, 'custom provenance cannot silently retain the pinned version');
    await build(dir, source);
    const first = await readFile(path.join(dir, 'outlines/manifest.json'), 'utf8');
    const hkg = JSON.parse(await readFile(path.join(dir, 'outlines/HKG.json'), 'utf8'));
    assert.equal(hkg.features[0].countryCode, 'HKG');
    const hkgPath = decodeOutlinePath(hkg.features[0]);
    assert.equal(hkg.features[0].pathEncoding, 'relative-delta-v1');
    assert.equal(Object.hasOwn(hkg.features[0], 'd'), false);
    assert.ok((hkgPath.match(/[Ml]/g) || []).length > 350);
    assert.ok(Math.max(...hkgPath.split(' M').map(ring => (ring.match(/l/g) || []).length)) > 3,
      'detail must retain the Natural Earth main island contour');
    assert.deepEqual(JSON.parse(first).countries.HKG.regionIds, ['HKG:ADM0:HKG']);
    const islandParts = JSON.parse(first).countries.AAA.parts;
    assert.equal(islandParts.length, 3, 'distant islands stay separate across the date line');
    assert.ok(islandParts.every(bounds => bounds[2] - bounds[0] < 2 ** 24 / 4));
    await build(dir, source);
    assert.equal(await readFile(path.join(dir, 'outlines/manifest.json'), 'utf8'), first);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('generated Natural Earth detail keeps the pinned source and HKG coastline', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'data/outlines/manifest.json'), 'utf8'));
  const sources = JSON.parse(await readFile(path.join(root, 'data/outlines/sources.json'), 'utf8'));
  const hkg = JSON.parse(await readFile(path.join(root, 'data/outlines/HKG.json'), 'utf8')).features[0];
  assert.equal(sources.source.sha256, '239eec57ac17f100a11e2536cffc56752c318b50ae765b0918ff7aab4ce8f255');
  assert.equal(manifest.countries.HKG.regionIds[0], 'HKG:ADM0:HKG');
  const hkgPath = decodeOutlinePath(hkg);
  assert.ok((hkgPath.match(/[Ml]/g) || []).length >= 350);
  assert.ok(Math.max(...hkgPath.split(' M').map(ring => (ring.match(/l/g) || []).length)) > 3);
});

const project = (longitude, latitude, extent) => [
  (longitude + 180) / 360 * extent,
  (1 - Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360)) / Math.PI) * extent / 2,
];
function overlapsViewport(entry, [west, south, east, north], extent) {
  const [left, bottom] = project(west, south, extent);
  const [right, top] = project(east, north, extent);
  return (entry.parts || [entry.bounds]).some(([minX, minY, maxX, maxY]) =>
    [-extent, 0, extent].some(shift => maxX + shift >= left && minX + shift <= right && maxY >= top && minY <= bottom));
}

test('spatial detail bounds exclude unrelated continents while retaining distant country parts', async () => {
  const { countries, extent } = JSON.parse(await readFile(path.join(root, 'data/outlines/manifest.json'), 'utf8'));
  const hongKong = [113, 21.8, 115, 23];
  const london = [-1, 50, 5, 54];
  for (const code of ['USA', 'UMI']) assert.equal(overlapsViewport(countries[code], hongKong, extent), false, `${code} is outside Hong Kong`);
  for (const code of ['USA', 'RUS']) assert.equal(overlapsViewport(countries[code], london, extent), false, `${code} is outside London`);
  for (const [code, box] of [
    ['USA', [-101, 39, -99, 41]], ['USA', [-151, 63, -149, 65]],
    ['USA', [-156, 19, -155, 20]], ['USA', [179, 51, 180, 53]],
    ['RUS', [159, 59, 161, 61]], ['HKG', hongKong],
  ]) assert.equal(overlapsViewport(countries[code], box, extent), true, `${code} must retain ${box.join(',')}`);
});

test('spatial bounds cover every compiled ring and add less than 5 KiB compressed to the initial manifest', async () => {
  const text = await readFile(path.join(root, 'data/compiled/manifest.json'), 'utf8');
  const manifest = JSON.parse(text);
  const withoutParts = structuredClone(manifest);
  const entries = Object.entries(manifest.outlines.countries);
  assert.equal(entries.length, 259);
  for (const [code, entry] of entries) {
    const parts = entry.parts || [entry.bounds];
    assert.ok(parts.length >= 1 && parts.length <= 12, `${code} has a bounded spatial index`);
    for (const part of parts) {
      assert.equal(part.length, 4);
      assert.ok(part.every(Number.isInteger));
      assert.ok(part[0] <= part[2] && part[1] <= part[3]);
    }
    const outline = JSON.parse(await readFile(path.join(root, `data/outlines/${code}.json`), 'utf8')).features[0];
    assert.equal(outline.pathEncoding, 'relative-delta-v1', `${code} uses compact transport`);
    assert.equal(Object.hasOwn(outline, 'd'), false, `${code} does not duplicate its path`);
    const d = decodeOutlinePath(outline);
    assert.match(d, /^(?:M-?\d+ -?\d+(?:l-?\d+ -?\d+){3,}z)(?: M-?\d+ -?\d+(?:l-?\d+ -?\d+){3,}z)*$/);
    if (outline.strokeWidths) {
      assert.equal(outline.strokeWidths.length, (d.match(/M/g) || []).length);
      assert.ok(outline.strokeWidths.every(width => width === null || Number.isInteger(width) && width >= 0));
    }
    for (const ring of d.split(/(?=M)/).filter(Boolean)) {
      let x; let y;
      const ringBounds = [Infinity, Infinity, -Infinity, -Infinity];
      for (const [, command, rawX, rawY] of ring.matchAll(/([Ml])(-?\d+) (-?\d+)/g)) {
        x = command === 'M' ? Number(rawX) : x + Number(rawX);
        y = command === 'M' ? Number(rawY) : y + Number(rawY);
        ringBounds[0] = Math.min(ringBounds[0], x); ringBounds[1] = Math.min(ringBounds[1], y);
        ringBounds[2] = Math.max(ringBounds[2], x); ringBounds[3] = Math.max(ringBounds[3], y);
      }
      assert.ok(parts.some(part => part[0] <= ringBounds[0] && part[1] <= ringBounds[1] &&
        part[2] >= ringBounds[2] && part[3] >= ringBounds[3]), `${code} ring remains completely covered`);
    }
    delete withoutParts.outlines.countries[code].parts;
  }
  const overhead = gzipSync(text).length - gzipSync(`${JSON.stringify(withoutParts)}\n`).length;
  assert.ok(overhead > 0 && overhead <= 5 * 1024, `spatial metadata adds ${overhead} gzip bytes`);
});

function decodeRings(d) {
  return d.split(/(?=M)/).filter(Boolean).map(text => {
    let x; let y;
    return [...text.matchAll(/([Ml])(-?\d+) (-?\d+)/g)].map(([, command, rawX, rawY]) => {
      x = command === 'M' ? Number(rawX) : x + Number(rawX);
      y = command === 'M' ? Number(rawY) : y + Number(rawY);
      return [x, y];
    });
  });
}
function ringContains(ring, [x, y]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if ((ring[i][1] > y) !== (ring[j][1] > y) &&
        x < (ring[j][0] - ring[i][0]) * (y - ring[i][1]) / (ring[j][1] - ring[i][1]) + ring[i][0]) inside = !inside;
  }
  return inside;
}

test('canonical unions align coasts, preserve all hole fills, and retain only unrepresented context', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'journeysphere-aligned-detail-'));
  const rectangle = (left, bottom, right, top) => [[left, bottom], [right, bottom], [right, top], [left, top], [left, bottom]];
  const feature = (code, id, rings) => ({ type: 'Feature', properties: { countryCode: code, id, name: id },
    geometry: { type: 'Polygon', coordinates: rings } });
  try {
    const children = [
      feature('AAA', 'AAA:ADM2:L', [rectangle(0, 0, 1, 3), rectangle(0.2, 0.2, 0.4, 0.4)]),
      feature('AAA', 'AAA:ADM2:B', [rectangle(1, 0, 3, 1)]),
      feature('AAA', 'AAA:ADM2:R', [rectangle(2, 1, 3, 3)]),
      feature('AAA', 'AAA:ADM2:T', [rectangle(1, 2, 2, 3)]),
    ];
    const other = feature('BBB', 'BBB:ADM0:BBB', [rectangle(20, 0, 21, 1)]);
    const catalog = { version: 'fixture', regionIds: [...children.map(f => f.properties.id), other.properties.id], countries: {
      AAA: { source: 'geoBoundaries', file: 'countries/AAA.geojson' },
      BBB: { source: 'naturalEarth' },
    } };
    const context = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { countryCode: 'AAA' },
      geometry: { type: 'MultiPolygon', coordinates: [
        [rectangle(-0.1, -0.1, 3.1, 3.1)], [rectangle(10, 0, 11, 1)], [rectangle(20, 0, 21, 1)],
      ] } }, other] };
    await mkdir(path.join(dir, 'countries'));
    const childText = JSON.stringify({ type: 'FeatureCollection', features: children });
    await writeFile(path.join(dir, 'countries/AAA.geojson'), childText);
    await writeFile(path.join(dir, 'catalog.json'), JSON.stringify(catalog));
    const source = path.join(dir, 'world.geojson');
    await writeFile(source, JSON.stringify(context));
    await build(dir, source);
    const file = path.join(dir, 'outlines/AAA.json');
    const original = await readFile(file, 'utf8');
    const record = JSON.parse(original).features[0];
    const rings = decodeRings(decodeOutlinePath(record));
    const point = (lng, lat) => project(lng, lat, 2 ** 24);
    const contains = (lng, lat) => rings.filter(ring => ringContains(ring, point(lng, lat))).length % 2 === 1;
    assert.equal(contains(0.7, 0.7), true);
    assert.equal(contains(-0.05, 1), false, 'overlapping old coastal fringe is not restored');
    assert.equal(contains(0.3, 0.3), false, 'explicit source hole remains empty');
    assert.equal(contains(1.5, 1.5), false, 'unsupported inter-region gap remains empty');
    assert.equal(contains(10.5, 0.5), true, 'disjoint unrepresented context remains');
    assert.equal(contains(20.5, 0.5), false, 'separate atlas entity is not redrawn under AAA');
    const sourceHole = rings.findIndex((ring, index) => record.strokeWidths[index] !== null && ringContains(ring, point(0.3, 0.3)));
    const inferredGap = rings.findIndex((ring, index) => record.strokeWidths[index] !== null && ringContains(ring, point(1.5, 1.5)));
    assert.ok(record.strokeWidths[sourceHole] > 0, 'explicit hole retains a resolvable outline');
    assert.equal(record.strokeWidths[inferredGap], 0, 'gap does not acquire an inferred geographic outline');
    const sources = JSON.parse(await readFile(path.join(dir, 'outlines/sources.json'), 'utf8'));
    assert.equal(sources.countrySources.AAA.sha256, createHash('sha256').update(childText).digest('hex'));
    assert.deepEqual(sources.countrySources.AAA.context.retainedPolygons, [1]);
    assert.deepEqual(sources.countrySources.AAA.context.excludedPolygons, [{ index: 2, representedBy: ['BBB'] }]);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'outlines/manifest.json'), 'utf8')).countries.AAA.regionIds, []);
    await build(dir, source);
    assert.equal(await readFile(file, 'utf8'), original, 'aligned build is deterministic');
    await writeFile(path.join(dir, 'countries/AAA.geojson'), JSON.stringify({ features: [] }));
    await assert.rejects(build(dir, source), /Empty canonical regions/);
    assert.equal(await readFile(file, 'utf8'), original, 'failed union leaves the previous atlas intact');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('aligned country provenance identifies canonical inputs and preserves separate atlas entities', async () => {
  const sources = JSON.parse(await readFile(path.join(root, 'data/outlines/sources.json'), 'utf8'));
  const catalog = JSON.parse(await readFile(path.join(root, 'data/catalog.json'), 'utf8'));
  assert.equal(Object.keys(sources.countrySources).length, Object.keys(catalog.countries).length);
  for (const [code, entry] of Object.entries(catalog.countries)) {
    const provenance = sources.countrySources[code];
    if (entry.source === 'naturalEarth' || !entry.file) continue;
    assert.equal(provenance.kind, 'canonical-region-union');
    assert.equal(provenance.source, entry.source);
    assert.equal(provenance.file, entry.file);
    const bytes = await readFile(path.join(root, 'data', entry.file));
    assert.equal(provenance.sha256, createHash('sha256').update(bytes).digest('hex'), `${code} source hash`);
    assert.match(provenance.interiorStrokePolicy, /explicit child/);
  }
  assert.deepEqual(sources.countrySources.FRA.context.retainedPolygons, []);
  for (const code of ['GUF', 'GLP', 'MTQ', 'MYT', 'REU']) {
    assert.ok(sources.countrySources.FRA.context.excludedPolygons.some(item => item.representedBy.includes(code)), code);
  }
  assert.equal(sources.countrySources.NOR.context.retainedPolygons.length, 24, 'unrepresented northern islands remain contextual land');
  assert.ok(sources.countrySources.NLD.context.excludedPolygons.some(item => item.representedBy.includes('BES')));
});
