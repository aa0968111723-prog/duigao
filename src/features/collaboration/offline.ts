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
  /** 讓路集合：拖曳中 ∪ persist in-flight 的節點 id。 */
  shieldedIds: ReadonlySet<string> | null,
): { nodes: WhiteboardNode[]; edges: WhiteboardEdge[]; changed: boolean } {
  let nextNodes = nodes;
  let nextEdges = edges;
  for (const patch of patches) {
    if (patch.type === "node-upsert") {
      const incoming = patch.node;
      if (shieldedIds?.has(incoming.id)) {
        // 讓路且「不推進 ack」（Grok pr02c F1）：若推進，拖曳/打字結束的
        // persist 會 stamp 到遠端版本 → 等版本被接受 → 本地舊 content
        // 靜默蓋掉別人的編輯，02b 的 409→drop+refetch 永遠走不到。
        // 不推進，讓 persist 用舊 acked 去撞 409，衝突路徑誠實接手。
        // 同一守則也擋自己的 WAL echo（HTTP ack 前 version=acked+1 —
        // Grok pr02c F2）：in-flight 的節點在自己的 ack 落地前不接受
        // 任何 inbound 覆蓋。
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

/**
 * 板級整替（純函式，Grok pr02c F3）：該板以雲端 graph 為準 —
 * 遠端已刪的節點消失、acked 水位同步（缺席者清除、在席者設為其 version），
 * 其他板不動。in-flight/拖曳中的節點例外保留（其 persist 結果由 OCC 決）。
 */
export function replaceBoardGraph(
  nodes: WhiteboardNode[],
  edges: WhiteboardEdge[],
  acked: Map<string, number>,
  whiteboardId: string,
  graph: { nodes: WhiteboardNode[]; edges: WhiteboardEdge[] },
  shieldedIds: ReadonlySet<string> | null,
): { nodes: WhiteboardNode[]; edges: WhiteboardEdge[] } {
  const incomingIds = new Set(graph.nodes.map((node) => node.id));
  const keptLocal = nodes.filter(
    (node) => node.whiteboardId !== whiteboardId || (shieldedIds?.has(node.id) && !incomingIds.has(node.id)),
  );
  const shieldPreserved = new Map(
    nodes
      .filter((node) => node.whiteboardId === whiteboardId && shieldedIds?.has(node.id))
      .map((node) => [node.id, node]),
  );
  const nextNodes = [
    ...keptLocal,
    ...graph.nodes.map((node) => shieldPreserved.get(node.id) ?? node),
  ];
  const nextEdges = [
    ...edges.filter((edge) => edge.whiteboardId !== whiteboardId),
    ...graph.edges,
  ];
  // acked 同步：該板缺席者清除；在席者推到雲端 version（護盾中不推 —
  // 讓 in-flight persist 的 OCC 結果決定）。
  for (const node of nodes) {
    if (node.whiteboardId === whiteboardId && !incomingIds.has(node.id) && !shieldedIds?.has(node.id)) {
      acked.delete(node.id);
    }
  }
  for (const node of graph.nodes) {
    if (shieldedIds?.has(node.id)) continue;
    const current = acked.get(node.id) ?? 0;
    if ((node.version ?? 1) > current) acked.set(node.id, node.version ?? 1);
  }
  return { nodes: nextNodes, edges: nextEdges };
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
