/**
 * Edge / HTTP payload honesty.
 *
 * Production Zeabur (`https://duigao-k7q2.zeabur.app/`) is a Vite SPA: Caddy
 * + `vercel.json` rewrite every unknown path — including `/functions/v1/*`
 * and `/rest/v1/*` — to `index.html` with HTTP 200 and `text/html`.
 *
 * A client that only checks `response.ok` / status 200 would treat that
 * catch-all as a successful API. This module is the shared rejection gate:
 * HTML is never a function payload, and `{ ok: true }` without the keys the
 * caller said it needs is never success.
 */

export type FunctionPayloadReject = {
  kind: "reject";
  code: "SPA_HTML" | "INVALID_PAYLOAD" | "MISSING_KEYS";
};

export type FunctionPayloadAccept = {
  kind: "payload";
  value: Record<string, unknown>;
};

export type FunctionPayloadResult = FunctionPayloadAccept | FunctionPayloadReject;

/** True when the body or Content-Type is the SPA (or any HTML) catch-all. */
export function looksLikeSpaHtml(body: unknown, contentType?: string | null): boolean {
  if (typeof contentType === "string" && /text\/html/i.test(contentType)) return true;
  if (typeof body !== "string") return false;
  return /^\s*<(!doctype\s+html|html[\s>])/i.test(body);
}

function isBlank(value: unknown): boolean {
  return value == null || value === "";
}

/**
 * Parse a supabase.functions.invoke `data` (or a raw fetch body) into a
 * JSON object, or reject it.
 *
 * `successKeys` are required only when the payload claims `ok === true`.
 * A truthful failure (`{ ok: false, code: "VOICE_NOT_CONFIGURED" }`) does
 * not need those keys. An empty array counts as present; `""` / `null` does not.
 */
export function parseFunctionPayload(
  data: unknown,
  options: { contentType?: string | null; successKeys?: readonly string[] } = {},
): FunctionPayloadResult {
  if (looksLikeSpaHtml(data, options.contentType)) {
    return { kind: "reject", code: "SPA_HTML" };
  }
  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    return { kind: "reject", code: "INVALID_PAYLOAD" };
  }
  const value = data as Record<string, unknown>;
  if (value.ok === true && options.successKeys?.length) {
    for (const key of options.successKeys) {
      if (isBlank(value[key])) return { kind: "reject", code: "MISSING_KEYS" };
    }
  }
  return { kind: "payload", value };
}

/** Content-Type on the Response supabase-js stashes at `error.context`. */
export function invokeErrorContentType(error: unknown): string | null {
  const ctx = (error as { context?: Response } | null)?.context;
  if (!ctx || typeof ctx.headers?.get !== "function") return null;
  return ctx.headers.get("content-type");
}

/** Map a parser reject onto the honest "unreachable / not a real payload" codes. */
export function rejectAsUnreachable<C extends string>(
  parsed: FunctionPayloadReject,
  unreachable: C,
): { ok: false; code: C } {
  return { ok: false, code: unreachable };
}
