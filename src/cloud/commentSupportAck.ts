/**
 * RLS can "succeed" a comment_supports UPSERT/DELETE with zero rows.
 * App then toggles "我也覺得" locally, so the count looks saved.
 */
export function acceptSupportUpsertAck(data: unknown): { commentId: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw Object.assign(new Error("SUPPORT_NOT_SAVED"), { code: "SUPPORT_NOT_SAVED" });
  }
  const raw = (data as { comment_id?: unknown }).comment_id;
  const commentId = typeof raw === "string" ? raw.trim() : "";
  if (!commentId) {
    throw Object.assign(new Error("SUPPORT_NOT_SAVED"), { code: "SUPPORT_NOT_SAVED" });
  }
  return { commentId };
}

export function acceptSupportDeleteAck(data: unknown): { commentId: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw Object.assign(new Error("SUPPORT_NOT_REMOVED"), { code: "SUPPORT_NOT_REMOVED" });
  }
  const raw = (data as { comment_id?: unknown }).comment_id;
  const commentId = typeof raw === "string" ? raw.trim() : "";
  if (!commentId) {
    throw Object.assign(new Error("SUPPORT_NOT_REMOVED"), { code: "SUPPORT_NOT_REMOVED" });
  }
  return { commentId };
}

export function isSupportNotSaved(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "SUPPORT_NOT_SAVED");
}

export function isSupportNotRemoved(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "SUPPORT_NOT_REMOVED");
}
