# BASELINE_AUDIT — 團隊溝通現況稽核

分支 `agent/team-communication-mobile-tablet`｜base `origin/main` @ `2a9d7a0`｜2026-08-29

方法：讀真實原始碼、對真 PostgreSQL 跑真角色探針、`grep` 全 repo 交叉確認。
**沒有把 PR 說明當成已部署功能。**

> 證據等級：
> **[實測]** 我自己在真環境跑出來的（migration harness 輸出、測試輸出）。
> **[原始碼]** 我自己讀過該檔並用 `grep` 全 repo 交叉確認過。
> **[待複驗]** 子代理稽核提出、但對抗驗證輪因網路中斷未完成 —— 不得當成事實。

---

## 1. 現有功能（真的能用的）

| 能力 | 狀態 | 依據 |
|---|---|---|
| 房間層文字討論（發送／讀回） | 可用 | `room_discussion_messages`（0014）＋ `insertDiscussion` [原始碼] |
| 穩定訊息 ID ＋ 冪等重試 | 可用 | client 鑄 uuid 當 PK；`isDuplicateKey`（`errors.ts`）把 23505 當成功 [原始碼] |
| 送出狀態 sending／sent／failed ＋ 重試 | 可用，且**誠實** | `useDiscussionOutbox`：insert 回成功才轉 `acked`，且要等 id 出現在伺服器快照才丟 ghost [原始碼] |
| 12 秒 abort deadline | 可用 | `insertDiscussion` 的 `AbortSignal.timeout(12000)` —— 死區 fetch 懸掛不會卡在 sending [原始碼] |
| 離線回網一次性補送 | 可用 | `window "online"` handler [原始碼] |
| 綁定 re-key（本機房 → 雲端房）不遺失 in-flight | 可用 | `reconcileOutbox` ＋ 既有 8 條測試 [實測] |
| 附件（上傳／預覽／開啟）、連結卡 | 可用 | 0018 ＋ `AttachmentCard` [實測：migrations 有 10 條附件探針] |
| 白板卡／內容卡導航（ContextAnchor） | 可用 | `anchorFromDiscussion` / `openTarget` [原始碼] |
| 決策紀錄（新增／標成已決定） | 可用但很淺 | `decision_records`（0014），UI 只有兩個狀態 [原始碼] |
| 單一「支持」表情 | 可用 | `room_discussion_supports`，PK `(message_id, user_id)` → **不會重複計數** [原始碼] |
| 語音 dock（LiveKit） | 可用，取決於部署密鑰 | `useVoiceRoom` ＋ `voice-token` edge [原始碼] |
| 跨房隔離（RLS） | 可用 | `is_room_member` SECURITY DEFINER；`set search_path=''` [實測] |

---

## 2. 表面存在但無法使用 / 誤導使用者的

| # | 問題 | 證據 |
|---|---|---|
| A1 | **回覆指不回來源**。`replyToId` 寫進資料庫，但 `grep -rn replyToId src/` 顯示**沒有任何 UI 讀它**；畫面只顯示 `payload.quotedBody` —— 送出當下複製的字串。點不下去、來源被編輯後停在舊字、來源被刪除後變成孤兒。 | [原始碼] `RoomDiscussion.tsx:248,326`（修正前）→ **本 PR 已修** |
| A2 | **回覆時只貼一條網址，回覆對象整個消失**。連結卡分支 `if (…test(text) && api.onSendLink?.(text)) { … return; }` 不帶 `replyToId`。 | [原始碼] → **本 PR 已修** |
| A3 | **點了「回覆」之後沒有任何取消方式**。唯一線索是 placeholder，打第一個字就消失，之後每一句都會被當成該則的回覆送出。 | [原始碼] → **本 PR 已修** |
| A4 | **訊息作者可以被偽造**。任何成員都能 insert 一列 `author_user_id = <別人的 uid>`。 | [實測] → **本 PR 已修（0022）** |
| A5 | **管理者可以改寫別人訊息的作者**。 | [實測] → **本 PR 已修（0022）** |
| A6 | **房間搜尋說謊**。輸入框寫「搜尋房間內容」，實際只比對 branch 名稱，卻對討論、企劃內文、附件回「找不到相關內容」。 | [待複驗] `MultiBranchRoom.tsx:825,874` |
| A7 | **三條白板 e2e 檢查寫死 `true`**，永遠不會失敗。 | [原始碼] `collaboration-workspace.mjs:261,269,272` — **不屬本線，已交接** |
| A8 | 語音「還在準備」文案對已設定 LiveKit 的部署也會出現（health 探測失敗一次就整個 session 說謊）。 | [待複驗] |

---

## 3. 資料來源

