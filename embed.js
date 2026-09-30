// Start the largest dependency alongside the component's module graph.
if (globalThis.document) {
  const engine = document.createElement('link');
  engine.rel = 'modulepreload';
  engine.href = new URL('./vendor/leaflet/leaflet-src.esm.js', import.meta.url).href;
  engine.crossOrigin = 'anonymous';
  document.head.append(engine);
}
await import('./src/embed.js');
