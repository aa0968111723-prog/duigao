# Gap-remediation — restack tip evidence（未完成）

本檔在 `#115` `cursor/p0-voice-nine-state-restack-70d9`。**全站目標未完成。** 不是 merge／deploy 許可。`#96` 仍有一份證據檔。

核對時間：2026-08-29。再抓過 remote，不沿用舊 SHA。

## Live

| 項 | Head | Base |
|---|---|---|
| main | `097a6afe47cf` | — #97、#99、#105、#106、**#107** 已合 |
| **#115 restack** | `fee48520e782` | **必須** `#112` `cursor/p1-realtime-offline-restack-70d9` @ `5ff07a7` |
| #112 | `5ff07a7ec1a5` | #111 |
| #95 | `26ad4a65ea6b` | main `444ae9d`（未吃 #105/#106/#107） |
| #98 | `54a6bd167582` | **未 reset** |
| #78 | `84d3f3e67ceb` | **未 reset**；舊 0022–0026 |
| #116 / #117 | `84e6808` / `0b27d13` | bases **必須** 維持 `agent/wb01-canonical-schema` / #116 |
| #103 | `851964f37716` | **未 reset** |
| #88 | `32e3bca10d70` | **未 reset**；舊 0027–0028 |
| #118 | `5cdfe490ff80` | **必須** `agent/design-intelligence-perplexity` |
| #104 | `87a56596092d` | **未 reset**；舊 0027–0028 + honesty |
| AI restack | `e1ea34d6a83d` | **必須** `#118` |
| #106 | merged | 替代 #98；**不更新房間堆疊** |
| #107 | merged → `097a6af` | 替代 #95 + SPA routing **自稱**；**正式站未證明** |
| #108–#110 / #113–#114 | resolve drafts | **未碰** |

## #106 / #107 上 main ≠ 房間堆疊跟上 ≠ 正式站已修

`#115` base **必須維持 `#112`**。`#95` recorded base 仍是 `444ae9d`。main 吃到九態（#106）與 TUS／`0023_video_optimize`／Caddyfile（#107）**不會**自動推進 `#109/#111/#112/#115`。

正式站再 curl `https://duigao-k7q2.zeabur.app/functions/v1/voice-token`：

- HTTP **200**
- `content-type: text/html; charset=utf-8`
- body 以 `<!doctype html>` 開頭（1461 bytes）
- `Last-Modified: Sat, 29 Aug 2026 15:16:18 GMT`

**SPA catch-all 仍 live。** 不得宣稱 production 已修。

## Agent-review（#115 + 兩個 migration stack）

| 檢查 | #115 | #117 / #116 | #118 / AI restack |
|---|---|---|---|
| `as CanvaBridgeHealth` 成功路徑 | **無** — `canva.ts` 走 `parseFunctionPayload` | 有（#78 遺產）。**不改 #78 擁有檔** | 有（#88 遺產）。G7-08 誠實留下；修在 #97/#115 |
| frontend `service_role` | 僅 `config.ts` **拒絕** secret key | 同左 | 同左 |
| fake voice `connected` | **無** — `setPhase("connected")` 只在 `connectVoice` 成功後 `markConnected` | n/a（非房間九態） | n/a |

本回合 **沒有** 在 #115 改產品碼。沒有把 `apiResponse.ts` 抄上 DI／白板 stack。

## 本回合：#104 honesty restack 到 #118（未 reset #104）

| 項 | 證據 |
|---|---|
| Branch | `cursor/p2-ai-external-handoff-restack-70d9` @ `e1ea34d` |
| **必須的 base** | `cursor/p2-di-migration-renumber-70d9`（#118） |
| Compare | https://github.com/aa0968111723-prog/duigao/compare/cursor/p2-di-migration-renumber-70d9...cursor/p2-ai-external-handoff-restack-70d9?expand=1 |
| PR | create **403** |
| 檔名 | 保持 **0029–0030**；未改回 0027–0028 |
| 沒做 | 重寫 `schema.ts` / `types.ts` / SQL |
| 測試 | fail-then-pass（缺 honesty → `ERR_MODULE_NOT_FOUND`）；pass 8/8；analysis 15/15；research 23/23 |

## 仍 incomplete

- 正式站 SPA HTML 200（本回合 curl 證明）
- 房間堆疊未合；#95 落後 #105/#106/#107
- #78 / #88 / #103 / #104 仍舊名
- Typing / presence 未建模
- 全站目標
