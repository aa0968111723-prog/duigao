import type {
  ChatMessage,
  BranchStatus,
  BranchSummary,
  BranchType,
  ContentRelation,
  CommentPin,
  CommentReply,
  CommentSupport,
  MediaType,
  Point,
  ProposalPref,
  ReviewPriority,
  ReviewType,
  PlanBlock,
  PlanDocument,
  PollVote,
  RoomBranch,
  RoomPoll,
  Stroke,
  VideoAnchor,
} from "../lib/types";
import { isReviewStatus } from "../lib/types";
import { anchorFromCommentColumns } from "../lib/contextAnchor";
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
  room_mode?: string | null;
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
  branch_id?: string | null;
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
  /** Optional content hash added by the Asset Intelligence migration. */
  content_hash?: string | null;
  /** PR #25. Absent when reading a database that has not run 0008 yet. */
  archived_at?: string | null;
  /** PR #29. Compatible proxy; original video_path stays immutable. */
  optimized_video_path?: string | null;
  optimized?: boolean | null;
  source_file_size?: number | null;
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
  /** PR #32 four-state. Absent when reading a database without 0012. */
  review_status?: string | null;
  /** Included only by the project-room summary query to label recent feedback. */
  versions?: { branch_id?: string | null } | { branch_id?: string | null }[] | null;
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
  // 委派 ContextAnchor 契約層（PR-02d）：同一份「說不通的列退回 image
  // 語意」規則現在只寫在一個地方。
  const anchor = anchorFromCommentColumns(row);
  if (anchor.type === "video-range") return { kind: "range", startTime: anchor.startTime, endTime: anchor.endTime };
  if (anchor.type === "video-point") return { kind: "point", time: anchor.time };
  return undefined;
}

export function commentFromRow(row: CommentRow): CommentPin {
  const region = normalizeRegion(row.region);
  const anchor = anchorFromRow(row);
  const relatedVersion = Array.isArray(row.versions) ? row.versions[0] : row.versions;
  const branchId = relatedVersion?.branch_id ?? undefined;
  return {
    id: row.id,
    versionId: row.version_id,
    ...(branchId ? { branchId } : {}),
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
    // A database without 0012 sends nothing here, and a room that has never
    // been triaged sends 'open'. Both mean the same thing, and `commentStatus()`
    // derives it from `resolved` when it is missing — so the two models cannot
    // disagree no matter which schema answered.
    ...(isReviewStatus(row.review_status) ? { reviewStatus: row.review_status } : {}),
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

export type BranchRow = {
  id: string;
  room_id: string;
  name: string;
  branch_type: string;
  sort_order: number;
  status: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type BranchSummaryRow = {
  branch_id: string;
  version_count: number | string;
  latest_version_id: string | null;
  latest_label: string | null;
  latest_updated_at: string | null;
  open_comment_count: number | string;
  feedback_count: number | string;
};

export type PlanRow = {
  branch_id: string;
  room_id: string;
  title: string;
  description: string;
  blocks: unknown;
  updated_by: string | null;
  updated_at: string;
};

export type RelationRow = {
  id: string;
  room_id: string;
  from_branch_id: string;
  to_branch_id: string;
  relation_type: string;
  created_by: string | null;
  created_at: string;
};

export type PollRow = {
  id: string;
  room_id: string;
  question: string;
  options: unknown;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

export type PollVoteRow = {
  poll_id: string;
  room_id: string;
  user_id: string;
  option: string;
  created_at: string;
};

function listOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function branchFromRow(row: BranchRow): RoomBranch | null {
  if (!["poster", "video", "plan", "copy"].includes(row.branch_type)) return null;
  const status = ["in_progress", "pending", "completed", "archived"].includes(row.status)
    ? row.status as BranchStatus
    : "in_progress";
  return {
    id: row.id,
    roomId: row.room_id,
    name: row.name,
    branchType: row.branch_type as BranchType,
    sortOrder: row.sort_order,
    status,
    createdBy: row.created_by ?? "system",
    createdAt: ms(row.created_at),
    updatedAt: ms(row.updated_at),
  };
}

export function branchSummaryFromRow(row: BranchSummaryRow): BranchSummary {
  const number = (value: number | string | null | undefined) => Number(value ?? 0) || 0;
  const latestUpdatedAt = row.latest_updated_at ? ms(row.latest_updated_at) : undefined;
  return {
    branchId: row.branch_id,
    versionCount: number(row.version_count),
    ...(row.latest_version_id ? { latestVersionId: row.latest_version_id } : {}),
    ...(row.latest_label ? { latestLabel: row.latest_label } : {}),
    ...(latestUpdatedAt ? { latestUpdatedAt } : {}),
    openCommentCount: number(row.open_comment_count),
    feedbackCount: number(row.feedback_count),
  };
}

export function planFromRow(row: PlanRow): PlanDocument {
  const blocks = Array.isArray(row.blocks) ? row.blocks : [];
  return {
    branchId: row.branch_id,
    title: row.title,
    description: row.description,
    blocks: blocks.filter((block): block is PlanBlock => Boolean(block && typeof block === "object" && "id" in block && "kind" in block)),
    // summary 路徑的 select 不含 blocks（lazy）；標記起來，讓合併端能分辨
    // 「沒查」與「真的清空」。
    ...(row.blocks === undefined ? { blocksOmitted: true } : {}),
    updatedBy: row.updated_by ?? undefined,
    updatedAt: ms(row.updated_at),
  };
}

export function relationFromRow(row: RelationRow): ContentRelation {
  return {
    id: row.id,
    roomId: row.room_id,
    fromBranchId: row.from_branch_id,
    toBranchId: row.to_branch_id,
    relationType: "related",
    createdBy: row.created_by ?? "system",
    createdAt: ms(row.created_at),
  };
}

export function pollFromRow(row: PollRow): RoomPoll {
  return {
    id: row.id,
    roomId: row.room_id,
    question: row.question,
    options: listOfStrings(row.options),
    createdBy: row.created_by ?? "system",
    createdAt: ms(row.created_at),
    updatedAt: ms(row.updated_at),
    ...(row.closed_at ? { closedAt: ms(row.closed_at) } : {}),
  };
}

export function pollVoteFromRow(row: PollVoteRow): PollVote {
  return {
    pollId: row.poll_id,
    roomId: row.room_id,
    userId: row.user_id,
    option: row.option,
    createdAt: ms(row.created_at),
  };
}

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
