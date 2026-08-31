/**
 * Heuristic: is this edit one asset or the whole poster?
 * Pure — no I/O. Human 改判 is passed as `override` and always wins.
 */
export type EditScope = "single" | "full";

export type EditScopePin = { body: string };

export type InferEditScopeInput = {
  pins: EditScopePin[];
  regionArea?: number;
  bodyText?: string;
  override?: EditScope | null;
};

export type InferEditScopeResult = {
  scope: EditScope | null;
  label: string;
  reason: "empty" | "heuristic" | "override";
};

export const EMPTY_EDIT_SCOPE_COPY = "先點要改的地方，或改判整張。";
export const SINGLE_EDIT_HINT = "已生成視覺提案，尚未成為正式版本";
export const FULL_EDIT_HINT = "第二版預覽，尚未成為正式版本";
export const FULL_SCOPE_KEYWORDS = ["整張", "整體", "重排", "底換掉"] as const;
export const LARGE_REGION_AREA = 0.4;

const LABEL_MAX = 8;

export function shortScopeLabel(body: string): string {
  const text = body.trim();
  if (!text) return "";
  if (/logo/i.test(text)) return "logo";
  if (/貼圖/.test(text)) return "貼圖";
  if (/主標/.test(text)) return "主標";
  if (/這行字|文字/.test(text)) return "文字";
  const cut = text.replace(/看不清.*$/, "").replace(/要?改(成|成)?.*/, "").trim();
  const token = (cut.split(/[\s，。、／/]+/).find(Boolean) || text).trim();
  return token.slice(0, LABEL_MAX);
}

export function canGenerateEdit(input: InferEditScopeInput): boolean {
  const area = input.regionArea ?? 0;
  return input.pins.length > 0 || area > 0;
}

export function inferEditScope(input: InferEditScopeInput): InferEditScopeResult {
  const pins = input.pins ?? [];
  const area = input.regionArea ?? 0;
  const body = (input.bodyText ?? pins.map((pin) => pin.body).join(" ")).trim();
  const empty = pins.length === 0 && area <= 0;

  if (input.override === "single" || input.override === "full") {
    const label = input.override === "full" ? "整張" : (shortScopeLabel(body) || "單一素材");
    return { scope: input.override, label, reason: "override" };
  }

  if (empty) return { scope: null, label: "", reason: "empty" };

  if (area >= LARGE_REGION_AREA) return { scope: "full", label: "整張", reason: "heuristic" };
  if (FULL_SCOPE_KEYWORDS.some((word) => body.includes(word))) {
    return { scope: "full", label: "整張", reason: "heuristic" };
  }
  if (pins.length >= 2) return { scope: "full", label: "整張", reason: "heuristic" };

  return { scope: "single", label: shortScopeLabel(body) || "單一素材", reason: "heuristic" };
}

export function visualEditPrompt(input: { scope: EditScope; label: string; bodyText?: string }): string {
  const body = (input.bodyText ?? "").trim();
  if (input.scope === "single") {
    const label = input.label.trim() || "這一處";
    return `只改 ${label} 這一處，其餘構圖、底、主體不變。${body}`.trim().slice(0, 4000);
  }
  return `依修改改整張。${body}`.trim().slice(0, 4000);
}

export function visualEditHint(scope: EditScope): string {
  return scope === "full" ? FULL_EDIT_HINT : SINGLE_EDIT_HINT;
}

export function chipCaption(result: InferEditScopeResult): string {
  if (result.scope === "single") return `這次改：單一素材 · ${result.label || "單一素材"}`;
  if (result.scope === "full") return "這次改：整張";
  return EMPTY_EDIT_SCOPE_COPY;
}
