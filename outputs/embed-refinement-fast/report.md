# Embed navigation and refinement validation

Status: PASS

Cold cache, gzip, 1.6 Mbps downstream, 150 ms latency, no CPU throttling. Timing starts at navigation and ends after actual attached land canvas tiles are painted. All files were read and compressed before navigation.

First-map values are medians of 5 cold samples per version and page, after one unmeasured warmup per version and page. The regression budget is the larger of 100 ms or 5% of the pinned version.

| Page | Previous first map | Current first map | Difference | Map body before paint |
| --- | ---: | ---: | ---: | ---: |
| embed-desktop | 2391 ms | 2017 ms | -374 ms (-15.6%) | 347 → 273 KiB |
| embed-mobile | 2399 ms | 2033 ms | -366 ms (-15.3%) | 347 → 273 KiB |
| consumer-desktop | 2938 ms | 2558 ms | -380 ms (-12.9%) | 397 → 324 KiB |

The map focuses on Shanghai at [31.5, 121.8]. China is the country under that view center; these medians measure its actual detailed land paint after the first map:

| Page | Baseline centered refinement after first map | Current centered refinement after first map |
| --- | ---: | ---: |
| embed-desktop | 1.44 s | 1.45 s |
| embed-mobile | 1.48 s | 1.48 s |
| consumer-desktop | 1.45 s | 1.46 s |

Visible countries refine progressively after the first map. The following values measure completion of every visible country at normal zoom on the first cold sample:

| Page | Baseline all outlines after first map | Current all outlines after first map | Baseline refinement body | Current refinement body |
| --- | ---: | ---: | ---: | ---: |
| embed-desktop | 8.1 s | 7.6 s | 1.32 MB | 1.21 MB |
| embed-mobile | 5.5 s | 5.5 s | 0.95 MB | 0.95 MB |
| consumer-desktop | 7.2 s | 6.7 s | 1.25 MB | 1.14 MB |

- hong-kong: detailed world 70 → 3,437 path characters; visit IDs and codeword preserved; no full country downloads.
- japan-islands: detailed world 2,762 → 362,586 path characters; visit IDs and codeword preserved; no full country downloads.
- norway-fjords: detailed world 15,175 → 421,261 path characters; visit IDs and codeword preserved; no full country downloads.
- alaska: detailed world 19,703 → 503,598 path characters; visit IDs and codeword preserved; no full country downloads.

Optional outline failure keeps the initial map usable. Explicit retry succeeds and preserves selected visits.
Mobile detailed land remains aligned and destroy removes all tiles.

Cold mobile zoom-in to fully aligned Hong Kong detail: 1.66 s. A real tap on newly detailed land toggles the visit and the original codeword restores it.

The sibling homepage is served from an in-memory copy with only the remote embed URL replaced. Its files are not modified. The test scrolls its below-the-fold map into view immediately when ready. External fonts are excluded from this local repeatable performance check. These results measure the browser loader and compressed transfer; production CDN geography and TLS are not simulated.
