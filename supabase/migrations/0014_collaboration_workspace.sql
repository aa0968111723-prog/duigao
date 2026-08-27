-- ============================================================================
-- 協作討論工作台 1.0：房間討論 + 多白板 + 流程 / 心智圖 + 決策
--
-- Additive. Existing rooms, branches, comments, polls, Storage and review
-- tables stay the source of truth. A whiteboard stores nodes and edges, never
-- a screenshot. Room discussion is a room-layer feed, distinct from image /
-- video / plan comments. Polls stay in room_polls (0013) — this file only
-- references them. Original media is never copied onto a board.
--
-- AI boundary: get_whiteboard_context / get_selected_board_context return
-- structured board facts. node_type `ai_result` is reserved. This migration
-- does not generate embeddings, analyse assets, or call an AI provider.
--
-- Voice and follow-the-presenter are architecture reservations. Feature flags
-- and interfaces live in the client; these tables are the schema contract.
--
-- Re-runnable: every constraint/policy/trigger this file owns is dropped or
-- guarded before it is recreated.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Room-level board permission: view | collaborate
-- owner/editor default collaborate; reviewer default view.
-- Owner may enable 「允許大家一起編輯」.
-- ---------------------------------------------------------------------------

alter table public.rooms
  add column if not exists allow_board_edit boolean not null default false;

comment on column public.rooms.allow_board_edit is
  'true 時房間成員（含 reviewer）可在白板上新增／移動／編輯節點。預設 false：reviewer 只能看與討論。';

-- ---------------------------------------------------------------------------
-- Whiteboards (many per room)
-- ---------------------------------------------------------------------------

create table if not exists public.whiteboards (
  id            uuid primary key default extensions.gen_random_uuid(),
  room_id       uuid not null references public.rooms (id) on delete cascade,
  title         text not null check (length(btrim(title)) between 1 and 120),
  description   text not null default '',
  allow_edit    boolean not null default false,
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  archived_at   timestamptz,
  version       integer not null default 1 check (version >= 1),
  unique (id, room_id)
);

comment on table public.whiteboards is
  '活動房內的討論白板。一間房可以有多塊（招生總規劃、擺攤流程、影片腳本討論…）。';
comment on column public.whiteboards.allow_edit is
  '單板覆寫：true 時即使房間未開 allow_board_edit，成員也可編輯此板。';
comment on column public.whiteboards.version is
  '樂觀鎖。寫入時比對 version，避免兩人同時覆寫標題。';

create index if not exists idx_whiteboards_room_updated
  on public.whiteboards (room_id, archived_at, updated_at desc);

-- ---------------------------------------------------------------------------
-- Unified nodes — sticky / flow / mindmap / content / poll / decision
-- ---------------------------------------------------------------------------

create table if not exists public.whiteboard_nodes (
  id                  uuid primary key default extensions.gen_random_uuid(),
  whiteboard_id       uuid not null,
  room_id             uuid not null references public.rooms (id) on delete cascade,
  node_type           text not null check (node_type in (
    'text', 'image', 'room_content', 'flow', 'mindmap', 'decision',
    'poll', 'link', 'group', 'ai_result'
  )),
  x                   double precision not null default 0,
  y                   double precision not null default 0,
  width               double precision not null default 180 check (width > 0 and width <= 2000),
  height              double precision not null default 96 check (height > 0 and height <= 2000),
  content             jsonb not null default '{}'::jsonb,
  linked_entity_type  text check (linked_entity_type is null or linked_entity_type in (
    'branch', 'version', 'plan', 'poll', 'decision', 'asset', 'discussion', 'whiteboard'
  )),
  linked_entity_id    uuid,
  parent_group_id     uuid,
  created_by          uuid references auth.users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  version             integer not null default 1 check (version >= 1),
  unique (id, whiteboard_id),
  constraint whiteboard_nodes_board_room_fk
    foreign key (whiteboard_id, room_id) references public.whiteboards (id, room_id) on delete cascade,
  constraint whiteboard_nodes_content_object check (jsonb_typeof(content) = 'object')
);

