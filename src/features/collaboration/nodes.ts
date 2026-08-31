import type {
  EdgeType,
  LinkedEntityType,
  NodeContent,
  NodeType,
  WhiteboardEdge,
  WhiteboardNode,
} from "./types";

const uid = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `n_${Date.now()}_${Math.random()}`);

const DEFAULT_SIZE: Record<NodeType, { width: number; height: number }> = {
  text: { width: 180, height: 96 },
  image: { width: 280, height: 280 },
  room_content: { width: 200, height: 120 },
  flow: { width: 176, height: 72 },
  mindmap: { width: 160, height: 64 },
  decision: { width: 200, height: 88 },
  poll: { width: 200, height: 88 },
  link: { width: 180, height: 72 },
  group: { width: 280, height: 200 },
  ai_result: { width: 200, height: 96 },
  // freehand 實際尺寸由筆畫外接框決定（normalizeStroke）；這裡只是型別完備
  freehand: { width: 120, height: 120 },
  calendar_event: { width: 200, height: 88 },
  task: { width: 200, height: 88 },
};

export function createNode(input: {
  whiteboardId: string;
  roomId: string;
  nodeType: NodeType;
  x?: number;
  y?: number;
  content?: NodeContent;
  linkedEntityType?: LinkedEntityType;
  linkedEntityId?: string;
  createdBy: string;
  id?: string;
}): WhiteboardNode {
  const size = DEFAULT_SIZE[input.nodeType];
  const now = Date.now();
  return {
    id: input.id ?? uid(),
    whiteboardId: input.whiteboardId,
    roomId: input.roomId,
    nodeType: input.nodeType,
    x: input.x ?? 80,
    y: input.y ?? 80,
    width: size.width,
    height: size.height,
    content: input.content ?? {},
    linkedEntityType: input.linkedEntityType,
    linkedEntityId: input.linkedEntityId,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}

export function createSticky(input: {
  whiteboardId: string;
  roomId: string;
  createdBy: string;
  text?: string;
  x?: number;
  y?: number;
}): WhiteboardNode {
  return createNode({
    ...input,
    nodeType: "text",
    content: { text: input.text ?? "" },
  });
}

export function createEdge(input: {
  whiteboardId: string;
  roomId: string;
  sourceNodeId: string;
  targetNodeId: string;
  edgeType?: EdgeType;
  label?: string;
  id?: string;
}): WhiteboardEdge {
  return {
    id: input.id ?? uid(),
    whiteboardId: input.whiteboardId,
    roomId: input.roomId,
    sourceNodeId: input.sourceNodeId,
    targetNodeId: input.targetNodeId,
    edgeType: input.edgeType ?? "default",
    label: input.label ?? "",
    createdAt: Date.now(),
  };
}

const FLOW_GAP_Y = 112;
const MINDMAP_GAP_X = 200;
const MINDMAP_GAP_Y = 80;

/** Mobile primitive: tap a flow node → 下一步. Creates the next node + edge. */
export function addFlowNextStep(
  source: WhiteboardNode,
  text: string,
  createdBy: string,
  siblings: WhiteboardNode[],
): { node: WhiteboardNode; edge: WhiteboardEdge } {
  const outgoing = siblings.filter((node) => node.y > source.y && Math.abs(node.x - source.x) < 40);
  const node = createNode({
    whiteboardId: source.whiteboardId,
    roomId: source.roomId,
    nodeType: "flow",
    createdBy,
    x: source.x,
    y: source.y + source.height + FLOW_GAP_Y + outgoing.length * 8,
    content: { text },
  });
  return {
    node,
    edge: createEdge({
      whiteboardId: source.whiteboardId,
      roomId: source.roomId,
      sourceNodeId: source.id,
      targetNodeId: node.id,
      edgeType: "flow",
    }),
  };
}

/** Mobile primitive: tap a mindmap node → 子項目. */
export function addMindmapChild(
  parent: WhiteboardNode,
  text: string,
  createdBy: string,
  existingEdges: WhiteboardEdge[],
  existingNodes: WhiteboardNode[],
): { node: WhiteboardNode; edge: WhiteboardEdge } {
  const childIds = new Set(
    existingEdges.filter((edge) => edge.sourceNodeId === parent.id && edge.edgeType === "mindmap").map((edge) => edge.targetNodeId),
  );
  const children = existingNodes.filter((node) => childIds.has(node.id));
  const node = createNode({
    whiteboardId: parent.whiteboardId,
    roomId: parent.roomId,
    nodeType: "mindmap",
    createdBy,
    x: parent.x + parent.width + MINDMAP_GAP_X,
    y: parent.y + children.length * MINDMAP_GAP_Y,
    content: { text },
  });
  return {
    node,
    edge: createEdge({
      whiteboardId: parent.whiteboardId,
      roomId: parent.roomId,
      sourceNodeId: parent.id,
      targetNodeId: node.id,
      edgeType: "mindmap",
    }),
  };
}

export function nodeSearchText(node: WhiteboardNode): string {
  const { text, title, subtitle, filename, pollQuestion, sourceLabel } = node.content;
  return [text, title, subtitle, filename, pollQuestion, sourceLabel].filter(Boolean).join(" ");
}

export function findNodes(nodes: WhiteboardNode[], query: string): WhiteboardNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return nodes;
  return nodes.filter((node) => `${nodeSearchText(node)} ${node.nodeType}`.toLowerCase().includes(needle));
}

