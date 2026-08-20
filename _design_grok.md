# PR #23 設計審查（Grok）

審查對象：`docs/pr23-video-review-plan.md` + 已落地的 `supabase/migrations/0006_video_rooms.sql`、`src/cloud/videoAssets.ts`、`src/features/video-review/media.ts`。
對照事實：`0001` / `0003` / `0005`、`roomRepository.ts`、`sharePreview.ts`、`useCloudRoom.ts`、`assets.ts`、`types.ts`、`mock-supabase.mjs`。
原則同意：同一套 room / invite / RLS / Storage / Realtime / comments；圖片＝空間、影片＝時間；不另開 `video_versions`。下面只講會出事的決定。

---

## 1. schema：`image_path` 借給 poster、`video_path` 存影片、drop NOT NULL

### 複合外鍵會不會壞？

**不會。** `share_previews_version_in_room` 是 `(version_id, room_id) → versions(id, room_id)`（`0005` + `idx_versions_id_room`）。它不讀 `image_path`。加欄、drop NOT NULL、影片列 `image_path` 為 null，都不碰這條 FK。既有圖片房間的 versions 列本來就有 `image_path`，不受影響。`get_share_preview` 讀的是 `share_previews.thumbnail_path`，不是 `versions.image_path`，函式本體確實可以零改動。

真正會壞的不是 FK，是 **client 假設 `image_path` 永遠有值**：

- `loadRoom`：`signedUrl(supabase, row.image_path)`。`image_path` 為 null 時整房 load 丟錯，影片房間打不開。
- `VersionRow.image_path: string`、`Version.imageDataUrl: string` 都還是必填。
- `sharePreview.versionImageUrl`：`if (!data?.image_path) throw`。沒 poster 的影片房分享會走失敗路徑（PR #21 允許降級成純文字卡，這段可以接受）。

### drop NOT NULL 對 RLS / replica identity full / PostgREST？

**這三個都沒有實質副作用。**

| 面 | 判斷 |
|---|---|
| RLS | `versions_all` 只看 `is_room_member(room_id)`，不讀 `image_path`。政策不用改。 |
| REPLICA IDENTITY FULL | 識別的是「整列」，不是 NOT NULL。新欄位（含 null）會進 WAL／Realtime payload；內容是 path 字串，不是影片位元組。舊訂閱者走 `scheduleReload` → `select *`，多欄位會被忽略。 |
| PostgREST | nullable 欄位在 insert 時可省略。舊前端 insert version 本來就帶 `image_path`，不受影響。schema cache 重載後 `select *` 多幾個欄。 |

`0006` 註解寫「widening a column is safe」——對這三層是對的。不安全的是上面那個 client 契約。

### 有沒有更乾淨、又不用動 share_previews 的做法？

**有：繼續把 poster 寫進 `image_path`（這層借用是對的），但不要 drop NOT NULL。**

poster 擷取失敗時寫一張品牌 fallback JPEG（純色 + 標題「影片」），再上傳到既有 `versionPath(...)`。這樣：

- `share_previews` / OG / `loadRoom` / `Version.imageDataUrl` **契約不變**
- 影片卡永遠有圖，不會變成「FK 沒壞但分享管線 throw」
- `versions_media_shape` 可以改成更硬：image 必有 `image_path`、video **兩者都要有**（`video_path` + `image_path`）

`image_path` 對影片來說語意是「封面」不是「文宣原稿」，這是刻意的謊，但換來 OG 管線零改動，划算。另開 `poster_path` 再 `coalesce` 反而要動 `sharePreview.ts`，比借用更髒。

**結論：借用 `image_path` = 通過。drop NOT NULL = 反對。** 失敗模式用 fallback 圖處理，不要用 null 把錯誤延遲到 load / 分享。

---

## 2. comments：`anchor_type` + 時間欄 + backfill + CHECK

### 有既有資料 + 舊前端還在跑，這支 migration 安全嗎？

**既有資料：安全。** `ADD COLUMN ... DEFAULT 'image-point'` 填舊列，接著 `UPDATE ... WHERE region IS NOT NULL AND anchor_type = 'image-point'` 把圈範圍列改成 `image-region`，然後才加 CHECK。順序對。舊列時間欄是 null，通過 `comments_anchor_time_shape`。

