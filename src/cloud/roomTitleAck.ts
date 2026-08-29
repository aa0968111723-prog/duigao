/**
 * RLS can "succeed" a rooms.title UPDATE with zero rows.
 * App then keeps the typed name locally, so the field looks saved.
 */
export function acceptRoomTitleAck(data: unknown): { id: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw Object.assign(new Error("TITLE_NOT_SAVED"), { code: "TITLE_NOT_SAVED" });
  }
  const raw = (data as { id?: unknown }).id;
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id) {
    throw Object.assign(new Error("TITLE_NOT_SAVED"), { code: "TITLE_NOT_SAVED" });
  }
  return { id };
}

export function isTitleNotSaved(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "TITLE_NOT_SAVED");
}
