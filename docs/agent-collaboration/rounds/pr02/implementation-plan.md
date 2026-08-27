All load-bearing claims from the reader reports verified against HEAD (df8c499, main = PR-01b tip): `package.json:21` lists `scripts/tests/collaboration.test.ts` in `test:collaboration`; `decideNodeWriteRetry` has only success|unbound|failed (src/features/collaboration/offline.ts:25-28); roomSync discards whiteboard_nodes/edges payloads (src/cloud/roomSync.ts:94-96); errors.ts has `isRevisionConflict` ("revision conflict", errors.ts:17-19) but nothing matching "stale-write"; the prototype cluster's only referencers are agent-config.mjs, the two test files, roomContext.ts, and DiscussionWorkspace.tsx; `intelligent-asset-library` cites dead src/collaboration/library.ts (scripts/agent-config.mjs:325-332); RoomAiSheet mounts at App.tsx:2546 and App.tsx:2726; flushPendingBoardEdits at App.tsx:1570-1583.

# PR-02 implementation plan

**Verdict: split into four PRs.** The roadmap's "PR-02" bundles four separable concerns with different risk profiles. Recommended sequence: **PR-02a** (prototype takedown + scanner + evidence), **PR-02b** (F10 stale-write conflict), **PR-02c** (open-board realtime row-patch, depends on 02b), **PR-02d** (ContextAnchor contract, independent, can land anytime after 02a).

---

## PR-02a — Second-model takedown + mounted-import scanner + evidence honesty

All commits in this PR must land atomically per the constraint: `npm run test:collaboration` (package.json:21) breaks the moment sources are deleted before the test file/script line are updated.

**Commit 1 — scanner first (so the gate enforces the delete instead of trusting it):**
1. `scripts/agent-lib.mjs` — add `buildImportGraph(root, entry="src/main.tsx")`: regex BFS over `import ... from "..."` / `export ... from "..."` / `import("...")`, resolving relative specifiers with candidates `[.ts, .tsx, /index.ts, /index.tsx]`; keep type imports, skip `.css`/assets. Dependency-free Node only (agent-lib.mjs currently uses only node:fs/path/url).
2. `scripts/agent-feature-scan.mjs` — in `classifyFeature` (:16-60), require `src/`-prefixed `source` probes to be reachable from the graph to satisfy `minimum.source`; present-but-unreachable files go to a new `unmountedSource` bucket with an explanatory note (soft downgrade to partial, never hard "missing" — per the false-downgrade risk). Probes outside `src/` (supabase/functions, sibling repos at agent-config.mjs:184-246) exempt. Cache graph once per scan.
3. `scripts/agent-config.mjs:325-332` — re-scope `intelligent-asset-library`: remove the dead `src/collaboration/library.ts` source probe and the collaboration.test.ts probe; honest status is **partial** (migration 0016 + RLS hardening live, zero mounted client). Do not fake new evidence. `whiteboard-apply-back` (:334-347) needs no change — #44 already re-pointed it to proposals.ts/RoomAiSheet/App.tsx.

