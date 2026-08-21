# PR #29：影片自動最佳化、容量防呆與 H.264 相容化

## 背景

正式環境已確認：影片長度本身不是這次上傳失敗的原因。現行前端允許 `MAX_VIDEO_BYTES = 100MB`，但正式 Supabase Free 專案的全域單檔限制比前端小；因此使用者會先看到「可選」，等真正 POST Storage 才收到 400，最後 UI 又容易把它誤解成網路問題。

這條 PR 要修三件事：

1. **選檔當下就知道容量與可上傳性**，不要等 Storage 失敗。
2. **大檔自動最佳化後再進 #27 的 TUS 上傳**，不要叫使用者自己找壓縮工具。
3. **把能在瀏覽器安全處理的來源統一成 H.264/AAC MP4**，提升 Android / Windows / LINE 播放相容性。

核心定位仍是「影片對稿」，不是剪輯器。

---

## 一、產品體驗

使用者選一支影片後，先顯示極簡資訊：

- 檔名
- 片長
- 原始大小
- 格式／相容性狀態

例如：

> 1:02 · 73.4 MB  
> 這支影片較大，會先最佳化後再上傳。

正常小檔：

> 0:38 · 12.8 MB  
> 可以直接上傳。

不要出現 codec、bitrate、WebCodecs、TUS、Supabase 等技術詞。

---

## 二、容量規則

不要再讓 UI 固定宣稱「100MB 一定可上傳」。

新增一個單一來源的 production upload ceiling，例如：

- `VITE_MAX_VIDEO_UPLOAD_MB`

正式環境目前預設 50MB；若未設定，UI 採保守值 50MB，而不是 100MB。

實際送出前保留二次防線：

- `file.size <= directUploadLimit`：可直接 TUS 上傳
- `file.size > directUploadLimit`：進最佳化流程

最佳化輸出目標需留安全邊界，不要壓到剛好 50MB：

- target <= 42～45MB

以免封裝 metadata、重編碼差異或未來限制造成邊界失敗。

不要把 bucket 的 200MB 當成真正可上傳上限；全域限制與方案限制才是最終硬限制。

---

## 三、錯誤分類

目前 Storage 400 不能再一律顯示成「請檢查網路」。

`src/cloud/videoAssets.ts` / TUS error handler 必須分類：

- 檔案過大／payload too large → 「影片超過目前雲端可接受的大小」
- 權限/RLS → 「你目前沒有上傳這個房間影片的權限」
- Auth/session → 「登入狀態已失效，請重新整理後再試」
- 網路中斷 → 「網路中斷，可從目前進度繼續」
- 格式/解碼 → 「這支影片需要先最佳化」
- 其他未知 400 → 顯示可追蹤的短錯誤碼，但不要把 raw backend message 整段丟給使用者

同時保留開發模式 console diagnostic，方便之後直接對照 Storage response body。

---

## 四、最佳化策略

### 4.1 不要一上來就重編所有影片

只有符合任一條件才最佳化：

- 大於 direct upload limit
- 明顯高 bitrate、可安全縮小
- `.mov` / `video/quicktime`
- codec / container 在 Android / Windows / LINE 有高風險
- 使用者主動按「最佳化後上傳」

已經是小型 H.264 MP4 的影片直接走 #27 TUS，不浪費手機電量。

### 4.2 輸出規格

目標格式：

- container：MP4
- video：H.264 / AVC
- audio：AAC（來源有音訊時）
- 最大解析度：1080p，保持原始比例
- 不放大低解析度來源
- frame rate 優先保持來源；若來源 > 60fps 可降到 30/60 的合理值
- 保留音訊與畫面長度，不做裁切

bitrate 用「目標檔案大小」反推，不要固定單一 bitrate：

`targetVideoBitrate ≈ (targetBytes * 8 / duration) - audioBitrate`

並設合理上下限，避免短片畫質過差或長片超限。

### 4.3 畫質原則

「對稿」比極致壓縮重要：

- 文字／UI 畫面不能糊到看不清楚
- 1080p 優先
- 只有在容量仍超標時才降到 720p
- 不要預設 480p

---

## 五、瀏覽器端轉檔能力分級

不要假設所有瀏覽器都有同一套 codec 能力。

新增 capability probe：

- `VideoDecoder.isConfigSupported`
- `VideoEncoder.isConfigSupported`
- `MediaSource.isTypeSupported`
- `video.canPlayType`

根據結果分成：

1. `direct`：原檔直接可用
2. `browser-optimize`：本機可解碼 + 可 H.264 編碼
3. `needs-fallback`：本機無法安全轉成 H.264

對 `browser-optimize`：

- 優先用 WebCodecs
- MP4 mux 使用成熟且維護中的 muxer library
- 依賴必須動態載入，不要讓所有使用者首頁多下載一大包轉檔程式
- 轉檔在 worker 中進行，避免鎖死主 UI

對 `needs-fallback`：

第一版可以明確告知「這台裝置無法直接最佳化這支影片」，提供重新選檔；不要假裝成功。

如果要做伺服器轉檔 fallback，另開後續 PR，不能把 service-role 或 ffmpeg worker key 放前端。

