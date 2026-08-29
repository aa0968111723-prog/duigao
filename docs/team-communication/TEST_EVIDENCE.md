# TEST_EVIDENCE — 團隊溝通線

分支 `agent/team-communication-mobile-tablet`｜base `2a9d7a0`｜commit `f2adcb8`

規則：這份檔只放**實際跑過並貼出輸出**的證據。沒跑過的一律寫在
「尚未執行」，不寫成綠燈。

---

## 1. 環境

| 項目 | 值 |
|---|---|
| OS | Windows 11 (10.0.26200) |
| Node | v26.3.0 |
| npm | 11.16.0 |
| PostgreSQL（migration harness） | `D:/pgsql-dl/x/pgsql/bin`（`PG_BIN` 指定） |
| worktree | `D:/duigao-comm` |

> 註：本機是共用機器，同時跑多個 agent。第一次跑 `test:migrations` 時因為
> 前一輪殘留的 cluster 佔住 55432 而炸掉（`pg_ctl … start` 失敗）——
> 那是負載/連接埠衝突，不是程式碼紅燈。清掉殘留 process 後重跑才是有效結果。

---

## 2. Migration / RLS（真 PostgreSQL、真角色）

指令：

```bash
PG_BIN=/d/pgsql-dl/x/pgsql/bin npm run test:migrations
```

| 時點 | 結果 |
|---|---|
| base（`2a9d7a0`，未動任何東西） | **242/242 通過** |
| 加入 9 條作者完整性探針、尚未修 | **246/248 通過** — 2 條紅燈，都是真缺陷 |
| 加入 `0029` 第一版（`security invoker`） | **243/251** — 8 條紅燈，**修錯了**（見下） |
| 加入 `0029` 第二版（`security definer`） | **251/251 通過** |
| 修掉自己寫的假綠探針＋補表情回應 RLS | **257/257 通過** |

### 2.1 缺陷存在的證據（修之前）

```
討論訊息作者完整性：0014 room_discussion_messages
  ✓ 成員可以用自己的 uid 發討論訊息
  ✗ 冒名發訊息（author_user_id 填別人的 uid）被擋 — reviewer 成功以 owner 身分發言 — 決策證據可被偽造
  ✓ 作者不能把自己的訊息改成別人發的
  ✗ 管理者也不能改寫訊息作者（洗白作者身分） — can_manage_media 不該等於可以重寫作者
  ✓ 非成員不能對別人的房間發訊息
  ✓ reply_to_id 不能指向別的房間的訊息
```

### 2.2 第一版修法是假綠（如實記錄）

`0029` 的 trigger 一開始寫成 `security invoker`。`authenticated` 沒有 schema
`auth` 的 USAGE，於是：

```
✗ 成員可以用自己的 uid 發討論訊息 — ERROR:  permission denied for schema auth
  ...new.author_user_id is not null and new.author_user_id <> (select auth.uid()...
  PL/pgSQL function public.guard_discussion_message_write() line 5 at IF
```

冒名的那條探針「通過」了 —— 但通過的原因是**每一則**討論訊息都寫不進去。
只看負面探針會誤判成修好了。成對的正面探針（「成員可以用自己的 uid 發討論
訊息」「重跑 0014 之後成員仍然發得出自己的訊息」）才把它抓出來。

### 2.3 修好之後

```
討論訊息作者完整性：0014 room_discussion_messages
  ✓ 成員可以用自己的 uid 發討論訊息
  ✓ 冒名發訊息（author_user_id 填別人的 uid）被擋
  ✓ 作者不能把自己的訊息改成別人發的
  ✓ 管理者也不能改寫訊息作者（洗白作者身分）
  ✓ 非成員不能對別人的房間發訊息
  ✓ reply_to_id 不能指向別的房間的訊息

協作工作台：0014 可以重跑
  ✓ 重跑 0014 之後 tables / policies / triggers 數量不變
  ✓ 重跑 0014 之後仍然擋得住冒名發訊息（0029 的 trigger 不被 replay 洗掉）
  ✓ 重跑 0014 之後成員仍然發得出自己的訊息（護欄沒有擋到正常路徑）

251/251 通過
```

### 2.4 我自己寫出來的假綠（對抗審查抓到的）

第一版的跨房回覆探針欄位數與值數對不上：

```js
insert into ... (room_id, author_user_id, author_name, body, reply_to_id)   // 5 欄
values ('<otherRoom>', '<otherRoom>', '<owner>', 'Owner', '跨房回覆', '<honestMsg>')  // 6 值
```

SQL 語法錯 → 每次都失敗 → `.failed` 永遠是 true → **探針永遠綠，而且通過的
原因跟外鍵毫無關係**。這正是我在別處指出的那一類缺陷（白板三條 `check(…, true)`），
出現在我自己新加的測試裡。

修法不只是把欄位補對，而是**配一個正向對照**：同一句話拿掉 `reply_to_id`
必須寫得進去。只驗負面的話，任何一種失敗都會讓探針變綠。

```
✓ reply_to_id 不能指向別的房間的訊息（且同一句話拿掉 reply_to_id 就寫得進去）
```

### 2.5 表情回應的 RLS（原本零探針）

