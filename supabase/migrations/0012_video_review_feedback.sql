-- ============================================================================
-- 影片對稿 2.0 — 作者說明、時間回饋、快速反應、看完表態 (PR #32)
--
-- 目前的影片房只能「播放 + 時間點留言」。要成為真正能用的審片流程，缺的不是
-- 更多留言欄位，而是四件在留言之外的事：
--
--   1. 作者這一版想請大家看什麼      → version_review_briefs
--   2. 懶得打字時也要能表達          → video_reactions
--   3. 看完之後這版到底過不過        → version_verdicts
--   4. 到底有沒有人看過              → version_review_progress
--
-- 加上一件在留言之內的事：作者要能整理回饋的處理狀態（comments.review_status）。
--
-- 設計約束：
--
--   * **沿用既有的角色模型**，不另立第二套。0007 已經有 owner / editor /
--     reviewer 與 `can_manage_media()`；這裡直接重用，reviewer 能參與（留言、
--     反應、表態、回報進度），owner/editor 能管理（寫作者說明、改回饋狀態）。
--   * **每一版各自獨立**。brief / verdict / progress 都掛在 version_id 上，
--     初剪與二剪不會共用一份過期的說明或一份過期的表態。
--   * **不做行為監控**。progress 只存「最遠看到哪裡」與「看完了沒」，沒有
--     play/pause 事件、沒有裝置指紋、沒有觀看熱圖。這是刻意的產品決定，寫在
--     schema 註解裡，讓後來的人知道少的欄位不是忘了加。
--   * **comments 不重寫**。`resolved` 保持原樣並繼續運作，`review_status` 是
--     疊在它上面的四態，兩者由 trigger 保持同步（見下方）。舊 client 只讀
--     `resolved` 也不會看到錯的東西。
--   * 可重複套用。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 共用：回饋分類與四態
--
-- 影片的分類與圖片的 problem_type（文字／排版／圖片／顏色／資訊錯誤／其他）
-- 語義不同，但沒必要為此多開一欄——problem_type 本來就是自由文字加上前端的
-- 清單。這裡只把影片用的六類寫成註解，約束交給前端，資料庫保持寬鬆，
-- 免得未來調整分類就要一次 migration。
-- ---------------------------------------------------------------------------

comment on column public.comments.problem_type is
  '回饋分類。圖片房：文字／排版／圖片／顏色／資訊錯誤／其他。影片房：畫面／節奏／字幕／聲音／文案／其他。可為 null（不強迫分類才能送出）。';

-- ---------------------------------------------------------------------------
-- comments.review_status — 作者的整理狀態
--
-- 為什麼不直接把 resolved 換掉：`resolved` 是既有 client、既有 realtime
-- payload、既有 e2e 與既有 UI 都在讀的欄位。換掉它等於要求所有東西同時升級。
-- 所以四態是**新增**的，並且與 resolved 雙向同步：
--
--   review_status ∈ (open, doing, done, wontfix)
--   resolved = (review_status in ('done','wontfix'))
--
-- 任一邊被寫入，trigger 都會把另一邊補成一致。舊 client 送 resolved=true，
-- 讀到的是 done；新 client 送 wontfix，舊 client 看到的是「已完成」——語義上
-- 「不採用」確實也是「不用再處理了」，這是這兩個模型之間最誠實的對應。
-- ---------------------------------------------------------------------------

alter table public.comments
  add column if not exists review_status text not null default 'open';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'comments_review_status_check') then
    alter table public.comments
      add constraint comments_review_status_check
      check (review_status in ('open', 'doing', 'done', 'wontfix'));
  end if;
end;
$$;

comment on column public.comments.review_status is
  '作者整理狀態：open 待處理 / doing 處理中 / done 已修改 / wontfix 不採用。與 resolved 由 trigger 保持同步，舊 client 只讀 resolved 仍然正確。';

-- 既有資料回填：已完成的留言就是 done，其餘 open。
update public.comments
   set review_status = 'done'
 where resolved and review_status = 'open';

/*
 * 雙向同步。
 *
 * 只在「該邊真的變了」時才推另一邊，否則同時寫兩欄的 client 會被覆蓋回去：
 * 例如 UPDATE 同時帶 resolved=true 與 review_status='wontfix'，若無條件由
 * resolved 推導，wontfix 會被壓成 done。這裡讓明確寫入的那一欄贏。
 */
