# TEST_EVIDENCE

Branch: `codex/third-agent-ai-proposal-apply`  
Base: `ddb916e`

| Command | Result |
| --- | --- |
| `npm run build:local` | PASS (tsc + vite) |
| `npm run test:asset-intelligence` | PASS 14/14 (includes `ai-proposals.test.ts`) |
| `npm run test:collaboration` | PASS 33/33 |
| `npm run test:agent` | PASS 15/15 |
| `npm run test:multi-branch` | PASS 7/7 |
| `npm run test:asset-intelligence-e2e` | PASS 12/12 — 390×844 Android emulation; proposal preview; Apply comment; Apply 0014 node; discussion text |
| `npm run test:collaboration-e2e` | PASS 21/21 |
| `npm run test:multi-branch-e2e` | PASS 16/16 |
| `npm run agent:gate` | PASS |

Not run on this branch (unchanged surfaces): `test:video`, `test:migrations`, `test:share-preview`, `test:review-viewer`.

Physical device: **PHYSICAL_DEVICE_PENDING**  
Production URL: **BLOCKED_ZEABUR_ACCESS**
