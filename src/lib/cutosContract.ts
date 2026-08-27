/**
 * CUTOS S2S 契約的 duigao 側鏡像（PR-07 第一階段，ADR-005 v2）。
 *
 * 來源是 CUTOS repo 的實際 wire 契約（github.com/aa0968111723-prog/CUTOS，
 * packages/protocol/src/protocol.ts＋apps/web/server/aios-capabilities.ts），
 * 不是猜測。這裡只鏡射 duigao 用得到的最小子集：
 *
 *  - v2 envelope（capabilityInvocation / capabilityResponse）
 *  - 錯誤碼詞彙與可重試子集
 *  - 協定協商（checkProtocolCompatibility 的同一語意：偏好本地順序、
 *    不認識就大聲失敗，絕不靜默降級）
 *
 * 邊界（ADR-005 v2 的紅線）：
 *  - CUTOS_API_KEY 只存在 edge function（cutos-bridge）的環境；client
 *    永遠拿不到 key 也拿不到 CUTOS base URL。
 *  - 禁止 iframe／proxy／把無認證 editor REST 暴露給房間成員。
 *  - 第一階段只做「已渲染成品 MP4 → duigao artifact」的匯入與 health；
 *    觸發 export（requiresApproval=true）屬 AI 提案層整合，之後的 PR。
 */

export const CUTOS_PROTOCOL_VERSION = "cutos.agent.v2" as const;
export const CUTOS_PROTOCOL_VERSION_V1 = "cutos.agent.v1" as const;
export const CUTOS_SUPPORTED_PROTOCOLS = [CUTOS_PROTOCOL_VERSION, CUTOS_PROTOCOL_VERSION_V1] as const;
export type CutosProtocolVersion = (typeof CUTOS_SUPPORTED_PROTOCOLS)[number];

/** protocol.ts CUTOS_ERROR_CODES 的逐字鏡像（順序不重要，成員必須一致）。 */
export const CUTOS_ERROR_CODES = [
  "PROTOCOL_VERSION_MISMATCH",
  "CAPABILITY_NOT_FOUND",
  "VALIDATION_FAILED",
  "UNAUTHORIZED",
  "FORBIDDEN_PROJECT_SCOPE",
  "PROJECT_NOT_FOUND",
  "JOB_NOT_FOUND",
  "RUN_NOT_FOUND",
  "STALE_TIMELINE_REVISION",
  "IDEMPOTENCY_IN_PROGRESS",
  "IDEMPOTENCY_CONFLICT",
  "APPROVAL_REQUIRED",
  "NO_PENDING_PLAN",
  "UNSUPPORTED_OPERATION",
  "EMPTY_TIMELINE",
  "ANALYSIS_REQUIRED",
  "CANCELLED",
  "TIMEOUT",
  "UNAVAILABLE",
  "INTERNAL",
] as const;
export type CutosErrorCode = (typeof CUTOS_ERROR_CODES)[number];

/** 可帶同一 idempotencyKey 重試的錯誤（protocol.ts CUTOS_RETRYABLE_ERROR_CODES）。 */
export const CUTOS_RETRYABLE_ERROR_CODES: readonly CutosErrorCode[] = [
  "IDEMPOTENCY_IN_PROGRESS",
  "TIMEOUT",
  "UNAVAILABLE",
  "INTERNAL",
];

export function isRetryableCutosError(code: string | undefined): boolean {
  return !!code && (CUTOS_RETRYABLE_ERROR_CODES as readonly string[]).includes(code);
}

export type CutosError = {
  code: CutosErrorCode;
  message: string;
  messageKey?: string;
};

/** v2 呼叫 envelope（capabilityInvocationSchema 的最小鏡像）。 */
export type CutosInvocation = {
  protocolVersion: typeof CUTOS_PROTOCOL_VERSION;
  capability: string;
  args: Record<string, unknown>;
  correlation: {
    /** 每次 HTTP 嘗試唯一；重試時換新。 */
    requestId: string;
    /** 同一邏輯效果跨重試不變；寫入型 capability 必帶。 */
    idempotencyKey?: string;
  };
  expectedRevision?: number;
};

export type CutosCapabilityResult = {
  protocolVersion: string;
  capability: string;
  ok: true;
  result: unknown;
  replayed?: boolean;
};

export type CutosCapabilityFailure = {
  protocolVersion: string;
  capability: string;
  ok: false;
  error: CutosError;
};

