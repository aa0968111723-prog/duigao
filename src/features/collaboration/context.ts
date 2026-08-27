/**
 * Thin AI / Asset Intelligence boundary.
 *
 * This module only projects board facts. It does not generate text, embeddings,
 * asset analysis, room-context AI, or tku-zen-agent calls. A future AI line
 * consumes these shapes and may place answers as `ai_result` nodes.
 */
import type {
  DiscussionContext,
  DiscussionMessage,
  DecisionRecord,
  SelectionContext,
  Whiteboard,
  WhiteboardContext,
  WhiteboardEdge,
  WhiteboardNode,
} from "./types";

export function getWhiteboardContext(
  whiteboard: Whiteboard,
  nodes: WhiteboardNode[],
  edges: WhiteboardEdge[],
): WhiteboardContext {
  const boardNodes = nodes.filter((node) => node.whiteboardId === whiteboard.id);
  const boardEdges = edges.filter((edge) => edge.whiteboardId === whiteboard.id);
  return {
    whiteboard: {
      id: whiteboard.id,
      roomId: whiteboard.roomId,
      title: whiteboard.title,
      description: whiteboard.description,
      archivedAt: whiteboard.archivedAt,
      updatedAt: whiteboard.updatedAt,
    },
    nodes: boardNodes.map((node) => ({
      id: node.id,
      nodeType: node.nodeType,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      content: node.content,
      linkedEntityType: node.linkedEntityType,
      linkedEntityId: node.linkedEntityId,
    })),
    edges: boardEdges.map((edge) => ({
      id: edge.id,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
      edgeType: edge.edgeType,
      label: edge.label,
    })),
    linkedEntities: boardNodes
      .filter((node) => node.linkedEntityType && node.linkedEntityId)
      .map((node) => ({
        nodeId: node.id,
        entityType: node.linkedEntityType!,
        entityId: node.linkedEntityId!,
      })),
  };
}

export function getSelectedBoardContext(
  whiteboardId: string,
  roomId: string,
  nodes: WhiteboardNode[],
  nodeIds: string[],
): SelectionContext {
  const wanted = new Set(nodeIds);
  return {
    whiteboardId,
    roomId,
    nodes: nodes
      .filter((node) => node.whiteboardId === whiteboardId && wanted.has(node.id))
      .map((node) => ({
        id: node.id,
        nodeType: node.nodeType,
        content: node.content,
        linkedEntityType: node.linkedEntityType,
        linkedEntityId: node.linkedEntityId,
      })),
  };
}

export function buildDiscussionContext(
  roomId: string,
  messages: DiscussionMessage[],
  decisions: DecisionRecord[],
): DiscussionContext {
  return {
    roomId,
    messages: messages.filter((message) => message.roomId === roomId),
    decisions: decisions.filter((decision) => decision.roomId === roomId),
  };
}

/** Reserved: future AI answers land as ai_result nodes. This file never creates model output. */
export const RESERVED_AI_NODE_TYPE = "ai_result" as const;
