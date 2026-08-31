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
const clip = planted.nodes.find((node) => node.id === planted.byKey["video-clip"]);
const ask = boardAskContext({ nodes: planted.nodes, edges: planted.edges, focusNode: clip });
const card = buildRoomAgentCard({
  room: { id: "11111111-1111-4111-8111-111111111111", title: "淡江招生房", role: "owner" },
  contents: [{ branchId: "b-video", type: "video", name: "招生短片", latestVersionLabel: "第一剪", openCommentCount: 1 }],
  focus: {
    label: ask.focus?.label ?? "招生短片",
    nodeId: clip.id,
    nodeType: "mindmap",
    source: "discussion",
    treePath: ask.focus?.treePath,
    treeRootId: ask.focus?.treeRootId,
  },
});

const key = (process.env.XAI_API_KEY ?? "").trim();
const urls = [];
const fetchFn = key
  ? async (url, init) => {
      urls.push(String(url));
      return fetch(url, init);
    }
  : async (url) => {
      urls.push(String(url));
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
  query: `針對「${ask.focus?.treePath}」，招生短片節奏會不會太快？只准提案，不要改原稿。`,
  card,
  imagineVideoConfirmed: false,
  fetchFn,
  storeImagine: async () => ({
    proposalId: "probe",
    path: "rooms/r/proposals/probe/a.png",
  }),
});

const evidence = {
  at: new Date().toISOString(),
  mode: key ? "live" : "fixture-through-askGrok",
  treePath: ask.focus?.treePath,
  configured: Boolean(key),
  urls,
  text: answer?.text ?? null,
  actions: answer?.actions?.map((item) => item.type) ?? [],
  blocker: key ? null : "XAI_API_KEY missing after lookup; fixture exercised the same askGrok path",
};
try {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "enrollment_tree_ai_probe.json"), `${JSON.stringify(evidence, null, 2)}\n`);
} catch (error) {
  console.error(error);
}
console.log(JSON.stringify(evidence, null, 2));
process.exit(answer ? 0 : 1);
