# PR #30：影片／文宣分享分流、縮圖可靠化與自訂分享內容

## 問題

目前分享流程在 Cloud Room 建好後，先把原始 App URL 立刻交給 ShareSheet：

`https://duigao.../#room=<uuid>&invite=<token>`

接著才在背景建立 Open Graph preview。若使用者在 preview 還是 `building` 時立刻按「傳到 LINE」，LINE 收到的是原始 App URL，因此只會抓到通用站點卡片，沒有房間專屬縮圖。

這在影片模式特別明顯：房間其實已經有 video poster、share_previews row 與 cover.webp，但分享出去仍可能顯示「文宣討論區」。

另外 ShareSheet 的分享文案與 UI 仍有多處硬寫「文宣」：
- `幫我看一下這張文宣...`
- `顯示文宣縮圖`
- `低解析度文宣預覽`
- 通用品牌文案也是文宣導向

## 目標

1. 圖片房與影片房分享體驗真正分流。
2. 預覽正在建立時，不讓使用者誤把原始 App URL 當成有縮圖的分享網址送出去。
3. 影片房預設使用影片 poster frame 作為 LINE / Messenger / Facebook 分享縮圖。
4. 分享內容可在 ShareSheet 內輕量自訂，不增加主導航。
5. 保留 invite 在 URL fragment 的安全模型，不把 secret 放 query/path/server。

## 一、修正 preview race

目前：

`ensureShared -> set ready(appUrl, preview=building) -> async ensure preview -> replace url`

問題：building 期間 Copy / LINE / native share 都可以立刻拿到 appUrl。

改成：

- `ready + preview=building` 時：
  - ShareSheet 顯示「正在準備分享預覽…」
  - LINE / 複製 / 系統分享按鈕先 disable，避免誤送無縮圖 URL
- preview 成功後：
  - `state.url = buildPreviewShareUrl(...)`
  - 立即 enable 分享按鈕
- preview 明確失敗或 timeout 後：
  - enable fallback 分享
  - 顯示「這次沒有縮圖，連結仍可分享」
  - 使用者清楚知道這次是無縮圖模式

不要無限等待。建議 preview build timeout 4–6 秒。

## 二、media-aware 分享文案

ShareSheet 必須收到 `mediaType: image | video`。

圖片模式：
- 主產品語境：文宣討論
- 邀請文案：`幫我看一下這張文宣「{title}」，點需要調整的位置留一句話就可以，不用改原稿 🙏`
- toggle：`顯示文宣縮圖`
- privacy：`分享平台會看到一張低解析度文宣預覽。`

影片模式：
- 主產品語境：影片對稿
- 邀請文案：`幫我看一下這支影片「{title}」，在需要調整的時間點留一句話就可以 🙏`
- toggle：`顯示影片封面`
- privacy：`分享平台會看到一張低解析度影片封面。`
- ShareSheet / preview card 不要再出現「這張文宣」。

## 三、影片分享縮圖

影片 room：
- 預設使用 version.image_path，也就是 upload 時擷取的 poster frame
- 產生 1200×630 preview
- 保持 contain，不變形、不硬裁
- 加輕量 play glyph
- 右下可顯示影片長度，例如 `1:23`
- 不包含留言、修改點、控制列、時間軸、proposal overlay

若 poster 不存在：
- 不阻止分享
- 先使用影片專用通用封面，而不是文宣通用封面

## 四、分享內容自訂

在既有 ShareSheet 裡加一個收合區：`自訂分享內容`。

不要增加主導航按鈕。

可編輯：
1. 分享標題
   - 預設 room.title
   - 例如 `小華招生短片｜第一剪`
2. 分享說明
   - 圖片與影片各有 mode-aware 預設
3. 封面
   - 使用目前封面
   - 上傳自訂封面
   - 不顯示封面
4. `恢復預設`

自訂內容存在 `share_previews`，不要改 room.title，除非使用者另外改房間名稱。

## 五、自訂影片封面

第一版不要做完整影片剪輯器。

提供：
- `使用目前影片封面`
- `上傳自訂封面`

若可低成本完成，再加：
- `使用目前播放畫面`

但這個功能必須：
- 從原影片乾淨 frame 擷取
- 不把播放器 UI 畫進去
- 壓成低解析度 share preview derivative
- 不公開原始 private video

## 六、資料結構

優先沿用現有 share_previews：
- title
- description
- thumbnail_path
- show_thumbnail

如需區分 generic fallback，可新增：
- media_type text check in ('image','video')
- thumbnail_source text check in ('auto','custom','none')

migration 必須 commit 到 `supabase/migrations/`。

不要存 invite token。

## 七、Edge Function

`share-preview` 必須 mode-aware。

圖片 fallback：
- site/product label：`文宣討論區`
- generic image：既有 og-cover.png

影片 fallback：
- site/product label：`影片對稿`
- generic image：新增影片專用 og cover（可用簡單 play icon + 深色背景）

若 preview row 有 title / description / thumbnail：優先用房間自訂內容。

保持：
- server-side OG HTML
- crawler 不需 JWT
- preview endpoint 永遠拿不到 fragment secret
- 人類點擊後 fragment 原樣轉回 App

## 八、LINE 分享

只有在 preview ready 後，預設「傳到 LINE」才使用 preview URL。

理想結果：

影片模式：

[影片封面 + play icon]

**小華招生短片｜第一剪**

幫我看一下這支影片，在需要調整的時間點留一句話就可以。

使用者訊息文字也要是影片語境，不再寫「這張文宣」。

## 九、快取

LINE 可能 cache 舊 preview。

保留／加強：
- thumbnail URL `?v=<updatedAt>`
- 自訂封面或文字更新後 touch updated_at
- 需要時可 rotate preview id

UI 用人話：`重新產生分享預覽`。

## 十、驗收

### 影片房
1. 建立 1:23 影片房
2. 立刻按分享
3. preview building 期間 LINE 按鈕不可送出 appUrl
4. preview ready 後 LINE 收到 share-preview URL
5. LINE 顯示影片 poster + play icon + 1:23
6. 標題顯示 room/share custom title
7. 邀請文字使用「這支影片」
8. 點卡片正常進同一 room
9. invite secret 仍只在 fragment

### 圖片房
- 原本文宣縮圖與文案保持正常
- 不 regression

### 自訂
- 可改分享標題，不影響 room.title
- 可改描述
- 可上傳自訂封面
- 可關閉封面
- 可恢復預設
- 更新後重新分享可看到新卡片

### fallback
- preview 建立失敗：永久分享仍可用
- UI 明確說這次無縮圖
- 不再讓使用者以為已產生預覽

## 不做
- 不改 invite 安全模型
- 不公開 room-assets
- 不公開原影片
- 不把 invite 放 query string
- 不做完整影片剪輯器
- 不做 AI 生封面
- 不新增主導航
- 不重寫 #27 TUS / #29 影片最佳化
