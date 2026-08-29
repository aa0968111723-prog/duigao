/**
 * Truthful voice phases — positive / negative / mutation (PR-GAP-03).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  VOICE_TRUTHFUL_PHASES,
  assertConnectableToken,
  canShowVoiceParticipants,
  classifyConnectFailure,
  isVoiceConnected,
  looksLikeSpaHtml,
  parseVoiceHealthPayload,
  parseVoiceTokenPayload,
  voicePhaseMessage,
  voicePhaseToDockState,
} from "../../src/features/voice/voiceState.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPA = `<!doctype html>
<html lang="zh-Hant"><head><title>對稿</title></head><body><div id="root"></div></body></html>`;

function naiveHttp200IsLive(status: number, _body: string): boolean {
  return status === 200;
}

test("positive: nine truthful phases are enumerated and mapped", () => {
  assert.deepEqual([...VOICE_TRUTHFUL_PHASES], [
    "idle",
    "requesting-permission",
    "joining",
    "connected",
    "reconnecting",
    "permission-denied",
    "service-not-configured",
    "connection-failed",
    "left",
  ]);
  assert.equal(voicePhaseToDockState("connected"), "live");
  assert.equal(voicePhaseToDockState("joining"), "connecting");
  assert.equal(voicePhaseToDockState("requesting-permission"), "connecting");
  assert.equal(voicePhaseToDockState("reconnecting"), "connecting");
  assert.equal(voicePhaseToDockState("permission-denied"), "error");
  assert.equal(voicePhaseToDockState("service-not-configured"), "error");
  assert.equal(voicePhaseToDockState("connection-failed"), "error");
  assert.equal(voicePhaseToDockState("left"), "idle");
});

test("positive: a complete token is accepted and may connect", () => {
  const parsed = parseVoiceTokenPayload({
    ok: true,
    url: "wss://livekit.example",
    token: "header.payload.sig",
    liveKitRoom: "duigao-11111111-1111-1111-1111-111111111111",
    ttlSeconds: 600,
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(assertConnectableToken(parsed).url, "wss://livekit.example");
  assert.equal(isVoiceConnected("connected"), true);
  assert.equal(canShowVoiceParticipants("connected"), true);
  assert.equal(voicePhaseMessage("connected"), "已連線");
});

test("negative: missing provider is service-not-configured, never 已連線", () => {
  const parsed = parseVoiceTokenPayload({ ok: false, code: "VOICE_NOT_CONFIGURED" });
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.phase, "service-not-configured");
  assert.equal(isVoiceConnected(parsed.phase), false);
  assert.equal(canShowVoiceParticipants(parsed.phase), false);
  assert.equal(voicePhaseMessage(parsed.phase), "語音服務尚未設定");
  assert.doesNotMatch(voicePhaseMessage(parsed.phase), /已連線/);
  const health = parseVoiceHealthPayload({ ok: false, code: "VOICE_NOT_CONFIGURED" });
  assert.equal(health.ok, false);
  if (health.ok) return;
  assert.equal(health.phase, "service-not-configured");
});

test("negative: permission-denied is distinct from connection-failed", () => {
  assert.equal(classifyConnectFailure(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" })), "permission-denied");
  assert.equal(classifyConnectFailure(new Error("websocket failed")), "connection-failed");
  assert.notEqual(voicePhaseMessage("permission-denied"), voicePhaseMessage("connection-failed"));
  assert.doesNotMatch(voicePhaseMessage("permission-denied"), /已連線/);
  assert.equal(isVoiceConnected("permission-denied"), false);
  assert.equal(isVoiceConnected("connection-failed"), false);
});

test("negative: SPA HTML token response is not a live session", () => {
  const byBody = parseVoiceTokenPayload(SPA);
  const byType = parseVoiceTokenPayload({ ok: true, url: "wss://x", token: "t", liveKitRoom: "r", ttlSeconds: 60 }, "text/html");
  assert.equal(byBody.ok, false);
  assert.equal(byType.ok, false);
  if (byBody.ok || byType.ok) return;
  assert.equal(byBody.code, "SPA_HTML");
  assert.equal(byType.code, "SPA_HTML");
  assert.equal(isVoiceConnected(byBody.phase), false);
  assert.equal(canShowVoiceParticipants(byBody.phase), false);
  assert.doesNotMatch(voicePhaseMessage(byBody.phase), /已連線/);
});

test("negative: { ok: true } without url/token is not connected", () => {
  const parsed = parseVoiceTokenPayload({ ok: true });
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.code, "MISSING_KEYS");
  assert.equal(isVoiceConnected(parsed.phase), false);
});

test("negative: non-websocket url or non-finite ttl is not a live session", () => {
  const http = parseVoiceTokenPayload({
    ok: true,
    url: "https://example.invalid/livekit",
    token: "header.payload.sig",
    liveKitRoom: "room-a",
    ttlSeconds: 600,
  });
  const badTtl = parseVoiceTokenPayload({
    ok: true,
    url: "wss://livekit.example",
    token: "header.payload.sig",
    liveKitRoom: "room-a",
    ttlSeconds: "nope",
  });
  assert.equal(http.ok, false);
  assert.equal(badTtl.ok, false);
  if (http.ok || badTtl.ok) return;
  assert.equal(http.code, "INVALID_REQUEST");
  assert.equal(badTtl.code, "MISSING_KEYS");
  assert.equal(isVoiceConnected(http.phase), false);
});

test("negative-control: status-only helper WOULD treat production SPA 200 as live", () => {
  assert.equal(naiveHttp200IsLive(200, SPA), true);
  assert.equal(looksLikeSpaHtml(SPA, "text/html"), true);
  assert.notEqual(naiveHttp200IsLive(200, SPA), parseVoiceTokenPayload(SPA).ok === true);
});

test("mutation: dropping the HTML check accepts a typed-html {ok:true} — real parser must not", () => {
  const mutated = (data: unknown) => {
    if (data && typeof data === "object" && !Array.isArray(data) && (data as { ok?: unknown }).ok === true) {
      return { ok: true as const };
    }
    return { ok: false as const };
  };
  const spoof = { ok: true, url: "wss://x", token: "t", liveKitRoom: "r", ttlSeconds: 60 };
  assert.equal(mutated(spoof).ok, true);
  const real = parseVoiceTokenPayload(spoof, "text/html; charset=utf-8");
  assert.equal(real.ok, false);
  if (real.ok) return;
  assert.equal(real.code, "SPA_HTML");
});

test("reconnecting / joining / left never publish a fake roster", () => {
  for (const phase of ["idle", "joining", "requesting-permission", "reconnecting", "left"] as const) {
    assert.equal(canShowVoiceParticipants(phase), false);
    assert.equal(isVoiceConnected(phase), false);
  }
});

test("hook and liveVoice use the truthful machine; RoomDiscussion still reads legacy dock state", () => {
  const hook = readFileSync(resolve(ROOT, "src/hooks/useVoiceRoom.ts"), "utf8");
  const live = readFileSync(resolve(ROOT, "src/features/voice/liveVoice.ts"), "utf8");
  const token = readFileSync(resolve(ROOT, "src/cloud/voiceToken.ts"), "utf8");
  const discussion = readFileSync(resolve(ROOT, "src/features/room-discussion/RoomDiscussion.tsx"), "utf8");
  assert.match(hook, /VoiceTruthfulPhase/);
  assert.match(hook, /voicePhaseToDockState/);
  assert.match(hook, /parseVoiceTokenPayload/);
  assert.match(hook, /parseVoiceHealthPayload/);
  assert.match(hook, /canShowVoiceParticipants/);
  assert.match(hook, /phase:/);
  assert.match(token, /parseVoiceTokenPayload/);
  assert.match(token, /parseVoiceHealthPayload/);
  assert.match(live, /assertConnectableToken|looksLikeSpaHtml/);
  // #95 owns this file — we keep the live/connecting contract so the dock still works.
  assert.match(discussion, /state === "live"/);
  assert.match(discussion, /state === "connecting"/);
});

test("voiceUnavailableReason is 語音服務尚未設定 (not a fake upcoming room)", () => {
  const voice = readFileSync(resolve(ROOT, "src/features/collaboration/voice.ts"), "utf8");
  assert.match(voice, /語音服務尚未設定/);
  assert.doesNotMatch(voice, /語音房間還在準備，這一版先把討論和白板做好/);
});
