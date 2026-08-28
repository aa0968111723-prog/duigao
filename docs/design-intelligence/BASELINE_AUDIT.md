# Design Intelligence — 基線稽核

- 稽核基準：`origin/main` @ `2a17b7b`（含 #85 bright UI refresh）
- 方法：六路平行讀者實際讀程式碼（技術棧／AI 層／資料模型／行動 UI／測試／安全），
  不看 README 自述，全部對照檔案與行號
- 稽核者：Claude（本分支主要實作者）
- 日期：2026-08-29

> 這份文件的用途是**擋掉錯誤的假設**。下面每一條都可以在程式碼裡查到；
> 凡是我沒查證的，一律寫「未驗證」而不是猜。

## 1. 真實架構

| 面向 | 事實 | 出處 |
|---|---|---|
| 套件管理 | npm（只有 `package-lock.json`，lockfileVersion 3），無 `packageManager`／`engines`／`.nvmrc`；Node 20 只釘在 CI | `package-lock.json:4`、`.github/workflows/build.yml:17` |
| Framework | React 19.1 + Vite 6.3 + TypeScript 5.8 | `package.json:36-46` |
| Routing | **沒有 router 函式庫**。畫面靠 `App.tsx` 內的條件渲染切換；網址層只有 hash fragment（`#room=&invite=`），啟動時讀一次 | `src/cloud/invite.ts:41-88`、`src/App.tsx` |
| 狀態管理 | **沒有外部狀態函式庫**（zustand/redux/jotai/react-query 全部零命中）。`src/App.tsx` 3171 行、36 個 `useState` | `src/App.tsx:262` 等 |
| 後端 | Supabase：6 支 edge function、21 支 migration | `supabase/` |
| 離線 | 三個各自獨立版本的 IndexedDB（`duigao`／`duigao-collaboration`／`duigao-visual-proposals`）＋ Service Worker | `src/lib/store.ts:4`、`offline.ts:187`、`public/sw.js:2` |
| 測試 | Node 內建 runner（`tsx --test` / `node --test`）＋ 手寫 Playwright 腳本。**沒有 vitest/jest、沒有 playwright.config、沒有 eslint** | `package.json:13-26` |
| 型別檢查範圍 | `tsconfig.json` 的 `include` **只有 `["src"]`** | `tsconfig.json:19` |

### 1.1 既有 AI 層的真實形狀

**這是本任務最重要的一段：AI 的「腦」不在這個 repo 裡。**

- `src/ai/proposals.ts` 只有 200 行，是**純函式的提案正規化＋權限閘**，
  零網路、零 React、零 Supabase。
- 模型、prompt、temperature 全在外部 agent 服務（`tku-zen-agent`）。
  本 repo 從不指定模型；edge function 只把回傳的 `raw.model` 原樣回顯。
  （`grep 'prompt|temperature|max_tokens|gpt-|claude-'` 在 `src/` 與
  `supabase/functions/` 只命中註解與影片播放器 UI 文案。）
- 呼叫方式是 HMAC 簽章的 S2S POST，逾時 45 秒
  （`supabase/functions/room-ai-context/index.ts:179-240`）。
- AI 動作詞彙表是**四值封閉 union**：`create_comment`／`create_poll`／
  `create_plan_draft`／`add_whiteboard_node`，而且**同一份白名單在三個地方各寫一次**
  （`src/ai/proposals.ts:6-13`、`room-ai-context/index.ts:218`、
  `src/lib/assetIntelligence.ts:233-237`），必須手動同步。
- **反幻覺閘門已經存在而且做得好**：`safeAgentCitations` 只接受能對回本次請求證據的
  引用；`safeAgentLocator` 要求 video-segment 對得上既有 segment（±0.25 秒）、
  image-region 對得上既有 region（±0.01），對不上就丟棄
  （`_shared/roomContext.ts:213-292`）。
- **外洩防護也已經存在**：`stripSecrets` 深層清除 `storage_path`／`invite`／
  `access_token`／`signed_url`／`data_url`／`bytes` 等；`scrubText` 把 URL 換成
  「[連結已省略]」並截 5000 字。有專門測試守著
  （`scripts/tests/room-context-strip.test.ts`）。

## 2. 可重用的能力

引入 Design Intelligence **不需要重造**的東西：

1. **證據投影管線**（`_shared/roomContext.ts`）：權限過濾 → 清洗 → 打分 → 組 context。
2. **反幻覺驗證**（citation/locator 必須對回本次證據）。這套規則正是外部搜尋結果
   最需要的東西，但**不能直接沿用**（見 §5）。
