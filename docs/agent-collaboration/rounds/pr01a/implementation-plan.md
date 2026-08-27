# PR-01a Implementation Plan — Discussion as Room Shell

Verified against branch main @ 344459e (read-only). All paths under `D:\duigao`. Key anchors re-checked in-repo: `showProjectShell` fork (src/App.tsx:2264-2295), fire-and-forget send (src/App.tsx:1103-1105), `run()`/`runAndWait`/`writeAck` (src/cloud/useCloudRoom.ts:414-480, insertDiscussion via `run` at :934, `CloudWrites.insertDiscussion` typed void at :116), branch-loader collab gap (src/cloud/roomRepository.ts:634-712 sets `messages: []` and never loads the collab slice; src/lib/roomBranches.ts:109-146 spreads `...detail` so missing keys silently keep stale discussion), deep-link re-assert on every snapshot (src/App.tsx:323-328 inside `applyRemoteRoom`, called from useCloudRoom `onSnapshot` at App.tsx:345), MultiBranchRoom local tab state + forcing effects (MultiBranchRoom.tsx:430-455), `--kb` publisher with unconditional cleanup removal (src/hooks/useViewport.ts:18,35), composer `position: sticky; bottom: 0` with no `--kb` (src/features/room-discussion/discussion.css:15).

---

## 1. File-by-file change list (dependency order)

### Phase 0 — plumbing (no visible UI change; each lands green on its own)

**1. `src/hooks/useViewport.ts`** — make `--kb` publication ref-counted.
- Module-level `let kbConsumers = 0`; increment in the effect, decrement in cleanup; only `root.style.removeProperty("--kb")` (currently unconditional at :35) when the count reaches 0.
- Reason: the shell (new consumer) and an overlaid MobileWorkspace/VideoWorkspace (existing consumers at MobileWorkspace.tsx:37, VideoWorkspace.tsx:54) will be mounted simultaneously; today the first unmount deletes `--kb` for the survivor.
- No API change; return value (vv height for sheet snaps, BottomSheet.tsx:33-37) untouched.

**2. `src/cloud/useCloudRoom.ts`** — awaitable, ack-based discussion insert.
- Change `CloudWrites.insertDiscussion` type (:116) from `(message) => void` to `(message) => Promise<boolean>`.
- Change impl (:934) from `run(() => insertDiscussion(...))` to `writeAck(() => insertDiscussion(...))` — `writeAck` (:458-480) already returns `false` on failure, treats duplicate-key as success (:the isDuplicateKey branch), and does NOT push a stale closure into `pending`, which is exactly the contract a per-message retry UI needs (the outbox, not the closure queue, becomes the retry owner — same rationale as the node-write comment at :458-462).
- Leave `setDiscussionSupport` (:935) on `run()` — supports stay best-effort in this PR.

**3. `src/cloud/roomRepository.ts`** — fix the branch-mode collab gap.
- In `loadRoomBranch` (:634-712), add a `loadCollaborationSummary(client, roomId)` call (same as `loadRoomFull` does at :521-529 / `loadRoomSummary` at :618-629) and attach `discussion`, `discussionSupports`, `whiteboards`, `decisions`, `allowBoardEdit` to the returned room.
- Without this, the new always-visible shell freezes its feed the moment a poster/video branch is open: realtime discussion events (roomSync.ts:97-98) trigger `reload()` which takes the branch path (useCloudRoom.ts:326-333), and that snapshot has no discussion keys. This is the headline PR-01a regression if skipped.

**4. `src/lib/roomBranches.ts`** — make `mergeRoomBranch` (:109-146) explicit about the collab slice.
- Add explicit lines mirroring the existing `messages: room.messages` (:125): `discussion: detail.discussion ?? room.discussion`, `discussionSupports: detail.discussionSupports ?? room.discussionSupports`, `whiteboards: detail.whiteboards ?? room.whiteboards`, `decisions: detail.decisions ?? room.decisions`.
- Today these ride implicitly on the `...detail` spread; once the loader provides them we want the fallback-to-stale behavior documented, not accidental. Keep `scripts/tests/multi-branch.test.ts:101-131` semantics (summary-first + merge) intact; extend that test to assert the collab keys survive a branch merge.

