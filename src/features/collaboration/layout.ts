import type { WhiteboardEdge, WhiteboardNode } from "./types";

export type ArrangeMode = "auto" | "mindmap" | "flow" | "grid";

const GRID_GAP_X = 24;
const GRID_GAP_Y = 20;
const FLOW_GAP_Y = 48;
const FLOW_GAP_X = 48;
const TREE_GAP_X = 56;
const TREE_GAP_Y = 28;

function outgoing(id: string, edges: WhiteboardEdge[], type?: WhiteboardEdge["edgeType"]): string[] {
  return edges
    .filter((edge) => edge.sourceNodeId === id && (!type || edge.edgeType === type))
    .map((edge) => edge.targetNodeId);
}

function incoming(id: string, edges: WhiteboardEdge[], type?: WhiteboardEdge["edgeType"]): string[] {
  return edges
    .filter((edge) => edge.targetNodeId === id && (!type || edge.edgeType === type))
    .map((edge) => edge.sourceNodeId);
}

/** Deterministic vertical/horizontal flow. Roots at the top, children below. */
export function arrangeFlow(nodes: WhiteboardNode[], edges: WhiteboardEdge[], axis: "vertical" | "horizontal" = "vertical"): WhiteboardNode[] {
  const flowNodes = nodes.filter((node) => node.nodeType === "flow");
  if (!flowNodes.length) return nodes;
  const ids = new Set(flowNodes.map((node) => node.id));
  const flowEdges = edges.filter((edge) => edge.edgeType === "flow" && ids.has(edge.sourceNodeId) && ids.has(edge.targetNodeId));
  const roots = flowNodes.filter((node) => incoming(node.id, flowEdges, "flow").length === 0);
  const start = roots.length ? roots : [flowNodes[0]];
  const placed = new Map<string, { x: number; y: number }>();
  const visit = (id: string, depth: number, index: number) => {
    if (placed.has(id)) return;
    const node = flowNodes.find((item) => item.id === id);
    if (!node) return;
    placed.set(id, axis === "vertical"
      ? { x: index * (node.width + FLOW_GAP_X), y: depth * (node.height + FLOW_GAP_Y) }
      : { x: depth * (node.width + FLOW_GAP_X), y: index * (node.height + FLOW_GAP_Y) });
    outgoing(id, flowEdges, "flow").forEach((child, childIndex) => visit(child, depth + 1, index + childIndex));
  };
  start.forEach((root, index) => visit(root.id, 0, index));
  const originX = Math.min(...flowNodes.map((node) => node.x));
  const originY = Math.min(...flowNodes.map((node) => node.y));
  return nodes.map((node) => {
    const next = placed.get(node.id);
    return next ? { ...node, x: originX + next.x, y: originY + next.y, updatedAt: Date.now() } : node;
  });
}

/** Deterministic tree: parent on the left, children stacked to the right. */
export function arrangeMindmap(nodes: WhiteboardNode[], edges: WhiteboardEdge[]): WhiteboardNode[] {
  const mapNodes = nodes.filter((node) => node.nodeType === "mindmap");
  if (!mapNodes.length) return nodes;
  const ids = new Set(mapNodes.map((node) => node.id));
  const tree = edges.filter((edge) => edge.edgeType === "mindmap" && ids.has(edge.sourceNodeId) && ids.has(edge.targetNodeId));
  const roots = mapNodes.filter((node) => incoming(node.id, tree, "mindmap").length === 0);
  const start = roots[0] ?? mapNodes[0];
  const subtreeHeight = new Map<string, number>();
  const heightOf = (id: string): number => {
    if (subtreeHeight.has(id)) return subtreeHeight.get(id)!;
    const node = mapNodes.find((item) => item.id === id);
    const children = outgoing(id, tree, "mindmap");
    const value = children.length
      ? children.reduce((sum, child) => sum + heightOf(child), 0) + (children.length - 1) * TREE_GAP_Y
      : node?.height ?? 64;
    subtreeHeight.set(id, value);
    return value;
  };
  heightOf(start.id);
  const placed = new Map<string, { x: number; y: number }>();
  const walk = (id: string, x: number, y: number) => {
    const node = mapNodes.find((item) => item.id === id);
    if (!node || placed.has(id)) return;
    placed.set(id, { x, y });
    const children = outgoing(id, tree, "mindmap");
    let cursor = y - (heightOf(id) - node.height) / 2;
    for (const child of children) {
      const h = heightOf(child);
      const childNode = mapNodes.find((item) => item.id === child);
      walk(child, x + node.width + TREE_GAP_X, cursor + (h - (childNode?.height ?? h)) / 2);
      cursor += h + TREE_GAP_Y;
    }
  };
  walk(start.id, start.x, start.y);
  return nodes.map((node) => {
    const next = placed.get(node.id);
    return next ? { ...node, x: next.x, y: next.y, updatedAt: Date.now() } : node;
  });
}

/** Stickies and leftover cards into a stable grid. */
export function arrangeGrid(nodes: WhiteboardNode[], kinds: WhiteboardNode["nodeType"][] = ["text", "image", "room_content", "poll", "decision", "link"]): WhiteboardNode[] {
  const wanted = new Set(kinds);
  const cards = nodes
    .filter((node) => wanted.has(node.nodeType))
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  if (!cards.length) return nodes;
  const colWidth = Math.max(...cards.map((node) => node.width)) + GRID_GAP_X;
  const rowHeight = Math.max(...cards.map((node) => node.height)) + GRID_GAP_Y;
  const columns = Math.max(1, Math.ceil(Math.sqrt(cards.length)));
  const originX = Math.min(...cards.map((node) => node.x));
  const originY = Math.min(...cards.map((node) => node.y));
  const placed = new Map<string, { x: number; y: number }>();
  cards.forEach((node, index) => {
    placed.set(node.id, {
      x: originX + (index % columns) * colWidth,
      y: originY + Math.floor(index / columns) * rowHeight,
    });
  });
  return nodes.map((node) => {
    const next = placed.get(node.id);
    return next ? { ...node, x: next.x, y: next.y, updatedAt: Date.now() } : node;
  });
}

/** 整理: mindmap → tree; flow → vertical; stickies → grid. Deterministic, not AI. */
export function arrangeBoard(nodes: WhiteboardNode[], edges: WhiteboardEdge[], mode: ArrangeMode = "auto"): WhiteboardNode[] {
  if (mode === "mindmap") return arrangeMindmap(nodes, edges);
  if (mode === "flow") return arrangeFlow(nodes, edges, "vertical");
  if (mode === "grid") return arrangeGrid(nodes);
  let next = arrangeMindmap(nodes, edges);
  next = arrangeFlow(next, edges, "vertical");
  return arrangeGrid(next);
}

export function nodeBounds(nodes: WhiteboardNode[]): { minX: number; minY: number; maxX: number; maxY: number } {
  if (!nodes.length) return { minX: 0, minY: 0, maxX: 800, maxY: 600 };
  return {
    minX: Math.min(...nodes.map((node) => node.x)),
    minY: Math.min(...nodes.map((node) => node.y)),
    maxX: Math.max(...nodes.map((node) => node.x + node.width)),
    maxY: Math.max(...nodes.map((node) => node.y + node.height)),
  };
}
