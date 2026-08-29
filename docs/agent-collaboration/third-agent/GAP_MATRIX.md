# THIRD AGENT GAP MATRIX

Base SHA: `ddb916e2f9d47d0effeda12f707be182de5cba90`

Status key: OPEN / FIXED_THIS_PR / BLOCKED / PHYSICAL_DEVICE_PENDING

## TA-001

- severity: P1
- area: AI write path
- claim: Phase 3 “AI × whiteboard retrieve + apply-back” done; feature-map `whiteboard-apply-back=implemented`
- actual evidence: `RoomAiSheet.tsx` rendered `answer.text` + citations only. `supabase/functions/room-ai-context/index.ts` already parsed `actions`. `DiscussionWorkspace.tsx` was never imported from `App.tsx`.
- reproduction: Open room AI, ask, observe no 套用 control on main before this PR.
- affected users: every room using 房間 AI
- root cause: apply-back implemented against an unmounted prototype graph (`canvasId`), not 0014 `whiteboard_nodes`
- recommended fix: typed proposal cards on RoomAiSheet → human Apply → production `upsertNode` / discussion / poll / extra-confirmed plan draft
- release blocker: yes (core Human-first loop missing)
- status: FIXED_THIS_PR
- commit: this branch
- test: `scripts/tests/ai-proposals.test.ts`, `npm run test:asset-intelligence-e2e`

## TA-002

- severity: P1
- area: tests
- claim: collaboration tests prove apply-back
- actual evidence: `scripts/tests/collaboration.test.ts` grepped unused `DiscussionWorkspace.tsx` for `加入白板`
- reproduction: delete production import of DiscussionWorkspace (already absent); tests still passed
- affected users: maintainers shipping false greens
- root cause: file-string assertions on a prototype
- recommended fix: require `App.tsx` + `RoomAiSheet` apply path
- release blocker: yes (false confidence)
- status: FIXED_THIS_PR
- commit: this branch
- test: `prototype DiscussionWorkspace is not the production apply path`

## TA-003

- severity: P1
- area: discussion IA
- claim: 進房第一眼是人 / 內容 / 討論
- actual evidence: `MultiBranchRoom.tsx` default tab is `overview`; 討論 is 4th tab. Single-mode rooms have no room-layer discussion shell.
- reproduction: 建立活動房 → 總覽
- affected users: mobile project rooms
- root cause: room shell is a dashboard of tools
- recommended fix: Claude PR-01a (not this PR; IA rewrite is a larger collision)
- release blocker: yes for “human-first room”
- status: OPEN
- commit: —
- test: missing production e2e that 進房即討論

## TA-004

- severity: P1
- area: whiteboard realtime
- claim: live collaboration
- actual evidence: PROJECT_STATE.md item 5; postgres_changes reloads the room snapshot but an open board keeps local nodes
- reproduction: two users, one board open, peer edits not visible until leave/reenter
- affected users: simultaneous board editors
- root cause: snapshot merge prefers in-memory open board
- recommended fix: row-patch (Claude PR-02)
- release blocker: yes for multiplayer boards
- status: OPEN
- commit: —
- test: no two-client open-board e2e

## TA-005

- severity: P1
- area: Universal Intake
- claim: any file type enters one asset pipeline
- actual evidence: `accept=image/*` or `VIDEO_ACCEPT` only in Home / MultiBranchRoom / VideoVersionSelector. `registerIntelligentAsset` has no UI callers found.
- reproduction: try PDF/DOCX/camera/clipboard from composer
- affected users: anyone adding non-image/video
- root cause: no shared intake module
- recommended fix: Claude PR-01b
- release blocker: yes for “join real assets from discussion”
- status: OPEN
- commit: —
- test: no intake e2e for PDF/GLB/URL

## TA-006

