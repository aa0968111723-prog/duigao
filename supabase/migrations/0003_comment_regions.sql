-- ============================================================================
-- 文宣討論區 — Comment regions (PR #14)
-- A comment may point at a circled AREA of the poster instead of a single
-- spot. The mobile 圈範圍 gesture is reduced to a normalized bounding box and
-- stored here; the freehand stroke itself is never persisted.
--
--   region: {"x": 0..1, "y": 0..1, "width": 0..1, "height": 0..1}
--   null  : the comment is a plain point (x/y), exactly as before.
--
-- Additive only. No changes to strokes (legacy data stays readable), no
-- backfill/conversion: the meaning of an old freehand stroke cannot be
-- inferred safely. RLS is inherited from the existing membership policy on
-- public.comments (comments_all), and comments is already published to
-- Realtime with replica identity full, so region changes sync unchanged.
-- ============================================================================

alter table public.comments
  add column if not exists region jsonb;

comment on column public.comments.region is
  'AnnotationRegion {x,y,width,height}, normalized 0..1 relative to the poster; null = point comment';

-- Cheap sanity check so malformed writes cannot poison every client render.
-- The client additionally clamps/validates on read (normalizeRegion).
alter table public.comments
  drop constraint if exists comments_region_shape;
alter table public.comments
  add constraint comments_region_shape check (
    region is null
    or (
      jsonb_typeof(region) = 'object'
      and jsonb_typeof(region->'x') = 'number'
      and jsonb_typeof(region->'y') = 'number'
      and jsonb_typeof(region->'width') = 'number'
      and jsonb_typeof(region->'height') = 'number'
    )
  );
