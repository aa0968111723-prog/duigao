# PR-GAP-07 restack — AI／外部工具誠實狀態（疊在 #118）

狀態：**HANDOFF / INCOMPLETE**。全站 gap-remediation **未完成**。

核對時間：2026-08-29。來源：GitHub live + `git ls-tree`（再抓，不沿用舊 SHA）。

## 為什麼疊在 #118，不 reset #104

#104（`cursor/p2-ai-external-handoff-70d9` @ `87a5659`）仍疊在 #88，檔名仍是 **0027–0028**。**不要 reset #104。**

#118（`cursor/p2-di-migration-renumber-70d9` @ `5cdfe49`）是 #88 的 filename-only 重編號：**0029–0030**。本分支從 #118 重建 GAP-07 誠實契約，檔名保持 0029–0030。

| 欄位 | 值 |
|---|---|
| Branch | `cursor/p2-ai-external-handoff-restack-70d9` |
| **Base 必須是** | `cursor/p2-di-migration-renumber-70d9`（#118） |
| #88 | `32e3bca` — **未 reset**；仍舊名 0027–0028 |
| #104 | `87a5659` — **未 reset**；仍舊名 0027–0028 + honesty |
| Migrations on this tree | `0029_design_knowledge.sql`、`0030_design_research_usage.sql` |

**不要**把 0029–0030（或舊 0027–0028）複製到 main、#95 或 #78。Do **not** invent 0031+。

## Canva／CUTOS 後端真相（不是契約空話）

| 層 | 真相 |
|---|---|
| `src/lib/canvaContract.ts` / `cutosContract.ts` | 契約 only。金鑰不得進 client。 |
| `src/cloud/canva.ts` | **#88/#118 樹上仍是 `as CanvaBridgeHealth`。** #97 已合 main + #115 走 `parseFunctionPayload`。本棧**不重做 #97、不把 `apiResponse.ts` 抄上來。** |
| `supabase/functions/canva-bridge` / `cutos-bridge` | 真實 OAuth／API key 在 Deno.env。沒 env → `*_NOT_CONFIGURED`。 |
| #88 `adapters.ts` | contract-only。沒連線 → `unconfigured`。 |
| Production env | **未證明** secret 已部署。沒設定必須「整合尚未設定」。 |

## 本批做了什麼（疊在 #118 之上，不重寫 schema）

1. `honesty.ts` — vision 缺口；SPA HTML / `{ok:true}` 缺欄拒絕。
2. `analysis.ts` — `needsForAnalysis` 含 vision；缺口寫進 `proposal.risks`。
3. `research.ts` — 200 但 SPA HTML／缺 `answer` 不當成功。
4. `scripts/tests/ai-external-handoff.test.ts` — 斷言 **0029–0030**。
5. 本文件 + incremental `FINAL_EVIDENCE.md`。

## 本批拒絕

- 重寫 `schema.ts` / `types.ts` / `0029` / `0030` SQL bytes
- 把檔名改回 0027–0028
- 把 #88 migrations 複製到 main／#95／#78
- 把 #97 的 `apiResponse.ts` cherry-pick 進本棧
- 在 client 放 `VITE_` Canva／Perplexity secret 或 `service_role`
- 從瀏覽器打 `api.perplexity.ai`
- 發明 typing／presence 或 0031+
- merge／deploy／改正式庫／force-push／reset #78/#88/#95/#103/#104

## 人類必須做

1. rebase／解 #88 對現行 main 的衝突；人類合入時用 **0029–0030**（#116 已佔 0024–0028）。
2. 部署 Canva／CUTOS／Perplexity 的 **server-side** secret（若要真的接通）。
3. 不要把本分支 retarget 到 `main`。**Base 必須維持 #118。**
