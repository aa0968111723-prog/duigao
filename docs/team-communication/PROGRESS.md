# PROGRESS — 團隊溝通線（長任務）

分支：`agent/team-communication-mobile-tablet`
worktree：`D:/duigao-comm`（獨立，不與其他代理共用）
base：`origin/main` @ `2a9d7a0`

---

## 階段總表

| 階段 | 範圍 | 狀態 |
|---|---|---|
| **PR-COMM-00** | 真實稽核與安全基線 | **已開 [#94](https://github.com/aa0968111723-prog/duigao/pull/94)，待人類 review** |
| PR-COMM-01 | 手機輸入列與可靠傳送 | 未開始 |
| PR-COMM-02 | 回覆、提及與表情 | 未開始（**需新 migration，被凍結擋住**） |
| PR-COMM-03 | 未讀、Presence 與 Typing | 未開始（需新 migration） |
| PR-COMM-04 | 決策、待辦與置頂 | 未開始（需新 migration） |
| PR-COMM-05 | 附件、作品與錨點 | 未開始 |
| PR-COMM-06 | 語音與文字銜接 | 未開始 |
| PR-COMM-07 | 搜尋、通知與完整 E2E | 未開始 |

---

## PR-COMM-00

**分支**：`agent/team-communication-mobile-tablet`
**base commit**：`2a9d7a018836e7ec913f009f2f7a5d5b8b25fbff`
**commit**：`8363c8a`（5 個 commit）
**PR**：[#94](https://github.com/aa0968111723-prog/duigao/pull/94) — **OPEN，不自動合併**
**Preview URL**：無（**不自動部署正式環境**）

### 完成內容

真實稽核：

- `docs/team-communication/BASELINE_AUDIT.md` — 任務書 §三 要求的 15 項全數涵蓋，
  每條標明證據等級（實測／原始碼／待複驗）。
- `docs/team-communication/MIGRATION_RESERVATION.md` — 列舉全部 46 條 remote
  分支與 2 個 open PR 之後的編號歸屬。
- `docs/handoffs/TEAM_COMMUNICATION_HANDOFF.md` — 共享檔案、套用順序風險、
  交給別條線的問題。
- `docs/team-communication/TEST_EVIDENCE.md`、`KNOWN_LIMITATIONS.md`。

測試補強（**不是純文件 PR**）：

- `scripts/e2e/migrations.mjs` +15 條真角色 RLS 探針（作者完整性、
  0014 replay 存活、跨房 reply FK ＋正向對照、表情回應 RLS 6 條）。
- 修掉**我自己新加的一條假綠探針**（欄位數與值數對不上，SQL 語法錯導致
  永遠通過）——對抗審查抓到的，見 `TEST_EVIDENCE.md` §2.4。
- 修掉 `collaboration-workspace.test.ts` 裡一條假測試：`buildInviteUrl` 被
  import、被寫進三元判斷的條件（讀 `.call` 屬性永遠 truthy），但從來沒有被
  呼叫過，結果還被 `void` 丟掉。改成 stub `location` 真的跑一遍，並與
  `readInviteFromUrl` 對接成 round-trip。
- `scripts/tests/discussion-replies.test.ts` +12 條引用解析測試，
  掛進 `npm run test:collaboration`（CI 第 90 行會跑到）。

P0 修復：

- `supabase/migrations/0022_discussion_author_integrity.sql` — 訊息作者不可
  偽造、不可改寫；trigger 同時凍結 `room_id` 與 `created_at`，且能撐過
  0014 replay。
- `src/features/collaboration/replies.ts` ＋ UI 接線 — 引用改成解析而不是複製，
  可點回來源，來源被編輯會標示，來源不在會誠實說。
- 回覆時貼純網址不再丟掉回覆對象。
- composer 加回覆列與取消鈕。
- 長網址不再撐爆訊息卡造成橫向捲動。
- `loadCollaborationSummary` 不再把查詢失敗變成「這間房沒有訊息」；
  `mergeDiscussionSnapshot` 讓空快照不覆蓋畫面上的對話（且換房不沿用）。
- 回覆自己剛送出的訊息不再撞複合外鍵：outbox 先扣住回覆，來源 ack 之後才送；
  來源失敗時回覆一起顯示失敗，重試從來源開始。

### 測試

| 指令 | base | 現在 |
|---|---|---|
| `PG_BIN=… npm run test:migrations` | 242/242 | **257/257** |
| `npm run test:collaboration` | 79 pass | **106 pass** |
| `npm run test:multi-branch` | 25 pass | 25 pass |
| `npm run test:asset-intelligence` | 15 pass | 15 pass |
| `npm run test:edge-cors` | 5 pass | 5 pass |
| `npx tsc --noEmit` | 乾淨 | 乾淨 |
| `npm run build:local` | ✓ | ✓ 5.25s |

失敗的測試：**無**。

### 尚未執行

手機證據、平板證據、雙人證據、真機語音、正式站驗收 —— 全部未執行，
原因與所需條件見 `TEST_EVIDENCE.md` §4。**不宣稱這些已完成。**

### 對抗審查

`irm` 本機不存在（`command not found`），未冒充使用。實際用 Claude Code
workflow 子代理做多角度稽核：

- 第 1 輪 7 個稽核代理：6 個完成、1 個（realtime-sync）因網路錯誤中止。
- 對抗驗證輪 74 個 verifier：**首次全部因
  `Self-signed certificate detected` 中止**，等於沒有驗證。已重跑。
- 裁決記錄見本檔下方「findings 裁決」。

### 阻塞

- **BLOCKED_MIGRATION_ORDER**：本線的 `0022` 與 #78 的 `0022` **必然撞號**
  —— repo 的 release gate 要求編號連續，兩條分支都從 `main`（0021）長出來，
  各自只能取下一號。撞號一定會被 gate 抓到（`duplicate prefix`），不會靜默
  出事，但需要人類決定合併順序：建議 #78 先，本線 rebase 後重新編號。
  詳見 `MIGRATION_RESERVATION.md`。
- **BLOCKED_TWO_ACCOUNT_E2E**：沒有第二個測試帳號與可連線的 Supabase 環境變數。
- **BLOCKED_REAL_DEVICE**：沒有真機／真瀏覽器可驗收。

### commit

```
8363c8a PR-COMM-00: 修掉我自己寫的假綠探針，並補上表情回應的 RLS
5ac8fe8 PR-COMM-00: 對抗審查裁決與交接更新
b2a9490 PR-COMM-00: 回覆自己剛送出的訊息不再撞外鍵
d112733 PR-COMM-00: 一次讀取失敗不再清空整條討論串
f2adcb8 PR-COMM-00: 訊息作者可被偽造，回覆是失去來源的複製品
```

### 下一步

1. 人類 review [#94](https://github.com/aa0968111723-prog/duigao/pull/94)，決定 `0022` 的合併與套用順序。
2. `0022–0028` 定案後解除 migration 凍結。
3. 開始 PR-COMM-01（捲動管理、輸入列、草稿持久化、outbox 持久化）——
   這一階段**不需要新表**，可以在凍結期間進行。

---

## findings 裁決

依 §二十九，每一條稽核發現逐項記錄
`accepted` / `partially-accepted` / `rejected-with-reason` / `deferred-with-owner`。

見本檔 `FINDINGS_RULING.md`（同目錄）。

---

## §三十二 完成標準對照（PR-COMM-00）

```
分支：            agent/team-communication-mobile-tablet
PR：              #94  https://github.com/aa0968111723-prog/duigao/pull/94（OPEN，未合併）
Commit：          41b6ee6（7 個 commit）
Base commit：     2a9d7a018836e7ec913f009f2f7a5d5b8b25fbff
Preview URL：     無 —— 不自動部署正式環境
CI：              build / migrations / agent-read-layer / browser 全綠
```

**修改檔案**：`supabase/migrations/0022_discussion_author_integrity.sql`（新增）、
`src/features/collaboration/replies.ts`（新增）、`src/hooks/discussionOutboxCore.ts`、
`src/hooks/useDiscussionOutbox.ts`、`src/cloud/collaborationRepository.ts`、
`src/features/collaboration/offline.ts`、`src/features/room-discussion/*`、
`src/App.tsx`、`src/features/multi-room/MultiBranchRoom.tsx`、
`scripts/e2e/migrations.mjs`、`scripts/tests/discussion-*.test.ts`、
`scripts/tests/collaboration-workspace.test.ts`、`package.json`、`docs/**`。

| 項目 | 狀態 |
|---|---|
| 真實完成 | 作者完整性（policy＋trigger＋replay 存活）、引用解析與跳轉、回覆取消、回覆順序、快照不清空、表情回應 RLS 探針、假綠測試修正 |
| 尚未完成 | 提及、未讀、typing、per-member presence、多表情、待辦、置頂、統一搜尋、通知、平板 split view、訊息編輯／刪除、outbox 持久化、自動捲動 |
| 測試指令 | `PG_BIN=… npm run test:migrations`／`npm run test:collaboration`／`test:multi-branch`／`test:asset-intelligence`／`test:edge-cors`／`tsc --noEmit`／`build:local` |
| 測試結果 | migrations **257/257**（base 242）、collaboration **106 pass**（base 79）、其餘全綠、build ✓ |
| 雙人同步 | **未執行** —— 無第二測試帳號與可連線 Supabase |
| 離線測試 | 純函式層有（outbox 狀態機、回覆順序、快照合併）；**真瀏覽器離線未執行** |
| 回覆測試 | ✅ 12 條（含已編輯來源、來源消失、先於來源到達、ghost、自我回覆） |
| 提及測試 | **無此功能** |
| 表情測試 | ✅ RLS 層 6 條（身分綁定、不重複計數、取消只刪自己那列、跨房） |
| 未讀測試 | **無此功能** |
| Presence 測試 | **無此功能**（目前只有人數） |
| Typing 測試 | **無此功能** |
| 附件測試 | 既有 10 條（本 PR 未動） |
| 決策測試 | 既有（本 PR 未動） |
| 待辦測試 | **無此功能** |
| 語音失敗測試 | 程式碼層確認不阻塞文字；**真機未驗** |
| 手機驗證 | **未執行** |
| 平板驗證 | **未執行** |
| RLS 驗證 | ✅ 真 PostgreSQL、真角色（非超級使用者），257 條 |
| Migration 衝突檢查 | ✅ 已檢查並**確認會與 #78 撞號** —— 見 `MIGRATION_RESERVATION.md` |
| irm／Grok 審查 | irm 不存在、未冒充；用 workflow 子代理兩層審查，含失敗如實記錄；裁決見 `FINDINGS_RULING.md` |
| 已知限制 | `KNOWN_LIMITATIONS.md` |
| 需要人工操作 | 決定合併順序並重新編號；設 Supabase secrets；真機／雙人驗收 |
| 建議合併順序 | `#78 → #88 → DI(0028) → 本 PR（rebase 後重新編號）` |
| 自動合併 | ❌ 沒有 |
| 自動部署正式環境 | ❌ 沒有 |
