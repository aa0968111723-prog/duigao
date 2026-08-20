-- ============================================================================
-- 文宣討論區 — 影片對稿 (PR #23)
--
-- Images are reviewed in SPACE (a point, or a circled region). Videos are
-- reviewed in TIME (a moment, or a stretch). This migration adds the second
-- axis without forking the room model: same rooms, same invite + membership,
-- same RLS, same Storage bucket, same Realtime publication, same discussion
-- tables. Only the coordinates differ.
--
-- Three deliberate choices, and why:
--
--   1. `versions` is EXTENDED, not duplicated. A video draft shares six of its
--      nine fields with a poster draft (label, sort_order, mime_type, width,
--      height, and a still image), and two existing foreign keys already point
--      at public.versions: comments.version_id, and the composite
--      (version_id, room_id) on share_previews. A separate video_versions table
--      would force both of those to fork — which is exactly the kind of change
--      that breaks working image rooms.
--
--   2. For a video version, `image_path` holds the captured POSTER FRAME. A
--      poster is genuinely an image, so share cards, Open Graph thumbnails and
--      anything else that asks a version for "its picture" keep working with no
--      code change at all. `video_path` holds the video itself.
--
--   3. `get_share_preview` is NOT touched. A video room's card needs a title, a
--      description and a thumbnail — all of which already exist. The anonymous
--      read surface stays byte-for-byte what PR #21 shipped.
--
-- Backward compatibility is the whole point: every column added here has a
-- default or is nullable, old rows keep their meaning (media_kind 'image',
-- anchor_type derived from region), and an older client that knows nothing
-- about video keeps inserting valid rows.
--
-- Idempotent: re-applying this file is a no-op (scripts/e2e/migrations.mjs
-- re-applies migrations on purpose).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Rooms: what kind of thing is being reviewed.
-- ---------------------------------------------------------------------------

alter table public.rooms
  add column if not exists media_type text not null default 'image';

alter table public.rooms
  drop constraint if exists rooms_media_type_check;
alter table public.rooms
  add constraint rooms_media_type_check check (media_type in ('image', 'video'));

comment on column public.rooms.media_type is
  'image | video. Rooms created before PR #23 default to image, which is what they are.';

-- ---------------------------------------------------------------------------
-- Versions: a draft is either a poster or a cut.
-- ---------------------------------------------------------------------------

alter table public.versions
  add column if not exists media_kind text not null default 'image';
alter table public.versions
  add column if not exists video_path text;
alter table public.versions
  add column if not exists duration_seconds double precision;
alter table public.versions
  add column if not exists file_size bigint;

-- A video version can exist before (or without) a usable poster: capturing a
-- frame is a browser canvas operation that legitimately fails on some codecs
-- and cross-origin setups. Dropping NOT NULL keeps that a degraded card rather
-- than a failed upload. Widening a column is safe for existing rows, for RLS,
-- for REPLICA IDENTITY FULL and for PostgREST's schema cache.
alter table public.versions
  alter column image_path drop not null;

alter table public.versions
  drop constraint if exists versions_media_kind_check;
alter table public.versions
  add constraint versions_media_kind_check check (media_kind in ('image', 'video'));

-- The real integrity rule: whatever kind a version claims to be, the asset that
-- makes it that kind has to be there.
alter table public.versions
  drop constraint if exists versions_media_shape;
alter table public.versions
  add constraint versions_media_shape check (
    (media_kind = 'image' and image_path is not null)
    or (media_kind = 'video' and video_path is not null)
  );

alter table public.versions
  drop constraint if exists versions_duration_sane;
alter table public.versions
  add constraint versions_duration_sane check (
    duration_seconds is null or (duration_seconds > 0 and duration_seconds < 86400)
  );

comment on column public.versions.image_path is
  'The still image for this version: the poster artwork for an image version, the captured poster frame for a video one. Nullable only because a poster frame capture may fail.';
comment on column public.versions.video_path is
  'Object path of the video itself in the private room-assets bucket: rooms/<room-id>/videos/<version-id>/original.<ext>. Never public, never in a Realtime payload.';
comment on column public.versions.duration_seconds is
  'Video length in seconds. Null when the browser could not read the metadata; the UI degrades to a duration-less timeline rather than refusing the upload.';

-- ---------------------------------------------------------------------------
-- Comments: the second coordinate system.
--
-- An image comment points at x/y (optionally a region). A video comment points
-- at a moment, or at a stretch. Both live in the same table so that supports,
-- replies, resolve, Realtime and the whole discussion UI stay one thing.
-- ---------------------------------------------------------------------------

alter table public.comments
  add column if not exists anchor_type text not null default 'image-point';
alter table public.comments
  add column if not exists time_seconds double precision;
alter table public.comments
  add column if not exists end_time_seconds double precision;

-- Existing rows already say which they are — a region comment is an
-- 'image-region', everything else is an 'image-point'. This is derived from
-- data that is already there, so nothing is lost and nothing is guessed.
-- Restricted to image anchors so re-applying can never rewrite a video row.
update public.comments
   set anchor_type = 'image-region'
 where region is not null
   and anchor_type = 'image-point';

alter table public.comments
  drop constraint if exists comments_anchor_type_check;
alter table public.comments
  add constraint comments_anchor_type_check check (
    anchor_type in ('image-point', 'image-region', 'video-point', 'video-range')
  );

-- Time columns belong to time anchors, and a range has to actually be a range.
-- Written as "video anchors require time / image anchors must not have it"
-- rather than enumerating every anchor kind, so a future anchor type (say a
-- video-region for on-screen positions) only needs the list above extended.
alter table public.comments
  drop constraint if exists comments_anchor_time_shape;
alter table public.comments
  add constraint comments_anchor_time_shape check (
    case
      when anchor_type like 'video-%' then
        time_seconds is not null
        and time_seconds >= 0
        and (
          (anchor_type = 'video-range' and end_time_seconds is not null and end_time_seconds > time_seconds)
          or (anchor_type <> 'video-range' and end_time_seconds is null)
        )
      else time_seconds is null and end_time_seconds is null
    end
  );

comment on column public.comments.anchor_type is
  'Which coordinate system this feedback uses: image-point / image-region (x,y[,region]) or video-point / video-range (time_seconds[,end_time_seconds]).';
comment on column public.comments.time_seconds is
  'Seconds into the version''s video. Numeric on purpose: the timeline seeks, sorts and measures with it.';

-- A client that predates this migration keeps inserting region comments without
-- an anchor_type, and the column default would file them as plain points. The
-- CHECK deliberately does NOT forbid that combination — rejecting writes from a
-- still-deployed client would look like sync failure to the person using it —
-- so a trigger states the derivation instead, and the data stays self-consistent
-- through the mixed-version window.
create or replace function public.derive_comment_anchor()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.region is not null and new.anchor_type = 'image-point' then
    new.anchor_type := 'image-region';
  end if;
  return new;
end;
$$;

drop trigger if exists comments_derive_anchor on public.comments;
create trigger comments_derive_anchor
  before insert or update on public.comments
  for each row execute function public.derive_comment_anchor();

-- Video discussion is read in time order far more often than in insert order.
create index if not exists idx_comments_version_time
  on public.comments (version_id, time_seconds)
  where time_seconds is not null;

-- ---------------------------------------------------------------------------
-- Storage.
--
-- No new bucket and no new policy: videos live under
--   rooms/<room-id>/videos/<version-id>/original.<ext>
-- so (storage.foldername(name))[2] is still the room id, and the four existing
-- room_assets policies already gate them by membership. A non-member cannot
-- read, write or delete a video, and the bucket stays private.
--
-- The only change is an explicit size ceiling, so an accidental multi-gigabyte
-- upload fails fast at the edge instead of after a long wait. The effective
-- limit is min(project limit, this value) — on a project whose global limit is
-- lower, that global limit still wins, which is why the client validates
-- against the same number and says so in plain language.
--
-- allowed_mime_types stays NULL deliberately: pinning a list here would reject
-- any image type the app already accepts but the list forgot.
-- ---------------------------------------------------------------------------

update storage.buckets
   set file_size_limit = 200 * 1024 * 1024
 where id = 'room-assets'
   and (file_size_limit is null or file_size_limit <> 200 * 1024 * 1024);

-- ---------------------------------------------------------------------------
-- Realtime: nothing to add. rooms, versions and comments are already published
-- with REPLICA IDENTITY FULL (0001), so media_type, video_path and the anchor
-- columns ride along in the payloads that already flow. Video BYTES never do:
-- only the Storage path travels, and reading it still requires membership.
-- ---------------------------------------------------------------------------
