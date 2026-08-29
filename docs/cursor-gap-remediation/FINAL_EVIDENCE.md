# Gap-remediation — incremental evidence（未完成）

核對時間：2026-08-29（語音九態 restack 續）。本檔只列有權威證據的項目。**全站目標未完成。** 不是 merge／deploy 許可。

現行 `origin/main`：`196b3a3`（`PR-RESOLVE-01: Home offline and cloud-unset truthful state (#105)`）。含已合併的 #97、#99、#105。#96 仍開著（證據檔在此分支）。

---

## 已合入 main

| 項 | 證據 |
|---|---|
| **#97** | Merged。`src/cloud/apiResponse.ts` 在 main。正式站**未**部署此碼。 |
| **#99** | Merged 2026-08-29T14:38:18Z。`docs/cursor-gap-remediation/REMAINING.md` 與 `scripts/tests/remaining-gaps.test.ts` 在 main。 |
| **#105** | Merged 2026-08-29T15:02:35Z。自稱「替代 #96」。`homeEntryStatus.ts` 現在在 main。**未關閉 #96。** |

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

- 正式站 SPA catch-all（平台／Zeabur）；#97 只在 main client，**未部署**
- #96 仍開著；Home 誠實狀態已由 **#105** 合進 main（`196b3a3`）。#96 的 `FINAL_EVIDENCE` 仍是本檔
- #98 九態仍只在 `cursor/p0-voice-truthful-state-70d9` @ `54a6bd1`（base 仍記 `444ae9d`；main 已前移）
- #95 @ `26ad4a6` 吃過 `444ae9d`，**還沒**吃 `196b3a3`（#105）
- #109 / #111 / #112 / 語音 restack **未合 main**，也未互相 squash
- #78／#88 人類 rebase 與 migration 重編號（main `0022` vs #78 `0022`–`0026` vs #95 `0023`）
- Typing／逐人 presence（未建模；不要發明 schema）
- Production Canva／CUTOS／Perplexity secret 未驗證
- 競爭 `resolve/pr-*` drafts（#106–#110）— 除非撞線否則不要動
- 全站目標

---

## 本回合 live GitHub（語音 restack 後再抓；不沿用舊 SHA）

| 項 | Head | Base | 備註 |
|---|---|---|---|
| **main** | `196b3a3672ca` | — | #105 已合 |
| **#96** | `10fcb903a256`（本檔再推一次） | main（GitHub 仍顯示 `444ae9d`） | 證據檔；不要當 #105 的替代去合 |
| **#98** | `54a6bd167582` | main `444ae9d` | **未 reset**。九態只在這條 main 線 |
| **#95** | `26ad4a65ea6b` | main `444ae9d` | TUS／library；未吃 #105 |
| **#109** | `5df06eb3c57d` | #95 `26ad4a6` | Parent 已開。空房／auth-loading／permission-denied |
| **#111** | `5d21d66bcf8f` | #109 `5df06eb` | UX restack。**未 reset** 舊 #101 `4f966a3` |
| **#112** | `5ff07a7ec1a5` | #111 `5d21d66` | Realtime + V-04 helper。**未 reset** 舊 #102 `3622181`。仍是四態直到 restack |
| **語音 restack** | `477da1ad08a5` | **必須** `#112` `cursor/p1-realtime-offline-restack-70d9` | PR create **403**。Compare 見下 |
| **#78 / #88** | `84d3f3e` / `32e3bca` | stale main | CONFLICTING |

---

## 本回合：#109 session-entry（parent 已開）

| 項 | 證據 |
|---|---|
| PR | https://github.com/aa0968111723-prog/duigao/pull/109 |
| Head | `5df06eb3c57dd754b4db9e7081e1f9d764eba143` |
| Base | `cursor/complete-missing-features-0897` @ `26ad4a6`。**不要** base=`main` |

---

## 本回合：#111 UX restack（parent 已開）

| 項 | 證據 |
|---|---|
| PR | https://github.com/aa0968111723-prog/duigao/pull/111 |
| Head | `5d21d66bcf8f85798a59a60eecbd0a341ed4f534` |
| Base | `cursor/p0-session-room-entry-70d9` @ `5df06eb` |
| 做了 | #101 更多／對話白板／768 split／44px **加上** #95 `hideRoomChrome` |
| 沒做 | 未 reset 舊 `cursor/p1-mobile-tablet-ux-70d9` |

