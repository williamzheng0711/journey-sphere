const WORLD_SHIFT_OFFSETS = [-1, 0, 1];

/**
 * Render compact atlas records directly into Leaflet tiles.
 * @param {object} L
 * @param {object} options
 */
export function createCompiledLayer(L, options) {
  if (!L?.GridLayer?.extend) throw new TypeError('JourneySphere compiled renderer requires Leaflet GridLayer.');
  const {
    world, extent, getCountries, getVisited, colorFor, fillOpacity = 0.44,
    labels, interactive = true, onToggle, onError, getOutline = () => null, outlineRegionIds = [],
  } = options || {};
  if (!world || !Array.isArray(world.features)) throw new TypeError('Compiled renderer requires world features.');
  if (!Number.isFinite(extent) || extent <= 0) throw new RangeError('Compiled renderer extent must be positive.');
  if (typeof getCountries !== 'function' || typeof getVisited !== 'function') {
    throw new TypeError('Compiled renderer requires getCountries and getVisited callbacks.');
  }

  let paths = new WeakMap();
  let strokePaths = new WeakMap();
  let replacements = new WeakMap();
  const replaceable = new Set(outlineRegionIds);
  const detailedRecord = (record, zoom) => {
    const outline = getOutline(record.countryCode, zoom);
    if (!outline) return record;
    let records = replacements.get(outline);
    if (!records) replacements.set(outline, records = new WeakMap());
    if (!records.has(record)) records.set(record, {
      ...record, d: outline.d, bounds: outline.bounds, parts: outline.parts, strokeWidths: outline.strokeWidths,
    });
    return records.get(record);
  };
  const pathFor = (record, stroke = false, zoom = 0) => {
    if (stroke && record.strokeWidths) {
      let cached = strokePaths.get(record);
      if (!cached) {
        const positiveWidths = [...new Set(record.strokeWidths.filter(width => Number.isFinite(width) && width > 0))].sort((a, b) => a - b);
        cached = { rings: record.d.match(/M[^M]+/g), positiveWidths, paths: new Map() };
        strokePaths.set(record, cached);
      }
      const minimumWidth = 0.5 * extent / (256 * 2 ** zoom);
      const firstEligible = cached.positiveWidths.findIndex(width => width >= minimumWidth);
      // Positive widths are sorted, so the first eligible width uniquely identifies
      // the complete eligible suffix. The exterior ring (null) remains unconditional.
      const key = firstEligible < 0 ? 'none' : String(cached.positiveWidths[firstEligible]);
      if (!cached.paths.has(key)) {
        // Keep the exact fill; outline only supported holes wide enough to resolve.
        const rings = cached.rings.filter((_, index) => record.strokeWidths[index] === null ||
          record.strokeWidths[index] >= minimumWidth);
        cached.paths.set(key, new Path2D(rings.join(' ')));
      }
      return cached.paths.get(key);
    }
    if (!paths.has(record)) paths.set(record, new Path2D(record.d));
    return paths.get(record);
  };
  const recordsForCountries = () => {
    const countries = getCountries() || [];
    return countries.flatMap(country => country?.features || []);
  };
  const admin1ForCountries = () => {
    const countries = getCountries() || [];
    return countries.flatMap(country => country?.admin1 || []);
  };
  const visitedSet = () => {
    const value = getVisited() || [];
    return value instanceof Set ? value : new Set(value);
  };
  const countrySet = visited => new Set([...visited].map(id => String(id).split(':')[0]));
  const parentKey = record => `${record.countryCode}:${record.parentId || record.id}`;
  const labelFor = record => typeof labels === 'function' ? labels(record.id, record) : labels?.[record.id] || record.name || record.id;
  const reportError = error => { if (typeof onError === 'function') onError(error); };

  function tileContext(canvas) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Compiled renderer could not create a 2D canvas context.');
    return context;
  }

  function tileShifts(record, coords, zoom, padding) {
    const boxes = Array.isArray(record.parts) && record.parts.length
      ? record.parts : record.bounds ? [record.bounds] : null;
    if (!boxes) return WORLD_SHIFT_OFFSETS;
    const worldWidth = extent / (2 ** zoom);
    const left = coords.x * worldWidth;
    const right = left + worldWidth;
    return WORLD_SHIFT_OFFSETS.filter(shift => {
      return boxes.some(([minX, minY, maxX, maxY]) => {
        const shiftedMin = minX + shift * extent;
        const shiftedMax = maxX + shift * extent;
        return shiftedMax + padding >= left && shiftedMin - padding <= right &&
          maxY + padding >= coords.y * worldWidth && minY - padding <= (coords.y + 1) * worldWidth;
      });
    });
  }

  function drawRecord(context, record, coords, zoom, size, ratio, style) {
    const scale = (2 ** zoom) * size.x / extent;
    const shifts = tileShifts(record, coords, zoom, style.stroke === false ? 0 : style.weight / (2 * scale));
    if (!shifts.length) return;
    for (const shift of shifts) {
      context.save();
      context.setTransform(scale * ratio, 0, 0, scale * ratio,
        -coords.x * size.x * ratio, -coords.y * size.y * ratio);
      context.translate(shift * extent, 0);
      if (style.fill) {
        context.fillStyle = style.fill;
        context.globalAlpha = style.fillOpacity;
        context.fill(pathFor(record), 'evenodd');
      }
      if (style.stroke !== false) {
        context.lineWidth = style.weight / scale;
        context.lineCap = 'round';
        context.lineJoin = 'round';
        context.strokeStyle = style.color;
        context.globalAlpha = style.opacity ?? 1;
        context.stroke(pathFor(record, true, zoom));
      }
      context.restore();
    }
  }

  function scene(zoom) {
    const visited = visitedSet();
    const activeCountries = countrySet(visited);
    const baseRecords = recordsForCountries();
    const replacementParents = new Set(baseRecords.filter(record => replaceable.has(record.id)).map(parentKey));
    const activeRecords = baseRecords.map(record => replaceable.has(record.id) ? detailedRecord(record, zoom) : record);
    const recordsById = new Map(activeRecords.map(record => [record.id, record]));
    const activeParents = new Set([...visited].map(id => recordsById.get(id)).filter(Boolean).map(parentKey));
    const selected = record => visited.has(record.id);
    const sibling = record => activeParents.has(parentKey(record)) && !selected(record);
    return { zoom, visited, activeCountries, activeParents, activeRecords, selected,
      worldRecords: world.features.map(record => getOutline(record.countryCode, zoom) || record),
      adminRecords: admin1ForCountries().map(record => replacementParents.has(parentKey(record)) ? detailedRecord(record, zoom) : record),
      visibleRegions: activeRecords.filter(record => activeCountries.has(record.countryCode) && (selected(record) || sibling(record))),
    };
  }

  const Layer = L.GridLayer.extend({
    _cancelCompiledRefresh() {
      const handle = this._compiledRefreshFrame;
      const cancel = this._compiledRefreshCancel;
      this._compiledRefreshFrame = null;
      this._compiledRefreshCancel = null;
      this._compiledRefreshQueued = false;
      this._compiledRefreshToken = (this._compiledRefreshToken || 0) + 1;
      if (handle !== null && handle !== undefined && typeof cancel === 'function') cancel(handle);
    },
    requestRefresh() {
      this._clearCompiledHover();
      this._compiledScene = null;
      if (!this._compiledMap || this._compiledRefreshQueued) return this;
      const token = (this._compiledRefreshToken || 0) + 1;
      this._compiledRefreshToken = token;
      this._compiledRefreshQueued = true;
      const repaint = () => {
        if (!this._compiledRefreshQueued || this._compiledRefreshToken !== token) return;
        this._compiledRefreshFrame = null;
        this._compiledRefreshCancel = null;
        this._compiledRefreshQueued = false;
        if (this._compiledMap) this.redraw();
      };
      const useFrame = typeof globalThis.requestAnimationFrame === 'function';
      this._compiledRefreshCancel = useFrame ? globalThis.cancelAnimationFrame : globalThis.clearTimeout;
      this._compiledRefreshFrame = useFrame
        ? globalThis.requestAnimationFrame(repaint) : globalThis.setTimeout(repaint, 0);
      return this;
    },
    _sceneAt(zoom) {
      if (!this._compiledScene || this._compiledScene.zoom !== zoom) this._compiledScene = scene(zoom);
      return this._compiledScene;
    },
    createTile(coords) {
      let tile;
      try {
        const size = this.getTileSize();
        if (!size?.x || !size?.y) throw new Error('Compiled renderer received an invalid tile size.');
        const ratio = globalThis.devicePixelRatio || 1;
        tile = document.createElement('canvas');
        tile.width = Math.round(size.x * ratio);
        tile.height = Math.round(size.y * ratio);
        tile.style.width = `${size.x}px`;
        tile.style.height = `${size.y}px`;
        const context = tileContext(tile);
        const zoom = this._compiledMap?.getZoom() ?? this._map?.getZoom() ?? coords.z;
        const state = this._sceneAt(zoom);
        const countryRecords = state.visibleRegions;
        const adminRecords = state.adminRecords;
        const activeWorld = feature => state.activeCountries.has(feature.countryCode);
        // Neighboring fills must finish before shared boundary strokes.
        for (const feature of state.worldRecords) {
          drawRecord(context, feature, coords, coords.z, size, ratio, {
            fill: '#f8fafc', fillOpacity: 0.84, stroke: false,
          });
        }
        for (const feature of state.worldRecords) {
          drawRecord(context, feature, coords, coords.z, size, ratio, {
            color: activeWorld(feature) ? '#8795a6' : zoom >= 6 ? '#acb8c5' : '#c1cbd5',
            weight: activeWorld(feature) ? (zoom >= 6 ? 0.95 : 0.8) : (zoom >= 6 ? 0.65 : 0.45),
          });
        }
        for (const feature of countryRecords) {
          if (!state.selected(feature)) continue;
          drawRecord(context, feature, coords, coords.z, size, ratio, {
            fill: colorFor?.(feature.countryCode) || '#64748b', fillOpacity, stroke: false,
          });
        }
        for (const feature of adminRecords) {
          if (!state.activeCountries.has(feature.countryCode)) continue;
          const activeParent = state.activeParents.has(parentKey(feature));
          drawRecord(context, feature, coords, coords.z, size, ratio, {
            color: '#8795a6', weight: activeParent ? 0.8 : 0.55, opacity: activeParent ? 0.75 : 0.4, stroke: true,
          });
        }
        for (const feature of countryRecords) {
          const isSelected = state.selected(feature);
          drawRecord(context, feature, coords, coords.z, size, ratio, {
            color: isSelected ? colorFor?.(feature.countryCode) || '#64748b' : '#9aa8b7',
            weight: isSelected ? (zoom >= 6 ? 1.15 : 1.05) : 0.55,
            opacity: isSelected ? 0.88 : 0.65,
          });
        }
      } catch (error) {
        reportError(error);
        throw error;
      }
      return tile;
    },
    onAdd(map) {
      L.GridLayer.prototype.onAdd.call(this, map);
      this._compiledMap = map;
      this._compiledRefreshFrame = null;
      this._compiledRefreshCancel = null;
      this._compiledRefreshQueued = false;
      this._compiledRefreshToken = (this._compiledRefreshToken || 0) + 1;
      this._compiledScene = scene(map.getZoom());
      map.on('mousemove', this._compiledHover, this);
      map.on('mouseout', this._clearCompiledHover, this);
      map.on('movestart', this._clearCompiledHover, this);
      if (interactive) map.on('click', this._compiledClick, this);
      this._compiledTooltip = L.tooltip?.({ sticky: true });
    },
    onRemove(map) {
      this._cancelCompiledRefresh();
      map.off('click', this._compiledClick, this);
      map.off('mousemove', this._compiledHover, this);
      map.off('mouseout', this._clearCompiledHover, this);
      map.off('movestart', this._clearCompiledHover, this);
      this._clearCompiledHover();
      this._compiledMap = null;
      this._compiledScene = null;
      this._compiledHitCanvas = null;
      this._compiledHitContext = null;
      this._compiledTooltip = null;
      this._compiledLabel = null;
      paths = new WeakMap();
      strokePaths = new WeakMap();
      replacements = new WeakMap();
      L.GridLayer.prototype.onRemove.call(this, map);
    },
    _clearCompiledHover() {
      if (this._compiledTooltip && this._compiledMap) this._compiledMap.removeLayer(this._compiledTooltip);
    },
    _hitRecord(event) {
      const map = this._compiledMap;
      if (!map) return null;
      const point = map.project(event.latlng, 0);
      const x = ((point.x % 256) + 256) % 256 * extent / 256;
      const y = point.y * extent / 256;
      const canvas = this._compiledHitCanvas || (this._compiledHitCanvas = document.createElement('canvas'));
      const context = this._compiledHitContext || (this._compiledHitContext = tileContext(canvas));
      const records = this._sceneAt(map.getZoom()).activeRecords;
      for (const record of records) {
        if (!record.bounds) continue;
        const [minX, minY, maxX, maxY] = record.bounds;
        for (const shift of WORLD_SHIFT_OFFSETS) {
          const shiftedX = x + shift * extent;
          if (shiftedX < minX || shiftedX > maxX || y < minY || y > maxY) continue;
          const path = pathFor(record);
          if (context.isPointInPath(path, shiftedX, y, 'evenodd')) return record;
        }
      }
      return null;
    },
    _compiledClick(event) {
      const record = this._hitRecord(event);
      if (!record || !interactive || typeof onToggle !== 'function') return;
      try { Promise.resolve(onToggle(record.id)).catch(reportError); } catch (error) { reportError(error); }
    },
    _compiledHover(event) {
      const record = this._hitRecord(event);
      const visited = visitedSet();
      if (!record || !visited.has(record.id) || !this._compiledTooltip || !this._compiledMap) {
        this._clearCompiledHover();
        return;
      }
      const label = this._compiledLabel || (this._compiledLabel = document.createElement('span'));
      label.textContent = String(labelFor(record));
      this._compiledTooltip.setLatLng(event.latlng).setContent(label).addTo(this._compiledMap);
    },
    refresh() {
      this._cancelCompiledRefresh();
      this._clearCompiledHover();
      this._compiledScene = null;
      if (this._compiledMap) this.redraw();
      return this;
    },
  });

  return new Layer();
}
