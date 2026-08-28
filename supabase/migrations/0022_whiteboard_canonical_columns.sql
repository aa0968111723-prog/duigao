-- 0021 — canonical whiteboard 欄位補齊（WB01，ADR-013/014）。
--
-- 全部 additive：新欄有 default、既有列不動。行為切換（soft-delete）是
-- client-release 耦合的 — 部署順序：本 migration 先（欄位＋RPC 過濾＋
-- revoke delete），client 讀寫側後。回滾 = 先回 client；欄位留著無害。
--
-- 對照 rounds/wb00/migration-plan.md（Grok wb00 F3/F4 修訂版）。

-- ---- whiteboard_nodes 補欄 ------------------------------------------------

alter table public.whiteboard_nodes
  add column if not exists rotation double precision not null default 0,
  add column if not exists z_index integer not null default 0,
  add column if not exists locked boolean not null default false,
  add column if not exists source_version_id uuid,
  add column if not exists anchor jsonb,
  add column if not exists updated_by uuid,
  add column if not exists deleted_at timestamptz;

-- CHECK 與 FK 分開加（add column if not exists 帶 constraint 在重跑時會撞名）
do $$
begin
  alter table public.whiteboard_nodes
    add constraint whiteboard_nodes_rotation_range check (rotation >= -360 and rotation <= 360);
exception when duplicate_object then null;
end $$;

-- 節點層恆 >= 0：與 frames（0022，恆 < 0）構成「frame 永遠墊底」的 DB 不變式
do $$
begin
  alter table public.whiteboard_nodes
    add constraint whiteboard_nodes_z_index_range check (z_index >= 0);
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.whiteboard_nodes
    add constraint whiteboard_nodes_anchor_object
    check (anchor is null or jsonb_typeof(anchor) = 'object');
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.whiteboard_nodes
    add constraint whiteboard_nodes_source_version_fk
    foreign key (source_version_id) references public.versions(id) on delete set null;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.whiteboard_nodes
    add constraint whiteboard_nodes_updated_by_fk
    foreign key (updated_by) references auth.users(id) on delete set null;
exception when duplicate_object then null;
end $$;

-- linked_entity_type/id 成對（audit 缺口）：NOT VALID → 清理 → VALIDATE。
-- 清理 UPDATE 會把半截 link 正規化為雙 null（半截 link 本來就不可導航，
-- 資訊量為零）；VALIDATE 隨後證明全表乾淨。註：因為先清理，validate
-- 不會失敗 — 它的角色是證明，不是守門（Grok wb01 F8 修正原註解）。
do $$
begin
  alter table public.whiteboard_nodes
    add constraint whiteboard_nodes_link_pair
    check ((linked_entity_type is null) = (linked_entity_id is null)) not valid;
exception when duplicate_object then null;
end $$;
update public.whiteboard_nodes
  set linked_entity_type = null, linked_entity_id = null
  where (linked_entity_type is null) <> (linked_entity_id is null);
alter table public.whiteboard_nodes validate constraint whiteboard_nodes_link_pair;

-- parent_group_id 一直沒有 FK 與索引（audit）：一併補
do $$
begin
  alter table public.whiteboard_nodes
    add constraint whiteboard_nodes_parent_group_fk
    foreign key (parent_group_id) references public.whiteboard_nodes(id) on delete set null not valid;
exception when duplicate_object then null;
end $$;
update public.whiteboard_nodes n
  set parent_group_id = null
  where parent_group_id is not null
    and not exists (select 1 from public.whiteboard_nodes p where p.id = n.parent_group_id);
alter table public.whiteboard_nodes validate constraint whiteboard_nodes_parent_group_fk;
create index if not exists idx_whiteboard_nodes_parent_group
  on public.whiteboard_nodes (parent_group_id) where parent_group_id is not null;

-- group 環防護（Grok wb00 F4：FK 不防 A↔B）。深度上限 32。
-- 誠實記錄（Grok wb01 F8）：兩個「並發」update 在 READ COMMITTED 下各自
-- 看不到對方，理論上仍可拼出環 — 防護目標是 client bug/一般誤用，不是
-- serializable 級保證；讀側的深度上限（32）保證即使成環也不會無窮迴圈。
create or replace function public.guard_group_cycle()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  cursor_id uuid := new.parent_group_id;
  depth integer := 0;
begin
  while cursor_id is not null loop
    if cursor_id = new.id then
      raise exception 'group-cycle' using hint = '群組不能互相包含。';
    end if;
    depth := depth + 1;
    if depth > 32 then
      raise exception 'group-depth' using hint = '群組層級過深。';
    end if;
    select parent_group_id into cursor_id from public.whiteboard_nodes where id = cursor_id;
  end loop;
  return new;
end;
$$;
drop trigger if exists whiteboard_nodes_group_cycle on public.whiteboard_nodes;
create trigger whiteboard_nodes_group_cycle
  before insert or update of parent_group_id on public.whiteboard_nodes
  for each row when (new.parent_group_id is not null)
  execute function public.guard_group_cycle();

-- ---- whiteboard_edges 補欄＋OCC（audit：edges 零 OCC、無 updated_at）------

alter table public.whiteboard_edges
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists created_by uuid,
  add column if not exists version integer not null default 1,
  add column if not exists source_handle text,
  add column if not exists target_handle text,
  add column if not exists label_style jsonb;

