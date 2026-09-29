#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import polygonClipping from 'polygon-clipping';
import { featuresNearLongitudeCopies } from '../src/geometry.js';
import { describeCatalog } from '../src/state.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const valueFor = name => {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
};
const dataDir = path.resolve(valueFor('--data-dir') || path.join(root, 'data'));
const sourceArgument = valueFor('--source-world');
if (!sourceArgument) throw new Error('--source-world is required; pass the pinned Natural Earth GeoJSON explicitly.');
const sourcePath = path.resolve(sourceArgument);
const sourceVersion = valueFor('--source-version') || 'ca96624a56bd078437bca8184e78163e5039ad19';
const sourceUrl = valueFor('--source-url') || 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/ca96624a56bd078437bca8184e78163e5039ad19/geojson/ne_10m_admin_0_countries.geojson';
const COUNTRY_CODE_ALIASES = new Map([['KOS', 'XKX']]);
const extent = 2 ** 24;

const readJson = file => readFile(file, 'utf8').then(JSON.parse);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const project = ([longitude, latitude]) => {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) throw new Error('Invalid atlas coordinate.');
  const clamped = Math.max(-85.0511287798, Math.min(85.0511287798, latitude));
  const y = Math.log(Math.tan(Math.PI / 4 + clamped * Math.PI / 360));
  return [Math.round((longitude + 180) / 360 * extent), Math.round((1 - y / Math.PI) * extent / 2)];
};

function record(feature, code, polygons, holeSupport) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  const paths = [];
  const strokeWidths = [];
  for (const polygon of polygons) for (const [ringIndex, ring] of polygon.entries()) {
    if (!Array.isArray(ring) || ring.length < 4) throw new Error(`Invalid ring for ${code}.`);
    if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) throw new Error(`Unclosed ring for ${code}.`);
    let previous;
    let commands = '';
    let twiceArea = 0;
    let perimeter = 0;
    for (const point of ring) {
      bounds[0] = Math.min(bounds[0], point[0]); bounds[1] = Math.min(bounds[1], point[1]);
      bounds[2] = Math.max(bounds[2], point[0]); bounds[3] = Math.max(bounds[3], point[1]);
      commands += previous ? `l${point[0] - previous[0]} ${point[1] - previous[1]}` : `M${point[0]} ${point[1]}`;
      if (previous) {
        twiceArea += (previous[0] - ring[0][0]) * (point[1] - ring[0][1]) -
          (point[0] - ring[0][0]) * (previous[1] - ring[0][1]);
        perimeter += Math.hypot(point[0] - previous[0], point[1] - previous[1]);
      }
      previous = point;
    }
    paths.push(`${commands}z`);
    const supported = ringIndex === 0 || !holeSupport || intersectsPolygons([ring], holeSupport);
    strokeWidths.push(ringIndex === 0 ? null : supported && perimeter ? Math.floor(Math.abs(twiceArea) / perimeter) : 0);
  }
  if (!paths.length) throw new Error(`Empty detail geometry for ${code}.`);
  const properties = feature.properties || {};
  const id = properties.id || `${code}:ADM0:${code}`;
  const name = properties.name || properties.NAME || properties.ADMIN || code;
  return { id, name, countryCode: code, d: paths.join(' '), bounds,
    ...(strokeWidths.some(width => width !== null) ? { strokeWidths } : {}) };
}

function sourceCodes(feature) {
  const properties = feature.properties || {};
  const candidates = [properties.countryCode, properties.ADM0_A3, properties.ADM0_A3_US,
    properties.ISO_A3, properties.iso_a3, properties.SOV_A3, properties.WB_A3];
  return candidates.filter(value => /^[A-Z]{3}$/.test(String(value || ''))).map(String);
}

function sourceCode(feature, allowed) {
  return sourceCodes(feature).map(code => COUNTRY_CODE_ALIASES.get(code) || code)
    .find(code => !allowed || allowed.has(code)) || null;
}