comment on table public.whiteboard_nodes is
  '白板統一節點。便利貼／流程／心智圖共用一表，不用三套系統。ai_result 僅預留。';
comment on column public.whiteboard_nodes.linked_entity_id is
  '引用房間內容（文宣／影片／企劃／素材／投票）的 id，絕不複製原始檔。';
comment on column public.whiteboard_nodes.version is
  '樂觀鎖。拖曳結束才寫入；文字編輯比對 version，避免兩人覆寫同一便利貼。';

create index if not exists idx_whiteboard_nodes_board
  on public.whiteboard_nodes (whiteboard_id, updated_at desc);
create index if not exists idx_whiteboard_nodes_room
  on public.whiteboard_nodes (room_id, node_type);
create index if not exists idx_whiteboard_nodes_link
  on public.whiteboard_nodes (room_id, linked_entity_type, linked_entity_id)
  where linked_entity_id is not null;

-- ---------------------------------------------------------------------------
-- Edges
-- ---------------------------------------------------------------------------

create table if not exists public.whiteboard_edges (
  id               uuid primary key default extensions.gen_random_uuid(),
  whiteboard_id    uuid not null,
  room_id          uuid not null references public.rooms (id) on delete cascade,
  source_node_id   uuid not null,
  target_node_id   uuid not null,
  edge_type        text not null default 'default' check (edge_type in ('default', 'flow', 'mindmap', 'relation')),
  label            text not null default '',
  created_at       timestamptz not null default now(),
  unique (id, whiteboard_id),
  constraint whiteboard_edges_not_self check (source_node_id <> target_node_id),
  constraint whiteboard_edges_board_room_fk
    foreign key (whiteboard_id, room_id) references public.whiteboards (id, room_id) on delete cascade,
  constraint whiteboard_edges_source_fk
    foreign key (source_node_id, whiteboard_id) references public.whiteboard_nodes (id, whiteboard_id) on delete cascade,
  constraint whiteboard_edges_target_fk
    foreign key (target_node_id, whiteboard_id) references public.whiteboard_nodes (id, whiteboard_id) on delete cascade
);

comment on table public.whiteboard_edges is
  '節點關係。手機用「下一步／子節點」自動建立，不靠精準拉線。';

create index if not exists idx_whiteboard_edges_board
  on public.whiteboard_edges (whiteboard_id);
create index if not exists idx_whiteboard_edges_ends
  on public.whiteboard_edges (source_node_id, target_node_id);

-- ---------------------------------------------------------------------------
-- Room-layer discussion (not image / video / plan comments)
-- ---------------------------------------------------------------------------

create table if not exists public.room_discussion_messages (
  id               uuid primary key default extensions.gen_random_uuid(),
  room_id          uuid not null references public.rooms (id) on delete cascade,
  author_user_id   uuid references auth.users (id) on delete set null,
  author_name      text not null,
  author_color     text not null default '#c45c4a',
  kind             text not null default 'text' check (kind in (
    'text', 'quote', 'image', 'room_asset', 'poster', 'video', 'plan',
    'poll', 'whiteboard', 'node', 'decision'
  )),
  body             text not null default '',
  payload          jsonb not null default '{}'::jsonb,
  reply_to_id      uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (id, room_id),
  constraint room_discussion_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint room_discussion_reply_fk
    foreign key (reply_to_id, room_id) references public.room_discussion_messages (id, room_id) on delete set null
);

comment on table public.room_discussion_messages is
  '房間層討論。與 comments（文宣／影片錨點）及 plan 內文分開，避免混成無上下文訊息流。';

create index if not exists idx_room_discussion_room
  on public.room_discussion_messages (room_id, created_at desc);

create table if not exists public.room_discussion_supports (
  message_id  uuid not null,
  room_id     uuid not null references public.rooms (id) on delete cascade,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (message_id, user_id),
  constraint room_discussion_supports_fk
    foreign key (message_id, room_id) references public.room_discussion_messages (id, room_id) on delete cascade
);

create index if not exists idx_room_discussion_supports_room
  on public.room_discussion_supports (room_id, message_id);

