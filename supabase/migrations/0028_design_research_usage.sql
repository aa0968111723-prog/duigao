-- ---------------------------------------------------------------------------
-- 0028 — 外部研究使用量（PR-DI-03）
--
-- 為什麼需要這張表：配額如果算在前端，改一行 JS 就繞過了，而外部搜尋是**要
-- 付錢**的。帳單不會自己停，所以上限必須算在後端，而後端要有地方記。
--
-- 設計：**append-only**，而且 client 連 insert 都拿不到。
--
-- 這裡與 0019 的稽核表不同：0019 是「先 grant insert 再 revoke update/delete」
-- （client 寫得進去但改不掉）。使用量不能讓 client 寫 —— 讓 client 決定
-- 自己用了幾次，配額就形同虛設。所以這張表對 authenticated **只 grant
-- select**，寫入完全走 service_role（bypass RLS）。
--
-- 對抗審查指出檔頭原本抄了 0019 的說法，與底下的 SQL 不符 —— 已改正。
--
-- **不記錄查詢原文**，只記 SHA-256。理由：
--   * 配額只需要知道「發生過幾次」，不需要知道問了什麼。
--   * 查詢字串雖然已經過兩道出站掃描，但掃描是黑名單，總有漏網的。
--     不存原文，漏網的東西就不會沉澱在資料庫裡。
--   * 雜湊仍然足以做去重與「同一個問題被問了幾次」的統計。
--
-- 讀：房內成員可以看自己房間用了多少（使用者有權知道配額還剩多少）。
-- 寫：**沒有 client 政策** —— 只有 service_role（edge function）寫得進去。
--     讓 client 寫使用量，等於讓 client 自己決定用了幾次。
-- ---------------------------------------------------------------------------

create table if not exists public.design_research_usage (
  id uuid primary key default extensions.gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,

  -- SHA-256 十六進位，64 字元。不存查詢原文（見檔頭）。
  query_hash text not null check (char_length(query_hash) = 64),

  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  source_count integer not null default 0 check (source_count >= 0),

  -- 這次回來的內容命中了幾條 prompt injection 樣式。
  -- 用途不只是統計：某個房間的可疑計數突然升高，代表它引用的來源出了問題。
  suspicious_count integer not null default 0 check (suspicious_count >= 0),

  created_at timestamptz not null default now()
);

-- 配額查詢的路徑就是這個索引：某房間最近 24 小時的筆數
create index if not exists idx_design_research_usage_room_time
  on public.design_research_usage (room_id, created_at desc);

alter table public.design_research_usage enable row level security;

-- 讀：房內成員看得到自己房間的用量
drop policy if exists design_research_usage_select on public.design_research_usage;
create policy design_research_usage_select on public.design_research_usage
  for select to authenticated
  using (public.is_room_member(room_id));

-- 權限：**先全部收回再逐項給**。
--
-- Supabase 的 default privileges 對新表是 `grant all to anon, authenticated`。
-- 只做 `revoke insert, update, delete` 會留下 TRUNCATE —— 而 **RLS 不管
-- TRUNCATE**，任何登入者都能把整張使用量表清空，等於把所有人的配額歸零。
-- 這是 migration probe 誠實化之後實測到的（原本的 probe 用超級使用者，
-- 證明不了任何權限）。
revoke all on public.design_research_usage from anon, authenticated;
grant select on public.design_research_usage to authenticated;

-- 寫入只有 service_role。edge function 走這條路。
grant all on public.design_research_usage to service_role;
