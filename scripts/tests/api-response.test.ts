/**
 * SPA catch-all and missing-key honesty (PR-GAP-00).
 *
 * Production evidence (curl 2026-08-29 against https://duigao-k7q2.zeabur.app):
 *   /functions/v1/voice-token  → 200 text/html  <!doctype html>… (index.html)
 *   /functions/v1/canva-bridge → 200 text/html  same SPA body
 *   /rest/v1/rooms             → 200 text/html  same SPA body
 *
 * These tests exist so a future "just check response.ok" rewrite fails CI
 * instead of shipping a fake-success voice/Canva/CUTOS path.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  invokeErrorContentType,
  looksLikeSpaHtml,
  parseFunctionPayload,
  rejectAsUnreachable,
} from "../../src/cloud/apiResponse.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPA_HTML = `<!doctype html>
<html lang="zh-Hant">
  <head><meta charset="UTF-8" /><title>對稿</title></head>
  <body><div id="root"></div></body>
</html>`;

/** Negative-control helper: the bug we must never reintroduce. */
function naiveHttp200IsSuccess(status: number, _body: string, _contentType?: string): boolean {
  return status === 200;
}

test("positive: real voice token JSON is accepted", () => {
  const parsed = parseFunctionPayload(
    {
      ok: true,
      url: "wss://livekit.example",
      token: "eyJhbGciOiJIUzI1NiJ9.e30.sig",
      liveKitRoom: "duigao-11111111-1111-1111-1111-111111111111",
      ttlSeconds: 600,
    },
    { successKeys: ["url", "token", "liveKitRoom", "ttlSeconds"] },
  );
  assert.equal(parsed.kind, "payload");
  if (parsed.kind !== "payload") return;
  assert.equal(parsed.value.ok, true);
  assert.equal(parsed.value.url, "wss://livekit.example");
});

test("positive: honest VOICE_NOT_CONFIGURED failure is accepted", () => {
  const parsed = parseFunctionPayload({ ok: false, code: "VOICE_NOT_CONFIGURED" }, {
    successKeys: ["url", "token"],
  });
  assert.equal(parsed.kind, "payload");
  if (parsed.kind !== "payload") return;
  assert.equal(parsed.value.ok, false);
  assert.equal(parsed.value.code, "VOICE_NOT_CONFIGURED");
});

test("positive: health { ok: true } needs no extra keys", () => {
  const parsed = parseFunctionPayload({ ok: true });
  assert.equal(parsed.kind, "payload");
});

test("negative: SPA HTML body is not a function payload", () => {
  const parsed = parseFunctionPayload(SPA_HTML, { successKeys: ["url", "token"] });
  assert.equal(parsed.kind, "reject");
  if (parsed.kind !== "reject") return;
  assert.equal(parsed.code, "SPA_HTML");
  assert.deepEqual(rejectAsUnreachable(parsed, "VOICE_UNREACHABLE"), {
    ok: false,
    code: "VOICE_UNREACHABLE",
  });
});

test("negative: Content-Type text/html is SPA even when body is empty object text", () => {
  assert.equal(looksLikeSpaHtml("{}", "text/html; charset=utf-8"), true);
  const parsed = parseFunctionPayload({ ok: true, url: "x", token: "y" }, {
    contentType: "text/html; charset=utf-8",
    successKeys: ["url", "token"],
  });
  assert.equal(parsed.kind, "reject");
  if (parsed.kind !== "reject") return;
  assert.equal(parsed.code, "SPA_HTML");
});

test("negative: { ok: true } without token keys is not success", () => {
  const parsed = parseFunctionPayload({ ok: true }, {
    successKeys: ["url", "token", "liveKitRoom", "ttlSeconds"],
  });
  assert.equal(parsed.kind, "reject");
  if (parsed.kind !== "reject") return;
  assert.equal(parsed.code, "MISSING_KEYS");
});

test("negative: empty string keys do not count as present", () => {
  const parsed = parseFunctionPayload(
    { ok: true, url: "", token: "tok", liveKitRoom: "r", ttlSeconds: 600 },
    { successKeys: ["url", "token", "liveKitRoom", "ttlSeconds"] },
  );
  assert.equal(parsed.kind, "reject");
  if (parsed.kind !== "reject") return;
  assert.equal(parsed.code, "MISSING_KEYS");
});

test("negative: array / string / null bodies are INVALID_PAYLOAD", () => {
  assert.equal(parseFunctionPayload(null).kind, "reject");
  assert.equal(parseFunctionPayload("not-html").kind, "reject");
  assert.equal(parseFunctionPayload(["ok"]).kind, "reject");
  assert.equal((parseFunctionPayload(null) as { code: string }).code, "INVALID_PAYLOAD");
});

