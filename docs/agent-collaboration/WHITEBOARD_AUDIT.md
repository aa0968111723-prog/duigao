# WHITEBOARD_AUDIT — 白板現況稽核（PR-00）

日期：2026-08-28　基準：`main@1d30c67`
方法：7 個維度平行深讀（16 個稽核 agent、281 次工具呼叫）＋ 8 條關鍵宣稱
對抗覆核（6 CONFIRMED / 2 PARTIAL，修正已併入本文）＋正式站真瀏覽器量測。
所有宣稱附檔案:行；未親證的標 UNVERIFIED。

## 0. 正式站量測（真瀏覽器，375×812，duigao-k7q2.zeabur.app）

| 元素 | 位置/尺寸 | 佔視窗 |
|---|---|---|
| `.project-room-header`（sticky） | y0，375×69 | 8% |
| 分類膠囊列 | y135，343×38 | 4% |
| `.rd-tabs`（對話/白板） | y209，351×48 | 6% |
| `.wb-toolbar`（板內頂欄） | y269，351×58 | 7% |
| **`.wb-canvas-wrap`（真畫布）** | **y327，351×420** | **48%** |
| `.wb-bottom`（板內底欄，absolute 疊在畫布上） | y674，329×62 | 7% |
| `.project-fab`（＋，fixed z-25） | y688，52×52 浮於畫布 | — |
| `.asset-ai-fab`（AI，fixed z-62） | y628，61×48 浮於畫布 | — |

任務書要求畫布 ≥75% 可視 — **現況 48%**，有效面積再被底欄與雙 FAB 遮蝕。

## 1. 元件與掛載（維度一）

- `WhiteboardWorkspace.tsx` 共 **749 行**，單檔 4 個元件（NodeView memo
  76-147、RoomContentPicker 149-219、BoardList 221-253、主體 255-749）＋
  28 欄 WhiteboardApi 型別＋ 6 種 bottom sheet JSX。主體 useState×16、
  useRef×8。Sheet union 有死成員 `"create-board"`（無 setSheet、無 render）。
- 掛載鏈（覆核 CONFIRMED）：App.tsx:87-130 lazy 載 MultiBranchRoom →
  `main.project-room-main.is-discussion-root`（寬 `min(680px,100%-32px)`
  置中，styles.css:1026）→ `.project-section` → `.rd-tabs` →
  `discussPane==="board"` 時掛 WhiteboardWorkspace（MultiBranchRoom.tsx:817，
  全庫唯一 mount 點）。**與 RoomDiscussion 互斥掛載：切回對話整個卸載白板，
  camera/selection 全失**（camera 初始 {x:24,y:24,zoom:1}）。
- **[blocker] 畫布高度鏈斷裂（覆核 CONFIRMED，兩層斷點）**：
  `.wb-shell{flex:1;min-height:0}` 的父 `.project-section` 是 block
  container（styles.css:1027 只有 padding）→ flex:1 被忽略；再上層
  `.project-room-main` 無高度/flex（styles.css:1026）。結果畫布塌縮為
  `.wb-canvas-wrap` 的 `min-height:420px` 定值（whiteboard.css:9），
  與視窗高度無關。畫布還是圓角 18px＋邊框的**卡片**，套在 680px 欄裡。
- **[major] FAB 遮擋（覆核 CONFIRMED）**：`.project-fab`（z-25，
  MultiBranchRoom.tsx:908 在 pane 條件之外 — board pane 照樣渲染）與
  `.asset-ai-fab.is-project`（z-62，App.tsx:2888）都是 root stacking
  context 的 fixed，蓋在 z-auto 的 `.wb-bottom` 與畫布右下之上；
  寬幅（≥721px）時 AI FAB 的 bottom 改 24px、遮得更直接（asset-ai.css:322）。
- 頂部「✦ AI」按鈕 `project-ai-button` class 在全部 CSS 零命中 — 裸 class。

## 2. 輸入與手勢（維度二）

已有：Pointer Events 統一入口（setPointerCapture＋cancel 容錯）、單指拖
node（120ms debounce 持久化）、單指空白平移、雙指 pinch（中點錨定，
clamp 0.35–2.4）、長按 420ms 進多選、桌機 shift 框選/shift 點擊 toggle、
`touch-action:none`＋`overscroll-behavior:none`。無 hover 依賴（css 零 :hover）。

缺陷（皆讀碼實證）：

- **[major] pinch 不清 drag**：第二指落下只設 pinch 就 return，一指抬起後
  殘留手指沿用 pinch 前的 `drag.current.last` — 按在節點上時節點跳整段
  pinch 位移（WhiteboardWorkspace.tsx:320-325 vs 378-383）。
