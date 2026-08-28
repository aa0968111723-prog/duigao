# Design Intelligence — 跨工作線交接

分支：`agent/design-intelligence-perplexity`
基準：`origin/main` @ `2a17b7b`

本文件列出**本分支不會自己改、但需要別條工作線處理**的事項。
每一項都寫清楚：改什麼、為什麼、需要什麼介面、預期輸入輸出、可能衝突、
建議由誰處理。

---

## H-1【缺陷】`asset-analysis` edge function 有 ReferenceError

- **檔案**：`supabase/functions/asset-analysis/index.ts:510-511`
- **問題**：第 510 行宣告 `const dedupeKey = ...`，第 511 行的 insert 物件用了
  簡寫 `dedupe_key`。全 repo 沒有這個識別字，Deno 執行時會丟 ReferenceError，
  被最外層 catch 吞成 503 `ANALYSIS_UNAVAILABLE`。
- **為什麼沒被發現**：`tsconfig.json` 的 `include` 只有 `["src"]`，
  `supabase/functions/` 從未被 `tsc` 檢查；`test:edge-cors` 只發 OPTIONS
  預檢，不跑 POST 路徑。
- **觸發條件**：只有在「沒有既有 queued/processing job」時才走到這條分支，
  平時 DB trigger 已先建 job，所以是潛伏的。
- **建議修法**：`dedupe_key: dedupeKey`（或把變數改名）。
- **建議由誰處理**：負責 edge function／素材理解的工作線。
- **本分支不動它的理由**：`supabase/functions/asset-analysis/` 在本分支的
  「不應修改」清單內（BASELINE_AUDIT §10）。

### 順帶建議（同一條工作線）

把 `scripts/` 與 `supabase/functions/` 納入型別檢查。白板工作線
（PR #78 鏈）已經在 `tsconfig.scripts.json` 做了 `scripts/tests` 的部分，
可以沿用同一模式再補 Deno 端。

---

## H-2【需要新授權維度】設計知識庫沒有「跨房共用」的位置

- **現況**：授權的最上層就是 `room` + `room_members`，所有 RLS 都是
  `can_manage_media(room_id)` / `is_room_member(room_id)`。沒有
  organization / workspace / team 這一層。
- **問題**：設計知識（例如「內文對比至少 4.5:1」）本質上是**跨房共用**的，
  但在現有骨架下沒有位置。`library_assets` 的 `scope='shared'` 是唯一的跨房
  嘗試，但它的 SELECT 等同「所有已登入者可見」、INSERT 等同「在任何一房是
  owner/editor 就能寫」（`0016:61-74`），對知識庫而言粒度過粗。
- **本分支的計畫（PR-DI-01）**：新增 `design_knowledge` 表，採**兩段式授權**：
  - `project_specific IS NULL` 的通用知識 → 所有 authenticated 可讀，
    只有服務端（migration seed 或後端函式）可寫。
  - `project_specific = <room_id>` 的專案規範 → 沿用 `is_room_member` 讀、
    `can_manage_media` 寫。
- **需要別條工作線確認的**：如果近期會導入 organization / workspace 層，
  請告知 —— 本分支會把 `project_specific` 設計成可以無痛改指向 org id 的形狀
  （單一欄位 + 一條 RLS 條件），但**遷移時機**需要協調。
- **可能衝突**：新 migration 的編號。目前 `main` 到 `0021`，而
  `agent/wb01-canonical-schema`（PR #78）佔用了 `0022`–`0026`。
  → **本分支的 migration 從 `0027` 起編**，並在 PR 描述註明「若 #78 未先合併
  需重新編號」。

---

## H-3【共享檔案】AI 動作白名單目前散在三處

- **現況**：同一份四值白名單各寫一次：
  - `src/ai/proposals.ts:6-13`
  - `supabase/functions/room-ai-context/index.ts:218`
  - `src/lib/assetIntelligence.ts:233-237`
- **問題**：本分支要新增 design proposal 的動作型別時，三處都得改，而其中一處
  在 edge function（本分支不動）。
- **本分支的做法**：**不擴充**那條四值 union。Design Intelligence 的提案走
  獨立型別（`src/features/design-intelligence/types.ts`），最終落地時**轉譯**
  成既有的 `add_whiteboard_node` 等動作 —— 也就是說既有白名單不需要改。
- **需要別條工作線做的**：無。這裡只是說明為什麼本分支不碰它。

---

## H-4【外部服務】Canva / CUTOS / planform-iso adapter

- **本分支只做契約與 mock**（PR-DI-05），不實作 OAuth、不呼叫真實 API。
- **Canva OAuth** 由 `agent/canva-oauth-production` 負責。本分支需要的是：
  - 一個「目前有沒有連上 Canva」的可查詢狀態
  - 一個「把設計提案送進 Canva」的函式簽名（可以先是 stub）
- **CUTOS**：`src/lib/cutosContract.ts` 已有完整的 capability envelope
  （20 個錯誤碼、4 個可重試碼、協定協商），本分支會沿用它的形狀產生
  影片分鏡 payload，**不改該檔案**。
- **planform-iso**：目前 repo 內只有 `lib/planformArtifact.ts` 的解析與註解，
  沒有 adapter。本分支會定義介面，實作留給場佈工作線。

---

## H-5【需要人工設定】密鑰

| 密鑰 | 放哪裡 | 沒有它時 |
|---|---|---|
| `PERPLEXITY_API_KEY` | 後端 secret（Zeabur / Supabase Function secret），**不得**有 `VITE_` 前綴 | 研究層顯示「研究服務尚未設定」，其餘功能完全不受影響 |
| `TKU_ZEN_AGENT_URL` | Supabase secret | 既有行為：AI 回答降級成只列證據 |

**已知事件**：`PERPLEXITY_API_KEY` 曾被貼進代理對話視窗一次，
該把金鑰應視為已外洩並已請使用者輪替。本分支**未曾**將任何金鑰值寫入
程式碼、設定檔、commit 或 prompt。

---

## H-6【建議合併順序】

1. PR #78（白板鏈）—— 它佔用 `0022`–`0026`，先合併可讓本分支的
   migration 編號確定。
2. 本分支的 PR-DI-00（純新增檔案，與任何人都不衝突）。
3. 其餘 PR-DI-01 起。

若順序相反，本分支需要 renumber migration 並重跑 probe（白板工作線先前
處理過同樣的撞號，流程已驗證過）。