function polygonParts(geometry) {
  if (geometry?.type === 'Polygon') return [geometry.coordinates];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

const mergeBounds = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]),
  Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const boundsArea = bounds => (bounds[2] - bounds[0]) * (bounds[3] - bounds[1]);
const boundsOverlap = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const combinedBounds = boxes => boxes.reduce(mergeBounds);
const polygonBounds = polygon => polygon.flat().reduce((bounds, [x, y]) =>
  mergeBounds(bounds, [x, y, x, y]), [Infinity, Infinity, -Infinity, -Infinity]);
const projectPolygons = feature => polygonParts(feature.geometry).map(polygon => polygon.map(ring => ring.map(project)));
const roundPolygons = polygons => polygons.map(polygon => polygon.map(ring => ring.map(point => point.map(Math.round))));
function polygonCollection(polygons) {
  const boxes = polygons.map(polygonBounds);
  return { polygons, boxes, bounds: boxes.length ? combinedBounds(boxes) : [Infinity, Infinity, -Infinity, -Infinity] };
}
const explicitHoles = features => featuresNearLongitudeCopies(features, 0).filter((_, index) => index % 3 === 0)
  .flatMap(feature => projectPolygons(feature).flatMap(polygon => polygon.slice(1).map(ring => [ring])));

function unionRegions(features) {
  const normalized = featuresNearLongitudeCopies(features, 0).filter((_, index) => index % 3 === 0);
  const inputs = normalized.map(projectPolygons);
  const vertices = inputs.reduce((count, polygons) => count + polygons.reduce((n, polygon) =>
    n + polygon.reduce((m, ring) => m + ring.length, 0), 0), 0);
  // Large inputs exceed polygon-clipping's initial one-million-endpoint guard.
  // Dissolve the same children by their existing parent assignment first; never
  // substitute separately simplified parent geometry.
  let dissolvedInputs = inputs;
  if (vertices > 400_000) {
    const groups = new Map();
    for (let index = 0; index < inputs.length; index++) {
      const key = normalized[index].properties.parentId || normalized[index].properties.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(inputs[index]);
    }
    dissolvedInputs = [...groups.values()].map(group => polygonClipping.union(...group));
  }
  return roundPolygons(polygonClipping.union(...dissolvedInputs));
}

function intersectsPolygons(polygon, collection) {
  if (!collection.polygons.length) return false;
  const bounds = polygonBounds(polygon);
  if (!boundsOverlap(bounds, collection.bounds)) return false;
  const candidates = collection.polygons.filter((_, index) => boundsOverlap(bounds, collection.boxes[index]));
  return candidates.length > 0 && polygonClipping.intersection([polygon], candidates).length > 0;
}

function bestBoundsSplit(boxes) {
  if (boxes.length < 2) return null;
  const area = boundsArea(combinedBounds(boxes));
  let best;
  for (const axis of [0, 1]) {
    const sorted = [...boxes].sort((a, b) => a[axis] + a[axis + 2] - b[axis] - b[axis + 2]);
    const left = [sorted[0]];
    const right = Array(sorted.length);
    right[sorted.length - 1] = sorted.at(-1);
    for (let index = 1; index < sorted.length; index++) left[index] = mergeBounds(left[index - 1], sorted[index]);
    for (let index = sorted.length - 2; index >= 0; index--) right[index] = mergeBounds(right[index + 1], sorted[index]);
    for (let index = 1; index < sorted.length; index++) {
      const gain = area - boundsArea(left[index - 1]) - boundsArea(right[index]);
      if (gain > (best?.gain || 0)) best = { gain, groups: [sorted.slice(0, index), sorted.slice(index)] };
    }
  }
  return best;
}