### Phase 1 — send-state outbox

**5. NEW `src/hooks/useDiscussionOutbox.ts`**
- ```ts
  type OutboxState = "sending" | "failed";
  interface OutboxEntry { message: DiscussionMessage; state: OutboxState; }
  function useDiscussionOutbox(args: {
    insert?: (m: DiscussionMessage) => Promise<boolean>; // cloud.writes.insertDiscussion
    bound: boolean;            // cloud is configured AND room is bound
    boundRoomId: string | null;
    serverIds: Set<string>;    // ids present in room.discussion after last snapshot
  }): {
    sendStates: Record<string, OutboxState>;
    ghosts: DiscussionMessage[];           // failed/sending rows missing from the snapshot
    send: (m: DiscussionMessage) => void;
    retry: (messageId: string) => void;
  }
  ```
- Semantics:
  - `send`: register entry as `"sending"`, then `await insert(m)`; `true` → drop entry; `false` → `"failed"`.
  - Pre-bind window: if `!bound`, hold the entry as `"sending"` and flush when `boundRoomId` arrives, stamping `message.roomId = boundRoomId` at flush time — this fixes the stale-local-id FK problem (sendDiscussion stamps `roomRef.current?.id ?? ""` at App.tsx:1092 before the re-key) and the silent pre-bind drop (`run()` no-ops when unbound, useCloudRoom.ts:416).
  - Snapshot reconciliation: any entry whose id appears in `serverIds` is dropped (covers duplicate-key-treated-as-success and echo-reload races). Entries missing from the snapshot are surfaced as `ghosts` so the optimistic row survives the wholesale `room.discussion` replacement (applyRemoteRoom, App.tsx:293-341 + roomRepository.ts:524/623).
  - `retry` re-calls `insert` with the SAME message id — `insertDiscussion` is id-keyed and duplicate-key is treated as success (useCloudRoom.ts writeAck), so retry is idempotent and cannot double-post.
  - Local-only mode: when `insert` is undefined or cloud unconfigured, `send` is a no-op registrar (no entry created) — no failed UI ever appears in local/PeerJS rooms (IndexedDB persist at App.tsx:589-598 is the source of truth there).

### Phase 2 — shell hosting (the core IA change)

**6. `src/features/room-discussion/RoomDiscussion.tsx`**
- New api fields: `sendStates?: Record<string, "sending" | "failed">`, `onRetry?: (messageId: string) => void`, `showDecisions?: boolean` (default true; the single-mode drawer passes reviewer-gated value — see Phase 3).
- Feed render (:114-157): merge `ghosts` are passed in by the caller as part of the message list; per-message, apply `.rd-msg.is-sending` (dimmed) and `.rd-msg.is-failed` with a `button.rd-retry` labeled `未送出 · 重試`, `data-testid="discussion-retry"`.
- Voice (:55-71): DELETE the full-pane `pane === "voice"` branch. Render instead a single inline disabled row under the tabs / above the feed: `<div className="rd-voice-note" data-testid="voice-boundary">{voiceUnavailableReason()}</div>`. Keeps the testid and the 語音 boundary copy (collaboration-workspace.mjs:303 contract text) without occupying a pane. Narrow the `pane` union to `"chat" | "board"`.
- Decisions strip (:87-112): wrap in `showDecisions`.
- Do NOT touch `DiscussionPaneTabs` (:200-214, dead code), `src/features/collaboration/DiscussionWorkspace.tsx`, `src/features/collaboration/discussionShell.ts`, or `voice.ts` — unit tests regex their source text (collaboration.test.ts:59-69,142-143,165-168) and the flag remains the contract.

**7. `src/features/room-discussion/discussion.css`**
- Composer: replace `.rd-composer { position: sticky; bottom: 0; ... }` (:15) with a fixed dock:
  `.rd-composer { position: fixed; left: 12px; right: 12px; bottom: calc(var(--kb, 0px) + var(--rd-dock, 0px)); z-index: 30; padding-bottom: env(safe-area-inset-bottom); }` where `--rd-dock` is set to the bottom-nav height (64px) on the shell root and `0px` when the keyboard is up is unnecessary — when `--kb > 0` the dock rides above the keyboard and simply covers the (useless-while-typing) nav. z-30 sits above `.project-bottom-nav` (z-20, styles.css:1072) and `.project-fab` (z-25).
