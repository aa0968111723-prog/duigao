# embedded-editor checkpoint
branch: feat/embedded-editor-phased
nextPhase: P2
done: [P0, P1]
blocked: []
notes: |
  P1 evidence: scripts/tests/poster-compose.test.ts 「compose 單一皮：Dock 五鍵、完成出口、無 pin 鍵」23 pass; tsc --noEmit 0.

  DesktopWorkspace: composing=layerEditing → ProposalDock in toolbar row; TOOLS／EditScopeBar／視覺提案 popover 卸下; 完成 data-testid=compose-exit → setEditing(false).
  ProposalDock 五鍵：＋文字 ＋素材 比較 存成新版本 完成（存檔進 bar，不再第六顆獨立鈕）。
  Mobile：proposalMode 仍掛 Dock；編輯這張 在 compose 時隱藏。
  CSS: .workspace.is-compose .pdock grid-area toolbar.

  下一刀 P2：768 五鍵 nowrap 不疊 safe-area；1024 is-tablet-split 藏 .panel、舞台欄圖最大、Dock 貼該欄底。mobile-tablet-ux.test.ts 加 compose 斷言。
