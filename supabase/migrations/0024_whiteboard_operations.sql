-- 0023 — whiteboard_operations：append-only 操作事件（WB01，ADR-014）。
--
-- 不是第二個 truth：套用順序由 row state＋OCC 決定；本表承擔 undo/redo
-- 與版本歷史的「誰在何時做了什麼」。與 row 寫入非原子（PostgREST 兩次
-- REST）— 兩種缺口都是明示取捨（Grok wb00 F2）：
--   op 缺（row 成 op 敗）＝undo 粒度損失，不損資料正確性；
--   幽靈 op（op 成 row 敗）＝undo 端以 field_mask 限制傷害面 — inverse
--   永不整列還原，只回寫 mask 內欄位、帶當前 acked version 走 OCC。
-- op_id 由 client 產生、unique — 失敗重試冪等（duplicate-key = ack）。

create table if not exists public.whiteboard_operations (
  id bigint generated always as identity primary key,
  op_id uuid not null,
  whiteboard_id uuid not null,
  room_id uuid not null references public.rooms(id) on delete cascade,
  actor_user_id uuid not null,
  op_type text not null check (op_type in (
    'node-create','node-update','node-delete','node-move',
    'edge-create','edge-update','edge-delete',
    'frame-create','frame-update','frame-delete',
    'board-arrange','bulk-restore')),
  entity_id uuid not null,
  field_mask text[] not null default '{}',
  before jsonb not null default '{}'::jsonb check (jsonb_typeof(before) = 'object'),
  after jsonb not null default '{}'::jsonb check (jsonb_typeof(after) = 'object'),
  created_at timestamptz not null default now(),
  unique (op_id),
  foreign key (whiteboard_id, room_id) references public.whiteboards(id, room_id) on delete cascade
);

create index if not exists idx_whiteboard_operations_board
  on public.whiteboard_operations (whiteboard_id, id desc);
create index if not exists idx_whiteboard_operations_entity
  on public.whiteboard_operations (entity_id, id desc);

-- RLS：append-only。actor 冒名防護沿 0019 稽核表模式。
alter table public.whiteboard_operations enable row level security;
drop policy if exists whiteboard_operations_select on public.whiteboard_operations;
create policy whiteboard_operations_select on public.whiteboard_operations
  for select to authenticated using (public.is_room_member(room_id));
drop policy if exists whiteboard_operations_insert on public.whiteboard_operations;
create policy whiteboard_operations_insert on public.whiteboard_operations
  for insert to authenticated
  with check (
    actor_user_id = (select auth.uid())
    and public.can_collaborate_on_board(room_id, whiteboard_id)
  );
-- 無 update / delete policy；grant 也不給 — 雙層 append-only。

revoke all on public.whiteboard_operations from anon;
-- 預設 privilege 會把 update/delete 也 grant 給 authenticated；append-only
-- 必須顯式收回（無 policy 時 update 只是 0 列 no-op，不是拒絕 — 假象）。
revoke update, delete on public.whiteboard_operations from authenticated;
grant select, insert on public.whiteboard_operations to authenticated;

-- 不加入 realtime publication：op 流由寫入端自己知道、他端經 row-patch
-- 看見結果；歷史頁用查詢。避免 26 個 binding 的 channel 再膨脹。
