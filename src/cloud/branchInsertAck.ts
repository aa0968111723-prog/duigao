/**
 * RLS can "succeed" a room_branches INSERT with zero rows.
 * App then keeps the new 內容 card locally, so the branch looks created.
 */
export function acceptBranchInsertAck(data: unknown): { id: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw Object.assign(new Error("BRANCH_NOT_CREATED"), { code: "BRANCH_NOT_CREATED" });
  }
  const raw = (data as { id?: unknown }).id;
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id) {
    throw Object.assign(new Error("BRANCH_NOT_CREATED"), { code: "BRANCH_NOT_CREATED" });
  }
  return { id };
}

export function isBranchNotCreated(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "BRANCH_NOT_CREATED");
}
