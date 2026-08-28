/**
 * WB04：realtime 增量的收斂規則 — 舊 echo 不得倒退、UPDATE 要真的生效。
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import type { WhiteboardEdge, WhiteboardNode } from "../../src/features/collaboration/types";
import { applyBoardPatches } from "../../src/features/collaboration/offline";

const edge = (over: Partial<WhiteboardEdge> = {}): WhiteboardEdge => ({
  id: "e1",
  whiteboardId: "b1",
  roomId: "r1",
  sourceNodeId: "n1",
  targetNodeId: "n2",
  edgeType: "default",
  label: "",
  createdAt: 1,
  version: 1,
  ...over,
});

const nodes: WhiteboardNode[] = [];
const acked = () => new Map<string, number>();

test("edge UPDATE：版本前進才替換（0022 之後 label/handle 可改）", () => {
  const before = [edge({ label: "" })];
  // 別人把線標籤改成「先做這個」，version 2
  const first = applyBoardPatches(nodes, before, acked(), [
    { type: "edge-insert", edge: edge({ label: "先做這個", version: 2 }) },
  ], null);
  assert.equal(first.edges[0].label, "先做這個", "UPDATE 必須真的生效（舊版只在不存在時新增＝no-op）");
  // 亂序抵達的舊 echo（version 1）不得把標籤洗回去
  const stale = applyBoardPatches(nodes, first.edges, acked(), [
    { type: "edge-insert", edge: edge({ label: "", version: 1 }) },
  ], null);
  assert.equal(stale.edges[0].label, "先做這個", "較舊的 echo 不得倒退");
});

test("edge INSERT：新的線照常進來，且不重複", () => {
  const first = applyBoardPatches(nodes, [], acked(), [{ type: "edge-insert", edge: edge() }], null);
  assert.equal(first.edges.length, 1);
  const again = applyBoardPatches(nodes, first.edges, acked(), [{ type: "edge-insert", edge: edge() }], null);
  assert.equal(again.edges.length, 1, "同一條線的重複事件不得長出第二條");
});

test("edge DELETE：刪掉就是刪掉", () => {
  const start = applyBoardPatches(nodes, [edge()], acked(), [{ type: "edge-delete", id: "e1" }], null);
  assert.equal(start.edges.length, 0);
});
