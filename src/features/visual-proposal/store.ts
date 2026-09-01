import { useCallback, useEffect, useSyncExternalStore } from "react";
import { uid } from "../../lib/id";
import { cloneProposalDocsToVersion } from "./saveComposeVersion";
import { mergeActiveByVersionForHydrate, mergeProposalDocsForHydrate } from "./mergeHydrate";
import { parseCrop, replaceImageKeepingBox, resetImageGeometry, type CropInsets } from "./quickEdit";

export type ProposalAlign = "left" | "center" | "right";
export type TextRole = "title" | "subtitle" | "body" | "date" | "place" | "cta" | "custom";
export type GradientKind = "none" | "vertical" | "horizontal" | "diagonal";
export type BgImageFit = "cover" | "contain";

/** What a proposal is about. Drives the badge on the proposal card only — never the editor. */
export type ProposalType = "text" | "font" | "background" | "asset" | "layout" | "color";

/** Where a proposal sits in the discussion. 已採用 is the one everyone needs to spot fast. */
export type ProposalStatus = "draft" | "discussing" | "accepted" | "rejected";

/** 原稿 / 提案 / 對照 — the whole viewing model on mobile. */
export type ProposalViewMode = "original" | "proposal" | "compare";

/** Whoever is looking: needed for 我支持這個提案 and proposal comments. */
export type ProposalAuthor = { id: string; name: string; color: string };

export type ProposalSupport = { userId: string; userName: string; createdAt: number };

export type ProposalComment = {
  id: string;
  authorId: string;
  authorName: string;
  authorColor: string;
  body: string;
  createdAt: number;
};

export type ProposalBackground = {
  color: string;
  colorOpacity: number;
  gradient: GradientKind;
  gradientFrom: string;
  gradientTo: string;
  gradientOpacity: number;
  imageDataUrl?: string;
  imageOpacity: number;
  imageFit: BgImageFit;
};

/** Fields every proposal element shares: position, size, opacity, visibility. */
type ProposalItemBase = {
  id: string;
  x: number;
  y: number;
  width: number;
  rotation: number;
  opacity: number;
  /** Hidden elements stay in the proposal but are not drawn — cheaper than delete + undo. */
  visible: boolean;
};

export type ProposalTextItem = ProposalItemBase & {
  type: "text";
  role: TextRole;
  text: string;
  fontFamily: string;
  fontStyle: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  align: ProposalAlign;
  backdropColor: string;
  backdropOpacity: number;
  backdropPadding: number;
  backdropRadius: number;
};

export type ImageCrop = { x: number; y: number; width: number; height: number };

export type ProposalImageItem = ProposalItemBase & {
  type: "image";
  name: string;
  imageDataUrl: string;
  /** Insets `{l,t,r,b}` or box `{x,y,width,height}`. Display is CSS-only. */
  crop?: CropInsets | ImageCrop;
};

/** A plain colour block: the cheapest way to say "put something solid here". */
export type ProposalShapeItem = ProposalItemBase & {
  type: "shape";
  color: string;
  /** Percentage of the poster height (width is a percentage of its width). */
  height: number;
  radius: number;
};

export type ProposalItem = ProposalTextItem | ProposalImageItem | ProposalShapeItem;

export type VisualProposal = {
  id: string;
  versionId: string;
  /**
   * Legacy cloud column (`visual_proposals.name`). It always mirrors `title`;
   * `title` is the single field the UI reads and writes.
   */
  name: string;
  title: string;
  description: string;
  type: ProposalType;
  status: ProposalStatus;
  createdBy: string;
  authorName: string;
  /** The 修改點 this proposal answers, when it was started from one. */
  linkedCommentId?: string;
  supports: ProposalSupport[];
  comments: ProposalComment[];
  items: ProposalItem[];
  background: ProposalBackground;
  createdAt: number;
  updatedAt: number;
};

type PersistedProposalState = {
  roomId: string;
  docs: VisualProposal[];
  activeByVersion: Record<string, string>;
};

type HistorySnapshot = { docs: VisualProposal[]; activeByVersion: Record<string, string> };

type ProposalRuntimeState = PersistedProposalState & {
  hydrated: boolean;
  viewMode: ProposalViewMode;
  editing: boolean;
  /** 0..1 wipe position used by the 對照 view. */
  compareSplit: number;
  selectedItemId: string | null;
  undo: HistorySnapshot[];
  redo: HistorySnapshot[];
  error: string | null;
};

export type ProposalItemPatch =
  | Partial<Omit<ProposalTextItem, "id" | "type">>
  | Partial<Omit<ProposalImageItem, "id" | "type">>
  | Partial<Omit<ProposalShapeItem, "id" | "type">>;

const DB_NAME = "duigao-visual-proposals";
const DB_VERSION = 1;
const STORE = "rooms";
const HISTORY_LIMIT = 25;

const PROPOSAL_TYPES: ProposalType[] = ["text", "font", "background", "asset", "layout", "color"];
const PROPOSAL_STATUSES: ProposalStatus[] = ["draft", "discussing", "accepted", "rejected"];

const EMPTY_BACKGROUND: ProposalBackground = {
  color: "#000000",
  colorOpacity: 0,
  gradient: "none",
  gradientFrom: "#000000",
  gradientTo: "#c45c4a",
  gradientOpacity: 0,
  imageOpacity: 1,
  imageFit: "cover",
};

