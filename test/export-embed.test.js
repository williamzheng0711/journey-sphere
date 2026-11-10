import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir, access, symlink, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportEmbed } from '../scripts/export-embed.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const dataBaseUrl = `https://raw.githubusercontent.com/example/journey-sphere/${'a'.repeat(40)}/data/embed/`;
const manifest = JSON.parse(await readFile(path.join(root, 'data/compiled/manifest.json'), 'utf8'));
const aliases = await readFile(path.join(root, 'data/embed/aliases.js'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fixture = async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'journey-sphere-embed-export-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, outputDir: path.join(directory, 'runtime') };
};
const matchingManifest = async () => new Response(JSON.stringify(manifest));
const matchingData = async url => new URL(url).pathname.endsWith('/data/embed/aliases.js')
  ? new Response(aliases) : matchingManifest();
async function tree(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = `${prefix}${entry.name}`;
    if (entry.isDirectory()) files.push(...await tree(path.join(directory, entry.name), `${file}/`));
    else files.push(file);
  }
  return files.sort();
}

test('embed export copies canonical runtime and licensing without the geometry corpus', async t => {
  const { outputDir } = await fixture(t);
  const calls = [];
  const result = await exportEmbed({ outputDir, dataBaseUrl: dataBaseUrl.slice(0, -1), fetchImpl: async (url, options) => {
    calls.push(String(url));
    assert.ok(options.signal instanceof AbortSignal);
    return matchingData(url);
  } });
  assert.deepEqual(calls, [new URL('../compiled/manifest.json', dataBaseUrl).href, new URL('aliases.js', dataBaseUrl).href]);
  assert.equal(result.dataBaseUrl, dataBaseUrl);
  assert.equal(result.format, 1);
  assert.match(result.sourceCommit, /^[a-f0-9]{40}$/);
  const expectedSourceFiles = [
    'embed.js', 'LICENSE', 'data/README.md', 'data/embed/aliases.js', 'data/compiled/manifest.js',
    ...(await readdir(path.join(root, 'src'))).filter(file => /\.(?:js|css)$/.test(file)).map(file => `src/${file}`),
    ...(await tree(path.join(root, 'vendor'))).map(file => `vendor/${file}`),
  ];
  assert.deepEqual(await tree(outputDir), [...expectedSourceFiles, 'export-manifest.json', 'GENERATED.md'].sort());
  let bytes = 0;
  for (const file of expectedSourceFiles) {
    const source = await readFile(path.join(root, file));
    const output = await readFile(path.join(outputDir, file));
    assert.deepEqual(output, source, `${file} is copied from its canonical source`);
    assert.equal(result.sourceHashes[file], hash(source));
    assert.equal(result.files[file], hash(output));
    bytes += output.byteLength;
  }
  assert.ok(bytes < 3_000_000, `runtime is compact (${bytes} bytes)`);
  assert.equal(Object.keys(result.files).some(file => /\.(?:geojson|json)$/.test(file)), true, 'vendor engine provenance is retained');
  assert.deepEqual(Object.keys(result.files).filter(file => file.startsWith('data/')).sort(),
    ['data/README.md', 'data/compiled/manifest.js', 'data/embed/aliases.js']);
  assert.equal(result.sourceHashes['data/compiled/manifest.json'], hash(await readFile(path.join(root, 'data/compiled/manifest.json'))));
  assert.equal(result.sourceHashes['scripts/export-embed.mjs'], hash(await readFile(path.join(root, 'scripts/export-embed.mjs'))));
  assert.deepEqual(JSON.parse(await readFile(path.join(outputDir, 'export-manifest.json'), 'utf8')), result);
  const generated = await readFile(path.join(outputDir, 'GENERATED.md'), 'utf8');
  assert.ok(generated.includes(dataBaseUrl));
  assert.match(generated, /local embed\.js/);
  assert.match(generated, /data-base-url/);
  assert.match(generated, /Do not patch/);
  assert.equal(result.files['GENERATED.md'], hash(generated));
});

test('embed export rejects a different remote atlas before creating output files', async t => {
  const { outputDir } = await fixture(t);
  const changed = structuredClone(manifest);
  // The complete manifest is checked, not only its version or fingerprint.
  changed.countries.CHN.file = 'wrong-country.json';
  await assert.rejects(exportEmbed({ outputDir, dataBaseUrl, fetchImpl: async () => new Response(JSON.stringify(changed)) }), /does not match/);
  await assert.rejects(access(outputDir), { code: 'ENOENT' });
  await assert.rejects(exportEmbed({ outputDir, dataBaseUrl, fetchImpl: async () => new Response('Unavailable', { status: 503 }) }), /does not match/);
  await assert.rejects(access(outputDir), { code: 'ENOENT' });
});

