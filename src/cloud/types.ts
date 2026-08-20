import type {
  ChatMessage,
  CommentPin,
  CommentReply,
  CommentSupport,
  MediaType,
  Point,
  ProposalPref,
  ReviewPriority,
  ReviewType,
  Stroke,
  VideoAnchor,
} from "../lib/types";
import { normalizeRegion } from "../lib/region";

/** User-facing sync state. Never exposes the transport (Supabase/PeerJS/RLS). */
export type SyncStatus = "local-only" | "connecting" | "syncing" | "synced" | "offline-pending" | "error";

export function syncStatusLabel(status: SyncStatus): string {
  switch (status) {
    case "connecting":
    case "syncing":
      return "正在同步…";
    case "synced":
      return "已同步";
    case "offline-pending":
      return "尚未同步，已保存在這台裝置";
    case "error":
      return "同步失敗，點一下重試";
    default:
      return "";
  }
}

// ---- DB row shapes (public schema) ----

export type RoomRow = {
  id: string;
  owner_user_id: string;
  title: string;
  /** Absent from rooms created before PR #23; read through `mediaTypeOf`. */
  media_type?: string | null;
  created_at: string;
  updated_at: string;
};

/** Anything that is not an explicit "video" is an image room, including null. */
export function mediaTypeOf(value: string | null | undefined): MediaType {
  return value === "video" ? "video" : "image";
}

export type VersionRow = {
  id: string;
  room_id: string;
  label: string;
  sort_order: number;
  /** Poster artwork for an image version, captured poster frame for a video one. */
  image_path: string | null;
  mime_type: string | null;
  width: number | null;
  height: number | null;
  /** PR #23. Absent when reading a database that has not run 0006 yet. */
  media_kind?: string | null;
  video_path?: string | null;
  duration_seconds?: number | null;
  file_size?: number | null;
  created_at: string;
};

export type CommentRow = {
  id: string;
  room_id: string;
  version_id: string;
  author_user_id: string;
  author_name: string;
  author_color: string;
  x: number;
  y: number;
  /** AnnotationRegion jsonb (0003_comment_regions); null for point comments. */
  region: unknown;
  /** PR #23 time anchors. Absent when reading a database without 0006. */
  anchor_type?: string | null;
  time_seconds?: number | null;
  end_time_seconds?: number | null;
  body: string;
  suggestion: string;
  problem_type: string | null;
  priority: string | null;
  resolved: boolean;
  created_at: string;
};

export type StrokeRow = {
  id: string;
  room_id: string;
  version_id: string;
  author_user_id: string;
  color: string;
  width: number;
  points: Point[];
  created_at: string;
};

export type MessageRow = {
  id: string;
  room_id: string;
  author_user_id: string;
  author_name: string;
  author_color: string;
  body: string;
  created_at: string;
};

export type ProposalRow = {
  id: string;
  room_id: string;
  version_id: string;
  author_user_id: string;
  author_name: string;
  name: string;
  payload: Record<string, unknown>;
  revision: number;
  created_at: string;
  updated_at: string;
};

const ms = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Date.now() : t;
};

/**
 * Rebuild a video anchor from its columns.
 *
 * Trusts `anchor_type` as the intent and the numbers as the data, but still
 * checks the numbers: a row that claims to be a range without a usable end is
 * read as the moment it starts at, which is the closest true statement — far
 * better than a NaN that renders as an invisible marker.
 */
export function anchorFromRow(row: CommentRow): VideoAnchor | undefined {
  const kind = row.anchor_type ?? "";
  if (!kind.startsWith("video-")) return undefined;
  const time = Number(row.time_seconds);
  if (!Number.isFinite(time) || time < 0) return undefined;
  const end = Number(row.end_time_seconds);
  if (kind === "video-range" && Number.isFinite(end) && end > time) {
    return { kind: "range", startTime: time, endTime: end };
  }
  return { kind: "point", time };
}

export function commentFromRow(row: CommentRow): CommentPin {
  const region = normalizeRegion(row.region);
  const anchor = anchorFromRow(row);
  return {
    id: row.id,
    versionId: row.version_id,
    authorId: row.author_user_id,
    authorName: row.author_name,
    authorColor: row.author_color,
    x: row.x,
    y: row.y,
    ...(region ? { region } : {}),
    ...(anchor ? { anchor } : {}),
    body: row.body,
    suggestion: row.suggestion || undefined,
    problemType: (row.problem_type as ReviewType | null) ?? undefined,
    priority: (row.priority as ReviewPriority | null) ?? undefined,
    resolved: row.resolved,
    createdAt: ms(row.created_at),
  };
}

export function strokeFromRow(row: StrokeRow): Stroke {
  return {
    id: row.id,
    versionId: row.version_id,
    authorId: row.author_user_id,
    color: row.color,
    width: row.width,
    points: Array.isArray(row.points) ? row.points : [],
    createdAt: ms(row.created_at),
  };
}

export function messageFromRow(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    authorId: row.author_user_id,
    authorName: row.author_name,
    authorColor: row.author_color,
    body: row.body,
    createdAt: ms(row.created_at),
  };
}

export type SupportRow = { comment_id: string; user_id: string; room_id: string };
export type ReplyRow = {
  id: string;
  room_id: string;
  comment_id: string;
  author_user_id: string;
  author_name: string;
  author_color: string;
  body: string;
  created_at: string;
};
export type PrefRow = { room_id: string; version_id: string; user_id: string; choice: string };

export function supportFromRow(row: SupportRow): CommentSupport {
  return { commentId: row.comment_id, userId: row.user_id };
}

export function replyFromRow(row: ReplyRow): CommentReply {
  return {
    id: row.id,
    commentId: row.comment_id,
    authorId: row.author_user_id,
    authorName: row.author_name,
    authorColor: row.author_color,
    body: row.body,
    createdAt: ms(row.created_at),
  };
}

export function prefFromRow(row: PrefRow): ProposalPref {
  return { versionId: row.version_id, userId: row.user_id, choice: row.choice };
}
