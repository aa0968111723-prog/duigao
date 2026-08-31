/**
 * canva-bridge 的 client 呼叫層（PR-05 第一階段）。
 *
 * client 只認識 bridge 的動作詞彙；Canva 的 client secret 與使用者 token
 * 從不出現在瀏覽器。health 帶 5 分鐘快取 — 用來分三態，不再把入口藏掉。
 * 負向 30 秒（與 cutos 同紀律，Grok 07 F6）。
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { invokeErrorContentType, looksLikeSpaHtml, parseFunctionPayload, rejectAsUnreachable } from "./apiResponse";
import type {
  CanvaBridgeDesignList,
  CanvaBridgeHealth,
  CanvaBridgeImportResult,
  CanvaBridgePageList,
  CanvaPageSummary,
} from "../lib/canvaContract";

let healthCache: { at: number; value: CanvaBridgeHealth } | null = null;
const HEALTH_TTL_MS = 5 * 60 * 1000;
const HEALTH_NEGATIVE_TTL_MS = 30 * 1000;

/** 非 2xx 的 body 帶著誠實錯誤碼 — 讀回來，別折成「連不上」（Grok 07 F3）。 */
async function readErrorBody<T extends { ok: false; code: string }>(error: unknown): Promise<T | null> {
  const ctx = (error as { context?: Response }).context;
  if (ctx && typeof ctx.json === "function") {
    const body = (await ctx.json().catch(() => null)) as T | null;
    if (body && body.ok === false && body.code) return body;
  }
  return null;
}

export async function canvaHealth(supabase: SupabaseClient): Promise<CanvaBridgeHealth> {
  if (healthCache) {
    const ttl = healthCache.value.ok ? HEALTH_TTL_MS : HEALTH_NEGATIVE_TTL_MS;
    if (Date.now() - healthCache.at < ttl) return healthCache.value;
  }
  try {
    const { data, error } = await supabase.functions.invoke("canva-bridge", { body: { action: "health" } });
    if (error) {
      if (looksLikeSpaHtml(null, invokeErrorContentType(error))) {
        throw Object.assign(new Error("SPA_HTML"), { code: "SPA_HTML" });
      }
      throw error;
    }
    const parsed = parseFunctionPayload(data);
    if (parsed.kind === "reject") {
      const value = rejectAsUnreachable(parsed, "CANVA_UNREACHABLE");
      healthCache = { at: Date.now(), value };
      return value;
    }
    const value: CanvaBridgeHealth =
      parsed.value.ok === true
        ? { ok: true }
        : { ok: false, code: parsed.value.code === "CANVA_NOT_CONFIGURED" ? "CANVA_NOT_CONFIGURED" : "CANVA_UNREACHABLE" };
    healthCache = { at: Date.now(), value };
    return value;
  } catch {
    const value: CanvaBridgeHealth = { ok: false, code: "CANVA_UNREACHABLE" };
    healthCache = { at: Date.now(), value };
    return value;
  }
}

/** 測試用：讓 e2e 能在同一頁面內重置 health gate。 */
export function resetCanvaHealthCache(): void {
  healthCache = null;
}

export async function canvaStatus(supabase: SupabaseClient): Promise<boolean> {
  try {
    const { data, error } = await supabase.functions.invoke("canva-bridge", { body: { action: "status" } });
    if (error) throw error;
    const parsed = parseFunctionPayload(data, { successKeys: ["connected"] });
    if (parsed.kind === "reject") return false;
    return parsed.value.ok === true && parsed.value.connected === true;
  } catch {
    return false;
  }
}

export async function canvaConnectUrl(supabase: SupabaseClient): Promise<string | null> {
  try {
    const { data, error } = await supabase.functions.invoke("canva-bridge", { body: { action: "connect-url" } });
    if (error) throw error;
    const parsed = parseFunctionPayload(data, { successKeys: ["url"] });
    if (parsed.kind === "reject") return null;
    return parsed.value.ok === true && typeof parsed.value.url === "string" ? parsed.value.url : null;
  } catch {
    return null;
  }
}

