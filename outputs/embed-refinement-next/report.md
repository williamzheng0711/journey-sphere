# Embed navigation and refinement validation

Status: PASS

Cold cache, gzip, 1.6 Mbps downstream, 150 ms latency, no CPU throttling. Timing starts at navigation and ends after actual attached land canvas tiles are painted. All files were read and compressed before navigation.

First-map values are medians of 5 cold samples per version and page, after one unmeasured warmup per version and page. The regression budget is the larger of 100 ms or 5% of the pinned version.

| Page | Previous first map | Current first map | Difference | Map body before paint |
| --- | ---: | ---: | ---: | ---: |
| embed-desktop | 2390 ms | 2389 ms | -1 ms (-0.0%) | 347 → 347 KiB |
| embed-mobile | 2389 ms | 2383 ms | -5 ms (-0.2%) | 347 → 347 KiB |
| consumer-desktop | 2927 ms | 2925 ms | -2 ms (-0.1%) | 397 → 397 KiB |

The map focuses on Shanghai at [31.5, 121.8]. China is the country under that view center; these medians measure its actual detailed land paint after the first map:

| Page | Baseline centered refinement after first map | Current centered refinement after first map |
| --- | ---: | ---: |
| embed-desktop | 2.91 s | 1.44 s |
| embed-mobile | 2.94 s | 1.46 s |
| consumer-desktop | 2.91 s | 1.45 s |

Visible countries refine progressively after the first map. The following values measure completion of every visible country at normal zoom on the first cold sample:

| Page | Baseline all outlines after first map | Current all outlines after first map | Baseline refinement body | Current refinement body |
| --- | ---: | ---: | ---: | ---: |
| embed-desktop | 9.3 s | 8.1 s | 1.54 MB | 1.32 MB |
| embed-mobile | 6.4 s | 5.5 s | 1.17 MB | 0.95 MB |
| consumer-desktop | 8.4 s | 7.2 s | 1.47 MB | 1.25 MB |

- hong-kong: detailed world 75 → 3,437 path characters; visit IDs and codeword preserved; no full country downloads.
- japan-islands: detailed world 2,992 → 362,586 path characters; visit IDs and codeword preserved; no full country downloads.
- norway-fjords: detailed world 16,461 → 421,261 path characters; visit IDs and codeword preserved; no full country downloads.
- alaska: detailed world 21,456 → 503,598 path characters; visit IDs and codeword preserved; no full country downloads.

Optional outline failure keeps the initial map usable. Explicit retry succeeds and preserves selected visits.
Mobile detailed land remains aligned and destroy removes all tiles.

Cold mobile zoom-in to fully aligned Hong Kong detail: 1.64 s. A real tap on newly detailed land toggles the visit and the original codeword restores it.

The sibling homepage is served from an in-memory copy with only the remote embed URL replaced. Its files are not modified. The test scrolls its below-the-fold map into view immediately when ready. External fonts are excluded from this local repeatable performance check. These results measure the browser loader and compressed transfer; production CDN geography and TLS are not simulated.
