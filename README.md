# 文宣討論區

> AI 代理開始工作前先執行 `npm run agent:context`；功能、修復或安全 PR 必須通過 `npm run agent:gate`。`AUTOMERGE REQUIRES AGENT_GATE_PASS`。

手機優先的文宣討論工具。把 Canva / Adobe 做好的活動文宣變成一條連結傳給夥伴，大家不直接修改原稿，只在畫面上指出哪裡需要調整。

> 海報是主畫面，討論比編輯更快。

## 手機主流程

1. 從 LINE 點開連結 → 輸入名字 → 直接看到文宣
2. 底部選「修改點」→ 點文宣上要調整的位置
3. Bottom Sheet 滑出，打一句話就能送出（建議、分類、優先都是選填）
4. 從底部討論面板查看其他人的意見，處理完標記完成

## 功能

- 多版本文宣（初稿、改一、改二…），手機用水平 chips 切換
- 點位置留意見、圈出範圍（AnnotationRegion）；看稿永遠是乾淨原稿
- 低摩擦回饋：快速原因、一句話、我也覺得、回覆；分類／優先／建議選填
- 待修改 / 已完成、一鍵複製完整修改清單
- 視覺提案 2.0：覆蓋在原稿上的提案層（文字／素材／色塊），提案卡有類型、狀態、支持與留言；原稿 / 提案 / 對照三種檢視；可從修改點直接開提案
- 分享 Bottom Sheet：複製連結、傳到 LINE、系統分享
- 連結預覽（Open Graph）：貼到 LINE 會出現乾淨文宣縮圖＋標題，可一鍵關掉縮圖或重新產生預覽連結；invite 永遠不會離開瀏覽器
- 操作回饋 toast 與「復原」、儲存狀態、首次使用引導
- 雲端房間（Supabase）：分享後主辦方關掉頁面，夥伴仍能隨時打開同一房
- 彩色 / 黑白 / 對切 / 並排 / 滑動比較（手機收在「更多」）

## 畫面結構

手機與桌機共用同一份狀態（`App.tsx`），只有外殼不同：

```
src/
  App.tsx                  狀態容器：房間、版本、修改點、連線、分享
  components/
    MobileWorkspace.tsx    手機外殼：頂列、版本 chips、海報、底部工具列
    DesktopWorkspace.tsx   桌機外殼：工具列 + 右側面板
    BottomSheet.tsx        DragSheet（討論清單）與 ModalSheet（新增／分享／更多）
    Stage.tsx              海報與圖釘；座標以「海報本身」為基準
    PinFields.tsx          新增修改點表單（共用）
    CommentCard.tsx        修改點卡片（共用）
    Home.tsx / ShareSheet.tsx / UploadZone.tsx
  toast.tsx                操作回饋 toast
  cloud/                   唯一的雲端層：auth、invite、repository、realtime、offline queue
                           ＋ sharePreview / shareThumbnail（LINE 連結預覽）
  features/visual-proposal/ 視覺提案：提案層、提案卡（支持／留言／狀態）、比較、與修改點連動
  styles.css               共用樣式與桌機版面
  mobile.css               手機元件樣式（≤720px）
  usability.css            toast / 儲存狀態 / 新手引導
```

`mobile.css` 只負責手機元件本身的樣式，不再覆寫桌機版面。

## 開發

```bash
npm install
npm run dev
npm run build              # cloud env 檢查 + tsc --noEmit + vite build，輸出到 dist/
npm run check:cloud-env    # 只檢查部署 env，未就緒時 exit 1（給 CI / 部署流程用）
npm run test:migrations    # 用真的 PostgreSQL 套 supabase/migrations 並驗 RLS
npm run test:share-preview # 連結預覽：爬蟲 OG、invite 隔離、縮圖幾何
npm run test:share-e2e     # 完整分享旅程驗收（見 scripts/e2e/README.md）
npm run test:video         # 影片對稿驗收：上傳、時間點/片段留言、切版本、分享卡
npm run make:og-cover      # 重製 public/og-cover.png 通用分享封面
```

## 影片對稿

圖片是空間座標（點一個位置、圈一塊範圍），影片是時間座標（某一刻、某一段）。
兩者共用同一套房間、邀請、權限、Storage、Realtime 與討論；分開的只有工作區介面，
由 `RoomWorkspace` 依 `room.mediaType` 決定要開哪一個。

**支援格式**：MP4（H.264）與 WebM 最穩。`.mov`（iPhone）可以上傳，但裡面若是 HEVC，
桌機 Chrome／Android 常常播不出來——播放器會直接說明，不會給一個黑畫面。
匯出時請選「網頁用 / fast start」的 MP4，否則瀏覽器要下載完才能拉時間軸。

**大小與長度**：一支上限 100MB、120 分鐘。這是客戶端的上限；Storage bucket 另外設在
200MB，而 Supabase 專案本身還有全域上限（免費方案是 50MB），**三者取最小**。
上傳是單次請求、沒有續傳，所以這個數字刻意保守——大檔續傳（TUS）是後續的事。

**離線**：房間、討論、留言可以離線看；影片本體需要連線才能播放。


## 技術

- Vite + React + TypeScript
- Supabase（Postgres + RLS + Storage + Realtime + Anonymous Auth）
- IndexedDB 本地快取
- PeerJS（WebRTC）：本機模式的即時同步
- PWA：manifest + service worker、safe-area、100dvh

## 架構：資料存放與同步

