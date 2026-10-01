#!/usr/bin/env node
import { readFile, writeFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { featuresNearLongitudeCopies } from '../src/geometry.js';
import { describeCatalog } from '../src/state.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argument = process.argv.indexOf('--data-dir');
if (argument >= 0 && !process.argv[argument + 1]) throw new Error('--data-dir requires a directory.');
const dataDir = path.resolve(argument < 0 ? path.join(root, 'data') : process.argv[argument + 1]);
const outputDir = path.join(dataDir, 'compiled');
const extent = 2 ** 24;
const read = async file => JSON.parse(await readFile(path.join(dataDir, file), 'utf8'));
const readOptional = async file => {
  try { return await read(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

function project([longitude, latitude]) {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) throw new Error('Invalid atlas coordinate.');
  const clamped = Math.max(-85.0511287798, Math.min(85.0511287798, latitude));
  const y = Math.log(Math.tan(Math.PI / 4 + clamped * Math.PI / 360));
  return [Math.round((longitude + 180) / 360 * extent), Math.round((1 - y / Math.PI) * extent / 2)];
}

function record(feature, index) {
  const geometry = feature.geometry;
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates]
    : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  const paths = [];
  for (const polygon of polygons) {
    for (const ring of polygon) {
      if (ring.length < 4) throw new Error('Compiled atlas requires closed polygon rings.');
      let previous;
      let commands = '';
      for (const coordinate of ring) {
        const point = project(coordinate);
        bounds[0] = Math.min(bounds[0], point[0]); bounds[1] = Math.min(bounds[1], point[1]);
        bounds[2] = Math.max(bounds[2], point[0]); bounds[3] = Math.max(bounds[3], point[1]);
        commands += previous ? `l${point[0] - previous[0]} ${point[1] - previous[1]}` : `M${point[0]} ${point[1]}`;
        previous = point;
      }
      paths.push(`${commands}z`);
    }
  }
  if (!paths.length) throw new Error(`Empty compiled geometry: ${feature.properties?.id || feature.properties?.countryCode}`);
  const { id, name, countryCode, parentId } = feature.properties;
  return { id, name, countryCode, parentId, index, d: paths.join(' '), bounds };
}

function exterior(feature) {
  const geometry = feature.geometry;
  return { ...feature, geometry: {
    ...geometry,
    coordinates: geometry.type === 'Polygon' ? geometry.coordinates.slice(0, 1)
      : geometry.coordinates.map(polygon => polygon.slice(0, 1)),
  } };
}

const OVERVIEW_TOLERANCE = 3000;
const squaredDistance = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
function simplifyIndices(points, toleranceSquared) {
  if (points.length <= 2) return points.map((_, index) => index);
  let farthest = -1;
  let distance = toleranceSquared;
  const start = points[0]; const end = points.at(-1);
  const dx = end[0] - start[0]; const dy = end[1] - start[1];
  for (let index = 1; index < points.length - 1; index++) {
    const point = points[index]; const length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / length)) : 0;
    const projection = [start[0] + t * dx, start[1] + t * dy];
    const error = squaredDistance(point, projection);
    if (error > distance) { farthest = index; distance = error; }
  }
  if (farthest < 0) return [0, points.length - 1];
  const left = simplifyIndices(points.slice(0, farthest + 1), toleranceSquared);
  const right = simplifyIndices(points.slice(farthest), toleranceSquared).map(index => index + farthest);
  return [...left, ...right.slice(1)];
}

function simplifyRing(ring) {
  if (ring.length <= 5) return ring;
  const open = ring.slice(0, -1);
  const projected = open.map(project);
  const span = projected.reduce((result, point) => [Math.min(result[0], point[0]), Math.min(result[1], point[1]),
    Math.max(result[2], point[0]), Math.max(result[3], point[1])], [Infinity, Infinity, -Infinity, -Infinity]);
  if (Math.max(span[2] - span[0], span[3] - span[1]) <= OVERVIEW_TOLERANCE) return ring;
  const indices = simplifyIndices([...projected, projected[0]], OVERVIEW_TOLERANCE ** 2).slice(0, -1);
  const simplified = indices.map(index => open[index]);
  return simplified.length >= 3 ? [...simplified, simplified[0]] : ring;
}

function simplifyWorld(feature) {
  const geometry = feature.geometry;
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  const coordinates = polygons.map(polygon => polygon.map(simplifyRing));
  return { ...feature, geometry: geometry.type === 'Polygon' ? { ...geometry, coordinates: coordinates[0] } : { ...geometry, coordinates } };
}

