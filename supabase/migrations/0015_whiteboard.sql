-- ============================================================================
-- Collaborative Intelligence Workspace 1.0 / Phase 2
-- Discussion whiteboard: one node+edge model (sticky, room refs, poll,
-- flow, mindmap). Original media is referenced, never copied.
-- Voice / Canva tables are intentionally absent.
-- ============================================================================

create table if not exists public.whiteboard_canvases (
  id          uuid primary key default extensions.gen_random_uuid(),
  room_id     uuid not null references public.rooms (id) on delete cascade,
  title       text not null default '白板',
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, room_id),
  unique (room_id)
);

create table if not exists public.whiteboard_nodes (
  id                   uuid primary key default extensions.gen_random_uuid(),
  room_id              uuid not null references public.rooms (id) on delete cascade,
  canvas_id            uuid not null,
  node_type            text not null check (node_type in (
    'sticky','text','image','poster','video','video_segment','plan','asset','poll','decision','flow','mindmap'
  )),
  x                    double precision not null default 24,
  y                    double precision not null default 24,
  text                 text not null default '',
  linked_asset_id      uuid,
  linked_branch_id     uuid,
  linked_version_id    uuid references public.versions (id) on delete set null,
  video_start_seconds  double precision,
  poll_id              uuid,
  payload              jsonb not null default '{}'::jsonb,
  created_by           uuid references auth.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint whiteboard_nodes_canvas_fk
    foreign key (canvas_id, room_id) references public.whiteboard_canvases (id, room_id) on delete cascade,
  constraint whiteboard_nodes_no_bytes check (
    not (payload ? 'imageDataUrl')
    and not (payload ? 'bytes')
    and not (payload ? 'videoUrl')
  )
);

create table if not exists public.whiteboard_edges (
  id           uuid primary key default extensions.gen_random_uuid(),
  room_id      uuid not null references public.rooms (id) on delete cascade,
  canvas_id    uuid not null,
  from_node_id uuid not null references public.whiteboard_nodes (id) on delete cascade,
  to_node_id   uuid not null references public.whiteboard_nodes (id) on delete cascade,
  edge_kind    text not null default 'flow' check (edge_kind in ('flow','mindmap','related')),
  created_at   timestamptz not null default now(),
  constraint whiteboard_edges_canvas_fk
    foreign key (canvas_id, room_id) references public.whiteboard_canvases (id, room_id) on delete cascade,
  constraint whiteboard_edges_not_self check (from_node_id <> to_node_id)
);

create index if not exists idx_whiteboard_nodes_room on public.whiteboard_nodes (room_id, canvas_id);
create index if not exists idx_whiteboard_edges_room on public.whiteboard_edges (room_id, canvas_id);

create or replace function public.touch_whiteboard()
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

drop trigger if exists whiteboard_canvases_touch on public.whiteboard_canvases;
create trigger whiteboard_canvases_touch
  before update on public.whiteboard_canvases
  for each row execute function public.touch_whiteboard();
drop trigger if exists whiteboard_nodes_touch on public.whiteboard_nodes;
create trigger whiteboard_nodes_touch
  before update on public.whiteboard_nodes
  for each row execute function public.touch_whiteboard();

revoke execute on function public.touch_whiteboard() from public, anon, authenticated;

alter table public.whiteboard_canvases enable row level security;
alter table public.whiteboard_nodes enable row level security;
alter table public.whiteboard_edges enable row level security;

drop policy if exists whiteboard_canvases_select on public.whiteboard_canvases;
create policy whiteboard_canvases_select on public.whiteboard_canvases
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists whiteboard_canvases_write on public.whiteboard_canvases;
create policy whiteboard_canvases_write on public.whiteboard_canvases
  for insert to authenticated with check (public.can_manage_media(room_id));
drop policy if exists whiteboard_canvases_update on public.whiteboard_canvases;
create policy whiteboard_canvases_update on public.whiteboard_canvases
  for update to authenticated using (public.can_manage_media(room_id)) with check (public.can_manage_media(room_id));

drop policy if exists whiteboard_nodes_select on public.whiteboard_nodes;
create policy whiteboard_nodes_select on public.whiteboard_nodes
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists whiteboard_nodes_write on public.whiteboard_nodes;
create policy whiteboard_nodes_write on public.whiteboard_nodes
  for insert to authenticated with check (public.can_manage_media(room_id));
drop policy if exists whiteboard_nodes_update on public.whiteboard_nodes;
create policy whiteboard_nodes_update on public.whiteboard_nodes
  for update to authenticated using (public.can_manage_media(room_id)) with check (public.can_manage_media(room_id));
drop policy if exists whiteboard_nodes_delete on public.whiteboard_nodes;
create policy whiteboard_nodes_delete on public.whiteboard_nodes
  for delete to authenticated using (public.can_manage_media(room_id));

drop policy if exists whiteboard_edges_select on public.whiteboard_edges;
create policy whiteboard_edges_select on public.whiteboard_edges
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists whiteboard_edges_write on public.whiteboard_edges;
create policy whiteboard_edges_write on public.whiteboard_edges
  for insert to authenticated with check (public.can_manage_media(room_id));
drop policy if exists whiteboard_edges_delete on public.whiteboard_edges;
create policy whiteboard_edges_delete on public.whiteboard_edges
  for delete to authenticated using (public.can_manage_media(room_id));

revoke all on public.whiteboard_canvases, public.whiteboard_nodes, public.whiteboard_edges from anon;
grant select, insert, update, delete on public.whiteboard_canvases, public.whiteboard_nodes, public.whiteboard_edges to authenticated;

alter table public.whiteboard_canvases replica identity full;
alter table public.whiteboard_nodes replica identity full;
alter table public.whiteboard_edges replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table
        public.whiteboard_canvases, public.whiteboard_nodes, public.whiteboard_edges;
    exception when duplicate_object then
      null;
    end;
  end if;
end;
$$;
