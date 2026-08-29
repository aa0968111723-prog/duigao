# Gap-remediation — restack tip evidence（未完成）

本檔在 `#115` `cursor/p0-voice-nine-state-restack-70d9`。**全站目標未完成。** 不是 merge／deploy 許可。`#96` 仍有一份證據檔。

核對時間：2026-08-29。再抓過 remote，不沿用舊 SHA。

## Live

| 項 | Head | Base |
|---|---|---|
| main | `196b3a3672ca` | — #105 Home honesty 已合 |
| **#115 restack** | `f620ad543caf`（本 merge） | **必須** `#112` `cursor/p1-realtime-offline-restack-70d9` @ `5ff07a7` |
| #112 | `5ff07a7ec1a5` | #111 |
| #111 | `5d21d66bcf8f` | #109 |
| #109 | `5df06eb3c57d` | #95 |
| #95 | `26ad4a65ea6b` | main `444ae9d`（未吃 #105） |
| #96 | `675d15291495` | main dirty vs `196b3a3` |
| #98 | `54a6bd167582` | main `444ae9d` — **未 reset** |
| #78 | `84d3f3e67ceb` | stale main — **未 reset** |
| renumber | `84e6808e0260` | **必須** `agent/wb01-canonical-schema` |
| #88 | `32e3bca10d70` | stale — **未 reset** |
| #106 | `d3e403cd9b98` | main `196b3a3` — 替代 #98；**未碰** |
| #107–#110 | resolve drafts | **未碰** |

## 本回合：`origin/main` → `#115`（merge commit，無 rebase／force）

| 項 | 證據 |
|---|---|
| Merge | `f620ad5` parents `477da1a` + `196b3a3` |
| 衝突 | **僅** `package.json` |
| 決議 | 保留 restack 全部 test scripts；加上 `#105` `test:home-entry`；`test:multi-branch` 同時跑 upload-pipeline + api-response + home-entry |
| 自動合入 | `Home.tsx` / `homeEntryStatus.ts` / `home-entry.test.ts` |
| 未丟 | 九態 voice、more-sheet、`hideRoomChrome`、realtime patches、session-entry |
| 測試 | `test:home-entry` 6/6；`test:voice-state` 16/16；`test:voice-dock-leave` 2/2；`test:session-entry` 9/9；`test:api-response` 17/17；`remaining-gaps` 4/4 |

未對 `#95` 再推 merge。

## 本回合：#78 編號（新 stack，未抄上 main）

| 項 | 證據 |
|---|---|
| Branch | `cursor/p1-whiteboard-migration-renumber-70d9` @ `84e6808` |
| **必須的 base** | `agent/wb01-canonical-schema` |
| Compare | https://github.com/aa0968111723-prog/duigao/compare/agent/wb01-canonical-schema...cursor/p1-whiteboard-migration-renumber-70d9?expand=1 |
| PR | create **403** |
| 映射 | 0022→0024 … 0026→0028（`git mv`，SQL 0 bytes 變更） |
| 文件 | `docs/cursor-gap-remediation/WHITEBOARD_HANDOFF.md` on that branch |
| `test:migrations` | 本機 `127.0.0.1:5432` **無回應** — 未跑 |
| 缺口 | 本樹沒有 main 0022 / #95 0023；gate 連號要人類 rebase |
| #88 | 0027–0028 現在撞白板新名；之後必須 0029–0030 |

## 仍 incomplete

- 正式站 SPA HTML 200；#97 未部署
- #115 / #109–#112 / #95 / #98 **未合**
- #78 原分支仍佔 0022–0026；renumber 未合進 #78
- #88 / #103 / #104 未 rebase
- Typing / presence 未建模
- 全站目標
