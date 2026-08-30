import { createNode } from "../collaboration/nodes";
import type { DiscussionMessage, WhiteboardNode } from "../collaboration/types";
import { createScheduleEvent } from "./events";
import type { ScheduleEvent, ScheduleEventType } from "./types";

export function eventFromDiscussion(
  message: DiscussionMessage,
  createdBy: string,
  startAt: number,
  eventType: ScheduleEventType = "task",
): ScheduleEvent {
  return createScheduleEvent({
    roomId: message.roomId,
    createdBy,
    title: (message.body || message.payload.title || "討論事項").slice(0, 240),
    description: message.body,
    startAt,
    eventType,
    sourceType: "discussion",
    sourceId: message.id,
  });
}

export function eventFromBoardNode(
  node: WhiteboardNode,
  createdBy: string,
  startAt: number,
  eventType: ScheduleEventType = "board_due",
): ScheduleEvent {
  return createScheduleEvent({
    roomId: node.roomId,
    createdBy,
    title: (node.content.title || node.content.text || "白板節點").slice(0, 240),
    startAt,
    eventType,
    sourceType: "whiteboard_node",
    sourceId: node.id,
  });
}

export function nodeFromScheduleEvent(
  event: ScheduleEvent,
  whiteboardId: string,
  createdBy: string,
  position?: { x?: number; y?: number },
): WhiteboardNode {
  const node = createNode({
    whiteboardId,
    roomId: event.roomId,
    createdBy,
    nodeType: event.eventType === "task" || event.eventType === "deadline" ? "task" : "calendar_event",
    x: position?.x,
    y: position?.y,
    content: {
      title: event.title,
      text: event.description || event.title,
      sourceLabel: "時程",
    },
    linkedEntityType: "calendar",
    linkedEntityId: event.id,
  });
  return node;
}

export function sourceOpenTarget(event: ScheduleEvent):
  | { surface: "discussion"; messageId: string }
  | { surface: "board"; nodeId: string }
  | { surface: "none" } {
  if (event.sourceType === "discussion" && event.sourceId) {
    return { surface: "discussion", messageId: event.sourceId };
  }
  if (event.sourceType === "whiteboard_node" && event.sourceId) {
    return { surface: "board", nodeId: event.sourceId };
  }
  return { surface: "none" };
}

export function applyDeadlineToNode(node: WhiteboardNode, startAt: number): WhiteboardNode {
  return {
    ...node,
    content: {
      ...node.content,
      subtitle: `期限 ${new Intl.DateTimeFormat("zh-Hant", { month: "numeric", day: "numeric" }).format(new Date(startAt))}`,
    },
    updatedAt: Date.now(),
    version: node.version + 1,
  };
}
