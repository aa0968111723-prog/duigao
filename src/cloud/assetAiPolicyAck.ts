/**
 * RLS can "succeed" an intelligent_assets UPDATE with zero rows.
 * App.tsx then toasts「已開啟素材 AI 理解」. A missing id is not applied.
 */
export function acceptAssetAiPolicyAck(data: unknown): { id: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw Object.assign(new Error("POLICY_NOT_APPLIED"), { code: "POLICY_NOT_APPLIED" });
  }
  const id = typeof (data as { id?: unknown }).id === "string" ? (data as { id: string }).id.trim() : "";
  if (!id) {
    throw Object.assign(new Error("POLICY_NOT_APPLIED"), { code: "POLICY_NOT_APPLIED" });
  }
  return { id };
}
