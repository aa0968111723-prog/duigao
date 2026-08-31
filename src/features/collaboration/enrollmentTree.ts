/**
 * 2026招生樹：活動房裡用既有 mindmap 討論招生支線。
 * 不新增 DISCUSSION_KINDS / NODE_TYPES；路徑是從 mindmap 邊算出來的。
 * 原稿／versions 不會被這棵樹碰到。
 */
import { createEdge, createNode } from "./nodes";
import { discussionPayloadFromNode } from "./links";
import type { DiscussionPayload, WhiteboardEdge, WhiteboardNode } from "./types";

export const ENROLLMENT_TREE_YEAR = 2026;
export const ENROLLMENT_TREE_ROOT_LABEL = "2026招生樹";
export const ENROLLMENT_TREE_SOURCE = "2026招生樹";
export const PLANT_ENROLLMENT_TREE_VERB_ID = "plant-enrollment-tree";
export const PLANT_ENROLLMENT_TREE_LABEL = "種一棵 2026招生樹";

export type EnrollmentSpecNode = {
  key: string;
  label: string;
  children?: EnrollmentSpecNode[];
};

/** 社團招生對稿用的預設樹。節點只是討論錨，不是文宣原稿。 */
export const ENROLLMENT_TREE_2026: EnrollmentSpecNode = {
  key: "root",
  label: ENROLLMENT_TREE_ROOT_LABEL,
  children: [
    {
      key: "poster",
      label: "文宣",
      children: [
        { key: "poster-hero", label: "主視覺" },
        { key: "poster-booth", label: "擺攤海報" },
      ],
    },
    {
      key: "video",
      label: "影片",
      children: [
        { key: "video-clip", label: "招生短片" },
      ],
    },
    {
      key: "plan",
      label: "企劃",
      children: [
        { key: "plan-staff", label: "時程與人力" },
      ],
    },
    { key: "booth", label: "擺攤" },
    { key: "schedule", label: "時程" },
  ],
};

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

function mindmapEdges(edges: WhiteboardEdge[]): WhiteboardEdge[] {
  return edges.filter((edge) => edge.edgeType === "mindmap");
}

export function formatEnrollmentTreePath(labels: string[]): string {
  return labels.map((label) => label.trim()).filter(Boolean).join(" › ");
}

export function mindmapParentId(nodeId: string, edges: WhiteboardEdge[]): string | null {
  const incoming = mindmapEdges(edges).find((edge) => edge.targetNodeId === nodeId);
  return incoming?.sourceNodeId ?? null;
}

export function mindmapChildIds(nodeId: string, edges: WhiteboardEdge[]): string[] {
  return mindmapEdges(edges)
    .filter((edge) => edge.sourceNodeId === nodeId)
    .map((edge) => edge.targetNodeId);
}

export function isOnMindmapTree(nodeId: string, edges: WhiteboardEdge[]): boolean {
  return mindmapEdges(edges).some((edge) => edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId);
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
  if (!isOnMindmapTree(node.id, edges)) return null;
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
  return Boolean(path?.labels[0] === ENROLLMENT_TREE_ROOT_LABEL);
}

/** 根＝整棵樹的討論；支線＝自己＋祖先（知道自己在哪條招生線）。 */
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
      : path.nodeIds,
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
