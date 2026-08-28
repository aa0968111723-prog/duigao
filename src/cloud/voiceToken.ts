/**
 * voice-token edge function 的 client 呼叫層（PR-03，LiveKit）。
 *
 * LIVEKIT_API_SECRET 永遠在 edge env；瀏覽器拿到的是短命（10 分鐘）、
 * 單房、音訊限定的 access token。health 正向快取 5 分鐘、負向 30 秒
 * （與 cutos 同一套語意：env 後補不用整頁重載）。
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type VoiceHealth = { ok: boolean; code?: "VOICE_NOT_CONFIGURED" | "VOICE_UNREACHABLE" };

export type VoiceTokenResult =
  | { ok: true; url: string; token: string; liveKitRoom: string; ttlSeconds: number }
  | { ok: false; code: "VOICE_NOT_CONFIGURED" | "ROOM_NOT_FOUND" | "VOICE_UNREACHABLE" | "INVALID_REQUEST" };

let healthCache: { at: number; value: VoiceHealth } | null = null;
const HEALTH_TTL_MS = 5 * 60 * 1000;
const HEALTH_NEGATIVE_TTL_MS = 30 * 1000;

export async function voiceHealth(supabase: SupabaseClient): Promise<VoiceHealth> {
  if (healthCache) {
    const ttl = healthCache.value.ok ? HEALTH_TTL_MS : HEALTH_NEGATIVE_TTL_MS;
    if (Date.now() - healthCache.at < ttl) return healthCache.value;
  }
  try {
    const { data, error } = await supabase.functions.invoke("voice-token", { body: { action: "health" } });
    if (error) throw error;
    const value = (data ?? { ok: false, code: "VOICE_UNREACHABLE" }) as VoiceHealth;
    healthCache = { at: Date.now(), value };
    return value;
  } catch {
    const value: VoiceHealth = { ok: false, code: "VOICE_UNREACHABLE" };
    healthCache = { at: Date.now(), value };
    return value;
  }
}

/** 測試用：讓 e2e 在同一頁面內重置 health gate。 */
export function resetVoiceHealthCache(): void {
  healthCache = null;
}

export async function fetchVoiceToken(
  supabase: SupabaseClient,
  roomId: string,
  displayName: string,
): Promise<VoiceTokenResult> {
  try {
    const { data, error } = await supabase.functions.invoke("voice-token", {
      body: { action: "token", roomId, displayName },
    });
    if (error) {
      // 非 2xx 的 body 帶誠實碼（404 ROOM_NOT_FOUND）— 讀回來。
      const ctx = (error as { context?: Response }).context;
      if (ctx && typeof ctx.json === "function") {
        const body = (await ctx.json().catch(() => null)) as VoiceTokenResult | null;
        if (body && body.ok === false && body.code) return body;
      }
      throw error;
    }
    return (data ?? { ok: false, code: "VOICE_UNREACHABLE" }) as VoiceTokenResult;
  } catch {
    return { ok: false, code: "VOICE_UNREACHABLE" };
  }
}
