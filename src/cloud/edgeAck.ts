/**
 * RLS can "succeed" a whiteboard_edges INSERT with zero rows.
 * App then draws the line locally, so the edge looks created.
 */
export function acceptEdgeInsertAck(data: unknown): { id: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw Object.assign(new Error("EDGE_NOT_SAVED"), { code: "EDGE_NOT_SAVED" });
  }
  const raw = (data as { id?: unknown }).id;
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id) {
    throw Object.assign(new Error("EDGE_NOT_SAVED"), { code: "EDGE_NOT_SAVED" });
  }
  return { id };
}

export function isEdgeNotSaved(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "EDGE_NOT_SAVED");
}
