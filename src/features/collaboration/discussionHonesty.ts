/**
 * Discussion extras that already have columns/kinds (0014/0018/0022).
 * No mention / unread / receipt / todo / deleted_at — those stay unmodeled.
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
  message: Pick<DiscussionMessage, "authorId" | "kind" | "payload">,
  userId: string,
  sendState?: "sending" | "failed" | string,
): boolean {
  if (!userId || sendState === "sending" || sendState === "failed") return false;
  if (message.payload.legacy) return false;
  if (message.kind !== "text") return false;
  return message.authorId === userId;
}

/** 0022: body may change; author / room / created_at must not travel in the patch. */
export function discussionEditPatch(body: string): { body: string } | null {
  const next = body.replace(/\s+/g, " ").trim();
  if (!next) return null;
  return { body: next.slice(0, 4000) };
}

export function isMemberActor(actor: string | undefined | null): boolean {
  if (!actor) return false;
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
