# Gap-remediation — incremental evidence（未完成）

核對時間：2026-08-29（續）。本檔只列有權威證據的項目。**全站目標未完成。** 不是 merge／deploy 許可。

現行 `origin/main`：`444ae9d`（`Handoff: remaining gaps and merge order (#99)`）。含已合併的 #97 與 #99。

---

## 已合入 main

| 項 | 證據 |
|---|---|
| **#97** | Merged。`src/cloud/apiResponse.ts` 在 main。正式站**未**部署此碼。 |
| **#99** | Merged 2026-08-29T14:38:18Z。`docs/cursor-gap-remediation/REMAINING.md` 與 `scripts/tests/remaining-gaps.test.ts` 在 main。 |

---

## 本回合 live GitHub（不沿用舊 SHA）

| 項 | Head | Base | mergeable | Checks |
|---|---|---|---|---|
| **main** | `444ae9d` | — | — | — |
| **#96** | `6c4ae6e` | main `444ae9d` | clean | build / migrations / agent-read-layer / **browser success**（run `33258294438`） |
| **#98** | `54a6bd1` | main `444ae9d` | clean | 同上 **browser success**（run `33258266223`） |
| **#95** | `26ad4a6`（本回合 merge main）先前 `07c1164` | main `444ae9d`（GitHub 已重算） | blocked（CI） | 推送後 CI 進行中 |
| **#100** | 已 squash 進 #95（`07c1164`）；branch `bfa3d37` = 原 #100 + squash #101 | — | merged into stack | — |
| **#101** | 已 squash 進 `cursor/p0-files-and-outbox-70d9` @ `bfa3d37`；原 branch `4f966a3` | — | merged into files-and-outbox | — |
| **#102** | `3622181` | `cursor/p1-mobile-tablet-ux-70d9` @ `4f966a3` | clean vs stack base | 未合 main |
| **#103** | `851964f` | #78 `84d3f3e` | — | 未合 main |
| **#104** | `87a5659` | #88 `32e3bca` | — | 未合 main |
| **#105** | `7416b20` draft「替代 #96」 | main `444ae9d` | — | 不是本目標的工作分支 |
| **#78 / #88** | `84d3f3e` / `32e3bca` | stale main | CONFLICTING | 未合 main |

較早 #96 @ `4d805cb` 的 browser 曾 `EADDRINUSE :::54418`（`test:collaboration-e2e`）。**現行 head `6c4ae6e` browser 已綠**，未改 e2e assertion。

---

## 本回合：#95 ← origin/main（merge commit，無 rebase／force）

| 項 | 證據 |
|---|---|
| Head | `26ad4a65ea6ba653b1cbbdb9107a91ea6c0ff3e5` |
| 衝突 | **僅** `package.json` + `docs/cursor-gap-remediation/PROGRESS.md` |
| 決議 | 保留 #95 的 `test:files-batch` / upload-pipeline / discussion-files-batch，並加上 main 的 `test:api-response` |
| 未改 | App.tsx、TUS、`0023_video_optimize.sql` |
| 測試 | `test:api-response` 17/17；`remaining-gaps` 4/4 |

---

## 本回合：#100 ← #95 停止

試 `git merge cursor/complete-missing-features-0897` 進 `cursor/p0-files-and-outbox-70d9` @ `bfa3d37`。

衝突檔：`package.json`、`PROGRESS.md`、`scripts/tests/discussion-files-batch.test.ts`、**`src/features/multi-room/MultiBranchRoom.tsx`**。

`MultiBranchRoom` 是 #101「更多 / tablet split」對 #95「composer hideRoomChrome」。**已 abort。** 不是 package.json 級，也不是 App/TUS/0023，但會重寫 #101 第一層。#101 / #102 **未**吃 main。

---

## 本回合：session-entry 疊在 #95（未開成 GitHub PR：403）

| 項 | 證據 |
|---|---|
| Branch | `cursor/p0-session-room-entry-70d9` @ `5df06eb3c57dd754b4db9e7081e1f9d764eba143` |
| **必須的 base** | `cursor/complete-missing-features-0897`（#95 @ `26ad4a6`），**不要** base=`main` |
| Compare | https://github.com/aa0968111723-prog/duigao/compare/cursor/complete-missing-features-0897...cursor/p0-session-room-entry-70d9?expand=1 |
| 測試 | `test:session-entry` 9/9；`test:api-response` 17/17；`remaining-gaps` 4/4 |
| 做了 | Guest 空房不再假 loading；auth-loading／permission-denied 分開；`invalid invite` 不重分類（不洩露房間是否存在） |
| 沒做 | 不重寫 MultiBranchRoom／TUS／討論 |

Agent-review（本分支，self）：

| Finding | Class |
|---|---|
| Join 失敗仍是 `invalid invite`，不拆 permission-denied | **accepted** — 0007 不洩露房間是否存在 |
| 空房不掛第二套討論殼 | **accepted** — 專案房已走 MultiBranchRoom |
| `permission denied for schema auth` 不當成進房拒絕 | **accepted** |

---

## 正式站（本回合 curl）

`https://duigao-k7q2.zeabur.app/functions/v1/voice-token`、`/rest/v1/rooms`、`/api/health`：**HTTP 200 `text/html`**（Caddy，`last-modified: Sat, 29 Aug 2026 14:40:56 GMT`）。**#97 未部署。** 不要假裝正式站已修好 SPA catch-all。

---

## 仍 incomplete（已知 leftover）

- 正式站 SPA catch-all（平台／Zeabur）；#97 只在 main client
- #96 / #98 尚未合進 main（browser 已綠、mergeable clean）
- #95 stack 往上合 main 停在 MultiBranchRoom（#101 vs #100 chrome）
- Session-entry 只在 #95 疊層，不在 main / #102
- V-04 Leave-during-reconnecting（#95 `RoomDiscussion` dock）
- #78／#88 人類 rebase 與 migration 重編號
- Typing／逐人 presence（未建模）
- Production Canva／CUTOS／Perplexity secret 未驗證
- #100–#102 產品碼不在 main
- 全站目標
