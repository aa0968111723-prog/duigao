# duigao Agent Instructions

產品：手機優先的圖片／影片對稿協作工具。

## 強制原則

- 只標記，不改原稿；原始圖片／影片不可被修改。
- reviewer UX 極簡；深功能採 progressive disclosure；圖片／影片 workspace 分離。
- Supabase/Postgres 是 cloud source of truth；IndexedDB 只是 cache/offline layer。
- `room-assets` 永遠 private；invite secret 永遠只能存在 URL fragment。
- reviewer 不可取得 owner/editor 的媒體上傳、取代、封存或刪除能力。
- 功能 PR 不可只有 docs；build / E2E / RLS / migration / agent gate 未全綠不得 merge。
- `AUTOMERGE REQUIRES AGENT_GATE_PASS`。

## 開始任何任務前

1. 執行 `npm run agent:context`。
2. 讀 `.agent/state.json`、`.agent/feature-map.json`、`.agent/invariants.json`。
3. 檢查相關 source、migrations、tests 與 Git diff，再開始修改。

可信度：程式碼 → migrations → tests → Git diff → deployment/production → PR metadata → docs。若 docs 宣稱完成但沒有 source/migration/test 證據，狀態必須是 `SPEC_ONLY`，不可寫 `IMPLEMENTED`。

## Agent Context Protocol

`READ → VERIFY → PLAN → IMPLEMENT → TEST → GATE → MERGE`

禁止：`PROMPT → WRITE DOC → DECLARE DONE`。
