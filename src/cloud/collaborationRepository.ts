import type { SupabaseClient } from "@supabase/supabase-js";
import type { Room } from "../lib/types";
import type {
  DecisionRecord,
  DiscussionMessage,
  DiscussionSupport,
  Whiteboard,
  WhiteboardEdge,
  WhiteboardFrame,
  WhiteboardNode,
  WhiteboardOperation,
} from "../features/collaboration/types";
import { FRAME_KINDS } from "../features/collaboration/types";
import { isDiscussionKind, isEdgeType, isNodeType } from "../features/collaboration/types";
import { acceptDiscussionInsert } from "./discussionWrite";
import { CloudError } from "./errors";

type WhiteboardRow = {
  id: string;
  room_id: string;
  title: string;
  description: string;
  allow_edit: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  version: number;
};

export type NodeRow = {
  id: string;
  whiteboard_id: string;
  room_id: string;
  node_type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  content: Record<string, unknown> | null;
  linked_entity_type: string | null;
  linked_entity_id: string | null;
  parent_group_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  version: number;
  // 0021/0022（舊部署的列可能缺欄 — 全部 optional，讀側補值）
  rotation?: number | null;
  z_index?: number | null;
  locked?: boolean | null;
  source_version_id?: string | null;
  anchor?: Record<string, unknown> | null;
  updated_by?: string | null;
  deleted_at?: string | null;
  frame_id?: string | null;
};

export type EdgeRow = {
  id: string;
  whiteboard_id: string;
  room_id: string;
  updated_at?: string | null;
  created_by?: string | null;
  version?: number | null;
  source_handle?: string | null;
  target_handle?: string | null;
  source_node_id: string;
  target_node_id: string;
  edge_type: string;
  label: string | null;
  created_at: string;
};

export type DiscussionRow = {
  id: string;
  room_id: string;
  author_user_id: string | null;
  author_name: string;
  author_color: string;
  kind: string;
  body: string;
  payload: Record<string, unknown> | null;
  reply_to_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  deleted_by?: string | null;
};

export type DiscussionReadRow = {
  room_id: string;
  user_id: string;
  last_read_message_id: string | null;
  last_read_at: string;
};

type SupportRow = { message_id: string; room_id: string; user_id: string };

type DecisionRow = {
  id: string;
  room_id: string;
  title: string;
  body: string;
  status: string;
  source_type: string | null;
  source_id: string | null;
  created_by: string | null;
  finalized_by: string | null;
  created_at: string;
  updated_at: string;
  finalized_at: string | null;
  version: number;
};

const ms = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Date.now() : t;
};

const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export function whiteboardFromRow(row: WhiteboardRow): Whiteboard {
  return {
    id: row.id,
    roomId: row.room_id,
    title: row.title,
    description: row.description,
    allowEdit: Boolean(row.allow_edit),
    createdBy: row.created_by ?? "system",
    createdAt: ms(row.created_at),
    updatedAt: ms(row.updated_at),
    archivedAt: row.archived_at ? ms(row.archived_at) : undefined,
    version: row.version ?? 1,
  };
}

export function nodeFromRow(row: NodeRow): WhiteboardNode | null {
  if (!isNodeType(row.node_type)) return null;
  return {
    id: row.id,
    whiteboardId: row.whiteboard_id,
    roomId: row.room_id,
    nodeType: row.node_type,
    x: Number(row.x) || 0,
    y: Number(row.y) || 0,
    width: Number(row.width) || 180,
    height: Number(row.height) || 96,
    content: (row.content && typeof row.content === "object" ? row.content : {}) as WhiteboardNode["content"],
    linkedEntityType: (row.linked_entity_type ?? undefined) as WhiteboardNode["linkedEntityType"],
    linkedEntityId: row.linked_entity_id ?? undefined,
    parentGroupId: row.parent_group_id ?? undefined,
    createdBy: row.created_by ?? "system",
    createdAt: ms(row.created_at),
    updatedAt: ms(row.updated_at),
    version: row.version ?? 1,
    rotation: Number(row.rotation) || 0,
    zIndex: Number(row.z_index) || 0,
    locked: Boolean(row.locked),
    sourceVersionId: row.source_version_id ?? undefined,
    anchor: (row.anchor && typeof row.anchor === "object" ? row.anchor : undefined) as WhiteboardNode["anchor"],
    updatedBy: row.updated_by ?? undefined,
    deletedAt: row.deleted_at ? ms(row.deleted_at) : undefined,
    frameId: row.frame_id ?? undefined,
  };
}