3. **提案 → 預覽 → 人按套用**的流程骨架（`applyGate` + `RoomAiSheet` + `applyAiProposal`）。
4. **AI policy 開關**（`ai_readable` / `external_ai_allowed`）與它進 cache key 的做法
   （`App.tsx:655`：policy 改變會讓舊答案立即失效）。
5. **稽核表 append-only 模式**（`0019`：grant insert 之後 revoke update/delete）。
6. **行動裝置基礎**：Bottom Sheet（`.project-sheet` + `.project-scrim`）、
   safe-area、虛擬鍵盤（`--kb`）、斷點 hook。
7. **e2e 用真 production bundle 打本地假 Supabase** 的測試骨架，以及
   `page.route` 攔截 edge function 的既有手法。

## 3. 缺少的能力

按對本任務的阻礙程度排序：

1. **沒有任何知識庫語意的表**。`grep knowledge/guideline/principle/brand_/design_system`
   在 `supabase/` 與 `src/` 零命中。設計知識庫要從零建。
2. **沒有 organization / workspace / team 這一層**。授權的最上層就是
   `room` + `room_members`，所有 RLS 都是 `is_room_member(room_id)`。
   「跨房共用的設計知識」在這個骨架下**沒有位置**，需要新的授權維度。
3. **沒有 capability registry**、沒有 provider fallback、沒有重試、沒有斷路器。
   `DUIGAO_AGENT_PROVIDER` 是單選 env，無法設主／備。
4. **沒有 schema 驗證函式庫**（zod/ajv 零命中）。結構化輸出驗證全是手寫白名單。
   → 本分支沿用手寫路線（不引入新依賴），但要把它**集中成一層**而不是散在三處。
5. **沒有 rate limit / quota / 成本上限**。`estimated_cost` 欄位存在但**沒有任何寫入端**。
6. **沒有 pgvector**。`asset_embeddings.embedding` 是 jsonb array、沒有索引、
   **沒有任何程式碼讀寫它**。語意檢索目前不存在，檢索是 lexical token 交集。
7. **`scripts/` 與 `supabase/functions/` 從未被 tsc 檢查**。

## 4. 稽核時發現的既有缺陷（不在本任務範圍，但必須報告）

**`supabase/functions/asset-analysis/index.ts:511` 有 ReferenceError。**

第 510 行宣告的變數是 `dedupeKey`，第 511 行的 insert 物件用了簡寫 `dedupe_key`。
全 repo 沒有名為 `dedupe_key` 的識別字，因此這行在 Deno 執行時會 throw，
被最外層 catch 吞成 503 `ANALYSIS_UNAVAILABLE`。

它是**潛伏的**：這條分支只在「沒有既有 queued/processing job」時才走到，而平時
DB trigger 已先建 job。兩道 CI 都抓不到 —— `tsconfig` 不含 `supabase/functions`，
`edge-cors` 測試只發 OPTIONS 不跑 POST。

→ 已寫進 `docs/handoffs/DESIGN_INTELLIGENCE_INTEGRATION.md`，交給負責 edge function
的工作線。本分支不動它（§一的邊界）。

## 5. 資料安全風險（引入外部搜尋後新增的面）

這一節是本任務最需要提前定契約的地方。

| 風險 | 現況 | 為什麼外部搜尋讓它變嚴重 |
|---|---|---|
| **成本無邊界** | 零 rate limit／quota；匿名登入即可建房並無限問 AI | 目前只燒 agent 額度；接上按次計費的搜尋 API 就是直接刷帳單 |
| **出站無治理** | 唯一 host 白名單是 canva-bridge 的 `*.canva.com`；provider URL 完全由 env 決定 | 多出第二個「env 決定送去哪」的出口 |
| **信任分級不存在** | `context` 是同質的 `SafeAsset[]`，沒有欄位表達「房內證據」vs「網路撈來的」 | 外部文字一旦混進去就享有跟房內證據同等地位 |
| **citation 驗證會被迫放寬** | `safeAgentCitations` 只接受對得回房內 asset 的引用 | 外部來源沒有 assetId：要嘛拆掉反幻覺閘門，要嘛設計獨立命名空間 |
| **URL 被清洗掉** | `scrubText` 把所有 URL 換成「[連結已省略]」 | 外部來源的價值有一半就是那條 URL；共用同一 sanitizer 會讓結果不可引用 |
| **query 本身會出境** | `external_ai_allowed` 保護的是素材，不管 query | query 是使用者自由輸入的 2000 字，可能夾帶房內敏感內容 |
| **已有同型繞過先例** | 房間討論被包成偽素材（`sourceId='room:<id>:discussion'`）送進 context，而外部封鎖檢查用 `assetId` 反查原始列、偽素材查不到 → **不擋** | 同一條路徑會把討論送給外部搜尋 |
| **prompt injection 防線不在本 repo** | 注入處理在 tku-zen-agent 端；duigao 只做形狀驗證 | 搜尋結果是典型注入載體；型別白名單擋得住 type，擋不住「合法 type + 惡意 label」 |
| **AI 使用面零稽核** | 只在人按套用時寫一列 | 事後無法回答「這句話是從哪個網頁進來的」 |

