# Embed navigation and refinement validation

Status: PASS

Cold cache, gzip, 1.6 Mbps downstream, 150 ms latency, no CPU throttling. Timing starts at navigation and ends after actual attached land canvas tiles are painted. All files were read and compressed before navigation.

| Page | Previous first map | Current first map | Difference | Map body before paint |
| --- | ---: | ---: | ---: | ---: |

- hong-kong: detailed world 75 → 3,437 path characters; visit IDs and codeword preserved; no full country downloads.
- japan-islands: detailed world 2,992 → 362,586 path characters; visit IDs and codeword preserved; no full country downloads.
- norway-fjords: detailed world 16,461 → 421,261 path characters; visit IDs and codeword preserved; no full country downloads.
- alaska: detailed world 21,456 → 503,598 path characters; visit IDs and codeword preserved; no full country downloads.

Optional outline failure keeps the initial map usable. Explicit retry succeeds and preserves selected visits.
Mobile detailed land remains aligned and destroy removes all tiles.

The sibling homepage is served from an in-memory copy with only the remote embed URL replaced. Its files are not modified. The test scrolls its below-the-fold map into view immediately when ready. External fonts are excluded from this local repeatable performance check. These results measure the browser loader and compressed transfer; production CDN geography and TLS are not simulated.
