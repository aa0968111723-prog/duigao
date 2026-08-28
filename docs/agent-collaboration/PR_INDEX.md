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
| #52 PR-02c | feat/board-realtime-rowpatch-02c | MERGED | 開板 row-patch realtime；拖曳/in-flight 護盾；heal=整板 replace | rounds/pr02（02c round）；CI 全綠 |
| #53 PR-02d | feat/context-anchor-layer | MERGED | ContextAnchor 契約層＋adapter 委派＋openTarget | rounds/pr02（02d round，Grok F1 獨立收斂）；unit 72/72 |
| #54 PR-04b | feat/ai-apply-audit | MERGED | 0019 AI 套用稽核＋edge cap 對齊 | rounds/pr04；migrations 232/232 |
| #55 | chore/pr04-round-followup | OPEN（automerge 待 CI） | #54 round 收尾（automerge 搶先）：F1 探針＋裁決文件 | — |
| #56 PR-01c | feat/mobile-upload-hardening | MERGED | 首上傳沿用同房；addVersion 冪等；HEVC 警告 | rounds/pr01c（Grok F1/F2 blocking 全修）；video check 24 ×7 |
| #57 PR-08a | feat/bundle-code-split | MERGED | 進場 JS 902KB→404KB；殼 lazy＋chunk 失敗敘事＋peer 世代守衛 | rounds/pr08（Grok F1–F4 全修） |
| #58 PR-06 | feat/planform-artifact | MERGED | planform artifact 契約：JSON 識別＋摘要卡＋planform-scene 錨臂 | rounds/pr06（Grok PASS）；unit 78、e2e 38 |
| #59 PR-07 | feat/cutos-s2s-contract | MERGED（automerge 搶跑，修復經 #60 補齊） | CUTOS S2S 契約＋cutos-bridge＋成品匯入 | rounds/pr07；multi-branch e2e 26/26 |
| #60 | fix/cutos-grok-round | MERGED | Grok 07 安全修復（redirect 拒跟/串流計量 50MB/分支不增生/誠實敘事） | rounds/pr07/claude-adjudication.md |
| #61 | fix/planform-identifier | MERGED | planform 識別器收緊（pr06 F2/F6 承諾） | 碰撞 fixture；e2e 負例強化 |
| #62 | fix/harness-ws-stub | MERGED | Node 20 CI 無原生 WebSocket → harness stub（main browser 紅燈根因） | CI browser 回綠 |
| #63 PR-08b | feat/offline-matrix | OPEN（CI 中；Grok PASS） | 離線矩陣 e2e＋死區懸掛修復（insert deadline＋回網自癒） | rounds/pr08（08b round）；collab e2e 43/43 |
| PR-03 | feat/voice-room-livekit | MERGED（#64＋修復輪 #65） | LiveKit 語音房 MVP：voice-token edge＋VoiceDock＋失敗即清場 | rounds/pr03 |
| PR-04 | （#44 已由第三 agent 合併核心） | 部分完成 | 剩餘：audit event migration、chunk cap 對齊（Grok pr00 F8） | #44 |
| PR-05 | feat/canva-bridge | MERGED（#69）＋接續修復 #68/#70 | Canva OAuth bridge＋設計匯入為房間圖片版本；share-preview 真人 302 | rounds/pr05 |
| PR-06 | feat/planform-artifact | 未開始 | planform JSON+snapshot artifact 契約 | — |
| PR-07 | feat/cutos-s2s-contract | 部分可做（ADR-005 v2） | AIOS-key S2S contract+fixture+MP4 artifact；EDL 等 CUTOS auth |  — |
| PR-08 | hardening/release | 未開始 | realtime row-patch、code-split、offline 矩陣、部署驗收 | — |

歷史合併（#35–#40）見 git log；#41 之前的 feature 狀態以 `.agent/feature-map.json` 為準。

| #44/#45/#46/#47 | codex/third-agent-* | MERGED | AI Apply／keyed pending writes／context path strip／author ACL 0017 | third-agent/ 記錄 |