export async function canvaListDesigns(supabase: SupabaseClient): Promise<CanvaBridgeDesignList> {
  try {
    const { data, error } = await supabase.functions.invoke("canva-bridge", { body: { action: "list-designs" } });
    if (error) {
      if (looksLikeSpaHtml(null, invokeErrorContentType(error))) {
        return { ok: false, code: "CANVA_UNREACHABLE" };
      }
      const body = await readErrorBody<Extract<CanvaBridgeDesignList, { ok: false }>>(error);
      if (body) return body;
      throw error;
    }
    const parsed = parseFunctionPayload(data, { successKeys: ["designs"] });
    if (parsed.kind === "reject") return rejectAsUnreachable(parsed, "CANVA_UNREACHABLE");
    if (parsed.value.ok === true && Array.isArray(parsed.value.designs)) {
      return { ok: true, designs: parsed.value.designs as Extract<CanvaBridgeDesignList, { ok: true }>["designs"] };
    }
    if (parsed.value.ok === false && parsed.value.code) {
      return parsed.value as Extract<CanvaBridgeDesignList, { ok: false }>;
    }
    return { ok: false, code: "CANVA_UNREACHABLE" };
  } catch {
    return { ok: false, code: "CANVA_UNREACHABLE" };
  }
}

export async function canvaListPages(
  supabase: SupabaseClient,
  designId: string,
): Promise<CanvaBridgePageList> {
  try {
    const { data, error } = await supabase.functions.invoke("canva-bridge", {
      body: { action: "list-pages", designId },
    });
    if (error) {
      if (looksLikeSpaHtml(null, invokeErrorContentType(error))) {
        return { ok: false, code: "CANVA_UNREACHABLE" };
      }
      const body = await readErrorBody<Extract<CanvaBridgePageList, { ok: false }>>(error);
      if (body) return body;
      throw error;
    }
    const parsed = parseFunctionPayload(data, { successKeys: ["pages"] });
    if (parsed.kind === "reject") return rejectAsUnreachable(parsed, "CANVA_UNREACHABLE");
    if (parsed.value.ok === true && Array.isArray(parsed.value.pages)) {
      return { ok: true, pages: parsed.value.pages as CanvaPageSummary[] };
    }
    if (parsed.value.ok === false && parsed.value.code) {
      return parsed.value as Extract<CanvaBridgePageList, { ok: false }>;
    }
    return { ok: false, code: "CANVA_UNREACHABLE" };
  } catch {
    return { ok: false, code: "CANVA_UNREACHABLE" };
  }
}

export async function importCanvaDesign(
  supabase: SupabaseClient,
  input: { roomId: string; designId: string; branchId?: string; label?: string; pageNumber?: number; pageId?: string },
): Promise<CanvaBridgeImportResult> {
  try {
    const { data, error } = await supabase.functions.invoke("canva-bridge", {
      body: { action: "import-design", ...input },
    });
    if (error) {
      if (looksLikeSpaHtml(null, invokeErrorContentType(error))) {
        return { ok: false, code: "CANVA_UNREACHABLE" };
      }
      const body = await readErrorBody<Extract<CanvaBridgeImportResult, { ok: false }>>(error);
      if (body) return body;
      throw error;
    }
    const parsed = parseFunctionPayload(data, { successKeys: ["versionId"] });
    if (parsed.kind === "reject") return { ok: false, code: "IMPORT_FAILED" };
    if (parsed.value.ok === true) {
      return parsed.value as Extract<CanvaBridgeImportResult, { ok: true }>;
    }
    if (parsed.value.ok === false && parsed.value.code) {
      return parsed.value as Extract<CanvaBridgeImportResult, { ok: false }>;
    }
    return { ok: false, code: "IMPORT_FAILED" };
  } catch {
    return { ok: false, code: "CANVA_UNREACHABLE" };
  }
}
