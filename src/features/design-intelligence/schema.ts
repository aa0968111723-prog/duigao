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
  CHANGE_DIMENSIONS,
  COLOR_ROLES,
  DESIGN_MODES,
  DESIGN_PROPOSAL_STATUSES,
  DESIGN_TARGET_TYPES,
  KNOWLEDGE_CATEGORIES,
  KNOWLEDGE_STATUSES,
  SEVERITIES,
  SOURCE_TYPES,
  TRUST_LEVELS,
  type ColorRole,
  type ColorToken,
  type DesignAlternative,
  type DesignChange,
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

  // 先掃一遍取得**所有**可能的底色。
  //
  // 只拿 background 當基準是錯的：對抗審查給出的反例是
  // background #000 + surface #fff + text #aaaaaa —— 對 background 是
  // 9.04（AAA），但那個字實際上是落在 surface #fff 上，真值 2.32（不及格）。
  // 只看 background 會把不及格的配色標成 AAA，正好是這個檔案要防的事。
  //
  // 這一層不知道每個字實際疊在哪個面上（那要版面資訊），所以取**最差情況**：
  // 對所有底色算一遍，回報最低的那個，並記錄是對誰算的。寧可誤報也不漏報。
  const surfaces: Array<{ role: ColorRole; hex: string }> = [];
  for (const item of list) {
    const record = asRecord(item);
    const role = oneOf(record.role, COLOR_ROLES);
    if (role !== "background" && role !== "surface") continue;
    const hex = text(record.hex, 9);
    if (hex && HEX_RE.test(hex) && !surfaces.some((s) => s.role === role)) {
      surfaces.push({ role, hex });
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
    let worst: { role: ColorRole; ratio: number } | null = null;
    if (CONTRAST_REQUIRED.has(role)) {
      for (const surface of surfaces) {
        const ratio = contrastRatio(hex, surface.hex);
        if (ratio === null) continue;
        if (!worst || ratio < worst.ratio) worst = { role: surface.role, ratio };
      }
    }
    byRole.set(role, {
      role,
      hex: hex.toLowerCase(),
      rgb,
      cssToken: text(record.cssToken, 60) ?? `--di-${role}`,
      contrastAgainst: worst?.role,
      contrastRatio: worst?.ratio ?? null,
      wcag: wcagLevel(worst?.ratio ?? null),
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
      // id 一律加 `ai-` 命名空間。模型可以指定 id，而本地診斷的 id 是
      // 由內容決定的 —— 不隔開的話模型能撞掉本地診斷的 id，或偽造出
      // 讓下游分類錯誤的前綴。
      id: `ai-${text(record.id, 48) ?? value.length + 1}`,
      location: location!,
      issue: issue!,
      impact: impact!,
      evidence: evidence!,
      recommendation: recommendation!,
      severity: oneOf(record.severity, SEVERITIES) ?? "minor",
      // 一律 false：模型自己說「這是量出來的」沒有意義。
      measured: false,
      dimension: oneOf(record.dimension, CHANGE_DIMENSIONS) ?? undefined,
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
        // 沒有標明維度的改動一律退掉：維度是「三個方案真的不同」這條規則的
        // 唯一可檢查依據，讓它可選等於讓那條規則失效。
        const dimension = oneOf(c.dimension, CHANGE_DIMENSIONS);
        return target && detail && reason && dimension
          ? { dimension, target, change: detail, reason }
          : null;
      })
      .filter((change): change is DesignChange => change !== null)
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
 *
 * 採**預設拒絕**：
 *  - 任何 IP 字面值一律拒絕（v4 與 v6 都是）。合法的引用來源不會用裸 IP，
 *    而逐一列舉內網網段永遠列不完 —— 對抗審查實測繞過的就是列舉法：
 *    `[::ffff:169.254.169.254]`（IPv4-mapped IPv6）、`https://0/`
 *    （URL parser 正規化成 `0.0.0.0`）、`[fe80::1]`、`[::]`。
 *  - 主機名尾端的點會先剝掉：`metadata.google.internal.` 與
 *    `localhost.` 在 DNS 上等價於沒有尾點的版本，但字串比對不等價。
 *
 * **這個函式不是出站許可**。它只保證「這個字串長得像公開網址」。真正發請求
 * 的一端必須：不跟隨跨主機重新導向、或在每一跳重新驗證 —— 因為 3xx 可以從
 * 一個合法網域跳進 metadata endpoint，而本層看不到那一跳。
 */
const BLOCKED_HOST_SUFFIXES = [
  ".localhost", ".local", ".internal", ".lan", ".home.arpa", ".test", ".invalid", ".onion",
];
const BLOCKED_HOSTS = new Set([
  "localhost", "metadata.google.internal", "metadata", "instance-data",
]);

/**
 * 已知會解析到迴環位址的網域。
 *
 * **這份清單一定不完整，而且不可能完整** —— 任何人都能把自己的網域的 A record
 * 指到 127.0.0.1，字串上完全看不出來。所以這裡列的只是常見的開發用別名，
 * 不是防線。
 *
 * 真正的防線是結構上的：本專案**從不 fetch 外部回傳的網址**。研究層拿到的
 * 網址只作為「來源出處」顯示給人看，由使用者自己決定要不要點。
 * `ResearchProvider.fetchRelevantSnippets` 因此**沒有實作** ——
 * 一旦實作它，就必須在解析出 IP 之後、連線之前再檢查一次，而那是 fetch
 * 那一端的責任，不是這個字串檢查函式做得到的。
 */
const LOOPBACK_ALIAS_DOMAINS = ["lvh.me", "vcap.me", "localtest.me", "nip.io", "sslip.io", "traefik.me"];

/**
 * 主機名裡有沒有 IP。
 *
 * 一條規則、一個地方。涵蓋三種寫法：
 *   - IPv4 點分四段：`8.8.8.8`
 *   - 方括號 IPv6：`[::1]`、`[fe80::1]`（URL parser 只有 IPv6 會加方括號）
 *   - **把 IP 編進主機名**的萬用 DNS：`169.254.169.254.nip.io`、
 *     `192-168-1-1.sslip.io` —— 字串上完全不是 IP 字面值，卻解析回內網。
 *
 * 合在一起而不是分成兩個檢查，是因為變異測試指出分開時其中一個永遠殺不死：
 * 移掉字面值檢查，嵌入式檢查會接住所有測試案例。兩個都在時，
 * 沒有任何測試分得出誰在守門 —— 那就等於其中一個沒有被測到。
 */
function hostContainsIp(host: string): boolean {
  if (host.startsWith("[")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return /(^|[.-])\d{1,3}[.-]\d{1,3}[.-]\d{1,3}[.-]\d{1,3}([.-]|$)/.test(host);
}

export function isSafePublicUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  // 尾端的點在 DNS 上無意義，但會讓字串比對失效 → 先正規化
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host) return false;
  if (hostContainsIp(host)) return false;
  if (BLOCKED_HOSTS.has(host)) return false;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  if (LOOPBACK_ALIAS_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))) return false;
  // 沒有點的單標籤主機名（`https://intranet/`）只可能是內網
  if (!host.includes(".")) return false;
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
/**
 * 知識條目的來源。決定這條知識**最高**能被信任到什麼程度。
 *
 * 這是刻意的必填語意（預設值取最嚴格的 "machine"）：呼叫端忘了傳，
 * 拿到的是最不被信任的那一檔，而不是最寬鬆的。
 */