// Normalize seams once, keeping only the center copy. The browser reuses its
// native path at wrapped tile offsets, instead of cloning the coordinates.
const normalize = features => featuresNearLongitudeCopies(features, 0).filter((_, index) => index % 3 === 0);
const [catalog, palette, world, outlines, outlineOverview, outlineFragments] = await Promise.all([
  read('catalog.json'), read('palette.json'), read('world.geojson'),
  readOptional('outlines/manifest.json'), readOptional('outlines/overview/manifest.json'),
  readOptional('outlines/fragments/manifest.json'),
]);
const identity = describeCatalog(catalog);
const indexById = new Map(catalog.regionIds.map((id, index) => [id, index]));
const seen = new Set();
const staging = await mkdtemp(path.join(dataDir, '.compiled-'));
const envelope = features => ({ format: 1, version: identity.version, extent, fingerprint: identity.fingerprint, features });
const write = (file, value) => writeFile(path.join(staging, file), `${JSON.stringify(value)}\n`);
let backup;
try {
  await mkdir(path.join(staging, 'countries'));
  const worldFeatures = normalize(world.features).map(simplifyWorld).map(feature => record(feature));
  await write('world.json', envelope(worldFeatures));
  const countries = {};
  let nextIndex = 0;
  for (const [code, entry] of Object.entries(catalog.countries).sort(([a], [b]) => a.localeCompare(b))) {
    const source = entry.file ? await read(entry.file) : null;
    const features = source ? normalize(source.features).map(feature => {
      const id = feature.properties.id;
      const index = indexById.get(id);
      if (!Number.isInteger(index) || seen.has(id) || !id.startsWith(`${code}:`) || feature.properties.countryCode !== code) {
        throw new Error(`Invalid or duplicate catalog region: ${id}`);
      }
      seen.add(id);
      return record(feature, index);
    }).sort((a, b) => a.index - b.index) : [];
    const start = nextIndex;
    for (const feature of features) {
      if (feature.index !== nextIndex++) throw new Error(`Country ranges must follow catalog order: ${code}`);
    }
    const admin1 = source ? normalize((source.admin1?.features || []).map(exterior)).map(feature => record(feature)) : [];
    const file = source ? `countries/${code}.json` : null;
    if (file) await write(file, { ...envelope(features), admin1 });
    countries[code] = { file, start, count: features.length,
      color: palette[code]?.color || palette.countries?.[code]?.color || '#64748b' };
  }
  if (seen.size !== identity.regionCount) throw new Error('Source shards do not cover the complete catalog.');
  let outlineMetadata;
  if (outlineOverview && !outlines) throw new Error('Overview outlines require a matching detailed outline manifest.');
  if (outlineFragments && !outlines) throw new Error('Outline fragments require a matching detailed outline manifest.');
  if (outlines) {
    if (outlines.format !== 1 || outlines.version !== identity.version || outlines.extent !== extent ||
        JSON.stringify(outlines.fingerprint) !== JSON.stringify(identity.fingerprint) || typeof outlines.countries !== 'object') {
      throw new Error('Detail outline manifest identity does not match the compiled atlas.');
    }
    outlineMetadata = outlines;
    if (outlineOverview) {
      if (outlineOverview.format !== 1 || outlineOverview.version !== identity.version || outlineOverview.extent !== extent ||
          JSON.stringify(outlineOverview.fingerprint) !== JSON.stringify(identity.fingerprint) ||
          !Number.isFinite(outlineOverview.minZoom) || outlineOverview.minZoom < 0 ||
          outlineOverview.detailZoom !== outlines.minZoom || outlineOverview.minZoom >= outlineOverview.detailZoom ||
          Object.keys(outlineOverview.countries || {}).length !== Object.keys(outlines.countries).length) {
        throw new Error('Overview outline manifest does not match the detailed atlas.');
      }
      const countries = {};
      for (const [code, entry] of Object.entries(outlines.countries)) {
        const file = outlineOverview.countries[code]?.file;
        if (file !== `../outlines/overview/${code}.json`) throw new Error(`Invalid overview outline path: ${code}`);
        const sourceBytes = await readFile(path.join(dataDir, 'outlines', `${code}.json`));
        const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
        if (sourceSha256 !== outlineOverview.countries[code].sourceSha256) {
          throw new Error(`Overview outline is stale; rebuild it from the current detailed atlas: ${code}`);
        }
        // Fail before replacing a working atlas if a tier was only partly built.
        const overviewBytes = await readFile(path.join(dataDir, 'outlines', 'overview', `${code}.json`));
        const payload = JSON.parse(overviewBytes);
        if (payload.version !== identity.version || payload.extent !== extent || payload.format !== 1 ||
            JSON.stringify(payload.fingerprint) !== JSON.stringify(identity.fingerprint) ||
            payload.features?.length !== 1 || payload.features[0].countryCode !== code) {
          throw new Error(`Overview outline data does not match the detailed atlas: ${code}`);
        }
        // Some source polygons already contain invalid topology. Their safe
        // overview keeps the exact source, so reuse one URL/cache entry at every
        // refinement zoom instead of downloading identical geometry twice.
        countries[code] = { ...entry, overviewFile: sourceBytes.equals(overviewBytes) ? entry.file : file };
      }
      outlineMetadata = { ...outlines, minZoom: outlineOverview.minZoom, detailZoom: outlineOverview.detailZoom, countries };
    }
    if (outlineFragments) {
      if (outlineFragments.format !== 1 || outlineFragments.version !== identity.version || outlineFragments.extent !== extent ||
          JSON.stringify(outlineFragments.fingerprint) !== JSON.stringify(identity.fingerprint) ||
          !outlineFragments.countries || typeof outlineFragments.countries !== 'object') {
        throw new Error('Outline fragment manifest identity does not match the compiled atlas.');
      }
      const countries = { ...outlineMetadata.countries };
      for (const [code, group] of Object.entries(outlineFragments.countries)) {
        const original = outlines.countries[code];
        if (!original || original.regionIds?.length || !Array.isArray(group.fragments) || !group.fragments.length ||
            group.fragments.length !== original.parts?.length) throw new Error(`Invalid outline fragment group: ${code}`);
        const source = await readFile(path.join(dataDir, 'outlines', `${code}.json`));
        if (createHash('sha256').update(source).digest('hex') !== group.sourceSha256) {
          throw new Error(`Outline fragments are stale; rebuild them from the current detailed atlas: ${code}`);
        }
        const fragments = [];
        for (const [index, fragment] of group.fragments.entries()) {
          if (fragment.id !== index || fragment.file !== `../outlines/fragments/${code}/${index}.json` ||
              JSON.stringify(fragment.bounds) !== JSON.stringify(original.parts[index])) {
            throw new Error(`Invalid outline fragment index: ${code}`);
          }
          const bytes = await readFile(path.join(dataDir, 'outlines', 'fragments', code, `${index}.json`));
          const payload = JSON.parse(bytes);
          if (createHash('sha256').update(bytes).digest('hex') !== fragment.sha256 || payload.fragment !== index ||
              payload.version !== identity.version || payload.extent !== extent || payload.format !== 1 ||
              JSON.stringify(payload.fingerprint) !== JSON.stringify(identity.fingerprint) ||
              payload.features?.length !== 1 || payload.features[0].countryCode !== code ||
              JSON.stringify(payload.features[0].bounds) !== JSON.stringify(fragment.bounds)) {
            throw new Error(`Outline fragment data does not match the detailed atlas: ${code}/${index}`);
          }
          fragments.push({ id: fragment.id, file: fragment.file, bounds: fragment.bounds });
        }
        countries[code] = { ...countries[code], fragments };
      }
      outlineMetadata = { ...outlineMetadata, countries };
    }
  }
  const manifest = { format: 1, ...identity, extent, worldFile: 'world.json', catalogFile: '../catalog.json', countries,
    ...(outlineMetadata ? { outlines: outlineMetadata } : {}) };
  await write('manifest.json', manifest);
  await writeFile(path.join(staging, 'manifest.js'), `export default ${JSON.stringify(manifest)};\n`);

  // A failed build leaves the last complete atlas intact.
  backup = `${staging}-previous`;
  try { await rename(outputDir, backup); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    backup = null;
  }
  try { await rename(staging, outputDir); } catch (error) {
    if (backup) { await rename(backup, outputDir); backup = null; }
    throw error;
  }
  if (backup) await rm(backup, { recursive: true, force: true });
  console.log(`Compiled atlas: ${identity.regionCount} regions, ${worldFeatures.length} country outlines -> ${outputDir}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
