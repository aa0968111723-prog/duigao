# KNOWN_LIMITATIONS — 團隊溝通線

分支 `agent/team-communication-mobile-tablet`｜base `2a9d7a0`

這份檔的用途是**不讓任何東西被誤以為已經完成**。列在這裡的都是真的還沒好，
或是好了一半。

---

## A. PR-COMM-00 修了什麼、沒修什麼

修了（有真環境證據，見 `TEST_EVIDENCE.md`）：

- 訊息作者可被偽造 / 可被改寫（`0029`）。
- 回覆指不回來源、來源被編輯後引用停在舊字、引用是孤立複製品。
- 回覆時只貼一條網址會丟掉回覆對象。
- 點了「回覆」之後無法取消。
- 長網址撐爆訊息卡造成 360px 橫向捲動。

**沒修**（照 §三十的分階段，或受 migration 凍結所限）：

| 能力 | 現況 | 排在哪一階段 |
|---|---|---|
| 提及 `@` | **完全不存在**（`grep -rni mention src/ supabase/` 只有一句無關註解） | PR-COMM-02（需新表） |
| 未讀 / 第一則未讀 / 提及未讀 | **完全不存在** | PR-COMM-03（需新表） |
| Typing | **完全不存在** | PR-COMM-03 |
| Presence | 只有一個**人數**（`Object.keys(channel.presenceState()).length`），沒有身分、沒有在線／離開／重新連線 | PR-COMM-03 |
| 表情回應 | 只有單一「支持」，不是任務書要的六種 | PR-COMM-02（需新表） |
| 已送達 / 已讀 | **沒有** receipt 機制。現況只有 `sending`／`sent`／`failed`，這是對的 —— 沒有真證據就不顯示雙勾 | PR-COMM-03 |
| 待辦 / 置頂 | 沒有 | PR-COMM-04（需新表） |
| 決策 | 有 `decision_records`，但 UI 只有「新增／標成已決定」兩個狀態，不是任務書要的五個狀態機 | PR-COMM-04 |
| 統一搜尋 | 房間搜尋只比對 branch 名稱，卻對討論、企劃內文、附件也回「找不到相關內容」 | PR-COMM-07 |
| 通知分類 / 靜音 | 沒有 | PR-COMM-07 |
| 平板 split view | **沒有**。目前是手機單欄放大 | PR-COMM-01 之後 |
| 訊息編輯 / 刪除 | 資料庫層有 policy 與 grant，**client 完全沒有入口**。刪除是 hard delete，不是 tombstone | PR-COMM-02 |
| AI 溝通輔助 | 房間有 AI，但沒有「分析→提案→預覽→人確認→寫入→稽核」完整迴圈的溝通輔助 | PR-COMM-04 之後 |

---

## B. 0029 沒有關掉的殘餘：顯示名稱仍是 client 主張

`0029` 保證的是 **`author_user_id` 不能指向別人**。它**沒有**保證
`author_name` 是真的。

`room_discussion_messages.author_name` 是純文字欄位，由 client 送出。
成員可以送出一列 `author_user_id = NULL`（合法，見下）但
`author_name = '小雨'`，畫面就會顯示「小雨」。

為什麼 `NULL` 必須合法：本機房第一次分享時，`insertCollaborationSlice` 會把
整包本機討論搬上雲。本機訪客的 id 是 `g_xxxx`（`uid("g_")`），不是
`auth.users` 的 uuid，所以那些列只能是 `NULL`。強制 `NOT NULL` 會讓
「把本機房變成雲端房」整個失敗。

**正確的解法**（排在 PR-COMM-02，跟提及的成員模型一起做）：顯示名稱不再讀
訊息列的 `author_name`，改成用 `author_user_id` 去 `room_members` 解析；
`author_user_id IS NULL` 的列明確標示成「匯入的舊訊息」。

在那之前：**冒充某個帳號**（強）已經擋掉；**顯示成某個名字**（弱）還沒有。