const states = new Map<string, ProposalRuntimeState>();
const listeners = new Map<string, Set<() => void>>();
const hydrating = new Set<string>();
const hydrateQueued = new Set<string>();
const checkpoints = new Map<string, { snap: HistorySnapshot; dirty: boolean }>();
let channel: BroadcastChannel | null = null;

function emptyState(roomId: string): ProposalRuntimeState {
  return {
    roomId,
    docs: [],
    activeByVersion: {},
    hydrated: false,
    viewMode: "proposal",
    editing: false,
    compareSplit: 0.5,
    selectedItemId: null,
    undo: [],
    redo: [],
    error: null,
  };
}

function snapshot(roomId: string): ProposalRuntimeState {
  let state = states.get(roomId);
  if (!state) {
    state = emptyState(roomId);
    states.set(roomId, state);
  }
  return state;
}

function emit(roomId: string) {
  listeners.get(roomId)?.forEach((listener) => listener());
}

function subscribe(roomId: string, listener: () => void) {
  let set = listeners.get(roomId);
  if (!set) {
    set = new Set();
    listeners.set(roomId, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
    if (set?.size === 0) listeners.delete(roomId);
  };
}

/* ---------- migration / normalization of possibly-old persisted data ---------- */

function normalizeBackground(raw: unknown): ProposalBackground {
  const bg = (raw ?? {}) as Partial<ProposalBackground>;
  return {
    color: typeof bg.color === "string" ? bg.color : EMPTY_BACKGROUND.color,
    colorOpacity: clampNum(bg.colorOpacity, 0, 1, 0),
    gradient: (["none", "vertical", "horizontal", "diagonal"] as GradientKind[]).includes(bg.gradient as GradientKind)
      ? (bg.gradient as GradientKind)
      : "none",
    gradientFrom: typeof bg.gradientFrom === "string" ? bg.gradientFrom : EMPTY_BACKGROUND.gradientFrom,
    gradientTo: typeof bg.gradientTo === "string" ? bg.gradientTo : EMPTY_BACKGROUND.gradientTo,
    gradientOpacity: clampNum(bg.gradientOpacity, 0, 1, 0),
    imageDataUrl: typeof bg.imageDataUrl === "string" ? bg.imageDataUrl : undefined,
    imageOpacity: clampNum(bg.imageOpacity, 0, 1, 1),
    imageFit: bg.imageFit === "contain" ? "contain" : "cover",
  };
}

export function normalizeItem(raw: unknown): ProposalItem | null {
  const item = raw as Partial<ProposalItem> & { type?: string };
  if (!item || typeof item.id !== "string") return null;
  const base: ProposalItemBase = {
    id: item.id,
    x: clampNum((item as ProposalItem).x, 0, 1, 0.5),
    y: clampNum((item as ProposalItem).y, 0, 1, 0.5),
    width: clampNum((item as ProposalItem).width, 4, 100, 35),
    rotation: clampNum((item as ProposalItem).rotation, -180, 180, 0),
    opacity: clampNum((item as ProposalItem).opacity, 0.05, 1, 1),
    // Anything persisted before 2.0 has no `visible` flag and was always drawn.
    visible: (item as ProposalItem).visible !== false,
  };
  if (item.type === "image") {
    const img = item as Partial<ProposalImageItem>;
    if (typeof img.imageDataUrl !== "string") return null;
    const crop = parseCrop(img.crop) ?? normalizeCrop(img.crop);
    return {
      ...base,
      type: "image",
      name: img.name ?? "素材",
      imageDataUrl: img.imageDataUrl,
      ...(crop ? { crop } : {}),
    };
  }
  if (item.type === "shape") {
    const shape = item as Partial<ProposalShapeItem>;
    return {
      ...base,
      type: "shape",
      color: typeof shape.color === "string" ? shape.color : "#c45c4a",
      height: clampNum(shape.height, 2, 100, 18),
      radius: clampNum(shape.radius, 0, 60, 10),
    };
  }
  const txt = item as Partial<ProposalTextItem>;
  return {
    ...base,
    type: "text",
    role: (["title", "subtitle", "body", "date", "place", "cta", "custom"] as TextRole[]).includes(txt.role as TextRole)
      ? (txt.role as TextRole)
      : "custom",
    text: typeof txt.text === "string" ? txt.text : "文字",
    fontFamily: typeof txt.fontFamily === "string" ? txt.fontFamily : '"Noto Sans TC", sans-serif',
    fontStyle: typeof txt.fontStyle === "string" ? txt.fontStyle : "modern",
    fontSize: clampNum(txt.fontSize, 1.5, 16, 5),
    fontWeight: clampNum(txt.fontWeight, 100, 900, 700),
    color: typeof txt.color === "string" ? txt.color : "#ffffff",
    align: (["left", "center", "right"] as ProposalAlign[]).includes(txt.align as ProposalAlign)
      ? (txt.align as ProposalAlign)
      : "center",
    backdropColor: typeof txt.backdropColor === "string" ? txt.backdropColor : "#000000",
    backdropOpacity: clampNum(txt.backdropOpacity, 0, 1, 0),
    backdropPadding: clampNum(txt.backdropPadding, 0, 2, 0.3),
    backdropRadius: clampNum(txt.backdropRadius, 0, 40, 8),
  };
}

function normalizeSupports(raw: unknown): ProposalSupport[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ProposalSupport[] = [];
  for (const entry of raw) {
    const s = entry as Partial<ProposalSupport>;
    if (!s || typeof s.userId !== "string" || seen.has(s.userId)) continue;
    seen.add(s.userId);
    out.push({
      userId: s.userId,
      userName: typeof s.userName === "string" ? s.userName : "夥伴",
      createdAt: typeof s.createdAt === "number" ? s.createdAt : Date.now(),
    });
  }
  return out;
}

function normalizeComments(raw: unknown): ProposalComment[] {
  if (!Array.isArray(raw)) return [];
  const out: ProposalComment[] = [];
  for (const entry of raw) {
    const c = entry as Partial<ProposalComment>;
    if (!c || typeof c.id !== "string" || typeof c.body !== "string") continue;
    out.push({
      id: c.id,
      authorId: typeof c.authorId === "string" ? c.authorId : "",
      authorName: typeof c.authorName === "string" ? c.authorName : "夥伴",
      authorColor: typeof c.authorColor === "string" ? c.authorColor : "#3d6b8c",
      body: c.body,
      createdAt: typeof c.createdAt === "number" ? c.createdAt : Date.now(),
    });
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

export function normalizeDoc(raw: unknown): VisualProposal | null {
  const doc = raw as Partial<VisualProposal>;
  if (!doc || typeof doc.id !== "string" || typeof doc.versionId !== "string") return null;
  const items = Array.isArray(doc.items)
    ? doc.items.map(normalizeItem).filter((i): i is ProposalItem => i != null)
    : [];
  // Pre-2.0 proposals only had `name`; it becomes the title and keeps mirroring it.
  const title =
    (typeof doc.title === "string" && doc.title.trim()) || (typeof doc.name === "string" && doc.name.trim()) || "提案";
  const now = Date.now();
  return {
    id: doc.id,
    versionId: doc.versionId,
    name: title,
    title,
    description: typeof doc.description === "string" ? doc.description : "",
    type: PROPOSAL_TYPES.includes(doc.type as ProposalType) ? (doc.type as ProposalType) : "layout",
    status: PROPOSAL_STATUSES.includes(doc.status as ProposalStatus) ? (doc.status as ProposalStatus) : "draft",
    createdBy: typeof doc.createdBy === "string" ? doc.createdBy : "",
    authorName: typeof doc.authorName === "string" ? doc.authorName : "夥伴",
    ...(typeof doc.linkedCommentId === "string" && doc.linkedCommentId
      ? { linkedCommentId: doc.linkedCommentId }
      : {}),
    supports: normalizeSupports(doc.supports),
    comments: normalizeComments(doc.comments),
    items,
    background: normalizeBackground(doc.background),
    createdAt: typeof doc.createdAt === "number" ? doc.createdAt : now,
    updatedAt: typeof doc.updatedAt === "number" ? doc.updatedAt : now,
  };
}

function clampNum(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeCrop(raw: unknown): ImageCrop | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const crop = raw as Partial<ImageCrop>;
  if (typeof crop.x !== "number" || typeof crop.y !== "number" || typeof crop.width !== "number" || typeof crop.height !== "number") {
    return undefined;
  }
  const x = clampNum(crop.x, 0, 0.85, 0);
  const y = clampNum(crop.y, 0, 0.85, 0);
  return {
    x,
    y,
    width: clampNum(crop.width, 0.15, 1 - x, 1),
    height: clampNum(crop.height, 0.15, 1 - y, 1),
  };
}

/* ---------- IndexedDB ---------- */

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "roomId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("blocked"));
  });
}

