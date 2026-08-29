# Gap remediation — stacked tip evidence (incomplete)

**全站目標未完成。** Do not merge. Do not deploy. Do not apply 0031/0032 to production. Do not invent 0033. Do not show 已讀／雙藍勾. Unread watermark ≠ receipts.

This file is on the stacked tip `#120 → #124 → #125`. Docs are not IMPLEMENTED without source / migration / test evidence below.

## Stack (VERIFY)

| PR | Branch | Base | Head at this write | Role |
|---|---|---|---|---|
| #120 | `cursor/p0-main-remainders-70d9` | `main` | see that PR | session-entry, hideRoomChrome, GAP-05, V-04, human poll/decision titles |
| #124 | `cursor/p0-discussion-tombstone-unread-70d9` | #120 | `10c9109` | 0031 tombstone + own unread watermark |
| #125 | `cursor/p0-discussion-mentions-todos-70d9` | #124 | `81db260`+ | 0032 mentions + human todos + ephemeral typing; 0031 attribution; RLS + jump + rail |

`origin/main` @ `cd7eb5f` — **not moved**. No merge this turn.

Repo migration head: **0032**. No `0033_*.sql`.

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
| UI todo complete aligned to RLS | `canCompleteRoomTodo` — author or `canManage` |
| Jump first-unread does not advance watermark | `suppressReadFromJump`; T-07 |
| Split View rail hides todos | `showTodos: false` on `wb-side-rail` |
| Discussion reaction is binary 支持 | `room_discussion_supports` PK `(message_id, user_id)`; no `reaction_type`; D-11 |
| `kind: quote` has no producer | reply uses `reply_to_id` + `quotedBody` snapshot; D-12 |
| No 0033 / no receipts | no `0033_*.sql`; UI / SQL must not show 已讀／雙藍勾 |

## CI (this stack)

| SHA | browser | note |
|---|---|---|
| #124 `10c9109` | **success** | build / migrations / agent-read-layer success |
| #125 `c841418` | **fail** `137/138` | `未讀跳到水位之後` |
| #125 `15c59b3` | **fail** visual `11/15` | collaboration-e2e **138/138** (unread jump PASS) |
| #125 `81db260` | **fail** at `test:video` | run `33266947044`: e2e **138/138**, visual **15/15**, review-viewer **27/27**; then `playerReady` 60s timeout after webm fixture. Unread jump / rail / visual were green. |

Local: `test:visual` **15/15**. `test:collaboration` **273/273**. `test:migrations` **385/385**. D-01…D-12 **12/12**.

## Inspected this turn — not wired

### Reactions (`room_discussion_supports`)

Table is **presence = 支持**. Columns: `message_id`, `room_id`, `user_id`, `created_at`. PK `(message_id, user_id)`. **No `reaction_type`.** Not 支持-only by CHECK — it has no type column at all, so it cannot honestly store a second reaction kind without 0033 (new column + CHECK) or a new table.

Video already has a **closed time-anchored** set (`ok` / `confused` / `slow` / `fast` / `fun` / `love` on `video_reactions`). Those labels (太慢／太快) are about playback, not chat. Copying them onto discussion would be a fake product. Discussion’s closed set is one verb: **支持**. Left as-is. **No 0033.**

### `kind: quote`

CHECK in 0014/0018 allows `quote`. Zero send-path producers (`kind: "quote"` absent from `RoomDiscussion.tsx` / `App.tsx` / `collaborationRepository.ts`). Honest quoting is already **reply**: `reply_to_id` + live resolve + `quotedBody` snapshot when the source is missing. A second `kind: quote` card would duplicate that cite type. Left unmodeled.

## Unmodeled (intentional — do not add)

- Read receipts / 已讀／雙藍勾
- Typing **table**
- `kind: quote` producer (reply already cites)
- Multi-emoji discussion reactions (would need 0033 column; no honest closed chat set)

## Deploy-blocked

- 0031 / 0032 are **not** applied to the production database. Do not apply.
- Production origin JSON 404 ≠ success.
- Canva / CUTOS / Perplexity production secrets unverified.
- Stale drafts `#95→#115`, `#88`, `#104`, `#119` stay human rebase / CONFLICTING.
- `#120` / `#124` / `#125` stay mergeable **in order**. `AUTOMERGE REQUIRES AGENT_GATE_PASS`.
- This file is incomplete evidence. Goal remains open.

## Adversarial RLS (0031 + 0032)

| Attack | Verdict | Fix / probe |
|---|---|---|
| BOLA tombstone `deleted_by` forged | **fixed** | `deleted_by := caller` |
| Cross-room mention | denied | WITH CHECK + trigger |
| Mention UPDATE rehang | denied | INSERT-only + UPDATE trigger |
| Peer / stranger todo complete | denied | author / `can_manage` |
| Unread watermark forge / rehang | denied | own-row + trigger |
| Jump first-unread marks latest | **fixed** | `suppressReadFromJump` |

## Production (re-curl this turn)

Re-curled 2026-08-29 18:00 UTC (`/opt/cursor/artifacts/production-curl-2026-08-29-1802.txt`):

| Path | HTTP | Type | Body |
|---|---|---|---|
| `/functions/v1/voice-token` | **404** | `application/json` | `{"ok":false,"code":"NOT_FOUND","message":"this origin has no API"}` |
| `/rest/v1/` | **404** | `application/json` | same |
| `/api/health` | **404** | `application/json` | same |
| `/` | **200** | `text/html` | `<!doctype html>` SPA |

**404 JSON ≠ success.** Do not claim production is fixed. Do not claim deploy.