export type KnowledgeProvenance = "machine" | "human-review" | "project";

const TRUST_CEILING: Record<KnowledgeProvenance, KnowledgeEntry["trustLevel"]> = {
  machine: "machine",
  "human-review": "approved",
  project: "project",
};

export function parseKnowledgeEntry(
  raw: unknown,
  provenance: KnowledgeProvenance = "machine",
): ParseResult<KnowledgeEntry | null> {
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
  // 信任等級由**來源**決定，不由 payload 自己宣稱。
  //
  // 舊版只在 `status === "machine-researched"` 時降級，但 status 本身就來自
  // 同一份不可信輸入 —— 搜尋結果只要回 `status: "approved"` 就整條繞過。
  // 現在上限由呼叫端傳入的 provenance 決定：研究層一律傳 "machine"，
  // 人工審查介面傳 "human-review"，migration/專案規範傳 "project"。
  const ceiling = TRUST_CEILING[provenance];
  let status = oneOf(record.status, KNOWLEDGE_STATUSES) ?? "draft";
  let trustLevel = oneOf(record.trustLevel, TRUST_LEVELS) ?? "unverified";
  if (TRUST_ORDER[trustLevel] < TRUST_ORDER[ceiling]) {
    rejected.push(`${provenance} 來源不得自稱 ${trustLevel}，已降為 ${ceiling}：${title}`);
    trustLevel = ceiling;
  }
  if (provenance === "machine" && status !== "draft") {
    if (status !== "machine-researched") {
      rejected.push(`機器來源不得自稱 ${status}，已改為 machine-researched：${title}`);
    }
    status = "machine-researched";
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
      // 一律重算：輸入給的雜湊沒有任何可信度，接受它等於讓呼叫端宣告
      // 「我跟那條已審查的知識內容相同」而繞過衝突偵測。
      contentHash: contentHashOf(title, summary, rules),
    },
  };
}

