/**
 * RLS can "succeed" a content_relations INSERT/DELETE with zero rows.
 * App then adds or removes the related-content chip locally, so it looks saved.
 */
export function acceptRelationInsertAck(data: unknown): { id: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw Object.assign(new Error("RELATION_NOT_SAVED"), { code: "RELATION_NOT_SAVED" });
  }
  const raw = (data as { id?: unknown }).id;
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id) {
    throw Object.assign(new Error("RELATION_NOT_SAVED"), { code: "RELATION_NOT_SAVED" });
  }
  return { id };
}

export function acceptRelationDeleteAck(data: unknown): { id: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw Object.assign(new Error("RELATION_NOT_REMOVED"), { code: "RELATION_NOT_REMOVED" });
  }
  const raw = (data as { id?: unknown }).id;
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id) {
    throw Object.assign(new Error("RELATION_NOT_REMOVED"), { code: "RELATION_NOT_REMOVED" });
  }
  return { id };
}

export function isRelationNotSaved(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "RELATION_NOT_SAVED");
}

export function isRelationNotRemoved(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "RELATION_NOT_REMOVED");
}
