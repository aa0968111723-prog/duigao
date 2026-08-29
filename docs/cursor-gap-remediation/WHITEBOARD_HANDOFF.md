# Whiteboard migration renumber — handoff（證據，未完成）

狀態：**HANDOFF / INCOMPLETE**。全站 gap-remediation **未完成**。不要 merge、不要 deploy、不要改正式庫。

Branch: `cursor/p1-whiteboard-migration-renumber-70d9`  
**Base 必須是** `agent/wb01-canonical-schema`（#78 @ `84d3f3e`）。**不要** retarget `main`。  
**未 reset** #78 / #103。SQL 語意未改，只改檔名與引用。

核對時間：2026-08-29。來源：`git ls-tree` + GitHub PR heads（再抓，不沿用舊 SHA）。

## Reservation table（權威：各分支 `supabase/migrations/` 檔名）

| Prefix | Filename on that tree | Proven owner | Evidence |
|---|---|---|---|
| 0001–0021 | same family | shared history | on `origin/main` @ `196b3a3` |
| **0022** | `0022_discussion_author_integrity.sql` | **main** (#99) | `git ls-tree origin/main` |
| **0023** | `0023_video_optimize.sql` | **#95** / room stack | `git ls-tree origin/cursor/complete-missing-features-0897` and restack `#115` |
| 0022–0026 **old names** | `0022_whiteboard_*` … `0026_whiteboard_freehand.sql` | #78 / #103 | `origin/agent/wb01-canonical-schema` @ `84d3f3e` **and** `origin/cursor/p1-whiteboard-handoff-70d9` @ `851964f` — **collide with main 0022 and #95 0023** |
| **0024–0028 (this branch)** | `0024_whiteboard_canonical_columns.sql` … `0028_whiteboard_freehand.sql` | this renumber | next free after main **and** after #95 `0023` |
| **0027–0028 old DI** | `0027_design_knowledge.sql` / `0028_design_research_usage.sql` | **#88 / #104** | `origin/agent/design-intelligence-perplexity` @ `32e3bca` — **now collides with this branch’s 0027–0028** |
| 0029–0030 | (none yet) | **reserved for #88 after this lands** | not a guess: #88 files exist today as 0027–0028 and must move after #78 takes 0024–0028 |

`#107` body also says: 白板 #78 若稍後合入，必須從 **0024** 起編號，不可再佔 0023。

## Mapping (filename only)

| Old (#78) | New (this branch) |
|---|---|
| `0022_whiteboard_canonical_columns.sql` | `0024_whiteboard_canonical_columns.sql` |
| `0023_whiteboard_frames.sql` | `0025_whiteboard_frames.sql` |
| `0024_whiteboard_operations.sql` | `0026_whiteboard_operations.sql` |
| `0025_whiteboard_versions.sql` | `0027_whiteboard_versions.sql` |
| `0026_whiteboard_freehand.sql` | `0028_whiteboard_freehand.sql` |

`git mv` only. No SQL text change. `scripts/e2e/migrations.mjs` join() paths updated.

## Gaps on this tree (expected)

This branch still has **no** `0022_discussion_author_integrity.sql` and **no** `0023_video_optimize.sql` (those live on main / #95). `agent:gate` `checkMigrationOrder` will see a gap at 0022–0023. **Do not copy those files onto this branch.** Human rebase of #78 onto a tree that already has 0022+0023 is the fill.

## #88

Do **not** renumber #88 here. After this mapping, #88 must move `0027`/`0028` → `0029`/`0030` on its own stacked branch. Leave `resolve/pr-*` alone.

## Tests

`test:migrations` if PostgreSQL is available locally. This branch does not claim gate-contiguous until 0022+0023 exist via human rebase.

## Forbidden

- Reset #78 or #103
- Copy whiteboard SQL onto `main` or the room restack
- Change SQL semantics
- Merge PRs / deploy / touch production DB