/**
 * 內容的正規化編碼。
 *
 * **長度前綴**，不用分隔字元：`5:title6:summary...`。理由是分隔字元一律可以
 * 被嵌進內容裡構造出「不同內容、相同編碼」—— 舊版用 NUL 當分隔，
 * 標題裡塞一個 NUL 就能偽造出相同的雜湊輸入。長度前綴沒有這個面。
 */
function canonicalContent(title: string, summary: string, rules: readonly string[]): string {
  const part = (value: string) => `${value.length}:${value}`;
  return [part(title), part(summary), part(String(rules.length)), ...rules.map(part)].join("");
}

/**
 * 內容雜湊（FNV-1a，兩組不同起始值串成 64 bit，十六進位）。
 *
 * 用途是偵測「同一份知識被重複匯入」與「內容被悄悄改掉」，**不是密碼學用途**，
 * 也不是資料庫的判重依據 —— DB 的 `content_hash` 由 trigger 自己算
 * （見 `0027_design_knowledge.sql`），呼叫端給什麼都會被覆蓋。兩者刻意分開：
 * 這一個是本地變更偵測，那一個是唯一索引的權威來源，不互相比較。
 *
 * 不用 `crypto.subtle`：那是非同步的，會逼整個純函式層變 async。
 * 32-bit 在幾萬條知識下生日碰撞已經不可忽略，所以串到 64-bit。
 */
