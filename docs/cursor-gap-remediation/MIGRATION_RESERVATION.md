# MIGRATION_RESERVATION

Rule: do not guess the next number. Do not edit applied migrations. Do not touch the production database.  
`scripts/agent-release-gate.mjs` `checkMigrationOrder` requires **contiguous** prefixes (no gaps, no duplicates).

## Authoritative listing this session

```
git ls-tree --name-only origin/main supabase/migrations/
```

main (`398960d`) files:

| # | File | Status |
|---|---|---|
| 0001–0021 | … through `0021_canva_design_pages.sql` | applied history in repo |
| **0022** | `0022_discussion_author_integrity.sql` | **on main via #94** |

Open-PR claims (not on main):

| # | File | PR | Branch | Collision |
|---|---|---|---|---|
| 0022 | `0022_whiteboard_canonical_columns.sql` | #78 | `agent/wb01-canonical-schema` | **YES — main already used 0022** |
| 0023 | `0023_whiteboard_frames.sql` | #78 | same | will collide with #95 |
| 0024 | `0024_whiteboard_operations.sql` | #78 | same | — |
| 0025 | `0025_whiteboard_versions.sql` | #78 | same | — |
| 0026 | `0026_whiteboard_freehand.sql` | #78 | same | — |
| 0023 | `0023_video_optimize.sql` | #95 | `cursor/complete-missing-features-0897` | **YES — same number as #78 0023** |
| 0006 | `0006_video_rooms.sql` (edit) | #95 | same | **edits an already-applied migration** — human must not apply as-is if 0006 already ran in production |
| 0027 | `0027_design_knowledge.sql` | #88 | `agent/design-intelligence-perplexity` | reserved by DI; #88 body said “main at 0021, #78 takes 0022–0026” — **stale vs current main** |
| 0028 | `0028_design_research_usage.sql` | #88 | same | — |

## This program

**PR-GAP-00 casts no migration.**  
If a later batch needs a table: stop, update this file, take `max(main)+1` only after the colliding PRs rebase. If that number is already claimed by an open PR, **do not ship a migration** — UI / adapter / tests / handoff only.

## Production

`productionMigrationHead` is **unknown**. No Zeabur/Supabase dashboard access this session. Do not infer from repo head.

`supabase` CLI is **not installed** in this cloud environment (`command not found`). Install is a human/setup action; not done here.

## Forbidden

- Edit 0001–0022 on main
- Apply SQL to `uanurolzzgshxrqbooix` or any live project
- Leave a gap to “reserve” 0029 while 0023 is empty — gate will fail
- Copy #78/#88/#95 migration files onto a gap branch
