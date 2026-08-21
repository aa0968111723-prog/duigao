-- ============================================================================
-- 文宣討論區 — Storage 孤兒盤點與安全清除
--
-- 問題：影片上傳是「先放物件、後寫資料列」（videoRoom.ts 的順序是刻意的：版本
-- 絕不能存在卻沒有影片）。失敗時客戶端會盡力把物件刪掉，但那是 best-effort：
-- 分頁被關掉、瀏覽器當掉、手機被系統回收、或那句 remove 本身失敗，物件就永遠
-- 留在私有 bucket 裡，沒有任何一列資料指向它。沒有人會再看它一眼，但它一直在
-- 佔容量，而且它是使用者的影片。
--
-- 這個 migration 不自動刪任何東西。自動刪除跑在「正在上傳」的物件上就是資料
-- 損毀，而 Storage 沒有給我們「這個上傳還活著嗎」的信號。它提供的是可以稽核、
-- 可以測試的三件事：
--
--   1. `orphaned_room_assets(interval)` — 盤點：哪些物件沒有任何 DB 參照。
--      預設寬限 24 小時，正在進行的上傳不會被算進來。
--   2. `room_asset_orphan_count(interval)` — 給測試與監控用的單一數字。
--   3. `purge_orphaned_room_assets(interval, int)` — 明確呼叫才會刪，有上限，
--      回傳實際刪掉的清單。維運用，不掛任何自動排程。
--
-- 可測的不變式（scripts/e2e/migrations.mjs 驗這一條）：
--   「room-assets 裡每一個物件，都必須被某一列 versions 的 video_path 或
--     image_path 指到；否則它就是孤兒，而正常流程結束後孤兒數必須是 0。」
--
-- 路徑是確定性的，這條不變式才可能成立：version id 在任何位元組移動之前就先在
-- 客戶端產生（App.tsx），同時成為物件資料夾與 versions.id。
--
-- Idempotent。
-- ============================================================================

create or replace function public.orphaned_room_assets(
  p_older_than interval default interval '24 hours'
)
-- 只回名字與時間：storage.objects 的 metadata 欄位在正式 Supabase 有、在測試用的
-- 精簡 storage schema 沒有，而盤點孤兒並不需要檔案大小（要的話 Storage API 查得到）。
returns table (
  name       text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    o.name,
    o.created_at
  from storage.objects o
  where o.bucket_id = 'room-assets'
    -- 還在寬限期內的物件可能正是此刻正在上傳的那一個。
    and o.created_at < now() - p_older_than
    and not exists (
      select 1 from public.versions v
       where v.video_path = o.name
          or v.image_path = o.name
    )
    -- 提案夾帶的圖片（rooms/<room>/proposals/…）由提案 payload 參照，
    -- 不在 versions 裡，這裡不視為孤兒。
    and (storage.foldername(o.name))[3] in ('videos', 'versions');
$$;

revoke all on function public.orphaned_room_assets(interval) from public;
-- 盤點是維運動作，不開放給一般使用者。service_role 走的是 RLS 之外的路徑，
-- 這裡不需要額外授權；authenticated 一律不給。
comment on function public.orphaned_room_assets(interval) is
  'room-assets 裡沒有任何 versions 參照、且已超過寬限期的物件。不會刪除任何東西。';

create or replace function public.room_asset_orphan_count(
  p_older_than interval default interval '24 hours'
)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::bigint from public.orphaned_room_assets(p_older_than);
$$;

revoke all on function public.room_asset_orphan_count(interval) from public;

comment on function public.room_asset_orphan_count(interval) is
  '孤兒物件數。正常流程跑完之後這個數字必須是 0——測試與監控都盯這一個值。';

/*
 * 真的刪掉。
 *
 * 兩道刻意的煞車：必須明確呼叫（沒有排程、沒有 trigger），而且一次最多刪
 * p_limit 個。回傳被刪掉的清單，讓維運可以留紀錄——刪掉的是別人的影片，
 * 「刪了什麼」必須說得出來。
 */
create or replace function public.purge_orphaned_room_assets(
  p_older_than interval default interval '7 days',
  p_limit int default 100
)
returns table (name text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with doomed as (
    select o.name
      from public.orphaned_room_assets(p_older_than) o
     order by o.created_at
     limit greatest(0, p_limit)
  )
  delete from storage.objects s
   using doomed d
   where s.bucket_id = 'room-assets'
     and s.name = d.name
  returning s.name;
end;
$$;

revoke all on function public.purge_orphaned_room_assets(interval, int) from public;

comment on function public.purge_orphaned_room_assets(interval, int) is
  '刪除確認沒有 DB 參照的 room-assets 物件。預設寬限 7 天、單次上限 100 個；必須手動呼叫。';