-- ---------------------------------------------------------------------------
-- Decisions (convergence). Polls remain room_polls.
-- ---------------------------------------------------------------------------

create table if not exists public.decision_records (
  id             uuid primary key default extensions.gen_random_uuid(),
  room_id        uuid not null references public.rooms (id) on delete cascade,
  title          text not null check (length(btrim(title)) between 1 and 240),
  body           text not null default '',
  status         text not null default 'pending' check (status in ('pending', 'decided')),
  source_type    text check (source_type is null or source_type in ('poll', 'discussion', 'whiteboard', 'manual')),
  source_id      uuid,
  created_by     uuid references auth.users (id) on delete set null,
  finalized_by   uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  finalized_at   timestamptz,
  version        integer not null default 1 check (version >= 1),
  unique (id, room_id)
);

comment on table public.decision_records is
  '決策紀錄。例如「已決定：主視覺採 B 版／來源：投票」。投票本身仍用 0013 room_polls。';

create index if not exists idx_decision_records_room
  on public.decision_records (room_id, status, updated_at desc);

-- ---------------------------------------------------------------------------
-- Voice Room — schema + interface only. Client ships behind a feature flag.
-- ---------------------------------------------------------------------------

create table if not exists public.voice_sessions (
  id           uuid primary key default extensions.gen_random_uuid(),
  room_id      uuid not null references public.rooms (id) on delete cascade,
  title        text not null default '語音房間',
  status       text not null default 'scheduled' check (status in ('scheduled', 'live', 'ended')),
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  ended_at     timestamptz,
  unique (id, room_id)
);

create table if not exists public.voice_session_participants (
  session_id    uuid not null,
  room_id       uuid not null references public.rooms (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  display_name  text not null default '',
  muted         boolean not null default false,
  joined_at     timestamptz not null default now(),
  left_at       timestamptz,
  primary key (session_id, user_id),
  constraint voice_participants_session_fk
    foreign key (session_id, room_id) references public.voice_sessions (id, room_id) on delete cascade
);

comment on table public.voice_sessions is
  '語音房間架構預留。1.0 不宣稱 WebRTC MVP 完成；client feature flag 關閉時不曝光。';

-- ---------------------------------------------------------------------------
-- Follow-the-presenter reservation
-- ---------------------------------------------------------------------------

create table if not exists public.presentation_state (
  room_id              uuid primary key references public.rooms (id) on delete cascade,
  active_entity_type   text check (active_entity_type is null or active_entity_type in (
    'branch', 'version', 'whiteboard', 'node', 'discussion', 'video'
  )),
  active_entity_id     uuid,
  video_time           double precision,
  whiteboard_id        uuid,
  whiteboard_x         double precision,
  whiteboard_y         double precision,
  whiteboard_zoom      double precision,
  presenter_user_id    uuid references auth.users (id) on delete set null,
  updated_at           timestamptz not null default now()
);

comment on table public.presentation_state is
  '跟隨主講者狀態預留。未完成產品流程前 client 不得宣稱已實作。';

-- ---------------------------------------------------------------------------
-- Audit — board created / archived, decision finalized. Never drag pixels.
-- ---------------------------------------------------------------------------

create table if not exists public.collaboration_audit_events (
  id             uuid primary key default extensions.gen_random_uuid(),
  room_id        uuid not null references public.rooms (id) on delete cascade,
  event_type     text not null check (event_type in (
    'whiteboard_created', 'whiteboard_archived', 'decision_finalized'
  )),
  actor_user_id  uuid references auth.users (id) on delete set null,
  payload        jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

create index if not exists idx_collaboration_audit_room
  on public.collaboration_audit_events (room_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Capability helpers
-- ---------------------------------------------------------------------------

create or replace function public.can_collaborate_on_board(p_room_id uuid, p_whiteboard_id uuid default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.can_manage_media(p_room_id)
    or (
      public.is_room_member(p_room_id)
      and (
        exists (
          select 1 from public.rooms r
          where r.id = p_room_id and r.allow_board_edit
        )
        or (
          p_whiteboard_id is not null
          and exists (
            select 1 from public.whiteboards w
            where w.id = p_whiteboard_id
              and w.room_id = p_room_id
              and w.allow_edit
              and w.archived_at is null
          )
        )
      )
    );
$$;

revoke all on function public.can_collaborate_on_board(uuid, uuid) from public;
grant execute on function public.can_collaborate_on_board(uuid, uuid) to authenticated;

comment on function public.can_collaborate_on_board(uuid, uuid) is
  'owner/editor 預設可編輯白板；reviewer 預設只能看。房間 allow_board_edit 或單板 allow_edit 才開放協作。';

-- AI boundary: structured board facts, no generation, no embeddings.
create or replace function public.get_whiteboard_context(p_whiteboard_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    when w.id is null then null
    else jsonb_build_object(
      'whiteboard', jsonb_build_object(
        'id', w.id,
        'roomId', w.room_id,
        'title', w.title,
        'description', w.description,
        'archivedAt', w.archived_at,
        'updatedAt', w.updated_at
      ),
      'nodes', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', n.id,
          'nodeType', n.node_type,
          'x', n.x,
          'y', n.y,
          'width', n.width,
          'height', n.height,
          'content', n.content,
          'linkedEntityType', n.linked_entity_type,
          'linkedEntityId', n.linked_entity_id
        ) order by n.created_at)
        from public.whiteboard_nodes n
        where n.whiteboard_id = w.id
      ), '[]'::jsonb),
      'edges', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', e.id,
          'sourceNodeId', e.source_node_id,
          'targetNodeId', e.target_node_id,
          'edgeType', e.edge_type,
          'label', e.label
        ) order by e.created_at)
        from public.whiteboard_edges e
        where e.whiteboard_id = w.id
      ), '[]'::jsonb),
      'linkedEntities', coalesce((
        select jsonb_agg(jsonb_build_object(
          'nodeId', n.id,
          'entityType', n.linked_entity_type,
          'entityId', n.linked_entity_id
        ) order by n.created_at)
        from public.whiteboard_nodes n
        where n.whiteboard_id = w.id
          and n.linked_entity_id is not null
      ), '[]'::jsonb)
    )
  end
  from public.whiteboards w
  where w.id = p_whiteboard_id
    and public.is_room_member(w.room_id);
