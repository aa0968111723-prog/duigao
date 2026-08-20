-- ============================================================================
-- 文宣討論區 — Share previews / Open Graph 卡片 (PR #21)
--
-- Social crawlers (LINE, Facebook, Messenger, X) do not run SPA JavaScript and
-- never receive a URL fragment. The permanent share link keeps its secret in
-- the fragment (`#room=<uuid>&invite=<token>`, PR #12/#16), so the only way to
-- get a rich card is a server-rendered landing page that knows NOTHING about
-- the room it links to.
--
-- This migration adds exactly that: a tiny, deliberately anaemic public
-- projection of "what a share card may say".
--
--   share_previews  — id (a fresh random UUID, NOT the room id), the room it
--                     belongs to, a title/description, and an optional
--                     low-resolution derived thumbnail path.
--   get_share_preview(uuid)
--                   — the ONLY anon-reachable read. Returns title,
--                     description and image path. It deliberately does NOT
--                     return room_id, version_id or created_by, so a preview
--                     id can never be walked back to a room, and never acts
--                     as an authentication shortcut.
--   share-previews  — a separate PUBLIC storage bucket for derived thumbnails
--                     only. `room-assets` (the real, full-resolution posters)
--                     stays private and membership-gated, unchanged.
--
-- Invariants this file exists to hold:
--   * No raw invite token, room JSON, comment, message or proposal content is
--     ever stored here.
--   * Only room members may create/update/disable a preview (reusing
--     room_members + is_room_member; there is no second membership model).
--   * Because the thumbnail bucket is public, revoking a preview means
--     DELETING the object as well as flipping `enabled` — the client does
--     both. A public bucket is not covered by storage RLS on read, so the
--     random 122-bit preview id is what protects an *active* thumbnail, and
--     deletion is what protects a *revoked* one. That deletion is only
--     possible because members also get a SELECT policy: PostgreSQL applies
--     SELECT policies when a DELETE inspects columns, so a bucket with only
--     INSERT/UPDATE/DELETE policies would delete nothing at all, silently.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

-- A preview names a room AND a version; the pair has to be consistent, or a
-- member of one room could file a preview against another room's version. A
-- composite foreign key states that directly instead of trusting the client.
create unique index if not exists idx_versions_id_room on public.versions (id, room_id);

create table if not exists public.share_previews (
  id             uuid primary key default gen_random_uuid(),
  room_id        uuid not null references public.rooms (id) on delete cascade,
  version_id     uuid not null,
  title          text not null default '文宣討論區',
  description    text not null default '',
  -- Path inside the `share-previews` bucket, e.g. `<preview id>/cover.webp`.
  thumbnail_path text,
  show_thumbnail boolean not null default true,
  enabled        boolean not null default true,
  created_by     uuid not null default auth.uid() references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint share_previews_version_in_room
    foreign key (version_id, room_id) references public.versions (id, room_id) on delete cascade
);

comment on table public.share_previews is
  'Public Open Graph card metadata for a room share link. Never holds the invite token or any room content.';
comment on column public.share_previews.id is
  'previewId — an independent random UUID. Must never be derived from, or resolvable to, room_id.';
comment on column public.share_previews.thumbnail_path is
  'Object path in the public share-previews bucket. A LOW-RESOLUTION derivative only; the original poster stays in the private room-assets bucket.';

-- One live preview per room keeps re-sharing idempotent instead of piling up
-- orphan cards; revoked previews stay as rows so old links keep resolving to
-- the generic card rather than 404-ing.
create unique index if not exists idx_share_previews_room_enabled
  on public.share_previews (room_id) where enabled;

create index if not exists idx_share_previews_room on public.share_previews (room_id);

-- Cache-busting for social platforms is derived from updated_at, so it must
-- move on every write rather than relying on the client to remember.
create or replace function public.touch_share_preview()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists share_previews_touch on public.share_previews;
create trigger share_previews_touch
  before update on public.share_previews
  for each row execute function public.touch_share_preview();

-- ---------------------------------------------------------------------------
-- RLS — same membership model as every other child table.
-- ---------------------------------------------------------------------------

alter table public.share_previews enable row level security;

-- No policy for `anon`: anonymous readers reach previews only through
-- get_share_preview(), which returns a strict subset of columns.
drop policy if exists share_previews_all on public.share_previews;
create policy share_previews_all on public.share_previews
  for all to authenticated
  using (public.is_room_member(room_id))
  with check (public.is_room_member(room_id));

-- ---------------------------------------------------------------------------
-- The one public read. SECURITY DEFINER with a fixed empty search_path, and a
-- hand-picked column list — adding room_id here would turn a share card into a
-- room oracle, so it is intentionally absent.
--
-- Unknown id, disabled preview and "thumbnail turned off" are all expressed as
-- data, not errors: the caller renders the generic 文宣討論區 card.
-- ---------------------------------------------------------------------------

create or replace function public.get_share_preview(p_preview_id uuid)
returns table (
  title       text,
  description text,
  image_path  text,
  updated_at  timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    sp.title,
    sp.description,
    case when sp.show_thumbnail then sp.thumbnail_path else null end as image_path,
    sp.updated_at
  from public.share_previews sp
  where sp.id = p_preview_id
    and sp.enabled
    and exists (select 1 from public.rooms r where r.id = sp.room_id and r.archived_at is null);
$$;

revoke all on function public.get_share_preview(uuid) from public;
grant execute on function public.get_share_preview(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Storage: a SEPARATE public bucket for derived thumbnails.
--
-- `room-assets` is untouched and stays private — nothing here widens access to
-- a full-resolution poster. Object path convention:
--     <preview id>/cover.<ext>   =>  (storage.foldername(name))[1] is the id
-- so write access can be checked against the preview's room membership.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'share-previews',
  'share-previews',
  true,
  2 * 1024 * 1024,
  array['image/webp', 'image/jpeg', 'image/png']
)
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Crawlers read through the public bucket route, which bypasses RLS by design.
-- The SELECT policy below is not for them: it is what lets a MEMBER replace or
-- delete their own thumbnail, because PostgreSQL evaluates SELECT policies for
-- any UPDATE/DELETE that inspects columns. Without it, revocation would be a
-- no-op — the flag would flip while the image stayed publicly fetchable.
--
-- It stays membership-scoped, so `anon` still cannot list or read through the
-- authenticated endpoints, and the bucket cannot be enumerated.
drop policy if exists share_previews_select on storage.objects;
create policy share_previews_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'share-previews'
    and exists (
      select 1 from public.share_previews sp
      where sp.id = ((storage.foldername(name))[1])::uuid
        and public.is_room_member(sp.room_id)
    )
  );
drop policy if exists share_previews_insert on storage.objects;
create policy share_previews_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'share-previews'
    and exists (
      select 1 from public.share_previews sp
      where sp.id = ((storage.foldername(name))[1])::uuid
        and public.is_room_member(sp.room_id)
    )
  );

drop policy if exists share_previews_update on storage.objects;
create policy share_previews_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'share-previews'
    and exists (
      select 1 from public.share_previews sp
      where sp.id = ((storage.foldername(name))[1])::uuid
        and public.is_room_member(sp.room_id)
    )
  )
  with check (
    bucket_id = 'share-previews'
    and exists (
      select 1 from public.share_previews sp
      where sp.id = ((storage.foldername(name))[1])::uuid
        and public.is_room_member(sp.room_id)
    )
  );

drop policy if exists share_previews_delete on storage.objects;
create policy share_previews_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'share-previews'
    and exists (
      select 1 from public.share_previews sp
      where sp.id = ((storage.foldername(name))[1])::uuid
        and public.is_room_member(sp.room_id)
    )
  );
