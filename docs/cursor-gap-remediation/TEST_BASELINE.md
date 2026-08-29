# TEST_BASELINE

Recorded on `cursor/gap-remediation-audit-70d9` @ `eb5e4b5` then gate-fix commit.  
Base: `origin/main` @ `398960d`.  
`package.json` has **no** `"test"` script.

## Scripts discovered in package.json

| Script | Ran | Result |
|---|---|---|
| `npm run test:api-response` | yes | **17/17 pass** (new) |
| `npm run test:agent` | yes | **16/16** |
| `npm run test:edge-cors` | yes | **5/5** |
| `npm run test:multi-branch` | yes | **42/42** (includes api-response) |
| `npm run test:asset-intelligence` | yes | **15/15** |
| `npm run test:collaboration` | yes | **106/106** |
| `npm run test:viewer-geometry` | yes | **5/5** |
| `npm run test:design-intelligence` | yes | **20/20** |
| `npm run test:migrations` | yes (`PG_BIN=/usr/lib/postgresql/16/bin REQUIRE_PG=1`) | **257/257** |
| `npm run test:share-preview` | yes | **163/163** |
| `npm run test:share-e2e` | yes | **72/72** |
| `npm run test:review-viewer` | yes | **27/27** |
| `npm run test:video` | yes | **165/165** |
| `npm run test:multi-branch-e2e` | yes | **54/54** |
| `npm run test:collaboration-e2e` | yes | **43/43** |
| `npm run test:asset-intelligence-e2e` | yes | pass (AI apply-back path) |
| `npm run build:local` | yes | tsc + vite **pass** |
| `npm run build` | yes | **exit 1** — missing VITE_* (honest; not faked) |
| `npm run agent:gate` | yes | **PASS** after test fixture stopped using an `sb_secret_*` lookalike |
| `npm test` | n/a | **script does not exist** |

First `test:migrations` without Postgres printed 「找不到 PostgreSQL…略過」 and exited 0. That is **not** a gate. Re-ran with real PG 16 + `REQUIRE_PG=1`.

## Negative controls (this PR)

| Case | Evidence |
|---|---|
| SPA HTML 200 ≠ success | `parseFunctionPayload(SPA_HTML)` → `SPA_HTML`; production `/functions/v1/voice-token` is 200 `text/html` |
| `{ ok: true }` without token keys | `MISSING_KEYS` |
| `{ ok: true }` import without `versionId` | rejected |
| status-only helper would accept HTML | negative-control test documents the bug |
| mutation: drop Content-Type html check | mutated parser accepts; real parser rejects |
| empty VITE keys | `check-cloud-env --strict` exit ≠ 0 |
| key containing `service_role` | `check-cloud-env --strict` exit ≠ 0 |

## Production UI (Playwright, no invite/PII)

| Viewport | File | What it shows |
|---|---|---|
| 360 / 390 / 412 | `prod-home-*-*.png` | Guest name onboard（顯示名稱／開始） |
| 768 / 820 | same | same onboard, wider card |
| 390 after name | `prod-home-after-name-phone-390x844.png` | Home + 建立活動房 |
| 768 after name | `prod-home-after-name-tablet-768x1024.png` | Home + 活動房／圖片／影片三卡 |
| 390 `/functions/v1/voice-token` | `prod-spa-catchall-voice-token-390.png` | **blank white** SPA 200 |

Did not: create a live room, capture invite fragments, upload unpublished files, or open private messages.

## Not run / limited

| Item | Why |
|---|---|
| `supabase` CLI | not installed |
| Live production SQL | forbidden |
| Physical iPhone / LINE | no device |
| Two-client live | no second account |
| #78 / #88 / #95 suites on their branches | not our code |
