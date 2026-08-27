# FILE_OWNERSHIP — 避免雙 AI 互踩

原則：Grok 審查一律 read-only。Grok 若實作，只在 `grok/<phase>-<topic>` worktree/branch，
Claude 同期不修改同一批檔案；Grok commit 由 Claude review 後 cherry-pick 或重作。

| 區域 | Owner | 備註 |
|---|---|---|
| src/、supabase/、scripts/ 實作變更 | Claude | 每 PR 一個 branch |
| docs/agent-collaboration/rounds/*/grok-findings.* | Grok（產出）| Claude 不改寫其內容，只裁決 |
| docs/agent-collaboration/ 其他 | Claude | |
| .agent/*.json | 生成物 | 只由 `npm run agent:context` 更新，不手改 |
| 外部 repo（CUTOS/planform-iso/tku-zen-agent） | 各自獨立 PR | 不與 duigao PR 混批 |
