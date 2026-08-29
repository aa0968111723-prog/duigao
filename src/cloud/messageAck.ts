/**
 * RLS can "succeed" a messages INSERT with zero rows.
 * App then keeps the chat locally, so the line looks posted.
 */
export function acceptMessageInsertAck(data: unknown): { id: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw Object.assign(new Error("MESSAGE_NOT_SAVED"), { code: "MESSAGE_NOT_SAVED" });
  }
  const raw = (data as { id?: unknown }).id;
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id) {
    throw Object.assign(new Error("MESSAGE_NOT_SAVED"), { code: "MESSAGE_NOT_SAVED" });
  }
  return { id };
}

export function isMessageNotSaved(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "MESSAGE_NOT_SAVED");
}
