#!/usr/bin/env node
import { readFile, writeFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { featuresNearLongitudeCopies } from '../src/geometry.js';
import { describeCatalog } from '../src/state.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argument = process.argv.indexOf('--data-dir');
if (argument >= 0 && !process.argv[argument + 1]) throw new Error('--data-dir requires a directory.');
const dataDir = path.resolve(argument < 0 ? path.join(root, 'data') : process.argv[argument + 1]);
const outputDir = path.join(dataDir, 'compiled');
const extent = 2 ** 24;
const read = async file => JSON.parse(await readFile(path.join(dataDir, file), 'utf8'));

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

// Normalize seams once, keeping only the center copy. The browser reuses its
// native path at wrapped tile offsets, instead of cloning the coordinates.
const normalize = features => featuresNearLongitudeCopies(features, 0).filter((_, index) => index % 3 === 0);
const [catalog, palette, world] = await Promise.all([read('catalog.json'), read('palette.json'), read('world.geojson')]);
const identity = describeCatalog(catalog);
const indexById = new Map(catalog.regionIds.map((id, index) => [id, index]));
const seen = new Set();
const staging = await mkdtemp(path.join(dataDir, '.compiled-'));
const envelope = features => ({ format: 1, version: identity.version, extent, fingerprint: identity.fingerprint, features });
const write = (file, value) => writeFile(path.join(staging, file), `${JSON.stringify(value)}\n`);
let backup;
try {
  await mkdir(path.join(staging, 'countries'));
  const worldFeatures = normalize(world.features).map(feature => record(feature));
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
  const manifest = { format: 1, ...identity, extent, worldFile: 'world.json', catalogFile: '../catalog.json', countries };
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