export type CutosCapabilityResponse = CutosCapabilityResult | CutosCapabilityFailure;

export function buildInvocation(
  capability: string,
  args: Record<string, unknown>,
  opts: { requestId: string; idempotencyKey?: string },
): CutosInvocation {
  return {
    protocolVersion: CUTOS_PROTOCOL_VERSION,
    capability,
    args,
    correlation: {
      requestId: opts.requestId,
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    },
  };
}

/**
 * 回應解析：寬容讀取、嚴格分辨。ok 布林與 capability 字串是判別的最低
 * 要件；error.code 不在詞彙表裡時折疊成 INTERNAL（保留原 message 給
 * 開發者，但呼叫端拿到的是穩定碼 — 與 CUTOS 側「never raw exception
 * string」同一精神）。
 */
export function parseCapabilityResponse(json: unknown): CutosCapabilityResponse | null {
  if (!json || typeof json !== "object") return null;
  const r = json as Record<string, unknown>;
  if (typeof r.capability !== "string" || typeof r.ok !== "boolean") return null;
  if (r.ok === true) {
    return {
      protocolVersion: String(r.protocolVersion ?? ""),
      capability: r.capability,
      ok: true,
      result: r.result,
      ...(typeof r.replayed === "boolean" ? { replayed: r.replayed } : {}),
    };
  }
  const rawError = (r.error && typeof r.error === "object" ? r.error : {}) as Record<string, unknown>;
  const code = (CUTOS_ERROR_CODES as readonly string[]).includes(String(rawError.code))
    ? (rawError.code as CutosErrorCode)
    : "INTERNAL";
  return {
    protocolVersion: String(r.protocolVersion ?? ""),
    capability: r.capability,
    ok: false,
    error: {
      code,
      message: String(rawError.message ?? "unknown error").slice(0, 2000),
      ...(typeof rawError.messageKey === "string" ? { messageKey: rawError.messageKey } : {}),
    },
  };
}

export type ProtocolCompatibility =
  | { compatible: true; negotiated: CutosProtocolVersion }
  | { compatible: false; code: "PROTOCOL_VERSION_MISMATCH" | "PROTOCOL_VERSION_UNKNOWN" };

/**
 * 協定協商（protocol.ts checkProtocolCompatibility 同語意）：偏好本地
 * 順序裡兩邊都會講的最新版本；對面沒報版本或完全對不上 → 大聲失敗，
 * 沒有靜默降級。
 */
export function checkProtocolCompatibility(
  remoteVersion: string | undefined,
  remoteSupported: readonly string[] | undefined,
): ProtocolCompatibility {
  if (!remoteVersion) return { compatible: false, code: "PROTOCOL_VERSION_UNKNOWN" };
  const remoteAll = [remoteVersion, ...(remoteSupported ?? [])];
  for (const candidate of CUTOS_SUPPORTED_PROTOCOLS) {
    if (remoteAll.includes(candidate)) return { compatible: true, negotiated: candidate };
  }
  return { compatible: false, code: "PROTOCOL_VERSION_MISMATCH" };
}

// ---- duigao ⇄ cutos-bridge（edge function）的請求/回應 --------------------

/** bridge 的動作詞彙。第一階段刻意只有這兩個（ADR-005 v2）。 */
export type CutosBridgeRequest =
  | { action: "health" }
  | {
      action: "import-output";
      roomId: string;
      /** CUTOS 專案 id — 由使用者貼入；bridge 端會驗形狀。 */
      cutosProjectId: string;
      branchId?: string;
      label?: string;
    };

export type CutosBridgeHealth = {
  ok: boolean;
  /** 未設定 env 時 false＋此碼；client 以此隱藏整個入口（誠實不可用）。 */
  code?: "CUTOS_NOT_CONFIGURED" | "CUTOS_UNREACHABLE" | "PROTOCOL_VERSION_MISMATCH";
  negotiated?: string;
  manifestVersion?: number;
  serverVersion?: string;
};

export type CutosBridgeImportResult =
  | { ok: true; versionId: string; label: string; fileSize: number }
  | { ok: false; code: "CUTOS_NOT_CONFIGURED" | "CUTOS_UNREACHABLE" | "NO_EXPORT" | "TOO_LARGE" | "FORBIDDEN" | "ROOM_NOT_FOUND" | "IMPORT_FAILED"; message?: string };
