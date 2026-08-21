# 分享驗收 (PR #16 / #21 / #30)

`share-flow.mjs` 用真正的 production bundle 在 Chromium 跑完整分享流程，驗證
PR #16 的核心規則：**只有 `#room=<uuid>&invite=<token>` 能被當成分享連結**，
並接著走 PR #21 的 LINE 旅程：分享 → 連結預覽卡片 → 夥伴點卡片 → 進同一個房間。

```bash
npm i -D playwright && npx playwright install chromium
npm run test:share-e2e
# 想沿用既有的 Chromium：CHROMIUM_PATH=/path/to/chrome npm run test:share-e2e
```

腳本自己會 build 兩份 bundle（有 cloud env / 沒有 cloud env）、開好本機伺服器、
跑完再收乾淨，不需要事先準備任何東西。

## 檢查項目

| 情境 | 驗收 |
|---|---|
| A 新分享 | 分享 URL 帶 `&invite=`；**A 完全關頁後**，B 用 LINE UA 開連結仍能載入房間與海報 |
| B cloud 建立失敗 | 顯示「暫時無法建立分享連結」＋「再試一次」，**完全不給任何可複製連結** |
| C production 沒有 cloud env | 不宣稱分享已建立，說明服務無法使用，不產生 `#room=` |
| D 舊版連結（owner） | `#room=<6碼>` 自動升級成 `#room=<uuid>&invite=<token>` |
| D 舊版連結（guest） | 主辦方離線時顯示「這是舊版分享連結」，不再 generic retry |
| 安全 | 竄改 invite、只有 room id 沒有 invite，都讀不到房間（PR #12 模型） |
| 版面 | 390×844 與 430×932 都不出現水平溢出 |
| A 連結預覽 (PR #21) | 分享 URL 走 `/functions/v1/share-preview/<previewId>`（≠ roomId）；ShareSheet 顯示乾淨文宣縮圖；爬蟲抓得到 OG 且 HTML 不含 invite / room id；關掉「顯示文宣縮圖」後只剩通用封面 |
| 預覽失敗 (PR #30) | 縮圖產不出來時不會靜默降級：先說「這次沒有產生預覽縮圖」，按下「仍要分享」之後才拿得到原始連結 |
| 文宣語境 (PR #30) | 圖片房的 sheet 與 LINE 文案不會出現「這支影片」「影片封面」 |
| 自訂分享內容 (PR #30) | 改標題／說明只寫進 `share_previews`，`rooms.title` 一個字都沒動；重開 ShareSheet 內容還在；自訂封面只上傳衍生檔到 `share-previews`；「不顯示封面」真的把公開檔案刪掉；「恢復預設」回到房間名與預設文案 |

## mock-supabase.mjs

Supabase 端用的是本機替身，只實作這個 app 會用到的路由：匿名登入、invite
RPC（含 token 雜湊比對與成員檢查）、PostgREST 風格的讀寫、Storage 上傳／簽名／
取檔（私有與公開 bucket），以及掛載真正的 `share-preview` Edge Function。它讓驗收可以在沒有網路、也不動到正式專案的情況下跑完整條路徑；它驗證的是
**這個 app 的邏輯**，不是 Supabase 本身。真實 Supabase 專案上的驗收仍以
`docs/pr16-share-link-cloud-hotfix.md` 的手動清單為準。

---

## share-preview.mjs (PR #21)

連結預覽的驗收，**不需要瀏覽器也能跑最重要的部分**。它把真正的
`supabase/functions/share-preview/index.ts` 用 repo 裡既有的 TypeScript 轉譯後，
掛在一個兩行的 `Deno` shim 上執行——所以驗的是會被部署的那份原始碼，
不是另一份會慢慢走鐘的副本。

```bash
npm run test:share-preview
# 想沿用既有的 Chromium：CHROMIUM_PATH=/path/to/chrome npm run test:share-preview
```

| 情境 | 驗收 |
|---|---|
| 爬蟲（facebookexternalhit / Twitterbot / LINE / curl） | 200 text/html、og:title / description / image、twitter card 齊全，且 meta 出現在任何 script 之前 |
| invite 隔離 | HTML 完全不含 invite token、room id、私有 bucket 名，連夾帶在 query / referer 的 secret 也不會被回顯 |
| 不是 Room API | 整次請求只呼叫 `get_share_preview` 一次，沒有碰任何資料表 |
| HTML injection | 房間名寫成 `"><script>…` 會被 escape |
| 顯示文宣縮圖 off | og:image 換成通用封面，HTML 不再出現縮圖路徑 |
| 撤銷 preview | 舊 previewId 只剩品牌卡片 |
| 未知 / 壞掉的 previewId | 仍回 200 通用卡片（連結照樣能進房） |
| 真人點擊（Chromium） | fragment 一字不差回到 App origin，沒有重複 `#`，room / invite 都沒掉 |
| 縮圖幾何（Chromium） | 直式 / 橫式 / 正方形海報四個角落都在，不裁切、不變形、< 1MB |
| Migration 靜態檢查 | `get_share_preview` 與 `get_share_preview_v3` 回傳欄位都不含 room_id / version_id / created_by |
| 影片分流 (PR #30) | 影片房的卡片 og:title 是自訂影片標題、og:description 是影片文案、og:site_name 是「影片對稿」，整份 HTML 沒有「文宣」也沒有原始影片副檔名 |
| 影片 fallback (PR #30) | 關掉封面／撤銷之後退到 `og-video-cover.png` 與「影片對稿」，而不是文宣通用卡片 |
| 部署順序 (PR #30) | 專案還沒套 0011（沒有 `get_share_preview_v3`）時，會自動退回舊的 `get_share_preview`，卡片照樣出得來 |
| 文案同源 (PR #30) | Edge Function 的品牌字／文案／通用封面檔名，與 `src/lib/sharePresentation.ts` 的常數逐字相同 |
| 通用封面資產 | `public/og-video-cover.png` 有 commit、是 1200×630 PNG，且產生它的 script 也在 repo 裡 |

## migrations.mjs

把 `supabase/migrations/*.sql` 套到一個用完即丟的 PostgreSQL cluster，
然後**分別用成員、非成員、匿名三種身分**去驗 RLS。

```bash
npm run test:migrations
```

`supabase-shim.sql` 只是補上 Supabase 本來就會提供的東西（`auth.uid()`、
`storage.objects`、`anon` / `authenticated` 角色、default privileges），
它是測試 fixture，永遠不會被套到正式專案。

沒有安裝 PostgreSQL 執行檔時會直接跳過（不會失敗）；CI 請設 `REQUIRE_PG=1`，
讓缺少資料庫變成失敗而不是假綠。

PR #30 在這裡多驗：`get_share_preview_v3` 只多回一個 `media_type`（撤銷後也還
回得出來，但標題與縮圖是 null）、`media_type` / `cover_source` 的 check
constraint、舊的 `get_share_preview` 回傳型別沒有被動過（否則整套 migration
重放會炸），以及 0011 可以重複套用。

---

## video-flow.mjs (PR #23 / #30)

影片對稿的完整驗收。PR #30 在 G 段加了 race 與自訂分享：

| 情境 | 驗收 |
|---|---|
| G0 preview building race | 卡片還在產生時，`傳到 LINE` 是 disabled、沒有可點的連結、輸入框不出現，而且**整個 ShareSheet 裡找不到原始 App URL**；完成後分享的是 `/functions/v1/share-preview/<id>#room=…&invite=…` |
| G1 影片語境 | sheet 是「顯示影片封面」「影片封面預覽」，沒有「顯示文宣縮圖」「這張文宣」 |
| G2 自訂標題 | 卡片標題變成「淡江招生短片｜第一剪」，房間仍然是「未命名影片」 |
| G3 自訂封面 | 只有衍生檔進 `share-previews`，原始影片與 poster 沒被改寫 |
| G4 換版本 | `custom` 封面不會被新版 poster 蓋掉；切回 `auto` 會跟著目前這一版重畫 |
| G5 無封面 / 恢復預設 | 退到 `og-video-cover.png` 與「影片對稿」；恢復預設回到房間名與影片預設文案 |

mock 端的 `faults.previewUploadDelayMs` 只是把上傳撐開，好讓 building 這個窗口
大到看得見——正式環境它只有一兩秒，但那一兩秒剛好夠一個人按下去。
