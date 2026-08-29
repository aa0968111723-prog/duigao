/**
 * Design Intelligence — 前端研究層（PR-DI-03）
 *
 * **這個檔案沒有金鑰，也不可能有。** 它呼叫 `design-research` edge function，
 * 金鑰只存在那一端。前端是 Vite 打包，任何 `VITE_` 開頭的變數都會被寫進
 * bundle 讓所有訪客看到 —— 所以「把金鑰放前端」不是風格問題，是外洩。
 *
 * 這一層負責的是**省錢與不卡住使用者**：
 *
 *  - 快取：同一個問題不重複付費。
 *  - 去重：兩個人同時問同一件事只送一次。
 *  - 斷路器：上游連續失敗時直接停，不要每次都等 timeout。
 *  - 功能旗標：可以整個關掉，而且關掉之後其他功能完全不受影響。
 *  - 取消：使用者關掉面板就不該再等。
 *
 * 後端也有一份配額。兩邊都要有，理由不同：前端這份是為了不浪費（省掉根本
 * 不必送的請求），後端那份是為了守住（前端的檢查改一行 JS 就繞過了）。
 */
import { buildResearchQuery, quoteUntrusted, trustForExternal } from "./sanitize";
import { disabledResearchResult, type ProviderStatus, type ResearchFilters, type ResearchProvider } from "./providers";
import { parseResearchSources } from "./schema";
import type { DesignTargetType, ResearchResult, ResearchSource } from "./types";

/** 呼叫後端的方式。注入進來讓這一層可以完全離線測試。 */
export type ResearchTransport = (
  body: { roomId: string; query: string; timeoutMs?: number },
  signal?: AbortSignal,
) => Promise<{ status: number; body: Record<string, unknown> }>;

export type ResearchProviderOptions = {
  roomId: string;
  transport: ResearchTransport;
  now: () => number;
  /** 功能旗標。關掉時所有方法都回可辨識的 disabled 結果，不丟例外。 */
  enabled?: boolean;
  /** 快取存活時間。設計規範不會每小時變，預設一天。 */
  cacheTtlMs?: number;
  /** 前端這一側的每日上限（省錢用；真正的閘門在後端）。 */
  dailyLimit?: number;
  /** 連續失敗幾次後開啟斷路器。 */
  circuitThreshold?: number;
  /** 斷路器開啟後多久再試一次。 */
  circuitCooldownMs?: number;
};

type CacheEntry = { result: ResearchResult; storedAt: number };

export type ResearchDiagnostics = {
  cacheSize: number;
  inFlight: number;
  todayCount: number;
  circuitOpen: boolean;
  consecutiveFailures: number;
};

const DEFAULTS = {
  cacheTtlMs: 24 * 60 * 60 * 1000,
  dailyLimit: 40,
  circuitThreshold: 3,
  circuitCooldownMs: 5 * 60 * 1000,
};

/** 給 UI 顯示的、可辨識的失敗種類。空答案不算失敗訊息。 */
export type ResearchFailure =
  | "not-configured"
  | "quota-exceeded"
  | "blocked-outbound"
  | "not-a-member"
  | "upstream-error"
  | "timeout"
  | "circuit-open"
  | "disabled";

/** 附在 ResearchResult 上的額外欄位（型別不變，用 as 附掛，與 disabledResearchResult 同慣例）。 */
export type ResearchResultMeta = {
  failure?: ResearchFailure;
  failureDetail?: string;
  retryable?: boolean;
  /** 這次回來的內容命中了哪些 prompt injection 樣式。 */
  suspicious?: string[];
  /** 出站掃描擋下了什麼（種類，不含實際值）。 */
  blocked?: string[];
};

export function failureOf(result: ResearchResult): ResearchFailure | null {
  return (result as ResearchResult & ResearchResultMeta).failure ?? null;
}

export function suspiciousOf(result: ResearchResult): string[] {
  return (result as ResearchResult & ResearchResultMeta).suspicious ?? [];
}

function withMeta(result: ResearchResult, meta: ResearchResultMeta): ResearchResult {
  return { ...result, ...meta } as ResearchResult;
}

function emptyResult(query: string, now: number, meta: ResearchResultMeta): ResearchResult {
  return withMeta(
    {
      requestId: "research-failed",
      query,
      answer: "",
      findings: [],
      sources: [],
      retrievedAt: now,
      provider: "perplexity",
      model: null,
      confidence: 0,
      conflicts: [],
      usage: { inputTokens: null, outputTokens: null, requests: 0 },
      cost: { amount: null, currency: null, estimated: false },
      cacheStatus: "bypass",
    } as ResearchResult,
    meta,
  );
}

