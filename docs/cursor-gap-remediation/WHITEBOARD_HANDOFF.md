# Whiteboard handoff restack — #103 onto #116（證據，未完成）

狀態：**HANDOFF / INCOMPLETE**。全站 gap-remediation **未完成**。不要 merge、不要 deploy、不要改正式庫。

Branch: `cursor/p1-whiteboard-handoff-restack-70d9`  
**Base 必須是** `cursor/p1-whiteboard-migration-renumber-70d9`（#116 @ `84e6808`）。**不要** retarget `main` 或 #78。  
**未 reset** #78 / #103。#78 schema 檔與 SQL **拒絕重寫**。只 port 測試／證據，並改釘 **新檔名 0024–0028**。

核對時間：2026-08-29。來源：`git ls-tree` + GitHub PR heads（再抓，不沿用舊 SHA）。

## 為什麼疊在 #116，不重疊 #78、不疊 #95、不上 main

#78 仍是 **schema owner**，且 **未合併**。#116 是 #78 的 **filename-only** 重編號（0022→0024 … 0026→0028），SQL bytes 不變。

#103（`cursor/p1-whiteboard-handoff-70d9` @ `851964f`）仍釘舊名 `0022`–`0026`。**不要 reset #103。** 本分支從 #116 重建 handoff 測試，讓斷言跟新檔名走。

#78 / #103 舊名與 main `0022_discussion_author_integrity.sql`、#95 `0023_video_optimize.sql` 仍是 **編號碰撞**。人類 rebase #78 才能補 0022+0023 缺口。

本分支 **禁止** 把白板工作疊在 #95 stack 或把 #78 migration／canonical schema 複製到 main／#95。

## #78 擁有、本批拒絕改寫的檔

- `src/features/whiteboard/**`
- `src/features/collaboration/operations.ts`、`types.ts`、`nodes.ts`、`links.ts`、`offline.ts`
- `supabase/migrations/0024_whiteboard_canonical_columns.sql`（#78 舊名 0022）
- `supabase/migrations/0025_whiteboard_frames.sql`（#78 舊名 0023）
- `supabase/migrations/0026_whiteboard_operations.sql`（#78 舊名 0024）
- `supabase/migrations/0027_whiteboard_versions.sql`（#78 舊名 0025）
- `supabase/migrations/0028_whiteboard_freehand.sql`（#78 舊名 0026）

本批 **沒有** 新增或改寫任何上述檔。沒有把這些 SQL 複製到 main 或 #95 stack。

## Reservation table（權威：各分支 `supabase/migrations/` 檔名）

| Prefix | Filename on that tree | Proven owner | Evidence |
|---|---|---|---|
| **0022** | `0022_discussion_author_integrity.sql` | **main** (#99) | `git ls-tree origin/main` |
| **0023** | `0023_video_optimize.sql` | **#95** / room stack | `git ls-tree origin/cursor/complete-missing-features-0897` |
| 0022–0026 **old whiteboard** | `0022_whiteboard_*` … `0026_whiteboard_freehand.sql` | #78 / #103 | still on those heads — **編號碰撞** — **do not reset** |
| **0024–0028 (this tree / #116)** | `0024_whiteboard_canonical_columns.sql` … `0028_whiteboard_freehand.sql` | #116 + this restack | `origin/cursor/p1-whiteboard-migration-renumber-70d9` @ `84e6808` |
| 0027–0028 **old DI** | `0027_design_knowledge.sql` / `0028_design_research_usage.sql` | #88 / #104 | still on those heads — **do not reset** |
| **0029–0030** | `0029_design_knowledge.sql` / `0030_design_research_usage.sql` | DI renumber | `cursor/p2-di-migration-renumber-70d9` — **do not invent 0031+** |

## Mapping (#78 → #116, filename only)

| Old (#78 / #103) | New (#116 / this restack) |
|---|---|
| `0022_whiteboard_canonical_columns.sql` | `0024_whiteboard_canonical_columns.sql` |
| `0023_whiteboard_frames.sql` | `0025_whiteboard_frames.sql` |
| `0024_whiteboard_operations.sql` | `0026_whiteboard_operations.sql` |
| `0025_whiteboard_versions.sql` | `0027_whiteboard_versions.sql` |
| `0026_whiteboard_freehand.sql` | `0028_whiteboard_freehand.sql` |

## 在 #78/#116 樹上已經存在、因此不重做的產品層

| 項目 | 證據 | 本批 |
|---|---|---|
| Focus Mode chrome | `WhiteboardWorkspace.tsx`：`wb-focus` / `wb-focus-top` / `wb-focus-bottom` | **拒絕重寫** |
| 空白板進場 | `wb-empty`／還沒有白板／建立白板／招生規劃 | **已保證；不重寫** |
| conversation↔node | `links.ts` + workspace「打開來源訊息」／「加到白板上」 | 不重寫 schema |
| 非整房 last-write-wins | `applyBoardPatches` / `reconcileNodes` / `replaceBoardGraph` / `applyRemoteRoom` | 只加 **回歸測試** |

## 本批實際做的（疊在 #116 之上）

1. 本文件：#103 handoff 改釘新檔名；保留 #116 reservation。
2. `FINAL_EVIDENCE.md`：有證據的批次；**不宣告全目標完成**。
3. `scripts/tests/whiteboard-handoff.test.ts`：整房 LWW 若被重新引入必須失敗；斷言 **0024–0028**。

## #106 不會自動更新房間堆疊

`#106`（「替代 #98」）已合進 `origin/main`。那是 **main-line** 九態語音。房間堆疊仍是 `#95 → #109 → #111 → #112 → #115`，#95 的 recorded base 仍是 `444ae9d`。**合進 main 不會自動把 #115 / #95 帶上新 tip。** Leave `#107`–`#110`  alone.

## Gaps on this tree (expected)

沒有 main `0022_discussion_*`、沒有 #95 `0023_video_optimize.sql`。**不要把那些檔複製上來。**

## Forbidden

- Reset #78 / #103 / #88 / #95 / #98
- Rewrite #78 schema files or SQL
- Copy whiteboard SQL onto `main` or the room restack
- Invent typing/presence or further migration numbers
- Merge PRs / deploy / touch production DB
