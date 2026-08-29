# Checkpoint: Git 衝突整合與正式上線修復

- **稽核時間**：2026-08-29 22:36 +08:00
- **本檔更新**：2026-08-29 16:08Z（#113+#114 已 squash 進 main）
- **工作代理**：Grok Build TUI conflict-integration agent
- **倉庫**：https://github.com/aa0968111723-prog/duigao
- **正式站**：https://duigao-k7q2.zeabur.app/
- **本檔路徑**：`docs/agent-checkpoints/conflict-integration-2026-08-29.md`
- **原始 audit 輸出**：`{SCRATCH}/audit-git.txt`（session scratch；不進 git）

## 如何恢復（任務中斷時讀這裡）

1. `cd C:\Users\User\duigao`
2. `git fetch origin "+refs/heads/*:refs/remotes/origin/*" --prune`
3. 讀本檔最新「下一步」與 replacement 分支表。
4. **禁止**把 GitHub 綠勾當「無衝突」；一律 `git merge-tree origin/main <head>`。
5. **禁止**假設 #100 / #101 已在 `main` 或正式站。它們的 merge target 不是 `main`。
6. **禁止**刪原始 PR／分支，直到對應 `PR-RESOLVE-*` 測試通過且（若可能）已合入。
7. 整合基準永遠是最新 `origin/main`。Replacement 分支從該 SHA 長出，不要疊舊 agent branch。
8. Migration：main 已用到 `0022_discussion_author_integrity.sql`。#78 的 0022–0026、#95 的 0023、#88 的 0027–0028 **必須重編號**成下一個連續 prefix，且不可改已套用的 `0006`。

## origin/main