**舊前端持續 insert：不會炸掉，但會寫出「CHECK 合法、語意髒」的列。**

`insertComment`（`roomRepository.ts`）送的是 `id, room_id, version_id, author_name, author_color, x, y, region, body, ...`，**不帶 `anchor_type` / `time_seconds`**。Postgres 對「JSON 沒出現的欄」套 DEFAULT → `anchor_type='image-point'`，時間欄 null。`comments_anchor_time_shape` 只約束時間，**不管 `region`**，所以：

- 舊前端插 **點評**：DEFAULT `image-point` + 時間 null → 通過，正確。
- 舊前端插 **圈範圍**：DEFAULT `image-point` + `region` 有值 → **也通過**。Migration 的 backfill **不會**在之後的 insert 再跑一次。

若新前端改成只信 `anchor_type === 'image-region'`，這些列會被畫成點。現在的 `commentFromRow` 是看 `region` 有沒有，所以 **過渡期只要讀側繼續「region 優先、anchor_type 次之」就不會壞畫面**。

舊前端不會去插影片房的時間錨（它根本沒那個 UI）。它若因 `rooms.media_type` 沒被設成 `video` 而走進 ImageWorkspace，會在 poster 上釘 x/y=0.5 的 `image-point`——那是路由問題，不是 CHECK 問題。

**不要**把 CHECK 寫成 `image-point ⇒ region IS NULL`：舊前端立刻 23514，comment 進 `offline-pending` 隊列，看起來像同步壞掉。

可選、我建議加：`BEFORE INSERT OR UPDATE` trigger，`IF NEW.region IS NOT NULL AND NEW.anchor_type = 'image-point' THEN NEW.anchor_type := 'image-region'`。比收緊 CHECK 更適合混版期。

### CHECK 什麼形狀以後最不容易卡住（PR #24 video-region）？

`0006` 現在這份 **通過，而且是對的形狀**：

1. **種類清單單獨一條** `comments_anchor_type_check`（`IN (...)`）。PR #24 只要沿用 `0003` 的 `DROP IF EXISTS` + `ADD` 加一個值。
2. **時間形狀用 `anchor_type LIKE 'video-%'`**，不要枚舉四個 kind。`video-region` 自動變成「要有 `time_seconds`、`end_time_seconds` 必須 null」。這正好符合計畫裡「PR #24 沿用 x/y、仍是時間上的一個瞬間」。
3. **不要約束 x/y/region。** `comments.x/y` 本來就是 `NOT NULL DEFAULT 0.5`。若 CHECK 寫「影片錨 x/y 必須是 0.5」或「影片不能有 region」，#24 會卡死。現在沒寫，對。

#24 若變成「時間範圍 + 畫面位置」，現有規則會逼你再加一個 kind（例如 `video-range` 已佔 end 欄）。屆時只改時間那條 CHECK，不要現在預支。

嚴格大於 `end_time_seconds > time_seconds` 保留。相等當 point，客戶端先正規化再 insert。

### 哪些寫法第二次執行會爆？（對照 `migrations.mjs` 會重跑）

`0006` **就目前這份來看，重跑不會爆**。它有抄 `0003`/`0005` 的功課。下面是「若照計畫草稿裸寫」會爆、以及這份 SQL 還剩的非爆炸腳槍：

會爆（`0006` 已避開）：

- `ADD COLUMN` 沒有 `IF NOT EXISTS`
- `ADD CONSTRAINT` 沒有先 `DROP IF EXISTS`
- `CREATE INDEX` 沒有 `IF NOT EXISTS`
- backfill 寫成無條件 `SET anchor_type='image-region' WHERE region IS NOT NULL`（第二次會把已經是 `video-*` 但誤帶 region 的列改回去）。現在有 `AND anchor_type = 'image-point'`，第二次是 no-op。

不會爆但會副作用：

- `ALTER COLUMN image_path DROP NOT NULL`：第二次是 no-op。OK。
- `UPDATE storage.buckets SET file_size_limit = 200MB WHERE ... <> 200MB`：第二次 no-op；但若有人在 Dashboard 改成別的值，**重跑會被改回 200MB**。e2e 沒差，正式專案重跑有差。
- `0004` 改 storage 有 `exception when undefined_table`；`0006` 沒包。對真實 Supabase 與 shim 都有 `storage.buckets`，e2e 過。不要在沒 shim 的裸 Postgres 單獨跑它。

