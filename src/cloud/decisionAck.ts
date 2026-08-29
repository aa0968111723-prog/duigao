/**
 * RLS can "succeed" a decision_records INSERT with zero rows.
 * App then shows a 待決定 card locally, so the record looks created.
 */
export function acceptDecisionInsertAck(data: unknown): { id: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw Object.assign(new Error("DECISION_NOT_SAVED"), { code: "DECISION_NOT_SAVED" });
  }
  const raw = (data as { id?: unknown }).id;
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id) {
    throw Object.assign(new Error("DECISION_NOT_SAVED"), { code: "DECISION_NOT_SAVED" });
  }
  return { id };
}

export function isDecisionNotSaved(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "DECISION_NOT_SAVED");
}
