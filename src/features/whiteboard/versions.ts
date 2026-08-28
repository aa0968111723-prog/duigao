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

export type BoardVersion = {
  id: string;
  whiteboardId: string;
  roomId: string;
  label: string;
  createdBy: string;
  createdAt: number;
  snapshot: BoardSnapshot;
};

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
  /** 現在有、快照裡沒有 → 軟刪。 */
  deleteNodeIds: string[];
  upsertFrames: WhiteboardFrame[];
  deleteFrameIds: string[];
  /** 快照裡有、現在沒有的線（線沒有 OCC 以外的還原語意，只補不刪）。 */
  createEdges: WhiteboardEdge[];
};

function sameNodeShape(a: WhiteboardNode, b: WhiteboardNode): boolean {
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height &&
    a.nodeType === b.nodeType && a.locked === b.locked && a.zIndex === b.zIndex &&
    JSON.stringify(a.content) === JSON.stringify(b.content)
  );
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
  for (const snapNode of snapshot.nodes) {
    const live = currentNodeById.get(snapNode.id);
    if (!live) {
      // 快照後被刪掉的節點：以 version 1 重建（tombstone 的 undelete 由
      // 上層的 upsert 管線處理）
      upsertNodes.push({ ...snapNode, deletedAt: undefined });
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

  return { upsertNodes, deleteNodeIds, upsertFrames, deleteFrameIds, createEdges };
}

/** 人看得懂的差異摘要（還原前的確認對話用）。 */
export function describeRestore(plan: RestorePlan): string {
  const parts: string[] = [];
  if (plan.upsertNodes.length) parts.push(`${plan.upsertNodes.length} 個內容還原`);
  if (plan.deleteNodeIds.length) parts.push(`${plan.deleteNodeIds.length} 個之後新增的會被移除`);
  if (plan.upsertFrames.length) parts.push(`${plan.upsertFrames.length} 個區塊還原`);
  if (plan.deleteFrameIds.length) parts.push(`${plan.deleteFrameIds.length} 個區塊會被移除`);
  if (plan.createEdges.length) parts.push(`${plan.createEdges.length} 條連線補回`);
  return parts.length ? parts.join("、") : "和現在一樣，沒有變化";
}