沒做、所以也不會爆：沒改 `create_room_with_invite` 簽名。代價是影片房必須在 RPC 之後 `UPDATE rooms SET media_type='video'`。忘記的話 DEFAULT 是 `'image'`，router 會把影片房送進 ImageWorkspace。

`migrations.mjs` 現在只重跑 `0005`。PR #23 應比照加一行重跑 `0006`，並加探針：舊形 insert（不帶 `anchor_type`、帶 `region`）仍成功；`image_path` null 的 image 列被 `versions_media_shape` 擋下；video 列沒有 `video_path` 被擋下。

---

## 3. Storage 路徑、大小上限、signed URL + Range

### `(storage.foldername(name))[2]` 路徑深度對嗎？

**對。** shim 與 `0001` 的約定：`foldername` 回「去掉最後一段的陣列」，1-indexed。

```
rooms/<roomId>/videos/<versionId>/original.mp4
→ {rooms, <roomId>, videos, <versionId>}
→ [2] = roomId
```

跟既有 `rooms/<roomId>/versions/<versionId>/poster.jpg` 同一層級的 roomId。四條 `room_assets_*` 政策不用改。`videoAssets.ts` 的 `videoPath()` 符合這個深度。

錯的例子：`rooms/<roomId>/<versionId>/original.mp4`（少一層）或 `videos/<roomId>/...`（[2] 不是 uuid，政策 cast 失敗）。現在不是。

### 大影片上限怎麼設才誠實？SQL 改 `storage.buckets` 有沒有雷？

**`0006` 寫 200MB、不碰 `allowed_mime_types`：方向對。** 理由：

- 專案層級上限（Free 目前約 50MB，Pro 可到數十 GB）是硬頂。bucket 的 `file_size_limit` 再取 min。SQL 設 200MB **不會**讓 Free 專案真的能傳 200MB。`media.ts` 的錯誤文案有講這件事，保留。
- **標準 upload**（`storage.from().upload()` / 單次 XHR）：官方建議 >6MB 改 TUS。200MB 走單次 POST，手機熱點 / LINE 背景殺頁會中斷且無法續傳。Kong／Cloudflare 也有請求超時。
- **TUS resumable**：`POST /storage/v1/upload/resumable`，chunk **必須 6MB**（Supabase 現在寫死）。這才是 200MB 這個數字配得上的協定。
- SQL 改 `storage.buckets.file_size_limit` **可以**，`0005` 已對 `share-previews` 做過，storage-api 認這欄。雷：
  1. 作用於 **整個** `room-assets`（海報、proposal 素材一起）。200MB 對圖片無害；不要設成 2GB「以防萬一」。
  2. **不要**設 `allowed_mime_types`。一設漏掉現有的 `image/svg+xml` / `gif` / `webp`，圖片房上傳會 400。`0006` 刻意保持 NULL，對。
  3. 與 Dashboard「最大檔案大小」雙重來源；重跑 migration 會覆蓋人工改值。
  4. 413 的錯誤訊息來自 storage-api，XHR 路徑已把 413 翻成中文（`videoAssets.ts`）。

誠實組合：客戶端硬頂 200MB（或 Free 就顯示 50MB）+ bucket 200MB + **上傳用 TUS**。單次 XHR 配 200MB 是自我安慰。

### signed URL 播影片，Range / 206 行不行？

**行，這是 Storage 支援的路徑，不是新賭局。** 官方從 Storage beta 就說用 Range 串流媒體。`<video src={signedUrl}>` 的 seek 會帶 `Range`，後端應回 `206` + `Content-Range` + `Accept-Ranges: bytes`。

已知限制（不要當沒有）：

