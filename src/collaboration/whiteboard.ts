/**
 * One node+edge model for sticky notes, room-content references, polls,
 * flow, and mindmap. Room content is a reference (branch/version/asset id),
 * never a copy of original media bytes.
 */
export const WHITEBOARD_NODE_TYPES = [
  "sticky",
  "text",
  "image",
  "poster",
  "video",
  "video_segment",
  "plan",
  "asset",
  "poll",
  "decision",
  "flow",
  "mindmap",
] as const;

export type WhiteboardNodeType = (typeof WHITEBOARD_NODE_TYPES)[number];

export type WhiteboardNode = {
  id: string;
  canvasId: string;
  roomId: string;
  type: WhiteboardNodeType;
  x: number;
  y: number;
  text: string;
  linkedAssetId?: string;
  linkedBranchId?: string;
  linkedVersionId?: string;
  videoTimestamp?: number;
  pollId?: string;
  /** Never original media bytes. */
  payload?: Record<string, unknown>;
};

export type WhiteboardEdge = {
  id: string;
  canvasId: string;
  roomId: string;
  fromNodeId: string;
  toNodeId: string;
  kind: "flow" | "mindmap" | "related";
};

export type WhiteboardGraph = {
  canvasId: string;
  roomId: string;
  nodes: WhiteboardNode[];
  edges: WhiteboardEdge[];
};

export function emptyGraph(roomId: string, canvasId = `canvas_${roomId}`): WhiteboardGraph {
  return { canvasId, roomId, nodes: [], edges: [] };
}

export function createNode(
  graph: WhiteboardGraph,
  input: Omit<WhiteboardNode, "id" | "canvasId" | "roomId"> & { id?: string },
): { graph: WhiteboardGraph; node: WhiteboardNode } {
  if (input.payload && ("imageDataUrl" in input.payload || "bytes" in input.payload || "videoUrl" in input.payload)) {
    throw new Error("whiteboard nodes must reference room content, not copy original media");
  }
  const node: WhiteboardNode = {
    id: input.id ?? `node_${graph.nodes.length + 1}_${Math.abs(hash(`${input.type}:${input.text}`))}`,
    canvasId: graph.canvasId,
    roomId: graph.roomId,
    type: input.type,
    x: input.x,
    y: input.y,
    text: input.text,
    linkedAssetId: input.linkedAssetId,
    linkedBranchId: input.linkedBranchId,
    linkedVersionId: input.linkedVersionId,
    videoTimestamp: input.videoTimestamp,
    pollId: input.pollId,
    payload: input.payload,
  };
  return { graph: { ...graph, nodes: [...graph.nodes, node] }, node };
}

export function createEdge(
  graph: WhiteboardGraph,
  fromNodeId: string,
  toNodeId: string,
  kind: WhiteboardEdge["kind"] = "flow",
): { graph: WhiteboardGraph; edge: WhiteboardEdge } {
  const edge: WhiteboardEdge = {
    id: `edge_${fromNodeId}_${toNodeId}`,
    canvasId: graph.canvasId,
    roomId: graph.roomId,
    fromNodeId,
    toNodeId,
    kind,
  };
  return { graph: { ...graph, edges: [...graph.edges, edge] }, edge };
}

/** Add 文宣/影片/企劃 as a pointer, not a duplicated file. */
export function addRoomContentReference(
  graph: WhiteboardGraph,
  input: {
    type: Extract<WhiteboardNodeType, "poster" | "video" | "video_segment" | "plan" | "asset" | "image">;
    title: string;
    branchId?: string;
    versionId?: string;
    assetId?: string;
    videoTimestamp?: number;
    x?: number;
    y?: number;
  },
): { graph: WhiteboardGraph; node: WhiteboardNode } {
  return createNode(graph, {
    type: input.type,
    text: input.title,
    x: input.x ?? 40,
    y: input.y ?? graph.nodes.length * 88,
    linkedBranchId: input.branchId,
    linkedVersionId: input.versionId,
    linkedAssetId: input.assetId,
    videoTimestamp: input.videoTimestamp,
  });
}

export function addSticky(graph: WhiteboardGraph, text: string, x = 24, y?: number) {
  return createNode(graph, { type: "sticky", text, x, y: y ?? graph.nodes.length * 72 });
}

export function addPollNode(graph: WhiteboardGraph, question: string, pollId: string) {
  return createNode(graph, { type: "poll", text: question, x: 24, y: graph.nodes.length * 72, pollId });
}

export function addDecisionNode(graph: WhiteboardGraph, text: string) {
  return createNode(graph, { type: "decision", text, x: 24, y: graph.nodes.length * 72 });
}

export function createFlow(graph: WhiteboardGraph, steps: string[]): WhiteboardGraph {
  let next = graph;
  const ids: string[] = [];
  steps.forEach((step, index) => {
    const made = createNode(next, { type: "flow", text: step, x: 32, y: 24 + index * 96 });
    next = made.graph;
    ids.push(made.node.id);
  });
  for (let i = 0; i < ids.length - 1; i += 1) {
    next = createEdge(next, ids[i], ids[i + 1], "flow").graph;
  }
  return next;
}

export function createMindmap(graph: WhiteboardGraph, center: string, children: string[]): WhiteboardGraph {
  const root = createNode(graph, { type: "mindmap", text: center, x: 160, y: 40 });
  let next = root.graph;
  children.forEach((child, index) => {
    const made = createNode(next, { type: "mindmap", text: child, x: 40, y: 140 + index * 80 });
    next = createEdge(made.graph, root.node.id, made.node.id, "mindmap").graph;
  });
  return next;
}

export type WhiteboardApplyAction =
  | { type: "add_whiteboard_node"; label?: string; payload: { text: string; nodeType?: WhiteboardNodeType } }
  | { type: "create_flow"; label?: string; payload: { steps: string[] } }
  | { type: "create_mindmap"; label?: string; payload: { center: string; children: string[] } }
  | { type: "create_poll"; label?: string; payload: { question: string; pollId?: string } }
  | { type: "create_decision"; label?: string; payload: { text: string } };

export function applyWhiteboardActions(graph: WhiteboardGraph, actions: WhiteboardApplyAction[]): WhiteboardGraph {
  return actions.reduce((current, action) => {
    if (action.type === "create_flow") return createFlow(current, action.payload.steps);
    if (action.type === "create_mindmap") return createMindmap(current, action.payload.center, action.payload.children);
    if (action.type === "create_poll") {
      return addPollNode(current, action.payload.question, action.payload.pollId ?? `poll_${current.nodes.length}`).graph;
    }
    if (action.type === "create_decision") return addDecisionNode(current, action.payload.text).graph;
    return createNode(current, {
      type: action.payload.nodeType ?? "sticky",
      text: action.payload.text,
      x: 24,
      y: current.nodes.length * 72,
    }).graph;
  }, graph);
}

export function selectedSlice(graph: WhiteboardGraph, nodeIds: string[]): WhiteboardGraph {
  const idSet = new Set(nodeIds);
  const nodes = graph.nodes.filter((node) => idSet.has(node.id));
  const known = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => known.has(edge.fromNodeId) && known.has(edge.toNodeId));
  return { ...graph, nodes, edges };
}

function hash(value: string): number {
  return [...value].reduce((sum, char) => (sum * 33 + char.charCodeAt(0)) | 0, 7);
}