create or replace function public.sync_comment_review_status()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.review_status is distinct from 'open' then
      new.resolved := new.review_status in ('done', 'wontfix');
    else
      new.review_status := case when new.resolved then 'done' else 'open' end;
    end if;
    return new;
  end if;

  if new.review_status is distinct from old.review_status then
    -- 四態是比較細的那一邊，明確改它就以它為準。
    new.resolved := new.review_status in ('done', 'wontfix');
  elsif new.resolved is distinct from old.resolved then
    -- 舊 client 只翻 resolved：done ↔ open，不要把 wontfix 誤變成 done。
    if new.resolved then
      new.review_status := 'done';
    else
      new.review_status := 'open';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists comments_sync_review_status on public.comments;
create trigger comments_sync_review_status
  before insert or update on public.comments
  for each row execute function public.sync_comment_review_status();

/*
 * 誰能改狀態。
 *
 * 這裡有兩個模型要同時尊重，而它們的答案不一樣：
 *
 *   0007 明確寫著 reviewer「能留言、回覆、支持、**標記狀態（resolve）**——這是
 *   他被邀請來做的事」。所以 `resolved` 這個既有能力一步都不能收。
 *
 *   PR #32 要的是作者的**整理工作流**：處理中 / 不採用。一個 reviewer 不該能
 *   把別人提的問題標成「不採用」。
 *
 * 兩者的交集很乾淨：`open` 與 `done` 本來就能透過 resolved 達成，擋它們只會
 * 打破 0007 又換不到任何保護；真正新增的管理語義只有 `doing` 與 `wontfix`。
 * 所以 guard 只看這兩個值——最小的限制，剛好蓋住新增的權力。
 *
 * 寫成 trigger 而不是改 policy，是因為 policy 名稱散在舊 migration 裡，重放
 * 任何一支舊檔都會把放寬的版本裝回來（0010 的註解已經記過這個教訓）；trigger
 * 的名字只存在這裡。
 */
create or replace function public.guard_comment_status_write()
returns trigger
language plpgsql
-- DEFINER for the same reason 0007's guards are: the body reads auth.uid(),
-- and `authenticated` has no rights on the auth schema itself.
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return new;  -- service-role / maintenance path, same posture as 0007
  end if;
  if new.review_status is distinct from old.review_status
     and new.review_status in ('doing', 'wontfix') then
    -- 作者本人可以處理自己提的（例如自己收回），owner/editor 可以處理全部。
    if not (public.can_manage_media(new.room_id) or old.author_user_id = auth.uid()) then
      raise exception 'only the room owner or an editor may set 處理中／不採用';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists comments_guard_status on public.comments;
create trigger comments_guard_status
  before update on public.comments
  for each row execute function public.guard_comment_status_write();

revoke execute on function public.sync_comment_review_status() from public, anon, authenticated;
revoke execute on function public.guard_comment_status_write() from public, anon, authenticated;

create index if not exists idx_comments_review_status
  on public.comments (version_id, review_status);

-- ---------------------------------------------------------------------------
-- version_review_briefs — 作者這一版想請大家看什麼
--
-- 一版一列（version_id 是主鍵）。room_id 一起存，是為了讓 RLS 不必每次都
-- join versions 才知道要問哪個房間的成員資格；composite FK 保證兩者一致，
-- client 沒辦法把 A 房的 brief 掛到 B 房的版本上（同 0005 的手法）。
-- ---------------------------------------------------------------------------

create table if not exists public.version_review_briefs (
  version_id  uuid primary key,
  room_id     uuid not null references public.rooms (id) on delete cascade,
  body        text not null default '',
  -- 關注標籤與問題都是短清單，用 jsonb 存：它們是一起讀寫的整體，拆成關聯表
  -- 只會換來每次存檔多兩個 round trip，換不到任何查詢能力。
  focus_tags  jsonb not null default '[]'::jsonb,
  questions   jsonb not null default '[]'::jsonb,
  updated_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint version_review_briefs_version_in_room
    foreign key (version_id, room_id) references public.versions (id, room_id) on delete cascade,
  constraint version_review_briefs_shape check (
    jsonb_typeof(focus_tags) = 'array'
    and jsonb_typeof(questions) = 'array'
    and jsonb_array_length(questions) <= 3
  )
);

comment on table public.version_review_briefs is
  '每個影片版本的作者說明：想請大家看什麼、關注標籤、最多三個問題。一版一列，初剪與二剪不共用。';
comment on column public.version_review_briefs.questions is
  '最多三個問題的 jsonb 陣列。上限寫成 check constraint，因為「問到第七個」就不再是 brief 而是問卷。';

create index if not exists idx_version_review_briefs_room on public.version_review_briefs (room_id);

