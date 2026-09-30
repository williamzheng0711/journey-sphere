#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, isDeepStrictEqual } from 'node:util';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const sourceFiles = ['src/compiled.js', 'src/compiled-layer.js', 'src/outline-detail.js', 'src/state.js', 'src/style.css', 'LICENSE', 'README.md', 'data/README.md'];

/** Build a static deployment from canonical map sources and a consumer's visits. */
export async function exportStatic({ recordPath, outputDir, fallbackDataUrl }) {
  const output = resolve(outputDir);
  // Export into a dedicated directory, never over canonical source files.
  if (sourceRoot.startsWith(`${output}/`) || output === sourceRoot.replace(/\/$/, '') || output.startsWith(sourceRoot)) {
    throw new Error('Output must be outside the JourneySphere source directory.');
  }
  const read = file => readFile(resolve(sourceRoot, file));
  const manifest = JSON.parse(await read('data/compiled/manifest.json'));
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  if (record.atlasVersion !== manifest.version || !Array.isArray(record.visited) ||
      record.visited.some(id => typeof id !== 'string') || new Set(record.visited).size !== record.visited.length) {
    throw new Error('Travel record must contain unique region IDs and match the atlas version.');
  }
  const codes = [...new Set(record.visited.map(id => id.split(':')[0]))];
  const countries = {};
  const files = new Map();
  const sourceHashes = {};
  async function include(file) {
    const bytes = await read(file);
    files.set(file, bytes);
    sourceHashes[file] = digest(bytes);
    return bytes;
  }
  for (const file of sourceFiles) await include(file);
  await include('data/catalog.json');
  await include(`data/compiled/${manifest.worldFile}`);
  for (const code of codes) {
    const entry = manifest.countries[code];
    if (!entry?.file) throw new Error(`Unknown country: ${code}`);
    const data = JSON.parse(await include(`data/compiled/${entry.file}`));
    if (data.version !== manifest.version || data.format !== manifest.format || data.extent !== manifest.extent ||
        JSON.stringify(data.fingerprint) !== JSON.stringify(manifest.fingerprint)) throw new Error(`Atlas mismatch: ${code}`);
    const selected = new Set(record.visited.filter(id => id.startsWith(`${code}:`)));
    const features = data.features.filter(feature => selected.has(feature.id));
    if (features.length !== selected.size) throw new Error(`Unknown region ID in ${code}`);
    countries[code] = { ...data, features, admin1: [] };
  }
  const deployment = structuredClone(manifest);
  let fallback;
  if (fallbackDataUrl) {
    fallback = new URL(fallbackDataUrl.endsWith('/') ? fallbackDataUrl : `${fallbackDataUrl}/`);
    if (fallback.protocol !== 'https:') throw new Error('Fallback data URL must use HTTPS.');
    const response = await fetch(new URL('compiled/manifest.json', fallback), { signal: AbortSignal.timeout(30_000) });
    if (!response.ok || !isDeepStrictEqual(await response.json(), manifest)) {
      throw new Error('Fallback atlas does not match the source atlas; update the pinned fallback release.');
    }
  }
  for (const [code, entry] of Object.entries(deployment.countries)) {
    if (!entry.file || codes.includes(code)) continue;
    if (fallback) entry.file = new URL(`compiled/${entry.file}`, fallback).href;
    else await include(`data/compiled/${entry.file}`);
  }
  // Outlines follow the viewport, including countries with no selected regions.
  // Keep their manifest and attribution local even with a remote country fallback.
  if (manifest.outlines) {
    await include('data/outlines/manifest.json');
    await include('data/outlines/sources.json');
    if (manifest.outlines.detailZoom !== undefined) {
      await include('data/outlines/overview/manifest.json');
      await include('data/outlines/overview/provenance.json');
    }
    for (const [code, entry] of Object.entries(manifest.outlines.countries)) {
      // Keep the generated tier corpus together with its provenance, including
      // exact fallback records whose runtime URL reuses the full outline.
      if (manifest.outlines.detailZoom !== undefined) await include(`data/outlines/overview/${code}.json`);
      for (const outlineFile of new Set([entry.file, entry.overviewFile].filter(Boolean))) {
        const file = relative(sourceRoot, resolve(sourceRoot, 'data/compiled/', outlineFile));
        if (!file.startsWith('data/outlines/')) throw new Error('Outline export paths must stay inside data/outlines/.');
        await include(file);
      }
    }
  }
  sourceHashes['data/compiled/manifest.json'] = digest(await read('data/compiled/manifest.json'));
  sourceHashes['scripts/export-static.mjs'] = digest(await read('scripts/export-static.mjs'));
  files.set('data/compiled/manifest.json', JSON.stringify(deployment));
  files.set('data/compiled/manifest.js', `export default ${JSON.stringify(deployment)};\n`);
  files.set('data/startup.json', JSON.stringify({ atlasVersion: record.atlasVersion, visited: record.visited, labels: record.labels, countries }));
  let sourceCommit = null;
  try { sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim(); } catch { /* Archive exports may not have Git metadata. */ }
  const provenance = {
    format: 1, sourceCommit, sourceHashes,
    recordSha256: digest(await readFile(recordPath)),
    fallbackDataUrl: fallback?.href || null,
    files: Object.fromEntries([...files].map(([file, bytes]) => [file, digest(bytes)])),
  };
  files.set('export-manifest.json', `${JSON.stringify(provenance, null, 2)}\n`);
  files.set('GENERATED.md', '# Generated JourneySphere deployment\n\nDo not edit map code or geometry here. Maintain them in the JourneySphere project and rerun its scripts/export-static.mjs through the consuming website\'s sync command.\n\nexport-manifest.json records the source base commit, exact source hashes (including local changes), input record hash and deployed file hashes. The base commit alone does not identify uncommitted source changes.\n\nCountry URLs are deployment configuration generated from the chosen fallback data URL. Keep that URL pinned to a compatible atlas release. Software and geographic-data attribution are in LICENSE and data/README.md.\n');
  for (const [file, bytes] of files) {
    const destination = resolve(output, file);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  return provenance;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { record: { type: 'string' }, out: { type: 'string' }, 'fallback-data-url': { type: 'string' } } });
  if (!values.record || !values.out) {
    throw new Error('Usage: node scripts/export-static.mjs --record visits.json --out deployment-dir [--fallback-data-url https://.../data/]');
  }
  const result = await exportStatic({ recordPath: values.record, outputDir: values.out, fallbackDataUrl: values['fallback-data-url'] });
  console.log(`Exported ${Object.keys(result.files).length} files from JourneySphere; source and deployment hashes recorded.`);
}
