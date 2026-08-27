# IMPLEMENTATION_LOG

## 2026-08-28 — TA-001 / TA-002

Branch: `codex/third-agent-ai-proposal-apply`

- Added `src/ai/proposals.ts`: normalize `answer.actions`, gate, 0014 node mapping, no original-media copy, plan-draft extra confirm, double-apply fingerprint.
- `RoomAiSheet` renders proposal cards (preview / 套用 / 拒絕).
- `App.applyAiProposal` writes comment / poll / extra-confirmed plan / whiteboard node via existing cloud writes + audit discussion line.
- `agent-config` `whiteboard-apply-back` now requires production files, not unused `DiscussionWorkspace`.
- Tests: `scripts/tests/ai-proposals.test.ts` + collaboration production-path assertion + asset-intelligence e2e Apply.
- Did not rewrite PR-01a discussion shell. Did not touch Claude docs outside `third-agent/`.

## 2026-08-28 — CTX path keys

Branch: `codex/third-agent-context-path-strip`

- `stripSecrets` now drops `poster_storage_path`, `image_path`, `video_path` and camelCase aliases so 0015 metadata cannot ride into Room Context.
- Test: `scripts/tests/room-context-strip.test.ts` drives the shipped helper.
## 2026-08-28 — RLS author ACL

Branch: `codex/third-agent-rls-author-acl`

- 0017: shared library mutate = created_by only; visual proposal write = author or can_manage_media.
- `upsert_visual_proposal` rejects non-author reviewers.
- Tests in `scripts/e2e/migrations.mjs`.
