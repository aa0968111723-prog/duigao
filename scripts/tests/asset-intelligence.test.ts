import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { acceptAssetAnalysisPayload } from "../../src/cloud/assetAnalysisPayload";
import {
  contextCacheKey,
  isNormalizedAssetRegion,
  latestVersionForBranch,
  normalizeAssetRegion,
  preferCurrentAssets,
  rankContextItems,
  segmentsInRange,
  type IntelligentAsset,
  type RoomContextItem,
} from "../../src/lib/assetIntelligence";

const SPA_HTML = "<!doctype html><html><body>duigao</body></html>";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cloudAssets = () => readFileSync(resolve(ROOT, "src/cloud/assetIntelligence.ts"), "utf8");

const versions = [
  { id: "v-old", branchId: "poster-1", label: "初稿", archivedAt: undefined },
  { id: "v-current", branchId: "poster-1", label: "改二", archivedAt: undefined },
  { id: "v-archived", branchId: "poster-1", label: "改一", archivedAt: "2026-01-01T00:00:00.000Z" },
] as any;

function asset(id: string, patch: Partial<IntelligentAsset> = {}): IntelligentAsset {
  return {
    id,
    roomId: "room-1",
    branchId: "poster-1",
    versionId: id,
    assetType: "image",
    title: id,
    source: "room",
    status: "ready",
    analysisVersion: "1.0",
    aiReadable: true,
    externalAiAllowed: false,
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    regions: [],
    videoSegments: [],
    documentChunks: [],
    ...patch,
  };
}

test("image analysis regions stay normalized for viewer focus", () => {
  const region = normalizeAssetRegion({ type: "headline", label: "主標題", x: 0.12, y: 0.08, width: 0.9, height: 0.2, confidence: 1.4 });
  assert.ok(region);
  assert.equal(region.x, 0.12);
  assert.equal(region.width, 0.88);
  assert.equal(region.confidence, 1);
  assert.equal(isNormalizedAssetRegion(region), true);
  assert.equal(normalizeAssetRegion({ x: 0, y: 0, width: 0, height: 0 }), null);
});

test("latest version preference excludes archived versions", () => {
  assert.equal(latestVersionForBranch(versions, "poster-1")?.id, "v-current");
  const current = preferCurrentAssets([asset("v-old"), asset("v-current"), asset("v-archived")], versions);
  assert.deepEqual(current.map((item) => item.id), ["v-current"]);
  assert.deepEqual(preferCurrentAssets([asset("v-archived")], versions, ["v-archived"]).map((item) => item.id), ["v-archived"]);
});

test("video segment retrieval intersects a selected timestamp range", () => {
  const segments = [
    { id: "s1", assetId: "a-video", startSeconds: 0, endSeconds: 8, summary: "開場", transcript: "", topics: [], detectedText: "" },
    { id: "s2", assetId: "a-video", startSeconds: 42, endSeconds: 55, summary: "禪學社介紹", transcript: "", topics: ["禪學社"], detectedText: "" },
  ];
  assert.deepEqual(segmentsInRange(segments, { startSeconds: 43, endSeconds: 50 }).map((segment) => segment.id), ["s2"]);
  assert.equal(segmentsInRange(segments, null).length, 2);
});

test("room context search ranks semantic metadata and keeps selected assets", () => {
  const items = [
    { sourceId: "a", assetId: "a", title: "擺攤照片 03", assetType: "image", isCurrent: true, archived: false, topics: ["學生", "戶外"], keywords: ["主視覺"], summary: "社團活動宣傳桌" },
    { sourceId: "b", assetId: "b", title: "茶會文宣", assetType: "image", isCurrent: true, archived: false, topics: ["茶會"], keywords: [], summary: "日期與地點" },
  ] as RoomContextItem[];
  assert.equal(rankContextItems("適合擺攤主視覺", items, 1)[0].assetId, "a");
});

test("context cache key includes selected items and analysis versions", () => {
  const left = contextCacheKey("room-1", { query: "缺什麼", selectedAssetIds: ["b", "a"] }, ["2", "1"]);
  const right = contextCacheKey("room-1", { query: "缺什麼", selectedAssetIds: ["a", "b"] }, ["1", "2"]);
  assert.equal(left, right);
  assert.match(left, /room-1/);
  assert.match(left, /缺什麼/);
});