export function contentHashOf(title: string, summary: string, rules: readonly string[]): string {
  const input = canonicalContent(title, summary, rules);
  const fnv = (seed: number) => {
    let hash = seed;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  };
  return fnv(0x811c9dc5) + fnv(0x7fffffff);
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
/**
 * 把規則拆成「對象」「運算子」「數值」。
 *
 * 「內文行高 ≥ 1.5」→ 對象「內文行高」、`>=`、1.5
 * 「內文行高 = 1.2」→ 對象「內文行高」、`=`、1.2
 *
 * 一條規則裡可能有多組（「標題字級 ≥ 24，內文 ≥ 16」），所以是全域掃描
 * 而不是只取第一個 —— 對抗審查實測到舊版會漏掉第二組。
 *
 * 這是字面比對，不是語意理解：「一般內文與背景對比」與「內文對比」
 * 會被當成兩個不同的對象。已知極限，寫在這裡而不是假裝沒有。
 */
type Constraint = { subject: string; op: ">=" | "<=" | "="; value: number };

const OP_WORDS: Array<[RegExp, Constraint["op"]]> = [
  [/^(?:≥|>=|至少|不得低於|不小於)$/, ">="],
  [/^(?:≤|<=|不超過|最多|不得超過|不大於)$/, "<="],
  [/^(?:=|==|等於|固定為|固定)$/, "="],
];

function constraintsOf(rule: string): Constraint[] {
  const out: Constraint[] = [];
  const pattern = /([^，,。；;]*?)[\s]*(≥|≤|>=|<=|==|=|>|<|至少|不得低於|不小於|不超過|最多|不得超過|不大於|等於|固定為|固定)[\s]*([0-9]+(?:[.][0-9]+)?)/g;
  for (const match of rule.matchAll(pattern)) {
    const subject = match[1].replace(/[\s。，、：:]+/g, "");
    if (!subject) continue;
    const raw = match[2];
    const op = OP_WORDS.find(([test]) => test.test(raw))?.[1] ?? (raw === ">" ? ">=" : raw === "<" ? "<=" : "=");
    const value = Number(match[3]);
    if (Number.isFinite(value)) out.push({ subject, op, value });
  }
  if (out.length) return out;

  // 沒有運算子的寫法：「行高 1.5」「內文對比 4.5:1」。
  // 這在真實的規則裡很常見，當成等值處理。
  //
  // 只在**整條規則都沒有運算子**時才走這條 —— 否則「標題字級 ≥ 24，內文 16」
  // 的後半段會被重複解讀。
  const bare = /^([^0-9，,。；;]+?)[\s]*([0-9]+(?:[.][0-9]+)?)/.exec(rule.trim());
  if (bare) {
    const subject = bare[1].replace(/[\s。，、：:]+/g, "");
    const value = Number(bare[2]);
    if (subject && Number.isFinite(value)) out.push({ subject, op: "=", value });
  }
  return out;
}

/**
 * 這一組對同一個對象的約束**互相衝突**嗎。
 *
 * 相容的情況（不該回報）：
 *   - 兩個下限：「至少 24」與「至少 44」—— 較嚴的滿足較寬的。
 *   - 兩個上限：同理。
 *   - 一個下限一個上限且區間不為空：「≥ 1.2」與「≤ 1.8」。
 *
 * 衝突的情況：
 *   - 兩個不同的等值：「= 1.2」與「= 1.5」。
 *   - 等值落在另一個約束之外：「= 1.2」與「≥ 1.5」。
 *   - 下限大於上限：「≥ 1.5」與「≤ 1.2」。
 *
 * 把「至少 24」與「至少 44」當成矛盾去逼使用者選一邊，最糟的結果是
 * 品牌那條較嚴的規則被丟掉 —— 對抗審查點名的正是這件事。
 */
function incompatible(constraints: readonly Constraint[]): boolean {
  const equals = constraints.filter((item) => item.op === "=").map((item) => item.value);
  const lower = constraints.filter((item) => item.op === ">=").map((item) => item.value);
  const upper = constraints.filter((item) => item.op === "<=").map((item) => item.value);

  if (new Set(equals).size > 1) return true;
  const maxLower = lower.length ? Math.max(...lower) : null;
  const minUpper = upper.length ? Math.min(...upper) : null;
  if (maxLower !== null && minUpper !== null && maxLower > minUpper) return true;
  for (const value of equals) {
    if (maxLower !== null && value < maxLower) return true;
    if (minUpper !== null && value > minUpper) return true;
  }
  return false;
}

function bySubject(
  entries: readonly KnowledgeEntry[],
): Map<string, Array<{ entry: KnowledgeEntry; constraint: Constraint }>> {
  const buckets = new Map<string, Array<{ entry: KnowledgeEntry; constraint: Constraint }>>();
  for (const entry of entries) {
    for (const rule of entry.rules) {
      for (const constraint of constraintsOf(rule)) {
        const list = buckets.get(constraint.subject) ?? [];
        list.push({ entry, constraint });
        buckets.set(constraint.subject, list);
      }
    }
  }
  return buckets;
}

/**
 * 找出互相矛盾的知識。
 *
 * **只回報判定得出來的矛盾**，靠的是規則裡的數值約束（`constraintsOf` +
 * `incompatible`）。同一個對象上，「= 1.2」與「≥ 1.5」是矛盾；
 * 「≥ 24」與「≥ 44」不是（較嚴的滿足較寬的）。
 *
 * ## 為什麼不再用「同類別 + 內容不同」當判準
 *
 * 舊版把同一個 category＋context 桶裡任兩條內容不同的知識都當成矛盾。
 * 那會讓「行高 ≥ 1.5」與「行長 ≤ 75」被報成衝突 —— 它們都是 typography，
 * 但完全無關。使用者每次都看到一堆假衝突，久了就不看了，
 * 而真的衝突就藏在那堆噪音裡。**一個訓練使用者忽略它的警告，比沒有警告更糟。**
 *
 * ## 誠實的極限
 *
 * 非數值的規則（「一律使用無襯線字體」vs「一律使用襯線字體」）**判定不出來**，
 * 所以這裡不回報。這是漏報，不是誤報 —— 在兩種錯誤之間，
 * 讓使用者自己看那兩條並存的規則，比替他們宣告一個不存在的矛盾好。
 *
 * 對象的比對也是字面的：「一般內文與背景對比」與「內文對比」是兩個對象。
 */
export function findKnowledgeConflicts(entries: KnowledgeEntry[]): Array<{
  category: string;
  context: string;
  entryIds: string[];
}> {
  const live = entries.filter((entry) => entry.status !== "deprecated");
  const conflicts: Array<{ category: string; context: string; entryIds: string[] }> = [];

  for (const [subject, list] of bySubject(live)) {
    if (list.length < 2) continue;
    // 同一條知識自己的規則不算跟自己衝突
    const entryIds = [...new Set(list.map((item) => item.entry.id))];
    if (entryIds.length < 2) continue;
    if (!incompatible(list.map((item) => item.constraint))) continue;

    // 類別欄位：同類別就用它，跨類別就標明。UI 要能顯示「這是品牌規範與
    // 通用規範打架」還是「同一類別內部不一致」。
    const categories = [...new Set(list.map((item) => item.entry.category))];
    conflicts.push({
      category: categories.length === 1 ? categories[0] : "跨類別",
      context: subject,
      entryIds,
    });
  }

  // 同一組條目可能因為多個對象而被回報多次 —— 去重，
  // 否則 UI 會顯示「有 5 組矛盾」而其實只有一組。
  const seen = new Set<string>();
  return conflicts.filter((conflict) => {
    const key = [...conflict.entryIds].sort().join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
