/**
 * RLS can "succeed" a room_branches UPDATE with zero rows.
 * App then keeps the typed branch name locally, so the field looks saved.
 */
export function acceptBranchUpdateAck(data: unknown): { id: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw Object.assign(new Error("BRANCH_NOT_SAVED"), { code: "BRANCH_NOT_SAVED" });
  }
  const raw = (data as { id?: unknown }).id;
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id) {
    throw Object.assign(new Error("BRANCH_NOT_SAVED"), { code: "BRANCH_NOT_SAVED" });
  }
  return { id };
}

export function isBranchNotSaved(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "BRANCH_NOT_SAVED");
}