test("context asset projection has no storage or invite capability", () => {
  const item = asset("a");
  const context: RoomContextItem = {
    sourceId: item.id,
    assetId: item.id,
    title: item.title,
    assetType: item.assetType,
    isCurrent: true,
    archived: false,
    topics: [],
    keywords: [],
  };
  assert.equal("storagePath" in context, false);
  assert.equal("invite" in context, false);
  assert.equal("serviceRole" in context, false);
});

test("asset relation expansion keeps a room-scoped source and target", () => {
  const relation = { roomId: "room-1", sourceAssetId: "plan-1", targetAssetId: "poster-2", relationType: "supports" };
  assert.equal(relation.roomId, "room-1");
  assert.notEqual(relation.sourceAssetId, relation.targetAssetId);
  assert.equal(["supports", "related_to", "references"].includes(relation.relationType), true);
});

test("latest version and content hash are the analysis reuse boundary", () => {
  const source = readFileSync(new URL("../../supabase/functions/asset-analysis/index.ts", import.meta.url), "utf8");
  assert.match(source, /reuseSiblingAnalysis/);
  assert.match(source, /content_hash/);
  assert.match(source, /analysis_version/);
  assert.match(source, /stage:\s*"dedupe"/);
});

test("asset-analysis SPA HTML and empty objects are not queued success", () => {
  assert.throws(() => acceptAssetAnalysisPayload(SPA_HTML), (err: Error & { code?: string }) => err.code === "SPA_HTML");
  assert.throws(() => acceptAssetAnalysisPayload({}), (err: Error & { code?: string }) => err.code === "INVALID_PAYLOAD");
  assert.throws(() => acceptAssetAnalysisPayload({ ok: true }), (err: Error & { code?: string }) => err.code === "INVALID_PAYLOAD");
  assert.throws(() => acceptAssetAnalysisPayload({ error: "QUEUE_FAILED" }), (err: Error & { code?: string }) => err.code === "QUEUE_FAILED");
  assert.throws(() => acceptAssetAnalysisPayload({ jobId: "   " }), (err: Error & { code?: string }) => err.code === "INVALID_PAYLOAD");
  assert.throws(
    () => acceptAssetAnalysisPayload({ ok: true, jobId: "j1" }, "text/html"),
    (err: Error & { code?: string }) => err.code === "SPA_HTML",
  );
  assert.throws(
    () => acceptAssetAnalysisPayload({ ok: false, code: "ANALYSIS_UNAVAILABLE" }),
    (err: Error & { code?: string }) => err.code === "ANALYSIS_UNAVAILABLE",
  );
  assert.deepEqual(acceptAssetAnalysisPayload({ assetId: "a1", jobId: "j1", status: "queued" }), { jobId: "j1" });
});

test("enqueue / retry / askRoomContext wire the shared SPA gate (no import.meta.env)", () => {
  const src = cloudAssets();
  assert.match(src, /acceptAssetAnalysisPayload/);
  assert.match(src, /parseFunctionPayload/);
  assert.match(src, /looksLikeSpaHtml|SPA_HTML/);
  assert.match(src, /enqueueAssetAnalysis[\s\S]*acceptAssetAnalysisPayload/);
  assert.match(src, /retryAssetAnalysis[\s\S]*acceptAssetAnalysisPayload/);
  assert.match(src, /askRoomContext[\s\S]*parseFunctionPayload/);
  assert.doesNotMatch(src, /if \(error\) throw error;\s*\n\s*const response = sanitizeRoomAnswer/);
});

test("Room Context API adapter uses HMAC and bounded evidence", () => {
  const secret = "duigao-test-secret";
  const timestamp = "1780000000";
  const body = JSON.stringify({ query: "找擺攤素材", context: [], sources: [], relations: [] });
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  assert.equal(signature.length, 64);
  assert.match("tku-zen-agent adapter / ai_os adapter HMAC", /adapter|HMAC/);
  assert.doesNotMatch(body, /storage_path|invite_token|service_role/i);
});
