-- ============================================================================
-- 文宣討論區 — 房間能力模型（reviewer / editor / owner）
--
-- 問題：在這個 migration 之前，每一條 RLS policy 都只問一件事——
-- `public.is_room_member(room_id)`。角色欄位存在（'owner' | 'editor'）卻沒有任何
-- policy 讀它，而 `join_room_by_invite` 一律發 'editor'。實際後果是：任何拿到
-- 分享連結、只輸入一個名字的人，都可以上傳影片版本、刪除別人的版本、改版本名稱、
-- 刪除別人的留言，以及覆寫 Storage 裡任何一支影片的物件。對「請大家幫我看一下」
-- 這種分享情境，這是錯的預設。
--
-- 三個刻意的設計選擇：
--
--   1. **能力而不是帳號**。角色是「這個房間裡你能做什麼」，存在 room_members 上。
--      匿名登入的 UX 一個字都不改：使用者仍然只輸入名字。沒有註冊、沒有密碼、
--      沒有跨房間身分。
--
--   2. **既有房間行為零變化**。已經加入的人保有原本的角色（owner/editor 都還能
--      管理版本），而既有房間的 `default_member_role` 一律回填 'editor'——也就是
--      這些房間的新成員仍然是編輯者，跟今天一模一樣。只有「之後新開的房間」預設
--      發 reviewer。安全的預設只往前套用，不追溯破壞正在進行的協作。
--
--   3. **收緊寫入，不收緊閱讀與討論**。reviewer 讀得到房間全部內容，能留言、回覆、
--      支持、標記狀態（resolve）——這是他被邀請來做的事。被擋住的只有「改動媒體
--      版本本身」：上傳、刪除、改名、重排、以及對應的 Storage 物件寫入。
--
-- 另外修掉一個真正的權限提升漏洞：`room_members_update_self` 原本允許使用者更新
-- 自己那一列的任何欄位——包含 `role`。也就是 reviewer 可以把自己 UPDATE 成 owner。
-- 新的 policy 把 role/room_id/user_id 釘死，只留 display_name/color/last_seen_at。
--
-- Idempotent：可重複套用（scripts/e2e/migrations.mjs 會刻意重跑）。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 角色本身
-- ---------------------------------------------------------------------------

alter table public.room_members
  drop constraint if exists room_members_role_check;
alter table public.room_members
  add constraint room_members_role_check check (role in ('owner', 'editor', 'reviewer'));

comment on column public.room_members.role is
  'owner：房主，可管理成員與邀請連結。editor：可管理媒體版本。reviewer：可讀、可留言／回覆／支持／標記狀態，不能改動版本。';

-- 新房間預設發哪一種角色。既有房間回填 'editor'，行為與今天完全相同；
-- 這個 migration 之後建立的房間預設 'reviewer'。
alter table public.rooms
  add column if not exists default_member_role text not null default 'editor';

alter table public.rooms
  drop constraint if exists rooms_default_member_role_check;
alter table public.rooms
  add constraint rooms_default_member_role_check
  check (default_member_role in ('editor', 'reviewer'));

comment on column public.rooms.default_member_role is
  '透過分享連結加入的人拿到的角色。既有房間回填 editor（不改變既有行為）；新房間由 create_room_with_invite 寫入 reviewer。';

-- ---------------------------------------------------------------------------
-- 能力查詢
--
-- 兩個都是 SECURITY DEFINER，理由與 is_room_member 相同：policy 內要讀
-- room_members，不能再遞迴進 room_members 自己的 RLS。
-- ---------------------------------------------------------------------------

