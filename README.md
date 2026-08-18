# 文宣討論區

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
- 視覺提案（素材 / 字體 / 文案 / 背景）與提案表態
- 分享 Bottom Sheet：複製連結、傳到 LINE、系統分享
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
  features/visual-proposal/ 視覺提案（A/B/C、素材、偏好）
  styles.css               共用樣式與桌機版面
  mobile.css               手機元件樣式（≤720px）
  usability.css            toast / 儲存狀態 / 新手引導
```

`mobile.css` 只負責手機元件本身的樣式，不再覆寫桌機版面。

## 開發

```bash
npm install
npm run dev
npm run build   # tsc --noEmit && vite build，輸出到 dist/
```

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
| **Supabase** | persistent collaboration —— 房間、成員、版本、修改建議（含圈選範圍）、留言、我也覺得、回覆、視覺提案的**唯一永久資料來源**；海報與提案素材放 private Storage |
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

### 雲端設定

```bash
VITE_SUPABASE_URL=...                # Supabase 專案 URL
VITE_SUPABASE_PUBLISHABLE_KEY=...    # publishable（anon）key，絕不放 service-role
```

金鑰**不寫在程式碼裡**，只透過環境變數（見 `.env.example`）。
未設定時整個 app 以「IndexedDB + PeerJS」本機模式運作，不會白屏。

### Supabase 專案初始化

依序執行 `supabase/migrations/`：

1. `0001_cloud_rooms.sql` — 資料表、RLS、invite RPC、Storage、Realtime
2. `0002_feedback.sql` — 我也覺得、回覆、提案表態
3. `0003_comment_regions.sql` — 修改建議的圈選範圍
4. `0004_reconcile_cloud_architecture.sql` — 移除早期簡化版 `get_room`/`save_room` 鏡像（全新專案為 no-op）

> 若專案曾部署過早期鏡像（有 `get_room`/`save_room`），請先跑 `0004` 再跑 `0001`–`0003`，
> 並在 Dashboard 開啟 **Authentication → Allow anonymous sign-ins**。