export function edgeFromRow(row: EdgeRow): WhiteboardEdge | null {
  if (!isEdgeType(row.edge_type)) return null;
  return {
    id: row.id,
    whiteboardId: row.whiteboard_id,
    roomId: row.room_id,
    sourceNodeId: row.source_node_id,
    targetNodeId: row.target_node_id,
    edgeType: row.edge_type,
    label: row.label ?? "",
    createdAt: ms(row.created_at),
    updatedAt: row.updated_at ? ms(row.updated_at) : undefined,
    version: row.version ?? 1,
    createdBy: row.created_by ?? undefined,
    sourceHandle: (row.source_handle ?? undefined) as WhiteboardEdge["sourceHandle"],
    targetHandle: (row.target_handle ?? undefined) as WhiteboardEdge["targetHandle"],
  };
}

export function discussionFromRow(row: DiscussionRow): DiscussionMessage | null {
  if (!isDiscussionKind(row.kind)) return null;
  return {
    id: row.id,
    roomId: row.room_id,
    authorId: row.author_user_id ?? "system",
    authorName: row.author_name,
    authorColor: row.author_color,
    kind: row.kind,
    body: row.body,
    payload: (row.payload && typeof row.payload === "object" ? row.payload : {}) as DiscussionMessage["payload"],
    replyToId: row.reply_to_id ?? undefined,
    createdAt: ms(row.created_at),
    updatedAt: ms(row.updated_at),
    deletedAt: row.deleted_at ? ms(row.deleted_at) : undefined,
    deletedBy: row.deleted_by ?? undefined,
  };
}

export function decisionFromRow(row: DecisionRow): DecisionRecord | null {
  if (row.status !== "pending" && row.status !== "decided") return null;
  return {
    id: row.id,
    roomId: row.room_id,
    title: row.title,
    body: row.body,
    status: row.status,
    sourceType: (row.source_type ?? undefined) as DecisionRecord["sourceType"],
    sourceId: row.source_id ?? undefined,
    createdBy: row.created_by ?? "system",
    finalizedBy: row.finalized_by ?? undefined,
    createdAt: ms(row.created_at),
    updatedAt: ms(row.updated_at),
    finalizedAt: row.finalized_at ? ms(row.finalized_at) : undefined,
    version: row.version ?? 1,
  };
}

export type CollaborationSlice = {
  whiteboards: Whiteboard[];
  nodes: WhiteboardNode[];
  edges: WhiteboardEdge[];
  discussion: DiscussionMessage[];
  discussionSupports: DiscussionSupport[];
  decisions: DecisionRecord[];
  allowBoardEdit: boolean;
};

export async function loadCollaborationSummary(supabase: SupabaseClient, roomId: string): Promise<Omit<CollaborationSlice, "nodes" | "edges"> & { nodes: WhiteboardNode[]; edges: WhiteboardEdge[] }> {
  const [boardsRes, discussionRes, supportsRes, decisionsRes, roomRes] = await Promise.all([
    supabase.from("whiteboards").select("*").eq("room_id", roomId).order("updated_at", { ascending: false }),
    supabase.from("room_discussion_messages").select("*").eq("room_id", roomId).order("created_at", { ascending: true }),
    supabase.from("room_discussion_supports").select("*").eq("room_id", roomId),
    supabase.from("decision_records").select("*").eq("room_id", roomId).order("updated_at", { ascending: false }),
    supabase.from("rooms").select("allow_board_edit").eq("id", roomId).maybeSingle(),
  ]);
  // 查詢失敗不得退化成「這間房沒有訊息」。每個結果都寫成 `res.data ?? []`，
  // 所以一次暫時性的 PostgREST 失敗（網路抖動、5xx、RLS 改動）會讓整條討論串
  // 變成空陣列 —— 而快照會整包替換 room.discussion，還會被寫回 IndexedDB。
  // 也就是一次讀取失敗可以同時清空畫面與本機快取。
  //
  // 這裡改成拋出。呼叫端（roomRepository 的 `catch { /* 0014 not applied yet */ }`）
  // 因此保持欄位不動，而 App 的 applyRemoteRoom 有「空的不覆蓋非空的」防護，
  // 使用者看到的是上一份好的快照，不是被抹掉的對話。
  const failed = [boardsRes, discussionRes, supportsRes, decisionsRes, roomRes].find((res) => res.error);
  if (failed?.error) throw new CloudError(failed.error.message, "collaboration-summary");
  return {
    whiteboards: ((boardsRes.data as WhiteboardRow[] | null) ?? []).map(whiteboardFromRow),
    nodes: [],
    edges: [],
    discussion: ((discussionRes.data as DiscussionRow[] | null) ?? []).map(discussionFromRow).filter((item): item is DiscussionMessage => Boolean(item)),
    discussionSupports: ((supportsRes.data as SupportRow[] | null) ?? []).map((row) => ({
      messageId: row.message_id,
      roomId: row.room_id,
      userId: row.user_id,
    })),
    decisions: ((decisionsRes.data as DecisionRow[] | null) ?? []).map(decisionFromRow).filter((item): item is DecisionRecord => Boolean(item)),
    allowBoardEdit: Boolean((roomRes.data as { allow_board_edit?: boolean } | null)?.allow_board_edit),
  };
}

