/**
 * 招生樹：房間裡已經在用的 campaign mindmap（截圖根是「202609招生」）。
 * 幹部把文宣／版本釘成樹，在支線上討論。不另發明第一層、不是 Canva、不是拼圖目錄。
 * 空板才長 202609 骨架；已有 20xx招生 根就只討論，不另種一棵玩具樹。
 * 路徑走 mindmap + relation 邊（落板的 room_content／便利貼也算支線）。
 * 不新增 DISCUSSION_KINDS / NODE_TYPES。原稿／versions 不碰。
 */
import { createEdge, createNode } from "./nodes";
import { discussionPayloadFromNode } from "./links";
import type { DiscussionPayload, WhiteboardEdge, WhiteboardNode } from "./types";

export const ENROLLMENT_TREE_YEAR = 2026;
export const ENROLLMENT_TREE_ROOT_LABEL = "202609招生";
export const ENROLLMENT_TREE_SOURCE = "招生樹";
export const PLANT_ENROLLMENT_TREE_VERB_ID = "plant-enrollment-tree";
export const PLANT_ENROLLMENT_TREE_LABEL = "空板長 202609招生骨架";
export const FOCUS_ENROLLMENT_TREE_LABEL = "討論這棵招生樹";

export type EnrollmentSpecNode = {
  key: string;
  label: string;
  children?: EnrollmentSpecNode[];
};

/** 對齊 202609 截圖的支線名稱。空板骨架只有標籤，沒有假圖。 */
export const ENROLLMENT_TREE_2026: EnrollmentSpecNode = {
  key: "root",
  label: ENROLLMENT_TREE_ROOT_LABEL,
  children: [
    { key: "copy", label: "招募文案" },
    {
      key: "print",
      label: "印製招募文案",
      children: [
        { key: "print-front", label: "正" },
        { key: "print-back", label: "反" },
      ],
    },
    {
      key: "food",
      label: "美食地圖",
      children: [
        { key: "food-front", label: "正" },
        { key: "food-back", label: "反" },
      ],
    },
    { key: "booth", label: "擺攤企劃" },
    { key: "bookmark", label: "書籤" },
    { key: "badge", label: "胸章" },
  ],
};

/** 202609招生、2026招生樹、2026招生 —— 已在板上的真樹，不是空白模板名。 */
export function isEnrollmentCampaignRootLabel(label: string | undefined | null): boolean {
  const trimmed = (label ?? "").trim();
  if (!trimmed) return false;
  if (trimmed.includes("招生樹")) return true;
  return /^20\d{2}\d{0,2}\s*招生/.test(trimmed);
}

export type EnrollmentTreePath = {
  nodeIds: string[];
  labels: string[];
  text: string;
  rootId: string;
  parentId: string | null;
  childIds: string[];
  siblingIds: string[];
};

function live(nodes: WhiteboardNode[]): WhiteboardNode[] {
  return nodes.filter((node) => !node.deletedAt);
}

function treeEdges(edges: WhiteboardEdge[]): WhiteboardEdge[] {
  return edges.filter((edge) => edge.edgeType === "mindmap" || edge.edgeType === "relation");
}

export function formatEnrollmentTreePath(labels: string[]): string {
  return labels.map((label) => label.trim()).filter(Boolean).join(" › ");
}

export function mindmapParentId(nodeId: string, edges: WhiteboardEdge[]): string | null {
  const incoming = treeEdges(edges).find((edge) => edge.targetNodeId === nodeId);
  return incoming?.sourceNodeId ?? null;
}

export function mindmapChildIds(nodeId: string, edges: WhiteboardEdge[]): string[] {
  return treeEdges(edges)
    .filter((edge) => edge.sourceNodeId === nodeId)
    .map((edge) => edge.targetNodeId);
}

export function isOnMindmapTree(nodeId: string, edges: WhiteboardEdge[]): boolean {
  return treeEdges(edges).some((edge) => edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId);
}

export function enrollmentAncestorIds(nodeId: string, edges: WhiteboardEdge[]): string[] {
  const seen = new Set<string>();
  const chain: string[] = [];
  let cursor: string | null = nodeId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    chain.unshift(cursor);
    cursor = mindmapParentId(cursor, edges);
  }
  return chain;
}

export function enrollmentDescendantIds(nodeId: string, edges: WhiteboardEdge[]): string[] {
  const out: string[] = [];
  const queue = [...mindmapChildIds(nodeId, edges)];
  const seen = new Set<string>([nodeId]);
  while (queue.length) {
    const id = queue.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    queue.push(...mindmapChildIds(id, edges));
  }
  return out;
}

function labelOf(node: WhiteboardNode | undefined): string {
  return (node?.content.text || node?.content.title || "未命名").trim();
}

export function enrollmentTreePath(
  node: Pick<WhiteboardNode, "id"> | null | undefined,
  nodes: WhiteboardNode[],
  edges: WhiteboardEdge[],
): EnrollmentTreePath | null {
  if (!node) return null;
  const self = live(nodes).find((item) => item.id === node.id);
  const selfLabel = labelOf(self);
  if (!isOnMindmapTree(node.id, edges) && !isEnrollmentCampaignRootLabel(selfLabel)) return null;
  const byId = new Map(live(nodes).map((item) => [item.id, item]));
  const ancestorIds = enrollmentAncestorIds(node.id, edges);
  const labels = ancestorIds.map((id) => labelOf(byId.get(id)));
  const rootId = ancestorIds[0] ?? node.id;
  const parentId = mindmapParentId(node.id, edges);
  const childIds = mindmapChildIds(node.id, edges).filter((id) => byId.has(id));
  const siblingIds = parentId
    ? mindmapChildIds(parentId, edges).filter((id) => id !== node.id && byId.has(id))
    : [];
  return {
    nodeIds: ancestorIds,
    labels,
    text: formatEnrollmentTreePath(labels),
    rootId,
    parentId,
    childIds,
    siblingIds,
  };
}

