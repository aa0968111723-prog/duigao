# PR-05 Grok round 裁決（canva-bridge）

Grok verdict：MUST_FIX（F1–F4 blocking、F5 non-blocking）。逐項裁決：

## F1 — callback 會被平台 JWT 閘擋死（critical）｜接受，已修

正確。callback 是無 Authorization 的瀏覽器 GET，函式若以預設
verify_jwt=true 部署，callback 永遠到不了程式。修法：supabase/config.toml
新增 `[functions.canva-bridge] verify_jwt = false`（與 share-preview 同模
式），並加 guard test 釘住 config；部署時 MCP deploy 亦以 verify_jwt=false
執行（部署 runbook 記載）。安全性由函式內部承擔：POST 動作全自驗 JWT，
callback 只消費一次性 state。

## F2 — window.open 在 await 之後（high）｜接受，已修

正確：await 後的 open 已離開 user-gesture 棧，主流瀏覽器預設攔截。修法：
click 同步棧先 `window.open("", "_blank")` 開空白分頁，拿到 URL 再導向；
open 回 null（被攔）→ 顯示 `canva-connect-fallback` 可點連結，永遠有路。

## F3 — refresh 失敗一律刪列（high）｜接受，已修

正確，且比表面更痛：Canva RT 輪替下，並發 refresh 的輸家拿 invalid_grant，
原實作會把贏家剛寫入的新 RT 一起刪掉。修法：exchangeToken 區分
`rejected`（4xx 明確拒絕）與 `unreachable`（網路/5xx）；unreachable 不刪列；
rejected 先重讀列 — RT 已被輪替就改用新 RT 重試一次，RT 沒變才刪列。
e2e 既有的「過期→refresh→輪替落盤」檢查續留。

## F4 — SSRF：https://127.0.0.1 穿透（high）｜接受，已修

正確，註解與實作不符。修法：解析 downloadUrl 的 hostname —
只允許 apiBase 自身（e2e 假上游）或 https 且 host 為 canva.com/*.canva.com。
IP literal、localhost、內網名全部擋在 fetch 之前。guard test 釘住。

## F5 — e2e 假綠面（medium，non-blocking）｜部分接受

- 接受並已補：F1 的 config guard、F4 的 host 邊界 guard（源碼證據層）。
- 接受為殘餘（記錄不修）：
  - 真 OAuth 彈窗流程無法 headless e2e（彈窗＋跨網域授權頁）— node 側
    已全鏈驗 authorize→callback→PKCE→輪替，UI 殘餘為真機驗收項。
  - TOO_LARGE 的 25MB 串流計量：實作與 cutos-bridge 同構（該處有
    Grok 07 F2 輪的驗證史），e2e 造 25MB 假檔的成本高於邊際價值。
  - reviewer FORBIDDEN 的 e2e：室內角色矩陣屬 RLS/migrations 套件既有
    覆蓋範圍（room_role 前置檢查只是誠實錯誤碼，不是權威）。
- 「平台 JWT 閘沒被模擬」：loadEdgeHandler 直接掛函式、繞過平台閘 —
  本質上無法在 harness 模擬 Supabase 的 gateway 行為；以 config.toml
  guard＋部署 runbook 補位。

## 真機驗收殘餘（deploy 後）

1. 使用者在 Supabase Dashboard 設 CANVA_CLIENT_ID / CANVA_CLIENT_SECRET。
2. Canva Developer Portal 的 redirect URL 需登記
   `https://<project>.supabase.co/functions/v1/canva-bridge/callback`。
3. 真機：連結 Canva → 清單 → 匯入一張真設計 → 房間出現圖片版本。