async function loadPersisted(roomId: string): Promise<PersistedProposalState | undefined> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).get(roomId);
      request.onsuccess = () => resolve(request.result as PersistedProposalState | undefined);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function savePersisted(state: ProposalRuntimeState): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({
        roomId: state.roomId,
        docs: state.docs,
        activeByVersion: state.activeByVersion,
      } satisfies PersistedProposalState);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function hydrate(roomId: string, force = false) {
  if (hydrating.has(roomId)) {
    if (force) hydrateQueued.add(roomId);
    return;
  }
  const current = snapshot(roomId);
  if (current.hydrated && !force) return;
  hydrating.add(roomId);
  try {
    const saved = await loadPersisted(roomId);
    const latest = snapshot(roomId);
    const savedDocs = Array.isArray(saved?.docs)
      ? saved!.docs.map(normalizeDoc).filter((d): d is VisualProposal => d != null)
      : [];
    const docs = saved
      ? mergeProposalDocsForHydrate(latest.docs, savedDocs)
      : latest.docs;
    const savedActive = saved?.activeByVersion && typeof saved.activeByVersion === "object"
      ? saved.activeByVersion
      : {};
    states.set(roomId, {
      ...latest,
      roomId,
      docs,
      activeByVersion: saved
        ? mergeActiveByVersionForHydrate(latest.activeByVersion, savedActive, docs)
        : latest.activeByVersion,
      hydrated: true,
      error: null,
    });
    emit(roomId);
  } catch {
    // Corrupt or unreadable data must not crash the app; start clean but usable.
    states.set(roomId, { ...snapshot(roomId), hydrated: true, error: "讀取這台裝置的提案時發生問題，已改用目前的工作層。" });
    emit(roomId);
  } finally {
    hydrating.delete(roomId);
    if (hydrateQueued.delete(roomId)) void hydrate(roomId, true);
  }
}

