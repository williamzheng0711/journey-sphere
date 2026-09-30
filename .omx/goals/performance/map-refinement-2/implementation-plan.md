# Second map optimization round

Baseline: aa5dcc7e, the complete previous refinement; the worktree was clean.

Preserve the current map appearance, canonical selection geometry, IDs, colors and global loading rules. No dependency or deployment changes.

1. Reduce lossless detail transport after measuring compact encodings. Keep old payload compatibility and verify exact decoded paths for all 259 entries. Avoid an additional runtime network roundtrip for the decoder.
2. Skip refreshes for initial countries already loaded at startup; batch asynchronous geometry arrivals into one redraw per animation frame. Explicit selection refresh remains immediate and cancels pending repaint.
3. Use the existing conservative spatial parts for tile culling, and share stroke paths when zoom changes do not change which holes are outlined.
4. Extend the existing browser benchmark with five alternating detail measurements across East Asia, Norway and the date line. Keep three-view first-display regression guards. Reuse the desktop/mobile interaction, seam-pixel, failure/retry and lifecycle suite.

Ownership: root owns compiled.js integration, runtime tests, export/package/docs and final verification. final_detail_audit owns detail encoding/build/loader/data tests. render_review owns compiled-layer.js and renderer tests. browser_contract_review owns browser benchmark/regression scripts and evidence. Each lane preserves other edits.

Acceptance: meaningful detail download/latency improvement; initial-display medians within max(5%,100ms) of baseline; exact decoded paths and identical selected records; renderer pixels unchanged; no lifecycle regressions; all check/data/export/browser gates pass. Keep only changes supported by these measurements.
