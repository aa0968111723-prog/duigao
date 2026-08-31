#!/usr/bin/env node
/**
 * Reproducible 2026招生樹 AI probe — same askGrok path as production.
 *
 *   npx tsx scripts/enrollment-tree-ai-probe.mjs
 *   XAI_API_KEY=... npx tsx scripts/enrollment-tree-ai-probe.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { plantEnrollmentTree2026 } from "../src/features/collaboration/enrollmentTree.ts";
import { boardAskContext } from "../src/features/whiteboard/boardFocus.ts";
import { buildRoomAgentCard, DEFAULT_GROK_TEXT_MODEL } from "../src/ai/roomAgentContract.ts";
import { askGrok } from "../supabase/functions/_shared/roomAgent.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = JSON.parse(readFileSync(resolve(ROOT, "scripts/fixtures/enrollment-tree-grok-chat.json"), "utf8"));
const outDir = process.env.ENROLLMENT_AI_EVIDENCE_DIR || "/opt/cursor/artifacts";

let n = 0;
const planted = plantEnrollmentTree2026({
  whiteboardId: "wb-enroll",
  roomId: "11111111-1111-4111-8111-111111111111",
  createdBy: "owner",
  idFn: () => `n${++n}`,
});
const clip = planted.nodes.find((node) => node.id === planted.byKey.bookmark);
const ask = boardAskContext({ nodes: planted.nodes, edges: planted.edges, focusNode: clip });
const card = buildRoomAgentCard({
  room: { id: "11111111-1111-4111-8111-111111111111", title: "招生房", role: "owner" },
  contents: [{ branchId: "b-bookmark", type: "poster", name: "書籤", latestVersionLabel: "正面語錄", openCommentCount: 1 }],
  focus: {
    label: ask.focus?.label ?? "書籤",
    nodeId: clip.id,
    nodeType: "mindmap",
    source: "discussion",
    treePath: ask.focus?.treePath,
    treeRootId: ask.focus?.treeRootId,
  },
});

const key = (process.env.XAI_API_KEY ?? "").trim();
const hits = [];
const recordHit = (url, extra = {}) => {
  hits.push({ url: String(url), ...extra });
};
const chatShape = [];
const fetchFn = key
  ? async (url, init) => {
      const started = Date.now();
      const response = await fetch(url, init);
      const raw = await response.text();
      const extra = {
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get("content-type"),
        bodyBytes: raw.length,
        ms: Date.now() - started,
      };
      if (String(url).includes("/chat/completions")) {
        try {
          const parsed = JSON.parse(raw);
          const message = parsed?.choices?.[0]?.message ?? {};
          const tools = Array.isArray(message.tool_calls) ? message.tool_calls : [];
          chatShape.push({
            responseModel: typeof parsed?.model === "string" ? parsed.model : null,
            finishReason: parsed?.choices?.[0]?.finish_reason ?? null,
            contentChars: typeof message.content === "string" ? message.content.length : 0,
            toolNames: tools.map((item) => item?.function?.name).filter(Boolean),
          });
        } catch {
          chatShape.push({ parseError: true });
        }
      }
      recordHit(url, extra);
      return {
        ok: response.ok,
        headers: { get: (name) => response.headers.get(name) },
        text: async () => raw,
      };
    }
  : async (url) => {
      recordHit(url, { status: 200, ok: true, contentType: "application/json", bodyBytes: 0, ms: 0 });
      if (String(url).includes("/chat/completions")) {
        return { ok: true, headers: { get: () => "application/json" }, text: async () => JSON.stringify(FIXTURE) };
      }
      return {
        ok: true,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify({ data: [{ b64_json: Buffer.from("PNG-ENROLL").toString("base64") }] }),
      };
    };

const answer = await askGrok({
  env: {
    provider: "grok-room-agent",
    xaiKey: key || "xai-test-enrollment-tree",
    textModel: DEFAULT_GROK_TEXT_MODEL,
    imageModel: "grok-imagine-image",
    videoModel: "grok-imagine-video",
    maxUsd: 0.05,
  },
  query: `針對「${ask.focus?.treePath}」，書籤要不要補師父法語、原有的是否需要更換？只准提案，不要改原稿。`,
  card,
  imagineVideoConfirmed: false,
  fetchFn,
  storeImagine: async () => ({
    proposalId: "probe",
    path: "rooms/r/proposals/probe/a.png",
  }),
});

const text = answer?.text ?? "";
const actions = answer?.actions ?? [];
const imagineRef = String(actions.find((item) => item.type === "imagine_image")?.payload?.workLayerRef ?? "");
const evidence = {
  at: new Date().toISOString(),
  mode: key ? "live-xai" : "fixture-through-askGrok",
  treePath: ask.focus?.treePath,
  configured: Boolean(key),
  keyRedacted: key ? "xai-…" : null,
  model: answer?.model ?? chatShape[0]?.responseModel ?? null,
  chatShape,
  hits: hits.map((hit) => ({
    url: hit.url,
    status: hit.status ?? null,
    ok: hit.ok ?? null,
    contentType: hit.contentType ?? null,
    bodyBytes: hit.bodyBytes ?? null,
    ms: hit.ms ?? null,
  })),
  replyNonEmpty: text.trim().length > 0,
  textPreview: text.slice(0, 240) || null,
  staysOnBookmark: Boolean(text) && /書籤/.test(text),
  mixesBadge: /胸章/.test(text),
  actions: actions.map((item) => item.type),
  imagineWorkLayerRef: imagineRef || null,
  imagineTouchesVersions: /\/versions\//.test(actions.map((item) => String(item.payload?.workLayerRef ?? "")).join("\n")),
  blocker: key ? null : "XAI_API_KEY missing after lookup; fixture exercised the same askGrok path",
};
try {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "enrollment_tree_ai_probe.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  if (key) writeFileSync(resolve(outDir, "enrollment_tree_ai_live.json"), `${JSON.stringify(evidence, null, 2)}\n`);
} catch (error) {
  console.error(error);
}
console.log(JSON.stringify(evidence, null, 2));
process.exit(answer ? 0 : 1);
