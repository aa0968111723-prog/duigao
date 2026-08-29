# PROGRESS

## 2026-08-29 — PR-RESOLVE-04 / PR-GAP-02 files + outbox (this branch)

Replayed onto latest `main` + `PR-RESOLVE-03` video (not the stale #95 agent branch).

### Done here

- Honest discussion insert (SPA HTML / failed API ≠ sent)
- Honest attachment upload (null data / wrong path / HTML ≠ complete)
- Same `message.id` retry does not create two server rows
- Outbox isolated per account (`ownerId` / `isolateOutboxForOwner`)
- Mobile composer hides room chrome while the input is focused
- Tests in `scripts/tests/discussion-files-batch.test.ts`

## 2026-08-29 — PR-GAP-00 shipped (merged as #97)

- Production curl: SPA catch-all 200 HTML on `/functions/v1/*`, `/rest/v1/*`, `/api/*`.
- `src/cloud/apiResponse.ts` + wire voice/canva/cutos.
- Voice boundary copy → `語音服務尚未設定`.
- #99 handoff merged.

### Still the durable goal

- GitHub required checks on replacement PRs
- Human rebase #78 / #88 migrations (0024+ after this 0023)
- No production DB writes from agents
- Zeabur platform routing for `/functions/v1/*`
