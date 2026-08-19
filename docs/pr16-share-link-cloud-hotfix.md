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