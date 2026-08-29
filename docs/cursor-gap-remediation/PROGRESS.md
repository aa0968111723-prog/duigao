# PROGRESS

## 2026-08-29 — PR-GAP-00 shipped (not merged)

Branch: `cursor/gap-remediation-audit-70d9`  
Head after gate-fix: see git log on the branch.  
Base: `main` @ `398960d`.

### Done

- Live GitHub re-fetch: **#78, #88, #95 still open**. #78/#88 dirty; #95 clean + CI green.
- Production curl: SPA catch-all 200 HTML on `/functions/v1/*`, `/rest/v1/*`, `/api/*`.
- Playwright: guest name screen on 360/390/412/768/820; Home after local display name; blank page on `/functions/v1/voice-token`.
- `src/cloud/apiResponse.ts` + wire voice/canva/cutos (unowned by those PRs).
- Voice boundary copy → `語音服務尚未設定`.
- Tests 17/17 new; full discovered script matrix green (see TEST_BASELINE).
- `npm run build` without keys **fails** (honest).
- `npm run agent:gate` **PASS**.
- Migrations 257/257 on throwaway PG 16. **No production DB writes.**
- Docs in `docs/cursor-gap-remediation/`.

### Not done (do not shrink the goal)

- GAP-01 session/room/error on `App.tsx` / `useCloudRoom` / `MultiBranchRoom` — **file-owned by #78/#95**
- GAP-02 discussion/files — **#95**
- GAP-03 full voice state machine
- GAP-04 mobile first-layer shell rewrite
- GAP-05 realtime/offline — **#78+#95**
- GAP-06 whiteboard — **pause #78**
- GAP-07 AI/Canva backend — **pause #88**
- Physical devices, dual-client live, Zeabur deploy
- Migration number collision — **human rebase**

### Agent Review (self, this turn)

No separate bugbot process in this subagent turn. Self security-review of the diff:

| Finding | Class |
|---|---|
| Test fixture used `sb_secret_*` lookalike and tripped `SECRETS_NOT_EMITTED` | **accepted** — changed to `service_role` substring, no `sb_secret_` |
| Parser fail-closed to UNREACHABLE on HTML | accepted as intended |
| Docs mention public Supabase hostname from the JS bundle | **rejected-with-evidence** — not a secret; already in shipped JS |
| Touching RoomDiscussion / App / whiteboard | not done |

### Next exact branch

`cursor/p0-mobile-room-entry-70d9` **from latest `origin/main`** for Home/onboard empty-error work **only if** it stays off #78/#95 files.

If that still collides: `cursor/p0-voice-truthful-state-70d9` (`useVoiceRoom.ts` unowned).

**Do not start files/outbox or whiteboard or DI.**