- severity: P2
- area: Voice
- claim: first screen includes 語音
- actual evidence: flag false, `voiceRoomApi` throws, copy is honest. Tab still present in production `RoomDiscussion` / `MultiBranchRoom`.
- reproduction: tap 語音 → “語音房間還在準備…”
- affected users: mobile IA density
- root cause: tab is a reserved slot
- recommended fix: hide tab while flag is off (PR-03)
- release blocker: no (not fake-success)
- status: OPEN
- commit: —
- test: collaboration.test.ts currently requires 語音 on first screen labels

## TA-007

- severity: P2
- area: integrations
- claim: Canva / planform / CUTOS
- actual evidence: no `canva`/`planform`/`CUTOS` source. Flags disabled. CUTOS auth blocked per PR-00.
- reproduction: no UI entry that pretends they work (Canva). Voice is honest.
- affected users: none yet
- root cause: optional phases
- recommended fix: keep DISABLED; do not mark IMPLEMENTED
- release blocker: no
- status: OPEN
- commit: —
- test: feature flags

## TA-008

- severity: P1
- area: production
- claim: deployed product
- actual evidence: Zeabur MCP `ERROR_INVALID_TOKEN`. `productionMigrationHead=unknown`. No live smoke.
- reproduction: zeabur list-projects
- affected users: anyone given a production URL
- root cause: no valid token in this session
- recommended fix: user supplies Zeabur/Supabase access
- release blocker: yes for “production ready”
- status: BLOCKED (`BLOCKED_ZEABUR_ACCESS`)
- commit: —
- test: —

## TA-009

- severity: P2
- area: devices
- claim: mobile/tablet verified
- actual evidence: Playwright 390×844 Android UA only. No 430/375/393, no landscape, no tablet 768/820/1024, no physical iPhone/LINE/HEVC.
- reproduction: read e2e viewport constants
- affected users: iPhone / tablet / LINE
- root cause: emulator-only
- recommended fix: viewport matrix + PHYSICAL_DEVICE_PENDING until real devices
- release blocker: no for this PR; yes for device sign-off
- status: PHYSICAL_DEVICE_PENDING
- commit: —
- test: AUTOMATED_VERIFIED for 390×844 Android Chrome emulation after this PR’s AI sheet path

## TA-010

- severity: P2 (privacy leak if metadata is copied into context)
- area: Room Context secret strip
- claim: `stripSecrets` prevents storage paths from reaching tku-zen-agent
- actual evidence: 0015 writes `poster_storage_path` into asset metadata; FORBIDDEN_KEYS listed `storage_path` only
- reproduction: pass `{ poster_storage_path, image_path, video_path }` through `stripSecrets`
- affected users: any room that asks AI after video/image analysis
- root cause: key denylist missed 0015 aliases
- recommended fix: add path keys + regex
- release blocker: no (no signed URL in Room Context today if those keys stay in structured_data)
- status: FIXED_THIS_PR
- commit: this branch
- test: `scripts/tests/room-context-strip.test.ts`

## TA-011

- severity: P1
- area: RLS
- claim: shared library is room-safe
- actual evidence: 0016 UPDATE/DELETE allowed any owner/editor of any room to mutate every shared row
- reproduction: editor of room A updates a shared logo created by another user
- affected users: every shared library asset
- root cause: membership exists-check without created_by
- recommended fix: stamp created_by; shared mutate = author only
- release blocker: yes if shared library is used
- status: FIXED_THIS_PR
- commit: this branch
- test: migrations 0017 section

## TA-012

- severity: P1
- area: RLS
- claim: reviewer cannot overwrite another member's proposals
- actual evidence: visual_proposals FOR ALL members + SECURITY DEFINER upsert only checks is_room_member
- reproduction: reviewer `upsert_visual_proposal` on an owner's proposal id
- affected users: proposal authors
- root cause: membership treated as write grant
- recommended fix: author or can_manage_media
- release blocker: yes for proposal integrity
- status: FIXED_THIS_PR
- commit: this branch
- test: migrations 0017 section
