/**
 * asset-analysis returns `{ assetId, jobId, status }` (HTTP 202), not `{ ok: true }`.
 * SPA HTML / empty objects must not toast「已重新排入素材理解」。
 */
import { parseFunctionPayload } from "./apiResponse";

export function acceptAssetAnalysisPayload(data: unknown, contentType?: string | null): { jobId: string } {
  const parsed = parseFunctionPayload(data, { contentType });
  if (parsed.kind === "reject") {
    throw Object.assign(new Error(parsed.code), { code: parsed.code });
  }
  if (typeof parsed.value.error === "string" && parsed.value.error) {
    throw Object.assign(new Error(parsed.value.error), { code: parsed.value.error });
  }
  if (parsed.value.ok === false) {
    const code = typeof parsed.value.code === "string" ? parsed.value.code : "ANALYSIS_UNAVAILABLE";
    throw Object.assign(new Error(code), { code });
  }
  const jobId = typeof parsed.value.jobId === "string" ? parsed.value.jobId.trim() : "";
  if (!jobId) {
    throw Object.assign(new Error("INVALID_PAYLOAD"), { code: "INVALID_PAYLOAD" });
  }
  return { jobId };
}
