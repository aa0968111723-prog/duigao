-- ============================================================================
-- 文宣討論區 — 版本封存（保護討論歷史）
--
-- 問題：`comments.version_id`、`comment_supports.version_id`、`strokes`、
-- `visual_proposals`、`share_previews` 全部是 `on delete cascade`
-- （0001:59/77/98、0002:35、0005:64）。也就是說今天刪掉一個版本，整串討論
-- ——留言、回覆、支持數、時間錨點、以及已經傳出去的分享卡片——會一起被靜靜
-- 刪除。這比留下孤兒更糟：孤兒至少救得回來。對「大家花一小時討論完的那一版」
-- 來說，一次誤觸就沒了，而且沒有任何提示。
--
-- 做法：把「刪除」變成兩件不同的事。
--
--   * 沒有人討論過的版本（沒有留言／支持／筆記／提案／分享卡）：維持硬刪除。
--     使用者上傳錯檔案想立刻重來，不該被迫留下垃圾。
--
--   * 只要有一則討論，硬刪除就被資料庫擋下來（trigger），必須改用封存。
--     封存的版本：資料全部保留、歷史討論照樣讀得到、Storage 物件不動，
--     但預設不出現在版本選單裡。
--
-- 這條規則寫在資料庫而不是前端，因為「不可以刪掉別人的討論」是資料完整性，
-- 不是 UI 禮貌。任何客戶端（包含還沒更新的舊版前端）都攔得住。
--
-- share preview 指向封存版本時不刪卡片、也不讓它壞掉：`get_share_preview`
-- 仍然回得出資料，並多回一個 `version_archived` 旗標讓前端安全降級。
--
-- Idempotent。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 欄位
-- ---------------------------------------------------------------------------

alter table public.versions
  add column if not exists archived_at timestamptz;

alter table public.versions
  add column if not exists archived_by uuid;

comment on column public.versions.archived_at is
  '封存時間。非 null 表示這一版預設不出現在版本選單，但歷史討論、時間錨點與 Storage 物件全部保留。';

-- 版本選單、預設載入與 share preview 都會用「這個房間還在檯面上的版本」來查。
create index if not exists idx_versions_room_active
  on public.versions (room_id, sort_order)
  where archived_at is null;

-- ---------------------------------------------------------------------------
-- 討論存在與否
--
-- 一個函式，兩個地方用（trigger 與 RPC），避免兩邊對「什麼算討論」的定義漂移。
-- SECURITY DEFINER：呼叫者可能沒有權限直接讀某些子表，但一定有權知道
-- 「這一版能不能刪」。
-- ---------------------------------------------------------------------------

