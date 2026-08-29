-- ============================================================================
-- 影片最佳化／相容化 metadata（PR #29）
--
-- 原檔 bytes 仍然不可變。若瀏覽器端產出相容代理，路徑寫在
-- optimized_video_path；播放端優先用代理，沒有才用 video_path。
-- 0006 也用 IF NOT EXISTS 加了同名欄位，這條給已經套過 0006 的正式庫。
-- ============================================================================

alter table public.versions
  add column if not exists optimized_video_path text;

alter table public.versions
  add column if not exists source_file_size bigint;

alter table public.versions
  add column if not exists optimized boolean not null default false;

comment on column public.versions.optimized_video_path is
  'Optional compatible proxy in room-assets: rooms/<room-id>/videos/<version-id>/optimized.mp4. Playback prefers this when present; original video_path is never rewritten.';

comment on column public.versions.source_file_size is
  'Byte size of the file the person picked, before any local optimize/transcode.';

comment on column public.versions.optimized is
  'True when the uploaded object is a locally optimized / transcoded proxy, not the raw camera file.';
