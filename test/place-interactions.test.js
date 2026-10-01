import test from 'node:test';
import assert from 'node:assert/strict';
import { bindLongPress } from '../src/place-interactions.js';

function surface() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) { listeners.get(type)?.delete(handler); },
    emit(type, event = {}) {
      for (const handler of listeners.get(type) || []) handler({ type, target: this, ...event });
    },
  };
}

function setup(t, pointer = true) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const view = surface(), doc = surface(), container = surface(), events = surface();
  if (pointer) view.PointerEvent = class {};
  doc.defaultView = view;
  container.ownerDocument = doc;
  const map = {
    getContainer: () => container,
    mouseEventToLatLng: event => ({ lng: event.clientX, lat: event.clientY }),
    on(types, handler) { types.split(' ').forEach(type => events.addEventListener(type, handler)); },
    off(types, handler) { types.split(' ').forEach(type => events.removeEventListener(type, handler)); },
  };
  let visible = null;
  let visited = true;
  const shown = [];
  const binding = bindLongPress(map, {
    resolve: latlng => visited && latlng.lng < 100 ? 'Visited place' : null,
    show: (place, latlng) => { visible = place; shown.push({ place, latlng }); },
    hide: () => { visible = null; },
  });
  t.after(() => binding.destroy());
  const dispatch = (type, { id = 1, x = 20, y = 30, ...extra } = {}) => {
    const event = { pointerType: 'touch', pointerId: id, isPrimary: id === 1, clientX: x, clientY: y, ...extra };
    doc.emit(type, event);
    if (type === 'pointerdown') container.emit(type, event);
  };
  return { binding, dispatch, container, doc, view, events, shown,
    get visible() { return visible; }, unvisit: () => { visited = false; } };
}

test('a hold waits 500ms, tolerates finger jitter, and hides on release without synthetic hover', t => {
  const state = setup(t);
  state.dispatch('pointerdown');
  t.mock.timers.tick(499);
  assert.equal(state.visible, null);
  state.dispatch('pointermove', { x: 24, y: 32 });
  t.mock.timers.tick(1);
  assert.equal(state.visible, 'Visited place');
  state.dispatch('pointerup');
  assert.equal(state.visible, null);
  assert.equal(state.binding.shouldIgnoreHover({ originalEvent: { type: 'mousemove' } }), true);
  t.mock.timers.tick(801);
  assert.equal(state.binding.shouldIgnoreHover({ originalEvent: { type: 'mousemove' } }), false);
});

test('short taps, movement, extra fingers, pointer cancellation, and map motion cancel holds', t => {
  const state = setup(t);
  const cancelActions = [
    () => state.dispatch('pointerup'),
    () => state.dispatch('pointermove', { x: 40 }),
    () => state.dispatch('pointerdown', { id: 2 }),
    () => state.dispatch('pointercancel'),
    () => state.events.emit('movestart'),
    () => state.events.emit('zoomstart'),
    () => state.view.emit('blur'),
  ];
  for (const cancel of cancelActions) {
    state.dispatch('pointerdown');
    t.mock.timers.tick(100);
    cancel();
    t.mock.timers.tick(600);
    assert.equal(state.visible, null);
    state.dispatch('pointerup');
    state.dispatch('pointerup', { id: 2 });
  }
  assert.equal(state.shown.length, 0);
});

test('holds ignore unvisited land, removed visits, mouse buttons, and map controls', t => {
  const state = setup(t);
  for (const event of [{ x: 120 }, { pointerType: 'mouse' }, { target: { closest: () => ({}) } }]) {
    state.dispatch('pointerdown', event);
    t.mock.timers.tick(600);
    assert.equal(state.visible, null);
    state.dispatch('pointerup');
  }
  state.dispatch('pointerdown');
  state.unvisit();
  t.mock.timers.tick(600);
  assert.equal(state.visible, null);
});

test('holding prevents the mobile context menu only over visited land', t => {
  const state = setup(t);
  let prevented = 0;
  state.dispatch('pointerdown');
  t.mock.timers.tick(1200);
  for (const clientX of [20, 120]) state.container.emit('contextmenu', {
    clientX, clientY: 30, preventDefault: () => prevented++,
  });
  assert.equal(prevented, 1);
});

test('destroy cancels a pending label and removes every document, container, and map listener', t => {
  const state = setup(t);
  state.dispatch('pointerdown');
  state.binding.destroy();
  t.mock.timers.tick(1000);
  assert.equal(state.shown.length, 0);
  for (const target of [state.container, state.doc, state.view, state.events]) {
    for (const handlers of target.listeners.values()) assert.equal(handlers.size, 0);
  }
});

test('touch-event fallback supports holds and cancels on multitouch, drag, and release', t => {
  const state = setup(t, false);
  const finger = { identifier: 1, clientX: 20, clientY: 30 };
  const start = () => {
    state.doc.emit('touchstart', { touches: [finger] });
    state.container.emit('touchstart', { touches: [finger] });
  };
  start();
  t.mock.timers.tick(500);
  assert.equal(state.visible, 'Visited place');
  state.doc.emit('touchend', { touches: [] });
  assert.equal(state.visible, null);
  for (const cancel of [
    () => state.doc.emit('touchstart', { touches: [finger, { ...finger, identifier: 2 }] }),
    () => state.doc.emit('touchmove', { touches: [{ ...finger, clientX: 50 }] }),
    () => state.doc.emit('touchcancel', { touches: [] }),
  ]) {
    start(); cancel(); t.mock.timers.tick(600);
    assert.equal(state.visible, null);
  }
  assert.equal(state.shown.length, 1);
});
