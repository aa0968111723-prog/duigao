# Gap remediation — main remainders evidence

**全站目標未完成。** This branch ports leftover product fixes onto latest `origin/main`. It does not merge, deploy, or rebase #78/#88.

## Main tip (VERIFY)

- `origin/main` @ `39f3221` — docs(checkpoint) #113 #114 + production probe (#121)
- Previous: `3c0bf0c` #114, `6da2af7` #113, `85755ff` #110, `105b89b` #108, `097a6af` #107, `698595b` #106, `196b3a3` #105, `444ae9d` #99, `3d8b2cf` #97
- Migrations `0022+` on main after #114: `0022_discussion_author_integrity.sql`, `0023_video_optimize.sql`, `0024_whiteboard_canonical_columns.sql` … `0028_whiteboard_freehand.sql`, `0029_design_knowledge.sql`, `0030_design_research_usage.sql`

## This branch

- Branch: `cursor/p0-main-remainders-70d9`
- Head after this turn: merge `origin/main` #114 + GAP-07 honesty (vision / SPA research)
- Prior: `35ce691` collaboration regex, `a63e517` merge #113, `93c9d3e` leftover-channel honesty
- Base **must stay `main`**
- PR: https://github.com/aa0968111723-prog/duigao/pull/120
- Does not copy #88/#104 SQL names (`0027_design_knowledge` / `0028_design_research_usage`). Does not invent typing. Does not restack #95.

## Four remainders kept after #113 + #114 merges

1. **session-entry** — `src/cloud/sessionEntryStatus.ts`, `isPermissionDenied`, guest card `data-testid="session-entry-status"`. Invite-invalid wins over permission-denied. Cloud-guest `local-only` is load-error, not empty-room. Post-join rooms RLS sets `permissionDenied`.
2. **hideRoomChrome** — phone composer focus hides first-layer chrome; tablet ≥768 keeps split (`roomChrome.ts`, `MultiBranchRoom.tsx`).
3. **GAP-05 realtime + owner flush** — `acceptRealtimePayload` + discussion row-patch; leftover channel dropped before re-subscribe; bind subscribe failure after a snapshot does not fake load-error; `flushOutboxOnOnline` / `isolateOutboxForOwner`. Store API stays #108-scoped.
4. **V-04 Leave** — `voiceDockShowsLeave` on `live|connected|reconnecting`. Leave teardown mutes then disconnects.

## #113 file-level (shipped on main @ `6da2af7`, present after merge)

| Claim | Present? | Evidence |
|---|---|---|
| Canonical whiteboard 0024–0028 | **present** | `supabase/migrations/0024_whiteboard_canonical_columns.sql` … `0028_whiteboard_freehand.sql` |
| conversation↔node links / provenance | **present** | `src/features/collaboration/links.ts`, `src/lib/contextAnchor.ts`; stickyFromDiscussion writes `linkedEntityType:"discussion"` |
| No whole-room LWW | **present** | `src/features/collaboration/operations.ts` field-mask snapshots; `offline.ts` tombstone filter; `roomSync.ts` row-patch |
| Focus mode | **present** | `WhiteboardWorkspace.tsx` `board-focus` history layer + `onFocusChange`; collaboration e2e Focus Mode |
| Empty board honesty | **present** | `WhiteboardWorkspace.tsx` 「還沒有白板。先開一塊…」; session-entry empty-room is guest onboard, not whiteboard empty |
| Frames | **present** | `0025_whiteboard_frames.sql`; `onBoardFrameUpsert/Delete` in `roomSync.ts` |
| Presence tables / per-member online API | **missing as SQL** | No `presence` table in 0024–0030. Channel presence only: `{ at, boardId }` — **no name on the wire (P1)** |
| Named presence UI | **partial / honest** | `PresencePerson` + `onPresenceList`; names from RLS member list + `lastWriter*` stamps in `presence.ts` (`collectBoardEditors`, 30s). Count UI: `wb-presence`, `room-presence`. **Do not invent typing.** |
| Typing | **unmodeled** | No typing column / event. Do not fake. |

## #114 file-level (shipped on main @ `3c0bf0c`)

| Claim | Present? | Evidence |
|---|---|---|
| DI stack 0029–0030 | **present** | `0029_design_knowledge.sql`, `0030_design_research_usage.sql`, `src/features/design-intelligence/**`, `supabase/functions/design-research/index.ts` |
| vision-analysis capability type | **present** | `providers.ts` `CAPABILITIES` + `selectProvider` gaps |
| Poster/video must require vision | **was missing on #114 tip** | `analysis.ts` `capabilitiesFor(mode)` ignored `targetType` |
| SPA research honesty | **was missing on #114 tip** | `research.ts` treated HTTP 200 + object as success; no `honesty.ts` |
| GAP-07 honesty.ts | **added on this branch** | `src/features/design-intelligence/honesty.ts` reuses `#97` `apiResponse.looksLikeSpaHtml` |
| Old #88/#119 drafts | **not this tree** | `#88` / `#104` / `#119` still exist as drafts; do not copy their SQL |

## GAP-07 honesty added on #120 (unowned DI files after #114)

