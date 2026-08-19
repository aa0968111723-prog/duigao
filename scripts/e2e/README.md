# 分享連結驗收 (PR #16)

`share-flow.mjs` 用真正的 production bundle 在 Chromium 跑完整分享流程，驗證
PR #16 的核心規則：**只有 `#room=<uuid>&invite=<token>` 能被當成分享連結**。

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

## mock-supabase.mjs

Supabase 端用的是本機替身，只實作這個 app 會用到的路由：匿名登入、invite
RPC（含 token 雜湊比對與成員檢查）、PostgREST 風格的讀寫、Storage 上傳／簽名／
取檔。它讓驗收可以在沒有網路、也不動到正式專案的情況下跑完整條路徑；它驗證的是
**這個 app 的邏輯**，不是 Supabase 本身。真實 Supabase 專案上的驗收仍以
`docs/pr16-share-link-cloud-hotfix.md` 的手動清單為準。
