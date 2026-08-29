/**
 * RLS can "succeed" an asset_human_metadata UPSERT with zero rows.
 * App.tsx then toasts「已保存人工素材標記」. A missing asset_id is not saved.
 */
export function acceptHumanAssetMetadataAck(data: unknown): { assetId: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw Object.assign(new Error("METADATA_NOT_SAVED"), { code: "METADATA_NOT_SAVED" });
  }
  const raw = (data as { asset_id?: unknown }).asset_id;
  const assetId = typeof raw === "string" ? raw.trim() : "";
  if (!assetId) {
    throw Object.assign(new Error("METADATA_NOT_SAVED"), { code: "METADATA_NOT_SAVED" });
  }
  return { assetId };
}