export async function loadWhiteboardGraph(supabase: SupabaseClient, roomId: string, whiteboardId: string): Promise<{ nodes: WhiteboardNode[]; edges: WhiteboardEdge[] }> {
  const [nodesRes, edgesRes] = await Promise.all([
    supabase.from("whiteboard_nodes").select("*").eq("room_id", roomId).eq("whiteboard_id", whiteboardId),
    supabase.from("whiteboard_edges").select("*").eq("room_id", roomId).eq("whiteboard_id", whiteboardId),
  ]);
  return {
    nodes: ((nodesRes.data as NodeRow[] | null) ?? []).map(nodeFromRow).filter((item): item is WhiteboardNode => Boolean(item)),
    edges: ((edgesRes.data as EdgeRow[] | null) ?? []).map(edgeFromRow).filter((item): item is WhiteboardEdge => Boolean(item)),
  };
}

export async function insertWhiteboard(supabase: SupabaseClient, board: Whiteboard): Promise<void> {
  const { error } = await supabase.from("whiteboards").insert({
    id: board.id,
    room_id: board.roomId,
    title: board.title,
    description: board.description,
    allow_edit: board.allowEdit,
    created_by: isUuid(board.createdBy) ? board.createdBy : null,
  });
  if (error) throw new CloudError(error.message, "whiteboard");
}

export async function updateWhiteboard(
  supabase: SupabaseClient,
  board: Pick<Whiteboard, "id" | "roomId" | "title" | "description" | "allowEdit" | "archivedAt" | "version">,
): Promise<void> {
  const { error } = await supabase.from("whiteboards").update({
    title: board.title,
    description: board.description,
    allow_edit: board.allowEdit,
    archived_at: board.archivedAt ? new Date(board.archivedAt).toISOString() : null,
    version: board.version,
  }).eq("id", board.id).eq("room_id", board.roomId);
  if (error) throw new CloudError(error.message, "whiteboard");
}

function nodeRowPayload(node: WhiteboardNode) {
  return {
    id: node.id,
    whiteboard_id: node.whiteboardId,
    room_id: node.roomId,
    node_type: node.nodeType,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    content: node.content,
    linked_entity_type: node.linkedEntityType ?? null,
    linked_entity_id: node.linkedEntityId ?? null,
    parent_group_id: node.parentGroupId ?? null,
    created_by: isUuid(node.createdBy) ? node.createdBy : null,
    version: node.version,
    rotation: node.rotation ?? 0,
    z_index: node.zIndex ?? 0,
    locked: node.locked ?? false,
    source_version_id: node.sourceVersionId ?? null,
    anchor: node.anchor ?? null,
    frame_id: node.frameId ?? null,
    // deleted_at 刻意不在 upsert payload：復活/刪除只走 softDeleteNode 的
    // 專用 update — 一般編輯永遠碰不到墓碑欄。
  };
}

function requireNodeFromRow(row: NodeRow | null, fallback: WhiteboardNode): WhiteboardNode {
  const persisted = row ? nodeFromRow(row) : null;
  if (persisted) return persisted;
  return { ...fallback, version: (fallback.version ?? 1) + 1 };
}

export async function upsertNode(supabase: SupabaseClient, node: WhiteboardNode): Promise<WhiteboardNode> {
  const { data, error } = await supabase.from("whiteboard_nodes").upsert(nodeRowPayload(node)).select("*").maybeSingle();
  if (error) throw new CloudError(error.message, "whiteboard-node");
  return requireNodeFromRow(data as NodeRow | null, node);
}

/**
 * 復活被軟刪的節點（WB04/F1）— **只給版本還原用**。
 *
 * 一般 upsert 的 payload 刻意不含 deleted_at（墓碑紀律：編輯路徑永遠碰
 * 不到那一欄），所以「還原一張含有『之後被刪掉的節點』的快照」原本做不到：
 * 節點樂觀出現、tombstone 的 realtime echo 一到就再度消失。這支是明確的
 * 反向動作：先讀現況 version（含墓碑列）再帶著它 update，OCC 照走。
 */
export async function restoreDeletedNode(
  supabase: SupabaseClient,
  roomId: string,
  node: WhiteboardNode,
): Promise<WhiteboardNode> {
  const { data: existing, error: readError } = await supabase
    .from("whiteboard_nodes")
    .select("version")
    .eq("id", node.id)
    .eq("room_id", roomId)
    .maybeSingle();
  if (readError) throw new CloudError(readError.message, "whiteboard-node");
  if (!existing) {
    // 列真的不見了（硬刪或跨房）→ 當新節點插入
    return upsertNode(supabase, { ...node, version: 1 });
  }
  const currentVersion = Number((existing as { version?: number }).version ?? 1);
  const { data, error } = await supabase
    .from("whiteboard_nodes")
    .update({ ...nodeRowPayload({ ...node, version: currentVersion }), deleted_at: null })
    .eq("id", node.id)
    .eq("room_id", roomId)
    .select("*")
    .maybeSingle();
  if (error) throw new CloudError(error.message, "whiteboard-node");
  return requireNodeFromRow(data as NodeRow | null, { ...node, version: currentVersion });
}

