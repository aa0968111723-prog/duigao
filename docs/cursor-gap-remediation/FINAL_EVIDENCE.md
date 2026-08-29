# Gap-remediation — whiteboard handoff restack evidence（未完成）

本檔在 `cursor/p1-whiteboard-handoff-restack-70d9`（#103 測試疊在 #116 新檔名上）。**全站目標未完成。** 不是 merge／deploy 許可。`#115` 與 `#96` 另有證據檔。

核對時間：2026-08-29。再抓過 remote，不沿用舊 SHA。

## Live

| 項 | Head | Base |
|---|---|---|
| main | `698595bb5c10` | — #97、#99、#105、**#106** 已合 |
| **#115** | `c433535f4b32` | **必須** `#112` `cursor/p1-realtime-offline-restack-70d9` |
| #112 | `5ff07a7ec1a5` | #111 |
| #95 | `26ad4a65ea6b` | main `444ae9d`（未吃 #105/#106） |
| #96 | `52e76c765d53` | main dirty |
| #98 | `54a6bd167582` | main `444ae9d` — **未 reset** |
| #78 | `84d3f3e67ceb` | stale — **未 reset**；仍舊名 0022–0026 |
| **#116** | `84e6808e0260` | **必須** `agent/wb01-canonical-schema` |
| **#103** | `851964f37716` | #78 — **未 reset**；仍舊名 0022–0026 |
| 本 restack | （本分支） | **必須** `#116` `cursor/p1-whiteboard-migration-renumber-70d9` |
| #88 | `32e3bca10d70` | stale — **未 reset**；仍舊名 0027–0028 |
| DI renumber | `5cdfe490ff80` | **必須** `agent/design-intelligence-perplexity` |
| #104 | `87a56596092d` | #88 — **未 reset** |
| **#106** | merged → main `698595b` | 「替代 #98」；**不會自動更新房間堆疊** |
| #107–#110 | resolve drafts | **未碰** |

## #106 替代 #98 已上 main — 房間堆疊不會自動跟上

`origin/main` tip `698595b` = `PR-RESOLVE-02: voice nine-state truthful UI (replaces #98) (#106)`。

這只更新 **main-line** 語音。`#115` 的 GitHub base 必須維持 `#112`。`#95` recorded base 仍是 `444ae9d`。把 #106 合進 main **不會** 把 nine-state 推進 `#109/#111/#112/#115`。若產品要房間殼內的九態，仍看 `#115`，不要以為 main 已取代 restack。

Leave `#107`–`#110` alone。

## 本批：#103 handoff → #116 新檔名

| 項 | 證據 |
|---|---|
| From | `#103` `whiteboard-handoff.test.ts` / `WHITEBOARD_HANDOFF.md` / 本檔（未 reset #103） |
| Onto | `#116` @ `84e6808`（0024–0028） |
| 斷言 | 新檔名 `0024_whiteboard_canonical_columns.sql` … `0028_whiteboard_freehand.sql` |
| LWW | 整房 last-write-wins 若被重新引入，測試必須失敗 |
| 沒做 | 改寫 #78 schema／SQL；不上 main；不疊 #95 |

## 有證據（歷史，不重跑則只當自稱）

- **#97** 已合 main：`src/cloud/apiResponse.ts`
- **#116** filename-only：0022→0024 … 0026→0028，SQL blob 不變
- **#103** 仍在舊名樹上，LWW 測試仍有效
- **DI renumber** `0027`→`0029`、`0028`→`0030`（#88 未 reset）

## 仍 incomplete

- 正式站 SPA HTML 200；#97 未部署
- 房間堆疊 #95→#109→#111→#112→#115 **未合**；#95 落後 #105/#106
- #78 仍佔舊 0022–0026；#116 未合進 #78
- #103 仍舊名，直到人類改用本 restack
- #88 / #104 仍舊名 0027–0028
- Typing / presence 未建模
- 全站目標