export function createResearchProvider(options: ResearchProviderOptions): ResearchProvider & {
  diagnostics(): ResearchDiagnostics;
  clearCache(): void;
} {
  const config = { ...DEFAULTS, ...options };
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<ResearchResult>>();
  const requestTimes: number[] = [];
  let consecutiveFailures = 0;
  let circuitOpenedAt = 0;

  const enabled = () => options.enabled !== false;

  const pruneRequestTimes = (now: number) => {
    const cutoff = now - 24 * 60 * 60 * 1000;
    while (requestTimes.length && requestTimes[0] < cutoff) requestTimes.shift();
  };

  const circuitIsOpen = (now: number) => {
    if (!circuitOpenedAt) return false;
    if (now - circuitOpenedAt >= config.circuitCooldownMs) {
      // 冷卻結束：半開，讓下一個請求試試看
      circuitOpenedAt = 0;
      consecutiveFailures = 0;
      return false;
    }
    return true;
  };

  const recordFailure = (now: number) => {
    consecutiveFailures += 1;
    if (consecutiveFailures >= config.circuitThreshold && !circuitOpenedAt) {
      circuitOpenedAt = now;
    }
  };

  async function run(
    question: string,
    targetType: DesignTargetType,
    filters?: ResearchFilters,
    /** 通用設計詞彙（「無障礙對比」）。**不得**是房間內容；出站掃描會再驗一次。 */
    topics?: readonly string[],
  ): Promise<ResearchResult> {
    const now = options.now();

    if (!enabled()) {
      return withMeta(disabledResearchResult(question, "研究功能已關閉"), { failure: "disabled" });
    }

    // 出站掃描在送出之前。掃到金鑰就**拒絕**，不遮掉再送。
    const built = buildResearchQuery({ question, targetType, topics });
    if (!built.ok) {
      // **不把原始問題放進結果**。它就是那個含著金鑰的字串 ——
      // 帶回去等於讓它進到 UI 狀態、log、甚至被存進 IndexedDB。
      // 測試抓到的：一開始這裡傳的是 `question`。
      return withMeta(emptyResult("（已停止送出：內容含不應外流的資訊）", now, {}), {
        failure: "blocked-outbound",
        failureDetail: built.reason,
        blocked: built.blocked,
        retryable: false,
      });
    }
    const query = built.query;

    // 快取
    const cached = cache.get(query);
    if (cached && now - cached.storedAt < config.cacheTtlMs) {
      return { ...cached.result, cacheStatus: "hit" };
    }
    if (cached) cache.delete(query);

    if (circuitIsOpen(now)) {
      return withMeta(emptyResult(query, now, {}), {
        failure: "circuit-open",
        failureDetail: "外部研究服務連續失敗，已暫停呼叫。稍後會自動再試一次。",
        retryable: true,
      });
    }

    pruneRequestTimes(now);
    if (requestTimes.length >= config.dailyLimit) {
      return withMeta(emptyResult(query, now, {}), {
        failure: "quota-exceeded",
        failureDetail: `今天的外部研究次數已達上限（${config.dailyLimit} 次）`,
        retryable: false,
      });
    }

    // 去重：同一個問題正在查就共用那一次
    const pending = inFlight.get(query);
    if (pending) return pending.then((result) => ({ ...result, cacheStatus: "dedup" as const }));

    const task = (async (): Promise<ResearchResult> => {
      requestTimes.push(now);
      let response: { status: number; body: Record<string, unknown> };
      try {
        response = await options.transport(
          { roomId: options.roomId, query, timeoutMs: filters?.timeoutMs },
          filters?.signal,
        );
      } catch (error) {
        recordFailure(now);
        const aborted = error instanceof Error && error.name === "AbortError";
        return withMeta(emptyResult(query, now, {}), {
          failure: aborted ? "timeout" : "upstream-error",
          failureDetail: aborted ? "研究請求已取消或逾時" : "無法連線到研究服務",
          retryable: true,
        });
      }

      if (response.status === 503) {
        // 沒設定不算失敗 —— 斷路器不該因為「沒裝」而累積
        return withMeta(disabledResearchResult(query, "研究服務尚未設定"), {
          failure: "not-configured",
          failureDetail: "外部研究服務尚未設定。其餘設計分析功能不受影響。",
          retryable: false,
        });
      }
      if (response.status === 403) {
        return withMeta(emptyResult(query, now, {}), { failure: "not-a-member", retryable: false });
      }
      if (response.status === 422) {
        return withMeta(emptyResult(query, now, {}), {
          failure: "blocked-outbound",
          blocked: Array.isArray(response.body.blocked) ? (response.body.blocked as string[]) : [],
          retryable: false,
        });
      }
      if (response.status === 429) {
        return withMeta(emptyResult(query, now, {}), {
          failure: "quota-exceeded",
          failureDetail: typeof response.body.detail === "string" ? response.body.detail : undefined,
          retryable: false,
        });
      }
      if (response.status !== 200) {
        recordFailure(now);
        return withMeta(emptyResult(query, now, {}), {
          failure: response.status === 504 ? "timeout" : "upstream-error",
          retryable: true,
        });
      }

      consecutiveFailures = 0;
      const answer = quoteUntrusted(response.body.answer, 4000);
      const sources = parseResearchSources(response.body.sources);
      const usage = (response.body.usage ?? {}) as Record<string, unknown>;

      const result: ResearchResult = withMeta(
        {
          requestId: typeof response.body.requestId === "string" ? response.body.requestId : `res-${now}`,
          query,
          answer: answer.text,
          findings: [],
          sources: sources.value,
          retrievedAt: now,
          provider: "perplexity",
          model: typeof response.body.model === "string" ? response.body.model : null,
          // 外部搜尋的信心永遠不會滿：它是引用資料，不是已審查的知識。
          // 命中 injection 樣式時再往下壓。
          confidence: answer.suspicious.length ? 0.2 : 0.6,
          conflicts: [],
          usage: {
            inputTokens: typeof usage.inputTokens === "number" ? usage.inputTokens : null,
            outputTokens: typeof usage.outputTokens === "number" ? usage.outputTokens : null,
            requests: 1,
          },
          cost: { amount: null, currency: null, estimated: false },
          cacheStatus: "miss",
        } as ResearchResult,
        { suspicious: answer.suspicious },
      );

      cache.set(query, { result, storedAt: now });
      return result;
    })();

    inFlight.set(query, task);
    try {
      return await task;
    } finally {
      inFlight.delete(query);
    }
  }

  return {
    id: "perplexity",

    async status(): Promise<ProviderStatus> {
      if (!enabled()) return { state: "unavailable", reason: "研究功能已關閉", retryable: false };
      if (circuitIsOpen(options.now())) {
        return { state: "unavailable", reason: "連續失敗，暫停呼叫中", retryable: true };
      }
      // 前端不知道後端有沒有金鑰 —— 那是後端的事，而且**故意**不提供一個
      // 「有沒有金鑰」的查詢端點：那種端點本身就是在對外宣告設定狀態。
      // 第一次真的呼叫時會拿到 503，那時才知道。
      return { state: "ready" };
    },

    search: (query, filters) => run(query, "website", filters),
    research: (question, _context, filters) => run(question, "website", filters),
    verifyClaim: (claim, filters) => run(claim, "website", filters),

    /**
     * **刻意不實作**。見 `providers.ts` 的說明：要抓任意外部網址，必須在 DNS
     * 解析出 IP 之後、建立連線之前再檢查一次那個 IP 是不是內網 ——
     * 字串層的檢查做不到（`lvh.me` 字串完全正常，A record 指向 127.0.0.1），
     * 而且合法網域的 3xx 可以把請求導進 metadata endpoint。
     *
     * 回空陣列並在文件裡說清楚，比做一個擋不住的版本誠實。
     */
    async fetchRelevantSnippets(): Promise<ResearchSource[]> {
      return [];
    },

    getSources: (result) => result.sources,
    getUsage: (result) => result.usage,

    diagnostics(): ResearchDiagnostics {
      const now = options.now();
      pruneRequestTimes(now);
      return {
        cacheSize: cache.size,
        inFlight: inFlight.size,
        todayCount: requestTimes.length,
        circuitOpen: Boolean(circuitOpenedAt) && now - circuitOpenedAt < config.circuitCooldownMs,
        consecutiveFailures,
      };
    },

    clearCache() {
      cache.clear();
    },
  };
}

