-- 0024 — whiteboard_versions：白板內容快照（WB01）。
--
-- 手動/里程碑快照（AI apply 前自動一張屬 WB06）；連續粒度由
-- whiteboard_operations 承擔。快照不可變（無 update policy＋無 grant）。
-- 不加入 realtime publication（快照無即時需求）。

create table if not exists public.whiteboard_versions (
  id uuid primary key default gen_random_uuid(),
  whiteboard_id uuid not null,
  room_id uuid not null references public.rooms(id) on delete cascade,
  label text not null default '' check (char_length(label) <= 120),
  snapshot jsonb not null check (
    jsonb_typeof(snapshot) = 'object'
    and jsonb_typeof(snapshot->'nodes') = 'array'
    and jsonb_typeof(snapshot->'edges') = 'array'
    and jsonb_array_length(snapshot->'nodes') <= 2000
  ),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  foreign key (whiteboard_id, room_id) references public.whiteboards(id, room_id) on delete cascade
);

create index if not exists idx_whiteboard_versions_board
  on public.whiteboard_versions (whiteboard_id, created_at desc);

alter table public.whiteboard_versions enable row level security;
drop policy if exists whiteboard_versions_select on public.whiteboard_versions;
create policy whiteboard_versions_select on public.whiteboard_versions
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists whiteboard_versions_insert on public.whiteboard_versions;
create policy whiteboard_versions_insert on public.whiteboard_versions
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and public.can_collaborate_on_board(room_id, whiteboard_id)
  );
drop policy if exists whiteboard_versions_delete on public.whiteboard_versions;
create policy whiteboard_versions_delete on public.whiteboard_versions
  for delete to authenticated
  using (public.can_manage_media(room_id));
-- 無 update policy — 快照不可變。

revoke all on public.whiteboard_versions from anon;
-- 快照不可變：update 顯式收回（同 0023 的預設 privilege 理由）。
revoke update on public.whiteboard_versions from authenticated;
grant select, insert, delete on public.whiteboard_versions to authenticated;
