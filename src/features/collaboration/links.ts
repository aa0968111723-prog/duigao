import { anchorToDiscussionPayload } from "../../lib/contextAnchor";
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
  return createSticky({
    whiteboardId,
    roomId: message.roomId,
    createdBy,
    text: message.body,
    x: position?.x,
    y: position?.y,
  });
}