function spatialParts(polygons, bounds) {
  // One country-wide box can span empty oceans between islands or dateline
  // copies. Keep conservative polygon boxes, then compact nearby parts without
  // moving coordinates or joining opposite edges of the world.
  const boxes = [];
  for (const polygon of polygons) {
    let box = polygonBounds(polygon);
    for (let index = 0; index < boxes.length;) {
      if (boundsOverlap(box, boxes[index])) {
        box = mergeBounds(box, boxes.splice(index, 1)[0]);
        index = 0;
      } else index++;
    }
    boxes.push(box);
  }
  if (boxes.length < 2) return undefined;
  const groups = [boxes];
  while (groups.length < 12) {
    let selected;
    for (let index = 0; index < groups.length; index++) {
      const split = bestBoundsSplit(groups[index]);
      if (split && split.gain > (selected?.gain || 0)) selected = { ...split, index };
    }
    // Avoid spending initial-load bytes separating tiny neighboring islands.
    if (!selected || selected.gain < boundsArea(bounds) * 0.02) break;
    groups.splice(selected.index, 1, ...selected.groups);
  }
  const parts = groups.map(combinedBounds);
  // Small reductions do not justify more metadata on every initial load.
  return parts.reduce((area, part) => area + boundsArea(part), 0) < boundsArea(bounds) * 0.6 ? parts : undefined;
}

function mergeFeature(first, next) {
  const coordinates = [...polygonParts(first.geometry), ...polygonParts(next.geometry)];
  return { ...first, geometry: { type: 'MultiPolygon', coordinates } };
}

const [catalog, sourceText, worldText] = await Promise.all([
  readJson(path.join(dataDir, 'catalog.json')),
  readFile(sourcePath, 'utf8'),
  readFile(path.join(dataDir, 'world.geojson'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  }),
]);
const source = JSON.parse(sourceText);
const world = worldText ? JSON.parse(worldText) : null;
const sourceSha256 = sha256(sourceText);
const worldSha256 = worldText ? sha256(worldText) : null;
if (sourceSha256 !== '239eec57ac17f100a11e2536cffc56752c318b50ae765b0918ff7aab4ce8f255' &&
    (!valueFor('--source-url') || !valueFor('--source-version'))) {
  throw new Error('This input differs from the pinned source; provide --source-url and --source-version for its provenance.');
}
if (!source || source.type !== 'FeatureCollection' || !Array.isArray(source.features)) {
  throw new Error(`--source-world must be a GeoJSON FeatureCollection: ${sourcePath}`);
}
const identity = describeCatalog(catalog);
const catalogCodes = new Set(Object.keys(catalog.countries));
const sourceByCode = new Map();
for (const feature of source.features) {
  const code = sourceCode(feature, catalogCodes);
  if (!code || !catalogCodes.has(code)) continue;
  sourceByCode.set(code, sourceByCode.has(code) ? mergeFeature(sourceByCode.get(code), feature) : feature);
}
const missing = [...catalogCodes].filter(code => !sourceByCode.has(code));
const fallbackCodes = [];
let fallbackSource;
if (missing.length) {
  if (!world) throw new Error(`Source is missing catalog countries and no world.geojson fallback exists: ${missing.join(', ')}`);
  fallbackSource = { file: 'world.geojson', sha256: worldSha256, attribution: '../README.md and ../catalog.json' };
  const fallbackByCode = new Map((world.features || []).map(feature => [sourceCode(feature, catalogCodes), feature]));
  for (const code of missing) {
    if (!fallbackByCode.has(code)) throw new Error(`Source is missing catalog countries: ${missing.join(', ')}`);
    sourceByCode.set(code, fallbackByCode.get(code));
    fallbackCodes.push(code);
  }
}
const outputDir = path.join(dataDir, 'outlines');
const staging = await mkdtemp(path.join(dataDir, '.outlines-'));
const envelope = features => ({ format: 1, version: identity.version, extent,
  fingerprint: identity.fingerprint, features });
