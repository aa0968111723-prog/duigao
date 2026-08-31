import { anchorFromNode, anchorToDiscussionPayload, anchorToNodeLink } from "../../lib/contextAnchor";
import { boardMediaFromVersion, boardMediaSize, createNode, createSticky, hydrateBoardMedia } from "./nodes";
import { nodeFromPlanSection } from "./boardAnchors";
import type { Room, Version } from "../../lib/types";
import type { DiscussionMessage, DiscussionPayload, LinkedEntityType, NodeContent, RoomContentKind, WhiteboardNode } from "./types";

/** Board → discussion: only ids + label, never media bytes. */
export function discussionPayloadFromNode(node: WhiteboardNode, boardTitle?: string): DiscussionPayload {
  const label = node.content.text || node.content.title || "節點";
  return {
    // 參照欄位走 ContextAnchor 契約層（PR-02d）；label 是呈現，留在呼叫端。
    ...anchorToDiscussionPayload({ type: "board-node", whiteboardId: node.whiteboardId, nodeId: node.id }),
    title: boardTitle ? `${boardTitle} · ${label}` : label,
  };
}

/** Composer stamp while a board node is focused. Kind stays text. */
export function discussionPayloadFromFocusNode(node: WhiteboardNode): DiscussionPayload {
  const fromAnchor = anchorToDiscussionPayload(anchorFromNode(node));
  const versionId = (typeof node.sourceVersionId === "string" && node.sourceVersionId)
    || (node.linkedEntityType === "version" ? node.linkedEntityId : undefined)
    || fromAnchor.versionId;
  const branchId = fromAnchor.branchId
    || ((node.linkedEntityType === "branch" || node.linkedEntityType === "plan") ? node.linkedEntityId : undefined);
  const planSectionId = (typeof node.anchor?.sectionId === "string" && node.anchor.sectionId)
    || fromAnchor.planSectionId;
  const startTime = node.content.startTime ?? fromAnchor.startTime;
  const endTime = node.content.endTime ?? fromAnchor.endTime;
  return {
    ...fromAnchor,
    whiteboardId: node.whiteboardId,
    nodeId: node.id,
    ...(versionId ? { versionId } : {}),
    ...(branchId ? { branchId } : {}),
    ...(planSectionId ? { planSectionId } : {}),
    ...(startTime != null ? { startTime } : {}),
    ...(endTime != null ? { endTime } : {}),
  };
}

export function discussionShowsContentActions(message: Pick<DiscussionMessage, "kind" | "payload">): boolean {
  if (message.kind === "poster" || message.kind === "video" || message.kind === "plan") return true;
  const payload = message.payload ?? {};
  return Boolean(payload.versionId || payload.planSectionId || (payload.branchId && payload.startTime != null));
}

export function discussionPlacesAsRoomContent(message: Pick<DiscussionMessage, "kind" | "payload">): boolean {
  return discussionShowsContentActions(message);
}

/** Discussion → board: a sticky that quotes the message body. */
export function stickyFromDiscussion(
  message: DiscussionMessage,
  whiteboardId: string,
  createdBy: string,
  position?: { x?: number; y?: number },
): WhiteboardNode {
  const sticky = createSticky({
    whiteboardId,
    roomId: message.roomId,
    createdBy,
    text: message.body,
    x: position?.x,
    y: position?.y,
  });
  // provenance（WB03）：訊息→白板必須留錨 — anchorToNodeLink 的
  // message 臂產 {linkedEntityType:"discussion", linkedEntityId}，
  // 「打開來源訊息」靠它跳回。sourceLabel 給卡片顯示出處。
  return {
    ...sticky,
    ...anchorToNodeLink({ type: "message", messageId: message.id }),
    content: { ...sticky.content, sourceLabel: `討論 · ${message.authorName || "成員"}` },
  };
}

export function existingRoomContentNode(
  nodes: WhiteboardNode[],
  input: {
    whiteboardId: string;
    linkedEntityType?: LinkedEntityType;
    linkedEntityId?: string;
    startTime?: number;
  },
): WhiteboardNode | undefined {
  if (!input.linkedEntityType || !input.linkedEntityId) return undefined;
  return nodes.find((node) => {
    if (node.deletedAt) return false;
    if (node.whiteboardId !== input.whiteboardId) return false;
    if (node.nodeType !== "room_content") return false;
    if (node.linkedEntityType !== input.linkedEntityType || node.linkedEntityId !== input.linkedEntityId) return false;
    if (input.startTime != null) {
      const nodeStart = Number(node.content.startTime);
      if (!Number.isFinite(nodeStart) || Math.abs(nodeStart - input.startTime) > 0.5) return false;
    }
    return true;
  });
}

function resolveVersion(
  room: Pick<Room, "versions">,
  payload: DiscussionPayload,
): Version | undefined {
  if (payload.versionId) return room.versions?.find((version) => version.id === payload.versionId);
  if (!payload.branchId) return undefined;
  const onBranch = (room.versions ?? []).filter((version) => version.branchId === payload.branchId && !version.archivedAt);
  const withMedia = [...onBranch].reverse().find((version) => version.imageDataUrl?.trim() || version.videoUrl?.trim());
  return withMedia ?? onBranch[onBranch.length - 1];
}