create or replace function public.version_has_discussion(p_version_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  -- Only the tables that hang off the version DIRECTLY are listed: supports and
  -- replies hang off a comment, so a version with either necessarily has the
  -- comment too, and checking comments already covers them.
  select
    exists (select 1 from public.comments c where c.version_id = p_version_id)
    or exists (select 1 from public.strokes k where k.version_id = p_version_id)
    or exists (select 1 from public.visual_proposals p where p.version_id = p_version_id)
    or exists (select 1 from public.proposal_preferences f where f.version_id = p_version_id)
    or exists (select 1 from public.share_previews v where v.version_id = p_version_id);
$$;

revoke all on function public.version_has_discussion(uuid) from public;
grant execute on function public.version_has_discussion(uuid) to authenticated;

comment on function public.version_has_discussion(uuid) is
  '這一版身上是否掛著任何會被 cascade 刪掉的東西：留言（含其回覆與支持）、筆記、提案、提案偏好或分享卡。';

-- ---------------------------------------------------------------------------
-- 擋下會毀掉討論的硬刪除
--
-- 刻意用例外而不是靜默轉成封存：前端必須知道自己按錯了，才能把「封存」這個
-- 正確動作顯示給使用者。訊息用固定字串開頭，客戶端據此顯示人話。
-- ---------------------------------------------------------------------------

create or replace function public.guard_version_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- 同 0007 的理由：沒有登入身分＝維運路徑，不在這條護欄的守備範圍。
  if auth.uid() is null then
    return old;
  end if;
  if public.version_has_discussion(old.id) then
    raise exception 'version-has-discussion'
      using hint = '這一版已經有討論，請改用封存（archive_version），封存後歷史討論仍然讀得到。';
  end if;
  return old;
end;
$$;

drop trigger if exists versions_guard_delete on public.versions;
create trigger versions_guard_delete
  before delete on public.versions
  for each row execute function public.guard_version_delete();

-- ---------------------------------------------------------------------------
-- 封存 / 取消封存
--
-- 能力沿用 0007：可管理媒體的人（owner / editor）才能封存，reviewer 不行。
-- ---------------------------------------------------------------------------

create or replace function public.archive_version(p_version_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_room uuid;
  v_at timestamptz;
begin
  if v_uid is null then
    raise exception 'auth required';
  end if;
  select room_id into v_room from public.versions where id = p_version_id;
  if v_room is null then
    raise exception 'version not found';
  end if;
  if not public.can_manage_media(v_room) then
    raise exception 'not allowed';
  end if;

  update public.versions
     set archived_at = coalesce(archived_at, now()),
         archived_by = coalesce(archived_by, v_uid)
   where id = p_version_id
  returning archived_at into v_at;

  return v_at;
end;
$$;

revoke all on function public.archive_version(uuid) from public;
grant execute on function public.archive_version(uuid) to authenticated;

create or replace function public.restore_version(p_version_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_room uuid;
begin
  if v_uid is null then
    raise exception 'auth required';
  end if;
  select room_id into v_room from public.versions where id = p_version_id;
  if v_room is null then
    raise exception 'version not found';
  end if;
  if not public.can_manage_media(v_room) then
    raise exception 'not allowed';
  end if;

  update public.versions
     set archived_at = null, archived_by = null
   where id = p_version_id;
end;
$$;

revoke all on function public.restore_version(uuid) from public;
grant execute on function public.restore_version(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- share preview 的安全降級
--
-- 分享卡片已經傳出去了，指向的版本卻被封存——這在正式使用裡一定會發生。
-- 卡片不該 404，也不該假裝那一版還是現行版本：多回一個旗標，讓開啟連結的人
-- 看得到「這一版已封存」而不是一片空白。
--
-- 這裡是一個**新函式**，而不是改寫 0005 的那一支。理由是可重跑性：
-- scripts/e2e/migrations.mjs（以及任何重放 migration 的部署流程）會從 0001 依序
-- 再跑一次，若 0008 把 get_share_preview 的回傳型別換掉，第二輪跑到 0005 的
-- `create or replace` 就會撞上 "cannot change return type of existing function"
-- 而整條 migration 失敗。歷史 migration 一旦出門就不該再被後面的檔案破壞。
--
-- 0005 的安全不變式一併保留：匿名端仍然拿不到 room_id、version_id 或
-- created_by，preview id 依舊無法反推回房間。新增的只有一個布林值。
-- ---------------------------------------------------------------------------

create or replace function public.get_share_preview_v2(p_preview_id uuid)
returns table (
  title            text,
  description      text,
  image_path       text,
  updated_at       timestamptz,
  version_archived boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    sp.title,
    sp.description,
    case when sp.show_thumbnail then sp.thumbnail_path else null end as image_path,
    sp.updated_at,
    coalesce(v.archived_at is not null, false) as version_archived
  from public.share_previews sp
  left join public.versions v
    on v.id = sp.version_id and v.room_id = sp.room_id
  where sp.id = p_preview_id
    and sp.enabled
    and exists (select 1 from public.rooms r where r.id = sp.room_id and r.archived_at is null);
$$;

revoke all on function public.get_share_preview_v2(uuid) from public;
grant execute on function public.get_share_preview_v2(uuid) to anon, authenticated;

comment on function public.get_share_preview_v2(uuid) is
  '匿名可讀的分享卡片資料，多回一個 version_archived：true 時前端顯示「這一版已封存」，而不是把它當現行版本。仍然不回傳 room_id / version_id。舊的 get_share_preview 保持原樣，未更新的客戶端照常運作。';
