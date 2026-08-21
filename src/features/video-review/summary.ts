import {
  commentStatus,
  REACTION_LABEL,
  VERDICT_LABEL,
  type CommentPin,
  type ReactionType,
  type ReviewProgress,
  type Verdict,
  type VersionVerdict,
  type VideoReaction,
} from "../../lib/types";
import { anchorEnd, anchorStart } from "./anchors";
import { formatTime } from "./media";

/**
 * 審片摘要 — arithmetic, not AI.
 *
 * Everything here is counting and bucketing. That is a deliberate ceiling: a
 * summary the author cannot verify by scrolling the list is a summary they
 * cannot act on, and "the model thinks people found it slow" is not something
 * you can take to an edit. Counting where the feedback CLUSTERS is enough to
 * point at the right ten seconds of the cut, which is the actual job.
 *
 * Pure functions over plain data so the whole thing is testable without a
 * browser, a database or a video.
 */

/** Hotspot resolution. 5s for short cuts, 10s once a cut is long enough that
 * 5-second bins would scatter one problem across three of them. */
export function binSize(duration: number): number {
  return duration > 180 ? 10 : 5;
}

export type Hotspot = {
  /** Bin start, in seconds. */
  start: number;
  end: number;
  label: string;
  count: number;
  /** The category that dominates this bin, when one does. */
  topCategory?: string;
  /** The reaction that dominates this bin, when one does. */
  topReaction?: ReactionType;
};

export type ReviewSummary = {
  viewers: number;
  completed: number;
  comments: number;
  reactions: number;
  open: number;
  done: number;
  verdicts: Record<Verdict, number>;
  topVerdict: { verdict: Verdict; count: number } | null;
  hotspots: Hotspot[];
};

function mostCommon<T extends string>(items: T[]): T | undefined {
  if (!items.length) return undefined;
  const counts = new Map<T, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  let best: T | undefined;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  // A single mention is not a pattern; saying "節奏相關回饋較集中" off one
  // comment would be a confident-sounding lie.
  return bestCount > 1 ? best : undefined;
}

/**
 * Where feedback piles up.
 *
 * A range counts in every bin it covers — a "this whole stretch drags" note is
 * about the stretch, and dropping it into its first bin would hide it from the
 * seconds it is actually complaining about.
 */
export function hotspotsOf(
  comments: CommentPin[],
  reactions: VideoReaction[],
  duration: number,
  limit = 3,
): Hotspot[] {
  const size = binSize(duration);
  type Bucket = { count: number; categories: string[]; reactions: ReactionType[] };
  const bins = new Map<number, Bucket>();

  const touch = (bin: number): Bucket => {
    let bucket = bins.get(bin);
    if (!bucket) {
      bucket = { count: 0, categories: [], reactions: [] };
      bins.set(bin, bucket);
    }
    return bucket;
  };

  for (const c of comments) {
    const start = anchorStart(c);
    const end = anchorEnd(c) ?? start;
    const firstBin = Math.floor(start / size);
    const lastBin = Math.floor(Math.max(start, end) / size);
    for (let bin = firstBin; bin <= lastBin; bin += 1) {
      const bucket = touch(bin);
      bucket.count += 1;
      if (c.problemType) bucket.categories.push(c.problemType);
    }
  }

  for (const r of reactions) {
    const bucket = touch(Math.floor(r.time / size));
    bucket.count += 1;
    bucket.reactions.push(r.type);
  }

  return [...bins.entries()]
    .filter(([, b]) => b.count > 1) // one lone note is not a hotspot
    .sort((a, b) => b[1].count - a[1].count || a[0] - b[0])
    .slice(0, limit)
    .map(([bin, b]) => {
      const start = bin * size;
      const end = start + size;
      return {
        start,
        end,
        label: `${formatTime(start)}–${formatTime(end)}`,
        count: b.count,
        topCategory: mostCommon(b.categories),
        topReaction: mostCommon(b.reactions),
      };
    });
}

/** One sentence for a hotspot, or null when there is nothing honest to say. */
export function hotspotNote(spot: Hotspot): string | null {
  if (spot.topCategory) return `${spot.topCategory}相關回饋較集中`;
  if (spot.topReaction) return `多數人覺得「${REACTION_LABEL[spot.topReaction].text}」`;
  return null;
}

export function summarize(input: {
  comments: CommentPin[];
  reactions: VideoReaction[];
  verdicts: VersionVerdict[];
  progress: ReviewProgress[];
  duration: number;
}): ReviewSummary {
  const { comments, reactions, verdicts, progress, duration } = input;

  const verdictCounts: Record<Verdict, number> = { pass: 0, minor: 0, revise: 0 };
  for (const v of verdicts) verdictCounts[v.verdict] += 1;

  let topVerdict: { verdict: Verdict; count: number } | null = null;
  for (const key of Object.keys(verdictCounts) as Verdict[]) {
    const count = verdictCounts[key];
    if (count > 0 && (!topVerdict || count > topVerdict.count)) topVerdict = { verdict: key, count };
  }

  const statuses = comments.map(commentStatus);

  return {
    // "已查看" means they told us they watched something, not that they opened
    // the link — a row only exists once the player has actually run.
    viewers: progress.filter((p) => p.maxWatched > 0 || p.completedAt).length,
    completed: progress.filter((p) => p.completedAt).length,
    comments: comments.length,
    reactions: reactions.length,
    open: statuses.filter((s) => s === "open" || s === "doing").length,
    done: statuses.filter((s) => s === "done").length,
    verdicts: verdictCounts,
    topVerdict,
    hotspots: hotspotsOf(comments, reactions, duration),
  };
}

/** The whole summary as plain text, for 複製 and for the e2e run to read. */
export function summaryLines(label: string, s: ReviewSummary): string[] {
  const lines = [`${label}回饋`];
  if (s.viewers) lines.push(`${s.viewers} 位夥伴已查看`);
  lines.push(`${s.comments} 則時間回饋`);
  if (s.reactions) lines.push(`${s.reactions} 個快速反應`);
  lines.push(`${s.open} 個待處理`);
  if (s.done) lines.push(`${s.done} 個已修改`);
  if (s.hotspots.length) {
    lines.push("集中位置：");
    for (const spot of s.hotspots) {
      const note = hotspotNote(spot);
      lines.push(`${spot.label}${note ? `：${note}` : `：${spot.count} 則`}`);
    }
  }
  if (s.topVerdict) lines.push(`整體：${s.topVerdict.count} 人「${VERDICT_LABEL[s.topVerdict.verdict]}」`);
  return lines;
}
