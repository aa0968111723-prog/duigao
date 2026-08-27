# Round: pr01a — 討論成為房間殼（實際 diff review）

Branch: feat/discussion-room-shell（base main@344459e，單一 commit 5328018）。
實作計畫：implementation-plan.md（同目錄）。變更摘要見 commit message。

請以獨立 adversarial 視角審 **實際 diff**（git diff main...HEAD）與現行原始碼：

1. IA 契約：討論是否真的成為房間殼？overlay/推進面板有沒有變相做回四分頁？
   開內容是否可返回且殼狀態保留？有沒有漏掉的離殼路徑（deep link、分享、
   AI citation focus、createProjectContent…）？
2. outbox 正確性：ghost/serverIds/pre-bind flush/duplicate-key/claim 去抖——
   找 race：雙擊、重試同時 snapshot 到達、bound 切換、房間切換殘留 entry。
3. 快照競態修復是否正確而非掩蓋：PlanEditor updatedAt 守門會不會拒收合法
   遠端更新？plans 保內容 reconcile 在「別人真的清空 blocks」時行為？
   projectMode 不降級在「房間真的變 single」時（有這種流程嗎）？
4. single 房 drawer：reviewer invariant 是否真的成立？legacy messages 併入
   的互動（支持/回覆）是否產生錯誤寫入？桌機/影片位置的佈局破壞？
5. E2E 更新是否「刻意且等價」，有沒有把原本的保護測弱？新增檢查是否可能假綠？
6. CSS/z-index：overlay 30、push-pane 28、composer 30、FAB 25、bottom-nav 已刪
   — 疊層衝突？--kb ref-count 的洩漏？

輸出逐項 finding：{severity, claim, evidence(file:line), repro, suggested_fix, blocks_release}。不要客套。
