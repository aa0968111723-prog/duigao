# TEST_STATUS — 基準線

更新：2026-08-28　基準：main @ f327a70 ＋ PR #42（fix/video-e2e-fault-race）

| 指令 | 結果 | 備註 |
|---|---|---|
| npm run build:local | ✅ | tsc + vite；873KB chunk 警告（PR-08 收） |
| npm run test:agent | ✅ | node --test，0 fail |
| npm run test:asset-intelligence | ✅ 9 pass | 需 `npm install`（tsx 為 devDep；乾環境 npm ci 即有） |
| npm run test:collaboration | ✅ 32 pass | 同上 |
| npm run test:multi-branch | ✅ 7 pass | |
| npm run test:migrations | ✅ 192/192 | 真 PostgreSQL、16 migrations、5 角色 RLS 探測 |
| npm run test:multi-branch-e2e | ✅ 16/16 | Playwright Chromium |
| npm run test:collaboration-e2e | ✅ 21/21 | |
| npm run test:review-viewer | ✅ 23/23 | |
| npm run test:video | ✅ 157/157 | **修復前在負載下 156/157**（PR #42，A/B 驗證） |
| npm run test:share-e2e | ✅ 72/72 | |
| npm run test:share-preview | ✅ 176/176 | 真 edge function 原始碼在 Deno shim 下執行 |
| npm run agent:gate | ✅ PASS | AUTOMERGE REQUIRES AGENT_GATE_PASS |

## CI（GitHub Actions）

- main @ f327a70：**紅**（run 33080577556）— 敗於 video-flow 檢查 23；同因 ad350b5（33079054174）。根因與修復：PR #42。
- 環境注意：CI browser job 為 2-core runner；PR #42 的修法已在 6×CPU burner 負載下本機驗證。

## 已知未覆蓋（誠實清單）

- 所有瀏覽器 E2E 打本機 mock-supabase，hosted Supabase 未驗（見 BLOCKERS UNVERIFIED_PRODUCTION_STATE）。
- 真機矩陣（Safari Range seek、iPhone HEVC、LINE in-app 首播手勢）— harness 自己聲明需真機。
- feature-map 的 implemented 判定是字串存在證據（agent-feature-scan classifyFeature），非行為證據 — room-ai-context/asset-analysis 因此標成 implemented，但 audit 顯示 actions UI 斷頭（PR-04 目標）。
