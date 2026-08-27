/**
 * Geometry for the review viewer.
 *
 * An annotation is always stored in the poster's normalized coordinate space.
 * These helpers are the only place where that space is converted to the
 * viewport's CSS pixels, which keeps zooming and hit-testing mathematically
 * symmetrical.
 */

export type ViewerSize = { w: number; h: number };

export type ViewerRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type ViewerTransform = {
  scale: number;
  translateX: number;
  translateY: number;
};

export type ZoomPreset = "fit" | "100" | "200";

export const MIN_VIEWER_SCALE = 1;
export const MAX_VIEWER_SCALE = 6;
export const DEFAULT_VIEWER_TRANSFORM: ViewerTransform = {
  scale: MIN_VIEWER_SCALE,
  translateX: 0,
  translateY: 0,
};

const EPSILON = 0.0001;

export function containRect(box: ViewerSize, natural: ViewerSize): ViewerRect {
  if (box.w <= 0 || box.h <= 0 || natural.w <= 0 || natural.h <= 0) {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  const fit = Math.min(box.w / natural.w, box.h / natural.h);
  const width = natural.w * fit;
  const height = natural.h * fit;
  return { left: (box.w - width) / 2, top: (box.h - height) / 2, width, height };
}

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return MIN_VIEWER_SCALE;
  return Math.min(MAX_VIEWER_SCALE, Math.max(MIN_VIEWER_SCALE, scale));
}

/** The scale needed to render one source pixel as one CSS pixel. */
export function naturalZoomScale(frame: ViewerRect, natural: ViewerSize): number {
  if (frame.width <= 0 || frame.height <= 0 || natural.w <= 0 || natural.h <= 0) return MIN_VIEWER_SCALE;
  return Math.max(MIN_VIEWER_SCALE, natural.w / frame.width, natural.h / frame.height);
}

export function zoomScaleForPreset(preset: ZoomPreset, frame: ViewerRect, natural: ViewerSize): number {
  if (preset === "fit") return MIN_VIEWER_SCALE;
  const sourceScale = naturalZoomScale(frame, natural);
  return clampScale(sourceScale * (preset === "200" ? 2 : 1));
}

/**
 * Transform a point in the stage's unscaled CSS coordinate space.
 * The transform origin is always the viewport center.
 */
export function transformPoint(point: { x: number; y: number }, box: ViewerSize, transform: ViewerTransform) {
  const centerX = box.w / 2;
  const centerY = box.h / 2;
  return {
    x: centerX + (point.x - centerX) * transform.scale + transform.translateX,
    y: centerY + (point.y - centerY) * transform.scale + transform.translateY,
  };
}

export function inverseTransformPoint(point: { x: number; y: number }, box: ViewerSize, transform: ViewerTransform) {
  const centerX = box.w / 2;
  const centerY = box.h / 2;
  const scale = Math.max(EPSILON, transform.scale);
  return {
    x: centerX + (point.x - centerX - transform.translateX) / scale,
    y: centerY + (point.y - centerY - transform.translateY) / scale,
  };
}

export function normalizedToStagePoint(
  point: { x: number; y: number },
  frame: ViewerRect,
  box: ViewerSize,
  transform: ViewerTransform,
) {
  return transformPoint(
    { x: frame.left + point.x * frame.width, y: frame.top + point.y * frame.height },
    box,
    transform,
  );
}

/**
 * Convert a client point into normalized poster coordinates. Letterboxed areas
 * return null, while points on the poster edges remain valid.
 */
export function stagePointToNormalized(
  point: { x: number; y: number },
  frame: ViewerRect,
  box: ViewerSize,
  transform: ViewerTransform,
) {
  if (frame.width <= 0 || frame.height <= 0) return null;
  const unscaled = inverseTransformPoint(point, box, transform);
  const x = (unscaled.x - frame.left) / frame.width;
  const y = (unscaled.y - frame.top) / frame.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

function clampAxis(
  translation: number,
  viewport: number,
  frameStart: number,
  frameSize: number,
  scale: number,
  center: number,
) {
  const start = center + (frameStart - center) * scale;
  const end = center + (frameStart + frameSize - center) * scale;
  const scaledSize = end - start;

  // If the poster is still smaller than the viewport on this axis, keep it
  // centered instead of allowing a blank edge to drift into view.
  if (scaledSize <= viewport) return viewport / 2 - (start + end) / 2;

  // Otherwise the transformed poster must continue to cover the viewport.
  return Math.min(Math.max(translation, viewport - end), -start);
}

/** Keep the poster bounded while preserving its aspect ratio and letterbox. */
export function clampTransform(transform: ViewerTransform, box: ViewerSize, frame: ViewerRect): ViewerTransform {
  const scale = clampScale(transform.scale);
  if (box.w <= 0 || box.h <= 0 || frame.width <= 0 || frame.height <= 0) {
    return { scale, translateX: 0, translateY: 0 };
  }
  return {
    scale,
    translateX: clampAxis(transform.translateX, box.w, frame.left, frame.width, scale, box.w / 2),
    translateY: clampAxis(transform.translateY, box.h, frame.top, frame.height, scale, box.h / 2),
  };
}

/** Center a normalized annotation and zoom it enough to inspect. */
export function focusTransform(
  point: { x: number; y: number },
  box: ViewerSize,
  frame: ViewerRect,
  current: ViewerTransform,
  focusScale = 2,
): ViewerTransform {
  const scale = clampScale(Math.max(current.scale, focusScale));
  const target = { x: frame.left + point.x * frame.width, y: frame.top + point.y * frame.height };
  return clampTransform(
    {
      scale,
      translateX: -(target.x - box.w / 2) * scale,
      translateY: -(target.y - box.h / 2) * scale,
    },
    box,
    frame,
  );
}

export function sameTransform(a: ViewerTransform, b: ViewerTransform): boolean {
  return (
    Math.abs(a.scale - b.scale) < EPSILON &&
    Math.abs(a.translateX - b.translateX) < EPSILON &&
    Math.abs(a.translateY - b.translateY) < EPSILON
  );
}

export function zoomLabel(transform: ViewerTransform, frame: ViewerRect, natural: ViewerSize): string {
  if (Math.abs(transform.scale - MIN_VIEWER_SCALE) < 0.02) return "Fit";
  const sourceScale = naturalZoomScale(frame, natural);
  if (Math.abs(transform.scale - sourceScale) < 0.04) return "100%";
  if (Math.abs(transform.scale - sourceScale * 2) < 0.06) return "200%";
  return `${Math.round((transform.scale / sourceScale) * 100)}%`;
}
