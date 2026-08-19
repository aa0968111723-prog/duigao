# PR #16 — 永久分享連結 Hotfix

## 問題

真機從 LINE 開啟分享 URL 時出現「目前暫時無法載入這個討論」。回報網址只有：

`#room=<6碼舊房號>`

而不是正式 cloud room 應該使用的：

`#room=<uuid>&invite=<高熵token>`

目前 `App.tsx` 在 cloud 未設定或 `ensureShared()` 失敗時，仍會 fallback 到 `localShareUrl`，因此正式環境可能把一條只能依賴 IndexedDB/PeerJS 的 legacy URL 當成可永久分享的 URL 傳出去。

## 核心原則

> 正式分享只能分享「真的能在主辦方離線時打開」的連結。

不能再用「建立 cloud share 失敗 → 靜默退回 legacy #room=<code> → 照樣分享」的做法。

## 必做

1. 新建立的正式分享連結必須是 `room + invite`。
2. Cloud 建立失敗時，不得 fallback 成可分享的 legacy URL。
3. Cloud 未設定時，正式部署不可假裝已建立永久分享連結。
4. ShareSheet 必須區分「永久分享已建立」與「目前無法建立分享連結」。
5. Legacy `#room=<6碼>` 仍可做舊資料相容，但 UI 必須明確辨識為舊版連結。
6. 舊版連結若本機 owner 有 local→cloud mapping，應自動升級成新版 invite URL。
7. 舊版連結若是新裝置 guest、主辦方不在線、沒有 invite，不能一直顯示 generic retry；應顯示「這是舊版分享連結，請向主辦方取得新版連結」。
8. 不能降低 PR #12 的 invite/membership/RLS 安全模型來救舊連結。
9. 新增 cloud deployment readiness 檢查，避免 production build 沒有 Supabase env 卻默默進 local share。
10. Zeabur 必須設定 `VITE_SUPABASE_URL`、`VITE_SUPABASE_PUBLISHABLE_KEY`；若代理能操作部署平台，請直接驗證；若不能，必須在 PR 明確列出待設定值名稱與驗證方式，不得放真 key 進 repo。

## 分享 UX

Cloud ready：
- 正在建立分享連結…
- 分享連結已建立
- 複製連結 / LINE / 系統分享

Cloud create 失敗：
- 暫時無法建立分享連結，請稍後再試
- [再試一次]
- 不顯示 legacy URL

Legacy guest URL：
- 這是舊版分享連結
- 若主辦方目前在線可嘗試即時連線
- 若無法連線：請向主辦方取得新版分享連結

## 不要做

- 不 hardcode Supabase URL/key
- 不把 publishable key 當 secret，但仍由 deployment env 注入
- 不退回 6 碼 room code 作 cloud authorization
- 不新增第二套 cloud adapter
- 不重做手機 UI
- 不重做 PR #14 annotation
- 不讓 generic retry 永久循環

## 驗收

### A. 新房分享
1. A 建房
2. A 按分享
3. URL 必須包含 `room=<uuid>&invite=<token>`
4. A 完全關頁
5. B 從 LINE 開 URL
6. B 成功看到房間

### B. Cloud create failure
1. 模擬 cloud create 失敗
2. ShareSheet 不得產生 `#room=<6碼>` 可分享 URL
3. 顯示重試

### C. Cloud env missing
1. production-like build 沒有 Supabase env
2. 不得宣稱永久分享成功
3. UI 顯示設定/服務暫不可用的人話

### D. Legacy link
1. 開 `#room=<6碼>`
2. 若本機 owner mapping 存在，自動導到新版 invite URL
3. 若 guest 無 mapping 且 host offline，顯示舊版連結提示，不 generic retry
4. 若 host online，可保留 PeerJS best-effort compatibility

### E. Regression
- 390×844 Android
- 430×932 Android
- LINE in-app / browser
- 主辦方切 LINE 後 background freeze
- Cloud room 正常載入
- comment / region / reply / support / chat / proposal 正常

## 完成標準

只有真正的 cloud invite URL 才能被當成「分享連結已建立」。任何無法保證主辦方離線仍可打開的 legacy URL，都不能再被悄悄當成永久分享連結。
---

