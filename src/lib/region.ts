import type { AnnotationRegion, Point } from "./types";

/** Breathing room added around the raw gesture bounds so the box never hugs the strokes. */
const PADDING = 0.015;
/** Below this (both axes, pre-padding) a gesture is treated as an accidental tap. */
const ACCIDENTAL = 0.01;
/** Final regions are never thinner than this, so a straight line still yields a visible box. */
const MIN_SIZE = 0.025;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Collapse a freehand circling gesture into its bounding box: pad a little,
 * enforce a minimum size (a straight line still becomes a usable area) and
 * clamp into the poster's 0..1 space. Returns null for accidental taps so no
 * junk feedback is ever created from a stray touch.
 */
export function regionFromPoints(points: Point[]): AnnotationRegion | null {
  if (points.length < 3) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;

  const rawW = maxX - minX;
  const rawH = maxY - minY;
  if (rawW < ACCIDENTAL && rawH < ACCIDENTAL) return null;

  let x = minX - PADDING;
  let y = minY - PADDING;
  let width = rawW + PADDING * 2;
  let height = rawH + PADDING * 2;

  // Grow to the minimum size around the center, so tiny-but-deliberate
  // gestures (e.g. underlining one word) still produce a tappable box.
  if (width < MIN_SIZE) {
    x -= (MIN_SIZE - width) / 2;
    width = MIN_SIZE;
  }
  if (height < MIN_SIZE) {
    y -= (MIN_SIZE - height) / 2;
    height = MIN_SIZE;
  }

  // Shift back inside the poster before clamping, so edge gestures keep their size.
  width = Math.min(width, 1);
  height = Math.min(height, 1);
  x = clamp01(Math.min(x, 1 - width));
  y = clamp01(Math.min(y, 1 - height));

  return { x, y, width, height };
}

export function regionCenter(region: AnnotationRegion): Point {
  return { x: region.x + region.width / 2, y: region.y + region.height / 2 };
}

/**
 * Validate a region coming from outside the app (cloud rows, old local data).
 * Repairs what it can by clamping; anything unusable becomes null so the
 * comment gracefully falls back to its x/y point.
 */
export function normalizeRegion(value: unknown): AnnotationRegion | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const x = Number(v.x);
  const y = Number(v.y);
  const width = Number(v.width);
  const height = Number(v.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (width <= 0 || height <= 0) return null;

  const w = Math.min(width, 1);
  const h = Math.min(height, 1);
  const cx = clamp01(Math.min(Math.max(x, 0), 1 - w));
  const cy = clamp01(Math.min(Math.max(y, 0), 1 - h));
  return { x: cx, y: cy, width: w, height: h };
}
