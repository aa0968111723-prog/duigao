import type { ShowToast } from "../toast";
import type {
  CommentReply,
  Guest,
  Point,
  ReviewPriority,
  ReviewType,
  Room,
  Tool,
  ViewState,
} from "../lib/types";

export type SaveState = "idle" | "saving" | "saved" | "error";

export type PinDraft = { versionId: string; x: number; y: number };

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
  chatInput: string;
  saveState: SaveState;
  coachSeen: boolean;
  canUndo: boolean;
  setTool: (t: Tool) => void;
  setView: (v: ViewState) => void;
  setForm: (patch: Partial<PinForm>) => void;
  placePin: (versionId: string, x: number, y: number) => void;
  commitPin: () => void;
  cancelPin: () => void;
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
