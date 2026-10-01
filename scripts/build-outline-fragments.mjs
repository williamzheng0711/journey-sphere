#!/usr/bin/env node

// Split complete polygons into the already indexed, disjoint country parts.
// Every exterior and all of its holes stay together. No clipping, coordinate
// changes, geometry repair, or additional simplification occurs here.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}
const dataDir = path.resolve(argument('--data-dir') || path.join(root, 'data'));
const codes = [...new Set((argument('--countries') || 'USA').split(','))].sort();
if (!codes.length || codes.some(code => !/^[A-Z]{3}$/.test(code))) throw new Error('--countries requires comma-separated ISO3 codes.');
const sourceDir = path.join(dataDir, 'outlines');
const outputDir = path.join(sourceDir, 'fragments');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const serialize = value => `${JSON.stringify(value)}\n`;
const mergeBounds = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const combineBounds = boxes => boxes.reduce(mergeBounds, [Infinity, Infinity, -Infinity, -Infinity]);
const contains = (outer, inner) => outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
const validBounds = bounds => Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isSafeInteger) && bounds[0] <= bounds[2] && bounds[1] <= bounds[3];
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function decodeRings(feature) {
  if (feature.pathEncoding !== 'relative-delta-v1' || !Array.isArray(feature.paths) || !feature.paths.length || Object.hasOwn(feature, 'd')) {
    throw new Error('Fragment build requires relative-delta-v1 exact outlines.');
  }
  // The source marks exteriors with null and holes with a numeric width. Without
  // that policy the transport alone cannot identify complete polygons safely.
  if (!Array.isArray(feature.strokeWidths) || feature.strokeWidths.length !== feature.paths.length ||
    !feature.strokeWidths.every(width => width === null || (Number.isSafeInteger(width) && width >= 0))) {
    throw new Error('Invalid source stroke-width metadata.');
  }
  let originX = 0; let originY = 0;
  return feature.paths.map((values, index) => {
    if (!Array.isArray(values) || values.length < 6 || values.length % 2 || !values.every(Number.isSafeInteger)) throw new Error('Invalid source ring transport.');
    originX += values[0]; originY += values[1];
    let x = originX; let y = originY;
    const points = [[x, y]];
    for (let offset = 2; offset < values.length; offset += 2) {
      x += values[offset]; y += values[offset + 1]; points.push([x, y]);
    }
    if (!points.every(point => point.every(Number.isSafeInteger))) throw new Error('Invalid absolute source coordinates.');
    const bounds = combineBounds(points.map(([x, y]) => [x, y, x, y]));
    return { index, values, origin: [originX, originY], points, bounds, width: feature.strokeWidths?.[index] ?? null };
  });
}

function polygonsFor(feature) {
  const polygons = [];
  for (const ring of decodeRings(feature)) {
    if (ring.width === null) polygons.push({ index: polygons.length, rings: [] });
    if (!polygons.length) throw new Error('Source hole has no exterior ring.');
    polygons.at(-1).rings.push(ring);
  }
  return polygons.map(polygon => ({ ...polygon, bounds: combineBounds(polygon.rings.map(ring => ring.bounds)) }));
}

function encodeRings(rings) {
  let originX = 0; let originY = 0;
  return rings.map(ring => {
    const values = [ring.origin[0] - originX, ring.origin[1] - originY, ...ring.values.slice(2)];
    [originX, originY] = ring.origin;
    return values;
  });
}

