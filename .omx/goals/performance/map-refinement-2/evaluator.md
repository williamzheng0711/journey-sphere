# Performance Evaluator: map-refinement-2

## Objective
繼續全圖優化：保留目前外觀及區域選取語意，改善邊界清晰度、首次顯示速度與放大細節等待時間；以目前 aa5dcc7e 為基準，用瀏覽器實測驗證效益和全圖回歸。

## Evaluator Command
```sh
npm run check && npm run validate:data && node scripts/test-map-progressive.mjs && node scripts/test-map-detail.mjs && BENCHMARK_MODE=refinement BASELINE_REF=aa5dcc7e node scripts/benchmark-zoom.mjs
```

## Pass/Fail Contract
PASS only with a measured material reduction in first-display or zoom-detail latency/transfer versus pinned HEAD aa5dcc7e, five alternating cold-cache browser samples for affected metrics, no more than 5 percent or 100 ms first-display regression per geographic view, unchanged full selected geometry/IDs/palette/layout, global detail and desktop/mobile interactions plus cancellation/retry/destroy passing; visual changes must retain or improve border clarity. New data formats require exact decoded-geometry equivalence across all259entries and compatible static exports.

This evaluator must exist and produce concrete pass/fail evidence before the performance goal can be completed.