export async function persistNodePosition(supabase: SupabaseClient, node: WhiteboardNode): Promise<WhiteboardNode> {
  const { data, error } = await supabase.from("whiteboard_nodes").update({
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    version: node.version,
  }).eq("id", node.id).eq("whiteboard_id", node.whiteboardId).select("*").maybeSingle();
  if (error) throw new CloudError(error.message, "whiteboard-node");
  return requireNodeFromRow(data as NodeRow | null, node);
}

/**
 * 刪除 = tombstone（0021）：update deleted_at 帶「最後 ack 的 version」
 * 走 touch trigger 的 OCC — 離線刪除蓋掉線上編輯的 ADR-011 缺口在此
 * 關閉（stale 即 raise，上層走既有 conflict 路徑）。REST 硬刪已被 0021
 * revoke，這是唯一刪除路徑。
 */
export async function softDeleteNode(
  supabase: SupabaseClient,
  roomId: string,
  nodeId: string,
  version: number,
): Promise<void> {
  const { error } = await supabase
    .from("whiteboard_nodes")
    .update({ deleted_at: new Date().toISOString(), version })
    .eq("id", nodeId)
    .eq("room_id", roomId);
  if (error) throw new CloudError(error.message, "whiteboard-node");
}

export async function insertEdge(supabase: SupabaseClient, edge: WhiteboardEdge): Promise<void> {
  const { error } = await supabase.from("whiteboard_edges").insert({
    id: edge.id,
    whiteboard_id: edge.whiteboardId,
    room_id: edge.roomId,
    source_node_id: edge.sourceNodeId,
    target_node_id: edge.targetNodeId,
    edge_type: edge.edgeType,
    label: edge.label,
    source_handle: edge.sourceHandle ?? null,
    target_handle: edge.targetHandle ?? null,
    created_by: isUuid(edge.createdBy ?? "") ? edge.createdBy : null,
  });
  if (error) throw new CloudError(error.message, "whiteboard-edge");
}

// ---- frames / operations / versions（0022–0024，WB01 資料層） --------------

export type FrameRow = {
  id: string;
  whiteboard_id: string;
  room_id: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  kind: string;
  style: Record<string, unknown> | null;
  z_index: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  version: number;
};

export function frameFromRow(row: FrameRow): WhiteboardFrame | null {
  if (!(FRAME_KINDS as readonly string[]).includes(row.kind)) return null;
  return {
    id: row.id,
    whiteboardId: row.whiteboard_id,
    roomId: row.room_id,
    title: row.title ?? "",
    x: Number(row.x) || 0,
    y: Number(row.y) || 0,
    width: Number(row.width) || 480,
    height: Number(row.height) || 320,
    kind: row.kind as WhiteboardFrame["kind"],
    style: (row.style && typeof row.style === "object" ? row.style : {}) as Record<string, unknown>,
    zIndex: Number(row.z_index) || -1,
    createdBy: row.created_by ?? "system",
    createdAt: ms(row.created_at),
    updatedAt: ms(row.updated_at),
    version: row.version ?? 1,
  };
}

/**
 * 反向鏈（WB03/S10）：查「哪些還活著的節點引用了這些 entity」。
 *
 * 為什麼不能用房內已載入的節點：loadCollaborationSummary 刻意回
 * nodes: []（節點只在開該板時才載），所以雲端房重整後、使用者還沒開過
 * 板時，對稿頂列的「⊞ 白板 N」入口整個不存在 — 本功能在冷啟動路徑上
 * 等於不存在。這支查詢只取 id/whiteboard_id 兩欄，不把節點灌進房態。
 */
export async function loadNodeRefs(
  supabase: SupabaseClient,
  roomId: string,
  entityIds: string[],
): Promise<Array<{ id: string; whiteboardId: string }>> {
  if (!entityIds.length) return [];
  const { data, error } = await supabase
    .from("whiteboard_nodes")
    .select("id, whiteboard_id")
    .eq("room_id", roomId)
    .in("linked_entity_id", entityIds)
    .is("deleted_at", null);
  if (error) throw new CloudError(error.message, "whiteboard-node");
  return ((data ?? []) as Array<{ id: string; whiteboard_id: string }>).map((row) => ({
    id: row.id,
    whiteboardId: row.whiteboard_id,
  }));
}

export async function loadFrames(
  supabase: SupabaseClient,
  roomId: string,
  whiteboardId: string,
): Promise<WhiteboardFrame[]> {
  const { data, error } = await supabase
    .from("whiteboard_frames")
    .select("*")
    .eq("room_id", roomId)
    .eq("whiteboard_id", whiteboardId);
  if (error) throw new CloudError(error.message, "whiteboard-frame");
  return ((data ?? []) as FrameRow[]).map(frameFromRow).filter((frame): frame is WhiteboardFrame => frame !== null);
}

