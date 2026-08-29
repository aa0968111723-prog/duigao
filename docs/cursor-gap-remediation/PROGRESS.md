# PROGRESS

## 2026-08-29 — PR-RESOLVE-05 / PR-GAP-04 mobile + tablet

Replayed onto `PR-RESOLVE-04` (files/outbox) which sits on `PR-RESOLVE-03` video + latest `main`. Not the stale agent stack.

### Done here (GAP-04)

- First-layer chrome: back / title / presence / voice / more
- 對話／白板 only on the first layer
- 總覽 / 內容 / 企劃 / 搜尋 / AI / 新增 behind 更多
- Tablet split at 768 / 820 when more is open
- Safe area, `--kb`, 44px targets, overflow-x, reduced motion, orientation, Android back (`duigaoMore`)
- Tests: `scripts/tests/mobile-tablet-ux.test.ts` + e2e helpers

## 2026-08-29 — PR-RESOLVE-04 / PR-GAP-02 files + outbox

- Honest discussion insert (SPA HTML / failed API ≠ sent)
- Honest attachment upload (null data / wrong path / HTML ≠ complete)
- Same `message.id` retry does not create two server rows
- Outbox isolated per account (`ownerId` / `isolateOutboxForOwner`)

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
