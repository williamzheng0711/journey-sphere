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
  const saved = [];
  let width = 0; let height = 0;
  const context = {
    calls, globalAlpha: 1, globalCompositeOperation: 'source-over',
    save() { calls.push(['save']); saved.push({ globalAlpha: this.globalAlpha, globalCompositeOperation: this.globalCompositeOperation }); },
    restore() { calls.push(['restore']); Object.assign(this, saved.pop()); },
    setTransform: (...args) => calls.push(['transform', ...args]), translate: (...args) => calls.push(['translate', ...args]),
    clearRect(...args) { calls.push(['clear', ...args]); canvas.pixels = []; },
    fill(path, rule) {
      calls.push(['fill', path, rule]);
      canvas.pixels.push({ kind: 'fill', d: path.d, color: this.fillStyle, alpha: this.globalAlpha });
    },
    stroke(path) {
      calls.push(['stroke', path]);
      canvas.pixels.push({ kind: 'stroke', d: path.d, color: this.strokeStyle, alpha: this.globalAlpha });
    },
    drawImage(source, x, y) {
      calls.push(['drawImage', source, x, y, this.globalCompositeOperation, this.globalAlpha, source.calls.slice()]);
      if (this.globalCompositeOperation === 'copy') canvas.pixels = source.pixels.slice();
      else canvas.pixels.push(...source.pixels);
    },
    isPointInPath: (...args) => { calls.push(['hit', ...args]); return true; },
  };
  const canvas = {
    style: {}, calls, pixels: [],
    getContext: () => context,
  };
  const reset = () => {
    canvas.pixels = []; saved.length = 0;
    context.globalAlpha = 1; context.globalCompositeOperation = 'source-over';
  };
  Object.defineProperties(canvas, {
    width: { get: () => width, set: value => { width = value; reset(); } },
    height: { get: () => height, set: value => { height = value; reset(); } },
  });
  return canvas;
}