function inferMediaKind(message: DiscussionMessage, version?: Version): RoomContentKind {
  if (message.kind === "plan" || message.payload.planSectionId) return "plan";
  if (message.kind === "video" || version?.kind === "video" || message.payload.startTime != null) return "video";
  if (message.kind === "poster" || version?.kind === "image") return "poster";
  return "poster";
}

export type PlaceFromDiscussionResult = {
  node: WhiteboardNode;
  created: boolean;
};

export function placeRoomContentFromDiscussion(
  message: DiscussionMessage,
  whiteboardId: string,
  createdBy: string,
  room: Pick<Room, "versions" | "branches" | "plans">,
  existing: WhiteboardNode[] = [],
  position?: { x?: number; y?: number },
): PlaceFromDiscussionResult {
  const payload = message.payload ?? {};
  const version = resolveVersion(room, payload);
  const branchId = payload.branchId || version?.branchId;
  const branch = branchId ? room.branches?.find((item) => item.id === branchId) : undefined;
  const kind = inferMediaKind(message, version);

  let linkedEntityType: LinkedEntityType;
  let linkedEntityId: string;
  if (kind === "plan" && branchId) {
    linkedEntityType = "plan";
    linkedEntityId = branchId;
  } else if (branchId && (kind === "poster" || kind === "video")) {
    linkedEntityType = "branch";
    linkedEntityId = branchId;
  } else if (version?.id) {
    linkedEntityType = "version";
    linkedEntityId = version.id;
  } else if (branchId) {
    linkedEntityType = "branch";
    linkedEntityId = branchId;
  } else {
    const sticky = stickyFromDiscussion(message, whiteboardId, createdBy, position);
    const already = existing.find((node) =>
      !node.deletedAt && node.whiteboardId === whiteboardId
      && node.linkedEntityType === "discussion" && node.linkedEntityId === message.id,
    );
    return already ? { node: already, created: false } : { node: sticky, created: true };
  }

  const startTime = kind === "video" ? payload.startTime : undefined;
  const already = existingRoomContentNode(existing, {
    whiteboardId,
    linkedEntityType,
    linkedEntityId,
    startTime,
  }) ?? (version?.id
    ? existingRoomContentNode(existing, {
        whiteboardId,
        linkedEntityType: "version",
        linkedEntityId: version.id,
        startTime,
      }) ?? existing.find((node) =>
        !node.deletedAt
        && node.whiteboardId === whiteboardId
        && node.nodeType === "room_content"
        && node.sourceVersionId === version.id
        && (startTime == null || Math.abs(Number(node.content.startTime) - startTime) <= 0.5),
      )
    : undefined);
  if (already) return { node: already, created: false };

  const plan = branchId ? room.plans?.find((item) => item.branchId === branchId) : undefined;
  const section = payload.planSectionId
    ? plan?.blocks.find((block) => block.id === payload.planSectionId)
    : undefined;
  const planExtra = kind === "plan" && branchId
    ? nodeFromPlanSection({
        branchId,
        section: section ? { id: section.id, text: section.text } : undefined,
      })
    : null;

  const content: NodeContent = {
    title: payload.title || branch?.name || version?.label || message.body,
    mediaKind: kind,
    versionLabel: version?.label,
    ...boardMediaFromVersion(version),
    startTime: payload.startTime,
    endTime: payload.endTime,
    duration: version?.duration,
    subtitle: planExtra?.subtitle ?? (kind === "plan" ? plan?.title : undefined),
    sourceLabel: `討論 · ${message.authorName || "成員"}`,
  };
  const size = boardMediaSize(kind, version);
  const node = createNode({
    whiteboardId,
    roomId: message.roomId,
    nodeType: "room_content",
    createdBy,
    x: position?.x,
    y: position?.y,
    content,
    linkedEntityType,
    linkedEntityId,
  });
  node.width = size.width;
  node.height = size.height;
  node.anchor = {
    ...(planExtra?.anchor ?? { type: "message", messageId: message.id }),
    messageId: message.id,
  };
  if (kind === "poster" && version?.id) node.sourceVersionId = version.id;
  else if (planExtra) {
    /* plan-section lives on anchor; message provenance is messageId on the same jsonb */
  }
  return { node: hydrateBoardMedia(node, version), created: true };
}

export function placeFromDiscussion(
  message: DiscussionMessage,
  whiteboardId: string,
  createdBy: string,
  room: Pick<Room, "versions" | "branches" | "plans">,
  existing: WhiteboardNode[] = [],
  position?: { x?: number; y?: number },
): PlaceFromDiscussionResult {
  if (!discussionPlacesAsRoomContent(message)) {
    const already = existing.find((node) =>
      !node.deletedAt && node.whiteboardId === whiteboardId
      && node.linkedEntityType === "discussion" && node.linkedEntityId === message.id,
    );
    if (already) return { node: already, created: false };
    return { node: stickyFromDiscussion(message, whiteboardId, createdBy, position), created: true };
  }
  return placeRoomContentFromDiscussion(message, whiteboardId, createdBy, room, existing, position);
}