export function isEnrollmentTree2026(path: EnrollmentTreePath | null | undefined): boolean {
  return Boolean(path && isEnrollmentCampaignRootLabel(path.labels[0]));
}

export function findEnrollmentTreeRoots(nodes: WhiteboardNode[], edges: WhiteboardEdge[]): WhiteboardNode[] {
  return live(nodes).filter((node) => {
    if (!isEnrollmentCampaignRootLabel(labelOf(node))) return false;
    return mindmapParentId(node.id, edges) == null;
  });
}

export function shouldPlantEnrollmentTree(nodes: WhiteboardNode[], edges: WhiteboardEdge[]): boolean {
  return findEnrollmentTreeRoots(nodes, edges).length === 0;
}

/** 根＝整棵樹；支線＝自己＋祖先＋子孫（書籤上的便利貼算這條），不含旁支。 */
export function messagesForEnrollmentFocus<T extends { payload?: { nodeId?: string } }>(
  messages: T[],
  node: Pick<WhiteboardNode, "id"> | null,
  nodes: WhiteboardNode[],
  edges: WhiteboardEdge[],
): T[] | null {
  const path = enrollmentTreePath(node, nodes, edges);
  if (!node || !path) return null;
  const allowed = new Set(
    path.rootId === node.id
      ? [path.rootId, ...enrollmentDescendantIds(path.rootId, edges)]
      : [...path.nodeIds, ...enrollmentDescendantIds(node.id, edges)],
  );
  return messages.filter((message) => {
    const nodeId = message.payload?.nodeId;
    return typeof nodeId === "string" && allowed.has(nodeId);
  });
}

export function discussionPayloadFromEnrollmentNode(
  node: WhiteboardNode,
  nodes: WhiteboardNode[],
  edges: WhiteboardEdge[],
  boardTitle?: string,
): DiscussionPayload {
  const base = discussionPayloadFromNode(node, boardTitle);
  const path = enrollmentTreePath(node, nodes, edges);
  if (!path) return base;
  return {
    ...base,
    title: path.text,
    treePath: path.text,
    treeRootId: path.rootId,
  };
}

export function enrollmentColleaguePrompt(pathText: string | undefined, fallback = "針對這張，我們下一步做什麼？"): string {
  const trimmed = pathText?.trim();
  if (!trimmed) return fallback;
  return `針對「${trimmed}」，我們下一步做什麼？`;
}

export type PlantedEnrollmentTree = {
  nodes: WhiteboardNode[];
  edges: WhiteboardEdge[];
  rootId: string;
  byKey: Record<string, string>;
};

export function plantEnrollmentTree2026(input: {
  whiteboardId: string;
  roomId: string;
  createdBy: string;
  origin?: { x: number; y: number };
  idFn?: () => string;
  spec?: EnrollmentSpecNode;
}): PlantedEnrollmentTree {
  const origin = input.origin ?? { x: 48, y: 72 };
  const spec = input.spec ?? ENROLLMENT_TREE_2026;
  const nodes: WhiteboardNode[] = [];
  const edges: WhiteboardEdge[] = [];
  const byKey: Record<string, string> = {};
  let seq = 0;
  let row = 0;
  const nextId = () => input.idFn?.() ?? `enroll-2026-${++seq}`;

  const walk = (item: EnrollmentSpecNode, depth: number, parentId: string | null) => {
    const id = nextId();
    byKey[item.key] = id;
    const node = createNode({
      id,
      whiteboardId: input.whiteboardId,
      roomId: input.roomId,
      nodeType: "mindmap",
      createdBy: input.createdBy,
      x: origin.x + depth * 200,
      y: origin.y + row * 80,
      content: {
        text: item.label,
        sourceLabel: ENROLLMENT_TREE_SOURCE,
        title: item.label,
      },
    });
    row += 1;
    nodes.push(node);
    if (parentId) {
      edges.push(createEdge({
        whiteboardId: input.whiteboardId,
        roomId: input.roomId,
        sourceNodeId: parentId,
        targetNodeId: id,
        edgeType: "mindmap",
        id: `${id}-edge`,
      }));
    }
    for (const child of item.children ?? []) walk(child, depth + 1, id);
  };

  walk(spec, 0, null);
  const rootId = byKey[spec.key] ?? nodes[0]?.id ?? "";
  return { nodes, edges, rootId, byKey };
}

export function enrollmentAskFocus(
  path: EnrollmentTreePath | null,
  nodes: WhiteboardNode[] = [],
): {
  treePath?: string;
  treeRootId?: string;
  parentLabel?: string;
  childLabels?: string[];
} {
  if (!path) return {};
  const byId = new Map(live(nodes).map((item) => [item.id, item]));
  return {
    treePath: path.text,
    treeRootId: path.rootId,
    parentLabel: path.labels.length > 1 ? path.labels[path.labels.length - 2] : undefined,
    childLabels: path.childIds.map((id) => labelOf(byId.get(id))).filter(Boolean),
  };
}
