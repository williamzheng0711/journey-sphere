import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { decodeOutlinePath } from '../src/outline-detail.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => readFile(path.join(root, file)).then(JSON.parse);
const build = dir => run(process.execPath, [path.join(root, 'scripts/build-outline-fragments.mjs'), '--data-dir', dir]);
const sourceFields = ['format', 'version', 'extent', 'fingerprint'];
const svgRings = feature => decodeOutlinePath(feature).split(' ' + 'M').map((ring, index) => index ? `M${ring}` : ring);

function pointsFor(svg) {
  const commands = [...svg.matchAll(/([Ml])(-?\d+) (-?\d+)/g)];
  let x = 0; let y = 0;
  return commands.map(([command, type, dx, dy]) => {
    if (type === 'M') { x = Number(dx); y = Number(dy); }
    else { x += Number(dx); y += Number(dy); }
    return [x, y];
  });
}
function actualBounds(rings) {
  return rings.flatMap(pointsFor).reduce((bounds, [x, y]) => [Math.min(bounds[0], x), Math.min(bounds[1], y),
    Math.max(bounds[2], x), Math.max(bounds[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
}
function polygonsFor(feature) {
  const polygons = [];
  feature.strokeWidths.forEach((width, index) => {
    if (width === null) polygons.push([]);
    assert.ok(polygons.length, 'a hole follows its exterior');
    polygons.at(-1).push(index);
  });
  return polygons;
}
function metadata(feature) {
  const { paths, bounds, strokeWidths, ...value } = feature;
  return value;
}

test('the five USA fragments preserve every complete polygon, hole, ring policy, and decoded source coordinate exactly once', async () => {
  const [sourceManifest, manifest, provenance, source] = await Promise.all([
    read('data/outlines/manifest.json'), read('data/outlines/fragments/manifest.json'),
    read('data/outlines/fragments/provenance.json'), read('data/outlines/USA.json'),
  ]);
  assert.deepEqual(Object.keys(manifest.countries), ['USA'], 'only the country with useful disjoint-part savings is sharded');
  for (const key of sourceFields) assert.deepEqual(manifest[key], source[key], key);
  assert.equal(provenance.sourceAttribution, '../sources.json');
  assert.equal(provenance.sourceManifestSha256, digest(await readFile(path.join(root, 'data/outlines/manifest.json'))));
  const sourceBytes = await readFile(path.join(root, 'data/outlines/USA.json'));
  const audit = provenance.countrySources.USA;
  assert.equal(manifest.countries.USA.sourceSha256, digest(sourceBytes));
  assert.equal(audit.sha256, digest(sourceBytes));
  const feature = source.features[0];
  const rings = svgRings(feature);
  const polygons = polygonsFor(feature);
  assert.equal(polygons.length, 516); assert.equal(rings.length, 2384);
  assert.equal(audit.polygonCount, polygons.length); assert.equal(audit.ringCount, rings.length);
  const seenPolygons = new Set(); const seenRings = new Set(); const reconstructed = [];
  const parts = sourceManifest.countries.USA.parts;
  const fragments = manifest.countries.USA.fragments;
  assert.deepEqual(fragments.map(fragment => fragment.id), [0, 1, 2, 3, 4]);
  assert.deepEqual(fragments.map(fragment => fragment.bounds), parts, 'stable fragment IDs retain original spatial-part indexes');
  let fragmentBytes = 0;
  for (const fragment of fragments) {
    const bytes = await readFile(path.join(root, 'data/compiled', fragment.file));
    const payload = JSON.parse(bytes); const target = payload.features[0];
    const fragmentAudit = audit.fragments[fragment.id];
    assert.equal(fragment.file, `../outlines/fragments/USA/${fragment.id}.json`);
    assert.equal(fragment.sha256, digest(bytes), 'manifest detects partial or tampered fragments');
    assert.equal(fragmentAudit.sha256, digest(bytes));
    for (const key of sourceFields) assert.deepEqual(payload[key], source[key], key);
    assert.equal(payload.fragment, fragment.id); assert.equal(payload.features.length, 1);
    assert.deepEqual(metadata(target), metadata(feature), 'canonical IDs, names and path format remain unchanged');
    assert.deepEqual(target.bounds, fragment.bounds);
    const targetRings = svgRings(target);
    assert.deepEqual(actualBounds(targetRings), fragment.bounds, 'bounds are the exact union of complete rings');
    const expectedRingIndexes = [];
    for (const [index, polygonIndex] of fragmentAudit.polygonIndices.entries()) {
      assert.ok(!seenPolygons.has(polygonIndex), 'every source polygon has exactly one owner');
      seenPolygons.add(polygonIndex);
      const polygon = polygons[polygonIndex];
      assert.deepEqual(fragmentAudit.ringRanges[index], [polygon[0], polygon.length], 'all holes stay with their original exterior');
      expectedRingIndexes.push(...polygon);
    }
    assert.equal(targetRings.length, expectedRingIndexes.length);
    assert.equal(fragmentAudit.polygonCount, fragmentAudit.polygonIndices.length);
    assert.equal(fragmentAudit.ringCount, expectedRingIndexes.length);
    assert.deepEqual(target.strokeWidths, expectedRingIndexes.map(index => feature.strokeWidths[index]));
    targetRings.forEach((ring, index) => {
      const originalIndex = expectedRingIndexes[index];
      assert.ok(!seenRings.has(originalIndex)); seenRings.add(originalIndex);
      assert.equal(ring, rings[originalIndex], `source ring ${originalIndex} retains its exact closed SVG path`);
      reconstructed[originalIndex] = ring;
    });
    assert.equal(fragmentAudit.gzipBytes, gzipSync(bytes).length);
    fragmentBytes += fragmentAudit.gzipBytes;
  }
  assert.deepEqual([...seenPolygons].sort((a, b) => a - b), polygons.map((polygon, index) => index));
  assert.deepEqual([...seenRings].sort((a, b) => a - b), rings.map((ring, index) => index));
  assert.equal(reconstructed.join(' '), decodeOutlinePath(feature), 'reconstructing original ring order is lossless, including invalid source topology');
  assert.equal(audit.vertices, feature.paths.reduce((total, ring) => total + ring.length / 2, 0));
  assert.equal(audit.sourceGzipBytes, gzipSync(sourceBytes).length);
  assert.ok(fragmentBytes < audit.sourceGzipBytes * 1.02, 'fetching all parts adds less than 2% gzip overhead');
});

function bufferedView(lat, lng, zoom, width = 1200, height = 800, buffer = 512) {
  const extent = 2 ** 24; const scale = extent / (256 * 2 ** zoom);
  const sin = Math.sin(lat * Math.PI / 180);
  const x = (lng + 180) / 360 * extent;
  const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * extent;
  const margin = Math.max(256, width * scale * 0.04, buffer * scale);
  return [x - width * scale / 2 - margin, y - height * scale / 2 - margin,
    x + width * scale / 2 + margin, y + height * scale / 2 + margin];
}
function intersects(bounds, view) {
  if (bounds[3] < view[1] || bounds[1] > view[3]) return false;
  const extent = 2 ** 24;
  for (let offset = Math.floor((view[0] - bounds[2]) / extent); offset <= Math.ceil((view[2] - bounds[0]) / extent); offset++) {
    if (bounds[2] + offset * extent >= view[0] && bounds[0] + offset * extent <= view[2]) return true;
  }
  return false;
}
test('visible USA downloads use lossless buffered fragments while offscreen mobile views request no USA data', async () => {
  const manifest = await read('data/outlines/fragments/manifest.json');
  const audit = (await read('data/outlines/fragments/provenance.json')).countrySources.USA;
  const cases = [
    { name: 'Shanghai default desktop', point: [31.23, 121.47, 4], ids: [0, 1, 3, 4], ratio: 0.45 },
    { name: 'Hong Kong default desktop', point: [22.3, 114.2, 4], ids: [0, 1, 3, 4], ratio: 0.45 },
    { name: 'Shanghai default mobile', point: [31.23, 121.47, 4, 390, 844], ids: [], active: false },
    { name: 'Hong Kong default mobile', point: [22.3, 114.2, 4, 390, 844], ids: [], active: false },
    { name: 'Guam close mobile', point: [13.45, 144.75, 9, 390, 844], ids: [3], ratio: 0.007 },
    { name: 'continental USA close zoom', point: [38, -97, 9], ids: [2], ratio: 0.57 },
    { name: 'Alaska close zoom', point: [61, -150, 7], ids: [0], ratio: 0.41 },
    { name: 'both sides of the antimeridian', point: [52.4, 179.6, 9], ids: [0, 4], ratio: 0.42 },
  ];
  for (const scenario of cases) {
    const [lat, lng, zoom, width = 1200, height = 800] = scenario.point;
    const normalView = bufferedView(lat, lng, zoom, width, height, 0);
    const active = manifest.countries.USA.fragments.some(fragment => intersects(fragment.bounds, normalView));
    assert.equal(active, scenario.active ?? true, `${scenario.name}: country activation uses the ordinary viewport margin`);
    const view = bufferedView(lat, lng, zoom, width, height);
    const buffered = manifest.countries.USA.fragments.filter(fragment => intersects(fragment.bounds, view));
    const required = active ? buffered : [];
    assert.deepEqual(required.map(fragment => fragment.id), scenario.ids, scenario.name);
    const bytes = required.reduce((total, fragment) => total + audit.fragments[fragment.id].gzipBytes, 0);
    if (active) assert.ok(bytes < audit.sourceGzipBytes * scenario.ratio, `${scenario.name}: ${bytes} bytes versus ${audit.sourceGzipBytes}`);
    else {
      assert.ok(buffered.length > 0, 'a distant USA part lies in the tile buffer but cannot activate the country');
      assert.equal(bytes, 0, 'neither whole-country nor fragment data is downloaded for offscreen USA');
    }
  }
});

function encode(rings) {
  let x = 0; let y = 0;
  return rings.map(points => {
    const result = [points[0][0] - x, points[0][1] - y];
    [x, y] = points[0];
    for (let index = 1; index < points.length; index++) result.push(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]);
    return result;
  });
}
const square = (x, y, size) => [[x, y], [x + size, y], [x + size, y + size], [x, y + size]];

test('fragment building groups nonadjacent complete polygons deterministically and preserves invalid topology without repair', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'journeysphere-fragment-test-'));
  try {
    const outlines = path.join(dir, 'outlines'); await mkdir(outlines);
    const identity = { format: 1, version: 'fixture', extent: 2 ** 24, fingerprint: [1, 2] };
    const parts = [[0, 0, 1200, 1000], [5000, 0, 5100, 100]];
    const bounds = [0, 0, 5100, 1000];
    const sourceManifest = { ...identity, countries: { USA: { bounds, parts } } };
    const source = { ...identity, features: [{ id: 'USA:ADM0:USA', name: 'Fixture', countryCode: 'USA', bounds,
      strokeWidths: [null, 40, 0, null, null], pathEncoding: 'relative-delta-v1',
      paths: encode([square(0, 0, 1000), square(100, 100, 200), [[400, 400], [400, 400], [400, 400]],
        [[5000, 0], [5100, 100], [5000, 100], [5100, 0]], square(1100, 0, 100)]) }] };
    const serialize = value => `${JSON.stringify(value)}\n`;
    await writeFile(path.join(outlines, 'manifest.json'), serialize(sourceManifest));
    await writeFile(path.join(outlines, 'USA.json'), serialize(source));
    await build(dir);
    const outputFiles = ['manifest.json', 'provenance.json', 'USA/0.json', 'USA/1.json'];
    const snapshot = () => Promise.all(outputFiles.map(file => readFile(path.join(outlines, 'fragments', file), 'utf8')));
    const first = await snapshot(); await build(dir); assert.deepEqual(await snapshot(), first);
    const generated = first.map(JSON.parse); const audit = generated[1].countrySources.USA;
    assert.deepEqual(audit.fragments.map(fragment => fragment.polygonIndices), [[0, 2], [1]], 'grouping uses whole-polygon spatial containment rather than slicing arrays');
    assert.deepEqual(audit.fragments[0].ringRanges, [[0, 3], [4, 1]]);
    assert.deepEqual(generated[2].features[0].strokeWidths, [null, 40, 0, null], 'normal and degenerate holes stay with their shell');
    const original = svgRings(source.features[0]);
    assert.deepEqual(svgRings(generated[2].features[0]), [original[0], original[1], original[2], original[4]]);
    assert.deepEqual(svgRings(generated[3].features[0]), [original[3]], 'the self-intersecting bowtie remains exact');
    assert.equal(await readFile(path.join(outlines, 'USA.json'), 'utf8'), serialize(source), 'the canonical source is never modified');
    sourceManifest.countries.USA.parts = [bounds, bounds];
    await writeFile(path.join(outlines, 'manifest.json'), serialize(sourceManifest));
    await assert.rejects(build(dir), /exactly one spatial part/);
    assert.deepEqual(await snapshot(), first, 'an ambiguous grouping leaves the previous build intact');
    await writeFile(path.join(outlines, 'manifest.json'), serialize({ ...sourceManifest, countries: { USA: { bounds, parts } } }));
    delete source.features[0].strokeWidths;
    await writeFile(path.join(outlines, 'USA.json'), serialize(source));
    await assert.rejects(build(dir), /stroke-width metadata/);
    assert.deepEqual(await snapshot(), first, 'missing polygon metadata cannot silently split holes away from their shell');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
