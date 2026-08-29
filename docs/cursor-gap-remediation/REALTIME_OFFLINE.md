# PR-GAP-05 Realtime 與離線 — stacked on GAP-04

Branch: `cursor/p1-realtime-offline-70d9`  
**Base (must not be main):** `cursor/p1-mobile-tablet-ux-70d9` (PR-GAP-04) @ `4f966a3f74740e4e5b4bd84952a45ced7258ce1e`

4-level stack: #95 → GAP-02 → GAP-04 → this branch.

Does **not** invent a second sync system. Does **not** start `#78` whiteboard schema / room JSON overwrite. Does **not** start `#88` Design Intelligence. IndexedDB stays cache / draft / outbox.

## What was still broken on the GAP-04 stack

1. `room_discussion_messages` realtime called `onProjectChange` → whole-room reload on every chat event.
2. Realtime payloads were cast and applied with no SPA HTML / missing-id check.
3. `online` flush walked every failed outbox row, including another account’s, and dispatched them.
4. Duplicate discussion events had no id/updatedAt gate (reload-only path).

## What this branch fixed

- `src/cloud/realtimeApply.ts` — `acceptRealtimePayload`, `applyDiscussionRealtime` (duplicate / older / delete idempotent)
- `roomSync` discussion INSERT/UPDATE/DELETE → row-patch, not whole-room reload
- `flushOutboxOnOnline(ownerId)` — reconnect replay is owner-scoped
- Same discussion stream for `attachment` kind (no second attachment sync)

## Not this PR

- Typing indicators (not modeled)
- Per-member presence beyond the existing room channel count
- `#78` tombstone / operations / room JSON overwrite
- `#88` Design Intelligence
- Production SPA catch-all (client still rejects HTML payloads)
