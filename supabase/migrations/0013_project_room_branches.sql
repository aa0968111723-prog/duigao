-- ============================================================================
-- 同房多分支 1.0：文宣 / 影片 / 企劃整合房
--
-- This migration is additive. `rooms`, `versions`, `comments`, memberships,
-- Storage and the existing image/video review tables stay the source of truth.
-- A branch is a light-weight grouping layer; it is not a second room model.
-- Existing versions receive one compatible default branch, while branch_id is
-- intentionally nullable so an older deployed client can continue inserting a
-- version during the mixed-version rollout. The trigger fills it in.
--
-- Re-runnable: every constraint/policy/trigger that this file owns is dropped
-- or guarded before it is recreated. No invite secret or original media is
-- copied into the new tables.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Room mode and branches
-- ---------------------------------------------------------------------------

alter table public.rooms
  add column if not exists room_mode text not null default 'single';

alter table public.rooms
  drop constraint if exists rooms_room_mode_check;
alter table public.rooms
  add constraint rooms_room_mode_check check (room_mode in ('single', 'project'));

comment on column public.rooms.room_mode is
  'single 保留舊版單一媒體 workspace；project 啟用同房多分支手機房間 shell。';

create table if not exists public.room_branches (
  id          uuid primary key default extensions.gen_random_uuid(),
  room_id     uuid not null references public.rooms (id) on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 120),
  branch_type text not null default 'poster'
    check (branch_type in ('poster', 'video', 'plan', 'copy')),
  sort_order  integer not null default 0 check (sort_order >= 0),
  status      text not null default 'in_progress'
    check (status in ('in_progress', 'pending', 'completed', 'archived')),
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz,
  unique (id, room_id)
);

comment on table public.room_branches is
  '同一活動房內的文宣、影片、企劃或文案分支；branch 不是另一間 room。';
comment on column public.room_branches.branch_type is
  'poster=文宣 / video=影片 / plan=企劃 / copy=文案。技術型別不直接暴露在主要 UI。';

create index if not exists idx_room_branches_room_sort
  on public.room_branches (room_id, sort_order, updated_at desc);
create index if not exists idx_room_branches_room_updated
  on public.room_branches (room_id, updated_at desc);

-- Existing rooms become readable as one branch without asking anyone to move
-- files. The current media_type is authoritative for old image/video rooms.
insert into public.room_branches (room_id, name, branch_type, sort_order, status, created_by)
select
  r.id,
  case when r.media_type = 'video' then coalesce(nullif(r.title, ''), '影片')
       else coalesce(nullif(r.title, ''), '文宣') end,
  case when r.media_type = 'video' then 'video' else 'poster' end,
  0,
  'in_progress',
  r.owner_user_id
from public.rooms r
where not exists (
  select 1 from public.room_branches b where b.room_id = r.id
);

alter table public.versions
  add column if not exists branch_id uuid;

alter table public.versions
  drop constraint if exists versions_branch_room_fk;
alter table public.versions
  add constraint versions_branch_room_fk
  foreign key (branch_id, room_id)
  references public.room_branches (id, room_id)
  on delete restrict;

-- Attach all old versions to the compatible default branch. If a project has
-- already gained multiple branches, use the first branch of the same family;
-- this avoids accidentally putting a video cut into a poster branch.
update public.versions v
set branch_id = b.id
from public.room_branches b
where v.branch_id is null
  and b.room_id = v.room_id
  and b.id = (
    select b2.id
    from public.room_branches b2
    where b2.room_id = v.room_id
      and b2.branch_type = case when v.media_kind = 'video' then 'video' else 'poster' end
    order by b2.sort_order, b2.created_at
    limit 1
  );

comment on column public.versions.branch_id is
  '版本所屬分支。可為 null 只為相容尚未升級的舊 client；0013 trigger 會補相容預設分支。';

