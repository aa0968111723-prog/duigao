# PR-01 Migration 計畫 — canonical whiteboard schema

基準：0014 現況（WHITEBOARD_AUDIT §4）。經 Grok wb00 輪修訂（F2/F3/F4/F5
全數採納 — 見 claude-adjudication.md）。

原則的誠實版：**欄位/表新增是 additive 可回滾；行為切換（soft-delete）
是 client-release 耦合的，不假裝可獨立回滾** — 以部署順序控制（先
migration 後 client；回滾 = 先回 client 再議欄位，欄位留著無害）。

## 0021_whiteboard_canonical_columns

```sql
-- nodes 補欄
alter table public.whiteboard_nodes
  add column if not exists rotation double precision not null default 0
    check (rotation >= -360 and rotation <= 360),
  add column if not exists z_index integer not null default 0
    check (z_index >= 0),                                   -- 節點層 ≥0（F5）
  add column if not exists locked boolean not null default false,
  add column if not exists source_version_id uuid
    references public.versions(id) on delete set null,       -- 補 FK（F4）
  add column if not exists anchor jsonb
    check (anchor is null or jsonb_typeof(anchor) = 'object'),
  add column if not exists updated_by uuid
    references auth.users(id) on delete set null,
  add column if not exists deleted_at timestamptz;           -- tombstone（見 §行為切換）

-- 成對約束：NOT VALID → 清理 → VALIDATE 三步全寫進 migration 檔註解，
-- 探針必驗 convalidated = true（F4：只驗存在會假綠）
alter table public.whiteboard_nodes add constraint whiteboard_nodes_link_pair
  check ((linked_entity_type is null) = (linked_entity_id is null)) not valid;
-- （PR-01 內附）select count(*) 髒列清理查詢＋
alter table public.whiteboard_nodes validate constraint whiteboard_nodes_link_pair;

-- edges 補欄＋OCC
alter table public.whiteboard_edges
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists created_by uuid references auth.users(id) on delete set null,
  add column if not exists version integer not null default 1 check (version >= 1),
  add column if not exists source_handle text
    check (source_handle is null or source_handle in ('top','right','bottom','left','auto')),
  add column if not exists target_handle text
    check (target_handle is null or target_handle in ('top','right','bottom','left','auto')),
  add column if not exists label_style jsonb;

-- F4：函式必須先定義（照抄 touch_whiteboard_node 語意）
create or replace function public.touch_whiteboard_edge()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.version < old.version then
    raise exception 'stale-write' using errcode = 'P0001';
  end if;
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end $$;
create trigger whiteboard_edges_touch before update on public.whiteboard_edges
  for each row execute function public.touch_whiteboard_edge();

-- get_whiteboard_context 同 migration 內重建：加 deleted_at is null 過濾（F3）
```

## 行為切換：tombstone（F3 全面修訂）

**寫側**：client `deleteNode` 改為 `update({deleted_at: now, version})` —
走既有 upsert 管線與 OCC trigger（離線 delete 蓋掉線上編輯的 ADR-011
缺口由此關閉）。**同一 migration 內 `revoke delete on whiteboard_nodes
from authenticated`**（REST 硬刪路徑物理封死，F3 repro 5；硬刪只剩
30 天修剪工作走 service role；edges 的 cascade 隨修剪發生）。

**讀側（逐路清單 — F3 指出的全部路徑，PR-01 逐一改＋各附測試）**：

1. `loadWhiteboardGraph`（collaborationRepository.ts:217）→ 查詢加
   `is('deleted_at', null)`。
2. `NodeRow`/`nodeFromRow`（:112-131）→ row shape 加 `deleted_at`。
3. **realtime patch 管線**（最關鍵）：`roomSync` 的 UPDATE binding →
   useCloudRoom 轉 patch 處，`deleted_at != null` 的 row **轉成
   node-delete patch**，不是 upsert（否則本地已刪節點被更高 version 的
   tombstone echo 復活 — F3 repro 2/3）。
4. `get_whiteboard_context` RPC → 0021 內重建加過濾（AI 不讀墓碑）。
5. IndexedDB `board_snapshots` reconcile → reconcileNodes 對
   deleted_at 節點視同刪除（快照可能存舊活列）。
6. e2e mock-supabase 的 whiteboard_nodes 查詢路徑同步支援
   `deleted_at=is.null` 過濾（否則 e2e 測不到真行為）。

