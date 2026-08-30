import { looksLikeSpaHtml } from "../../cloud/apiResponse";

export type ScheduleWriteAccept =
  | { ok: true; reason: "inserted" | "updated" | "deleted" | "duplicate" }
  | { ok: false; code: "SPA_HTML" | "ZERO_ROW" | "FAILED" | "UNSET_CLOUD" | "FORBIDDEN" };

function returnedId(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") return null;
  const id = (row as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? id : null;
}

function errorText(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (typeof error === "object" && "message" in error) return String((error as { message: unknown }).message ?? "");
  return String(error);
}

/** REST insert/update: HTML and zero-row RLS are never success. */
export function acceptScheduleWrite(input: {
  error: unknown;
  data?: unknown;
  contentType?: string | null;
  unsetCloud?: boolean;
}): ScheduleWriteAccept {
  if (input.unsetCloud) return { ok: false, code: "UNSET_CLOUD" };
  if (looksLikeSpaHtml(input.data, input.contentType) || looksLikeSpaHtml(errorText(input.error), input.contentType)) {
    return { ok: false, code: "SPA_HTML" };
  }
  if (input.error) {
    const text = errorText(input.error);
    if (/duplicate|unique/i.test(text)) return { ok: true, reason: "duplicate" };
    if (/permission|rls|42501/i.test(text)) return { ok: false, code: "FORBIDDEN" };
    return { ok: false, code: "FAILED" };
  }
  if (input.data === true) return { ok: true, reason: "deleted" };
  if (!returnedId(input.data)) return { ok: false, code: "ZERO_ROW" };
  return { ok: true, reason: "inserted" };
}

/**
 * Node OCC drops stale-write and does not retry the same payload.
 * Schedule writes must do the same: conflict never enters the memory queue.
 */
export function decideScheduleWriteRetry(outcome: "success" | "failed" | "conflict" | "duplicate"): {
  queueMemory: boolean;
} {
  if (outcome === "conflict" || outcome === "duplicate" || outcome === "success") {
    return { queueMemory: false };
  }
  return { queueMemory: true };
}

export function scheduleWriteMessage(code: ScheduleWriteAccept extends { ok: false; code: infer C } ? C : never): string {
  if (code === "SPA_HTML") return "伺服器回了網頁而不是資料，時程沒有寫上。";
  if (code === "ZERO_ROW") return "權限或資料列沒寫成，時程沒有保存。";
  if (code === "UNSET_CLOUD") return "雲端尚未設定，時程只留在這台裝置。";
  if (code === "FORBIDDEN") return "沒有權限改這個時程。";
  return "時程沒有寫上，請再試一次。";
}
