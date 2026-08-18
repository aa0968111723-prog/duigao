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

export type Version = {
  id: string;
  label: string;
  imageDataUrl: string;
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

export const REVIEW_TYPES: ReviewType[] = ["文字", "排版", "圖片", "顏色", "資訊錯誤", "其他"];

export const REVIEW_PRIORITIES: ReviewPriority[] = ["一般", "重要", "急"];
