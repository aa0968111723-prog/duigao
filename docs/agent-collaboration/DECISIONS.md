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

## ADR-010：第二套白板模型（canvasId 原型）下架；VOICE_ROOM_MVP 為唯一旗標機制

日期：2026-08-28　狀態：**採納**（PR-02a 執行）

- 刪除 src/collaboration/{whiteboard,discussionShell,library}.ts、
  src/features/collaboration/DiscussionWorkspace.tsx（含其 css）與 src/ai 的
  原型枝葉（roomContext/index/featureFlags/understanding/versionAwareness/
  video/types）。#44 已把 AI Apply 接到 0014 真模型；原型再無任何掛載者。
- src/ai/featureFlags.ts 隨原型刪除：語音唯一旗標為
  src/features/collaboration/voice.ts 的 VOICE_ROOM_MVP（PR-03 于此開關）；
  Canva/其他旗標於各自 PR 落地時在使用點就地定義，不再有集中 flag 檔。
- 原型上的「第一屏 對話/白板/語音」契約由真殼承接（移植測試釘住：討論根
  ＋rd-tabs＋voice-boundary 一行邊界）；Bounded Room Context 契約由
  room-context-strip / asset-intelligence 測試持有。
- feature-map 證據自此要求 mounted-import（src/ 檔案必須從 src/main.tsx
  走得到）；intelligent-asset-library 誠實降為 partial（schema 真、client 零）。
## ADR-011：stale-write 以 drop+refetch 解；離線重放維持 upsert 語意

日期：2026-08-28　狀態：**採納**（PR-02b）

- 版本衝突（0014 touch_whiteboard_node 的 'stale-write'）不是可重試失敗：
  舊 payload 不進任何佇列，清掉 IDB 殘鍵、toast 告知、scheduleReload 取回
  較新內容。本輪不做逐節點 merge/rebase UI。
- 離線重放**維持 upsert**：離線期間新建的節點必須能重放建立；改成
  update-only 會把離線創作整批丟掉。代價是「已刪節點被離線重放復活」的
  已知窗口 — 接受並記錄，未來以 tombstone 檢查（PR-08 或 02c 後續）關窗。

### ADR-011 補記（Grok pr02b F5）

- 相等 version 不觸發 stale-write：0014 trigger 條件是 incoming < stored，
  相等會被接受並 +1 — 同版本並發是 LWW 覆寫，屬既有語意。
- 離線 delete 無 OCC：重放的 delete 會刪掉別人已更新的列（與復活窗口對偶）。
  兩者都留給 tombstone 設計一併處理；delete 路徑不裝假的 conflict 分支。

## ADR-012：branch protection 必要化四個 CI check（automerge 搶跑事故）

日期：2026-08-28　狀態：**採納**

#54/#59/#60 三次 automerge 在「round 修復 push 之前」或「browser 紅燈下」
合併了舊 head — automerge 原本只 gate agent-release-gate。已把 main 的
branch protection 設為 required：build＋browser＋migrations＋
agent-read-layer，strict（head 必須 up-to-date）。效果：automerge 不能
再搶跑晚到的 push、也不能帶著紅色 browser 合併。副作用：每個 PR 合併前
若 main 前進需 update-branch（成本可接受）。三次事故皆已以 cherry-pick
跟進 PR 補齊（#55/#60/#62），main 無缺失殘留。

## ADR-013：白板架構 — 保留自研引擎並分層強化；xyflow 為明訂的後備方案

日期：2026-08-28　狀態：**採納**（PR-02 結束時有量化重評檢查點）

### 比較過的選項（依 WHITEBOARD_AUDIT §9 與 2026-08 現時 library 實查）

| 選項 | 授權/成本 | bundle(gzip) | 行動觸控 | 資料模型主權 | 判定 |
|---|---|---|---|---|---|
| A. 保留並強化自研引擎（**採納**） | 無 | 最小（+可選 use-gesture ~7KB） | 缺口明確可補（見下） | 完美（本來就是 entity model） | ✅ |
| B. @xyflow/react 12.11.5 | MIT | ~60KB | 中等（Grok 覆核修正：#5066 已關閉且屬 v10 時代、#5475 已修；僅 #5341 仍開且限 panOnScroll 桌機情境 — 原始研究的證據**過時，已撤回**） | 最佳（fully controlled 一級模式） | 後備 |
| C. tldraw 5.3.2 | **專有＋production license key＋年費** | ~524KB | 業界最佳 | **相抵觸**（自帶 reactive store 為 session truth） | ✗ |
| D. excalidraw 0.18.1 | MIT | ~353KB+lazy | 桌面優先、stylus issues | 弱（自有 scene/element 格式）；**無 custom node renderer** | ✗ |
| E. konva+react-konva | MIT | ~96KB | 手勢全自建 | 最佳（純 view） | 次備（若節點轉向自由繪圖） |
| F. pixi.js 8 | MIT | ~258KB+viewport | 全 DIY | 最佳 | overkill ✗ |

### 決策理由

1. **最不可擾動的資產是同步管線，不是渲染**。OCC（DB trigger 自增
   version）＋row-patch（rAF 合併）＋in-flight/dragging shield＋
   IndexedDB durable 佇列，經 pr02b/02c/02d 三輪 Grok 對抗審查與真斷網
   e2e 淬鍊。導入任何自帶 store 的 library（C/D）直接牴觸「Supabase
   entity-level model 為 source of truth」的硬需求；即使是 controlled
   模式的 B，也要把 shield/echo/OCC 邏輯重新縫進 zustand 派生 state —
   在我們已被對抗驗證的程式碼上製造最大 churn。
