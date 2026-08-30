import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import { answerRoomContext, requireDuigaoSignature, signDuigaoRequest } from "../../src/ai/duigaoAgentAdapter";
import { answerDuigaoRoomContext, verifyDuigaoSignature } from "../../src/ai/aiOsRoomContext";
import { DocumentUnderstandingProvider, PdfReader } from "../../src/ai/documentUnderstanding";
import { VideoUnderstandingProvider } from "../../src/ai/videoUnderstanding";

Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });

test("tku-zen-agent adapter / ai_os adapter HMAC signature skew and reject", async () => {
  const secret = "duigao-test-secret";
  const body = JSON.stringify({ query: "找擺攤素材", context: [], sources: [], relations: [] });
  const timestamp = "1780000000";
  const signature = await signDuigaoRequest(body, timestamp, secret);
  await requireDuigaoSignature({ body, timestamp, signature, secret, nowSeconds: 1780000100 });
  assert.equal(await verifyDuigaoSignature({ body, timestamp, signature, secret, nowSeconds: 1780000100 }), true);
  assert.equal(await verifyDuigaoSignature({ body, timestamp, signature: "deadbeef", secret, nowSeconds: 1780000100 }), false);
  await assert.rejects(
    () => requireDuigaoSignature({ body, timestamp, signature, secret, nowSeconds: 1780000401 }),
    /timestamp/,
  );
});

test("answer_room_context and asset_analysis payloads stay secret-free", () => {
  const ask = { query: "缺什麼" };
  const fromZen = answerRoomContext(ask, {
    text: "建議補一張主視覺 https://secret.example/x",
    citations: [{ sourceId: "a1", title: "海報" }],
    actions: [{ type: "add_whiteboard_node", label: "釘海報", payload: { invite_token: "nope", label: "ok" } }],
  });
  const fromOs = answerDuigaoRoomContext(ask, { answer: "同一句", citations: [], actions: [] });
  assert.ok(fromZen);
  assert.match(fromZen.text, /連結已省略/);
  assert.equal(fromZen.actions[0]?.payload && "invite_token" in fromZen.actions[0].payload, false);
  assert.ok(fromOs);
  assert.doesNotMatch(JSON.stringify({ ask, fromZen, fromOs, asset_analysis: { sourceUrl: null } }), /service_role|invite_token/);
});

test("grok propose/imagine actions pass the shared adapter without secrets", () => {
  const ask = { query: "改主標" };
  const fromGrok = answerRoomContext(ask, {
    text: "這是提案",
    citations: [{ sourceId: "b-poster" }],
    actions: [
      { type: "propose_edit_text", label: "改主標", payload: { text: "五月茶會", service_role: "nope" } },
      { type: "overwrite_version", label: "不該過", payload: {} },
    ],
  });
  assert.ok(fromGrok);
  assert.equal(fromGrok.actions.length, 1);
  assert.equal(fromGrok.actions[0].type, "propose_edit_text");
  assert.equal(fromGrok.actions[0].payload && "service_role" in fromGrok.actions[0].payload, false);
});

test("DocumentUnderstandingProvider + PdfReader emit document chunks", () => {
  const provider = new DocumentUnderstandingProvider(20);
  const pdfish = new TextEncoder().encode("%PDF-1.4\n(茶會手冊內文一段)\n");
  const extracted = PdfReader.extractText(pdfish);
  assert.match(extracted, /茶會/);
  const { chunks, summary } = provider.understand({ assetId: "doc-1", textContent: "第一段。".repeat(10) });
  assert.ok(chunks.length >= 2);
  assert.equal(chunks[0].asset_id, "doc-1");
  assert.ok(summary.length > 0);
});

test("VideoUnderstandingProvider uses duration_seconds and keyframe windows", () => {
  const provider = new VideoUnderstandingProvider();
  const { segments, duration_seconds } = provider.understand({
    assetId: "vid-1",
    title: "開場",
    duration_seconds: 40,
    keyframes: [{ startSeconds: 0, endSeconds: 8, text: "片頭" }],
  });
  assert.equal(duration_seconds, 40);
  assert.equal(segments[0].start_seconds, 0);
  assert.equal(segments[0].end_seconds, 8);
  assert.match(segments[0].summary, /片頭/);
});
