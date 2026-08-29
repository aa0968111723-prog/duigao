/**
 * PR-GAP-07 疊在 #88 之上的誠實契約（不重寫 schema / migration）。
 *
 * 三條產品句：
 *  - 沒金鑰／沒 OAuth →「整合尚未設定」，不阻塞討論、不假裝版本卡。
 *  - 模型沒有 vision →「不支援圖片，不得假裝視覺分析」。
 *  - SPA HTML / `{ok:true}` 缺欄 → 不是 Canva／CUTOS／研究成功。
 */
import type { Capability, CapabilityGap } from "./providers";
import type { DesignMode, DesignTargetType } from "./types";

export const INTEGRATION_NOT_CONFIGURED = "整合尚未設定";
export const NO_FAKE_VISION = "模型不支援圖片，不得假裝視覺分析";

/** 海報／影片分析若要用模型解讀畫面，就必須要 vision。diagnose 只跑本地量測。 */
export function visualAnalysisRequired(targetType: DesignTargetType, mode: DesignMode): boolean {
  if (mode === "diagnose") return false;
  return targetType === "poster" || targetType === "video";
}

export function needsForAnalysis(mode: DesignMode, targetType: DesignTargetType): Capability[] {
  const base: Capability[] = (() => {
    switch (mode) {
      case "diagnose":
        return [];
      case "extract":
        return ["structured-output"];
      case "improve":
        return ["structured-output", "layout-analysis"];
      case "redesign":
        return ["structured-output", "layout-analysis", "color-analysis"];
    }
  })();
  if (visualAnalysisRequired(targetType, mode) && !base.includes("vision-analysis")) {
    return [...base, "vision-analysis"];
  }
  return base;
}

export function gapRiskLines(gaps: readonly CapabilityGap[]): string[] {
  return gaps.map((gap) => {
    if (gap.missing === "vision-analysis") {
      return `${NO_FAKE_VISION}。${gap.stillAvailable.join("、") || "討論與本地量測仍可用"}。`;
    }
    if (gap.missing === "web-research") {
      return `${INTEGRATION_NOT_CONFIGURED}（外部研究）。${gap.stillAvailable.join("、")}`;
    }
    return `能力不足：${gap.cannotDo}。${gap.workaround}`;
  });
}

export function looksLikeSpaHtml(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return (
    /^<!doctype html/i.test(trimmed) ||
    /^<html[\s>]/i.test(trimmed) ||
    /<\/html>/i.test(trimmed)
  );
}

/**
 * Canva／CUTOS／研究／AI 的成功判定。
 * SPA catch-all（HTTP 200 HTML）與光禿 `{ok:true}` 都不是成功。
 */
export function acceptExternalToolSuccess(
  payload: unknown,
  requiredKeys: readonly string[],
): { ok: true } | { ok: false; reason: string } {
  if (looksLikeSpaHtml(payload)) {
    return { ok: false, reason: "SPA HTML 不得當成整合成功" };
  }
  if (typeof payload === "string") {
    return { ok: false, reason: "字串回應不是契約成功" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "回應不是物件" };
  }
  const row = payload as Record<string, unknown>;
  for (const value of Object.values(row)) {
    if (looksLikeSpaHtml(value)) {
      return { ok: false, reason: "SPA HTML 不得當成整合成功" };
    }
  }
  if (row.ok === true && requiredKeys.every((key) => row[key] == null)) {
    return { ok: false, reason: "{ok:true} 缺欄不得當成成功" };
  }
  for (const key of requiredKeys) {
    if (row[key] == null) {
      return { ok: false, reason: `缺欄 ${key}` };
    }
  }
  return { ok: true };
}

export function acceptResearchSuccessBody(body: unknown): boolean {
  if (looksLikeSpaHtml(body)) return false;
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const row = body as Record<string, unknown>;
  if (looksLikeSpaHtml(row.answer) || looksLikeSpaHtml(row.html)) return false;
  if (typeof row.answer !== "string") return false;
  return true;
}
