-- ============================================================================
-- The slice of a Supabase project that `supabase/migrations/*.sql` depends on,
-- recreated on a stock PostgreSQL so the migrations can be applied — and their
-- RLS actually exercised — without a hosted project.
--
-- This is a TEST FIXTURE, not part of the schema. It is never applied to a real
-- project: Supabase provides all of it already.
--
-- `auth.uid()` reads a session GUC so a test can switch identity with
-- `set local request.jwt.claim.sub = '<uuid>'`, which is how RLS is verified
-- from both a member's and a stranger's point of view.
-- ============================================================================

create extension if not exists pgcrypto with schema public;

create schema if not exists auth;
create schema if not exists storage;
create schema if not exists extensions;

-- 0001 calls extensions.digest / extensions.gen_random_uuid explicitly.
create or replace function extensions.digest(text, text) returns bytea
  language sql immutable as $$ select public.digest($1, $2) $$;
create or replace function extensions.gen_random_uuid() returns uuid
  language sql volatile as $$ select public.gen_random_uuid() $$;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

grant usage on schema public to anon, authenticated;

-- Supabase ships default privileges so every table created in `public` is
-- reachable by the API roles (RLS is what actually restricts rows). The
-- migrations rely on that and never grant per table, so the fixture has to
-- reproduce it or every policy check below would fail on GRANT, not on RLS.
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;

create table if not exists auth.users (
  id uuid primary key default public.gen_random_uuid(),
  created_at timestamptz not null default now()
);

create or replace function auth.uid() returns uuid
  language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz not null default now()
);

create table if not exists storage.objects (
  id uuid primary key default public.gen_random_uuid(),
  bucket_id text not null references storage.buckets (id) on delete cascade,
  name text not null,
  owner uuid,
  created_at timestamptz not null default now(),
  unique (bucket_id, name)
);
alter table storage.objects enable row level security;

-- Supabase splits an object name on '/' and returns everything but the last
-- segment, 1-indexed. `rooms/<id>/versions/x.png` => {rooms,<id>,versions}.
create or replace function storage.foldername(name text) returns text[]
  language plpgsql immutable as $$
declare
  parts text[];
begin
  parts := string_to_array(name, '/');
  return parts[1:array_length(parts, 1) - 1];
end;
$$;

grant usage on schema storage to anon, authenticated;
grant select, insert, update, delete on storage.objects to authenticated;
grant select on storage.objects to anon;

-- Realtime publication（WB01）：真專案由 Supabase 建立；shim 補上讓
-- migrations 的 `alter publication supabase_realtime add table` 分支真的
-- 執行（先前 guard 跳過 → publication 成員資格在 harness 測不到）。
create publication supabase_realtime;
