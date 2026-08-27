-- ============================================================================
-- Collaborative Intelligence Workspace 1.0 / Phase 1
-- Asset Intelligence Layer + Room Knowledge Index + Room Context retrieval
--
-- Additive only. Original media stays in room-assets; these tables store
-- references, analyses, segments and a searchable index. Whiteboard, voice
-- and Canva tables are intentionally absent — those phases are not started.
--
-- Re-runnable: owned constraints/policies/triggers are dropped or guarded
-- before recreate. Invite secrets never land in the knowledge index.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Logical assets: one understood thing in a room, pointing at existing rows
-- ---------------------------------------------------------------------------

create table if not exists public.asset_records (
  id                 uuid primary key default extensions.gen_random_uuid(),
  room_id            uuid not null references public.rooms (id) on delete cascade,
  branch_id          uuid not null,
  kind               text not null default 'poster'
    check (kind in ('poster', 'video', 'plan', 'copy', 'image', 'document', 'audio')),
  title              text not null check (length(btrim(title)) between 1 and 160),
  source_version_id  uuid references public.versions (id) on delete set null,
  current_version_id uuid references public.versions (id) on delete set null,
  created_by         uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (id, room_id),
  constraint asset_records_branch_room_fk
    foreign key (branch_id, room_id) references public.room_branches (id, room_id) on delete cascade
);

comment on table public.asset_records is
  '房間內可被 AI 理解的邏輯素材。只存 reference，不複製原稿 bytes。';

create index if not exists idx_asset_records_room on public.asset_records (room_id, updated_at desc);
create index if not exists idx_asset_records_branch on public.asset_records (room_id, branch_id);

create table if not exists public.asset_analyses (
  id          uuid primary key default extensions.gen_random_uuid(),
  room_id     uuid not null references public.rooms (id) on delete cascade,
  asset_id    uuid not null,
  version_id  uuid references public.versions (id) on delete cascade,
  kind        text not null check (kind in ('image', 'document', 'audio', 'video')),
  status      text not null default 'ready' check (status in ('pending', 'ready', 'failed')),
  source      text not null default 'structured'
    check (source in ('structured', 'vision', 'transcript', 'manual')),
  summary     text not null default '',
  topics      text[] not null default '{}',
  ocr_text    text,
  caption     text,
  payload     jsonb not null default '{}'::jsonb,
  model       text,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint asset_analyses_asset_room_fk
    foreign key (asset_id, room_id) references public.asset_records (id, room_id) on delete cascade,
  constraint asset_analyses_payload_object check (jsonb_typeof(payload) = 'object')
);

create unique index if not exists idx_asset_analyses_unique
  on public.asset_analyses (asset_id, coalesce(version_id, '00000000-0000-0000-0000-000000000000'::uuid), kind);
create index if not exists idx_asset_analyses_room on public.asset_analyses (room_id, kind, updated_at desc);

comment on column public.asset_analyses.source is
  'structured=房間既有文字／留言／企劃；vision=真實視覺模型；不可假裝未接上的 API。';

create table if not exists public.asset_video_segments (
  id            uuid primary key default extensions.gen_random_uuid(),
  room_id       uuid not null references public.rooms (id) on delete cascade,
  asset_id      uuid not null,
  version_id    uuid not null references public.versions (id) on delete cascade,
  start_seconds double precision not null check (start_seconds >= 0),
  end_seconds   double precision not null,
  summary       text not null default '',
  topics        text[] not null default '{}',
  source        text not null default 'comment'
    check (source in ('comment', 'transcript', 'manual', 'analysis')),
  created_at    timestamptz not null default now(),
  constraint asset_video_segments_time check (end_seconds >= start_seconds),
  constraint asset_video_segments_asset_room_fk
    foreign key (asset_id, room_id) references public.asset_records (id, room_id) on delete cascade
);

create index if not exists idx_asset_video_segments_room
  on public.asset_video_segments (room_id, version_id, start_seconds, end_seconds);

create table if not exists public.asset_relations (
  id             uuid primary key default extensions.gen_random_uuid(),
  room_id        uuid not null references public.rooms (id) on delete cascade,
  from_asset_id  uuid not null,
  to_asset_id    uuid not null,
  relation_type  text not null default 'related'
    check (relation_type in ('related', 'variant_of', 'used_in', 'derived_from')),
  created_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  constraint asset_relations_not_self check (from_asset_id <> to_asset_id),
  constraint asset_relations_from_fk
    foreign key (from_asset_id, room_id) references public.asset_records (id, room_id) on delete cascade,
  constraint asset_relations_to_fk
    foreign key (to_asset_id, room_id) references public.asset_records (id, room_id) on delete cascade,
  unique (room_id, from_asset_id, to_asset_id, relation_type)
);

