export type Point = { x: number; y: number };

/**
 * A circled area of the poster, stored as a normalized bounding box (0..1,
 * relative to the poster itself). This is what a mobile "圈出範圍" gesture is
 * reduced to — the freehand stroke itself is never persisted.
 */
export type AnnotationRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * What a room is for. Images are reviewed in space (a point or a circled area);
 * videos are reviewed in time (a moment or a stretch). The two workspaces share
 * everything below the UI — rooms, invites, discussion, sync — and nothing above
 * it, which is why this lives on the room rather than being guessed per action.
 */
export type MediaType = "image" | "video";

/**
 * Where a piece of video feedback points. Times are SECONDS as numbers, never
 * "00:13" strings: the timeline, seeking and any future frame-accurate work all
 * need real arithmetic, and formatting is a render-time concern.
 */
export type VideoAnchor =
  | { kind: "point"; time: number }
  | { kind: "range"; startTime: number; endTime: number };

/**
 * One draft of the work under review.
 *
 * `imageDataUrl` is the still image for this version: the poster artwork for an
 * image room, the captured poster frame for a video room. Keeping that one field
 * honest for both is what lets thumbnails, share cards and recents stay
 * media-agnostic. Video-only facts live in the optional fields below; an image
 * version simply has none of them.
 */
export type Version = {
  id: string;
  label: string;
  imageDataUrl: string;
  /** The branch owns the version in a project room. Absent on pre-branch data. */
  branchId?: string;
  /** Absent on rooms created before video existed — treat as "image". */
  kind?: MediaType;
  /** Playable URL for the video itself (signed, and refreshed on expiry). */
  videoUrl?: string;
  /** Storage path of the video, so a stale signed URL can be re-signed. */
  videoPath?: string;
  /** Seconds. Absent when the browser could not read the metadata. */
  duration?: number;
  mimeType?: string;
  fileSize?: number;
  width?: number;
  height?: number;
  /**
   * Archived versions stay loaded — their discussion is still readable and a
   * shared link may still point at them — but they drop out of the version
   * picker so the room shows what is current. ISO string, or absent.
   */
  archivedAt?: string;
};

/** The versions a picker should offer: everything still on the table. */
export function activeVersions(versions: Version[]): Version[] {
  return versions.filter((v) => !v.archivedAt);
}

export type ReviewType = "文字" | "排版" | "圖片" | "顏色" | "資訊錯誤" | "其他";
export type ReviewPriority = "一般" | "重要" | "急";

/* ------------------------------------------------------ 影片對稿 2.0 (#32) -- */

/**
 * What a piece of VIDEO feedback is about.
 *
 * Deliberately a different list from `ReviewType`: a poster is wrong about
 * 排版 or 顏色, a cut is wrong about 節奏 or 聲音. They share the storage
 * column (`comments.problem_type`) because both are "which bucket is this",
 * and the column has always been free text with the list living in the client.
 */
export const VIDEO_CATEGORIES = ["畫面", "節奏", "字幕", "聲音", "文案", "其他"] as const;
export type VideoCategory = (typeof VIDEO_CATEGORIES)[number];

export function isVideoCategory(value: unknown): value is VideoCategory {
  return typeof value === "string" && (VIDEO_CATEGORIES as readonly string[]).includes(value);
}

/**
 * The author's triage state for one piece of feedback.
 *
 * Four states, not a boolean, because "處理中" and "不採用" are real answers a
 * reviewer deserves and `resolved` cannot express either. `resolved` is still
 * written and still correct (done/wontfix ⇒ true); the database keeps the two
 * in step, so a client that only knows the boolean is never shown a lie.
 */
export const REVIEW_STATUSES = ["open", "doing", "done", "wontfix"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  open: "待處理",
  doing: "處理中",
  done: "已修改",
  wontfix: "不採用",
};

/** Only these two are new author powers; open/done are reachable by anyone. */
export const AUTHOR_ONLY_STATUSES: ReviewStatus[] = ["doing", "wontfix"];

export function isReviewStatus(value: unknown): value is ReviewStatus {
  return typeof value === "string" && (REVIEW_STATUSES as readonly string[]).includes(value);
}

/** `resolved` as the four-state sees it — the one place the mapping is written. */
export function statusFromResolved(resolved: boolean): ReviewStatus {
  return resolved ? "done" : "open";
}

export function resolvedFromStatus(status: ReviewStatus): boolean {
  return status === "done" || status === "wontfix";
}

/**
 * 一鍵反應 — the way to say something without typing.
 *
 * Stored as an English key so the label is a rendering decision; the emoji is
 * part of the label because on a phone it is the fastest thing to aim at.
 */