const sourceManifestText = await readFile(path.join(sourceDir, 'manifest.json'));
const sourceManifest = JSON.parse(sourceManifestText);
if (sourceManifest.format !== 1 || sourceManifest.extent !== 2 ** 24 || !Array.isArray(sourceManifest.fingerprint) || !sourceManifest.countries) {
  throw new Error('Invalid source outline manifest.');
}
const identity = Object.fromEntries(['format', 'version', 'extent', 'fingerprint'].map(key => [key, sourceManifest[key]]));
const staging = await mkdtemp(path.join(sourceDir, '.fragments-'));
try {
  const countries = {};
  const countrySources = {};
  let sourceGzipBytes = 0; let fragmentGzipBytes = 0; let fragmentCount = 0;
  for (const code of codes) {
    const entry = sourceManifest.countries[code];
    if (!entry || !Array.isArray(entry.parts) || entry.parts.length < 2 || !entry.parts.every(validBounds)) {
      throw new Error(`Country ${code} needs at least two valid existing spatial parts.`);
    }
    const sourceText = await readFile(path.join(sourceDir, `${code}.json`));
    const source = JSON.parse(sourceText);
    for (const key of Object.keys(identity)) if (!equal(source[key], identity[key])) throw new Error(`Source outline identity mismatch for ${code}.`);
    if (!Array.isArray(source.features) || source.features.length !== 1) throw new Error(`Invalid source feature count for ${code}.`);
    const feature = source.features[0];
    if (feature.countryCode !== code || !validBounds(feature.bounds) || !equal(feature.bounds, entry.bounds)) {
      throw new Error(`Source outline geometry mismatch for ${code}.`);
    }
    const polygons = polygonsFor(feature);
    if (!equal(combineBounds(polygons.map(polygon => polygon.bounds)), feature.bounds)) throw new Error(`Source bounds do not cover exact rings for ${code}.`);
    const groups = entry.parts.map(() => []);
    for (const polygon of polygons) {
      const containing = entry.parts.flatMap((bounds, index) => contains(bounds, polygon.bounds) ? [index] : []);
      if (containing.length !== 1) throw new Error(`Polygon ${polygon.index} in ${code} must belong to exactly one spatial part; found ${containing.length}.`);
      groups[containing[0]].push(polygon);
    }
    await mkdir(path.join(staging, code));
    const sourceSha256 = digest(sourceText);
    const fragments = [];
    const audits = [];
    for (const [id, group] of groups.entries()) {
      if (!group.length) throw new Error(`Empty spatial part ${id} for ${code}.`);
      const bounds = combineBounds(group.map(polygon => polygon.bounds));
      if (!equal(bounds, entry.parts[id])) throw new Error(`Spatial part ${id} does not match its whole-polygon coverage for ${code}.`);
      const rings = group.flatMap(polygon => polygon.rings);
      const record = { ...feature, bounds, paths: encodeRings(rings),
        ...(feature.strokeWidths ? { strokeWidths: rings.map(ring => ring.width) } : {}) };
      const payload = { ...source, fragment: id, features: [record] };
      const body = serialize(payload);
      const decoded = decodeRings(record);
      if (decoded.length !== rings.length || decoded.some((ring, index) => !equal(ring.points, rings[index].points) || ring.width !== rings[index].width)) {
        throw new Error(`Fragment ${id} failed exact coordinate verification for ${code}.`);
      }
      await writeFile(path.join(staging, code, `${id}.json`), body);
      const file = `../outlines/fragments/${code}/${id}.json`;
      const gzipBytes = gzipSync(body).length;
      fragments.push({ id, file, bounds, sha256: digest(body) });
      audits.push({ id, file, bounds, sha256: digest(body), gzipBytes,
        polygonIndices: group.map(polygon => polygon.index),
        ringRanges: group.map(polygon => [polygon.rings[0].index, polygon.rings.length]),
        polygonCount: group.length, ringCount: rings.length,
        vertices: rings.reduce((count, ring) => count + ring.values.length / 2, 0) });
      fragmentGzipBytes += gzipBytes; fragmentCount++;
    }
    countries[code] = { sourceSha256, fragments };
    countrySources[code] = { source: `../${code}.json`, sha256: sourceSha256, bounds: feature.bounds,
      sourceGzipBytes: gzipSync(sourceText).length, polygonCount: polygons.length, ringCount: feature.paths.length,
      vertices: feature.paths.reduce((count, ring) => count + ring.length / 2, 0), fragments: audits };
    sourceGzipBytes += countrySources[code].sourceGzipBytes;
  }
  const manifest = { ...identity, countries };
  const provenance = { format: 1, sourceAttribution: '../sources.json', sourceManifest: '../manifest.json',
    sourceManifestSha256: digest(sourceManifestText),
    algorithm: 'Partition complete source polygons by unique containment within their existing spatial-part bounds; preserve all coordinates and holes, rebasing relative origins only.',
    countrySources };
  await writeFile(path.join(staging, 'manifest.json'), serialize(manifest));
  await writeFile(path.join(staging, 'provenance.json'), serialize(provenance));
  let backup;
  try { await rename(outputDir, `${staging}-previous`); backup = `${staging}-previous`; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await rename(staging, outputDir); }
  catch (error) { if (backup) await rename(backup, outputDir); throw error; }
  if (backup) await rm(backup, { recursive: true, force: true });
  console.log(JSON.stringify({ countries: codes.length, fragments: fragmentCount, sourceGzipBytes, fragmentGzipBytes }));
} finally {
  await rm(staging, { recursive: true, force: true });
}
