# WB03 — 雙向連結輪 設計（Claude 提案）

盤點依據：六路平行讀者的接線點地圖（2026-08-28）。缺口與對策逐項：

## 1. 訊息→白板 provenance（斷鏈修復）

現況：`stickyFromDiscussion`（links.ts）建的便利貼**沒有** link — WB01 造好
的 `anchorToNodeLink` message 臂（discussion 詞彙的第一個合法寫入路徑）
從未接線。修：sticky 帶 `linkedEntityType:"discussion"`、
`linkedEntityId:messageId`，並引用原文（quotedBody 語意進 content.sourceLabel）。

## 2. 板節點→來源訊息（新路）

現況：`anchorFromNode` 把 discussion link 折進 entity 臂 → `openTarget`
給 entity surface → 白板「打開內容」對這種節點是死路。修：
- `anchorFromNode`：`linkedEntityType==="discussion"` → `{type:"message",
  messageId}`（openTarget 既有 message→discussion surface）。
- WhiteboardWorkspace「打開來源訊息」：surface==="discussion" →
  `api.onOpenDiscussionMessage(messageId)`。
- MultiBranchRoom：關板→切討論 pane→scroll 到 `discussion-${id}`＋
  1.6s 高亮（.rd-msg-flash）。訊息已被刪→toast 誠實說。

## 3. 內容側反向 chip「白板引用 N」

對稿（poster/video）頂列（手機 .m-versions、桌機 topbar-right）加 chip：
N = 該 branch 被白板節點引用數（含 version link 歸戶到 branch）。點擊→
`onOpenBoardNode(whiteboardId, nodeId)`（首個引用節點）。N=0 不渲染。
plan 屬 PlanEditor 殼，本輪不加（誠實範圍）。

## 4. Frame 互動（0023 從「只能建」到可用）

- 選取：frame 標題列（pointer-events:auto 的把手）tap → selectedFrameId
  （與節點選取互斥）；情境列：改名／刪除／取消。
- 拖曳：標題列拖 → frame＋「起拖時中心在框內的節點」一起位移（成員
  判定凍結在起拖，不逐 move 重算）。
- 縮放：右下角 handle。min 120×90，max 8000（DB CHECK）。
- ops：frame-create/update/delete 全部 emit；undo：executors 加 frame 四
  件組（upsert/delete/recreate/find）；frame-update 有 drift 防護同 F8。
- 佈線：useCloudRoom.writes.deleteFrame；App onUpdateFrame/onDeleteFrame
  （樂觀＋雲端）。realtime 訂閱仍屬 WB04（誠實不動）。

## 5. Freehand（0026）

- migration 0026：node_type CHECK 重建含 'freehand'（0014 重放不會洗掉
  — probe 驗證）。
- 資料：content.points＝相對節點左上的 [x,y][]（外接框＋8px pad），
  content.color/strokeWidth。搬節點＝搬筆畫，undo 走既有 x/y mask。
- 工具列「繪圖」鈕（補 wireflow 缺席位）：作用中時 pointer 直接進筆畫
  收集（**繞過手勢 reducer** — 單指畫、雙指仍縮放：第二指落下即取消
  當前筆畫轉 pinch）。up→thinStroke→normalizeStroke→建節點＋record。
- renderer：SVG path；選取／鎖定沿用節點框。

## 6. Camera memory（WB02-F9 承諾）

模組級 `Map<boardId, Camera>`：開板還原、關板/切板時存。上限 24 板
LRU。不存 selection（stale id 風險）。

## 7. History 層協調器（修 overlay×focus 的 back 真 bug）

現況：對稿 overlay 疊在 Focus 上時按 back，白板的 popstate listener 先
收 → **板被退、overlay 還在** — 兩個 listener 不協調。修：
`src/lib/historyLayers.ts` 單一協調器 —
- `pushHistoryLayer(name, onBack)`：入 stack＋pushState；回傳 remove()。
- 全域單一 popstate listener 只叫**棧頂**的 onBack：回 "closed"（層被
  消耗）或 "repush"（層自理內層 UI — 白板 sheet 情境 — 補 pushState）。
- 亂序移除（層不在頂被程式性關閉）：標記 zombie，下一次 pop 消耗
  zombie、不誤傷活層 — 已知限制誠實記錄：那一下 back 無可見效果。
- 白板 focus/sheet 遷移到協調器（語意不變：back 先關 sheet 再退板）；
  對稿 overlay 開啟時 push "content-overlay" 層 → back 先關 overlay。
- 可測性：核心 `createLayerStack(historyLike)` 注入樣式，單元直測。

## 8. 測試

- 單元：freehand 幾何 5 條；historyLayers（closed/repush/zombie/亂序）；
  frame undo executors＋drift；anchorFromNode discussion 臂 round-trip。
- migrations：0026 probes（freehand 可插、非法型別仍擋、0014 重放後
  'freehand' 仍在、re-run 冪等）。
- e2e（collaboration-workspace 增章）：訊息「加入白板」→ 節點帶
  provenance → 「打開來源訊息」跳回討論＋高亮；對稿 chip「白板引用」；
  frame 拖/縮/改名/刪＋undo；freehand 畫一筆成節點＋undo；camera
  memory（關板重開視角不歸零）；overlay-over-focus back 順序。
- 視覺基準：不擴矩陣（12 張維持），新 UI 由功能斷言覆蓋 — 誠實理由:
  頻繁改版期基準churn 會淹沒真回歸。

## 不做（誠實邊界）

Universal Intake（相機/檔案直入板）、plan 段落級反向鏈、frame 巢狀、
筆畫編輯（點級 eraser）、realtime frames — WB04+。
