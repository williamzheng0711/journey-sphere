# Embed navigation and refinement validation

Status: PASS

Cold cache, gzip, 1.6 Mbps downstream, 150 ms latency, no CPU throttling. Timing starts at navigation and ends after actual attached land canvas tiles are painted. All files were read and compressed before navigation.

First-map values are medians of 5 cold samples per version and page, after one unmeasured warmup per version and page. The regression budget is the larger of 100 ms or 5% of the pinned version.

| Page | Previous first map | Current first map | Difference | Map body before paint |
| --- | ---: | ---: | ---: | ---: |
| embed-desktop | 2755 ms | 2383 ms | -372 ms (-13.5%) | 334 → 347 KiB |
| embed-mobile | 2758 ms | 2378 ms | -380 ms (-13.8%) | 334 → 347 KiB |
| consumer-desktop | 3351 ms | 2924 ms | -426 ms (-12.7%) | 385 → 397 KiB |

Visible countries refine progressively after the first map. These values measure completion of every visible country at normal zoom on the first current cold sample:

| Page | All visible outlines after first map | Compressed refinement body |
| --- | ---: | ---: |
| embed-desktop | 10.0 s | 1.61 MB |
| embed-mobile | 7.5 s | 1.28 MB |
| consumer-desktop | 8.8 s | 1.47 MB |

- hong-kong: detailed world 75 → 3,437 path characters; visit IDs and codeword preserved; no full country downloads.
- japan-islands: detailed world 2,992 → 362,586 path characters; visit IDs and codeword preserved; no full country downloads.
- norway-fjords: detailed world 16,461 → 421,261 path characters; visit IDs and codeword preserved; no full country downloads.
- alaska: detailed world 21,456 → 503,598 path characters; visit IDs and codeword preserved; no full country downloads.

Optional outline failure keeps the initial map usable. Explicit retry succeeds and preserves selected visits.
Mobile detailed land remains aligned and destroy removes all tiles.

Cold mobile zoom-in to fully aligned Hong Kong detail: 1.48 s. A real tap on newly detailed land toggles the visit and the original codeword restores it.

The sibling homepage is served from an in-memory copy with only the remote embed URL replaced. Its files are not modified. The test scrolls its below-the-fold map into view immediately when ready. External fonts are excluded from this local repeatable performance check. These results measure the browser loader and compressed transfer; production CDN geography and TLS are not simulated.
