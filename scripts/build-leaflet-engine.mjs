#!/usr/bin/env node

// Build the production engine from the retained, unmodified Leaflet source.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { minify } from 'terser';

const require = createRequire(import.meta.url);
const TERSER_VERSION = '5.51.2';
const SOURCE_SHA256 = '39ee93464f11fe3847137e50c0dc8189f706c460e36989ea7871bf7d540f3306';
const LICENSE_SHA256 = '53e8dc25862014e4324741ca18fbe3611e11d42ef69f59f86ea8c5389647d4cb';
const sourceDirectory = fileURLToPath(new URL('../vendor/leaflet/', import.meta.url));
const sourceFile = 'leaflet-src.esm.js';
const outputFile = 'leaflet.esm.min.js';
const provenanceFile = 'engine-build.json';
const digest = value => createHash('sha256').update(value).digest('hex');

// ES module exports retain their public names. Leaflet's public and private
// property names are also used by map plugins, so property mangling is disabled.
const options = {
  module: true,
  ecma: 2015,
  compress: { passes: 2, unsafe: false },
  mangle: { properties: false },
  safari10: true,
  format: { comments: false, ascii_only: true },
};

export async function buildLeafletEngine({ sourceDir = sourceDirectory, outputDir = sourceDir, check = false } = {}) {
  const version = require('terser/package.json').version;
  if (version !== TERSER_VERSION) throw new Error(`Leaflet engine build requires Terser ${TERSER_VERSION}; found ${version}.`);
  const [source, license] = await Promise.all([
    readFile(resolve(sourceDir, sourceFile)),
    readFile(resolve(sourceDir, 'LICENSE')),
  ]);
  if (digest(source) !== SOURCE_SHA256 || digest(license) !== LICENSE_SHA256) {
    throw new Error('Leaflet engine source or license does not match the pinned 1.9.4 distribution.');
  }
  const text = source.toString('utf8');
  const banner = text.match(/^\/\* @preserve[\s\S]*?\*\//)?.[0];
  if (!banner) throw new Error('Leaflet engine source is missing its preserved license banner.');
  // Terser fills nested option defaults in place. Keep the requested settings
  // separate so provenance records the same explicit options on every build.
  const minifyOptions = structuredClone(options);
  minifyOptions.format.preamble = banner;
  const result = await minify({ [sourceFile]: text }, minifyOptions);
  if (!result.code) throw new Error('Leaflet engine minifier produced no code.');
  const code = `${result.code}\n`;
  const provenance = {
    format: 1,
    source: { file: sourceFile, version: '1.9.4', sha256: digest(source), bytes: source.length,
      url: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet-src.esm.js' },
    license: { file: 'LICENSE', sha256: digest(license) },
    minifier: { name: 'terser', version, options },
    output: { file: outputFile, sha256: digest(code), bytes: Buffer.byteLength(code) },
  };
  // No timestamp or host paths: builds on different machines have the same bytes.
  const metadata = `${JSON.stringify(provenance, null, 2)}\n`;
  if (check) {
    const [published, publishedMetadata] = await Promise.all([
      readFile(resolve(outputDir, outputFile), 'utf8'),
      readFile(resolve(outputDir, provenanceFile), 'utf8'),
    ]);
    if (published !== code || publishedMetadata !== metadata) {
      throw new Error('Published Leaflet engine is stale; run npm run build:engine.');
    }
  } else {
    await writeFile(resolve(outputDir, outputFile), code);
    await writeFile(resolve(outputDir, provenanceFile), metadata);
  }
  return provenance;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { check: { type: 'boolean', default: false } } });
  const result = await buildLeafletEngine({ check: values.check });
  console.log(`${values.check ? 'Verified' : 'Built'} Leaflet ${result.source.version} engine: ${result.source.bytes} → ${result.output.bytes} bytes.`);
}