$$;

revoke all on function public.get_whiteboard_context(uuid) from public;
grant execute on function public.get_whiteboard_context(uuid) to authenticated;

create or replace function public.get_selected_board_context(p_whiteboard_id uuid, p_node_ids uuid[])
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    when w.id is null then null
    else jsonb_build_object(
      'whiteboardId', w.id,
      'roomId', w.room_id,
      'nodes', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', n.id,
          'nodeType', n.node_type,
          'content', n.content,
          'linkedEntityType', n.linked_entity_type,
          'linkedEntityId', n.linked_entity_id
        ) order by n.created_at)
        from public.whiteboard_nodes n
        where n.whiteboard_id = w.id
          and n.id = any(p_node_ids)
      ), '[]'::jsonb)
    )
  end
  from public.whiteboards w
  where w.id = p_whiteboard_id
    and public.is_room_member(w.room_id);
$$;

revoke all on function public.get_selected_board_context(uuid, uuid[]) from public;
grant execute on function public.get_selected_board_context(uuid, uuid[]) to authenticated;

-- Optimistic concurrency: bump version; reject stale writes.
create or replace function public.touch_collaboration_row()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if tg_table_name in ('whiteboards', 'whiteboard_nodes', 'decision_records') then
      if new.version is distinct from old.version and new.version < old.version then
        raise exception 'stale-write'
          using hint = '這則內容剛被別人改過，請重新載入。';
      end if;
      new.version := old.version + 1;
    end if;
    if tg_table_name = 'whiteboards' and new.archived_at is not null and old.archived_at is null then
      new.archived_at := coalesce(new.archived_at, now());
    end if;
    if tg_table_name = 'decision_records' and new.status = 'decided' and old.status is distinct from 'decided' then
      new.finalized_at := coalesce(new.finalized_at, now());
      new.finalized_by := coalesce(new.finalized_by, auth.uid());
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists whiteboards_touch on public.whiteboards;
create trigger whiteboards_touch
  before update on public.whiteboards
  for each row execute function public.touch_collaboration_row();
