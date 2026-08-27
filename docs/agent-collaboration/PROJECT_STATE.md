# PROJECT_STATE — duigao 長任務檢查點

> 恢復規則：任何 session 重新進入工作，先讀本檔，再讀 ROADMAP.md 與 BLOCKERS.md，
> 然後執行 `npm run agent:context` 比對現況。不重做已驗證工作。

更新：2026-08-28 08:00（Asia/Taipei）
基準：main @ 23490c6（PR-06 #58）

## 目前 phase

PR-07（#59，feat/cutos-s2s-contract，draft）— CUTOS S2S 契約＋成品匯入；
CI＋Grok round 進行中，兩者綠即 ready→merge。

## 已合併（時序）

#42 CI 紅燈修復 → #43 PR-00 計畫 → #44 AI Apply（第三 agent）→ #45 keyed
pending writes → #47 author ACL → #46 context path strip → #48 PR-01a
討論殼 → #49 PR-01b Universal Intake＋0018 → #50 PR-02a 模型下架 →
#51 PR-02b stale-write 衝突 → #52 PR-02c 開板 row-patch → #53 PR-02d
ContextAnchor 契約層 → #54 PR-04b AI 稽核 0019 → #55 round 收尾 →
#56 PR-01c 手機上傳強化 → #57 PR-08a code-split（902KB→404KB）→
#58 PR-06 planform artifact 契約。

**PR-02 系列全數完成；PR-01 系列全數完成；PR-04 剩餘完成；PR-08 第一刀完成。**

## 已完成（有證據）

| 項目 | 證據 |
|---|---|
| 雙 AI 握手 | rounds/pr00/grok-smoke.json（exit 0、回覆逐字 GROK_DUAL_COLLAB_READY、grok 1.0.5 / grok-4.6-build）；rounds/pr00/grok-inspect.txt（讀到 Agents.md、35 permissions、22 skills）。Claude 端：本 session 是 Claude Code 桌面/agent session，shell 內無 `claude` CLI（如實記錄，未冒充） |
| CI 紅燈根因修復 | **sibling PR #42（OPEN，未合併；本計畫基準 f327a70 不含它）**。全域 fault 注入 race；A/B：舊碼 6×CPU load 156/157、新碼同載 157/157×2。Grok round ci-red-fix 已裁決 |
| 現況深度盤點 | 7 區域 × 13 agents，rounds/pr00/current-state-audit.md；blocker 級 gap 全數經第二 agent 對抗驗證（6 CONFIRMED / 1 PARTIAL） |
| 測試基準線 | TEST_STATUS.md（main @ f327a70 + PR42 修復後全綠） |
| 外部 repo 實際存取 | planform-iso（public，shallow clone 已讀）、CUTOS（private，gh 可讀，shallow clone 已讀）、tku-zen-agent（private，本機 D:\生成系統最新\tku-zen-agent = origin/main f6dc790） |

## 進行中

- PR-00 計畫文件（本 PR）。

## 尚未開始（見 ROADMAP.md）

PR-01 起的實作序列。

## 關鍵現況事實（來自盤點，開工前必讀）

1. **討論不是 Home**：project room 落在 overview tab，討論是第 4 個 tab；single-mode 房完全沒有房級討論面。（MultiBranchRoom.tsx:83,430）
2. **白板有兩套 model**：真的那套 = whiteboard_nodes/0014 + WhiteboardWorkspace；假的那套 = src/collaboration/whiteboard.ts（canvasId、無持久化），而號稱完成的 AI apply-back 只寫進假的那套，宿主 DiscussionWorkspace.tsx **從未被 mount**。
3. **AI actions 管線在 UI 斷頭**：tku-zen-agent HMAC 契約兩端都真接通（edge → /api/v1/room-context/answer），但 RoomAiSheet 只渲染 text+citations，answer.actions 無人讀取 → 「AI 提案 → 人 Apply」核心迴圈不存在。
4. **Universal Intake 不存在**：8 個分散入口、兩套 picker；generic attachments（pdf/audio/link）schema 有、UI 零入口（registerIntelligentAsset 零呼叫者）；無 paste、無 camera capture、無 share_target。
5. **開著的白板收不到別人的編輯**：postgres_changes 只觸發整房 debounced reload，而 reload 對已開白板保留現有 nodes → 要關掉重開才看得到協作者的變更。
6. **CUTOS editor REST API 完全無認證**（僅 /api/aios/invoke 有 key）：接進 duigao 前必須先解決 auth/tenancy，否則任何訪客可讀寫所有專案。
7. **planform-iso 是純前端 local-first PWA**（無後端、localStorage+IDB、PROJECT_VERSION=7）：第一階段只能走 project JSON + snapshot 的 artifact 契約，iframe 可行性取決於部署端 headers，需 live 探測。
8. **production migration 狀態 unknown**：agent:context 顯示 repo head 0016，線上未驗證；本機無 VITE_SUPABASE_URL（cloud env missing）。
9. Realtime 是單 channel ~26 bindings → 整房快照 reload；行動端負載風險，PR-02/08 需 row-patch。
10. Task 實體完全不存在；ActivityEvent 只有 3 種 audit 事件；Thread 只有單層 reply_to_id。

## feature-map scanner 已知誤報（Grok F13；PR-02 修 scanner 前開工必讀）

| feature-map 條目 | 標示 | 實況 |
|---|---|---|
| whiteboard-apply-back | implemented | 證據檔 src/collaboration/whiteboard.ts / src/ai/roomContext.ts 未被任何 mounted 元件 import；AI apply-back 不會出現在出貨 UI |
| intelligent-asset-library | implemented | src/collaboration/library.ts 是 in-memory，無 client 寫入 library_assets |
| room-ai-context / asset-analysis 相關 | implemented | 後端管線真、UI 端 actions 斷頭（PR-04 目標） |

## 可直接恢復的下一步

1. 確認 PR #42 CI 綠 → merge（AUTOMERGE REQUIRES AGENT_GATE_PASS）。
2. PR-00 經 Grok review + 裁決後開 PR。
3. 開工 PR-01（見 ROADMAP.md 的 scope 與 gate 定義）。