- Feed clearance: `.rd-feed { padding-bottom: calc(88px + var(--kb, 0px)); }` (today hardcoded 88px at :5).
- New: `.rd-msg.is-sending`, `.rd-msg.is-failed`, `.rd-retry`, `.rd-voice-note`.
- `.rd-tabs` grid `repeat(3,1fr)` → `repeat(2,1fr)` (對話/白板 only).

**8. `src/features/multi-room/MultiBranchRoom.tsx`** — discussion becomes the root screen; content/plan become pushed panes; workspace becomes an overlay child.
- New prop on `MultiBranchRoomApi` (or a second component prop): `workspace?: { node: ReactNode; branchId: string } | null` — the fully-built review workspace App renders into the shell.
- IA restructure:
  - Root screen = the discussion shell: rd-tabs (對話/白板), decisions strip, `discussion-feed`, fixed composer. Delete the 4-tab chrome as the primary IA: `.project-tabs` (:530-532) and `.project-bottom-nav` (:685) are replaced by (a) header entry chips `總覽 / 內容 / 企劃` (`data-testid="open-overview-pane" / "open-content-pane" / "open-plan-pane"`) and (b) content cards inside the feed (`.rd-ref` → `api.onOpenBranch`, already wired via `onOpenContent` at :619).
  - New local state `pushedPane: "overview" | "content" | "plan" | null` replacing `tab`; pushed panes render in `.project-push-pane` (slide-over inside the shell, own `.project-back-button` header — keep that class name for e2e continuity, currently at :486). `discussPane`, `search`, `contentKind`, `sortRecent`, `createOpen` all stay component-local — and now SURVIVE branch opens because the component never unmounts.
  - Remove the 語音 button (:544); rd-tabs = 對話/白板.
  - Branch-forcing effect (:447-449, `setTab("content"/"plan")` on activeBranch): gate on `api.workspace == null` and re-target to `pushedPane` — only plan/copy and zero-version branches still show in-shell detail (:502-527 block moves into the plan/content pushed panes unchanged); poster/video-with-versions branches never retab the shell underneath the overlay. Whiteboard-forcing effect (:450-455) stays but is now harmless (deep-link one-shot, see App.tsx below).
  - Workspace overlay: when `api.workspace` is set, render `<div className="project-workspace-overlay" data-testid="branch-workspace-overlay">{api.workspace.node}</div>` as the LAST child. CSS (styles.css): `position: fixed; inset: 0; z-index: 30; background: var(--bg);` — critically NO transform/filter/contain on this container or any ancestor, so the workspace's own `position: fixed` chrome (`.m-bottom` z-40 bottom:var(--kb), mobile.css:187-194; `.m-modal`, :350-357) keeps positioning against the viewport.
  - Mount `useViewport()` at the top of MultiBranchRoom (ref-counted after change 1) so `--kb` is live for the shell composer.
- Keep `data-testid="multi-branch-room"` on the root (asset-intelligence.mjs:158 only needs it to survive).

**9. `src/styles.css` (+ small mobile.css additions)**
- `.project-workspace-overlay`, `.project-push-pane`, entry-chip styles; delete/retire `.project-tabs` / `.project-bottom-nav` rules (:1026, :1072, :1076 adjust `.project-room-main` padding to composer/dock arithmetic instead of nav height).

