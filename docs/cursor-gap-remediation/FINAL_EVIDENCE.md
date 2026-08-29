# Gap remediation — main remainders evidence

**全站目標未完成。** This branch ports leftover product fixes onto latest `origin/main`. It does not merge, deploy, or rebase #78/#88.

## Main tip (VERIFY)

- `origin/main` @ `cd7eb5f` — docs(checkpoint): production JSON 404 after origin server (#123)
- Previous: `de4064b` #122 host JSON 404, `39f3221` #121 docs, `3c0bf0c` #114, `6da2af7` #113, `85755ff` #110, `105b89b` #108, `097a6af` #107
- Migrations `0022+` on main after #114: `0022_discussion_author_integrity.sql`, `0023_video_optimize.sql`, `0024_whiteboard_canonical_columns.sql` … `0028_whiteboard_freehand.sql`, `0029_design_knowledge.sql`, `0030_design_research_usage.sql`
- #122/#123 record **host origin JSON 404 in repo / checkpoint**. This PR does **not** deploy Zeabur.

## This branch

- Branch: `cursor/p0-main-remainders-70d9`
- Code head: `1416120` compact extras + visual baselines (on merge `1a99253` of #123, extras `8f91286`)
- Evidence commit follows this file; do not treat docs as IMPLEMENTED without the source above
- This turn compact-discloses the decision draft and refreshes 1024/1280 visual baselines (cite button in Split View)
- Base **must stay `main`**
- PR: https://github.com/aa0968111723-prog/duigao/pull/120
- Does not copy #88/#104 SQL names. Does not invent typing / mention / unread / receipt / todo tables. Does not restack #95.

## Four remainders kept after #113 + #114 merges

1. **session-entry** — `src/cloud/sessionEntryStatus.ts`, `isPermissionDenied`, guest card `data-testid="session-entry-status"`. Invite-invalid wins over permission-denied. Cloud-guest `local-only` is load-error, not empty-room. Post-join rooms RLS sets `permissionDenied`.
2. **hideRoomChrome** — phone composer focus hides first-layer chrome; tablet ≥768 keeps split (`roomChrome.ts`, `MultiBranchRoom.tsx`).
3. **GAP-05 realtime + owner flush** — `acceptRealtimePayload` + discussion row-patch; leftover channel dropped before re-subscribe; bind subscribe failure after a snapshot does not fake load-error; `flushOutboxOnOnline` / `isolateOutboxForOwner`. Store API stays #108-scoped.
4. **V-04 Leave** — `voiceDockShowsLeave` on `live|connected|reconnecting`. Leave teardown mutes then disconnects.

## Discussion extras vs schema (0014 / 0018 / 0022)

Inspected current tree after #107/#108/#113/#114. Do **not** invent tables. Do **not** show 已讀／雙藍勾.

| Feature | Verdict | Evidence |
|---|---|---|
| reply | **present** | `reply_to_id` 0014; `replies.ts` resolve + jump; composer reply bar |
| mention `@` | **unmodeled** | no mentions table / column |
| reactions | **present as 支持 only** | `room_discussion_supports` binary; not six-emoji (would need a new table) |
| composer draft | **present** | `useDiscussionDraft` + IndexedDB `DISCUSSION_DRAFTS` |
| unread + first unread | **unmodeled** | no read/unread table; `jump-latest` is scroll, not unread |
| message edit | **wired** | 0022 allows body+payload update; `updateDiscussion`; UI `discussion-edit` + `payload.edited` |
| message tombstone | **unmodeled** | no `deleted_at` on `room_discussion_messages`; do not hard-delete as a fake tombstone |
| attachment cite | **wired** | existing `attachment` kind; cite sets `reply_to_id` via `attachmentCiteReply` |
| work cite | **wired** | existing kinds `poster`/`video`/`plan`/`whiteboard` + payload ids; composer `引` → `cite-work` |
| decision draft | **wired** | `decision_records` pending/decided; first layer is 新增, input is progressive disclosure; AI/`agent`/`system` cannot finalize (`isMemberActor`; `normalizeAiActions` drops create/finalize) |
| todo draft | **unmodeled** | no todo/task table |
| read receipts | **unmodeled** | no receipt table; UI must not show 已讀／雙藍勾 |
| `kind: quote` | **unmodeled as producer** | CHECK allows it; zero honest producers — do not fake a cite type |
| polls | **present** | `room_polls` + 「建立投票」; not a todo |

## This turn — CI fix + compact extras

`8f91286` browser **failed** `33263703226` on `test:visual`: tablet-1024-board-20 / desktop-1280-board-20 / desktop-1280-selected (~15k px). Cause: Split View discussion column showed a always-on decision title input + 「引用」 wrapping the composer.

| Change | Why |
|---|---|
| Decision draft behind `decision-draft-open` | First layer stays 「新增」(same as pre-extras). Click reveals title input. No hardcoded 「待決定：主視覺」 |
| Composer cite label `引` | 44×44 like attach; does not wrap the Split View composer |
| Visual baselines | Refresh the three Split View shots that now include `引` |
| Honesty extras kept | edit / work cite / attachment cite / member-only decision |

## #120 CI

| SHA | agent-read-layer | browser | note |
|---|---|---|---|
| `8139879` honesty + #121 | **success** | **success** `33262546722` | requested first check |
| `43a5b41` compact-width | **success** | **success** `33263240901` | 15/15 visual |
| `5399833` evidence | **success** | **success** `33263357191` | 15/15 visual |
| `0570218` extras | **success** | **failed** `33263623652` | visual Split View |
| `8f91286` edit mark | **success** | **failed** `33263703226` | same visual; `test:visual` 11/15. **Fixed this turn from these logs.** |
| post-#123 merge + compact | (this push) | (pending) | do not claim green until terminal |

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
| Discussion edit / work cite / decision title | Wired | `discussionHonesty.ts` + RoomDiscussion |

### Won’t fix / leftover (not this PR)

- Mentions / unread / first-unread / read receipts / discussion tombstone / todo — **unmodeled**
- Typing / per-member presence **table** unmodeled (channel count + lastWriter stamps only)
- `kind: quote` has no producer
- Whiteboard 「寫下決策」 still uses a canned title (`已決定：採用 B 版`) — board node helper, not a new table
- Canva / CUTOS / Perplexity production secrets unverified
- Stale room stack `#95→#115` vs main
- #88 / #104 / #119 drafts still CONFLICTING / human rebase
- Production origin JSON 404 is a **probe**, not “functions work”
- This push’s CI browser not yet terminal at evidence write

## E2E (local this turn)

`CHROMIUM_PATH=/usr/bin/google-chrome-stable`

| Suite | Result |
|---|---|
| `test:visual` | **15/15** after baseline refresh (was 11/15 on `8f91286` CI) |
| `discussion-honesty` | **7/7** D-01…D-07 |
| `test:collaboration-e2e` | **126/126** (edit / 已編輯 / decision title / work cite) |
| `test:collaboration` | **252/252** |

390/768 discussion shots: `discussion_edit_390.png`, `discussion_cite_work_390.png`, `discussion_cite_768.png` (from collaboration e2e this turn).

## Production (re-curl this turn)

Re-curled 2026-08-29 16:47 UTC (`/opt/cursor/artifacts/production-curl-2026-08-29-1650.txt`):

| Path | HTTP | Type | Body |
|---|---|---|---|
| `/functions/v1/voice-token` | **404** | `application/json` | `{"ok":false,"code":"NOT_FOUND","message":"this origin has no API"}` |
| `/rest/v1/` | **404** | `application/json` | same |
| `/api/health` | **404** | `application/json` | same |
| `/` | **200** | `text/html` | `<!doctype html>` SPA |

This matches #122 origin JSON 404. **Do not claim production is fixed. Do not claim deploy.** Origin 404 ≠ LiveKit / Canva / CUTOS / research actually running.