export async function upsertFrame(supabase: SupabaseClient, frame: WhiteboardFrame): Promise<WhiteboardFrame> {
  const { data, error } = await supabase
    .from("whiteboard_frames")
    .upsert({
      id: frame.id,
      whiteboard_id: frame.whiteboardId,
      room_id: frame.roomId,
      title: frame.title,
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: frame.height,
      kind: frame.kind,
      style: frame.style,
      z_index: frame.zIndex,
      created_by: isUuid(frame.createdBy) ? frame.createdBy : null,
      version: frame.version,
    })
    .select("*")
    .maybeSingle();
  if (error) throw new CloudError(error.message, "whiteboard-frame");
  const persisted = data ? frameFromRow(data as FrameRow) : null;
  return persisted ?? { ...frame, version: (frame.version ?? 1) + 1 };
}

export async function deleteFrame(supabase: SupabaseClient, roomId: string, frameId: string): Promise<void> {
  const { error } = await supabase.from("whiteboard_frames").delete().eq("id", frameId).eq("room_id", roomId);
  if (error) throw new CloudError(error.message, "whiteboard-frame");
}

/**
 * append-only 操作事件（0023）。op_id unique：重試撞 duplicate-key 視為
 * 已入帳（冪等 ack — 與 pendingWrites 的 duplicate-key 語意一致）。
 */
export async function insertOperation(supabase: SupabaseClient, op: WhiteboardOperation): Promise<void> {
  const { error } = await supabase.from("whiteboard_operations").insert({
    op_id: op.opId,
    whiteboard_id: op.whiteboardId,
    room_id: op.roomId,
    actor_user_id: op.actorUserId,
    op_type: op.opType,
    entity_id: op.entityId,
    field_mask: op.fieldMask,
    before: op.before,
    after: op.after,
  });
  if (error && !/duplicate key/i.test(error.message)) {
    throw new CloudError(error.message, "whiteboard-operation");
  }
}

export async function listOperations(
  supabase: SupabaseClient,
  whiteboardId: string,
  limit = 100,
): Promise<WhiteboardOperation[]> {
  const { data, error } = await supabase
    .from("whiteboard_operations")
    .select("*")
    .eq("whiteboard_id", whiteboardId)
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw new CloudError(error.message, "whiteboard-operation");
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    opId: String(row.op_id),
    whiteboardId: String(row.whiteboard_id),
    roomId: String(row.room_id),
    actorUserId: String(row.actor_user_id),
    opType: row.op_type as WhiteboardOperation["opType"],
    entityId: String(row.entity_id),
    fieldMask: Array.isArray(row.field_mask) ? (row.field_mask as string[]) : [],
    before: (row.before && typeof row.before === "object" ? row.before : {}) as Record<string, unknown>,
    after: (row.after && typeof row.after === "object" ? row.after : {}) as Record<string, unknown>,
    createdAt: ms(String(row.created_at)),
  }));
}

export async function createBoardVersion(
  supabase: SupabaseClient,
  input: {
    id: string;
    whiteboardId: string;
    roomId: string;
    label: string;
    createdBy: string;
    snapshot: { nodes: unknown[]; edges: unknown[]; frames?: unknown[] };
  },
): Promise<void> {
  const { error } = await supabase.from("whiteboard_versions").insert({
    id: input.id,
    whiteboard_id: input.whiteboardId,
    room_id: input.roomId,
    label: input.label,
    snapshot: input.snapshot,
    created_by: input.createdBy,
  });
  if (error) throw new CloudError(error.message, "whiteboard-version");
}

/**
 * 版本清單（WB04/P6）：**真的不取 snapshot**。舊版寫著這句註解卻
 * `.select("*")` — 開一次版本歷史就下載 20 份完整快照（每份最多 2000 個
 * 節點含 content）。清單只要 metadata，快照在使用者點下去時才取。
 */
export async function listBoardVersions(
  supabase: SupabaseClient,
  roomId: string,
  whiteboardId: string,
  limit = 20,
): Promise<import("../features/whiteboard/versions").BoardVersionSummary[]> {
  const { data, error } = await supabase
    .from("whiteboard_versions")
    .select("id, whiteboard_id, room_id, label, created_by, created_at")
    .eq("room_id", roomId)
    .eq("whiteboard_id", whiteboardId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new CloudError(error.message, "whiteboard-version");
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    whiteboardId: String(row.whiteboard_id),
    roomId: String(row.room_id),
    label: typeof row.label === "string" ? row.label : "",
    createdBy: String(row.created_by ?? ""),
    createdAt: row.created_at ? new Date(String(row.created_at)).getTime() : 0,
    nodeCount: 0,
  }));
}

