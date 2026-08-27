# PR_INDEX

| PR | Branch | 狀態 | Scope | 證據 |
|---|---|---|---|---|
| #42 | fix/video-e2e-fault-race | MERGED | CI 紅燈根因：video E2E fault 注入 race → room-scoped + 終態輪詢；無產品碼變更 | A/B（load 下舊 156/157、新 157/157×2）；全 gate 綠；Grok round ci-red-fix |
| #43 PR-00 | plan/human-first-visual-collaboration | MERGED | 盤點＋契約＋路線 docs；不標任何功能 IMPLEMENTED | 7 區域對抗驗證 audit；TEST_STATUS 基準線 |
| #48 PR-01a | feat/discussion-room-shell | MERGED | 討論=房間殼；卡→內容可返回；single 房 drawer；composer 鍵盤/重試 | rounds/pr01a（Grok r1/r2 全修）；全 gate 綠 |
| #49 PR-01b | feat/universal-intake | MERGED | UniversalIntake；討論附件/連結 kind＋0018；storage add-only RLS；library RLS 修 | rounds/pr01b；migrations 5-role probe 綠 |
| PR-01c | feat/mobile-upload-hardening | 未開始 | 圖片 await/重試；HEVC 誠實提示 | — |
| #50 PR-02a | feat/whiteboard-model-teardown | MERGED | 第二套白板模型下架；mounted-import 掛載證據（ADR-010） | rounds/pr02；agent-layer unit 16/16 |
| #51 PR-02b | feat/stale-write-conflict | MERGED | OCC stale-write 衝突分支：drop＋板級 refetch＋誠實 toast；version-first reconcile | rounds/pr02（grok-findings-02b）；e2e 真 409 全迴圈 |
| #52 PR-02c | feat/board-realtime-rowpatch-02c | OPEN（Grok round 修復完，CI 中） | 開板 row-patch realtime；拖曳/in-flight 護盾；heal=整板 replace | rounds/pr02（grok-findings-02c＋claude-adjudication-02c） |
| PR-02d | feat/context-anchor-layer | 未開始 | ContextAnchor 契約層＋七 adapter＋openTarget | implementation-plan.md |
| PR-03 | feat/voice-context | BLOCKED_VOICE_PROVIDER | provider adapter＋誠實 unavailable | — |
| PR-04 | （#44 已由第三 agent 合併核心） | 部分完成 | 剩餘：audit event migration、chunk cap 對齊（Grok pr00 F8） | #44 |
| PR-05 | feat/canva-surface | BLOCKED_CANVA_CREDENTIALS | adapter+fixture 先行 | — |
| PR-06 | feat/planform-artifact | 未開始 | planform JSON+snapshot artifact 契約 | — |
| PR-07 | feat/cutos-s2s-contract | 部分可做（ADR-005 v2） | AIOS-key S2S contract+fixture+MP4 artifact；EDL 等 CUTOS auth |  — |
| PR-08 | hardening/release | 未開始 | realtime row-patch、code-split、offline 矩陣、部署驗收 | — |

歷史合併（#35–#40）見 git log；#41 之前的 feature 狀態以 `.agent/feature-map.json` 為準。

| #44/#45/#46/#47 | codex/third-agent-* | MERGED | AI Apply／keyed pending writes／context path strip／author ACL 0017 | third-agent/ 記錄 |
