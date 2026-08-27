import type { CommentPin, VideoAnchor } from "../lib/types";
import type { AssetVideoSegment } from "./types";
import { extractTopics } from "./understanding";

export function parseTimestamp(query: string): number | undefined {
  const clock = query.match(/(?:^|[^\d])(\d{1,2}):(\d{2})(?:[^\d]|$)/);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  const seconds = query.match(/(\d+(?:\.\d+)?)\s*秒/);
  if (seconds) return Number(seconds[1]);
  return undefined;
}

export function commentTimeRange(anchor: VideoAnchor | undefined): { start: number; end: number } | undefined {
  if (!anchor) return undefined;
  if (anchor.kind === "point") return { start: anchor.time, end: anchor.time };
  return { start: anchor.startTime, end: anchor.endTime };
}

export function coversTime(start: number, end: number, timeSeconds: number, slack = 8): boolean {
  return timeSeconds >= start - slack && timeSeconds <= end + slack;
}

export function segmentsAtTime(segments: AssetVideoSegment[], timeSeconds: number): AssetVideoSegment[] {
  return segments.filter((segment) => coversTime(segment.startSeconds, segment.endSeconds, timeSeconds, 0.5));
}

/**
 * Temporal intelligence starts from the discussion the team already left on the
 * timeline. Transcript/vision segments can be merged later without a second model.
 */
export function segmentsFromComments(
  comments: CommentPin[],
  versionId: string,
  assetId: string,
): AssetVideoSegment[] {
  const segments: AssetVideoSegment[] = [];
  comments.forEach((comment, index) => {
    if (comment.versionId !== versionId || !comment.anchor) return;
    const range = commentTimeRange(comment.anchor);
    if (!range) return;
    const text = [comment.body, comment.suggestion].filter(Boolean).join(" ");
    segments.push({
      id: `seg_${comment.id || index}`,
      assetId,
      versionId,
      startSeconds: range.start,
      endSeconds: Math.max(range.end, range.start + 1),
      summary: text,
      topics: extractTopics(text),
      source: "comment",
    });
  });
  return segments;
}

export function describeMoment(segments: AssetVideoSegment[], timeSeconds: number): string {
  const hits = segmentsAtTime(segments, timeSeconds);
  if (!hits.length) return `這個時間點（${formatClock(timeSeconds)}）還沒有可讀的片段理解。`;
  return hits.map((segment) => `${formatClock(segment.startSeconds)}–${formatClock(segment.endSeconds)}：${segment.summary}`).join("\n");
}

export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const mm = String(Math.floor(whole / 60)).padStart(2, "0");
  const ss = String(whole % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}
