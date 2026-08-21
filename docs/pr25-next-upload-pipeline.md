# 下一個 PR 的範圍：可續傳上傳與相容性轉檔

這份文件**不是**這個 PR 的內容。這個 PR 只做正式多人使用會出問題的邊界修補
（權限、封存、signed URL、上傳安全、孤兒盤點、release gate）。真正的上傳管線
換血刻意留到下一個 PR，因為它需要新的後端元件與新的失敗模式，硬塞進來只會讓
兩件事都審不乾淨。

以下是接手時需要的完整規格。

## 為什麼需要這一輪

現況（`src/cloud/videoAssets.ts`）是單一 `XMLHttpRequest` POST 到 Storage
REST endpoint。它做對了兩件事：有真實的位元組進度、用使用者自己的 token 所以
RLS 照舊。但它有三個在手機上一定會遇到的極限：

1. **中斷就從頭來。** 一支 80MB 的影片在捷運上傳到 70% 斷線，使用者要重傳 80MB。
2. **切背景可能被殺。** iOS 會回收背景分頁，沒有任何狀態可以恢復。
3. **iPhone 拍的 HEVC .MOV 在 Windows / Android Chrome 播不了。** 目前的處理只是
   在播放端顯示訊息（而且只在 `video/quicktime` 時），上傳端不知情，
   `duration_seconds` 可能是 null，時間軸對所有人都壞掉。

## 一、Resumable TUS upload

Supabase Storage 支援 TUS（`/storage/v1/upload/resumable`）。

**要做的**
- 以 `tus-js-client` 取代 `uploadVideoWithProgress` 的單次 POST。
- chunk 大小固定 6MB（Supabase 目前的要求），`retryDelays` 用指數退避。
- metadata 帶 `bucketName` / `objectName` / `contentType` / `cacheControl`，
  `objectName` 沿用現有路徑 `rooms/<roomId>/videos/<versionId>/original.<ext>`
  ——路徑不能改，Storage policy 用 `(storage.foldername(name))[2]` 認房間。
- Authorization 仍然帶使用者自己的 access token（**不要**改用 service-role）。

**驗收**
- 上傳到 50% 拔網路、恢復後續傳，總傳輸位元組明顯小於「重傳整支」。
- 續傳後 `versions` 只有一列（不會產生重複版本）。

## 二、pause / resume / retry

**要做的**
- `UploadHandle` 從現在的 `{ done, cancel }` 擴充為
  `{ done, cancel, pause, resume, state }`。
- UI（`VideoWorkspace`）在上傳中顯示暫停／繼續，錯誤時顯示重試而不是只能取消。
- 重試必須沿用同一個 upload URL（TUS 的 `uploadUrl`），不是重新開始。

**驗收**
- 暫停 30 秒再繼續，進度從暫停處往前，不歸零。
- 連續三次網路失敗後仍可手動重試成功。

## 三、Upload session recovery

**要做的**
- 在**第一個位元組送出之前**，把 `{ versionId, roomId, objectName, uploadUrl,
  fileName, fileSize, mime, createdAt }` 寫進 IndexedDB（`src/lib/store.ts`
  已經有 IndexedDB 封裝，沿用同一個 DB）。
- 上傳成功寫完 `versions` 之後刪掉這筆 session。
- App 啟動時掃描未完成的 session：
  - 檔案 handle 無法跨 session 保存 → 顯示「上次有一支影片沒傳完，要重新選檔繼續嗎？」
    使用者重新選同一個檔案（用 size + name 比對），續傳同一個 uploadUrl。
  - 使用者說不要 → 呼叫 Storage 刪掉半成品物件，並刪掉 session 記錄。
- 這同時把 `0009_asset_orphans.sql` 的孤兒來源從「分頁被關掉」縮到幾乎為零：
  現在孤兒只剩「使用者裝置再也沒有回來過」這一種。

**驗收**
- 上傳到一半直接關掉分頁 → 重開 App 會問 → 選同檔案可續傳完成。
- 選擇放棄 → `room_asset_orphan_count()` 在寬限期後仍然是 0。

## 四、HEVC / MOV → H.264 MP4 相容性代理

**問題的形狀**：iPhone 預設用 HEVC 錄影並輸出 `.MOV`。Safari 播得動，
Windows / Android Chrome 多半播不動。這不是「品質」問題，是「同一個房間裡有人
完全看不到影片」的問題——而對稿房間本來就是給不同裝置的人一起看的。

**要做的（建議順序）**

1. **上傳端先偵測、先講清楚。** 用 `MediaSource.isTypeSupported` /
   `video.canPlayType` 在上傳前判斷，若本機瀏覽器都播不動，直接告訴使用者
   「這支影片在 Android / Windows 上可能看不到，要轉檔嗎？」——不要等到別人看不到才發現。
2. **瀏覽器端轉檔（優先）**：`WebCodecs` + `mp4-muxer` 在支援的瀏覽器把
   HEVC 解碼成 H.264 MP4。優點是不需要任何伺服器、不需要新的信任邊界、
   使用者的影片不離開他自己的裝置去第三方。缺點是舊瀏覽器沒有 WebCodecs。
3. **伺服器端轉檔（後備）**：Supabase Edge Function 無法跑 ffmpeg，需要外部
   worker（例如一個小的容器服務）。若要走這條，必須先回答：
   - 誰持有 service-role key（**絕不能**是前端）
   - 轉檔輸出寫回哪個路徑（建議 `rooms/<room>/videos/<version>/h264.mp4`，
     原檔保留，`versions` 加一欄 `proxy_path`）
   - 轉檔失敗時版本要不要照樣可用（建議：可用，但標記「部分裝置可能無法播放」）
4. **資料模型**：`versions` 加 `proxy_path text` 與 `proxy_state text
   check (proxy_state in ('none','pending','ready','failed'))`。
   播放端優先用 `proxy_path`，沒有才用 `video_path`。

**驗收（需要真機）**
- iPhone 拍的 HEVC .MOV 上傳後，Windows Chrome 與 Android Chrome 都能播放。
- 轉檔中版本仍可留言（用 poster 當佔位），轉完自動可播。
- 轉檔失敗時房間不會出現「壞掉的版本」，只會出現明確的相容性提示。

## 不在下一個 PR 範圍

- 影片剪輯、裁切、字幕、濾鏡：這個產品的定位是「對稿」，不是剪輯器。
- 多軌／多影片比對。
- 轉檔品質參數的 UI。