2. **稽核顯示行動端痛點多數不在引擎**：畫布 48% 可視是 CSS 高度鏈
   斷裂＋殼佔用（版面）；手勢缺口（pinch 不清 drag、長按無 slop、雙指
   平移、套索、鍵盤避讓、pointer 雙擊）是 104 行 canvas.ts＋749 行
   workspace 內的具體修補，每一項都有測試掛點。
3. **誠實的成本對比（Grok F1 修正後）**：xyflow 的行動觸控 issue 清單
   經覆核大多已修 — 「導入仍要修別人手勢層」的論據**弱於原稿**。同時
   PR-02 本來就要重寫自研手勢層（分層拆解），兩案的手勢工程量級相近。
   決策的真正裁量點只剩兩個：(a) 同步管線（shield/echo/OCC）縫進
   zustand 派生 state 的 churn 與風險；(b) 資料模型主權的長期成本。
   這兩點仍偏向 A，但**差距比原稿窄** — 因此檢查點從「參考」升為
   「強制」（見下）。另：畫布外 pinch 縮放整頁是我們自己的 viewport
   缺口（audit §2），與 library 無關，兩案都要修。
4. **成本誠實面**：自研的隱性成本是手勢邊角（iOS Safari 慣性、palm
   rejection、stylus 區分）。對策：(a) PR-02 允許引入 @use-gesture
   （~7KB，MIT，純手勢辨識、零資料模型）承擔仲裁數學，PR-02 spike 時
   決定；(b) 平板 Pencil/palm rejection 屬 PR-05，屆時重評。

### 執行形狀（PR-01/PR-02 的邊界）

- 引擎分層：`canvas.ts` 拆為 camera（純數學）/ gestures（仲裁狀態機）/
  registry（node renderer 註冊表，消滅 NodeView 內的型別分支）/
  interaction（selection/marquee/lasso）。WhiteboardWorkspace 只剩組裝。
- schema 一律 additive（見 rounds/wb00/migration-plan.md）；
  operations 採 append-only 事件表（不做 CRDT — OCC＋可見衝突已被驗證
  足夠，CRDT 屬過度工程，除非重評觸發）。
- presence（cursor/selection）走 Realtime channel broadcast（暫態），
  **不落表**（沿 0014:783 的既有邊界）；throttle 於 client。

### 重評檢查點（PR-02 結束，量化，防 game 版 — Grok F1）

**通過定義 = 五項全過**，缺一即「不過」：pinch 縮放錨點漂移 <8px、
pinch↔drag 切換零節點跳動、長按成功率（10 次帶自然抖動）≥9、雙指
平移可用、鍵盤彈出時編輯節點完整可見（在鍵盤上緣之上）。

防 game 條款：
- 量測**只認真機**（Android Chrome＋iPhone Safari 各一輪），證據 =
  錄影檔＋逐項數據表存 rounds/wb02/，CDP/模擬器數據不得替代。
- 任一項不過 → 修補窗**七個日曆天**（起算日寫入 rounds/wb02）；到期
  重測仍有**任一項**不過 → **無條件啟動 xyflow spike**（一週 timebox，
  同步管線與 entity model 不動），spike 結果與 A 並排比較後由人類裁決。
- 不允許「持續修補不觸發」：修補窗只有一次。

## ADR-014：白板多人寫入 = entity-level OCC ＋ append-only operations，不做整包覆蓋、不做 CRDT

日期：2026-08-28　狀態：**採納**（PR-01 落地）

- 既有 0014 的 version＋trigger 樂觀鎖保留為權威；`whiteboard_operations`
  append-only 表補「誰在何時做了什麼」的可重放事實（undo/redo 與版本
  歷史的基礎），**不是**第二個 truth — 套用順序仍由 row state 決定。
- edges 補 version/updated_at/created_by＋touch trigger（現況 edges 零
  OCC，audit §4）；delete 補 tombstone 語意（ADR-011 缺口在 PR-01 併決）。
- **undo 契約（Grok F2 修訂）**：operations 帶 client 產 `op_id`
（unique，重試冪等）＋ `field_mask`＋僅 mask 欄位的 before/after；
undo 永不整列還原 — inverse 只回寫 mask 內欄位、帶當前 acked version
走同一條 OCC 管線，衝突即可見。row 與 op 非原子的兩種缺口（op 缺=
undo 粒度損失；幽靈 op=被 mask 限制傷害面）均為明示取捨。
- 衝突永遠可見（既有誠實 toast＋drop-refetch 模式延續），禁止靜默
last-write-wins。P2P 整包 Room JSON 路徑經覆核（Grok F7）：cloud 房
collabRef 為 null、該路徑僅在本機/PeerJS 房活躍 — 嚴重度下修，PR-04
仍收斂之（cloud 房斷言 P2P snapshot 不可達）。
- 繪製/命中全序 =`(z_index, created_at, id)` 三鍵（Grok F5），render
與 hit-test 共用同一排序 util；frame `z_index<0`、node `z_index>=0`
是 DB CHECK 不變式，非慣例。
