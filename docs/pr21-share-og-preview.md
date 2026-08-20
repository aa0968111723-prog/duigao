# PR #21：LINE 分享示圖與 Open Graph 文宣預覽

## 目標

讓使用者把「文宣討論區」連結分享到 LINE、Messenger、Facebook 等支援 Open Graph 的平台時，可以直接看到：

- 乾淨的文宣縮圖
- 房間／文宣標題
- 低壓力邀請文案

同時不洩漏正式房間的 invite secret，不改原稿，也不把私有高清文宣直接公開。

---

## 核心安全原則

1. 正式房間仍使用 `#room=<uuid>&invite=<secret>`。
2. `invite` 留在 URL fragment，分享預覽伺服器與爬蟲都不應讀到。
3. 預覽使用獨立、隨機的 `previewId`，不能由 room id 推算。
4. 預覽圖片使用低解析度衍生縮圖，不直接公開 private `room-assets` 原圖。
5. 使用者可關閉「顯示文宣縮圖」，關閉後使用通用品牌預覽。
6. 預覽只顯示乾淨原稿，不包含修改點、圈選、討論、提案 overlay、作者名單或 invite。

---

## 為什麼不能只改 React `<meta>`

目前正式分享 URL 的房間秘密都在 hash fragment。社群／LINE 預覽爬蟲通常只抓伺服器回傳的 HTML，不可靠執行 SPA JavaScript，也不會把 `#...` 傳給伺服器。

因此不能只在 React mount 後動態改 `og:image`。

需要一個真正的 server-side preview endpoint，回傳帶 OG meta 的 HTML。

---

## 建議 URL

第一版不改正式 app domain 路由，直接使用 Supabase Edge Function 當 preview landing page：

`https://<project>.supabase.co/functions/v1/share-preview/<previewId>#room=<uuid>&invite=<secret>`

爬蟲請求只會看到：

`/share-preview/<previewId>`

不會收到 `#room=...&invite=...`。

真人點擊後，Edge Function 回傳的 HTML 用極小 JavaScript：

`location.replace(APP_ORIGIN + location.hash)`

把原 fragment 原封不動帶回 Zeabur 正式網站。

未來若有自訂 share domain，可再把此 endpoint 綁到例如 `share.duigao.app`，但本 PR 不要求。

---

## 資料模型

新增 `share_previews`：

- `id uuid primary key` — previewId
- `room_id uuid not null`
- `version_id uuid not null`
- `title text not null`
- `description text not null`
- `thumbnail_path text null`
- `show_thumbnail boolean not null default true`
- `enabled boolean not null default true`
- `created_by uuid not null`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`

不要存 raw invite token。

正式 room member 才能建立／更新 preview。

Edge Function 只能讀 preview 公開需要的最小欄位。

---

## Thumbnail Storage

新增獨立 bucket：

`share-previews`

只存衍生縮圖，不存正式高清原圖。

建議：

- JPEG / WebP
- 最大約 1200×630
- 合理壓縮品質
- 對直式文宣使用 letterbox / contain，不能亂裁文字
- 背景可用深色／模糊延伸，但縮圖主體必須完整可辨識
- 不包含任何 annotation / proposal overlay

路徑：

`<previewId>/cover.webp`

由隨機 previewId 保護可猜測性。

如果 bucket 設 public，僅允許這個低解析度衍生 bucket public；`room-assets` 保持 private。

---

## 建立分享預覽流程

當 `ensureShared()` 已成功取得永久 room+invite URL 後：

1. 找目前要分享的 version（預設目前版本，若不適合則初稿）
2. 產生乾淨縮圖
3. 上傳到 `share-previews`
4. create / update `share_previews`
5. 取得 `previewId`
6. 最終給使用者分享的 URL 變成 preview landing URL + 原本 hash fragment

例如：

`https://.../functions/v1/share-preview/2bb...#room=abc...&invite=xyz...`

如果 preview 建立失敗，但 cloud room 本身已成功：

- 不要讓整個分享失敗
- fallback 到既有永久 app URL
- 顯示一般分享功能仍可用
- 只少了縮圖預覽

換句話說：

**OG preview 是 enhancement，不可以變成永久分享的單點故障。**

---

## Open Graph HTML

Edge Function 回傳至少：

- `og:title`
- `og:description`
- `og:image`
- `og:type=website`
- `og:url`
- `twitter:card=summary_large_image`
- `twitter:title`
- `twitter:description`
- `twitter:image`

文字 HTML-escape，避免 title / description 注入。

建議 description：

`幫我看一下這張文宣，點需要調整的位置留一句話就可以，不用改原稿。`

若使用者關閉縮圖：

- 使用通用品牌 OG image
- 不回傳文宣內容

---

## ShareSheet UX

不要新增主導航按鈕。

在既有「分享給夥伴」Bottom Sheet 中只加一個非常輕量的區塊：

`連結預覽`

- 小縮圖
- 標題
- `顯示文宣縮圖` toggle（預設開）

不要做大型設定頁。

第一次分享可自動建立 preview；之後若標題或版本改變，可在重新分享時更新。

---

## 隱私與撤銷

房間擁有者可以：

- 關閉 preview
- 換另一個 version 當 preview
- 重新產生 previewId（撤銷舊預覽）

舊 previewId 被停用後，Edge Function 回傳通用「文宣討論區」預覽，不顯示原文宣。

本 PR 不需要做複雜權限 UI，只要在 ShareSheet / 更多內提供最小控制。

---

## Cache

社群平台可能會快取 OG。

因此 preview image URL 建議帶版本：

`cover.webp?v=<updatedAt>`

或每次重大更新直接換 previewId。

Edge Function HTML：

- `Cache-Control` 設合理短 cache
- 不要 cache invite，因為 function 本來就看不到 fragment