do $$
begin
  alter table public.whiteboard_edges
    add constraint whiteboard_edges_version_min check (version >= 1);
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.whiteboard_edges
    add constraint whiteboard_edges_source_handle
    check (source_handle is null or source_handle in ('top','right','bottom','left','auto'));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.whiteboard_edges
    add constraint whiteboard_edges_target_handle
    check (target_handle is null or target_handle in ('top','right','bottom','left','auto'));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.whiteboard_edges
    add constraint whiteboard_edges_created_by_fk
    foreign key (created_by) references auth.users(id) on delete set null;
exception when duplicate_object then null;
end $$;

-- edges 的 stale-write：與 touch_whiteboard_node 同語意（0014:441-455）
create or replace function public.touch_whiteboard_edge()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.version is distinct from old.version and new.version < old.version then
    raise exception 'stale-write' using hint = '這條連線剛被別人改過，請重新載入。';
  end if;
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists whiteboard_edges_touch on public.whiteboard_edges;
create trigger whiteboard_edges_touch
  before update on public.whiteboard_edges
  for each row execute function public.touch_whiteboard_edge();

-- ---- tombstone：硬刪路徑物理封死（Grok wb00 F3 repro 5）--------------------
-- client 的 deleteNode 改為 update deleted_at（帶 version、走 touch trigger
-- 的 OCC — ADR-011 的「離線 delete 蓋掉線上編輯」由此關閉）。REST DELETE
-- 對 authenticated 收回；硬刪只剩日後的修剪工作（service role）。
revoke delete on public.whiteboard_nodes from authenticated;
-- 0014 的 delete policy 刻意保留不 drop：grant 層的 revoke 已足以封死
-- （permission denied 先於 policy 評估），且 0014 若被 replay 也不會產生
-- policy 數量漂移（harness 的 0014 冪等探針實抓過這個衝突）。

-- 讀側索引：活列查詢是熱路徑
create index if not exists idx_whiteboard_nodes_live
  on public.whiteboard_nodes (whiteboard_id, updated_at desc)
  where deleted_at is null;

-- ---- get_whiteboard_context 重建：AI 不讀墓碑（Grok wb00 F3 repro 4）------
-- 逐字沿 0014:322-381，僅三處 where 各加 deleted_at 過濾；edges 以兩端
-- 節點皆活著為準。
create or replace function public.get_whiteboard_context(p_whiteboard_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    when w.id is null then null
    else jsonb_build_object(
      'whiteboard', jsonb_build_object(
        'id', w.id,
        'roomId', w.room_id,
        'title', w.title,
        'description', w.description,
        'archivedAt', w.archived_at,
        'updatedAt', w.updated_at
      ),
      'nodes', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', n.id,
          'nodeType', n.node_type,
          'x', n.x,
          'y', n.y,
          'width', n.width,
          'height', n.height,
          'content', n.content,
          'linkedEntityType', n.linked_entity_type,
          'linkedEntityId', n.linked_entity_id
        ) order by n.created_at)
        from public.whiteboard_nodes n
        where n.whiteboard_id = w.id
          and n.deleted_at is null
      ), '[]'::jsonb),
      'edges', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', e.id,
          'sourceNodeId', e.source_node_id,
          'targetNodeId', e.target_node_id,
          'edgeType', e.edge_type,
          'label', e.label
        ) order by e.created_at)
        from public.whiteboard_edges e
        where e.whiteboard_id = w.id
          and exists (select 1 from public.whiteboard_nodes s
                      where s.id = e.source_node_id and s.deleted_at is null)
          and exists (select 1 from public.whiteboard_nodes t
                      where t.id = e.target_node_id and t.deleted_at is null)
      ), '[]'::jsonb),
      'linkedEntities', coalesce((
        select jsonb_agg(jsonb_build_object(
          'nodeId', n.id,
          'entityType', n.linked_entity_type,
          'entityId', n.linked_entity_id
        ) order by n.created_at)
        from public.whiteboard_nodes n
        where n.whiteboard_id = w.id
          and n.deleted_at is null
          and n.linked_entity_id is not null
      ), '[]'::jsonb)
    )
  end
  from public.whiteboards w
  where w.id = p_whiteboard_id
    and public.is_room_member(w.room_id);
$$;

revoke all on function public.get_whiteboard_context(uuid) from public;
grant execute on function public.get_whiteboard_context(uuid) to authenticated;

-- 第二條 AI 讀路（Grok wb01 F3 抓漏）：選取節點的 context 同樣不讀墓碑。
-- 逐字沿 0014:386-415，僅 where 加 deleted_at 過濾。
create or replace function public.get_selected_board_context(p_whiteboard_id uuid, p_node_ids uuid[])
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    when w.id is null then null
    else jsonb_build_object(
      'whiteboardId', w.id,
      'roomId', w.room_id,
      'nodes', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', n.id,
          'nodeType', n.node_type,
          'content', n.content,
          'linkedEntityType', n.linked_entity_type,
          'linkedEntityId', n.linked_entity_id
        ) order by n.created_at)
        from public.whiteboard_nodes n
        where n.whiteboard_id = w.id
          and n.id = any(p_node_ids)
          and n.deleted_at is null
      ), '[]'::jsonb)
    )
  end
  from public.whiteboards w
  where w.id = p_whiteboard_id
    and public.is_room_member(w.room_id);
$$;

revoke all on function public.get_selected_board_context(uuid, uuid[]) from public;
grant execute on function public.get_selected_board_context(uuid, uuid[]) to authenticated;
