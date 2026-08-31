# Checkpoint — 白板焦點 × Grok 同事（2026-08-31）

基準：`main` @ `e343e19`（#171/#172/#173/#175 已在）。雲端分支 `cursor/whiteboard-discussion-focus-grok-1f8d` @ `769d038`。

本機協作 E2E 134/134（`5c9f8cc`）。GitHub `browser` 上一輪在平板 `wb-side-rail` 逾時；腳本已對齊 viewport。§7 稽核見 `/opt/cursor/artifacts/completion-audit.md`。

## 讀到的現況（程式為準，各三行）
焦點：選取是本機 `selected[]`，與 Focus Mode（開板 portal）正交；`focusNodeId` 只拉相機一次。沒有「房間焦點」物件，選卡 ≠ 團隊在討論這張。
Rail：`railVisible = tabletUp(900×600) && !railCollapsed`。手機 `discussPane` 互斥卸載討論；註解已寫 CSS 隱藏會雙掛，所以手機直接不掛。
空板／工具：開板零節點無中央 CTA；新 flow 預設文案「新步驟」。五鍵底欄已在。`create_comment` 用觸發者名；無 `payload.agent`。

## 任務書過期句
「分頁：對話｜白板｜時程」是 #175 UI 第三鍵；`FIRST_LAYER_TABS` 仍是 `["對話","白板"]`——不抬時程。
`railVisible` 斷點是 900×600 不是 ≥768；sheet/rail 跟既有 `tabletUp`，不硬改 768。

## 打算改 / 不改
改：WhiteboardWorkspace、whiteboard.css、aiPreview layout origin、MultiBranchRoom 狀態與手機 sheet、RoomDiscussion 同事氣泡、discussionHonesty、App `create_comment`、roomAgentContract focus 欄、測試。
不改：`roomChrome` 兩個 FIRST_LAYER、visual-proposal store/mergeHydrate、versions Storage、#163、新 migration、Photoshop/Canva。

## 補齊（同日）
房間焦點改走既有 presence（只帶不透明 `focusNodeId`，不送姓名）。
四入口 ask 帶 `boardAskContext`（focus + 最多 12 張可見節點短列）；edge `room-ai-context` 合併進卡。
平板 rail 焦點切換時捲到相關訊息；沒有關聯顯示「針對這張留言」。
