import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { exportStatic } from '../scripts/export-static.mjs';

const manifest = JSON.parse(await readFile(new URL('../data/compiled/manifest.json', import.meta.url)));
const country = JSON.parse(await readFile(new URL('../data/compiled/countries/CHN.json', import.meta.url)));
const selected = country.features.find(feature => feature.id === 'CHN:ADM2:310000');

test('static export preserves exact selected geometry, canonical runtime and reproducible provenance', async t => {
  let remoteManifest = manifest;
  const originalFetch = globalThis.fetch;
  t.after(() => { if (originalFetch) globalThis.fetch = originalFetch; else delete globalThis.fetch; });
  globalThis.fetch = async url => {
    assert.equal(String(url), 'https://example.org/release/data/compiled/manifest.json');
    return { ok: true, json: async () => structuredClone(remoteManifest) };
  };
  const temp = await mkdtemp(join(tmpdir(), 'journeysphere-export-'));
  try {
    const recordPath = join(temp, 'visits.json');
    const outputDir = join(temp, 'deployment');
    await writeFile(recordPath, JSON.stringify({ atlasVersion: manifest.version, visited: [selected.id], labels: {} }));
    const options = { recordPath, outputDir, fallbackDataUrl: 'https://example.org/release/data/' };
    const first = await exportStatic(options);
    assert.deepEqual(await exportStatic(options), first);
    const startup = JSON.parse(await readFile(join(outputDir, 'data/startup.json')));
    assert.deepEqual(startup.countries.CHN.features, [selected]);
    assert.deepEqual(await readFile(join(outputDir, 'src/compiled.js')), await readFile(new URL('../src/compiled.js', import.meta.url)));
    const deployed = JSON.parse(await readFile(join(outputDir, 'data/compiled/manifest.json')));
    assert.equal(deployed.countries.CHN.file, manifest.countries.CHN.file);
    assert.equal(deployed.countries.USA.file, 'https://example.org/release/data/compiled/countries/USA.json');
    assert.deepEqual(await readFile(join(outputDir, 'src/outline-detail.js')), await readFile(new URL('../src/outline-detail.js', import.meta.url)));
    assert.ok(first.files['data/outlines/HKG.json']);
    assert.ok(first.files['data/outlines/overview/HKG.json']);
    assert.ok(first.files['data/outlines/overview/provenance.json']);
    assert.ok(first.files['data/outlines/sources.json']);
    assert.deepEqual(deployed.outlines, manifest.outlines);
    for (const [file, hash] of Object.entries(first.files)) {
      assert.equal(createHash('sha256').update(await readFile(join(outputDir, file))).digest('hex'), hash);
    }
    remoteManifest = { ...manifest, fingerprint: [0, 0] };
    await assert.rejects(exportStatic(options), /Fallback atlas does not match/);
    remoteManifest = manifest;
    for (const visited of [[selected.id, selected.id], ['CHN:missing'], ['BAD:missing']]) {
      await writeFile(recordPath, JSON.stringify({ atlasVersion: manifest.version, visited }));
      await assert.rejects(exportStatic(options));
    }
    await writeFile(recordPath, JSON.stringify({ atlasVersion: 'wrong', visited: [selected.id] }));
    await assert.rejects(exportStatic(options), /atlas version/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});


test('default export supports empty visits and serves every country locally', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'journeysphere-full-export-'));
  try {
    const recordPath = join(temp, 'visits.json');
    const outputDir = join(temp, 'deployment');
    await writeFile(recordPath, JSON.stringify({ atlasVersion: manifest.version, visited: [] }));
    const result = await exportStatic({ recordPath, outputDir });
    assert.equal(result.fallbackDataUrl, null);
    assert.deepEqual(JSON.parse(await readFile(join(outputDir, 'data/compiled/manifest.json'))), manifest);
    assert.deepEqual(JSON.parse(await readFile(join(outputDir, 'data/startup.json'))).countries, {});
    for (const entry of Object.values(manifest.countries)) {
      if (entry.file) assert.ok(result.files[`data/compiled/${entry.file}`]);
    }
    for (const code of Object.keys(manifest.outlines.countries)) {
      assert.ok(result.files[`data/outlines/${code}.json`]);
      assert.ok(result.files[`data/outlines/overview/${code}.json`]);
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
