/**
 * WB04：版本快照與還原計畫。還原絕不能整列覆寫（會帶舊 version 撞 OCC）。
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import type { WhiteboardEdge, WhiteboardFrame, WhiteboardNode } from "../../src/features/collaboration/types";
import { buildSnapshot, planRestore, describeRestore } from "../../src/features/whiteboard/versions";

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
  createdBy: "u1",
  createdAt: 1,
  updatedAt: 1,
  version: 1,
  ...over,
});

const frame = (id: string, over: Partial<WhiteboardFrame> = {}): WhiteboardFrame => ({
  id,
  whiteboardId: "b1",
  roomId: "r1",
  title: id,
  x: 0,
  y: 0,
  width: 480,
  height: 320,
  kind: "frame",
  style: {},
  zIndex: -1,
  createdBy: "u1",
  createdAt: 1,
  updatedAt: 1,
  version: 1,
  ...over,
});

const edge = (id: string): WhiteboardEdge => ({
  id,
  whiteboardId: "b1",
  roomId: "r1",
  sourceNodeId: "a",
  targetNodeId: "b",
  edgeType: "default",
  label: "",
  createdAt: 1,
  version: 1,
});

test("buildSnapshot：墓碑不入快照", () => {
  const snapshot = buildSnapshot(
    [node("a"), node("gone", { deletedAt: 123 })],
    [edge("e1")],
    [frame("f1")],
  );
  assert.deepEqual(snapshot.nodes.map((item) => item.id), ["a"]);
  assert.equal(snapshot.edges.length, 1);
  assert.equal(snapshot.frames.length, 1);
});

test("還原時沿用現況 version — 不得把快照的舊 version 寫回去（必被 OCC 永久擋下）", () => {
  const snapshot = buildSnapshot([node("a", { x: 0, version: 1 })], [], []);
  // 快照之後這個節點被改過好幾次，現在是 version 7
  const current = { nodes: [node("a", { x: 500, version: 7 })], edges: [], frames: [] };
  const plan = planRestore(snapshot, current);
  assert.equal(plan.upsertNodes.length, 1);
  assert.equal(plan.upsertNodes[0].x, 0, "位置還原成快照的值");
  assert.equal(plan.upsertNodes[0].version, 7, "version 必須是現況的，不是快照的 1");
});

test("內容一樣的節點不進計畫（不製造無謂寫入與 op 帳）", () => {
  const snapshot = buildSnapshot([node("a"), node("b")], [], []);
  const current = { nodes: [node("a"), node("b", { version: 9 })], edges: [], frames: [] };
  const plan = planRestore(snapshot, current);
  assert.equal(plan.upsertNodes.length, 0, "形狀相同就不寫");
  assert.equal(plan.deleteNodeIds.length, 0);
});

test("F1：快照裡有、現在是墓碑的節點必須走 restoreNodes（不是一般 upsert）", () => {
  const snapshot = buildSnapshot([node("old")], [], []);
  // 快照後這個節點被刪了（墓碑還在本地）
  const current = { nodes: [node("old", { deletedAt: 999, version: 3 }), node("new")], edges: [], frames: [] };
  const plan = planRestore(snapshot, current);
  assert.deepEqual(plan.deleteNodeIds, ["new"], "快照後新增的要移除");
  assert.equal(plan.upsertNodes.length, 0, "墓碑節點不能走一般 upsert — payload 碰不到 deleted_at，節點會出現一下又消失");
  assert.deepEqual(plan.restoreNodes.map((item) => item.id), ["old"]);
  assert.equal(plan.restoreNodes[0].deletedAt, undefined, "復原的節點不得帶墓碑");
});

test("F1：本地整個沒有的節點也走 restoreNodes（可能是別人刪的、本地已收掉）", () => {
  const snapshot = buildSnapshot([node("gone")], [], []);
  const plan = planRestore(snapshot, { nodes: [], edges: [], frames: [] });
  assert.deepEqual(plan.restoreNodes.map((item) => item.id), ["gone"]);
  assert.equal(plan.upsertNodes.length, 0);
});

test("frames 與 edges：frame 同樣沿用現況 version；線只補不刪", () => {
  const snapshot = buildSnapshot([], [edge("e1")], [frame("f1", { title: "舊名" })]);
  const current = {
    nodes: [],
    edges: [edge("e2")],
    frames: [frame("f1", { title: "新名", version: 4 }), frame("f2")],
  };
  const plan = planRestore(snapshot, current);
  assert.equal(plan.upsertFrames[0].title, "舊名");
  assert.equal(plan.upsertFrames[0].version, 4, "frame 也要沿用現況 version");
  assert.deepEqual(plan.deleteFrameIds, ["f2"]);
  assert.deepEqual(plan.createEdges.map((item) => item.id), ["e1"], "快照有、現在沒有的線要補");
});

test("describeRestore：復原已刪節點要說出來（使用者要知道會發生什麼）", () => {
  const plan = planRestore(buildSnapshot([node("gone")], [], []), { nodes: [], edges: [], frames: [] });
  assert.ok(describeRestore(plan).includes("已刪的會被復原"), describeRestore(plan));
});

test("describeRestore：沒有差異時誠實說「沒有變化」", () => {
  const snapshot = buildSnapshot([node("a")], [], []);
  const plan = planRestore(snapshot, { nodes: [node("a")], edges: [], frames: [] });
  assert.equal(describeRestore(plan), "和現在一樣，沒有變化");
  const plan2 = planRestore(buildSnapshot([node("a", { x: 9 })], [], []), { nodes: [node("a")], edges: [], frames: [] });
  assert.ok(describeRestore(plan2).includes("1 個內容還原"));
});
