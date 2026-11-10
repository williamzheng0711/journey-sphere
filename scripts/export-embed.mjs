#!/usr/bin/env node
import { readFile, writeFile, mkdir, readdir, realpath, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, isDeepStrictEqual } from 'node:util';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const digest = value => createHash('sha256').update(value).digest('hex');
const inside = (parent, child) => {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith('../') && !isAbsolute(path));
};

function pinnedDataUrl(value) {
  let url;
  try { url = new URL(value); } catch { /* Report the required format below. */ }
  if (!url || url.protocol !== 'https:' || url.hostname !== 'raw.githubusercontent.com' ||
      url.port || url.username || url.password || url.search || url.hash ||
      !/^\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/[a-f0-9]{40}\/data\/embed\/?$/.test(url.pathname)) {
    throw new Error('Data base URL must be an HTTPS raw.githubusercontent.com URL pinned to a full 40-character commit SHA and ending in /data/embed/.');
  }
  url.pathname = url.pathname.replace(/\/?$/, '/');
  return url;
}

// Resolve the existing parent too, so a symlink cannot turn an apparently
// separate output directory into a write over the canonical project.
async function resolvedDestination(path) {
  try { return await realpath(path); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return resolve(await resolvedDestination(dirname(path)), relative(dirname(path), path));
  }
}

/** Export the small embed runtime; geometry stays on a verified pinned host. */
export async function exportEmbed({ outputDir, dataBaseUrl, fetchImpl = globalThis.fetch }) {
  if (!outputDir) throw new Error('An output directory is required.');
  const dataUrl = pinnedDataUrl(dataBaseUrl);
  const output = await resolvedDestination(resolve(outputDir));
  const source = await realpath(sourceRoot);
  if (inside(source, output) || inside(output, source)) {
    throw new Error('Output must be outside the JourneySphere source directory and its parent directories.');
  }

  const read = file => readFile(resolve(sourceRoot, file));
  const manifestBytes = await read('data/compiled/manifest.json');
  const manifest = JSON.parse(manifestBytes);
  const response = await fetchImpl(new URL('../compiled/manifest.json', dataUrl), { signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !isDeepStrictEqual(await response.json(), manifest)) {
    throw new Error('Remote atlas does not match the source atlas; choose a compatible pinned data release.');
  }
  // The embed builder can change alias group paths without changing the atlas
  // manifest. Check the actual index that the copied resolver imports too.
  const aliasesBytes = await read('data/embed/aliases.js');
  const aliasesResponse = await fetchImpl(new URL('aliases.js', dataUrl), { signal: AbortSignal.timeout(30_000) });
  if (!aliasesResponse.ok || !Buffer.from(await aliasesResponse.arrayBuffer()).equals(aliasesBytes)) {
    throw new Error('Remote place aliases do not match the source aliases; choose a pinned data release built from the same embed data.');
  }

  const files = new Map([['data/embed/aliases.js', aliasesBytes]]);
  const sourceHashes = {
    'data/compiled/manifest.json': digest(manifestBytes),
    'data/embed/aliases.js': digest(aliasesBytes),
    'scripts/export-embed.mjs': digest(await read('scripts/export-embed.mjs')),
  };
  async function include(file) {
    const bytes = await read(file);
    files.set(file, bytes);
    sourceHashes[file] = digest(bytes);
    return bytes;
  }
  async function includeTree(directory) {
    const entries = (await readdir(resolve(sourceRoot, directory), { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await includeTree(file);
      else if (entry.isFile()) await include(file);
    }
  }
  for (const file of ['embed.js', 'LICENSE', 'data/README.md']) await include(file);
  for (const entry of (await readdir(resolve(sourceRoot, 'src'), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && /\.(?:js|css)$/.test(entry.name)) await include(`src/${entry.name}`);
  }
  const manifestModule = await include('data/compiled/manifest.js');
  const moduleManifest = JSON.parse(manifestModule.toString().replace(/^export default\s*/, '').replace(/;\s*$/, ''));
  if (!isDeepStrictEqual(moduleManifest, manifest)) {
    throw new Error('The source atlas manifest module does not match manifest.json; rebuild the atlas before exporting.');
  }
  // Ship the production engine, upstream source, licenses and build hashes.
  await includeTree('vendor');
  files.set('GENERATED.md', `# Generated JourneySphere embed runtime\n\nThis directory is generated from the JourneySphere project. Keep map changes in that project and rerun scripts/export-embed.mjs. Do not patch the copied runtime by hand.\n\nLoad the local embed.js script from this directory and set each <journey-sphere> element's data-base-url to:\n\n${dataUrl.href}\n\nThe runtime is served by the consuming website. Geometry and place indexes are fetched from this pinned GitHub commit, so no large geometry corpus or jsDelivr package request is needed. Keep this data URL with the generated runtime when deploying.\n\nexport-manifest.json records the source base commit, exact source hashes (including local changes), output hashes and dataBaseUrl. The source base commit alone does not identify uncommitted changes. Software and geographic-data attribution are in LICENSE and data/README.md; vendor licenses are retained under vendor/.\n`);
  let sourceCommit = null;
  try { sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Source archives may not have Git metadata. */ }
  const provenance = {
    format: 1, sourceCommit, sourceHashes, dataBaseUrl: dataUrl.href,
    files: Object.fromEntries([...files].map(([file, bytes]) => [file, digest(bytes)])),
  };
  files.set('export-manifest.json', `${JSON.stringify(provenance, null, 2)}\n`);
  // Check every destination before the first write. A previous deployment may
  // contain symlinks even when its top-level directory is safe.
  for (const file of files.keys()) {
    let target = resolve(output, file);
    while (target !== output) {
      try {
        if ((await lstat(target)).isSymbolicLink()) throw new Error('Export destinations must not contain symbolic links.');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      target = dirname(target);
    }
  }
  for (const [file, bytes] of files) {
    const destination = resolve(output, file);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  return provenance;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, 'data-base-url': { type: 'string' } } });
  if (!values.out || !values['data-base-url']) {
    throw new Error('Usage: node scripts/export-embed.mjs --out deployment-dir --data-base-url https://raw.githubusercontent.com/owner/repo/<full-commit-sha>/data/embed/');
  }
  const result = await exportEmbed({ outputDir: values.out, dataBaseUrl: values['data-base-url'] });
  console.log(`Exported ${Object.keys(result.files).length} runtime files; source and output hashes recorded. No geometry corpus copied.`);
}
