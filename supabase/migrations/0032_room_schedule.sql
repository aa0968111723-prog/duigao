-- 0032 — 專案日曆／時程（additive）
--
-- 日曆不是第二套 task 系統：沒有既有 task 表，deadline／活動／交稿／
-- 企劃階段／影片節點／白板期限都是 room_schedule_events 的 event_type。
-- 舊白板列、discussion、decision 不動。RLS 開著。
--
-- 節點 CHECK 擴充 calendar_event / task，舊列仍合法。

alter table public.whiteboard_nodes
  drop constraint if exists whiteboard_nodes_node_type_check;
alter table public.whiteboard_nodes
  add constraint whiteboard_nodes_node_type_check check (node_type in (
    'text', 'image', 'room_content', 'flow', 'mindmap', 'decision',
    'poll', 'link', 'group', 'ai_result', 'freehand',
    'calendar_event', 'task'
  ));

alter table public.whiteboard_nodes
  drop constraint if exists whiteboard_nodes_linked_entity_type_check;
alter table public.whiteboard_nodes
  add constraint whiteboard_nodes_linked_entity_type_check check (
    linked_entity_type is null or linked_entity_type in (
      'branch', 'version', 'plan', 'poll', 'decision', 'asset',
      'discussion', 'whiteboard', 'calendar'
    )
  );

create table if not exists public.room_schedule_events (
  id             uuid primary key default extensions.gen_random_uuid(),
  room_id        uuid not null references public.rooms (id) on delete cascade,
  created_by     uuid references auth.users (id) on delete set null,
  title          text not null check (length(btrim(title)) between 1 and 240),
  description    text not null default '',
  event_type     text not null default 'activity' check (event_type in (
    'deadline', 'activity', 'plan_stage', 'video_milestone',
    'copy_due', 'board_due', 'task', 'decision'
  )),
  start_at       timestamptz not null,
  end_at         timestamptz,
  timezone       text not null default 'Asia/Taipei',
  all_day        boolean not null default true,
  status         text not null default 'open' check (status in ('open', 'doing', 'done', 'cancelled')),
  assignee_id    uuid references auth.users (id) on delete set null,
  assignee_name  text not null default '',
  source_type    text check (source_type is null or source_type in (
    'discussion', 'whiteboard_node', 'task', 'decision', 'branch', 'version', 'manual', 'ai_proposal'
  )),
  source_id      uuid,
  color          text not null default '#c45c4a',
  version        integer not null default 1 check (version >= 1),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (id, room_id),
  constraint room_schedule_end_after_start check (end_at is null or end_at >= start_at)
);

comment on table public.room_schedule_events is
  '活動房時程視角。任務截止日期與活動時間共用一表，不另建 task 表。';

create index if not exists idx_room_schedule_room_start
  on public.room_schedule_events (room_id, start_at);
create index if not exists idx_room_schedule_source
  on public.room_schedule_events (room_id, source_type, source_id)
  where source_id is not null;

alter table public.room_schedule_events enable row level security;

drop policy if exists room_schedule_select on public.room_schedule_events;
create policy room_schedule_select on public.room_schedule_events
  for select to authenticated using (public.is_room_member(room_id));

drop policy if exists room_schedule_insert on public.room_schedule_events;
create policy room_schedule_insert on public.room_schedule_events
  for insert to authenticated
  with check (public.is_room_member(room_id) and (created_by = auth.uid() or public.can_manage_media(room_id)));

drop policy if exists room_schedule_update on public.room_schedule_events;
create policy room_schedule_update on public.room_schedule_events
  for update to authenticated
  using (public.is_room_member(room_id) and (created_by = auth.uid() or public.can_manage_media(room_id)))
  with check (public.is_room_member(room_id) and (created_by = auth.uid() or public.can_manage_media(room_id)));

drop policy if exists room_schedule_delete on public.room_schedule_events;
create policy room_schedule_delete on public.room_schedule_events
  for delete to authenticated
  using (public.is_room_member(room_id) and (created_by = auth.uid() or public.can_manage_media(room_id)));
