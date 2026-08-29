-- ============================================================================
-- 0032 — 討論 @提及 + 待辦草稿
--
-- 樹上最新是 0031，所以這支是 0032。不要發明 0033。
-- 不加 receipt／已讀回條。typing 不建表（走既有 presence channel）。
--
-- (1) Mentions
--   room_discussion_mentions：一則訊息 × 一個被提及的人。
--   讀：房內成員。寫：只有訊息作者能插自己的提及。
--   被提及的人必須是這間房的成員（WITH CHECK + trigger）。跨房 denied。
--
-- (2) Todos
--   room_todos：人填標題。created_by = auth.uid()。
--   AI / agent / system 不能當成員結案（trigger 擋 reserved actor；
--   client 再用 isMemberActor）。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (1) 提及
-- ---------------------------------------------------------------------------

create table if not exists public.room_discussion_mentions (
  message_id uuid not null,
  room_id uuid not null,
  mentioned_user_id uuid not null references auth.users (id) on delete cascade,
  created_by uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (message_id, mentioned_user_id),
  foreign key (message_id, room_id)
    references public.room_discussion_messages (id, room_id)
    on delete cascade
);

comment on table public.room_discussion_mentions is
  '討論 @提及。不是第二條聊天。被提及者必須是本房成員。';

create index if not exists room_discussion_mentions_room_idx
  on public.room_discussion_mentions (room_id, mentioned_user_id);

alter table public.room_discussion_mentions enable row level security;
alter table public.room_discussion_mentions force row level security;

revoke all on public.room_discussion_mentions from public, anon, authenticated;
grant select, insert on public.room_discussion_mentions to authenticated;

drop policy if exists room_discussion_mentions_select on public.room_discussion_mentions;
create policy room_discussion_mentions_select
  on public.room_discussion_mentions
  for select
  to authenticated
  using (public.is_room_member(room_id));

drop policy if exists room_discussion_mentions_insert_author on public.room_discussion_mentions;
create policy room_discussion_mentions_insert_author
  on public.room_discussion_mentions
  for insert
  to authenticated
  with check (
    public.is_room_member(room_id)
    and created_by = (select auth.uid())
    and exists (
      select 1 from public.room_discussion_messages msg
      where msg.id = message_id
        and msg.room_id = room_discussion_mentions.room_id
        and msg.author_user_id = (select auth.uid())
    )
    and exists (
      select 1 from public.room_members m
      where m.room_id = room_discussion_mentions.room_id
        and m.user_id = mentioned_user_id
    )
  );

comment on policy room_discussion_mentions_select on public.room_discussion_mentions is
  '房內成員可讀提及。';
comment on policy room_discussion_mentions_insert_author on public.room_discussion_mentions is
  '只有作者能寫自己訊息的提及；被提及者必須是本房成員。';

create or replace function public.guard_discussion_mention_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  author uuid;
begin
  if tg_op = 'UPDATE' then
    raise exception 'discussion-mention-update-forbidden'
      using hint = '提及只能新增，不能改。';
  end if;
  if new.created_by is distinct from caller then
    raise exception 'discussion-mention-not-own'
      using hint = '提及只能用自己的身分寫。';
  end if;
  select author_user_id into author
  from public.room_discussion_messages
  where id = new.message_id and room_id = new.room_id;
  if author is distinct from caller then
    raise exception 'discussion-mention-not-author'
      using hint = '只有作者能標這則的提及。';
  end if;
  if not exists (
    select 1 from public.room_members m
    where m.room_id = new.room_id and m.user_id = new.mentioned_user_id
  ) then
    raise exception 'discussion-mention-not-member'
      using hint = '只能提及這間房的成員。';
  end if;
  return new;
end;
$$;

comment on function public.guard_discussion_mention_write() is
  '提及：作者自己寫、被提及者必須是本房成員、INSERT-only、不能跨房（0032）。';