`room_discussion_supports` 是討論路徑上唯一一張完全沒有 RLS 探針的表。
client 的「取消支持」是 `delete ... eq(message_id).eq(room_id)`，
**沒有帶 `user_id`** —— 它靠的正是 delete policy 把範圍收斂到自己那列。
沒有探針的話，policy 一旦鬆掉，「取消自己的支持」會變成「清掉所有人的支持」
而沒有人會發現。

```
表情回應：0014 room_discussion_supports RLS
  ✓ 成員可以支持一則訊息（user_id 由 default auth.uid() 填）
  ✓ 同一人同一則不會重複計數（PK 擋住）
  ✓ 不能以別人的身分支持
  ✓ 取消支持只會刪掉自己那一列（client 的 delete 沒帶 user_id，靠 RLS 收斂）
  ✓ 非成員讀不到也寫不了別房的表情回應
  ✓ 支持不能指向別的房間的訊息（複合外鍵）
```

**RLS 驗證涵蓋**：跨房隔離（reviewer 讀不到另一間房）、匿名讀不到討論、
非成員不能寫別房、作者綁定、作者不可變更、跨房 `reply_to_id` 被 FK 擋下、
表情回應的身分綁定與取消範圍。全部用
`set role authenticated; set request.jwt.claim.sub = '<uid>'`，**不是超級使用者**。

---

## 3. 單元測試

```bash
npm run test:collaboration
```

| 時點 | 結果 |
|---|---|
| base | **79 pass / 0 fail** |
| 本次 | **106 pass / 0 fail**（+12 引用解析、+5 快照合併、+10 回覆順序） |

新增的 27 條：

- **引用解析（12）** — 任務書 §七 要求的回覆情境：一般訊息、附件、
  **已編輯的來源**、**來源被刪除／回覆先於來源到達**、連結卡、白板卡、
  outbox ghost、自我回覆、截斷、空內容。
- **快照合併（5）** — 伺服器有回答就採用（空陣列也算）、查詢失敗保留現況、
  **換房不沿用上一間房的訊息**、首次載入失敗不偽造空陣列。
- **回覆順序（10）** — 來源在 sending／acked／serverIds／不在 outbox 的四種
  情形、來源 ack 後依 createdAt 放行、已 failed 的回覆不被偷偷重送、
  **來源失敗時回覆一起顯示失敗**（不得停在假的「送出中」）。

其他既有套件（同一次執行）：

```
npm run test:multi-branch        → 25 pass / 0 fail
npm run test:asset-intelligence  → 15 pass / 0 fail
npm run test:edge-cors           →  5 pass / 0 fail
npx tsc --noEmit                 → 無輸出（乾淨）
npm run build:local              → ✓ built in 5.25s
```

CI 會跑到本次新增的兩組：`.github/workflows/build.yml` 第 67 行
（`test:migrations`）與第 90 行（`test:collaboration`）。

---

## 4. 尚未執行（不得當成綠燈）

| 項目 | 為什麼沒做 | 需要什麼 |
|---|---|---|
| 雙人 E2E（§二十七 全部 22 步） | 需要兩個真帳號與可連線的 Supabase 專案；本機 `VITE_SUPABASE_URL` 為 `missing` | 使用者提供測試帳號，或在 CI 用既有 mock 走一輪並明確標示非真帳號 |
| 手機真機驗證（360×800／390×844／412×915） | 需要真瀏覽器／真裝置。依 `verify-in-real-browser` 紀律，curl 或單元測試綠燈不等於使用者可用 | 人類在真裝置上點過，或接上 Playwright device emulation |
| 平板驗證（768×1024／820×1180） | 同上；且平板 split view 本來就還沒實作 | PR-COMM-01 之後 |
| `test:collaboration-e2e` | **試跑了，被連接埠擋住**：`EADDRINUSE :::4190`。佔用者是 pid 23452（node，啟動時間 11:16:54），早於本 session 建立 worktree 的時間（12:36），屬於**另一個 agent session**，依規範不得砍。這是共用機器的資源衝突，不是程式碼紅燈 | 等該 session 結束，或把 e2e 的 port 改成可設定 |
| `test:multi-branch-e2e` | 需要 dev server ＋ Supabase 環境變數 | 雲端環境變數 |
| 正式站驗收 | **不自動部署正式環境**（任務書禁止） | 人類決定 |
| 語音失敗不阻塞文字的實測 | 需要真 LiveKit 與真的拒絕麥克風權限 | PR-COMM-06 |

**程式碼層面**已確認語音失敗不阻塞文字：`RoomDiscussion` 對語音是
`api.voice?.available ? <dock> : <一行說明>`，訊息列表與 composer 在同一個
`return` 裡、不在語音的載入／錯誤閘後面。但這是讀程式碼的結論，
**不是真機證據**，所以列在這一節。

---

## 5. irm／Grok 對抗審查

`irm` 在本機不存在（`command not found`）。實際使用的是 **Claude Code 的
workflow 子代理**做多角度稽核與對抗驗證，如實記錄如下：

- 第一輪（7 個稽核代理）：6 個完成、1 個（realtime-sync）因網路錯誤中止。
- 對抗驗證輪（74 個 verifier）：**全部因為
  `Unable to connect to API: Self-signed certificate detected` 中止**，
  當時等於沒有驗證。已重跑（進行中／見 BASELINE_AUDIT 的證據等級標示）。

本檔中所有標為「已確認」的缺陷，都是**我自己用真 PostgreSQL 或
直接讀原始碼＋grep 全 repo 交叉確認**的，不是靠代理的單方說法。