**10. `src/App.tsx`** — kill the fork, one-shot deep links, unify returns, lift ShareSheet, wire outbox.
- **Fork removal (:2264-2295 vs :2429-2473):** delete `showProjectShell` early return. New structure: when `projectApi` exists, ALWAYS render `<MultiBranchRoom api={projectApi} workspace={branchWorkspace} />` where `branchWorkspace` is built iff `activeProjectBranch` is poster/video AND `branchVersions(...).length > 0` (same predicate, inverted use): `{ branchId, node: <RoomWorkspace api={api} presence={...} cloud={...} /> }` using the already-built `WorkspaceApi` (:2058-2127), `VideoApi` (:2023-2056), presence (:2433-2436) — no prop drilling of internals; App keeps ownership, MultiBranchRoom gets an opaque node. The overlay MOUNTS on open and UNMOUNTS on back — this deliberately preserves VideoWorkspace's unmount-flush progress/verdict semantics (VideoWorkspace.tsx:443-494) and stops its frame bus while the user is back in discussion; per-open remount matches today's behavior exactly, so `verdictAskedRef`/progress invariants are untouched.
- **ShareSheet lift:** move `ShareSheet` (+ its state consumers, today only on the workspace return path :2458-2469) into the shared wrapper rendered on BOTH paths, closing the pre-existing gap where the shell header's 分享 (MultiBranchRoom.tsx:490 → `onShare` = `openShare` :2251) sets `shareOpen` that nothing renders. `sharePresentation` (:2460) must receive the ROOM title/mediaType when no branch overlay is open and the projected branch room when one is — compute from `activeProjectBranch` presence, not from which return path rendered.
- **One-shot deep link:** add `const roomLinkAppliedRef = useRef(false)`; in `applyRemoteRoom`, guard the `roomLink.branchId` / `roomLink.whiteboardId` / `roomLink.versionId` applications (:323-340) with the ref and set it after first application. Without this, every `onSnapshot` (:345) and peer message (:560-566) re-pushes the user into the branch overlay after they pressed back, and yanks the shell to the board pane (MultiBranchRoom.tsx:450-455).
- **Return unification:** in project rooms, `WorkspaceApi.goHome` (:2110-2125) must ONLY pop the overlay (its `activeBranchId` branch) — assert/guarantee it can never fall through to the leave-room branch while `projectApi` exists (today the dual meaning is reachable). `projectApi.onBackToRoom` (:2189-2194) becomes an alias of the same pop. Leaving the room stays exclusively on `projectApi.onGoHome` (:2253-2259). `openAtSeconds` clear on pop is kept (:2118/:2192) — the whiteboard→video-timestamp carrier (:2178, MultiBranchRoom.tsx:569-571) is unchanged.
- **sendDiscussion (:1085-1108):** route through `useDiscussionOutbox`: keep the optimistic `updateRoom` append (:1103), replace the bare `writes.insertDiscussion?.(message)` (:1104) with `outbox.send(message)`; add a `claim()`-style double-tap guard mirroring `sendChat` (:1596). Pass `sendStates` + `onRetry` + ghost rows into `projectApi` (:2203-2208) and into the single-mode drawer. Feed rendering merges `room.discussion` + `outbox.ghosts` (dedup by id, sort by createdAt).
- **Draft separation:** the shared `chatInput` (:188) stays for the project-shell composer + overview mini-chat; the single-mode DiscussionDrawer gets its OWN draft (local to the drawer) so it never clobbers the workspace chat draft (`WorkspaceApi.chatInput` :2088-2089).
- **Escape ordering:** the overlay/drawer registers a capture-phase keydown that closes itself and stops propagation, sitting ABOVE VideoWorkspace's ladder (VideoWorkspace.tsx:497-533) and the global handler (:1976-1989). Documented order: drawer/sheet → workspace ladder → app ladder; one press closes exactly one thing.
- Untouched: `addFiles`/`addImageFiles`/`addVideoFile`/`createProjectContent` routing (:687-995 — `activeBranchId` remains the single source of truth; `createProjectContent` setting it at :968 now opens the overlay instead of swapping trees, which is the desired UX), first-video full-screen path (:2297-2349), asset-intelligence effect (:352-407), `openShare` fragment encoding (:1838-1869).

### Phase 3 — single-mode discussion drawer