## 實作（本 PR）

| 規則 | 落點 |
|---|---|
| 分享 URL 只有一種格式 | `src/cloud/invite.ts` `buildInviteUrl()` 是全 app 唯一的分享 URL 產生器；`readRoomLink()` 把網址分成 `none` / `cloud` / `legacy` |
| 失敗不 fallback | `src/App.tsx` `openShare()` 刪掉 `localShareUrl` fallback；`ensureShared()` 改回傳 `ShareResult`（`{ok:true,url}` 或 `{ok:false,reason}`），失敗一律無 URL |
| ShareSheet 狀態 | `src/components/ShareSheet.tsx` `ShareState`：`creating` / `ready` / `failed` / `unavailable` / `legacy-guest` / `local`（只有 dev） |
| production env 檢查 | `src/cloud/config.ts` 驗證 URL 與 key 並輸出 `cloudConfigStatus`；production 缺 env 時 console.error，分享顯示「分享服務目前無法使用」 |
| 部署 readiness | `scripts/check-cloud-env.mjs`（`npm run build` 警告、`npm run check:cloud-env` 失敗退出），值只印遮罩指紋 |
| 舊連結 owner 升級 | `src/cloud/legacy.ts` `upgradeLegacyShareUrl()`，在 `main.tsx` 於 React 讀網址前就 `history.replaceState` 換成 invite URL |
| 舊連結 guest 指引 | `App.tsx` 的 guest 空狀態：舊連結 + 主辦方離線 → 「這是舊版分享連結」＋取得新版連結的指引，不再 generic retry |
| 不碰安全模型 | `useCloudRoom` 只有 `kind === "cloud"` 的連結能 join；沒有 invite 一律不進雲端，PR #12 的 invite/membership/RLS 完全沒有放寬 |

補充：`config.ts` 與檢查腳本允許 `http://127.0.0.1`（本機 `supabase start`），
其餘一律必須 https；key 若看起來是 service-role 會直接判定為不可用。

production bundle 內已經**不存在**產生 `#room=<6碼>` 的程式碼——dev 專用的本機測試
連結寫在 `import.meta.env.DEV` 分支裡，build 時整段被移除（可用
`grep -o '#room=[^"]*' dist/assets/*.js` 確認只剩 invite URL 那一條）。

## 驗收結果

自動化：`npm run test:share-e2e`（見 `scripts/e2e/README.md`），19/19 通過。
用真正的 production bundle 在 Chromium 390×844 / 430×932 與 LINE in-app UA 下跑：

- A 建房 → 分享 → URL 為 `#room=<uuid>&invite=<token>`；**A 的 context 完全關閉後**，
  B 從 LINE UA 開連結仍載入房間與 Storage 上的海報
- B cloud create 失敗（攔截 `create_room_with_invite` 回 500）→ 只有「暫時無法建立
  分享連結」＋「再試一次」，DOM 內不存在任何 `#room=` 連結
- C 沒有 cloud env 的 production build → 不宣稱已建立，顯示服務無法使用
- D owner 開舊連結 → 自動變成新版 invite URL；guest 開舊連結且主辦方離線 →
  「這是舊版分享連結」指引
- 安全 regression：竄改 invite、只有 room id 沒有 invite，皆讀不到房間
- 兩個尺寸都沒有水平溢出

雲端端點在自動化裡是本機替身（`scripts/e2e/mock-supabase.mjs`），驗的是 app 自己的
邏輯。以下仍需在真機／真專案上人工確認：

1. 對正式 Supabase 專案跑一次 A～E（本 sandbox 無法對外連線）
2. 實體 Android + LINE in-app browser（含主辦方切到 LINE 後的 background freeze）
3. 部署平台（Zeabur）確實注入 `VITE_SUPABASE_URL`、`VITE_SUPABASE_PUBLISHABLE_KEY`：
   設定後重新 build，build log 應出現 `✔ cloud env ready`；線上開 console 不應出現
   `[duigao] cloud 未就緒`。建議在部署流程加上 `npm run check:cloud-env` 把關。
