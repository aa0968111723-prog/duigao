# embedded-editor checkpoint
branch: feat/embedded-editor-phased
nextPhase: P3
done: [P0, P1, P2]
blocked: []
notes: |
  P2 evidence: mobile-tablet-ux.test.ts 「compose 390／768／1024：五鍵一列、split 文宣欄 Dock、第一層仍是對話白板」+ poster-compose 23 pass.

  .pdock-bar: repeat(5, minmax(0,1fr)) + flex-wrap nowrap. padding 含 safe-area-inset-bottom.
  768+ 字 12px min-height 44. 1024 is-tablet-split：workspace.is-compose 單欄 stage/toolbar，.panel display:none。
  FIRST_LAYER_TABS 仍 ["對話","白板"].

  下一刀 P3：ProposalImageItem.crop JSON；圖上快捷 移動／裁剪／換圖／轉／刪；方向鍵微移；換圖保留框。poster-compose 加 crop round-trip + undo。