-- ---------------------------------------------------------------------------
-- video_reactions — 一鍵反應
--
-- 「同一個人、同一版、同一種反應、時間很近」只留一筆，否則連點三下就會在
-- timeline 上長出三顆一樣的點。用 bucket 欄位做這件事而不是靠 client 自律：
-- bucket = floor(time_seconds / 2)，配合 unique index，資料庫直接擋掉重複。
-- 兩秒是刻意選的——比人手連點快、比「這是另一個時間點」慢。
-- ---------------------------------------------------------------------------

create table if not exists public.video_reactions (
  id            uuid primary key default gen_random_uuid(),
  room_id       uuid not null references public.rooms (id) on delete cascade,
  version_id    uuid not null,
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  time_seconds  double precision not null check (time_seconds >= 0),
  reaction_type text not null,
  created_at    timestamptz not null default now(),
  constraint video_reactions_version_in_room
    foreign key (version_id, room_id) references public.versions (id, room_id) on delete cascade,
  constraint video_reactions_type_check
    check (reaction_type in ('ok', 'confused', 'slow', 'fast', 'fun', 'love'))
);

comment on table public.video_reactions is
  '影片上的一鍵反應（可以／看不懂／太慢／太快／有感／喜歡）。降低回饋門檻用，不強制打字也不強制暫停。';
comment on column public.video_reactions.reaction_type is
  'ok 可以 / confused 看不懂 / slow 太慢 / fast 太快 / fun 有感 / love 喜歡。存英文 key，顯示字串屬於前端。';

-- 連點防護：同一人同一版同一種反應，每 2 秒的桶子裡只能有一筆。
create unique index if not exists idx_video_reactions_dedupe
  on public.video_reactions (version_id, user_id, reaction_type, (floor(time_seconds / 2)));

create index if not exists idx_video_reactions_version_time
  on public.video_reactions (version_id, time_seconds);

-- ---------------------------------------------------------------------------
-- version_verdicts — 看完之後這版過不過
--
-- 三個語義，不是五顆星：審片要的是決定，不是評分。一人一版一列，可以改。
-- ---------------------------------------------------------------------------

create table if not exists public.version_verdicts (
  version_id uuid not null,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  room_id    uuid not null references public.rooms (id) on delete cascade,
  verdict    text not null check (verdict in ('pass', 'minor', 'revise')),
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (version_id, user_id),
  constraint version_verdicts_version_in_room
    foreign key (version_id, room_id) references public.versions (id, room_id) on delete cascade
);

comment on table public.version_verdicts is
  '看完後的表態：pass 可以過 / minor 小修即可 / revise 需要再調整。一人一版一列，可修改。刻意不做星等評分。';

create index if not exists idx_version_verdicts_version on public.version_verdicts (version_id);

-- ---------------------------------------------------------------------------
-- version_review_progress — 有沒有看過，大約看到哪
--
-- 只有兩個事實：最遠看到哪一秒、看完了沒。**這是上限，不是第一版。**
-- 不記每次 play/pause、不記裝置、不做觀看熱圖——團隊要知道的是「還有誰沒看」，
-- 不是「誰在第 37 秒倒帶了四次」。
-- ---------------------------------------------------------------------------

create table if not exists public.version_review_progress (
  version_id          uuid not null,
  user_id             uuid not null default auth.uid() references auth.users (id) on delete cascade,
  room_id             uuid not null references public.rooms (id) on delete cascade,
  max_watched_seconds double precision not null default 0 check (max_watched_seconds >= 0),
  completed_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (version_id, user_id),
  constraint version_review_progress_version_in_room
    foreign key (version_id, room_id) references public.versions (id, room_id) on delete cascade
);

comment on table public.version_review_progress is
  '每人每版的觀看進度，只存「最遠看到哪」與「看完了沒」。刻意不存 play/pause 事件、裝置資訊或觀看熱圖——這是給團隊看進度用的，不是行為監控。';

/*
 * 進度只准前進。
 *
 * 使用者拉回去重看一段是很正常的事，但那不代表「他只看到那裡」。若讓 client
 * 直接寫入現值，一次倒帶就會把 12 個人的進度統計弄成假的。
 */
create or replace function public.bump_review_progress()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    new.max_watched_seconds := greatest(old.max_watched_seconds, new.max_watched_seconds);
    new.completed_at := coalesce(old.completed_at, new.completed_at);
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists version_review_progress_bump on public.version_review_progress;
create trigger version_review_progress_bump
  before insert or update on public.version_review_progress
  for each row execute function public.bump_review_progress();

revoke execute on function public.bump_review_progress() from public, anon, authenticated;

