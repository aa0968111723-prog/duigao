# MIGRATION_RESERVATION

Rule: do not guess the next number. Do not edit applied migrations. Do not touch the production database.
`scripts/agent-release-gate.mjs` `checkMigrationOrder` requires **contiguous** prefixes (no gaps, no duplicates).

核對時間：2026-08-29（`origin/main` @ `698595b`，#105+#106 已合）。本檔只列 `git ls-tree` 證據。

## Authoritative listing this session

```
git ls-tree --name-only origin/<branch> supabase/migrations/
```

| Tree | Head | Max prefix | Last file |
|---|---|---|---|
| `origin/main` | `698595bb5c10` | **0022** | `0022_discussion_author_integrity.sql` |
| room restack `#115` | `c433535f4b32` | **0023** | `0023_video_optimize.sql` (+ main 0022) |
| `#95` | `26ad4a65ea6b` | **0023** | `0023_video_optimize.sql` |
| `#78` | `84d3f3e67ceb` | 0026 | `0022`–`0026` **whiteboard** (collide) |
| `#103` | `851964f37716` | 0026 | same old whiteboard names as #78 |
| `#116` | `84e6808e0260` | 0028 | `0024`–`0028` **whiteboard** (renamed) |
| handoff restack | `0b27d138b500` | 0028 | same **new** whiteboard names as #116 |
| `#88` | `32e3bca10d70` | 0028 | `0027_design_knowledge.sql`, `0028_design_research_usage.sql` |
| `#104` | `87a56596092d` | 0028 | same old DI names as #88 |
| **DI renumber** | `5cdfe490ff80` | **0030** | `0029_design_knowledge.sql`, `0030_design_research_usage.sql` |

## Claims / collisions

| # | File | Owner | Collision |
|---|---|---|---|
| 0022 | `0022_discussion_author_integrity.sql` | main | — |
| 0022 | `0022_whiteboard_canonical_columns.sql` | #78 / #103 | **YES vs main** |
| 0023 | `0023_video_optimize.sql` | #95 / restack | — |
| 0023 | `0023_whiteboard_frames.sql` | #78 / #103 | **YES vs #95** |
| 0024–0026 | whiteboard ops/versions/freehand **old names** | #78 / #103 | free on main/#95; superseded on #116 |
| 0024–0028 | whiteboard **new names** | #116 + handoff restack | 0027–0028 **YES vs #88/#104 old DI names** |
| 0027–0028 | DI knowledge / research **old names** | #88 / #104 | still on those heads — **do not reset** |
| 0029–0030 | DI knowledge / research **new names** | `cursor/p2-di-migration-renumber-70d9` | reserved; **do not invent 0031+** |
| 0006 | `0006_video_rooms.sql` edit | #95 | applied-history edit — human must not replay as-is |

## This program

Room restack `#115` **casts no new migration**. `#106` on main does **not** update this stack.

Whiteboard renumber (#116) is filename-only on #78. Handoff restack ports #103 tests onto those new names. DI renumber is filename-only on #88. None of these copy SQL onto main. `agent:gate` on #78/#116/#88 trees will see gaps until a human rebases onto a tree that already has the missing prefixes.

## Production

`productionMigrationHead` is **unknown**. Do not infer from repo head. Do not apply SQL to the live project.

## Forbidden

- Edit 0001–0022 on main
- Apply SQL to production
- Copy #78/#88 SQL onto main or the room restack
- Reset #78 / #88 / #95 / #98 / #103 / #104
- Guess a number that an open PR already lists
- Invent 0031+
