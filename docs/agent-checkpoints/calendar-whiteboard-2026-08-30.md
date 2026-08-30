# Checkpoint — 專案日曆時程與白板協作 UX（2026-08-30）

## 如何恢復

```bash
cd duigao
git fetch --all --prune
git checkout feat/collab-02-calendar-ux-fix
```

未提交工作不要 `reset --hard` / `checkout --`。

## 稽核結果

- 現有白板：`whiteboards` / `whiteboard_nodes` / `whiteboard_edges`（0014 + 0024–0028）。節點有 OCC `version`、tombstone、`linked_entity_*`、freehand。
- 沒有獨立 task 表。決策用 `decision_records`，投票用 `room_polls`。
- 訊息↔白板已有 `stickyFromDiscussion` / `linkedEntityType: discussion`。
- Project context = `rooms` + `projectMode` 活動房殼 `MultiBranchRoom`。
- PR #78 舊白板 PR 有衝突；本工作以最新 `main`（`7789d5c`）新分支重放，不硬合併 #78/#88/#95/#96/#98。
- 受影響共用檔：`App.tsx`、`MultiBranchRoom.tsx`、`WhiteboardWorkspace.tsx`、`RoomDiscussion.tsx`、`collaborationRepository.ts`、`proposals.ts`、`types.ts`。採最小差異：新增 `src/features/schedule/`，不覆寫畫布核心。

## 現有白板架構

`NODE_TYPES`：text/image/room_content/flow/mindmap/decision/poll/link/group/ai_result/freehand。  
本次 additive 擴充：`calendar_event`、`task`。舊列仍可讀。

## 現有任務架構

無 task 表。時程與任務截止日期共用 `room_schedule_events.event_type`。

## 新增日曆資料結構

`supabase/migrations/0032_room_schedule.sql`：`room_schedule_events` + RLS `is_room_member`。欄位：title/event_type/start_at/end_at/status/assignee/source_type/source_id/version。

## UI 設計決策

- 手機預設「今日／本週 Agenda」，不是巨大月曆。日期 → ModalSheet。
- 活動房分頁：對話｜白板｜時程。
- 白板手機底欄五項：選取、畫筆、文字／便利貼、連線、加入。素材進加入 sheet。
- 訊息「加入時程」、節點「設定期限」。
- AI `create_schedule_event` / `create_task` 需 `applyGate` 採用後才寫入。

## 受衝突影響的檔案

未碰 PR #78 分支。未 `ours/theirs`。未刪白板欄位。

## 每階段完成狀態

1 稽核：完成  
2 日曆：完成（local + cloud upsert 誠實 ack）  
3 白板 UX：完成（五鍵底欄、期限、舊資料可讀）  
4 雙向連結：完成  
5 AI proposal：完成（採用前不寫）  
6 RLS/offline：migration + pendingWrites 鍵 `schedule:`  
7 衝突：以 main 新分支  
8 測試：見下  
9 PR：見交付  
10 正式站：未部署

## 測試結果

第二輪（skeptic 缺口修補後）：

- `tsx --test scripts/tests/schedule-workspace.test.ts`：13 pass / 0 fail（含 weekStart 週一、OCC plan、decideScheduleProposalWrite 採用／拒絕）
- `test:collaboration`：283 pass / 0 fail
- `test:realtime-offline`：9 pass / 0 fail
- `test:mobile-tablet-ux`：8 pass / 0 fail
- `test:asset-intelligence`：21 pass / 0 fail
- `tsc --noEmit`：通過
- `test:api-response`：22 pass / 2 fail — 失敗是既有 Termux `rollup-android-arm64` optional dependency，與本變更無關
- Playwright Chromium：`Unsupported platform: android`（BLOCKED_BY_EXTERNAL_DEPENDENCY）
- 正式站未部署本分支，live 驗證不做假通過

## skeptic 修補（2026-08-30 第二輪）

- 時程卡片 tap-through：先切對話／白板 pane（平板走 split companion），再呼叫 App `onOpenScheduleSource`，不再提早 return。
- `weekStart` 用 Taipei weekday，不再用 `getUTCDay()`（2026-08-31 週一的本週從週一起）。
- 白板「設定期限」有日期表單；`addNodeDeadline` 會 `applyDeadlineToNode`。
- Agenda 可選類型／日期、編輯、刪除、拖到日期、長按開編輯（不誤開來源）。
- 平板 對話＋日曆／白板＋日曆 split；時間軸可折疊。
- `patchScheduleEvent` 不 bump version（version = 上次 ack 的伺服器版）。ack 後 `stampPersistedScheduleEvent` / `adoptPersistedScheduleEvent`。
- `scheduleCloudWrite`：沒有列 INSERT；內容相同才 ack（同客戶端重試）；`existing.version !== event.version` 為 stale-write；否則 UPDATE `eq event.version`、payload version+1。兩個客戶端從 v1 改出不同標題，後寫者衝突，不再 ack-on-equal。
- `useCloudRoom` 時程寫入走 `writeAck`（與節點 OCC 同路徑），不進 `run(schedule:id)` 記憶體重試佇列。stale-write → conflict + reload。
- AI 拒絕走 `decideScheduleProposalWrite({ action: "reject" })`，不會產事件；採用才 `upsertSchedule`。提案顯示用過的訊息／檔案／節點與理由。

## 下一次如何恢復

拉此分支，勿重開新 repo。正式站需套 0032 後才有雲端時程列；未套用時 load 回空陣列、本機仍可建。未部署時不要用正式站當通過證據。
