# TEST_BASELINE

Recorded on `cursor/gap-remediation-audit-70d9` from `origin/main` @ `398960d`.  
`package.json` has **no** `"test"` script. Commands below are the real scripts (discovered, not guessed).

## Scripts in package.json

| Script | Purpose |
|---|---|
| `npm run build` | check-cloud-env --strict + tsc + vite (needs VITE_* or fails) |
| `npm run build:local` | tsc + vite without env gate |
| `npm run check:cloud-env` | env gate only |
| `npm run test:share-e2e` | `scripts/e2e/share-flow.mjs` |
| `npm run test:share-preview` | `scripts/e2e/share-preview.mjs` |
| `npm run test:video` | `scripts/e2e/video-flow.mjs` |
| `npm run test:review-viewer` | `scripts/e2e/review-viewer.mjs` |
| `npm run test:viewer-geometry` | geometry unit |
| `npm run test:asset-intelligence` | AI / proposals / strip |
| `npm run test:asset-intelligence-e2e` | browser AI |
| `npm run test:multi-branch` | branches + video-media + canva/cutos + **api-response (this PR)** |
| `npm run test:collaboration` | workspace / outbox / replies / anchors / planform |
| `npm run test:multi-branch-e2e` | browser multi-branch |
| `npm run test:collaboration-e2e` | browser collab |
| `npm run test:migrations` | real PostgreSQL + RLS |
| `npm run test:design-intelligence` | schema only on main |
| `npm run test:agent` | agent-layer |
| `npm run test:edge-cors` | edge CORS |
| `npm run test:api-response` | **new** SPA/HTML/missing-key honesty |
| `npm run agent:gate` | release gate |
| `npm test` | **MISSING** — do not invent a green |

## Results this session

Filled after the commands actually ran. See `PROGRESS.md` for updates.

| Command | Result | Notes |
|---|---|---|
| `npm run test:api-response` | *(pending in this file; updated after run)* | |
| `npm run test:multi-branch` | | |
| `npm run test:agent` | | |
| `npm run test:edge-cors` | | |
| `npm run test:asset-intelligence` | | |
| `npm run test:collaboration` | | |
| `npm run test:viewer-geometry` | | |
| `npm run test:design-intelligence` | | |
| `npm run test:migrations` | | needs local postgres |
| `npm run test:share-e2e` | | playwright + mock |
| `npm run test:share-preview` | | |
| `npm run test:video` | | |
| `npm run test:review-viewer` | | |
| `npm run test:multi-branch-e2e` | | |
| `npm run test:collaboration-e2e` | | |
| `npm run test:asset-intelligence-e2e` | | |
| `npm run build:local` | | |
| `npm run build` | | expected fail without VITE_* |
| `npm run agent:gate` | | |

## Negative controls this PR must keep

1. SPA HTML 200 ≠ function success (`parseFunctionPayload` → `SPA_HTML`)
2. `{ ok: true }` without token/versionId → `MISSING_KEYS`
3. `check-cloud-env --strict` with empty keys exits ≠ 0
4. service-role-shaped `VITE_SUPABASE_PUBLISHABLE_KEY` exits ≠ 0
5. A status-only helper **would** accept production HTML (documented so nobody “simplifies” the parser)
