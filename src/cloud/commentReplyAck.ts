/**
 * RLS can "succeed" a comment_replies INSERT with zero rows.
 * App then keeps the reply locally, so the thread looks posted.
 */
export function acceptReplyInsertAck(data: unknown): { id: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw Object.assign(new Error("REPLY_NOT_SAVED"), { code: "REPLY_NOT_SAVED" });
  }
  const raw = (data as { id?: unknown }).id;
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id) {
    throw Object.assign(new Error("REPLY_NOT_SAVED"), { code: "REPLY_NOT_SAVED" });
  }
  return { id };
}

export function isReplyNotSaved(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "REPLY_NOT_SAVED");
}
