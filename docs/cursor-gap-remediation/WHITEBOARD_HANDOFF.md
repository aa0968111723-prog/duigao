# PR-GAP-06 白板整合 — handoff（不重做 #78 schema）

狀態：**HANDOFF / INCOMPLETE**。本文件不是完工聲明。全站 gap-remediation **未完成**。

核對時間：2026-08-29。來源：GitHub PR #78 live + 本分支 checkout。

## 為什麼疊在 #78，不疊 #95、不上 main

#78 仍是 **schema owner**，且 **未合併**。

| 欄位 | 2026-08-29 live |
|---|---|
| PR | https://github.com/aa0968111723-prog/duigao/pull/78 |
| 標題 | PR-WB01: canonical whiteboard schema — 0021-0024＋tombstone 資料層＋operations＋anchors |
| 分支 | `agent/wb01-canonical-schema` |
| Head | `84d3f3e67cebad111a9a71d9941423eaab376ff7` |
| Base（GitHub 紀錄） | `main` @ `361bec04be944d36cb1c6a3e9e62572caecc54c7`（過期） |
| `mergeable_state` | **`dirty`（CONFLICTING）** |
| 相對其紀錄 base | 102 files / 24 commits |

現行 `origin/main` 已是 `3d8b2cf`（含已合併的 #97）。#78 對現行 main **仍衝突**。

#95 stack（含 GAP-02／04／05）與 #78 **檔案重疊**：`src/App.tsx`、`src/cloud/collaborationRepository.ts`、`src/cloud/roomSync.ts`、`src/cloud/useCloudRoom.ts`、`src/features/multi-room/MultiBranchRoom.tsx`、`package.json`、`src/styles.css` 等。因此 **禁止** 把白板工作疊在 #95 stack 或把 #78 migration／canonical schema 複製到 main／#95。

本分支：`cursor/p1-whiteboard-handoff-70d9`，**從 #78 當前 head 建立**。Base 必須是 `agent/wb01-canonical-schema`，不可改成 `main`。

## #78 擁有、本批拒絕改寫的檔

這些是他們的 in-flight schema／畫布。改它們就是搶 schema：

- `src/features/whiteboard/**`（含 `WhiteboardWorkspace.tsx`、canvas／gestures／pen／freehand／versions／registry、`whiteboard.css`）
- `src/features/collaboration/operations.ts`、`types.ts`、`nodes.ts`、`links.ts`、`offline.ts`
- `supabase/migrations/0022_whiteboard_canonical_columns.sql`
- `supabase/migrations/0023_whiteboard_frames.sql`
- `supabase/migrations/0024_whiteboard_operations.sql`
- `supabase/migrations/0025_whiteboard_versions.sql`
- `supabase/migrations/0026_whiteboard_freehand.sql`

本批 **沒有** 新增或改寫任何上述檔。沒有把這些 SQL 複製到 main 或 #95 stack。

## 在 #78 樹上已經存在、因此不重做的產品層

核過 source，不是文件宣稱：

| 項目 | 證據（#78 head） | 本批 |
|---|---|---|
| Focus Mode chrome | `WhiteboardWorkspace.tsx`：`wb-focus` / `wb-focus-top` / `wb-focus-main` / `wb-focus-bottom`；`App.tsx` 抑制 AssetAiFab；`MultiBranchRoom.tsx` 抑制 project-fab | **拒絕重寫**（檔屬 #78） |
| 手機／平板工具列 | 同一檔的 `wb-focus-bottom` 選取／便利貼／套索；平板側欄註記在 `.wb-focus-main` | **拒絕重寫** |
| 空白板進場 | `wb-empty`：「還沒有白板。先開一塊「招生規劃」，再把文宣和流程放上去。」＋可建立表單 | **已保證；不重寫** |
| conversation↔node 型別 | `LINKED_ENTITY_TYPES` 含 `discussion`；`DISCUSSION_KINDS` 含 `node` | 型別已在；不重寫 `types.ts` |
| conversation↔node 函式 | `links.ts`：`discussionPayloadFromNode`、`stickyFromDiscussion` | 不重寫 `links.ts` |
| conversation↔node UI | 節點動作「打開來源訊息」（`wb-open-source-message`）；「加到白板上」；`App.tsx` `shareNodeToDiscussion` / `addMessageToBoard` | **已接線；不重寫** |
| 非整房 last-write-wins | `applyBoardPatches`（增量＋version gate）；`reconcileNodes`（OCC）；`replaceBoardGraph`（**板級**整替，他板不動）；`App.tsx` `applyRemoteRoom` 空 snapshot 保留本地 nodes | 本批只加 **回歸測試**，不改實作 |

## 本批實際做的（疊在 #78 之上）

1. 本文件：說明為何停手、誰擁有 schema、migration 必須重編號。
2. `docs/cursor-gap-remediation/FINAL_EVIDENCE.md`：只列目前有證據的批次；**不宣告全目標完成**。
3. `scripts/tests/whiteboard-handoff.test.ts`：
   - 若整房 last-write-wins 覆蓋被重新引入，測試必須失敗。
   - 記錄空白板進場與 conversation↔node 已在 #78 樹上的證據。
   - 記錄「schema 未在本批完成、不可複製到 main」——不實作他們的 schema。

## 人類必須做、代理不得代做

1. **不要** 把 #78 原樣 merge 進現行 main。main 已有 `0022_discussion_author_integrity.sql`。#78 的 `0022`–`0026` **編號碰撞**。
2. #95 stack 另有 `0023_video_optimize.sql`（在 #95 樹上）。三方編號必須由人類 **renumber** 後再合。
3. #78 對現行 main 的衝突由 **#78 作者** 解。本批不幫他們「修完 schema」。
4. #88 Design Intelligence 仍暫停（0027–0028）。不要在本批開始。
5. 不要把本分支 retarget 到 `main` 或 #95 stack — 那會變成複製 #78 schema。

## 合併順序（產品修復，不是本文件）

1. #97（已合進 main）
2. #96 Home 誠實狀態（open，對現行 main dirty — 需 rebase）
3. 先 rebase #98（與 #97 撞 `voiceToken.ts`／`voice.ts`）再合 #98
4. #95 → 已疊上的 #100 → #101 → #102（GAP-05）
5. **然後** 人類 rebase／renumber #78，再考慮本 handoff 分支
6. #88 最後

## 本批明確拒絕

- 改寫 `WhiteboardWorkspace.tsx` 或任何 whiteboard CSS／canvas 實作來「補」Focus Mode
- 新增或改寫 `0022`–`0026` whiteboard SQL
- 把 #78 的 migration 或 canonical types 複製到 main／#95
- 解 #78 與 main 的 merge 衝突
- merge、deploy、改正式庫、force-push
