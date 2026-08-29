# Design Intelligence — 進度

分支：`agent/design-intelligence-perplexity`　基準：`origin/main` @ `b0f7a1b`

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

（無 —— 六個階段都已完成並開出 PR）

## PR 鏈

| PR | 階段 | base |
|---|---|---|
| [#88](https://github.com/aa0968111723-prog/duigao/pull/88) | PR-DI-01 設計知識系統 | `main` |
| [#89](https://github.com/aa0968111723-prog/duigao/pull/89) | PR-DI-02 分析引擎 ＋ DI-01/02 審查修正 | #88 |
| [#90](https://github.com/aa0968111723-prog/duigao/pull/90) | PR-DI-03 研究層 | #89 |
| [#91](https://github.com/aa0968111723-prog/duigao/pull/91) | PR-DI-04 手機／平板介面 | #90 |
| [#92](https://github.com/aa0968111723-prog/duigao/pull/92) | PR-DI-05 外部工具契約 | #91 |
| （本分支）| PR-DI-06 完整評估 ＋ DI-03/04 審查修正 | #92 |

PR-DI-00 是 [#86](https://github.com/aa0968111723-prog/duigao/pull/86)，已合併。

**堆疊的原因**：任務書要求小而獨立可回退的 PR，但同時禁止 force push。
每個階段完成後才開新分支，所以修正只能落在後續的 PR 裡 ——
每個 PR 的描述都寫明它帶了哪些屬於前一個 PR 的修正。

## 評估報告

`docs/design-intelligence/EVALUATION.md` —— 七個驗收案例、測試總覽、
安全、行動裝置實測數字、被抓到的 29 個問題、誠實的限制清單。

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
| `irm` | **未安裝** —— PR-DI-00／01 的對抗審查用的是 `grok`，報告一律註明 |
| xAI CLI | `grok` 1.0.5 可用 —— 階段審查用它，報告會註明「用的是 grok 不是 irm」 |
| `claude` CLI | 不在 PATH（本代理跑在 Claude Code 內，屬預期） |
