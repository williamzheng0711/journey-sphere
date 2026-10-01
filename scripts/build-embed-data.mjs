#!/usr/bin/env node
/* Build the package-owned, on-demand embed data set. */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describeCatalog } from '../src/state.js';
import { normalizePlaceName, placeBucket } from '../src/place-names.js';
import { compactWorldPath } from './lib/compact-world-path.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = path.join(root, 'data');
const output = path.join(dataRoot, 'embed');
const read = file => readFile(path.join(dataRoot, file), 'utf8').then(JSON.parse);
const write = (file, value) => writeFile(path.join(output, file), `${JSON.stringify(value)}\n`);
const identity = describeCatalog(await read('catalog.json'));
const manifest = await read('compiled/manifest.json');
const catalog = await read('catalog.json');
const aliases = await read('place-aliases.json');
const extent = manifest.extent;

function simplifyLine(points, tolerance) {
  if (points.length < 3) return points;
  const squared = tolerance * tolerance;
  const keep = new Uint8Array(points.length); keep[0] = keep[points.length - 1] = 1;
  const visit = (start, end) => {
    let best = squared, index = -1;
    const [ax, ay] = points[start], [bx, by] = points[end]; const dx = bx - ax, dy = by - ay;
    for (let i = start + 1; i < end; i++) {
      const [px, py] = points[i]; const t = Math.max(0, Math.min(1, (dx * (px - ax) + dy * (py - ay)) / (dx * dx + dy * dy || 1)));
      const distance = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
      if (distance > best) { best = distance; index = i; }
    }
    if (index >= 0) { keep[index] = 1; visit(start, index); visit(index, end); }
  };
  visit(0, points.length - 1);
  return points.filter((_, index) => keep[index]);
}
function simplifyCompiledPath(path, tolerance = 6000) {
  const rings = [...path.matchAll(/M[^M]+/g)].map(([text]) => {
    const points = []; let x = 0, y = 0;
    for (const [, command, a, b] of text.matchAll(/(M|l)(-?\d+) (-?\d+)/g)) {
      x = command === 'M' ? Number(a) : x + Number(a);
      y = command === 'M' ? Number(b) : y + Number(b);
      points.push([x, y]);
    }
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    const area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    return { text, points, area };
  });
  const largest = Math.max(...rings.map(ring => ring.area));
  // Keep the first overview small; detailed viewport paths restore every island
  // and hole after it has painted, without delaying the initial map.
  return rings.filter(ring => ring.area === largest || ring.area >= tolerance ** 2 * 4).map(({ text, points }) => {
    const reduced = simplifyLine(points, tolerance);
    if (reduced.length < 4) return text;
    let result = `M${reduced[0][0]} ${reduced[0][1]}`;
    for (let i = 1; i < reduced.length; i++) result += `l${reduced[i][0] - reduced[i - 1][0]} ${reduced[i][1] - reduced[i - 1][1]}`;
    return `${result}z`;
  }).join(' ');
}

