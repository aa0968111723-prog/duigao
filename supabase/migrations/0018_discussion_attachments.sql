-- ============================================================================
-- 0018 — 討論附件（Universal Intake）＋ library_assets insert 殘洞（PR-01b）
--
-- (a) room_discussion_messages 增加兩個 kind：
--       'attachment' — 檔案卡（pdf／音訊／文件），payload.path 指向
--                      room-assets 的 attachments 前綴、payload.mime 必填。
--       'link'       — 純 URL 卡，payload.href 必填，無 storage 物件。
--     訊息表的 insert RLS 已是 is_room_member（0014），不需要動 —
--     reviewer 本來就能發討論訊息，附件只是新的訊息形狀。
-- (b) room-assets 新增一條「房間成員可寫、只限 attachments 前綴」的
--     INSERT policy。permissive policies 之間是 OR：versions/videos/proposals
--     仍由 0007 的 room_assets_insert 鎖在 can_manage_media；UPDATE／DELETE
--     完全不加新 policy — 0007 已把它們限制在 can_manage_media，所以
--     上傳者（含 reviewer）永遠不能改寫或刪除已上傳的附件物件
--     （原稿不可變：附件是 add-only）。
-- (c) 0016 的 library_assets_insert 殘洞（#47／0017 只修了 update/delete）：
--     shared-scope insert 必須綁 created_by = auth.uid()，擋掉明寫別人
--     uuid 的冒名 insert（0017 的 stamp trigger 只補 NULL）。
--
-- 附件前綴刻意「不」納入 0009 的孤兒盤點（0009 只掃 versions/videos）：
-- 附件由 room_discussion_messages.payload 參照、不掛在 versions 上，
-- 掃進去反而會把成員上傳的檔案當孤兒清掉 — 與 proposals 同一個豁免理由。
-- 路徑帶 messageId（rooms/<room>/attachments/<messageId>/<assetId>.<ext>），
-- 未來要做 reaper 時可據以對帳。
-- ============================================================================

-- (a) kind CHECK：0014 的 inline constraint 自動名稱是
--     room_discussion_messages_kind_check；重建全集（重跑冪等）。
alter table public.room_discussion_messages
  drop constraint if exists room_discussion_messages_kind_check;
alter table public.room_discussion_messages
  add constraint room_discussion_messages_kind_check check (kind in (
    'text', 'quote', 'image', 'room_asset', 'poster', 'video', 'plan',
    'poll', 'whiteboard', 'node', 'decision',
    'attachment',
    'link'
  ));

-- 資料衛生：attachment 一定要有 path＋mime；link 一定要有 href。
-- （size／name 是顯示用的 client 主張，不在資料庫層擔保。）
alter table public.room_discussion_messages
  drop constraint if exists room_discussion_attachment_payload;
alter table public.room_discussion_messages
  add constraint room_discussion_attachment_payload check (
    (kind <> 'attachment' or (payload ? 'path' and payload ? 'mime'))
    and (kind <> 'link' or payload ? 'href')
  );

-- (b) 成員可寫的附件前綴：rooms/<room>/attachments/<messageId>/<assetId>.<ext>
drop policy if exists room_assets_attachments_insert on storage.objects;
create policy room_assets_attachments_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'room-assets'
    and public.is_room_member(((storage.foldername(name))[2])::uuid)
    and (storage.foldername(name))[1] = 'rooms'
    and (storage.foldername(name))[3] = 'attachments'
  );
-- 不加 update/delete policy：沿用 0007 的 can_manage_media（附件 add-only）。
-- SELECT 不用加：0001 的成員讀取 policy 已涵蓋整個 bucket。

-- (c) library_assets shared-insert：綁 created_by。
--     0017 的 BEFORE INSERT trigger 會把 NULL 補成 auth.uid()，policy 的
--     WITH CHECK 看的是 trigger 之後的列，所以這裡直接要求相等即可；
--     保留 is null 分支讓 policy 不依賴 trigger 順序也讀得通。
drop policy if exists library_assets_insert on public.library_assets;
create policy library_assets_insert on public.library_assets
  for insert to authenticated
  with check (
    (scope = 'room' and room_id is not null and public.can_manage_media(room_id))
    or (
      scope = 'shared'
      and room_id is null
      and (created_by is null or created_by = auth.uid())
      and exists (
        select 1 from public.room_members m
        where m.user_id = auth.uid() and m.role in ('owner', 'editor')
      )
    )
  );
