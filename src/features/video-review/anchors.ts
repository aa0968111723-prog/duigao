import type { CommentPin, VideoAnchor } from "../../lib/types";
import { formatTime } from "./media";

/**
 * Reading a comment's time anchor.
 *
 * Every one of these tolerates a comment that has no anchor at all, because the
 * same discussion list can hold both kinds while a room is loading, and because
 * a row written by an older client will legitimately arrive without one.
 */

export function isVideoComment(pin: CommentPin): boolean {
  return pin.anchor?.kind === "point" || pin.anchor?.kind === "range";
}

/** Where the marker sits, and what a tap seeks to. Non-video feedback is 0. */
export function anchorStart(pin: CommentPin): number {
  if (pin.anchor?.kind === "range") return pin.anchor.startTime;
  if (pin.anchor?.kind === "point") return pin.anchor.time;
  return 0;
}

export function anchorEnd(pin: CommentPin): number | undefined {
  return pin.anchor?.kind === "range" ? pin.anchor.endTime : undefined;
}

/** "00:13" or "00:22–00:27". An en dash, because it is a span, not a minus. */
export function anchorLabel(pin: CommentPin): string | undefined {
  if (pin.anchor?.kind === "range") {
    return `${formatTime(pin.anchor.startTime)}–${formatTime(pin.anchor.endTime)}`;
  }
  if (pin.anchor?.kind === "point") return formatTime(pin.anchor.time);
  return undefined;
}

/**
 * Build a range from two taps in either order, and refuse the ones that would
 * be lies: a backwards range, or one so short it cannot be scrubbed to. The
 * caller turns null into "選一段太短了，再選一次".
 */
export const MIN_RANGE_SECONDS = 0.3;

export function makeRange(a: number, b: number, duration?: number): VideoAnchor | null {
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.max(a, b);
  const capped = duration && duration > 0 ? Math.min(hi, duration) : hi;
  if (!Number.isFinite(lo) || !Number.isFinite(capped)) return null;
  if (capped - lo < MIN_RANGE_SECONDS) return null;
  return { kind: "range", startTime: lo, endTime: capped };
}

export function makePoint(time: number, duration?: number): VideoAnchor {
  const capped = duration && duration > 0 ? Math.min(Math.max(0, time), duration) : Math.max(0, time);
  return { kind: "point", time: capped };
}