function ensureChannel() {
  if (channel || typeof BroadcastChannel === "undefined") return;
  try {
    channel = new BroadcastChannel("duigao-visual-proposals");
    channel.onmessage = (event) => {
      const roomId = typeof event.data === "string" ? event.data : "";
      if (roomId) void hydrate(roomId, true);
    };
  } catch {
    channel = null;
  }
}

function friendlyDbError(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "QuotaExceededError" || String(err).includes("quota")) {
    return "這個提案暫時無法儲存，裝置空間不足，請先移除較大的素材或背景圖。";
  }
  return "這個提案暫時無法儲存，請稍後再試一次。";
}

function persist(roomId: string) {
  const state = snapshot(roomId);
  void savePersisted(state)
    .then(() => {
      ensureChannel();
      channel?.postMessage(roomId);
      if (snapshot(roomId).error) {
        states.set(roomId, { ...snapshot(roomId), error: null });
        emit(roomId);
      }
    })
    .catch((err) => {
      states.set(roomId, { ...snapshot(roomId), error: friendlyDbError(err) });
      emit(roomId);
    });
  pushChangedDocs(roomId);
}

/* ---------- cloud bridge (additive; inert until a sync is registered) ---------- */

type CloudDocPush = (doc: VisualProposal) => void;
let cloudSync: { roomId: string; push: CloudDocPush } | null = null;
const lastPushed = new Map<string, Map<string, VisualProposal>>();

/** Wire (or clear) cloud sync for a room. `push` receives each changed proposal. */
export function setProposalCloudSync(roomId: string, push: CloudDocPush | null): void {
  if (!push) {
    if (cloudSync?.roomId === roomId) cloudSync = null;
    return;
  }
  cloudSync = { roomId, push };
  // Seed baseline from current docs so we do not re-push what is already known.
  const map = new Map<string, VisualProposal>();
  for (const doc of snapshot(roomId).docs) map.set(doc.id, doc);
  lastPushed.set(roomId, map);
}

function pushChangedDocs(roomId: string) {
  if (!cloudSync || cloudSync.roomId !== roomId) return;
  const map = lastPushed.get(roomId) ?? new Map<string, VisualProposal>();
  for (const doc of snapshot(roomId).docs) {
    if (map.get(doc.id) !== doc) {
      map.set(doc.id, doc);
      cloudSync.push(doc);
    }
  }
  lastPushed.set(roomId, map);
}

/** Snapshot of a room's proposals (used to migrate local proposals to the cloud). */
export function getProposalDocs(roomId: string): VisualProposal[] {
  return snapshot(roomId).docs;
}

/** Merge proposals loaded from the cloud into the store without echoing them back. */
export function applyCloudProposals(roomId: string, incoming: VisualProposal[]): void {
  if (incoming.length === 0) return;
  const current = snapshot(roomId);
  const byId = new Map(current.docs.map((d) => [d.id, d] as const));
  for (const doc of incoming) byId.set(doc.id, doc);
  const docs = [...byId.values()];
  states.set(roomId, { ...current, docs, hydrated: true });
  const map = lastPushed.get(roomId) ?? new Map<string, VisualProposal>();
  for (const doc of incoming) map.set(doc.id, byId.get(doc.id)!);
  lastPushed.set(roomId, map);
  emit(roomId);
  void savePersisted(snapshot(roomId)).catch(() => undefined);
}

function set(roomId: string, next: ProposalRuntimeState) {
  states.set(roomId, next);
  emit(roomId);
}

function snapshotHistory(state: ProposalRuntimeState): HistorySnapshot {
  return { docs: state.docs, activeByVersion: state.activeByVersion };
}

function pushUndo(state: ProposalRuntimeState): Pick<ProposalRuntimeState, "undo" | "redo"> {
  const undo = [...state.undo, snapshotHistory(state)].slice(-HISTORY_LIMIT);
  return { undo, redo: [] };
}

/* ---------- active-doc resolution ---------- */

function nextProposalTitle(docs: VisualProposal[], versionId: string) {
  const count = docs.filter((doc) => doc.versionId === versionId).length;
  const letter = String.fromCharCode(65 + Math.min(count, 25));
  return `提案 ${letter}`;
}

export type NewProposalOptions = {
  type?: ProposalType;
  title?: string;
  description?: string;
  linkedCommentId?: string;
};

function newProposal(
  versionId: string,
  author: ProposalAuthor,
  docs: VisualProposal[],
  options: NewProposalOptions = {},
): VisualProposal {
  const now = Date.now();
  const title = options.title?.trim() || nextProposalTitle(docs, versionId);
  return {
    id: uid("vp_"),
    versionId,
    name: title,
    title,
    description: options.description ?? "",
    type: options.type ?? "layout",
    status: "draft",
    createdBy: author.id,
    authorName: author.name,
    ...(options.linkedCommentId ? { linkedCommentId: options.linkedCommentId } : {}),
    supports: [],
    comments: [],
    items: [],
    background: { ...EMPTY_BACKGROUND },
    createdAt: now,
    updatedAt: now,
  };
}

