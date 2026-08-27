import { createSticky } from "./nodes";
import type { DiscussionMessage, DiscussionPayload, WhiteboardNode } from "./types";

/** Board → discussion: only ids + label, never media bytes. */
export function discussionPayloadFromNode(node: WhiteboardNode, boardTitle?: string): DiscussionPayload {
  const label = node.content.text || node.content.title || "節點";
  return {
    whiteboardId: node.whiteboardId,
    nodeId: node.id,
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
