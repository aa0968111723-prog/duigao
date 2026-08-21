import type { SupabaseClient } from "@supabase/supabase-js";
import { CloudError } from "./errors";
import {
  isReviewStatus,
  isVerdict,
  isVideoCategory,
  MAX_BRIEF_QUESTIONS,
  REACTION_TYPES,
  type ReactionType,
  type ReviewBrief,
  type ReviewProgress,
  type ReviewStatus,
  type Verdict,
  type VersionVerdict,
  type VideoCategory,
  type VideoReaction,
} from "../lib/types";

/**
 * 影片對稿 2.0 — the four things a review needs that a comment cannot say (#32).
 *
 *   version_review_briefs     what the author wants looked at, per cut
 *   video_reactions           一鍵反應, for the 90% who will not type
 *   version_verdicts          可以過 / 小修即可 / 需要再調整
 *   version_review_progress   has this person seen it, roughly how far
 *
 * All four are per VERSION, never per room: 初剪 and 二剪 are different asks and
 * deserve different answers. All four are membership-gated by RLS, and none of
 * them is reachable by `anon` — the public share card (0005/0011) reads a
 * separate projection and has no overlap with anything here.
 *
 * Every function is allowed to fail. Reactions and verdicts are enhancements on
 * top of a room that already works; the caller shows an error and the video
 * keeps playing.
 */

/* --------------------------------------------------------------- briefs -- */

type BriefRow = {
  version_id: string;
  body: string;
  focus_tags: unknown;
  questions: unknown;
  updated_at: string;
};

/** jsonb is whatever the last writer put there, so nothing is trusted here. */
function readTags(value: unknown): VideoCategory[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isVideoCategory);
}

function readQuestions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((q): q is string => typeof q === "string")
    .map((q) => q.trim())
    .filter(Boolean)
    .slice(0, MAX_BRIEF_QUESTIONS);
}

function briefFromRow(row: BriefRow): ReviewBrief {
  return {
    versionId: row.version_id,
    body: typeof row.body === "string" ? row.body : "",
    focusTags: readTags(row.focus_tags),
    questions: readQuestions(row.questions),
    updatedAt: Date.parse(row.updated_at) || 0,
  };
}

export async function loadBriefs(supabase: SupabaseClient, roomId: string): Promise<ReviewBrief[]> {
  const { data, error } = await supabase
    .from("version_review_briefs")
    .select("version_id, body, focus_tags, questions, updated_at")
    .eq("room_id", roomId);
  if (error) throw new CloudError(error.message, "review");
  return ((data as BriefRow[] | null) ?? []).map(briefFromRow);
}

export type BriefInput = {
  body: string;
  focusTags: VideoCategory[];
  questions: string[];
};

/**
 * Write the author's note for one cut.
 *
 * Upsert rather than insert-or-update-by-hand: the row is keyed by version, so
 * "save" is the same operation whether or not a brief already existed, and two
 * editors saving at once cannot produce a duplicate-key error one of them has
 * to be shown.
 */
export async function saveBrief(
  supabase: SupabaseClient,
  roomId: string,
  versionId: string,
  input: BriefInput,
): Promise<ReviewBrief> {
  const { data, error } = await supabase
    .from("version_review_briefs")
    .upsert(
      {
        version_id: versionId,
        room_id: roomId,
        body: input.body.trim(),
        focus_tags: input.focusTags.filter(isVideoCategory),
        // The database also caps this, but sending four and being rejected is a
        // worse experience than sending the three that were asked for.
        questions: input.questions.map((q) => q.trim()).filter(Boolean).slice(0, MAX_BRIEF_QUESTIONS),
      },
      { onConflict: "version_id" },
    )
    .select("version_id, body, focus_tags, questions, updated_at")
    .single();
  if (error || !data) throw new CloudError(error?.message ?? "brief save failed", "review");
  return briefFromRow(data as BriefRow);
}

export async function clearBrief(supabase: SupabaseClient, versionId: string): Promise<void> {
  const { error } = await supabase.from("version_review_briefs").delete().eq("version_id", versionId);
  if (error) throw new CloudError(error.message, "review");
}

/* ------------------------------------------------------------ reactions -- */

type ReactionRow = {
  id: string;
  version_id: string;
  user_id: string;
  time_seconds: number;
  reaction_type: string;
  created_at: string;
};

function reactionFromRow(row: ReactionRow): VideoReaction | null {
  if (!(REACTION_TYPES as readonly string[]).includes(row.reaction_type)) return null;
  return {
    id: row.id,
    versionId: row.version_id,
    userId: row.user_id,
    time: Number(row.time_seconds) || 0,
    type: row.reaction_type as ReactionType,
    createdAt: Date.parse(row.created_at) || 0,
  };
}

export async function loadReactions(supabase: SupabaseClient, roomId: string): Promise<VideoReaction[]> {
  const { data, error } = await supabase
    .from("video_reactions")
    .select("id, version_id, user_id, time_seconds, reaction_type, created_at")
    .eq("room_id", roomId)
    .order("time_seconds", { ascending: true });
  if (error) throw new CloudError(error.message, "review");
  return ((data as ReactionRow[] | null) ?? []).map(reactionFromRow).filter((r): r is VideoReaction => r !== null);
}