**11. NEW `src/features/room-discussion/DiscussionDrawer.tsx`**
- Thin wrapper mounting `RoomDiscussion` with: own local `draft` state; `hideTabs: true, pane: "chat"` (no board/voice in single rooms); `showDecisions: canManage` and no poll/board-add actions for reviewers (`canTalk` from api rather than the hardcoded `true` at MultiBranchRoom.tsx:596) — this keeps reviewer progressive disclosure (`.agent/invariants.json:60-68`).
- **Store decision (explicit):** the drawer reads a unified feed — `room.discussion ?? []` plus legacy `room.messages` mapped read-only into display rows (precedent: MultiBranchRoom overview fallback `room.discussion ?? room.messages` at :645) — and WRITES only via `sendDiscussion`/`room_discussion_messages`. No schema fork, no disjoint-history rooms; `sendChat`/`insertMessage` (:1594-1608) is not called from the drawer and is left in place elsewhere.
- RLS confirmed mode-agnostic: `room_discussion_messages` policies check only `is_room_member` (supabase/migrations/0014_collaboration_workspace.sql:641-655), realtime publication already includes the tables (:790-806), and single rooms hydrate the collab slice via `loadRoomFull` (roomRepository.ts:521-529) — data-safe with zero backend change.
- Mount points (respecting the workspaces-separated seam — drawer imports live per-workspace, never image↔video cross-imports; only existing cross-import stays `VIDEO_ACCEPT` at MultiBranchRoom.tsx:36):
  - **`src/features/image-review/MobileWorkspace.tsx`:** the existing 討論 tool (:445-457) and DragSheet stay; the sheet's 聊天 tab (:333-335, :375-399) renders `DiscussionDrawer` content instead of the raw `.m-chatbar` list. `.m-tool` position, `.m-sheet-half/.m-sheet-full` classes, `--kb`/`--m-compose` arithmetic all inherited unchanged.
  - **`src/features/image-review/DesktopWorkspace.tsx`:** 聊天 panel tab (:200-207, :266-300) renders the drawer content.
  - **`src/features/video-review/VideoWorkspace.tsx`:** net-new. Mobile: the existing 討論 tool sheet (:958-971, sheet :923-936) gains a segmented control `回饋 | 房間討論`; 討論 remains the 3rd `.m-tool` (video-flow.mjs:1093 positional pin). Desktop: a 房間討論 section/tab inside `aside.v-desktop-side` (:863; video-flow.mjs:1307 pin). Drawer sits inside the existing `.m-bottom` stack — no new fixed layer, no coverage of the frozen frame (video.css:624-649 contract preserved).
- `data-testid="discussion-drawer"` on the wrapper.

### Phase 4 — tests

**12-16. E2E + unit test files** — detailed in section 3: `scripts/e2e/multi-branch-room.mjs`, `scripts/e2e/collaboration-workspace.mjs`, `scripts/e2e/review-viewer.mjs`, `scripts/e2e/video-flow.mjs`, `scripts/e2e/asset-intelligence.mjs`, `scripts/tests/multi-branch.test.ts` (extend merge assertions). `scripts/tests/collaboration.test.ts` untouched (its subjects are untouched).

---

## 2. New components / props / state (names)

| Name | Kind | Where |
|---|---|---|
| `useDiscussionOutbox` | hook — `{ sendStates, ghosts, send, retry }`; entry states `"sending" \| "failed"`; id-keyed idempotent retry; pre-bind flush stamping `boundRoomId` | new `src/hooks/useDiscussionOutbox.ts` |
| `DiscussionDrawer` | component — single-mode wrapper around RoomDiscussion, own draft, reviewer-gated | new `src/features/room-discussion/DiscussionDrawer.tsx` |
| `MultiBranchRoomApi.workspace` | prop — `{ node: ReactNode; branchId: string } \| null`, opaque review-workspace overlay slot | MultiBranchRoom.tsx |
| `pushedPane` | state — `"overview" \| "content" \| "plan" \| null` (replaces `tab: RoomTab`) | MultiBranchRoom.tsx |
| `RoomDiscussionApi.sendStates` / `.onRetry` / `.showDecisions` | props | RoomDiscussion.tsx |
| `roomLinkAppliedRef` | ref — one-shot deep-link guard | App.tsx |
| `branchWorkspace` | derived value in App — the overlay payload (old `showProjectShell` predicate inverted) | App.tsx |
| `kbConsumers` | module ref-counter for `--kb` | useViewport.ts |
| CSS: `.project-workspace-overlay`, `.project-push-pane`, `.rd-composer` (fixed dock), `.rd-msg.is-sending/.is-failed`, `.rd-retry`, `.rd-voice-note` | styles | styles.css / discussion.css |
| Testids: `branch-workspace-overlay`, `discussion-drawer`, `discussion-retry`, `open-content-pane`, `open-plan-pane`, `open-overview-pane` | selectors | as above |
| Kept stable: `multi-branch-room`, `discussion-feed`, `decision-area`, `voice-boundary`, `room-discussion`, `plan-editor`, `create-content-sheet`, aria-label `房間討論`, `.project-back-button`, `.m-tool` order, `.m-sheet-half/.m-sheet-full`, `.v-desktop-side` | | |

