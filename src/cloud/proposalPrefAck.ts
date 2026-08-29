/**
 * RLS can "succeed" a proposal_preferences UPSERT/DELETE with zero rows.
 * App then keeps the version take locally, so the choice looks saved.
 */
export function acceptPrefUpsertAck(data: unknown): { versionId: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw Object.assign(new Error("PREF_NOT_SAVED"), { code: "PREF_NOT_SAVED" });
  }
  const raw = (data as { version_id?: unknown }).version_id;
  const versionId = typeof raw === "string" ? raw.trim() : "";
  if (!versionId) {
    throw Object.assign(new Error("PREF_NOT_SAVED"), { code: "PREF_NOT_SAVED" });
  }
  return { versionId };
}

export function acceptPrefDeleteAck(data: unknown): { versionId: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw Object.assign(new Error("PREF_NOT_REMOVED"), { code: "PREF_NOT_REMOVED" });
  }
  const raw = (data as { version_id?: unknown }).version_id;
  const versionId = typeof raw === "string" ? raw.trim() : "";
  if (!versionId) {
    throw Object.assign(new Error("PREF_NOT_REMOVED"), { code: "PREF_NOT_REMOVED" });
  }
  return { versionId };
}

export function isPrefNotSaved(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "PREF_NOT_SAVED");
}

export function isPrefNotRemoved(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "PREF_NOT_REMOVED");
}
