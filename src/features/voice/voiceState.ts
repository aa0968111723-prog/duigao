/**
 * Truthful voice phases (PR-GAP-03).
 *
 * RoomDiscussion still reads the legacy dock field `state`
 * (`idle | connecting | live | error`). The real machine lives on `phase`.
 * `connected` / `live` is only derived from a completed LiveKit connect,
 * never from HTTP 200, SPA HTML, or `{ ok: true }` without a token.
 *
 * SPA / missing-key rejection is the shared #97 gate (`parseFunctionPayload`);
 * this module adds ws/wss + finite TTL and the nine-state mapping.
 */

import { looksLikeSpaHtml, parseFunctionPayload } from "../../cloud/apiResponse";

export { invokeErrorContentType, looksLikeSpaHtml } from "../../cloud/apiResponse";

export const VOICE_TRUTHFUL_PHASES = [
  "idle",
  "requesting-permission",
  "joining",
  "connected",
  "reconnecting",
  "permission-denied",
  "service-not-configured",
  "connection-failed",
  "left",
] as const;

export type VoiceTruthfulPhase = (typeof VOICE_TRUTHFUL_PHASES)[number];

/** Backward-compatible field for RoomDiscussion (owned by #95 — do not rewrite). */
export type VoiceDockState = "idle" | "connecting" | "live" | "error";

export type VoiceTokenAccept = {
  ok: true;
  url: string;
  token: string;
  liveKitRoom: string;
  ttlSeconds: number;
};

export type VoiceTokenReject = {
  ok: false;
  code: "VOICE_NOT_CONFIGURED" | "ROOM_NOT_FOUND" | "VOICE_UNREACHABLE" | "INVALID_REQUEST" | "SPA_HTML" | "MISSING_KEYS";
  phase: Extract<VoiceTruthfulPhase, "service-not-configured" | "connection-failed">;
};

export function isVoiceConnected(phase: VoiceTruthfulPhase): boolean {
  return phase === "connected";
}

export function canShowVoiceParticipants(phase: VoiceTruthfulPhase): boolean {
  return phase === "connected";
}

/**
 * RoomDiscussion (#95) only renders Leave when `state === "live"`.
 * Any phase that maps away from `live` hides leave. Combined with an
 * still-open LiveKit/mic session that is the Bugbot refresh hole.
 */
export function dockShowsLeaveControl(phase: VoiceTruthfulPhase): boolean {
  return voicePhaseToDockState(phase) === "live";
}

export function refreshHidesLeaveWhileSessionLive(input: {
  phase: VoiceTruthfulPhase;
  liveKitSessionOpen: boolean;
}): boolean {
  return !dockShowsLeaveControl(input.phase) && input.liveKitSessionOpen;
}

export function voicePhaseToDockState(phase: VoiceTruthfulPhase): VoiceDockState {
  switch (phase) {
    case "connected":
      return "live";
    case "requesting-permission":
    case "joining":
    case "reconnecting":
      return "connecting";
    case "permission-denied":
    case "service-not-configured":
    case "connection-failed":
      return "error";
    case "idle":
    case "left":
      return "idle";
  }
}

export function voicePhaseMessage(phase: VoiceTruthfulPhase): string {
  switch (phase) {
    case "idle":
      return "語音房間";
    case "requesting-permission":
      return "正在請求麥克風權限…";
    case "joining":
      return "正在加入語音…";
    case "connected":
      return "已連線";
    case "reconnecting":
      return "正在重新連線…";
    case "permission-denied":
      return "麥克風權限被拒。請在瀏覽器網址列旁允許麥克風後再試。";
    case "service-not-configured":
      return "語音服務尚未設定";
    case "connection-failed":
      return "語音連線失敗，稍後再試一次。";
    case "left":
      return "已離開語音";
  }
}

export function classifyConnectFailure(error: unknown): Extract<
  VoiceTruthfulPhase,
  "permission-denied" | "connection-failed"
> {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const name = error instanceof Error ? error.name : "";
  if (/NotAllowed|NotAllowedError|permission/i.test(`${name} ${message}`)) return "permission-denied";
  return "connection-failed";
}

/**
 * Parse a voice-token / health payload. SPA HTML and `{ ok: true }` without
 * LiveKit fields are never a live session. Uses the #97 shared gate first.
 */
export function parseVoiceTokenPayload(
  data: unknown,
  contentType?: string | null,
): VoiceTokenAccept | VoiceTokenReject {
  const gate = parseFunctionPayload(data, {
    contentType,
    successKeys: ["url", "token", "liveKitRoom", "ttlSeconds"],
  });
  if (gate.kind === "reject") {
    if (gate.code === "SPA_HTML") return { ok: false, code: "SPA_HTML", phase: "connection-failed" };
    if (gate.code === "MISSING_KEYS") return { ok: false, code: "MISSING_KEYS", phase: "connection-failed" };
    return { ok: false, code: "INVALID_REQUEST", phase: "connection-failed" };
  }
  const value = gate.value;
  if (value.ok === true) {
    const ttl = Number(value.ttlSeconds);
    const url = String(value.url ?? "");
    if (!Number.isFinite(ttl) || ttl <= 0) {
      return { ok: false, code: "MISSING_KEYS", phase: "connection-failed" };
    }
    if (!/^wss?:\/\//i.test(url)) {
      return { ok: false, code: "INVALID_REQUEST", phase: "connection-failed" };
    }
    return {
      ok: true,
      url,
      token: String(value.token),
      liveKitRoom: String(value.liveKitRoom),
      ttlSeconds: ttl,
    };
  }
  if (value.code === "VOICE_NOT_CONFIGURED") {
    return { ok: false, code: "VOICE_NOT_CONFIGURED", phase: "service-not-configured" };
  }
  if (value.code === "ROOM_NOT_FOUND" || value.code === "INVALID_REQUEST") {
    return { ok: false, code: value.code, phase: "connection-failed" };
  }
  return { ok: false, code: "VOICE_UNREACHABLE", phase: "connection-failed" };
}

export function parseVoiceHealthPayload(
  data: unknown,
  contentType?: string | null,
): { ok: true } | { ok: false; code: "VOICE_NOT_CONFIGURED" | "VOICE_UNREACHABLE"; phase: VoiceTruthfulPhase } {
  const gate = parseFunctionPayload(data, { contentType });
  if (gate.kind === "reject") {
    return { ok: false, code: "VOICE_UNREACHABLE", phase: "connection-failed" };
  }
  const value = gate.value;
  if (value.ok === true) return { ok: true };
  if (value.code === "VOICE_NOT_CONFIGURED") {
    return { ok: false, code: "VOICE_NOT_CONFIGURED", phase: "service-not-configured" };
  }
  return { ok: false, code: "VOICE_UNREACHABLE", phase: "connection-failed" };
}

export function assertConnectableToken(token: VoiceTokenAccept | VoiceTokenReject): VoiceTokenAccept {
  if (!token.ok) {
    throw Object.assign(new Error(token.code), { voicePhase: token.phase, code: token.code });
  }
  if (looksLikeSpaHtml(token.url) || looksLikeSpaHtml(token.token)) {
    throw Object.assign(new Error("SPA_HTML"), { voicePhase: "connection-failed", code: "SPA_HTML" });
  }
  return token;
}
