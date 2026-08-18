-- ============================================================================
-- 文宣討論區 — Cloud rooms (PR #12)
-- Persistent, multi-user rooms with invite-secured access, RLS, Storage and
-- Realtime. Anonymous auth only; the frontend uses the publishable (anon) key.
--
-- Security model (summary):
--   * Every data table has RLS enabled.
--   * A user may read/write a room's data ONLY if they have a row in
--     room_members for that room (checked via public.is_room_member).
--   * Rooms are created / joined exclusively through SECURITY DEFINER RPCs that
--     verify a hashed invite token; the raw token never touches the database.
--   * Storage objects under rooms/<room-id>/... are readable/writable only by
--     members of that room.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.rooms (
  id            uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  title         text not null default '未命名文宣',
  invite_hash   text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  archived_at   timestamptz
);

create table if not exists public.room_members (
  room_id      uuid not null references public.rooms (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  display_name text not null default '夥伴',
  color        text not null default '#c45c4a',
  role         text not null default 'editor' check (role in ('owner', 'editor')),
  joined_at    timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table if not exists public.versions (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references public.rooms (id) on delete cascade,
  label      text not null default '初稿',
  sort_order integer not null default 0,
  image_path text not null,
  mime_type  text,
  width      integer,
  height     integer,
  created_by uuid not null default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.comments (
  id            uuid primary key default gen_random_uuid(),
  room_id       uuid not null references public.rooms (id) on delete cascade,
  version_id    uuid not null references public.versions (id) on delete cascade,
  author_user_id uuid not null default auth.uid() references auth.users (id) on delete set null,
  author_name   text not null default '夥伴',
  author_color  text not null default '#c45c4a',
  x             double precision not null default 0.5,
  y             double precision not null default 0.5,
  body          text not null default '',
  suggestion    text not null default '',
  problem_type  text,
  priority      text,
  resolved      boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.strokes (
  id            uuid primary key default gen_random_uuid(),
  room_id       uuid not null references public.rooms (id) on delete cascade,
  version_id    uuid not null references public.versions (id) on delete cascade,
  author_user_id uuid not null default auth.uid() references auth.users (id) on delete set null,
  color         text not null default '#c45c4a',
  width         double precision not null default 4,
  points        jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now()
);

create table if not exists public.messages (
  id            uuid primary key default gen_random_uuid(),
  room_id       uuid not null references public.rooms (id) on delete cascade,
  author_user_id uuid not null default auth.uid() references auth.users (id) on delete set null,
  author_name   text not null default '夥伴',
  author_color  text not null default '#c45c4a',
  body          text not null default '',
  created_at    timestamptz not null default now()
);

create table if not exists public.visual_proposals (
  id             uuid primary key default gen_random_uuid(),
  room_id        uuid not null references public.rooms (id) on delete cascade,
  version_id     uuid not null references public.versions (id) on delete cascade,
  author_user_id uuid not null default auth.uid() references auth.users (id) on delete set null,
  author_name    text not null default '夥伴',
  name           text not null default '提案 A',
  payload        jsonb not null default '{}'::jsonb,
  revision       integer not null default 1,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes (child tables are almost always queried by room)
-- ---------------------------------------------------------------------------

create index if not exists idx_room_members_user on public.room_members (user_id);
create index if not exists idx_versions_room on public.versions (room_id);
create index if not exists idx_comments_room on public.comments (room_id);
create index if not exists idx_comments_version on public.comments (version_id);
create index if not exists idx_strokes_room on public.strokes (room_id);
create index if not exists idx_messages_room on public.messages (room_id);
create index if not exists idx_visual_proposals_room on public.visual_proposals (room_id);
create index if not exists idx_visual_proposals_version on public.visual_proposals (version_id);

-- ---------------------------------------------------------------------------
-- Membership helper. SECURITY DEFINER so policies can check membership without
-- recursing into room_members' own RLS. Fixed empty search_path; fully-qualified
-- names only.
-- ---------------------------------------------------------------------------

create or replace function public.is_room_member(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.room_members m
    where m.room_id = p_room_id and m.user_id = auth.uid()
  );
$$;

revoke all on function public.is_room_member(uuid) from public;
grant execute on function public.is_room_member(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.versions enable row level security;
alter table public.comments enable row level security;
alter table public.strokes enable row level security;
alter table public.messages enable row level security;
alter table public.visual_proposals enable row level security;

-- rooms: members can read; members can update (title/updated_at). No direct
-- INSERT/DELETE — creation happens only through create_room_with_invite.
create policy rooms_select on public.rooms
  for select to authenticated using (public.is_room_member(id));
create policy rooms_update on public.rooms
  for update to authenticated using (public.is_room_member(id)) with check (public.is_room_member(id));

-- room_members: members can see co-members; a user may update only their own
-- row (e.g. last_seen_at). Inserts happen only through the join/create RPCs.
create policy room_members_select on public.room_members
  for select to authenticated using (public.is_room_member(room_id));
create policy room_members_update_self on public.room_members
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Child tables: full CRUD for room members only.
create policy versions_all on public.versions
  for all to authenticated using (public.is_room_member(room_id)) with check (public.is_room_member(room_id));
create policy comments_all on public.comments
  for all to authenticated using (public.is_room_member(room_id)) with check (public.is_room_member(room_id));
create policy strokes_all on public.strokes
  for all to authenticated using (public.is_room_member(room_id)) with check (public.is_room_member(room_id));
create policy messages_all on public.messages
  for all to authenticated using (public.is_room_member(room_id)) with check (public.is_room_member(room_id));
create policy visual_proposals_all on public.visual_proposals
  for all to authenticated using (public.is_room_member(room_id)) with check (public.is_room_member(room_id));

-- ---------------------------------------------------------------------------
-- RPCs. All SECURITY DEFINER with fixed empty search_path. The raw invite token
-- is only ever hashed here; the DB stores/compares the sha256 hash.
-- ---------------------------------------------------------------------------

create or replace function public.create_room_with_invite(
  p_room_id uuid,
  p_title text,
  p_invite_token text,
  p_display_name text,
  p_color text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_hash text;
begin
  if v_uid is null then
    raise exception 'auth required';
  end if;
  if p_invite_token is null or length(p_invite_token) < 16 then
    raise exception 'invalid invite';
  end if;
  v_hash := encode(extensions.digest(p_invite_token, 'sha256'), 'hex');

  insert into public.rooms (id, owner_user_id, title, invite_hash)
  values (coalesce(p_room_id, extensions.gen_random_uuid()), v_uid, coalesce(nullif(p_title, ''), '未命名文宣'), v_hash)
  on conflict (id) do nothing;

  insert into public.room_members (room_id, user_id, display_name, color, role)
  values (p_room_id, v_uid, coalesce(nullif(p_display_name, ''), '夥伴'), coalesce(nullif(p_color, ''), '#c45c4a'), 'owner')
  on conflict (room_id, user_id) do update set display_name = excluded.display_name, color = excluded.color;

  return p_room_id;
end;
$$;

create or replace function public.join_room_by_invite(
  p_room_id uuid,
  p_invite_token text,
  p_display_name text,
  p_color text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_stored text;
  v_candidate text;
begin
  if v_uid is null then
    raise exception 'auth required';
  end if;

  select invite_hash into v_stored from public.rooms where id = p_room_id and archived_at is null;
  -- Do not disclose whether the room exists: same generic error on any failure.
  if v_stored is null then
    raise exception 'invalid invite';
  end if;
  v_candidate := encode(extensions.digest(coalesce(p_invite_token, ''), 'sha256'), 'hex');
  if v_candidate <> v_stored then
    raise exception 'invalid invite';
  end if;

  insert into public.room_members (room_id, user_id, display_name, color, role)
  values (p_room_id, v_uid, coalesce(nullif(p_display_name, ''), '夥伴'), coalesce(nullif(p_color, ''), '#c45c4a'), 'editor')
  on conflict (room_id, user_id) do update set display_name = excluded.display_name, color = excluded.color, last_seen_at = now();

  return p_room_id;
end;
$$;

create or replace function public.rotate_room_invite(p_room_id uuid, p_new_invite_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'auth required';
  end if;
  if p_new_invite_token is null or length(p_new_invite_token) < 16 then
    raise exception 'invalid invite';
  end if;
  update public.rooms
    set invite_hash = encode(extensions.digest(p_new_invite_token, 'sha256'), 'hex'), updated_at = now()
    where id = p_room_id and owner_user_id = v_uid;
  if not found then
    raise exception 'not room owner';
  end if;
end;
$$;

-- Optimistic-concurrency proposal upsert. Rejects a stale write instead of
-- silently overwriting a co-editor's newer revision.
create or replace function public.upsert_visual_proposal(
  p_id uuid,
  p_room_id uuid,
  p_version_id uuid,
  p_author_name text,
  p_name text,
  p_payload jsonb,
  p_expected_revision integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_current integer;
begin
  if v_uid is null or not public.is_room_member(p_room_id) then
    raise exception 'not a room member';
  end if;

  select revision into v_current from public.visual_proposals where id = p_id;

  if v_current is null then
    insert into public.visual_proposals (id, room_id, version_id, author_user_id, author_name, name, payload, revision)
    values (p_id, p_room_id, p_version_id, v_uid, coalesce(p_author_name, '夥伴'), coalesce(p_name, '提案'), coalesce(p_payload, '{}'::jsonb), 1);
    return 1;
  end if;

  if p_expected_revision is not null and v_current <> p_expected_revision then
    raise exception 'revision conflict (current=%)', v_current using errcode = 'P0001';
  end if;

  update public.visual_proposals
    set name = coalesce(p_name, name),
        payload = coalesce(p_payload, payload),
        version_id = p_version_id,
        revision = v_current + 1,
        updated_at = now()
    where id = p_id;
  return v_current + 1;
end;
$$;

revoke all on function public.create_room_with_invite(uuid, text, text, text, text) from public;
revoke all on function public.join_room_by_invite(uuid, text, text, text) from public;
revoke all on function public.rotate_room_invite(uuid, text) from public;
revoke all on function public.upsert_visual_proposal(uuid, uuid, uuid, text, text, jsonb, integer) from public;
grant execute on function public.create_room_with_invite(uuid, text, text, text, text) to authenticated;
grant execute on function public.join_room_by_invite(uuid, text, text, text) to authenticated;
grant execute on function public.rotate_room_invite(uuid, text) to authenticated;
grant execute on function public.upsert_visual_proposal(uuid, uuid, uuid, text, text, jsonb, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: publish row changes; REPLICA IDENTITY FULL so UPDATE/DELETE
-- payloads include the row. RLS still applies to realtime subscriptions.
-- ---------------------------------------------------------------------------

alter table public.rooms replica identity full;
alter table public.versions replica identity full;
alter table public.comments replica identity full;
alter table public.strokes replica identity full;
alter table public.messages replica identity full;
alter table public.visual_proposals replica identity full;
alter table public.room_members replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.rooms, public.versions, public.comments, public.strokes,
      public.messages, public.visual_proposals, public.room_members;
  end if;
exception when duplicate_object then
  null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Storage: private bucket + membership-scoped policies.
-- Object path convention: rooms/<room-id>/versions/...  or
-- rooms/<room-id>/proposals/...  => (storage.foldername(name))[2] is the room id.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('room-assets', 'room-assets', false)
on conflict (id) do nothing;

create policy room_assets_select on storage.objects
  for select to authenticated
  using (bucket_id = 'room-assets' and public.is_room_member(((storage.foldername(name))[2])::uuid));

create policy room_assets_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'room-assets' and public.is_room_member(((storage.foldername(name))[2])::uuid));

create policy room_assets_update on storage.objects
  for update to authenticated
  using (bucket_id = 'room-assets' and public.is_room_member(((storage.foldername(name))[2])::uuid))
  with check (bucket_id = 'room-assets' and public.is_room_member(((storage.foldername(name))[2])::uuid));

create policy room_assets_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'room-assets' and public.is_room_member(((storage.foldername(name))[2])::uuid));
