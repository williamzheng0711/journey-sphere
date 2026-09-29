# Performance Evaluator: zoom-detail

## Objective
我覺得這個方向還可以多向前走幾步：

我的品味，先和你說一下：

- 现在这种显示的样子我还是挺满意的，加載起來的速度已經是滿意的水平。
- 希望把这个地图的边界画得更加清楚一点的话就更好了。
- 可以考慮（只是作為一種建議）讓地圖在沒放大的時候模糊，但是放大的時候儘量還是清楚一點，現在放大了之後有點沒眼看。
- 加載速度還是可以再快一點。

Referenced image files:
- [Image #1]: /Users/williamzheng/.codex/attachments/fe8c6ba3-b17f-4cf0-a8c9-39bd5a33105b/image-1.png

## Evaluator Command
```sh
npm run check && npm run validate:data && node scripts/test-map-progressive.mjs && node scripts/test-map-detail.mjs && node scripts/benchmark-zoom.mjs
```

## Pass/Fail Contract
PASS only when current real-browser screenshot/geometry evidence at overview and zoom 7-12 resolves the reference image coarse-coast/triangle problem with genuinely finer underlying boundaries; preserves layout/palette/visited IDs and codewords; higher-detail data is requested only as needed by the viewport after first display; cold first-display median and transfer at 1.6Mbps/150ms across five alternating baseline/current samples improve over current HEAD65d417c1; detailed-view render remains responsive; desktop/mobile DPR1/2 zoom/pan/wrap/click/hover/reset/destroy and stale/aborted/failed/retry detail loading verified; static export includes needed detail assets; all regression and data checks pass.

This evaluator must exist and produce concrete pass/fail evidence before the performance goal can be completed.
