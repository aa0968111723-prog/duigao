# PR_DEPENDENCIES

Live 2026-08-29. Re-check GitHub before starting any later batch.

## Open product PRs

```
#95  cursor/complete-missing-features-0897     base main@398960d  MERGEABLE clean  CI green
#88  agent/design-intelligence-perplexity      base main@b0f7a1b  dirty
#78  agent/wb01-canonical-schema               base main@361bec0  dirty
```

## This program

| ID | Branch | Depends on | Conflict | Action |
|---|---|---|---|---|
| PR-GAP-00 | `cursor/gap-remediation-audit-70d9` | current main | none on owned cores | **ship this PR** (docs + parser + tests + voice copy) |
| PR-GAP-01 | `cursor/p0-production-stability-70d9` or `cursor/p0-mobile-room-entry-70d9` | main after GAP-00 *or* latest main | avoid App / MultiBranchRoom / useCloudRoom | session / empty / error states **only on unowned files** |
| PR-GAP-02 | files + discussion | **#95** | RoomDiscussion, outbox, App | **PAUSE** |
| PR-GAP-03 | voice truthful state | GAP-00 parser | RoomDiscussion (#95) for dock UI | hook + edge only; copy already started here |
| PR-GAP-04 | mobile / tablet | MultiBranchRoom (#78) | first-layer IA | CSS + Home if possible; pause shell rewrite |
| PR-GAP-05 | realtime / offline | #78 `roomSync` + #95 `useCloudRoom` | both | **PAUSE** |
| PR-GAP-06 | whiteboard | **#78 merged** | 0022–0026 vs main 0022 | **PAUSE** — do not stack unless human asks |
| PR-GAP-07 | AI / Canva backend | **#88** + Canva edge secrets | 0027–0028 | **PAUSE** |

## Suggested human merge order (migrations)

```
1. #94 already on main (0022_discussion_author_integrity)
2. Human rebase #78: rename 0022–0026 → 0023–0027 (or current head+1)
3. Human rebase #88: its 0027–0028 after #78's new head
4. Human rebase #95: 0023_video_optimize must move after whatever #78 takes
5. Then GAP PRs that were paused
```

**Do not auto-merge. Do not apply migrations to production from this agent.**

## Stacking rule

If a batch needs an unmerged PR: write a handoff and stop that batch. Do not copy the other PR's code onto main.
