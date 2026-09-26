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