const normalize = feature => featuresNearLongitudeCopies([feature], 0)[0];
try {
  await mkdir(staging, { recursive: true });
  const countries = {};
  const countrySources = {};
  const canonical = new Map();
  // Build every canonical coverage mask first so contextual offshore parts can
  // respect other separately represented atlas entities without code exceptions.
  for (const code of [...catalogCodes].sort()) {
    const entry = catalog.countries[code];
    if (entry.source === 'naturalEarth' || !entry.file) continue;
    const text = await readFile(path.join(dataDir, entry.file), 'utf8');
    const data = JSON.parse(text);
    if (!Array.isArray(data.features) || !data.features.length) throw new Error(`Empty canonical regions for ${code}.`);
    const polygons = unionRegions(data.features);
    if (!polygons.length) throw new Error(`Empty canonical union for ${code}.`);
    canonical.set(code, { ...polygonCollection(polygons), explicitHoles: explicitHoles(data.features) });
    countrySources[code] = { kind: 'canonical-region-union', source: entry.source, file: entry.file,
      sha256: sha256(text), attribution: '../catalog.json and ../README.md' };
  }
  const coverageByCode = new Map(canonical);
  for (const code of [...catalogCodes].sort()) if (!coverageByCode.has(code)) {
    coverageByCode.set(code, polygonCollection(projectPolygons(normalize(sourceByCode.get(code)))));
  }
  for (const code of [...catalogCodes].sort()) {
    const feature = normalize(sourceByCode.get(code));
    const context = projectPolygons(feature);
    const contextSource = fallbackCodes.includes(code)
      ? { file: 'world.geojson', sha256: fallbackSource.sha256 }
      : { url: sourceUrl, sha256: sourceSha256 };
    let polygons = context;
    let holeSupport;
    if (canonical.has(code)) {
      const own = canonical.get(code);
      const worldFeatures = (world?.features || []).filter(item => sourceCode(item, catalogCodes) === code);
      holeSupport = polygonCollection([...own.explicitHoles, ...explicitHoles([feature, ...worldFeatures])]);
      const retainedPolygons = [];
      const excludedPolygons = [];
      for (const [index, polygon] of context.entries()) {
        if (intersectsPolygons(polygon, own)) continue;
        const representedBy = [...coverageByCode].filter(([other, coverage]) =>
          other !== code && intersectsPolygons(polygon, coverage)).map(([other]) => other);
        if (representedBy.length) excludedPolygons.push({ index, representedBy });
        else retainedPolygons.push(index);
      }
      polygons = [...own.polygons, ...retainedPolygons.map(index => context[index])];
      countrySources[code].context = { ...contextSource, retainedPolygons, excludedPolygons };
      countrySources[code].interiorStrokePolicy = 'positive-area support from explicit child, context, or checked-in world holes';
      if (worldText) countrySources[code].holeSupportWorld = { file: 'world.geojson', sha256: worldSha256 };
    } else {
      countrySources[code] = { kind: fallbackCodes.includes(code) ? 'checked-in-world' : 'natural-earth', ...contextSource };
    }
    const outline = record(feature, code, polygons, holeSupport);
    const parts = spatialParts(polygons, outline.bounds);
    const body = `${JSON.stringify(envelope([outline]))}\n`;
    await writeFile(path.join(staging, `${code}.json`), body);
    countries[code] = { file: `../outlines/${code}.json`, bounds: outline.bounds, ...(parts ? { parts } : {}),
      regionIds: catalog.countries[code]?.source === 'naturalEarth'
        ? catalog.regionIds.filter(id => id.startsWith(`${code}:`)) : [] };
  }
  const manifest = { format: 1, version: identity.version, extent, fingerprint: identity.fingerprint,
    minZoom: 6, countries };
  await writeFile(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  const sources = { format: 1, source: { name: 'Natural Earth', version: sourceVersion, url: sourceUrl,
    file: path.basename(sourcePath), sha256: sourceSha256 }, fallbackCodes: fallbackCodes.sort(),
    ...(fallbackSource ? { fallbackSource } : {}),
    contextPolygonIndices: 'indices after world-wrap normalization of the country source geometry', countrySources };
  await writeFile(path.join(staging, 'sources.json'), `${JSON.stringify(sources)}\n`);

  let backup;
  try { await rename(outputDir, `${staging}-previous`); backup = `${staging}-previous`; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await rename(staging, outputDir); }
  catch (error) { if (backup) await rename(backup, outputDir); throw error; }
  if (backup) await rm(backup, { recursive: true, force: true });
  console.log(`Detail atlas: ${Object.keys(countries).length} country outlines -> ${outputDir}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
