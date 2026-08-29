-- ============================================================================
-- 0031 — 討論訊息 tombstone + 每人未讀水位（不是回條）
--
-- 範圍只這兩件事。不要在這支加 mention / typing / todo / receipt。
--
-- (1) Tombstone
--   討論列軟刪：deleted_at / deleted_by。畫面要留墓碑，不能默默消失。
--   誰能標：作者自己，或 can_manage_media。跨房改 room_id 仍由 0022
--   guard_discussion_message_write 擋下。
--   硬刪收回：0014 給了 DELETE grant + room_discussion_delete policy。
--   0014 可重跑，所以 policy/grant 可能被洗回來；BEFORE DELETE trigger
--   的名字不在 0014 裡，replay 之後仍然擋硬刪（與 0022 同一理由）。
--
-- (2) 未讀水位
--   room_discussion_reads (room_id, user_id) 每人一列。
--   只准讀寫自己的列，而且必須是房內成員。
--   last_read_message_id 必須屬於同一間房（複合外鍵），避免跨房水位。
--   這不是回條：別人看不到你的水位。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (1) 訊息 tombstone 欄
-- ---------------------------------------------------------------------------

alter table public.room_discussion_messages
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references auth.users (id) on delete set null;

create index if not exists room_discussion_messages_room_live_idx
  on public.room_discussion_messages (room_id, created_at)
  where deleted_at is null;

-- 複合唯一：未讀水位的 last_read_message_id 必須指向同一間房的訊息。
-- id 已是 PK，(id, room_id) 對既有列是多餘的，但複合 FK 需要它。
do $$
begin
  alter table public.room_discussion_messages
    add constraint room_discussion_messages_id_room_unique unique (id, room_id);
exception
  when duplicate_object then null;
  when duplicate_table then null;
end $$;

-- 0014 的 update policy 已經是「作者或 can_manage」。這裡重寫成
-- `(select auth.uid())`，與 0022 同一寫法；0014 replay 會把舊寫法放回來，
-- 語意不變。tombstone 走 UPDATE，不走 DELETE。
drop policy if exists room_discussion_update on public.room_discussion_messages;
create policy room_discussion_update
  on public.room_discussion_messages
  for update
  to authenticated
  using (
    public.is_room_member(room_id)
    and (
      author_user_id = (select auth.uid())
      or public.can_manage_media(room_id)
    )
  )
  with check (
    public.is_room_member(room_id)
    and (
      author_user_id = (select auth.uid())
      or public.can_manage_media(room_id)
    )
  );

comment on policy room_discussion_update on public.room_discussion_messages is
  '作者或 can_manage 可改內容／標 tombstone。作者／房間／發出時間仍由 0022 trigger 凍結。';

-- 硬刪：revoke + 拿掉 policy。0014 replay 可能把它們放回來，trigger 才是護欄。
revoke delete on public.room_discussion_messages from authenticated;
drop policy if exists room_discussion_delete on public.room_discussion_messages;

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
    new.deleted_by := coalesce(new.deleted_by, caller);
  end if;

  return new;
end;
$$;

comment on function public.guard_discussion_tombstone() is
  '討論訊息軟刪：擋硬刪、墓碑列不可再改、deleted_by 記操作者（0031）。0014 replay 不會丟掉這支 trigger。';

revoke execute on function public.guard_discussion_tombstone() from public, anon, authenticated;

drop trigger if exists room_discussion_guard_tombstone on public.room_discussion_messages;
create trigger room_discussion_guard_tombstone
  before delete or update on public.room_discussion_messages
  for each row execute function public.guard_discussion_tombstone();

-- ---------------------------------------------------------------------------
-- (2) 每人未讀水位（不是 receipt）
-- ---------------------------------------------------------------------------

create table if not exists public.room_discussion_reads (
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  last_read_message_id uuid,
  last_read_at timestamptz not null default now(),
  primary key (room_id, user_id),
  foreign key (room_id, last_read_message_id)
    references public.room_discussion_messages (room_id, id)
    on delete set null
);

comment on table public.room_discussion_reads is
  '每人一間房一列未讀水位。只給自己看，不是回條。';

create index if not exists room_discussion_reads_message_idx
  on public.room_discussion_reads (last_read_message_id)
  where last_read_message_id is not null;

alter table public.room_discussion_reads enable row level security;
alter table public.room_discussion_reads force row level security;

-- 先全部收回再逐項給。只留 SELECT/INSERT/UPDATE；TRUNCATE 一併拿掉。
revoke all on public.room_discussion_reads from public, anon, authenticated;
grant select, insert, update on public.room_discussion_reads to authenticated;

drop policy if exists room_discussion_reads_select_own on public.room_discussion_reads;
create policy room_discussion_reads_select_own
  on public.room_discussion_reads
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    and public.is_room_member(room_id)
  );

drop policy if exists room_discussion_reads_insert_own on public.room_discussion_reads;
create policy room_discussion_reads_insert_own
  on public.room_discussion_reads
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and public.is_room_member(room_id)
  );

drop policy if exists room_discussion_reads_update_own on public.room_discussion_reads;
create policy room_discussion_reads_update_own
  on public.room_discussion_reads
  for update
  to authenticated
  using (
    user_id = (select auth.uid())
    and public.is_room_member(room_id)
  )
  with check (
    user_id = (select auth.uid())
    and public.is_room_member(room_id)
  );

comment on policy room_discussion_reads_select_own on public.room_discussion_reads is
  '只能讀自己的未讀水位，而且必須是房內成員。';
comment on policy room_discussion_reads_insert_own on public.room_discussion_reads is
  '只能寫自己的未讀水位，而且必須是房內成員。';
comment on policy room_discussion_reads_update_own on public.room_discussion_reads is
  'UPDATE 同時有 USING + WITH CHECK；只能改自己的列。';

create or replace function public.guard_discussion_read_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if new.user_id is distinct from caller then
    raise exception 'discussion-read-not-own'
      using hint = '未讀水位只能寫自己的列。';
  end if;
  if tg_op = 'UPDATE' then
    if new.room_id is distinct from old.room_id then
      raise exception 'discussion-read-room-immutable'
        using hint = '不能把未讀水位搬到別的房間。';
    end if;
    if new.user_id is distinct from old.user_id then
      raise exception 'discussion-read-user-immutable'
        using hint = '不能把未讀水位改掛到別人。';
    end if;
  end if;
  return new;
end;
$$;

comment on function public.guard_discussion_read_write() is
  '未讀水位只能寫自己、不能跨房改掛（0031）。複合外鍵另擋 last_read_message_id 跨房。';

revoke execute on function public.guard_discussion_read_write() from public, anon, authenticated;

drop trigger if exists room_discussion_reads_guard_write on public.room_discussion_reads;
create trigger room_discussion_reads_guard_write
  before insert or update on public.room_discussion_reads
  for each row execute function public.guard_discussion_read_write();