- **[major] 長按無位移門檻**：任何 pointermove 即取消計時器（無 slop），
  手指微抖就進不了多選 — 而長按是行動端唯一多選入口。
- **[major] text 節點永遠渲染 textarea**（非編輯時也是），textarea
  stopPropagation → 只能靠 10-12px 邊框環拖曳，觸控幾乎抓不到。
- **[major] 虛擬鍵盤零避讓**：WhiteboardWorkspace 不用 useViewport；
  `--kb` 全庫只有 `.m-bottom`/`.m-modal` 消費 — 下半畫面節點編輯時被
  鍵盤蓋住，無 camera 調整、無 scrollIntoView。
- **[minor] 雙指平移未實作**（zoom 不變時 zoomAt 數學上不動 camera）；
  雙擊靠原生 dblclick 合成（iOS 穩定性 UNVERIFIED）；套索不存在；
  雙擊縮放/邊緣 back swipe 無防護（viewport meta 無限制；畫布外起手的
  pinch 仍縮放整頁）；MIN_ZOOM 0.35 時 mindmap 節點縮到 ~56×22 螢幕 px。
- 觸控目標：底欄 48px ✓、sheet 選項 52px ✓；節點動作 pill 40px ✗、
  多選「完成」鈕無尺寸保障 ✗（<44px 標準）。
- `BROADCAST_THROTTLE_MS=80` 是**死碼**（只更新時戳，無任何廣播呼叫）；
  長按空白的分支實質無作用（pointerdown 已清空選取）。

## 3. 渲染與效能（維度一/六）

- zoom/pan 用 CSS transform（`.wb-layer` translate+scale，origin 0 0，
  will-change）— 正確方向。**桌機滾輪縮放/平移完全未實作**（全庫零
  wheel handler）。
- 節點層有 culling（>80 節點才 AABB 過濾，pad 80 世界座標）；
  **邊完全不 cull**：`edges.map` 每條 2 次 `liveNodes.find`
  （O(edges×nodes) 每 render），SVG 邊層寫死 4000×4000＋overflow:visible。
- bundle（build:local 實跑）：首屏 index 421KB（gzip 131）＋supabase 220KB；
  白板 UI 在 lazy 的 MultiBranchRoom chunk（55.5KB, gzip 15.8）；但
  offline.ts（白板佇列邏輯）被 App.tsx 直接 import — **進了首屏 bundle**。
  livekit 582KB 是動態 chunk（僅按語音才載）✓。

## 4. 資料模型與 schema（維度三）

- 兩套 model 問題**已解**：src/collaboration/whiteboard.ts（canvasId 那套）
  在 #50（ADR-010）整目錄刪除，現有復活警報測試。現行唯一 model =
  0014 的 whiteboards/whiteboard_nodes/whiteboard_edges；型別來自
  `src/features/collaboration/types.ts`。
- 寫入是 **row 級 upsert**（collaborationRepository.upsertNode），無雲端
  整包覆蓋路徑。**但 P2P（PeerJS legacy）整包 Room JSON 廣播仍活著**
  （App.tsx:772/2228，覆蓋本地 state＋IDB — 不寫 Supabase，但屬「整包
  覆蓋」活路徑，[major]）。
- OCC：`version` integer＋DB trigger（BEFORE UPDATE，stale 即 raise、
  否則 version:=old+1 伺服器自增）；client 有 lastAckedNodeVersion、
  in-flight shield、per-node persist chain、conflict→drop+refetch+誠實
  toast。**delete 無版本檢查**（trigger 只掛 UPDATE — ADR-011 已知，
  tombstone 未做）。`persistNodePosition` 是 dead export。
- 對照任務書第 7 節 canonical 欄位（逐欄）：

| 欄位/表 | 現況 |
|---|---|
| rotation / z_index / locked | **缺**（輸出以 created_at 排序） |
| source_type/source_id/source_version_id | 部分：linked_entity_type/id（8 詞彙 CHECK、無 FK、無版本欄、無成對 null check） |
| anchor（edge 連接點） | **缺** |
| revision | 有（名為 version；nodes/boards 有，**edges 完全沒有** — edges 也無 updated_at/created_by） |
| frames 表 | **缺**（替代：node_type='group'＋parent_group_id，無 FK 無索引） |
| operations 表 | **缺**（audit events 僅 3 型別，明言 'Never drag pixels'） |
| versions（快照）表 | **缺**（只有整數計數，不能回溯內容） |
| presence 表 | 刻意無（0014:783 註解：presence 走 channel）；presentation_state 是 presenter 預留、src 零引用 |