export function formatTimestamp(seconds?: number): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Accepts `40`, `00:40`, or `1:05`. */
export function parseTimestamp(value: string): number | undefined {
  const raw = value.trim();
  if (!raw) return undefined;
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
  }
  const match = /^(\d+):([0-5]?\d)$/.exec(raw);
  if (!match) return undefined;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function formatVideoRange(start?: number, end?: number): string {
  if (start == null) return "";
  if (end == null || end <= start) return formatTimestamp(start);
  return `${formatTimestamp(start)}–${formatTimestamp(end)}`;
}

/**
 * Optimistic-lock precondition for touch_whiteboard_node: send the last
 * acknowledged server version, never a client-advanced guess. The trigger
 * increments after a successful write; adopting that increment is what
 * prepares the next persist.
 */
export function stampPersistedNode(node: WhiteboardNode, lastAcked?: WhiteboardNode | number | null): WhiteboardNode {
  const acked = typeof lastAcked === "number" ? lastAcked : lastAcked?.version;
  return { ...node, version: acked ?? node.version ?? 1 };
}

/** Keep local content; only take a newer server version/timestamp after ack. */
export function adoptPersistedNode(local: WhiteboardNode, persisted: WhiteboardNode): WhiteboardNode {
  return {
    ...local,
    version: Math.max(local.version ?? 1, persisted.version ?? 1),
    updatedAt: Math.max(local.updatedAt ?? 0, persisted.updatedAt ?? 0),
  };
}

/** Mirrors 0014 touch_whiteboard_node: reject only versions lower than stored. */
export function touchWhiteboardNodeVersion(incoming: number, stored: number): number {
  if (incoming !== stored && incoming < stored) throw new Error("stale-write");
  return stored + 1;
}

export function applyNodePatch(node: WhiteboardNode, patch: Partial<Pick<WhiteboardNode, "x" | "y" | "width" | "height" | "content" | "parentGroupId">>): WhiteboardNode {
  return {
    ...node,
    ...patch,
    content: patch.content ? { ...node.content, ...patch.content } : node.content,
    updatedAt: Date.now(),
  };
}

