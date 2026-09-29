# Map-wide detail with a lighter initial load

Validated on 2026-09-29 against baseline `65d417c1739243e9f04ce5644e63fa463c09958b`.

All 259 atlas entries use the same zoom and viewport refinement rules. The overview remains lightweight; finer outlines load after the first map display, starting at zoom 6. Palette, layout, region IDs, codewords and the original administrative-region shards are preserved.

For 232 countries, country outlines are built from the same projected administrative polygons used for selection. The other 27 use direct source outlines. This avoids offset coastlines between background and selected regions. The build also retains 728 disjoint contextual polygons and excludes 34 polygons already represented by another atlas entity. Provenance and licenses are recorded per country in `data/outlines/sources.json`.

Fill paths keep all holes. A gap created by merging administrative regions does not acquire a new outline unless an explicit source hole supports it. Supported hole outlines also respect a half-pixel visibility threshold. This removes dark seam marks without changing selection geometry. Existing administrative strokes are drawn after fills so neighboring fills cannot obscure them.

## Cold-load measurements

Chrome, 1200 × 800 at DPR 1, zoom 4, empty cache, gzip, 1.6 Mbps download and 150 ms latency. Each view has one warmup and five alternating baseline/current samples. Both variants use the compiled renderer and the same retained Hong Kong visit; the geographic viewport changes. Timing measures navigation to factory readiness plus two animation frames, an approximation of first display.

| View | Baseline median | Updated median | Improvement |
| --- | ---: | ---: | ---: |
| East Asia | 3,299.0 ms | 3,159.2 ms | 4.2% |
| Europe | 3,315.7 ms | 3,148.1 ms | 5.1% |
| Pacific | 3,303.6 ms | 3,137.4 ms | 5.0% |

Startup resource transfer fell from 488,054 to 455,119 bytes in every view: 32,935 bytes, or 6.7%, less. The overview itself fell from 423,141 to 376,984 gzip bytes. No fine outline request starts before the first map paint opportunity, and the zoom-4 overview requests none.

Fine geometry is additional, deferred data: all country outline files total 6,337,675 gzip bytes, but only visible countries are requested. Downloads are limited to three at a time, the cache holds 32 countries, and obsolete requests are canceled. Representative country files range from Hong Kong's 1,785 bytes to Russia's 501,378 bytes. Spatial bounds prevent a distant island from causing unrelated continent downloads; that index adds 4,595 gzip bytes to the initial manifest.

## Verification

- 85 automated tests passed, including validation of all 259 shipped detail payloads through the real loader.
- Atlas validation passed: 259 countries, 45,863 region IDs, 248 country shards.
- Progressive startup, failure recovery, interaction and reset passed in Chrome.
- 18 recorded browser cases passed across Hong Kong, Japan, Norway, inland Europe, Alaska and the Aleutian date line, including mobile DPR 2 taps, hover, wrapped worlds, cancellation, destruction and retries.
- Four fixed canvas probes at previously problematic Japan seam locations have zero dark pixels; a negative control using the earlier outline policy fails the same test.
- Static export tests and package dry-run include all detail assets, loader and source attribution. Syntax and whitespace checks passed.

Run the checks with an existing Playwright installation and Google Chrome:

```sh
npm run check
npm run validate:data
PLAYWRIGHT_MODULE=/absolute/path/to/playwright node scripts/test-map-progressive.mjs
PLAYWRIGHT_MODULE=/absolute/path/to/playwright node scripts/test-map-detail.mjs
PLAYWRIGHT_MODULE=/absolute/path/to/playwright node scripts/benchmark-zoom.mjs
npm pack --dry-run
```

The browser scripts write measurements and screenshots to `outputs/zoom-detail/`. Final evidence is `benchmark.json` and `detail-test.json`; directories named `*-prototype` contain development experiments.

These are controlled local measurements, not a guarantee for every device or host. Detail remains limited by the source data, and faint unfilled source gaps can still appear at maximum zoom. The legacy GeoJSON entry point is unchanged; this refinement applies to `createCompiledJourneySphere`.
