import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compactWorldPath } from '../scripts/lib/compact-world-path.mjs';

// Read coordinate pairs independently of explicit/implicit command spelling.
function ringCoordinates(path) {
  return [...path.matchAll(/M([^M]+)z/g)].map(([, ring]) => {
    const numbers = [...ring.matchAll(/-?\d+/g)].map(([number]) => Number(number));
    assert.equal(numbers.length % 2, 0);
    const points = [[numbers[0], numbers[1]]];
    for (let index = 2; index < numbers.length; index += 2) {
      const previous = points.at(-1);
      points.push([previous[0] + numbers[index], previous[1] + numbers[index + 1]]);
    }
    assert.deepEqual(points.at(-1), points[0]);
    return points;
  });
}

test('world syntax compaction preserves positive, negative and zero coordinates', () => {
  const source = 'M-20 -30l40 0l0 60l-40 0l0 -60z M10 20l-5 -6l0 2l5 4z';
  const compact = compactWorldPath(source);
  assert.equal(compact, 'M-20-30l40 0 0 60-40 0 0-60zM10 20l-5-6 0 2 5 4z');
  assert.deepEqual(ringCoordinates(compact), ringCoordinates(source));
  assert.equal(compactWorldPath(` ${source.replace('z M', 'z  M')} `), compact);
  assert.throws(() => compactWorldPath('M0 0l1 1z'), /Invalid/);
  assert.throws(() => compactWorldPath('M0 0L1 1L2 2L0 0z'), /Invalid/);
});

test('every canonical country keeps exactly the same rings and vertices', async () => {
  const source = JSON.parse(await readFile(new URL('../data/compiled/world.json', import.meta.url)));
  for (const feature of source.features) {
    const compact = compactWorldPath(feature.d);
    assert.deepEqual(ringCoordinates(compact), ringCoordinates(feature.d), feature.countryCode);
    assert.ok(compact.length < feature.d.length, feature.countryCode);
  }
});