---

## 六、轉檔進度 UX

不要只有 spinner。

狀態：

1. 讀取影片
2. 正在最佳化 0–100%
3. 準備上傳
4. 上傳 0–100%（沿用 #27）
5. 建立封面
6. 完成

在手機上只顯示一條主進度＋一句話，不增加新的大面板。

轉檔階段可取消。

取消後：

- 停止 worker
- revoke object URLs
- 釋放中間 Blob
- 不建立 version
- 不留下 Storage object
- 不留下 upload session

---

## 七、記憶體與手機安全

這條非常重要。

不要把整支影片同時複製成多份 ArrayBuffer。

要求：

- streaming / chunk-oriented pipeline 優先
- worker 轉檔
- transferables 可用就用
- object URL 用完立即 revoke
- 任何錯誤都 cleanup
- Android 低記憶體裝置必須能回到選檔畫面，而不是整頁 crash

對過大的來源（例如數百 MB）如果瀏覽器端無法安全處理，應在轉檔前拒絕並顯示人話，不要讓手機 OOM。

---

## 八、與 #27 TUS 的整合

#27 已經負責：

- TUS resumable upload
- pause/resume/retry
- IndexedDB upload session recovery

#29 不重寫 #27。

正確流程：

`原始 File -> 檢查 -> 必要時最佳化成 optimized File/Blob -> 交給既有 TUS uploader`

TUS object path、membership RLS、room-assets private bucket 都保持不變。

如果最佳化產生新檔：

- file name 可改成 `optimized.mp4`
- Storage object path 仍使用既有 version path，例如 `original.mp4`
- DB `file_size` 寫「實際上傳後的大小」
- 如需保留原始大小，只加 metadata 欄位，不上傳原檔副本

不要同時保存 80MB 原檔 + 35MB proxy，Free 方案下會浪費容量。

---

## 九、資料模型

第一版盡量不需要新增大型資料表。

可在 `versions` 增加最小 metadata（若實際需要）：

- `source_file_size bigint`
- `optimized boolean default false`
- `optimization_note text`（可選，內部用途）

不要保存：

- 原始本機路徑
- codec dump
- 裝置 fingerprint
- 完整 ffprobe JSON

如果沒有產品價值，不要為了紀錄而增加 schema。

---

## 十、目前這次 bug 的直接修復

即使轉檔功能尚未完成，這條 PR 第一個 commit 就先修：

1. 選檔畫面顯示 `片長 · 檔案大小`
2. production safe limit 改為目前實際可接受的上限
3. 超限時不要進 Storage 才失敗
4. Storage 400/413 不再顯示成網路錯誤
5. 顯示「這支影片太大，會先最佳化」或「目前需要壓縮後再上傳」

這部分可獨立測試，不能等整個 transcoder 做完才修 UX。

---

## 十一、測試

### A. 容量防呆

- 12MB MP4 → 直接上傳
- 49MB MP4 → 依 production ceiling 正確判斷
- 55MB MP4 → 不送 direct upload，先進最佳化
- Storage 回 400 size error → 顯示容量錯誤，不顯示網路錯誤

### B. 自動最佳化

- 1 分鐘約 70–90MB 的 1080p MP4 → 輸出 <= safe target，仍為 1080p 或必要時 720p
- 音訊存在 → 輸出仍有音訊
- duration 誤差極小，不可讓時間留言全部偏移
- 直式 9:16 → 比例不變
- 橫式 16:9 → 比例不變

### C. H.264 相容性

可本機轉檔的來源：

- 輸出 MP4/H.264
- Android Chrome 可播放
- Windows Chrome 可播放
- LINE in-app browser 可播放

若來源 codec 本機無法解：

- 不 crash
- 顯示 fallback 訊息
- 不建立壞 version

### D. #27 regression

最佳化後的 Blob：

- 仍走 TUS
- 拔網路可續傳
- pause/resume 正常
- reload recovery 正常
- 不產生 duplicate version

### E. 圖片功能 regression

圖片房所有流程完全不動。

---

## 十二、不做

本 PR 不做：

- 剪輯
- 裁切
- 字幕
- 濾鏡
- 多軌
- waveform
- A/B 同步雙播
- AI 影片強化
- 上傳原始檔備份
- 公開 Storage
- 前端 service-role

---

## 十三、完成標準

以下全部成立才算完成：

1. 使用者選一支 1 分鐘高畫質影片時，先看到片長與大小。
2. 超過目前雲端安全上限，不會先傻傻 POST 再 400。
3. 能在本機處理的大檔，自動最佳化後進 TUS。
4. 最佳化後不超過 production safe target。
5. 時長基本一致，時間碼對稿不漂移。
6. Android / Windows / LINE 可播放 H.264 MP4 輸出。
7. 不支援本機轉檔的來源，給清楚 fallback，不 crash。
8. #27 的續傳／恢復完全保留。
9. 取消或失敗不留下 Storage 孤兒與空 version。
10. `npm run build`、影片 e2e、分享 e2e、migration/security tests 全部通過。

完成後保持 Draft，不自行 merge。