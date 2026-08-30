/**
 * RLS can "succeed" a share_previews disable UPDATE with zero rows.
 * rotateRoomPreview would then mint a new id and App.tsx would toast
 * 「已重新產生預覽連結」while the old preview stays enabled.
 */
export function acceptSharePreviewDisableAck(data: unknown): { id: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw Object.assign(new Error("PREVIEW_NOT_REVOKED"), { code: "PREVIEW_NOT_REVOKED" });
  }
  const raw = (data as { id?: unknown }).id;
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id) {
    throw Object.assign(new Error("PREVIEW_NOT_REVOKED"), { code: "PREVIEW_NOT_REVOKED" });
  }
  return { id };
}