/** 單一版本的完整快照（點下去才取；形狀不合的元素會被丟掉並回報）。 */
export async function loadBoardVersion(
  supabase: SupabaseClient,
  roomId: string,
  versionId: string,
): Promise<{ snapshot: import("../features/whiteboard/versions").BoardSnapshot; dropped: number }> {
  const { data, error } = await supabase
    .from("whiteboard_versions")
    .select("snapshot")
    .eq("room_id", roomId)
    .eq("id", versionId)
    .maybeSingle();
  if (error) throw new CloudError(error.message, "whiteboard-version");
  const raw = ((data as { snapshot?: unknown } | null)?.snapshot ?? {}) as {
    nodes?: unknown;
    edges?: unknown;
    frames?: unknown;
  };
  const { sanitizeSnapshot } = await import("../features/whiteboard/versions");
  return sanitizeSnapshot(raw);
}

export async function deleteEdge(supabase: SupabaseClient, roomId: string, edgeId: string): Promise<void> {
  const { error } = await supabase.from("whiteboard_edges").delete().eq("id", edgeId).eq("room_id", roomId);
  if (error) throw new CloudError(error.message, "whiteboard-edge");
}

export async function updateDiscussion(supabase: SupabaseClient, message: Pick<DiscussionMessage, "id" | "roomId" | "body" | "payload">): Promise<void> {
  const { data, error } = await supabase.from("room_discussion_messages").update({
    body: message.body,
    payload: message.payload ?? {},
  }).eq("id", message.id).eq("room_id", message.roomId).abortSignal(AbortSignal.timeout(12000));
  const accepted = acceptDiscussionInsert({ error, data });
  if (!accepted.ok) {
    throw new CloudError(accepted.code === "SPA_HTML" ? "SPA_HTML" : (error?.message ?? "discussion update failed"), "discussion");
  }
}

/** 0031: soft-delete only. Filter by id + room_id so a cross-room id cannot move. */
export async function tombstoneDiscussion(supabase: SupabaseClient, message: Pick<DiscussionMessage, "id" | "roomId">): Promise<void> {
  const { data, error } = await supabase.from("room_discussion_messages").update({
    deleted_at: new Date().toISOString(),
  }).eq("id", message.id).eq("room_id", message.roomId).abortSignal(AbortSignal.timeout(12000));
  const accepted = acceptDiscussionInsert({ error, data });
  if (!accepted.ok) {
    throw new CloudError(accepted.code === "SPA_HTML" ? "SPA_HTML" : (error?.message ?? "discussion tombstone failed"), "discussion");
  }
}

export async function loadDiscussionRead(supabase: SupabaseClient, roomId: string): Promise<{ lastReadMessageId?: string; lastReadAt: number } | null> {
  const { data, error } = await supabase
    .from("room_discussion_reads")
    .select("last_read_message_id, last_read_at")
    .eq("room_id", roomId)
    .maybeSingle();
  if (error) throw new CloudError(error.message, "discussion-read");
  const row = data as Pick<DiscussionReadRow, "last_read_message_id" | "last_read_at"> | null;
  if (!row) return null;
  return {
    lastReadMessageId: row.last_read_message_id ?? undefined,
    lastReadAt: ms(row.last_read_at),
  };
}

export async function upsertDiscussionRead(
  supabase: SupabaseClient,
  roomId: string,
  watermark: { lastReadMessageId?: string; lastReadAt: number },
): Promise<void> {
  const { error } = await supabase.from("room_discussion_reads").upsert({
    room_id: roomId,
    last_read_message_id: watermark.lastReadMessageId ?? null,
    last_read_at: new Date(watermark.lastReadAt).toISOString(),
  }, { onConflict: "room_id,user_id" });
  if (error) throw new CloudError(error.message, "discussion-read");
}

export async function insertDiscussion(supabase: SupabaseClient, message: DiscussionMessage): Promise<void> {
  // 討論訊息的 insert 必須有 deadline（PR-08b 離線矩陣發現）：行動網路
  // 死區（與 CDP offline 模擬一致）的 fetch 會「懸掛而非拒絕」— 沒有
  // timeout 的話 outbox 卡在 sending，重試按鈕永遠不出現。12 秒後 abort
  // → 誠實 failed → 使用者可重試；id 不變，重送撞 duplicate-key=成功。
  const { data, error } = await supabase.from("room_discussion_messages").insert({
    id: message.id,
    room_id: message.roomId,
    author_user_id: isUuid(message.authorId) ? message.authorId : null,
    author_name: message.authorName,
    author_color: message.authorColor,
    kind: message.kind,
    body: message.body,
    payload: message.payload,
    reply_to_id: message.replyToId ?? null,
  }).abortSignal(AbortSignal.timeout(12000));
  const accepted = acceptDiscussionInsert({ error, data });
  if (!accepted.ok) {
    throw new CloudError(accepted.code === "SPA_HTML" ? "SPA_HTML" : (error?.message ?? "discussion insert failed"), "discussion");
  }
}