/** Editing anything implies you want to see it: leave 原稿 for 提案, keep 對照 as-is. */
function viewAfterEdit(mode: ProposalViewMode): ProposalViewMode {
  return mode === "original" ? "proposal" : mode;
}

/** Apply a mutation to the active proposal for a version, creating one if needed. */
function editActive(
  state: ProposalRuntimeState,
  versionId: string,
  author: ProposalAuthor,
  mutate: (doc: VisualProposal) => VisualProposal,
  selectedItemId?: string | null,
): ProposalRuntimeState {
  let docs = state.docs;
  let activeId = state.activeByVersion[versionId];
  let active = docs.find((doc) => doc.id === activeId && doc.versionId === versionId);
  if (!active) {
    active = newProposal(versionId, author, docs);
    activeId = active.id;
    docs = [...docs, active];
  }
  const nextDoc = { ...mutate(active), updatedAt: Date.now() };
  return {
    ...state,
    docs: docs.map((doc) => (doc.id === active!.id ? nextDoc : doc)),
    activeByVersion: { ...state.activeByVersion, [versionId]: activeId },
    viewMode: viewAfterEdit(state.viewMode),
    selectedItemId: selectedItemId === undefined ? state.selectedItemId : selectedItemId,
  };
}

function commitActiveDoc(
  roomId: string,
  versionId: string,
  author: ProposalAuthor,
  mutate: (doc: VisualProposal) => VisualProposal,
  selectedItemId?: string | null,
): void {
  const current = snapshot(roomId);
  const withHistory = { ...current, ...pushUndo(current) };
  set(roomId, {
    ...editActive(withHistory, versionId, author, mutate, selectedItemId),
    editing: true,
  });
  persist(roomId);
}

/** Same path Overlay / Dock use via the hook. Tests drive this, not a copy. */
export function updateProposalItem(
  roomId: string,
  versionId: string,
  author: ProposalAuthor,
  itemId: string,
  patch: ProposalItemPatch,
): void {
  commitActiveDoc(
    roomId,
    versionId,
    author,
    (doc) => ({
      ...doc,
      items: doc.items.map((item) => (item.id === itemId ? ({ ...item, ...patch } as ProposalItem) : item)),
    }),
    itemId,
  );
}

export function addProposalItem(roomId: string, versionId: string, author: ProposalAuthor, item: ProposalItem): void {
  commitActiveDoc(roomId, versionId, author, (doc) => ({ ...doc, items: [...doc.items, item] }), item.id);
}

export function undoProposalEdits(roomId: string): void {
  const current = snapshot(roomId);
  if (current.undo.length === 0) return;
  const previous = current.undo[current.undo.length - 1];
  set(roomId, {
    ...current,
    docs: previous.docs,
    activeByVersion: previous.activeByVersion,
    undo: current.undo.slice(0, -1),
    redo: [...current.redo, snapshotHistory(current)].slice(-HISTORY_LIMIT),
    selectedItemId: null,
  });
  persist(roomId);
}

/** Open compose dock only when editing started, never after 完成 cleared the session. */
export function shouldSyncComposeSession(layerEditing: boolean, hasSession: boolean, exiting: boolean): boolean {
  return layerEditing && !hasSession && !exiting;
}

/* ---------- read-only helpers usable outside the editor ---------- */

/** All proposals in a room, for surfaces that only need to read (e.g. 修改點卡片). */
export function useRoomProposals(roomId: string): { hydrated: boolean; docs: VisualProposal[] } {
  useEffect(() => {
    ensureChannel();
    void hydrate(roomId);
  }, [roomId]);

  const state = useSyncExternalStore(
    useCallback((listener) => subscribe(roomId, listener), [roomId]),
    useCallback(() => snapshot(roomId), [roomId]),
    useCallback(() => snapshot(roomId), [roomId]),
  );
  return { hydrated: state.hydrated, docs: state.docs };
}

/* ---------- public store hook ---------- */

