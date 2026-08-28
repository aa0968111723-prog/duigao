/**
 * planform-iso 場佈 artifact 契約（PR-06 第一階段，ADR-006）。
 *
 * planform 是獨立的 local-first 3D 場佈 PWA；第一階段的整合是
 * **artifact 契約**，不是 live embed：場佈以「project JSON＋（可選的）
 * 快照 PNG」進房，走 0018 的附件機制（add-only、原始檔不可逆轉換＝零）。
 *
 * 這個模組是唯讀的識別器＋摘要器：
 *  - 不改寫、不正規化、不「修」project JSON — 原始 bytes 原樣上傳；
 *  - 摘要只給討論卡呈現用（與 payload.mime 同級：client 主張，顯示用，
 *    安全判斷不得信任）；
 *  - planform 的 schema 是加法演進（其 model.ts 文件明言 v2..v8 全是
 *    optional 疊加），所以「版本比我認識的新」不是拒絕理由 — 摘要照出，
 *    帶 beyondKnownVersion 旗標誠實標示。
 *
 * 3D anchor（指向場佈裡的某個 zone/object）進 ContextAnchor union 的
 * planform-scene 臂；三套既有機制目前都沒有它的表示法（已知缺口，
 * 契約點名 — 第二階段 live embed 探測完 host headers 後再接）。
 */

/** 這個讀取器驗證過的最高版本（planform PROJECT_VERSION，2026-08）。 */
export const PLANFORM_KNOWN_VERSION = 8;

export type PlanformSummary = {
  /** v8+ 才有穩定 id；舊檔缺席是正常的。 */
  projectId?: string;
  name: string;
  version: number;
  /** 版本比讀取器新：欄位是加法演進，摘要仍可信，但要標示。 */
  beyondKnownVersion: boolean;
  zoneCount: number;
  objectCount: number;
  routeCount: number;
  scenarioCount: number;
  /** v8+ 可選活動日期（YYYY-MM-DD 字串，原樣轉手）。 */
  eventDate?: string;
};

const countOf = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

/**
 * 這份 JSON 看起來是 planform project 嗎？
 *
 * 判準取 planform 從 v1 就存在、且別的常見 JSON 不會同時具備的骨架：
 * 數字 version＋classroom/corridor 兩個場地區塊。故意不驗到每個欄位 —
 * 識別器的責任是「別把 package.json 當場佈」，不是 schema 檢查。
 */
export function looksLikePlanformProject(json: unknown): boolean {
  if (!json || typeof json !== "object" || Array.isArray(json)) return false;
  const p = json as Record<string, unknown>;
  // 場地區塊必須長得像 AreaConfig（length/width 數字）— typeof [] 也是
  // "object"，光驗物件擋不住 {classroom:[]}（Grok pr06 F2 收緊）。
  const isArea = (value: unknown): boolean =>
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).length === "number" &&
    typeof (value as Record<string, unknown>).width === "number";
  return (
    typeof p.version === "number" &&
    Number.isFinite(p.version) &&
    p.version >= 1 &&
    isArea(p.classroom) &&
    isArea(p.corridor)
  );
}

/**
 * 摘要一份 planform project JSON。不是 planform 檔（或壞檔）→ null，
 * 呼叫端把它當一般附件 — 永遠不因為讀不懂而擋上傳。
 */
export function readPlanformSummary(json: unknown): PlanformSummary | null {
  if (!looksLikePlanformProject(json)) return null;
  const p = json as Record<string, unknown>;
  const version = p.version as number;
  const name = typeof p.name === "string" && p.name.trim() ? p.name.trim() : "未命名平面圖";
  return {
    ...(typeof p.id === "string" && p.id ? { projectId: p.id } : {}),
    name: name.slice(0, 120),
    version,
    beyondKnownVersion: version > PLANFORM_KNOWN_VERSION,
    zoneCount: countOf(p.zones),
    objectCount: countOf(p.objects),
    routeCount: countOf(p.routes),
    scenarioCount: countOf(p.scenarios),
    ...(typeof p.eventDate === "string" && p.eventDate ? { eventDate: p.eventDate.slice(0, 10) } : {}),
  };
}

/** 附件 payload 裡的場佈摘要形狀（DiscussionPayload.planform）。 */
export type PlanformPayload = Pick<
  PlanformSummary,
  "name" | "version" | "zoneCount" | "objectCount" | "routeCount"
> & { projectId?: string };

export function planformPayloadFromSummary(summary: PlanformSummary): PlanformPayload {
  return {
    ...(summary.projectId ? { projectId: summary.projectId } : {}),
    name: summary.name,
    version: summary.version,
    zoneCount: summary.zoneCount,
    objectCount: summary.objectCount,
    routeCount: summary.routeCount,
  };
}