create or replace function public.room_role(p_room_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
    from public.room_members m
   where m.room_id = p_room_id
     and m.user_id = auth.uid()
   limit 1;
$$;

revoke all on function public.room_role(uuid) from public;
grant execute on function public.room_role(uuid) to authenticated;

comment on function public.room_role(uuid) is
  '呼叫者在這個房間的角色；不是成員則為 null。';

/*
 * 能不能改動媒體版本。
 *
 * 刻意寫成「role 不是 reviewer」而不是「role in (owner, editor)」：未來若新增
 * 其他可管理的角色，只需要在 reviewer 這個唯讀清單上做決定，不必回頭改每一條
 * policy。null（非成員）本來就會被 is_room_member 擋掉，這裡也回 false。
 */
create or replace function public.can_manage_media(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.room_members m
     where m.room_id = p_room_id
       and m.user_id = auth.uid()
       and m.role <> 'reviewer'
  );
$$;

revoke all on function public.can_manage_media(uuid) from public;
grant execute on function public.can_manage_media(uuid) to authenticated;

comment on function public.can_manage_media(uuid) is
  '呼叫者能否新增／刪除／修改這個房間的媒體版本（owner 或 editor）。';

create or replace function public.is_room_owner(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.rooms r
     where r.id = p_room_id
       and r.owner_user_id = auth.uid()
  );
$$;

revoke all on function public.is_room_owner(uuid) from public;
grant execute on function public.is_room_owner(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 堵住自我升級
-- ---------------------------------------------------------------------------

drop policy if exists room_members_update_self on public.room_members;
create policy room_members_update_self on public.room_members
  for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    -- 只能改自己的顯示資訊；角色與歸屬欄位必須與現況一致，
    -- 否則 reviewer 一次 UPDATE 就能把自己變成 owner。
    and role = public.room_role(room_id)
  );

-- 房主可以調整同房間其他人的角色（透過下面的 RPC；policy 讓 RPC 以外的直接
-- UPDATE 仍然只有房主能做）。
drop policy if exists room_members_update_by_owner on public.room_members;
create policy room_members_update_by_owner on public.room_members
  for update to authenticated
  using (public.is_room_owner(room_id))
  with check (public.is_room_owner(room_id) and role in ('owner', 'editor', 'reviewer'));

-- ---------------------------------------------------------------------------
-- 版本：所有成員可讀，只有 owner/editor 可寫
--
-- 拆成四條而不是一條 `for all`，因為 reviewer 必須讀得到版本才能討論。
-- ---------------------------------------------------------------------------

drop policy if exists versions_all on public.versions;

drop policy if exists versions_select on public.versions;
create policy versions_select on public.versions
  for select to authenticated using (public.is_room_member(room_id));

drop policy if exists versions_insert on public.versions;
create policy versions_insert on public.versions
  for insert to authenticated with check (public.can_manage_media(room_id));

drop policy if exists versions_update on public.versions;
create policy versions_update on public.versions
  for update to authenticated
  using (public.can_manage_media(room_id))
  with check (public.can_manage_media(room_id));

drop policy if exists versions_delete on public.versions;
create policy versions_delete on public.versions
  for delete to authenticated using (public.can_manage_media(room_id));

-- ---------------------------------------------------------------------------
-- 留言：討論是 reviewer 的本業，唯一收緊的是「刪掉別人的話」
--
-- UPDATE 仍然開放給所有成員：標記狀態（resolve）本來就是大家一起做的事，
-- 而留言內容的作者欄位由既有欄位保存，不因誰按了 resolve 而改變。
-- ---------------------------------------------------------------------------

drop policy if exists comments_all on public.comments;

drop policy if exists comments_select on public.comments;
create policy comments_select on public.comments
  for select to authenticated using (public.is_room_member(room_id));

drop policy if exists comments_insert on public.comments;
create policy comments_insert on public.comments
  for insert to authenticated with check (public.is_room_member(room_id));

drop policy if exists comments_update on public.comments;
create policy comments_update on public.comments
  for update to authenticated
  using (public.is_room_member(room_id))
  with check (public.is_room_member(room_id));

-- 只有作者本人或可管理媒體的人（owner/editor）能刪留言。
-- author_user_id 在 0004 之後就存在；舊資料若為 null，交給 owner/editor 收拾。
drop policy if exists comments_delete on public.comments;
create policy comments_delete on public.comments
  for delete to authenticated
  using (
    public.is_room_member(room_id)
    and (author_user_id = auth.uid() or public.can_manage_media(room_id))
  );

-- ---------------------------------------------------------------------------
-- Storage：讀給成員，寫給 owner/editor
--
-- 版本的影片與封面都在 rooms/<room-id>/… 底下，(storage.foldername(name))[2]
-- 仍然是房間 id。reviewer 讀得到（要播放），但不能上傳、覆寫或刪除任何物件——
-- 這同時堵住「reviewer 覆寫別人版本的影片」與「reviewer 塞大檔進私有 bucket」。
-- ---------------------------------------------------------------------------

/*
 * 寫入除了要有身分，路徑也必須是這個 App 真的會用的三種形狀之一。
 *
 * 原本的 policy 只看 [2] 是不是房間 id，也就是 `rooms/<room>/隨便什麼/…` 都收。
 * 對一個已經是成員的人來說，那等於一個 200MB 上限的私人檔案倉庫，而且它會被
 * 孤兒盤點（0009）視為「不屬於任何版本」而永遠對不起來。限制在 versions /
 * videos / proposals，前端本來就只寫這三種（assets.ts、videoAssets.ts）。
 */
drop policy if exists room_assets_insert on storage.objects;
create policy room_assets_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'room-assets'
    and public.can_manage_media(((storage.foldername(name))[2])::uuid)
    and (storage.foldername(name))[1] = 'rooms'
    and (storage.foldername(name))[3] in ('versions', 'videos', 'proposals')
  );

