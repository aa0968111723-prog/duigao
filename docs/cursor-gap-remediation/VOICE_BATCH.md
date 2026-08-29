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

There is no `npm test` script.

| Script | Result |
|---|---|
| `test:voice-state` | **12/12** |
| `test:collaboration` | pass (includes voice-state) |
| `test:agent` | **16/16** |
| `test:edge-cors` | **5/5** |
| `test:asset-intelligence` | **15/15** |
| `test:multi-branch` | **25/25** |
| `test:migrations` `REQUIRE_PG=1` PG16 | **257/257** |
| `test:multi-branch-e2e` | **54/54** — fake LiveKit → `語音連線失敗，稍後再試一次。`；無離開鈕 |
| `test:collaboration-e2e` | **43/43** — voice-boundary 仍含「語音」；文字／白板仍可用 |
| `build:local` | pass |
| `agent:gate` | **PASS** |

## Evidence (no tokens / PII)

- `/opt/cursor/artifacts/voice-phases-{360,390,412,768,820}.png`
- `/opt/cursor/artifacts/voice-phases.html`
- `/opt/cursor/artifacts/voice-phase-browser-log.json`
- `/opt/cursor/artifacts/voice-production-voice-token-headers.json` — production `/functions/v1/voice-token` is HTTP 200 `text/html`
- `/opt/cursor/artifacts/e2e-multi-branch-voice-dock.png`
- `/opt/cursor/artifacts/e2e-collaboration-text-whiteboard.png`

## PR

`create_pull_request` / GitHub MCP **403**. Branch is pushed. Compare:

https://github.com/aa0968111723-prog/duigao/pull/new/cursor/p0-voice-truthful-state-70d9

Head: see `git rev-parse HEAD` on this branch.

## Read-only review (this branch)

| ID | Finding | Class |
|---|---|---|
| V-01 | `{ok:true}` with `https://` / non-ws URL could be treated as connectable | **accepted** — parser now requires `ws:` / `wss:` |
| V-02 | non-finite `ttlSeconds` would schedule `setTimeout(NaN)` | **accepted** — reject; `MISSING_KEYS` |
| V-03 | token refresh failure left DB participant `left_at` null while UI said failed | **accepted** — refresh failure now `teardown(true)` |
| V-04 | RoomDiscussion still only shows `live` roster chrome | **deferred-with-owner** — `#95` owns the file; dock `state` mapping kept |
| V-05 | health `{ok:true}` does not prove TURN / LiveKit is up | **accepted-as-designed** — join still parses token; missing provider cannot become `connected` |
| V-06 | production Zeabur `/functions/v1/voice-token` is SPA HTML 200 | **deferred-with-owner** — platform routing; client now refuses that body |

Rejected-with-evidence: none. No secrets, invite fragments, or `room-assets` ACL changes.

## Next unowned P0 (after this branch is open)

Do not start files/outbox, whiteboard, or Design Intelligence. If still unblocked, the next unowned surface is whatever the gap matrix lists that is not owned by #78 / #88 / #95 — not a collision rewrite of those PRs.
