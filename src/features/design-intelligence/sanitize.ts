/**
 * Design Intelligence — 外部搜尋的雙向安全層（PR-DI-03）
 *
 * 兩個方向，兩種威脅：
 *
 * **出去**（任務書第九節）：不得把私人房間的完整討論、未公開影片、個資、
 * token、密碼、邀請密鑰、Canva secret、Supabase service role key、原始私人
 * 附件、尚未公開的商業企劃送到 Perplexity。
 *
 * 這裡**不用黑名單過濾**當主要手段。理由：黑名單永遠列不完，而「漏掉一個
 * 正則」的代價是私人企劃被送到第三方。改用**白名單建構** ——
 * `buildResearchQuery` 只接受幾個明確欄位，房間內容根本沒有欄位可以進來。
 * 正則掃描只作為第二道，而且掃到高風險字串時是**拒絕送出**，不是偷偷遮掉
 * 再送 —— 把密碼遮成 `[已移除]` 再送出去，仍然送出了一次請求，
 * 而且使用者不知道自己差點外洩。
 *
 * **回來**（任務書第九節）：外部內容只能作為「引用資料」，不能改寫 system
 * prompt、工具權限或開發規則。`quoteUntrusted` 是那條界線。
 */

/** 出站掃描的結果。 */
export type OutboundScan = {
  /** 可以送出去嗎。 */
  safe: boolean;
  /**
   * 掃到的高風險內容種類（不含實際值 —— 把密鑰複製到錯誤訊息、log 或
   * 畫面上，只是換一個地方外洩）。
   */
  blocked: string[];
  /** 低風險但已移除的東西（例如網址）。 */
  redacted: string[];
};

/**
 * 高風險樣式。掃到就**拒絕送出**。
 *
 * 這裡刻意包含 UUID：房間 id 是 UUID，而邀請連結是
 * `#room=<uuid>&invite=<token>` —— 把房間 id 送到外部搜尋沒有任何研究價值，
 * 卻讓第三方拿到一個可以跟邀請連結對起來的識別碼。
 */
const BLOCKING_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/ },
  { name: "Supabase 金鑰", pattern: /\bsb_(publishable|secret)_[A-Za-z0-9_-]{8,}/i },
  { name: "Perplexity 金鑰", pattern: /\bpplx-[A-Za-z0-9]{16,}/i },
  { name: "OpenAI 類金鑰", pattern: /\bsk-[A-Za-z0-9_-]{16,}/i },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/ },
  { name: "Bearer token", pattern: /\bbearer\s+[A-Za-z0-9._-]{16,}/i },
  { name: "私鑰", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "UUID（房間或邀請識別碼）", pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
  { name: "電子郵件", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { name: "電話號碼", pattern: /(?:\+886|\b09)\d{2}[-\s]?\d{3}[-\s]?\d{3}\b/ },
  { name: "身分證字號", pattern: /\b[A-Z][12]\d{8}\b/ },
  { name: "信用卡號", pattern: /\b(?:\d[ -]?){13,19}\b/ },
  {
    name: "疑似密碼欄位",
    // 前後都用識別字通配，不用 \b 貼著關鍵字：
    // SUPABASE_SERVICE_ROLE_KEY 這種真實寫法兩頭都會被卡住 ——
    // 前面的 E_S 之間沒有邊界，後面的 _KEY 也沒有。兩次都是測試抓到的。
    // 代價是 mysecretsauce = 1 這種也會命中；安全閘門寧可誤擋。
    pattern:
      /\b[a-z0-9_-]*(password|passwd|secret|api[_-]?key|access[_-]?token|service[_-]?role|private[_-]?key|client[_-]?secret)[a-z0-9_-]*\s*[:=]\s*\S/i,
  },
];

/** 低風險：移除即可，不必拒絕。 */
const REDACT_PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }> = [
  // 網址可能帶 query token，而研究問題本身不需要使用者貼網址
  { name: "網址", pattern: /https?:\/\/\S+/gi, replacement: "［網址已移除］" },
];

/** 掃描一段要送出去的文字。 */
export function scanOutbound(text: string): OutboundScan {
  const blocked: string[] = [];
  for (const { name, pattern } of BLOCKING_PATTERNS) {
    if (pattern.test(text)) blocked.push(name);
  }
  const redacted: string[] = [];
  for (const { name, pattern } of REDACT_PATTERNS) {
    if (new RegExp(pattern.source, pattern.flags.replace("g", "")).test(text)) redacted.push(name);
  }
  return { safe: blocked.length === 0, blocked, redacted };
}

function redact(text: string): string {
  let result = text;
  for (const { pattern, replacement } of REDACT_PATTERNS) {
    result = result.replace(new RegExp(pattern.source, pattern.flags), replacement);
  }
  return result;
}

export type ResearchQueryInput = {
  /** 使用者的問題（原話）。唯一的自由文字欄位。 */
  question: string;
  /** 作品類型。從固定詞彙表來，不是自由文字。 */
  targetType: "poster" | "video" | "plan" | "website" | "board";
  /**
   * 設計主題關鍵字。**只能是通用設計詞彙**（「無障礙對比」「行動裝置排版」），
   * 不得是房間內容。呼叫端要為此負責，這裡再掃一次。
   */
  topics?: readonly string[];
};

export type ResearchQueryResult =
  | { ok: true; query: string; redacted: string[] }
  | { ok: false; blocked: string[]; reason: string };

