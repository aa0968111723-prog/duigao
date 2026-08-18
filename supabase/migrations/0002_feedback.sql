-- ============================================================================
-- 文宣討論區 — Low-friction feedback (PR #13)
-- "我也覺得" (supports), 修改點回覆 (replies) and 視覺提案表態 (proposal
-- preferences). Additive to 0001; same membership-gated RLS model.
--   * SELECT: any room member.
--   * A user may only add/remove their OWN support and preference, and only
--     create replies as themselves. Cross-room access stays impossible.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.comment_supports (
  comment_id uuid not null references public.comments (id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  room_id    uuid not null references public.rooms (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);

create table if not exists public.comment_replies (
  id             uuid primary key default gen_random_uuid(),
  room_id        uuid not null references public.rooms (id) on delete cascade,
  comment_id     uuid not null references public.comments (id) on delete cascade,
  author_user_id uuid not null default auth.uid() references auth.users (id) on delete set null,
  author_name    text not null default '夥伴',
  author_color   text not null default '#c45c4a',
  body           text not null default '',
  created_at     timestamptz not null default now()
);

create table if not exists public.proposal_preferences (
  room_id    uuid not null references public.rooms (id) on delete cascade,
  version_id uuid not null references public.versions (id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  choice     text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (version_id, user_id)
);

create index if not exists idx_comment_supports_room on public.comment_supports (room_id);
create index if not exists idx_comment_supports_comment on public.comment_supports (comment_id);
create index if not exists idx_comment_replies_room on public.comment_replies (room_id);
create index if not exists idx_comment_replies_comment on public.comment_replies (comment_id);
create index if not exists idx_proposal_preferences_room on public.proposal_preferences (room_id);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.comment_supports enable row level security;
alter table public.comment_replies enable row level security;
alter table public.proposal_preferences enable row level security;

-- supports: members read; a user may only add/remove their own.
create policy comment_supports_select on public.comment_supports
  for select to authenticated using (public.is_room_member(room_id));
create policy comment_supports_insert on public.comment_supports
  for insert to authenticated with check (public.is_room_member(room_id) and user_id = auth.uid());
create policy comment_supports_delete on public.comment_supports
  for delete to authenticated using (user_id = auth.uid());

-- replies: members read; a user may only create their own; delete own.
create policy comment_replies_select on public.comment_replies
  for select to authenticated using (public.is_room_member(room_id));
create policy comment_replies_insert on public.comment_replies
  for insert to authenticated with check (public.is_room_member(room_id) and author_user_id = auth.uid());
create policy comment_replies_delete on public.comment_replies
  for delete to authenticated using (author_user_id = auth.uid());

-- preferences: members read; a user may only set/change/remove their own.
create policy proposal_preferences_select on public.proposal_preferences
  for select to authenticated using (public.is_room_member(room_id));
create policy proposal_preferences_insert on public.proposal_preferences
  for insert to authenticated with check (public.is_room_member(room_id) and user_id = auth.uid());
create policy proposal_preferences_update on public.proposal_preferences
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy proposal_preferences_delete on public.proposal_preferences
  for delete to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------

alter table public.comment_supports replica identity full;
alter table public.comment_replies replica identity full;
alter table public.proposal_preferences replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.comment_supports, public.comment_replies, public.proposal_preferences;
  end if;
exception when duplicate_object then
  null;
end;
$$;
