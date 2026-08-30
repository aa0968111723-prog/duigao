/**
 * RLS can "succeed" a plan_documents UPSERT with zero rows.
 * App then keeps the typed plan locally, so the editor looks saved.
 */
export function acceptPlanUpsertAck(data: unknown): { branchId: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw Object.assign(new Error("PLAN_NOT_SAVED"), { code: "PLAN_NOT_SAVED" });
  }
  const raw = (data as { branch_id?: unknown }).branch_id;
  const branchId = typeof raw === "string" ? raw.trim() : "";
  if (!branchId) {
    throw Object.assign(new Error("PLAN_NOT_SAVED"), { code: "PLAN_NOT_SAVED" });
  }
  return { branchId };
}

export function isPlanNotSaved(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "PLAN_NOT_SAVED");
}
