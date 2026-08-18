-- ============================================================================
-- 文宣討論區 — Reconcile cloud architecture (PR #15)
--
-- There must be exactly ONE cloud persistence model: the entity-level schema
-- defined by 0001_cloud_rooms.sql / 0002_feedback.sql / 0003_comment_regions.sql
-- (anonymous auth + invite-hash membership + RLS + private Storage + Realtime).
--
-- An earlier iteration of PR #15 deployed a simplified "room mirror" to the
-- live project instead:
--   * SECURITY DEFINER functions public.get_room / public.save_room
--   * a public.rooms table holding whole-Room JSON snapshots
--   * a PUBLIC "posters" storage bucket
-- That model lets anyone who knows (or guesses) a 6-char code read AND
-- OVERWRITE an entire room anonymously, and whole-JSON snapshots make
-- concurrent edits last-write-wins. This migration retires it in a repeatable,
-- tracked way — no untracked Dashboard surgery.
--
-- What it does (all steps are defensive no-ops when the object is absent):
--   1. Drops every overload of public.get_room / public.save_room.
--   2. If public.rooms is the LEGACY mirror shape (it lacks owner_user_id),
--      renames it to public.legacy_room_mirror and revokes API access, so the
--      old data stays recoverable but unreachable, and 0001 can then create
--      the canonical rooms table. Aborts if that destination name is already
--      taken, since continuing would leave the legacy table as public.rooms.
--   3. Turns the legacy "posters" bucket private (uploaded test posters stay
--      recoverable by the owner, but are no longer world-readable).
--
-- APPLY ORDER
--   * Fresh project:            0001 → 0002 → 0003 → 0004 (this file no-ops).
--   * Current live project (has the legacy mirror, has NOT run 0001–0003):
--                               0004 → 0001 → 0002 → 0003
--     ...then enable Authentication → Sign In / Up → "Allow anonymous
--     sign-ins" in the Supabase Dashboard (required by the client's
--     signInAnonymously flow; it cannot be enabled from SQL).
-- ============================================================================

-- 1. Retire the legacy whole-room RPCs (any signature).
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('get_room', 'save_room')
  loop
    execute format('drop function if exists %s', fn.signature);
  end loop;
end $$;

-- 2. Park the legacy mirror table out of the way (data preserved, access cut).
--    The canonical public.rooms from 0001 has owner_user_id; the legacy mirror
--    does not, which is how the two shapes are told apart.
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'rooms'
  )
  and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'rooms' and column_name = 'owner_user_id'
  ) then
    if exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = 'legacy_room_mirror'
    ) then
      -- Abort rather than continue: 0001 creates public.rooms with
      -- CREATE TABLE IF NOT EXISTS, so carrying on would leave the legacy
      -- shape in place and silently skip the canonical table.
      raise exception 'reconciliation conflict: public.rooms still has the legacy shape but public.legacy_room_mirror already exists; resolve the two by hand before re-running';
    else
      alter table public.rooms rename to legacy_room_mirror;
      alter table public.legacy_room_mirror enable row level security;
      revoke all on table public.legacy_room_mirror from anon, authenticated;
      raise notice 'legacy public.rooms mirror renamed to public.legacy_room_mirror';
    end if;
  end if;
end $$;

-- 3. The legacy "posters" bucket must not stay world-readable. (The canonical
--    bucket is the private "room-assets" from 0001, guarded by membership.)
do $$
begin
  update storage.buckets set public = false where id = 'posters';
exception
  when undefined_table then null; -- not running on Supabase storage
end $$;
