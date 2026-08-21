-- ============================================================================
-- 文宣討論區 — SECURITY DEFINER ACL hardening
--
-- Supabase may add direct EXECUTE grants for anon/authenticated when functions
-- are created. `REVOKE ... FROM PUBLIC` alone is therefore insufficient.
-- This migration explicitly removes direct anon/authenticated access from
-- maintenance/trigger functions, then grants only the minimum app surface.
-- ============================================================================

-- Start from an explicit deny for every SECURITY DEFINER helper introduced by
-- this project. service_role/postgres grants are intentionally left untouched.
revoke execute on function public.archive_version(uuid) from public, anon, authenticated;
revoke execute on function public.can_manage_media(uuid) from public, anon, authenticated;
revoke execute on function public.create_room_with_invite(uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.get_share_preview(uuid) from public, anon, authenticated;
revoke execute on function public.get_share_preview_v2(uuid) from public, anon, authenticated;
revoke execute on function public.guard_comment_delete() from public, anon, authenticated;
revoke execute on function public.guard_media_write() from public, anon, authenticated;
revoke execute on function public.guard_room_update() from public, anon, authenticated;
revoke execute on function public.guard_version_delete() from public, anon, authenticated;
revoke execute on function public.is_room_member(uuid) from public, anon, authenticated;
revoke execute on function public.is_room_owner(uuid) from public, anon, authenticated;
revoke execute on function public.join_room_by_invite(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.orphaned_room_assets(interval) from public, anon, authenticated;
revoke execute on function public.purge_orphaned_room_assets(interval, integer) from public, anon, authenticated;
revoke execute on function public.restore_version(uuid) from public, anon, authenticated;
revoke execute on function public.room_asset_orphan_count(interval) from public, anon, authenticated;
revoke execute on function public.room_role(uuid) from public, anon, authenticated;
revoke execute on function public.rotate_room_invite(uuid, text) from public, anon, authenticated;
revoke execute on function public.set_member_role(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.set_room_default_role(uuid, text) from public, anon, authenticated;
revoke execute on function public.upsert_visual_proposal(uuid, uuid, uuid, text, text, jsonb, integer) from public, anon, authenticated;
revoke execute on function public.version_has_discussion(uuid) from public, anon, authenticated;

-- Signed-in app surface. Supabase anonymous sign-in issues an authenticated JWT,
-- so the pre-login `anon` role is not needed for room operations.
grant execute on function public.archive_version(uuid) to authenticated;
grant execute on function public.can_manage_media(uuid) to authenticated;
grant execute on function public.create_room_with_invite(uuid, text, text, text, text) to authenticated;
grant execute on function public.is_room_member(uuid) to authenticated;
grant execute on function public.is_room_owner(uuid) to authenticated;
grant execute on function public.join_room_by_invite(uuid, text, text, text) to authenticated;
grant execute on function public.restore_version(uuid) to authenticated;
grant execute on function public.room_role(uuid) to authenticated;
grant execute on function public.rotate_room_invite(uuid, text) to authenticated;
grant execute on function public.set_member_role(uuid, uuid, text) to authenticated;
grant execute on function public.set_room_default_role(uuid, text) to authenticated;
grant execute on function public.upsert_visual_proposal(uuid, uuid, uuid, text, text, jsonb, integer) to authenticated;
grant execute on function public.version_has_discussion(uuid) to authenticated;

-- The only intentionally public SECURITY DEFINER projection: social crawlers
-- need share-card metadata before any user session exists.
grant execute on function public.get_share_preview(uuid) to anon, authenticated;
grant execute on function public.get_share_preview_v2(uuid) to anon, authenticated;

-- Deliberately NO grants to anon/authenticated for:
--   orphaned_room_assets
--   room_asset_orphan_count
--   purge_orphaned_room_assets
--   guard_* trigger functions
-- They remain maintenance/internal surfaces only.
