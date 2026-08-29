# BASELINE — gap remediation audit

Date: 2026-08-29  
Auditor branch: `cursor/gap-remediation-audit-70d9`  
Base: `origin/main` @ `398960d4251d84bb906f04358a714bc2709791c2`  
Production: https://duigao-k7q2.zeabur.app/  
Production `Last-Modified`: Sat, 29 Aug 2026 07:08:42 GMT (aligns with #94 push `2026-08-29T07:06:59Z`)

Method: live `git fetch` + `gh pr list/view` + source + production HTTP + bundled JS hostnames.  
**PR bodies and older docs are clues only.** `.agent/state.json` on disk can lag; `npm run agent:context` this session reported main `398960d` dirty because of a local lockfile that was discarded.

## Environment this session

| Check | Result |
|---|---|
| Node | v22.14.0 |
| npm | 10.9.7 |
| `gh auth` | logged in (`cursor` account) |
| Current branch at fetch | `main` @ `398960d` |
| Dirty tree at start | `package-lock.json` libc-field noise; restored, not committed |
| `supabase` CLI | **not installed** (`command not found`) |
| `npm test` | **script does not exist** in `package.json` |
| Cloud env in this workspace | no `.env`; only `.env.example` |
| Zeabur / production DB | **not touched**; no service-role; no live SQL |

## Live GitHub — open PRs (re-fetched, not assumed)

| PR | Title | Head | Base SHA | mergeable | CI |
|---|---|---|---|---|---|
| **#78** | PR-WB01 canonical whiteboard schema 0021–0026 | `agent/wb01-canonical-schema` @ `84d3f3e` | `361bec0` (stale vs current main) | **dirty** | CodeRabbit skip; Supabase Preview skip |
| **#88** | PR-DI-01～06 Design Intelligence | `agent/design-intelligence-perplexity` @ `32e3bca` | `b0f7a1b` (stale) | **dirty** | same |
| **#95** | feat(video) TUS / transcode / compare / archive / library | `cursor/complete-missing-features-0897` @ `4e5d8b3` | `398960d` (current main) | **clean** | agent-read-layer / browser / build / migrations **pass** |

**#78 and #88 are NOT merged.** Do not implement whiteboard schema or Design Intelligence on main. Do not copy those branches.

**#95 is also open** and owns `src/App.tsx`, `useCloudRoom.ts`, `RoomDiscussion.tsx`, discussion outbox, video upload, and `0023_video_optimize.sql`. Files-and-outbox / video-pipeline work must wait or stack.

## main HEAD capabilities (source evidence)

Merged most recently: **#94 PR-COMM-00** — discussion author integrity (`0022_discussion_author_integrity.sql`). Repo migration head on main is **0022**, not 0021 (older `.agent/*.json` snapshots are stale).

Honestly present on main:

- Image / video review workspaces, share preview, cloud rooms, invite-in-fragment
- Room discussion + outbox + attachments (0014 + 0018 + 0022)
- Whiteboard 0014 model (nodes/edges); **not** #78 canonical schema
- Voice LiveKit client + `voice-token` edge; copy mixed (see GAP_MATRIX)
- Canva / CUTOS / planform **contracts + honest unconfigured gates**
- Design Intelligence: **schema test only** on main (`test:design-intelligence`); full DI is #88
- TUS / transcode / version-compare: **SPEC_ONLY** on main (docs, no source). Executable work is #95, unmerged

## Production HTTP (this session)

```
GET https://duigao-k7q2.zeabur.app/                         200 text/html  1461 bytes
GET https://duigao-k7q2.zeabur.app/api/health               200 text/html  same index.html
GET https://duigao-k7q2.zeabur.app/functions/v1/voice-token 200 text/html  same index.html
GET https://duigao-k7q2.zeabur.app/functions/v1/canva-bridge 200 text/html same index.html
GET https://duigao-k7q2.zeabur.app/rest/v1/rooms            200 text/html  same index.html
GET https://duigao-k7q2.zeabur.app/login                    200 text/html  same index.html
GET https://duigao-k7q2.zeabur.app/room/test                200 text/html  same index.html
GET https://duigao-k7q2.zeabur.app/assets/index-BFpYk92m.js 200 application/javascript
```

This is the SPA catch-all. **HTTP 200 on those paths is not backend success.**  
`vercel.json` rewrites `/(.*)` → `/index.html`. Zeabur/Caddy serves the same.

Production bundle host (hostname only): `https://uanurolzzgshxrqbooix.supabase.co`.  
Bundle also contains LiveKit client code and both voice copy strings (`語音服務尚未設定` and the older `語音房間還在準備`). No service-role value was printed; `service_role` / `sb_secret_` matches are the **client-side rejection strings** in `src/cloud/config.ts`.

## Production first paint (Playwright)

Without a `#room=` hash, production is **not** the create-room Home first. It is the guest display-name onboard（「歡迎加入對稿空間」「你的顯示名稱」「開始」）. After a local name, Home shows 建立活動房 / 圖片文宣對稿 / 影片對稿. On 390 the first fold is dominated by hero + 建立活動房.

`/functions/v1/voice-token` on the **app origin** is HTTP 200 HTML that paints a **blank white** mobile screen — proof that catch-all 200 is not an API.

## First safe P0 batch (this PR)

Does **not** touch #78 / #88 / #95 owned cores (`App.tsx`, whiteboard schema, DI, discussion outbox, video TUS).

1. Shared `parseFunctionPayload` — reject SPA HTML and `{ ok: true }` without required keys
2. Wire into `voiceToken.ts` / `canva.ts` / `cutos.ts` (unowned by open PRs)
3. Honest voice boundary copy: `語音服務尚未設定`
4. Tests: positive + negative + mutation/negative-control + missing-key cloud-env

No new migration. No production DB change.