1. 必須打 **object 端點**（`/storage/v1/object/sign/...`）。影像轉換 `/render/image` 不吃影片、也不保證 Range。
2. 舊 bug（storage#322、discussion #4115）曾發生 signed URL **不回 `Accept-Ranges` / 忽略 Range**。Safari 對此特別嚴（沒有 206 就整檔下載或不能 seek）。**真機 Safari 必測**，mock 測不到（見下）。
3. CORS：若以後從 canvas 擷遠端影格，要 `crossOrigin="anonymous"`，且 bucket CORS 暴露 `Content-Range`、`Accept-Ranges`、`Content-Length`。上傳當下用 **本地 blob URL** 擷 poster（`media.ts` 已這樣做），這條暫時不是上傳路徑的雷。
4. token 在 query string，每次 Range 重送同一條 URL。過期後所有 Range 變 403，看起來像「seek 壞了」。
5. **未 faststart 的 MP4**（`moov` 在檔尾）：瀏覽器在下載完之前不能 seek。Storage 不會幫你搬 atom。錯誤文案要說「請匯出成網頁用 MP4（fast start）」。
6. `mock-supabase.mjs` 的 sign/serve **永遠 200 整份 body**，沒有 Range。e2e 的 canvas.captureStream webm 又很小，**seek / 206 完全沒被測到**。

`VIDEO_URL_TTL = 6h` + 播放錯誤重簽：比計畫裡的 1h 務實。仍要在 error / 403 時重簽並 **restore `currentTime`**，不要只換 `src`。

---

## 4. 上傳進度：supabase-js 沒有 progress

**判斷：XHR 直打同一個 Storage REST 端點是可行做法，而且沒有繞過 RLS。200MB 這個上限則應該改 TUS（一樣有 progress）。**

`videoAssets.ts` 現況（XHR）是對的骨架：

```
POST ${SUPABASE_URL}/storage/v1/object/room-assets/${encodeURI(path)}
Authorization: Bearer ${session.access_token}   // supabase.auth.getSession()
apikey: ${SUPABASE_PUBLISHABLE_KEY}
Content-Type: video/mp4（或實際 mime）
x-upsert: true
Cache-Control: 3600
body: File / Blob（raw，不是 FormData）
xhr.upload.onprogress → loaded/total
```

- token 是 **匿名使用者的 JWT**，不是 service role。`ensureSession` → `signInAnonymously`。Storage 用這顆 JWT 跑 `room_assets_insert`：`is_room_member((foldername(name))[2])`。路徑是 `rooms/<roomId>/...`，[2] 是 roomId。**RLS 全數生效。** 不是另一條後門。
- 跟 `storage.from().upload(..., { upsert: true })` 打的是同一支 API。差別只有瀏覽器能報 progress。
- 沒有 session 就 upload：現在會丟「尚未登入」。對。影片房必須先 `create_room_with_invite` 再傳，順序不能反。

TUS 做法（建議當 200MB 的主路徑，XHR 留作小檔 fallback）：

```
endpoint: ${SUPABASE_URL}/storage/v1/upload/resumable
headers: { authorization: `Bearer ${session.access_token}`, apikey: PUBLISHABLE_KEY, 'x-upsert': 'true' }
metadata: { bucketName: 'room-assets', objectName: path, contentType: mime, cacheControl: '3600' }
chunkSize: 6 * 1024 * 1024   // 不准改
onProgress(bytesUploaded, bytesTotal)
```

TUS 一樣帶 user JWT，一樣走 Storage 政策，**一樣不繞 RLS**。多了斷點續傳，LINE 把頁面丟背景時救得回來。`tus-js-client` 的 `onProgress` 就是「正在上傳影片 46%」。

不要用假 timer 假裝進度。不要把影片讀成 data URL（計畫寫了，對：永遠不進 Room JSON / IDB / Postgres / Realtime）。

失敗序：先傳 video、再傳 poster、最後 insert version。version insert 失敗（例如 `duration_seconds = 0` 撞 CHECK）要刪掉已上傳的 object，否則 private bucket 會堆孤兒。

---

## 5. 播放效能：currentTime 每幀更新 vs 討論列表

計畫「rAF 寫 ref + DOM transform，React state 250ms 一次，列表 memo」方向對。**最容易寫錯的 3 個地方：**

1. **`currentTime` 從父層 props/context 漏進討論列表。**  
   就算 250ms 才 `setState`，只要 `VideoWorkspace` 用 `comments.filter(c => c.time <= now)` 或 inline `style={{...}}` / `onClick={() => seek(c.time)}` 當 props，`memo(CommentCard)` 會因為新 array／新 closure 每 250ms 全數重繪。更糟的是把 playhead 放進包著整個 workspace 的 context。  
   **做法：** playhead 只存在 player/timeline 的 ref；討論列表的 React state 最多是「目前高亮的 comment id」（有換才 set）。列表 props 是 `room.comments`，不帶時間。

