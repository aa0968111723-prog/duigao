/**
 * 白板焦點：選節點 = 開焦點，不是只亮框。
 * 房間焦點與本機選取分開；session 活在模組層，切對話／白板不丟。
 */
import { formatVideoRange } from "../collaboration/nodes";
import type { WhiteboardNode } from "../collaboration/types";
import type { Camera } from "./canvas";
import type { BoardAiPreview } from "./aiPreview";

export type FocusSource = "discussion" | "version" | "schedule" | "none";

export type BoardFocusCard = {
  nodeId: string;
  title: string;
  source: FocusSource;
  sourceLabel: string;
  openCommentCount: number;
  lastWriter: string | null;
};

export type BoardSession = {
  camera: Camera | null;
  selection: string[];
  roomFocusId: string | null;
  pendingPreview: BoardAiPreview | null;
};

export const EMPTY_BOARD_VERBS = [
  { id: "pin-discussion", label: "從對話把一句話釘上來" },
  { id: "add-asset", label: "放一張文宣／素材" },
  { id: "ask-grok", label: "問 Grok「我們下一步做什麼」" },
] as const;

export const DEFAULT_CAMERA: Camera = { x: 24, y: 24, zoom: 1 };

const SESSION = new Map<string, BoardSession>();

export function emptyBoardVerbs(): readonly { id: string; label: string }[] {
  return EMPTY_BOARD_VERBS;
}

export function emptyBoardCopyHasLonelyStep(copy: string): boolean {
  return copy.includes("新步驟") && !EMPTY_BOARD_VERBS.some((verb) => copy.includes(verb.label));
}

export function emptyRoomTitle(title: string | undefined | null): { label: string; unnamed: boolean } {
  const trimmed = (title ?? "").trim();
  if (!trimmed || trimmed === "未命名活動房") {
    return { label: trimmed || "未命名活動房", unnamed: true };
  }
  return { label: trimmed, unnamed: false };
}

export function focusNodeIdFromSelection(selected: string[]): string | null {
  return selected[0] ?? null;
}

export function liveBoardNodes(nodes: WhiteboardNode[]): WhiteboardNode[] {
  return nodes.filter((node) => !node.deletedAt);
}

export function isEmptyBoard(nodes: WhiteboardNode[]): boolean {
  return liveBoardNodes(nodes).length === 0;
}

export function nodeFocusSource(node: Pick<WhiteboardNode, "linkedEntityType" | "anchor">): FocusSource {
  if (node.linkedEntityType === "discussion") return "discussion";
  if (node.linkedEntityType === "version" || node.linkedEntityType === "branch" || node.linkedEntityType === "plan") return "version";
  if (node.linkedEntityType === "calendar") return "schedule";
  const anchorType = typeof node.anchor?.type === "string" ? node.anchor.type : "";
  if (anchorType === "message" || anchorType === "discussion") return "discussion";
  if (anchorType === "image-region" || anchorType === "plan-section") return "version";
  if (anchorType === "schedule" || anchorType === "calendar") return "schedule";
  return "none";
}

export function focusSourceLabel(source: FocusSource): string {
  if (source === "discussion") return "討論";
  if (source === "version") return "文宣圈選／企劃";
  if (source === "schedule") return "時程";
  return "無來源";
}

export function discussionIdFromNode(
  node: Pick<WhiteboardNode, "linkedEntityType" | "linkedEntityId" | "anchor">,
): string | null {
  if (node.linkedEntityType === "discussion" && node.linkedEntityId) return node.linkedEntityId;
  const messageId = node.anchor?.messageId;
  if (typeof messageId === "string" && messageId) return messageId;
  return null;
}

function focusCardTitle(node: WhiteboardNode): string {
  const kind = node.content.mediaKind;
  const range = formatVideoRange(node.content.startTime, node.content.endTime);
  const text = (
    node.content.text
    || node.content.title
    || node.content.subtitle
    || node.content.versionLabel
    || node.content.sourceLabel
    || ""
  ).trim();
  if (kind === "video" && range) return (text ? `${text} · ${range}` : `影片 · ${range}`).slice(0, 80);
  if (text) return text.slice(0, 80);
  if (kind === "poster") return "文宣";
  if (kind === "video") return "影片";
  if (kind === "plan" || node.linkedEntityType === "plan") return "企劃";
  if (node.linkedEntityType === "version" || node.linkedEntityType === "branch") return "文宣";
  return "未命名卡片";
}