---

## C. outbox 只活在記憶體

`useDiscussionOutbox` 的 entry 存在 React state。重新整理、PWA 被系統回收、
或分頁被關掉，**尚未送出的訊息就消失了**，而且訊息本體雖然進了 IndexedDB
（`updateRoom` → `saveRoom`），但沒有任何東西會再去送它。

另外 `reconcileOutbox` 的第 3 條規則「不屬於目前房的 entry 丟棄」意味著
**送出後立刻切到別的房間，in-flight 或 failed 的那則會被直接刪掉**，
不會回到原本的房間重試。這是既有測試明確鎖住的行為
（`A→home：A 的 entry 立即被隔離，不殘留`），也就是說這個資料遺失是被
測試保護著的 —— 要改需要連同那條測試一起改，屬於 PR-COMM-01 的範圍。

任務書 §二十四 要求「離線 outbox」是可持久的。目前**不是**。

---

## D. 討論串沒有任何捲動管理

`grep -rn "scrollIntoView|scrollTop|scrollTo" src/` 在討論路徑上只有本次新加的
「跳到來源」。也就是說：

- 打開房間停在**最舊**的訊息，不是最新。
- 送出訊息之後畫面不會捲到自己那一則。
- 沒有「第一則未讀」定位（未讀本來就還沒做）。
- 沒有「有新訊息」提示。

任務書 §四 要求「最新訊息在哪裡」一眼看得到。目前做不到。排在 PR-COMM-01。

---

## E. 語音只有四個狀態

`VoiceRoomState = "idle" | "connecting" | "live" | "error"`。任務書 §十六 要求
九個可分辨的狀態（尚未開始／正在請求權限／正在加入／已連線／重新連線／
權限被拒／服務未設定／連線失敗／已離開）。目前：

- 「服務未設定」與「本機房」共用同一句「語音房間還在準備，這一版先把討論和
  白板做好。」—— 對已經設定好 LiveKit 的部署會說謊。
- 「正在請求權限」與「正在加入」都是 `connecting`。
- 沒有「重新連線」狀態。

**語音失敗不阻塞文字這一點，程式碼層面是成立的**（訊息列表與 composer 不在
語音的載入／錯誤閘後面），但還沒有真機證據。排在 PR-COMM-06。

---

## F. Migration 套用順序需要人類決定

見 `MIGRATION_RESERVATION.md` 與 `docs/handoffs/TEAM_COMMUNICATION_HANDOFF.md`。
正式庫在 `0021`；`0022–0028` 全部尚未合併。若 PR-COMM-00 先合併並套用
`0029`，之後套 `0022–0027` 會是「比已套用的還舊」，Supabase CLI 會擋。

**本線不會自動合併，也不會自動部署正式環境。**

---

## G. 本次稽核的證據等級

第一輪 74 條候選缺陷裡，**只有下列是我自己用真環境或全 repo grep 交叉確認的**：

- 作者可偽造 / 可改寫 —— 真 PostgreSQL 探針（`TEST_EVIDENCE.md` §2.1）。
- 回覆指不回來源 —— `grep -rn replyToId` 全 repo 只有寫入端，沒有讀取端。
- 提及／未讀／typing 不存在 —— 全 repo grep 無實作。
- Presence 只有人數 —— `roomSync.ts:124`。
- 語音只有四個狀態 —— `useVoiceRoom.ts:32`。
- 三條白板 e2e 檢查寫死 `true` —— `collaboration-workspace.mjs:261,269,272`。
- 討論串沒有捲動管理 —— 全 repo grep。

其餘候選（特別是 `SEC-01`／`SEC-05`／`SEC-10`／`SEC-12` 這些不屬於本線範圍的）
**尚未經對抗驗證**，在 `BASELINE_AUDIT.md` 裡標為「待複驗」。交接時請自行複驗，
不要當成已確認的事實。
