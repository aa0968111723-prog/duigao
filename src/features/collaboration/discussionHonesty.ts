/**
 * Discussion extras typed by 0014/0018/0022 plus 0031 tombstone / unread watermark.
 * Mentions, typing, todo, and receipts stay unmodeled.
 */
import type { DiscussionKind, DiscussionMessage, DiscussionPayload } from "./types";
import { replySnippet } from "./replies";

/** Insert + touch trigger can bump updated_at by a few hundred ms. */
export const EDIT_MARK_MS = 1500;

export function messageIsEdited(message: Pick<DiscussionMessage, "createdAt" | "updatedAt" | "payload">): boolean {
  if (message.payload?.edited === true) return true;
  return message.updatedAt - message.createdAt > EDIT_MARK_MS;
}

export function canEditDiscussion(
  message: Pick<DiscussionMessage, "authorId" | "kind" | "payload" | "deletedAt">,
  userId: string,
  sendState?: "sending" | "failed" | string,
): boolean {
  if (!userId || sendState === "sending" || sendState === "failed") return false;
  if (message.deletedAt) return false;
  if (message.payload.legacy) return false;
  if (message.payload.agent === true) return false;
  if (message.payload.audit === true) return false;
  if (message.kind !== "text") return false;
  return message.authorId === userId;
}

export function messageIsTombstoned(message: Pick<DiscussionMessage, "deletedAt">): boolean {
  return Boolean(message.deletedAt);
}

/** Author or can_manage. Tombstone is UPDATE deleted_at, never a hard delete. */
export function canTombstoneDiscussion(
  message: Pick<DiscussionMessage, "authorId" | "deletedAt">,
  userId: string,
  canManage: boolean,
  sendState?: "sending" | "failed" | string,
): boolean {
  if (!userId || sendState === "sending" || sendState === "failed") return false;
  if (message.deletedAt) return false;
  return message.authorId === userId || canManage;
}

/** 0022 freezes room_id / author / created_at — this patch must not carry them. */
export function discussionTombstonePatch(): { deleted_at: string } {
  return { deleted_at: new Date().toISOString() };
}

export type DiscussionReadWatermark = {
  roomId: string;
  lastReadMessageId?: string;
  lastReadAt: number;
};

export function firstUnreadMessageId(
  messages: Pick<DiscussionMessage, "id" | "createdAt">[],
  watermark: { lastReadMessageId?: string; lastReadAt?: number } | null | undefined,
): string | null {
  const sorted = [...messages].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  if (!sorted.length) return null;
  if (!watermark) return sorted[0].id;
  if (watermark.lastReadMessageId) {
    const idx = sorted.findIndex((item) => item.id === watermark.lastReadMessageId);
    if (idx >= 0) return sorted[idx + 1]?.id ?? null;
  }
  if (watermark.lastReadAt) {
    return sorted.find((item) => item.createdAt > watermark.lastReadAt!)?.id ?? null;
  }
  return sorted[0].id;
}

export function unreadCount(
  messages: Pick<DiscussionMessage, "id" | "createdAt">[],
  watermark: { lastReadMessageId?: string; lastReadAt?: number } | null | undefined,
): number {
  const first = firstUnreadMessageId(messages, watermark);
  if (!first) return 0;
  const sorted = [...messages].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const idx = sorted.findIndex((item) => item.id === first);
  return idx < 0 ? 0 : sorted.length - idx;
}

/**
 * Bound-room unread is a cloud watermark. A failed write (missing
 * room_discussion_reads, RLS, network) must not hide jump-first-unread.
 */
export function applyReadWatermarkAfterCloudAck<T>(next: T, ok: boolean): T | null {
  if (!ok) return null;
  return next;
}

/** Watermark only moves forward along createdAt. */
export function nextReadWatermark(
  current: DiscussionReadWatermark | null | undefined,
  message: Pick<DiscussionMessage, "id" | "roomId" | "createdAt">,
): DiscussionReadWatermark {
  if (current && current.roomId === message.roomId) {
    if (current.lastReadAt > message.createdAt) return current;
    if (current.lastReadAt === message.createdAt && current.lastReadMessageId && current.lastReadMessageId > message.id) {
      return current;
    }
  }
  return {
    roomId: message.roomId,
    lastReadMessageId: message.id,
    lastReadAt: message.createdAt,
  };
}

/** 0022: body may change; author / room / created_at must not travel in the patch. */
export function discussionEditPatch(body: string): { body: string } | null {
  const next = body.replace(/\s+/g, " ").trim();
  if (!next) return null;
  return { body: next.slice(0, 4000) };
}

export function isMemberActor(
  actor:
    | string
    | undefined
    | null
    | { authorId?: string; authorName?: string; payload?: { agent?: boolean } },
): boolean {
  if (!actor) return false;
  if (typeof actor === "object") {
    if (actor.payload?.agent === true) return false;
    if (actor.authorName === "Grok") {
      const id = (actor.authorId ?? "").trim().toLowerCase();
      if (!id || id === "ai" || id === "agent" || id.startsWith("ai-") || id.startsWith("agent-") || id.startsWith("model-")) {
        return false;
      }
    }
    return isMemberActor(actor.authorId);
  }
  const id = actor.trim().toLowerCase();
  if (!id) return false;
  if (id === "ai" || id === "system" || id === "agent") return false;
  if (id.startsWith("ai-") || id.startsWith("agent-") || id.startsWith("model-")) return false;
  return true;
}

export function decisionDraftTitle(raw: string): string | null {
  const title = raw.replace(/\s+/g, " ").trim().slice(0, 240);
  return title.length ? title : null;
}

/** Board 「寫下決策」uses the same title rule. Empty / canned UI is not a decision. */
export function boardDecisionWrite(raw: string): { title: string; status: "decided" } | null {
  const title = decisionDraftTitle(raw);
  if (!title) return null;
  return { title, status: "decided" };
}

/** 0013: question 1–240, options array length 2–6. Empty question is not a poll. */
export function boardPollWrite(questionRaw: string, optionRaws: string[]): { question: string; options: string[] } | null {
  const question = decisionDraftTitle(questionRaw);
  if (!question) return null;
  const options = optionRaws.map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 6);
  if (options.length < 2) return null;
  return { question, options };
}

export type WorkCite = {
  kind: Extract<DiscussionKind, "poster" | "video" | "plan" | "whiteboard">;
  body: string;
  payload: DiscussionPayload;
};

export function workCiteFromBranch(branch: { id: string; name: string; branchType: string }): WorkCite | null {
  if (branch.branchType === "poster" || branch.branchType === "video" || branch.branchType === "plan") {
    return {
      kind: branch.branchType,
      body: branch.name,
      payload: { branchId: branch.id, title: branch.name },
    };
  }
  return null;
}

export function workCiteFromBoard(board: { id: string; title: string }): WorkCite {
  return {
    kind: "whiteboard",
    body: board.title,
    payload: { whiteboardId: board.id, title: board.title },
  };
}

/** Cite an existing attachment card by reply_to_id — no new table. */
export function attachmentCiteReply(
  message: Pick<DiscussionMessage, "id" | "kind" | "body" | "payload">,
): { replyToId: string; quotedBody: string } | null {
  if (message.kind !== "attachment") return null;
  return { replyToId: message.id, quotedBody: replySnippet(message) };
}
