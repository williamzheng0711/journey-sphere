import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { decodeOutlinePath } from '../src/outline-detail.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = file => readFile(path.join(root, file), 'utf8').then(JSON.parse);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const python = process.env.JOURNEY_SPHERE_PYTHON || 'python3';
const hasShapely = spawnSync(python, ['-c', 'import shapely; assert int(shapely.__version__.split(".")[0]) >= 2']).status === 0;
const run = promisify(execFile);
const build = dir => run(process.execPath, [path.join(root, 'scripts/build-outline-overview.mjs'), '--data-dir', dir, '--python', python]);

function ringsFor(feature) {
  let originX = 0; let originY = 0;
  return feature.paths.map(path => {
    originX += path[0]; originY += path[1];
    let x = originX; let y = originY;
    const ring = [[x, y]];
    for (let index = 2; index < path.length; index += 2) {
      x += path[index]; y += path[index + 1]; ring.push([x, y]);
    }
    ring.push([...ring[0]]);
    return ring;
  });
}
const samePoint = (a, b) => a[0] === b[0] && a[1] === b[1];
function openRing(ring) {
  const points = ring.slice(0, -1).filter((point, index) => index === 0 || !samePoint(point, ring[index - 1]));
  while (points.length > 1 && samePoint(points.at(-1), points[0])) points.pop();
  return points;
}

function assertDisplacement(source, outline, tolerance, label) {
  if (JSON.stringify(source) === JSON.stringify(outline)) return;
  const original = openRing(source);
  const points = openRing(outline);
  const sourceIndices = new Map(original.map((point, index) => [point.join(','), index]));
  const kept = points.map(point => {
    assert.ok(sourceIndices.has(point.join(',')), `${label} uses original integer vertices`);
    return sourceIndices.get(point.join(','));
  });
  assert.ok(kept.length >= 3, `${label} keeps a complete island or hole`);
  const start = kept.indexOf(Math.min(...kept));
  const ordered = [...kept.slice(start), ...kept.slice(0, start)];
  assert.deepEqual(ordered, [...ordered].sort((a, b) => a - b), `${label} preserves circular order`);
  const count = original.length;
  for (let index = 0; index < ordered.length; index++) {
    const left = ordered[index];
    const right = ordered[(index + 1) % ordered.length] + (index === ordered.length - 1 ? count : 0);
    const a = original[left]; const b = original[right % count];
    const dx = b[0] - a[0]; const dy = b[1] - a[1]; const length = dx * dx + dy * dy;
    for (let current = left + 1; current < right; current++) {
      const point = original[current % count];
      const fraction = length ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length)) : 0;
      const error = Math.hypot(point[0] - a[0] - fraction * dx, point[1] - a[1] - fraction * dy);
      assert.ok(error <= tolerance + 1e-6, `${label} displaces a vertex by ${error} grid units`);
    }
  }
}