2. **seek 回饋迴圈。**  
   rAF 讀 `video.currentTime` → setState → `useEffect` 再寫回 `video.currentTime`。時間軸拖曳與播放搶同一個 state，Chrome 會頓、Safari 會跳。  
   **做法：** 拖曳中設 `scrubbingRef=true`，rAF 不寫 state；鬆手才 `video.currentTime = t`。播放中 **禁止** 用 React state 去 seek，只讓 video 當唯一時間來源。

3. **Realtime `scheduleReload` 在播放中重簽 URL、換 `video.src`。**  
   `loadRoom` 對每個 version 做 `signedUrl`。任一則 comment insert 都會 200ms debounce 後整房 reload。若 snapshot 把新的 signed `videoUrl` 寫進 `Version` 又觸發 `<video src>` 更新，播放器重載、`currentTime` 歸零。這比 16ms 重繪更像「同步成功但影片跳回開頭」。  
   **做法：** player 以 `videoPath` 當身份，path 沒變就不要換 `src`。snapshot 不要因為重簽而視為新媒體。高亮「已播過的 marker」用 timeline 自己的 DOM／canvas，不要每 tick 對 N 個 React marker 做 className。

附帶：不要用 `ontimeupdate` **又** 用 rAF 雙寫。不要每 250ms `scrollIntoView` 當則討論（手機抖到不能滑）。

---

## 6. 最可能真的出 bug 的 10 個邊界

1. **`duration` 讀到 0 / `Infinity` / `NaN`**  
   `probeVideo` 已處理 Infinity（seek `1e101`），失敗回 0。但 `versions_duration_sane` 是 `duration_seconds > 0`。若 upload 把 0 寫進 DB，**影片已在 Storage、version insert 23514**。  
   **處理：** 讀不到就寫 `NULL`，不要寫 0。時間軸進入「沒有總長」模式：仍可播、可釘 point，range 工具關掉。上傳不要因缺 duration 拒絕。

2. **iOS Safari canvas 擷不到 poster**  
   上傳路徑用本地 object URL，理論上不 taint。但 `capturePoster` 對 blob URL 仍設了 `crossOrigin="anonymous"`，部分 Safari 會因此 **整段 video 載入失敗**，poster 變 null。加上 iOS 在未真正 decode 前 `drawImage` 得到黑幀。  
   **處理：** `blob:` / `file:` 不要設 `crossOrigin`。seek 後若像素接近全黑，改試 0 / 1s / 中間幀。最終仍失敗就寫 fallback JPEG（呼應 §1：不要靠 null `image_path`）。遠端 signed URL 重擷封面：另議，且必須 CORS。

3. **range 的 end ≤ start**  
   CHECK 嚴格 `>`，insert 直接失敗，UI 以為送出了、進 offline-pending。手指在時間軸反向拖很常見。  
   **處理：** composer 正規化（swap 或 |end-start|<0.1s 當 point）再寫庫。讀側也 clamp，防舊髒資料。

4. **切版本時 `currentTime` 超過新片長**  
   未 clamp 的 `video.currentTime = 87` 打在 15s 的片子上，有的瀏覽器停在尾、有的靜音卡住。  
   **處理：** 換 version 先 pause，等 `loadedmetadata`，`currentTime = min(prev, duration - 0.05)`；duration 未知則歸零。同一房間不會混 image/video（`rooms.media_type`），但版本時長可以差很多。

5. **signed URL 過期**  
   6h 仍可能：分頁掛著、筆電蓋上、隔夜。過期後 `Range` 變 403，使用者感覺是「拉進度條沒反應」。  
   **處理：** `video.onerror` **以及** 任何 403 都重簽，設回 `src` 後 seek 回原時間。TTL 80% 主動換簽。path 留下（`videoPath` 已有），token 不進 Realtime。

6. **LINE in-app 自動播放 / `playsInline`**  
   iOS WKWebView：有聲 autoplay 一定失敗；沒有 user gesture 的 `play()` promise reject。LINE 全螢幕常常是壞的。  
   **處理：** 預設暫停 + poster；第一次播放必須來自 click/tap；`muted` + `playsInline` + `webkit-playsinline` 都設。不在進房時 autoplay。全螢幕失敗就忽略，不要當成 fatal。

