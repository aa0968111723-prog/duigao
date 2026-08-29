-- ============================================================================
-- 0022 — 討論訊息的作者完整性（PR-COMM-00）
--
-- 稽核（scripts/e2e/migrations.mjs「討論訊息作者完整性」節）用真實角色對真
-- PostgreSQL 打出來的兩個洞：
--
--   (a) reviewer 可以 insert 一列 author_user_id = <owner 的 uid> 的訊息。
--       0014 的 room_discussion_insert 只檢查 is_room_member(room_id)，
--       沒有把 author_user_id 綁在 auth.uid() 上。房間裡任何成員都能用
--       supabase-js 直接發一則「看起來是房主說的」訊息 —— 而訊息正是
--       「誰同意了什麼」的原始證據，決策與待辦都往回指它。
--
--   (b) can_manage_media 的人可以 UPDATE 別人訊息的 author_user_id。
--       0014 的 update policy 用 `author_user_id = auth.uid() or
--       can_manage_media(room_id)` 當 WITH CHECK，於是 owner/editor 改寫
--       作者之後 WITH CHECK 仍然成立 —— 作者身分可以被洗掉。
--
-- 0019 早就把「actor 冒名」當成必須擋下的類別（collaboration_audit_events
-- 的 with check 綁 actor_user_id = auth.uid()）。這支把同一條線補到訊息表。
--
-- 為什麼同時用 policy 與 trigger（不是只改 policy）：
--   0014 用 `drop policy if exists room_discussion_insert` + `create policy`
--   重建同名 policy，而 0014 是可重跑的。只改 policy 的話，任何一次 0014
--   replay 都會把這個洞原封不動放回來。trigger 的名字不在 0014 裡，replay
--   不會動它 —— 所以 trigger 是真正的護欄，policy 是把規則寫在它該在的
--   地方。本檔尾端的探針同時驗這兩件事，以及「replay 之後仍然擋得住」。
--
-- 為什麼 author_user_id 仍然允許 NULL：
--   本機房第一次分享時，roomRepository 會把整包討論搬上雲（
--   insertCollaborationSlice）。本機訪客的 id 是 `g_xxxx`，不是 auth.users
--   的 uuid，所以那些列的 author_user_id 只能是 NULL；強制 NOT NULL 會讓
--   「把本機房變成雲端房」整個失敗，而那是既有且正常的路徑。
--   NULL 的意思是「這列不屬於任何平台帳號」—— 它不能拿來冒充某個帳號，
--   這正是本檔要保住的性質。author_name 仍然是 client 的顯示主張（殘餘限制
--   記在 docs/team-communication/KNOWN_LIMITATIONS.md）。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (1) INSERT：author_user_id 只能是自己，或 NULL（不可歸屬）
-- ---------------------------------------------------------------------------

drop policy if exists room_discussion_insert on public.room_discussion_messages;
create policy room_discussion_insert on public.room_discussion_messages
  for insert to authenticated
  with check (
    public.is_room_member(room_id)
    and (author_user_id is null or author_user_id = (select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- (2) UPDATE：可以改內容，不可以改「誰在哪間房什麼時候說的」
--
-- WITH CHECK 看不到 OLD，所以欄位凍結只能用 trigger。凍結三個欄位：
--   author_user_id — 作者不可被改寫（含管理者）。
--   room_id        — 訊息不可被搬到另一間房（搬過去等於憑空出現在別的脈絡）。
--   created_at     — 時間線是回覆與未讀定位的依據，不可被重寫。
-- ---------------------------------------------------------------------------

create or replace function public.guard_discussion_message_write()
returns trigger
language plpgsql
-- security definer，與 public.is_room_member（0001）同一個理由：呼叫端是
-- `authenticated`，而 `authenticated` 沒有 schema auth 的 USAGE —— invoker
-- 版本會在 `auth.uid()` 上噴 "permission denied for schema auth"，而那個錯誤
-- 長得就像「擋下來了」。第一版正是這樣假綠：冒名的探針過了，但是**所有**
-- 討論訊息的 insert 都失敗，連正常發言都寫不進去。
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if tg_op = 'INSERT' then
    -- policy 已經擋一次；trigger 是 0014 replay 之後仍然存在的那一道。
    -- `is distinct from` 而不是 `<>`：呼叫端沒有身分（caller 為 NULL）時
    -- `<>` 會得到 NULL、IF 不成立、冒名就過了。
    if new.author_user_id is not null and new.author_user_id is distinct from caller then
      raise exception 'discussion-author-forged'
        using hint = '訊息的作者只能是自己。';
    end if;
    return new;
  end if;

  if new.author_user_id is distinct from old.author_user_id then
    raise exception 'discussion-author-immutable'
      using hint = '不能改變訊息的作者。';
  end if;
  if new.room_id is distinct from old.room_id then
    raise exception 'discussion-room-immutable'
      using hint = '不能把訊息搬到別的房間。';
  end if;
  if new.created_at is distinct from old.created_at then
    raise exception 'discussion-created-at-immutable'
      using hint = '不能改變訊息的發出時間。';
  end if;
  return new;
end;
$$;

comment on function public.guard_discussion_message_write() is
  '討論訊息的作者／房間／發出時間不可偽造也不可改寫（0022）。與 policy 重複是刻意的：0014 可重跑，replay 會重建它的 insert policy，trigger 不會被 replay 動到。';

-- trigger function 不需要被任何人直接呼叫（trigger 由系統呼叫，不看 EXECUTE）。
-- 沿用 0010／0017 的紀律：預設的 PUBLIC EXECUTE 一律收回。
revoke execute on function public.guard_discussion_message_write() from public, anon, authenticated;

drop trigger if exists room_discussion_guard_write on public.room_discussion_messages;
create trigger room_discussion_guard_write
  before insert or update on public.room_discussion_messages
  for each row execute function public.guard_discussion_message_write();

comment on policy room_discussion_insert on public.room_discussion_messages is
  '房間成員可發言，且只能以自己的身分發言（0022）。NULL = 不屬於任何平台帳號的匯入列。';