drop trigger if exists whiteboard_nodes_touch on public.whiteboard_nodes;
create trigger whiteboard_nodes_touch
  before update on public.whiteboard_nodes
  for each row execute function public.touch_collaboration_row();
drop trigger if exists room_discussion_touch on public.room_discussion_messages;
create trigger room_discussion_touch
  before update on public.room_discussion_messages
  for each row execute function public.touch_collaboration_row();
drop trigger if exists decision_records_touch on public.decision_records;
create trigger decision_records_touch
  before update on public.decision_records
  for each row execute function public.touch_collaboration_row();

create or replace function public.prevent_whiteboard_hard_delete()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'whiteboards are archived instead of deleted';
end;
$$;

drop trigger if exists whiteboards_no_delete on public.whiteboards;
create trigger whiteboards_no_delete
  before delete on public.whiteboards
  for each row execute function public.prevent_whiteboard_hard_delete();

create or replace function public.write_collaboration_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'whiteboards' and tg_op = 'INSERT' then
    insert into public.collaboration_audit_events (room_id, event_type, actor_user_id, payload)
    values (new.room_id, 'whiteboard_created', auth.uid(), jsonb_build_object('whiteboardId', new.id, 'title', new.title));
  elsif tg_table_name = 'whiteboards' and tg_op = 'UPDATE'
        and new.archived_at is not null and old.archived_at is null then
    insert into public.collaboration_audit_events (room_id, event_type, actor_user_id, payload)
    values (new.room_id, 'whiteboard_archived', auth.uid(), jsonb_build_object('whiteboardId', new.id, 'title', new.title));
  elsif tg_table_name = 'decision_records' and tg_op = 'UPDATE'
        and new.status = 'decided' and old.status is distinct from 'decided' then
    insert into public.collaboration_audit_events (room_id, event_type, actor_user_id, payload)
    values (new.room_id, 'decision_finalized', auth.uid(), jsonb_build_object('decisionId', new.id, 'title', new.title));
  end if;
  return new;
end;
$$;

drop trigger if exists whiteboards_audit_insert on public.whiteboards;
create trigger whiteboards_audit_insert
  after insert on public.whiteboards
  for each row execute function public.write_collaboration_audit();
drop trigger if exists whiteboards_audit_archive on public.whiteboards;
create trigger whiteboards_audit_archive
  after update of archived_at on public.whiteboards
  for each row execute function public.write_collaboration_audit();
drop trigger if exists decision_records_audit on public.decision_records;
create trigger decision_records_audit
  after update of status on public.decision_records
  for each row execute function public.write_collaboration_audit();

revoke execute on function public.touch_collaboration_row() from public, anon, authenticated;
revoke execute on function public.prevent_whiteboard_hard_delete() from public, anon, authenticated;
revoke execute on function public.write_collaboration_audit() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.whiteboards enable row level security;
alter table public.whiteboard_nodes enable row level security;
alter table public.whiteboard_edges enable row level security;
alter table public.room_discussion_messages enable row level security;
alter table public.room_discussion_supports enable row level security;
alter table public.decision_records enable row level security;
alter table public.voice_sessions enable row level security;
alter table public.voice_session_participants enable row level security;
alter table public.presentation_state enable row level security;
alter table public.collaboration_audit_events enable row level security;

drop policy if exists whiteboards_select on public.whiteboards;
create policy whiteboards_select on public.whiteboards
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists whiteboards_insert on public.whiteboards;
create policy whiteboards_insert on public.whiteboards
  for insert to authenticated with check (public.can_manage_media(room_id));
drop policy if exists whiteboards_update on public.whiteboards;
create policy whiteboards_update on public.whiteboards
  for update to authenticated
  using (public.can_manage_media(room_id))
  with check (public.can_manage_media(room_id));

