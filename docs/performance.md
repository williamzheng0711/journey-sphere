# Startup performance

The recommended `createCompiledJourneySphere` entry point projects and indexes the atlas at build time. At runtime it reuses native Canvas paths and applies the visit bitset. It avoids the full catalog/palette startup requests and thousands of per-region Leaflet objects. Existing `js1_` codewords and region IDs are unchanged.

## Reproduce

```sh
BASELINE_REF=3957870 node scripts/benchmark-startup.mjs
```

Open the printed local URL and click **Run benchmark**. `PORT` can select another port. `BASELINE_REF` defaults to `HEAD`; pin `3957870` to reproduce the original renderer after committing these changes. The server binds only to `127.0.0.1`.

The test selects the first USA region in the catalog, centered at `[39, -98]`, zoom 4. It compares the original source, the optimized GeoJSON source, and the compiled renderer. Each receives one unmeasured warmup and five measured runs, alternating forward and reverse order. All data responses use `Cache-Control: no-store`, a fixed 100 ms delay, and on-demand gzip compression. Leaflet and source modules are loaded before timing begins.

- `readyMs` measures factory invocation through resolution, including data downloads, parsing, and initial drawing.
- `paintReadyMs` adds two animation frames. It is a paint approximation, not a browser FCP/LCP measurement.
- `countryStartMinusWorldEnd` reports request overlap; negative means country loading started before the world response ended.
- `createElementCount` / `spanCount` count DOM creation during initialization.
- `smoke` checks initial state, clearing, restoring, reset, and rejection after destroy.

`/preview` provides a compiled map with controls for Singapore, 40 USA regions, horizontal wrapping, clearing, reset, and codeword restoration. `/current/examples/index.html` serves the actual example with local Leaflet assets for offline verification.

## Results, 2026-09-26

Measured in the Codex in-app browser on macOS. Final comparison, with no concurrent agent test/build jobs:

| Metric | Original GeoJSON | Optimized GeoJSON | Precompiled |
| --- | ---: | ---: | ---: |
| Initialization median | 861.0 ms | 690.2 ms | **199.4 ms** |
| Initialization mean | 878.9 ms | 733.1 ms | 201.8 ms |
| Two-frame completion median | 868.0 ms | 697.7 ms | **203.8 ms** |
| Two-frame completion mean | 886.0 ms | 740.6 ms | 209.6 ms |
| DOM elements created | 9,488 | 23 | 26 |
| Label elements created | 9,468 | 3 | 0 |

Labels in the compiled renderer are created on hover. All measured samples passed the state assertions and reported no map errors.

| Sample | Original ready | Optimized ready | Compiled ready | Compiled two-frame completion |
| --- | ---: | ---: | ---: | ---: |
| 1 | 861.0 | 754.2 | 193.8 | 194.9 |
| 2 | 817.3 | 690.2 | 221.7 | 222.8 |
| 3 | 876.0 | 892.5 | 193.3 | 202.3 |
| 4 | 810.9 | 660.2 | 200.8 | 203.8 |
| 5 | 1,029.3 | 668.3 | 199.4 | 224.1 |

Two earlier development runs are retained here to show variability instead of implying a strict 200 ms upper bound:

| Run | Original ready median | Optimized ready median | Compiled ready median / mean | Compiled two-frame median |
| --- | ---: | ---: | ---: | ---: |
| First compiled comparison | 764.0 ms | 667.8 ms | 195.5 / 196.8 ms | 200.6 ms |
| Second comparison | 765.8 ms | 664.4 ms | 202.7 / 228.5 ms | 208.7 ms |

First comparison compiled ready samples: `196.6, 195.0, 195.5, 195.4, 201.5` ms; second comparison: `333.2, 197.6, 207.2, 202.7, 201.8` ms. Development activity overlapped earlier measurements; the final run removed concurrent agent test/build jobs, but machine/browser variability remains.

These results support **about 200 ms initialization in this controlled test**. They do not guarantee every run finishes within 200 ms, and exclude HTML, stylesheet, Leaflet/module download, DNS, and connection setup. Slow networks, mobile CPUs, a larger viewport, and different country selections can change the result. Production navigation-to-map performance has not been measured or deployed here.

## Transfer and deployment

For the USA scenario, gzip data payloads shrink from **2,740,319 bytes** (world, catalog, palette, USA) to **1,508,840 bytes** (compiled world and USA), about 45% less. The bundled manifest is another 20,423 bytes uncompressed / 4,585 bytes gzip, included in module loading outside the factory timer. A first visit still transfers geometry; the tiny visit bitset does not eliminate this transfer.

The example preloads its module graph and known initial world/Singapore data from the document head, so requests can begin before the map factory runs. Integrations should bundle the module graph or preload it, serve compressed static data, and use versioned URLs with appropriate caching. Preload only the countries in that page's initial state. No user history is stored in the compiled atlas.

Ship `src/compiled.js`, its module dependencies, and the matching `data/compiled/` together. The additional compiled directory is static shared geometry and is loaded by country, not downloaded as a whole. Existing applications must select the `/compiled` entry point; the legacy root API remains available for compatibility. The compiled API offers `await journey.loadCatalog()` instead of an eagerly available `journey.catalog`.

Validation: 59 automated tests, syntax checks, full atlas validation (259 country outlines, 45,863 regions, 248 shards), and package-content validation pass. Browser checks covered visible rendering, clicks, half-step zoom, wrapped-world clicks, clearing, resetting, and codeword restoration. The repository has no separate lint or typecheck configuration.