test('embed export rejects changed alias chunks even when the remote atlas matches', async t => {
  const { outputDir } = await fixture(t);
  const changed = Buffer.from(aliases.toString().replace(/groups\//, 'changed-groups/'));
  assert.notDeepEqual(changed, aliases, 'fixture changes the chunk paths used by the resolver');
  const fetchImpl = async url => new URL(url).pathname.endsWith('/data/embed/aliases.js')
    ? new Response(changed) : matchingManifest();
  await assert.rejects(exportEmbed({ outputDir, dataBaseUrl, fetchImpl }), /Remote place aliases do not match/);
  await assert.rejects(access(outputDir), { code: 'ENOENT' });
  await mkdir(outputDir);
  await writeFile(path.join(outputDir, 'embed.js'), 'existing runtime');
  await writeFile(path.join(outputDir, 'retained.txt'), 'consumer data');
  await assert.rejects(exportEmbed({ outputDir, dataBaseUrl, fetchImpl }), /Remote place aliases do not match/);
  assert.deepEqual(await readdir(outputDir), ['embed.js', 'retained.txt']);
  assert.equal(await readFile(path.join(outputDir, 'embed.js'), 'utf8'), 'existing runtime');
  assert.equal(await readFile(path.join(outputDir, 'retained.txt'), 'utf8'), 'consumer data');
  await assert.rejects(exportEmbed({ outputDir, dataBaseUrl, fetchImpl: async url => new URL(url).pathname.endsWith('/data/embed/aliases.js')
    ? new Response('Unavailable', { status: 503 }) : matchingManifest() }), /Remote place aliases do not match/);
});

test('embed export requires an immutable GitHub raw data URL', async t => {
  const { outputDir } = await fixture(t);
  let requests = 0;
  for (const invalid of [
    undefined, 'not a URL', dataBaseUrl.replace('https:', 'http:'),
    dataBaseUrl.replace('raw.githubusercontent.com', 'cdn.jsdelivr.net'),
    dataBaseUrl.replace('a'.repeat(40), 'main'),
    dataBaseUrl.replace('a'.repeat(40), 'v1.0.0'),
    dataBaseUrl.replace('a'.repeat(40), 'abcdef12'),
    dataBaseUrl.replace('/data/embed/', '/data/'),
    `${dataBaseUrl}?ref=main`, `${dataBaseUrl}#data`,
    dataBaseUrl.replace('https://', 'https://user:password@'),
    dataBaseUrl.replace('raw.githubusercontent.com', 'raw.githubusercontent.com:444'),
  ]) {
    await assert.rejects(exportEmbed({ outputDir, dataBaseUrl: invalid, fetchImpl: async () => { requests++; return matchingManifest(); } }), /full 40-character commit SHA/);
  }
  assert.equal(requests, 0);
  await assert.rejects(access(outputDir), { code: 'ENOENT' });
});

test('embed export protects source files from overlapping output paths and symlinks', async t => {
  const { directory, outputDir } = await fixture(t);
  const sourcePath = path.join(root, 'src/embed.js');
  const sourceBefore = await readFile(sourcePath);
  let requests = 0;
  const fetchImpl = async url => { requests++; return matchingData(url); };
  for (const unsafe of [root, path.join(root, 'generated-embed-runtime'), path.dirname(root)]) {
    await assert.rejects(exportEmbed({ outputDir: unsafe, dataBaseUrl, fetchImpl }), /outside the JourneySphere/);
  }
  const alias = path.join(directory, 'source-alias');
  await symlink(await realpath(root), alias, 'dir');
  await assert.rejects(exportEmbed({ outputDir: path.join(alias, 'generated-embed-runtime'), dataBaseUrl, fetchImpl }), /outside the JourneySphere/);
  assert.equal(requests, 0, 'unsafe output paths are rejected before network requests');
  await mkdir(outputDir);
  await symlink(path.join(root, 'src'), path.join(outputDir, 'src'), 'dir');
  await assert.rejects(exportEmbed({ outputDir, dataBaseUrl, fetchImpl }), /symbolic links/);
  assert.deepEqual(await readdir(outputDir), ['src'], 'preflight completes before any generated files are written');
  assert.deepEqual(await readFile(sourcePath), sourceBefore);
});
