# ROADMAP — 從 f327a70 到「一體成形的協作房間」

每個 PR 的完成定義：source + migration（如需）+ 測試 + 全 gate 綠 + Grok round + 部署驗證。
沒有這些證據的功能只能標 SPEC_ONLY / PARTIAL / BLOCKED。

## 已完成

- **HOTFIX #42** — video E2E fault-injection race（CI 紅燈根因）。已 A/B 驗證。

## PR-00 `plan/human-first-visual-collaboration`（本 PR）

盤點、契約、路線；docs only（計畫 PR 豁免 feature-pr-not-docs-only，不標任何功能 IMPLEMENTED）。

## PR-01 — 討論成為 Home ＋ Universal Intake

**吃掉的 audit gaps**：討論不是 Home（blocker）；8 個分散 intake 入口；generic attachments 零 UI；無 paste/camera；Thread 只有單層 reply。

範圍：
1. Project room 預設 tab 改為討論（overview 內容併入討論頂部的 context 卡）；single-mode 房補房級討論面（room_discussion_messages 已通用，複用而非新表）。
2. `UniversalIntake` 模組：統一 8 個入口到單一 intake path（UploadZone 為底），composer／白板／review 工作區／branch add 全走同一條；加 paste 與 `capture` 相機屬性。
3. Generic attachments 第一步：接通 registerIntelligentAsset 既有 API（pdf/audio/link/document），composer 附件按鈕可加非圖影檔，存 intelligent_assets（schema 已在 0015/0016）。
4. 不動 legacy messages 表（single 房舊資料照舊讀），新寫入走 room_discussion_messages；遷移策略記入 DECISIONS。

Gate 追加：discussion-home E2E（手機 viewport：進房即討論、附件從 composer 進、pdf 附件出現於資產庫）。

## PR-02 — 對話 ⇄ 白板雙向連結（canonical model 收斂）

**吃掉的 gaps**：兩套白板 model（blocker）；apply-back 寫進未 mount 的原型（blocker）；開板收不到協作者編輯（blocker）；三套 anchor 機制。

範圍：
1. 刪除第二套 model：src/collaboration/whiteboard.ts、DiscussionWorkspace.tsx 原型下架；apply-back 改寫為對 whiteboard_nodes（0014 真 model）的 insert，保留作者/來源訊息連結（linked_entity_type/id）。
2. 訊息→節點（一鍵加入白板）與節點→訊息（點卡回跳）雙向，走既有 linkedEntity 欄位。
3. 開板 realtime：whiteboard_nodes/edges 的 postgres_changes 改 row-patch 進已開白板（保留整房 reload 作為其他表的 fallback）。
4. ContextAnchor 統一**只做契約層**：TypeScript union（poster_region/video_time_range/plan_section/whiteboard_node）+ 轉接三套既有機制；不加第四套儲存機制（audit 風險明確警告）。

## PR-03 — 語音上下文（誠實 unavailable → 真 provider adapter）

現況：voice_sessions/participants schema 已存在（0014），client 全部 throw 在 VOICE_ROOM_MVP=false 後面。
範圍：provider adapter 介面 + 無 credential 時透明顯示未設定；有 credential（LiveKit/Twilio 擇一，需使用者提供）才開 MVP：加入/離開/成員/靜音/focus 廣播。無 credential 就以 BLOCKED 記錄，不假裝。

## PR-04 — AI proposal layer（tku-zen-agent 已接通的最後一哩）

**吃掉的 gaps**：answer.actions 死在 RoomAiSheet（blocker）；無 proposal→Apply→audit 迴圈。
範圍：
1. RoomAiSheet 渲染 typed actions 為提案卡（影響什麼、會建立什麼、來源模型）；「採用」後走 PR-02 的真 apply-back 寫 whiteboard_nodes / discussion，並寫 collaboration_audit_events（事件型別擴充）。
2. 失敗/quota/timeout 保留輸入可重試（edge 已有 agent-status，補 UI）。
3. tku-zen-agent 端已有 /api/v1/room-context/answer + HMAC（兩端有測試）；本 PR 不改該契約。

## PR-05 — Canva 文宣工作面

需 Canva OAuth credentials（使用者提供）。無 credential：adapter + fixture + feature flag，狀態 BLOCKED_CANVA_CREDENTIALS。有：OAuth（token 只在 server/edge）、design reference、export→ArtifactVersion、return navigation。

## PR-06 — planform-iso 3D 場佈工作面

第一階段（無需改 planform repo）：planform project JSON + 縮圖/場佈圖作為 duigao artifact/version（intelligent_assets kind 擴充或 link asset）；匯入/匯出往返保留原始 JSON 不可逆轉換＝零。
第二階段：live embed 前先探測部署端 X-Frame-Options/CSP（記錄於 BLOCKERS）；typed postMessage 契約 + origin 驗證。3D anchor 併入 PR-02 的 ContextAnchor union（planform_object）。

## PR-07 — CUTOS 影片協作工作面

**前置 blocker**：CUTOS editor API 無認證單租戶（audit CONFIRMED）。順序：
1. 先在 CUTOS repo 落 auth（API key/session + project scoping）— 獨立 PR，不混入 duigao。
2. duigao 端：timeline/EDL artifact 契約 + 時間 anchor（PR-02 union 已含 video_time_range，擴 track/clip）+ EditProposal 走 PR-04 提案卡。
3. render 為背景 job（CUTOS 端已有 job 結構，經 bridge 介接）。
無法完成 1 之前，duigao 端只落 contract + fixture，狀態 BLOCKED_CUTOS_AUTH。

## PR-08 — 品質、離線、release hardening

realtime 全房 reload → 分表 row-patch；bundle 873KB 超標 code-split；PWA/offline/safe-area/鍵盤/慢網/大檔上傳矩陣；observability；Zeabur preview 實測驗收。

## 序列原則

PR-01 → PR-02 → PR-04 是關鍵路徑（Home → canonical 白板 → AI 迴圈）。PR-03/05/06/07 視 credential/前置條件可並行插入；PR-08 收尾。
