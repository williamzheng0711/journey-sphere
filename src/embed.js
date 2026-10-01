import bundledManifest from '../data/compiled/manifest.js';
import { createCompiledJourneySphere } from './compiled.js';
import { resolvePlaces } from './places.js';

const EMBED_DATA_URL = new URL('../data/embed/', import.meta.url);
const DEFAULT_CENTER = [20, 0];
const DEFAULT_ZOOM = 2;
const manifest = { ...bundledManifest, worldFile: '../embed/world.json' };

function parsePlaces(value) {
  if (Array.isArray(value)) return value.map(String).map(value => value.trim()).filter(Boolean);
  if (value == null || value === '') return [];
  const text = String(value).trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(String).map(value => value.trim()).filter(Boolean);
  } catch {
    // Human-friendly attribute syntax is handled below.
  }
  return text.split(/[;\n]+/).map(value => value.trim()).filter(Boolean);
}

function parseCenter(value) {
  if (Array.isArray(value) && value.length === 2) return value.map(Number);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.length === 2) return parsed.map(Number);
    } catch {
      const parsed = value.split(',').map(Number);
      if (parsed.length === 2) return parsed;
    }
  }
  return DEFAULT_CENTER;
}

function initialView(ids, countries, container) {
  const selected = new Set(ids);
  const records = Object.values(countries).flatMap(country => country.features).filter(feature => selected.has(feature.id));
  if (!records.length) return { center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM };
  const extent = bundledManifest.extent;
  const anchor = (records[0].bounds[0] + records[0].bounds[2]) / 2;
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const record of records) {
    const [left, top, right, bottom] = record.bounds;
    const shift = Math.round((anchor - (left + right) / 2) / extent) * extent;
    bounds[0] = Math.min(bounds[0], left + shift); bounds[1] = Math.min(bounds[1], top);
    bounds[2] = Math.max(bounds[2], right + shift); bounds[3] = Math.max(bounds[3], bottom);
  }
  const x = (bounds[0] + bounds[2]) / (2 * extent), y = (bounds[1] + bounds[3]) / (2 * extent);
  const scale = Math.min(Math.max(1, container.clientWidth - 48) * extent / (256 * Math.max(1, bounds[2] - bounds[0])),
    Math.max(1, container.clientHeight - 48) * extent / (256 * Math.max(1, bounds[3] - bounds[1])));
  return { center: [Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI, x * 360 - 180],
    zoom: Math.min(6, Math.floor(Math.log2(scale) * 2) / 2) };
}

async function loadChunks(chunks, baseUrl, signal, identity = null) {
  if (!Array.isArray(chunks)) throw new TypeError('JourneySphere chunks must be an array of paths.');
  const initialCountries = {};
  await Promise.all([...new Set(chunks)].map(async path => {
    const match = /^(?:regions|groups)\/([A-Z]{3})\/[a-f0-9]+\.json$/.exec(path);
    if (!match) throw new Error('JourneySphere place data has an invalid chunk path.');
    const code = match[1];
    const response = await fetch(new URL(path, baseUrl), { signal });
    if (!response.ok) throw new Error(`JourneySphere: ${response.status} loading place data for ${code}`);
    const payload = await response.json();
    if (!Array.isArray(payload?.features) || (identity && (payload.format !== identity.format ||
        payload.version !== identity.version || payload.extent !== identity.extent ||
        JSON.stringify(payload.fingerprint) !== JSON.stringify(identity.fingerprint)))) {
      throw new Error(`JourneySphere place data for ${code} does not match the published atlas.`);
    }
    if (!initialCountries[code]) initialCountries[code] = { ...payload, features: [], admin1: [] };
    const present = new Map(initialCountries[code].features.map(feature => [feature.id, feature]));
    for (const feature of payload.features) {
      if (present.has(feature.id)) {
        if (JSON.stringify(present.get(feature.id)) !== JSON.stringify(feature)) throw new Error(`Conflicting geometry for ${feature.id}`);
      } else { initialCountries[code].features.push(feature); present.set(feature.id, feature); }
    }
    initialCountries[code].admin1.push(...(payload.admin1 || []));
  }));
  return initialCountries;
}

function stylesheet(root, href) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  root.append(link);
  return new Promise((resolve, reject) => {
    link.addEventListener('load', resolve, { once: true });
    link.addEventListener('error', () => reject(new Error(`JourneySphere: unable to load stylesheet ${href}`)), { once: true });
  });
}

let leafletReady;
function importLeaflet() {
  return leafletReady ||= import(new URL('../vendor/leaflet/leaflet.esm.min.js', import.meta.url))
    .then(module => module.default || module)
    .catch(error => { leafletReady = undefined; throw error; });
}
// Start the shared engine download before the consumer's place list arrives.
// Importing the name/chunk helpers in a non-browser environment stays supported.
if (globalThis.window && globalThis.document) importLeaflet().catch(() => {});

function errorText(error) {
  return error?.message || String(error);
}

const HTMLElementBase = globalThis.HTMLElement || class {};

export class JourneySphereElement extends HTMLElementBase {
  static observedAttributes = ['places', 'center', 'zoom', 'data-base-url'];

