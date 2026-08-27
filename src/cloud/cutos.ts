/**
 * cutos-bridge 的 client 呼叫層（PR-07 第一階段）。
 *
 * client 只認識 bridge 的動作詞彙（health / import-output）；CUTOS 的
 * base URL 與 API key 從不出現在瀏覽器（ADR-005 v2）。health 帶 5 分鐘
 * 快取 — 它 gate 的是「入口要不要出現」，不是即時狀態面板。
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CutosBridgeHealth, CutosBridgeImportResult } from "../lib/cutosContract";

let healthCache: { at: number; value: CutosBridgeHealth } | null = null;
const HEALTH_TTL_MS = 5 * 60 * 1000;

export async function cutosHealth(supabase: SupabaseClient): Promise<CutosBridgeHealth> {
  if (healthCache && Date.now() - healthCache.at < HEALTH_TTL_MS) return healthCache.value;
  try {
    const { data, error } = await supabase.functions.invoke("cutos-bridge", { body: { action: "health" } });
    if (error) throw error;
    const value = (data ?? { ok: false, code: "CUTOS_UNREACHABLE" }) as CutosBridgeHealth;
    healthCache = { at: Date.now(), value };
    return value;
  } catch {
    // bridge 未部署／網路失敗：入口隱藏，不報錯打擾 — 誠實不可用。
    const value: CutosBridgeHealth = { ok: false, code: "CUTOS_UNREACHABLE" };
    healthCache = { at: Date.now(), value };
    return value;
  }
}

/** 測試用：讓 e2e 能在同一頁面內重置 health gate。 */
export function resetCutosHealthCache(): void {
  healthCache = null;
}

export async function importCutosOutput(
  supabase: SupabaseClient,
  input: { roomId: string; cutosProjectId: string; branchId?: string; label?: string },
): Promise<CutosBridgeImportResult> {
  try {
    const { data, error } = await supabase.functions.invoke("cutos-bridge", {
      body: { action: "import-output", ...input },
    });
    if (error) throw error;
    return (data ?? { ok: false, code: "IMPORT_FAILED" }) as CutosBridgeImportResult;
  } catch {
    return { ok: false, code: "CUTOS_UNREACHABLE" };
  }
}
