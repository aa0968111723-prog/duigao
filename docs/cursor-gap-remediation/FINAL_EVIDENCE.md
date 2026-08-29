# Gap remediation — main remainders evidence

**全站目標未完成。** This branch ports leftover product fixes onto latest `origin/main`. It does not merge, deploy, or rebase #78/#88.

## Main tip (VERIFY)

- `origin/main` @ `105b89b` — PR-RESOLVE-04 files/outbox (#108)
- Previous: `097a6af` #107, `698595b` #106, `196b3a3` #105, `444ae9d` #99, `3d8b2cf` #97
- Migrations `0022+` on main: `0022_discussion_author_integrity.sql`, `0023_video_optimize.sql`

## Present / missing on that tip (before this branch)

| Fix | On main? | Evidence |
|---|---|---|
| Home honesty (#105) | Present | `src/components/homeEntryStatus.ts` |
| SPA parser / HTML reject (#97) | Present | `src/cloud/apiResponse.ts` wired in canva/cutos/voiceToken |
| Caddyfile / spa routing (#107) | Present on main only | `Caddyfile`, `spaFallback.ts`. Production still HTML 200 |
| Nine-state voice + V-07 (#106) | Present | `useVoiceRoom` mute+disconnect before `reconnecting` |
| Files/outbox isolation (#108) | Present | scoped `loadOutboxEntries(ownerId)`, `discussionWrite.ts` |
| V-04 Leave on reconnecting | Missing | `RoomDiscussion` was `voice.state === "live"` only |
| session-entry empty/auth-loading/permission-denied | Missing | guest card still「正在載入…」 |
| hideRoomChrome + more-sheet + tablet split | Partial / missing | #108 hid some chrome; chips still first-layer `hidden={hideRoomChrome}` |
| applyDiscussionRealtime + acceptRealtimePayload | Missing | `room_discussion_messages` still `*` → `onProjectChange` |
| flushOutboxOnOnline owner filter | Missing | #108 online flush replayed every failed row |

## This branch

- Branch: `cursor/p0-main-remainders-70d9`
- Base **must stay `main`**
- Does not copy #78/#88 SQL. Does not invent 0031+. Does not restack #95.

## Production (re-curled)

`https://duigao-k7q2.zeabur.app/functions/v1/voice-token` → HTTP 200, `content-type: text/html`, `<!doctype html>`. Same for `/rest/v1/`. Last-Modified `Sat, 29 Aug 2026 15:29:22 GMT`. #107 Caddyfile on main ≠ production deployed.