export function useProposalStore(roomId: string, versionId: string, author: ProposalAuthor) {
  useEffect(() => {
    ensureChannel();
    void hydrate(roomId);
  }, [roomId]);

  const state = useSyncExternalStore(
    useCallback((listener) => subscribe(roomId, listener), [roomId]),
    useCallback(() => snapshot(roomId), [roomId]),
    useCallback(() => snapshot(roomId), [roomId]),
  );

  const authorId = author.id;
  const authorName = author.name;
  const authorColor = author.color;

  const docs = state.docs.filter((doc) => doc.versionId === versionId);
  const activeId = state.activeByVersion[versionId];
  const active = docs.find((doc) => doc.id === activeId) ?? docs[0];
  const selectedItem = active?.items.find((item) => item.id === state.selectedItemId);

  /* discrete commit: one history step + persist */
  const commit = useCallback(
    (mutate: (doc: VisualProposal) => VisualProposal, selectedItemId?: string | null) => {
      const current = snapshot(roomId);
      const withHistory = { ...current, ...pushUndo(current) };
      set(roomId, {
        ...editActive(withHistory, versionId, { id: authorId, name: authorName, color: authorColor }, mutate, selectedItemId),
        editing: true,
      });
      persist(roomId);
    },
    [roomId, versionId, authorId, authorName, authorColor],
  );

  /**
   * Discussion writes (support / comment / status / meta) target one proposal by
   * id and never enter the undo stack — undoing someone's 支持 would be odd.
   */
  const commitDoc = useCallback(
    (id: string, mutate: (doc: VisualProposal) => VisualProposal) => {
      const current = snapshot(roomId);
      if (!current.docs.some((doc) => doc.id === id)) return;
      set(roomId, {
        ...current,
        docs: current.docs.map((doc) => (doc.id === id ? { ...mutate(doc), updatedAt: Date.now() } : doc)),
      });
      persist(roomId);
    },
    [roomId],
  );

  /* continuous gesture: begin -> live* -> end (single history step, persist once) */
  const beginEdit = useCallback(() => {
    if (checkpoints.has(roomId)) return;
    checkpoints.set(roomId, { snap: snapshotHistory(snapshot(roomId)), dirty: false });
  }, [roomId]);

  const live = useCallback(
    (mutate: (doc: VisualProposal) => VisualProposal, selectedItemId?: string | null) => {
      const point = checkpoints.get(roomId);
      if (point) point.dirty = true;
      set(roomId, {
        ...editActive(snapshot(roomId), versionId, { id: authorId, name: authorName, color: authorColor }, mutate, selectedItemId),
        editing: true,
      });
    },
    [roomId, versionId, authorId, authorName, authorColor],
  );

  const endEdit = useCallback(() => {
    const point = checkpoints.get(roomId);
    checkpoints.delete(roomId);
    if (!point || !point.dirty) return;
    const current = snapshot(roomId);
    set(roomId, {
      ...current,
      undo: [...current.undo, point.snap].slice(-HISTORY_LIMIT),
      redo: [],
    });
    persist(roomId);
  }, [roomId]);

  const create = useCallback(
    (options: NewProposalOptions = {}) => {
      const current = snapshot(roomId);
      const doc = newProposal(versionId, { id: authorId, name: authorName, color: authorColor }, current.docs, options);
      set(roomId, {
        ...current,
        ...pushUndo(current),
        docs: [...current.docs, doc],
        activeByVersion: { ...current.activeByVersion, [versionId]: doc.id },
        viewMode: "proposal",
        editing: true,
        selectedItemId: null,
      });
      persist(roomId);
      return doc.id;
    },
    [roomId, versionId, authorId, authorName, authorColor],
  );

  const selectProposal = useCallback(
    (id: string) => {
      const current = snapshot(roomId);
      const target = current.docs.find((doc) => doc.id === id);
      if (!target) return;
      set(roomId, {
        ...current,
        activeByVersion: { ...current.activeByVersion, [target.versionId]: id },
        viewMode: viewAfterEdit(current.viewMode),
        selectedItemId: null,
      });
      persist(roomId);
    },
    [roomId],
  );

  const renameProposal = useCallback(
    (id: string, title: string) => {
      const next = title.trim();
      if (!next) return;
      commitDoc(id, (doc) => ({ ...doc, title: next, name: next }));
    },
    [commitDoc],
  );

  const setDescription = useCallback(
    (id: string, description: string) => commitDoc(id, (doc) => ({ ...doc, description })),
    [commitDoc],
  );

  const setType = useCallback(
    (id: string, type: ProposalType) => commitDoc(id, (doc) => ({ ...doc, type })),
    [commitDoc],
  );

  const setStatus = useCallback(
    (id: string, status: ProposalStatus) => commitDoc(id, (doc) => ({ ...doc, status })),
    [commitDoc],
  );

  const linkComment = useCallback(
    (id: string, commentId: string | null) =>
      commitDoc(id, (doc) => {
        const { linkedCommentId: _drop, ...rest } = doc;
        return commentId ? { ...rest, linkedCommentId: commentId } : rest;
      }),
    [commitDoc],
  );

  /** 我支持這個提案 — one per person, tapping again takes it back. */
  const toggleSupport = useCallback(
    (id: string) =>
      commitDoc(id, (doc) => {
        const has = doc.supports.some((s) => s.userId === authorId);
        return {
          ...doc,
          supports: has
            ? doc.supports.filter((s) => s.userId !== authorId)
            : [...doc.supports, { userId: authorId, userName: authorName, createdAt: Date.now() }],
        };
      }),
    [commitDoc, authorId, authorName],
  );

  const addComment = useCallback(
    (id: string, body: string) => {
      const text = body.trim();
      if (!text) return;
      commitDoc(id, (doc) => ({
        ...doc,
        // First reply moves a 草稿 into 討論中 on its own; nobody has to remember.
        status: doc.status === "draft" ? "discussing" : doc.status,
        comments: [
          ...doc.comments,
          {
            id: uid("pc_"),
            authorId,
            authorName,
            authorColor,
            body: text,
            createdAt: Date.now(),
          },
        ],
      }));
    },
    [commitDoc, authorId, authorName, authorColor],
  );

  const duplicateProposal = useCallback(
    (id: string) => {
      const current = snapshot(roomId);
      const source = current.docs.find((doc) => doc.id === id);
      if (!source) return "";
      const title = `${source.title} 複製`;
      const copy: VisualProposal = {
        ...source,
        id: uid("vp_"),
        name: title,
        title,
        status: "draft",
        createdBy: authorId,
        authorName,
        supports: [],
        comments: [],
        items: source.items.map((item) => ({ ...item, id: uid(itemPrefix(item.type)) })),
        background: { ...source.background },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      set(roomId, {
        ...current,
        ...pushUndo(current),
        docs: [...current.docs, copy],
        activeByVersion: { ...current.activeByVersion, [source.versionId]: copy.id },
        viewMode: "proposal",
        selectedItemId: null,
      });
      persist(roomId);
      return copy.id;
    },
    [roomId, authorId, authorName],
  );

  const deleteProposal = useCallback(
    (id: string) => {
      const current = snapshot(roomId);
      const target = current.docs.find((doc) => doc.id === id);
      if (!target) return;
      const remaining = current.docs.filter((doc) => doc.id !== id);
      const activeByVersion = { ...current.activeByVersion };
      if (activeByVersion[target.versionId] === id) {
        const fallback = remaining.find((doc) => doc.versionId === target.versionId);
        if (fallback) activeByVersion[target.versionId] = fallback.id;
        else delete activeByVersion[target.versionId];
      }
      set(roomId, {
        ...current,
        ...pushUndo(current),
        docs: remaining,
        activeByVersion,
        selectedItemId: null,
      });
      persist(roomId);
    },
    [roomId],
  );

  const setViewMode = useCallback(
    (viewMode: ProposalViewMode) => {
      const current = snapshot(roomId);
      set(roomId, {
        ...current,
        viewMode,
        // Only 提案 is editable: 原稿 must stay clean and 對照 must stay readable.
        editing: viewMode === "proposal" ? current.editing : false,
        selectedItemId: viewMode === "proposal" ? current.selectedItemId : null,
      });
    },
    [roomId],
  );

  const setCompareSplit = useCallback(
    (compareSplit: number) => set(roomId, { ...snapshot(roomId), compareSplit: Math.min(1, Math.max(0, compareSplit)) }),
    [roomId],
  );

  const setEditing = useCallback(
    (editing: boolean) => {
      const current = snapshot(roomId);
      set(roomId, {
        ...current,
        editing,
        viewMode: editing ? "proposal" : current.viewMode,
        selectedItemId: editing ? current.selectedItemId : null,
      });
    },
    [roomId],
  );

  const selectItem = useCallback((id: string | null) => set(roomId, { ...snapshot(roomId), selectedItemId: id }), [roomId]);

  const addText = useCallback(
    (item: ProposalTextItem) => commit((doc) => ({ ...doc, items: [...doc.items, item] }), item.id),
    [commit],
  );

  const addImage = useCallback(
    (item: ProposalImageItem) => addProposalItem(roomId, versionId, { id: authorId, name: authorName, color: authorColor }, item),
    [roomId, versionId, authorId, authorName, authorColor],
  );

  const addShape = useCallback(
    (item: ProposalShapeItem) => commit((doc) => ({ ...doc, items: [...doc.items, item] }), item.id),
    [commit],
  );

  const updateItem = useCallback(
    (id: string, patch: ProposalItemPatch) =>
      updateProposalItem(roomId, versionId, { id: authorId, name: authorName, color: authorColor }, id, patch),
    [roomId, versionId, authorId, authorName, authorColor],
  );

  const updateItemLive = useCallback(
    (id: string, patch: ProposalItemPatch) =>
      live(
        (doc) => ({ ...doc, items: doc.items.map((item) => (item.id === id ? ({ ...item, ...patch } as ProposalItem) : item)) }),
        id,
      ),
    [live],
  );

  const toggleItemVisible = useCallback(
    (id: string) => {
      const item = active?.items.find((i) => i.id === id);
      if (!item) return;
      updateItem(id, { visible: !item.visible });
    },
    [active, updateItem],
  );

  const deleteItem = useCallback((id: string) => commit((doc) => ({ ...doc, items: doc.items.filter((item) => item.id !== id) }), null), [commit]);

  const duplicateItem = useCallback(
    (id: string) => {
      const source = active?.items.find((item) => item.id === id);
      if (!source) return;
      const copy = {
        ...source,
        id: uid(itemPrefix(source.type)),
        x: Math.min(0.95, source.x + 0.04),
        y: Math.min(0.95, source.y + 0.04),
      } as ProposalItem;
      commit((doc) => ({ ...doc, items: [...doc.items, copy] }), copy.id);
    },
    [active, commit],
  );

  const reorderItem = useCallback(
    (id: string, dir: 1 | -1) =>
      commit((doc) => {
        const index = doc.items.findIndex((item) => item.id === id);
        if (index < 0) return doc;
        const target = index + dir;
        if (target < 0 || target >= doc.items.length) return doc;
        const items = [...doc.items];
        const [moved] = items.splice(index, 1);
        items.splice(target, 0, moved);
        return { ...doc, items };
      }, id),
    [commit],
  );

  const resetItemPosition = useCallback(
    (id: string) => {
      const item = active?.items.find((entry) => entry.id === id);
      if (!item) return;
      if (item.type === "image") updateItem(id, resetImageGeometry(item));
      else updateItem(id, { x: 0.5, y: 0.5, rotation: 0 });
    },
    [active, updateItem],
  );

  const replaceSelectedImage = useCallback(
    (src: { imageDataUrl: string; name: string }) => {
      if (!selectedItem || selectedItem.type !== "image") return;
      const next = replaceImageKeepingBox(selectedItem, src);
      updateItem(selectedItem.id, { imageDataUrl: next.imageDataUrl, name: next.name });
    },
    [selectedItem, updateItem],
  );

  const setBackground = useCallback(
    (patch: Partial<ProposalBackground>) => commit((doc) => ({ ...doc, background: { ...doc.background, ...patch } })),
    [commit],
  );

  const setBackgroundLive = useCallback(
    (patch: Partial<ProposalBackground>) => live((doc) => ({ ...doc, background: { ...doc.background, ...patch } })),
    [live],
  );

  const removeBackgroundImage = useCallback(
    () => commit((doc) => ({ ...doc, background: { ...doc.background, imageDataUrl: undefined } })),
    [commit],
  );

  const undo = useCallback(() => undoProposalEdits(roomId), [roomId]);

  const redo = useCallback(() => {
    const current = snapshot(roomId);
    if (current.redo.length === 0) return;
    const nextSnap = current.redo[current.redo.length - 1];
    set(roomId, {
      ...current,
      docs: nextSnap.docs,
      activeByVersion: nextSnap.activeByVersion,
      redo: current.redo.slice(0, -1),
      undo: [...current.undo, snapshotHistory(current)].slice(-HISTORY_LIMIT),
      selectedItemId: null,
    });
    persist(roomId);
  }, [roomId]);

  const dismissError = useCallback(() => set(roomId, { ...snapshot(roomId), error: null }), [roomId]);

  return {
    hydrated: state.hydrated,
    docs,
    allDocs: state.docs,
    active,
    selectedItem,
    viewMode: state.viewMode,
    compareSplit: state.compareSplit,
    /** The proposal layer is drawn unless the viewer asked for the clean original. */
    visible: state.viewMode !== "original",
    editing: state.editing && state.viewMode === "proposal",
    layerEditing: state.editing,
    canUndo: state.undo.length > 0,
    canRedo: state.redo.length > 0,
    error: state.error,
    userId: authorId,
    create,
    selectProposal,
    renameProposal,
    setDescription,
    setType,
    setStatus,
    linkComment,
    toggleSupport,
    addComment,
    duplicateProposal,
    deleteProposal,
    setViewMode,
    setCompareSplit,
    setEditing,
    selectItem,
    addText,
    addImage,
    addShape,
    updateItem,
    updateItemLive,
    toggleItemVisible,
    beginEdit,
    endEdit,
    deleteItem,
    duplicateItem,
    reorderItem,
    resetItemPosition,
    replaceSelectedImage,
    setBackground,
    setBackgroundLive,
    removeBackgroundImage,
    undo,
    redo,
    dismissError,
  };
}

function itemPrefix(type: ProposalItem["type"]): string {
  return type === "text" ? "vpt_" : type === "image" ? "vpi_" : "vps_";
}

/** Enter the compose editor for a version (create a working layer if none). */
export function startComposeEditing(roomId: string, versionId: string, author: ProposalAuthor): void {
  const current = snapshot(roomId);
  let docs = current.docs;
  let activeId = current.activeByVersion[versionId];
  let active = docs.find((doc) => doc.id === activeId && doc.versionId === versionId);
  if (!active) {
    active = newProposal(versionId, author, docs, { type: "layout", title: "工作層" });
    activeId = active.id;
    docs = [...docs, active];
  }
  set(roomId, {
    ...current,
    docs,
    activeByVersion: { ...current.activeByVersion, [versionId]: activeId },
    viewMode: "proposal",
    editing: true,
    hydrated: true,
    selectedItemId: null,
  });
  persist(roomId);
}

/** Copy the working layer onto a newly saved version. Old version docs stay. */
export function cloneProposalsInStore(roomId: string, fromVersionId: string, toVersionId: string): void {
  const current = snapshot(roomId);
  if (fromVersionId === toVersionId) return;
  const docs = cloneProposalDocsToVersion(current.docs, fromVersionId, toVersionId);
  const copied = docs.filter((doc) => doc.versionId === toVersionId).at(-1);
  set(roomId, {
    ...current,
    docs,
    activeByVersion: copied
      ? { ...current.activeByVersion, [toVersionId]: copied.id }
      : current.activeByVersion,
    viewMode: "proposal",
    editing: true,
    selectedItemId: null,
  });
  persist(roomId);
}

/** Remove proposals whose poster version no longer exists (called by the room owner). */
export function pruneProposalVersions(roomId: string, validVersionIds: string[]) {
  const current = states.get(roomId);
  if (!current || !current.hydrated) return;
  const valid = new Set(validVersionIds);
  const docs = current.docs.filter((doc) => valid.has(doc.versionId));
  if (docs.length === current.docs.length) return;
  const activeByVersion: Record<string, string> = {};
  for (const [vId, docId] of Object.entries(current.activeByVersion)) {
    if (valid.has(vId) && docs.some((d) => d.id === docId)) activeByVersion[vId] = docId;
  }
  set(roomId, { ...current, docs, activeByVersion, selectedItemId: null });
  persist(roomId);
}
