# FILE_OWNERSHIP — live open PRs vs this audit

Fetched 2026-08-29 from GitHub. **Do not edit these files on gap-remediation batches unless the owning PR is merged.**

## This audit / PR-GAP-00 (`cursor/gap-remediation-audit-70d9`)

| Path | Why safe |
|---|---|
| `src/cloud/apiResponse.ts` | **new** |
| `src/cloud/voiceToken.ts` | not in #78 / #88 / #95 |
| `src/cloud/canva.ts` | not in #78 / #88 / #95 |
| `src/cloud/cutos.ts` | not in #78 / #88 / #95 |
| `src/features/collaboration/voice.ts` | not in #78 / #88 / #95 |
| `scripts/tests/api-response.test.ts` | **new** |
| `package.json` | additive script only (`test:api-response` + append to `test:multi-branch`) |
| `docs/cursor-gap-remediation/*` | **new** |

## #78 whiteboard (`agent/wb01-canonical-schema`) — PAUSE batch 06

Owns (non-exhaustive): `src/features/whiteboard/**`, `src/features/collaboration/{nodes,operations,types,offline,links}.ts`, `src/cloud/collaborationRepository.ts`, `src/cloud/roomSync.ts`, `src/cloud/useCloudRoom.ts`, `src/App.tsx`, `src/components/api.ts`, `src/features/multi-room/MultiBranchRoom.tsx`, `src/features/room-discussion/discussion.css`, `scripts/e2e/collaboration-workspace.mjs`, `scripts/e2e/migrations.mjs`, `scripts/tests/collaboration-workspace.test.ts`, migrations **`0022_whiteboard_*` through `0026_whiteboard_freehand.sql`**.

## #88 Design Intelligence (`agent/design-intelligence-perplexity`) — PAUSE batch 07

Owns: `src/features/design-intelligence/**`, `supabase/functions/design-research/**`, `supabase/migrations/0027_design_knowledge.sql`, `0028_design_research_usage.sql`, `scripts/tests/design-intelligence-*.ts`, `scripts/e2e/migrations.mjs` (shared collide), `package.json`.

## #95 video TUS / library (`cursor/complete-missing-features-0897`) — do not redo

Owns: `src/App.tsx`, `src/cloud/{tusUpload,videoAssets,videoOptimize,videoRoom,assetLibrary,assetIntelligence,roomRepository,useCloudRoom,types}.ts`, `src/components/api.ts`, `src/features/room-discussion/{RoomDiscussion,DiscussionDrawer,feed,discussion.css}`, `src/hooks/{discussionOutboxCore,useDiscussionDraft,useDiscussionOutbox}.ts`, `src/lib/store.ts`, `src/features/video-review/{VideoWorkspace,VideoVersionSelector,media,video.css}`, `scripts/e2e/{video-flow,migrations,mock-supabase,collaboration-workspace}.mjs`, `scripts/tests/{discussion-outbox,upload-pipeline,video-media}.ts`, **`supabase/migrations/0006_video_rooms.sql` (edit)**, **`0023_video_optimize.sql`**.

## Collision hotspots

| File | #78 | #88 | #95 | Consequence |
|---|---|---|---|---|
| `src/App.tsx` | yes | | yes | never touch until both merge or one is closed |
| `src/cloud/useCloudRoom.ts` | yes | | yes | same |
| `src/components/api.ts` | yes | | yes | same |
| `scripts/e2e/migrations.mjs` | yes | yes | yes | no new probes here |
| `package.json` | yes | yes | yes | additive scripts only |
| `0022` / `0023` numbers | 0022–0026 | 0027–0028 | 0023 | see `MIGRATION_RESERVATION.md` |

## Later gap branches (planned owners)

| Branch | Allowed surfaces | Forbidden |
|---|---|---|
| `cursor/p0-production-stability-70d9` | `apiResponse`, config, share-preview honesty, env gate | #78/#88/#95 cores |
| `cursor/p0-mobile-room-entry-70d9` | Home, empty/error shells **if not** `App.tsx`/`MultiBranchRoom` | MultiBranchRoom (#78), App (#95/#78) |
| `cursor/p0-files-and-outbox-70d9` | **PAUSE** — #95 owns outbox + RoomDiscussion | — |
| `cursor/p0-voice-truthful-state-70d9` | `useVoiceRoom.ts`, `liveVoice.ts`, voice-token edge comments | RoomDiscussion (#95) |
| `cursor/p1-team-communication-70d9` | **PAUSE or stack on #95** | RoomDiscussion, outbox |
| `cursor/p1-mobile-tablet-ux-70d9` | CSS / Home / unowned shells | MultiBranchRoom, whiteboard CSS (#78) |
| `cursor/p1-realtime-offline-70d9` | **PAUSE** — `roomSync.ts` / `useCloudRoom.ts` are #78+#95 | — |
| `cursor/p2-ai-integration-70d9` | **PAUSE until #88 merges** | design-intelligence |
| `cursor/p2-external-adapters-70d9` | canva/cutos/planform **UI honesty only** if unowned | Canva OAuth secrets, new migrations |