/**
 * AI 套用的稽核列（0019）。payload 只存呈現層事實（id/type/label），
 * 不存 proposal 原始 payload。RLS 保證 actor=自己、房間=所屬、型別只能
 * 是 ai_proposal_applied — 這裡不重複檢查，policy 是唯一權威。
 */
export async function insertAiApplyAudit(
  supabase: SupabaseClient,
  entry: { roomId: string; actorUserId: string; proposalId: string; proposalType: string; label: string },
): Promise<void> {
  const { error } = await supabase.from("collaboration_audit_events").insert({
    room_id: entry.roomId,
    event_type: "ai_proposal_applied",
    actor_user_id: entry.actorUserId,
    payload: { proposal_id: entry.proposalId, type: entry.proposalType, label: entry.label.slice(0, 240) },
  });
  if (error) throw new CloudError(error.message, "ai-audit");
}

export async function setDiscussionSupport(supabase: SupabaseClient, roomId: string, messageId: string, add: boolean): Promise<void> {
  if (add) {
    const { error } = await supabase.from("room_discussion_supports").upsert({ message_id: messageId, room_id: roomId });
    if (error) throw new CloudError(error.message, "discussion-support");
    return;
  }
  const { error } = await supabase.from("room_discussion_supports").delete().eq("message_id", messageId).eq("room_id", roomId);
  if (error) throw new CloudError(error.message, "discussion-support");
}

export async function insertDecision(supabase: SupabaseClient, decision: DecisionRecord): Promise<void> {
  const { error } = await supabase.from("decision_records").insert({
    id: decision.id,
    room_id: decision.roomId,
    title: decision.title,
    body: decision.body,
    status: decision.status,
    source_type: decision.sourceType ?? null,
    source_id: decision.sourceId ?? null,
    created_by: isUuid(decision.createdBy) ? decision.createdBy : null,
    finalized_at: decision.finalizedAt ? new Date(decision.finalizedAt).toISOString() : null,
    finalized_by: decision.finalizedBy && isUuid(decision.finalizedBy) ? decision.finalizedBy : null,
  });
  if (error) throw new CloudError(error.message, "decision");
}

export async function updateDecision(supabase: SupabaseClient, decision: DecisionRecord): Promise<void> {
  const { error } = await supabase.from("decision_records").update({
    title: decision.title,
    body: decision.body,
    status: decision.status,
    version: decision.version,
  }).eq("id", decision.id).eq("room_id", decision.roomId);
  if (error) throw new CloudError(error.message, "decision");
}

export async function setAllowBoardEdit(supabase: SupabaseClient, roomId: string, allow: boolean): Promise<void> {
  const { error } = await supabase.from("rooms").update({ allow_board_edit: allow }).eq("id", roomId);
  if (error) throw new CloudError(error.message, "room");
}

export type CollaborationIdMaps = {
  branchIdMap?: Map<string, string>;
  versionIdMap?: Map<string, string>;
  pollIdMap?: Map<string, string>;
};

export function collaborationSliceFromRoom(room: Pick<Room, "whiteboards" | "whiteboardNodes" | "whiteboardEdges" | "discussion" | "discussionSupports" | "decisions" | "allowBoardEdit">): CollaborationSlice {
  return {
    whiteboards: room.whiteboards ?? [],
    nodes: room.whiteboardNodes ?? [],
    edges: room.whiteboardEdges ?? [],
    discussion: room.discussion ?? [],
    discussionSupports: room.discussionSupports ?? [],
    decisions: room.decisions ?? [],
    allowBoardEdit: Boolean(room.allowBoardEdit),
  };
}

function remapId(id: string | undefined, map?: Map<string, string>): string | undefined {
  if (!id) return id;
  return map?.get(id) ?? id;
}

function remapLinkedId(type: WhiteboardNode["linkedEntityType"], id: string | undefined, maps: CollaborationIdMaps): string | undefined {
  if (!id) return id;
  if (type === "version" || type === "asset") return remapId(id, maps.versionIdMap);
  if (type === "branch" || type === "plan") return remapId(id, maps.branchIdMap);
  if (type === "poll") return remapId(id, maps.pollIdMap);
  return id;
}