/**
 * 外部研究結果轉成知識條目的候選。
 *
 * **永遠**是 `machine-researched` / `machine` 或更低 —— 任務書：Perplexity 的
 * 結果不能直接被提升為 approved。要升級只能經過人工審查那條路
 * （`parseKnowledgeEntry(raw, "human-review")`）。
 */
export function researchToKnowledgeCandidates(
  result: ResearchResult,
  category: string,
): Array<Record<string, unknown>> {
  if (!result.answer.trim()) return [];
  const quoted = quoteUntrusted(result.answer, 800);
  return [
    {
      category,
      title: `外部研究：${result.query.slice(0, 60)}`,
      summary: quoted.text.slice(0, 400),
      // 整段答案當成**一條**規則，不拆句 —— 拆句會讓上下文與限制條件掉光，
      // 而外部內容的限制條件往往就是最重要的部分。
      rules: [quoted.text.slice(0, 400)],
      sourceUrl: result.sources[0]?.url ?? null,
      sourceTitle: result.sources[0]?.title ?? null,
      sourceType: result.sources[0]?.sourceType ?? "unknown",
      publisher: result.sources[0]?.publisher ?? null,
      retrievedAt: result.retrievedAt,
      status: "machine-researched",
      trustLevel: trustForExternal(quoted),
    },
  ];
}
