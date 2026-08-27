# Collaborative Intelligence Workspace 1.0 / 智慧協作工作台 1.0

單一長期開發線。Branch：`agent/collaborative-intelligence-workspace`。不要再開第二條平行線。

`duigao` → Room Context API → `tku-zen-agent`。不另建第二套 agent。

## Phase status

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Asset Intelligence / Room Knowledge / Room Context API | done |
| 2 | Discussion + whiteboard (`whiteboard_nodes` / `whiteboard_edges`) | done |
| 3 | AI × whiteboard retrieve + apply-back | done |
| 4 | Shared + room asset library | done |
| 5 | Canva integration boundary | DISABLED (optional) |
| 6 | Collaborative voice | DISABLED (optional) |

Feature flags:

- `ai.assetIntelligence = true`
- `collaboration.discussion = true`
- `collaboration.whiteboard = true`
- `collaboration.voice = false`
- `canva.integration = false`

未完成功能沒有假 UI 入口。語音 tab 顯示「語音尚未開放」。

## Evidence

- `src/ai/*` — understanding, version awareness, retrieval, apply-back
- `src/collaboration/*` — node+edge graph, discussion tabs, library search
- `src/features/collaboration/DiscussionWorkspace.tsx`
- `supabase/migrations/0014_asset_intelligence.sql`
- `supabase/migrations/0015_whiteboard.sql`
- `supabase/migrations/0016_asset_library.sql`
- `scripts/tests/asset-intelligence.test.ts`
- `scripts/tests/collaboration.test.ts`
