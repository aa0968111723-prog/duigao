# Gap remediation — main remainders evidence

**全站目標未完成。** This branch ports leftover product fixes onto latest `origin/main`. It does not merge, deploy, or rebase #78/#88.

## Main tip (VERIFY)

- `origin/main` @ `de4064b` — fix(host): Node origin so `/functions` `/api` `/rest` return JSON 404 (#122)
- Previous: `39f3221` #121 docs, `3c0bf0c` #114, `6da2af7` #113, `85755ff` #110, `105b89b` #108, `097a6af` #107, `698595b` #106, `196b3a3` #105, `444ae9d` #99, `3d8b2cf` #97
- Migrations `0022+` on main after #114: `0022_discussion_author_integrity.sql`, `0023_video_optimize.sql`, `0024_whiteboard_canonical_columns.sql` … `0028_whiteboard_freehand.sql`, `0029_design_knowledge.sql`, `0030_design_research_usage.sql`
- #122 is **host origin JSON 404 in repo**. Production Zeabur was **not** redeployed this turn.

## This branch

- Branch: `cursor/p0-main-remainders-70d9`
- Head after this turn: `43a5b41` Compact toolbar follows window width, not the canvas wrap
- Merge: `b91e655` merged `origin/main` #122 (merge commit, no rebase)
- Prior extras: `53aac03` board anchors + fail-closed apply + `test:realtime-offline-e2e` script
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
| Image-region marks on board | **wired** | Existing `comments.region` + `node.anchor` (`image-region`). Sheet `wb-poster-region`. No new table. |
| Video timestamp anchors | **already present** | `wb-video-range` + `content.startTime` — not rewritten |
| Planning-paragraph links | **wired** | `plan-section` on `node.anchor`; `wb-plan-section` uses `plan.blocks` ids. `blocksOmitted` stays honest. |
| Compact toolbar &lt;768 | **wired** | `data-compact` on `wb-focus-bottom` from **window.innerWidth** (not canvas wrap). Split View wrap &lt;768 on a 1024 tablet still shows labels. |

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

## This turn — typed extras + fail-closed + e2e script

| Item | Verdict | Evidence |
|---|---|---|
| Image-region / plan-section | **wired** | `src/features/collaboration/boardAnchors.ts`; sheets in `WhiteboardWorkspace.tsx`; e2e clicks `wb-poster-whole` / `wb-plan-whole` |
| Video timestamps | **refused rewrite** | already on #113 (`wb-video-0040`) |
| Empty board / focus / LWW | **untouched** | |
| Compact toolbar | **wired** | window width &lt;768; 390 icon-only, 768 labels, 1024 tablet not compact |
| Canva/CUTOS/planform apply | **fail-closed** | `applyGate` blocks those adapters unless `adapterStatus.state === "ready"`; room import already `#97` + 「整合尚未設定」 |
| Canva/CUTOS room import | **already honest** | health gate hides entry; codes `CANVA_NOT_CONFIGURED` / `CUTOS_NOT_CONFIGURED` |
| `test:realtime-offline-e2e` | **run 5/5** | two Playwright contexts (390+768); B joins via captured `create_room_with_invite` fragment; flush exactly one row, no duplicate replay |
| Typing / presence table | **unmodeled** | left listed |
| 0031+ | **refused** | |
| #122 production deploy | **refused** | repo has origin JSON 404; live Zeabur still SPA HTML 200 |

## #120 CI

| SHA | What | agent-read-layer | browser | note |
|---|---|---|---|---|
| `8139879` honesty + #121 | requested first check | **success** (`33262546628`) | **success** (`33262546722`) | gate + migrations + build green |
| `53aac03` extras (no e2e sheet clicks) | browser **failed** `33262930728` | success | fail | poster-region sheet intercepted `whiteboard-add` |
| `dd8f0b4`…`90bf072` e2e join fixes | browser **failed** (superseded) | success | fail | empty-room ShareSheet hides `m-share-url`; invite now captured from create RPC |
| `43a5b41` current head | `33263240901` | (gate `33263240911` **success**) | **in progress** at evidence write | local browser suites green |

`35ce691` earlier: gate `33262145327` + build `33262145267` **success**. Intermediate `ebb00ae` `33262538059` flake 52/54 superseded.

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

- Production SPA catch-all still HTML 200 (re-curl 16:27 UTC Last-Modified `Sat, 29 Aug 2026 16:15:36 GMT`). #122 is on main, **not claimed deployed**.
- Typing / per-member presence **table** unmodeled (channel count + lastWriter stamps only; do not invent)
- Canva / CUTOS / Perplexity production secrets unverified
- Stale room stack `#95→#115` vs main
- #88 / #104 / #119 drafts still CONFLICTING / human rebase
- Competing old drafts
- Current head CI browser not yet terminal at evidence write

## E2E (local this turn @ `43a5b41`)

`CHROMIUM_PATH=/usr/bin/google-chrome-stable`

| Suite | Result |
|---|---|
| `test:mobile-tablet-ux-e2e` | **30/30** |
| `test:collaboration-e2e` | **122/122** (was 117; +poster/plan sheets + compact 390/768) |
| `test:realtime-offline-e2e` | **5/5** |
| `test:ai-external-handoff` | **8/8** |
| `test:collaboration` | **245/245** |
| `test:design-intelligence` | **182/182** |
| `test:api-response` | **24/24** (includes #122 origin JSON 404) |
| `npm run agent:gate` | **PASS** through `0030_design_research_usage.sql` |

390/768 shots: `wb_poster_region_390.png`, `wb_plan_section_390.png`, `wb_compact_toolbar_390.png`, `wb_toolbar_768.png`.

## Session-entry screenshots (no PII)

Honest mock-supabase + production bundle via `scripts/e2e/session-entry-shots.mjs`.

| Kind | 390 | 768 |
|---|---|---|
| empty-room 「這個房間還沒有文宣或影片」／「不是載入失敗」 | `session_entry_empty_room_390_honest.png` | `session_entry_empty_room_768_honest.png` |
| permission-denied 「沒有權限進入這個房間」 (not invalid invite) | `session_entry_permission_denied_390_honest.png` | `session_entry_permission_denied_768_honest.png` |

Earlier `session_entry_*_{390,768}.png` without `_honest` raced a leftover-channel fake load-error; do not use those as empty-room proof.

## Production (re-curl this turn)

Re-curled 2026-08-29 16:27 UTC (`/opt/cursor/artifacts/production-curl-2026-08-29-1627.txt`):

`https://duigao-k7q2.zeabur.app/functions/v1/voice-token`, `/rest/v1/`, `/api/health` → HTTP **200**, `content-type: text/html; charset=utf-8`, body starts `<!doctype html>`. Last-Modified still `Sat, 29 Aug 2026 16:15:36 GMT`. #122 origin JSON 404 is on `main` (`de4064b`) and merged into this PR; **live Zeabur is unchanged**. **Do not claim production is fixed. Do not claim deploy.**
