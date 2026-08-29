# 全站目標未完成 — 完成度審計（`2192774` + 本 harness 修補）

本檔是對 **原始全站目標** 的完成度審計，不是「這條 stack 已做完」的證明。
可信度：程式碼 → migrations → tests → Git / CI → production curl → 本檔。
本檔不可單獨讓任何列變成 evidenced。沒有當下證據的列不得寫 evidenced。
禁止把成功重新定義成「#120/#124/#125 已存在」。

| 鍵 | 值 |
|---|---|
| 審計時間（UTC） | 2026-08-29 18:35 |
| 本 tip SHA | 本檔落地後的 HEAD（harness 修補）。產品討論碼與 `2192774` 相同。 |
| 已核對 SHA | `21927746ba7c5157961fca8b3ab4cdb05cff4c79` |
| 本 PR | [#125](https://github.com/aa0968111723-prog/duigao/pull/125) `cursor/p0-discussion-mentions-todos-70d9` |
| 底層 stack | [#124](https://github.com/aa0968111723-prog/duigao/pull/124) `10c9109` → [#120](https://github.com/aa0968111723-prog/duigao/pull/120) `c5a61f1` → `main` `cd7eb5f` |
| `origin/main` | `cd7eb5fcff13451b31447d64dc72dd58d534e18f`（本回合未前進） |
| #113 / #114 | **已合進 main**：`6da2af7`（#113）、`3c0bf0c`（#114）。`git merge-base --is-ancestor` 皆 YES。 |
| 最新公開 migration | stack tree：`0032_discussion_mentions_todos.sql`。main：`0030`。**禁止 0033。** |
| `agent:gate` | 本機於 `2192774` **PASS**（`PASS: AUTOMERGE REQUIRES AGENT_GATE_PASS`）。不是 GitHub `agent-read-layer` job。 |
| 生產 | `https://duigao-k7q2.zeabur.app/` — 見下方 curl。**404 JSON ≠ API 成功。** |

狀態只能是 **evidenced** / **incomplete** / **unmodeled** / **deploy-blocked**。
evidenced = 本 tip 有 source + 對應 test（可加 artifact）。不是「目標完成」、不是「已上線」。

---

## 1. session / room

| 交付 | 狀態 | 證據 |
|---|---|---|
| guest `sessionEntryStatus` 分態（載入／空房／權限／邀請無效） | evidenced | `src/cloud/sessionEntryStatus.ts`；`scripts/tests/session-entry.test.ts`（含 empty-room、permission-denied、invite-invalid、不把 local-only 當空房成功） |
| Home 離線／未設定雲端，不 canned 成功 | evidenced | `src/components/homeEntryStatus.ts`；`scripts/tests/home-entry.test.ts`（offline、`服務尚未設定`、禁止「分享連結已建立」） |
| reviewer／guest 無上傳／取代／封存／刪除媒體 | evidenced | `src/cloud/useCloudRoom.ts` `canManageMedia`；`src/App.tsx` 檢視者守衛；`supabase/migrations/0007_room_capabilities.sql`；agent-layer `REVIEWER_NO_MEDIA` |
| 邀請 secret 只在 URL fragment | evidenced | `src/cloud/invite.ts` `buildInviteUrl` / `readInviteFromUrl`；`scripts/tests/collaboration-workspace.test.ts`；`scripts/tests/remaining-gaps.test.ts` |
| 雙人同時進同一房（生產） | incomplete | 本 tip 無兩客戶端生產錄影。e2e 只是本機 fixture。 |
| LINE / 實體裝置進房 | incomplete | 無裝置或 LINE 通道證據。`scripts/e2e/video-flow.mjs` 有 LINE UA 字串，不是實機／LINE 通道。 |

---

## 2. discussion / files

| 交付 | 狀態 | 證據 |
|---|---|---|
| 討論寫入走 `acceptDiscussionInsert`；失敗進 outbox | evidenced | `src/cloud/discussionWrite.ts`；`scripts/tests/discussion-files-batch.test.ts`；`scripts/tests/collaboration-workspace.test.ts` |
| 附件走 `acceptStorageUpload` + 0018 `room_discussion_attachments` | evidenced | `src/cloud/discussionWrite.ts`；`scripts/tests/discussion-files-batch.test.ts`；`scripts/e2e/collaboration-workspace.mjs` |
| outbox 依 owner 隔離 | evidenced | `src/hooks/discussionOutboxCore.ts` `isolateOutboxForOwner`；`scripts/tests/discussion-files-batch.test.ts`；`scripts/tests/realtime-offline.test.ts` |
| TUS 續傳（本 tree 客戶端） | evidenced | `src/cloud/tusUpload.ts`；`scripts/tests/upload-pipeline.test.ts`；`scripts/e2e/video-flow.mjs` TUS 段 |
| 0031 tombstone（軟刪、作者或 `can_manage`、跨房 room_id 凍結） | evidenced | `supabase/migrations/0031_discussion_tombstone_unread.sql`；T-01…T-10 `scripts/tests/discussion-tombstone-unread.test.ts`；`scripts/e2e/migrations.mjs` `0031：討論 tombstone + 未讀水位 RLS` |
| 0031 `deleted_by` 以 caller 覆寫（不 coalesce） | evidenced | 0031 + 0032 皆 `new.deleted_by := caller`；T-10 |
| 0031 `room_discussion_reads` 自己列水位 | evidenced | 0031 RLS；T-07；**不是已讀回條** |
| 未讀跳轉不把水位推到最新 | evidenced | `src/features/room-discussion/RoomDiscussion.tsx` `suppressReadFromJump`；T-07 掃描該符號；`scripts/e2e/collaboration-workspace.mjs`「未讀跳到水位之後」 |
| 0032 `@` 提及（同房成員、作者 INSERT、禁 UPDATE） | evidenced | `supabase/migrations/0032_discussion_mentions_todos.sql`；M-01…M-05、M-08 `scripts/tests/discussion-mentions-todos.test.ts` |
| 0032 待辦草稿（作者或 `can_manage` 完成、`isMemberActor`） | evidenced | 0032；`src/features/collaboration/discussionHonesty.ts` `canCompleteRoomTodo`；M-04…M-08 |
| 0032 typing = ephemeral presence `typing: boolean` | evidenced | `src/cloud/useCloudRoom.ts` `setTyping`；`src/cloud/roomSync.ts` presence `typing`；M-06。**無 typing table。** |
| Split View 討論軌不掛待辦欄 | evidenced | `src/features/multi-room/MultiBranchRoom.tsx` `showTodos: false`；`bad534b` CI `test:visual` **success**（run `33267190274` job `browser` 18:04:46Z） |
| 討論表情（支持以外） | unmodeled | `room_discussion_supports` 只有存在列，無 `reaction_type`。第二種表情要 0033。D-11 `scripts/tests/discussion-honesty.test.ts` 鎖住。 |
| `kind: quote` 獨立引用氣泡 | unmodeled | 0014/0018 CHECK 有 kind，**零 producer**。誠實引用 = `reply_to_id`。D-12 鎖住。 |
| 已讀／雙藍勾／回條 | unmodeled | 禁止做。水位 ≠ 回條。D-06、T-03、T-07、M-06。 |
| 討論附件／TUS 在**生產** bucket 可讀 | deploy-blocked | 本 tip 未對生產 DB／Storage 驗證。origin `/rest/v1/` 為 JSON 404。 |

---

## 3. voice

| 交付 | 狀態 | 證據 |
|---|---|---|
| 九態，中間態不可當成功 | evidenced | `src/features/voice/voiceState.ts`；`scripts/tests/voice-state.test.ts` |
| dock 僅 connected／live 顯示離開 | evidenced | `src/features/room-discussion/voiceDockLeave.ts` `voiceDockShowsLeave`；`src/features/room-discussion/RoomDiscussion.tsx`；`scripts/tests/voice-dock-leave.test.ts` |
| 未設定 LiveKit 文案 | evidenced | `src/features/collaboration/voice.ts` `語音服務尚未設定`；voice-state / remaining-gaps 掃描 |
| token 失敗走 `parseFunctionPayload`，404 JSON 不是成功 | evidenced | `src/cloud/voiceToken.ts`；`src/cloud/apiResponse.ts`；`test:api-response` |
| **生產** LiveKit / `voice-token` | deploy-blocked | 本回合 curl：`GET /functions/v1/voice-token` → **HTTP 404** `application/json` `{"ok":false,"code":"NOT_FOUND","message":"this origin has no API"}`。見 `/opt/cursor/artifacts/production-curl-2026-08-29-1805.txt`。 |

---

## 4. mobile / tablet

| 交付 | 狀態 | 證據 |
|---|---|---|
| 第一層只有 對話／白板；總覽／AI／檔案在「更多」 | evidenced | `src/features/multi-room/roomChrome.ts` `FIRST_LAYER_TABS` / `firstLayerChrome`；`src/features/multi-room/MultiBranchRoom.tsx` `data-testid=room-more-sheet`；`scripts/tests/mobile-tablet-ux.test.ts` |
| 手機聚焦輸入時收起 chrome（`hideRoomChrome`） | evidenced | `roomChrome.ts`（`composerActive && width < 768`）；`mobile-tablet-ux.test.ts`「focused composer hides phone chrome」 |
| Split View ≥768 | evidenced | `isTabletSplitWidth`；`scripts/e2e/mobile-tablet-ux.mjs` |
| 視覺基線 | evidenced（`bad534b` CI） | run `33267190274` `npm run test:visual` **success**。`b17772c` 只改本檔，其 browser 尚未結束，不得把該 SHA 的 visual 標 evidenced。 |
| 實體手機／平板手勢 | incomplete | 無實機。e2e 是 Chromium 寬度。 |

---

## 5. realtime / offline

| 交付 | 狀態 | 證據 |
|---|---|---|
| realtime payload 經驗證才進 store | evidenced | `src/cloud/realtimeApply.ts` `acceptRealtimePayload`；`src/cloud/roomSync.ts`；`scripts/tests/realtime-offline.test.ts` |
| `online` 才 flush outbox | evidenced | `src/hooks/discussionOutboxCore.ts` `flushOutboxOnOnline`；`src/hooks/useDiscussionOutbox.ts`；同上 |
| 本機 e2e 五條 | evidenced（`bad534b` CI） | `scripts/e2e/realtime-offline.mjs`；run `33267190274` `test:realtime-offline-e2e` **success**。 |
| 兩客戶端生產即時 | incomplete | 無生產雙端錄影。 |

---

## 6. whiteboard（#113 之後）

| 交付 | 狀態 | 證據 |
|---|---|---|
| 0024–0028 在本 tree | evidenced | `0024_whiteboard_canonical_columns.sql` … `0028_whiteboard_freehand.sql`；`scripts/e2e/migrations.mjs` `0024–0028：canonical whiteboard schema（WB01）` |
| 白板 OCC／tombstone／context 不含墓碑 | evidenced | 同上 migrations 段；`scripts/tests/whiteboard-operations.test.ts`；`scripts/tests/whiteboard-realtime.test.ts` |
| 獨立 `whiteboard-rls.test.ts` / `whiteboard-client.test.ts` | unmodeled | **本 tip 無這兩個檔。** 不得用假路徑充證據。RLS 證據在 `migrations.mjs` 0024–0028。 |
| #113 已 merge 進 `main` | evidenced | `origin/main` `cd7eb5f` 的祖先 `6da2af7` = `PR-RESOLVE-06 … (#113)`。**合進 main ≠ 已部署到生產 DB。** |
| 生產白板 schema | deploy-blocked | 未對生產 DB 跑 0024–0028。禁止本 agent 改生產 DB。 |

---

## 7. AI / external（#114 之後）

| 交付 | 狀態 | 證據 |
|---|---|---|
| 0029–0030 在本 tree | evidenced | `0029_design_knowledge.sql`、`0030_design_research_usage.sql` |
| 不把 SPA HTML / 假 vision 當成功 | evidenced | `src/features/design-intelligence/honesty.ts` `looksLikeSpaHtml`、`NO_FAKE_VISION`；`scripts/tests/ai-external-handoff.test.ts` |
| Canva / CUTOS client 走 `parseFunctionPayload` | evidenced | `src/cloud/canva.ts`、`src/cloud/cutos.ts` |
| G7-07 契約（標題聲明未完成、禁止完成旗標） | evidenced | `scripts/tests/ai-external-handoff.test.ts` G7-07；本檔標題為「全站目標未完成」 |
| #114 已 merge 進 `main` | evidenced | `origin/main` 祖先 `3c0bf0c` = `PR-RESOLVE-07 … (#114)`。**合進 main ≠ 生產 functions／secrets。** |
| `asset-analysis` / `room-ai-context` client 走 `parseFunctionPayload` | incomplete | `src/cloud/assetIntelligence.ts` `enqueueAssetAnalysis` / `retryAssetAnalysis` / `askRoomContext` 只看 `error`，HTML／空物件可當成功。#125 修 video harness 時不混這條。另開分支。 |
| 生產 Perplexity / Canva / CUTOS secrets 與 functions | deploy-blocked | 本回合未驗證任何 provider secret。origin `/functions/v1/*` 為 JSON 404。 |

---

## 8. RLS

| 交付 | 狀態 | 證據 |
|---|---|---|
| 0014–0032 探針在 repo | evidenced | `scripts/e2e/migrations.mjs`；`bad534b` CI job `migrations` **success**（run `33267190274`） |
| 0031 tombstone / unread RLS | evidenced | migrations.mjs `0031：討論 tombstone + 未讀水位 RLS` |
| 0032 mentions / todos RLS | evidenced | migrations.mjs `0032：討論提及 + 待辦草稿 RLS` |
| 本回合重跑 385 probes | incomplete | 本審計回合**未**重跑 `npm run test:migrations`。不得把記憶中的 385/385 寫成本回合證據。 |
| 生產 Postgres 已套 0031/0032 | deploy-blocked | **未套用。禁止本 agent 改生產 DB。** |
| 遠端 `supabase` CLI 對帳 | unmodeled | 本環境無 `supabase` CLI。 |

---

## 9. 不造假成功

| 交付 | 狀態 | 證據 |
|---|---|---|
| 函式／REST 404／HTML 不可當 JSON 成功 | evidenced（client） | `src/cloud/apiResponse.ts`；`scripts/tests/api-response.test.ts` |
| 生產 origin 有 API | deploy-blocked | 本回合 18:06 UTC：`/functions/v1/voice-token`、`/rest/v1/`、`/api/health` 皆 **HTTP 404** + `application/json` + `code: NOT_FOUND`。`/` 為 SPA HTML 200。見 artifact。 |
| 本機 `npm run agent:gate` @ `2192774` | evidenced | 本回合跑過，exit 0，印出 `PASS: AUTOMERGE REQUIRES AGENT_GATE_PASS`。含 `build:local`。 |
| GitHub `agent-read-layer` @ `2192774` | evidenced | run `33268176132` **success**。 |
| CI browser @ `bad534b` | evidenced | run `33267190274` **success**（含 `test:video`）。 |
| CI browser @ `2192774` | incomplete | run [`33268176148`](https://github.com/aa0968111723-prog/duigao/actions/runs/33268176148) **failure**。`build` / `migrations` / `agent-read-layer` success。`test:collaboration-e2e` **success**（未讀跳轉）。`test:video` **failure**：`playerReady` `waitForSelector('video.v-video')` 45s。本 tip 把等待改成 90s + 誠實失敗卡 + dump，**本 tip 的 browser 尚未跑。不得寫綠。** |
| CodeRabbit 1-check success | unmodeled | 「Review skipped: draft」不是產品 CI。 |
| 已讀回條 UI | unmodeled | 禁止。 |

---

## 10. 堆疊 / merge / 舊稿（不是產品功能，但是目標阻礙）

| 交付 | 狀態 | 證據 |
|---|---|---|
| #120 / #124 / #125 依序存在 | evidenced | GitHub PR API。**存在 ≠ merge。** |
| 三 PR merge 且 main 含 0031/0032 | deploy-blocked | 皆 draft。`AUTOMERGE REQUIRES AGENT_GATE_PASS`。本 agent 不 merge。 |
| 舊稿 #95→#115、#88、#104、#119、#78 | deploy-blocked | 仍 open / CONFLICTING / 過期。與本 tip 並行，不是本 tip 的完成證明。 |

---

## 本回合生產 curl（2026-08-29 18:27 UTC）

```
GET https://duigao-k7q2.zeabur.app/functions/v1/voice-token
  HTTP 404  application/json  {"ok":false,"code":"NOT_FOUND","message":"this origin has no API"}
GET https://duigao-k7q2.zeabur.app/rest/v1/
  HTTP 404  application/json  （同上）
GET https://duigao-k7q2.zeabur.app/api/health
  HTTP 404  application/json  （同上）
GET https://duigao-k7q2.zeabur.app/
  HTTP 200  text/html  SPA
```

**404 JSON 不是 API 成功。** 比先前「HTML 200 catch-all」更誠實，仍不是 LiveKit / functions / 已部署。

---

## 本回合不做的事

- 不 merge、不 deploy、不改生產 DB、不 force-push。
- 不發明 0033。不發明已讀／雙藍勾。
- `2192774` browser 已 terminal **紅**（`test:video`）。不把尚未重跑的 harness 修補寫成綠。
- 不把 #113/#114「未合 main」寫進本檔；它們已在 `cd7eb5f` 祖先上。
- `asset-analysis` invoke 誠實閘另開分支，不推進 in-flight／剛紅的 #125 產品討論碼。