| File | Change |
|---|---|
| `src/features/design-intelligence/honesty.ts` | **new** — vision needs, SPA / `{ok:true}` 缺欄 reject; wraps shared `looksLikeSpaHtml` |
| `src/features/design-intelligence/analysis.ts` | `needsForAnalysis(mode, targetType)`; `gapRiskLines` → `proposal.risks` |
| `src/features/design-intelligence/research.ts` | `acceptResearchSuccessBody` before treating 200 as success |
| `scripts/tests/ai-external-handoff.test.ts` | G7-01…G7-08; asserts 0029–0030 names, forbids old #88 0027/0028 DI names |
| `package.json` | `test:ai-external-handoff`; file also in `test:collaboration` + `test:design-intelligence` |

Did **not** copy #88 schema. Did **not** add 0031+.

## #120 CI @ `35ce691` (pre-#114 merge)

| Workflow | Run | Result |
|---|---|---|
| `agent-release-gate` | `33262145327` | **success** |
| `build` (migrations + build + browser) | `33262145267` | **success** (browser included `test:collaboration`  after regex fix) |

Post-#114 merge + honesty head is later; CI for that SHA is a new run.

## Review classifications

### Fixed on this branch (accepted)

| Finding | Classification | Evidence |
|---|---|---|
| Invite-invalid vs permission-denied leak | Fixed | `sessionEntryStatus` checks inviteInvalid first |
| Cloud-guest `local-only` as empty-room | Fixed | `local-only` → load-error |
| Bind flush cross-account outbox | Fixed | `isolateOutboxForOwner` on reconcile flush |
| Leave/mic still live after Leave | Fixed | `teardown` mutes then disconnects |
| Post-join rooms RLS swallowed as retry | Fixed | `reload()` sets `permissionDenied` and rethrows |
| Re-bind leftover realtime channel fakes load-error | Fixed | `subscribeRoom` removes leftovers; subscribe throw after snapshot stays synced |
| SPA HTML as applied realtime | Accepted / already gated | `looksLikeSpaHtml` in `acceptRealtimePayload` |
| Poster/video fake vision + research SPA 200 | Fixed on this branch | `honesty.ts` + analysis/research wiring |

### Accepted, no further change on this PR

- V-07 mute-before-refresh already on main via #106
- #108 scoped IndexedDB outbox
- #110 more-sheet + tablet split; remainders only add hideRoomChrome
- #113 frames / channel presence / whiteboard 0024–0028 via merge (not a #78 port)
- #114 DI stack via merge (not a #88 port)

### Won’t fix / leftover (not this PR)

- Production SPA catch-all still HTML 200 (deploy #107 Caddyfile)
- No `test:realtime-offline-e2e` script; two-client coverage is collaboration e2e
- Typing / per-member presence **table** unmodeled (channel count + lastWriter stamps only; do not invent)
- Canva / CUTOS / Perplexity production secrets unverified
- Stale room stack `#95→#115` vs main
- #88 / #104 / #119 drafts still CONFLICTING / human rebase
- Competing old drafts

## E2E (after #113 merge @ `a63e517`; re-run after #114+honesty)

`CHROMIUM_PATH=/usr/bin/google-chrome-stable`

| Suite | Result @ `a63e517` | After #114+honesty |
|---|---|---|
| `test:mobile-tablet-ux-e2e` | **30/30** | **30/30** (`remainders-e2e-after-114.log`) |
| `test:collaboration-e2e` | **117/117** | **117/117** |
| `test:multi-branch-e2e` | **54/54** | **54/54** |
| `test:realtime-offline-e2e` | **script missing** | still missing |
| `test:ai-external-handoff` | n/a | **8/8** (`gap07-honesty-unit.log`) |
| `test:collaboration` | 233 @ regex fix | **241/241** (includes G7-01…08) |
| `npm run agent:gate` | **PASS** through `0028` | **PASS** through `0030_design_research_usage.sql` |

## Session-entry screenshots (no PII)

Honest mock-supabase + production bundle via `scripts/e2e/session-entry-shots.mjs`.

| Kind | 390 | 768 |
|---|---|---|
| empty-room 「這個房間還沒有文宣或影片」／「不是載入失敗」 | `session_entry_empty_room_390_honest.png` | `session_entry_empty_room_768_honest.png` |
| permission-denied 「沒有權限進入這個房間」 (not invalid invite) | `session_entry_permission_denied_390_honest.png` | `session_entry_permission_denied_768_honest.png` |

Earlier `session_entry_*_{390,768}.png` without `_honest` raced a leftover-channel fake load-error; do not use those as empty-room proof.

## Production (re-curl this turn)

Re-curled 2026-08-29 16:14 UTC (`/opt/cursor/artifacts/production-curl-2026-08-29.txt`):

`https://duigao-k7q2.zeabur.app/functions/v1/voice-token` and `/rest/v1/` → HTTP **200**, `content-type: text/html; charset=utf-8`, body starts `<!doctype html>`. Last-Modified `Sat, 29 Aug 2026 16:09:14 GMT`. #107 Caddyfile on main ≠ production deployed. **Do not claim production is fixed.**