-- updated_at 也要在 verdict 與 brief 上前進，讓「最後更新」是真的。
create or replace function public.touch_review_row()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists version_verdicts_touch on public.version_verdicts;
create trigger version_verdicts_touch
  before update on public.version_verdicts
  for each row execute function public.touch_review_row();

drop trigger if exists version_review_briefs_touch on public.version_review_briefs;
create trigger version_review_briefs_touch
  before update on public.version_review_briefs
  for each row execute function public.touch_review_row();

revoke execute on function public.touch_review_row() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RLS
--
-- 同一套規則，三種不同的權限形狀：
--
--   brief     讀：成員      寫：owner/editor（can_manage_media）
--   reaction  讀：成員      寫：成員，但只能寫自己的（user_id = auth.uid()）
--   verdict   讀：成員      寫：成員，只能寫自己的那一列
--   progress  讀：成員      寫：成員，只能寫自己的那一列
--
-- anon 一律沒有 policy，因此完全讀不到——分享卡片走的是 0005/0011 的公開投影，
-- 跟這四張表沒有任何交集。
-- ---------------------------------------------------------------------------

alter table public.version_review_briefs      enable row level security;
alter table public.video_reactions            enable row level security;
alter table public.version_verdicts           enable row level security;
alter table public.version_review_progress    enable row level security;

drop policy if exists version_review_briefs_read on public.version_review_briefs;
create policy version_review_briefs_read on public.version_review_briefs
  for select to authenticated
  using (public.is_room_member(room_id));

-- 寫入分成三條而不是一條 for all：insert 沒有 USING，update 需要兩邊都擋，
-- 合在一起寫很容易漏掉其中一半。
drop policy if exists version_review_briefs_insert on public.version_review_briefs;
create policy version_review_briefs_insert on public.version_review_briefs
  for insert to authenticated
  with check (public.can_manage_media(room_id));

drop policy if exists version_review_briefs_update on public.version_review_briefs;
create policy version_review_briefs_update on public.version_review_briefs
  for update to authenticated
  using (public.can_manage_media(room_id))
  with check (public.can_manage_media(room_id));

drop policy if exists version_review_briefs_delete on public.version_review_briefs;
create policy version_review_briefs_delete on public.version_review_briefs
  for delete to authenticated
  using (public.can_manage_media(room_id));

drop policy if exists video_reactions_read on public.video_reactions;
create policy video_reactions_read on public.video_reactions
  for select to authenticated
  using (public.is_room_member(room_id));

drop policy if exists video_reactions_insert on public.video_reactions;
create policy video_reactions_insert on public.video_reactions
  for insert to authenticated
  with check (public.is_room_member(room_id) and user_id = auth.uid());

-- 收回自己剛按的反應是合理的；收回別人的不是。
drop policy if exists video_reactions_delete on public.video_reactions;
create policy video_reactions_delete on public.video_reactions
  for delete to authenticated
  using (public.is_room_member(room_id) and user_id = auth.uid());

drop policy if exists version_verdicts_read on public.version_verdicts;
create policy version_verdicts_read on public.version_verdicts
  for select to authenticated
  using (public.is_room_member(room_id));

drop policy if exists version_verdicts_insert on public.version_verdicts;
create policy version_verdicts_insert on public.version_verdicts
  for insert to authenticated
  with check (public.is_room_member(room_id) and user_id = auth.uid());

drop policy if exists version_verdicts_update on public.version_verdicts;
create policy version_verdicts_update on public.version_verdicts
  for update to authenticated
  using (public.is_room_member(room_id) and user_id = auth.uid())
  with check (public.is_room_member(room_id) and user_id = auth.uid());

drop policy if exists version_review_progress_read on public.version_review_progress;
create policy version_review_progress_read on public.version_review_progress
  for select to authenticated
  using (public.is_room_member(room_id));

drop policy if exists version_review_progress_insert on public.version_review_progress;
create policy version_review_progress_insert on public.version_review_progress
  for insert to authenticated
  with check (public.is_room_member(room_id) and user_id = auth.uid());

drop policy if exists version_review_progress_update on public.version_review_progress;
create policy version_review_progress_update on public.version_review_progress
  for update to authenticated
  using (public.is_room_member(room_id) and user_id = auth.uid())
  with check (public.is_room_member(room_id) and user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Realtime：其他人的回饋要自己出現，不必重整
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'video_reactions'
    ) then
      alter publication supabase_realtime add table public.video_reactions;
    end if;
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'version_verdicts'
    ) then
      alter publication supabase_realtime add table public.version_verdicts;
    end if;
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'version_review_briefs'
    ) then
      alter publication supabase_realtime add table public.version_review_briefs;
    end if;
  end if;
end;
$$;