drop policy if exists room_assets_update on storage.objects;
create policy room_assets_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'room-assets'
    and public.can_manage_media(((storage.foldername(name))[2])::uuid)
  )
  with check (
    bucket_id = 'room-assets'
    and public.can_manage_media(((storage.foldername(name))[2])::uuid)
  );

drop policy if exists room_assets_delete on storage.objects;
create policy room_assets_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'room-assets'
    and public.can_manage_media(((storage.foldername(name))[2])::uuid)
  );

-- ---------------------------------------------------------------------------
-- 分享卡片：讀給成員，建立／換圖／撤銷給 owner/editor
--
-- 發一張對外的卡片，等於決定「這個房間長什麼樣子被傳出去」，而且縮圖 bucket
-- 是公開的。這是房間主人的決定，不是被邀來看片的人的決定。reviewer 仍然看得到
-- 目前有沒有卡片（select），只是不能自己發、換圖或撤銷。
-- ---------------------------------------------------------------------------

drop policy if exists share_previews_all on public.share_previews;

drop policy if exists share_previews_select_members on public.share_previews;
create policy share_previews_select_members on public.share_previews
  for select to authenticated using (public.is_room_member(room_id));

drop policy if exists share_previews_write on public.share_previews;
create policy share_previews_write on public.share_previews
  for insert to authenticated with check (public.can_manage_media(room_id));

drop policy if exists share_previews_modify on public.share_previews;
create policy share_previews_modify on public.share_previews
  for update to authenticated
  using (public.can_manage_media(room_id))
  with check (public.can_manage_media(room_id));

drop policy if exists share_previews_remove on public.share_previews;
create policy share_previews_remove on public.share_previews
  for delete to authenticated using (public.can_manage_media(room_id));

-- 縮圖物件跟著同一條規則。SELECT policy 保持 0005 的樣子（PostgreSQL 在
-- DELETE 檢查欄位時會套用 SELECT policy，拿掉它會讓刪除靜默失敗）。
drop policy if exists share_previews_insert on storage.objects;
create policy share_previews_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'share-previews'
    and exists (
      select 1 from public.share_previews sp
      where sp.id = ((storage.foldername(name))[1])::uuid
        and public.can_manage_media(sp.room_id)
    )
  );

drop policy if exists share_previews_update on storage.objects;
create policy share_previews_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'share-previews'
    and exists (
      select 1 from public.share_previews sp
      where sp.id = ((storage.foldername(name))[1])::uuid
        and public.can_manage_media(sp.room_id)
    )
  )
  with check (
    bucket_id = 'share-previews'
    and exists (
      select 1 from public.share_previews sp
      where sp.id = ((storage.foldername(name))[1])::uuid
        and public.can_manage_media(sp.room_id)
    )
  );