test('all 259 regional outlines retain exact identity, islands, holes, spatial bounds, and source attribution', async () => {
  const [exactManifest, manifest, provenance] = await Promise.all([
    read('data/outlines/manifest.json'), read('data/outlines/overview/manifest.json'), read('data/outlines/overview/provenance.json'),
  ]);
  assert.equal(manifest.minZoom, 4); assert.equal(manifest.detailZoom, 6); assert.equal(manifest.tolerance, 700);
  assert.deepEqual(Object.keys(manifest.countries).sort(), Object.keys(exactManifest.countries).sort());
  assert.equal(Object.keys(manifest.countries).length, 259);
  assert.equal(provenance.sourceAttribution, '../sources.json');
  assert.equal(provenance.sourceManifestSha256, digest(await readFile(path.join(root, 'data/outlines/manifest.json'))));
  let exactBytes = 0; let regionalBytes = 0; let rings = 0;
  for (const [code, entry] of Object.entries(manifest.countries)) {
    const [sourceText, regionalText] = await Promise.all([
      readFile(path.join(root, `data/outlines/${code}.json`)), readFile(path.join(root, `data/outlines/overview/${code}.json`)),
    ]);
    const exact = JSON.parse(sourceText); const regional = JSON.parse(regionalText);
    const source = exact.features[0]; const target = regional.features[0];
    for (const key of ['format', 'version', 'extent', 'fingerprint']) assert.deepEqual(regional[key], exact[key], `${code} ${key}`);
    const { paths: sourcePaths, ...sourceMetadata } = source;
    const { paths: targetPaths, ...targetMetadata } = target;
    assert.deepEqual(targetMetadata, sourceMetadata, `${code} IDs, bounds, and stroke policies are preserved`);
    assert.equal(entry.file, `../outlines/overview/${code}.json`);
    assert.equal(entry.sourceSha256, digest(sourceText), `${code} manifest rejects stale source geometry`);
    assert.equal(provenance.countries[code].sha256, digest(sourceText));
    assert.equal(provenance.countries[code].outputSha256, digest(regionalText));
    assert.equal(targetPaths.length, sourcePaths.length, `${code} retains every island and hole`);
    assert.match(decodeOutlinePath(target), /^(?:M-?\d+ -?\d+(?:l-?\d+ -?\d+){3,}z)(?: M-?\d+ -?\d+(?:l-?\d+ -?\d+){3,}z)*$/);
    const sourceRings = ringsFor(source); const targetRings = ringsFor(target);
    const parts = exactManifest.countries[code].parts || [source.bounds];
    for (const [index, ring] of targetRings.entries()) {
      const bounds = ring.reduce((a, [x, y]) => [Math.min(a[0], x), Math.min(a[1], y), Math.max(a[2], x), Math.max(a[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
      assert.ok(parts.some(part => part[0] <= bounds[0] && part[1] <= bounds[1] && part[2] >= bounds[2] && part[3] >= bounds[3]), `${code} ring stays in the original spatial index`);
      if (new Set(sourceRings[index].map(point => point.join(','))).size < 3) assert.deepEqual(ring, sourceRings[index], `${code} degenerate source ring is retained exactly`);
      else assert.ok(new Set(ring.map(point => point.join(','))).size >= 3, `${code} tiny island or hole remains`);
    }
    if (provenance.countries[code].mode.startsWith('exact-')) assert.deepEqual(regional, exact, `${code} fallback preserves source topology exactly`);
    exactBytes += gzipSync(sourceText).length; regionalBytes += gzipSync(regionalText).length; rings += targetPaths.length;
  }
  assert.equal(rings, 109904, 'the complete shipped island and hole catalog remains present');
  assert.ok(regionalBytes < exactBytes * 0.8, `regional tier uses ${regionalBytes} gzip bytes vs ${exactBytes} exact bytes`);
});

test('every shipped regional ring has independently bounded subpixel displacement through zoom 5', async () => {
  const manifest = await read('data/outlines/overview/manifest.json');
  assert.ok(manifest.tolerance * 256 * 2 ** 5 / manifest.extent < 0.35, 'maximum error is less than 0.35 CSS pixels at zoom 5');
  for (const code of Object.keys(manifest.countries)) {
    const [source, target] = await Promise.all([read(`data/outlines/${code}.json`), read(`data/outlines/overview/${code}.json`)]);
    const original = ringsFor(source.features[0]); const simplified = ringsFor(target.features[0]);
    for (let index = 0; index < original.length; index++) assertDisplacement(original[index], simplified[index], manifest.tolerance, `${code} ring ${index}`);
  }
  const hkg = (await read('data/outlines/overview/HKG.json')).features[0];
  assert.ok(hkg.paths.reduce((total, ring) => total + ring.length / 2, 0) > 50, 'regional Hong Kong retains coastline detail beyond the old 25-point outline');
});

test('smaller tolerance retries recover valid complex coasts without changing the error cap or repairing invalid sources', async () => {
  const provenance = await read('data/outlines/overview/provenance.json');
  assert.deepEqual(provenance.retryToleranceFactors, [1, 0.5, 0.25, 0.125]);
  for (const code of ['NOR', 'PHL', 'RUS']) {
    const audit = provenance.countries[code];
    assert.equal(audit.mode, 'topology-preserving', `${code} no longer retains the whole country after a ring conflict`);
    assert.equal(audit.attemptCount, 2);
    assert.equal(audit.simplificationTolerance, 350);
    assert.deepEqual(audit.attempts.map(attempt => attempt.tolerance), [700, 350]);
    assert.equal(audit.attempts[0].mode, 'exact-topology-fallback');
    assert.equal(audit.attempts[1].mode, 'topology-preserving');
    assert.ok(audit.maxError <= provenance.tolerance);
    const [source, regional] = await Promise.all([
      readFile(path.join(root, `data/outlines/${code}.json`)), readFile(path.join(root, `data/outlines/overview/${code}.json`)),
    ]);
    assert.ok(gzipSync(regional).length < gzipSync(source).length * 0.7, `${code} retry materially reduces detail bytes`);
  }
  for (const code of ['CHN', 'JPN', 'USA']) {
    const audit = provenance.countries[code];
    assert.equal(audit.mode, 'exact-invalid-source');
    assert.equal(audit.attemptCount, 1, `${code} authoritative invalid geometry is never repaired or retried`);
    assert.equal(audit.sha256, audit.outputSha256);
  }
});

const topologyAudit = String.raw`
import json, pathlib, sys
from shapely.geometry import Polygon, MultiPolygon
root = pathlib.Path(sys.argv[1])
def geometry(record):
    polygons = []
    ox = oy = 0
    widths = record.get('strokeWidths')
    for index, path in enumerate(record['paths']):
        ox += path[0]; oy += path[1]
        x, y = ox, oy
        ring = [(x, y)]
        for offset in range(2, len(path), 2):
            x += path[offset]; y += path[offset + 1]
            ring.append((x, y))
        ring.append(ring[0])
        if widths is None or widths[index] is None: polygons.append([ring, []])
        else: polygons[-1][1].append(ring)
    return MultiPolygon([Polygon(outer, [hole for hole in holes if len(set(hole)) >= 3]) for outer, holes in polygons if len(set(outer)) >= 3])
manifest = json.loads((root / 'overview/manifest.json').read_text())
for code in manifest['countries']:
    exact = json.loads((root / (code + '.json')).read_text())['features'][0]
    overview = json.loads((root / 'overview' / (code + '.json')).read_text())['features'][0]
    a, b = geometry(exact), geometry(overview)
    if a.is_valid:
        assert b.is_valid, code + ': introduced an invalid polygon or ring intersection'
        assert len(a.geoms) == len(b.geoms), code + ': lost an island'
        assert [len(poly.interiors) for poly in a.geoms] == [len(poly.interiors) for poly in b.geoms], code + ': lost or moved a hole'
    else:
        assert exact == overview, code + ': modified invalid authoritative source geometry'
print('Validated topology for all ' + str(len(manifest['countries'])) + ' countries.')
`;

test('independent GEOS audit confirms every valid country stays valid and invalid sources remain exact', { skip: !hasShapely && 'Build-time topology audit requires Python with Shapely 2.x.' }, async () => {
  const { stdout } = await run(python, ['-c', topologyAudit, path.join(root, 'data/outlines')]);
  assert.match(stdout, /Validated topology for all 259 countries/);
});

test('regional builder is deterministic, keeps unsupported holes and tiny islands, and falls back on invalid input', { skip: !hasShapely && 'Builder requires Python with Shapely 2.x.' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'journeysphere-overview-'));
  const circle = (x, y, radius) => {
    const points = Array.from({ length: 180 }, (_, index) => {
      const angle = index / 180 * 2 * Math.PI;
      return [Math.round(x + Math.cos(angle) * radius), Math.round(y + Math.sin(angle) * radius)];
    });
    points.push(points[0]); return points;
  };
  const rectangle = (x, y, width) => [[x, y], [x + width, y], [x + width, y + width], [x, y + width], [x, y]];
  const encode = rings => {
    let x = 0; let y = 0;
    return rings.map(ring => {
      const points = [ring[0][0] - x, ring[0][1] - y]; [x, y] = ring[0];
      for (let index = 1; index < ring.length - 1; index++) points.push(ring[index][0] - ring[index - 1][0], ring[index][1] - ring[index - 1][1]);
      return points;
    });
  };
  try {
    await mkdir(path.join(dir, 'outlines'));
    const identity = { format: 1, version: 'fixture', extent: 2 ** 24, fingerprint: [0, 1] };
    const aRings = [circle(0, 0, 10000), circle(1000, 1000, 1500), rectangle(-3000, -1000, 30), rectangle(20000, 0, 10)];
    const bRings = [[[-10, -10], [10, 10], [-10, 10], [10, -10], [-10, -10]]];
    const a = { id: 'AAA:ADM0:AAA', name: 'A', countryCode: 'AAA', bounds: [-10000, -10000, 20010, 10000], strokeWidths: [null, 1500, 0, null], pathEncoding: 'relative-delta-v1', paths: encode(aRings) };
    const b = { id: 'BBB:ADM0:BBB', name: 'B', countryCode: 'BBB', bounds: [-10, -10, 10, 10], pathEncoding: 'relative-delta-v1', paths: encode(bRings) };
    await writeFile(path.join(dir, 'outlines/manifest.json'), JSON.stringify({ ...identity, minZoom: 6, countries: { AAA: { file: '../outlines/AAA.json', bounds: a.bounds }, BBB: { file: '../outlines/BBB.json', bounds: b.bounds } } }));
    await writeFile(path.join(dir, 'outlines/AAA.json'), JSON.stringify({ ...identity, features: [a] }));
    await writeFile(path.join(dir, 'outlines/BBB.json'), JSON.stringify({ ...identity, features: [b] }));
    await build(dir);
    const files = ['AAA.json', 'BBB.json', 'manifest.json', 'provenance.json'];
    const contents = () => Promise.all(files.map(file => readFile(path.join(dir, 'outlines/overview', file), 'utf8')));
    const first = await contents();
    await build(dir);
    assert.deepEqual(await contents(), first);
    const targetA = JSON.parse(first[0]).features[0];
    assert.equal(targetA.paths.length, 4); assert.deepEqual(targetA.strokeWidths, a.strokeWidths);
    assert.ok(targetA.paths[0].length < a.paths[0].length / 2, 'main coastline is materially simplified');
    for (const [index, ring] of ringsFor(targetA).entries()) assertDisplacement(aRings[index], ring, 700, `fixture ring ${index}`);
    assert.deepEqual(JSON.parse(first[1]).features[0], b, 'invalid source is never repaired or simplified');
    assert.equal(JSON.parse(first[3]).countries.BBB.mode, 'exact-invalid-source');
    const before = first[0];
    await writeFile(path.join(dir, 'outlines/AAA.json'), '{}');
    await assert.rejects(build(dir), /Exact outline identity mismatch/);
    assert.equal(await readFile(path.join(dir, 'outlines/overview/AAA.json'), 'utf8'), before, 'failed rebuild preserves the complete previous tier');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
