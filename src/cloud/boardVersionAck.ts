/**
 * RLS can "succeed" a whiteboard_versions INSERT with zero rows.
 * The snapshot sheet then says the moment was saved.
 */
export function acceptBoardVersionInsertAck(data: unknown): { id: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw Object.assign(new Error("BOARD_VERSION_NOT_SAVED"), { code: "BOARD_VERSION_NOT_SAVED" });
  }
  const raw = (data as { id?: unknown }).id;
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id) {
    throw Object.assign(new Error("BOARD_VERSION_NOT_SAVED"), { code: "BOARD_VERSION_NOT_SAVED" });
  }
  return { id };
}

export function isBoardVersionNotSaved(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "BOARD_VERSION_NOT_SAVED");
}