const TARGET_WORDS: Record<ResearchQueryInput["targetType"], string> = {
  poster: "平面海報設計",
  video: "影片與分鏡設計",
  plan: "簡報與企劃文件設計",
  website: "網頁介面設計",
  board: "白板與視覺協作",
};

/**
 * 建構要送出去的查詢字串。
 *
 * **白名單**：只有 `question`、固定詞彙表的 `targetType`、以及 `topics`
 * 會出現在輸出裡。房間的討論、附件、成員、企劃內容**沒有欄位可以進來** ——
 * 這是結構上的保證，不是靠過濾。
 *
 * 掃到高風險內容時回 `ok: false` 而**不送出**。呼叫端要把 `blocked` 顯示給
 * 使用者：「你的問題裡有一段看起來像金鑰，我沒有送出去」比偷偷遮掉好。
 */
export function buildResearchQuery(input: ResearchQueryInput): ResearchQueryResult {
  const parts = [input.question, ...(input.topics ?? [])].join(" ");
  const scan = scanOutbound(parts);
  if (!scan.safe) {
    return {
      ok: false,
      blocked: scan.blocked,
      reason: `問題裡包含不應該送到外部搜尋的內容（${scan.blocked.join("、")}），已停止送出`,
    };
  }
  const topics = (input.topics ?? []).map((topic) => topic.trim()).filter(Boolean).slice(0, 6);
  const query = [
    redact(input.question).trim(),
    TARGET_WORDS[input.targetType],
    ...topics.map(redact),
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 500);
  return { ok: true, query, redacted: scan.redacted };
}

// ---------------------------------------------------------------------------
// 回程：外部內容是資料，不是指令
// ---------------------------------------------------------------------------

/**
 * 看起來像「想改寫系統指令」的字樣。
 *
 * 這**不是**過濾器 —— 過濾了還是會漏，而且改寫過的內容會失真。它的用途是
 * **標記**：命中時把這段內容標成可疑，讓 UI 顯示警告、讓知識庫拒絕升級信任
 * 等級。真正的防線是 `quoteUntrusted` 的結構（外部內容永遠在引用區塊內）
 * 加上「外部來源一律 trustLevel: unverified」。
 */
const INJECTION_MARKERS: Array<{ name: string; pattern: RegExp }> = [
  { name: "要求忽略先前指示", pattern: /(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?)/i },
  { name: "要求忽略先前指示（中文）", pattern: /(忽略|無視|不要理會)(先前|上面|之前|所有)的?(指示|指令|規則|提示)/ },
  { name: "冒充系統角色", pattern: /^\s*(system|assistant|developer)\s*[:：]/im },
  { name: "要求輸出金鑰", pattern: /(reveal|print|output|show|貼出|印出|顯示).{0,20}(api[_\s-]?key|secret|token|password|密鑰|金鑰|密碼)/i },
  { name: "要求執行工具或指令", pattern: /(run|execute|curl|wget|rm\s+-rf|執行|呼叫).{0,20}(command|shell|tool|指令|工具)/i },
  { name: "宣稱擁有授權", pattern: /(you\s+are\s+now|from\s+now\s+on|你現在是|從現在開始你)/i },
  { name: "隱藏文字（零寬字元）", pattern: /[\u200b-\u200f\u2060-\u2064\ufeff]/ },
];

export type UntrustedContent = {
  /** 可以安全顯示與引用的文字。 */
  text: string;
  /** 命中的可疑樣式。非空時 UI 必須顯示警告。 */
  suspicious: string[];
  /** 是否被截斷。 */
  truncated: boolean;
};

/**
 * 把外部抓回來的內容變成**可引用的資料**。
 *
 * 做三件事：
 *  1. 移除控制字元與零寬字元（隱藏指令最常見的載體）。
 *  2. 標記看起來像 prompt injection 的段落。
 *  3. 截斷。
 *
 * 刻意**不移除**可疑內容本身：使用者有權看到那個網頁到底寫了什麼，
 * 而且悄悄刪掉會讓人以為來源是乾淨的。標記 + 引用結構才是防線。
 */
export function quoteUntrusted(raw: unknown, maxChars = 2000): UntrustedContent {
  const input = typeof raw === "string" ? raw : "";
  const suspicious: string[] = [];
  for (const { name, pattern } of INJECTION_MARKERS) {
    if (pattern.test(input)) suspicious.push(name);
  }
  // 控制字元、零寬字元、雙向覆寫字元（可以讓顯示出來的文字與實際內容不同）
  const cleaned = input
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ")
    .replace(/[\u200b-\u200f\u2060-\u2064\ufeff\u202a-\u202e]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const truncated = cleaned.length > maxChars;
  return {
    text: truncated ? `${cleaned.slice(0, maxChars)}…` : cleaned,
    suspicious,
    truncated,
  };
}

/**
 * 外部內容**永遠**不能直接成為已核准的知識。
 *
 * 這個函式回傳的是「這段外部內容最高能被信任到什麼程度」，答案永遠是
 * `unverified`（可疑）或 `machine`（不可疑）。任務書：「Perplexity 的結果
 * 不能直接被提升為 approved」。
 */
export function trustForExternal(content: UntrustedContent): "machine" | "unverified" {
  return content.suspicious.length > 0 ? "unverified" : "machine";
}
