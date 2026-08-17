export type Point = { x: number; y: number };

export type Version = {
  id: string;
  label: string;
  imageDataUrl: string;
};

export type ReviewType = "文字" | "排版" | "圖片" | "顏色" | "資訊錯誤" | "其他";
export type ReviewPriority = "一般" | "重要" | "急";
export type ReviewStatus = "open" | "in_progress" | "verify" | "resolved";

export type CommentPin = {
  id: string;
  versionId: string;
  authorId: string;
  authorName: string;
  authorColor: string;
  x: number;
  y: number;
  body: string;
  suggestion?: string;
  problemType?: ReviewType;
  priority?: ReviewPriority;
  /** Legacy compatibility. New UI uses status but keeps this in sync. */
  resolved: boolean;
  status?: ReviewStatus;
  assigneeId?: string;
  assigneeName?: string;
  supporters?: string[];
  carriedFromId?: string;
  createdAt: number;
  updatedAt?: number;
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

export type Room = {
  id: string;
  title: string;
  versions: Version[];
  comments: CommentPin[];
  strokes: Stroke[];
  messages: ChatMessage[];
  updatedAt: number;
};

export type Guest = {
  id: string;
  name: string;
  color: string;
};

export type Tool = "pan" | "pin" | "draw" | "erase";
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
