# Gap remediation — main remainders evidence

**全站目標未完成。** This branch ports leftover product fixes onto latest `origin/main`. It does not merge, deploy, or rebase #78/#88.

## Main tip (VERIFY)

- `origin/main` @ `6da2af7` — PR-RESOLVE-06 canonical whiteboard (replaces #78) (#113)
- Previous: `85755ff` #110, `105b89b` #108, `097a6af` #107, `698595b` #106, `196b3a3` #105, `444ae9d` #99, `3d8b2cf` #97
- Migrations `0022+` on main after #113: `0022_discussion_author_integrity.sql`, `0023_video_optimize.sql`, `0024_whiteboard_canonical_columns.sql` … `0028_whiteboard_freehand.sql`

## This branch

- Branch: `cursor/p0-main-remainders-70d9`
- Head: `a63e517` (merge of `origin/main` #113 + remainders)
- Prior remainder commits: `93c9d3e` leftover-channel honesty, `a240dd0` session-entry shots, `3bacb81` post-join RLS, `cb8f7cc` invite/local-only/outbox/mute
- Base **must stay `main`**
- PR: https://github.com/aa0968111723-prog/duigao/pull/120
- Does not copy #78/#88 old SQL names. Does not invent typing/presence. Does not restack #95.

## Four remainders kept after #113 merge

1. **session-entry** — `src/cloud/sessionEntryStatus.ts`, `isPermissionDenied`, guest card `data-testid="session-entry-status"`. Invite-invalid wins over permission-denied. Cloud-guest `local-only` is load-error, not empty-room. Post-join rooms RLS sets `permissionDenied`.
2. **hideRoomChrome** — phone composer focus hides first-layer chrome; tablet ≥768 keeps split (`roomChrome.ts`, `MultiBranchRoom.tsx`).
3. **GAP-05 realtime + owner flush** — `acceptRealtimePayload` + discussion row-patch; leftover channel dropped before re-subscribe; bind subscribe failure after a snapshot does not fake load-error; `flushOutboxOnOnline` / `isolateOutboxForOwner`. Store API stays #108-scoped.
4. **V-04 Leave** — `voiceDockShowsLeave` on `live|connected|reconnecting`. Leave teardown mutes then disconnects.

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

### Accepted, no further change on this PR

- V-07 mute-before-refresh already on main via #106
- #108 scoped IndexedDB outbox
- #110 more-sheet + tablet split; remainders only add hideRoomChrome
- #113 frames/presence/whiteboard 0024–0028 now on this branch via merge commit (not a #78 port)

### Won’t fix / leftover (not this PR)

- Production SPA catch-all still HTML 200 (deploy #107 Caddyfile)
- No `test:realtime-offline-e2e` script; two-client coverage is collaboration e2e
- Typing / per-member presence unmodeled (do not invent)
- Canva / CUTOS / Perplexity production secrets unverified
- Stale room stack `#95→#115` vs main
- #88 DI still CONFLICTING / human rebase
- Competing old drafts

## E2E (after #113 merge @ `a63e517`)

`CHROMIUM_PATH=/usr/bin/google-chrome-stable`

| Suite | Result | Log |
|---|---|---|
| `test:mobile-tablet-ux-e2e` | **30/30** | `/opt/cursor/artifacts/remainders-e2e-gate-after-113.log` |
| `test:collaboration-e2e` | **117/117** (includes two-client “B 不重開就看到 A”) | same |
| `test:multi-branch-e2e` | **54/54** | same |
| `test:realtime-offline-e2e` | **script missing** | — |
| `npm run agent:gate` | **PASS** (migrations contiguous through `0028_whiteboard_freehand.sql`) | same |

Pre-#113 merge on `93c9d3e`: mobile 30, collaboration 46, multi-branch 54, gate PASS through `0023`.

## Session-entry screenshots (no PII)

Honest mock-supabase + production bundle via `scripts/e2e/session-entry-shots.mjs`.

| Kind | 390 | 768 |
|---|---|---|
| empty-room 「這個房間還沒有文宣或影片」／「不是載入失敗」 | `session_entry_empty_room_390_honest.png` | `session_entry_empty_room_768_honest.png` |
| permission-denied 「沒有權限進入這個房間」 (not invalid invite) | `session_entry_permission_denied_390_honest.png` | `session_entry_permission_denied_768_honest.png` |

Earlier `session_entry_*_{390,768}.png` without `_honest` raced a leftover-channel fake load-error; do not use those as empty-room proof.

## Production (re-curled 2026-08-29 16:03 UTC)

`https://duigao-k7q2.zeabur.app/functions/v1/voice-token` → HTTP 200, `content-type: text/html`, `<!doctype html>`. Same for `/rest/v1/`. Last-Modified `Sat, 29 Aug 2026 15:35:57 GMT`. #107 Caddyfile on main ≠ production deployed. **Do not claim production is fixed.**
