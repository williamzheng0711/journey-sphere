# Map flashing regression

Status: PASS

The previous renderer removed visible canvas tiles during each repaint. Their replacements stayed hidden until the next animation frame, producing a brief blank map. The corrected renderer paints through a reusable detached canvas into the existing tiles. It also marks fully drawn new tile batches ready synchronously, covering instant view changes, and skips outline updates that do not change visible geometry.

Frame-by-frame browser comparison with revision `3503a3c77c684dcd9305f7f889b1044ed97a11d5`:

| Renderer | Scenario | Sampled blank frames |
| --- | --- | ---: |
| baseline | desktop | 13 |
| current | desktop | 0 |
| current | mobile | 0 |
| current | wrapped-world | 0 |

Checks include staggered outline arrivals, real clicks, reset, cached refinement thresholds, animated and instant fractional zooms, and repeated world copies. Fixed-view updates retain loaded tile identities. Every monitored frame checks actual visibility and land pixels; selected colors remain visible throughout refinement. No uncaught browser errors occurred. Coarse world-only Guam omits local land in the existing overview source, so its land-pixel assertions begin after exact coverage arrives.

![Previous blank frame](baseline-blank.png)

![Current refined map](current-refined.png)

Cold-start comparison uses three alternating samples per version on desktop and mobile, gzip, disabled cache, 1.6 Mbps downstream, 150 ms latency and no CPU throttling. No consumer website is included.

| Page | Previous first map | Current first map | Difference |
| --- | ---: | ---: | ---: |
| embed-desktop | 2027 ms | 2029 ms | 2.7 ms |
| embed-mobile | 2027 ms | 2032 ms | 4.7 ms |

These measured differences remain well within the existing regression budget (the larger of 100 ms or 5%). Production CDN geography and TLS are not simulated. Exact runtime hashes and individual timing samples are in [startup-results.json](startup-results.json).

Validation: all 166 automated checks pass, alongside cross-origin startup, live-update recovery, full coastline interaction, selective fragments, and the new frame regression. Fractional wrapping, visit clearing, drawing-failure recovery, native loading-event ordering and reentrant removal remain covered.

Run `npm run check` and `PLAYWRIGHT_MODULE=/path/to/playwright npm run test:flashing` to repeat the automated and browser checks.