| 時刻 | SHA | 說明 |
|---|---|---|
| 稽核開始 | `3d8b2cf95e47f082f47c18aca704bbf35fac8106` | `PR-GAP-00: 真實稽核、測試基線與 SPA 假成功防護 (#97)` |
| 本檔寫入時 | `444ae9d330e8be9636b3fd8ce4e2cdcc0327d616` | `Handoff: remaining gaps and merge order (#99)` squash 合併 |
| 2026-08-29 23:06 +08 | `196b3a3672ca240e123ba530b5d7cb2eed8048a5` | `PR-RESOLVE-01: Home offline and cloud-unset truthful state (#105)` |
| 2026-08-29 23:12 +08 | `698595bb5c100decd4c0489e48b1d4feb50addd7` | `PR-RESOLVE-02` 語音九態 (#106) |
| 2026-08-29 23:21 +08 | `097a6afe47cfff27e88e074cdfa390cbe9406126` | `PR-RESOLVE-03` 影片 TUS + SPA API routing (#107) |
| 2026-08-29 23:28 +08 | `105b89b` | `PR-RESOLVE-04` files/outbox (#108) |
| 2026-08-29 23:34 +08 | `85755ff` | `PR-RESOLVE-05` mobile first-layer (#110) |
| 2026-08-29 16:00Z | `6da2af79739084c8af9680803b1d48b55a33c1c1` | `PR-RESOLVE-06` 白板 (#113) |
| 2026-08-29 16:06Z | `3c0bf0c6d88bd85cf829dbe6e95068369d9d3678` | `PR-RESOLVE-07` Design Intelligence (#114) — **目前 origin/main** |

本地在稽核前曾停在 `9b8d388`（遠古 main）。已 fast-forward 到含 #97 的 tip，並合併 #99。

遠端 fetch 設定原本是 `+refs/heads/main:refs/remotes/origin/main`（只拉 main）。已用 `git fetch origin "+refs/heads/*:refs/remotes/origin/*"` 拉齊所有 PR 分支。

## 已合併到 main 的相關 PR

| PR | 標題 | merge 目標 | 合入 SHA / 時刻 |
|---|---|---|---|
| **#97** | PR-GAP-00: 真實稽核、測試基線與 SPA 假成功防護 | `main` | squash 成 `3d8b2cf`，2026-08-29 14:22:28Z |
| **#99** | Handoff: 剩餘缺陷與合併順序（無新產品修復） | `main` | squash 成 `444ae9d`，本輪合併。GitHub `mergeable_state=clean`；`browser` / `build` / `migrations` / `agent-read-layer` 皆 **success**。 |
| **#105** | PR-RESOLVE-01: Home 離線／雲端未設定誠實狀態（替代 #96） | `main` | squash 成 `196b3a3` |
| **#106** | PR-RESOLVE-02: 語音九態（替代 #98） | `main` | squash 成 `698595b`；browser 全綠後合 |
| **#107** | PR-RESOLVE-03: 影片 TUS + SPA routing（替代 #95） | `main` | squash 成 `097a6af`；in-repo `vercel.json`/`Caddyfile` 不再 rewrite `/functions` `/api` `/rest` |
| **#108** | PR-RESOLVE-04: honest files/outbox（替代 #100） | `main` | squash 成 `105b89b` |
| **#110** | PR-RESOLVE-05: mobile first-layer（替代 #101） | `main` | squash 成 `85755ff` |
| **#113** | PR-RESOLVE-06: canonical whiteboard（替代 #78） | `main` | squash 成 `6da2af7`。migrations 0024–0028 additive。overlay `historyLayers` 不得洗推進面板。 |
| **#114** | PR-RESOLVE-07: Design Intelligence（替代 #88） | `main` | squash 成 `3c0bf0c`。migrations 0029–0030。proposal 不可跳過採用。 |

## 未進 main（即使 GitHub 顯示 merged）

| PR | GitHub state | **實際 merge target** | head SHA | 語意 |
|---|---|---|---|---|
| **#100** | closed / merged 14:25:20Z | `cursor/complete-missing-features-0897`（**不是 main**） | 合併當下 head `782e586`；該 feature 分支之後被 #101 推進到 `bfa3d37` | 可靠傳送／誠實上傳／outbox 帳號隔離。只存在於舊影片功能分支。 |
| **#101** | closed / merged 14:25:35Z | `cursor/p0-files-and-outbox-70d9`（**不是 main**） | `4f966a3` | 手機第一層精簡與平板 Split View。只存在於舊檔案功能分支。 |
| **#102** | open draft | `cursor/p1-mobile-tablet-ux-70d9`（不是 main） | `3622181` | Realtime／離線。本任務忽略，不當作已上線。 |

## 每個待整合 PR（base / head / merge 狀態）

`mergeable_state` 來自 GitHub API。衝突檔來自本機 `git merge-tree origin/main <head>`（#99 合併前對 `3d8b2cf` 跑的；#99 只加兩個 docs/test 檔，不改變下列產品衝突）。

### PR #96 — Home／local mode／cloud truthful state → **PR-RESOLVE-01**

| | |
|---|---|
| 標題 | PR-GAP-01: Home 離線與雲端未設定的誠實狀態 |
| head | `cursor/p0-mobile-room-entry-70d9` @ `e163bb1b1ba95d7b17e9a40907a2010f25dbf421` |
| GitHub base | `main` @ **stale** `398960d`（#94） |
| GitHub mergeable | **dirty**（綠勾是對舊 main；不可當無衝突） |
| Checks on old head | build / browser / migrations / agent-read-layer success（對 #97 之前的 main） |
| vs current main 變更 | `package.json`, `scripts/tests/home-entry.test.ts` (A), `src/components/Home.tsx`, `src/components/homeEntryStatus.ts` (A) |
| **衝突檔** | **`package.json` only** |
| 衝突語意 | main/#97 在 `test:multi-branch` 加入 `api-response.test.ts` 並新增 `test:api-response`；#96 在同一行加入 `home-entry.test.ts` 並新增 `test:home-entry`。兩邊 scripts 都要留。Home.tsx 無內容衝突。 |
| 必須保留 | 離線文案不含「已建立／已連線／成功」；production 缺雲端顯示「尚未設定」且不含「分享連結已建立」；dev 無 key 仍是 local mode（kind=ok）；IndexedDB / offline fallback 不關。 |

### PR #98 — Voice nine-state → **PR-RESOLVE-02**

| | |
|---|---|
| 標題 | PR-GAP-03: 語音九態誠實狀態，永不假裝已連線 |
| head | `cursor/p0-voice-truthful-state-70d9` @ `af8c2a4aeee665142d95a4e2683ba94d5b0a6a8d` |
| GitHub base | `main` @ **stale** `398960d` |
| GitHub mergeable | **dirty** |
| Checks on old head | build / browser / migrations / agent-read-layer success（對舊 main） |
| vs current main 變更 | `VOICE_BATCH.md` (A), `package.json`, `voice-state.test.ts` (A), `src/cloud/voiceToken.ts`, `src/features/collaboration/voice.ts`, `src/features/voice/liveVoice.ts`, `src/features/voice/voiceState.ts` (A), `src/hooks/useVoiceRoom.ts` |
| **衝突檔** | `package.json`, **`src/cloud/voiceToken.ts`**, **`src/features/collaboration/voice.ts`** |
| 衝突語意 | **voiceToken.ts**：#97 已把 `parseFunctionPayload` / SPA HTML / `{ok:true}` 缺欄拒絕接進 client；#98 另有九態 `parseVoiceTokenPayload`（要求 `ws:`/`wss:` + 有限 TTL）與 phase 對應。必須語意合併：保留 #97 共用 parser **且** #98 的 ws/TTL/phase。不可整檔 ours/theirs。 **voice.ts**：兩邊都改「語音服務尚未設定」文案路徑，合併時保留誠實文案 + 九態。 **package.json**：main 的 `test:api-response` + #98 的 `test:voice-state`（並把 voice-state 掛進 `test:collaboration`）。 |
| 必須保留 | 九態 idle / requesting-permission / joining / connected / reconnecting / permission-denied / service-not-configured / connection-failed / left；roster 僅 `connected`；加入失敗先清場再顯示錯誤；refresh 先 mute+disconnect 再 reconnecting；PeerJS fallback **不刪**；SPA HTML 不當 token 成功。 |

### PR #95 — Video TUS / transcode / library → **PR-RESOLVE-03**

| | |
|---|---|
| 標題 | feat(video): complete TUS upload, transcode, compare, archive, and library |
| 原始影片 commits | `b02e3bd`（TUS/轉碼/比較/封存/庫）→ `9639c0e` → `b560fd4`（discussion drafts/outbox persist）→ `4e5d8b3` |
| GitHub 此刻 head | `cursor/complete-missing-features-0897` @ **`07c1164`**＝上面再 **merge #100**。所以 GitHub 的 #95 diff 已含 files/outbox 誠實層。重放時 **03 只取影片+既有 discussion persist，不含 #100**；#100 另走 RESOLVE-04。 |
| GitHub base | `main` @ stale `398960d` |
| GitHub mergeable | **dirty** |
| **衝突檔 vs main@3d8b2cf** | `docs/cursor-gap-remediation/PROGRESS.md` (add/add), `package.json` |
| 衝突語意 | PROGRESS.md 兩邊從不同 PR 新增；合併時保留 #97 稽核進度 + 本批影片進度，不要覆蓋。package.json scripts 兩邊都加 test 指令（#97 api-response vs #95 upload-pipeline / files-batch）。 **隱性風險**：`supabase/migrations/0023_video_optimize.sql` 與 main 的 `0022` 之後編號衝突（#78 也佔 0023）；`0006_video_rooms.sql` 被直接改 — **不可對已套用 migration 做非 additive 覆寫**。重放時把 0023 改成 `0023_video_optimize.sql` 僅當 main 下一個空號仍是 0023（#78/#88 尚未合入時可以），且 0006 的變更改寫成 **新的 additive migration**。 |
| 必須保留 | TUS 6MB pause/resume/retry；>50MB 轉碼但 **原稿 bytes 不變**；版本並排比較、封存、素材庫；失敗顯示真錯誤；SPA HTML 不當上傳成功。 |

### PR #78 — Whiteboard canonical schema → **PR-RESOLVE-06**

| | |
|---|---|
| 標題 | PR-WB01: canonical whiteboard schema — 0021-0024＋tombstone…（head 實際已 merge WB02–WB06） |
| head | `agent/wb01-canonical-schema` @ `84d3f3e67cebad111a9a71d9941423eaab376ff7` |
| GitHub base | `main` @ **很舊** `361bec0`（#79 canva pages） |
| GitHub mergeable | **dirty** |
| **衝突檔** | `.agent/state.json`, `package.json`, **`src/features/multi-room/MultiBranchRoom.tsx`**, **`src/features/room-discussion/discussion.css`**, **`src/features/whiteboard/whiteboard.css`** |
| 另有 auto-merge（仍需人工核對語意） | `App.tsx`, `collaborationRepository.ts`, `offline.ts`, Image/Video workspace, `styles.css`, `migrations.mjs`, collaboration tests |
| 衝突語意 | MultiBranchRoom：main 之後加了討論／語音 dock／進房殼；白板分支加 Focus Mode、Split View、更多工具。必須兩邊功能都留，不可整檔覆蓋。CSS 兩邊都加了手機／白板規則。 **Migration 編號全撞**：分支仍叫 0022–0026，main 已有 `0022_discussion_author_integrity.sql`。重放必須改成 0023+（視當時 main max）連續 additive；不可 DROP 既有 whiteboard 資料；tombstone / operations / versions / freehand 全留；舊資料可讀。 |
| 必須保留 | canonical nodes 欄位、frames、operations（op_id 冪等）、versions、freehand、tombstone OCC、undo/redo 用 field_mask 而非整列還原、offline queue、RLS、多人同時編輯可見衝突、Peer 不關。 |

### PR #88 — Design Intelligence → **PR-RESOLVE-07**

| | |
|---|---|
| 標題 | PR-DI-01～06: Design Intelligence 完整交付 |
| head | `agent/design-intelligence-perplexity` @ `32e3bca10d705acbc655af55d5861be0a8a422eb` |
| GitHub base | `main` @ stale `b0f7a1b`（DI-00 剛合入時） |
| GitHub mergeable | **dirty** |
| **衝突檔** | `.agent/manifest.json`, `.agent/state.json`, `docs/design-intelligence/PROGRESS.md` (add/add), `docs/handoffs/DESIGN_INTELLIGENCE_INTEGRATION.md` (add/add), `package.json`, `scripts/tests/design-intelligence-schema.test.ts`, `src/features/design-intelligence/providers.ts`, `schema.ts`, `types.ts` |
| 衝突語意 | main 已有 DI-00 契約層／部分 docs／schema test；#88 補知識庫、分析引擎、研究層、proposal UI、adapters、0027/0028 migrations。add/add 文件與 schema/types 必須手工合併，保留 DI-00 紅線 **且** DI-01～06 實作。Migrations 重編號到當時 main 下一個連續號（不要留洞，agent-gate `checkMigrationOrder` 要求連續）。 |
| 必須保留 | 設計知識、色彩／字體／層級／文案分析、手機平板 UX 分析、研究來源、Canva/影片/3D 契約、AI 建議只當 proposal、採用後才寫入、失敗（timeout/quota/provider/permission/missing key/bad format/missing file/missing service）真實顯示。AI 不可覆蓋原稿。 |

### PR #100 / #101 重放說明 → **PR-RESOLVE-04 / 05**

不要 `git merge` 舊 feature 分支（會把過期 main 與 #95 整包帶進來）。

從最新 main（加上已合入的 RESOLVE-03）**抽出**：

- **#100 有效 commit**：`782e586`「PR-GAP-02: honest discussion send/upload and account-scoped outbox」
  - `acceptDiscussionInsert` / `applyIdempotentInsert` / `acceptStorageUpload`
  - outbox `ownerId` + `isolateOutboxForOwner`（A 看不到 B）
  - SPA HTML / 錯 path / 缺欄 → failed，不當 sent/complete
  - 手機討論聚焦時收合次要 chrome
- **#101 有效 commits**：`9ebf2b1` + `4f966a3`
  - 第一層：返回、房名、在線、語音、更多；主切換只留 對話／白板
  - 搜尋／總覽／內容／企劃／AI／分享／檔案進 Bottom Sheet
  - Android 返回先關 sheet
  - 44px、safe-area、平板 `data-tablet-split`（width≥768 && moreOpen）

`origin/cursor/p0-files-and-outbox-70d9` 現在是 `bfa3d37`（已含 #101 merge commit）。`origin/cursor/p1-mobile-tablet-ux-70d9` 停在 `4f966a3`。

## 必須保留的產品規則（每一個 replacement 都要過）

1. 人討論為中心；文宣／海報／影片／企劃／對稿／活動規劃。
2. 對話、白板、檔案、語音、AI、任務、Canva、影片、3D 共用同一 project context。
3. AI 產出 = 可審核 proposal；使用者按「採用」才寫入。
4. 原始海報／影片／企劃不可被 AI 或其他成員直接覆蓋。
5. 文宣修改用標記、評論、overlay、proposal layer。
6. 手機／平板第一公民：單手、底部工具列、Bottom Sheet、相機／相簿／檔案 App／分享 Sheet、平板拖曳與 Pencil。
7. 討論區一體成形但依情境收合。
8. 雲端未設定：local mode + IndexedDB + offline fallback。
9. RLS 開著；secrets 不進前端；不整包覆寫 room。
10. PeerJS／既有語音 fallback 不刪，除非新方案測試證明完全取代。
11. SPA `index.html` 不當 API 成功。
12. 語音九態；roster 只顯示真正 connected。
13. outbox 依使用者 + 房間隔離。

## 目前測試結果

本輪尚未在新分支跑完整 suite（稽核階段）。`package.json` **沒有** `lint` script，也沒有 `npm test`。存在的 scripts 以 main@444ae9d 為準：

`build` / `build:local` / `test:share-e2e` / `test:share-preview` / `test:video` / `test:review-viewer` / `test:viewer-geometry` / `test:asset-intelligence` / `test:asset-intelligence-e2e` / `test:api-response` / `test:multi-branch` / `test:collaboration` / `test:multi-branch-e2e` / `test:collaboration-e2e` / `test:migrations` / `test:design-intelligence` / `test:agent` / `test:edge-cors` / `agent:gate`

GitHub required jobs：`build` / `migrations` / `browser` / `agent-read-layer`（workflow 檔名 `agent-release-gate.yml`）。

#96/#98/#95 的綠勾是 **舊 base** 的結論，**不能**當作對 `3d8b2cf`/`444ae9d` 可合併。

## 正式站（稽核時尚未 HTTP 探針本輪）

先前 #97 已記錄：`https://duigao-k7q2.zeabur.app/functions/v1/voice-token` 等路徑 HTTP 200 `text/html`（SPA catch-all）。#97 只修 client parser，**平台路由仍會回 HTML**。本任務第十階段必須再探針，並對照 Zeabur deploy SHA 與 `origin/main`。

## 本輪進度（2026-08-29 16:08Z）

Replacement PRs（原始 #78/#88/#95/#96/#98 **仍 open、未刪**。#100/#101 GitHub 已 merged 到舊 feature 分支，不是 main）：

| 代號 | GitHub | 分支 | 狀態 |
|---|---|---|---|
| PR-RESOLVE-01 | **#105 merged** | `resolve/pr-01-home-entry` | main `196b3a3` |
| PR-RESOLVE-02 | **#106 merged** | `resolve/pr-02-voice-state` | main `698595b` |
| PR-RESOLVE-03 | **#107 merged** | `resolve/pr-03-video-library` | main `097a6af` |
| PR-RESOLVE-04 | **#108 merged** | `resolve/pr-04-files-outbox` | main `105b89b` |
| PR-RESOLVE-05 | **#110 merged** | `resolve/pr-05-mobile-tablet` | main `85755ff` |
| PR-RESOLVE-06 | **#113 merged** | `resolve/pr-06-whiteboard` | main `6da2af7`。browser 全綠：pane 跨 overlay、更多 sheet e2e、visual 基準更新 |
| PR-RESOLVE-07 | **#114 merged** | `resolve/pr-07-design-intelligence` | main `3c0bf0c`。required `build`/`migrations`/`browser`/`agent-read-layer` success |

### 正式站 HTTP（#114 合入後，2026-08-29 16:07Z）

| URL | status | Content-Type | Last-Modified | 判定 |
|---|---|---|---|---|
| `/` | 200 | text/html; charset=utf-8 | Sat, 29 Aug 2026 16:03:06 GMT | 文件載入 OK（ETag `dl1jz2azwyyo14l-gzip`） |
| `/functions/v1/voice-token` | **200** | **text/html; charset=utf-8** | 同上同一 ETag | **失敗**：SPA catch-all，不是 API |
| `/api/health` | **200** | **text/html; charset=utf-8** | 同上同一 ETag | 同上 |

Zeabur MCP `list-projects`：`ERROR_INVALID_TOKEN`。無法比對 deploy SHA。in-repo Caddyfile/vercel.json 已排除 `/api` `/functions` `/rest`（#107），**平台仍把這些路徑指到 SPA**。GitHub merge ≠ 正式站 API 修好。

### 環境阻擋（不是程式沒寫）

- Canva OAuth / AI vendor keys / LiveKit env / **Zeabur 路由把 `/functions/v1/*` 指到真正 Edge Function**（Caddyfile 在平台上未被採用）

## 下一步（剩餘）

1. **平台**：Zeabur 必須讓 `/functions` `/api` `/rest` 回 JSON/404 而不是 `index.html`。這是環境阻擋，不是再改 SPA。
2. 原始 PR **#78 / #88 / #95 / #96 / #98 保持 open、不刪**（replacement 已在 main；刪除要等人確認）。
3. 其他 GAP restack PR（#102–#104、#109、#111–#112、#115–#120）不在本任務範圍。

## 本輪已完成

- [x] fetch / merge-tree / PR 讀取
- [x] 確認 #100 base=`cursor/complete-missing-features-0897`、#101 base=`cursor/p0-files-and-outbox-70d9`
- [x] #99 browser success → squash 合併到 main (`444ae9d`)
- [x] PR-RESOLVE-01 … 07 全部 squash 進 main（#105–#108、#110、#113、#114）
- [x] #113/#114 GitHub `mergeable_state=CLEAN` 且 required checks success 才合
- [x] 正式站 HTTP 在新 main SHA `3c0bf0c` 之後再探針（API 路徑仍 200 HTML）