只有一套雲端架構（`src/cloud/*`），四層分工：

| 層 | 角色 |
|---|---|
| **Supabase** | persistent collaboration —— 房間、成員、版本、修改建議（含圈選範圍）、留言、我也覺得、回覆、視覺提案的**唯一永久資料來源**；海報與提案素材放 private Storage。另有一個 Edge Function 專門回傳分享連結的 Open Graph 卡片 |
| **IndexedDB** | local / offline cache —— 開過的房間離線也能看，回線後自動補同步 |
| **Supabase Realtime** | collaboration updates —— 其他人的新增、完成、回覆即時出現 |
| **PeerJS** | optional live acceleration / fallback —— 未設定雲端時的本機分享通道；連不上時只影響即時性，**永遠不影響房間能不能使用** |

寫入一律是 entity-level（單筆 comment / reply / support / message / proposal…），
不做整包 Room JSON 覆蓋，多人同時操作不會互相蓋掉。離線時寫入排入佇列，
畫面顯示「尚未同步，已保存在這台裝置」，回線自動送出且不重複。

### 權限模型

分享連結 = `#room=<uuid>&invite=<高熵秘密>`。資料庫只存 invite 的雜湊，
必須透過連結加入成為房間成員（匿名身分，只需輸入名字），所有資料表與
Storage 都以 RLS 限制在成員之內；猜到房間 id 也讀不到內容。

**分享連結只有這一種格式。** 建立雲端房間失敗時，UI 顯示「暫時無法建立分享連結」
與「再試一次」，不會退回任何看似成功、其實需要主辦方保持頁面開著的連結。

### 舊版 `#room=<6碼>` 連結

雲端房間之前的連結沒有 invite，只有在主辦方頁面還開著時才連得上：

- 主辦方自己的裝置上有 local→cloud 對應，開啟舊連結會**自動換成新版 invite 連結**
- 夥伴的新裝置沒有對應，主辦方又不在線時，畫面直接說明「這是舊版分享連結，
  請向主辦方取得新版連結」，不再無止境地 generic retry
- 主辦方在線時仍保留 PeerJS best-effort 相容

### 雲端設定

```bash
VITE_SUPABASE_URL=...                # Supabase 專案 URL（本機 stack 可用 http://127.0.0.1:54321）
VITE_SUPABASE_PUBLISHABLE_KEY=...    # publishable（anon）key，絕不放 service-role
```

金鑰**不寫在程式碼裡**，只透過部署平台的環境變數注入（見 `.env.example`）。

`npm run build` 會先跑 `scripts/check-cloud-env.mjs`：env 沒就緒時印出明確警告
（值只顯示遮罩後的指紋，log 可以安心貼）。部署流程請改用
`npm run check:cloud-env`（或 `REQUIRE_CLOUD_ENV=1`），env 沒設定就讓 build 失敗，
而不是默默出一個不能分享的版本。

- **dev（`npm run dev`）沒設定 env**：以「IndexedDB + PeerJS」本機模式運作，
  分享會給一條標示為「本機測試連結」的暫時連結
- **production build 沒設定 env**：分享沒有永久連結可以給，UI 直接說明服務無法使用，
  絕不宣稱「分享連結已建立」；console 也會印出缺哪個變數

### Supabase 專案初始化

依序執行 `supabase/migrations/`：

1. `0001_cloud_rooms.sql` — 資料表、RLS、invite RPC、Storage、Realtime
2. `0002_feedback.sql` — 我也覺得、回覆、提案表態
3. `0003_comment_regions.sql` — 修改建議的圈選範圍
4. `0004_reconcile_cloud_architecture.sql` — 移除早期簡化版 `get_room`/`save_room` 鏡像（全新專案為 no-op）

5. `0005_share_previews.sql` — 分享連結預覽（`share_previews`、`get_share_preview`、public `share-previews` bucket）

視覺提案 2.0 的新欄位（類型、狀態、說明、支持、留言、綁定的修改點）都放在既有的
`visual_proposals.payload` jsonb 裡，**不需要新的 migration**。

### 分享連結預覽（Edge Function）

貼到 LINE 的連結長這樣：

```
https://<project>.supabase.co/functions/v1/share-preview/<previewId>#room=<uuid>&invite=<secret>
                             └──── 伺服器只看得到這一段 ────┘└─── 只留在瀏覽器 ───┘
```

瀏覽器不會把 fragment 送給任何伺服器，所以預覽服務**結構上就拿不到** invite；
它只用一個匿名 RPC 讀 title / description / 縮圖路徑（連 room_id 都讀不到），
組出 Open Graph HTML，再用兩行 JavaScript 把原 fragment 原封不動交回 App。
縮圖是從原稿衍生的低解析度圖，放在獨立的 public `share-previews` bucket；
`room-assets` 維持 private。預覽失敗只會少一張卡片，永久分享連結照常可用。

```bash
supabase secrets set APP_ORIGIN=https://duigao-k7q2.zeabur.app
supabase functions deploy share-preview --no-verify-jwt   # 爬蟲沒有 Authorization header
```

`SUPABASE_URL` / `SUPABASE_ANON_KEY` 由 Supabase 自動注入；這個 function
不需要也不應該拿到 service-role key。前端沒有新的環境變數。

> 若專案曾部署過早期鏡像（有 `get_room`/`save_room`），請先跑 `0004` 再跑 `0001`–`0003`，
> 並在 Dashboard 開啟 **Authentication → Allow anonymous sign-ins**。