create index if not exists idx_asset_relations_room on public.asset_relations (room_id, from_asset_id);

create table if not exists public.room_knowledge_entries (
  id                  uuid primary key default extensions.gen_random_uuid(),
  room_id             uuid not null references public.rooms (id) on delete cascade,
  asset_id            uuid,
  version_id          uuid references public.versions (id) on delete cascade,
  branch_id           uuid,
  segment_id          uuid,
  kind                text not null
    check (kind in ('asset_summary', 'image_analysis', 'document', 'video_segment', 'relation', 'comment')),
  title               text not null default '',
  body                text not null default '',
  topics              text[] not null default '{}',
  is_current_version  boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint room_knowledge_asset_fk
    foreign key (asset_id, room_id) references public.asset_records (id, room_id) on delete cascade
);

create index if not exists idx_room_knowledge_room on public.room_knowledge_entries (room_id, kind, is_current_version);
create index if not exists idx_room_knowledge_topics on public.room_knowledge_entries using gin (topics);

alter table public.room_knowledge_entries
  add column if not exists search_vector tsvector
  generated always as (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A')
    || setweight(to_tsvector('simple', coalesce(body, '')), 'B')
  ) stored;

create index if not exists idx_room_knowledge_fts on public.room_knowledge_entries using gin (search_vector);

-- ---------------------------------------------------------------------------
-- Touch + knowledge sync
-- ---------------------------------------------------------------------------

create or replace function public.touch_asset_intelligence()
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

drop trigger if exists asset_records_touch on public.asset_records;
create trigger asset_records_touch
  before update on public.asset_records
  for each row execute function public.touch_asset_intelligence();
drop trigger if exists asset_analyses_touch on public.asset_analyses;
create trigger asset_analyses_touch
  before update on public.asset_analyses
  for each row execute function public.touch_asset_intelligence();
drop trigger if exists room_knowledge_touch on public.room_knowledge_entries;
create trigger room_knowledge_touch
  before update on public.room_knowledge_entries
  for each row execute function public.touch_asset_intelligence();

create or replace function public.sync_knowledge_from_analysis()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_current boolean := true;
  v_kind text := case when new.kind = 'document' then 'document' else 'image_analysis' end;
begin
  if new.version_id is not null then
    select (v.archived_at is null) into v_current
      from public.versions v
     where v.id = new.version_id
       and v.room_id = new.room_id;
    v_current := coalesce(v_current, true);
  end if;

  insert into public.room_knowledge_entries (
    room_id, asset_id, version_id, kind, title, body, topics, is_current_version
  )
  values (
    new.room_id,
    new.asset_id,
    new.version_id,
    v_kind,
    coalesce(nullif(new.caption, ''), left(new.summary, 80), '素材理解'),
    new.summary,
    new.topics,
    v_current
  );
  return new;
end;
$$;

drop trigger if exists asset_analyses_sync_knowledge on public.asset_analyses;
create trigger asset_analyses_sync_knowledge
  after insert on public.asset_analyses
  for each row execute function public.sync_knowledge_from_analysis();

create or replace function public.sync_knowledge_from_segment()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into public.room_knowledge_entries (
    room_id, asset_id, version_id, segment_id, kind, title, body, topics, is_current_version
  )
  values (
    new.room_id,
    new.asset_id,
    new.version_id,
    new.id,
    'video_segment',
    '影片片段',
    new.summary,
    new.topics,
    true
  );
  return new;
end;
$$;

drop trigger if exists asset_video_segments_sync_knowledge on public.asset_video_segments;
create trigger asset_video_segments_sync_knowledge
  after insert on public.asset_video_segments
  for each row execute function public.sync_knowledge_from_segment();

revoke execute on function public.touch_asset_intelligence() from public, anon, authenticated;
revoke execute on function public.sync_knowledge_from_analysis() from public, anon, authenticated;
revoke execute on function public.sync_knowledge_from_segment() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Room Context retrieval: relevant slice only, membership required
-- ---------------------------------------------------------------------------

