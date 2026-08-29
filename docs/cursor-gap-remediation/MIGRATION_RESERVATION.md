# MIGRATION_RESERVATION

Rule: do not guess the next number. Do not edit applied migrations. Do not touch the production database.
`scripts/agent-release-gate.mjs` `checkMigrationOrder` requires **contiguous** prefixes (no gaps, no duplicates).

核對時間：2026-08-29（`origin/main` @ `196b3a3`，#105 已合）。本檔只列 `git ls-tree` 證據。

## Authoritative listing this session

```
git ls-tree --name-only origin/<branch> supabase/migrations/
```

| Tree | Head | Max prefix | Last file |
|---|---|---|---|
| `origin/main` | `196b3a3672ca` | **0022** | `0022_discussion_author_integrity.sql` |
| room restack `#115` | `f620ad543caf` | **0023** | `0023_video_optimize.sql` (+ main 0022) |
| `#95` | `26ad4a65ea6b` | **0023** | `0023_video_optimize.sql` |
| `#78` | `84d3f3e67ceb` | 0026 | `0022`–`0026` **whiteboard** (collide) |
| `#103` | `851964f37716` | 0026 | same whiteboard names as #78 |
| `#88` | `32e3bca10d70` | 0028 | `0027_design_knowledge.sql`, `0028_design_research_usage.sql` |
| `#104` | `87a56596092d` | 0028 | same as #88 |
| **renumber** | `84e6808e0260` | 0028 | `0024`–`0028` **whiteboard** (renamed) |

## Claims / collisions

| # | File | Owner | Collision |
|---|---|---|---|
| 0022 | `0022_discussion_author_integrity.sql` | main | — |
| 0022 | `0022_whiteboard_canonical_columns.sql` | #78 / #103 | **YES vs main** |
| 0023 | `0023_video_optimize.sql` | #95 / restack | — |
| 0023 | `0023_whiteboard_frames.sql` | #78 / #103 | **YES vs #95** |
| 0024–0026 | whiteboard ops/versions/freehand **old names** | #78 / #103 | free on main/#95; superseded on renumber branch |
| 0024–0028 | whiteboard **new names** | `cursor/p1-whiteboard-migration-renumber-70d9` | 0027–0028 **YES vs #88** |
| 0027–0028 | DI knowledge / research | #88 / #104 | must move to **0029–0030** after whiteboard 0024–0028 |
| 0006 | `0006_video_rooms.sql` edit | #95 | applied-history edit — human must not replay as-is |

## This program

Room restack `#115` **casts no new migration**. It absorbed `#105` Home honesty via merge commit `f620ad5`.

Whiteboard renumber is a **filename-only** stack on #78. It does **not** copy SQL onto main. It does **not** fill 0022/0023 on the #78 tree (those files stay on main/#95). `agent:gate` on the renumber branch will see a 0022–0023 gap until a human rebases #78 onto a tree that already has those two files.

## Production

`productionMigrationHead` is **unknown**. Do not infer from repo head. Do not apply SQL to the live project.

## Forbidden

- Edit 0001–0022 on main
- Apply SQL to production
- Copy #78/#88 SQL onto main or the room restack
- Reset #78 / #88 / #103 / #104
- Guess a number that an open PR already lists
