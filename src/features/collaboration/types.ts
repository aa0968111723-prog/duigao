/** Collaboration Workspace 1.0 domain types. Cloud rows map 1:1. */

export const NODE_TYPES = [
  "text",
  "image",
  "room_content",
  "flow",
  "mindmap",
  "decision",
  "poll",
  "link",
  "group",
  "ai_result",
  // WB03（0026）：手繪筆畫 — content.points 是相對節點左上的 [x,y][]
  "freehand",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const EDGE_TYPES = ["default", "flow", "mindmap", "relation"] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

export const LINKED_ENTITY_TYPES = [
  "branch",
  "version",
  "plan",
  "poll",
  "decision",
  "asset",
  "discussion",
  "whiteboard",
] as const;
export type LinkedEntityType = (typeof LINKED_ENTITY_TYPES)[number];

export const DISCUSSION_KINDS = [
  "text",
  "quote",
  "image",
  "room_asset",
  "poster",
  "video",
  "plan",
  "poll",
  "whiteboard",
  "node",
  "decision",
  // PR-01b Universal Intake：檔案卡（payload.path/mime）與純連結卡（payload.href）
  "attachment",
  "link",
] as const;
export type DiscussionKind = (typeof DISCUSSION_KINDS)[number];

export const DECISION_STATUSES = ["pending", "decided"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export type BoardPermission = "view" | "collaborate";

export type Whiteboard = {
  id: string;
  roomId: string;
  title: string;
  description: string;
  allowEdit: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
  version: number;
};

export type RoomContentKind = "poster" | "video" | "plan" | "asset";

export type NodeContent = {
  text?: string;
  color?: string;
  /** Thumbnail URL or data URL — never the original full-res asset. */
  thumbnailUrl?: string;
  title?: string;
  subtitle?: string;
  versionLabel?: string;
  openCommentCount?: number;
  duration?: number;
  startTime?: number;
  endTime?: number;
  filename?: string;
  mediaKind?: RoomContentKind;
  pollQuestion?: string;
  voteCount?: number;
  decided?: boolean;
  sourceLabel?: string;
  href?: string;
  groupIds?: string[];
  /** Mobile-safe presence stamp. Never a cursor stream. */
  lastWriterId?: string;
  lastWriterName?: string;
  /** freehand（WB03）：相對節點左上的筆畫點；搬節點＝搬筆畫。 */
  points?: [number, number][];
  strokeWidth?: number;
};

export type WhiteboardNode = {
  id: string;
  whiteboardId: string;
  roomId: string;
  nodeType: NodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  content: NodeContent;
  linkedEntityType?: LinkedEntityType;
  linkedEntityId?: string;
  parentGroupId?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  version: number;
  // canonical 欄位（0021/0022，WB01）。optional：舊列走 DB default，
  // 讀側以 ?? 補值；UI 消費屬 WB02。
  rotation?: number;
  zIndex?: number;
  locked?: boolean;
  /** 指向 versions.id：來源作品的「哪一版」（provenance 的版本半邊）。 */
  sourceVersionId?: string;
  /** ContextAnchor 序列化（jsonb）；形狀權威在 src/lib/contextAnchor。 */
  anchor?: Record<string, unknown>;
  updatedBy?: string;
  /** tombstone（0021）：非空＝已刪。過濾點在 offline.ts 純函式，不散落 UI。 */
  deletedAt?: number;
  /** 空間容器歸屬（0022 frames）；不參與 paint order。 */
  frameId?: string;
};

export type WhiteboardEdge = {
  id: string;
  whiteboardId: string;
  roomId: string;
  sourceNodeId: string;
  targetNodeId: string;
  edgeType: EdgeType;
  label: string;
  createdAt: number;
  // 0021：edges 補 OCC 與出處（audit：先前零 OCC）
  updatedAt?: number;
  version?: number;
  createdBy?: string;
  sourceHandle?: EdgeHandle;
  targetHandle?: EdgeHandle;
};

export const EDGE_HANDLES = ["top", "right", "bottom", "left", "auto"] as const;
export type EdgeHandle = (typeof EDGE_HANDLES)[number];

export const FRAME_KINDS = [
  "frame", "zone", "swimlane", "kanban-column", "vote-area",
  "status-needs-review", "status-needs-changes", "status-approved", "parking-lot",
] as const;
export type FrameKind = (typeof FRAME_KINDS)[number];

/** 空間容器（0022）：與 group（選取聚合）不同語意。z 恆 < 0（DB CHECK）。 */
export type WhiteboardFrame = {
  id: string;
  whiteboardId: string;
  roomId: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  kind: FrameKind;
  style: Record<string, unknown>;
  zIndex: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  version: number;
};

export const WHITEBOARD_OP_TYPES = [
  "node-create", "node-update", "node-delete", "node-move",
  "edge-create", "edge-update", "edge-delete",
  "frame-create", "frame-update", "frame-delete",
  "board-arrange", "bulk-restore",
] as const;
export type WhiteboardOpType = (typeof WHITEBOARD_OP_TYPES)[number];

/**
 * append-only 操作事件（0023，ADR-014）。不是第二個 truth：套用順序由
 * row state＋OCC 決定。opId 由 client 產生（重試冪等）；before/after 只含
 * fieldMask 內欄位 — undo 永不整列還原。
 */
export type WhiteboardOperation = {
  opId: string;
  whiteboardId: string;
  roomId: string;
  actorUserId: string;
  opType: WhiteboardOpType;
  entityId: string;
  fieldMask: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  createdAt: number;
};

export type DiscussionPayload = {
  quotedBody?: string;
  /** message 錨（WB01）：引用房內另一則討論訊息。 */
  messageId?: string;
  /** plan-section 錨（WB01）：企劃分支內的段落 id。 */
  planSectionId?: string;
  /** 唯讀併入的 legacy（0001 messages）列：討論表沒有這個 id，互動一律關閉。 */
  legacy?: boolean;
  /** attachment：room-assets 物件 key（永遠不是 signed URL）。 */
  path?: string;
  /** attachment：MIME（client 主張，顯示用；安全判斷不得信任）。 */
  mime?: string;
  /** attachment：位元組數（client 主張，顯示用）。 */
  size?: number;
  /** attachment：原始檔名（顯示用）。 */
  name?: string;
  /** link：目標 URL（渲染端只接受 http/https）。 */
  href?: string;
  /** attachment：planform 場佈摘要（PR-06；client 主張，顯示用）。 */
  planform?: {
    projectId?: string;
    name: string;
    version: number;
    zoneCount: number;
    objectCount: number;
    routeCount: number;
  };
  branchId?: string;
  versionId?: string;
  whiteboardId?: string;
  nodeId?: string;
  pollId?: string;
  decisionId?: string;
  thumbnailUrl?: string;
  title?: string;
  startTime?: number;
  endTime?: number;
};

export type DiscussionMessage = {
  id: string;
  roomId: string;
  authorId: string;
  authorName: string;
  authorColor: string;
  kind: DiscussionKind;
  body: string;
  payload: DiscussionPayload;
  replyToId?: string;
  createdAt: number;
  updatedAt: number;
};

export type DiscussionSupport = {
  messageId: string;
  roomId: string;
  userId: string;
};

export type DecisionRecord = {
  id: string;
  roomId: string;
  title: string;
  body: string;
  status: DecisionStatus;
  sourceType?: "poll" | "discussion" | "whiteboard" | "manual";
  sourceId?: string;
  createdBy: string;
  finalizedBy?: string;
  createdAt: number;
  updatedAt: number;
  finalizedAt?: number;
  version: number;
};

export type VoiceSessionStatus = "scheduled" | "live" | "ended";

export type VoiceSession = {
  id: string;
  roomId: string;
  title: string;
  status: VoiceSessionStatus;
  createdBy: string;
  createdAt: number;
  endedAt?: number;
};

export type VoiceParticipant = {
  sessionId: string;
  roomId: string;
  userId: string;
  displayName: string;
  muted: boolean;
  joinedAt: number;
  leftAt?: number;
};

export type PresentationState = {
  roomId: string;
  activeEntityType?: "branch" | "version" | "whiteboard" | "node" | "discussion" | "video";
  activeEntityId?: string;
  videoTime?: number;
  whiteboardId?: string;
  whiteboardX?: number;
  whiteboardY?: number;
  whiteboardZoom?: number;
  presenterUserId?: string;
  updatedAt: number;
};

export type WhiteboardContext = {
  whiteboard: Pick<Whiteboard, "id" | "roomId" | "title" | "description" | "archivedAt" | "updatedAt">;
  nodes: Array<Pick<WhiteboardNode, "id" | "nodeType" | "x" | "y" | "width" | "height" | "content" | "linkedEntityType" | "linkedEntityId">>;
  edges: Array<Pick<WhiteboardEdge, "id" | "sourceNodeId" | "targetNodeId" | "edgeType" | "label">>;
  linkedEntities: Array<{ nodeId: string; entityType: LinkedEntityType; entityId: string }>;
};

export type SelectionContext = {
  whiteboardId: string;
  roomId: string;
  nodes: Array<Pick<WhiteboardNode, "id" | "nodeType" | "content" | "linkedEntityType" | "linkedEntityId">>;
};

export type DiscussionContext = {
  roomId: string;
  messages: DiscussionMessage[];
  decisions: DecisionRecord[];
};

export type PresenceEditor = {
  userId: string;
  name: string;
  whiteboardId?: string;
  whiteboardTitle?: string;
};

export type PendingEdit = {
  id: string;
  roomId: string;
  kind: "node" | "edge" | "whiteboard" | "discussion" | "decision";
  op: "upsert" | "delete";
  payload: unknown;
  createdAt: number;
};

export function isNodeType(value: unknown): value is NodeType {
  return typeof value === "string" && (NODE_TYPES as readonly string[]).includes(value);
}

export function isEdgeType(value: unknown): value is EdgeType {
  return typeof value === "string" && (EDGE_TYPES as readonly string[]).includes(value);
}

export function isDiscussionKind(value: unknown): value is DiscussionKind {
  return typeof value === "string" && (DISCUSSION_KINDS as readonly string[]).includes(value);
}