function focusCardSourceLabel(node: WhiteboardNode): string {
  const stamped = node.content.sourceLabel?.trim();
  if (stamped) return stamped;
  const kind = node.content.mediaKind;
  const subtitle = node.content.subtitle?.trim();
  const versionLabel = node.content.versionLabel?.trim();
  const range = formatVideoRange(node.content.startTime, node.content.endTime);
  const anchorType = typeof node.anchor?.type === "string" ? node.anchor.type : "";
  if (kind === "poster" || anchorType === "image-region") {
    if (anchorType === "image-region") return subtitle ? `文宣圈選 · ${subtitle}` : "文宣圈選";
    return versionLabel ? `文宣 · ${versionLabel}` : "文宣";
  }
  if (kind === "video") return range ? `影片 · ${range}` : "影片";
  if (kind === "plan" || node.linkedEntityType === "plan" || anchorType === "plan-section") {
    return subtitle ? `企劃 · ${subtitle}` : "企劃";
  }
  if (node.linkedEntityType === "discussion" || anchorType === "message") return "討論";
  if (node.linkedEntityType === "calendar") return "時程";
  if (node.linkedEntityType || node.sourceVersionId || node.anchor) {
    if (node.linkedEntityType === "version" || node.linkedEntityType === "branch") {
      return versionLabel ? `文宣 · ${versionLabel}` : "文宣";
    }
    return focusSourceLabel(nodeFocusSource(node));
  }
  return "無來源";
}

export function focusCardFromNode(node: WhiteboardNode): BoardFocusCard {
  const source = nodeFocusSource(node);
  return {
    nodeId: node.id,
    title: focusCardTitle(node),
    source,
    sourceLabel: focusCardSourceLabel(node),
    openCommentCount: Math.max(0, node.content.openCommentCount ?? 0),
    lastWriter: node.content.lastWriterName?.trim() || null,
  };
}

/** 平板 rail：與 useIsTabletUp / whiteboard.css 同源（900×600）。 */
export function shouldInlineDiscussionRail(input: {
  width: number;
  height?: number;
  collapsed?: boolean;
}): boolean {
  return input.width >= 900 && (input.height ?? 800) >= 600 && !input.collapsed;
}

export function shouldMountFocusSheet(input: {
  width: number;
  height?: number;
  hasFocus: boolean;
  railCollapsed?: boolean;
}): boolean {
  const rail = shouldInlineDiscussionRail({
    width: input.width,
    height: input.height,
    collapsed: input.railCollapsed,
  });
  return input.hasFocus && !rail;
}

export function readBoardSession(key: string): BoardSession | undefined {
  return SESSION.get(key);
}

export function writeBoardSession(key: string, patch: Partial<BoardSession>): BoardSession {
  const current = SESSION.get(key) ?? {
    camera: null,
    selection: [],
    roomFocusId: null,
    pendingPreview: null,
  };
  const next: BoardSession = {
    camera: patch.camera !== undefined ? patch.camera : current.camera,
    selection: patch.selection ?? current.selection,
    roomFocusId: patch.roomFocusId !== undefined ? patch.roomFocusId : current.roomFocusId,
    pendingPreview: patch.pendingPreview !== undefined ? patch.pendingPreview : current.pendingPreview,
  };
  SESSION.set(key, next);
  if (SESSION.size > 24) {
    const oldest = SESSION.keys().next().value;
    if (oldest !== undefined && oldest !== key) SESSION.delete(oldest);
  }
  return next;
}

export function clearBoardSession(key?: string): void {
  if (key) SESSION.delete(key);
  else SESSION.clear();
}

/** 重掛載：有房間焦點用它；否則用自己的 camera；不准假裝重設成預設視角。 */
export function cameraAfterRemount(input: {
  saved: Camera | null | undefined;
  roomFocus: { x: number; y: number; width: number; height: number } | null | undefined;
  focusCamera: (node: { x: number; y: number; width: number; height: number }) => Camera;
}): Camera | null {
  if (input.roomFocus) return input.focusCamera(input.roomFocus);
  if (input.saved) return input.saved;
  return null;
}

const VIDEO_POINT_TOLERANCE = 0.5;

function finiteTime(value: unknown): number | null {
  const time = Number(value);
  return Number.isFinite(time) && time >= 0 ? time : null;
}

function nodeSectionId(node: Pick<WhiteboardNode, "anchor">): string | undefined {
  const sectionId = node.anchor?.sectionId;
  return typeof sectionId === "string" && sectionId ? sectionId : undefined;
}

function videoTimesRelated(
  nodeStart: number,
  nodeEnd: number | null,
  messageStart: number,
  messageEnd: number | null,
): boolean {
  const nodeIsPoint = nodeEnd === null || nodeEnd <= nodeStart;
  const messageIsPoint = messageEnd === null || messageEnd <= messageStart;
  if (nodeIsPoint && messageIsPoint) {
    return Math.abs(messageStart - nodeStart) <= VIDEO_POINT_TOLERANCE;
  }
  const nodeStop = nodeIsPoint ? nodeStart : nodeEnd!;
  const messageStop = messageIsPoint ? messageStart : messageEnd!;
  if (messageIsPoint) return messageStart >= nodeStart && messageStart <= nodeStop;
  if (nodeIsPoint) return nodeStart >= messageStart && nodeStart <= messageStop;
  return messageStart <= nodeStop && messageStop >= nodeStart;
}