drop policy if exists whiteboard_nodes_select on public.whiteboard_nodes;
create policy whiteboard_nodes_select on public.whiteboard_nodes
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists whiteboard_nodes_insert on public.whiteboard_nodes;
create policy whiteboard_nodes_insert on public.whiteboard_nodes
  for insert to authenticated
  with check (public.can_collaborate_on_board(room_id, whiteboard_id));
drop policy if exists whiteboard_nodes_update on public.whiteboard_nodes;
create policy whiteboard_nodes_update on public.whiteboard_nodes
  for update to authenticated
  using (public.can_collaborate_on_board(room_id, whiteboard_id))
  with check (public.can_collaborate_on_board(room_id, whiteboard_id));
drop policy if exists whiteboard_nodes_delete on public.whiteboard_nodes;
create policy whiteboard_nodes_delete on public.whiteboard_nodes
  for delete to authenticated
  using (public.can_collaborate_on_board(room_id, whiteboard_id));

drop policy if exists whiteboard_edges_select on public.whiteboard_edges;
create policy whiteboard_edges_select on public.whiteboard_edges
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists whiteboard_edges_insert on public.whiteboard_edges;
create policy whiteboard_edges_insert on public.whiteboard_edges
  for insert to authenticated
  with check (public.can_collaborate_on_board(room_id, whiteboard_id));
drop policy if exists whiteboard_edges_update on public.whiteboard_edges;
create policy whiteboard_edges_update on public.whiteboard_edges
  for update to authenticated
  using (public.can_collaborate_on_board(room_id, whiteboard_id))
  with check (public.can_collaborate_on_board(room_id, whiteboard_id));
drop policy if exists whiteboard_edges_delete on public.whiteboard_edges;
create policy whiteboard_edges_delete on public.whiteboard_edges
  for delete to authenticated
  using (public.can_collaborate_on_board(room_id, whiteboard_id));

drop policy if exists room_discussion_select on public.room_discussion_messages;
create policy room_discussion_select on public.room_discussion_messages
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists room_discussion_insert on public.room_discussion_messages;
create policy room_discussion_insert on public.room_discussion_messages
  for insert to authenticated with check (public.is_room_member(room_id));
drop policy if exists room_discussion_update on public.room_discussion_messages;
create policy room_discussion_update on public.room_discussion_messages
  for update to authenticated
  using (public.is_room_member(room_id) and (author_user_id = auth.uid() or public.can_manage_media(room_id)))
  with check (public.is_room_member(room_id) and (author_user_id = auth.uid() or public.can_manage_media(room_id)));
drop policy if exists room_discussion_delete on public.room_discussion_messages;
create policy room_discussion_delete on public.room_discussion_messages
  for delete to authenticated
  using (public.is_room_member(room_id) and (author_user_id = auth.uid() or public.can_manage_media(room_id)));

drop policy if exists room_discussion_supports_select on public.room_discussion_supports;
create policy room_discussion_supports_select on public.room_discussion_supports
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists room_discussion_supports_insert on public.room_discussion_supports;
create policy room_discussion_supports_insert on public.room_discussion_supports
  for insert to authenticated
  with check (public.is_room_member(room_id) and user_id = auth.uid());
drop policy if exists room_discussion_supports_delete on public.room_discussion_supports;
create policy room_discussion_supports_delete on public.room_discussion_supports
  for delete to authenticated
  using (public.is_room_member(room_id) and user_id = auth.uid());

drop policy if exists decision_records_select on public.decision_records;
create policy decision_records_select on public.decision_records
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists decision_records_insert on public.decision_records;
create policy decision_records_insert on public.decision_records
  for insert to authenticated with check (public.can_manage_media(room_id));
drop policy if exists decision_records_update on public.decision_records;
create policy decision_records_update on public.decision_records
  for update to authenticated
  using (public.can_manage_media(room_id))
  with check (public.can_manage_media(room_id));
drop policy if exists decision_records_delete on public.decision_records;
create policy decision_records_delete on public.decision_records
  for delete to authenticated using (public.can_manage_media(room_id));