---

## 與 PR #20 視覺提案 2.0 的界線

分享預覽預設只使用「乾淨原稿」。

本 PR 不分享 proposal overlay。

未來可以另做：

`分享這個提案`

產生 proposal 專屬 preview，但不在本 PR。

---

## 不要做

- 不把 invite 放 query string
- 不把 room id 當 preview id
- 不公開 private `room-assets`
- 不直接公開高清原稿
- 不依賴 React runtime 動態 meta 當唯一 OG 方案
- 不重做分享安全模型
- 不重做視覺提案
- 不增加新的主導航入口
- 不讓 preview 失敗阻止正常永久分享

---

## 測試

### OG crawler

用不執行 JavaScript的 HTTP client / crawler UA 直接 GET preview URL（不含 fragment server side）：

- 回 200 HTML
- 有正確 og:title / og:description / og:image
- HTML 不含 invite token
- HTML 不含 room private data

### 真人開啟

Android / LINE in-app browser：

- 點 preview URL
- 正確 redirect 回 Zeabur app
- fragment `room+invite` 完整保留
- 可進同一雲端房間

### Preview off

- 關閉「顯示文宣縮圖」
- crawler 只得到通用品牌圖
- app join 不受影響

### Preview service failure

- 模擬 Edge Function / thumbnail upload fail
- 使用者仍可取得原本的永久 `room+invite` 分享網址

### Security

- preview HTML 不含 invite
- 只知道 previewId 不能讀 room tables / private Storage
- 猜 room UUID 不能取得 preview metadata
- `room-assets` 繼續 private

### Build

`npm run build` 必須通過。

---

## 完成標準

使用者按「分享」後，把連結貼到 LINE：

1. LINE 顯示乾淨文宣縮圖
2. 顯示文宣／房間標題
3. 顯示一句簡短邀請回饋文案
4. 點卡片能正常進入原本的雲端房間
5. 主辦方關頁也不影響
6. LINE 預覽服務永遠拿不到 invite secret
7. 關掉縮圖時不會公開文宣內容

---

# 實作結果

## URL 架構

```
分享出去的連結
https://<project>.supabase.co/functions/v1/share-preview/<previewId>#room=<uuid>&invite=<secret>
                             └──── 伺服器只看得到這一段 ────┘└─── 只留在瀏覽器 ───┘
```

`buildInviteUrl()` 產生的 fragment 一個位元組都沒有被改寫；`buildPreviewShareUrl()`
只是把它接到 preview landing 後面。爬蟲的 HTTP request 永遠只有
`/share-preview/<previewId>`。

## 檔案

| 檔案 | 角色 |
|---|---|
| `supabase/migrations/0005_share_previews.sql` | `share_previews` 表、RLS、`get_share_preview` RPC、`share-previews` bucket 與寫入 policy |
| `supabase/functions/share-preview/index.ts` | Edge Function：讀 preview → 組 OG HTML → 把 fragment 交還 App |
| `supabase/config.toml` | 這個 function `verify_jwt = false`（爬蟲沒有 Authorization header） |
| `src/cloud/shareThumbnail.ts` | 純 canvas：把原稿 contain 進 1200×630，不裁切、不變形 |
| `src/cloud/sharePreview.ts` | preview 的建立／更新／關閉／重新產生，以及 URL 組裝 |
| `src/cloud/useCloudRoom.ts` | `preview.ensure()` / `preview.rotate()`，room 與 version 直接從雲端解析 |
| `src/components/ShareSheet.tsx` | 「連結預覽」區塊：縮圖、標題、顯示文宣縮圖 toggle、更多 → 重新產生 |
| `public/og-cover.png` | 關閉縮圖／撤銷／查不到時的通用品牌卡片（`scripts/make-og-cover.mjs` 可重製） |

## invite 隔離

四道各自獨立的防線：

1. secret 在 fragment，瀏覽器不會送給任何伺服器。
2. Edge Function 沒有任何讀 fragment 的路徑——它拿不到，不是「不看」。
3. `get_share_preview` 只回 `title / description / image_path / updated_at`，
   連 `room_id` 都不回，所以 previewId 推不回房間。
4. 送出的 HTML 整份不含 `invite` 這個字串（連註解都沒有），可以直接用 grep 驗證。

## Fallback

`ensureShared()` 一成功就先把永久連結交給使用者（`preview: building`），
預覽晚一步才補上。任何一步失敗都只會落到 `preview: unavailable`：
分享連結仍然是可複製、可傳 LINE 的 `#room=…&invite=…`，
只是顯示「這次沒有產生連結預覽，但分享連結仍可使用。」

## 驗收指令

```bash
npm run build            # cloud env 檢查 + tsc + vite build
npm run test:migrations  # 用真的 PostgreSQL 套 0001–0005 並驗 RLS（29 項）
npm run test:share-preview   # 爬蟲 / 安全 / 縮圖幾何（110 項）
npm run test:share-e2e       # 完整分享旅程，含 LINE 卡片 →  進房（29 項）
```

## 部署

```bash
# 1. migration（正式專案 uanurolzzgshxrqbooix，不要另開專案）
supabase db push            # 或在 SQL Editor 貼上 0005_share_previews.sql

# 2. Edge Function secret
supabase secrets set APP_ORIGIN=https://duigao-k7q2.zeabur.app

# 3. Edge Function（爬蟲沒有 Authorization header）
supabase functions deploy share-preview --no-verify-jwt
```

`SUPABASE_URL` 與 `SUPABASE_ANON_KEY` 由 Supabase 自動注入，
不需要、也不應該給這個 function service-role key。

前端沒有新的環境變數：preview URL 由既有的 `VITE_SUPABASE_URL` 推導。
