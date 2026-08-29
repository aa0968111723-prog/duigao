/**
 * RLS can "succeed" a versions INSERT with zero rows.
 * App then keeps a 文宣／影片 version locally, so the cut looks created.
 */
export function acceptVersionInsertAck(data: unknown): { id: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw Object.assign(new Error("VERSION_NOT_SAVED"), { code: "VERSION_NOT_SAVED" });
  }
  const raw = (data as { id?: unknown }).id;
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id) {
    throw Object.assign(new Error("VERSION_NOT_SAVED"), { code: "VERSION_NOT_SAVED" });
  }
  return { id };
}

export function isVersionNotSaved(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "VERSION_NOT_SAVED");
}
