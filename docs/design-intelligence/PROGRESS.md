# Design Intelligence — 進度

分支：`agent/design-intelligence-perplexity`　基準：`origin/main` @ `2a17b7b`

## 已完成

### PR-DI-00 稽核與契約

| 產出 | 檔案 |
|---|---|
| 基線稽核 | `docs/design-intelligence/BASELINE_AUDIT.md` |
| 跨工作線交接 | `docs/handoffs/DESIGN_INTELLIGENCE_INTEGRATION.md` |
| Domain model | `src/features/design-intelligence/types.ts` |
| 結構化輸出驗證 | `src/features/design-intelligence/schema.ts` |
| Provider／research 介面 | `src/features/design-intelligence/providers.ts` |
| 契約測試 | `scripts/tests/design-intelligence-schema.test.ts`（20 條） |

**這個 PR 不是純文件**：驗證器、WCAG 對比計算、SSRF 網址檢查、知識優先序、
提案狀態機都是可執行的程式碼，且每一條都有會紅的測試。

測試：`npm run test:design-intelligence` → 20/20；
既有套件未受影響（asset-intelligence 15、collaboration 79、multi-branch 25、
agent 16、edge-cors 5）；`tsc --noEmit` 乾淨；`npm run build` 綠。

## 進行中

（無）

## 下一步

**PR-DI-01 設計知識系統**

- migration（從 `0027` 起編，見 handoff H-2 的撞號說明）
- 兩段式 RLS：通用知識所有 authenticated 可讀／服務端可寫；
  專案規範沿用 `is_room_member` 讀、`can_manage_media` 寫
- 檢索：先沿用既有 lexical score（**誠實記錄**中文召回率未驗證），
  不假裝有語意檢索（repo 沒有 pgvector，`asset_embeddings` 是死碼）
- seed fixtures：WCAG 對比、觸控目標尺寸、行動裝置排版等可驗證的規則
- migration probe（沿用 `npm run test:migrations` 的模式）

## 阻塞

| 項目 | 狀態 |
|---|---|
| `PERPLEXITY_API_KEY` | 曾被貼進對話 → 已請使用者輪替。**本分支未曾寫入任何檔案**。PR-DI-03 會以 no-key 路徑先完成 |
| Supabase `vector` extension | 未確認是否可開。PR-DI-01 先用 lexical，不阻塞 |
| migration 編號 | 取決於 PR #78 是否先合併（handoff H-6） |

## 需要人工設定

1. 輪替 `PERPLEXITY_API_KEY`，放後端 secret（**不得**用 `VITE_` 前綴），設預算上限
2. 補 `TKU_ZEN_AGENT_URL` 到 Supabase secrets（既有阻塞，非本分支引入）

## 稽核時發現、但不屬本分支的缺陷

- `supabase/functions/asset-analysis/index.ts:511` 有 ReferenceError
  （`dedupe_key` vs `dedupeKey`）→ handoff H-1

## 工具鏈實況（誠實記錄）

| 工具 | 狀態 |
|---|---|
| `pplx`（Perplexity CLI） | **未安裝** |
| `irm` | **未安裝** |
| xAI CLI | `grok` 1.0.5 可用 —— 階段審查用它，報告會註明「用的是 grok 不是 irm」 |
| `claude` CLI | 不在 PATH（本代理跑在 Claude Code 內，屬預期） |