- RLS 現況良好：三表 enable、USING+WITH CHECK 齊、membership 走
  SECURITY DEFINER helper（search_path=''、0010 已收 grant）、白板
  禁硬刪（revoke delete＋trigger 擋、只許 archive）、guard_room_update
  防 reviewer 自我升級。

## 5. Realtime（維度四）

- 整房**單一 channel** `room:${roomId}`：26 個 postgres_changes binding
  ＋1 presence binding。nodes/edges 走 row-patch（rAF 合併單次 setRoom），
  whiteboards 表變更觸發整房 reload（200ms debounce）。
- echo 防護：shielded = inFlight ∪ dragging；version 嚴格大於
  max(acked, local) 才接受。重連：SUBSCRIBED 時 flushPending＋對開板
  loadWhiteboard 自癒；visibilitychange/online revive。
- presence 只有**線上人數**；無 cursor presence（PeerMsg 的 cursor 變體
  是零實作的死型別）；「誰在編輯」靠 stampWriter 把 lastWriterId 蓋進
  node.content（30 秒窗）。
- [minor] DELETE binding 未按 room_id 過濾（strokes/nodes/edges）；
  edges 無 UPDATE binding；CloudWrites 無 deleteEdge（repo 的 deleteEdge
  零呼叫者 — edge 刪除只靠 FK cascade 的 realtime DELETE，cascade 事件
  是否經 publication 送達 UNVERIFIED）。
- 拖曳中位置從不即時外送（見 §2 死碼）— 其他人要等 pointer-up 的
  postgres UPDATE 才看到移動。

## 6. 離線/快取/undo（維度五）

- 三個 IndexedDB：`duigao`（整包 Room 快照）、`duigao-collaboration`
  （board_snapshots＋pending_edits durable 佇列）、visual-proposals 自用。
- 開板：先 IDB 快照上畫、再雲端 loadWhiteboard，reconcileNodes（version
  優先）合併。節點寫入失敗/離線 → durable 佇列（IndexedDB 是唯一 retry
  owner）；conflict 不入佇列（drop+refetch）。online 事件重放，含防盲刪
  的 clearPendingEditIf。
- **[major] 白板完全沒有 undo/redo**：upsertNodes/deleteNode/createEdge
  不經 pushUndo（App 層 undo 只覆蓋 pin/圈畫/意見，且重開頁即失）。

## 7. 錨點與雙向連結（維度七）

- ContextAnchor union 7 臂：image-point/region、video-point/range、
  entity（8 詞彙）、board-node、planform-scene（純預留零 runtime）。
  **缺 message、plan_section、canva、cutos 臂**（canva/cutos 契約層與
  anchor 零交集）。26 條 unit tests 覆蓋 adapter round-trip。
- 「訊息→白板」走得通但 **provenance 遺失**（[major]）：加入白板產生的
  是純 text 便利貼（createSticky 不寫 linkedEntityType；'discussion'
  詞彙 DB 允許但**全庫零生產者**）— 貼上板後回不去原訊息。
- 「白板→訊息」雙向閉環 ✓（分享至討論 → kind:"node" payload → 「打開
  白板」按鈕 → focusCamera 置中）。
- openTarget 四 surface 只有 board/content 被 UI 消費；entity surface
  零導航路徑。意見列（comments）錨不進 whiteboard_node（schema 無欄）。

## 8. 測試現況（維度五）

- unit：collaboration-workspace.test.ts 36 test（OCC 流、patch 護盾、
  retry 四象限、culling、arrange）＋pending-writes 5＋outbox 6。
- e2e：collaboration-workspace.mjs ~43 check 實測建板/打字/pinch/pan/
  長按多選/stale-write 誠實化/雙分頁 row-patch/真斷網離線矩陣。
- 缺：手勢邊角（pinch 中斷拖曳、鍵盤避讓）、雙向連結 provenance、
  視覺回歸、平板 viewport、真機矩陣。

## 9. 結論（供 ADR-013）

現有引擎的**同步管線**（OCC＋row-patch＋shield＋durable 佇列）經多輪
對抗審查與離線 e2e 淬鍊，是最有價值且最不可擾動的資產；行動端的痛
是（a）CSS 高度鏈斷裂＋殼吃掉 52% 畫面（版面問題，非引擎問題）、
（b）手勢缺口清單明確（pinch-drag 衝突、slop、雙指平移、套索、鍵盤
避讓）、（c）schema 缺 canonical 欄位（全部可 additive 補）。
詳細架構決策見 DECISIONS.md **ADR-013**。