**Commit 2 — deletions (dependency order: leaves of the import chain last is irrelevant since the whole chain dies; delete together):**
- `src/features/collaboration/DiscussionWorkspace.tsx` (zero importers)
- `src/features/collaboration/discussion.css` (sole importer above; NOT `src/features/room-discussion/discussion.css`, which is live)
- `src/ai/roomContext.ts` (sole runtime importer was DiscussionWorkspace; server twin `supabase/functions/_shared/roomContext.ts` stays)
- `src/ai/index.ts` (barrel; imported only by collaboration.test.ts:6-10)
- `src/collaboration/whiteboard.ts`, `src/collaboration/discussionShell.ts`, `src/collaboration/library.ts`
- Orphan sweep in same commit: `src/ai/featureFlags.ts`, `understanding.ts`, `versionAwareness.ts`, `video.ts`, `types.ts` — post-delete their only importers are each other; server twins live in supabase/functions. **Decision required (risk):** featureFlags.ts is the only code home of the canva/voice flags PR-03/PR-05 reference; record in DECISIONS.md that `VOICE_ROOM_MVP` (src/features/collaboration/voice.ts, live via RoomDiscussion) is the single flag mechanism going forward.
- Keep untouched: all of `src/features/collaboration/*` (the real 0014 model; proposals.ts:1-8 depends on types+nodes), `src/ai/proposals.ts`, migrations 0016/0017/0018 (flag, don't drop the table — schema out of scope).

**Commit 2 test updates (same commit):**
- Delete `scripts/tests/collaboration.test.ts`; remove it from package.json:21.
- Port surviving invariants before deleting:
  - Canva/voice text-pin (test 6, :177-183) → `collaboration-workspace.test.ts`: assert 0014/0016 SQL contains no `canva_designs` and voice gating is `VOICE_ROOM_MVP` in voice.ts.
  - Bounded-Room-Context guard (:110-160) — verify server-side coverage in `room-context-strip.test.ts` + `asset-intelligence.test.ts` already pins no-full-room-dump (it does: #46 landed the strip test); no port needed, note it in the PR description.
  - "App does not mount DiscussionWorkspace" — already pinned at ai-proposals.test.ts:77; after deletion change it to assert App.tsx contains no `DiscussionWorkspace` **and** the file no longer exists (loud failure on revert of the delete commit).
  - First-screen 對話/白板/語音 UX contract (:57-70): the contract now binds the live shell — either assert against MultiBranchRoom's inline rd-tabs (MultiBranchRoom.tsx:598-601) in multi-branch tests, or record in DECISIONS.md that it's void. Decide explicitly; don't drop silently.
- `scripts/tests/ai-proposals.test.ts` — delete lines 71 and 78 (prototype readFileSync + 加入白板 match); keep line 77.
- Re-grep scripts/tests + scripts/e2e for all deleted paths after removal.

**Commit 3 — regenerate + docs:** regenerate `.agent/feature-map.json` / `.agent/state.json` via agent:context; update PROJECT_STATE.md:41,55-56, DECISIONS.md:30 (+ new ADR line for flags), ROADMAP.md:49, docs/collaborative-intelligence-workspace.md:32. Leave third-agent audit records untouched (historical). Update DUAL_AI_STATUS if it claims library implemented (risk: reality-audit discrepancy).

**Size:** ~-1,900 lines deleted, ~+300 added (scanner + ported pins + docs). Low runtime risk (nothing mounted changes); gate/test churn is the work.

---

## PR-02b — Stale-write conflict branch (F10 residue) — small, land before 02c

#45 covered only the in-memory half; the durable IDB path still queues and eternally replays stale versions, and can resurrect deleted nodes via plain upsert (collaborationRepository.ts:280 vs delete at :298-301).

Dependency order:
1. `src/cloud/errors.ts` — add `isStaleWrite(err)` matching the exact `'stale-write'` string raised by touch_whiteboard_node (0014_collaboration_workspace.sql:441-455) and thrown client-side by nodes.ts:220. Do not add a second optimistic-lock scheme.
2. `src/features/collaboration/offline.ts` — add `"conflict"` outcome to `decideNodeWriteRetry` (:25-28): `{acknowledged:false, queueDurable:false, queueMemory:false, refetch:true}`. In `applyPendingCloudWrites` (:35-72), a conflict result **drops** the edit (clears by the load-bearing keys `node:${id}` / `node-del:${id}`) instead of retaining; keep retain for transient failures (ack-gating stays).
3. `src/cloud/useCloudRoom.ts:468-500` (`writeAck`) — classify with `isStaleWrite` before the generic failure branch; on conflict, do not queue durable, trigger `scheduleReload` (per constraint: resolve via the existing whole-room nudge, no per-node merge channel in this PR).
4. `src/App.tsx:1317-1347, 1569-1584` — on conflict in `persistCloud`: drop the IDB key, `scheduleReload`, and surface a toast (risk: silent drop makes the user's text vanish). Route `flushPendingBoardEdits` replay through `nodePersistChain` (keep the `.catch(() => undefined)` guard at App.tsx:1318 to avoid the offline-rejection deadlock).
5. **ADR decision** (risk): whether replayed upserts become update-only so deletes win (kills node resurrection) — record it; don't change precedence silently.
6. Tests: extend the decideNodeWriteRetry table at collaboration-workspace.test.ts:322-324 with the conflict row; add a mock-supabase e2e leg (mock already emulates the 409 at mock-supabase.mjs:538-544) proving conflict → drop + reload, not eternal retry.

**Size:** ~+150/-30 lines including tests.

---

## PR-02c — Open-board realtime row-patch (whiteboard_nodes/edges only) — depends on 02b

Confirmed still broken: roomSync.ts:94-96 discards rows → scheduleReload → summary carries `nodes: []` by design (collaborationRepository lazy load) → App.tsx:314-318 keeps local nodes → open board stays stale until reopen.

Dependency order:
1. `src/cloud/collaborationRepository.ts` — no change; `nodeFromRow`/`edgeFromRow` (:112-146) already exported and forward-compatible (unknown node_type → null).
2. `src/cloud/roomSync.ts` — replace the whiteboard_nodes/edges discard bindings (:95-96) with typed handlers `onWhiteboardNodeUpsert(row)` / `onWhiteboardNodeDelete(oldRow)` / `onWhiteboardEdgeInsert(row)` / `onWhiteboardEdgeDelete(oldRow)`; keep the `whiteboards` table on `onProjectChange` (metadata is in the summary). DELETE handlers consume only `old.id` (strokes precedent roomSync.ts:49-51; full old rows exist only via replica identity full, 0014:787-789, and the mock over-delivers, mock-supabase.mjs:962-965).
3. `src/cloud/useCloudRoom.ts` — wire handlers to a dedicated patch callback (do NOT reuse applyRemoteRoom — its deep-link consumption at App.tsx:361-375 must not re-run per patch). Heal on channel re-SUBSCRIBED and the visibility/online revive path (:594-612) by re-running `loadWhiteboard` for the active board — needs an activeWhiteboardId ref reaching the hook. This heal is mandatory, not optional: removing the reload nudge removes its accidental healing.
4. `src/App.tsx` — per-id merge into `room.whiteboardNodes` (never wholesale replace; the empty-incoming guard at :314-318 stays for snapshot loads). **Version gate:** accept incoming node only when `row.version > max(lastAckedNodeVersion.get(id) ?? 0, local.version)`; always bump `lastAckedNodeVersion` to max (mirrors the snapshot path at :331-335) — otherwise the next local write 409s and, pre-02b, re-queues the old payload (this is why 02b lands first). Own-write echoes (version == just-adopted ack) drop cleanly. Prefer version over `updatedAt` comparison (clock-skew risk in reconcileNodes, offline.ts:174). Shield actively-dragged ids while previewNodes is non-null (WhiteboardWorkspace.tsx:296). Edges: set-union by id on INSERT, drop by id on DELETE (no version column, insert-only + hard delete). Batch bursts into one setRoom per animation frame (arrange writes N nodes → N echoes → avoid N renders + N trackSave IDB writes, App.tsx:279-295).
5. `src/features/collaboration/WhiteboardWorkspace.tsx` — no change (fully prop-driven, :255-256, :296).
6. Tests: unit tests for the gate/merge; **new two-tab e2e** over mock realtime (mock-supabase.mjs supports fan-out): tab A moves/adds a node on an open board, tab B sees it without reopening, and rooms GET count stays flat (proves the reload storm is gone). Keep assertions to new-row content and id-only deletes (mock over-fidelity risk). Frozen behavior: pending-writes.test.ts (#45) and discussion outbox must stay green untouched.

**Non-goal within 02c:** row-patch generalization to other tables is PR-08 (ROADMAP.md:51 scope line).

**Size:** ~+450/-20 lines including the e2e.

---

## PR-02d — ContextAnchor contract (ADR-004) — independent

New `src/lib/contextAnchor.ts` (src/lib sits below cloud and features; no cycles). Union arms: `image-point`, `image-region`, `video-point`, `video-range`, `entity` (reusing `LINKED_ENTITY_TYPES`, features/collaboration/types.ts:20-30 — closed vocabulary, do not duplicate), `board-node`; keep entity/board-node arms versionless (forcing versionId fabricates data); keep the union open for the PR-06 3D anchor.

Seven adapters, adapter-first (old codecs delegate to new adapters for one PR, no rewrite-in-place — protects the 0006 derive-trigger contract for legacy rows with missing anchor_type → image-point):
- `anchorFromComment` / `anchorToCommentColumns` (subsume cloud/types.ts:160-170 anchorFromRow + roomRepository.ts:107-123 anchorColumns + lib/region.ts normalizeRegion)
- `anchorFromNode` / `anchorToNodeLink` (WhiteboardNode.linkedEntity* + content.startTime/endTime; preserve the id-remap semantics of collaborationRepository.ts:399-405)
- `anchorFromDiscussion` / `anchorToDiscussionPayload` (DiscussionPayload, types.ts:125-149 incl. PR-01b attachment/link fields)
- `openTarget(a)` — single navigation contract feeding onOpenContent / onOpenBoardNode / setOpenAtSeconds (App.tsx:2405, RoomDiscussion.tsx:201-206, WhiteboardWorkspace.tsx:582-583)

Adoption sites: the M1-M3 read/write list plus proposals.ts:160-163 (normalize AI actions through anchorToNodeLink). Round-trip tests per mechanism against real row fixtures (including legacy no-anchor_type rows). **No DB change, no fourth mechanism, no migration** — 0003/0006/0014 checks stay authoritative. Contract should name but not solve the known holes: no whiteboard_node anchor for comments, no plan_section anchor.

**Size:** ~+550 lines including round-trip tests; touch-many-files but behavior-neutral.

---

## Explicit non-goals (all PRs)
- Re-implementing apply-back — #44 already wired the production path (proposals.ts, RoomAiSheet, App.tsx:1510-1568, both mounts :2546/:2726); PR-02 only tears down the second model.
- Dropping the `library_assets` table or building a mounted library client — flag the zero-client state; feature entry goes honest-partial (schema owned by migrations; #47 RLS fixes stay).
- Row-patch for any table other than whiteboard_nodes/edges (PR-08).
- Per-node conflict merge/rebase UI — conflicts resolve via drop + scheduleReload + toast in this cycle.
- Touching #45 keyed-pending semantics, insertDiscussion/outbox, or the stampPersistedNode invariant (client never pre-advances version; only acks adopt, nodes.ts:199-217).

## Total size estimate
PR-02a ~2,200 changed lines (mostly deletions), PR-02b ~180, PR-02c ~470, PR-02d ~550. As one mega-PR: ~3,400 changed lines across cloud sync, offline retry, App state, scanner, and every anchor surface — unreviewable and risk-coupled; the four-way split isolates the only true ordering dependency (02b before 02c) and lets 02a/02d proceed in parallel.