/**
 * WB06：白板 AI 預覽層。紅線是「AI 不自動執行」— 預覽不進房態、不寫 DB，
 * 套用才產生真 id。
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import type { WhiteboardEdge, WhiteboardNode } from "../../src/features/collaboration/types";
import type { AiProposal } from "../../src/ai/proposals";
import {
  boardProposals,
  layoutPreview,
  layoutOriginFromFocus,
  describePreview,
  planApply,
} from "../../src/features/whiteboard/aiPreview";

const proposal = (type: AiProposal["type"], label = "建議"): AiProposal => ({
  id: `p-${type}-${label}`,
  type,
  label,
  payload: {},
  requiresExtraConfirm: false,
  source: "agent",
});

const node = (id: string, over: Partial<WhiteboardNode> = {}): WhiteboardNode => ({
  id,
  whiteboardId: "b1",
  roomId: "r1",
  nodeType: "text",
  x: 0,
  y: 0,
  width: 180,
  height: 96,
  content: { text: id },
  createdBy: "ai",
  createdAt: 1,
  updatedAt: 1,
  version: 1,
  ...over,
});

const edge = (id: string, source: string, target: string): WhiteboardEdge => ({
  id,
  whiteboardId: "b1",
  roomId: "r1",
  sourceNodeId: source,
  targetNodeId: target,
  edgeType: "default",
  label: "",
  createdAt: 1,
  version: 1,
});

test("只有白板型別的提案會落在板上，其餘留給房間層", () => {
  const all = [
    proposal("add_whiteboard_node"),
    proposal("create_poll"),
    proposal("create_comment"),
    proposal("create_plan_draft"),
  ];
  assert.deepEqual(boardProposals(all).map((item) => item.type), ["add_whiteboard_node"]);
});

test("預覽擺放：三個一行、整齊可預期（不做自動避讓）", () => {
  const spots = layoutPreview(4, { x: 100, y: 200 });
  assert.equal(spots.length, 4);
  assert.equal(spots[0].x, 100);
  assert.equal(spots[1].x, 100 + 180 + 24);
  assert.equal(spots[2].y, 200, "同一行的 y 相同");
  assert.equal(spots[3].x, 100, "第四個換行回到最左");
  assert.ok(spots[3].y > spots[0].y);
});

test("describePreview：說人話，且沒東西時誠實說沒有", () => {
  assert.equal(describePreview({ proposals: [], nodes: [], edges: [] }), "沒有可以放上白板的建議");
  const summary = describePreview({
    proposals: [],
    nodes: [node("a"), node("b"), node("c", { nodeType: "mindmap" })],
    edges: [edge("e", "a", "b")],
  });
  assert.ok(summary.includes("2 個便利貼"), summary);
  assert.ok(summary.includes("1 個心智圖"), summary);
  assert.ok(summary.includes("1 條連線"), summary);
});

test("planApply：預覽 id 換成真 id，連線端點跟著換", () => {
  let seq = 0;
  const newId = () => `real-${++seq}`;
  const plan = planApply({
    proposals: [],
    nodes: [node("tmp-1"), node("tmp-2")],
    edges: [edge("tmp-e", "tmp-1", "tmp-2")],
  }, newId);
  assert.deepEqual(plan.nodes.map((item) => item.id), ["real-1", "real-2"]);
  assert.equal(plan.edges[0].sourceNodeId, "real-1", "端點必須換成真 id");
  assert.equal(plan.edges[0].targetNodeId, "real-2");
  assert.ok(!plan.edges[0].id.startsWith("tmp"), "連線本身也要新 id");
});

test("planApply：端點對不到的線丟掉（不畫指向虛空的線）", () => {
  const plan = planApply({
    proposals: [],
    nodes: [node("tmp-1")],
    edges: [edge("tmp-e", "tmp-1", "not-in-preview")],
  }, () => "real");
  assert.equal(plan.edges.length, 0);
  assert.equal(plan.nodes.length, 1);
});

test("layoutOriginFromFocus：有焦點從右側排，沒有用 fallback", () => {
  assert.deepEqual(layoutOriginFromFocus(null, { x: 12, y: 34 }), { x: 12, y: 34 });
  const origin = layoutOriginFromFocus({ x: 100, y: 80, width: 180, height: 96 }, { x: 0, y: 0 });
  assert.equal(origin.y, 80);
  assert.ok(origin.x > 100);
});

test("planApply：同一份預覽套用兩次會得到兩批不同 id（重複是使用者的選擇，不是意外）", () => {
  let seq = 0;
  const newId = () => `id-${++seq}`;
  const preview = { proposals: [], nodes: [node("tmp-1")], edges: [] };
  const first = planApply(preview, newId);
  const second = planApply(preview, newId);
  assert.notEqual(first.nodes[0].id, second.nodes[0].id);
  assert.equal(preview.nodes[0].id, "tmp-1", "預覽本身不得被改動");
});
