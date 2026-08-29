# Remaining work — gap remediation handoff

Fetched **2026-08-29** from live GitHub. Base: `origin/main` @ `398960d4251d84bb906f04358a714bc2709791c2` (#94).

This file is the only gap-remediation **handoff**. It does not implement a product fix. It exists because every remaining P0 / high P1 is already owned by an open PR or is human-blocked (migration numbers / platform routing / physical device).

**Do not treat this document as IMPLEMENTED.** Status of each row is `OWNED_OPEN_PR` / `BLOCKED_HUMAN` / `PLATFORM` / `PHYSICAL_DEVICE` / `NOT_A_REMAINING_P0`.

Production: https://duigao-k7q2.zeabur.app/  
Hard rules still in force: no automerge, no production deploy, no production DB writes, no force-push, no new migrations until #78 / #88 / #95 are rebased.

---

## Why this branch invented no product fix

Re-fetched open PRs and their **changed-file lists**. Evaluated every candidate the parent named. Nothing left is safely unowned.

| Candidate | Verdict | Why |
|---|---|---|
| Home / session error-loading-retry beyond #96 | **OWNED** | `Home.tsx` is #96. App onboard / empty-room / retry shells live in `App.tsx` + `MultiBranchRoom.tsx` + `useCloudRoom.ts` (#78 + #95). |
| SPA false-success remaining call sites (`canva.ts` / `cutos.ts` / `voiceToken.ts` casts on main) | **OWNED** | Real defect on main (source-grep + `scripts/tests/remaining-gaps.test.ts`). Fix is already on #97 (`apiResponse.ts` wired into those three files). #98 also rewrites `voiceToken.ts`. A third branch would dual-write. |
| Canva / CUTOS unconfigured honest UI | **OWNED / PAUSED** | Client casts = #97. Schema / DI engine = #88. UI copy already on main in `App.tsx` (`Canva 整合尚未設定` / `CUTOS 整合尚未設定`) — that file is #78+#95. Never start DI/Canva schema. |
| Empty-room entry | **OWNED** | `App.tsx`, `MultiBranchRoom.tsx`, `useCloudRoom.ts` (#78+#95). |
| Share / invite fragment secret leakage | **NOT_A_REMAINING_P0** | `buildInviteUrl` writes `#…` only. `readInviteFromUrl` reads invite from `location.hash` only. Query `?invite=` is ignored (existing `collaboration-workspace.test.ts` + this handoff test). `location.hash + location.search` can pollute **roomId** on a `?invite=#room=` fixture; that is not a capability leak and is not a new P0. |
| Remaining voice honesty outside RoomDiscussion | **OWNED** | Nine-state + V-07 mute-before-reconnect is #98 @ `af8c2a4`. RoomDiscussion chrome (V-04) is #95. |
| New migrations | **BLOCKED_HUMAN** | main head is `0022_discussion_author_integrity.sql`. #78 still claims 0022–0026. #95 claims 0023 + edits applied `0006`. #88 claims 0027–0028 (body still says “main at 0021”). Gate forbids gaps. Do not guess the next number. |

---

## Live open PRs (re-fetched this handoff)

| PR | Title | Branch @ head | Mergeable | Owns (do not copy) |
|---|---|---|---|---|
| **#97** draft | PR-GAP-00 audit + SPA parser | `cursor/gap-remediation-audit-70d9` @ `b8e0095` | **clean** | `apiResponse.ts` (new), `canva.ts`, `cutos.ts`, `voiceToken.ts`, `voice.ts` copy, `docs/cursor-gap-remediation/{BASELINE,GAP_MATRIX,FILE_OWNERSHIP,PR_DEPENDENCIES,TEST_BASELINE,PROGRESS,MIGRATION_RESERVATION}.md` |
| **#96** draft | PR-GAP-01 Home offline/unconfigured | `cursor/p0-mobile-room-entry-70d9` @ `e163bb1` | **clean** | `Home.tsx`, `homeEntryStatus.ts`, `home-entry.test.ts` |
| **#98** draft | PR-GAP-03 voice nine-state + V-07 | `cursor/p0-voice-truthful-state-70d9` @ `af8c2a4` | **blocked** (review/CI gate; parent said CI green) | `useVoiceRoom.ts`, `liveVoice.ts`, `voiceState.ts`, `voiceToken.ts`, `voice.ts`, `voice-state.test.ts`, `VOICE_BATCH.md` |
| **#95** | TUS / transcode / compare / library | `cursor/complete-missing-features-0897` @ `4e5d8b3` | **clean** | `App.tsx`, `useCloudRoom.ts`, `api.ts`, `RoomDiscussion.tsx`, outbox hooks, `tusUpload.ts`, video optimize/library, `0006` **edit**, `0023_video_optimize.sql` |
| **#78** | PR-WB01 whiteboard schema | `agent/wb01-canonical-schema` @ `84d3f3e` | **dirty** (CONFLICTING), base stale `361bec0` | `src/features/whiteboard/**`, collaboration nodes/ops, `collaborationRepository.ts`, `roomSync.ts`, `useCloudRoom.ts`, `App.tsx`, `MultiBranchRoom.tsx`, migrations **0022–0026 whiteboard** |
| **#88** | Design Intelligence 0027–0028 | `agent/design-intelligence-perplexity` @ `32e3bca` | **dirty** (CONFLICTING), base stale `b0f7a1b` | `src/features/design-intelligence/**`, `design-research` edge, `0027`/`0028` |

**#97 and #98 both edit `src/cloud/voiceToken.ts` and `src/features/collaboration/voice.ts`.** Merge #97 first, then rebase #98. Do not land both as-is.

This handoff branch only adds:

- `docs/cursor-gap-remediation/REMAINING.md` (this file; #97 does not have it)
- `scripts/tests/remaining-gaps.test.ts` (new; dual-mode so it still passes after #97/#96/#98 land)

No `package.json` edit (six open PRs already touch that file).

---

## Remaining items (requirement-by-requirement)

### R-01 — SPA HTML / missing-keys false success on Canva + CUTOS + voice token (main)

| Field | Value |
|---|---|
| Severity | **P0** |
| Evidence on this branch | `src/cloud/canva.ts` `as CanvaBridgeHealth` / `as CanvaBridgeDesignList` / `as { ok: boolean; url?: string }`. `src/cloud/cutos.ts` `as CutosBridgeHealth` / `as CutosBridgeImportResult`. `src/cloud/voiceToken.ts` `as VoiceHealth` / `as VoiceTokenResult`. `src/cloud/apiResponse.ts` **does not exist** on main. |
| Expected | HTML 200 and `{ok:true}` without required keys must not be treated as success. |
| Owner PR | **#97** (parser + all three clients). **#98** also replaces `voiceToken.ts` parse (collision). |
| Colliding files | `src/cloud/canva.ts`, `src/cloud/cutos.ts`, `src/cloud/voiceToken.ts`, `src/features/collaboration/voice.ts`, `package.json` |
| Why blocked | Fix already drafted. Copying #97 onto a third branch is dual-write. |
| Human action | Merge #97. Rebase #98 onto that main so voice token uses one parser, not two. |

### R-02 — Home offline / production-without-cloud honesty

| Field | Value |
|---|---|
| Severity | **P0 / high P1** |
| Evidence on this branch | `src/components/Home.tsx` has no `homeEntryStatus`, no offline listener, no「尚未設定」banner. `src/components/homeEntryStatus.ts` does not exist. |
| Owner PR | **#96** |
| Colliding files | `Home.tsx`, `homeEntryStatus.ts`, `package.json` |
| Why blocked | Owned. Further Home retry beyond #96 is not specified as a separate unowned defect. Session/onboard retry is `App.tsx` (#78+#95). |
| Human action | Merge #96 after or with #97. Do not extend Home on another branch. |

### R-03 — Voice nine-state + mute-before-reconnect + truthful token

| Field | Value |
|---|---|
| Severity | **P0** |
| Evidence on this branch | `useVoiceRoom.ts` still exports `VoiceRoomState = "idle" \| "connecting" \| "live" \| "error"`. `src/features/voice/voiceState.ts` does not exist. `voiceUnavailableReason()` is still「語音房間還在準備…」. |
| Owner PR | **#98** @ `af8c2a4` (CI green per parent). Copy string also on **#97**. |
| Colliding files | `useVoiceRoom.ts`, `liveVoice.ts`, `voiceState.ts`, `voiceToken.ts` (**#97**), `voice.ts` (**#97**), `package.json` |
| Why blocked | Done on #98. RoomDiscussion leave-button chrome (V-04) is #95 — do not rewrite. |
| Human action | Rebase #98 onto post-#97 main. Keep #98 session machine + V-07 order. Keep #97 `apiResponse` for canva/cutos. Unify copy to「語音服務尚未設定」. |

### R-04 — Voice dock copy / leave during `reconnecting` (RoomDiscussion)

| Field | Value |
|---|---|
| Severity | P1 (UX contract) |
| Evidence | #98 V-04 deferred-with-owner. #95 dock shows Leave only when `state === "live"`. |
| Owner PR | **#95** (`RoomDiscussion.tsx`) |
| Colliding files | `src/features/room-discussion/RoomDiscussion.tsx`, `discussion.css`, `DiscussionDrawer.tsx` |
| Why blocked | #95 owns the shell. #98 already mutes + disconnects **before** `reconnecting`, so mic is not left open without Leave. |
| Human action | After #98+#95 both exist on one tree, decide whether dock should show Leave while `reconnecting`. |

### R-05 — Empty-room entry + App Loading/Error/Retry/Offline

| Field | Value |
|---|---|
| Severity | P1 (GAP-00-010 / GAP-00-016) |
| Evidence | Empty / chunk-load / onboard live in `App.tsx` + `MultiBranchRoom.tsx` + `useCloudRoom.ts`. |
| Owner PR | **#78** + **#95** |
| Colliding files | `src/App.tsx`, `src/features/multi-room/MultiBranchRoom.tsx`, `src/cloud/useCloudRoom.ts`, `src/components/api.ts` |
| Why blocked | Both PRs edit the same cores. Do not start. |
| Human action | Human rebase / merge those owners; then a later agent may add honesty shells **only if still missing**. |

### R-06 — Files / TUS / outbox / discussion persistence

| Field | Value |
|---|---|
| Severity | P1 (GAP-00-005 / GAP-00-008) |
| Evidence | main has no `src/cloud/tusUpload.ts`. Outbox / RoomDiscussion / video optimize are #95’s 42-file diff. |
| Owner PR | **#95** (MERGEABLE, CI claimed green) |
| Colliding files | see table above; also `0006_video_rooms.sql` **edit**, `0023_video_optimize.sql` |
| Why blocked | Owned. Never start files/outbox. |
| Human action | Review #95. Resolve migration numbering with #78 **before** both merge. |

### R-07 — Whiteboard canonical schema / tombstone / operations

| Field | Value |
|---|---|
| Severity | P1 (GAP-00-006) |
| Evidence | main still 0014 node model. #78 open, CONFLICTING, base `361bec0`. |
| Owner PR | **#78** |
| Colliding files | `src/features/whiteboard/**`, collaboration nodes/ops/types/offline/links, `collaborationRepository.ts`, `roomSync.ts`, `useCloudRoom.ts`, `App.tsx`, `MultiBranchRoom.tsx`, migrations 0022–0026 |
| Why blocked | CONFLICTING. Never start whiteboard. |
| Human action | Rebase onto current main. **Renumber** migrations: main already has `0022_discussion_author_integrity.sql`. Do not apply 0022–0026 as written. |

### R-08 — Design Intelligence schema / research / Canva OAuth secrets

| Field | Value |
|---|---|
| Severity | P1 (GAP-00-007) |
| Evidence | main has contract tests only. Full engine + `0027`/`0028` on #88 (CONFLICTING, body stale). |
| Owner PR | **#88** |
| Colliding files | `src/features/design-intelligence/**`, `supabase/functions/design-research/**`, `0027_design_knowledge.sql`, `0028_design_research_usage.sql`, `scripts/e2e/migrations.mjs`, `package.json` |
| Why blocked | Never start DI/Canva schema. Client honesty for canva/cutos is #97. |
| Human action | Rebase after migration reservation is real (post-#78/#95 numbers). Rotate any leaked Perplexity key (already noted on #88). |

### R-09 — Migration number collision (do not cast a new file)

| Field | Value |
|---|---|
| Severity | **P0 if merged wrong** (GAP-00-004) |
| Evidence | main: `0022_discussion_author_integrity.sql`. #78: 0022–0026 whiteboard. #95: `0023_video_optimize.sql` + edit `0006`. #88: 0027–0028. |
| Owner PR | **#78 #88 #95** (human rebase) |
| Colliding files | `supabase/migrations/*`, `scripts/e2e/migrations.mjs` |
| Why blocked | Contiguous prefixes required. This line must not invent `0023`/`0024`/… |
| Human action | One human owner assigns the next free numbers after choosing merge order of #95 vs #78. |

### R-10 — Production SPA catch-all (platform)

| Field | Value |
|---|---|
| Severity | P0 infra / P2 UI blank page (GAP-00-001 / GAP-00-016) |
| Evidence | `#97` BASELINE: `curl -sI https://duigao-k7q2.zeabur.app/functions/v1/voice-token` → HTTP 200 `text/html`. Same for `/rest/v1/*`, `/api/*`. Client mitigation is #97. Removing the rewrite breaks client routes. |
| Owner | **Platform / Zeabur / `vercel.json`** — not an unowned app-core PR. |
| Colliding files | `vercel.json` (SPA `/(.*)` → `index.html`) |
| Why blocked | Infra. V-06 deferred-with-owner on #98. |
| Human action | After #97 client parser lands, optionally add origin routing so `/functions/v1/*` is not a product page. Do not “fix” it by pretending the SPA is an API. |

### R-11 — Realtime / offline snapshot replace

| Field | Value |
|---|---|
| Severity | P1 (GAP-00-012) |
| Owner PR | **#78** (`roomSync.ts`) + **#95** (`useDiscussionOutbox.ts`, `useCloudRoom.ts`) |
| Why blocked | Same cores. Pause. |

### R-12 — Mobile / tablet IA (tabs, more sheet)

| Field | Value |
|---|---|
| Severity | P1 (GAP-00-011) |
| Owner PR | **#78** `MultiBranchRoom.tsx` + **#95** `RoomDiscussion.tsx` |
| Why blocked | Owned shells. |

### R-13 — Physical device / LINE / HEVC

| Field | Value |
|---|---|
| Severity | P2 (GAP-00-013) |
| Status | `PHYSICAL_DEVICE` — cloud VM has Playwright viewports only. |
| Human action | Phone/tablet hand test after the honesty PRs land. |

### R-14 — Live DB introspection

| Field | Value |
|---|---|
| Severity | P2 (GAP-00-014) |
| Status | `BLOCKED_HUMAN` — no production DB from agents. Repo `test:migrations` still runs on throwaway PG. |

### R-15 — Stale conflict markers in old third-agent docs

| Field | Value |
|---|---|
| Severity | P3 (GAP-00-015) |
| File | `docs/agent-collaboration/third-agent/GAP_MATRIX.md` |
| Why not done here | Not P0/P1. Not product. Do not invent docs busywork on this handoff. |

---

## Suggested human merge order

1. **#97** — parser + canva/cutos + audit docs. No automerge. No deploy.
2. **#96** — Home honesty. Clean vs main; should stay clean vs #97 (different files except `package.json` scripts).
3. **Rebase #98** onto that main — resolve `voiceToken.ts` / `voice.ts`. Then merge #98.
4. **This handoff** — docs + dual-mode test only; can merge any time after or before 1–3 (no overlapping files except eventually `docs/cursor-gap-remediation/` as a new filename).
5. **#95** — only after a human accepts `0006` edit + `0023` number vs #78.
6. **#78** — rebase + **renumber** 0022–0026.
7. **#88** — rebase + take whatever numbers remain after 5–6. Do not keep “main at 0021”.

`AUTOMERGE REQUIRES AGENT_GATE_PASS`. Still do not automerge these drafts.

---

## What the accompanying test proves

`scripts/tests/remaining-gaps.test.ts` (run: `npx tsx --test scripts/tests/remaining-gaps.test.ts`):

- On **this** main-based branch: `apiResponse.ts` missing; canva/cutos/voiceToken still `as`-cast invoke data; Home has no `homeEntryStatus`; voice hook is still four-state; invite secret stays in the fragment.
- After **#97 / #96 / #98** land: the same file switches to “fix present” assertions so CI does not go red.
- Invite query-leak case is a **non-gap** invariant (already true on main).

---

## Exact next human action

1. Open or review the draft PRs in order **#97 → #96 → rebase #98 → #98**.
2. Open this handoff if GitHub create was 403:  
   https://github.com/aa0968111723-prog/duigao/compare/main...cursor/gap-remediation-handoff-70d9?expand=1
3. Do **not** ask another agent to start whiteboard, files/outbox, or DI schema.
4. Do **not** apply any of #78/#88/#95 migrations to production until numbers are contiguous and reviewed.
5. After #97 is on main, optionally fix Zeabur routing so app-origin `/functions/v1/*` is not HTTP 200 HTML.
