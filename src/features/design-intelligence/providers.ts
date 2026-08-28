/**
 * Design Intelligence — provider 與 capability 註冊（PR-DI-00）
 *
 * 基線稽核發現：本 repo **沒有** capability registry，AI 能力就是一條四值
 * union，provider 是單選 env（`DUIGAO_AGENT_PROVIDER`），沒有 fallback、
 * 沒有重試、沒有斷路器（BASELINE_AUDIT §3）。
 *
 * 這一層要解決的是：
 * - 功能不寫死在單一模型 → 以**能力**選 provider，不是以名字選。
 * - 能力不足時**誠實說**，不假裝分析過（任務書第十八節）。
 * - 換 provider 不用改 UI。
 */
import type { ResearchResult, ResearchSource } from "./types";

// ---------------------------------------------------------------------------
// 能力
// ---------------------------------------------------------------------------

export const CAPABILITIES = [
  "text-analysis",
  "vision-analysis",
  "layout-analysis",
  "color-analysis",
  "web-research",
  "structured-output",
  "long-context",
  "tool-use",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * 能力不足的回報。
 *
 * 任務書第十八節：需要 vision 但模型不支援時，要「清楚顯示能力不足、不假裝
 * 分析過圖片、提供可以補充的資料、不阻塞文字協作」。這個型別就是那句話的
 * 資料形狀 —— UI 拿到它就知道要顯示什麼，而不是拿到一個空答案自己猜。
 */
export type CapabilityGap = {
  missing: Capability;
  /** 因此**做不到**什麼（具體，不是「功能受限」）。 */
  cannotDo: string;
  /** 使用者可以補什麼讓它變成做得到（例如「改用文字描述版面」）。 */
  workaround: string;
  /** 沒有這個能力時**仍然可用**的部分 —— 不阻塞。 */
  stillAvailable: string[];
};

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export type ProviderId = "tku-zen-agent" | "ai-os" | "mock" | (string & {});

export type ProviderStatus =
  | { state: "ready" }
  | { state: "unconfigured"; missing: string[] }
  | { state: "unavailable"; reason: string; retryable: boolean };

export type AnalysisRequest = {
  /** 需要哪些能力才能完成這次分析。 */
  needs: Capability[];
  /** 已清洗過的證據投影（**不含**原始媒體 bytes）。 */
  context: unknown;
  /** 使用者的目標（原話）。 */
  goal: string;
  /** 取消訊號。任務書第十節要求 cancellation。 */
  signal?: AbortSignal;
};

export type AnalysisResponse = {
  provider: ProviderId;
  model: string | null;
  /** 未經驗證的原始輸出 —— 呼叫端**必須**過 schema.ts 才能用。 */
  raw: unknown;
  /** 這次實際具備／缺少的能力。 */
  satisfied: Capability[];
  gaps: CapabilityGap[];
  usage: { inputTokens: number | null; outputTokens: number | null };
};

export interface DesignAnalysisProvider {
  readonly id: ProviderId;
  /** 這個 provider 宣稱有哪些能力。 */
  capabilities(): readonly Capability[];
  /** 目前可不可用（缺 env 也算一種不可用，但要說缺什麼）。 */
  status(): Promise<ProviderStatus>;
  analyze(request: AnalysisRequest): Promise<AnalysisResponse>;
}

/**
 * 依能力挑 provider。
 *
 * 規則：
 * 1. 只考慮 `status().state === "ready"` 的 provider。
 * 2. 覆蓋最多所需能力者優先；平手時取註冊順序在前的（呼叫端決定主／備）。
 * 3. **沒有任何 provider 能滿足時不丟例外**，回 `null` 並附上缺口 ——
 *    因為「AI 不能用」不該讓整個功能崩掉，只該讓那個功能顯示不可用。
 */
export async function selectProvider(
  providers: readonly DesignAnalysisProvider[],
  needs: readonly Capability[],
): Promise<{ provider: DesignAnalysisProvider | null; gaps: CapabilityGap[] }> {
  let best: { provider: DesignAnalysisProvider; score: number } | null = null;
  for (const provider of providers) {
    const status = await provider.status();
    if (status.state !== "ready") continue;
    const owned = new Set(provider.capabilities());
    const score = needs.filter((need) => owned.has(need)).length;
    if (score === 0) continue;
    if (!best || score > best.score) best = { provider, score };
    if (best.score === needs.length) break;
  }
  if (!best) {
    return {
      provider: null,
      gaps: needs.map((missing) => ({
        missing,
        cannotDo: describeCapability(missing),
        workaround: "等 provider 設定完成，或改用不需要這項能力的分析",
        stillAvailable: ["本地設計知識庫的規則檢查", "討論、白板與檔案的既有功能"],
      })),
    };
  }
  const owned = new Set(best.provider.capabilities());
  const gaps = needs
    .filter((need) => !owned.has(need))
    .map((missing) => ({
      missing,
      cannotDo: describeCapability(missing),
      workaround: workaroundFor(missing),
      stillAvailable: needs.filter((need) => owned.has(need)).map(describeCapability),
    }));
  return { provider: best.provider, gaps };
}

function describeCapability(capability: Capability): string {
  switch (capability) {
    case "vision-analysis": return "看圖片或影片畫格本身";
    case "layout-analysis": return "判斷版面配置與視覺層級";
    case "color-analysis": return "從圖片抽色與判斷色彩關係";
    case "web-research": return "查詢最新的外部規範";
    case "structured-output": return "產生可驗證的結構化提案";
    case "long-context": return "一次讀完長篇內容";
    case "tool-use": return "呼叫外部工具";
    case "text-analysis": return "分析文字內容";
    default: return capability;
  }
}

function workaroundFor(capability: Capability): string {
  switch (capability) {
    case "vision-analysis":
      return "改用文字描述畫面內容，或先讓素材理解產生結構化摘要";
    case "web-research":
      return "使用已審查的本地知識庫；設定研究服務後可查最新規範";
    case "color-analysis":
      return "手動提供主要色碼，色彩對比會由程式計算";
    default:
      return "改用不需要這項能力的分析模式";
  }
}

// ---------------------------------------------------------------------------
// 研究（外部搜尋）
// ---------------------------------------------------------------------------

export type ResearchFilters = {
  /** 官方來源優先（不是只要官方，而是排序時加權）。 */
  preferOfficial?: boolean;
  allowDomains?: string[];
  denyDomains?: string[];
  language?: string;
  /** 只要這個時間點之後發布的（毫秒）。 */
  publishedAfter?: number;
  region?: string;
  maxResults?: number;
  maxTokens?: number;
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
};

/**
 * 研究 adapter。
 *
 * **UI 不得直接依賴 Perplexity** —— 這個介面就是那條界線。
 * 沒有金鑰時 `status()` 回 `unconfigured`，其餘方法一律回可辨識的
 * disabled 結果而不是丟例外（任務書第七節：不得假裝搜尋成功）。
 */
export interface ResearchProvider {
  readonly id: string;
  status(): Promise<ProviderStatus>;
  search(query: string, filters?: ResearchFilters): Promise<ResearchResult>;
  research(question: string, context: string, filters?: ResearchFilters): Promise<ResearchResult>;
  fetchRelevantSnippets(urls: string[], query: string, filters?: ResearchFilters): Promise<ResearchSource[]>;
  verifyClaim(claim: string, filters?: ResearchFilters): Promise<ResearchResult>;
  getSources(result: ResearchResult): ResearchSource[];
  getUsage(result: ResearchResult): ResearchResult["usage"];
}

/**
 * 研究服務未設定時的統一結果。
 *
 * 刻意**不是**空字串答案 —— 空答案會被 UI 當成「AI 想不出東西」。
 * `provider: "none"` 加上 `cacheStatus: "bypass"` 讓呼叫端可以明確分辨
 * 「沒設定」與「查了但沒結果」。
 */
export function disabledResearchResult(query: string, reason: string): ResearchResult {
  return {
    requestId: "research-disabled",
    query,
    answer: "",
    findings: [],
    sources: [],
    retrievedAt: 0,
    provider: "none",
    model: null,
    confidence: 0,
    conflicts: [],
    usage: { inputTokens: null, outputTokens: null, requests: 0 },
    cost: { amount: null, currency: null, estimated: false },
    cacheStatus: "bypass",
    // 附註不放進 answer，避免被當成 AI 的回答顯示給使用者
    ...({ disabledReason: reason } as Record<string, unknown>),
  } as ResearchResult;
}

/** 研究結果是不是「服務沒設定」而不是「查不到」。 */
export function isResearchDisabled(result: ResearchResult): boolean {
  return result.provider === "none";
}