- **雲端房**：Supabase Postgres 是唯一真相來源。
  `room_discussion_messages`（0014，0018 加 `attachment`/`link` 兩種 kind）。
- **IndexedDB**（`src/lib/store.ts`）：快取＋草稿，**不是**多人房的真相來源。
  快照回來時整包替換。
- **outbox**：只在 React state（見 KNOWN_LIMITATIONS §C）。
- **legacy `messages`（0001）**：唯讀併入 drawer，`payload.legacy = true` 標記，
  互動一律關閉（它們的 id 不在討論表，寫支持會 FK 失敗）。

---

## 4. Realtime channel

一條 channel：`room:${roomId}`，`config.presence.key = userId`（`roomSync.ts:38`）。

討論相關的三個綁定**都是 nudge，不是 row patch**：

```
room_discussion_messages  event:"*"  →  onProjectChange()
room_discussion_supports  event:"*"  →  onProjectChange()
decision_records          event:"*"  →  onProjectChange()
```

`onProjectChange` → 200ms debounce → `loadRoom` 整房重載 → 整包替換。

**這個設計讓「reconnect 重複訊息」在結構上不會發生**：畫面永遠是伺服器快照，
不是事件累積。代價是每一則訊息都觸發一次整房查詢。

Presence 只 `track({ at: Date.now() })`，只讀
`Object.keys(channel.presenceState()).length` —— **只有人數，沒有身分**。

---

## 5. RLS

`room_discussion_messages`（0014 ＋ 本 PR 的 0022）：

| 動作 | Policy |
|---|---|
| SELECT | `is_room_member(room_id)` |
| INSERT | `is_room_member(room_id) and (author_user_id is null or author_user_id = auth.uid())` ← **0022 補上後半** |
| UPDATE | `is_room_member and (author_user_id = auth.uid() or can_manage_media)`，**且 trigger 凍結 `author_user_id` / `room_id` / `created_at`** ← 0022 |
| DELETE | `is_room_member and (author_user_id = auth.uid() or can_manage_media)` — hard delete，**沒有 tombstone** |

`room_discussion_supports`：PK `(message_id, user_id)`，INSERT/DELETE 都綁
`user_id = auth.uid()`。client 的 delete 沒帶 `user_id` 篩選，但 RLS 把範圍
限制在自己那列，所以不會刪掉別人的 —— **不是漏洞，但 client 的意圖與寫法不一致**。

grants：0014 明確 `revoke all … from anon` 並逐動詞 grant。
**但 0001/0002/0005/0012 的老表仍停在 Supabase 預設 `GRANT ALL`（含 RLS 管不到
的 TRUNCATE）** [待複驗，不屬本線 —— 已交接]。

沒有任何 policy 使用 `auth.jwt()` / `user_metadata` [原始碼，全 repo grep]。

---

## 6. 離線流程

```
send → updateRoom（樂觀，寫 IndexedDB）→ outbox entry "sending"
     → 已綁定？dispatch : 等 reconcileOutbox 的綁定補送
     → insert（12s deadline）
        成功 → "acked"（仍當 ghost，等 serverIds 對帳才丟）
        失敗 → navigator.onLine 且本輪沒自動補送過 → 立刻補一次（上限一次）
             → 否則 "failed"，出現重試鈕
     → "online" 事件 → failed 一次性 flush
```

缺口：outbox 不持久（重整就沒了）；切房會直接丟掉 in-flight/failed。

---

## 7. 訊息傳送狀態

`sending` / `sent`（= entry 消失）/ `failed`。**沒有 delivered / read** ——
這是對的：後端沒有 receipt 表，不顯示雙勾就是誠實。

---

## 8. 語音依賴

`VoiceRoomState = "idle" | "connecting" | "live" | "error"`（4 個，任務書要 9 個）。

**語音失敗不阻塞文字**：`RoomDiscussion` 對語音是
`api.voice?.available ? <dock> : <一行說明>`，訊息列表與 composer 不在語音的
載入／錯誤閘後面 [原始碼]。尚無真機證據。

PeerJS 仍在 dependencies 且 `src/lib/peer.ts` 存在（本機房協作），
**沒有**把 PeerJS 連線狀態餵進訊息系統狀態 [原始碼]。

---

## 9. 手機阻塞

已具備：`useViewport()` 發佈 `--kb`（`MultiBranchRoom.tsx:721` 有掛），
composer 是 `position: fixed` 騎在 `--kb` 上，`env(safe-area-inset-bottom)` 有處理。

阻塞：
- **沒有任何捲動管理**（打開停在最舊、送出不捲到自己、沒有新訊息提示）。
  `grep -rn "scrollIntoView|scrollTop|scrollTo" src/` 在討論路徑上只有本 PR
  新加的「跳到來源」[原始碼]。
