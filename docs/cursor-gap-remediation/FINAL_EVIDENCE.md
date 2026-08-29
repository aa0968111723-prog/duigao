# Gap-remediation — incremental evidence（未完成）

核對時間：2026-08-29。本檔 **只列當下有權威證據的項目**。沒有證據的列保持 incomplete。

**全站目標未完成。** 本檔不是完工聲明，也不是 merge／deploy 許可。

權威來源優先序：GitHub PR 狀態 → 分支 SHA → 工作樹上的 source／test → 本回合實際跑過的指令。PR 內文的測試數字只當「該 PR 自稱」，除非本回合重跑。

現行 `origin/main`：`3d8b2cf95e47f082f47c18aca704bbf35fac8106`（#97 已合入）。

---

## 有證據

### #97 PR-GAP-00 — 已合入 main

| 欄位 | 證據 |
|---|---|
| PR | https://github.com/aa0968111723-prog/duigao/pull/97 — **merged** 2026-08-29T14:22:28Z |
| Head | `cursor/gap-remediation-audit-70d9` @ `b8e009547c0d1cdb3cea1ada824e7821257bda01` |
| Main 證明 | `origin/main` 訊息為 `PR-GAP-00: 真實稽核、測試基線與 SPA 假成功防護 (#97)` @ `3d8b2cf` |
| Source on main | `src/cloud/apiResponse.ts`、`docs/cursor-gap-remediation/GAP_MATRIX.md` 存在於 `origin/main` |

本回合 **沒有** 在 main 上重跑 `test:api-response`。正式站 SPA catch-all **未修**（仍屬平台路由，incomplete）。

### #96 PR-GAP-01 — open，未合入

| 欄位 | 證據 |
|---|---|
| PR | https://github.com/aa0968111723-prog/duigao/pull/96 — **open**，`mergeable_state: dirty` |
| Head | `cursor/p0-mobile-room-entry-70d9` @ `e163bb1b1ba95d7b17e9a40907a2010f25dbf421` |
| 範圍 | Home 離線／雲端未設定誠實狀態 |

對現行 main dirty（#97 已改變 main）。未合入。本回合未重跑 `test:home-entry`。

### #98 PR-GAP-03 — open，未合入

| 欄位 | 證據 |
|---|---|
| PR | https://github.com/aa0968111723-prog/duigao/pull/98 — **open**，`mergeable_state: dirty` |
| Head | `cursor/p0-voice-truthful-state-70d9` @ `af8c2a4aeee665142d95a4e2683ba94d5b0a6a8d` |
| 範圍 | 語音九態；mute+disconnect 後再 `reconnecting` |

對現行 main dirty。與 #97 在 `voiceToken.ts`／`voice.ts` 需 rebase。V-04 Leave-during-reconnecting 仍屬 #95 dock 契約（incomplete）。本回合未重跑 `test:voice-state`。

### #99 Handoff docs — open，未合入

| 欄位 | 證據 |
|---|---|
| PR | https://github.com/aa0968111723-prog/duigao/pull/99 — **open**，`mergeable_state: clean` |
| Head | `cursor/gap-remediation-handoff-70d9` @ `1e580562a804b2fa1f17c3031a41153d6381a500` |
| 範圍 | `REMAINING.md` + `remaining-gaps.test.ts`，無產品修復 |

### #100 PR-GAP-02 — 已合入 **#95 stack**，不是 main

| 欄位 | 證據 |
|---|---|
| PR | https://github.com/aa0968111723-prog/duigao/pull/100 — **merged** 2026-08-29T14:25:20Z |
| Head | `cursor/p0-files-and-outbox-70d9` @ `782e58646788bbdf754df780b5c0b4ba0a5dec60` |
| Base | `cursor/complete-missing-features-0897` @ `4e5d8b32e1e189e426b2728987d4312135f5ad1f` |
| 範圍 | 誠實 discussion insert／upload、帳號隔離 outbox |

**沒有** 合進 `main`。產品碼只存在 #95 堆疊。本回合未重跑 `test:files-batch`。

### #101 PR-GAP-04 — 已合入 **GAP-02 stack**，不是 main

| 欄位 | 證據 |
|---|---|
| PR | https://github.com/aa0968111723-prog/duigao/pull/101 — **merged** 2026-08-29T14:25:35Z |
| Head | `cursor/p1-mobile-tablet-ux-70d9` @ `4f966a3f74740e4e5b4bd84952a45ced7258ce1e` |
| Base | `cursor/p0-files-and-outbox-70d9` @ `782e586` |
| 範圍 | 手機第一層精簡、平板 split；未改 #78 `src/features/whiteboard/**` |

**沒有** 合進 `main`。本回合未重跑 `test:mobile-tablet-ux`。

### #102 PR-GAP-05 — open draft，疊在 GAP-04

| 欄位 | 證據 |
|---|---|
| PR | https://github.com/aa0968111723-prog/duigao/pull/102 — **open draft** |
| Head | `cursor/p1-realtime-offline-70d9` @ `362218170403d400cc0a3bcaaaabeba17ca1ab25` |
| Base | `cursor/p1-mobile-tablet-ux-70d9` @ `4f966a3` |
| 範圍 | 討論列修補、SPA realtime 拒絕、owner-scoped outbox flush |

Compare：https://github.com/aa0968111723-prog/duigao/compare/cursor/p1-mobile-tablet-ux-70d9...cursor/p1-realtime-offline-70d9?expand=1

未合入 main。Typing／逐人 presence 未建模（incomplete）。本回合未重跑 `test:realtime-offline`。

### PR-GAP-06 本分支 — 文件＋回歸測試，不是 schema 完成

| 欄位 | 證據 |
|---|---|
| 分支 | `cursor/p1-whiteboard-handoff-70d9`（從 #78 head 建立） |
| Base 必須是 | `agent/wb01-canonical-schema`（#78） |
| 做了 | `WHITEBOARD_HANDOFF.md`、本檔、`scripts/tests/whiteboard-handoff.test.ts` |
| 沒做 | 改寫 #78 schema／migration／WhiteboardWorkspace；不上 main；不疊 #95 |

---

## 仍 incomplete（本檔不假裝完成）

- #78 仍 OPEN、**CONFLICTING**；whiteboard `0022`–`0026` 與 main `0022_discussion_author_integrity.sql` 編號碰撞。人類 rebase／renumber。
- #95 仍 OPEN、dirty；TUS／transcode／V-04 dock Leave 仍在該 PR。
- #88 Design Intelligence 暫停。
- #96／#98 對含 #97 的 main 需 rebase。
- 正式站 SPA catch-all（`/functions/v1/*` 回 HTTP 200 HTML）。
- 語音 Leave-during-reconnecting（V-04，#95 `RoomDiscussion`）。
- Typing／逐人 presence（未建模）。
- #100／#101／#102 產品碼不在 main。
- 白板產品 chrome 精修若還要動 `WhiteboardWorkspace.tsx`：等 #78 schema 落地，或只由 #78 作者改。

建議合併順序（人類）：#96 rebase → rebase #98 → #98 → #95 → #100 → #101 → #102 → **renumber 後的 #78** → 本 handoff → #88。
