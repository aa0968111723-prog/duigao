# Design Intelligence migration renumber — handoff（證據，未完成）

狀態：**HANDOFF / INCOMPLETE**。全站 gap-remediation **未完成**。不要 merge、不要 deploy、不要改正式庫。

Branch: `cursor/p2-di-migration-renumber-70d9`  
**Base 必須是** `agent/design-intelligence-perplexity`（#88 @ `32e3bca`）。**不要** retarget `main`。  
**未 reset** #88 / #104。SQL 語意未改，只改檔名與引用。

核對時間：2026-08-29。來源：`git ls-tree` + GitHub PR heads（再抓，不沿用舊 SHA）。

## Why 0029–0030

#116 already reserved **0024–0028** for #78 whiteboard (new names). #88 still claimed **0027–0028** on its own tree. Those prefixes now collide with #116’s `0027_whiteboard_versions.sql` / `0028_whiteboard_freehand.sql`. This branch only moves the DI files to the next free pair.

Do **not** invent 0031+.

## Reservation table（權威：各分支 `supabase/migrations/` 檔名）

| Prefix | Filename on that tree | Proven owner | Evidence |
|---|---|---|---|
| **0022** | `0022_discussion_author_integrity.sql` | **main** (#99) | `git ls-tree origin/main` |
| **0023** | `0023_video_optimize.sql` | **#95** / room stack | `git ls-tree origin/cursor/complete-missing-features-0897` |
| **0024–0028** | `0024_whiteboard_*` … `0028_whiteboard_freehand.sql` | **#116** | `origin/cursor/p1-whiteboard-migration-renumber-70d9` @ `84e6808` |
| 0022–0026 **old whiteboard** | `0022_whiteboard_*` … `0026_whiteboard_freehand.sql` | #78 / #103 | still on those heads — **do not reset** |
| 0027–0028 **old DI** | `0027_design_knowledge.sql` / `0028_design_research_usage.sql` | #88 / #104 | still on those heads — **do not reset** |
| **0029–0030 (this branch)** | `0029_design_knowledge.sql` / `0030_design_research_usage.sql` | this renumber | reserved after #116 takes 0024–0028 |

## Mapping (filename only)

| Old (#88) | New (this branch) |
|---|---|
| `0027_design_knowledge.sql` | `0029_design_knowledge.sql` |
| `0028_design_research_usage.sql` | `0030_design_research_usage.sql` |

`git mv` only. No SQL text change. Blob hashes match #88. `scripts/e2e/migrations.mjs` join() paths updated.

## Gaps on this tree (expected)

This branch still has **no** main `0022_discussion_author_integrity.sql`, **no** #95 `0023_video_optimize.sql`, and **no** #116 `0024`–`0028` whiteboard files. `checkMigrationOrder` will see a 0022–0028 gap. **Do not copy those files onto this branch.** Human rebase of #88 onto a tree that already has 0022–0028 is the fill.

## Forbidden

- Reset #88 or #104
- Copy #78 / #95 / main SQL onto this tree
- Change SQL semantics
- Guess further numbers (0031+)
- Merge PRs / deploy / touch production DB