export const REACTION_TYPES = ["ok", "confused", "slow", "fast", "fun", "love"] as const;
export type ReactionType = (typeof REACTION_TYPES)[number];

export const REACTION_LABEL: Record<ReactionType, { emoji: string; text: string }> = {
  ok: { emoji: "👍", text: "可以" },
  confused: { emoji: "🤔", text: "看不懂" },
  slow: { emoji: "⏩", text: "太慢" },
  fast: { emoji: "⚡", text: "太快" },
  fun: { emoji: "😂", text: "有感" },
  love: { emoji: "✨", text: "喜歡" },
};

export type VideoReaction = {
  id: string;
  versionId: string;
  userId: string;
  time: number;
  type: ReactionType;
  createdAt: number;
};

/**
 * 看完之後這一版過不過.
 *
 * Three decisions rather than a star rating: a review meeting ends with "ship
 * it / tweak it / redo it", never with 3.4 stars.
 */
export const VERDICTS = ["pass", "minor", "revise"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const VERDICT_LABEL: Record<Verdict, string> = {
  pass: "可以過",
  minor: "小修即可",
  revise: "需要再調整",
};

export function isVerdict(value: unknown): value is Verdict {
  return typeof value === "string" && (VERDICTS as readonly string[]).includes(value);
}

export type VersionVerdict = {
  versionId: string;
  userId: string;
  verdict: Verdict;
  note?: string;
  updatedAt: number;
};

/**
 * The author's note for one cut: what this version is, and what they want
 * looked at. Per version on purpose — 初剪 and 二剪 ask for different things,
 * and a stale brief is worse than none.
 */
export type ReviewBrief = {
  versionId: string;
  body: string;
  /** Which of VIDEO_CATEGORIES the author wants attention on. */
  focusTags: VideoCategory[];
  /** At most three. More than that is a questionnaire, not a brief. */
  questions: string[];
  updatedAt: number;
};

export const MAX_BRIEF_QUESTIONS = 3;

/**
 * Deliberately only two facts per person per cut: how far they got, and
 * whether they finished. No play/pause log, no device, no heatmap — the team
 * needs "has everyone seen it", not surveillance.
 */
export type ReviewProgress = {
  versionId: string;
  userId: string;
  maxWatched: number;
  completedAt?: number;
};

export type CommentPin = {
  id: string;
  versionId: string;
  /** Derived project-room context; never replaces the version foreign key. */
  branchId?: string;
  authorId: string;
  authorName: string;
  authorColor: string;
  x: number;
  y: number;
  /** Present when the feedback points at an area instead of a single spot. x/y stay at the region's center. */
  region?: AnnotationRegion;
  /**
   * Present on video feedback: the moment or stretch it is about. x/y are
   * meaningless for these and stay at their defaults until a future release
   * adds on-screen positions to video comments.
   */
  anchor?: VideoAnchor;
  body: string;
  suggestion?: string;
  problemType?: ReviewType;
  priority?: ReviewPriority;
  resolved: boolean;
  /**
   * The author's triage state. Absent on rows written before #32 and on local
   * rooms — read it through `commentStatus()`, which falls back to `resolved`
   * so the two models can never disagree on screen.
   */
  reviewStatus?: ReviewStatus;
  createdAt: number;
};

/** The four-state for a comment, however old the row is. */
export function commentStatus(pin: Pick<CommentPin, "resolved" | "reviewStatus">): ReviewStatus {
  return pin.reviewStatus ?? statusFromResolved(pin.resolved);
}

export type Stroke = {
  id: string;
  versionId: string;
  authorId: string;
  color: string;
  width: number;
  points: Point[];
  createdAt: number;
};

export type ChatMessage = {
  id: string;
  authorId: string;
  authorName: string;
  authorColor: string;
  body: string;
  createdAt: number;
};

/* ------------------------------------------------ 同房多分支 1.0 ----------- */

/** User-facing content families. `branch` is deliberately not exposed in UI copy. */
export type BranchType = "poster" | "video" | "plan" | "copy";
export type BranchStatus = "in_progress" | "pending" | "completed" | "archived";

export const BRANCH_STATUS_LABEL: Record<BranchStatus, string> = {
  in_progress: "進行中",
  pending: "待確認",
  completed: "已完成",
  archived: "封存",
};

export const BRANCH_TYPE_LABEL: Record<BranchType, string> = {
  poster: "文宣",
  video: "影片",
  plan: "企劃",
  copy: "文案",
};

export type RoomBranch = {
  id: string;
  roomId: string;
  name: string;
  branchType: BranchType;
  sortOrder: number;
  status: BranchStatus;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

/** Lightweight overview data; detail rows/assets are loaded when a branch opens. */
export type BranchSummary = {
  branchId: string;
  versionCount: number;
  latestVersionId?: string;
  latestLabel?: string;
  latestUpdatedAt?: number;
  openCommentCount: number;
  feedbackCount: number;
};

export type PlanBlock =
  | { id: string; kind: "paragraph"; text: string }
  | { id: string; kind: "list"; text: string }
  | { id: string; kind: "checklist"; text: string; checked: boolean }
  | { id: string; kind: "link"; text: string; url: string };

export type PlanDocument = {
  branchId: string;
  title: string;
  description: string;
  blocks: PlanBlock[];
  updatedBy?: string;
  updatedAt: number;
};

export type ContentRelation = {
  id: string;
  roomId: string;
  fromBranchId: string;
  toBranchId: string;
  relationType: "related";
  createdBy: string;
  createdAt: number;
};

export type RoomPoll = {
  id: string;
  roomId: string;
  question: string;
  options: string[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
};

export type PollVote = {
  pollId: string;
  roomId: string;
  userId: string;
  option: string;
  createdAt: number;
};

/** "我也覺得" — one per user per comment. */
export type CommentSupport = { commentId: string; userId: string };

/** A short reply attached to a review item, kept out of the main chat. */
export type CommentReply = {
  id: string;
  commentId: string;
  authorId: string;
  authorName: string;
  authorColor: string;
  body: string;
  createdAt: number;
};

/** A viewer's take on a version's proposals: like a proposal id, or keep the original. */
export const KEEP_ORIGINAL = "__original__";
export type ProposalPref = { versionId: string; userId: string; choice: string };

export type Room = {
  id: string;
  title: string;
  /** Absent on every room created before video review shipped — normalized to "image". */
  mediaType?: MediaType;
  versions: Version[];
  comments: CommentPin[];
  strokes: Stroke[];
  messages: ChatMessage[];
  updatedAt: number;
  // Low-friction feedback (PR #13). Optional so older cached rooms stay valid.
  supports?: CommentSupport[];
  replies?: CommentReply[];
  proposalPrefs?: ProposalPref[];
  /** Present for project rooms; absent on legacy single-media rooms. */
  projectMode?: boolean;
  branches?: RoomBranch[];
  /** Summary-only project data; no image/video bytes or full comment bodies. */
  branchSummaries?: BranchSummary[];
  plans?: PlanDocument[];
  relations?: ContentRelation[];
  polls?: RoomPoll[];
  pollVotes?: PollVote[];
};

export type Guest = {
  id: string;
  name: string;
  color: string;
};

/**
 * "region" is the one-shot mobile 圈範圍 mode: the freehand gesture only lives
 * in memory and collapses into an AnnotationRegion on pointer up. It is never
 * surfaced as a persistent tool the way draw/erase are on desktop.
 */
export type Tool = "pan" | "pin" | "draw" | "erase" | "region";
export type ColorMode = "color" | "gray" | "split";
export type CompareMode = "single" | "side" | "wipe";

export type ViewState = {
  versionId: string;
  compareId: string;
  colorMode: ColorMode;
  compareMode: CompareMode;
  split: number;
  wipe: number;
};

export type PeerMsg =
  | { t: "hello"; guest: Guest }
  | { t: "snapshot"; room: Room; view: ViewState }
  | { t: "room"; room: Room }
  | { t: "view"; view: ViewState }
  | { t: "cursor"; x: number; y: number; name: string; color: string };

export const COLORS = ["#c45c4a", "#3d6b8c", "#5a7a4a", "#8a5a3a", "#6b5a8c", "#2f6f6a"] as const;

export const VERSION_LABELS = ["初稿", "改一", "改二", "改三", "改四"] as const;

/**
 * Cut names read differently from poster drafts, so video rooms get their own.
 *
 * No 最終版 here on purpose: the sixth cut would then be 改5 sitting after a
 * version that claims to be final. "Final" is something a person decides and
 * renames to, not the app's guess about the fifth upload.
 */
export const VIDEO_VERSION_LABELS = ["初剪", "改一", "改二", "改三", "改四"] as const;

/** Older rooms carry no mediaType; they are all image rooms. */
export function roomMediaType(room: Pick<Room, "mediaType">): MediaType {
  return room.mediaType === "video" ? "video" : "image";
}

export const REVIEW_TYPES: ReviewType[] = ["文字", "排版", "圖片", "顏色", "資訊錯誤", "其他"];

export const REVIEW_PRIORITIES: ReviewPriority[] = ["一般", "重要", "急"];
