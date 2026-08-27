import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  applyGate,
  applyReasonMessage,
  nodeFromAddWhiteboardAction,
  nodeTypeFromPayload,
  normalizeAiActions,
  payloadCopiesOriginalMedia,
  proposalsFromResponse,
} from "../../src/ai/proposals.ts";
import type { RoomContextResponse } from "../../src/lib/assetIntelligence.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("normalizeAiActions drops unknown types, media copies, and duplicate fingerprints", () => {
  const proposals = normalizeAiActions([
    { type: "add_whiteboard_node", label: "把主視覺放上白板", payload: { text: "擺攤主視覺", nodeType: "text" } },
    { type: "add_whiteboard_node", label: "把主視覺放上白板", payload: { text: "擺攤主視覺", nodeType: "text" } },
    { type: "explode_room", label: "不行", payload: {} },
    { type: "add_whiteboard_node", label: "偷塞原稿", payload: { text: "nope", imageDataUrl: "data:image/png;base64,QQ==" } },
    { type: "create_plan_draft", label: "建立企劃草稿", payload: { title: "招生企劃" } },
  ]);
  assert.equal(proposals.length, 2);
  assert.equal(proposals[0].type, "add_whiteboard_node");
  assert.equal(proposals[1].requiresExtraConfirm, true);
  assert.equal(payloadCopiesOriginalMedia({ imageDataUrl: "data:image/png;base64,QQ==" }), true);
});

test("applyGate requires human Apply, extra confirm for plan drafts, and refuses double apply", () => {
  const node = normalizeAiActions([{ type: "add_whiteboard_node", label: "放上白板", payload: { text: "招生" } }])[0];
  const plan = normalizeAiActions([{ type: "create_plan_draft", label: "建立企劃草稿", payload: { title: "招生企劃" } }])[0];
  assert.deepEqual(applyGate({ proposal: node, alreadyApplied: false, extraConfirmed: false, canTalk: true, canManage: true, canEditBoard: true }), { ok: true });
  assert.deepEqual(applyGate({ proposal: node, alreadyApplied: true, extraConfirmed: false, canTalk: true, canManage: true, canEditBoard: true }), { ok: false, reason: "already-applied" });
  assert.deepEqual(applyGate({ proposal: node, alreadyApplied: false, extraConfirmed: false, canTalk: true, canManage: false, canEditBoard: false }), { ok: false, reason: "forbidden" });
  assert.deepEqual(applyGate({ proposal: plan, alreadyApplied: false, extraConfirmed: false, canTalk: true, canManage: true, canEditBoard: true }), { ok: false, reason: "needs-confirm" });
  assert.deepEqual(applyGate({ proposal: plan, alreadyApplied: false, extraConfirmed: true, canTalk: true, canManage: true, canEditBoard: true }), { ok: true });
  assert.match(applyReasonMessage("already-applied"), /已經套用/);
});

test("add_whiteboard_node apply writes the 0014 production node, never the unused canvasId graph", () => {
  assert.equal(nodeTypeFromPayload("sticky"), "text");
  assert.equal(nodeTypeFromPayload("poster"), "room_content");
  const node = nodeFromAddWhiteboardAction({
    payload: { text: "報名後追蹤", nodeType: "flow" },
    whiteboardId: "board-1",
    roomId: "room-1",
    createdBy: "owner",
    x: 40,
    y: 96,
  });
  assert.equal(node.whiteboardId, "board-1");
  assert.equal(node.nodeType, "flow");
  assert.equal(node.content.text, "報名後追蹤");
  assert.equal(node.content.sourceLabel, "AI 提案");
  assert.equal("canvasId" in node, false);
  assert.throws(() => nodeFromAddWhiteboardAction({
    payload: { text: "nope", bytes: "abc" },
    whiteboardId: "board-1",
    roomId: "room-1",
    createdBy: "owner",
  }));
});

test("RoomAiSheet and App are the production apply path; unused DiscussionWorkspace is not evidence", () => {
  const sheet = readFileSync(resolve(ROOT, "src/features/asset-intelligence/RoomAiSheet.tsx"), "utf8");
  const app = readFileSync(resolve(ROOT, "src/App.tsx"), "utf8");
  const prototype = readFileSync(resolve(ROOT, "src/features/collaboration/DiscussionWorkspace.tsx"), "utf8");
  assert.match(sheet, /onApplyProposal/);
  assert.match(sheet, /data-testid="ai-proposal"/);
  assert.match(sheet, /套用/);
  assert.match(app, /applyAiProposal/);
  assert.match(app, /onApplyProposal=\{applyAiProposal\}/);
  assert.equal(app.includes("DiscussionWorkspace"), false);
  assert.match(prototype, /加入白板/);
});

test("proposalsFromResponse reads answer.actions and does not auto-apply", () => {
  const response: RoomContextResponse = {
    room: { id: "room-1", title: "招生房" },
    query: "幫我整理目前方向",
    context: [],
    sources: [],
    relations: [],
    permissions: { role: "owner", canAsk: true, selectedCount: 0 },
    truncated: false,
    answer: {
      text: "流程缺少報名後追蹤",
      citations: [],
      actions: [{ type: "add_whiteboard_node", label: "補上追蹤步驟", payload: { text: "報名後追蹤", nodeType: "flow" } }],
    },
    agent: { provider: "none", status: "unconfigured" },
  };
  const proposals = proposalsFromResponse(response);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].type, "add_whiteboard_node");
  assert.equal(proposals[0].payload.text, "報名後追蹤");
});
