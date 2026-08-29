# PR-GAP-03 Voice truthful states — progress

Branch: `cursor/p0-voice-truthful-state-70d9`  
Base: `origin/main` @ `398960d` (PR-COMM-00 / #94)  
Does **not** stack on #97. Does **not** rewrite #78 / #88 / #95 owned files.

This file lives on the voice branch so it cannot collide with `#97` `PROGRESS.md`.

## Live GitHub at start of this batch (re-fetched)

| PR | Branch | State | Mergeable | Checks |
|---|---|---|---|---|
| #78 | `agent/wb01-canonical-schema` @ `84d3f3e` | OPEN | CONFLICTING / dirty, base stale `361bec0` | Preview skipped |
| #88 | `agent/design-intelligence-perplexity` @ `32e3bca` | OPEN | CONFLICTING / dirty, base stale `b0f7a1b` | Preview skipped |
| #95 | `cursor/complete-missing-features-0897` @ `4e5d8b3` | OPEN | MERGEABLE, base current main | build / browser / migrations / agent-read-layer green |
| #96 | `cursor/p0-mobile-room-entry-70d9` @ `e163bb1` | DRAFT | MERGEABLE | build / browser / migrations / agent-read-layer green |
| #97 | `cursor/gap-remediation-audit-70d9` @ `b8e0095` | DRAFT | MERGEABLE | build / browser / migrations / agent-read-layer green |

Paused: files/outbox (#95), whiteboard (#78), AI/Canva (#88). No merge, no production deploy, no production DB.

## What this batch changes

Truthful phases on unowned voice files:

`idle` / `requesting-permission` / `joining` / `connected` / `reconnecting` / `permission-denied` / `service-not-configured` / `connection-failed` / `left`

- `src/features/voice/voiceState.ts` — pure machine + parsers
- `src/hooks/useVoiceRoom.ts` — phase is source of truth; `state` derived for RoomDiscussion
- `src/features/voice/liveVoice.ts` — reject empty / SPA HTML url or token before LiveKit load
- `src/cloud/voiceToken.ts` — parse invoke payloads; never cast HTML / `{ok:true}` missing keys as success
- `src/features/collaboration/voice.ts` — `語音服務尚未設定`
- `scripts/tests/voice-state.test.ts` — positive / negative / mutation / status-only control

Never fake `connected` or a roster. Participants only when `phase === "connected"`. Missing provider is not `已連線`. Permission-denied is distinct from connection-failed. SPA HTML token is not a live session.

RoomDiscussion (`#95`) still reads `state === "live"` / `state === "connecting"`. Text / whiteboard / files paths are untouched.

## Tests

There is no `npm test` script. Real scripts used by this batch are listed in the commit / PR body.

## Next unowned P0 (after this branch is open)

Do not start files/outbox, whiteboard, or Design Intelligence. If still unblocked, the next unowned surface is whatever the gap matrix lists that is not owned by #78 / #88 / #95 — not a collision rewrite of those PRs.