-- Overview cards need counts and the latest label, not every media row. Keep
-- that projection server-side so the first mobile request never signs or
-- transfers all versions/comments in a large activity room.
create or replace function public.get_room_branch_summaries(p_room_id uuid)
returns table (
  branch_id           uuid,
  version_count       bigint,
  latest_version_id   uuid,
  latest_label        text,
  latest_updated_at   timestamptz,
  open_comment_count  bigint,
  feedback_count      bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    b.id,
    (select count(*)
       from public.versions v
      where v.room_id = b.room_id
        and v.branch_id = b.id
        and v.archived_at is null),
    (select v.id
       from public.versions v
      where v.room_id = b.room_id
        and v.branch_id = b.id
        and v.archived_at is null
      order by v.sort_order desc, v.created_at desc
      limit 1),
    (select v.label
       from public.versions v
      where v.room_id = b.room_id
        and v.branch_id = b.id
        and v.archived_at is null
      order by v.sort_order desc, v.created_at desc
      limit 1),
    (select v.created_at
       from public.versions v
      where v.room_id = b.room_id
        and v.branch_id = b.id
        and v.archived_at is null
      order by v.sort_order desc, v.created_at desc
      limit 1),
    (select count(*)
       from public.comments c
       join public.versions v on v.id = c.version_id and v.room_id = c.room_id
      where c.room_id = b.room_id
        and v.branch_id = b.id
        and v.archived_at is null
        and not c.resolved),
    (select count(*)
       from public.comments c
       join public.versions v on v.id = c.version_id and v.room_id = c.room_id
      where c.room_id = b.room_id
        and v.branch_id = b.id
        and v.archived_at is null)
  from public.room_branches b
  where b.room_id = p_room_id
    and public.is_room_member(b.room_id)
  order by b.sort_order, b.created_at;
$$;

revoke all on function public.get_room_branch_summaries(uuid) from public;
grant execute on function public.get_room_branch_summaries(uuid) to authenticated;

create or replace function public.touch_branch_on_version()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.branch_id is not null then
    update public.room_branches
       set updated_at = now()
     where id = new.branch_id
       and room_id = new.room_id;
  end if;
  return new;
end;
$$;

drop trigger if exists versions_touch_branch on public.versions;
create trigger versions_touch_branch
  after insert or update of branch_id on public.versions
  for each row execute function public.touch_branch_on_version();

revoke execute on function public.touch_branch_on_version() from public, anon, authenticated;

-- Mixed-version safety: a client that still inserts a version without branch_id
-- gets the old room's default branch. SECURITY INVOKER preserves the caller's
-- membership/capability checks; it does not become an ACL bypass.
create or replace function public.assign_version_branch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text := case when new.media_kind = 'video' then 'video' else 'poster' end;
  v_branch uuid;
begin
  if new.branch_id is not null then
    return new;
  end if;

  -- The trigger runs before the existing 0007 media guard. Keep the same
  -- capability boundary here so a reviewer cannot make the compatibility
  -- helper create a branch as a side effect of a rejected version insert.
  -- Direct migration/service-role maintenance can run without a JWT. The
  -- Data API roles, however, must never get a branch side effect from an
  -- anonymous or reviewer version insert that will be rejected by RLS.
  if current_user in ('anon', 'authenticated')
     and (auth.uid() is null or not coalesce(public.can_manage_media(new.room_id), false)) then
    raise exception 'not allowed'
      using hint = '檢視者不能建立媒體版本或分支。';
  end if;

  select b.id into v_branch
    from public.room_branches b
   where b.room_id = new.room_id
     and b.branch_type = v_type
   order by b.sort_order, b.created_at
   limit 1;

  if v_branch is null then
    insert into public.room_branches (room_id, name, branch_type, created_by)
    values (new.room_id, case when v_type = 'video' then '影片' else '文宣' end, v_type, auth.uid())
    returning id into v_branch;
  end if;
  new.branch_id := v_branch;
  return new;
end;
$$;

drop trigger if exists versions_assign_branch on public.versions;
create trigger versions_assign_branch
  before insert on public.versions
  for each row execute function public.assign_version_branch();

revoke execute on function public.assign_version_branch() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Plan content: intentionally a small block model, not rich text
-- ---------------------------------------------------------------------------

create table if not exists public.plan_documents (
  branch_id  uuid primary key references public.room_branches (id) on delete cascade,
  room_id    uuid not null references public.rooms (id) on delete cascade,
  title      text not null default '未命名企劃',
  description text not null default '',
  blocks     jsonb not null default '[]'::jsonb,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint plan_documents_branch_room_fk
    foreign key (branch_id, room_id) references public.room_branches (id, room_id) on delete cascade,
  constraint plan_documents_blocks_array check (jsonb_typeof(blocks) = 'array')
);

create index if not exists idx_plan_documents_room on public.plan_documents (room_id, updated_at desc);

-- ---------------------------------------------------------------------------
-- Simple cross-content relations
-- ---------------------------------------------------------------------------

create table if not exists public.content_relations (
  id              uuid primary key default extensions.gen_random_uuid(),
  room_id         uuid not null references public.rooms (id) on delete cascade,
  from_branch_id  uuid not null,
  to_branch_id    uuid not null,
  relation_type   text not null default 'related' check (relation_type = 'related'),
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  constraint content_relations_not_self check (from_branch_id <> to_branch_id),
  constraint content_relations_from_fk
    foreign key (from_branch_id, room_id) references public.room_branches (id, room_id) on delete cascade,
  constraint content_relations_to_fk
    foreign key (to_branch_id, room_id) references public.room_branches (id, room_id) on delete cascade,
  unique (room_id, from_branch_id, to_branch_id)
);

create index if not exists idx_content_relations_from on public.content_relations (room_id, from_branch_id);
create index if not exists idx_content_relations_to on public.content_relations (room_id, to_branch_id);

-- ---------------------------------------------------------------------------
-- Room-level decisions: lightweight poll, not a project-management board
-- ---------------------------------------------------------------------------

create table if not exists public.room_polls (
  id         uuid primary key default extensions.gen_random_uuid(),
  room_id    uuid not null references public.rooms (id) on delete cascade,
  question   text not null check (length(btrim(question)) between 1 and 240),
  options    jsonb not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at  timestamptz,
  unique (id, room_id),
  constraint room_polls_options_shape check (
    jsonb_typeof(options) = 'array'
    and jsonb_array_length(options) between 2 and 6
  )
);

create table if not exists public.room_poll_votes (
  poll_id    uuid not null references public.room_polls (id) on delete cascade,
  room_id    uuid not null references public.rooms (id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  option     text not null,
  created_at timestamptz not null default now(),
  primary key (poll_id, user_id),
  constraint room_poll_votes_poll_room_fk
    foreign key (poll_id, room_id) references public.room_polls (id, room_id) on delete cascade
);

create index if not exists idx_room_polls_room on public.room_polls (room_id, created_at desc);
create index if not exists idx_room_poll_votes_room on public.room_poll_votes (room_id, poll_id);

-- ---------------------------------------------------------------------------
-- updated_at and archive-only branch deletion
-- ---------------------------------------------------------------------------

create or replace function public.touch_project_content()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_table_name = 'room_branches' then
    if new.status = 'archived' then
      new.archived_at := coalesce(new.archived_at, now());
    elsif old.status = 'archived' then
      new.archived_at := null;
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists room_branches_touch on public.room_branches;
create trigger room_branches_touch
  before update on public.room_branches
  for each row execute function public.touch_project_content();
drop trigger if exists plan_documents_touch on public.plan_documents;
create trigger plan_documents_touch
  before update on public.plan_documents
  for each row execute function public.touch_project_content();
drop trigger if exists room_polls_touch on public.room_polls;
create trigger room_polls_touch
  before update on public.room_polls
  for each row execute function public.touch_project_content();

create or replace function public.touch_branch_on_plan()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.room_branches
     set updated_at = now()
   where id = new.branch_id
     and room_id = new.room_id;
  return new;
end;
$$;

drop trigger if exists plan_documents_touch_branch on public.plan_documents;
create trigger plan_documents_touch_branch
  after insert or update on public.plan_documents
  for each row execute function public.touch_branch_on_plan();

create or replace function public.prevent_branch_hard_delete()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- A room delete is the intentional parent-level cascade. Only a direct
  -- branch DELETE is forbidden, so removing a whole room does not deadlock on
  -- its child branches.
  if pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'branches are archived instead of deleted';
end;
$$;

drop trigger if exists room_branches_no_delete on public.room_branches;
create trigger room_branches_no_delete
  before delete on public.room_branches
  for each row execute function public.prevent_branch_hard_delete();

revoke execute on function public.touch_project_content() from public, anon, authenticated;
revoke execute on function public.touch_branch_on_plan() from public, anon, authenticated;
revoke execute on function public.prevent_branch_hard_delete() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RLS and explicit Data API grants
-- ---------------------------------------------------------------------------

alter table public.room_branches enable row level security;
alter table public.plan_documents enable row level security;
alter table public.content_relations enable row level security;
alter table public.room_polls enable row level security;
alter table public.room_poll_votes enable row level security;

drop policy if exists room_branches_select on public.room_branches;
create policy room_branches_select on public.room_branches
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists room_branches_insert on public.room_branches;
create policy room_branches_insert on public.room_branches
  for insert to authenticated with check (public.can_manage_media(room_id));
drop policy if exists room_branches_update on public.room_branches;
create policy room_branches_update on public.room_branches
  for update to authenticated
  using (public.can_manage_media(room_id))
  with check (public.can_manage_media(room_id));

drop policy if exists plan_documents_select on public.plan_documents;
create policy plan_documents_select on public.plan_documents
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists plan_documents_insert on public.plan_documents;
create policy plan_documents_insert on public.plan_documents
  for insert to authenticated with check (public.can_manage_media(room_id));
drop policy if exists plan_documents_update on public.plan_documents;
create policy plan_documents_update on public.plan_documents
  for update to authenticated
  using (public.can_manage_media(room_id))
  with check (public.can_manage_media(room_id));
drop policy if exists plan_documents_delete on public.plan_documents;
create policy plan_documents_delete on public.plan_documents
  for delete to authenticated using (public.can_manage_media(room_id));

drop policy if exists content_relations_select on public.content_relations;
create policy content_relations_select on public.content_relations
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists content_relations_insert on public.content_relations;
create policy content_relations_insert on public.content_relations
  for insert to authenticated with check (public.can_manage_media(room_id));
drop policy if exists content_relations_delete on public.content_relations;
create policy content_relations_delete on public.content_relations
  for delete to authenticated using (public.can_manage_media(room_id));

drop policy if exists room_polls_select on public.room_polls;
create policy room_polls_select on public.room_polls
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists room_polls_insert on public.room_polls;
create policy room_polls_insert on public.room_polls
  for insert to authenticated with check (public.can_manage_media(room_id));
drop policy if exists room_polls_update on public.room_polls;
create policy room_polls_update on public.room_polls
  for update to authenticated
  using (public.can_manage_media(room_id))
  with check (public.can_manage_media(room_id));
drop policy if exists room_polls_delete on public.room_polls;
create policy room_polls_delete on public.room_polls
  for delete to authenticated using (public.can_manage_media(room_id));

drop policy if exists room_poll_votes_select on public.room_poll_votes;
create policy room_poll_votes_select on public.room_poll_votes
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists room_poll_votes_insert on public.room_poll_votes;
create policy room_poll_votes_insert on public.room_poll_votes
  for insert to authenticated
  with check (public.is_room_member(room_id) and user_id = auth.uid());
drop policy if exists room_poll_votes_update on public.room_poll_votes;
create policy room_poll_votes_update on public.room_poll_votes
  for update to authenticated
  using (public.is_room_member(room_id) and user_id = auth.uid())
  with check (public.is_room_member(room_id) and user_id = auth.uid());
drop policy if exists room_poll_votes_delete on public.room_poll_votes;
create policy room_poll_votes_delete on public.room_poll_votes
  for delete to authenticated
  using (public.is_room_member(room_id) and user_id = auth.uid());

-- Keep anonymous access closed and make Data API exposure intentional.
revoke all on public.room_branches, public.plan_documents, public.content_relations,
  public.room_polls, public.room_poll_votes from anon;
revoke delete on public.room_branches from authenticated;
grant select, insert, update on public.room_branches to authenticated;
grant select, insert, update, delete on public.plan_documents to authenticated;
grant select, insert, delete on public.content_relations to authenticated;
grant select, insert, update, delete on public.room_polls to authenticated;
grant select, insert, update, delete on public.room_poll_votes to authenticated;

-- A reviewer can read and vote, but the new content tables stay capability-
-- gated. Versions also accept branch_id through the existing capability policy.
grant select on public.versions to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: summaries update without loading media bytes
-- ---------------------------------------------------------------------------

alter table public.room_branches replica identity full;
alter table public.plan_documents replica identity full;
alter table public.content_relations replica identity full;
alter table public.room_polls replica identity full;
alter table public.room_poll_votes replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table
        public.room_branches, public.plan_documents, public.content_relations,
        public.room_polls, public.room_poll_votes;
    exception when duplicate_object then
      null;
    end;
  end if;
end;
$$;
