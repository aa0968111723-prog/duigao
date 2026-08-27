# ROADMAP — 從 f327a70 到「一體成形的協作房間」

> v2：依 Grok round pr00（PLAN_MUST_REVISE）修訂。每個 PR 的完成定義：
> source + migration（如需）+ 測試 + 全 gate 綠 + Grok round + 部署驗證。
> 沒有證據的功能只能標 SPEC_ONLY / PARTIAL / BLOCKED。

## Sibling / 已送審

- **#42 fix/video-e2e-fault-race**（OPEN）— CI 紅燈根因。本計畫基準是 f327a70，未包含 #42。

## PR-00 `plan/human-first-visual-collaboration`（本 PR）

盤點、契約、路線；docs only；不標任何功能 IMPLEMENTED。

## PR-01a — 討論就是房間殼（不是預設分頁）

**吃掉的 gaps**：討論不是 Home（blocker）；開內容離開房間殼無人負責（Grok F2）；single-mode 無房級討論；討論寫入 fire-and-forget（F14）；鍵盤/composer 相撞（F6）。

範圍：
1. Project room 的 IA 重構：討論 feed＝房間殼。content/plan/board 不再是與討論並列的頂部+底部 tab；由討論卡（內容卡、企劃卡、白板卡）推進開啟，**永遠可返回討論、不丟房間脈絡**。開有版本的 poster/video 不再切出房間殼（改 overlay/push；App.tsx:2264-2270 的 showProjectShell 邏輯重構）。voice 在 BLOCKED_VOICE_PROVIDER 期間不佔 pane。
2. Single-mode 房：對稿 workspace＋討論 drawer（**不是** MultiBranchRoom tab 殼）；reviewer-progressive-disclosure 與 workspaces-separated invariants 不破。
3. Composer 鍵盤處理：--kb/visualViewport 接到討論 composer；不被 bottom-nav 蓋住。
4. 討論寫入失敗可見＋重試（insertDiscussion 不再 fire-and-forget）。
5. Thread 模型**本 PR 不做**（ADR-009）；不動 legacy messages 表（ADR-008）。

Gate 追加：手機 viewport E2E — 進房即討論殼；從討論卡開內容再返回，脈絡不丟；鍵盤升起時 composer 可見可輸入。

## PR-01b — Universal Intake ＋ 討論附件

**吃掉的 gaps**：8 個分散 intake 入口、兩套 picker；generic attachments 零 UI；無 paste/camera；library_assets 跨房 RLS 與 upsert:true（F10，可立即修）。

範圍：
1. `UniversalIntake` 模組統一入口（UploadZone 為底）；paste；`capture` 相機屬性。
2. 討論附件走**新的討論訊息 kind**（migration：擴 room_discussion_messages kind＋成員可寫、與 versions 分離的附件 storage 路徑）— 不走 registerIntelligentAsset（reviewer 權限相撞，0015:530-531 要 can_manage_media）。reviewer 可補充檔案，不可管理版本。
3. pdf/audio/link 附件的訊息卡 preview／fallback。
4. 修 library_assets 跨房 RLS（0016:64-71）與 upsert 語意。

Gate 追加：composer 附 PDF → 訊息卡出現 PDF；reviewer 能附檔、不能動版本。

## PR-01c — 手機上傳強化（F7）

圖片 addVersion 由 fire-and-forget 改 await＋錯誤＋重試；影片斷點/失敗提示強化（單 POST 無 resume 的誠實 UX）；HEVC/.mov 在選檔當下說清楚可能播不出來。TUS/續傳屬 PR-08 評估項。

## PR-02 — 對話 ⇄ 白板雙向連結（canonical model 收斂）

**吃掉的 gaps**：兩套白板 model（blocker）；apply-back 寫進未 mount 原型（blocker）；開板收不到協作者編輯（blocker）；stale-write 把舊版推進 IDB（F10）；三套 anchor 機制；feature-map scanner 誤報（F13）。

