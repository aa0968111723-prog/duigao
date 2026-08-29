# Gap-remediation — restack tip evidence（未完成）

本檔在 `#115` `cursor/p0-voice-nine-state-restack-70d9`。**全站目標未完成。** 不是 merge／deploy 許可。`#96` 仍有一份證據檔。

核對時間：2026-08-29。再抓過 remote，不沿用舊 SHA。

## Live

| 項 | Head | Base |
|---|---|---|
| main | `698595bb5c10` | — #97、#99、#105、**#106** 已合 |
| **#115 restack** | `c433535f4b32` | **必須** `#112` `cursor/p1-realtime-offline-restack-70d9` @ `5ff07a7` |
| #112 | `5ff07a7ec1a5` | #111 |
| #111 | `5d21d66bcf8f` | #109 |
| #109 | `5df06eb3c57d` | #95 |
| #95 | `26ad4a65ea6b` | main `444ae9d`（未吃 #105/#106） |
| #96 | `52e76c765d53` | main dirty |
| #98 | `54a6bd167582` | main `444ae9d` — **未 reset** |
| #78 | `84d3f3e67ceb` | stale — **未 reset**；仍舊名 0022–0026 |
| **#116** | `84e6808e0260` | **必須** `agent/wb01-canonical-schema` |
| **#103** | `851964f37716` | #78 — **未 reset**；仍舊名 0022–0026 |
| handoff restack | `0b27d138b500` | **必須** `#116` `cursor/p1-whiteboard-migration-renumber-70d9` |
| #88 | `32e3bca10d70` | stale — **未 reset**；仍舊名 0027–0028 |
| DI renumber | `5cdfe490ff80` | **必須** `agent/design-intelligence-perplexity` |
| #104 | `87a56596092d` | #88 — **未 reset** |
| **#106** | merged → main `698595b` | 「替代 #98」；**不會自動更新房間堆疊** |
| #107–#110 | resolve drafts | **未碰** |

## #106 替代 #98 已上 main — 房間堆疊不會自動跟上

`origin/main` tip `698595bb5c10` = `PR-RESOLVE-02: voice nine-state truthful UI (replaces #98) (#106)`。

這只更新 **main-line** 語音。`#115` 的 GitHub base **必須維持 `#112`**。`#95` recorded base 仍是 `444ae9d`。把 #106 合進 main **不會** 把 nine-state 推進 `#109/#111/#112/#115`。房間殼內的九態仍看 `#115`。

Leave `#107`–`#110` alone。未碰、未 merge、未 retarget。

## 本回合：#88 DI 檔名重編號（未 reset #88）

| 項 | 證據 |
|---|---|
| Branch | `cursor/p2-di-migration-renumber-70d9` @ `5cdfe49` |
| **必須的 base** | `agent/design-intelligence-perplexity`（#88 @ `32e3bca`） |
| Compare | https://github.com/aa0968111723-prog/duigao/compare/agent/design-intelligence-perplexity...cursor/p2-di-migration-renumber-70d9?expand=1 |
| PR | create **403** |
| 映射 | `0027_design_knowledge.sql` → `0029_…`；`0028_design_research_usage.sql` → `0030_…`（`git mv`，SQL blob 不變） |
| 文件 | `docs/cursor-gap-remediation/DI_MIGRATION_HANDOFF.md` |
| 缺口 | 本樹沒有 main 0022 / #95 0023 / #116 0024–0028；**不要抄那些 SQL 上來** |
| #88 / #104 | 仍舊名 0027–0028 — **未 reset** |

## 本回合：#103 handoff restack 到 #116（未 reset #103）

| 項 | 證據 |
|---|---|
| Branch | `cursor/p1-whiteboard-handoff-restack-70d9` @ `0b27d13` |
| **必須的 base** | `cursor/p1-whiteboard-migration-renumber-70d9`（#116） |
| Compare | https://github.com/aa0968111723-prog/duigao/compare/cursor/p1-whiteboard-migration-renumber-70d9...cursor/p1-whiteboard-handoff-restack-70d9?expand=1 |
| PR | create **403** |
| 斷言 | 新檔名 0024–0028；整房 LWW 若回來必須失敗 |
| 測試 | `test:whiteboard-handoff` 6/6 |
| 沒做 | 改寫 #78 schema／SQL |

## 本回合：`origin/main` → `#115`（先前 merge，無 rebase／force）

| 項 | 證據 |
|---|---|
| Merge | `f620ad5` parents `477da1a` + `196b3a3` |
| 衝突 | **僅** `package.json` |
| 未丟 | 九態 voice、more-sheet、`hideRoomChrome`、realtime patches、session-entry |
| 測試 | `test:home-entry` 6/6；`test:voice-state` 16/16；`test:voice-dock-leave` 2/2；`test:session-entry` 9/9；`test:api-response` 17/17；`remaining-gaps` 4/4 |

未對 `#95` 再推 merge。#115 tip 證據 commit 仍是 `c433535`，直到本檔這次更新。

## 本回合：#78 編號（#116，未抄上 main）

| 項 | 證據 |
|---|---|
| Branch | `cursor/p1-whiteboard-migration-renumber-70d9` @ `84e6808` |
| **必須的 base** | `agent/wb01-canonical-schema` |
| 映射 | 0022→0024 … 0026→0028（`git mv`，SQL 0 bytes 變更） |
| 缺口 | 本樹沒有 main 0022 / #95 0023；gate 連號要人類 rebase |

## 仍 incomplete

- 正式站 SPA HTML 200；#97 未部署
- #115 / #109–#112 / #95 / #98 **未合**；#95 落後 #105/#106
- #78 原分支仍佔 0022–0026；#116 未合進 #78
- #103 仍舊名，直到人類改用 handoff restack
- #88 / #104 仍舊名 0027–0028
- Typing / presence 未建模
- 全站目標