  constructor() {
    super();
    this._journey = null;
    this._readyPromise = Promise.resolve(null);
    this._generation = 0;
    this._abort = null;
    this._overview = null;
    this._placesAssigned = false;
    this._connected = false;
    const root = this.attachShadow({ mode: 'open' });
    this._stylesReady = Promise.all([
      stylesheet(root, new URL('../vendor/leaflet/leaflet.css', import.meta.url)),
      stylesheet(root, new URL('./style.css', import.meta.url)),
      stylesheet(root, new URL('./embed.css', import.meta.url)),
    ]);
    this._stylesReady.catch(() => {});
    const frame = document.createElement('div');
    frame.className = 'frame';
    const map = document.createElement('div');
    map.className = 'map';
    map.setAttribute('part', 'map');
    const message = document.createElement('div');
    message.className = 'message';
    message.setAttribute('role', 'status');
    message.setAttribute('aria-live', 'polite');
    frame.append(map, message);
    root.append(frame);
    this._mapElement = map;
    this._message = message;
  }

  get ready() { return this._readyPromise; }
  get journey() { return this._journey; }
  get places() { return parsePlaces(this.getAttribute('places')); }
  set places(value) {
    if (!Array.isArray(value)) throw new TypeError('JourneySphere places must be an array.');
    this._placesAssigned = true;
    this.setAttribute('places', JSON.stringify(value));
  }

  connectedCallback() {
    this._connected = true;
    // A consumer can assign places after fetching its own record. Use that
    // interval to download public world context rather than adding a round trip.
    try { this._overviewFor(this._embedDataUrl()); } catch { /* _load reports invalid URLs. */ }
    if (!this.hasAttribute('places') && !this._placesAssigned) {
      this._setMessage('Set places to render JourneySphere.');
      return;
    }
    this._start();
  }
  disconnectedCallback() { this._connected = false; this._stop(); this._stopOverview(); }
  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue !== newValue && this._connected && this.isConnected) this._start();
  }

  reset() {
    if (!this._journey) return Promise.resolve();
    return this._journey.reset();
  }

  _setMessage(text, error = false) {
    this._message.textContent = text;
    this._message.hidden = !text;
    this._message.classList.toggle('error', error);
  }

  _stop() {
    this._generation++;
    this._abort?.abort();
    this._abort = null;
    this._journey?.destroy();
    this._journey = null;
  }

  _embedDataUrl() {
    const url = this.getAttribute('data-base-url')
      ? new URL(this.getAttribute('data-base-url'), document.baseURI)
      : new URL(EMBED_DATA_URL);
    url.pathname = url.pathname.replace(/\/?$/, '/');
    return url;
  }

  _stopOverview() {
    this._overview?.controller.abort();
    this._overview = null;
  }

  _overviewFor(baseUrl) {
    const url = new URL('world.json', baseUrl);
    if (this._overview?.url === url.href) return this._overview.promise;
    this._stopOverview();
    const request = { url: url.href, controller: new AbortController(), promise: null };
    request.promise = fetch(url, { signal: request.controller.signal }).then(async response => {
      if (!response.ok) throw new Error(`JourneySphere: ${response.status} loading the world overview`);
      return response.json();
    }).catch(error => {
      if (this._overview === request) this._overview = null;
      throw error;
    });
    request.promise.catch(() => {});
    this._overview = request;
    return request.promise;
  }

  _start() {
    this._stop();
    const generation = this._generation;
    const controller = new AbortController();
    this._abort = controller;
    this._setMessage('Loading JourneySphere…');
    this._readyPromise = this._load(generation, controller.signal).then(journey => {
      if (generation !== this._generation) return journey;
      this._journey = journey;
      this._setMessage('');
      this.dispatchEvent(new CustomEvent('journey-ready', { detail: journey, bubbles: true, composed: true }));
      return journey;
    }).catch(error => {
      if (generation !== this._generation || error?.name === 'AbortError') return null;
      controller.abort(error);
      this._setMessage(`JourneySphere could not load: ${errorText(error)}`, true);
      this.dispatchEvent(new CustomEvent('journey-error', { detail: error, bubbles: true, composed: true }));
      throw error;
    });
    this._readyPromise.catch(() => {});
  }

  async _load(generation, signal) {
    const embedDataUrl = this._embedDataUrl();
    const dataUrl = new URL('../', embedDataUrl);
    // Overlap the overview with place lookup and selected-region transfers.
    const worldData = this._overviewFor(embedDataUrl);
    const [L, places] = await Promise.all([
      importLeaflet(),
      resolvePlaces(this.places, { baseUrl: embedDataUrl, signal }),
      this._stylesReady,
    ]);
    if (generation !== this._generation) throw signal.reason || new DOMException('Disconnected', 'AbortError');
    const initialCountries = await loadChunks(places.chunks, embedDataUrl, signal, manifest);
    const automatic = initialView(places.visited, initialCountries, this._mapElement);
    const useAutomatic = !this.hasAttribute('center') && !this.hasAttribute('zoom');
    const center = useAutomatic ? automatic.center : parseCenter(this.getAttribute('center'));
    const zoomAttribute = this.getAttribute('zoom');
    const zoomValue = useAutomatic ? automatic.zoom : zoomAttribute === null ? DEFAULT_ZOOM : Number(zoomAttribute);
    const journey = await createCompiledJourneySphere(this._mapElement, {
      leaflet: L,
      dataUrl,
      manifest, worldData,
      visited: places.visited,
      labels: places.labels,
      initialCountries,
      backgroundDetails: false,
      center,
      zoom: Number.isFinite(zoomValue) ? zoomValue : DEFAULT_ZOOM,
      signal,
      onError: error => this.dispatchEvent(new CustomEvent('journey-error', { detail: error, bubbles: true, composed: true })),
    });
    return journey;
  }
}

if (globalThis.customElements && !customElements.get('journey-sphere')) customElements.define('journey-sphere', JourneySphereElement);

export { parsePlaces, loadChunks };
