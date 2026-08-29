# Gap remediation progress — PR-GAP-02 (this stacked branch only)

Stacked on #95. Do not treat #97’s `PROGRESS.md` as this file.

## Done here

- Honest discussion insert (SPA HTML / failed API ≠ sent)
- Honest attachment upload (null data / wrong path / HTML ≠ complete)
- Same `message.id` retry does not create two server rows
- Outbox isolated per account
- Mobile composer hides room chrome while the input is focused
- Tests in `scripts/tests/discussion-files-batch.test.ts`

## Not done (still the durable goal)

- Merge #97 → #96 → rebase #98 (voiceToken collision)
- Human rebase #78 / #88 migrations
- Review #95 then this stack
- No production deploy / no production DB from agents