function withBrowserCanvas(callback) {
  const originalDocument = globalThis.document;
  const originalPath2D = globalThis.Path2D;
  const canvases = [];
  const paths = [];
  globalThis.Path2D = class MockPath2D {
    constructor(d) { this.d = d; paths.push(this); }
  };
  globalThis.document = { createElement: name => {
    if (name === 'span') return { textContent: '' };
    assert.equal(name, 'canvas');
    const canvas = makeCanvas();
    canvases.push(canvas);
    return canvas;
  } };
  return Promise.resolve().then(() => callback(canvases, paths)).finally(() => {
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

test('pan invalidates a country replacement scene before a deferred outline callback', async () => {
  await withBrowserCanvas(async () => {
    const coarse = record('world', null, 'USA');
    const fine = { ...coarse, d: 'M0 0l1 0l0 1l-1 -1z' };
    let position = 0;
    const map = mapMock();
    map.getPixelBounds = () => ({ min: { x: position, y: 0 }, max: { x: position + 256, y: 256 } });
    const layer = createCompiledLayer(makeLeaflet(), {
      world: { features: [coarse] }, extent: 2 ** 24, getCountries: () => [], getVisited: () => [],
      getOutline: () => position === 0 ? fine : null,
    });
    layer.onAdd(map);
    const first = layer._sceneAt(0);
    assert.equal(first.worldRecords[0], fine);
    position = 1000;
    const next = layer._sceneAt(0);
    assert.notEqual(next, first);
    assert.equal(next.worldRecords[0], coarse, 'new view uses original whole-country fallback');
    assert.equal(first.worldRecords[0], fine);
    assert.equal(layer._sceneAt(0), next, 'unchanged viewport reuses the scene');
    layer.onRemove(map);
  });
});

test('cached outline transitions repaint retained tiles while ordinary pans do not', async () => {
  await withBrowserCanvas(async () => {
    const originalFrame = globalThis.requestAnimationFrame;
    const originalCancel = globalThis.cancelAnimationFrame;
    const frames = [];
    globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
    globalThis.cancelAnimationFrame = () => {};
    try {
      let zoom = 4;
      const map = mapMock(); map.getZoom = () => zoom;
      const coarse = record('world', null, 'USA');
      const fine = { ...coarse, d: 'M0 0l1 0l0 1l-1 -1z' };
      const layer = createCompiledLayer(makeLeaflet(), {
        world: { features: [coarse] }, extent: 2 ** 24, getCountries: () => [], getVisited: () => [],
        getOutline: (_code, level) => level >= 4 ? fine : null,
      });
      const emit = event => { const entry = map.handlers.get(event); entry.handler.call(entry.context); };
      layer.onAdd(map); layer.createTile({ x: 0, y: 0, z: 4 });
      emit('moveend'); emit('resize');
      assert.equal(frames.length, 0, 'same outline identities retain painted tiles');
      zoom = 3.5;
      assert.equal(layer._sceneAt(zoom).worldRecords[0], coarse, 'hit testing may update the logical scene before repaint');
      emit('zoomend'); emit('moveend');
      assert.equal(frames.length, 1, 'fractional threshold transition schedules one repaint');
      frames.shift()(); assert.equal(layer.redrawCount, 1);
      layer.createTile({ x: 0, y: 0, z: 4 });
      zoom = 4; emit('zoomend');
      assert.equal(frames.length, 1, 'cached detail repaints without another fetch callback');
      frames.shift()(); assert.equal(layer.redrawCount, 2);
      layer.onRemove(map);
      for (const event of ['moveend', 'zoomend', 'resize']) assert.equal(map.handlers.has(event), false);
    } finally {
      globalThis.requestAnimationFrame = originalFrame; globalThis.cancelAnimationFrame = originalCancel;
    }
  });
});

test('outline-only refresh skips incomplete arrivals and coalesces a real same-viewport transition', async () => {
  await withBrowserCanvas(async () => {
    const originalFrame = globalThis.requestAnimationFrame;
    const originalCancel = globalThis.cancelAnimationFrame;
    const frames = [];
    globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
    globalThis.cancelAnimationFrame = () => {};
    try {
      const coarse = record('world', null, 'USA');
      const fine = { ...coarse, d: 'M0 0l1 0l0 1l-1 -1z' };
      let effective = null;
      const map = mapMock(); map.getZoom = () => 4;
      const layer = createCompiledLayer(makeLeaflet(), {
        world: { features: [coarse] }, extent: 2 ** 24, getCountries: () => [], getVisited: () => [],
        getOutline: () => effective,
      });
      layer.onAdd(map); layer.createTile({ x: 0, y: 0, z: 4 });
      const cached = layer._sceneAt(4);
      layer.requestOutlineRefresh();
      assert.notEqual(layer._sceneAt(4), cached, 'an arrival invalidates cached logical scene even without a view change');
      assert.equal(layer._sceneAt(4).worldRecords[0], coarse);
      assert.equal(frames.length, 0, 'incomplete fragments leave the same whole-country fallback and cause no repaint');
      effective = fine;
      layer.requestOutlineRefresh().requestOutlineRefresh();
      assert.equal(layer._sceneAt(4).worldRecords[0], fine, 'completed detail cannot be masked by the old scene cache');
      assert.equal(frames.length, 1, 'a real identity change schedules one repaint for the current viewport');
      frames.shift()(); assert.equal(layer.redrawCount, 1);
      layer.createTile({ x: 0, y: 0, z: 4 });
      layer.requestOutlineRefresh();
      assert.equal(frames.length, 0, 'repeated notification of the painted detail does not repaint again');
      layer.onRemove(map);
    } finally {
      globalThis.requestAnimationFrame = originalFrame; globalThis.cancelAnimationFrame = originalCancel;
    }
  });
});

test('synchronous tile batches become ready after attachment without a duplicate native frame callback', async () => {
  await withBrowserCanvas(async () => {
    const L = makeLeaflet();
    const events = [];
    const frames = [];
    const parent = {};
    let pending = [{ x: 8193, y: 2, z: 10 }, { x: 8194, y: 2, z: 10 }];
    let baseCalls = 0;
    L.GridLayer.prototype._update = function (center) {
      baseCalls++;
      assert.deepEqual(center, { lat: 20, lng: 740 });
      const batch = pending; pending = [];
      if (batch.length) events.push('loading');
      const generated = batch.map(coords => {
        const wrapped = { ...coords, x: coords.x % (2 ** coords.z) };
        const tile = this.createTile(wrapped, () => events.push('unexpected done callback'));
        tile.className = 'leaflet-tile';
        const entry = { el: tile, coords, current: true };
        this._tiles[this._tileCoordsToKey(coords)] = entry;
        if (this.createTile.length < 2) frames.push(() => this._tileReady(coords, null, tile));
        events.push(`tileloadstart:${coords.x}`);
        return entry;
      });
      for (const entry of generated) entry.el.parentNode = parent;
    };
    const layer = createCompiledLayer(L, {
      world: { features: [record('world', null)] }, extent: 2 ** 24, getCountries: () => [], getVisited: () => [],
    });
    const map = mapMock(); map.getZoom = () => 9.5;
    layer.onAdd(map); layer._map = map;
    layer._tileCoordsToKey = coords => `${coords.x}:${coords.y}:${coords.z}`;
    const retained = layer.createTile({ x: 0, y: 0, z: 9 });
    retained.className = 'leaflet-tile leaflet-tile-loaded'; retained.parentNode = parent;
    layer._tiles = { '0:0:9': { el: retained, coords: { x: 0, y: 0, z: 9 }, current: false, loaded: 1, active: true } };
    layer._tileReady = function (coords, error, tile) {
      assert.equal(error, null);
      assert.equal(Object.keys(this._tiles).length, 3, 'the whole generated batch is cached before readiness');
      assert.ok(Object.values(this._tiles).every(entry => entry.el.parentNode === parent), 'the whole batch is attached before tileload');
      const entry = this._tiles[this._tileCoordsToKey(coords)];
      assert.equal(entry.el, tile);
      assert.ok(tile.pixels.length, 'only already painted canvases become ready');
      entry.loaded = 2; entry.active = true; tile.className += ' leaflet-tile-loaded';
      events.push(`tileload:${coords.x}`);
      if (Object.values(this._tiles).every(value => value.loaded)) events.push('load');
    };
    assert.equal(layer.createTile.length, 2, 'the native engine must use its callback protocol rather than schedule a readiness frame');
    layer._update({ lat: 20, lng: 740 });
    assert.deepEqual(events, ['loading', 'tileloadstart:8193', 'tileloadstart:8194', 'tileload:8193', 'tileload:8194', 'load']);
    assert.equal(frames.length, 0, 'native _addTile has no deferred readiness callback to duplicate tileload');
    assert.ok(Object.values(layer._tiles).every(entry => entry.el.className.includes('leaflet-tile-loaded')),
      'all rendered canvases have visible CSS before _update returns');
    layer._update({ lat: 20, lng: 740 });
    assert.equal(baseCalls, 2);
    assert.equal(events.length, 6, 'loaded retained and current tiles do not fire readiness a second time');
    layer.onRemove(map);
  });
});

test('tile-ready flushing ignores foreign canvases and entries replaced by a reentrant tileload handler', async () => {
  await withBrowserCanvas(async () => {
    const L = makeLeaflet();
    L.GridLayer.prototype._update = function () {};
    const layer = createCompiledLayer(L, {
      world: { features: [record('world', null)] }, extent: 2 ** 24, getCountries: () => [], getVisited: () => [],
    });
    const map = mapMock(); layer.onAdd(map); layer._map = map;
    layer._tileCoordsToKey = coords => `${coords.x}:${coords.y}:${coords.z}`;
    const first = { el: layer.createTile({ x: 0, y: 0, z: 0 }), coords: { x: 0, y: 0, z: 0 }, current: true };
    const stale = { el: layer.createTile({ x: 1, y: 0, z: 0 }), coords: { x: 1, y: 0, z: 0 }, current: true };
    const foreign = { el: makeCanvas(), coords: { x: 2, y: 0, z: 0 }, current: true };
    layer._tiles = { '0:0:0': first, '1:0:0': stale, '2:0:0': foreign };
    const calls = [];
    let replacement;
    layer._tileReady = function (coords, _error, tile) {
      calls.push(tile);
      this._tiles[this._tileCoordsToKey(coords)].loaded = 1;
      if (tile === first.el) {
        replacement = { el: this.createTile({ x: 1, y: 0, z: 0 }), coords: stale.coords, current: true };
        this._tiles['1:0:0'] = replacement;
        this._update();
      }
    };
    layer._update();
    assert.deepEqual(calls, [first.el, replacement.el], 'the reentrant current entry becomes ready once, while the outer stale snapshot is skipped');
    assert.equal(stale.loaded, undefined); assert.equal(foreign.loaded, undefined);
    layer._update(); assert.equal(calls.length, 2, 'unowned canvases remain outside the readiness protocol');
    layer.onRemove(map);
  });
});

test('tile-ready flushing stops when a tileload handler removes the map', async () => {
  await withBrowserCanvas(async () => {
    const L = makeLeaflet(); L.GridLayer.prototype._update = function () {};
    const layer = createCompiledLayer(L, {
      world: { features: [record('world', null)] }, extent: 2 ** 24, getCountries: () => [], getVisited: () => [],
    });
    const map = mapMock(); layer.onAdd(map); layer._map = map;
    layer._tileCoordsToKey = coords => `${coords.x}:${coords.y}:${coords.z}`;
    const first = { el: layer.createTile({ x: 0, y: 0, z: 0 }), coords: { x: 0, y: 0, z: 0 }, current: true };
    const later = { el: layer.createTile({ x: 1, y: 0, z: 0 }), coords: { x: 1, y: 0, z: 0 }, current: true };
    layer._tiles = { '0:0:0': first, '1:0:0': later };
    const calls = [];
    layer._tileReady = function (_coords, _error, tile) {
      calls.push(tile); first.loaded = 1;
      this.onRemove(map); this._map = null;
    };
    assert.doesNotThrow(() => layer._update());
    assert.deepEqual(calls, [first.el]);
    assert.equal(later.loaded, undefined, 'no readiness callback can run after map removal');
  });
});

test('redraw repaints retained wrapped levels without replacing loaded canvases or native grid state', async () => {
  await withBrowserCanvas(async canvases => {
    const layer = createCompiledLayer(makeLeaflet(), {
      world: { features: [record('world', null)] }, extent: 2 ** 24, getCountries: () => [], getVisited: () => [],
    });
    const map = mapMock(); map.getZoom = () => 9.5;
    layer.onAdd(map); layer._map = map;
    const first = layer.createTile({ x: 3, y: 4, z: 9 });
    const second = layer.createTile({ x: 7, y: 8, z: 10 });
    const parent = {};
    for (const tile of [first, second]) {
      tile.className = 'leaflet-tile leaflet-tile-loaded';
      tile.parentNode = parent; tile.style.transform = 'translate3d(17px, 23px, 0)';
    }
    const old = { el: first, coords: { x: 1539, y: 4, z: 9 }, loaded: 11, active: true, current: false, retain: true };
    const current = { el: second, coords: { x: 3079, y: 8, z: 10 }, loaded: 12, active: true, current: true, retain: true };
    layer._tiles = { old, current }; layer._tileZoom = 10;
    const wrap = layer._wrapX = [0, 1024];
    const range = layer._globalTileRange = { marker: 'native grid' };
    const levels = layer._levels = { 9: { el: parent }, 10: { el: parent } };
    for (const method of ['_wrapCoords', '_removeAllTiles', '_setView', '_resetGrid', '_tileReady']) {
      layer[method] = () => { throw new Error(`${method} must not run during an in-place repaint`); };
    }
    assert.equal(layer.redraw(), layer);
    assert.equal(layer._tiles.old, old); assert.equal(layer._tiles.current, current);
    assert.deepEqual([old.loaded, old.active, old.current, old.retain], [11, true, false, true]);
    assert.deepEqual([current.loaded, current.active, current.current, current.retain], [12, true, true, true]);
    assert.equal(layer._tileZoom, 10); assert.equal(layer._wrapX, wrap);
    assert.equal(layer._globalTileRange, range); assert.equal(layer._levels, levels);
    for (const tile of [first, second]) {
      assert.equal(tile.className, 'leaflet-tile leaflet-tile-loaded');
      assert.equal(tile.parentNode, parent); assert.equal(tile.style.transform, 'translate3d(17px, 23px, 0)');
      const copy = tile.calls.findLast(call => call[0] === 'drawImage');
      assert.equal(copy[4], 'copy'); assert.equal(copy[5], 1);
      const transform = copy[6].findLast(call => call[0] === 'transform');
      const coords = tile === first ? { x: 3, y: 4, z: 9 } : { x: 7, y: 8, z: 10 };
      assert.deepEqual(transform, ['transform', 2 ** coords.z * 256 / (2 ** 24), 0, 0,
        2 ** coords.z * 256 / (2 ** 24), -coords.x * 256, -coords.y * 256],
      'saved wrapped coordinates retain their own zoom scale and repeated-world position');
    }
    assert.equal(canvases.length, 3, 'one detached scratch canvas serves every retained tile');
    const scratch = layer._compiledRepaintCanvas;
    layer.redraw(); assert.equal(layer._compiledRepaintCanvas, scratch); assert.equal(canvases.length, 3);
    layer.onRemove(map);
    assert.equal(layer._compiledRepaintCanvas, null, 'removing the layer releases its detached repaint buffer');
  });
});

test('in-place repaint copies transparent pixels when a selected visit is cleared', async () => {
  await withBrowserCanvas(async () => {
    const selected = record('AA:1', 'parent');
    let visited = [selected.id];
    const layer = createCompiledLayer(makeLeaflet(), {
      world: { features: [record('world', null)] }, extent: 2 ** 24,
      getCountries: () => [{ features: [selected] }], getVisited: () => visited,
      colorFor: () => '#123456',
    });
    const map = mapMock(); layer.onAdd(map); layer._map = map;
    const tile = layer.createTile({ x: 0, y: 0, z: 0 });
    layer._tiles = { tile: { el: tile, coords: { x: 0, y: 0, z: 0 }, loaded: 1, active: true, current: true } };
    assert.ok(tile.pixels.some(pixel => pixel.kind === 'fill' && pixel.color === '#123456'));
    visited = []; layer.refresh();
    assert.equal(tile.pixels.some(pixel => pixel.kind === 'fill' && pixel.color === '#123456'), false,
      'the old visit fill must be overwritten rather than composed under the new transparent tile');
    assert.ok(tile.pixels.some(pixel => pixel.kind === 'fill' && pixel.color === '#f8fafc'));
    const copy = tile.calls.findLast(call => call[0] === 'drawImage');
    assert.equal(copy[4], 'copy'); assert.equal(copy[5], 1);
    assert.equal(tile.getContext('2d').globalCompositeOperation, 'source-over', 'copy state does not leak to later painting');
    layer.onRemove(map);
  });
});

test('failed scratch repaint preserves the attached canvas content and later valid detail recovers', async () => {
  await withBrowserCanvas(async () => {
    const OriginalPath = globalThis.Path2D;
    globalThis.Path2D = class extends OriginalPath {
      constructor(d) { if (d === 'MFAIL') throw new Error('invalid outline path'); super(d); }
    };
    const coarse = record('world', null, 'USA');
    let outline = null;
    const errors = [];
    const layer = createCompiledLayer(makeLeaflet(), {
      world: { features: [coarse] }, extent: 2 ** 24, getCountries: () => [], getVisited: () => [],
      getOutline: () => outline, onError: error => errors.push(error),
    });
    const map = mapMock(); layer.onAdd(map); layer._map = map;
    const tile = layer.createTile({ x: 0, y: 0, z: 0 });
    const content = tile.pixels.slice();
    const state = { el: tile, coords: { x: 0, y: 0, z: 0 }, loaded: 1, active: true, current: true };
    layer._tiles = { tile: state };
    outline = { ...coarse, d: 'MFAIL' };
    assert.doesNotThrow(() => layer.refresh());
    assert.deepEqual(tile.pixels, content, 'failed detached drawing must never clear the visible canvas');
    assert.equal(tile.calls.filter(call => call[0] === 'drawImage').length, 0);
    assert.equal(layer._tiles.tile, state); assert.equal(errors.length, 1); assert.match(errors[0].message, /invalid outline path/);
    outline = { ...coarse, d: 'M0 0l16777215 0l0 16777215z' };
    layer.refresh();
    assert.ok(tile.pixels.some(pixel => pixel.d === outline.d));
    assert.equal(tile.pixels.some(pixel => pixel.d === coarse.d), false);
    assert.equal(errors.length, 1); assert.equal(tile.calls.filter(call => call[0] === 'drawImage').length, 1);
    layer.onRemove(map);
  });
});

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
    outline.parts = [[0, 0, 100, 100]];
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
    assert.deepEqual(layer._compiledScene.activeRecords.find(item => item.id === region.id).parts, outline.parts);
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
  await withBrowserCanvas(async (canvases, paths) => {
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
    assert.equal(paths.length, 3, 'fill plus the two distinct stroke eligibility sets');
  });
});

test('reuses stroke paths while hole eligibility is unchanged across zooms', async () => {
  await withBrowserCanvas(async (_canvases, paths) => {
    const exterior = 'M10 10l200 0l0 200l-200 0z';
    const wideHole = 'M30 30l40 0l0 40l-40 0z';
    const duplicateWideHole = 'M90 30l40 0l0 40l-40 0z';
    const narrowHole = 'M150 30l20 0l0 20l-20 0z';
    const feature = {
      countryCode: 'AA', d: `${exterior} ${wideHole} ${duplicateWideHole} ${narrowHole}`,
      bounds: [10, 10, 210, 210], strokeWidths: [null, 20, 20, 10],
    };
    const layer = createCompiledLayer(makeLeaflet(), {
      world: { features: [feature] }, extent: 2 ** 24, getCountries: () => [], getVisited: () => [],
    });
    layer.createTile({ x: 0, y: 0, z: 9 });
    layer.createTile({ x: 0, y: 0, z: 10 });
    layer.createTile({ x: 0, y: 0, z: 11 });
    layer.createTile({ x: 0, y: 0, z: 12 });
    layer.createTile({ x: 0, y: 0, z: 13 });
    assert.equal(paths.length, 4, 'fill plus one Path2D for each actual eligibility set');
    const strokes = paths.slice(1);
    assert.equal(strokes.length, 3);
    assert.equal(strokes[0].d.trim(), exterior, 'subpixel holes are omitted');
    assert.match(strokes[1].d, /M30 30/);
    assert.doesNotMatch(strokes[1].d, /M150 30/);
    assert.match(strokes[2].d, /M150 30/, 'the exact half-pixel threshold remains eligible');
  });
});

test('culls multipart records per box with stroke padding and world wrapping', async () => {
  await withBrowserCanvas(async canvases => {
    const feature = {
      countryCode: 'AA', d: 'M511.7 10l1 0l0 20l-1 0z', bounds: [0, 0, 1024, 1024],
      parts: [[900, 10, 910, 20], [511.7, 10, 512.3, 30], [1000, 40, 1010, 60]],
    };
    const layer = createCompiledLayer(makeLeaflet(), {
      world: { features: [feature] }, extent: 1024, getCountries: () => [], getVisited: () => [],
    });
    layer.createTile({ x: 0, y: 0, z: 1 });
    assert.ok(canvases[0].calls.some(call => call[0] === 'stroke'), 'edge part must retain its padded outline');
    layer.createTile({ x: 1, y: 0, z: 1 });
    assert.ok(canvases[1].calls.some(call => call[0] === 'stroke'), 'far part must render in its own tile');
    layer.createTile({ x: -1, y: 0, z: 1 });
    assert.ok(canvases[2].calls.some(call => call[0] === 'stroke'), 'dateline-adjacent part must render in the wrapped tile');
  });
});

test('requestRefresh coalesces, invalidates immediately, and cannot repaint after removal', async () => {
  await withBrowserCanvas(async () => {
    const originalRaf = globalThis.requestAnimationFrame;
    const originalCancel = globalThis.cancelAnimationFrame;
    const callbacks = [];
    const cancelled = [];
    globalThis.requestAnimationFrame = callback => { callbacks.push(callback); return callbacks.length; };
    globalThis.cancelAnimationFrame = handle => cancelled.push(handle);
    try {
      const layer = createCompiledLayer(makeLeaflet(), {
        world: { features: [] }, extent: 2 ** 24, getCountries: () => [], getVisited: () => [],
      });
      const map = mapMock();
      layer.onAdd(map);
      layer.requestRefresh().requestRefresh();
      assert.equal(layer._compiledScene, null, 'scene is invalidated before the frame runs');
      assert.equal(callbacks.length, 1, 'multiple arrivals share one frame');
      assert.equal(layer.redrawCount, 0);
      callbacks[0]();
      assert.equal(layer.redrawCount, 1);
      layer.requestRefresh();
      layer.refresh();
      assert.equal(layer.redrawCount, 2, 'explicit refresh remains immediate');
      callbacks[1]();
      assert.equal(layer.redrawCount, 2, 'explicit refresh cancels queued repaint');
      layer.requestRefresh();
      layer.refresh();
      assert.equal(layer.redrawCount, 3);
      layer.requestRefresh();
      callbacks[2]();
      assert.equal(layer.redrawCount, 3, 'a stale callback cannot clear a newer queued repaint');
      callbacks[3]();
      assert.equal(layer.redrawCount, 4);
      layer.requestRefresh();
      layer.onRemove(map);
      callbacks[4]();
      assert.equal(layer.redrawCount, 4, 'removed layer cannot repaint');
      assert.deepEqual(cancelled, [2, 3, 5]);
    } finally {
      if (originalRaf === undefined) delete globalThis.requestAnimationFrame;
      else globalThis.requestAnimationFrame = originalRaf;
      if (originalCancel === undefined) delete globalThis.cancelAnimationFrame;
      else globalThis.cancelAnimationFrame = originalCancel;
    }
  });
});

test('requestRefresh falls back to one timer when animation frames are unavailable', async () => {
  await withBrowserCanvas(async () => {
    const originalRaf = globalThis.requestAnimationFrame;
    try {
      delete globalThis.requestAnimationFrame;
      const layer = createCompiledLayer(makeLeaflet(), {
        world: { features: [] }, extent: 2 ** 24, getCountries: () => [], getVisited: () => [],
      });
      layer.onAdd(mapMock());
      layer.requestRefresh().requestRefresh();
      assert.equal(layer.redrawCount, 0);
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(layer.redrawCount, 1);
    } finally {
      if (originalRaf === undefined) delete globalThis.requestAnimationFrame;
      else globalThis.requestAnimationFrame = originalRaf;
    }
  });
});