drop policy if exists voice_sessions_select on public.voice_sessions;
create policy voice_sessions_select on public.voice_sessions
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists voice_sessions_insert on public.voice_sessions;
create policy voice_sessions_insert on public.voice_sessions
  for insert to authenticated with check (public.can_manage_media(room_id));
drop policy if exists voice_sessions_update on public.voice_sessions;
create policy voice_sessions_update on public.voice_sessions
  for update to authenticated
  using (public.can_manage_media(room_id))
  with check (public.can_manage_media(room_id));

drop policy if exists voice_participants_select on public.voice_session_participants;
create policy voice_participants_select on public.voice_session_participants
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists voice_participants_insert on public.voice_session_participants;
create policy voice_participants_insert on public.voice_session_participants
  for insert to authenticated
  with check (public.is_room_member(room_id) and user_id = auth.uid());
drop policy if exists voice_participants_update on public.voice_session_participants;
create policy voice_participants_update on public.voice_session_participants
  for update to authenticated
  using (public.is_room_member(room_id) and user_id = auth.uid())
  with check (public.is_room_member(room_id) and user_id = auth.uid());

drop policy if exists presentation_state_select on public.presentation_state;
create policy presentation_state_select on public.presentation_state
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists presentation_state_upsert on public.presentation_state;
create policy presentation_state_insert on public.presentation_state
  for insert to authenticated with check (public.can_manage_media(room_id));
drop policy if exists presentation_state_update on public.presentation_state;
create policy presentation_state_update on public.presentation_state
  for update to authenticated
  using (public.can_manage_media(room_id))
  with check (public.can_manage_media(room_id));

drop policy if exists collaboration_audit_select on public.collaboration_audit_events;
create policy collaboration_audit_select on public.collaboration_audit_events
  for select to authenticated using (public.is_room_member(room_id));

-- Owner may flip the room-level board-edit flag. Reviewer cannot.
drop policy if exists rooms_update_allow_board_edit on public.rooms;
-- rooms already has an update policy from earlier migrations; keep that.
-- allow_board_edit is just another column on rooms and rides the existing
-- owner/editor room update path.

revoke all on public.whiteboards, public.whiteboard_nodes, public.whiteboard_edges,
  public.room_discussion_messages, public.room_discussion_supports,
  public.decision_records, public.voice_sessions, public.voice_session_participants,
  public.presentation_state, public.collaboration_audit_events from anon;

revoke delete on public.whiteboards from authenticated;
grant select, insert, update on public.whiteboards to authenticated;
grant select, insert, update, delete on public.whiteboard_nodes to authenticated;
grant select, insert, update, delete on public.whiteboard_edges to authenticated;
grant select, insert, update, delete on public.room_discussion_messages to authenticated;
grant select, insert, delete on public.room_discussion_supports to authenticated;
grant select, insert, update, delete on public.decision_records to authenticated;
grant select, insert, update on public.voice_sessions to authenticated;
grant select, insert, update on public.voice_session_participants to authenticated;
grant select, insert, update on public.presentation_state to authenticated;
grant select on public.collaboration_audit_events to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: board / discussion / decision. Positions persist on drag end;
-- clients throttle broadcasts. Presence rides the existing room channel.
-- ---------------------------------------------------------------------------

alter table public.whiteboards replica identity full;
alter table public.whiteboard_nodes replica identity full;
alter table public.whiteboard_edges replica identity full;
alter table public.room_discussion_messages replica identity full;
alter table public.room_discussion_supports replica identity full;
alter table public.decision_records replica identity full;
alter table public.voice_sessions replica identity full;
alter table public.voice_session_participants replica identity full;
alter table public.presentation_state replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table
        public.whiteboards, public.whiteboard_nodes, public.whiteboard_edges,
        public.room_discussion_messages, public.room_discussion_supports,
        public.decision_records, public.voice_sessions,
        public.voice_session_participants, public.presentation_state;
    exception when duplicate_object then
      null;
    end;
  end if;
end;
$$;
