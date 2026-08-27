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
};

export type DiscussionPayload = {
  quotedBody?: string;
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
