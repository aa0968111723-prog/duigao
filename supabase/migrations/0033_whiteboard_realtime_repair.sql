-- Repair / deployment guard for whiteboard collaboration.
--
-- Older projects may have the whiteboard tables but missed their publication
-- state during an interrupted deployment. Postgres Changes then has no events:
-- work is only visible in the authoring tab and looks lost after a reload.
-- This is additive, keeps RLS intact, and does not touch existing board rows.

alter table public.whiteboards replica identity full;
alter table public.whiteboard_nodes replica identity full;
alter table public.whiteboard_edges replica identity full;

do $$
declare
  relation_name text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;

  foreach relation_name in array array[
    'public.whiteboards',
    'public.whiteboard_nodes',
    'public.whiteboard_edges'
  ]
  loop
    begin
      execute format('alter publication supabase_realtime add table %s', relation_name);
    exception when duplicate_object then
      -- Already published is the normal path for newly provisioned projects.
      null;
    end;
  end loop;
end;
$$;
