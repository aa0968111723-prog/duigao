/**
 * Design Intelligence — 結構化輸出驗證（PR-DI-00）
 *
 * 為什麼手寫而不是引入 zod：這個 repo 沒有任何 schema 驗證函式庫，既有的
 * 結構化輸出驗證（`normalizeAiActions`、`safeAgentCitations`）也全是手寫
 * 白名單。引入新依賴會讓 bundle 與 review 面積都變大，而本層需要的檢查
 * 其實很具體（見下面每個 reject 理由）——所以沿用同一路線，但**集中成一層**，
 * 不再像既有那樣同一份白名單散在三個檔案。
 *
 * 核心紀律：**模型輸出一律不可信**。
 * 每個 parse 函式都回傳 `{ ok, value, rejected }`，其中 `rejected` 說明
 * 「丟掉了什麼、為什麼」—— 靜默丟棄會讓「AI 好像沒回答」變成無法診斷的問題。
 */
import {
  ALTERNATIVE_STRATEGIES,
  COLOR_ROLES,
  DESIGN_MODES,
  DESIGN_PROPOSAL_STATUSES,
  DESIGN_TARGET_TYPES,
  KNOWLEDGE_CATEGORIES,
  KNOWLEDGE_STATUSES,
  SEVERITIES,
  SOURCE_TYPES,
  TRUST_LEVELS,
  type ColorToken,
  type DesignAlternative,
  type Diagnostic,
  type KnowledgeEntry,
  type ResearchSource,
} from "./types";

export type ParseResult<T> = {
  ok: boolean;
  value: T;
  /** 丟掉了什麼、為什麼。UI 要能顯示「AI 回了 5 條，3 條格式不符已略過」。 */
  rejected: string[];
};

// ---- 基礎工具 -------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 非空字串，並截到上限。空白字串視為缺值 —— 「   」不是內容。 */
function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/** 0–1 的信心值。超界夾住而不是丟掉 —— 模型常常回 0 或 100。 */
function confidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.5;
  if (value > 1 && value <= 100) return Math.min(1, value / 100);
  return Math.min(1, Math.max(0, value));
}