create or replace function public.search_room_knowledge(
  p_room_id uuid,
  p_query text,
  p_at_seconds double precision default null,
  p_include_non_current boolean default false,
  p_limit integer default 12
)
returns table (
  entry_id uuid,
  asset_id uuid,
  version_id uuid,
  branch_id uuid,
  segment_id uuid,
  kind text,
  title text,
  body text,
  topics text[],
  is_current_version boolean,
  start_seconds double precision,
  end_seconds double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    e.id,
    e.asset_id,
    e.version_id,
    e.branch_id,
    e.segment_id,
    e.kind,
    e.title,
    e.body,
    e.topics,
    e.is_current_version,
    s.start_seconds,
    s.end_seconds
  from public.room_knowledge_entries e
  left join public.asset_video_segments s on s.id = e.segment_id
  where e.room_id = p_room_id
    and public.is_room_member(e.room_id)
    and (p_include_non_current or e.is_current_version)
    and (
      p_at_seconds is null
      or e.kind <> 'video_segment'
      or (s.start_seconds is not null and p_at_seconds >= s.start_seconds and p_at_seconds <= s.end_seconds)
    )
    and (
      coalesce(p_query, '') = ''
      or e.title ilike '%' || p_query || '%'
      or e.body ilike '%' || p_query || '%'
      or exists (
        select 1 from unnest(e.topics) as t(topic)
        where t.topic ilike '%' || p_query || '%' or p_query ilike '%' || t.topic || '%'
      )
      or e.search_vector @@ plainto_tsquery('simple', p_query)
    )
  order by
    case when p_at_seconds is not null and e.kind = 'video_segment' then 0 else 1 end,
    e.is_current_version desc,
    e.updated_at desc
  limit greatest(1, least(coalesce(p_limit, 12), 24));
$$;

revoke all on function public.search_room_knowledge(uuid, text, double precision, boolean, integer) from public;
grant execute on function public.search_room_knowledge(uuid, text, double precision, boolean, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.asset_records enable row level security;
alter table public.asset_analyses enable row level security;
alter table public.asset_video_segments enable row level security;
alter table public.asset_relations enable row level security;
alter table public.room_knowledge_entries enable row level security;

drop policy if exists asset_records_select on public.asset_records;
create policy asset_records_select on public.asset_records
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists asset_records_insert on public.asset_records;
create policy asset_records_insert on public.asset_records
  for insert to authenticated with check (public.can_manage_media(room_id));
drop policy if exists asset_records_update on public.asset_records;
create policy asset_records_update on public.asset_records
  for update to authenticated
  using (public.can_manage_media(room_id))
  with check (public.can_manage_media(room_id));
drop policy if exists asset_records_delete on public.asset_records;
create policy asset_records_delete on public.asset_records
  for delete to authenticated using (public.can_manage_media(room_id));

drop policy if exists asset_analyses_select on public.asset_analyses;
create policy asset_analyses_select on public.asset_analyses
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists asset_analyses_write on public.asset_analyses;
create policy asset_analyses_write on public.asset_analyses
  for insert to authenticated with check (public.can_manage_media(room_id));
drop policy if exists asset_analyses_update on public.asset_analyses;
create policy asset_analyses_update on public.asset_analyses
  for update to authenticated
  using (public.can_manage_media(room_id))
  with check (public.can_manage_media(room_id));

drop policy if exists asset_video_segments_select on public.asset_video_segments;
create policy asset_video_segments_select on public.asset_video_segments
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists asset_video_segments_write on public.asset_video_segments;
create policy asset_video_segments_write on public.asset_video_segments
  for insert to authenticated with check (public.can_manage_media(room_id));

drop policy if exists asset_relations_select on public.asset_relations;
create policy asset_relations_select on public.asset_relations
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists asset_relations_write on public.asset_relations;
create policy asset_relations_write on public.asset_relations
  for insert to authenticated with check (public.can_manage_media(room_id));
drop policy if exists asset_relations_delete on public.asset_relations;
create policy asset_relations_delete on public.asset_relations
  for delete to authenticated using (public.can_manage_media(room_id));

drop policy if exists room_knowledge_select on public.room_knowledge_entries;
create policy room_knowledge_select on public.room_knowledge_entries
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists room_knowledge_write on public.room_knowledge_entries;
create policy room_knowledge_write on public.room_knowledge_entries
  for insert to authenticated with check (public.can_manage_media(room_id));
drop policy if exists room_knowledge_update on public.room_knowledge_entries;
create policy room_knowledge_update on public.room_knowledge_entries
  for update to authenticated
  using (public.can_manage_media(room_id))
  with check (public.can_manage_media(room_id));

revoke all on public.asset_records, public.asset_analyses, public.asset_video_segments,
  public.asset_relations, public.room_knowledge_entries from anon;
grant select, insert, update, delete on public.asset_records to authenticated;
grant select, insert, update on public.asset_analyses to authenticated;
grant select, insert, update on public.asset_video_segments to authenticated;
grant select, insert, delete on public.asset_relations to authenticated;
grant select, insert, update on public.room_knowledge_entries to authenticated;

alter table public.asset_records replica identity full;
alter table public.asset_analyses replica identity full;
alter table public.asset_video_segments replica identity full;
alter table public.asset_relations replica identity full;
alter table public.room_knowledge_entries replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table
        public.asset_records, public.asset_analyses, public.asset_video_segments,
        public.asset_relations, public.room_knowledge_entries;
    exception when duplicate_object then
      null;
    end;
  end if;
end;
$$;
