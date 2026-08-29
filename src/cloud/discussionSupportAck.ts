/**
 * RLS can "succeed" a room_discussion_supports UPSERT/DELETE with zero rows.
 * App then toggles 支持 locally, so the count looks saved.
 */
export function acceptDiscSupportUpsertAck(data: unknown): { messageId: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw Object.assign(new Error("DISC_SUPPORT_NOT_SAVED"), { code: "DISC_SUPPORT_NOT_SAVED" });
  }
  const raw = (data as { message_id?: unknown }).message_id;
  const messageId = typeof raw === "string" ? raw.trim() : "";
  if (!messageId) {
    throw Object.assign(new Error("DISC_SUPPORT_NOT_SAVED"), { code: "DISC_SUPPORT_NOT_SAVED" });
  }
  return { messageId };
}

export function acceptDiscSupportDeleteAck(data: unknown): { messageId: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw Object.assign(new Error("DISC_SUPPORT_NOT_REMOVED"), { code: "DISC_SUPPORT_NOT_REMOVED" });
  }
  const raw = (data as { message_id?: unknown }).message_id;
  const messageId = typeof raw === "string" ? raw.trim() : "";
  if (!messageId) {
    throw Object.assign(new Error("DISC_SUPPORT_NOT_REMOVED"), { code: "DISC_SUPPORT_NOT_REMOVED" });
  }
  return { messageId };
}

export function isDiscSupportNotSaved(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "DISC_SUPPORT_NOT_SAVED");
}

export function isDiscSupportNotRemoved(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "DISC_SUPPORT_NOT_REMOVED");
}
