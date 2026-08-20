# PR #23 — 影片對稿工作區基礎版（圖片／影片雙工作區分離）

## 一、核心原則

圖片 = 空間座標（x/y、region）。影片 = 時間座標（point / range）。
**底層共用（cloud / room / invite / RLS / Storage / Realtime / 討論系統），介面分離（Workspace 各自一套）。**
沒有任何 `if (mediaType === "video")` 散落在圖片工作區裡；分歧只發生在一個 router。

## 二、檔案架構

```
src/components/RoomWorkspace.tsx      ← 唯一的分歧點：依 room.mediaType 選 shell
src/features/image-review/            ← 既有圖片工作區（整批 git mv，內容不動）
  ImageWorkspace.tsx                    App 原本的 isMobile 分支 + 桌機 header，逐字搬移
  MobileWorkspace.tsx / DesktopWorkspace.tsx / Stage.tsx
src/features/video-review/            ← 全新
  VideoWorkspace.tsx  VideoPlayer.tsx  VideoTimeline.tsx
  VideoCommentComposer.tsx  VideoDiscussion.tsx  VideoVersionSelector.tsx
  media.ts（驗證／metadata 探測／poster 擷取）  video.css
src/features/discussion/              ← 兩邊共用的討論元件（git mv）
  CommentCard.tsx  PinFields.tsx
src/components/                       ← 通用 UI 基礎設施，不分媒體
  BottomSheet UploadZone ShareSheet icons api.ts Home
src/cloud/                            ← 完全共用，不複製第二套
```

## 三、資料模型（延續，不另開平行世界）

`versions` 表可以合理擴充就延續（§8）：影片與圖片共用 `label / sort_order / mime_type / width / height`，
只新增 3 個真正屬於影片的欄位。**關鍵決定：`image_path` 對影片版本存的是 poster frame。**
poster 本來就是一張圖，這讓 `share_previews`／OG 縮圖管線**零改動**就能拿到影片封面。

```sql
versions += media_kind text not null default 'image' check in ('image','video')
         += video_path text            -- 影片本體（僅 video）
         += duration_seconds double precision
         += file_size bigint
versions.image_path drop not null      -- 影片 poster 擷取失敗時仍可存在（降級不擋路）
+ check: image 版必須有 image_path；video 版必須有 video_path
```

`comments` 延續（§29），加時間錨點：

```sql
comments += anchor_type text not null default 'image-point'
              check in ('image-point','image-region','video-point','video-range')
         += time_seconds double precision
         += end_time_seconds double precision
backfill: region is not null → anchor_type='image-region'   （純推導，無資料遺失）
+ check: 圖片錨點時間欄位必須為 null；video-point 只有 time；video-range 需 end > start
```

`rooms += media_type text not null default 'image'` — 舊房間自動 normalize 成 image（§3）。

**不新增 video_versions 表**：欄位重疊度高（6/9），且 `comments.version_id` 與
`share_previews (version_id, room_id)` 複合 FK 都指向 versions，另開一張表會逼我動這兩條
既有外鍵——那才是真正會弄壞圖片房間的改動。

**不改 `get_share_preview`**：影片卡片所需的一切（標題、影片專屬 description、poster 縮圖）
都已經在既有欄位裡。Edge Function 與匿名可讀面**一個位元都不動**。

## 四、Storage（延續 private 模型）

```
rooms/<roomId>/videos/<versionId>/original.<ext>   ← 影片本體（private）
rooms/<roomId>/versions/<versionId>/poster.jpg     ← poster（沿用既有 versionPath）
```
`(storage.foldername(name))[2]` 仍然是 roomId → **四條 room_assets 政策一行都不用改**。
bucket 維持 private；OG 只用衍生縮圖進 public `share-previews` bucket。

## 五、時間錨點（§11／§42）

```ts
type VideoAnchor =
  | { kind: "point"; time: number }              // 秒，number，不是 "00:13" 字串
  | { kind: "range"; startTime: number; endTime: number };
```
未來 PR #24 的畫面位置標記可直接沿用 comments 既有的 x/y 欄位，無需再遷移。

## 六、上傳（§6／§36）

不經過 `fileToDataUrl`。File → 驗證（MIME 白名單 + 大小 + duration）→ 探測 metadata →
canvas 擷取 poster（`min(duration*0.1, 3s)`，太短取中間）→ **XHR 直傳 Storage 並回報進度** →
寫入 version row。影片位元組永遠不進 Room JSON / IndexedDB / Postgres / Realtime。

影片房間在**建立時**就開雲端房（不像圖片是分享時才開）——因為 §43 要求主辦方關頁後 B 仍能播放，
且 Storage 路徑本來就需要 roomId 與 membership。

## 七、播放與時間軸

- 播放器：play/pause、seek、音量、靜音、全螢幕、倍速（收在更多）、點中央播放/暫停、鍵盤 Space/←/→
- `currentTime` 走 **requestAnimationFrame**，只寫入 ref + 直接改 DOM transform；
  React state 每 250ms 才更新一次（§16），討論列表用 memo，不會每幀重繪
- 時間軸：playhead + point marker（●）+ range segment（━━）+ 選取態；已完成的 marker 視覺弱化（§19）
- signed URL 一小時到期 → 播放錯誤時自動重新簽章並續播（既有管線沒有這個保護）

## 八、測試

`scripts/e2e/video-flow.mjs`（沿用 mock-supabase + Playwright 慣例，webm 由頁內
`canvas.captureStream + MediaRecorder` 現生，不 commit 二進位 fixture）涵蓋 §39 A–K；
`migrations.mjs` 增加新欄位／constraint／RLS 探針；圖片回歸沿用既有 `test:share-e2e`。
