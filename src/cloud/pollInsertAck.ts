/**
 * RLS can "succeed" a room_polls INSERT with zero rows.
 * App then keeps the new decision card locally, so it looks created.
 */
export function acceptPollInsertAck(data: unknown): { id: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw Object.assign(new Error("POLL_NOT_SAVED"), { code: "POLL_NOT_SAVED" });
  }
  const raw = (data as { id?: unknown }).id;
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id) {
    throw Object.assign(new Error("POLL_NOT_SAVED"), { code: "POLL_NOT_SAVED" });
  }
  return { id };
}

export function isPollNotSaved(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "POLL_NOT_SAVED");
}
