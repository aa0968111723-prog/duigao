# Collaborative Intelligence Workspace 1.0 / 智慧協作工作台 1.0

單一長期開發線。Branch：`agent/collaborative-intelligence-workspace`。不要再開第二條平行線。

`duigao` → Room Context API → `tku-zen-agent`。不另建第二套 agent。

## Phase status

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Asset Intelligence / Room Knowledge / Room Context API | in progress (this PR) |
| 2 | Discussion + whiteboard (`whiteboard_nodes` / `whiteboard_edges`) | not started |
| 3 | AI × whiteboard | not started |
| 4 | Shared + room asset library | not started |
| 5 | Canva integration boundary | DISABLED (optional) |
| 6 | Collaborative voice | DISABLED (optional) |

Feature flags:

- `ai.assetIntelligence = true`
- `collaboration.whiteboard = false`
- `collaboration.voice = false`
- `canva.integration = false`

未完成功能沒有假 UI 入口。

## Phase 1 evidence

- `src/ai/*` — understanding, version awareness, temporal segments, retrieval
- `supabase/migrations/0014_asset_intelligence.sql` — asset metadata, analyses, video segments, relations, knowledge index, RLS
- `scripts/tests/asset-intelligence.test.ts`
- `npm run test:migrations` covers 0014 RLS

Whiteboard / voice / Canva tables are not created in 0014.
