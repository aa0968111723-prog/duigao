-- 0022 — whiteboard_frames（WB01）。
--
-- frame 是空間容器（zone/swimlane/kanban 欄/投票區…），與 group（選取
-- 聚合）語意不同、分表。DB 不變式：frame z_index < 0、node z_index >= 0
-- （0021）→ frame 永遠墊底不是慣例是約束（Grok wb00 F5）。
-- paint/hit 全序 = (z_index, created_at, id) 三鍵（ADR-014），client 的
-- render 與 hit-test 共用同一排序 util（WB02 落地）。

create table if not exists public.whiteboard_frames (
  id uuid primary key default gen_random_uuid(),
  whiteboard_id uuid not null,
  room_id uuid not null references public.rooms(id) on delete cascade,
  title text not null default '' check (char_length(title) <= 120),
  x double precision not null default 0,
  y double precision not null default 0,
  width double precision not null default 480 check (width > 0 and width <= 8000),
  height double precision not null default 320 check (height > 0 and height <= 8000),
  kind text not null default 'frame'
    check (kind in ('frame','zone','swimlane','kanban-column','vote-area',
                    'status-needs-review','status-needs-changes','status-approved','parking-lot')),
  style jsonb not null default '{}'::jsonb check (jsonb_typeof(style) = 'object'),
  z_index integer not null default -1 check (z_index < 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version >= 1),
  unique (id, whiteboard_id),
  foreign key (whiteboard_id, room_id) references public.whiteboards(id, room_id) on delete cascade
);

create index if not exists idx_whiteboard_frames_board
  on public.whiteboard_frames (whiteboard_id, z_index, created_at);

-- OCC：與 nodes/edges 同語意
create or replace function public.touch_whiteboard_frame()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.version is distinct from old.version and new.version < old.version then
    raise exception 'stale-write' using hint = '這個區塊剛被別人改過，請重新載入。';
  end if;
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists whiteboard_frames_touch on public.whiteboard_frames;
create trigger whiteboard_frames_touch
  before update on public.whiteboard_frames
  for each row execute function public.touch_whiteboard_frame();

-- 節點的 frame 歸屬（空間容器；不參與 paint order — 那由 z_index 決定）
alter table public.whiteboard_nodes
  add column if not exists frame_id uuid;
do $$
begin
  alter table public.whiteboard_nodes
    add constraint whiteboard_nodes_frame_fk
    foreign key (frame_id) references public.whiteboard_frames(id) on delete set null;
exception when duplicate_object then null;
end $$;
create index if not exists idx_whiteboard_nodes_frame
  on public.whiteboard_nodes (frame_id) where frame_id is not null;

-- RLS：四條齊（與 nodes 同模式）
alter table public.whiteboard_frames enable row level security;
drop policy if exists whiteboard_frames_select on public.whiteboard_frames;
create policy whiteboard_frames_select on public.whiteboard_frames
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists whiteboard_frames_insert on public.whiteboard_frames;
create policy whiteboard_frames_insert on public.whiteboard_frames
  for insert to authenticated
  with check (public.can_collaborate_on_board(room_id, whiteboard_id));
drop policy if exists whiteboard_frames_update on public.whiteboard_frames;
create policy whiteboard_frames_update on public.whiteboard_frames
  for update to authenticated
  using (public.can_collaborate_on_board(room_id, whiteboard_id))
  with check (public.can_collaborate_on_board(room_id, whiteboard_id));
drop policy if exists whiteboard_frames_delete on public.whiteboard_frames;
create policy whiteboard_frames_delete on public.whiteboard_frames
  for delete to authenticated
  using (public.can_collaborate_on_board(room_id, whiteboard_id));

revoke all on public.whiteboard_frames from anon;
grant select, insert, update, delete on public.whiteboard_frames to authenticated;

-- realtime：加入 publication（回滾 = alter publication ... drop table）
alter table public.whiteboard_frames replica identity full;
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.whiteboard_frames;
    exception when duplicate_object then
      null;
    end;
  end if;
end $$;
