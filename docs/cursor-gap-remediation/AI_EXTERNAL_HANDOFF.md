# PR-GAP-07 AI 與外部工具 — handoff

狀態：**HANDOFF / INCOMPLETE**。全站 gap-remediation **未完成**。

核對時間：2026-08-29。來源：GitHub PR #88 live + 本分支 checkout。

## #88 live

| 欄位 | 2026-08-29 |
|---|---|
| PR | https://github.com/aa0968111723-prog/duigao/pull/88 |
| 標題 | PR-DI-01～06: Design Intelligence 完整交付 |
| 分支 | `agent/design-intelligence-perplexity` |
| Head | `32e3bca10d705acbc655af55d5861be0a8a422eb` |
| Base 紀錄 | `main` @ `b0f7a1b`（過期） |
| `mergeable_state` | **`dirty`（CONFLICTING）** |
| Migrations | `0027_design_knowledge.sql`、`0028_design_research_usage.sql` |

#88 **仍擁有** DI schema／migrations／`src/features/design-intelligence/**`（schema/types 除外本批只加 `honesty.ts`）／`supabase/functions/design-research`。

本分支：`cursor/p2-ai-external-handoff-70d9`，**從 #88 當前 head 建立**。Base 必須是 `agent/design-intelligence-perplexity`。**不要**把 0027–0028 複製到 main、#95 或 #78。

與 #78 重疊只有 `.agent/*`、`package.json`、`package-lock.json`、`scripts/e2e/migrations.mjs`、`tsconfig.scripts.json`。**沒有**與 DI source 重疊。

## Canva／CUTOS 後端真相（不是契約空話）

| 層 | 真相 |
|---|---|
| `src/lib/canvaContract.ts` / `cutosContract.ts` | 契約 only。金鑰不得進 client。 |
| `src/cloud/canva.ts` / `cutos.ts` | Client invoke `canva-bridge` / `cutos-bridge`。**#88 沒改這些檔。** #88 樹上仍是 `as CanvaBridgeHealth`。**#97 已合入 main**，main 的 `canva.ts` 走 `parseFunctionPayload`（SPA HTML 拒絕）。本棧**不重做 #97**。 |
| `supabase/functions/canva-bridge` | **真實 OAuth 碼**：PKCE S256、`CANVA_CLIENT_ID` / `CANVA_CLIENT_SECRET` 只在 Deno.env、token 進 `canva_connections`（service role）。沒 env → `CANVA_NOT_CONFIGURED`。 |
| `supabase/functions/cutos-bridge` | **真實 adapter 碼**：`CUTOS_API_KEY` 只在 Deno.env。沒 env → `CUTOS_NOT_CONFIGURED`。 |
| #88 `adapters.ts` | Canva／CUTOS／planform **contract-only**。不呼叫 OAuth、不寫回 Canva。沒連線 → `unconfigured`。 |
| `planformArtifact.ts` | 唯讀識別器。沒有寫入端。 |
| Production env | **本回合未證明** Canva／CUTOS／Perplexity secret 已部署。沒設定時必須顯示「整合尚未設定」，不得假裝版本卡。 |

結論：後端 **有實作檔**，不是純文件。是否「已接通」取決於 edge 環境變數。沒設定 = 保留 adapter、誠實不可用、不阻塞討論。

## 本批做了什麼（疊在 #88 之上，不重寫 schema）

1. `src/features/design-intelligence/honesty.ts` — 海報／影片必須要 vision；SPA HTML / `{ok:true}` 缺欄拒絕。
2. `analysis.ts` — `needsForAnalysis` 含 vision；缺口寫進 `proposal.risks` 給面板。
3. `research.ts` — 200 但 SPA HTML／缺 `answer` 不當成功。
4. `scripts/tests/ai-external-handoff.test.ts`
5. 本文件 + `FINAL_EVIDENCE.md`（只列有證據的項）

## 本批拒絕

- 重寫 `schema.ts` / `types.ts` / `0027` / `0028`
- 把 #88 migrations 複製到 main／#95／#78
- 把 #97 的 `apiResponse.ts` cherry-pick 進本棧（Canva parser 已在 main）
- 在 client 放 `VITE_` Canva／Perplexity secret 或 `service_role`
- 從瀏覽器打 `api.perplexity.ai`
- merge／deploy／改正式庫／force-push

## 人類必須做

1. rebase／解 #88 對含 #97 的 main 的衝突；**renumber** 0027–0028（main 已有 0022 討論 integrity；#78 佔 0022–0026；#95 佔 0023）。
2. 部署 Canva／CUTOS／Perplexity 的 **server-side** secret（若要真的接通）。沒 secret 就保持「整合尚未設定」。
3. 不要把本分支 retarget 到 `main`。
