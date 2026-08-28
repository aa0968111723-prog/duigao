# Claude 裁決 — PR-07（CUTOS S2S 契約）Grok round

日期：2026-08-28 ｜ PR #59 ｜ Grok verdict MUST_FIX（F1/F2/F4/F5 blocking）

| # | Grok 判定 | 裁決 | 處置 |
|---|---|---|---|
| F1 | high：fetch 未設 redirect:manual — 302 可把 Authorization 轉送任意 Location（歷史 Deno CVE）；import 可被 redirect 進內網 | **接受** | 兩處 fetch 皆 `redirect:"manual"`，3xx 一律 CUTOS_UNREACHABLE |
| F2 | high：200MB arrayBuffer 在 256MB isolate 不現實；CL 缺頭先驗全跳過 | **接受** | 上限降 50MB（誠實文案：壓製或走一般上傳）＋串流計量（讀多少算多少，超線 cancel），CL 謊報擋得住 |
| F3 | medium：client 把 403/404 折成 UNREACHABLE（FORBIDDEN 文案死碼）；branchId 未驗屬房 | **接受** | client 讀回非 2xx body 的誠實碼；bridge 驗 branch 屬房（跨房=INVALid） |
| F4 | medium/blocking：每次重試都新建空分支 | **接受** | 分支只建一次：失敗回傳 branchId，CreateSheet 重試沿用；e2e「重試不增生」釘住 |
| F5 | medium/blocking：loadBranch 失敗被吞，成功 toast 說謊 | **接受** | 匯入已落地是事實（版本列在雲端）→ 仍關 sheet，但快照失敗改 info toast「重新整理就看得到」— 不假裝畫面已有 |
| F6 | medium：負向 health 快取 5 分鐘，env 後補入口不出現 | **接受** | 負向 TTL 降 30 秒；正向維持 5 分鐘 |
| F7 | low：health 把 serverVersion/manifestVersion 給瀏覽器 | **接受** | bridge 只回 {ok, negotiated} |
| F8 | low：假 CUTOS 的錯 key 路徑未被 exercised | **記錄殘餘** | manifest 端 key 驗證存在；bridge 永遠帶對 key，錯 key 路徑屬 CUTOS 端測試範圍（其 repo 41 個測試檔），duigao e2e 不冒充 |

## 殘餘（誠實記錄）

- F3 指出「本 diff 無法證明 0007 RLS 真擋 reviewer 的 bridge 寫入」——
  正確：bridge 全程用呼叫者 JWT，RLS 是既有 0006/0007 的權威（migrations
  e2e 已有 reviewer 不可寫 versions/storage 的探針）；bridge 端的 role
  前置檢查只供誠實錯誤碼。此為既有保證的複用，非本 PR 新開面。
- e2e 的假 CUTOS 不能證明真部署行為（協定指紋、真實 302 行為）；
  BLOCKED_CUTOS_AUTH 解除後補 live 驗收。

## 回歸

multi-branch e2e 26/26（新增重試不增生）；collab 38/38、share 72/72、
share-preview 176/176、video 165/165、unit 全綠、gate PASS。