**部署順序**：0021（欄位＋RPC 過濾＋revoke delete）→ client release
（soft-delete 寫側＋六條讀側）。順序倒置的故障模式與監測寫進 PR-01
描述。DELETE binding 保留一版（相容期舊 client 的硬刪仍到達新 client）。

## 0022_whiteboard_frames

同前版，修訂（F4/F5）：

- `z_index integer not null default -1 check (z_index < 0)` — 與節點
  `check (z_index >= 0)` 構成**不變式：frame 恆在節點之下**，不再是慣例。
- 繪製/命中的全序寫進 ADR-014：`(z_index, created_at, id)` 三鍵，render
  與 hit-test 共用一個排序 util（PR-02 落地＋unit test）。
- `parent_group_id` FK NOT VALID → 清理 → VALIDATE 三步；**環防護**：
  BEFORE INSERT/UPDATE trigger 沿 parent 鏈上溯（深度上限 32，見環即
  raise）— PG 的 FK 不防 A↔B（F4 repro 4）。
- group vs frame 層級語意（F5）：`frame_id` 決定空間歸屬與繪製分層；
  `parent_group_id` 只是選取聚合，**不參與 paint order**。
- realtime publication＋replica identity full＋回滾註記（drop from
  publication 的逆操作）— 0022/0023/0024 三表逐條明寫。

## 0023_whiteboard_operations（F2 全面修訂）

```sql
create table public.whiteboard_operations (
  id bigint generated always as identity primary key,
  op_id uuid not null,                       -- client 產生的冪等鍵
  whiteboard_id uuid not null,
  room_id uuid not null references public.rooms(id) on delete cascade,
  actor_user_id uuid not null,
  op_type text not null check (op_type in (...同前版...)),
  entity_id uuid not null,
  field_mask text[] not null default '{}',   -- 這個 op 動了哪些欄位
  before jsonb not null default '{}',        -- 僅 field_mask 內欄位的舊值
  after  jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (op_id)                             -- 重試冪等（F2：重複 op → undo 超射）
);
```

**與 truth 的關係（ADR-014 修訂同步）**：

- row 先寫、op 後寫，op 失敗進 durable 佇列以同 op_id 重試
  （unique 擋重複；duplicate-key = ack）。兩者非原子 — 誠實記錄兩種
  缺口：op 缺 = undo 粒度損失；row 缺 op 在 = **undo 端以 field_mask
  防護**（見下），不會把幽靈動作放大成資料錯誤。
- **undo 永不整列還原**（F2 repro 3 的根治）：inverse op 只回寫
  `field_mask` 內的欄位（node-move 只還 x/y），以「當前讀到的列＋
  mask 欄位替換」組 payload、帶當前 acked version 走同一條 OCC 管線；
  OCC 擋下就顯示可見衝突。B 的 content.text 永不被 A 的 move-undo 觸碰。
- content 內部（jsonb）欄位級：field_mask 允許 `content.text` 形式的
  路徑鍵；undo 以 jsonb path 替換，不整包換 content。

RLS：insert WITH CHECK `actor_user_id = auth.uid() AND
can_collaborate_on_board(room_id, whiteboard_id)`；select =
is_room_member；**無 update/delete**（append-only）。保留策略同前版。

## 0024_whiteboard_versions

同前版＋補：realtime 不加入 publication（快照不需要即時）；
`check (jsonb_array_length(snapshot->'nodes') <= 2000)` 上限；
回滾註記。

## 驗證計畫（F4/F8 對應收緊）

- migrations.mjs 新章除前版矩陣外必含：`convalidated=true` 斷言
  （link_pair/parent_group_fk）、touch_whiteboard_edge stale-write 實測、
  環防護（A↔B 互指 raise）、`z_index` 邊界（frame=0 拒、node=-1 拒）、
  op_id 重複插入拒、**tombstone 全讀路探針**（含 get_whiteboard_context
  不回墓碑 — F8 repro 5）、revoke delete 後 authenticated DELETE 被拒。
- reviewer 負向控制修正（F8）：can_collaborate_on_board 在
  `rooms.allow_board_edit=true` 時允許 reviewer 協作 — 探針寫**兩態**：
  allow_board_edit=false 時 reviewer 寫 operations 被拒；=true 時可寫
  但 actor 冒名仍拒。
- database advisors 重大項清零或逐條記錄豁免。
