# PR-GAP-02 Files / discussion / outbox — stacked on #95

Branch: `cursor/p0-files-and-outbox-70d9`  
**Base (must not be main):** `cursor/complete-missing-features-0897` (#95) @ `4e5d8b32e1e189e426b2728987d4312135f5ad1f`

Does **not** copy #95 onto main. Does **not** start whiteboard (#78) or Design Intelligence (#88). Does **not** create a second chat system.

## Live GitHub at start

| PR | State |
|---|---|
| #95 | OPEN, MERGEABLE, `cursor/complete-missing-features-0897` @ `4e5d8b3` |
| #96 #97 #98 #99 | OPEN drafts on main |
| #78 #88 | OPEN, CONFLICTING / dirty |

## What was actually broken on #95 (verified in source)

1. **`uploadAttachment` treated “no error” as complete.** Mock/SPA can return HTML or `{ Key }` without a matching object path. Failed/incomplete upload could still proceed to `sendDiscussion`.
2. **`insertDiscussion` treated any non-throw as sent.** SPA HTML in `data` or `error.message` was not rejected. Duplicate-key retry was already success via `isDuplicateKey` — kept, but HTML mentioning `23505` must not count.
3. **Outbox IndexedDB was device-global.** `loadOutboxEntries` / `saveOutboxEntries` had no account key. Switching accounts on one device could show or retry another person’s sending/failed rows.
4. **No local preview / honest progress** on discussion attach. Composer did not say 上傳失敗 when the object never landed.
5. **Mobile discussion root** kept search + 總覽/內容/企劃 chips + AI + FAB visible while the keyboard was up.

## What this branch fixed

- `src/cloud/discussionWrite.ts` — `acceptDiscussionInsert`, `acceptStorageUpload`, `applyIdempotentInsert`, `honestUploadPercent`
- Wired into `collaborationRepository.insertDiscussion` and `assets.uploadAttachment`
- Outbox `ownerId` on persist + `isolateOutboxForOwner`; hook reloads on account change and does not wipe another owner’s rows
- Composer: preview + progress + `data-testid=attach-upload` `data-phase=failed|uploading`. Missing supabase →「雲端服務尚未設定」and text discussion still works
- Mobile: hide search / chips / AI / FAB only while `composerActive` (input focused). e2e that never focuses the input stays green

## Still broken / not this PR

- RoomDiscussion leave-button chrome during voice `reconnecting` (#98 V-04; #95 dock contract)
- TUS / transcode / compare product itself is #95’s — not reimplemented here
- Whiteboard schema (#78), DI schema (#88)
- Production SPA catch-all still HTTP 200 HTML at app origin (#97 client parser; this stack only guards discussion insert/upload)
- Physical device / LINE
- No new migrations (collision with #78/#88/#95)

## Tests

`npm run test:files-batch`  
`npm run test:collaboration` (includes the new file)

## Parent: open PR with this base

```
base: cursor/complete-missing-features-0897
head: cursor/p0-files-and-outbox-70d9
```

Not `main`. If create is 403, use:

https://github.com/aa0968111723-prog/duigao/compare/cursor/complete-missing-features-0897...cursor/p0-files-and-outbox-70d9?expand=1