/** Rewrite local room / entity ids so a first-share upload lands in the new cloud room. */
export function remapCollaborationSlice(slice: CollaborationSlice, roomId: string, maps: CollaborationIdMaps = {}): CollaborationSlice {
  return {
    allowBoardEdit: slice.allowBoardEdit,
    whiteboards: slice.whiteboards.map((board) => ({ ...board, roomId })),
    nodes: slice.nodes.map((node) => ({
      ...node,
      roomId,
      linkedEntityId: remapLinkedId(node.linkedEntityType, node.linkedEntityId, maps),
    })),
    edges: slice.edges.map((edge) => ({ ...edge, roomId })),
    discussion: slice.discussion.map((message) => ({
      ...message,
      roomId,
      payload: {
        ...message.payload,
        branchId: remapId(message.payload.branchId, maps.branchIdMap),
        versionId: remapId(message.payload.versionId, maps.versionIdMap),
        pollId: remapId(message.payload.pollId, maps.pollIdMap),
      },
    })),
    discussionSupports: slice.discussionSupports.map((support) => ({ ...support, roomId })),
    decisions: slice.decisions.map((decision) => ({
      ...decision,
      roomId,
      sourceId: decision.sourceType === "poll" ? remapId(decision.sourceId, maps.pollIdMap) : decision.sourceId,
    })),
  };
}

export function collaborationSliceHasRows(slice: CollaborationSlice): boolean {
  return Boolean(
    slice.whiteboards.length
    || slice.nodes.length
    || slice.edges.length
    || slice.discussion.length
    || slice.discussionSupports.length
    || slice.decisions.length
    || slice.allowBoardEdit,
  );
}

/**
 * Upload a local collaboration slice into an already-created cloud room.
 * Used by first-share migration so reload does not replace boards/discussion
 * with empty cloud results.
 */
export async function insertCollaborationSlice(supabase: SupabaseClient, slice: CollaborationSlice): Promise<void> {
  if (!collaborationSliceHasRows(slice)) return;
  const roomId = slice.whiteboards[0]?.roomId
    ?? slice.nodes[0]?.roomId
    ?? slice.discussion[0]?.roomId
    ?? slice.decisions[0]?.roomId;
  if (slice.allowBoardEdit && roomId) {
    await setAllowBoardEdit(supabase, roomId, true);
  }
  if (slice.whiteboards.length) {
    const { error } = await supabase.from("whiteboards").insert(slice.whiteboards.map((board) => ({
      id: board.id,
      room_id: board.roomId,
      title: board.title,
      description: board.description,
      allow_edit: board.allowEdit,
      created_by: isUuid(board.createdBy) ? board.createdBy : null,
      archived_at: board.archivedAt ? new Date(board.archivedAt).toISOString() : null,
    })));
    if (error) throw new CloudError(error.message, "whiteboard");
  }
  if (slice.nodes.length) {
    const { error } = await supabase.from("whiteboard_nodes").insert(slice.nodes.map(nodeRowPayload));
    if (error) throw new CloudError(error.message, "whiteboard-node");
  }
  if (slice.edges.length) {
    const { error } = await supabase.from("whiteboard_edges").insert(slice.edges.map((edge) => ({
      id: edge.id,
      whiteboard_id: edge.whiteboardId,
      room_id: edge.roomId,
      source_node_id: edge.sourceNodeId,
      target_node_id: edge.targetNodeId,
      edge_type: edge.edgeType,
      label: edge.label,
    })));
    if (error) throw new CloudError(error.message, "whiteboard-edge");
  }
  if (slice.discussion.length) {
    const { error } = await supabase.from("room_discussion_messages").insert(slice.discussion.map((message) => ({
      id: message.id,
      room_id: message.roomId,
      author_user_id: isUuid(message.authorId) ? message.authorId : null,
      author_name: message.authorName,
      author_color: message.authorColor,
      kind: message.kind,
      body: message.body,
      payload: message.payload,
      reply_to_id: message.replyToId ?? null,
    })));
    if (error) throw new CloudError(error.message, "discussion");
  }
  const supportRows = slice.discussionSupports.filter((support) => isUuid(support.userId));
  if (supportRows.length) {
    const { error } = await supabase.from("room_discussion_supports").insert(supportRows.map((support) => ({
      message_id: support.messageId,
      room_id: support.roomId,
      user_id: support.userId,
    })));
    if (error) throw new CloudError(error.message, "discussion-support");
  }
  if (slice.decisions.length) {
    const { error } = await supabase.from("decision_records").insert(slice.decisions.map((decision) => ({
      id: decision.id,
      room_id: decision.roomId,
      title: decision.title,
      body: decision.body,
      status: decision.status,
      source_type: decision.sourceType ?? null,
      source_id: decision.sourceId ?? null,
      created_by: isUuid(decision.createdBy) ? decision.createdBy : null,
      finalized_at: decision.finalizedAt ? new Date(decision.finalizedAt).toISOString() : null,
      finalized_by: decision.finalizedBy && isUuid(decision.finalizedBy) ? decision.finalizedBy : null,
    })));
    if (error) throw new CloudError(error.message, "decision");
  }
}

export async function fetchWhiteboardContext(supabase: SupabaseClient, whiteboardId: string): Promise<unknown> {
  const { data, error } = await supabase.rpc("get_whiteboard_context", { p_whiteboard_id: whiteboardId });
  if (error) throw new CloudError(error.message, "whiteboard-context");
  return data;
}
