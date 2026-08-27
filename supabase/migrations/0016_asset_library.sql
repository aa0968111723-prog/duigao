-- ============================================================================
-- Collaborative Intelligence Workspace 1.0 / Phase 4
-- Shared + room asset library. Search is by understood content, not filename.
-- Canva / voice tables remain absent.
-- ============================================================================

create table if not exists public.library_assets (
  id                 uuid primary key default extensions.gen_random_uuid(),
  scope              text not null check (scope in ('shared', 'room')),
  room_id            uuid references public.rooms (id) on delete cascade,
  title              text not null check (length(btrim(title)) between 1 and 160),
  filename           text,
  summary            text not null default '',
  topics             text[] not null default '{}',
  kind               text not null default 'image'
    check (kind in ('image', 'poster', 'video', 'document', 'audio')),
  linked_asset_id    uuid,
  linked_version_id  uuid references public.versions (id) on delete set null,
  created_by         uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint library_assets_room_scope check (
    (scope = 'room' and room_id is not null) or (scope = 'shared' and room_id is null)
  )
);

create index if not exists idx_library_assets_room on public.library_assets (scope, room_id, created_at desc);
create index if not exists idx_library_assets_topics on public.library_assets using gin (topics);

create or replace function public.touch_library_assets()
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

drop trigger if exists library_assets_touch on public.library_assets;
create trigger library_assets_touch
  before update on public.library_assets
  for each row execute function public.touch_library_assets();

revoke execute on function public.touch_library_assets() from public, anon, authenticated;

alter table public.library_assets enable row level security;

drop policy if exists library_assets_select on public.library_assets;
create policy library_assets_select on public.library_assets
  for select to authenticated
  using (
    scope = 'shared'
    or (room_id is not null and public.is_room_member(room_id))
  );

drop policy if exists library_assets_insert on public.library_assets;
create policy library_assets_insert on public.library_assets
  for insert to authenticated
  with check (
    (scope = 'room' and room_id is not null and public.can_manage_media(room_id))
    or (
      scope = 'shared'
      and room_id is null
      and exists (
        select 1 from public.room_members m
        where m.user_id = auth.uid() and m.role in ('owner', 'editor')
      )
    )
  );

drop policy if exists library_assets_update on public.library_assets;
create policy library_assets_update on public.library_assets
  for update to authenticated
  using (
    (scope = 'room' and room_id is not null and public.can_manage_media(room_id))
    or (
      scope = 'shared'
      and exists (
        select 1 from public.room_members m
        where m.user_id = auth.uid() and m.role in ('owner', 'editor')
      )
    )
  )
  with check (
    (scope = 'room' and room_id is not null and public.can_manage_media(room_id))
    or (
      scope = 'shared'
      and room_id is null
      and exists (
        select 1 from public.room_members m
        where m.user_id = auth.uid() and m.role in ('owner', 'editor')
      )
    )
  );

drop policy if exists library_assets_delete on public.library_assets;
create policy library_assets_delete on public.library_assets
  for delete to authenticated
  using (
    (scope = 'room' and room_id is not null and public.can_manage_media(room_id))
    or (
      scope = 'shared'
      and exists (
        select 1 from public.room_members m
        where m.user_id = auth.uid() and m.role in ('owner', 'editor')
      )
    )
  );

revoke all on public.library_assets from anon;
grant select, insert, update, delete on public.library_assets to authenticated;

alter table public.library_assets replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.library_assets;
    exception when duplicate_object then
      null;
    end;
  end if;
end;
$$;
