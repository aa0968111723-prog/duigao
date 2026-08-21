-- ============================================================================
-- 分享卡片：影片／文宣分流 + 輕量自訂 (PR #30)
--
-- 兩個問題，同一張表解決：
--
-- 1. 卡片不知道自己在講什麼
--    影片房已經有 poster frame、有 share_previews row，可是卡片一旦沒有縮圖
--    （撤銷、關閉封面、查不到），就只會退回「文宣討論區」。對一支影片而言那是
--    錯的標籤。`media_type` 讓 Edge Function 在完全不知道 room 是誰的前提下，
--    仍然能挑對品牌字與通用封面。
--
-- 2. 分享內容不能自訂
--    房間叫「未命名影片」，但 LINE 上想寫「淡江招生短片｜第一剪」。這是兩件
--    事：卡片是對外的邀請，房間名是對內的檔案名。`title_customized` /
--    `description_customized` 記住「這句話是人自己寫的」，房間改名就不會把它
--    洗掉；反過來，沒被自訂過的卡片仍然跟著房間走。
--
-- `cover_source` 則是把原本只有開／關的 `show_thumbnail` 補成三態：
--    auto   跟著房間走（換版本會換成新的 poster frame）
--    custom 主辦方自己上傳的封面（換版本不准動它）
--    none   不顯示封面
-- `show_thumbnail` 保留並繼續維護（= cover_source <> 'none'），舊的
-- get_share_preview / _v2 因此完全不受影響。
--
-- 不變式（與 0005 相同，這裡一條都沒有放寬）：
--   * 不存 invite token，不存房間內容。
--   * 匿名端只能透過 get_share_preview* 讀，且永遠拿不到 room_id / version_id。
--   * 自訂封面是衍生縮圖，放在公開的 share-previews bucket；room-assets（原始
--     文宣與原始影片）仍然私有，這個檔案沒有碰它。
--   * 這支 migration 可以重複套用。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table public.share_previews
  add column if not exists media_type text not null default 'image',
  add column if not exists cover_source text not null default 'auto',
  add column if not exists title_customized boolean not null default false,
  add column if not exists description_customized boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'share_previews_media_type_check') then
    alter table public.share_previews
      add constraint share_previews_media_type_check check (media_type in ('image', 'video'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'share_previews_cover_source_check') then
    alter table public.share_previews
      add constraint share_previews_cover_source_check check (cover_source in ('auto', 'custom', 'none'));
  end if;
end;
$$;

comment on column public.share_previews.media_type is
  '這張卡片在講文宣還是影片。決定通用封面與品牌字；不透露房間身分。';
comment on column public.share_previews.cover_source is
  'auto=跟著版本的 poster/文宣；custom=主辦方上傳的封面，換版本不覆蓋；none=不顯示封面。';
comment on column public.share_previews.title_customized is
  'true 表示標題是人自己寫的，rooms.title 改名時不得覆蓋。';
comment on column public.share_previews.description_customized is
  'true 表示說明是人自己寫的，預設文案不得覆蓋。';

-- 既有資料補齊：0005/0006 時代的 row 只記得 show_thumbnail，那正是 auto/none。
update public.share_previews sp
   set cover_source = case when sp.show_thumbnail then 'auto' else 'none' end
 where sp.cover_source = 'auto' and not sp.show_thumbnail;

-- 影片房的既有卡片一次補上正確的 media_type，讓舊連結立刻拿到「影片對稿」而
-- 不是「文宣討論區」。以 rooms.media_type 為準（0006 建立的欄位）。
update public.share_previews sp
   set media_type = 'video'
  from public.rooms r
 where r.id = sp.room_id
   and r.media_type = 'video'
   and sp.media_type <> 'video';

-- ---------------------------------------------------------------------------
-- get_share_preview_v3
--
-- 為什麼是新函式而不是改 0005 那一支：跟 0008 同樣的理由。migration 會被整套
-- 重放，改掉舊函式的回傳型別會讓第二輪跑到 0005 的 `create or replace` 直接
-- 撞上 "cannot change return type of existing function"。歷史檔案出門之後就不
-- 該再被後面的檔案破壞，所以 v1 / v2 原樣保留，未更新的客戶端照常運作。
--
-- v3 相對 v2 多兩件事：
--   * media_type：Edge Function 才能在沒有卡片內容時挑對通用封面。
--   * 撤銷的卡片也回一列，但 title / description / image_path 全部為 null。
--     這是刻意的：撤銷後「看不到原本的標題」仍然成立（欄位是 null），但至少
--     還知道該用「影片對稿」還是「文宣討論區」當招牌。回傳的欄位一樣不含
--     room_id / version_id / created_by，preview id 依舊反推不回房間。
-- ---------------------------------------------------------------------------

create or replace function public.get_share_preview_v3(p_preview_id uuid)
returns table (
  title            text,
  description      text,
  image_path       text,
  media_type       text,
  updated_at       timestamptz,
  version_archived boolean,
  revoked          boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    case when sp.enabled then sp.title else null end as title,
    case when sp.enabled then sp.description else null end as description,
    case when sp.enabled and sp.show_thumbnail then sp.thumbnail_path else null end as image_path,
    sp.media_type,
    sp.updated_at,
    coalesce(v.archived_at is not null, false) as version_archived,
    not sp.enabled as revoked
  from public.share_previews sp
  left join public.versions v
    on v.id = sp.version_id and v.room_id = sp.room_id
  where sp.id = p_preview_id
    and exists (select 1 from public.rooms r where r.id = sp.room_id and r.archived_at is null);
$$;

-- 與 0010 同樣的收斂順序：先明確拒絕（Supabase 可能自動加上 anon/authenticated
-- 的直接 grant），再只授與這一支真正需要的公開讀取。
revoke all on function public.get_share_preview_v3(uuid) from public;
revoke execute on function public.get_share_preview_v3(uuid) from public, anon, authenticated;
grant execute on function public.get_share_preview_v3(uuid) to anon, authenticated;

comment on function public.get_share_preview_v3(uuid) is
  '匿名可讀的分享卡片資料，多回 media_type（image/video）與 revoked。撤銷後只剩 media_type，標題與縮圖為 null。仍然不回傳 room_id / version_id / created_by。';
