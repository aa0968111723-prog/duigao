import type { ShowToast } from "../toast";
import type {
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

export function pinNumber(room: Room, pinId: string): number {
  return room.comments.findIndex((c) => c.id === pinId) + 1;
}

export function versionLabel(room: Room, versionId: string): string {
  return room.versions.find((v) => v.id === versionId)?.label ?? "";
}