---

## 3. E2E updates

### Changed assertions
- **multi-branch-room.mjs**
  - `:181` (4 `.project-tabs` + 4 `.project-bottom-nav` buttons) → REPLACE: root shows `discussion-feed` AND composer `aria-label="房間討論"` on first screen ("enter room lands on discussion shell"); entry chips present.
  - `:201/:214/:227/:239/:255` `.project-tabs button` filter-clicks → click `open-content-pane` / `open-plan-pane` / `open-overview-pane` chips; `:200/:236` `.project-back-button` survives (pushed-pane header).
  - `:215-225` decisions/poll → assert `decision-area` + `.project-poll-option.is-chosen` on the discussion root (rd-decisions strip) instead of the 總覽 tab.
  - `:256-258` BranchCard → `button.m-share` → now inside `branch-workspace-overlay`; ADD: `[data-testid="multi-branch-room"]` still attached while the overlay is open (shell not unmounted).
  - deep-link block (`~:296-302`, `input[aria-label="文宣名稱"]`) → link still lands in the workspace (inside the overlay); ADD one-shot check: close overlay, trigger/await a realtime snapshot, assert the overlay does NOT reopen.
  - `~:262` `branch=`/`item=` fragment assertions unchanged.
- **collaboration-workspace.mjs**
  - `:175-176` (討論 tab among exactly 4) → discussion-shell-first assertions as above; drop the tab click at `:197`.
  - `:199-201` composer fill / `discussion-feed` — selector-stable, keep.
  - `:203-207` 白板 pane button — keep (rd-tabs is now 2 buttons; role/name query unchanged).
  - `:302-303` 語音 pane click → REPLACE with: `voice-boundary` is visible on the discussion root as a NON-interactive note, innerText contains 語音 (boundary copy preserved, no pane occupied). Rewrite in the same serial journey so later whiteboard/decision steps still run.
- **review-viewer.mjs** `:244-251` — same 討論 tool / `.m-sheet-half,.m-sheet-full` toggle, ADD: sheet contains `discussion-drawer`. `:429` (viewer close returns to `.m-stage-area`) unchanged and re-asserted under the overlay shell.
- **video-flow.mjs** — S1–S7 + S10 selectors (`v-brief`, `v-capture-main`, `v-reactions`, `v-rmark`, `v-catrow`, `v-verdict`, no `.v-status` for reviewers) UNCHANGED and must stay green untouched; `:1093` `.m-tool:nth-child(3)` unchanged; `:1307` `.v-desktop-side` unchanged.
- **asset-intelligence.mjs** `:158-159` — unchanged (testid kept; re-run the no-horizontal-scroll check against the new root).

### New checks
1. **Room shell landing:** create project room → first screen is the discussion shell (feed + composer + entry chips), no 4-tab nav.
2. **Push/return context preservation:** open content pane → set search text → open poster branch card → `branch-workspace-overlay` + `.m-stage-area img.stage-img` → back → shell still mounted, search text and pane state preserved (the state that dies today at MultiBranchRoom.tsx:430-436).
3. **Keyboard composer:** on the discussion root, set `document.documentElement.style.setProperty("--kb","300px")` via `page.evaluate`, assert composer dock `getBoundingClientRect().bottom <= innerHeight - 300`; reset and assert it returns to the nav-adjacent position.
4. **Failed send + retry:** with the mock supabase, reject the first `room_discussion_messages` insert → optimistic row shows `.rd-msg.is-failed` + `discussion-retry`; trigger a realtime nudge and assert the ghost row SURVIVES the snapshot replacement; click retry → row transitions to sent, appears exactly once (id-idempotent, no duplicate).
5. **Single-room drawer:** in a single-mode image room, 討論 tool → sheet contains `discussion-drawer`; send a message → appears in `discussion-feed`; in a single-mode VIDEO room (net-new surface), open drawer → frozen frame still visible (no overlay over `.v-stage-area` beyond the sheet), send works.
6. **Reviewer invariants in the drawer:** reviewer opens the drawer → no decisions strip, no 建立投票/加入白板 actions; video reviewer leg (S10 shape) re-run with the drawer open.
7. **Whiteboard→video timestamp:** wb time card → overlay opens with `openAtSeconds` honored (video not at 0:00).