/**
 * Record a tap.
 *
 * A double-tap is not an error the person needs to hear about: the unique index
 * on (version, user, type, 2-second bucket) is what keeps the timeline from
 * growing three identical dots, and hitting it means the reaction they wanted
 * is already there. So a duplicate resolves to `null` and the caller stays
 * quiet, while a real failure still throws.
 */
export async function addReaction(
  supabase: SupabaseClient,
  roomId: string,
  versionId: string,
  time: number,
  type: ReactionType,
): Promise<VideoReaction | null> {
  const { data, error } = await supabase
    .from("video_reactions")
    .insert({
      room_id: roomId,
      version_id: versionId,
      time_seconds: Math.max(0, time),
      reaction_type: type,
    })
    .select("id, version_id, user_id, time_seconds, reaction_type, created_at")
    .single();
  if (error) {
    if (error.code === "23505") return null; // already recorded in this bucket
    throw new CloudError(error.message, "review");
  }
  return data ? reactionFromRow(data as ReactionRow) : null;
}

export async function removeReaction(supabase: SupabaseClient, id: string): Promise<void> {
  const { error } = await supabase.from("video_reactions").delete().eq("id", id);
  if (error) throw new CloudError(error.message, "review");
}

/* ------------------------------------------------------------- verdicts -- */

type VerdictRow = {
  version_id: string;
  user_id: string;
  verdict: string;
  note: string | null;
  updated_at: string;
};

function verdictFromRow(row: VerdictRow): VersionVerdict | null {
  if (!isVerdict(row.verdict)) return null;
  return {
    versionId: row.version_id,
    userId: row.user_id,
    verdict: row.verdict,
    note: row.note ?? undefined,
    updatedAt: Date.parse(row.updated_at) || 0,
  };
}

export async function loadVerdicts(supabase: SupabaseClient, roomId: string): Promise<VersionVerdict[]> {
  const { data, error } = await supabase
    .from("version_verdicts")
    .select("version_id, user_id, verdict, note, updated_at")
    .eq("room_id", roomId);
  if (error) throw new CloudError(error.message, "review");
  return ((data as VerdictRow[] | null) ?? []).map(verdictFromRow).filter((v): v is VersionVerdict => v !== null);
}

/** One per person per cut, and changing your mind is the normal case. */
export async function saveVerdict(
  supabase: SupabaseClient,
  roomId: string,
  versionId: string,
  verdict: Verdict,
  note?: string,
): Promise<VersionVerdict> {
  const { data, error } = await supabase
    .from("version_verdicts")
    .upsert(
      { version_id: versionId, room_id: roomId, verdict, note: note?.trim() || null },
      { onConflict: "version_id,user_id" },
    )
    .select("version_id, user_id, verdict, note, updated_at")
    .single();
  if (error || !data) throw new CloudError(error?.message ?? "verdict save failed", "review");
  const parsed = verdictFromRow(data as VerdictRow);
  if (!parsed) throw new CloudError("verdict save returned an unknown value", "review");
  return parsed;
}

/* ------------------------------------------------------------- progress -- */

type ProgressRow = {
  version_id: string;
  user_id: string;
  max_watched_seconds: number;
  completed_at: string | null;
};

function progressFromRow(row: ProgressRow): ReviewProgress {
  return {
    versionId: row.version_id,
    userId: row.user_id,
    maxWatched: Number(row.max_watched_seconds) || 0,
    completedAt: row.completed_at ? Date.parse(row.completed_at) || undefined : undefined,
  };
}

export async function loadProgress(supabase: SupabaseClient, roomId: string): Promise<ReviewProgress[]> {
  const { data, error } = await supabase
    .from("version_review_progress")
    .select("version_id, user_id, max_watched_seconds, completed_at")
    .eq("room_id", roomId);
  if (error) throw new CloudError(error.message, "review");
  return ((data as ProgressRow[] | null) ?? []).map(progressFromRow);
}

/**
 * Report how far this person has got.
 *
 * The database refuses to move `max_watched_seconds` backwards, so rewinding to
 * re-watch a passage never rewrites history — which is what makes "12 位夥伴
 * 已查看" a fact rather than a guess. Only two numbers are ever sent.
 */
export async function reportProgress(
  supabase: SupabaseClient,
  roomId: string,
  versionId: string,
  maxWatched: number,
  completed: boolean,
): Promise<void> {
  const { error } = await supabase.from("version_review_progress").upsert(
    {
      version_id: versionId,
      room_id: roomId,
      max_watched_seconds: Math.max(0, maxWatched),
      ...(completed ? { completed_at: new Date().toISOString() } : {}),
    },
    { onConflict: "version_id,user_id" },
  );
  if (error) throw new CloudError(error.message, "review");
}

/* --------------------------------------------------------------- status -- */

/**
 * Set the author's triage state on one piece of feedback.
 *
 * `resolved` travels with it so a client still reading only the boolean sees
 * the same thing this one does. The database would derive it anyway; sending it
 * keeps an offline-queued write correct even if it lands on an older schema.
 */
export async function setReviewStatus(
  supabase: SupabaseClient,
  id: string,
  status: ReviewStatus,
): Promise<void> {
  if (!isReviewStatus(status)) throw new CloudError("unknown review status", "review");
  const { error } = await supabase
    .from("comments")
    .update({
      review_status: status,
      resolved: status === "done" || status === "wontfix",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw new CloudError(error.message, "review");
}
