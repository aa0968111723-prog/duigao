import type { PendingEdit, Whiteboard, WhiteboardEdge, WhiteboardNode } from "./types";

export type CloudNodeWrites = {
  upsertNode?: (node: WhiteboardNode) => unknown;
  deleteNode?: (id: string) => unknown;
};

/** True only when the cloud write actually succeeded — not a fire-and-forget void. */
export function isCloudWriteAcknowledged(result: unknown): result is true | WhiteboardNode {
  if (result === true) return true;
  return Boolean(result && typeof result === "object" && "id" in result && "version" in result);
}

/**
 * Replay durable pending node edits. Records stay queued unless the write
 * returns an explicit ack (true or the persisted node). A skipped / queued /
 * fire-and-forget call must not drop the IndexedDB copy.
 */
export async function applyPendingCloudWrites(
  pending: PendingEdit[],
  writes: CloudNodeWrites,
): Promise<{ acknowledged: string[]; retained: string[] }> {
  const acknowledged: string[] = [];
  const retained: string[] = [];
  for (const edit of pending) {
    if (edit.kind !== "node") {
      retained.push(edit.id);
      continue;
    }
    try {
      let result: unknown = false;
      if (edit.op === "upsert") {
        if (!writes.upsertNode) {
          retained.push(edit.id);
          continue;
        }
        result = await writes.upsertNode(edit.payload as WhiteboardNode);
      } else if (edit.op === "delete") {
        const id = (edit.payload as { id?: string }).id;
        if (!id || !writes.deleteNode) {
          retained.push(edit.id);
          continue;
        }
        result = await writes.deleteNode(id);
      } else {
        retained.push(edit.id);
        continue;
      }
      if (isCloudWriteAcknowledged(result)) acknowledged.push(edit.id);
      else retained.push(edit.id);
    } catch {
      retained.push(edit.id);
    }
  }
  return { acknowledged, retained };
}

const DB_NAME = "duigao-collaboration";
const DB_VERSION = 1;
const SNAPSHOTS = "board_snapshots";
const PENDING = "pending_edits";

type BoardSnapshot = {
  whiteboardId: string;
  roomId: string;
  whiteboard: Whiteboard;
  nodes: WhiteboardNode[];
  edges: WhiteboardEdge[];
  savedAt: number;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SNAPSHOTS)) db.createObjectStore(SNAPSHOTS, { keyPath: "whiteboardId" });
      if (!db.objectStoreNames.contains(PENDING)) db.createObjectStore(PENDING, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(store: string, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const objectStore = tx.objectStore(store);
      const req = fn(objectStore);
      if (req) {
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      } else {
        tx.oncomplete = () => resolve(undefined);
        tx.onerror = () => reject(tx.error);
      }
    });
  } finally {
    db.close();
  }
}

export async function saveBoardSnapshot(snapshot: Omit<BoardSnapshot, "savedAt">): Promise<void> {
  await withStore(SNAPSHOTS, "readwrite", (store) => store.put({ ...snapshot, savedAt: Date.now() }));
}

export async function loadBoardSnapshot(whiteboardId: string): Promise<BoardSnapshot | undefined> {
  return withStore<BoardSnapshot>(SNAPSHOTS, "readonly", (store) => store.get(whiteboardId));
}

export async function listBoardSnapshots(roomId: string): Promise<BoardSnapshot[]> {
  const all = await withStore<BoardSnapshot[]>(SNAPSHOTS, "readonly", (store) => store.getAll());
  return (all ?? []).filter((item) => item.roomId === roomId).sort((a, b) => b.savedAt - a.savedAt);
}

export async function queuePendingEdit(edit: PendingEdit): Promise<void> {
  await withStore(PENDING, "readwrite", (store) => store.put(edit));
}

export async function listPendingEdits(roomId: string): Promise<PendingEdit[]> {
  const all = await withStore<PendingEdit[]>(PENDING, "readonly", (store) => store.getAll());
  return (all ?? []).filter((item) => item.roomId === roomId).sort((a, b) => a.createdAt - b.createdAt);
}

export async function clearPendingEdit(id: string): Promise<void> {
  await withStore(PENDING, "readwrite", (store) => store.delete(id));
}

/**
 * Last-write / optimistic reconcile after a brief disconnect.
 * Cloud rows win when their updatedAt/version is newer; pending local edits
 * that the server never saw stay queued.
 */
export function isBrowserOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

export function applyPendingNodeEdits(nodes: WhiteboardNode[], pending: PendingEdit[]): WhiteboardNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const edit of pending.filter((item) => item.kind === "node").sort((a, b) => a.createdAt - b.createdAt)) {
    if (edit.op === "delete") {
      const payload = edit.payload as { id?: string };
      if (payload.id) byId.delete(payload.id);
      continue;
    }
    const node = edit.payload as WhiteboardNode;
    if (node?.id) byId.set(node.id, node);
  }
  return [...byId.values()];
}

export function reconcileNodes(local: WhiteboardNode[], remote: WhiteboardNode[], pending: PendingEdit[]): WhiteboardNode[] {
  const byId = new Map(remote.map((node) => [node.id, node]));
  for (const node of local) {
    const remoteNode = byId.get(node.id);
    if (!remoteNode || node.updatedAt > remoteNode.updatedAt || node.version > remoteNode.version) {
      byId.set(node.id, node);
    }
  }
  const deleted = new Set(
    pending.filter((edit) => edit.kind === "node" && edit.op === "delete").map((edit) => {
      const payload = edit.payload as { id?: string };
      return payload.id;
    }),
  );
  for (const id of deleted) if (id) byId.delete(id);
  return [...byId.values()];
}