## 6. 實作順序（依風險與相依性）

```
PR-DI-00  稽核 + 契約（本 PR）
            └── 型別、schema 驗證器、provider 介面、research 介面、handoff
PR-DI-01  設計知識系統
            └── 需要新授權維度 → 必須先決定 org/workspace 或 owner-only 全域
PR-DI-02  分析引擎（本地知識 + provider adapter + mock）
            └── 不依賴外部搜尋，先讓「沒有 Perplexity 也能用」成立
PR-DI-03  Perplexity 研究層
            └── 依賴 PR-DI-02 的 capability 與 PR-DI-01 的 trustLevel
PR-DI-04  手機/平板提案 UI
PR-DI-05  外部工具契約（Canva/CUTOS/planform-iso/白板 payload）
PR-DI-06  完整評估與整合證據
```

**順序的理由**：PR-DI-02 排在 PR-DI-03 前面，是為了讓「Perplexity 未設定時
AI 基本設計功能仍可用」（任務書第七節）不是事後補的降級路徑，而是**先成立的預設路徑**。

## 7. 這次能真實完成的

- 全部型別、schema 驗證器、provider／research 介面與它們的測試
- 設計知識系統（表 + RLS + 檢索 + seed，用既有 migration probe 驗）
- 分析引擎（含 mock provider，可端到端跑）
- Perplexity adapter 的**完整實作與 no-key 路徑**（用 fixture 測）
- 手機/平板提案 UI（沿用既有 Bottom Sheet／Split View 基礎）
- 外部工具 adapter 契約與 mock

## 8. 需要外部密鑰／人工設定的

| 項目 | 阻擋什麼 | 沒有它時的行為 |
|---|---|---|
| `PERPLEXITY_API_KEY`（後端 secret） | 真實搜尋 | adapter 完整、顯示「研究服務尚未設定」、用 fixture 測 |
| `TKU_ZEN_AGENT_URL`（Supabase secret） | 真實 AI 回答 | 既有行為：degrade-to-evidence |
| Supabase 專案的 `vector` extension | 語意檢索 | 沿用既有 lexical 檢索（誠實標示召回率未驗證） |

## 9. 測試基準（現況）

| 指令 | 內容 |
|---|---|
| `npm run test:asset-intelligence` | 3 支 TS 測試（asset-intelligence 9、ai-proposals 5、room-context-strip 1） |
| `npm run test:asset-intelligence-e2e` | Playwright，攔截 `room-ai-context` 回 fixture |
| `npm run test:migrations` | 真 PostgreSQL 跑全部 migration + RLS probe |
| `npm run test:edge-cors` | 只發 OPTIONS 驗 allow-headers（**不跑 POST**） |
| CI | `build.yml` 3 jobs、`agent-release-gate.yml` 1 job |

## 10. 不應修改的檔案（本分支）

| 檔案／目錄 | 負責工作線 |
|---|---|
| `supabase/functions/canva-bridge/`、Canva OAuth | `agent/canva-oauth-production` |
| `src/features/whiteboard/`、`0014` 白板核心模型 | `agent/canonical-whiteboard-mobile-tablet`（現為 PR #78 鏈） |
| `src/lib/peer.ts`、`voice-token`、LiveKit | 語音工作線 |
| `src/cloud/auth.ts`、`invite.ts`、`roomRepository.ts` 的同步核心 | `fix/production-stabilization` |
| 已套用的 migration（`0001`–`0021`） | 任何人都不得改，只能新增 |
| `supabase/functions/asset-analysis/index.ts` | 見 §4，交 handoff |

本分支新增的程式碼一律放在：

- `src/features/design-intelligence/`
- `docs/design-intelligence/`
- `scripts/tests/design-intelligence-*.test.ts`
- 新的 migration（編號在合併前確認，避免與 wb 鏈撞號）
