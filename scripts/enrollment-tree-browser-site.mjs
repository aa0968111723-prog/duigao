#!/usr/bin/env node
/**
 * Local website for 202609招生樹 browser testing.
 * Mock Supabase + Vite on THIS branch. room-ai-context calls askGrok.
 * XAI_API_KEY is read from process env only — never logged or written.
 *
 *   XAI_API_KEY=… npx tsx scripts/enrollment-tree-browser-site.mjs
 */
import { spawn } from "node:child_process";
import http from "node:http";
import { start as startMock, setRoomAiHandler, roles } from "./e2e/mock-supabase.mjs";
import { askGrok, DEFAULT_GROK_TEXT_MODEL, GROK_PROVIDER } from "../supabase/functions/_shared/roomAgent.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const MOCK_PORT = Number(process.env.ENROLLMENT_MOCK_PORT || 54521);
const VITE_PORT = Number(process.env.ENROLLMENT_VITE_PORT || 5173);

function sendJson(res, code, body) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "*");
  res.setHeader("content-type", "application/json");
  res.writeHead(code);
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function roomResponse(input, answer, status) {
  return {
    room: { id: input.roomId, title: input.title || "招生房" },
    query: input.query,
    context: [],
    sources: [],
    relations: [],
    permissions: { role: input.role || "owner", canAsk: true, selectedCount: 0 },
    truncated: false,
    answer,
    agent: { provider: GROK_PROVIDER, status },
  };
}

async function handleRoomAi(req, res) {
  const raw = await readBody(req);
  let body = {};
  try { body = JSON.parse(raw || "{}"); } catch { body = {}; }
  const focus = body.focus && typeof body.focus === "object" ? body.focus : {};
  const query = String(body.query || "").trim().slice(0, 2000);
  const roomId = String(body.roomId || "");
  if (!query) {
    sendJson(res, 400, { error: "QUERY_REQUIRED" });
    return;
  }
  const key = (process.env.XAI_API_KEY || "").trim();
  if (!key) {
    sendJson(res, 200, roomResponse({ roomId, query }, {
      text: "AI 服務尚未設定",
      citations: [],
      actions: [],
    }, "unconfigured"));
    return;
  }
  const card = {
    room: { id: roomId || "local", title: "招生房", role: "owner" },
    contents: [],
    focus: {
      label: String(focus.label || focus.treePath || "目前焦點").slice(0, 160),
      nodeId: focus.nodeId ? String(focus.nodeId).slice(0, 80) : undefined,
      nodeType: focus.nodeType ? String(focus.nodeType).slice(0, 40) : undefined,
      source: focus.source,
      treePath: focus.treePath ? String(focus.treePath).slice(0, 160) : undefined,
      treeRootId: focus.treeRootId ? String(focus.treeRootId).slice(0, 80) : undefined,
    },
    comments: [],
    allowedActions: [
      "list_room_contents", "get_version_brief", "list_open_comments",
      "propose_edit_text", "propose_add_shape", "propose_move_item", "propose_add_image",
      "imagine_image", "imagine_video", "create_plan_draft", "refuse_with_reason",
    ],
    spendPolicy: { maxUsdThisTurn: 0.05, allowImagineImage: true, allowImagineVideo: true },
    truncated: false,
  };
  console.log(JSON.stringify({
    roomAi: "askGrok",
    treePath: card.focus.treePath || null,
    queryChars: query.length,
    keyRedacted: "xai-…",
  }));
  const grok = await askGrok({
    env: {
      provider: GROK_PROVIDER,
      xaiKey: key,
      textModel: DEFAULT_GROK_TEXT_MODEL,
      imageModel: "grok-imagine-image",
      videoModel: "grok-imagine-video",
      maxUsd: 0.05,
    },
    query,
    card,
    imagineVideoConfirmed: body.imagineVideoConfirmed === true,
    storeImagine: async () => ({
      proposalId: "browser-live-proposal",
      path: "rooms/browser/proposals/browser-live-proposal/preview.png",
    }),
  });
  const actions = (grok?.actions ?? []).map((item) => ({
    type: item.type,
    label: item.label,
    payload: item.payload ?? {},
  }));
  const touchesVersions = actions.some((item) => /\/versions\//.test(String(item.payload?.workLayerRef ?? "")));
  console.log(JSON.stringify({
    roomAi: "askGrok-done",
    replyChars: grok?.text?.length ?? 0,
    actionTypes: actions.map((item) => item.type),
    imagineTouchesVersions: touchesVersions,
    model: grok?.model ?? null,
  }));
  sendJson(res, 200, roomResponse({ roomId, query }, grok
    ? { text: grok.text, citations: [], actions, provider: GROK_PROVIDER, model: grok.model }
    : null, grok ? "ready" : "unavailable"));
}

const mock = await startMock(MOCK_PORT);
setRoomAiHandler(handleRoomAi);
roles.nextJoinRole = "editor";

const CONTROL_PORT = Number(process.env.ENROLLMENT_CONTROL_PORT || 54522);
http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${CONTROL_PORT}`);
  if (req.method === "POST" && url.pathname === "/next-join") {
    const raw = await readBody(req);
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch { body = {}; }
    const role = body.role === "reviewer" || body.role === "editor" || body.role === "owner" ? body.role : "reviewer";
    roles.nextJoinRole = role;
    sendJson(res, 200, { nextJoinRole: roles.nextJoinRole });
    return;
  }
  sendJson(res, 404, { error: "not_found" });
}).listen(CONTROL_PORT, "127.0.0.1");

const vite = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", String(VITE_PORT), "--strictPort"], {
  cwd: ROOT,
  env: {
    ...process.env,
    VITE_SUPABASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_e2e_mock_key_000000",
    XAI_API_KEY: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let viteReady = false;
const onVite = (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  if (/Local:\s+http/i.test(text) || /ready in/i.test(text)) viteReady = true;
};
vite.stdout.on("data", onVite);
vite.stderr.on("data", onVite);

const started = Date.now();
while (!viteReady && Date.now() - started < 30_000) {
  await new Promise((resolve) => setTimeout(resolve, 200));
}
if (!viteReady) {
  console.error("vite did not become ready");
  process.exit(1);
}

console.log(JSON.stringify({
  site: "ready",
  url: `http://127.0.0.1:${VITE_PORT}/`,
  mock: `http://127.0.0.1:${MOCK_PORT}`,
  grokConfigured: Boolean((process.env.XAI_API_KEY || "").trim()),
  keyRedacted: (process.env.XAI_API_KEY || "").trim() ? "xai-…" : null,
}));

const stop = () => {
  setRoomAiHandler(null);
  vite.kill("SIGTERM");
  mock.close();
};
process.on("SIGINT", () => { stop(); process.exit(0); });
process.on("SIGTERM", () => { stop(); process.exit(0); });
