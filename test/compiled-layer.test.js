import test from 'node:test';
import assert from 'node:assert/strict';

import { createCompiledLayer } from '../src/compiled-layer.js';

function makeLeaflet() {
  class GridLayer {
    constructor() { this.redrawCount = 0; }
    getTileSize() { return { x: 256, y: 256 }; }
    redraw() { this.redrawCount += 1; return this; }
    onAdd(map) { map.added = true; }
    onRemove(map) { map.removed = true; }
  }
  GridLayer.extend = methods => {
    class Extended extends GridLayer {}
    Object.assign(Extended.prototype, methods);
    return Extended;
  };
  return {
    GridLayer,
    tooltip: () => {
      const tooltip = {
        setLatLng(value) { tooltip.latlng = value; return tooltip; },
        setContent(value) { tooltip.content = value; return tooltip; },
        addTo(map) { tooltip.map = map; map.addLayer(tooltip); return tooltip; },
      };
      return tooltip;
    },
  };
}

function makeCanvas() {
  const calls = [];
  const context = {
    calls,
    save: () => calls.push(['save']), restore: () => calls.push(['restore']),
    setTransform: (...args) => calls.push(['transform', ...args]), translate: (...args) => calls.push(['translate', ...args]),
    fill: (...args) => calls.push(['fill', ...args]), stroke: path => calls.push(['stroke', path]),
    isPointInPath: (...args) => { calls.push(['hit', ...args]); return true; },
  };
  return {
    width: 0, height: 0, style: {}, calls,
    getContext: () => context,
  };
}

function withBrowserCanvas(callback) {
  const originalDocument = globalThis.document;
  const originalPath2D = globalThis.Path2D;
  const canvases = [];
  globalThis.Path2D = class MockPath2D {
    constructor(d) { this.d = d; }
  };
  globalThis.document = { createElement: name => {
    if (name === 'span') return { textContent: '' };
    assert.equal(name, 'canvas');
    const canvas = makeCanvas();
    canvases.push(canvas);
    return canvas;
  } };
  return Promise.resolve().then(() => callback(canvases)).finally(() => {
    globalThis.document = originalDocument;
    globalThis.Path2D = originalPath2D;
  });
}

function record(id, parentId, countryCode = 'AA') {
  const marker = [...id].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 100;
  return { id, name: id, countryCode, parentId, index: 0, d: `M${marker} 0l16777216 0l0 16777216l-16777216 0z`, bounds: [0, 0, 16777216, 16777216] };
}

function mapMock() {
  const handlers = new Map();
  return {
    handlers, layers: [], removedLayers: [],
    on(name, handler, context) { handlers.set(name, { handler, context }); },
    off(name) { handlers.delete(name); },
    addLayer(layer) { this.layers.push(layer); },
    removeLayer(layer) { this.removedLayers.push(layer); },
    project: () => ({ x: 128, y: 128 }),
    getZoom: () => 0,
  };
}

test('compiled layer draws world, active outlines, selected regions, and selected siblings', async () => {
  await withBrowserCanvas(async canvases => {
    const L = makeLeaflet();
    const world = { features: [record('world', null, 'ZZ')] };
    const selected = record('AA:1', 'P1');
    const sibling = record('AA:2', 'P1');
    const hidden = record('AA:3', 'P2');
    const admin1 = record('P1', null);
    const layer = createCompiledLayer(L, {
      world, extent: 2 ** 24, getCountries: () => [{ features: [selected, sibling, hidden], admin1: [admin1] }],
      getVisited: () => ['AA:1'], colorFor: () => '#123456', fillOpacity: 0.44,
    });
    const tile = layer.createTile({ x: 0, y: 0, z: 0 }, () => {});
    assert.equal(tile.width, 256);
    const filledPaths = new Set(canvases[0].calls.filter(call => call[0] === 'fill').map(call => call[1].d));
    assert.equal(canvases[0].calls.some(call => call[0] === 'fill' && call[2] === 'evenodd'), true);
    assert.equal(filledPaths.has(world.features[0].d), true);
    assert.equal(canvases[0].calls.some(call => call[0] === 'fill' && call[1].d === selected.d), true);
    assert.equal(canvases[0].calls.some(call => call[0] === 'stroke' && call[1].d === sibling.d), true);
    assert.equal(canvases[0].calls.some(call => call[0] === 'stroke' && call[1].d === admin1.d), true);
    assert.equal(filledPaths.has(hidden.d), false);
  });
});

test('compiled layer uses one lazy path per record and supports click, visited hover, refresh, and cleanup', async () => {
  await withBrowserCanvas(async canvases => {
    const L = makeLeaflet();
    const selected = record('AA:1', 'P1');
    const hidden = record('AA:2', 'P2');
    const toggles = [];
    const layer = createCompiledLayer(L, {
      world: { features: [] }, extent: 2 ** 24,
      getCountries: () => [{ features: [selected, hidden], admin1: [] }],
      getVisited: () => ['AA:1'], labels: { 'AA:1': 'Selected label' }, interactive: true,
      onToggle: id => toggles.push(id), colorFor: () => '#123456',
    });
    const map = mapMock();
    layer.onAdd(map);
    map.handlers.get('click').handler.call(layer, { latlng: {} });
    assert.deepEqual(toggles, ['AA:1']);
    const tooltip = layer._compiledTooltip;
    map.handlers.get('mousemove').handler.call(layer, { latlng: {} });
    assert.equal(tooltip.content.textContent, 'Selected label');
    assert.equal(map.layers.includes(tooltip), true);
    layer.refresh();
    assert.equal(layer.redrawCount, 1);
    assert.equal(map.removedLayers.includes(tooltip), true);
    layer.onRemove(map);
    assert.equal(map.handlers.has('click'), false);
    assert.equal(map.handlers.size, 0);
    assert.equal(map.removed, true);
    assert.equal(canvases.length, 1);
  });
});

