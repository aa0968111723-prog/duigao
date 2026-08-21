# PR #27 — 影片可續傳上傳與斷線恢復

## 目標

把目前「單次 XHR，上傳途中斷線就整支重來」改成真正適合手機與 LINE 使用情境的可續傳上傳。

本 PR 只做**可靠上傳**：TUS、暫停/繼續、網路重試、分頁關閉後恢復。

**不在本 PR 做 HEVC/MOV 轉檔**，避免把上傳可靠性和影音轉碼兩個高風險系統綁在一起。

---

## 現況

目前 `src/cloud/videoAssets.ts` 使用單一 `XMLHttpRequest POST` 直傳 Supabase Storage：

- 有真實進度
- 使用使用者自己的 access token，RLS 正常
- 路徑固定 `rooms/<roomId>/videos/<versionId>/original.<ext>`

但缺點：

- 網路中斷後只能整支重傳
- App 被背景回收後沒有 session 可恢復
- 上傳 70% 失敗時，使用者成本接近重傳 100%

---

## 一、改用 Supabase TUS resumable upload

使用 Supabase Storage resumable endpoint：

`/storage/v1/upload/resumable`

建議採用 `tus-js-client`。

要求：

- chunk size 固定 6MB
- retryDelays 使用指數退避，例如 `0, 1000, 3000, 5000, 10000`
- metadata：
  - `bucketName=room-assets`
  - `objectName=rooms/<roomId>/videos/<versionId>/original.<ext>`
  - `contentType`
  - `cacheControl=3600`
- Authorization 必須仍然使用目前匿名使用者自己的 access token
- 絕對不能把 service-role key 放進前端
- object path 不可改，因為 0007 Storage policy 依路徑判斷 room capability

成功後仍由既有 `videoRoom.ts`：

1. 上傳影片
2. 上傳 poster
3. 寫 `versions` row

資料模型不分叉。

---

## 二、UploadHandle

把目前：

```ts
{ done, cancel }
```

擴充成概念上：

```ts
{
  done,
  cancel,
  pause,
  resume,
  retry,
  getState
}
```

狀態至少：

- preparing
- uploading
- paused
- retrying
- processing
- completed
- cancelled
- failed

不要把 transient 網路錯誤直接變成整個版本失敗。

---

## 三、手機 UI

維持簡單，不增加主導航。

上傳卡只顯示：

- 檔名
- 真實百分比
- 已上傳 MB / 總 MB
- 暫停 / 繼續
- 取消

網路中斷時：

> 網路中斷，會從目前進度繼續。

正在自動重試：

> 正在重新連線…

多次失敗後才顯示：

> 還沒傳完，可以繼續上傳。
>
> [繼續] [取消]

禁止使用者看到 TUS、chunk、upload URL 等技術字眼。

---

## 四、Upload session persistence

在第一個 chunk 送出之前，把 session 寫入 IndexedDB。

建議資料：

```ts
VideoUploadSession {
  id
  roomId
  versionId
  objectName
  uploadUrl?
  fileName
  fileSize
  lastModified
  mime
  createdAt
  updatedAt
  state
}
```

注意：瀏覽器一般無法可靠跨 session 保存原始 File bytes。

App 重開後如果有未完成 session：

> 上次有一支影片還沒傳完。
>
> 重新選同一支影片，就能從上次進度繼續。

重新選檔後必須至少比對：

- fileName
- fileSize
- lastModified（可用時）

若不匹配，不得把另一支影片接到舊 upload URL。

---

## 五、TUS fingerprint

請明確定義穩定 fingerprint，至少包含：

- Supabase project origin
- bucket
- objectName
- file.name
- file.size
- file.lastModified

同一版本重試必須找到同一 resumable upload。

不同房間 / 不同 versionId 即使檔名相同，也不能誤接。

---

## 六、取消與清理

使用者按「取消」：

- 停止目前 TUS upload
- 清掉 IndexedDB session
- best-effort 刪除半成品 Storage object
- 新建且仍為空的影片房，沿用目前 PR #26 的空房清理規則

取消不能留下：

- 空房
- 無版本資料列的永久 Storage object
- 永遠卡住的 resumable session

0009 `room_asset_orphan_count()` 繼續當後端守門。

---

## 七、分頁關閉 / App 切背景

不要像一般單次 XHR 一樣在任何 `pagehide` 都直接宣布失敗。

當頁面真的被關閉：

- session 已先存在 IndexedDB
- 下次進站可恢復

App 暫時切到背景：

- 不主動破壞 upload URL
- 瀏覽器若讓傳輸繼續就繼續
- 被系統中止則下次 resume

---

## 八、版本唯一性

一個 upload session 對應一個 `versionId`。

不論：

- 自動重試 10 次
- pause/resume
- 關頁重開
- 重新選檔續傳

最後 `versions` 只能新增**一列**。

必須補 race / duplicate test。

---

## 九、權限模型不可回退

正式 production 已有：

- 0006 video rooms
- 0007 room capabilities
- 0008 version archive
- 0009 orphan audit

本 PR 不得繞過 0007。

尤其：

- reviewer 不能建立 resumable upload
- owner/editor 才能上傳影片
- 上傳仍走 authenticated user token
- 不新增 public video bucket
- 不把影片放進 Realtime / IndexedDB

IndexedDB 只保存 session metadata，不保存整支影片 bytes。

---

## 十、測試

至少新增：

### A. 斷線續傳

- 上傳到約 50%
- 模擬網路失敗
- 恢復
- 完成
- 驗證不是從 0% 重傳

### B. pause / resume

- 上傳中 pause
- 等待
- progress 不增加
- resume
- 從原進度繼續

### C. 關頁恢復

- 上傳到一半
- 關閉頁面
- 重開 App
- 出現「上次有影片沒傳完」
- 重選同一檔案
- 完成

### D. 選錯檔

- 有未完成 session
- 選另一支同名但 size 不同的影片
- 不得續傳
- 顯示白話錯誤

### E. 不重複版本

- retry / reload / resume 後
- `versions` 只有一列

### F. 取消

- 半途取消
- session 消失
- 空房清掉
- Storage 無永久孤兒

### G. 權限

- reviewer 嘗試上傳 → DB / Storage 層拒絕
- editor / owner 正常

---

## 十一、既有功能回歸

必須保持：

- 圖片文宣房完全不受影響
- 影片時間點留言
- range 留言
- 分享連結
- LINE OG 卡片
- Realtime
- 版本封存
- signed URL 續期

---

## 十二、驗收標準

完成才算過：

1. 80MB 測試影片上傳到中途斷線，恢復後從中途繼續
2. 暫停 / 繼續不歸零
3. 關閉分頁後重開，能提示並恢復同一 session
4. 同一版本不會重複建立 row
5. reviewer 無法上傳
6. 取消後 0009 孤兒盤點仍為 0
7. Android Chrome 真機測一次
8. LINE in-app browser 至少驗證「切背景再回來」不會造成永久壞 session
9. `npm run test:migrations` 通過
10. `npm run test:video` 通過
11. `npm run test:share-e2e` 通過
12. `npm run test:share-preview` 通過
13. `npm run build` 通過

---

## 不做

本 PR 不做：

- HEVC/MOV → H.264 轉檔
- 影片剪輯
- 字幕
- 多軌
- waveform
- A/B 同步播放
- 大型上傳管理中心

HEVC 相容性另開下一條 PR，等可續傳上傳穩定後再做。
