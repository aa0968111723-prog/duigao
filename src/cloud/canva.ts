/**
 * canva-bridge 的 client 呼叫層（PR-05 第一階段）。
 *
 * client 只認識 bridge 的動作詞彙；Canva 的 client secret 與使用者 token
 * 從不出現在瀏覽器。health 帶 5 分鐘快取 — 它 gate 的是「入口要不要
 * 出現」，不是即時狀態面板；負向 30 秒（與 cutos 同紀律，Grok 07 F6）。
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CanvaBridgeDesignList,
  CanvaBridgeHealth,
  CanvaBridgeImportResult,
  CanvaBridgePageList,
  CanvaBridgeStatus,
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
    if (error) throw error;
    const value = (data ?? { ok: false, code: "CANVA_UNREACHABLE" }) as CanvaBridgeHealth;
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
    const value = (data ?? null) as CanvaBridgeStatus | null;
    return Boolean(value && value.ok && value.connected);
  } catch {
    return false;
  }
}

export async function canvaConnectUrl(supabase: SupabaseClient): Promise<string | null> {
  try {
    const { data, error } = await supabase.functions.invoke("canva-bridge", { body: { action: "connect-url" } });
    if (error) throw error;
    const value = (data ?? null) as { ok: boolean; url?: string } | null;
    return value && value.ok && typeof value.url === "string" ? value.url : null;
  } catch {
    return null;
  }
}

export async function canvaListDesigns(supabase: SupabaseClient): Promise<CanvaBridgeDesignList> {
  try {
    const { data, error } = await supabase.functions.invoke("canva-bridge", { body: { action: "list-designs" } });
    if (error) {
      const body = await readErrorBody<Extract<CanvaBridgeDesignList, { ok: false }>>(error);
      if (body) return body;
      throw error;
    }
    return (data ?? { ok: false, code: "CANVA_UNREACHABLE" }) as CanvaBridgeDesignList;
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
      const body = await readErrorBody<Extract<CanvaBridgePageList, { ok: false }>>(error);
      if (body) return body;
      throw error;
    }
    return (data ?? { ok: false, code: "CANVA_UNREACHABLE" }) as CanvaBridgePageList;
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
      const body = await readErrorBody<Extract<CanvaBridgeImportResult, { ok: false }>>(error);
      if (body) return body;
      throw error;
    }
    return (data ?? { ok: false, code: "IMPORT_FAILED" }) as CanvaBridgeImportResult;
  } catch {
    return { ok: false, code: "CANVA_UNREACHABLE" };
  }
}
