-- 0021 — Canva 同一設計的不同頁對應對稿版本（PR-05b）。
--
-- 一間房可以綁一份 Canva 設計；每一頁匯出成 versions 的一列。
-- page_id 是穩定身分（頁被拖動後頁碼會變）；page_number 只給人看。
-- 舊庫沒跑過這支時，欄位缺席，versionFromRow 當沒有 Canva 來源即可。

alter table public.versions
  add column if not exists canva_design_id text,
  add column if not exists canva_page_id text,
  add column if not exists canva_page_number integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'versions_canva_design_id_shape'
  ) then
    alter table public.versions
      add constraint versions_canva_design_id_shape
      check (canva_design_id is null or canva_design_id ~ '^[A-Za-z0-9_-]{1,80}$');
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'versions_canva_page_id_shape'
  ) then
    alter table public.versions
      add constraint versions_canva_page_id_shape
      check (canva_page_id is null or canva_page_id ~ '^[A-Za-z0-9_-]{1,80}$');
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'versions_canva_page_number_range'
  ) then
    alter table public.versions
      add constraint versions_canva_page_number_range
      check (canva_page_number is null or (canva_page_number >= 1 and canva_page_number <= 500));
  end if;
end $$;

create index if not exists versions_canva_design_id_idx
  on public.versions (room_id, canva_design_id)
  where canva_design_id is not null;
