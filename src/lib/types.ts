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
};

export type ReviewType = "文字" | "排版" | "圖片" | "顏色" | "資訊錯誤" | "其他";
export type ReviewPriority = "一般" | "重要" | "急";

export type CommentPin = {
  id: string;
  versionId: string;
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
  createdAt: number;
};

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

/** Cut names read differently from poster drafts, so video rooms get their own. */
export const VIDEO_VERSION_LABELS = ["初剪", "改一", "改二", "改三", "最終版"] as const;

/** Older rooms carry no mediaType; they are all image rooms. */
export function roomMediaType(room: Pick<Room, "mediaType">): MediaType {
  return room.mediaType === "video" ? "video" : "image";
}

export const REVIEW_TYPES: ReviewType[] = ["文字", "排版", "圖片", "顏色", "資訊錯誤", "其他"];

export const REVIEW_PRIORITIES: ReviewPriority[] = ["一般", "重要", "急"];
