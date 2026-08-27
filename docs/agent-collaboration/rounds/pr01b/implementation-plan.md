All load-bearing claims from the two reader maps verified against the working tree (branch `feat/discussion-room-shell` @ 1ed3362 is fully merged into checked-out `main` @ 0075b9c via PR #48, so the tree content is identical; one path correction: the outbox hook lives at `src/hooks/useDiscussionOutbox.ts`, not under `src/features/room-discussion/`).

# PR-01b Implementation Plan — UniversalIntake + discussion attachments + library_assets residual

## 1. File-by-file, in dependency order

### Step 1 — `D:\duigao\supabase\migrations\0018_discussion_attachments.sql` (NEW; everything else depends on it)

Full draft:

```sql
-- ============================================================================
-- 0018 — Discussion attachments + library_assets insert residual (PR-01b)
--
-- (a) room_discussion_messages 增加 'attachment'（檔案：pdf/audio/doc，
--     payload.path 指向 room-assets）與 'link'（純 URL，無 storage 物件）。
--     insert RLS 已是 is_room_member（0014:645-646），不動。
-- (b) room-assets 新增一條「成員可寫、只限 attachments 前綴」的 INSERT policy。
--     permissive policies 是 OR：versions/videos/proposals 仍由 0007 的
--     room_assets_insert 鎖在 can_manage_media；update/delete 完全不加 —
--     0007:241-259 已把它們限制在 can_manage_media，上傳者（reviewer）
--     永遠不能改/刪自己的附件物件（originals-immutable）。
-- (c) 0016 的 library_assets_insert 殘洞（#47/0017 只修了 update/delete）：
--     shared-scope insert 綁 created_by = auth.uid()。
--
-- 附件前綴刻意不進 0009 孤兒盤點（0009:58 只掃 videos/versions）：
-- 附件由 room_discussion_messages.payload 參照，不在 versions 裡，
-- 掃進去反而會把成員上傳的檔案當孤兒清掉。與 proposals 同理（0009:56-57）。
-- ============================================================================

-- (a) kind check：inline constraint 的自動名稱是 room_discussion_messages_kind_check
alter table public.room_discussion_messages
  drop constraint if exists room_discussion_messages_kind_check;
alter table public.room_discussion_messages
  add constraint room_discussion_messages_kind_check check (kind in (
    'text', 'quote', 'image', 'room_asset', 'poster', 'video', 'plan',
    'poll', 'whiteboard', 'node', 'decision',
    'attachment',  -- 檔案卡：payload.path/mime/size/name
    'link'         -- 連結卡：payload.href，無 storage 物件
  ));

-- 便宜的資料衛生：attachment 一定要有 path+mime；link 一定要有 href。
alter table public.room_discussion_messages
  drop constraint if exists room_discussion_attachment_payload;
alter table public.room_discussion_messages
  add constraint room_discussion_attachment_payload check (
    (kind <> 'attachment' or (payload ? 'path' and payload ? 'mime'))
    and (kind <> 'link' or payload ? 'href')
  );

-- (b) 成員可寫的附件前綴：rooms/<room>/attachments/<messageId>/<assetId>.<ext>
drop policy if exists room_assets_attachments_insert on storage.objects;
create policy room_assets_attachments_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'room-assets'
    and public.is_room_member(((storage.foldername(name))[2])::uuid)
    and (storage.foldername(name))[1] = 'rooms'
    and (storage.foldername(name))[3] = 'attachments'
  );
-- 不加 update/delete policy：留 0007 的 can_manage_media（附件 add-only）。
-- SELECT 不用加：0001:375-377 已是 is_room_member。

-- (c) library_assets shared-insert 殘洞：綁 created_by（0017 的 stamp trigger
--     只補 NULL，policy 層才能擋「明寫別人 uuid」的冒名 insert）。
drop policy if exists library_assets_insert on public.library_assets;
create policy library_assets_insert on public.library_assets
  for insert to authenticated
  with check (
    (scope = 'room' and room_id is not null and public.can_manage_media(room_id))
    or (
      scope = 'shared'
      and room_id is null
      and (created_by is null or created_by = auth.uid())
      and exists (
        select 1 from public.room_members m
        where m.user_id = auth.uid() and m.role in ('owner', 'editor')
      )
    )
  );
```

Notes: `created_by is null or created_by = auth.uid()` is required because the 0017 stamp trigger (0017_author_acl.sql:11-28) runs BEFORE insert and fills NULL — the policy WITH CHECK evaluates the post-trigger row, so plain `created_by = auth.uid()` also works; keep the `is null` branch only if you want the policy readable independent of trigger ordering. The remaining "shared SELECT is world-readable to any authenticated user incl. anonymous JWTs" (0016_asset_library.sql:52-57) is a product decision — document as org-commons ADR, don't change in 0018 (see non-goals).

### Step 2 — `D:\duigao\src\features\collaboration\types.ts`
- Add `"attachment", "link"` to `DISCUSSION_KINDS` (types.ts:32-45). `isDiscussionKind` (types.ts:252-254) picks it up automatically.
- Extend `DiscussionPayload` (types.ts:122-136) with: `path?: string` (room-assets object key — never a signed URL), `mime?: string`, `size?: number`, `name?: string` (display filename), `href?: string` (link kind). Reuse existing `title`.
- No change to `discussionFromRow`/`insertDiscussion` (src/cloud/collaborationRepository.ts:148-149, 320-333) — payload passes through verbatim; old clients drop unknown kinds silently (returns null), so migration-first deploy is safe.

### Step 3 — `D:\duigao\src\cloud\assets.ts`
- Add `ATTACHMENT_EXT` map (pdf → `application/pdf`, audio: mp3/m4a/wav/ogg, doc: docx/pptx/xlsx/txt/csv/zip) and `attachmentExtForMime(mime, fallbackName)` that prefers the original filename's extension — do NOT touch `extForMime` (assets.ts:15-17, png-fallback is baked into versionPath/proposalAssetPath call sites).
- Add `attachmentPath(roomId, messageId, assetId, ext)` → `rooms/${roomId}/attachments/${messageId}/${assetId}.${ext}`. messageId ties object→row for future reconciliation; fresh assetId per upload attempt makes upsert:false retry-safe.
- Add `uploadAttachment(supabase, path, blob, mime)` — same as `uploadAsset` (assets.ts:39-43) but `upsert: false`. Do not change `uploadAsset` itself (PR-01c coordinates on this file; keep the diff surface disjoint).
- `signedUrl` (assets.ts:45-49, 1h TTL) is reused as-is for rendering.

### Step 4 — `D:\duigao\src\components\UniversalIntake.tsx` (NEW) + profile registry
See section 2 for the API. Implementation reuses UploadZone's body (src/components/UploadZone.tsx:24-55) for zone mode; UploadZone becomes a thin wrapper or is deleted after call sites migrate.

### Step 5 — `D:\duigao\src\App.tsx` — `sendAttachment` + wiring
- New `sendAttachment(files)` callback next to `sendDiscussion` (App.tsx:1138-1164): validate → `uploadAttachment` → `sendDiscussion({kind:"attachment", payload:{path,mime,size,name,title:name}})`. New `sendLink(url)` if a URL is pasted (kind "link", payload.href). Gate the whole affordance on `cloud.boundRoomId` (pre-bind, the outbox re-stamps roomId at dispatch — src/hooks/useDiscussionOutbox.ts:41-45 — but a storage path baked at upload time cannot be re-stamped, and the local room id would fail the storage folder RLS check anyway).
- Pass `onAttach` into both composer surfaces: MultiBranchRoom shell (App.tsx:2351-2352 area) and DiscussionDrawer (App.tsx ~2190-2198, where ghosts/sendStates/onRetry are already wired).
- Note `sendDiscussion` clears `chatInput` unconditionally (App.tsx:1161) — for attachment sends pass through without clearing, or accept the known minor issue explicitly in the PR.

### Step 6 — `D:\duigao\src\features\room-discussion\RoomDiscussion.tsx` + `discussion.css` + `DiscussionDrawer.tsx` + `MultiBranchRoom.tsx`
- `RoomDiscussionApi`: add optional `onAttach?: (files: File[]) => void` and `resolveAssetUrl?: (path: string) => Promise<string>` (RoomDiscussion stays presentation-only, no supabase import; App provides a memoized resolver over `signedUrl` with an in-memory cache keyed by path, TTL-aware).
- Attachment card in the message branch chain (after the poster/video/plan branch, RoomDiscussion.tsx:142-146): filename + human size + 開啟 button that signs on demand and opens in a new tab; `<audio controls>` for `audio/*` with lazily-signed src; broken-object fallback card when signing fails (visually distinct from `is-failed` send state, discussion.css:28-29). Link card: hostname + title text, `rel="noopener noreferrer"`, scheme whitelist http/https only (payload.href is member-supplied — refuse `javascript:`/`data:`).
- Composer (RoomDiscussion.tsx:171-190): attach button LEFT of the input (drawer reserves 68px on the right for the AI FAB, discussion.css:37); `onPaste` on the input reading `e.clipboardData.files` only — text paste untouched; button rendered only when `api.onAttach` present. Disable while an upload is in flight (attachment sends bypass the 300ms text claim debounce, App.tsx:1155-1158).
- Verify composer width at 375px: fixed bottom bar geometry discussion.css:18 (`.is-discussion-root .rd-composer`).
- DiscussionDrawer.tsx: forward `onAttach` through its api pass-through (~line 87-105); its local draft stays untouched.

### Step 7 — migrate intake sites to UniversalIntake (behavior-preserving)
Order: UploadZone sites 1-7 first (Home.tsx:44-60, App.tsx:2513-2520, VideoVersionSelector.tsx:38-40, DesktopWorkspace.tsx:59-62, MobileWorkspace.tsx:264-266/595-597) via zone mode; raw inputs (MultiBranchRoom.tsx:413 select-only mode, :569 zone/trigger; ProposalControls.tsx:252-259, ProposalDock.tsx:232-237, ProposalBackgroundControls.tsx:131-136, ShareSheet.tsx:283-291 trigger mode). Frozen-site rules in section 2. Camera trigger added at: Home poster entry, composer attach, MultiBranchRoom create/add.

### Step 8 — `D:\duigao\scripts\e2e\migrations.mjs` — new 0018 section (see section 4).

## 2. UniversalIntake component API

```ts
type IntakeProfile = {
  accept: string;                 // input accept attr
  multiple: boolean;
  maxBytes?: number;              // pre-upload size gate (200MB bucket cap: 0006:208-211)
  validate?: (file: File) => true | string;   // reason string → showToast at call site
};

// Registry reproduces today's semantics EXACTLY:
// poster:      accept "image/*", multiple, NO maxBytes (addImageFiles has none today, App.tsx:756 filter only)
// video:       VIDEO_ACCEPT, single; validity stays in acceptVideoFile (media.ts:100-118) — do not duplicate
// proposal:    "image/png,image/jpeg,image/webp,image/svg+xml", single; downstream prepareImageFile untouched
// share-cover: COVER_ACCEPT exact 3-MIME match (ShareSheet.tsx:88, 198-205)
// attachment:  pdf/audio/doc list + maxBytes (recommend 25MB client cap — RLS cannot enforce size; document the number)

type UniversalIntakeProps = {
  profile: keyof typeof INTAKE_PROFILES;
  mode: "zone" | "trigger" | "select-only";
  onFiles: (files: File[]) => void;      // select-only: caller holds them (MultiBranchRoom CreateSheet
                                          // must await createBranch FK before upload, App.tsx:1027-1033)
  camera?: boolean;                       // renders a SECOND hidden input with capture="environment";
                                          // never a blanket capture attr (kills gallery pick on iOS)
  className?: string; children?: ReactNode;   // zone mode
  triggerRef?: Ref<{ open(): void; openCamera(): void }>;  // trigger mode (proposal/cover/composer buttons)
};
```

- zone = UploadZone's current drop+click+Enter+hidden-input behavior verbatim (UploadZone.tsx:24-55), including input value reset.
- Paste is NOT a UniversalIntake concern — it lives on the composer input (files-only) and optionally a room-scoped document listener that ignores events targeting text inputs/contenteditable; treat as progressive enhancement (LINE in-app browser).
- `onFiles(FileList|null)` compatibility shim so sites 1-7 diff stays minimal.

## 3. Upload → send transactional order + outbox interaction

Strict order, enforced by construction:
1. Gate: `cloud.boundRoomId` set, else affordance disabled.
2. Validate size/mime BEFORE upload (the codebase's own doctrine: useCloudRoom.ts ~780 "stops a 100MB transfer that was always going to end in a 403").
3. `uploadAttachment(attachmentPath(boundRoomId, messageId, assetId, ext), blob)` with upsert:false — messageId minted here (crypto.randomUUID), passed into sendDiscussion so the row id and path agree.
4. Only after upload resolves: `sendDiscussion` builds the message and `discussionOutbox.send(message)` (App.tsx:1160).

Outbox consequences (all free, no outbox changes needed):
- Upload OK + insert fail → entry "failed", card shows 未送出·重試 (RoomDiscussion.tsx:147-151); retry re-dispatches the SAME message object (useDiscussionOutbox.ts:57-67) → insert-only, path already in payload → **retry never re-uploads by construction**. Duplicate-key counts as success (useCloudRoom.ts:944-958), so retry is idempotent.
- Upload fail → no row exists; File stays in composer state; re-upload mints a FRESH assetId (upsert:false-safe).
- Insert OK, snapshot lag → acked ghost until id appears in serverDiscussionIds (useDiscussionOutbox.ts:96-104; App.tsx:307-310) — the attachment card must render fully from ghost payload (it does: payload carries path/name/size).
- Insert permanently abandoned → stranded object; bounded garbage, invisible to 0009 by design (0009:58); messageId-scoped path enables a future sweeper. State this in the PR description.
- sendDiscussion requires `body || kind` (App.tsx:1141-1142) and falls back `body = payload.title` (App.tsx:1150) — set `title: name` so old-ish clients that know the kind but not the card still show the filename.
- Double-tap: attachment sends skip the 300ms text-only claim (App.tsx:1155-1158) — disable the attach button while the upload+send is in flight.

## 4. E2E / unit additions

`scripts/e2e/migrations.mjs`, new section after the 0017 block (pattern: capability section :688-826, 0017 section :1261-1311):
1. Apply 0018; owner inserts `kind='attachment'` with `{"path":"rooms/<capRoom>/attachments/<msg>/<id>.pdf","mime":"application/pdf","size":12345,"name":"brief.pdf"}` — succeeds; `kind='bogus'` fails; `kind='attachment'` WITHOUT path fails (payload constraint); `kind='link'` without href fails.
2. Reviewer inserts `kind='attachment'` and `kind='link'` — succeed (extends the existing reviewer-discussion probe at :1172-1176).
3. Storage, same run: reviewer CAN insert `rooms/<capRoom>/attachments/<msg>/<id>.pdf` into room-assets; reviewer still CANNOT insert versions/videos/proposals prefixes (existing :716-721 must stay green — proves the new permissive policy didn't OR-widen them); stranger (non-member) cannot insert another room's attachments prefix; reviewer cannot update/delete an attachment object (even one they inserted — no-mutate guardrail); editor still can (parity with :723); bucket still `public = f` (mirrors :404, :653-654).
4. Orphans: an attachments object older than the grace period does NOT appear in `orphaned_room_assets('0 seconds')` (0009:58 scoping holds).
5. library residual: user who is owner/editor only of a DIFFERENT room inserting `scope='shared'` with an explicit spoofed `created_by=<other uuid>` fails; with own/NULL created_by succeeds; re-verify 0017's editor-hijack probe stays green (:1272-1279).
6. Replay discipline: re-apply 0016 → 0017 → 0018 (extend the existing dance at :1262-1264 — a 0016 or 0017 replay after 0018 resurrects the old library_assets_insert, so the e2e replays in that order and re-probes item 5); re-run 0018 → policy/constraint counts unchanged (shape-count pattern like `aclShape()` at :1304-1310). 0014 replay is `create table if not exists` (0014:143) so it cannot resurrect the old kind CHECK, but assert attachment insert still works after a 0014 replay anyway.

Unit (vitest, wherever `discussionOutboxCore` tests live): profile registry snapshot per site (accept/multiple/maxBytes must equal today's values for frozen sites); link-card scheme whitelist rejects `javascript:`/`data:`; attachmentExtForMime fallback behavior.

Browser-level gate (ROADMAP.md:37 "composer 附 PDF → 訊息卡出現 PDF"): existing app E2E — attach PDF via composer → attachment card with filename appears; same via drawer; failed-send path shows 未送出·重試 and retry does not create a second storage request.

## 5. Explicit non-goals

- **No registerIntelligentAsset / intelligent_assets / library_assets integration for attachments** (0015_asset_intelligence.sql:530-531 requires can_manage_media; zero callers today).
- **No 0009 orphan-scan extension to attachments** — deliberate exemption like proposals (0009:56-58); scanning them would purge member uploads referenced only by discussion payloads.
- **No reviewer self-delete of attachment objects** — an owner-based storage delete policy would test green against the e2e shim's `owner` column but behave differently against production storage's `owner_id`; defer.
- **No change to library_assets shared SELECT** (0016:52-57, world-readable to authenticated incl. anonymous) — ship a documented org-commons ADR + the e2e probe instead; only the INSERT branch is fixed here.
- **No change to `uploadAsset`'s upsert:true / video x-upsert** for versions (assets.ts:40, videoAssets.ts) — storage overwrite hardening for versions coordinates with PR-01c (ROADMAP.md:115: 01c ∥ 01b, both touch assets.ts).
- **No image addVersion await/retry** — fire-and-forget (App.tsx:779-781) is PR-01c's scope; attachments deliberately ride the acked outbox instead.
- **Frozen behaviors preserved exactly**: ShareSheet cover (own bucket + COVER_ACCEPT, ShareSheet.tsx:88/198-205, sharePreview.ts), the three proposal pickers (data-URL overlay store only, prepareImageFile byte-for-byte), video `multiple=false` + canAdd sort_order race gate (VideoVersionSelector.tsx:18-20) + busy single-flight, Home's explicit two-entry poster-vs-video design (Home.tsx:18-24), CreateSheet deferred selection (upload only after createBranch FK, App.tsx:1027-1033).
- **No resumable/TUS upload, no link unfurl/oEmbed** (client-side unfurl leaks member viewing to third parties), **no inline PDF viewer**, no server-side mime/size enforcement (payload.size/mime are client claims — renderer must not trust them for anything security-relevant), no invite/bucket-visibility changes (invite stays fragment-only, room-assets stays private, signed-on-render only).

Key paths: `D:\duigao\supabase\migrations\0018_discussion_attachments.sql` (new), `D:\duigao\src\features\collaboration\types.ts`, `D:\duigao\src\cloud\assets.ts`, `D:\duigao\src\components\UniversalIntake.tsx` (new), `D:\duigao\src\App.tsx`, `D:\duigao\src\features\room-discussion\RoomDiscussion.tsx`, `D:\duigao\src\features\room-discussion\DiscussionDrawer.tsx`, `D:\duigao\src\features\room-discussion\discussion.css`, `D:\duigao\src\hooks\useDiscussionOutbox.ts` (unchanged, load-bearing), `D:\duigao\scripts\e2e\migrations.mjs`.