function stringList(value: unknown, max: number, itemMax: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const line = text(item, itemMax);
    if (line) out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

// ---- 色彩 -----------------------------------------------------------------

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** #abc / #aabbcc → {r,g,b}。不合法回 null。 */
export function parseHex(hex: string): { r: number; g: number; b: number } | null {
  if (!HEX_RE.test(hex)) return null;
  let body = hex.slice(1);
  if (body.length === 3) body = body.split("").map((ch) => ch + ch).join("");
  return {
    r: parseInt(body.slice(0, 2), 16),
    g: parseInt(body.slice(2, 4), 16),
    b: parseInt(body.slice(4, 6), 16),
  };
}

/** WCAG 相對亮度。 */
export function relativeLuminance(rgb: { r: number; g: number; b: number }): number {
  const channel = (raw: number) => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/**
 * WCAG 對比值（1–21）。
 *
 * 自己算而不是問模型：對比是**可以算出來的事實**，讓模型「估」一個對比值
 * 就是在製造幻覺的空間。任務書第五節要求色票必須附對比結果，那個結果
 * 應該由程式算，不是由 AI 說。
 */
export function contrastRatio(a: string, b: string): number | null {
  const rgbA = parseHex(a);
  const rgbB = parseHex(b);
  if (!rgbA || !rgbB) return null;
  const lumA = relativeLuminance(rgbA);
  const lumB = relativeLuminance(rgbB);
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return Number((((lighter + 0.05) / (darker + 0.05))).toFixed(2));
}

export function wcagLevel(ratio: number | null): ColorToken["wcag"] {
  if (ratio === null) return "n/a";
  if (ratio >= 7) return "AAA";
  if (ratio >= 4.5) return "AA";
  if (ratio >= 3) return "AA-large";
  return "none";
}

/** 需要對比檢查的角色（border 之類的裝飾性角色不強制）。 */
const CONTRAST_REQUIRED: ReadonlySet<string> = new Set([
  "text-primary", "text-secondary", "primary-action", "success", "warning", "danger",
]);

export function parseColorTokens(raw: unknown): ParseResult<ColorToken[]> {
  const rejected: string[] = [];
  const list = Array.isArray(raw) ? raw : [];
  const byRole = new Map<string, ColorToken>();

  // 先掃一遍取得背景色，對比才有基準
  let background: string | null = null;
  for (const item of list) {
    const record = asRecord(item);
    if (record.role === "background") {
      const hex = text(record.hex, 9);
      if (hex && HEX_RE.test(hex)) background = hex;
    }
  }

  for (const item of list) {
    const record = asRecord(item);
    const role = oneOf(record.role, COLOR_ROLES);
    if (!role) {
      rejected.push(`色彩角色不在詞彙表：${String(record.role).slice(0, 40)}`);
      continue;
    }
    const hex = text(record.hex, 9);
    const rgb = hex ? parseHex(hex) : null;
    if (!hex || !rgb) {
      rejected.push(`${role} 的 hex 不合法：${String(record.hex).slice(0, 20)}`);
      continue;
    }
    if (byRole.has(role)) {
      rejected.push(`同一個角色出現兩次，保留第一個：${role}`);
      continue;
    }
    const needsContrast = CONTRAST_REQUIRED.has(role) && background !== null;
    const ratio = needsContrast ? contrastRatio(hex, background!) : null;
    byRole.set(role, {
      role,
      hex: hex.toLowerCase(),
      rgb,
      cssToken: text(record.cssToken, 60) ?? `--di-${role}`,
      contrastAgainst: needsContrast ? "background" : undefined,
      contrastRatio: ratio,
      wcag: wcagLevel(ratio),
    });
  }
  const value = [...byRole.values()];
  return { ok: value.length > 0, value, rejected };
}

// ---- 診斷 -----------------------------------------------------------------

/**
 * 任務書第十三節禁止空話。這裡把它變成**可執行的檢查**：
 * location／issue／impact／evidence／recommendation 任一為空就整條丟掉，
 * 並在 rejected 說明是哪一欄缺了 —— 這樣「AI 只會講幹話」會在測試裡變紅，
 * 而不是靠人去讀輸出感覺。
 */
export function parseDiagnostics(raw: unknown, max = 12): ParseResult<Diagnostic[]> {
  const rejected: string[] = [];
  const value: Diagnostic[] = [];
  const list = Array.isArray(raw) ? raw : [];
  for (const item of list) {
    if (value.length >= max) {
      rejected.push(`超過 ${max} 條診斷，其餘略過`);
      break;
    }
    const record = asRecord(item);
    const location = text(record.location, 200);
    const issue = text(record.issue, 400);
    const impact = text(record.impact, 400);
    const evidence = text(record.evidence, 400);
    const recommendation = text(record.recommendation, 600);
    const missing = [
      !location && "location",
      !issue && "issue",
      !impact && "impact",
      !evidence && "evidence",
      !recommendation && "recommendation",
    ].filter(Boolean);
    if (missing.length) {
      rejected.push(`診斷缺少必要欄位（${missing.join("、")}）：${(issue ?? location ?? "無標題").slice(0, 40)}`);
      continue;
    }
    value.push({
      id: text(record.id, 64) ?? `dx-${value.length + 1}`,
      location: location!,
      issue: issue!,
      impact: impact!,
      evidence: evidence!,
      recommendation: recommendation!,
      severity: oneOf(record.severity, SEVERITIES) ?? "minor",
      confidence: confidence(record.confidence),
      knowledgeRefs: stringList(record.knowledgeRefs, 8, 64),
      sourceRefs: stringList(record.sourceRefs, 8, 64),
    });
  }
  return { ok: value.length > 0, value, rejected };
}

// ---- 方案 -----------------------------------------------------------------

/**
 * 三種方向必須**真的不同**（任務書第十四節：「不能只是三組不同顏色」）。
 * 這裡的可執行檢查是：strategy 不得重複。內容是否真的有差異無法用程式判定，
 * 所以那部分靠 e2e 的評估案例與人審 —— 誠實邊界。
 */
export function parseAlternatives(raw: unknown, max = 3): ParseResult<DesignAlternative[]> {
  const rejected: string[] = [];
  const value: DesignAlternative[] = [];
  const seenStrategy = new Set<string>();
  const list = Array.isArray(raw) ? raw : [];
  for (const item of list) {
    if (value.length >= max) {
      rejected.push(`超過 ${max} 個方案，其餘略過`);
      break;
    }
    const record = asRecord(item);
    const name = text(record.name, 60);
    const strategy = oneOf(record.strategy, ALTERNATIVE_STRATEGIES);
    if (!name || !strategy) {
      rejected.push(`方案缺少 name 或 strategy：${String(record.name).slice(0, 40)}`);
      continue;
    }
    if (seenStrategy.has(strategy)) {
      rejected.push(`同一個 strategy 出現兩次（三個方向必須真的不同）：${strategy}`);
      continue;
    }
    const changes = (Array.isArray(record.changes) ? record.changes : [])
      .map((change) => {
        const c = asRecord(change);
        const target = text(c.target, 120);
        const detail = text(c.change, 400);
        const reason = text(c.reason, 400);
        return target && detail && reason ? { target, change: detail, reason } : null;
      })
      .filter((change): change is { target: string; change: string; reason: string } => change !== null)
      .slice(0, 20);
    if (!changes.length) {
      rejected.push(`方案沒有任何具體修改，只有形容詞：${name}`);
      continue;
    }
    seenStrategy.add(strategy);
    const tokens = parseColorTokens(record.designTokens);
    rejected.push(...tokens.rejected.map((line) => `${name}：${line}`));
    value.push({
      id: text(record.id, 64) ?? `alt-${strategy}`,
      name,
      strategy,
      changes,
      designTokens: tokens.value,
      preview: null, // 預覽由 UI 層依 changes/tokens 產生，模型不得直接給 bytes
      advantages: stringList(record.advantages, 6, 200),
      tradeoffs: stringList(record.tradeoffs, 6, 200),
    });
  }
  return { ok: value.length > 0, value, rejected };
}

// ---- 外部來源 -------------------------------------------------------------

/**
 * 只接受 https 的公開網址。
 *
 * 擋掉的東西（任務書第九節）：`file://`、`localhost`、內網網段、
 * 雲端 metadata endpoint。這是 SSRF 與內網探測的第一道防線，而且**在型別
 * 邊界就擋**，不是等到發請求才擋。
 */
export function isSafePublicUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (host === "metadata.google.internal" || host === "169.254.169.254") return false;
  // IPv4 私有／迴環／link-local
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  // IPv6 迴環與唯一本地
  if (host === "::1" || host.startsWith("[::1") || /^\[?f[cd]/i.test(host)) return false;
  return true;
}

export function parseResearchSources(raw: unknown, max = 12): ParseResult<ResearchSource[]> {
  const rejected: string[] = [];
  const value: ResearchSource[] = [];
  const seen = new Set<string>();
  const list = Array.isArray(raw) ? raw : [];
  for (const item of list) {
    if (value.length >= max) {
      rejected.push(`超過 ${max} 個來源，其餘略過`);
      break;
    }
    const record = asRecord(item);
    const url = text(record.url, 2048);
    if (!url || !isSafePublicUrl(url)) {
      rejected.push(`來源網址不安全或不合法：${String(record.url).slice(0, 60)}`);
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    const publishedAt = typeof record.publishedAt === "number" && Number.isFinite(record.publishedAt)
      ? record.publishedAt
      : null;
    value.push({
      id: text(record.id, 64) ?? `src-${value.length + 1}`,
      url,
      title: text(record.title, 200) ?? url,
      publisher: text(record.publisher, 120) ?? new URL(url).hostname,
      sourceType: oneOf(record.sourceType, SOURCE_TYPES) ?? "unknown",
      retrievedAt: typeof record.retrievedAt === "number" ? record.retrievedAt : 0,
      // 頁面沒標日期就是 null —— 不拿取得時間冒充發布時間
      publishedAt,
      excerpt: text(record.excerpt, 1200) ?? "",
    });
  }
  return { ok: value.length > 0, value, rejected };
}

// ---- 知識條目 -------------------------------------------------------------

/**
 * 知識條目的驗證，重點在**信任等級不能被自己升級**。
 *
 * 規則（任務書第六節）：Perplexity 的搜尋結果不能直接變成 approved。
 * 這裡把它變成硬性檢查：`status === "machine-researched"` 時
 * trustLevel 最高只能到 `machine`。
 */
export function parseKnowledgeEntry(raw: unknown): ParseResult<KnowledgeEntry | null> {
  const rejected: string[] = [];
  const record = asRecord(raw);
  const title = text(record.title, 160);
  const summary = text(record.summary, 800);
  const category = oneOf(record.category, KNOWLEDGE_CATEGORIES);
  if (!title || !summary || !category) {
    rejected.push(`知識條目缺少 title／summary／category：${String(record.title).slice(0, 40)}`);
    return { ok: false, value: null, rejected };
  }
  const rules = stringList(record.rules, 20, 400);
  if (!rules.length) {
    rejected.push(`知識條目沒有任何可執行規則：${title}`);
    return { ok: false, value: null, rejected };
  }
  const status = oneOf(record.status, KNOWLEDGE_STATUSES) ?? "draft";
  let trustLevel = oneOf(record.trustLevel, TRUST_LEVELS) ?? "unverified";
  if (status === "machine-researched" && (trustLevel === "approved" || trustLevel === "project")) {
    rejected.push(`機器研究的結果不得自稱 ${trustLevel}，已降為 machine：${title}`);
    trustLevel = "machine";
  }
  const sourceUrl = text(record.sourceUrl, 2048);
  if (sourceUrl && !isSafePublicUrl(sourceUrl)) {
    rejected.push(`知識來源網址不安全，已移除：${sourceUrl.slice(0, 60)}`);
  }
  return {
    ok: true,
    rejected,
    value: {
      id: text(record.id, 64) ?? `kn-${category}-${title.slice(0, 24)}`,
      category,
      title,
      summary,
      rules,
      exceptions: stringList(record.exceptions, 10, 300),
      applicableContexts: stringList(record.applicableContexts, 12, 60),
      sourceUrl: sourceUrl && isSafePublicUrl(sourceUrl) ? sourceUrl : null,
      sourceTitle: text(record.sourceTitle, 200),
      sourceType: oneOf(record.sourceType, SOURCE_TYPES) ?? "unknown",
      publisher: text(record.publisher, 120),
      retrievedAt: typeof record.retrievedAt === "number" ? record.retrievedAt : null,
      reviewedAt: typeof record.reviewedAt === "number" ? record.reviewedAt : null,
      version: typeof record.version === "number" && record.version > 0 ? Math.floor(record.version) : 1,
      trustLevel,
      projectSpecific: text(record.projectSpecific, 64),
      status,
      contentHash: text(record.contentHash, 128) ?? contentHashOf(title, summary, rules),
    },
  };
}

/**
 * 內容雜湊（FNV-1a 32-bit，十六進位）。
 *
 * 用途是偵測「同一份知識被重複匯入」與「內容被悄悄改掉」，不是密碼學用途 ——
 * 所以不用 crypto.subtle（那是非同步的，會讓純函式層被迫變 async）。
 */
export function contentHashOf(title: string, summary: string, rules: string[]): string {
  const input = `${title} ${summary} ${rules.join(" ")}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// ---- 知識優先序 -----------------------------------------------------------

const TRUST_ORDER: Record<string, number> = {
  project: 0, approved: 1, reviewed: 2, machine: 3, unverified: 4,
};

/**
 * 知識排序：專案自有規範優先於已核准知識，已核准優先於未審查搜尋結果。
 * 同級時新的優先（reviewedAt → retrievedAt）。
 */
export function rankKnowledge(entries: KnowledgeEntry[]): KnowledgeEntry[] {
  return [...entries]
    .filter((entry) => entry.status !== "deprecated")
    .sort((a, b) => {
      const trust = TRUST_ORDER[a.trustLevel] - TRUST_ORDER[b.trustLevel];
      if (trust !== 0) return trust;
      const aTime = a.reviewedAt ?? a.retrievedAt ?? 0;
      const bTime = b.reviewedAt ?? b.retrievedAt ?? 0;
      return bTime - aTime;
    });
}

/**
 * 找出互相衝突的規則（同 category、同 applicableContext，但 rules 不同）。
 *
 * **不自行消除衝突**（任務書第八節）：只標示出來，交給規則或人決定。
 */
export function findKnowledgeConflicts(entries: KnowledgeEntry[]): Array<{
  category: string;
  context: string;
  entryIds: string[];
}> {
  const buckets = new Map<string, KnowledgeEntry[]>();
  for (const entry of entries) {
    if (entry.status === "deprecated") continue;
    for (const context of entry.applicableContexts.length ? entry.applicableContexts : ["*"]) {
      const key = `${entry.category}|${context}`;
      buckets.set(key, [...(buckets.get(key) ?? []), entry]);
    }
  }
  const conflicts: Array<{ category: string; context: string; entryIds: string[] }> = [];
  for (const [key, list] of buckets) {
    if (list.length < 2) continue;
    const hashes = new Set(list.map((entry) => entry.contentHash));
    if (hashes.size < 2) continue; // 內容相同不算衝突
    const [category, context] = key.split("|");
    conflicts.push({ category, context, entryIds: list.map((entry) => entry.id) });
  }
  return conflicts;
}

// ---- 提案狀態機 -----------------------------------------------------------

const ALLOWED_TRANSITIONS: Record<string, readonly string[]> = {
  draft: ["analyzing", "rejected"],
  analyzing: ["ready", "needs-context", "failed"],
  "needs-context": ["analyzing", "rejected"],
  ready: ["approved", "rejected"],
  approved: ["applying", "rejected"],
  applying: ["applied", "failed"],
  applied: ["reverted"],
  failed: ["analyzing", "rejected"],
  rejected: [],
  reverted: [],
};

/**
 * 狀態轉移檢查。
 *
 * 為什麼要有這個：任務書第十一節的紅線是「不得直接 使用者一句話 → AI 覆蓋原稿」。
 * 把它變成狀態機之後，「沒有經過 approved 就 applied」在型別層就是非法轉移，
 * 而不是靠 review 時用眼睛看。
 */
export function canTransition(from: string, to: string): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

export function isTerminalStatus(status: string): boolean {
  return status === "rejected" || status === "reverted";
}

export { DESIGN_PROPOSAL_STATUSES, DESIGN_TARGET_TYPES, DESIGN_MODES };