export function groupSelected(nodes: WhiteboardNode[], selectedIds: string[], createdBy: string): { group: WhiteboardNode; nodes: WhiteboardNode[] } | null {
  const selected = nodes.filter((node) => selectedIds.includes(node.id) && node.nodeType !== "group");
  if (selected.length < 2) return null;
  const minX = Math.min(...selected.map((node) => node.x));
  const minY = Math.min(...selected.map((node) => node.y));
  const maxX = Math.max(...selected.map((node) => node.x + node.width));
  const maxY = Math.max(...selected.map((node) => node.y + node.height));
  const group = createNode({
    whiteboardId: selected[0].whiteboardId,
    roomId: selected[0].roomId,
    nodeType: "group",
    createdBy,
    x: minX - 16,
    y: minY - 28,
    content: { text: "群組", groupIds: selected.map((node) => node.id) },
  });
  group.width = maxX - minX + 32;
  group.height = maxY - minY + 48;
  return {
    group,
    nodes: nodes.map((node) => (selectedIds.includes(node.id) ? { ...node, parentGroupId: group.id, updatedAt: Date.now() } : node)),
  };
}

export function moveNodes(nodes: WhiteboardNode[], ids: string[], dx: number, dy: number): WhiteboardNode[] {
  const moving = new Set(ids);
  return nodes.map((node) => (moving.has(node.id) ? { ...node, x: node.x + dx, y: node.y + dy, updatedAt: Date.now() } : node));
}

/** Version fields the board may show. Never original file bytes. */
export type BoardMediaSource = {
  kind?: "image" | "video";
  imageDataUrl?: string;
  videoUrl?: string;
  width?: number;
  height?: number;
};

const MEDIA_BOX = {
  poster: { width: 280, height: 360 },
  video: { width: 360, height: 220 },
  asset: { width: 280, height: 280 },
  plan: { width: 200, height: 120 },
} as const;

/** Copy the version's display URLs onto the node. Local/E2E data URLs stay. */
export function boardMediaFromVersion(version?: BoardMediaSource): Pick<NodeContent, "thumbnailUrl" | "videoUrl"> {
  if (!version) return {};
  const thumbnailUrl = version.imageDataUrl?.trim() || undefined;
  const videoUrl = version.videoUrl?.trim() || undefined;
  return {
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    ...(videoUrl ? { videoUrl } : {}),
  };
}

/** Fit a poster / video / asset onto the canvas without the 52px card size. */
export function boardMediaSize(
  kind?: NodeContent["mediaKind"],
  version?: Pick<BoardMediaSource, "width" | "height">,
): { width: number; height: number } {
  const box = MEDIA_BOX[kind && kind in MEDIA_BOX ? kind : "asset"];
  const vw = version?.width;
  const vh = version?.height;
  if (vw && vh && vw > 0 && vh > 0) {
    const scale = Math.min(box.width / vw, box.height / vh);
    return {
      width: Math.max(120, Math.round(vw * scale)),
      height: Math.max(88, Math.round(vh * scale)),
    };
  }
  return { width: box.width, height: box.height };
}

export function showsBoardMedia(content: NodeContent): boolean {
  if (content.mediaKind === "plan") return false;
  return Boolean(content.videoUrl || content.thumbnailUrl);
}

/** Prefer live version URLs (signed URLs refresh) over a stale copy on the node. */
export function hydrateBoardMedia(node: WhiteboardNode, version?: BoardMediaSource): WhiteboardNode {
  if (node.nodeType !== "room_content" && node.nodeType !== "image") return node;
  if (node.content.mediaKind === "plan") return node;
  const media = boardMediaFromVersion(version);
  if (!media.thumbnailUrl && !media.videoUrl) return node;
  if (node.content.thumbnailUrl === media.thumbnailUrl && node.content.videoUrl === media.videoUrl) return node;
  return {
    ...node,
    content: {
      ...node.content,
      thumbnailUrl: media.thumbnailUrl ?? node.content.thumbnailUrl,
      videoUrl: media.videoUrl ?? node.content.videoUrl,
    },
  };
}

export function createRelationEdges(
  whiteboardId: string,
  roomId: string,
  ids: string[],
): WhiteboardEdge[] {
  if (ids.length < 2) return [];
  const edges: WhiteboardEdge[] = [];
  for (let i = 0; i < ids.length - 1; i += 1) {
    edges.push(createEdge({
      whiteboardId,
      roomId,
      sourceNodeId: ids[i],
      targetNodeId: ids[i + 1],
      edgeType: "relation",
    }));
  }
  return edges;
}
