/**
 * design-research — 外部設計研究的**唯一**出口（PR-DI-03）
 *
 * 為什麼一定要有這支函式：`PERPLEXITY_API_KEY` 只能存在後端。前端是
 * Vite 打包，任何 `VITE_` 開頭的變數都會被寫進 bundle 讓所有訪客看到。
 * 所以前端不呼叫 Perplexity，前端呼叫這裡。
 *
 * 這支函式負責四件前端做不到（或做了也沒用）的事：
 *
 *  1. **持有金鑰**。金鑰不出現在任何回應裡 —— 連錯誤訊息都不行。
 *  2. **驗證呼叫者是房間成員**。前端的配額檢查一律可以被繞過（改 JS 就好），
 *     所以配額必須在這裡算，用 service role 寫進 append-only 的使用量表。
 *  3. **再掃一次出站內容**。前端已經掃過，但前端的掃描器可以被繞過。
 *     同一套規則在這裡再跑一次 —— 深度防禦，而不是「前端已經檢查過了」。
 *  4. **正規化回應**。Perplexity 的欄位形狀是它的事；本專案的
 *     `ResearchResult` 是這裡定義的。
 *
 * 沒有金鑰時回 503 + `RESEARCH_NOT_CONFIGURED`，**不是**假裝成功回一個空答案。
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  // supabase-js 的每次 invoke 都會帶 x-client-info 與 apikey，
  // 漏掉任何一個瀏覽器會在預檢就擋下（正式站踩過，見 edge-cors.test.mjs）。
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-max-age": "86400",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// 出站掃描：與前端 `src/features/design-intelligence/sanitize.ts` 同一套規則。
//
// 刻意重複而不是共用：edge function 跑在 Deno、前端跑在瀏覽器，而
// `_shared/` 只在 Deno 端。真正的理由是**信任邊界不同** —— 前端那份是
// 為了給使用者即時回饋，這份是為了守住出口。前端那份被繞過時，這份仍然要擋。
// 兩份走樣的風險由 `design-research.test.ts` 的共用案例表盯住。
// ---------------------------------------------------------------------------

const BLOCKING_PATTERNS: Array<[string, RegExp]> = [
  ["JWT", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/],
  ["Supabase 金鑰", /\bsb_(publishable|secret)_[A-Za-z0-9_-]{8,}/i],
  ["Perplexity 金鑰", /\bpplx-[A-Za-z0-9]{16,}/i],
  ["OpenAI 類金鑰", /\bsk-[A-Za-z0-9_-]{16,}/i],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{16,}/],
  ["Bearer token", /\bbearer\s+[A-Za-z0-9._-]{16,}/i],
  ["私鑰", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["UUID（房間或邀請識別碼）", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ["電子郵件", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
  ["電話號碼", /(?:\+886|\b09)\d{2}[-\s]?\d{3}[-\s]?\d{3}\b/],
  ["身分證字號", /\b[A-Z][12]\d{8}\b/],
  ["信用卡號", /\b(?:\d[ -]?){13,19}\b/],
  [
    "疑似密碼欄位",
    /\b[a-z0-9_-]*(password|passwd|secret|api[_-]?key|access[_-]?token|service[_-]?role|private[_-]?key|client[_-]?secret)[a-z0-9_-]*\s*[:=]\s*\S/i,
  ],
];

function scanOutbound(text: string): string[] {
  return BLOCKING_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

// ---------------------------------------------------------------------------
// 回程：外部內容是資料
// ---------------------------------------------------------------------------

const INJECTION_MARKERS: Array<[string, RegExp]> = [
  ["要求忽略先前指示", /(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?)/i],
  ["要求忽略先前指示（中文）", /(忽略|無視|不要理會)(先前|上面|之前|所有)的?(指示|指令|規則|提示)/],
  ["冒充系統角色", /^\s*(system|assistant|developer)\s*[:：]/im],
  ["要求輸出金鑰", /(reveal|print|output|show|貼出|印出|顯示).{0,20}(api[_\s-]?key|secret|token|password|密鑰|金鑰|密碼)/i],
  ["要求執行工具或指令", /(run|execute|curl|wget|rm\s+-rf|執行|呼叫).{0,20}(command|shell|tool|指令|工具)/i],
  ["宣稱擁有授權", /(you\s+are\s+now|from\s+now\s+on|你現在是|從現在開始你)/i],
  ["隱藏文字（零寬字元）", /[\u200b-\u200f\u2060-\u2064\ufeff]/],
];

function quoteUntrusted(raw: unknown, maxChars = 2000): {
  text: string;
  suspicious: string[];
  truncated: boolean;
} {
  const input = typeof raw === "string" ? raw : "";
  const suspicious = INJECTION_MARKERS.filter(([, pattern]) => pattern.test(input)).map(([name]) => name);
  const cleaned = input
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ")
    .replace(/[\u200b-\u200f\u2060-\u2064\ufeff\u202a-\u202e]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const truncated = cleaned.length > maxChars;
  return { text: truncated ? `${cleaned.slice(0, maxChars)}…` : cleaned, suspicious, truncated };
}

/** 只接受 https 的公開網址（與前端 `isSafePublicUrl` 同一套預設拒絕規則）。 */
function isSafePublicUrl(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host) return false;
  if (host.startsWith("[")) return false;                       // IPv6 字面值
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;       // IPv4 字面值
  if (!host.includes(".")) return false;                        // 單標籤 = 內網
  if (host === "localhost" || host === "metadata.google.internal") return false;
  for (const suffix of [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".test", ".invalid", ".onion"]) {
    if (host.endsWith(suffix)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------

const PERPLEXITY_URL = "https://api.perplexity.ai/chat/completions";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 45_000;
/** 每個房間每天的請求上限。超過就停 —— 帳單不會自己停。 */
const DAILY_ROOM_LIMIT = 40;

type Row = Record<string, unknown>;

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return jsonResponse(405, { error: "METHOD_NOT_ALLOWED" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const apiKey = Deno.env.get("PERPLEXITY_API_KEY") ?? "";

  let body: Row;
  try {
    body = (await request.json()) as Row;
  } catch {
    return jsonResponse(400, { error: "INVALID_JSON" });
  }

  const roomId = text(body.roomId).trim();
  const query = text(body.query).trim();
  if (!roomId || !query) {
    return jsonResponse(400, { error: "MISSING_FIELDS", detail: "roomId 與 query 皆為必填" });
  }
  if (query.length > 500) {
    return jsonResponse(400, { error: "QUERY_TOO_LONG", detail: "查詢字串上限 500 字" });
  }

  // ---- 出站掃描（第二道；前端那道可以被繞過）----
  const blocked = scanOutbound(query);
  if (blocked.length) {
    // 回報種類，不回報實際值 —— 把密鑰複製到回應裡只是換一個地方外洩。
    return jsonResponse(422, {
      error: "OUTBOUND_BLOCKED",
      blocked,
      detail: "查詢字串包含不應該送到外部搜尋的內容，已停止送出",
    });
  }

  // ---- 授權：呼叫者必須是這個房間的成員 ----
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization) return jsonResponse(401, { error: "UNAUTHENTICATED" });

  const asCaller = createClient(supabaseUrl, anonKey, {
    global: { headers: { authorization } },
    auth: { persistSession: false },
  });
  const { data: membership, error: membershipError } = await asCaller
    .from("room_members")
    .select("user_id")
    .eq("room_id", roomId)
    .limit(1);
  if (membershipError) {
    // **查詢失敗不等於不是成員。** 把資料庫故障回成 403 NOT_A_MEMBER，
    // 使用者會以為自己被踢出房間，而真正的問題（DB 掛了）沒有人知道。
    // 兩種情況都不會送出外部請求（失敗封閉），但訊息必須分得出來。
    return jsonResponse(503, {
      error: "MEMBERSHIP_CHECK_FAILED",
      detail: "無法確認你的房間成員身分，請稍後再試（這不是權限問題）",
      retryable: true,
    });
  }
  if (!membership || membership.length === 0) {
    // RLS 讓非成員讀到空集合，而不是錯誤 —— 空集合才是「不是成員」。
    return jsonResponse(403, { error: "NOT_A_MEMBER" });
  }

  // ---- 沒有金鑰：誠實回報，不假裝成功 ----
  if (!apiKey) {
    return jsonResponse(503, {
      error: "RESEARCH_NOT_CONFIGURED",
      detail: "外部研究服務尚未設定。其餘設計分析功能不受影響。",
    });
  }

  // ---- 配額：在後端算，寫進 append-only 的使用量表 ----
  const admin = serviceKey ? createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } }) : null;
  if (!admin) {
    // 沒有 service role key 就記不了用量，記不了用量就算不出配額 ——
    // 那等於沒有上限。外部搜尋是要付錢的，所以這裡選擇**停下來**
    // 而不是放行（對抗審查指出舊版是整段跳過，等於無限額度）。
    return jsonResponse(503, {
      error: "QUOTA_UNAVAILABLE",
      detail: "無法記錄使用量，因此暫停外部研究以免產生無上限的費用",
      retryable: false,
    });
  }
  {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count, error: countError } = await admin
      .from("design_research_usage")
      .select("id", { count: "exact", head: true })
      .eq("room_id", roomId)
      .gte("created_at", since);
    if (countError || typeof count !== "number") {
      // 同上：算不出用量就不放行。
      return jsonResponse(503, {
        error: "QUOTA_UNAVAILABLE",
        detail: "無法讀取使用量，因此暫停外部研究以免產生無上限的費用",
        retryable: true,
      });
    }
    if (count >= DAILY_ROOM_LIMIT) {
      return jsonResponse(429, {
        error: "QUOTA_EXCEEDED",
        detail: `這個房間今天的外部研究次數已達上限（${DAILY_ROOM_LIMIT} 次）`,
        used: count,
        limit: DAILY_ROOM_LIMIT,
      });
    }
  }

  // ---- 呼叫 Perplexity ----
  const timeoutMs = Math.min(
    typeof body.timeoutMs === "number" && body.timeoutMs > 0 ? body.timeoutMs : DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  let upstream: Response;
  try {
    upstream = await fetch(PERPLEXITY_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: text(body.model, "sonar"),
        messages: [
          {
            role: "system",
            content:
              "你是設計研究助理。只回答設計、排版、色彩、無障礙與品牌相關的公開規範與實務。" +
              "回答時務必附上來源網址。不要推測，查不到就說查不到。",
          },
          { role: "user", content: query },
        ],
        max_tokens: 900,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    const aborted = error instanceof Error && error.name === "AbortError";
    return jsonResponse(aborted ? 504 : 502, {
      error: aborted ? "RESEARCH_TIMEOUT" : "RESEARCH_UPSTREAM_ERROR",
      // 上游的錯誤訊息可能含有請求內容 —— 只回類別，不回原文。
      detail: aborted ? `外部研究超過 ${timeoutMs}ms 未回應` : "外部研究服務無法連線",
      retryable: true,
    });
  }
  clearTimeout(timer);

  if (!upstream.ok) {
    return jsonResponse(upstream.status === 429 ? 429 : 502, {
      error: upstream.status === 429 ? "UPSTREAM_RATE_LIMITED" : "RESEARCH_UPSTREAM_ERROR",
      detail: `外部研究服務回應 ${upstream.status}`,
      retryable: upstream.status === 429 || upstream.status >= 500,
    });
  }

  let payload: Row;
  try {
    payload = (await upstream.json()) as Row;
  } catch {
    return jsonResponse(502, { error: "RESEARCH_BAD_RESPONSE", detail: "外部研究服務回了無法解析的內容" });
  }

  // ---- 正規化 ----
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = (choices[0] ?? {}) as Row;
  const message = (first.message ?? {}) as Row;
  const answer = quoteUntrusted(message.content, 4000);

  const rawCitations = Array.isArray(payload.citations) ? payload.citations : [];
  const seen = new Set<string>();
  const sources = rawCitations
    .map((citation) => (typeof citation === "string" ? citation : text((citation as Row)?.url)))
    .filter((url) => isSafePublicUrl(url))
    .filter((url) => (seen.has(url) ? false : (seen.add(url), true)))
    .slice(0, 12)
    .map((url, index) => ({
      id: `src-${index + 1}`,
      url,
      title: null,
      publisher: null,
      publishedAt: null,      // 上游沒給就是 null，不用取得時間冒充
      retrievedAt: Date.now(),
      sourceType: "unknown",
      excerpt: null,
    }));

  const usage = (payload.usage ?? {}) as Row;

  // ---- 記錄使用量（append-only；失敗不擋回應，但要說）----
  // 寫入失敗時 `usageLogged: false` 會回給前端。這件事**必須被看見**：
  // 一直寫不進去代表配額實際上是失效的。
  let usageLogged = false;
  {
    const { error: logError } = await admin.from("design_research_usage").insert({
      room_id: roomId,
      query_hash: await sha256Hex(query),
      input_tokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null,
      output_tokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : null,
      latency_ms: Date.now() - startedAt,
      source_count: sources.length,
      suspicious_count: answer.suspicious.length,
    });
    usageLogged = !logError;
  }

  return jsonResponse(200, {
    query,
    // 外部回來的文字**永遠**是被引用的資料。呼叫端不得把它接進 prompt。
    answer: answer.text,
    answerSuspicious: answer.suspicious,
    answerTruncated: answer.truncated,
    sources,
    provider: "perplexity",
    model: text(payload.model, null as unknown as string) || null,
    retrievedAt: Date.now(),
    usage: {
      inputTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null,
      outputTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : null,
      requests: 1,
    },
    latencyMs: Date.now() - startedAt,
    usageLogged,
  });
});

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
