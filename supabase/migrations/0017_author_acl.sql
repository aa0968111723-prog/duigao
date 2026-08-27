-- ============================================================================
-- Author ACL for shared library assets and visual proposals.
--
-- Shared library UPDATE/DELETE previously allowed any owner/editor of *any*
-- room to mutate every shared row. Visual proposals used a FOR ALL member
-- policy plus a SECURITY DEFINER upsert that only checked membership, so a
-- reviewer could overwrite anyone's proposal.
-- ============================================================================

-- Stamp created_by on insert so shared-row ownership is real.
create or replace function public.stamp_library_asset_author()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.created_by is null then
    new.created_by := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  end if;
  return new;
end;
$$;

drop trigger if exists library_assets_stamp_author on public.library_assets;
create trigger library_assets_stamp_author
  before insert on public.library_assets
  for each row execute function public.stamp_library_asset_author();

revoke execute on function public.stamp_library_asset_author() from public, anon, authenticated;

drop policy if exists library_assets_update on public.library_assets;
create policy library_assets_update on public.library_assets
  for update to authenticated
  using (
    (scope = 'room' and room_id is not null and public.can_manage_media(room_id))
    or (scope = 'shared' and created_by = auth.uid())
  )
  with check (
    (scope = 'room' and room_id is not null and public.can_manage_media(room_id))
    or (scope = 'shared' and created_by = auth.uid() and room_id is null)
  );

drop policy if exists library_assets_delete on public.library_assets;
create policy library_assets_delete on public.library_assets
  for delete to authenticated
  using (
    (scope = 'room' and room_id is not null and public.can_manage_media(room_id))
    or (scope = 'shared' and created_by = auth.uid())
  );

drop policy if exists visual_proposals_all on public.visual_proposals;
drop policy if exists visual_proposals_select on public.visual_proposals;
drop policy if exists visual_proposals_insert on public.visual_proposals;
drop policy if exists visual_proposals_update on public.visual_proposals;
drop policy if exists visual_proposals_delete on public.visual_proposals;

create policy visual_proposals_select on public.visual_proposals
  for select to authenticated
  using (public.is_room_member(room_id));

create policy visual_proposals_insert on public.visual_proposals
  for insert to authenticated
  with check (public.is_room_member(room_id) and author_user_id = auth.uid());

create policy visual_proposals_update on public.visual_proposals
  for update to authenticated
  using (public.can_manage_media(room_id) or author_user_id = auth.uid())
  with check (public.is_room_member(room_id) and (public.can_manage_media(room_id) or author_user_id = auth.uid()));

create policy visual_proposals_delete on public.visual_proposals
  for delete to authenticated
  using (public.can_manage_media(room_id) or author_user_id = auth.uid());

create or replace function public.upsert_visual_proposal(
  p_id uuid,
  p_room_id uuid,
  p_version_id uuid,
  p_author_name text,
  p_name text,
  p_payload jsonb,
  p_expected_revision integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_current integer;
  v_author uuid;
begin
  if v_uid is null or not public.is_room_member(p_room_id) then
    raise exception 'not a room member';
  end if;

  select revision, author_user_id into v_current, v_author from public.visual_proposals where id = p_id;

  if v_current is null then
    insert into public.visual_proposals (id, room_id, version_id, author_user_id, author_name, name, payload, revision)
    values (p_id, p_room_id, p_version_id, v_uid, coalesce(p_author_name, '夥伴'), coalesce(p_name, '提案'), coalesce(p_payload, '{}'::jsonb), 1);
    return 1;
  end if;

  if v_author is distinct from v_uid and not public.can_manage_media(p_room_id) then
    raise exception 'not the proposal author';
  end if;

  if p_expected_revision is not null and v_current <> p_expected_revision then
    raise exception 'revision conflict (current=%)', v_current using errcode = 'P0001';
  end if;

  update public.visual_proposals
    set name = coalesce(p_name, name),
        payload = coalesce(p_payload, payload),
        version_id = p_version_id,
        revision = v_current + 1,
        updated_at = now()
    where id = p_id;
  return v_current + 1;
end;
$$;

revoke all on function public.upsert_visual_proposal(uuid, uuid, uuid, text, text, jsonb, integer) from public, anon;
grant execute on function public.upsert_visual_proposal(uuid, uuid, uuid, text, text, jsonb, integer) to authenticated;
