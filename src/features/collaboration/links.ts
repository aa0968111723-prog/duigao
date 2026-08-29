import { anchorToDiscussionPayload, anchorToNodeLink } from "../../lib/contextAnchor";
import { createSticky } from "./nodes";
import type { DiscussionMessage, DiscussionPayload, WhiteboardNode } from "./types";

/** Board → discussion: only ids + label, never media bytes. */
export function discussionPayloadFromNode(node: WhiteboardNode, boardTitle?: string): DiscussionPayload {
  const label = node.content.text || node.content.title || "節點";
  return {
    // 參照欄位走 ContextAnchor 契約層（PR-02d）；label 是呈現，留在呼叫端。
    ...anchorToDiscussionPayload({ type: "board-node", whiteboardId: node.whiteboardId, nodeId: node.id }),
    title: boardTitle ? `${boardTitle} · ${label}` : label,
  };
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
