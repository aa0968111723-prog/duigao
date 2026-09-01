# Checkpoint — 白板無法使用（2026-09-01）

基準：`main` @ `06db470`。分支 `fix/whiteboard-usable`。
#188（D1–D8）**未合**，本任務不重做引導影片／招生樹文案收斂。

## 診斷（依序）

1. **第一層「白板」分頁** — 能進 pane，但 `onClick` 只 `setDiscussPane("board")`，**不** `onOpenWhiteboard`。`WhiteboardWorkspace` 在 `activeBoardId` 空時渲染 `whiteboard-list`（要自填名稱才能建板）。空板動詞在 Focus 裡，永遠看不到。= 空白宇宙。
2. **空板四動詞** — `showStarter` 在 `activeNodes.length === 0` 也為真，編輯者看到 starter（寫步驟／釘文宣／畫關係／種樹），不是 `EMPTY_BOARD_VERBS`（釘對話／放文宣／長骨架／問 Grok）。`wb-empty-board` 幾乎掛不上。釘對話的 `onPinFromDiscussion` 還會切回對話並關板。
3. **plantEnrollmentTree2026** — 函式會長樹；但沒開板時 `plantEnrollmentTree` 直接 `if (!board) return`。種了才 `fitCamera`。
4. **390／768 手勢** — starter 有 `stopPropagation`；empty-board 沒有，點擊會被 canvas `setPointerCapture` 吃掉。焦點 sheet 掛在 canvas 裡、底欄是兄弟，peek 不應蓋五鍵。
5. **hydrate／雲端寫入** — `upsertNodes` 先寫本機再 persist；409 有活 toast。未 ack 會 queue。不把失敗畫成墓碑。
6. **問 Grok** — catch 已是活句。HTTP 200 `answer:null`／`unavailable` 走 `colleagueTurnFromResponse` 成功臂，變成「我看過了」。刪除列才顯示「這則已收回」。

## nextPhase

DONE：進白板自動 open／create「活動規劃」；空板只掛四動詞；長骨架／放文宣長可見卡並 fitCamera；empty-board stopPropagation；釘對話不離板；Grok 200 失敗走活句。測完開 PR。不 merge／deploy。

## 禁

`FIRST_LAYER_TABS`、新 tab、新 migration、Konva、embed Canva、#188 整包。
