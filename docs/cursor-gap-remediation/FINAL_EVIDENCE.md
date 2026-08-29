# Gap remediation — stacked tip evidence (incomplete)

**全站目標未完成。** Do not merge. Do not deploy. Do not apply 0031/0032 to production. Do not invent 0033. Do not show 已讀／雙藍勾. Unread watermark ≠ receipts.

This file is on the stacked tip `#120 → #124 → #125`. Docs are not IMPLEMENTED without source / migration / test evidence below.

## Stack (VERIFY)

| PR | Branch | Base | Head at this write | Role |
|---|---|---|---|---|
| #120 | `cursor/p0-main-remainders-70d9` | `main` | see that PR | session-entry, hideRoomChrome, GAP-05, V-04, human poll/decision titles |
| #124 | `cursor/p0-discussion-tombstone-unread-70d9` | #120 | `10c9109` | 0031 tombstone + own unread watermark |
| #125 | `cursor/p0-discussion-mentions-todos-70d9` | #124 | this tip | 0032 mentions + human todos + ephemeral typing; 0031 attribution fix |

`origin/main` @ `cd7eb5f` — production origin JSON 404 is recorded, not fixed.

## Evidenced on this stack

| Item | Evidence |
|---|---|
| session-entry / invite-invalid vs permission-denied | `sessionEntryStatus.ts`; guest `data-testid="session-entry-status"` |
| hideRoomChrome | `roomChrome.ts` + `MultiBranchRoom.tsx` |
| GAP-05 realtime + owner flush | `acceptRealtimePayload`; `flushOutboxOnOnline` / `isolateOutboxForOwner` |
| V-04 Leave | `voiceDockShowsLeave` on `live\|connected\|reconnecting` |
| discussion / board poll + decision human title | `boardPollWrite` / `boardDecisionWrite`; D-08…D-10 |
| 0031 tombstone | `0031_discussion_tombstone_unread.sql`; soft-delete; hard DELETE revoked; trigger survives 0014 replay |
| 0031 own unread watermark | `room_discussion_reads` own-row only; `jump-first-unread`; **not** a receipt |
| 0031 `deleted_by` cannot be forged | `new.deleted_by := caller` in 0031 **and** 0032 replace; T-10; migrations probe |
| 0032 mentions | author INSERT; mentioned user must be this room’s member; UPDATE forbidden |
| 0032 todos | member SELECT; own INSERT; UPDATE author or `can_manage`; peer / stranger complete denied |
| 0032 typing | presence `typing: boolean` only; no typing table |
| UI todo complete aligned to RLS | `canCompleteRoomTodo` — author or `canManage`; AI/`agent`/`system` rejected |
| Jump first-unread does not advance watermark | `suppressReadFromJump`; T-07; e2e 「未讀跳到水位之後」 |
| No 0033 / no receipts | no `0033_*.sql`; UI / SQL must not show 已讀／雙藍勾 |

Local suites on the 0032 feature commit `c841418` (before this RLS / jump fix): M-01…M-07 **7/7**; `test:collaboration` **271/271**; `test:migrations` **378/378**; `test:collaboration-e2e` **138/138** locally. CI browser on that SHA **failed 137/138** (`未讀跳到水位之後`) — this tip fixes that race.

#124 CI on `10c9109`: build / browser / migrations / agent-read-layer **success**.

#125 CI on `c841418`: build / migrations / agent-read-layer **success**; browser **failure** `33266334828`. Re-check after this push; do not claim green until terminal.

## Unmodeled (intentional — do not add)

- Read receipts / 已讀／雙藍勾
- Typing **table** (channel presence only)
- `kind: quote` producer
- Six-emoji reactions (`room_discussion_supports` is binary 支持)

## Deploy-blocked

- 0031 / 0032 are **not** applied to the production database. Do not apply.
- Production origin JSON 404 ≠ success. `/functions/v1/voice-token`, `/rest/v1/`, `/api/health` return `{"ok":false,"code":"NOT_FOUND","message":"this origin has no API"}`. `/` is SPA HTML 200.
- Canva / CUTOS / Perplexity production secrets unverified.
- Stale drafts `#95→#115`, `#88`, `#104`, `#119` stay human rebase / CONFLICTING.
- `#120` / `#124` / `#125` stay mergeable **in order**. `AUTOMERGE REQUIRES AGENT_GATE_PASS`.
- This file is incomplete evidence. Goal remains open.

## Adversarial RLS (0031 + 0032) — this tip

| Attack | Verdict | Fix / probe |
|---|---|---|
| BOLA tombstone `deleted_by` forged to another uuid | **real hole** | `deleted_by := caller` (0031 + 0032 replace so 0031 replay cannot restore `coalesce`) |
| Cross-room mention (owner in both rooms mentions capRoom-only reviewer on otherRoom message) | denied | WITH CHECK + trigger; e2e 「不能在這房提及只屬於另一房的人」 |
| Mention UPDATE rehang `mentioned_user_id` | denied | GRANT insert-only + UPDATE trigger `discussion-mention-update-forbidden` |
| Peer reviewer completes another member’s todo | denied | UPDATE USING author / `can_manage`; row stays `open` |
| Stranger completes a todo in another room | denied | RLS + row stays `open` |
| Unread watermark UPDATE / rehang `user_id` for another user | denied | own-row USING + WITH CHECK + trigger |
| Jump first-unread forges “caught up” | **UX hole** | jump must not call `onMarkRead` on feed-end intersection |

Not holes: members reading room mentions (same chat, not a second inbox); owner/`can_manage` completing a member todo; unread SELECT own-row only (that is why it is not a receipt).

## Production (re-curl this turn)

Re-curled 2026-08-29 17:48 UTC (`/opt/cursor/artifacts/production-curl-2026-08-29-1748.txt`):

| Path | HTTP | Type | Body |
|---|---|---|---|
| `/functions/v1/voice-token` | **404** | `application/json` | `{"ok":false,"code":"NOT_FOUND","message":"this origin has no API"}` |
| `/rest/v1/` | **404** | `application/json` | same |
| `/api/health` | **404** | `application/json` | same |
| `/` | **200** | `text/html` | `<!doctype html>` SPA |

**404 JSON ≠ success.** Do not claim production is fixed. Do not claim deploy.
