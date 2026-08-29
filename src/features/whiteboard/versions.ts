/**
 * 白板版本快照（WB04）— 純函式層。
 *
 * 0025 的 `whiteboard_versions.snapshot` 是不可變 jsonb（無 update policy）。
 * 這裡負責兩件事：把當下的板打包成快照、把快照還原成「要對現況做哪些
 * 動作」的計畫。**還原不是整包覆蓋**：算出 upsert/刪除清單，交給既有的
 * 節點管線逐筆走 OCC 與 op 帳（ADR-014：永不整列覆寫、永不繞過 OCC）。
 */
import type { WhiteboardEdge, WhiteboardFrame, WhiteboardNode } from "../collaboration/types";

export type BoardSnapshot = {
  nodes: WhiteboardNode[];
  edges: WhiteboardEdge[];
  frames: WhiteboardFrame[];
};

/** 版本清單列（P6：**不含 snapshot** — 20 份完整快照可能是好幾 MB）。 */
export type BoardVersionSummary = {
  id: string;
  whiteboardId: string;
  roomId: string;
  label: string;
  createdBy: string;
  createdAt: number;
  /** 快照裡有幾個節點（清單顯示用，來自 DB 的 jsonb_array_length）。 */
  nodeCount: number;
};

export type BoardVersion = BoardVersionSummary & { snapshot: BoardSnapshot };

/** DB CHECK：snapshot.nodes 不得超過 2000 筆。 */
export const SNAPSHOT_NODE_LIMIT = 2000;

export function buildSnapshot(
  nodes: WhiteboardNode[],
  edges: WhiteboardEdge[],
  frames: WhiteboardFrame[],
): BoardSnapshot {
  return {
    // 墓碑不入快照（還原時它們本來就該是「不存在」）
    nodes: nodes.filter((node) => !node.deletedAt),
    edges,
    frames,
  };
}

export type RestorePlan = {
  /** 快照裡有、現在沒有或不一樣 → 寫回去。 */
  upsertNodes: WhiteboardNode[];
  /**
   * 快照裡有、但**現在是墓碑或整個不見**的節點 → 要走 undelete 專用寫入。
   * 一般 upsert 的 payload 不含 deleted_at（墓碑紀律），照 upsert 走的話
   * 節點會樂觀出現、tombstone echo 一到就再消失（Grok wb04 F1 實抓）。
   */
  restoreNodes: WhiteboardNode[];
  /** 現在有、快照裡沒有 → 軟刪。 */
  deleteNodeIds: string[];
  upsertFrames: WhiteboardFrame[];
  deleteFrameIds: string[];
  /** 快照裡有、現在沒有的線（線沒有 OCC 以外的還原語意，只補不刪）。 */
  createEdges: WhiteboardEdge[];
};

/**
 * 穩定序列化（P12）：JSON.stringify 依鍵的插入順序，而快照經過 Postgres
 * jsonb 會被重排 — 直接比字串會讓「完全沒變」的節點被算成大量改寫，摘要
 * 說「N 個內容還原」、按下去還真的送出一批無謂寫入。
 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

function sameNodeShape(a: WhiteboardNode, b: WhiteboardNode): boolean {
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height &&
    a.nodeType === b.nodeType && Boolean(a.locked) === Boolean(b.locked) &&
    (a.zIndex ?? 0) === (b.zIndex ?? 0) &&
    stableJson(a.content) === stableJson(b.content)
  );
}

/** 快照節點數是否超過 0025 的 CHECK 上限（超過就存不起來 — 要先說）。 */
export function snapshotTooLarge(snapshot: BoardSnapshot): boolean {
  return snapshot.nodes.length > SNAPSHOT_NODE_LIMIT;
}

/**
 * 快照裡的節點形狀驗證（P13）：跨版本/畸形的快照列硬轉成 WhiteboardNode
 * 會產出 id/content 為 undefined 的 payload，PostgREST 400 之後進重試佇列
 * 反覆重放。讀回來時就把不成形的丟掉，並讓呼叫端知道丟了幾筆。
 */
