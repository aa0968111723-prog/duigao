import type { ReactNode } from "react";
import type { ShowToast } from "../toast";
import type {
  AnnotationRegion,
  CommentReply,
  Guest,
  Point,
  ReactionType,
  ReviewPriority,
  ReviewStatus,
  ReviewType,
  Room,
  Tool,
  Verdict,
  VideoAnchor,
  VideoCategory,
  ViewState,
} from "../lib/types";
import type { BriefInput } from "../cloud/videoReview";
import type { ReviewData } from "../cloud/useCloudRoom";
import type { IntelligentAsset, RoomContextFocus } from "../lib/assetIntelligence";

export type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * What a cut is doing on its way into the room. `progress` is a real byte
 * fraction, never a timer: a bar that moves on its own while the network is
 * stalled is worse than no bar.
 */
export type VideoUploadState =
  | { state: "idle" }
  | { state: "preparing"; progress: number; cancel: () => void }
  | { state: "optimizing"; progress: number; cancel: () => void }
  | { state: "uploading"; progress: number; cancel: () => void; pause?: () => void }
  | { state: "paused"; progress: number; cancel: () => void; resume: () => void }
  | { state: "retrying"; progress: number; cancel: () => void }
  | { state: "processing"; progress: number; cancel: () => void }
  | { state: "error"; message: string; progress: number; cancel: () => void };

/**
 * The video-only half of the workspace contract.
 *
 * Present only on video rooms, so the poster workspace neither sees it nor has
 * to ignore it — the two surfaces stay separate without a single `if (video)`
 * inside the image code.
 */
export type VideoApi = {
  upload: VideoUploadState;
  /** File the current draft against a moment or a stretch. */
  commitVideoComment: (anchor: VideoAnchor, category?: VideoCategory) => void;
  /** Re-sign the playing version's URL after an expiry. */
  refreshVideoUrl: (path: string) => Promise<string | null>;

  /* ------------------------------------------------ 影片對稿 2.0 (#32) -- */

  /** Briefs, reactions, verdicts and progress for this room. Empty offline. */
  review: ReviewData;
  /** Whether this visitor may write the brief and triage other people's feedback. */
  canManageReview: boolean;
  /** This visitor's cloud id, for "my verdict" / "my reaction" lookups. */
  myUserId: string;
  /** Only meaningful in a cloud room; a local-only room cannot review. */
  reviewOnline: boolean;
  saveBrief: (versionId: string, input: BriefInput) => void;
  react: (versionId: string, time: number, type: ReactionType) => void;
  setVerdict: (versionId: string, verdict: Verdict, note?: string) => void;
  reportProgress: (versionId: string, maxWatched: number, completed: boolean) => void;
  setStatus: (commentId: string, status: ReviewStatus) => void;
  archiveVersion?: (versionId: string) => void;
  restoreVersion?: (versionId: string) => void;
  addToLibrary?: (versionId: string) => void;
};

/** A pending piece of feedback. When it came from a 圈範圍 gesture, `region` is set and x/y are its center. */
export type PinDraft = { versionId: string; x: number; y: number; region?: AnnotationRegion };

export type PinForm = {
  body: string;
  suggestion: string;
  type: ReviewType;
  priority: ReviewPriority;
};

/**
 * Everything a workspace shell (mobile or desktop) needs. App owns the state;
 * the shells only decide how it is laid out, so both surfaces stay in sync.
 */
export type WorkspaceApi = {
  room: Room;
  view: ViewState;
  guest: Guest;
  tool: Tool;
  draftPin: PinDraft | null;
  form: PinForm;
  selectedPinId: string | null;
  /** Legacy stroke being previewed from the 舊圈畫 manager; null keeps view mode clean. */
  previewStrokeId: string | null;
  chatInput: string;
  /** single 房的房級討論面（雲端房才有）；工作區把它掛進自己的聊天位。 */
  discussionDrawer?: ReactNode;
  saveState: SaveState;
  coachSeen: boolean;
  canUndo: boolean;
  setTool: (t: Tool) => void;
  setView: (v: ViewState) => void;
  setForm: (patch: Partial<PinForm>) => void;
  placePin: (versionId: string, x: number, y: number) => void;
  /** A finished 圈範圍 gesture: opens the composer with the computed region. */
  placeRegion: (versionId: string, region: AnnotationRegion) => void;
  commitPin: () => void;
  cancelPin: () => void;
  setPreviewStroke: (id: string | null) => void;
  selectPin: (id: string | null) => void;
  toggleResolve: (id: string) => void;
  addStroke: (versionId: string, points: Point[]) => void;
  eraseStroke: (id: string) => void;
  toggleSupport: (commentId: string) => void;
  addReply: (commentId: string, body: string) => void;
  setProposalPref: (versionId: string, choice: string) => void;
  undo: () => void;
  setChatInput: (v: string) => void;
  sendChat: () => void;
  addFiles: (files: FileList | null) => void;
  setTitle: (title: string) => void;
  copySummary: () => void;
  markCoachSeen: () => void;
  showToast: ShowToast;
  openShare: () => void;
  goHome: () => void;
  /** Seek a video cut when opening from a board card. Poster rooms ignore it. */
  openAtSeconds?: number;
  /** Only on video rooms. Absent means "this is a poster room". */
  video?: VideoApi;
  /** Optional mobile-first AI entry point; omitted when cloud AI is unavailable. */
  ai?: {
    assets: IntelligentAsset[];
    open: (assetId?: string) => void;
    focusTarget?: RoomContextFocus | null;
  };
};

/** Number review items within their own poster version, not across all versions. */
export function pinNumber(room: Room, pinId: string): number {
  const pin = room.comments.find((c) => c.id === pinId);
  if (!pin) return 0;
  let n = 0;
  for (const item of room.comments) {
    if (item.versionId !== pin.versionId) continue;
    n += 1;
    if (item.id === pinId) return n;
  }
  return 0;
}

export function nextPinNumber(room: Room, versionId: string): number {
  return room.comments.filter((c) => c.versionId === versionId).length + 1;
}

export function versionLabel(room: Room, versionId: string): string {
  return room.versions.find((v) => v.id === versionId)?.label ?? "";
}

export function supportCount(room: Room, commentId: string): number {
  return (room.supports ?? []).filter((s) => s.commentId === commentId).length;
}

export function hasSupported(room: Room, commentId: string, userId: string): boolean {
  return (room.supports ?? []).some((s) => s.commentId === commentId && s.userId === userId);
}

export function repliesFor(room: Room, commentId: string): CommentReply[] {
  return (room.replies ?? [])
    .filter((r) => r.commentId === commentId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** For the "N people提出 M 個修改建議" reassurance line after submitting. */
export function feedbackStats(room: Room): { people: number; count: number } {
  const people = new Set(room.comments.map((c) => c.authorName));
  return { people: people.size, count: room.comments.length };
}