type FocusPayload = {
  nodeId?: string;
  messageId?: string;
  versionId?: string;
  branchId?: string;
  planSectionId?: string;
  startTime?: number;
  endTime?: number;
};

function versionMatchesFocus(
  node: Pick<WhiteboardNode, "linkedEntityType" | "linkedEntityId" | "sourceVersionId">,
  payload: FocusPayload,
): boolean {
  if (!payload.versionId) return false;
  if (node.linkedEntityType === "version" && payload.versionId === node.linkedEntityId) return true;
  return Boolean(node.sourceVersionId && payload.versionId === node.sourceVersionId);
}

function branchMatchesFocus(
  node: Pick<WhiteboardNode, "linkedEntityType" | "linkedEntityId">,
  payload: FocusPayload,
): boolean {
  return (node.linkedEntityType === "branch" || node.linkedEntityType === "plan")
    && Boolean(payload.branchId)
    && payload.branchId === node.linkedEntityId;
}

export function messagesForFocus<T extends { payload?: FocusPayload; id?: string }>(
  messages: T[],
  node: Pick<WhiteboardNode, "id" | "linkedEntityType" | "linkedEntityId" | "anchor" | "sourceVersionId" | "content"> | null,
): T[] {
  if (!node) return messages;
  const discussionId = discussionIdFromNode(node);
  const sectionId = nodeSectionId(node);
  const nodeStart = finiteTime(node.content?.startTime);
  const nodeEnd = finiteTime(node.content?.endTime);
  const timeScoped = nodeStart !== null;
  const sectionScoped = Boolean(sectionId);
  return messages.filter((message) => {
    const payload = message.payload ?? {};
    if (payload.nodeId === node.id) return true;
    if (discussionId && (message.id === discussionId || payload.messageId === discussionId)) return true;
    if (sectionScoped) return payload.planSectionId === sectionId;
    const messageStart = finiteTime(payload.startTime);
    const messageEnd = finiteTime(payload.endTime);
    if (timeScoped) {
      if (messageStart !== null) {
        const entityOk = versionMatchesFocus(node, payload)
          || branchMatchesFocus(node, payload)
          || (!payload.versionId && !payload.branchId);
        return entityOk && videoTimesRelated(nodeStart, nodeEnd, messageStart, messageEnd);
      }
      return versionMatchesFocus(node, payload);
    }
    if (versionMatchesFocus(node, payload)) return true;
    if (branchMatchesFocus(node, payload)) return true;
    return false;
  });
}

export function workLayerItemsFromNodes(nodes: WhiteboardNode[], limit = 12): Array<{
  id: string;
  type: string;
  text?: string;
  x: number;
  y: number;
}> {
  return liveBoardNodes(nodes).slice(0, limit).map((node) => ({
    id: node.id,
    type: node.nodeType,
    text: (node.content.text || node.content.title || "").slice(0, 160) || undefined,
    x: node.x,
    y: node.y,
  }));
}

/** 房間焦點：presence 上最新一筆不透明 nodeId（不含姓名）。 */
export function roomFocusFromPresence(
  people: Array<{ userId: string; focusNodeId?: string | null; at: number }>,
  opts?: { minAt?: number; ignoreUserId?: string },
): { nodeId: string; at: number } | null {
  let newest: { nodeId: string; at: number } | null = null;
  for (const person of people) {
    if (opts?.ignoreUserId && person.userId === opts.ignoreUserId) continue;
    const nodeId = person.focusNodeId?.trim();
    if (!nodeId) continue;
    if (opts?.minAt != null && person.at <= opts.minAt) continue;
    if (!newest || person.at >= newest.at) newest = { nodeId, at: person.at };
  }
  return newest;
}

export type BoardAskContext = {
  focus?: { label: string; nodeId?: string; nodeType?: string; source?: FocusSource; sourceLabel?: string };
  workLayer?: { proposalId: string; status: string; items: ReturnType<typeof workLayerItemsFromNodes> };
};

/** 問同事／房間 AI：焦點卡 + 板上可見節點短列。不含 Storage path。 */
export function boardAskContext(input: {
  nodes: WhiteboardNode[];
  focusNode?: WhiteboardNode | null;
}): BoardAskContext {
  const items = workLayerItemsFromNodes(input.nodes);
  const card = input.focusNode ? focusCardFromNode(input.focusNode) : undefined;
  return {
    focus: card && input.focusNode
      ? {
          label: card.title,
          nodeId: card.nodeId,
          nodeType: input.focusNode.nodeType,
          source: card.source,
          sourceLabel: card.sourceLabel,
        }
      : undefined,
    workLayer: items.length
      ? { proposalId: "board-visible", status: "visible", items }
      : undefined,
  };
}
