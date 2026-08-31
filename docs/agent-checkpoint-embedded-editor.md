# embedded-editor checkpoint
branch: feat/embedded-editor-phased
nextPhase: P4
done: [P0, P1, P2, P3]
blocked: []
notes: |
  P3 evidence: poster-compose.test.ts 「crop JSON round-trip、undo 還原、換圖保留框」24 pass; tsc 0.

  ProposalImageItem.crop 0–1. helpers: clampCrop insetCrop replaceImageKeepingFrame nudgeItemPosition nextRotation.
  Overlay 圖上快捷 data-testid=poster-item-shortcuts：移動／裁剪／換圖／轉／刪。Arrow 微移。換圖 hidden file → replaceImageKeepingFrame 保留 x/y/width/rotation。
  卸 Overlay「完成擺放」（完成只在 Dock）。

  下一刀 P4：對照滑桿圖下緣；compose 版本列鎖單張；768 對照可拖。
