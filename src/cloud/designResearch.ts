/**
 * design-research edge function client.
 *
 * Success is `{ query, answer, sources, … }` — not `{ ok: true }`.
 * SPA HTML, a missing string `answer`, or no supabase transport must never
 * become a research answer. The upstream key stays on the edge; this file
 * must not read a frontend research key or call the vendor directly.
 */
import { invokeErrorContentType, looksLikeSpaHtml, parseFunctionPayload } from "./apiResponse";
import {
  createResearchProvider,
  type ResearchProviderOptions,
  type ResearchTransport,
} from "../features/design-intelligence/research";

export type DesignResearchInvokeClient = {
  functions: {
    invoke: (
      name: string,
      args?: { body?: unknown },
    ) => Promise<{ data: unknown; error: unknown }>;
  };
};

export const RESEARCH_NOT_CONFIGURED = "RESEARCH_NOT_CONFIGURED";

export function notConfiguredResearchResponse(): { status: number; body: Record<string, unknown> } {
  return {
    status: 503,
    body: {
      error: RESEARCH_NOT_CONFIGURED,
      detail: "外部研究服務尚未設定。其餘設計分析功能不受影響。",
    },
  };
}

/**
 * True only when the body is a real research result: a string `answer`
 * that is not the SPA catch-all.
 */
export function acceptDesignResearchSuccessBody(body: unknown, contentType?: string | null): boolean {
  if (looksLikeSpaHtml(body, contentType)) return false;
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const row = body as Record<string, unknown>;
  if (looksLikeSpaHtml(row.answer) || looksLikeSpaHtml(row.html)) return false;
  return typeof row.answer === "string";
}

export function createDesignResearchTransport(
  client: DesignResearchInvokeClient | null | undefined,
): ResearchTransport {
  return async (body) => {
    if (!client?.functions?.invoke) return notConfiguredResearchResponse();

    try {
      const { data, error } = await client.functions.invoke("design-research", { body });
      if (error) {
        if (looksLikeSpaHtml(null, invokeErrorContentType(error))) {
          return { status: 502, body: { error: "SPA_HTML" } };
        }
        const ctx = (error as { context?: Response }).context;
        if (ctx && typeof ctx.json === "function") {
          const raw = (await ctx.json().catch(() => null)) as unknown;
          const parsed = parseFunctionPayload(raw, { contentType: invokeErrorContentType(error) });
          if (parsed.kind === "payload") {
            const status = typeof ctx.status === "number" && ctx.status > 0 ? ctx.status : 502;
            return { status, body: parsed.value };
          }
        }
        return { status: 502, body: { error: "RESEARCH_INVOKE_FAILED" } };
      }

      const parsed = parseFunctionPayload(data);
      if (parsed.kind === "reject") {
        return { status: 502, body: { error: parsed.code } };
      }
      if (!acceptDesignResearchSuccessBody(parsed.value)) {
        return { status: 502, body: { error: "MISSING_ANSWER" } };
      }
      return { status: 200, body: parsed.value };
    } catch {
      return { status: 502, body: { error: "RESEARCH_INVOKE_FAILED" } };
    }
  };
}

export function createCloudResearchProvider(
  client: DesignResearchInvokeClient | null | undefined,
  options: Omit<ResearchProviderOptions, "transport">,
) {
  return createResearchProvider({
    ...options,
    transport: createDesignResearchTransport(client),
  });
}
