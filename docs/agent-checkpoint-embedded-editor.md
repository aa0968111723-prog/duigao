# embedded-editor checkpoint
branch: feat/embedded-editor-phased
nextPhase: P1
done: [P0]
blocked: []
notes: |
  P0 recon (main 97eed9a). No feature change this slice.

  雙皮
  - useIsMobile QUERY max-width 720px → 390 = MobileWorkspace；768／1024 = DesktopWorkspace。
  - 手機「編輯這張」：startComposeEditing + proposalSession → 底欄換成 ProposalDock；看稿 m-toolbar（看／修改＝pin 入口）卸下。
  - 桌面「編輯這張」：只 startComposeEditing。toolbar 仍掛 TOOLS 看／修改點／圈畫／擦掉；視覺提案是 <details> popover（ProposalControls 長面板）。沒掛 Dock、沒有 完成 出口。
  - Overlay 兩邊都經 Stage 疊在圖上（拖／pinch／resize handle）。

  768 溢位
  - 768 根本不是手機皮，Dock CSS（.pdock-bar grid 5 列）鎖在 @media max-width 720。768 不會出現五鍵 Dock。
  - 手機 Dock 五鍵現況：＋文字 ＋素材 比較 提案 完成；另有獨立 poster-save-version 在 bar 上方＝第六控制。產品要 ＋文字 ＋素材 比較 存成新版本 完成（完成＝唯一出口）。
  - .pdock padding 含 safe-area-inset-bottom；若把現況五鍵+存檔硬塞 768 會疊 home indicator。

  1024 split 誰蓋圖
  - is-tablet-split = width>=768 && moreOpen（firstLayerChrome）。文宣欄 project-room-main，討論 project-more-sheet 欄 2。
  - 內鑲的是 DesktopWorkspace：頂 toolbar（版本＋pin 工具＋popover）壓舞台。Dock 不在文宣欄底。胸章會被桌面 toolbar 吃高。

  缺 crop／換圖
  - ProposalImageItem 只有 name／imageDataUrl，無 crop。store 無 crop 欄。
  - QuickElement：縮放／透明度／複製／層級／刪；不是圖上快捷「移動、裁剪、換圖、轉、刪」。移動靠 Overlay 拖。
  - 換圖：僅空層 hint「從房間撿」（OPEN_COMPOSE_PICKER_EVENT），沒有選中素材換圖且保留框。
  - 對照：ProposalCompare 面板內 range；Overlay clipPath。滑桿不在圖下緣。compose 時版本列未鎖單張。

  檔案：MobileWorkspace.tsx DesktopWorkspace.tsx VisualProposalOverlay.tsx ProposalDock.tsx ProposalQuickElement.tsx Stage.tsx ProposalCompare.tsx store.ts proposal.css ImageWorkspace.tsx roomChrome.ts
  下一刀 P1：DesktopWorkspace 掛 Dock、compose 卸 pin 工具、拿掉長 popover 當 compose chrome。