7. **iPhone HEVC `.mov`（`video/quicktime`）**  
   `acceptVideoFile` 放行，Safari 播得出，**桌面 Chrome / Android Chrome 常常不能**。主辦用 iPhone 傳、夥伴用 Windows 開，看到「黑畫面／不能播」。  
   **處理：** player 用 `canPlayType`；不行就明確說「這支是 iPhone 格式，請用 Safari 開，或請主辦轉成 MP4（H.264）」。不要假裝會轉檔。E2E 的 MediaRecorder webm 測不到這條。

8. **`create_room_with_invite` 不寫 `media_type`**  
   新欄 DEFAULT `'image'`。影片建立流程若只打現有 5 參數 RPC、忘記 follow-up UPDATE，router 把房送到 ImageWorkspace，poster 當文宣、所有時間錨變成畫面中央的點。  
   **處理：** 建房後立刻 `UPDATE rooms SET media_type='video'`（成員 RLS 允許 update）。或擴充 RPC（必須 `DROP FUNCTION` 舊簽名再重建，並重 grant；否則變成 overload，client 打到舊的）。`0006` 沒做 RPC，這是實作必補項。再加一個軟保證：該房所有 versions 的 `media_kind` 必須等於 `rooms.media_type`（trigger 或 CHECK 不好跨表，client + 探針就夠）。

9. **`loadRoom` 遇上 `image_path` null**  
   見 §1。poster 失敗 + drop NOT NULL = 整房進不去，比「沒封面」嚴重。  
   **處理：** 不要 drop NOT NULL（首選）；或 `loadRoom` 對 null 給空字串／placeholder，**絕對不要**讓一支壞 version 拖垮 `Promise.all`。

10. **MP4 未 faststart + mock 不支援 Range**  
    相機/剪輯輸出的 mp4，`moov` 在尾。Chrome 可能等到下載完才給 duration；Safari seek 失敗。e2e mock 永遠 200，綠燈沒意義。  
    **處理：** 產品文案要求「網頁用 MP4」。真機測一支 iPhone 直出 mov、一支未 optimized mp4、一支 faststart mp4。mock 至少對 `Range` 回 206（可選），否則標明「Range 不在 e2e 範圍、靠真機」。

額外兩個值得寫進測試但不佔滿 10 名：浮點時間（12.999 vs 13，高亮用區間不是 `===`）；上傳 100% 後 insert 失敗留下 Storage 孤兒（刪 object）。

---

## 總評（給 Claude 的可執行清單）

通過、不要改：

- 不開平行 `video_versions` 表
- poster 進 `image_path`，本體進 `video_path`（為了 OG 零改動）
- 路徑 `rooms/<roomId>/videos/<versionId>/original.<ext>`
- 不加 `allowed_mime_types`
- comments 時間 CHECK 用 `LIKE 'video-%'`，不鎖 x/y
- XHR 帶 user JWT + `apikey`，不繞 RLS
- 影片位元組不進 JSON / IDB / Realtime

請改：

1. **不要 drop `image_path` NOT NULL**；擷取失敗寫 fallback JPEG。
2. **`duration` 未知寫 NULL 不寫 0**，否則撞 `versions_duration_sane`、影片已上傳列插不進。
3. 混版期讀 comments **以 `region` 為準推 `image-region`**；可加 trigger，不要 CHECK 禁 `image-point`+region。
4. 建影片房 **務必寫 `media_type='video'`**（RPC 後 UPDATE 或擴充 RPC）。
5. `loadRoom` 必須能容忍缺 poster；player 以 `videoPath` 穩定 `src`，reload 不重掛播放器。
6. 200MB 用 **TUS**（chunk 6MB）當主上傳；XHR 當小檔。專案若是 Free，UI 講 50MB。
7. Safari / LINE 真機測 Range seek、HEVC、autoplay；不要相信 mock 的 200 OK。
8. `migrations.mjs` 重跑 `0006` 並加舊形 insert / media_shape 探針。

`0006` 的 idempotent 寫法本身比計畫草稿乾淨，重跑不會爆。剩下的風險幾乎都在「SQL 放寬了、client 還沒放寬」以及「200MB + 單次 XHR + Free 50MB」三套數字沒對齊。
