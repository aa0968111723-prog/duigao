# 全站目標未完成

本檔是對全站目標的完成度審計，**不是完成證明**。
可信度：程式碼 → migrations → tests → Git / CI → production curl → 本檔。
本檔不可單獨讓任何列變成 IMPLEMENTED。沒有當下證據的列不得寫 IMPLEMENTED。
禁止把成功重新定義成「#163–#167 已存在」或「四職綠」。

| 鍵 | 值 |
|---|---|
| 審計時間（UTC） | 2026-08-30 01:13 |
| `origin/main` | `ee835f130c11e6409948e5c45862e25fab32c284`（#161 squash）。本回合未前進。 |
| 本 PR | [#164](https://github.com/aa0968111723-prog/duigao/pull/164) `cursor/p0-discussion-tombstone-honesty-70d9` |
| 本 tip（寫檔前） | `f7a183698cefa4a54f2fae22884fb37d48d3cf30` |
| 生產 SPA | `https://duigao-k7q2.zeabur.app/` `200` · bundle `/assets/index-DNDzqryJ.js` · `505972` bytes |
| 真 API | `https://uanurolzzgshxrqbooix.supabase.co`。SPA origin JSON 404 ≠ API 成功。 |
| 禁止 | merge / deploy / 套用 0031·0032 到生產 / 發明 0033 / 已讀回條 / typing table / `kind:quote` |

狀態只准：

- **IMPLEMENTED** — 本 tip 或已合進 `main` 的 source + 對應 test；若宣稱 live，還要有當下 production 證據。
- **OPEN** — 開著的產品 PR，四職綠也不算合進 main、不算已部署。
- **schema-ahead（不是 IMPLEMENTED）** — UI 已在 live bundle，對應欄／表不在生產 DB。
- **leftover** — 過期 DIRTY 開 PR，不 rebase。
- **unmodeled** — 無 schema / 無誠實 producer。禁止發明。

---

## 1. 已合進 main（source + test；live 另標）

First-parent since `cd7eb5f`：`#120` `92e1df3` → `#127` `aa988a5` → `#143` `1575d09` → `#153` `0f3bf5d` → `#159` `a80e73f` → `#160` `2227fe3` → `#161` `ee835f1`。

| 交付 | 狀態 | 證據 |
|---|---|---|
| guest `sessionEntryStatus`（空房／權限／邀請無效） | IMPLEMENTED（source+test；live 有 `session-entry-status`） | `src/cloud/sessionEntryStatus.ts`；`scripts/tests/session-entry.test.ts`；live bundle 含 `session-entry-status` |
| 同頁 `hashchange` 重讀房間連結 | IMPLEMENTED（source+test；live `hashchange`=3） | `#159` squash；`scripts/tests/remaining-gaps.test.ts` / room-link 測試；live bundle |
| 討論草稿 hydrate 不蓋已打的字 | IMPLEMENTED（source+test；live `data-draft-ready`） | `#160` squash；`scripts/tests/discussion-draft-hydrate.test.ts` |
| 討論 insert 必須 `select("id")`，零列不是送出 | IMPLEMENTED（source+test；live `select("id")`） | `#143` squash；`src/cloud/collaborationRepository.ts` `insertDiscussion`；`src/cloud/discussionWrite.ts` `acceptDiscussionInsert`；`scripts/tests/discussion-insert-ack.test.ts` |
| 素材 AI policy 寫入必須有列 | IMPLEMENTED（source+test；合進 main） | `#127` squash；`src/cloud/assetAiPolicyAck.ts` |
| 邀請 secret 只在 URL fragment | IMPLEMENTED | `src/cloud/invite.ts`；collaboration / remaining-gaps tests；agent gate |
| reviewer 無上傳／取代／封存／刪除媒體 | IMPLEMENTED | `canManageMedia`；`0007_room_capabilities.sql`；agent gate `REVIEWER_NO_MEDIA` |
| 原稿不可改 | IMPLEMENTED | 上傳只建 version-addressed 物件；agent gate `ORIGINAL_MEDIA_IMMUTABLE` |
| 0031 SQL **在 repo** | IMPLEMENTED（檔案+測試；**不是生產 DB**） | `supabase/migrations/0031_discussion_tombstone_unread.sql`；`scripts/tests/discussion-tombstone-unread.test.ts`；`scripts/e2e/migrations.mjs` |
| SPA origin `/rest` `/functions` `/api` 當成功 | IMPLEMENTED（client 拒 HTML／缺欄） | `src/cloud/apiResponse.ts`；`scripts/tests/api-response.test.ts`。origin 仍 404 JSON `NOT_FOUND`。 |

手機聚焦收 chrome、realtime outbox、語音離開鈕：source 在 `#120` squash 上。函式名被 minify，不得用 live 字串 `hideRoomChrome` / `voiceDockShowsLeave` 當 production 證據。

---

## 2. schema-ahead（live UI，生產 DB 沒有 — 不是 IMPLEMENTED）

2026-08-30 01:13 UTC 對生產 PostgREST + live bundle：

| Live UI（`index-DNDzqryJ.js`） | 生產 DB | 為什麼不是 IMPLEMENTED |
|---|---|---|
| `這則討論已刪除` / tombstone 按鈕 | `PATCH deleted_at` → **400 PGRST204** 欄不存在 | #161 UI 已部署；0031 未套用。失敗路徑仍會先畫墓碑（#164 才修，未部署）。 |
| `jump-first-unread` / `holdingFirstUnread` / `room_discussion_reads` | `GET room_discussion_reads` → **404 PGRST205** | 未讀跳轉會假裝雲端記住水位（#167 才修，未部署）。 |
| — | `room_discussion_mentions` / `room_todos` → **404 PGRST205** | 0032 不在 live bundle（`mention-picker`=0、`discussion-todo`=0）。 |

**禁止本 agent 把 0031/0032 套到生產。**

---

## 3. 開著的誠實 PR（#163–#167）— OPEN，不是 IMPLEMENTED

皆 draft 已關、base `ee835f1`、`mergedAt=null`、head **不是** `origin/main` 祖先。四職（build / migrations / browser / agent-read-layer）= SUCCESS。未部署（live 無其 marker）。

| PR | Head | 修什麼 | 本機 390/768 證據 |
|---|---|---|---|
| [#163](https://github.com/aa0968111723-prog/duigao/pull/163) | `fe19c6977ed57a0c61b0a186fa4ab52b53a62702` | 0032-only 提及／待辦（mock DB，不是生產 0032） | `pr163_todo_draft_{390,768}.png`、`pr163_mention_picker_{390,768}.png` |
| [#164](https://github.com/aa0968111723-prog/duigao/pull/164)（本枝） | `f7a183698cefa4a54f2fae22884fb37d48d3cf30` | 雲端 tombstone 沒 ack 不得畫「已刪除」；UPDATE 必須 `select("id")` | `pr164_tombstone_fail_ack_{390,768}.png`：toast「這則討論沒有刪除」，列仍在 |
| [#165](https://github.com/aa0968111723-prog/duigao/pull/165) | `4329a84e020e650fbd60ebcc16cd8b3c51b8dcf5` | 未 `SUBSCRIBED` 不可畫「已同步／N 人在線」 | `pr165_join_before_subscribed_{390,768}.png`：presence 空 |
| [#166](https://github.com/aa0968111723-prog/duigao/pull/166) | `d14772ad6dc7e7ea09e8b27b13bc74ed56af1119` | realtime DELETE 必須 `room_id=eq.` | 單元／e2e 在該 PR；無新 UI 字串 |
| [#167](https://github.com/aa0968111723-prog/duigao/pull/167) | `f7e10d5b87711de016675f78519b99eedae13e8c` | 未讀水位 upsert 失敗不可假裝雲端已記住 | `pr167_mark_read_fail_ack_{390,768}.png`：「第一則未讀 2」仍在 |

本 tip source（#164 only）：

- `applyTombstoneAfterCloudAck` — `src/features/collaboration/discussionHonesty.ts`
- 綁定房先 `writes.tombstoneDiscussion`，失敗 toast「這則討論沒有刪除，請稍後再試。」— `src/App.tsx`
- T-10 / T-11 — `scripts/tests/discussion-tombstone-unread.test.ts`

Artifacts：`/opt/cursor/artifacts/pr164_*.png` 等；`/opt/cursor/artifacts/honesty-viewport-evidence.json`。

---

## 4. leftover DIRTY 開 PR（不 rebase）

`#126`–`#157` 除已 squash 進 main 的對應項與乾淨 replay 外，一律 **leftover**。不要 rebase、不要再開一波 ack。`#125` 不要改 base。

已知 leftover 零列 ack 稿（皆 OPEN，不是 IMPLEMENTED）：`#132`–`#149`（房間名／分支／企劃／投票／關係／聊天／回覆／支持／白板／決策／版本…）。本機 comment／stroke 維持 undo+toast，不再開 ack 枝。

`#162` 是舊 #161 stack 上的 0032 replay，3/4 影片 flake — **不要 empty-rerun**。

---

## 5. unmodeled（禁止發明）

| 項目 | 狀態 | 鎖 |
|---|---|---|
| 已讀回條／雙藍勾 | unmodeled | 0031 `room_discussion_reads` 是自己的水位，不是回條 |
| typing table | unmodeled | 不鑄 0033 |
| `kind:quote` 獨立氣泡 | unmodeled | CHECK 允許；零誠實 producer。引用走 `reply_to_id` |
| 六種討論表情 | unmodeled | 只有 `room_discussion_supports` 存在列 |
| 0033+ | unmodeled | 下一個號是 0032（#163），且 0032 未合 main、未套生產 |

---

## 6. 本回合生產 curl（2026-08-30 01:13 UTC）

```
GET https://duigao-k7q2.zeabur.app/
  HTTP 200  text/html  SPA  bundle=/assets/index-DNDzqryJ.js  505972
GET https://duigao-k7q2.zeabur.app/functions/v1/voice-token
  HTTP 404  application/json  {"ok":false,"code":"NOT_FOUND","message":"this origin has no API"}
GET https://duigao-k7q2.zeabur.app/rest/v1/
  HTTP 404  application/json  （同上）
GET https://duigao-k7q2.zeabur.app/api/health
  HTTP 404  application/json  （同上）
GET  …/rest/v1/room_discussion_reads       404 PGRST205
GET  …/rest/v1/room_discussion_mentions    404 PGRST205
GET  …/rest/v1/room_todos                  404 PGRST205
PATCH room_discussion_messages deleted_at  400 PGRST204
```

Artifact：`/opt/cursor/artifacts/prod-recurl-final-evidence-164.log`

**404 JSON 不是 API 成功。PGRST205/204 不是「功能已上線」。**

---

## 7. 本回合不做的事

- 不 merge、不 deploy、不改生產 DB、不 force-push、不 empty-rerun。
- 不發明 0033／已讀回條／typing table／`kind:quote`。
- 不把 #163–#167 四職綠寫成全站完成。
- 不把 schema-ahead live UI 寫成 IMPLEMENTED。
- 本檔是 #164 上的文件提交，掛在已有產品 diff 上；**不是 docs-only PR**。
