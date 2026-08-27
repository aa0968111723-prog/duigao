# DECISIONS — ADR 索引

## ADR-001：Supabase 仍是協作資料的 source of truth；InsForge 僅限 AI 邊界

日期：2026-08-28　狀態：**採納**

比較過的選項：
- **A. 保留 Supabase 為協作 SoT，InsForge 只作 AI／agent 資料層（採納）**
- B. 全量遷移 InsForge
- C. 雙寫

理由（證據）：
- 16 個 migration、RLS 全表覆蓋、fragment-only invite、private bucket 與 192/192 的 migration/RLS 測試都在 Supabase 上（scripts/e2e/migrations.mjs 以真 PostgreSQL 驗 owner/editor/reviewer/stranger/anon 五角色）。遷移等於重建整個安全基礎。
- InsForge 專案（ge5cr87f.us-east）是 tku-zen-agent 的資料層（knowledge/visual/graph schema）。duigao 與它的邊界已經以 HMAC edge functions 存在：room-ai-context / asset-analysis → tku-zen-agent API。AI 需要的資料交換已有清楚的、經簽章的介面，不需要資料庫層互通。
- 無設計雙寫被明令禁止（任務規範第四節），且 audit 顯示現有 IndexedDB offline queue 與 optimistic version 機制都繫在 Supabase row shape 上。

邊界：InsForge 憑證只存在 tku-zen-agent 部署端；duigao repo 與前端永遠不出現 InsForge key。若未來要把 AI 產出物（分析結果）長存，走 tku-zen-agent API，不直連。

## ADR-002：產品內 runtime AI = tku-zen-agent（既有 HMAC 契約），Claude/Grok 僅開發期

日期：2026-08-28　狀態：**採納**

- 契約已兩端落地且有測試：duigao edge `supabase/functions/room-ai-context/index.ts:160-203` ⇄ tku-zen-agent `app/main.py:272,974-986`（x-duigao-timestamp + HMAC-SHA256、300s skew、TestClient 測試）。PR-04 只補 UI 端斷頭的 actions 迴圈，不動契約。
- 模型 gateway 由 tku-zen-agent 端設定（LLM_PROVIDER=zeabur|nvidia），duigao 不感知。

## ADR-003：白板 canonical model = whiteboard_nodes（0014）；第二套 model 下架

日期：2026-08-28　狀態：**採納**（PR-02 執行）

- 唯一有持久化、RLS、optimistic-lock（stale-write trigger）、realtime publication 與 mounted UI 的是 0014 那套。src/collaboration/whiteboard.ts（canvasId/WhiteboardGraph）無持久化、宿主未 mount，audit 對抗驗證 CONFIRMED。
- 遷移：無資料需要遷（第二套從未寫入任何 storage）；純程式碼下架 + apply-back 重接。

## ADR-004：ContextAnchor 先統一契約層，不新增第四套儲存機制

日期：2026-08-28　狀態：**採納**（PR-02 執行）

三套既有機制（comments 欄位、whiteboard_nodes.linked_entity、discussion payload jsonb）以 TypeScript union + 轉接層統一讀寫；儲存層不動。audit 風險：貿然建新表會變成第四套平行機制。

## ADR-005：CUTOS 整合前置條件 = CUTOS 自身先有 auth/tenancy

日期：2026-08-28　狀態：**採納**（PR-07 序列）

audit CONFIRMED：CUTOS editor REST API 無認證，僅 /api/aios/invoke 有 key。任何 iframe/proxy 暴露 = 所有專案對所有訪客可讀寫。先在 CUTOS repo 落 auth，duigao 端在此之前只做 contract + fixture。

## ADR-006：planform-iso 第一階段 = artifact 契約（JSON+snapshot），不是 live embed

日期：2026-08-28　狀態：**採納**（PR-06 序列）

planform 是純前端 local-first PWA（無後端、localStorage/IDB、PROJECT_VERSION=7）。live embed 的 X-Frame-Options/CSP 取決於部署端 host config，程式碼審計無法確認，需 live 探測後才決定第二階段。

## ADR-007：計畫 PR 豁免 feature-pr-not-docs-only；任何功能狀態仍由 agent-gate 證據裁定

日期：2026-08-28　狀態：**採納**

PR-00 是 docs-only 的計畫 checkpoint（任務規範明定第一個 PR 為計畫 PR）。它不標任何功能 IMPLEMENTED，不改 feature-map。

## ADR-005 修訂（v2）：收窄 CUTOS 封鎖範圍（Grok F9）

日期：2026-08-28　狀態：**採納**（取代 v1 表述）

禁止：iframe／proxy／把無認證 editor REST 暴露給任何房間成員。
允許現在做：以 `CUTOS_API_KEY` 保護的 `/api/aios/invoke` S2S contract＋fixture；CUTOS 輸出 MP4 → 上傳為 duigao artifact。EDL／deep-link 深整合仍以 CUTOS auth 落地為前置。

## ADR-008：雙訊息表策略（Grok F4）

日期：2026-08-28　狀態：**採納**

- 新寫入一律 `room_discussion_messages`（0014，11 kinds＋jsonb payload，PR-01b 再擴附件 kind）。
- legacy `messages`（0001）唯讀保留服務既有 single 房歷史；不遷移、不雙寫。
- single 房的「討論 drawer」讀寫 room_discussion_messages；歷史 messages 以唯讀卡顯示（如有）。
- 移除 legacy 表屬 PR-08 之後的獨立決策，需線上資料盤點。

## ADR-009：Thread 與 Task 本輪不做（Grok F4/F10）

日期：2026-08-28　狀態：**採納**

- Thread：維持單層 reply_to_id（引用式回覆）。巢狀 thread 對手機殼的 IA 成本高、audit 未顯示使用者需求證據；待真實使用回饋再開 ADR。
- Task：不建 Task 表。決定（decision_records）＋提案卡已覆蓋「收斂結論」主流程；行動項先以 decision 附註承載。若 PR-04 之後 AI 產生行動項的需求成立，屆時以 migration 補。