export function sanitizeSnapshot(raw: {
  nodes?: unknown;
  edges?: unknown;
  frames?: unknown;
}): { snapshot: BoardSnapshot; dropped: number } {
  let dropped = 0;
  const nodes: WhiteboardNode[] = [];
  for (const item of Array.isArray(raw.nodes) ? raw.nodes : []) {
    const node = item as Partial<WhiteboardNode>;
    if (
      node && typeof node.id === "string" && node.id &&
      typeof node.nodeType === "string" &&
      typeof node.x === "number" && typeof node.y === "number" &&
      typeof node.width === "number" && typeof node.height === "number"
    ) {
      nodes.push({ ...(node as WhiteboardNode), content: node.content ?? {} });
    } else {
      dropped += 1;
    }
  }
  const edges: WhiteboardEdge[] = [];
  for (const item of Array.isArray(raw.edges) ? raw.edges : []) {
    const edge = item as Partial<WhiteboardEdge>;
    if (edge && typeof edge.id === "string" && typeof edge.sourceNodeId === "string" && typeof edge.targetNodeId === "string") {
      edges.push(edge as WhiteboardEdge);
    } else {
      dropped += 1;
    }
  }
  const frames: WhiteboardFrame[] = [];
  for (const item of Array.isArray(raw.frames) ? raw.frames : []) {
    const frame = item as Partial<WhiteboardFrame>;
    if (
      frame && typeof frame.id === "string" &&
      typeof frame.x === "number" && typeof frame.y === "number" &&
      typeof frame.width === "number" && typeof frame.height === "number"
    ) {
      frames.push(frame as WhiteboardFrame);
    } else {
      dropped += 1;
    }
  }
  return { snapshot: { nodes, edges, frames }, dropped };
}

/**
 * 還原計畫：以**現況的 version** 為基礎套用快照的內容欄位 — 直接把快照
 * 那一列寫回去會帶著舊 version，必被 OCC 擋下（而且是永久 409）。
 */
export function planRestore(snapshot: BoardSnapshot, current: {
  nodes: WhiteboardNode[];
  edges: WhiteboardEdge[];
  frames: WhiteboardFrame[];
}): RestorePlan {
  const liveNodes = current.nodes.filter((node) => !node.deletedAt);
  const currentNodeById = new Map(liveNodes.map((node) => [node.id, node]));
  const snapshotNodeIds = new Set(snapshot.nodes.map((node) => node.id));

  const upsertNodes: WhiteboardNode[] = [];
  const restoreNodes: WhiteboardNode[] = [];
  for (const snapNode of snapshot.nodes) {
    const live = currentNodeById.get(snapNode.id);
    if (!live) {
      // 快照後被刪掉（或整個不在本地）的節點：走 undelete 專用寫入
      restoreNodes.push({ ...snapNode, deletedAt: undefined });
      continue;
    }
    if (sameNodeShape(live, snapNode)) continue;
    upsertNodes.push({ ...snapNode, version: live.version, deletedAt: undefined });
  }
  const deleteNodeIds = liveNodes.filter((node) => !snapshotNodeIds.has(node.id)).map((node) => node.id);

  const currentFrameById = new Map(current.frames.map((frame) => [frame.id, frame]));
  const snapshotFrameIds = new Set(snapshot.frames.map((frame) => frame.id));
  const upsertFrames: WhiteboardFrame[] = [];
  for (const snapFrame of snapshot.frames) {
    const live = currentFrameById.get(snapFrame.id);
    if (!live) {
      upsertFrames.push(snapFrame);
      continue;
    }
    if (
      live.x === snapFrame.x && live.y === snapFrame.y &&
      live.width === snapFrame.width && live.height === snapFrame.height &&
      live.title === snapFrame.title
    ) continue;
    upsertFrames.push({ ...snapFrame, version: live.version });
  }
  const deleteFrameIds = current.frames.filter((frame) => !snapshotFrameIds.has(frame.id)).map((frame) => frame.id);

  const currentEdgeIds = new Set(current.edges.map((edge) => edge.id));
  const createEdges = snapshot.edges.filter((edge) => !currentEdgeIds.has(edge.id));

  return { upsertNodes, restoreNodes, deleteNodeIds, upsertFrames, deleteFrameIds, createEdges };
}

/** 人看得懂的差異摘要（還原前的確認對話用）。 */
export function describeRestore(plan: RestorePlan): string {
  const parts: string[] = [];
  if (plan.upsertNodes.length) parts.push(`${plan.upsertNodes.length} 個內容還原`);
  if (plan.restoreNodes.length) parts.push(`${plan.restoreNodes.length} 個已刪的會被復原`);
  if (plan.deleteNodeIds.length) parts.push(`${plan.deleteNodeIds.length} 個之後新增的會被移除`);
  if (plan.upsertFrames.length) parts.push(`${plan.upsertFrames.length} 個區塊還原`);
  if (plan.deleteFrameIds.length) parts.push(`${plan.deleteFrameIds.length} 個區塊會被移除`);
  if (plan.createEdges.length) parts.push(`${plan.createEdges.length} 條連線補回`);
  return parts.length ? parts.join("、") : "和現在一樣，沒有變化";
}
