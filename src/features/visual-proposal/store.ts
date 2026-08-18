import { useCallback, useEffect, useSyncExternalStore } from "react";
import { uid } from "../../lib/id";

export type ProposalAlign = "left" | "center" | "right";
export type TextRole = "title" | "subtitle" | "body" | "date" | "place" | "cta" | "custom";
export type GradientKind = "none" | "vertical" | "horizontal" | "diagonal";
export type BgImageFit = "cover" | "contain";

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

export type ProposalTextItem = {
  id: string;
  type: "text";
  role: TextRole;
  text: string;
  x: number;
  y: number;
  width: number;
  rotation: number;
  opacity: number;
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

export type ProposalImageItem = {
  id: string;
  type: "image";
  name: string;
  imageDataUrl: string;
  x: number;
  y: number;
  width: number;
  rotation: number;
  opacity: number;
};

export type ProposalItem = ProposalTextItem | ProposalImageItem;

export type VisualProposal = {
  id: string;
  versionId: string;
  name: string;
  authorName: string;
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
  visible: boolean;
  editing: boolean;
  compareOriginal: boolean;
  selectedItemId: string | null;
  undo: HistorySnapshot[];
  redo: HistorySnapshot[];
  error: string | null;
};

type ProposalItemPatch =
  | Partial<Omit<ProposalTextItem, "id" | "type">>
  | Partial<Omit<ProposalImageItem, "id" | "type">>;

const DB_NAME = "duigao-visual-proposals";
const DB_VERSION = 1;
const STORE = "rooms";
const HISTORY_LIMIT = 25;

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
const checkpoints = new Map<string, { snap: HistorySnapshot; dirty: boolean }>();
let channel: BroadcastChannel | null = null;

function emptyState(roomId: string): ProposalRuntimeState {
  return {
    roomId,
    docs: [],
    activeByVersion: {},
    hydrated: false,
    visible: false,
    editing: false,
    compareOriginal: false,
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

function normalizeItem(raw: unknown): ProposalItem | null {
  const item = raw as Partial<ProposalItem> & { type?: string };
  if (!item || typeof item.id !== "string") return null;
  const base = {
    id: item.id,
    x: clampNum((item as ProposalItem).x, 0, 1, 0.5),
    y: clampNum((item as ProposalItem).y, 0, 1, 0.5),
    width: clampNum((item as ProposalItem).width, 4, 100, 35),
    rotation: clampNum((item as ProposalItem).rotation, -180, 180, 0),
    opacity: clampNum((item as ProposalItem).opacity, 0.05, 1, 1),
  };
  if (item.type === "image") {
    const img = item as Partial<ProposalImageItem>;
    if (typeof img.imageDataUrl !== "string") return null;
    return { ...base, type: "image", name: img.name ?? "素材", imageDataUrl: img.imageDataUrl };
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

function normalizeDoc(raw: unknown): VisualProposal | null {
  const doc = raw as Partial<VisualProposal>;
  if (!doc || typeof doc.id !== "string" || typeof doc.versionId !== "string") return null;
  const items = Array.isArray(doc.items)
    ? doc.items.map(normalizeItem).filter((i): i is ProposalItem => i != null)
    : [];
  return {
    id: doc.id,
    versionId: doc.versionId,
    name: typeof doc.name === "string" ? doc.name : "提案",
    authorName: typeof doc.authorName === "string" ? doc.authorName : "夥伴",
    items,
    background: normalizeBackground(doc.background),
    createdAt: typeof doc.createdAt === "number" ? doc.createdAt : Date.now(),
    updatedAt: typeof doc.updatedAt === "number" ? doc.updatedAt : Date.now(),
  };
}

function clampNum(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
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
  if (hydrating.has(roomId)) return;
  const current = snapshot(roomId);
  if (current.hydrated && !force) return;
  hydrating.add(roomId);
  try {
    const saved = await loadPersisted(roomId);
    const latest = snapshot(roomId);
    const docs = Array.isArray(saved?.docs)
      ? saved!.docs.map(normalizeDoc).filter((d): d is VisualProposal => d != null)
      : latest.docs;
    states.set(roomId, {
      ...latest,
      roomId,
      docs,
      activeByVersion: (saved?.activeByVersion && typeof saved.activeByVersion === "object" ? saved.activeByVersion : latest.activeByVersion) ?? {},
      hydrated: true,
      error: null,
    });
    emit(roomId);
  } catch {
    // Corrupt or unreadable data must not crash the app; start clean but usable.
    states.set(roomId, { ...current, hydrated: true, error: "讀取這台裝置的提案時發生問題，已改用空白提案。" });
    emit(roomId);
  } finally {
    hydrating.delete(roomId);
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

function nextProposalName(docs: VisualProposal[], versionId: string) {
  const count = docs.filter((doc) => doc.versionId === versionId).length;
  const letter = String.fromCharCode(65 + Math.min(count, 25));
  return `提案 ${letter}`;
}

function newProposal(versionId: string, authorName: string, docs: VisualProposal[]): VisualProposal {
  const now = Date.now();
  return {
    id: uid("vp_"),
    versionId,
    name: nextProposalName(docs, versionId),
    authorName,
    items: [],
    background: { ...EMPTY_BACKGROUND },
    createdAt: now,
    updatedAt: now,
  };
}

/** Apply a mutation to the active proposal for a version, creating one if needed. */
function editActive(
  state: ProposalRuntimeState,
  versionId: string,
  authorName: string,
  mutate: (doc: VisualProposal) => VisualProposal,
  selectedItemId?: string | null,
): ProposalRuntimeState {
  let docs = state.docs;
  let activeId = state.activeByVersion[versionId];
  let active = docs.find((doc) => doc.id === activeId && doc.versionId === versionId);
  if (!active) {
    active = newProposal(versionId, authorName, docs);
    activeId = active.id;
    docs = [...docs, active];
  }
  const nextDoc = { ...mutate(active), updatedAt: Date.now() };
  return {
    ...state,
    docs: docs.map((doc) => (doc.id === active!.id ? nextDoc : doc)),
    activeByVersion: { ...state.activeByVersion, [versionId]: activeId },
    visible: true,
    selectedItemId: selectedItemId === undefined ? state.selectedItemId : selectedItemId,
  };
}

/* ---------- public store hook ---------- */

export function useProposalStore(roomId: string, versionId: string, authorName: string) {
  useEffect(() => {
    ensureChannel();
    void hydrate(roomId);
  }, [roomId]);

  const state = useSyncExternalStore(
    useCallback((listener) => subscribe(roomId, listener), [roomId]),
    useCallback(() => snapshot(roomId), [roomId]),
    useCallback(() => snapshot(roomId), [roomId]),
  );

  const docs = state.docs.filter((doc) => doc.versionId === versionId);
  const activeId = state.activeByVersion[versionId];
  const active = docs.find((doc) => doc.id === activeId) ?? docs[0];
  const selectedItem = active?.items.find((item) => item.id === state.selectedItemId);

  /* discrete commit: one history step + persist */
  const commit = useCallback(
    (mutate: (doc: VisualProposal) => VisualProposal, selectedItemId?: string | null) => {
      const current = snapshot(roomId);
      const withHistory = { ...current, ...pushUndo(current) };
      set(roomId, { ...editActive(withHistory, versionId, authorName, mutate, selectedItemId), editing: true });
      persist(roomId);
    },
    [roomId, versionId, authorName],
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
      set(roomId, { ...editActive(snapshot(roomId), versionId, authorName, mutate, selectedItemId), editing: true });
    },
    [roomId, versionId, authorName],
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

  const create = useCallback(() => {
    let createdId = "";
    const current = snapshot(roomId);
    const doc = newProposal(versionId, authorName, current.docs);
    createdId = doc.id;
    set(roomId, {
      ...current,
      ...pushUndo(current),
      docs: [...current.docs, doc],
      activeByVersion: { ...current.activeByVersion, [versionId]: doc.id },
      visible: true,
      editing: true,
      selectedItemId: null,
    });
    persist(roomId);
    return createdId;
  }, [roomId, versionId, authorName]);

  const selectProposal = useCallback(
    (id: string) => {
      const current = snapshot(roomId);
      set(roomId, {
        ...current,
        activeByVersion: { ...current.activeByVersion, [versionId]: id },
        visible: true,
        selectedItemId: null,
      });
      persist(roomId);
    },
    [roomId, versionId],
  );

  const renameProposal = useCallback(
    (id: string, name: string) => {
      const current = snapshot(roomId);
      set(roomId, {
        ...current,
        ...pushUndo(current),
        docs: current.docs.map((doc) => (doc.id === id ? { ...doc, name: name.trim() || doc.name, updatedAt: Date.now() } : doc)),
      });
      persist(roomId);
    },
    [roomId],
  );

  const duplicateProposal = useCallback(
    (id: string) => {
      let createdId = "";
      const current = snapshot(roomId);
      const source = current.docs.find((doc) => doc.id === id);
      if (!source) return "";
      const copy: VisualProposal = {
        ...source,
        id: uid("vp_"),
        name: `${source.name} 複製`,
        items: source.items.map((item) => ({ ...item, id: uid(item.type === "text" ? "vpt_" : "vpi_") })),
        background: { ...source.background },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      createdId = copy.id;
      set(roomId, {
        ...current,
        ...pushUndo(current),
        docs: [...current.docs, copy],
        activeByVersion: { ...current.activeByVersion, [source.versionId]: copy.id },
        visible: true,
        selectedItemId: null,
      });
      persist(roomId);
      return createdId;
    },
    [roomId],
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

  const setVisible = useCallback(
    (visible: boolean) => {
      const current = snapshot(roomId);
      set(roomId, { ...current, visible, editing: visible ? current.editing : false, selectedItemId: visible ? current.selectedItemId : null });
    },
    [roomId],
  );

  const setEditing = useCallback(
    (editing: boolean) => {
      const current = snapshot(roomId);
      set(roomId, { ...current, editing, visible: editing ? true : current.visible, selectedItemId: editing ? current.selectedItemId : null });
    },
    [roomId],
  );

  const setCompareOriginal = useCallback(
    (compareOriginal: boolean) => set(roomId, { ...snapshot(roomId), compareOriginal }),
    [roomId],
  );

  const selectItem = useCallback((id: string | null) => set(roomId, { ...snapshot(roomId), selectedItemId: id }), [roomId]);

  const addText = useCallback(
    (item: ProposalTextItem) => commit((doc) => ({ ...doc, items: [...doc.items, item] }), item.id),
    [commit],
  );

  const addImage = useCallback(
    (item: ProposalImageItem) => commit((doc) => ({ ...doc, items: [...doc.items, item] }), item.id),
    [commit],
  );

  const updateItem = useCallback(
    (id: string, patch: ProposalItemPatch) =>
      commit(
        (doc) => ({ ...doc, items: doc.items.map((item) => (item.id === id ? ({ ...item, ...patch } as ProposalItem) : item)) }),
        id,
      ),
    [commit],
  );

  const updateItemLive = useCallback(
    (id: string, patch: ProposalItemPatch) =>
      live(
        (doc) => ({ ...doc, items: doc.items.map((item) => (item.id === id ? ({ ...item, ...patch } as ProposalItem) : item)) }),
        id,
      ),
    [live],
  );

  const deleteItem = useCallback((id: string) => commit((doc) => ({ ...doc, items: doc.items.filter((item) => item.id !== id) }), null), [commit]);

  const duplicateItem = useCallback(
    (id: string) => {
      const source = active?.items.find((item) => item.id === id);
      if (!source) return;
      const copy = {
        ...source,
        id: uid(source.type === "text" ? "vpt_" : "vpi_"),
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

  const resetItemPosition = useCallback((id: string) => updateItem(id, { x: 0.5, y: 0.5, rotation: 0 }), [updateItem]);

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

  const undo = useCallback(() => {
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
  }, [roomId]);

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
    active,
    selectedItem,
    visible: state.visible,
    editing: state.editing,
    compareOriginal: state.compareOriginal,
    canUndo: state.undo.length > 0,
    canRedo: state.redo.length > 0,
    error: state.error,
    create,
    selectProposal,
    renameProposal,
    duplicateProposal,
    deleteProposal,
    setVisible,
    setEditing,
    setCompareOriginal,
    selectItem,
    addText,
    addImage,
    updateItem,
    updateItemLive,
    beginEdit,
    endEdit,
    deleteItem,
    duplicateItem,
    reorderItem,
    resetItemPosition,
    setBackground,
    setBackgroundLive,
    removeBackgroundImage,
    undo,
    redo,
    dismissError,
  };
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
