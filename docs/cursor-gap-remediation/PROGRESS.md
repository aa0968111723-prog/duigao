# Gap remediation progress — PR-GAP-05 (this stacked branch)

Stacked on GAP-04 (`cursor/p1-mobile-tablet-ux-70d9` @ `4f966a3`) → GAP-02 → #95.

## Done here (GAP-05)

- Discussion realtime is row-patch + SPA/invalid payload reject
- Duplicate / older events do not apply twice
- Online outbox flush is account-scoped
- Attachment messages stay on the same discussion stream
- Tests: `scripts/tests/realtime-offline.test.ts` + two-client e2e

## Still the durable goal (do not mark complete)

- Merge #97 → #96 → rebase #98
- Human rebase #78 / #88 migrations
- Review stacked PRs; parent opens this one (base = GAP-04)
- No production deploy / no production DB