test('interactive false avoids event hooks and toggles', async () => {
  await withBrowserCanvas(async () => {
    const L = makeLeaflet();
    const map = mapMock();
    let toggled = false;
    const layer = createCompiledLayer(L, {
      world: { features: [] }, extent: 2 ** 24, getCountries: () => [], getVisited: () => [],
      interactive: false, onToggle: () => { toggled = true; },
    });
    layer.onAdd(map);
    assert.equal(map.handlers.has('click'), false);
    assert.equal(map.handlers.has('mousemove'), true);
    layer.onRemove(map);
    assert.equal(map.handlers.size, 0);
    assert.equal(toggled, false);
  });
});

test('detail replaces world, selectable ADM0 and its parent together, including hit testing and zooming out', async () => {
  await withBrowserCanvas(async canvases => {
    const region = record('AA:ADM0:AA', 'P1');
    const outline = record('world-detail', null);
    const base = record('world-coarse', null);
    const parent = record('P1', null);
    let zoom = 4;
    const map = mapMock(); map.getZoom = () => zoom;
    const layer = createCompiledLayer(makeLeaflet(), {
      world: { features: [base] }, extent: 2 ** 24,
      getCountries: () => [{ features: [region], admin1: [parent] }], getVisited: () => [region.id],
      getOutline: (_code, atZoom) => atZoom >= 6 ? outline : null, outlineRegionIds: [region.id],
    });
    layer.onAdd(map);
    layer.createTile({ x: 0, y: 0, z: 0 });
    assert.ok(canvases[0].calls.some(call => call[0] === 'fill' && call[1].d === region.d));
    zoom = 8;
    layer.createTile({ x: 0, y: 0, z: 0 });
    const detailedPaths = canvases[1].calls.filter(call => ['fill', 'stroke'].includes(call[0])).map(call => call[1].d);
    assert.ok(detailedPaths.length > 0);
    assert.ok(detailedPaths.every(d => d === outline.d), 'no obsolete triangle remains in world, selected, or parent paths');
    const hit = layer._hitRecord({ latlng: {} });
    assert.equal(hit.id, region.id); assert.equal(hit.index, region.index); assert.equal(hit.d, outline.d);
    zoom = 4;
    assert.equal(layer._hitRecord({ latlng: {} }).d, region.d, 'zooming out restores overview hit geometry too');
    assert.equal(region.d, record('AA:ADM0:AA', 'P1').d, 'canonical data is immutable');
    layer.onRemove(map);
  });
});

test('adjacent fills finish before world and selected boundary strokes', async () => {
  await withBrowserCanvas(async canvases => {
    const world = [record('world-a', null), record('world-b', null)];
    const selected = [record('AA:1', 'P1'), record('AA:2', 'P1')];
    const parent = record('P1', null);
    const layer = createCompiledLayer(makeLeaflet(), {
      world: { features: world }, extent: 2 ** 24, getCountries: () => [{ features: selected, admin1: [parent] }],
      getVisited: () => selected.map(item => item.id),
    });
    layer.createTile({ x: 0, y: 0, z: 0 });
    const calls = canvases[0].calls;
    for (const records of [world, selected]) {
      const paths = new Set(records.map(item => item.d));
      const fills = calls.flatMap((call, index) => call[0] === 'fill' && paths.has(call[1].d) ? [index] : []);
      const strokes = calls.flatMap((call, index) => call[0] === 'stroke' && paths.has(call[1].d) ? [index] : []);
      assert.ok(fills.length > 0 && strokes.length > 0 && Math.max(...fills) < Math.min(...strokes));
    }
    const lastFill = calls.findLastIndex(call => call[0] === 'fill');
    const parentStroke = calls.findIndex(call => call[0] === 'stroke' && call[1].d === parent.d);
    assert.ok(parentStroke > lastFill, 'selected fills must not obscure parent boundaries');
  });
});

test('a stroke just beyond the tile geometry bounds remains visible', async () => {
  await withBrowserCanvas(async canvases => {
    const feature = { countryCode: 'AA', d: 'M512.25 10l10 0l0 20l-10 0z', bounds: [512.25, 10, 522.25, 30] };
    const layer = createCompiledLayer(makeLeaflet(), {
      world: { features: [feature] }, extent: 1024, getCountries: () => [], getVisited: () => ['AA:1'],
    });
    layer.createTile({ x: 0, y: 0, z: 1 });
    assert.ok(canvases[0].calls.some(call => call[0] === 'stroke'));
  });
});

test('subpixel interior gaps keep their fill geometry and gain a stroke only when resolved', async () => {
  await withBrowserCanvas(async canvases => {
    const exterior = 'M10 10l200 0l0 200l-200 0z';
    const hole = 'M30 30l40 0l0 40l-40 0z';
    const feature = { countryCode: 'AA', d: `${exterior} ${hole}`, bounds: [10, 10, 210, 210], strokeWidths: [null, 20] };
    const layer = createCompiledLayer(makeLeaflet(), {
      world: { features: [feature] }, extent: 2 ** 24, getCountries: () => [], getVisited: () => [],
    });
    layer.createTile({ x: 0, y: 0, z: 9 });
    layer.createTile({ x: 0, y: 0, z: 12 });
    for (const canvas of canvases) {
      assert.equal(canvas.calls.find(call => call[0] === 'fill')[1].d, feature.d, 'holes remain in the exact fill at every zoom');
    }
    assert.equal(canvases[0].calls.find(call => call[0] === 'stroke')[1].d.trim(), exterior);
    assert.equal(canvases[1].calls.find(call => call[0] === 'stroke')[1].d.replace(/\s+/g, ' '), feature.d);
  });
});
