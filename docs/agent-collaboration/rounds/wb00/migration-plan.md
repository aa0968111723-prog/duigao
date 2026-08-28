# PR-01 Migration 計畫 — canonical whiteboard schema（全部 additive）

基準：0014 現況（見 WHITEBOARD_AUDIT §4 逐欄對照）。原則：能延伸就延伸，
不重建同概念；每條可回滾（additive-only：新欄有 default、新表獨立）；
RLS 全部 USING＋WITH CHECK 走既有 `can_collaborate_on_board`；上線前跑
database advisors 與 migrations.mjs 五角色探針。

## 0021_whiteboard_canonical_columns

```
alter table whiteboard_nodes
  add column if not exists rotation double precision not null default 0
    check (rotation >= -360 and rotation <= 360),
  add column if not exists z_index integer not null default 0,
  add column if not exists locked boolean not null default false,
  add column if not exists source_version_id uuid,       -- 指 versions.id，補 provenance
  add column if not exists anchor jsonb,                  -- ContextAnchor 序列化（單一權威在 src/lib/contextAnchor）
  add column if not exists updated_by uuid references auth.users(id) on delete set null;
-- 成對約束（audit 缺口）：type 與 id 同 null / 同非 null
alter table whiteboard_nodes add constraint whiteboard_nodes_link_pair
  check ((linked_entity_type is null) = (linked_entity_id is null)) not valid;
-- not valid + 後續 validate：不鎖表、舊髒列另行清（PR-01 附清理查詢與計數證據）

alter table whiteboard_edges
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists created_by uuid references auth.users(id) on delete set null,
  add column if not exists version integer not null default 1 check (version >= 1),
  add column if not exists source_handle text,   -- 'top|right|bottom|left|auto'（CHECK）
  add column if not exists target_handle text,
  add column if not exists label_style jsonb;    -- 既有 label text 保留
create trigger whiteboard_edges_touch before update on whiteboard_edges
  for each row execute function touch_whiteboard_edge();  -- 複製 node 版 stale-write 語意
```

- 不改 node_type CHECK（新 node 型別走 PR-02 的 registry；DB 端以
  0022 擴充詞彙，同 migration 內附既有值不受影響證明）。
- linked_entity_type 詞彙擴充（'discussion' 已在 8 詞彙裡 — 訊息
  provenance **不需要新遷移**，是 client 端 createSticky 補寫的事）。

## 0022_whiteboard_frames

獨立表（不複用 group node — group 是選取聚合，frame 是空間容器，語意
不同；audit：parent_group_id 無 FK 無索引，一併補）：

```
create table whiteboard_frames (
  id uuid primary key default gen_random_uuid(),
  whiteboard_id uuid not null,
  room_id uuid not null references rooms(id) on delete cascade,
  title text not null default '' check (char_length(title) <= 120),
  x/y double precision not null default 0,
  width/height double precision not null check (> 0 and <= 8000),
  kind text not null default 'frame'
    check (kind in ('frame','zone','swimlane','kanban-column','vote-area',
                    'status-needs-review','status-needs-changes','status-approved','parking-lot')),
  style jsonb not null default '{}',
  z_index integer not null default -1,   -- frame 永遠墊底
  created_by / created_at / updated_at / version（同 node 慣例＋touch trigger）,
  foreign key (whiteboard_id, room_id) 複合對 whiteboards(id, room_id) cascade
);
alter table whiteboard_nodes add column if not exists frame_id uuid
  references whiteboard_frames(id) on delete set null;
create index on whiteboard_nodes (frame_id) where frame_id is not null;
alter table whiteboard_nodes
  add constraint whiteboard_nodes_parent_group_fk
  foreign key (parent_group_id) references whiteboard_nodes(id) on delete set null not valid;
```

RLS 四條齊（select=is_room_member；insert/update/delete=
can_collaborate_on_board）＋realtime publication＋replica identity full。

## 0023_whiteboard_operations（append-only）

```
create table whiteboard_operations (
  id bigint generated always as identity primary key,
  whiteboard_id uuid not null,
  room_id uuid not null references rooms(id) on delete cascade,
  actor_user_id uuid not null,
  op_type text not null check (op_type in
    ('node-create','node-update','node-delete','node-move','edge-create',
     'edge-update','edge-delete','frame-create','frame-update','frame-delete',
     'board-arrange','bulk-restore')),
  entity_id uuid not null,
  payload jsonb not null default '{}',   -- 逆操作所需最小 before/after（不含媒體 bytes）
  created_at timestamptz not null default now()
);
```

- **不是第二個 truth**（ADR-014）：undo/redo 與版本歷史讀它，套用仍走
  row upsert＋OCC。actor 冒名防護沿 0019 稽核表模式
  （`actor_user_id = auth.uid()` WITH CHECK、append-only：無 update/delete
  授權）。保留策略：per-board 上限＋定期修剪（PR-04 議題，先入表）。
- client 寫入時機：與 row 寫入同一批（非 trigger — trigger 拿不到
  逆操作 payload；漏寫 op 只損失 undo 粒度，不損資料正確性 — 誠實記錄
  此取捨）。

## 0024_whiteboard_versions（快照）

```
create table whiteboard_versions (
  id uuid primary key default gen_random_uuid(),
  whiteboard_id / room_id（複合 FK 同上）,
  label text not null default '',
  snapshot jsonb not null,          -- {nodes, edges, frames} 全量（bounded：節點數上限檢查）
  created_by uuid not null, created_at timestamptz not null default now()
);
```

手動/里程碑快照（AI apply 前自動一張 — PR-06），非連續歷史；連續粒度
由 operations 承擔。RLS：select=is_room_member、insert=can_collaborate、
**無 update**（快照不可變）、delete=can_manage_media。

## Tombstone（ADR-011 併決，0021 內）

```
alter table whiteboard_nodes add column if not exists deleted_at timestamptz;
```

delete 改 soft（update deleted_at → 經過 touch trigger 的 OCC 檢查，
關掉「離線 delete 蓋掉線上編輯」缺口）；讀側 where deleted_at is null；
硬刪由 30 天修剪工作處理（先入文件，排程屬 PR-04）。既有 client
deleteNode 在 PR-01 同步改為 soft delete 寫入（相容期：realtime DELETE
binding 保留，soft-delete 走 UPDATE binding 天然到達）。

## presence（決策：不落表）

cursor/selection presence 走既有 `room:${roomId}` channel 的 broadcast
（throttle ≥80ms、payload ≤ {userId,x,y,sel[]}），沿 0014:783 邊界。
presentation_state 表保留現狀（presenter mode 屬 PR-04 之後）。

## 驗證計畫

- migrations.mjs 新增 0021–0024 探針章：五角色（owner/editor/reviewer/
  stranger/anon）× 每表 CRUD 矩陣、edges stale-write、frames 複合 FK、
  operations 冒名/append-only、versions 不可變、soft-delete OCC、
  冪等重跑 shape 不變。
- database advisors 跑一輪，重大項清零或記錄豁免理由。
- 正式站套用順序：PR-01 合併後 0021→0024 逐條 verbatim apply＋
  行數/RLS 驗證（沿用既有部署紀律）。
