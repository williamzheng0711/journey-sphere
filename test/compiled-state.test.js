import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  decodeVisited,
  decodeVisitedIndices,
  describeCatalog,
  encodeVisited,
  encodeVisitedIndices,
} from '../src/state.js';

const catalog = JSON.parse(await readFile(new URL('../data/catalog.json', import.meta.url), 'utf8'));

function smallCatalog(count) {
  return { version: 'compiled-test', regionIds: Array.from({ length: count }, (_, index) => `region-${index}`) };
}

test('compiled descriptor round-trips real catalog and is byte-identical to ID encoding', () => {
  const descriptor = describeCatalog(catalog);
  const indices = [catalog.regionIds.length - 1, 0, 8, 257, 1024].filter(index => index < descriptor.regionCount);
  const ids = indices.map(index => catalog.regionIds[index]);

  const oldCodeword = encodeVisited(ids, catalog);
  const compiledCodeword = encodeVisitedIndices(indices, descriptor);
  assert.equal(compiledCodeword, oldCodeword);
  assert.deepEqual(decodeVisitedIndices(compiledCodeword, descriptor), [...indices].sort((a, b) => a - b));
  assert.deepEqual(decodeVisited(compiledCodeword, catalog), [...indices].sort((a, b) => a - b).map(index => catalog.regionIds[index]));
  assert.equal(descriptor.regionCount, catalog.regionIds.length);
  assert.equal(descriptor.fingerprint.length, 2);
});

test('compiled state handles bitset boundary counts', () => {
  for (const count of [0, 1, 7, 8, 9, 15, 16, 17, 255, 256, 257]) {
    const testCatalog = smallCatalog(count);
    const descriptor = describeCatalog(testCatalog);
    const indices = [...new Set([0, 7, 8, count - 1].filter(index => index >= 0 && index < count))];
    const codeword = encodeVisitedIndices(indices, descriptor);
    assert.deepEqual(decodeVisitedIndices(codeword, descriptor), [...new Set(indices)].sort((a, b) => a - b));
  }
});

test('compiled state rejects invalid descriptors and index lists', () => {
  const descriptor = describeCatalog(smallCatalog(3));
  const invalidDescriptors = [
    null,
    {},
    { ...descriptor, version: '' },
    { ...descriptor, regionCount: -1 },
    { ...descriptor, regionCount: 1.5 },
    { ...descriptor, regionCount: 0x100000000 },
    { ...descriptor, fingerprint: [1] },
    { ...descriptor, fingerprint: [1, -1] },
    { ...descriptor, fingerprint: [1, 1.5] },
  ];
  for (const invalid of invalidDescriptors) {
    assert.throws(() => encodeVisitedIndices([], invalid));
    assert.throws(() => decodeVisitedIndices('js1_AAAA', invalid));
  }

  assert.throws(() => encodeVisitedIndices([1, 1], descriptor), /duplicate/i);
  assert.throws(() => encodeVisitedIndices([-1], descriptor), /range/i);
  assert.throws(() => encodeVisitedIndices([3], descriptor), /range/i);
  assert.throws(() => encodeVisitedIndices([1.5], descriptor), /range/i);
  assert.throws(() => encodeVisitedIndices('1', descriptor), /array/i);
});

test('compiled state preserves strict format, padding, and fingerprint validation', () => {
  const descriptor = describeCatalog(smallCatalog(9));
  const valid = encodeVisitedIndices([], descriptor);
  for (const malformed of ['', 'js1_', 'js1_!', 'js1_A', `${valid}=`, `${valid.slice(0, -1)}!`]) {
    assert.throws(() => decodeVisitedIndices(malformed, descriptor));
  }
  assert.throws(() => decodeVisitedIndices(valid, { ...descriptor, fingerprint: [descriptor.fingerprint[0] ^ 1, descriptor.fingerprint[1]] }), /does not match/i);

  const padding = mutatePayloadByte(valid, 16, 0x01);
  assert.throws(() => decodeVisitedIndices(padding, descriptor), /padding/i);
  const header = mutatePayloadByte(valid, 2, 0xff);
  assert.throws(() => decodeVisitedIndices(header, descriptor), /format/i);
});

function mutatePayloadByte(codeword, byteIndex, xorMask) {
  const encoded = codeword.slice('js1_'.length).replaceAll('-', '+').replaceAll('_', '/');
  const bytes = Uint8Array.from(Buffer.from(encoded, 'base64'));
  bytes[byteIndex] ^= xorMask;
  return `js1_${Buffer.from(bytes).toString('base64url')}`;
}
