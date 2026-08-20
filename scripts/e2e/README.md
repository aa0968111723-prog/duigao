# 分享驗收 (PR #16 / #21)

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
| Migration 靜態檢查 | `get_share_preview` 回傳欄位不含 room_id / version_id / created_by |

## migrations.mjs

把 `supabase/migrations/*.sql` 套到一個用完即丟的 PostgreSQL cluster，
然後**分別用成員、非成員、匿名三種身分**去驗 RLS。

```bash
npm run test:migrations
```

`supabase-shim.sql` 只是補上 Supabase 本來就會提供的東西（`auth.uid()`、
`storage.objects`、`anon` / `authenticated` 角色、default privileges），
它是測試 fixture，永遠不會被套到正式專案。

沒有安裝 PostgreSQL 執行檔時會直接跳過（不會失敗）。
