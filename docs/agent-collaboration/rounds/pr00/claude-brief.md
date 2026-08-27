# Round: pr00 — 計畫 PR 審查

請以獨立 adversarial 視角審查本 branch（plan/human-first-visual-collaboration）的計畫文件：

- docs/agent-collaboration/ROADMAP.md（PR-01..08 範圍與序列）
- docs/agent-collaboration/DECISIONS.md（ADR-001..007）
- docs/agent-collaboration/rounds/pr00/current-state-audit.md（7 區域盤點）
- docs/agent-collaboration/PROJECT_STATE.md / BLOCKERS.md / TEST_STATUS.md

審查焦點（對照產品使命：人先討論、AI 輔助、檔案補充；手機平板最強；一體成形不混亂）：
1. 是否誤解定位？ROADMAP 有沒有把「討論是 Home」做成又一個互相競爭的分頁？
2. 序列是否正確？PR-01→02→04 關鍵路徑有沒有隱藏依賴或該對調的順序？
3. audit 結論有沒有你能在 repo 裡直接反駁的錯誤主張（抽查 file:line）？
4. ADR-001（Supabase 留任 SoT）與 ADR-005（CUTOS 先 auth）的推理是否成立？
5. 手機/平板 UX 有沒有被計畫遺漏的致命項（鍵盤、safe-area、離線、上傳）？
6. 哪些 scope 過大應該再切；哪些 BLOCKED 其實可以現在就做一部分？

輸出逐項 finding：{severity, claim, evidence, suggested_fix, blocks_release}。不要客套。