### Unit tests
- `scripts/tests/multi-branch.test.ts` — extend to assert `mergeRoomBranch` carries `discussion`/`decisions`/`whiteboards` from a branch detail snapshot.
- `scripts/tests/collaboration.test.ts` — no changes needed: its subjects (`discussionShell.ts` labels/flags, `DiscussionWorkspace.tsx` source text, `VOICE_ROOM_MVP === false`) are deliberately untouched.

---

## 4. Explicit non-goals (guard rails)

- **No router / history integration.** Returnability stays React-state-based (`activeBranchId`, `pushedPane`); hash still carries only `#room`+deep-link params (invite.ts:37-58); hardware back still exits the page.
- **No voice implementation or flag change.** `VOICE_ROOM_MVP` stays `false` (voice.ts:11); `voice.ts`, `discussionShell.ts`, `DiscussionWorkspace.tsx` and their text-pinned unit tests untouched. Only the mounted UI demotes the pane to a disabled note.
- **No change to reviewer review mechanics.** VideoWorkspace :443-533 (92% once-per-cut verdict, 15s progress throttle, unmount flush, Escape ladder internals) untouched; overlay mounts/unmounts the workspace exactly as the old tree swap did.
- **No discussion pagination / incremental realtime.** The unbounded history load (collaborationRepository.ts:197) and nudge→full-reload pipeline (roomSync.ts:97-99 → scheduleReload) stay as-is; the reload-storm cost is acknowledged and deferred (candidate PR-01b).
- **No migration of legacy `room.messages`.** `sendChat`/`insertMessage` (:1594-1608) and existing chat rows stay; the drawer merges them read-only. No backfill.
- **No per-branch presence.** `channel.track({at})` payload and room-scoped count (roomSync.ts:100-106) unchanged; subscription lifecycle (useCloudRoom.ts:490-601) unchanged.
- **No change to `run()`/pending-queue semantics for any write other than `insertDiscussion`.**
- **Unchanged flows:** first-video full-screen upload (App.tsx:2297-2349), branch upload routing via `activeBranchId` (:687-995), share-link fragment format (:1838-1869), asset-intelligence loading (:352-407), PeerJS whole-Room local mode (:536-598, :1670-1690), the RoomWorkspace image/video seam (RoomWorkspace.tsx:30-34 — no cross-imports added).
- **Single-mode rooms never mount MultiBranchRoom** (guard stays `room.projectMode` at App.tsx:2165); the drawer is the only single-mode addition.

---

## 5. Migration: none — CONFIRMED

No database migration is needed:
- `room_discussion_messages` / `room_discussion_supports` RLS is already mode-agnostic — select/insert require only `public.is_room_member(room_id)` (supabase/migrations/0014_collaboration_workspace.sql:641-646; update/delete author-or-manager :647-655; supports :657-666); nothing filters on `rooms.room_mode` (defined in 0013_project_room_branches.sql:21-29, never read by 0014 policies). Single-mode rooms can read/write discussion today.
- Realtime publication already includes the discussion/supports/decision tables (0014:790-806); the per-room channel subscribes to them for EVERY cloud room regardless of mode (roomSync.ts:97-99).
- Single-room hydration already returns the collab slice (`loadRoomFull`, roomRepository.ts:521-529); the one gap (`loadRoomBranch`) is a client-side loader change (Phase 0, item 3), not a schema change.
- Anonymous sessions are authenticated members (auth.ts:5-14); no policy change needed for guests.
- The outbox, one-shot deep link, `--kb` ref-count, and awaitable insert are all client-side. The only server-adjacent behavior change is `loadRoomBranch` issuing the extra `loadCollaborationSummary` queries per branch reload — additional read load, zero schema impact.