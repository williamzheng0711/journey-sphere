import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { buildLeafletEngine } from '../scripts/build-leaflet-engine.mjs';

const vendor = new URL('../vendor/leaflet/', import.meta.url);
const digest = value => createHash('sha256').update(value).digest('hex');
const exportNames = text => {
  const block = /export\s*\{([^}]+)\}/.exec(text)?.[1];
  assert.ok(block, 'engine retains its named ES module exports');
  return block.split(',').map(entry => entry.trim().split(/\s+as\s+/).at(-1)).sort();
};

test('published Leaflet engine rebuilds identically with its license and public exports', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'journey-sphere-engine-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await buildLeafletEngine({ outputDir: directory });
  const [source, license, published, provenance, rebuilt, rebuiltProvenance] = await Promise.all([
    readFile(new URL('leaflet-src.esm.js', vendor), 'utf8'),
    readFile(new URL('LICENSE', vendor)),
    readFile(new URL('leaflet.esm.min.js', vendor), 'utf8'),
    readFile(new URL('engine-build.json', vendor), 'utf8'),
    readFile(path.join(directory, 'leaflet.esm.min.js'), 'utf8'),
    readFile(path.join(directory, 'engine-build.json'), 'utf8'),
  ]);
  assert.equal(rebuilt, published, 'the committed production engine matches the pinned build');
  assert.equal(rebuiltProvenance, provenance, 'provenance has no changing timestamps or host paths');
  assert.equal(result.source.sha256, digest(source));
  assert.equal(result.license.sha256, digest(license));
  assert.equal(result.output.sha256, digest(published));
  assert.equal(result.output.bytes, Buffer.byteLength(published));
  assert.equal(result.minifier.options.mangle.properties, false);
  assert.equal(result.minifier.options.compress.unsafe, false);
  const banner = source.slice(0, source.indexOf('*/') + 2);
  assert.ok(published.startsWith(`${banner}\n`), 'original Leaflet copyright banner remains at the top');
  assert.deepEqual(exportNames(published), exportNames(source), 'every original named export remains available');
  assert.ok(gzipSync(published, { level: 9 }).length < gzipSync(source, { level: 9 }).length / 2,
    'production engine removes at least half of the compressed development download');
  await buildLeafletEngine({ outputDir: directory, check: true });
  await writeFile(path.join(directory, 'leaflet.esm.min.js'), `${rebuilt}\n// stale output\n`);
  await assert.rejects(buildLeafletEngine({ outputDir: directory, check: true }), /engine is stale/);
});

test('changing pinned Leaflet source or license fails before replacing production files', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'journey-sphere-engine-source-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const [source, license] = await Promise.all([
    readFile(new URL('leaflet-src.esm.js', vendor)),
    readFile(new URL('LICENSE', vendor)),
  ]);
  await writeFile(path.join(directory, 'leaflet.esm.min.js'), 'previous production engine');
  for (const changed of ['source', 'license']) {
    await writeFile(path.join(directory, 'leaflet-src.esm.js'), changed === 'source' ? `${source}\n// changed source` : source);
    await writeFile(path.join(directory, 'LICENSE'), changed === 'license' ? `${license}\nchanged license` : license);
    await assert.rejects(buildLeafletEngine({ sourceDir: directory }), /pinned 1\.9\.4 distribution/);
    assert.equal(await readFile(path.join(directory, 'leaflet.esm.min.js'), 'utf8'), 'previous production engine');
  }
});