test("negative-control: status-only helper WOULD accept the production SPA catch-all", () => {
  // This is the mutation we are guarding against. If someone "simplifies"
  // parseFunctionPayload down to `status === 200`, this assertion documents
  // that the production Zeabur response would then look like success.
  assert.equal(naiveHttp200IsSuccess(200, SPA_HTML, "text/html; charset=utf-8"), true);
  assert.equal(looksLikeSpaHtml(SPA_HTML, "text/html; charset=utf-8"), true);
  assert.notEqual(
    naiveHttp200IsSuccess(200, SPA_HTML, "text/html"),
    parseFunctionPayload(SPA_HTML, { contentType: "text/html" }).kind === "payload",
  );
});

test("mutation: a parser that drops the HTML check accepts SPA HTML — the real one must not", () => {
  const mutated = (data: unknown) => {
    if (data == null || typeof data !== "object" || Array.isArray(data)) {
      return { kind: "reject" as const, code: "INVALID_PAYLOAD" as const };
    }
    return { kind: "payload" as const, value: data as Record<string, unknown> };
  };
  // HTML is a string, so even the mutated object-only check rejects it —
  // the dangerous mutation is treating Content-Type html + {} as success.
  const htmlTypedOk = mutated({ ok: true, token: "stolen-from-index-html" });
  assert.equal(htmlTypedOk.kind, "payload");
  const real = parseFunctionPayload({ ok: true, token: "stolen-from-index-html" }, {
    contentType: "text/html",
    successKeys: ["token"],
  });
  assert.equal(real.kind, "reject");
  if (real.kind !== "reject") return;
  assert.equal(real.code, "SPA_HTML");
});

test("Canva / CUTOS import { ok: true } without versionId is rejected", () => {
  const canva = parseFunctionPayload({ ok: true, label: "海報" }, { successKeys: ["versionId"] });
  const cutos = parseFunctionPayload({ ok: true }, { successKeys: ["versionId"] });
  assert.equal(canva.kind, "reject");
  assert.equal(cutos.kind, "reject");
});

test("Canva status { ok: true, connected: false } is a valid payload", () => {
  const parsed = parseFunctionPayload({ ok: true, connected: false }, { successKeys: ["connected"] });
  assert.equal(parsed.kind, "payload");
});

test("voiceUnavailableReason is 語音服務尚未設定 (not a fake connected state)", () => {
  const voice = readFileSync(resolve(ROOT, "src/features/collaboration/voice.ts"), "utf8");
  assert.match(voice, /語音服務尚未設定/);
  assert.doesNotMatch(voice, /語音房間還在準備，這一版先把討論和白板做好/);
});

test("voice / canva / cutos / assetIntelligence clients call parseFunctionPayload", () => {
  const voice = readFileSync(resolve(ROOT, "src/cloud/voiceToken.ts"), "utf8");
  const canva = readFileSync(resolve(ROOT, "src/cloud/canva.ts"), "utf8");
  const cutos = readFileSync(resolve(ROOT, "src/cloud/cutos.ts"), "utf8");
  const assets = readFileSync(resolve(ROOT, "src/cloud/assetIntelligence.ts"), "utf8");
  const payload = readFileSync(resolve(ROOT, "src/cloud/assetAnalysisPayload.ts"), "utf8");
  for (const [name, src] of [["voiceToken", voice], ["canva", canva], ["cutos", cutos], ["assetIntelligence", assets], ["assetAnalysisPayload", payload]] as const) {
    assert.match(src, /parseFunctionPayload/, `${name} must parse payloads`);
    assert.match(src, /looksLikeSpaHtml|SPA_HTML|contentType/, `${name} must reject HTML`);
  }
});

test("missing VITE keys fail check-cloud-env --strict (no fake ready)", () => {
  const result = spawnSync(process.execPath, ["scripts/check-cloud-env.mjs", "--strict"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "production",
      VITE_SUPABASE_URL: "",
      VITE_SUPABASE_PUBLISHABLE_KEY: "",
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /VITE_SUPABASE_URL|Cloud env is NOT ready/);
});

test("service-role-shaped publishable key is rejected by check-cloud-env", () => {
  const result = spawnSync(process.execPath, ["scripts/check-cloud-env.mjs", "--strict"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "production",
      VITE_SUPABASE_URL: "https://example.supabase.co",
      VITE_SUPABASE_PUBLISHABLE_KEY: "not-a-real-key-contains-service_role-marker",
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /service-role/);
});

test("invokeErrorContentType reads Response headers and ignores junk", () => {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
  const response = new Response(SPA_HTML, { status: 200, headers });
  assert.equal(invokeErrorContentType({ context: response }), "text/html; charset=utf-8");
  assert.equal(invokeErrorContentType(null), null);
  assert.equal(invokeErrorContentType({}), null);
});
