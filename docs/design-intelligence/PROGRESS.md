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

（無）


### PR-DI-01 設計知識系統

| 產出 | 檔案 |
|---|---|
| 知識庫 schema、兩段式 RLS、seed | `supabase/migrations/0027_design_knowledge.sql` |
| RLS 與 CHECK probe（19 條） | `scripts/e2e/migrations.mjs` |
| 對抗審查修正 | `src/features/design-intelligence/schema.ts` |
| 反例測試（+8 條） | `scripts/tests/design-intelligence-schema.test.ts` |
| 測試型別閘門 | `tsconfig.scripts.json` |

**兩段式授權**：`project_specific IS NULL` 的通用知識所有 authenticated 可讀、
**沒有 client 寫入政策**（只有 migration seed 與 service_role 寫得進去）；
`project_specific = <room_id>` 的專案規範沿用 `is_room_member` 讀、
`can_manage_media` 寫。

**seed**：7 條**可驗證**的通用知識（WCAG 對比下限、非文字對比、觸控目標尺寸、
prefers-reduced-motion、行長與行高、視覺層級、社群縮圖可讀性）。挑選原則是
「程式量得出來」—— 「標題要有吸引力」這種品味不進知識庫。

**檢索**：沿用既有 lexical 打分。**誠實記錄**：repo 沒有 pgvector
（`asset_embeddings` 是 jsonb 死碼），本階段不假裝有語意檢索，
中文召回率未驗證。

處理 grok 對 PR-DI-00 契約層的對抗審查，5 條全部成立、全部修正：
SSRF 列舉法被 IPv4-mapped IPv6／DNS 尾點／數值正規化繞過（改預設拒絕）、
搜尋結果可自稱 approved（改由 provenance 決定信任上限）、
色彩對比只對 background 算導致不及格被標成 AAA（改取最差底色）、
多條紅線是假綠（補逐欄反例）、contentHash 可被輸入覆寫（改一律重算）。

migration probe 另外實測到一個自己的 bug：`array_length('{}', 1)` 回傳 NULL，
CHECK 遇到 NULL 一律放行 —— 零規則的知識條目寫得進去。改用 `cardinality`。

測試：`test:migrations` 262/262；`test:design-intelligence` 28/28
（型別檢查已納入同一個指令）。**變異測試 14 個變異體全數被殺死** ——
包含「換回舊的列舉式 SSRF 檢查」「讓 analyzing 直接進 applying」
「接受輸入的 contentHash」。

## 下一步

**PR-DI-02 設計分析引擎** —— 分析流程、結構化輸出驗證、provider adapter、
mock provider、診斷產生、三個方案、取消、錯誤狀態。

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
