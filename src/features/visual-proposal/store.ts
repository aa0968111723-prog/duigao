import { useCallback, useEffect, useSyncExternalStore } from "react";
import { uid } from "../../lib/id";

export type ProposalAlign = "left" | "center" | "right";

export type ProposalBackground = {
  color: string;
  colorOpacity: number;
  imageDataUrl?: string;
  imageOpacity: number;
};

export type ProposalTextItem = {
  id: string;
  type: "text";
  text: string;
  x: number;
  y: number;
  width: number;
  rotation: number;
  opacity: number;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  align: ProposalAlign;
  backdropColor: string;
  backdropOpacity: number;
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

type ProposalRuntimeState = PersistedProposalState & {
  hydrated: boolean;
  visible: boolean;
  editing: boolean;
  selectedItemId: string | null;
};

type ProposalItemPatch =
  | Partial<Omit<ProposalTextItem, "id" | "type">>
  | Partial<Omit<ProposalImageItem, "id" | "type">>;

const DB_NAME = "duigao-visual-proposals";
const STORE = "rooms";
const EMPTY_BACKGROUND: ProposalBackground = {
  color: "#000000",
  colorOpacity: 0,
  imageOpacity: 1,
};

const states = new Map<string, ProposalRuntimeState>();
const listeners = new Map<string, Set<() => void>>();
const hydrating = new Set<string>();
let channel: BroadcastChannel | null = null;

function emptyState(roomId: string): ProposalRuntimeState {
  return {
    roomId,
    docs: [],
    activeByVersion: {},
    hydrated: false,
    visible: false,
    editing: false,
    selectedItemId: null,
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

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "roomId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
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

async function savePersisted(state: ProposalRuntimeState) {
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
    states.set(roomId, {
      ...latest,
      roomId,
      docs: saved?.docs ?? latest.docs,
      activeByVersion: saved?.activeByVersion ?? latest.activeByVersion,
      hydrated: true,
    });
    emit(roomId);
  } catch {
    states.set(roomId, { ...current, hydrated: true });
    emit(roomId);
  } finally {
    hydrating.delete(roomId);
  }
}

function ensureChannel() {
  if (channel || typeof BroadcastChannel === "undefined") return;
  channel = new BroadcastChannel("duigao-visual-proposals");
  channel.onmessage = (event) => {
    const roomId = typeof event.data === "string" ? event.data : "";
    if (roomId) void hydrate(roomId, true);
  };
}

function commit(roomId: string, update: (state: ProposalRuntimeState) => ProposalRuntimeState, persist = true) {
  const next = update(snapshot(roomId));
  states.set(roomId, next);
  emit(roomId);
  if (persist) {
    void savePersisted(next)
      .then(() => {
        ensureChannel();
        channel?.postMessage(roomId);
      })
      .catch(() => undefined);
  }
}

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

function withActive(
  roomId: string,
  versionId: string,
  authorName: string,
  mutate: (doc: VisualProposal) => VisualProposal,
  selectedItemId?: string | null,
) {
  commit(roomId, (state) => {
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
      editing: true,
      selectedItemId: selectedItemId === undefined ? state.selectedItemId : selectedItemId,
    };
  });
}

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

  const create = useCallback(() => {
    let createdId = "";
    commit(roomId, (current) => {
      const doc = newProposal(versionId, authorName, current.docs);
      createdId = doc.id;
      return {
        ...current,
        docs: [...current.docs, doc],
        activeByVersion: { ...current.activeByVersion, [versionId]: doc.id },
        visible: true,
        editing: true,
        selectedItemId: null,
      };
    });
    return createdId;
  }, [roomId, versionId, authorName]);

  const selectProposal = useCallback(
    (id: string) => {
      commit(
        roomId,
        (current) => ({
          ...current,
          activeByVersion: { ...current.activeByVersion, [versionId]: id },
          visible: true,
          selectedItemId: null,
        }),
        false,
      );
    },
    [roomId, versionId],
  );

  const setVisible = useCallback(
    (visible: boolean) => {
      commit(roomId, (current) => ({ ...current, visible, editing: visible ? current.editing : false, selectedItemId: null }), false);
    },
    [roomId],
  );

  const setEditing = useCallback(
    (editing: boolean) => {
      commit(roomId, (current) => ({ ...current, editing, visible: editing ? true : current.visible, selectedItemId: editing ? current.selectedItemId : null }), false);
    },
    [roomId],
  );

  const selectItem = useCallback(
    (id: string | null) => commit(roomId, (current) => ({ ...current, selectedItemId: id }), false),
    [roomId],
  );

  const addText = useCallback(() => {
    const item: ProposalTextItem = {
      id: uid("vpt_"),
      type: "text",
      text: "輸入提案文案",
      x: 0.5,
      y: 0.28,
      width: 70,
      rotation: 0,
      opacity: 1,
      fontFamily: '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif',
      fontSize: 5.5,
      fontWeight: 700,
      color: "#ffffff",
      align: "center",
      backdropColor: "#000000",
      backdropOpacity: 0,
    };
    withActive(roomId, versionId, authorName, (doc) => ({ ...doc, items: [...doc.items, item] }), item.id);
  }, [roomId, versionId, authorName]);

  const addImage = useCallback(
    (imageDataUrl: string, name: string) => {
      const item: ProposalImageItem = {
        id: uid("vpi_"),
        type: "image",
        name,
        imageDataUrl,
        x: 0.5,
        y: 0.5,
        width: 35,
        rotation: 0,
        opacity: 1,
      };
      withActive(roomId, versionId, authorName, (doc) => ({ ...doc, items: [...doc.items, item] }), item.id);
    },
    [roomId, versionId, authorName],
  );

  const updateItem = useCallback(
    (id: string, patch: ProposalItemPatch) => {
      withActive(
        roomId,
        versionId,
        authorName,
        (doc) => ({
          ...doc,
          items: doc.items.map((item) => (item.id === id ? ({ ...item, ...patch } as ProposalItem) : item)),
        }),
        id,
      );
    },
    [roomId, versionId, authorName],
  );

  const deleteItem = useCallback(
    (id: string) => {
      withActive(
        roomId,
        versionId,
        authorName,
        (doc) => ({ ...doc, items: doc.items.filter((item) => item.id !== id) }),
        null,
      );
    },
    [roomId, versionId, authorName],
  );

  const setBackground = useCallback(
    (patch: Partial<ProposalBackground>) => {
      withActive(roomId, versionId, authorName, (doc) => ({
        ...doc,
        background: { ...doc.background, ...patch },
      }));
    },
    [roomId, versionId, authorName],
  );

  const removeBackgroundImage = useCallback(() => {
    withActive(roomId, versionId, authorName, (doc) => ({
      ...doc,
      background: { ...doc.background, imageDataUrl: undefined },
    }));
  }, [roomId, versionId, authorName]);

  return {
    hydrated: state.hydrated,
    docs,
    active,
    selectedItem,
    visible: state.visible,
    editing: state.editing,
    create,
    selectProposal,
    setVisible,
    setEditing,
    selectItem,
    addText,
    addImage,
    updateItem,
    deleteItem,
    setBackground,
    removeBackgroundImage,
  };
}
