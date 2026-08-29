# TEAM_COMMUNICATION_HANDOFF

分支：`agent/team-communication-mobile-tablet`
基底：`origin/main` @ `2a9d7a0`（`feat(ui): align product surfaces with brand mark (#87)`）
worktree：`D:/duigao-comm`（獨立；不與其他代理共用）

本檔依 §二 建立：本線需要動到共享檔案時，先在這裡列出檔案、原因、最小介面、
可能衝突與建議由哪條分支處理。

---

## 1. 本線動到的共享檔案

| 檔案 | 原因 | 最小介面 | 與誰可能衝突 | 建議 |
|---|---|---|---|---|
| `supabase/migrations/0029_discussion_author_integrity.sql`（新增） | 補 `room_discussion_messages` 的作者完整性洞（見 §3） | 只動 `room_discussion_insert` policy＋新增 `guard_discussion_message_write` trigger。不碰白板表、不碰 design knowledge 表 | 編號層面與 #78（0022–0026）／#88（0027）／DI（0028）**不衝突**，但套用順序有風險（見 §2） | 本線 |
| `scripts/e2e/migrations.mjs` | 加 9 條真角色 RLS 探針（作者完整性＋0014 replay 存活） | 只新增 `section()` 與 `ok()`，不改既有探針 | 白板線與 DI 線也會往這支加自己的 section | 各自加自己的 section，合併時取聯集 |
| `src/App.tsx` | `sendLink` 需要把回覆對象帶進連結卡（原本會整個丟掉） | 只改 `sendLink` 一個 callback 的簽章與 body | 其他線也在改 App.tsx（3175 行的共用檔） | 本線；衝突面很小（單一 callback） |
| `src/features/multi-room/MultiBranchRoom.tsx` | `onSendDiscussionLink` 型別跟著 `sendLink` 走 | 只改 prop 型別一行 | 白板線在同檔改白板 pane | 本線；不同區塊 |
| `package.json` | 把新測試掛進 `test:collaboration` | 只在既有字串尾端加一個檔案 | 各線都會加測試 | 各自加，合併取聯集 |

**沒有動**：白板 canvas 核心、白板 operations、白板 migrations、Design
Intelligence schema、Canva OAuth、CUTOS 編輯器、planform-iso 3D、正式部署設定。

---

## 2. Migration 套用順序（需要人類決定）

完整預約表見 `docs/team-communication/MIGRATION_RESERVATION.md`。

事實：`main` 到 `0021`；#78 佔 `0022–0026`；#88 佔 `0027`；DI02–DI06 五條分支
共用 `0028`（**尚無 PR 追蹤**）。本線取 `0029`（全 46 條 remote 分支列舉後
確認無人佔用）。

**風險與需要人類處理的事**：正式庫目前在 `0021`。若 PR-COMM-00 先合併並套用
`0029`，之後 #78／#88 合併時 `0022–0027` 會比已套用的 `0029` 舊，Supabase CLI
會回報 migration history mismatch。

建議合併順序（由下而上）：

```
#78 (0022–0026)  →  #88 (0027)  →  DI (0028，需先開 PR)  →  PR-COMM-00 (0029)
```

若人類決定讓 PR-COMM-00 先合併，套用 `0022–0028` 時需要 `--include-all`，
或把 `0029` 重新編號到當時的最大編號 +1。本線可以配合重新編號 —— 0029 的
內容不依賴任何其他 migration 的編號，只依賴 0014 已存在。

---

## 3. 已修的安全洞（給審查者的重點）

`room_discussion_messages` 的 insert policy（0014）只檢查
`public.is_room_member(room_id)`，沒有把 `author_user_id` 綁在 `auth.uid()`。

**這不是理論問題，是用真 PostgreSQL、真角色（不是超級使用者）實測出來的**：

```
討論訊息作者完整性：0014 room_discussion_messages
  ✗ 冒名發訊息（author_user_id 填別人的 uid）被擋 — reviewer 成功以 owner 身分發言
  ✗ 管理者也不能改寫訊息作者（洗白作者身分） — can_manage_media 不該等於可以重寫作者
```

任何房間成員都能用 supabase-js 直接送出一則「看起來是房主說的」訊息，而訊息
正是決策與待辦往回指的原始證據。0019 早就把同一類問題（actor 冒名）當成必須
擋下的類別，這條線只是沒補到訊息表。

`0029` 之後：

```
  ✓ 成員可以用自己的 uid 發討論訊息
  ✓ 冒名發訊息（author_user_id 填別人的 uid）被擋
  ✓ 作者不能把自己的訊息改成別人發的
  ✓ 管理者也不能改寫訊息作者（洗白作者身分）
  ✓ 重跑 0014 之後仍然擋得住冒名發訊息（0029 的 trigger 不被 replay 洗掉）
  ✓ 重跑 0014 之後成員仍然發得出自己的訊息（護欄沒有擋到正常路徑）
```