await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, 'names'), { recursive: true });
await mkdir(path.join(output, 'regions'), { recursive: true });
await mkdir(path.join(output, 'groups'), { recursive: true });
const byId = new Map();
const candidatesByName = new Map();
const chunkIndex = new Map();
let shardCount = 0;
function addCandidate(name, candidate) {
  const key = normalizePlaceName(name);
  const list = candidatesByName.get(key) || [];
  if (!list.some(item => item.ids.join() === candidate.ids.join())) list.push(candidate);
  candidatesByName.set(key, list);
}
for (const code of Object.keys(catalog.countries).sort()) {
  const source = catalog.countries[code].file ? await read(`compiled/countries/${code}.json`) : { features: [], admin1: [] };
  // Only country features are selectable catalog regions. ADM1 outlines stay
  // in the canonical atlas and must never leak into embed selection shards.
  const records = [...(source.features || [])].sort((a, b) => a.index - b.index);
  const chunkSize = 4;
  for (let offset = 0; offset < records.length; offset += chunkSize) {
    const chunk = `regions/${code}/${String(offset / chunkSize).padStart(4, '0')}.json`;
    await mkdir(path.join(output, 'regions', code), { recursive: true });
    shardCount++;
    await write(chunk, { format: 1, version: identity.version, extent, fingerprint: identity.fingerprint, features: records.slice(offset, offset + chunkSize), admin1: [] });
    for (const feature of records.slice(offset, offset + chunkSize)) chunkIndex.set(feature.id, chunk);
  }
  const parents = new Map((source.admin1 || []).map(parent => [parent.id, parent.name]));
  for (const feature of records) {
    byId.set(feature.id, feature);
    const parent = parents.get(feature.parentId);
    const qualifiedName = parent ? `${feature.name}, ${parent}` : feature.name;
    const candidate = { name: feature.name, country: code, qualified: `${qualifiedName}, ${code}`, ids: [feature.id], chunks: [chunkIndex.get(feature.id)] };
    addCandidate(feature.name, candidate);
    if (parent) addCandidate(qualifiedName, candidate);
    addCandidate(feature.id, candidate);
    // Native city names commonly omit their administrative suffix.
    if (/^[\p{Script=Han}]{2,}[市县縣区區]$/u.test(feature.name)) addCandidate(feature.name.slice(0, -1), candidate);
  }
}
const commonAliases = {};
const groups = new Set();
for (const [alias, ids] of Object.entries(aliases)) {
  const key = normalizePlaceName(alias);
  const grouped = new Map();
  for (const id of ids) {
    let feature = byId.get(id);
    // Curated city aliases may name an ADM1 parent (for example Tokyo). Expand
    // it to its selectable child regions while keeping generic names strict.
    const expanded = feature ? [feature] : [...byId.values()].filter(candidate => candidate.parentId === id);
    if (!expanded.length) throw new Error(`Alias ${alias} references missing region ${id}.`);
    for (feature of expanded) {
      const item = grouped.get(feature.countryCode) || { name: alias, country: feature.countryCode, qualified: `${alias}, ${feature.countryCode}`, ids: [], chunks: [] };
      item.ids.push(feature.id); item.chunks.push(chunkIndex.get(feature.id)); grouped.set(feature.countryCode, item);
    }
  }
  for (const [code, candidate] of grouped) {
    candidate.ids = [...new Set(candidate.ids)].sort((a, b) => byId.get(a).index - byId.get(b).index);
    const key = createHash('sha256').update(candidate.ids.join('\n')).digest('hex').slice(0, 16);
    const chunk = `groups/${code}/${key}.json`;
    candidate.chunks = [chunk];
    if (!groups.has(chunk)) {
      await mkdir(path.join(output, 'groups', code), { recursive: true });
      await write(chunk, { format: 1, version: identity.version, extent, fingerprint: identity.fingerprint, features: candidate.ids.map(id => byId.get(id)), admin1: [] });
      groups.add(chunk);
    }
  }
  commonAliases[key] = [...grouped.values()];
  candidatesByName.set(key, commonAliases[key]);
}
// Pack nearby popular single-region aliases into small shared requests. Keep
// multi-region city aliases (Tokyo, New York City) as exact dedicated groups.
const popular = new Map();
for (const candidates of Object.values(commonAliases)) for (const candidate of candidates) {
  if (candidate.ids.length !== 1) continue;
  const id = candidate.ids[0];
  if (!popular.has(candidate.country)) popular.set(candidate.country, new Map());
  const country = popular.get(candidate.country);
  if (!country.has(id)) country.set(id, []);
  country.get(id).push(candidate);
}
for (const [code, aliasesById] of popular) {
  let batch = [], size = 0;
  async function flush() {
    if (!batch.length) return;
    const key = createHash('sha256').update(batch.join('\n')).digest('hex').slice(0, 16);
    const chunk = `groups/${code}/${key}.json`;
    await write(chunk, { format: 1, version: identity.version, extent, fingerprint: identity.fingerprint, features: batch.map(id => byId.get(id)), admin1: [] });
    groups.add(chunk);
    for (const id of batch) for (const candidate of aliasesById.get(id)) candidate.chunks = [chunk];
    batch = []; size = 0;
  }
  for (const id of [...aliasesById.keys()].sort((a, b) => byId.get(a).index - byId.get(b).index)) {
    const bytes = Buffer.byteLength(JSON.stringify(byId.get(id)));
    if (batch.length && (batch.length === 8 || size + bytes > 40000)) await flush();
    batch.push(id); size += bytes;
  }
  await flush();
}
const referencedGroups = new Set(Object.values(commonAliases).flatMap(candidates => candidates.flatMap(candidate => candidate.chunks)));
for (const file of groups) if (!referencedGroups.has(file)) await rm(path.join(output, file));

await writeFile(path.join(output, 'aliases.js'), `export default ${JSON.stringify(commonAliases)};\n`);
const nameShards = new Map();
for (const [key, candidates] of candidatesByName) {
  const bucket = placeBucket(key); if (!nameShards.has(bucket)) nameShards.set(bucket, {});
  nameShards.get(bucket)[key] = candidates.map(candidate => ({ ...candidate, ids: [...new Set(candidate.ids)], chunks: [...new Set(candidate.chunks)] }));
}
// Empty buckets must also exist so an unknown name yields a useful input error.
for (let value = 0; value < 4096; value++) {
  const bucket = value.toString(16).padStart(3, '0');
  await write(`names/${bucket}.json`, nameShards.get(bucket) || {});
}

// Keep the atlas' canonical normalized world paths; they are seam-safe and
// already omit duplicated longitude copies. The overview remains one request.
const worldRecords = (await read('compiled/world.json')).features.map(feature => ({ ...feature, d: compactWorldPath(simplifyCompiledPath(feature.d)) }));
await write('world.json', { format: 1, version: identity.version, extent, fingerprint: identity.fingerprint, features: worldRecords });
await write('meta.json', { format: 1, ...identity, extent, worldFile: 'world.json', namesPattern: 'names/{bucket}.json', regionsPattern: 'regions/{country}/{shard}.json', chunkSize: 4, nameBucketCount: 4096, source: manifest });
console.log(`Embed data: ${byId.size} regions, ${4096} name shards, ${shardCount} region shards, ${worldRecords.length} world features.`);
