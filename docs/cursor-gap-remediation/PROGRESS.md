# Gap remediation progress — #95 stack (after merge origin/main)

This file stays the #95-stack note. Do not treat #97’s historical `PROGRESS.md` as this branch’s product status.

Merged `origin/main` @ `444ae9d` (#97 + #99) with a merge commit. Conflicts were `package.json` (kept #95 scripts **and** `test:api-response`) and this file.

## Done on this stack

- Honest discussion insert (SPA HTML / failed API ≠ sent)
- Honest attachment upload (null data / wrong path / HTML ≠ complete)
- Same `message.id` retry does not create two server rows
- Outbox isolated per account
- Mobile composer hides room chrome while the input is focused
- Tests in `scripts/tests/discussion-files-batch.test.ts`
- Now contains main’s `apiResponse.ts` / remaining-gaps handoff (no App/TUS/0023 rewrite)

## Not done (still the durable goal)

- Merge #96 / #98 to main (human)
- Human rebase #78 / #88 migrations vs main `0022` and this stack’s `0023`
- Review #95 then #100–#102
- Production SPA catch-all still live (Zeabur) — #97 client parser is on main, not deployed
- No production deploy / no production DB from agents