**為什麼同時用 policy 與 trigger**：0014 是可重跑的，而且它用
`drop policy if exists room_discussion_insert` 重建同名 policy —— 只改 policy
的話任何一次 0014 replay 都會把洞放回來。trigger 的名字不在 0014 裡。

**第一版是假綠，記錄下來以免重蹈**：trigger 最初寫成 `security invoker`，
`authenticated` 沒有 schema `auth` 的 USAGE，於是 `auth.uid()` 噴
`permission denied for schema auth` —— 冒名的探針「過了」，但其實是**每一則**
討論訊息都寫不進去。改成 `security definer`（與 `public.is_room_member` 同一
個理由）後 251/251 全綠。**負面探針通過時，一定要同時確認正面路徑還活著。**

---

## 4. 交給別條線的發現（本線不動）

以下是稽核過程中發現、但**不屬於本線負責範圍**（§二）的問題。本線沒有修，
列在這裡給對應的擁有者。

| 編號 | 問題 | 檔案 | 建議擁有者 |
|---|---|---|---|
| SEC-01 | `upsert_visual_proposal` 是 SECURITY DEFINER，用呼叫端給的 `p_room_id` 授權，卻用 `id` 單獨定位並更新該列 —— 跨房寫入 | `supabase/migrations/0017_author_acl.sql` | 安全線／視覺提案線 |
| SEC-05 / SEC-10 | `messages_all`、`strokes_all` 仍是 `for all` 給任何房間成員：分享連結進來的 reviewer 可以改／刪整個房間的舊聊天與所有人的標註 | `0001_cloud_rooms.sql` | 安全線 |
| SEC-03 / SEC-04 | `comments_insert` 沒有 `author_user_id = auth.uid()`；`comments_update` 讓任何成員改寫別人回饋的內容與作者欄 | `0001`／`0002` | 回饋線（與本線 0029 同一類問題，同一個解法形狀） |
| SEC-12 | `0001/0002/0005/0012` 的表仍停在 Supabase 預設 `GRANT ALL TO anon, authenticated`，含 RLS 管不到的 TRUNCATE | 同上 | 安全線 |
| SEC-08 | canva-bridge OAuth callback 沒綁發起流程的瀏覽器 | `supabase/functions/canva-bridge` | Canva 線 |
| SEC-09 | `room_members` 沒有 DELETE policy 也沒有 RPC —— 外流的邀請連結等於永久授權 | `0001`／`0007` | 安全線 |
| TC-01 | `scripts/e2e/collaboration-workspace.mjs` 有三條白板手勢檢查寫死 `check("…", true)`，永遠不會失敗 | `scripts/e2e/collaboration-workspace.mjs:261,269,272` | 白板線（#78 正在重寫這塊；本線不進去改，避免衝突） |
| V1–V13 | 語音的狀態機與假連線／幽靈參與者問題 | `src/hooks/useVoiceRoom.ts` | 本線 **PR-COMM-06**（已排程，不在 PR-COMM-00） |

### 對抗審查之後的更新

- **已確認為真**（對抗層 CONFIRMED）：`comments` 的冒名與改寫、`messages`
  的 `for all`、`room_members` 沒有 DELETE、`guard_room_update` 沒涵蓋
  `room_mode`、重播 insert 重鑄 uuid、`flushPending` 覆寫佇列、並行 reload
  沒有順序守衛、Realtime 重連不重抓、DELETE 監聽沒有房間 filter、
  白板節點 id fallback 成非 uuid。
- **被推翻**：`strokes` 的 `for all`（是刻意出貨的共同標註設計，不是疏漏）。
- **證據不足以定案**：`0001/0002/0005/0012` 的預設 `GRANT ALL`／TRUNCATE。
  推翻理由指出測試 shim 重現的預設權限與真專案不必然相同。
  **請用真專案 probe 確認**：
  ```sql
  select table_name, grantee, privilege_type
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee in ('anon','authenticated')
    and privilege_type = 'TRUNCATE';
  ```
- **新增**：`supabase/functions/asset-analysis/index.ts:511` 參照未定義的
  `dedupe_key`（`tsc` 報 TS2552）。對抗層判該分支不可達，但識別字確實
  未定義 —— 屬於待清理的真問題，交素材智慧線。

完整裁決見 `docs/team-communication/FINDINGS_RULING.md`。
仍標 **[待複驗]** 的（手機／平板 UI 多數條目、`upsert_visual_proposal`
跨房寫入、測試盲區多數條目）**沒有被確認也沒有被推翻**，請自行複驗。
