# Gap-remediation — AI／external handoff restack evidence（未完成）

本檔在 `cursor/p2-ai-external-handoff-restack-70d9`（#104 誠實契約疊在 #118 的 0029–0030 上）。**全站目標未完成。** 不是 merge／deploy 許可。

核對時間：2026-08-29。再抓過 remote，不沿用舊 SHA。

## Live

| 項 | Head | Base |
|---|---|---|
| main | `097a6afe47cf` | — #97、#99、#105、#106、**#107** 已合 |
| **#115** | `fee48520e782` | **必須** `#112` |
| #95 | `26ad4a65ea6b` | main `444ae9d`（未吃 #105/#106/#107） |
| #98 | `54a6bd167582` | **未 reset** |
| #78 | `84d3f3e67ceb` | **未 reset**；舊 0022–0026 |
| #116 / #117 | `84e6808` / `0b27d13` | #116 base **必須** `agent/wb01-canonical-schema`；#117 base **必須** #116 |
| #103 | `851964f37716` | **未 reset** |
| #88 | `32e3bca10d70` | **未 reset**；舊 0027–0028 |
| **#118** | `5cdfe490ff80` | **必須** `agent/design-intelligence-perplexity` |
| **#104** | `87a56596092d` | #88 — **未 reset**；舊 0027–0028 + honesty |
| 本 restack | （本分支） | **必須** `#118` `cursor/p2-di-migration-renumber-70d9` |
| #107 | merged → main `097a6af` | 「替代 #95」+ SPA API routing **自稱**；**正式站未證明已修** |
| #108–#110 / #113–#114 | resolve drafts | **未碰** |

## #107 上 main ≠ 正式站已修、≠ 房間堆疊跟上

`origin/main` tip `097a6af` = `PR-RESOLVE-03: video TUS/transcode/library + SPA API routing (replaces #95) (#107)`。

房間堆疊 `#95 → #109 → #111 → #112 → #115` **不會自動吃到 #107**。#106 九態同樣只在 main-line。

正式站 `https://duigao-k7q2.zeabur.app/functions/v1/voice-token` 本回合再 curl：**HTTP 200、`content-type: text/html`、body 以 `<!doctype html>` 開頭**。`Last-Modified: Sat, 29 Aug 2026 15:16:18 GMT`。**SPA catch-all 仍 live。** 不得宣稱 production 已修。

## GAP-07 restack（本分支）

| 欄位 | 證據 |
|---|---|
| From | #104 honesty / analysis / research / `test:ai-external-handoff`（未 reset #104） |
| Onto | #118 @ `5cdfe49`（0029–0030） |
| 沒做 | 重寫 `schema.ts` / `types.ts` / SQL bytes；改回 0027–0028 |
| 測試 | fail-then-pass：缺 `honesty.ts` 時 `ERR_MODULE_NOT_FOUND`；port 後必須綠 |

Canva／CUTOS：edge 有實作。本樹 `canva.ts` 仍是 `as CanvaBridgeHealth`（#88 遺產；修在 #97/#115）。Production secret **未驗證**。

## 仍 incomplete

- 正式站 SPA HTML 200（本回合 curl 證明）
- 房間堆疊未合；#95 落後 #105/#106/#107
- #78 / #88 / #103 / #104 仍舊名
- Typing / presence 未建模
- 全站目標
