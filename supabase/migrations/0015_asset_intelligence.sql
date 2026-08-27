-- ============================================================================
-- Asset Intelligence Layer 1.0
--
-- A version is still the source of truth for original media.  This migration
-- adds a room-scoped, metadata-only intelligence layer around it:
--   intelligent_assets -> analysis / regions / segments / document chunks
--                     -> relations / optional embeddings / analysis jobs
--
-- Design constraints:
--   * no binary is copied into Postgres;
--   * storage_path is never part of the room-context projection;
--   * all rows carry room_id so RLS remains cheap and auditable;
--   * old versions and plan branches are backfilled automatically;
--   * version/branch identity is immutable once an intelligence row exists;
--   * embeddings are optional JSONB, so lexical retrieval works without the
--     vector extension (which is opt-in on some Supabase deployments).
-- ============================================================================

-- A content hash belongs to the version record when an importer can provide
-- one.  It is optional for legacy rows and for large browser uploads where
-- hashing would unnecessarily duplicate the file in memory.
alter table public.versions add column if not exists content_hash text;
create index if not exists idx_versions_room_content_hash
  on public.versions (room_id, content_hash)
  where content_hash is not null;

create table if not exists public.intelligent_assets (
  id                    uuid primary key default extensions.gen_random_uuid(),
  room_id               uuid not null references public.rooms (id) on delete cascade,
  branch_id             uuid references public.room_branches (id) on delete restrict,
  version_id            uuid references public.versions (id) on delete cascade,
  asset_type            text not null default 'other'
    check (asset_type in ('image', 'video', 'audio', 'document', 'plan', 'whiteboard', 'canva', 'link', 'other')),
  title                 text not null default '未命名素材'
    check (length(btrim(title)) between 1 and 240),
  original_filename     text,
  mime_type             text,
  storage_path          text,
  source                text not null default 'room'
    check (source in ('upload', 'generated', 'canva', 'room', 'external')),
  status                text not null default 'pending'
    check (status in ('pending', 'processing', 'ready', 'partial', 'failed')),
  analysis_version      text not null default '1.0',
  analysis_provider     text,
  analysis_updated_at   timestamptz,
  ai_readable           boolean not null default true,
  external_ai_allowed   boolean not null default false,
  content_hash          text,
  source_key            text not null default (extensions.gen_random_uuid()::text),
  metadata              jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_by            uuid references auth.users (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (room_id, source_key)
);

comment on table public.intelligent_assets is
  '素材智能層的統一 asset metadata；不存 binary，原稿仍由 versions/Storage 保護。';
comment on column public.intelligent_assets.ai_readable is
  '允許 AI 使用此素材的理解資料；false 時 Room Context API 不會回傳它。';
comment on column public.intelligent_assets.external_ai_allowed is
  '允許把此素材內容送至外部 provider；false 仍可給 approved internal provider。';
comment on column public.intelligent_assets.source_key is
  '房間內冪等鍵，例如 version:<uuid>、plan:<branch_uuid> 或 content hash。';

create unique index if not exists idx_intelligent_assets_id_room
  on public.intelligent_assets (id, room_id);
create index if not exists idx_intelligent_assets_room_type_updated
  on public.intelligent_assets (room_id, asset_type, updated_at desc);
create index if not exists idx_intelligent_assets_room_branch
  on public.intelligent_assets (room_id, branch_id, updated_at desc);
create index if not exists idx_intelligent_assets_room_version
  on public.intelligent_assets (room_id, version_id);
create index if not exists idx_intelligent_assets_hash
  on public.intelligent_assets (room_id, content_hash)
  where content_hash is not null;

create table if not exists public.asset_analysis (
  asset_id       uuid primary key references public.intelligent_assets (id) on delete cascade,
  room_id        uuid not null references public.rooms (id) on delete cascade,
  summary        text not null default '',
  detected_text  text not null default '',
  topics         text[] not null default '{}'::text[],
  keywords       text[] not null default '{}'::text[],
  language       text,
  content_type   text,
  confidence     double precision
    check (confidence is null or (confidence >= 0 and confidence <= 1)),
  structured_data jsonb not null default '{}'::jsonb
    check (jsonb_typeof(structured_data) = 'object'),
  model_name     text,
  model_version  text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists idx_asset_analysis_room on public.asset_analysis (room_id, updated_at desc);

create table if not exists public.asset_regions (
  id            uuid primary key default extensions.gen_random_uuid(),
  asset_id      uuid not null references public.intelligent_assets (id) on delete cascade,
  room_id       uuid not null references public.rooms (id) on delete cascade,
  region_type   text not null default 'other',
  label         text not null default '',
  text_content  text not null default '',
  x             double precision not null check (x >= 0 and x <= 1),
  y             double precision not null check (y >= 0 and y <= 1),
  width         double precision not null check (width > 0 and width <= 1),
  height        double precision not null check (height > 0 and height <= 1),
  confidence    double precision check (confidence is null or (confidence >= 0 and confidence <= 1)),
  source        text not null default 'ai' check (source in ('ai', 'human')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (x + width <= 1),
  check (y + height <= 1)
);

create index if not exists idx_asset_regions_asset on public.asset_regions (asset_id, y, x);
create index if not exists idx_asset_regions_room on public.asset_regions (room_id, asset_id);

create table if not exists public.asset_video_segments (
  id             uuid primary key default extensions.gen_random_uuid(),
  asset_id       uuid not null references public.intelligent_assets (id) on delete cascade,
  room_id        uuid not null references public.rooms (id) on delete cascade,
  start_seconds  double precision not null check (start_seconds >= 0),
  end_seconds    double precision not null check (end_seconds > start_seconds),
  summary        text not null default '',
  transcript     text not null default '',
  topics         text[] not null default '{}'::text[],
  detected_text  text not null default '',
  scene_type     text,
  confidence     double precision check (confidence is null or (confidence >= 0 and confidence <= 1)),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists idx_asset_video_segments_asset_time
  on public.asset_video_segments (asset_id, start_seconds, end_seconds);
create index if not exists idx_asset_video_segments_room_time
  on public.asset_video_segments (room_id, start_seconds);

create table if not exists public.asset_document_chunks (
  id            uuid primary key default extensions.gen_random_uuid(),
  asset_id      uuid not null references public.intelligent_assets (id) on delete cascade,
  room_id       uuid not null references public.rooms (id) on delete cascade,
  chunk_index   integer not null check (chunk_index >= 0),
  content       text not null check (length(content) <= 100000),
  page          integer check (page is null or page > 0),
  section       text,
  heading       text,
  start_offset  integer check (start_offset is null or start_offset >= 0),
  end_offset    integer check (end_offset is null or end_offset >= 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (asset_id, chunk_index)
);

create index if not exists idx_asset_document_chunks_asset on public.asset_document_chunks (asset_id, chunk_index);
create index if not exists idx_asset_document_chunks_room on public.asset_document_chunks (room_id, asset_id, chunk_index);

create table if not exists public.asset_relations (
  id              uuid primary key default extensions.gen_random_uuid(),
  room_id         uuid not null references public.rooms (id) on delete cascade,
  source_asset_id  uuid not null references public.intelligent_assets (id) on delete cascade,
  target_asset_id  uuid not null references public.intelligent_assets (id) on delete cascade,
  relation_type   text not null
    check (relation_type in ('related_to', 'used_by', 'derived_from', 'supports', 'references', 'same_campaign', 'same_branch', 'version_of')),
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  check (source_asset_id <> target_asset_id),
  unique (room_id, source_asset_id, target_asset_id, relation_type)
);

create index if not exists idx_asset_relations_source on public.asset_relations (room_id, source_asset_id);
create index if not exists idx_asset_relations_target on public.asset_relations (room_id, target_asset_id);

-- Embeddings are intentionally provider-aware and optional.  JSONB avoids
-- making pgvector a hard requirement; a future migration can materialize this
-- column into vector after checking extension availability.
create table if not exists public.asset_embeddings (
  id           uuid primary key default extensions.gen_random_uuid(),
  asset_id     uuid not null references public.intelligent_assets (id) on delete cascade,
  room_id      uuid not null references public.rooms (id) on delete cascade,
  chunk_id     uuid references public.asset_document_chunks (id) on delete cascade,
  provider     text not null,
  model        text not null,
  dimensions   integer not null check (dimensions > 0),
  embedding    jsonb not null check (jsonb_typeof(embedding) = 'array'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (asset_id, chunk_id, provider, model)
);

create index if not exists idx_asset_embeddings_room on public.asset_embeddings (room_id, asset_id);

create table if not exists public.asset_human_metadata (
  asset_id      uuid primary key references public.intelligent_assets (id) on delete cascade,
  room_id       uuid not null references public.rooms (id) on delete cascade,
  title         text,
  summary       text,
  tags          text[] not null default '{}'::text[],
  structured_data jsonb not null default '{}'::jsonb
    check (jsonb_typeof(structured_data) = 'object'),
  updated_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_asset_human_metadata_room on public.asset_human_metadata (room_id, updated_at desc);

create table if not exists public.asset_analysis_jobs (
  id                 uuid primary key default extensions.gen_random_uuid(),
  asset_id           uuid not null references public.intelligent_assets (id) on delete cascade,
  room_id            uuid not null references public.rooms (id) on delete cascade,
  tier               smallint not null default 1 check (tier between 0 and 3),
  status             text not null default 'queued'
    check (status in ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  progress           smallint not null default 0 check (progress between 0 and 100),
  stage              text not null default 'queued',
  error_code         text,
  retry_count        integer not null default 0 check (retry_count >= 0),
  provider           text,
  model              text,
  input_type         text,
  estimated_cost     numeric(12, 6),
  processing_ms      integer,
  analysis_version   text not null default '1.0',
  content_hash       text,
  dedupe_key         text not null,
  error_detail       text,
  queued_at          timestamptz not null default now(),
  started_at         timestamptz,
  completed_at       timestamptz,
  created_by         uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (dedupe_key)
);

create index if not exists idx_asset_analysis_jobs_room_status
  on public.asset_analysis_jobs (room_id, status, queued_at);
create index if not exists idx_asset_analysis_jobs_asset
  on public.asset_analysis_jobs (asset_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Cross-row guards and automatic ingestion
-- ---------------------------------------------------------------------------

create or replace function public.guard_intelligent_asset_links()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch_room uuid;
  v_version_room uuid;
begin
  if new.branch_id is not null then
    select room_id into v_branch_room from public.room_branches where id = new.branch_id;
    if v_branch_room is null or v_branch_room <> new.room_id then
      raise exception 'asset-branch-room-mismatch';
    end if;
  end if;
  if new.version_id is not null then
    select room_id into v_version_room from public.versions where id = new.version_id;
    if v_version_room is null or v_version_room <> new.room_id then
      raise exception 'asset-version-room-mismatch';
    end if;
  end if;
  if tg_op = 'UPDATE' then
    if old.id <> new.id
       or old.room_id <> new.room_id
       or old.branch_id is distinct from new.branch_id
       or old.version_id is distinct from new.version_id
       or old.source_key <> new.source_key
       or old.storage_path is distinct from new.storage_path then
      raise exception 'asset-identity-immutable';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.guard_intelligence_child_room()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room uuid;
begin
  select room_id into v_room from public.intelligent_assets where id = new.asset_id;
  if v_room is null or v_room <> new.room_id then
    raise exception 'intelligence-child-room-mismatch';
  end if;
  return new;
end;
$$;

create or replace function public.guard_asset_relation_rooms()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source_room uuid;
  v_target_room uuid;
begin
  select room_id into v_source_room from public.intelligent_assets where id = new.source_asset_id;
  select room_id into v_target_room from public.intelligent_assets where id = new.target_asset_id;
  if v_source_room is null or v_target_room is null
     or v_source_room <> new.room_id
     or v_target_room <> new.room_id then
    raise exception 'asset-relation-room-mismatch';
  end if;
  return new;
end;
$$;

create or replace function public.touch_intelligence_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.enqueue_asset_analysis()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.ai_readable then
    insert into public.asset_analysis_jobs (
      asset_id, room_id, tier, status, stage, analysis_version,
      content_hash, dedupe_key, created_by
    ) values (
      new.id, new.room_id, 1, 'queued', 'metadata', new.analysis_version,
      new.content_hash,
      new.id::text || ':' || new.analysis_version || ':' || coalesce(new.content_hash, '') || ':1',
      coalesce(new.created_by, auth.uid())
    ) on conflict (dedupe_key) do nothing;
  end if;
  return new;
end;
$$;

create or replace function public.sync_version_to_intelligent_asset()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text := case when new.media_kind = 'video' then 'video' else 'image' end;
  v_path text := case when new.media_kind = 'video' then new.video_path else new.image_path end;
begin
  insert into public.intelligent_assets (
    room_id, branch_id, version_id, asset_type, title, original_filename,
    mime_type, storage_path, content_hash, source, source_key, created_by, metadata
  ) values (
    new.room_id, new.branch_id, new.id, v_type, new.label, null,
    new.mime_type, v_path, new.content_hash, 'room', 'version:' || new.id::text,
    new.created_by,
    jsonb_build_object(
      'version_order', new.sort_order,
      'content_hash', new.content_hash,
      'duration_seconds', new.duration_seconds,
      'poster_storage_path', case when new.media_kind = 'video' then new.image_path else null end
    )
  )
  on conflict (room_id, source_key) do update set
    branch_id = excluded.branch_id,
    version_id = excluded.version_id,
    asset_type = excluded.asset_type,
    title = excluded.title,
    mime_type = excluded.mime_type,
    storage_path = excluded.storage_path,
    content_hash = excluded.content_hash,
    metadata = public.intelligent_assets.metadata || excluded.metadata;
  return new;
end;
$$;

create or replace function public.sync_plan_to_intelligent_asset()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_created_by uuid;
begin
  select created_by into v_created_by from public.room_branches where id = new.branch_id;
  insert into public.intelligent_assets (
    room_id, branch_id, asset_type, title, source, source_key, created_by,
    metadata
  ) values (
    new.room_id, new.branch_id, 'plan', new.title, 'room',
    'plan:' || new.branch_id::text, coalesce(v_created_by, auth.uid()),
    jsonb_build_object('description', left(new.description, 20000), 'updated_at', new.updated_at)
  )
  on conflict (room_id, source_key) do update set
    title = excluded.title,
    metadata = excluded.metadata;
  return new;
end;
$$;

drop trigger if exists intelligent_assets_guard_links on public.intelligent_assets;
create trigger intelligent_assets_guard_links
  before insert or update on public.intelligent_assets
  for each row execute function public.guard_intelligent_asset_links();

drop trigger if exists intelligent_assets_touch on public.intelligent_assets;
create trigger intelligent_assets_touch
  before update on public.intelligent_assets
  for each row execute function public.touch_intelligence_row();

drop trigger if exists intelligent_assets_enqueue on public.intelligent_assets;
create trigger intelligent_assets_enqueue
  after insert or update of ai_readable, analysis_version, content_hash on public.intelligent_assets
  for each row execute function public.enqueue_asset_analysis();

drop trigger if exists versions_sync_intelligent_asset on public.versions;
create trigger versions_sync_intelligent_asset
  after insert or update of branch_id, label, media_kind, image_path, video_path, mime_type, sort_order, content_hash
  on public.versions
  for each row execute function public.sync_version_to_intelligent_asset();

drop trigger if exists plan_documents_sync_intelligent_asset on public.plan_documents;
create trigger plan_documents_sync_intelligent_asset
  after insert or update of title, description, updated_at on public.plan_documents
  for each row execute function public.sync_plan_to_intelligent_asset();

drop trigger if exists asset_relations_room_guard on public.asset_relations;
create trigger asset_relations_room_guard
  before insert or update on public.asset_relations
  for each row execute function public.guard_asset_relation_rooms();

-- Child rows cannot point to an asset in another room, even if a caller tries
-- to satisfy each independent FK with ids it already knows.
do $$
declare
  t text;
begin
  foreach t in array array[
    'asset_analysis', 'asset_regions', 'asset_video_segments',
    'asset_document_chunks', 'asset_embeddings', 'asset_human_metadata',
    'asset_analysis_jobs'
  ] loop
    execute format('drop trigger if exists %I_room_guard on public.%I', t, t);
    execute format('create trigger %I_room_guard before insert or update on public.%I for each row execute function public.guard_intelligence_child_room()', t, t);
  end loop;
end;
$$;

-- Backfill existing versions/plans after triggers exist.  This is idempotent:
-- source_key is the stable dedupe key and no Storage bytes are touched.
insert into public.intelligent_assets (
  room_id, branch_id, version_id, asset_type, title, mime_type, storage_path, content_hash,
  source, source_key, created_by, metadata
)
select
  v.room_id,
  v.branch_id,
  v.id,
  case when v.media_kind = 'video' then 'video' else 'image' end,
  v.label,
  v.mime_type,
  case when v.media_kind = 'video' then v.video_path else v.image_path end,
  v.content_hash,
  'room',
  'version:' || v.id::text,
  v.created_by,
  jsonb_build_object(
    'version_order', v.sort_order,
    'content_hash', v.content_hash,
    'duration_seconds', v.duration_seconds,
    'poster_storage_path', case when v.media_kind = 'video' then v.image_path else null end
  )
from public.versions v
on conflict (room_id, source_key) do nothing;

insert into public.intelligent_assets (
  room_id, branch_id, asset_type, title, source, source_key, created_by,
  metadata
)
select
  p.room_id,
  p.branch_id,
  'plan',
  p.title,
  'room',
  'plan:' || p.branch_id::text,
  b.created_by,
  jsonb_build_object('description', left(p.description, 20000), 'updated_at', p.updated_at)
from public.plan_documents p
left join public.room_branches b on b.id = p.branch_id
on conflict (room_id, source_key) do nothing;

-- ---------------------------------------------------------------------------
-- RLS / grants
-- ---------------------------------------------------------------------------

alter table public.intelligent_assets enable row level security;
alter table public.asset_analysis enable row level security;
alter table public.asset_regions enable row level security;
alter table public.asset_video_segments enable row level security;
alter table public.asset_document_chunks enable row level security;
alter table public.asset_relations enable row level security;
alter table public.asset_embeddings enable row level security;
alter table public.asset_human_metadata enable row level security;
alter table public.asset_analysis_jobs enable row level security;

drop policy if exists intelligent_assets_select on public.intelligent_assets;
create policy intelligent_assets_select on public.intelligent_assets
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists intelligent_assets_insert on public.intelligent_assets;
create policy intelligent_assets_insert on public.intelligent_assets
  for insert to authenticated with check (public.can_manage_media(room_id));
drop policy if exists intelligent_assets_update on public.intelligent_assets;
create policy intelligent_assets_update on public.intelligent_assets
  for update to authenticated
  using (public.can_manage_media(room_id))
  with check (public.can_manage_media(room_id));
drop policy if exists intelligent_assets_delete on public.intelligent_assets;
create policy intelligent_assets_delete on public.intelligent_assets
  for delete to authenticated using (public.can_manage_media(room_id));

-- Human members may see stored understanding in the UI.  The Room Context API
-- adds the separate `ai_readable` and `external_ai_allowed` filters before it
-- returns anything to an agent.
drop policy if exists asset_analysis_select on public.asset_analysis;
create policy asset_analysis_select on public.asset_analysis
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists asset_analysis_write on public.asset_analysis;
create policy asset_analysis_write on public.asset_analysis
  for all to authenticated using (public.can_manage_media(room_id)) with check (public.can_manage_media(room_id));

drop policy if exists asset_regions_select on public.asset_regions;
create policy asset_regions_select on public.asset_regions
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists asset_regions_write on public.asset_regions;
create policy asset_regions_write on public.asset_regions
  for all to authenticated using (public.can_manage_media(room_id)) with check (public.can_manage_media(room_id));

drop policy if exists asset_video_segments_select on public.asset_video_segments;
create policy asset_video_segments_select on public.asset_video_segments
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists asset_video_segments_write on public.asset_video_segments;
create policy asset_video_segments_write on public.asset_video_segments
  for all to authenticated using (public.can_manage_media(room_id)) with check (public.can_manage_media(room_id));

drop policy if exists asset_document_chunks_select on public.asset_document_chunks;
create policy asset_document_chunks_select on public.asset_document_chunks
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists asset_document_chunks_write on public.asset_document_chunks;
create policy asset_document_chunks_write on public.asset_document_chunks
  for all to authenticated using (public.can_manage_media(room_id)) with check (public.can_manage_media(room_id));

drop policy if exists asset_relations_select on public.asset_relations;
create policy asset_relations_select on public.asset_relations
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists asset_relations_insert on public.asset_relations;
create policy asset_relations_insert on public.asset_relations
  for insert to authenticated with check (public.can_manage_media(room_id));
drop policy if exists asset_relations_delete on public.asset_relations;
create policy asset_relations_delete on public.asset_relations
  for delete to authenticated using (public.can_manage_media(room_id));

drop policy if exists asset_embeddings_select on public.asset_embeddings;
create policy asset_embeddings_select on public.asset_embeddings
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists asset_embeddings_write on public.asset_embeddings;
create policy asset_embeddings_write on public.asset_embeddings
  for all to authenticated using (public.can_manage_media(room_id)) with check (public.can_manage_media(room_id));

drop policy if exists asset_human_metadata_select on public.asset_human_metadata;
create policy asset_human_metadata_select on public.asset_human_metadata
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists asset_human_metadata_write on public.asset_human_metadata;
create policy asset_human_metadata_write on public.asset_human_metadata
  for all to authenticated using (public.can_manage_media(room_id)) with check (public.can_manage_media(room_id));

drop policy if exists asset_analysis_jobs_select on public.asset_analysis_jobs;
create policy asset_analysis_jobs_select on public.asset_analysis_jobs
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists asset_analysis_jobs_write on public.asset_analysis_jobs;
create policy asset_analysis_jobs_write on public.asset_analysis_jobs
  for all to authenticated using (public.can_manage_media(room_id)) with check (public.can_manage_media(room_id));

revoke all on public.intelligent_assets, public.asset_analysis, public.asset_regions,
  public.asset_video_segments, public.asset_document_chunks, public.asset_relations,
  public.asset_embeddings, public.asset_human_metadata, public.asset_analysis_jobs
  from anon;
grant select, insert, update, delete on public.intelligent_assets to authenticated;
grant select, insert, update, delete on public.asset_analysis to authenticated;
grant select, insert, update, delete on public.asset_regions to authenticated;
grant select, insert, update, delete on public.asset_video_segments to authenticated;
grant select, insert, update, delete on public.asset_document_chunks to authenticated;
grant select, insert, delete on public.asset_relations to authenticated;
grant select, insert, update, delete on public.asset_embeddings to authenticated;
grant select, insert, update, delete on public.asset_human_metadata to authenticated;
grant select, insert, update, delete on public.asset_analysis_jobs to authenticated;

-- Trigger functions are internal implementation details.  They are called by
-- Postgres, never by the browser or by an AI provider.
revoke all on function public.guard_intelligent_asset_links() from public, anon, authenticated;
revoke all on function public.guard_intelligence_child_room() from public, anon, authenticated;
revoke all on function public.touch_intelligence_row() from public, anon, authenticated;
revoke all on function public.enqueue_asset_analysis() from public, anon, authenticated;
revoke all on function public.sync_version_to_intelligent_asset() from public, anon, authenticated;
revoke all on function public.sync_plan_to_intelligent_asset() from public, anon, authenticated;
revoke all on function public.guard_asset_relation_rooms() from public, anon, authenticated;

alter table public.intelligent_assets replica identity full;
alter table public.asset_analysis_jobs replica identity full;
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.intelligent_assets, public.asset_analysis_jobs;
    exception when duplicate_object then null;
    end;
  end if;
end;
$$;