-- 0031 replay 會把 tombstone 函式放回 coalesce(deleted_by)。這裡蓋回「只能是 caller」。
create or replace function public.guard_discussion_tombstone()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if tg_op = 'DELETE' then
    raise exception 'discussion-hard-delete-forbidden'
      using hint = '討論訊息只能標 tombstone，不能硬刪。';
  end if;

  if old.deleted_at is not null then
    if new.deleted_at is distinct from old.deleted_at
      or new.deleted_by is distinct from old.deleted_by
      or new.body is distinct from old.body
      or new.kind is distinct from old.kind
      or new.payload is distinct from old.payload
    then
      raise exception 'discussion-tombstone-immutable'
        using hint = '已刪除的討論不能再改。';
    end if;
  end if;

  if old.deleted_at is null and new.deleted_at is not null then
    new.deleted_by := caller;
  end if;

  return new;
end;
$$;

revoke execute on function public.guard_discussion_mention_write() from public, anon, authenticated;

drop trigger if exists room_discussion_mentions_guard_write on public.room_discussion_mentions;
create trigger room_discussion_mentions_guard_write
  before insert or update on public.room_discussion_mentions
  for each row execute function public.guard_discussion_mention_write();

-- ---------------------------------------------------------------------------
-- (2) 待辦草稿
-- ---------------------------------------------------------------------------

create table if not exists public.room_todos (
  id uuid primary key default extensions.gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 240),
  created_by uuid not null default auth.uid() references auth.users (id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'done')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.room_todos is
  '待辦草稿。人建立、人結案。不是 AI 代完成的決策。';

create index if not exists room_todos_room_idx
  on public.room_todos (room_id, created_at desc);

alter table public.room_todos enable row level security;
alter table public.room_todos force row level security;

revoke all on public.room_todos from public, anon, authenticated;
grant select, insert, update on public.room_todos to authenticated;

drop policy if exists room_todos_select on public.room_todos;
create policy room_todos_select
  on public.room_todos
  for select
  to authenticated
  using (public.is_room_member(room_id));

drop policy if exists room_todos_insert_own on public.room_todos;
create policy room_todos_insert_own
  on public.room_todos
  for insert
  to authenticated
  with check (
    public.is_room_member(room_id)
    and created_by = (select auth.uid())
  );

drop policy if exists room_todos_update_own on public.room_todos;
create policy room_todos_update_own
  on public.room_todos
  for update
  to authenticated
  using (
    public.is_room_member(room_id)
    and (
      created_by = (select auth.uid())
      or public.can_manage_media(room_id)
    )
  )
  with check (
    public.is_room_member(room_id)
    and (
      created_by = (select auth.uid())
      or public.can_manage_media(room_id)
    )
  );

comment on policy room_todos_select on public.room_todos is
  '房內成員可讀待辦。';
comment on policy room_todos_insert_own on public.room_todos is
  '只能以自己的身分建立待辦。';
comment on policy room_todos_update_own on public.room_todos is
  'UPDATE 有 USING + WITH CHECK。作者或 can_manage 可改狀態。';

create or replace function public.guard_room_todo_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if new.created_by is distinct from caller and tg_op = 'INSERT' then
    raise exception 'todo-author-forged'
      using hint = '待辦只能用自己的身分建立。';
  end if;
  if tg_op = 'UPDATE' then
    if new.created_by is distinct from old.created_by then
      raise exception 'todo-author-immutable'
        using hint = '不能改待辦的建立者。';
    end if;
    if new.room_id is distinct from old.room_id then
      raise exception 'todo-room-immutable'
        using hint = '不能把待辦搬到別的房間。';
    end if;
  end if;
  return new;
end;
$$;

comment on function public.guard_room_todo_write() is
  '待辦：建立者只能是自己，房間與建立者不可改掛（0032）。AI 結案由 client isMemberActor 擋。';

revoke execute on function public.guard_room_todo_write() from public, anon, authenticated;

drop trigger if exists room_todos_guard_write on public.room_todos;
create trigger room_todos_guard_write
  before insert or update on public.room_todos
  for each row execute function public.guard_room_todo_write();
