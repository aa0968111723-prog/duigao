/**
 * voice-token edge function 的 client 呼叫層（PR-03，LiveKit）。
 *
 * LIVEKIT_API_SECRET 永遠在 edge env；瀏覽器拿到的是短命（10 分鐘）、
 * 單房、音訊限定的 access token。health 正向快取 5 分鐘、負向 30 秒
 * （與 cutos 同一套語意：env 後補不用整頁重載）。
 *
 * SPA HTML / `{ ok: true }` 缺欄不得被當成已連線（PR-GAP-00 + PR-GAP-03）。
 * 共用 parseFunctionPayload（#97）再加上 parseVoiceTokenPayload 的
 * wss + 有限 TTL（#98）。
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  invokeErrorContentType,
  looksLikeSpaHtml,
  parseFunctionPayload,
  rejectAsUnreachable,
} from "./apiResponse";
import {
  parseVoiceHealthPayload,
  parseVoiceTokenPayload,
  type VoiceTokenReject,
} from "../features/voice/voiceState";

export type VoiceHealth = { ok: boolean; code?: "VOICE_NOT_CONFIGURED" | "VOICE_UNREACHABLE" };

export type VoiceTokenResult =
  | { ok: true; url: string; token: string; liveKitRoom: string; ttlSeconds: number }
  | { ok: false; code: "VOICE_NOT_CONFIGURED" | "ROOM_NOT_FOUND" | "VOICE_UNREACHABLE" | "INVALID_REQUEST" };

let healthCache: { at: number; value: VoiceHealth } | null = null;
const HEALTH_TTL_MS = 5 * 60 * 1000;
const HEALTH_NEGATIVE_TTL_MS = 30 * 1000;

function publicTokenReject(parsed: VoiceTokenReject): Extract<VoiceTokenResult, { ok: false }> {
  if (
    parsed.code === "VOICE_NOT_CONFIGURED" ||
    parsed.code === "ROOM_NOT_FOUND" ||
    parsed.code === "INVALID_REQUEST" ||
    parsed.code === "VOICE_UNREACHABLE"
  ) {
    return { ok: false, code: parsed.code };
  }
  return { ok: false, code: "VOICE_UNREACHABLE" };
}

export async function voiceHealth(supabase: SupabaseClient): Promise<VoiceHealth> {
  if (healthCache) {
    const ttl = healthCache.value.ok ? HEALTH_TTL_MS : HEALTH_NEGATIVE_TTL_MS;
    if (Date.now() - healthCache.at < ttl) return healthCache.value;
  }
  try {
    const { data, error } = await supabase.functions.invoke("voice-token", { body: { action: "health" } });
    if (error) {
      if (looksLikeSpaHtml(null, invokeErrorContentType(error))) {
        const value: VoiceHealth = { ok: false, code: "VOICE_UNREACHABLE" };
        healthCache = { at: Date.now(), value };
        return value;
      }
      throw error;
    }
    const shared = parseFunctionPayload(data);
    if (shared.kind === "reject") {
      const value = rejectAsUnreachable(shared, "VOICE_UNREACHABLE");
      healthCache = { at: Date.now(), value };
      return value;
    }
    const parsed = parseVoiceHealthPayload(data);
    const value: VoiceHealth = parsed.ok ? { ok: true } : { ok: false, code: parsed.code };
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
      if (looksLikeSpaHtml(null, invokeErrorContentType(error))) {
        return { ok: false, code: "VOICE_UNREACHABLE" };
      }
      const ctx = (error as { context?: Response }).context;
      if (ctx && typeof ctx.json === "function") {
        const body = (await ctx.json().catch(() => null)) as unknown;
        const shared = parseFunctionPayload(body, {
          contentType: ctx.headers?.get?.("content-type"),
          successKeys: ["url", "token", "liveKitRoom", "ttlSeconds"],
        });
        if (shared.kind === "reject") return rejectAsUnreachable(shared, "VOICE_UNREACHABLE");
        const parsed = parseVoiceTokenPayload(body, ctx.headers?.get?.("content-type"));
        if (!parsed.ok) return publicTokenReject(parsed);
        return parsed;
      }
      throw error;
    }
    const shared = parseFunctionPayload(data, {
      successKeys: ["url", "token", "liveKitRoom", "ttlSeconds"],
    });
    if (shared.kind === "reject") return rejectAsUnreachable(shared, "VOICE_UNREACHABLE");
    const parsed = parseVoiceTokenPayload(data);
    if (!parsed.ok) return publicTokenReject(parsed);
    return parsed;
  } catch {
    return { ok: false, code: "VOICE_UNREACHABLE" };
  }
}
