/**
 * RLS can "succeed" a whiteboards INSERT with zero rows.
 * App then opens the board locally, so a cloud board looks created.
 */
export function acceptWhiteboardInsertAck(data: unknown): { id: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw Object.assign(new Error("WHITEBOARD_NOT_SAVED"), { code: "WHITEBOARD_NOT_SAVED" });
  }
  const raw = (data as { id?: unknown }).id;
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id) {
    throw Object.assign(new Error("WHITEBOARD_NOT_SAVED"), { code: "WHITEBOARD_NOT_SAVED" });
  }
  return { id };
}

export function isWhiteboardNotSaved(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "WHITEBOARD_NOT_SAVED");
}