- 訊息卡的四個操作（回覆／支持／建立投票／加入白板）**永久顯示在每一則旁邊**，
  違反 §七「不要把所有操作永久顯示」。
- 長按是 `onContextMenu`（右鍵事件），手機支援不穩，且選單只有「加入白板」。
- `.rd-actions button { min-height: 32px }` 低於最小點擊區 [原始碼]。
- **[待複驗，需真瀏覽器]** `src/mobile.css:450` 在手機 media query 裡給
  `.project-room` 加了 `min-height: 100dvh; overflow-y: auto;`，而它的祖先
  `.app` 也是 `overflow-y: auto`（`mobile.css:13`）。`.project-room` 沒有
  `height`／`max-height`，所以它會長到內容高度、自己永遠不捲，捲的是 `.app`。
  若成立，任何掛在 `.project-room` 裡的 `position: sticky` 都會失效（sticky
  是相對於**自己的 scrollport**）。討論殼根畫面的 composer 是
  `position: fixed`（`.is-discussion-root .rd-composer`），**不受影響**；
  受影響的是 drawer 的 sticky composer 與 sticky 房間標頭。
  **這條只能用真裝置確認，讀 CSS 不能定案** —— 依 `verify-in-real-browser`
  紀律不在此宣稱成立或不成立。

---

## 10. 平板阻塞

**完全沒有平板佈局**。沒有 split view、沒有雙欄、沒有拖曳訊息到白板。
目前是手機單欄放大 [原始碼，全 repo grep 無 tablet 專屬佈局]。

---

## 11. 重複入口

討論有兩個入口，**共用同一個 `RoomDiscussion` 元件**，不是兩套系統：

1. `MultiBranchRoom`（活動房根畫面，`draft = api.chatInput`）。
2. `DiscussionDrawer`（single 房對稿工作區的 sheet／側欄，`draft` 是自己的
   local state，刻意不與對稿工作區的 `chatInput` 打架）。

`DiscussionPaneTabs` 匯出三個 tab（對話／白板／語音），但實際渲染路徑用的是
`MultiBranchRoom` 內嵌的兩個 tab（對話／白板）—— `DiscussionPaneTabs`
**目前沒有任何使用端**（`grep` 只有定義）。屬於死碼，但不影響行為。

---

## 12. 假成功風險

| 風險 | 現況 |
|---|---|
| 假已讀 | **沒有**已讀功能，所以沒有這個風險。狀態止於 sent。 |
| 假已送達 | 無。`acked` 需要 insert 真的回成功。 |
| 假連線 | 語音有疑慮 [待複驗 V2：LiveKit 自動重連期間仍顯示綠點]。 |
| 假參與者 | 語音有疑慮 [待複驗 V4/V5：非主動斷線不寫 `left_at`]。 |
| 假綠測試 | **有**：三條白板 e2e 寫死 `true`。 |
| 未綁定房的假送出中 | [待複驗 MSG-09] 未綁雲端時每則永遠停在半透明「送出中」。 |

---

## 13. 與 #78、#88 的衝突

| PR | 分支 | migrations | 與本線檔案衝突 |
|---|---|---|---|
| [#78](https://github.com/aa0968111723-prog/duigao/pull/78) | `agent/wb01-canonical-schema` | 0022–0026（白板） | **無 schema 衝突**。可能在 `scripts/e2e/migrations.mjs`（各加各的 section）與 `MultiBranchRoom.tsx`（不同區塊）文字衝突 |
| [#88](https://github.com/aa0968111723-prog/duigao/pull/88) | `agent/design-intelligence-perplexity` | 0027（design knowledge） | 無 |
| DI02–DI06 | 五條分支共用 0028 | 0028 | **無 PR 追蹤 —— 需要人類處理** |

本線取 **0022**（repo 的 release gate 要求編號連續，見 MIGRATION_RESERVATION）。
套用順序風險見 `MIGRATION_RESERVATION.md` 與 handoff。

---

## 14. 可以安全立即修改的檔案

`src/features/room-discussion/*`、`src/features/collaboration/replies.ts`（新增）、
`src/hooks/useDiscussionOutbox.ts`、`src/hooks/discussionOutboxCore.ts`、
`src/cloud/collaborationRepository.ts` 的討論函式、
`scripts/tests/discussion-*.test.ts`、`scripts/e2e/migrations.mjs` 的新 section。

---

## 15. 需要等上游合併的修改

- 任何新 migration（mentions、receipts、reactions 多表情、tasks、pins）——
  等 #78／#88／DI 的合併順序定案。
- 白板端的引用／拖曳整合 —— 等 #78 的 canonical schema 落地。
- `collaboration-workspace.mjs` 的白板手勢假綠檢查 —— #78 正在重寫該區。