drop policy if exists share_previews_delete on storage.objects;
create policy share_previews_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'share-previews'
    and exists (
      select 1 from public.share_previews sp
      where sp.id = ((storage.foldername(name))[1])::uuid
        and public.can_manage_media(sp.room_id)
    )
  );

-- ---------------------------------------------------------------------------
-- RPC：房主調整角色與預設角色
-- ---------------------------------------------------------------------------

create or replace function public.set_member_role(
  p_room_id uuid,
  p_user_id uuid,
  p_role text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_owner uuid;
begin
  if v_uid is null then
    raise exception 'auth required';
  end if;
  if p_role not in ('editor', 'reviewer') then
    -- 房主身分綁在 rooms.owner_user_id 上，不能靠改這張表轉移。
    raise exception 'invalid role';
  end if;

  select owner_user_id into v_owner from public.rooms where id = p_room_id;
  if v_owner is null or v_owner <> v_uid then
    raise exception 'not room owner';
  end if;
  if p_user_id = v_owner then
    raise exception 'cannot demote the room owner';
  end if;

  update public.room_members
     set role = p_role
   where room_id = p_room_id
     and user_id = p_user_id;
  if not found then
    raise exception 'not a room member';
  end if;
end;
$$;

revoke all on function public.set_member_role(uuid, uuid, text) from public;
grant execute on function public.set_member_role(uuid, uuid, text) to authenticated;

create or replace function public.set_room_default_role(p_room_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'auth required';
  end if;
  if p_role not in ('editor', 'reviewer') then
    raise exception 'invalid role';
  end if;
  update public.rooms
     set default_member_role = p_role, updated_at = now()
   where id = p_room_id and owner_user_id = v_uid;
  if not found then
    raise exception 'not room owner';
  end if;
end;
$$;

revoke all on function public.set_room_default_role(uuid, text) from public;
grant execute on function public.set_room_default_role(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 加入房間時發房間指定的角色
--
-- 只覆寫 join 這一支：create_room_with_invite 仍然把建立者寫成 owner。
-- `on conflict do update` 刻意不碰 role——重新點一次連結不會把 editor 降級，
-- 也不會把房主降成 reviewer。
-- ---------------------------------------------------------------------------

create or replace function public.join_room_by_invite(
  p_room_id uuid,
  p_invite_token text,
  p_display_name text,
  p_color text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_stored text;
  v_candidate text;
  v_role text;
begin
  if v_uid is null then
    raise exception 'auth required';
  end if;

  select invite_hash, coalesce(default_member_role, 'editor')
    into v_stored, v_role
    from public.rooms
   where id = p_room_id and archived_at is null;
  -- 不透露房間是否存在：任何失敗都回同一個訊息。
  if v_stored is null then
    raise exception 'invalid invite';
  end if;
  v_candidate := encode(extensions.digest(coalesce(p_invite_token, ''), 'sha256'), 'hex');
  if v_candidate <> v_stored then
    raise exception 'invalid invite';
  end if;

  insert into public.room_members (room_id, user_id, display_name, color, role)
  values (
    p_room_id,
    v_uid,
    coalesce(nullif(p_display_name, ''), '夥伴'),
    coalesce(nullif(p_color, ''), '#c45c4a'),
    v_role
  )
  on conflict (room_id, user_id) do update
    set display_name = excluded.display_name,
        color = excluded.color,
        last_seen_at = now();

  return p_room_id;
end;
$$;

/*
 * 建立房間。
 *
 * 這一版修掉一個真正的接管漏洞：原本 `rooms` 的 INSERT 是
 * `on conflict (id) do nothing`，但後面那句寫 room_members 的 INSERT 是無條件的。
 * 也就是說，只要 p_room_id 指向一個「已經存在的別人的房間」，rooms 這邊安靜地
 * 什麼都不做（owner_user_id、invite_hash 原封不動，看起來毫無異狀），
 * 而呼叫者仍然被寫成那個房間的 **owner**。邀請碼在這條路徑上從頭到尾只被檢查
 * 長度，沒有被比對過——比對只存在於 join_room_by_invite。
 *
 * 而 room id 的保護程度**低於**邀請碼：邀請碼只出現在網址片段與 POST body，
 * room id 卻出現在每一個 PostgREST 查詢字串裡，更關鍵的是它就寫在 Storage 物件
 * 路徑中（rooms/<room-id>/videos/…）。任何人把一張海報或影片的網址複製出去，
 * 就等於把 room id 交出去了，卻沒有交出邀請碼。
 *
 * 修法：房間已存在時，只有原房主本人可以繼續（讓「重試建立」這種正常情況照舊），
 * 其他人一律回與其他失敗相同的 'invalid invite'，不透露房間是否存在。
 *
 * 新房間預設只發 reviewer；房主要找共同編輯者，在成員清單升級即可。
 */
create or replace function public.create_room_with_invite(
  p_room_id uuid,
  p_title text,
  p_invite_token text,
  p_display_name text,
  p_color text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_hash text;
  v_id uuid := coalesce(p_room_id, extensions.gen_random_uuid());
  v_owner uuid;
begin
  if v_uid is null then
    raise exception 'auth required';
  end if;
  if p_invite_token is null or length(p_invite_token) < 16 then
    raise exception 'invalid invite';
  end if;
  v_hash := encode(extensions.digest(p_invite_token, 'sha256'), 'hex');

  insert into public.rooms (id, owner_user_id, title, invite_hash, default_member_role)
  values (
    v_id,
    v_uid,
    coalesce(nullif(p_title, ''), '未命名文案'),
    v_hash,
    'reviewer'
  )
  on conflict (id) do nothing;

  -- 房間已經存在而且不是我的 → 這不是「建立」，是別人的房間。
  select owner_user_id into v_owner from public.rooms where id = v_id;
  if v_owner is null or v_owner <> v_uid then
    raise exception 'invalid invite';
  end if;

  insert into public.room_members (room_id, user_id, display_name, color, role)
  values (v_id, v_uid, coalesce(nullif(p_display_name, ''), '夥伴'), coalesce(nullif(p_color, ''), '#c45c4a'), 'owner')
  on conflict (room_id, user_id) do update
    set display_name = excluded.display_name, color = excluded.color;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- rooms 的欄位保護
--
-- `rooms_update` 是一條沒有欄位限制的 policy（0001:159-160），任何成員都能
-- PATCH 整列。實際後果：把 owner_user_id 改成自己（奪取房主）、改寫 invite_hash
-- （廢掉房主的連結、換上自己的）、設 archived_at（讓所有人再也加不進來）、
-- 或翻掉 media_type（每個人的畫面都變成錯的工作區）。這些都繞過了
-- rotate_room_invite 裡那句 owner 檢查。
--
-- RLS 無法限制「哪些欄位可以被改」，所以規則寫成 trigger：身分與連結相關的欄位
-- 只有房主能動，其餘（標題、媒體型態）需要能管理媒體的身分。
-- ---------------------------------------------------------------------------

create or replace function public.guard_room_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- 沒有登入身分＝不是從 App 來的：migration 的資料修補、支援用的 psql 直連、
  -- service_role 後台。這些路徑本來就不受 RLS 約束（能執行就代表握有 DB 權限），
  -- trigger 若在這裡擋下去，只會讓維運無法修資料。
  if auth.uid() is null then
    return new;
  end if;

  if new.id is distinct from old.id
     or new.owner_user_id is distinct from old.owner_user_id
     or new.invite_hash is distinct from old.invite_hash
     or new.archived_at is distinct from old.archived_at
     or new.default_member_role is distinct from old.default_member_role then
    if not public.is_room_owner(old.id) then
      raise exception 'not room owner';
    end if;
  end if;

  if new.title is distinct from old.title
     or new.media_type is distinct from old.media_type then
    if not public.can_manage_media(old.id) then
      raise exception 'not allowed';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists rooms_guard_update on public.rooms;
create trigger rooms_guard_update
  before update on public.rooms
  for each row execute function public.guard_room_update();
