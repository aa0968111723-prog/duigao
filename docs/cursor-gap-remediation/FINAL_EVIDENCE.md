# Gap-remediation — incremental evidence（未完成）

核對時間：2026-08-29。本檔只列有權威證據的項目。**全站目標未完成。** 不是 merge／deploy 許可。

現行 `origin/main`：`444ae9d`（`Handoff: remaining gaps and merge order (#99)`）。含已合併的 #97 與 #99。

---

## 已合入 main

| 項 | 證據 |
|---|---|
| **#97** | Merged。`src/cloud/apiResponse.ts` 在 main。 |
| **#99** | Merged 2026-08-29T14:38:18Z。`docs/cursor-gap-remediation/REMAINING.md` 與 `scripts/tests/remaining-gaps.test.ts` 在 main。 |

---

## 本回合：把 #97 合進我們的 dirty draft（merge commit，無 rebase／force）

| PR | 舊 head | 新 head | 衝突 | 測試（本回合） |
|---|---|---|---|---|
| **#96** | `e163bb1` | `4d805cb`（merge）then `52bd0b8`（本檔） | 僅 `package.json`：保留 `test:home-entry` 與 `test:api-response` | `test:home-entry` 5/5；`test:api-response` 17/17 |
| **#98** | `af8c2a4` | `54a6bd1`（merge） | `package.json`、`voiceToken.ts`、`voice.ts`。保留九態 `parseVoiceTokenPayload` **與** #97 `parseFunctionPayload` | `test:voice-state` 15/15；`test:api-response` 17/17；`remaining-gaps` 4/4 |
| **#99** | — | 已在 main | 不需再 merge main 進該分支 | — |

未把 main merge 進 **#78 / #103** 或 **#88 / #104**。

---

## 仍 open（產品碼不在 main，除非另註）

| 項 | 證據 | 本回合 |
|---|---|---|
| **#96** | Open。Home 誠實狀態。已含 main。 | merge 完成 |
| **#98** | Open。語音九態。已含 main。 | merge 完成 |
| **#95** | Open，`07c1164`，base 仍是舊 main `398960d`。與 #97 重疊主要是 `package.json`。擁有 App／TUS／`0023`。 | **未** merge main：不是我們的 P0 誠實 PR，且 merge 會碰到其核心檔與 migration 編號。留給 #95 作者 |
| **#100/#101** | 已合進 #95 stack，不是 main | 未動 |
| **#102** | Open draft，`3622181`，base GAP-04，`mergeable_state: clean`（對其 stack base） | 未把 main merge 進此 stack |
| **#103 GAP-06** | Open draft，疊在 #78 | 未 merge main |
| **#104 GAP-07** | Open draft，疊在 #88 | 未 merge main |
| **#78** | Open，`84d3f3e`，CONFLICTING vs main。`0022`–`0026` 編號碰撞 | 未 merge main |
| **#88** | Open，`32e3bca`，CONFLICTING。`0027`–`0028` | 未 merge main |

---

## 仍 incomplete（已知 leftover）

- 正式站 SPA catch-all（平台／Zeabur 路由）
- V-04 Leave-during-reconnecting（#95 `RoomDiscussion` dock）
- #78／#88 人類 rebase 與 migration 重編號
- Typing／逐人 presence（未建模）
- Production Canva／CUTOS／Perplexity secret 未驗證
- #95 stack 與 #100–#102 產品碼不在 main
- 全站目標
