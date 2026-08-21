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

---

## 實作結果

### 一、race 的實際成因與修法

`openShare` 拿到 `ensureShared()` 的結果之後就把 sheet 設成
`ready(url = appUrl, preview = building)`，並在背景才建立卡片。ShareSheet 對
`building` 沒有任何限制，所以 `複製連結` / `傳到 LINE` / `其他方式分享` 在那個
window 內全部可按，送出去的就是 `https://app/#room=…&invite=…`。爬蟲抓不到
fragment，於是 LINE 顯示通用卡片——即使房間早就有 poster frame 與
`share_previews` row。

修法把「可以分享」從 `kind === "ready"` 移到 `preview` 上：

- `building`：顯示「正在準備影片／文宣分享預覽…」，三個分享動作全部 disabled，
  LINE 按鈕改成「正在準備 LINE 預覽…」，網址輸入框不出現。
- `on` / `off`：`state.url = buildPreviewShareUrl(preview.id, appUrl)`，解除限制。
- `unavailable`：顯示「這次沒有產生預覽縮圖，但分享連結仍可使用。」並要求按下
  「仍要分享（這次沒有縮圖）」才交出 `appUrl`——不是靜默降級。

`withPreviewTimeout`（6 秒）確保慢速網路不會永遠卡在 `building`；逾時走的是
`unavailable` 那條有告知的路。晚到的結果仍然可以靠 `shareSeq` 補上。

`複製原始安全連結` 放在「更多」裡，是進階 fallback，不是主要操作。

### 二、presentation model

`src/lib/sharePresentation.ts` 是唯一的文案來源：`sharePresentation(mediaType,
roomTitle)` 回傳 sectionTitle / brand / defaultTitle / defaultDescription /
thumbnailLabel / privacyCopy / preparingCopy / coverAutoLabel / inviteText。
ShareSheet、LINE deep link、`navigator.share`、clipboard 文字全部讀同一份，
Edge Function 的那一份是逐字複製並由 `share-preview.mjs` 斷言相同。

### 三、資料結構

`supabase/migrations/0011_share_preview_customization.sql`：

| 欄位 | 用途 |
|---|---|
| `media_type` | `image` / `video`，決定通用封面與品牌字 |
| `cover_source` | `auto` / `custom` / `none` |
| `title_customized` | true 之後 `rooms.title` 改名不再覆蓋卡片標題 |
| `description_customized` | 同上，對應說明 |

`show_thumbnail` 保留並與 `cover_source <> 'none'` 同步，所以 0005 的
`get_share_preview` 與 0008 的 `_v2` 行為完全沒變（也因此整套 migration 仍可重放）。
新的 `get_share_preview_v3` 只多回 `media_type` 與 `revoked`，撤銷的卡片會回一列
但 title / description / image_path 全是 null。

Edge Function 先打 v3，遇到 404 才退回舊的 `get_share_preview`——函式可以先於
migration 部署，也可以在 migration rollback 之後照常運作。

### 四、封面規則

| 模式 | 換版本 | 來源 |
|---|---|---|
| `auto` | 重新畫成新版的 poster frame / 文宣 | `versions.image_path`（影片是上傳時擷取的 poster frame） |
| `custom` | **不動** | 使用者上傳的圖，client-side render 成 1200×630 |
| `none` | 不適用 | 沒有封面，退到 `og-cover.png` / `og-video-cover.png` |

`auto` + 影片會加上 play glyph 與 `1:23` 這類 duration badge；`custom` 乾淨呈現，
不再額外疊播放鍵。兩者都走 `renderShareThumbnail()` 的 contain 邏輯，不 cover
crop、不拉伸，輸出 WebP 優先並壓到 700KB 以下。原圖從不進 public bucket。

### 五、安全

沒有放寬任何一條：invite 只在 URL fragment；`share_previews` 沒有任何
`%invite%` 欄位；v3 不回 `room_id` / `version_id` / `created_by`；`room-assets`
仍然私有；沒有新增 bucket；沒有 service role 進前端。
