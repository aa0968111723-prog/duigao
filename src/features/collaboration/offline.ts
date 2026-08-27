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

export type NodeWriteRetry = {
  acknowledged: boolean;
  queueDurable: boolean;
  queueMemory: boolean;
};

/**
 * Failed / unbound node writes retry only through the durable IndexedDB queue.
 * An in-memory closure must not also keep the old payload — a later success
 * would clear IDB and leave the stale task to overwrite newer cloud content.
 */
export function decideNodeWriteRetry(outcome: "success" | "unbound" | "failed" | "conflict"): NodeWriteRetry {
  if (outcome === "success") return { acknowledged: true, queueDurable: false, queueMemory: false };
  // conflict（stale-write）：舊 payload 永遠不可能被接受 — 不進任何佇列，
  // 由呼叫端丟棄本地編輯並以 reload 取回較新內容（drop + refetch，
  // 不做逐節點 merge — 本輪的衝突解法）。
  if (outcome === "conflict") return { acknowledged: false, queueDurable: false, queueMemory: false };
  return { acknowledged: false, queueDurable: true, queueMemory: false };
}

/**
 * Replay durable pending node edits. Records stay queued unless the write
 * returns an explicit ack (true or the persisted node). A skipped / queued /
 * fire-and-forget call must not drop the IndexedDB copy.
 */
export async function applyPendingCloudWrites(
  pending: PendingEdit[],
  writes: CloudNodeWrites,
): Promise<{ acknowledged: string[]; retained: string[]; dropped: string[] }> {
  const acknowledged: string[] = [];
  const retained: string[] = [];
  // stale-write：這份排隊中的舊 payload 已被更新版本蓋過 — 清出佇列
  //（否則每次 online 都重放、每次都 409），但不算成功。
  const dropped: string[] = [];
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
      else if (result === "conflict") dropped.push(edit.id);
      else retained.push(edit.id);
    } catch {
      retained.push(edit.id);
    }
  }
  return { acknowledged, retained, dropped };
}

export type BoardPatchInput =
  | { type: "node-upsert"; node: WhiteboardNode }
  | { type: "node-delete"; id: string }
  | { type: "edge-insert"; edge: WhiteboardEdge }
  | { type: "edge-delete"; id: string };

/**
 * 白板即時增量的合併規則（PR-02c，純函式）：
 * - node-upsert 只接受「嚴格更新的 version」（> max(acked, local)）—
 *   自己的 echo（version == 剛 ack 的值）與亂序舊事件都被擋下；
 *   ack 水位無條件推到最高，本地下一筆寫才不會 409。
 * - 拖曳中的節點讓路（拖曳結束的 persist 走 OCC；輸了由 02b 衝突路徑收）。
 * - edge 無版本欄位：insert 以 id 去重、delete 以 id 移除。
 */
export function applyBoardPatches(
  nodes: WhiteboardNode[],
  edges: WhiteboardEdge[],
  acked: Map<string, number>,
  patches: BoardPatchInput[],
  draggingIds: ReadonlySet<string> | null,
): { nodes: WhiteboardNode[]; edges: WhiteboardEdge[]; changed: boolean } {
  let nextNodes = nodes;
  let nextEdges = edges;
  for (const patch of patches) {
    if (patch.type === "node-upsert") {
      const incoming = patch.node;
      const shieldedAcked = acked.get(incoming.id) ?? 0;
      if (draggingIds?.has(incoming.id)) {
        // 讓路但 ack 水位仍推進：拖曳結束的 persist 會以「等版本 LWW」
        // 勝出（最後的實體動作贏 — ADR-011 補記），而不是 409 後整個輸掉。
        if ((incoming.version ?? 1) > shieldedAcked) acked.set(incoming.id, incoming.version ?? 1);
        continue;
      }
      const ackedVersion = acked.get(incoming.id) ?? 0;
      const local = nextNodes.find((item) => item.id === incoming.id);
      const localVersion = local?.version ?? 0;
      const incomingVersion = incoming.version ?? 1;
      if (incomingVersion > Math.max(ackedVersion, localVersion)) {
        nextNodes = local
          ? nextNodes.map((item) => (item.id === incoming.id ? incoming : item))
          : [...nextNodes, incoming];
      }
      if (incomingVersion > ackedVersion) acked.set(incoming.id, incomingVersion);
    } else if (patch.type === "node-delete") {
      if (nextNodes.some((item) => item.id === patch.id)) {
        nextNodes = nextNodes.filter((item) => item.id !== patch.id);
      }
    } else if (patch.type === "edge-insert") {
      if (!nextEdges.some((item) => item.id === patch.edge.id)) nextEdges = [...nextEdges, patch.edge];
    } else if (nextEdges.some((item) => item.id === patch.id)) {
      nextEdges = nextEdges.filter((item) => item.id !== patch.id);
    }
  }
  return { nodes: nextNodes, edges: nextEdges, changed: nextNodes !== nodes || nextEdges !== edges };
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
 * 只在 IDB 裡的列仍是「當初列出的那一份」時才清（以 createdAt 判定）。
 * flush 進行中使用者可能對同一節點又打了字 — queuePendingEdit 以同 key
 * put 覆蓋，盲刪會把較新的 payload 一起殺掉（Grok pr02b F3）。
 */
export async function clearPendingEditIf(id: string, createdAt: number): Promise<void> {
  await withStore(PENDING, "readwrite", (store) => {
    const req = store.get(id);
    req.onsuccess = () => {
      const row = req.result as PendingEdit | undefined;
      if (row && row.createdAt === createdAt) store.delete(id);
    };
  });
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
    if (!remoteNode) {
      byId.set(node.id, node);
      continue;
    }
    // version 是伺服器的 OCC 計數器 — 樂觀本地編輯不會前進它（stamp 只用
    // acked）。version 不同時 version 說了算：本地 updatedAt 較新但 version
    // 較舊＝這份編輯已經輸掉衝突，讓伺服器列贏，refetch 才換得動節點、
    // lastAcked 才會前進（Grok pr02b F2 深層）。同 version 才用 updatedAt。
    const localVersion = node.version ?? 1;
    const remoteVersion = remoteNode.version ?? 1;
    if (localVersion > remoteVersion) byId.set(node.id, node);
    else if (localVersion === remoteVersion && node.updatedAt > remoteNode.updatedAt) byId.set(node.id, node);
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
