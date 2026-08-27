# PR_INDEX

| PR | Branch | 狀態 | Scope | 證據 |
|---|---|---|---|---|
| #42 | fix/video-e2e-fault-race | OPEN（CI 驗證中） | CI 紅燈根因：video E2E fault 注入 race → room-scoped + 終態輪詢；無產品碼變更 | A/B（load 下舊 156/157、新 157/157×2）；全 gate 綠；Grok round ci-red-fix |
| PR-00 | plan/human-first-visual-collaboration | 本 PR | 盤點＋契約＋路線 docs；不標任何功能 IMPLEMENTED | 7 區域對抗驗證 audit；TEST_STATUS 基準線 |
| PR-01 | feat/discussion-home-universal-intake | 未開始 | 討論成 Home；UniversalIntake；generic attachments 接通 | — |
| PR-02 | feat/whiteboard-canonical-bidirectional | 未開始 | 白板 model 收斂；訊息⇄節點；開板 row-patch realtime；ContextAnchor 契約層 | — |
| PR-03 | feat/voice-context | BLOCKED_VOICE_PROVIDER | provider adapter＋誠實 unavailable | — |
| PR-04 | feat/ai-proposal-apply | 未開始 | actions→提案卡→Apply→audit；tku-zen 契約不動 | — |
| PR-05 | feat/canva-surface | BLOCKED_CANVA_CREDENTIALS | adapter+fixture 先行 | — |
| PR-06 | feat/planform-artifact | 未開始 | planform JSON+snapshot artifact 契約 | — |
| PR-07 | （先 CUTOS repo auth） | BLOCKED_CUTOS_AUTH | 契約先行 | — |
| PR-08 | hardening/release | 未開始 | realtime row-patch、code-split、offline 矩陣、部署驗收 | — |

歷史合併（#35–#40）見 git log；#41 之前的 feature 狀態以 `.agent/feature-map.json` 為準。