範圍：
1. 下架第二套 model（src/collaboration/whiteboard.ts、DiscussionWorkspace 原型）；apply-back 重接 whiteboard_nodes 真 model。
2. 訊息→節點與節點→訊息雙向（linked_entity_type/id）。
3. 開板 realtime row-patch（whiteboard_nodes/edges）；其他表保留整房 reload。
4. stale-write 衝突分支修正（decideNodeWriteRetry 不再把舊版寫回 IDB）。
5. ContextAnchor 統一**契約層**（union + 轉接三套既有機制；不新增儲存機制，ADR-004）。
6. agent-feature-scan 證據改良：mounted-import 要求，消除 apply-back/library 假 IMPLEMENTED。

## PR-03 — 語音上下文

BLOCKED_VOICE_PROVIDER。provider adapter＋誠實 unavailable 可先行；真 WebRTC 需使用者提供 credential（LiveKit/Twilio 擇一）。

## PR-04 — AI proposal layer（tku-zen-agent 最後一哩）

**吃掉的 gaps**：answer.actions 死在 RoomAiSheet（blocker）；無 proposal→Apply→audit 迴圈；audit 表寫不進（F8）。

範圍：
1. RoomAiSheet 渲染 typed actions 為提案卡；「採用」走 PR-02 真 apply-back。
2. **Migration**：collaboration_audit_events 擴 event_type＋新增 insert 途徑（RPC 或 policy）— 現況 CHECK 只有 3 種、policy 只有 SELECT（0014:270-272,722-724）。
3. Edge chunk cap 與 agent 上限對齊（scrubText 5000 有效上限；非 8000）。
4. HMAC 簽章與 action union **不動**；長度/上限類契約可修。
5. 失敗/quota/timeout 保留輸入可重試。

## PR-05 — Canva 文宣工作面

BLOCKED_CANVA_CREDENTIALS。adapter＋fixture＋flag 可先行；OAuth 需使用者提供。

## PR-06 — planform-iso 3D 場佈工作面

第一階段：planform project JSON＋縮圖/場佈圖 artifact 契約（原始 JSON 不可逆轉換＝零）。第二階段 live embed 前先探測部署端 headers（BLOCKERS）。3D anchor 併入 ContextAnchor union。

## PR-07 — CUTOS 影片協作工作面

ADR-005（v2 收窄）：**禁** iframe/proxy/editor REST 暴露；**允許現在做** AIOS-key S2S contract＋fixture＋MP4 output→duigao artifact。EDL/深整合等 CUTOS auth（獨立 PR 於 CUTOS repo）。

## PR-08 — 品質、離線、release hardening

realtime 全房 reload → row-patch 全面化；durable queue 擴 discussion/decision；bundle 873KB code-split；TUS/續傳評估；PWA/offline/慢網矩陣；observability；Zeabur preview 實測驗收；真機矩陣（HEVC/LINE in-app/Safari seek）。

## Audit-gap → PR 對照表（F10）

| Audit gap（severity） | Owner PR |
|---|---|
| 討論不是 Home（blocker） | PR-01a |
| 開內容離開房間殼 | PR-01a |
| 兩套白板 model／apply-back 未 mount（blocker×2） | PR-02 |
| 開板無 inbound realtime（blocker） | PR-02 |
| generic attachments 零 UI（blocker） | PR-01b |
| AI actions UI 斷頭（blocker） | PR-04 |
| CUTOS editor API 無認證（blocker） | CUTOS repo auth PR＋PR-07 |
| 無 UniversalIntake／paste／camera | PR-01b |
| 圖片 fire-and-forget／HEVC／無續傳 | PR-01c（續傳評估 PR-08） |
| stale-write IDB 舊版 | PR-02 |
| 討論 fire-and-forget | PR-01a |
| 鍵盤/composer | PR-01a |
| library_assets RLS／upsert | PR-01b |
| 全表 reload realtime | PR-02（白板）＋PR-08（全面） |
| audit event 3 種／insert 不可寫 | PR-04 |
| Task 實體不存在 | ADR-009（暫不做） |
| Thread 單層 reply | ADR-009（暫不做） |
| feature-map scanner 字串證據 | PR-02 |
| voice/presentation schema-only | PR-03 |
| bundle 873KB | PR-08 |
| production migration unknown | PR-08（需 env） |

## 序列原則

PR-01a → 01b → 02 → 04 是關鍵路徑。01c 可與 01b 並行；03/05/06/07 視 credential/前置條件插入；08 收尾。