---

## 本回合：#112 realtime restack + V-04 helper（parent 已開）

| 項 | 證據 |
|---|---|
| PR | https://github.com/aa0968111723-prog/duigao/pull/112 |
| Head | `5ff07a7ec1a5607396156d751bfb0303e28bf98c` |
| Base | `cursor/p1-mobile-tablet-ux-restack-70d9` @ `5d21d66` |
| 做了 | `applyDiscussionRealtime` / `acceptRealtimePayload` / `flushOutboxOnOnline(ownerId)`；`voiceDockShowsLeave` 接受 `live` **與** `reconnecting` |
| 沒做 | 未重寫 `useVoiceRoom`（當時仍四態）；未 reset 舊 #102 |

---

## 本回合：九態語音 restack 疊在 #112

| 項 | 證據 |
|---|---|
| Branch | `cursor/p0-voice-nine-state-restack-70d9` @ `477da1ad08a5134e32789f0ec956d1ed9a87972c` |
| **必須的 base** | `cursor/p1-realtime-offline-restack-70d9`（#112 @ `5ff07a7`）。**不要** base=`main`，**不要** reset #98 |
| Compare | https://github.com/aa0968111723-prog/duigao/compare/cursor/p1-realtime-offline-restack-70d9...cursor/p0-voice-nine-state-restack-70d9?expand=1 |
| PR | `create_pull_request` **403**。請人工開，base 必須是上面那條 |
| 調和 | `voiceToken.ts` 同時走 #97 `parseFunctionPayload` 與 #98 `parseVoiceTokenPayload`（`wss:`/`ws:` + 有限 TTL）。未覆寫 #97 |
| V-04 | `RoomDiscussion` 改讀 `voiceDockShowsLeave(api.voice.phase ?? api.voice.state)`。九態把 `reconnecting` 映成 dock `connecting`，只讀 `state` 會讓離開鈕消失 |
| V-07 | `scheduleTokenRefresh` 仍先 `setMuted(true)` + `disconnect` 再 `setPhase("reconnecting")` |
| 清場 | token 拒絕先 `abandonFailedJoin` 再 `setError`；`liveVoice` 只在 `sessionEstablished` 後轉發 `onDisconnected` |

測試（restack 頭 `477da1a`）：

| Script | 結果 |
|---|---|
| `test:voice-state` | 先因缺 `voiceState.ts` 紅 0/1，落地後 **16/16** |
| `test:voice-dock-leave` | 先因未讀 `phase` 紅 0/2，落地後 **2/2** |
| `test:collaboration` | **151/151**（含 voice-state + dock leave） |
| `test:api-response` | **17/17** |
| `remaining-gaps` | **4/4**（R-03 走九態臂） |
| `test:multi-branch-e2e` | **54/54** — 假 LiveKit →「語音連線失敗，稍後再試一次。」；live=0 zombies=0 |
| `test:voice-honesty-e2e` | **22/22**（390 + 768） |
| `agent:gate` | **PASS**（含 `build:local`） |

Browser 390 / 768（`/opt/cursor/artifacts`）：

- `voice-honesty-not-configured-{390,768}.png` — 真房間殼，「語音服務尚未設定」，無「已連線」
- `voice-honesty-connection-failed-{390,768}.png` — 真房間殼，按開始語音後「語音連線失敗，稍後再試一次。」，無離開鈕、無「已連線」
- `voice-honesty-permission-denied-room-{390,768}.png` — **同一次失敗 join 之後**把 `.rd-voice-error` 換成 `voicePhaseMessage("permission-denied")`（假 wss 在 getUserMedia 前就失敗，無法真打到 NotAllowed）。文案本身由 `test:voice-state` 保證不含「已連線」
- `voice-honesty-permission-denied-{390,768}.png` + `voice-honesty-dock.html` — 三態 fixture
- 先紅紀錄：`voice-state-fail.log`、`voice-dock-leave-fail.log`

未做：未把 #78/#88 拆上來；未發明 typing/presence；未改正式庫；未 deploy；未 merge 任何 PR。
