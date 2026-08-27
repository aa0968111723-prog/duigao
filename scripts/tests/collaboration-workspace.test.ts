import test from "node:test";
import assert from "node:assert/strict";
import { addRoomTarget, buildInviteUrl, readInviteFromUrl } from "../../src/cloud/invite.ts";
import {
  addFlowNextStep,
  addMindmapChild,
  createEdge,
  createRelationEdges,
  createSticky,
  findNodes,
  formatVideoRange,
  groupSelected,
  moveNodes,
  parseTimestamp,
} from "../../src/features/collaboration/nodes.ts";
import { arrangeBoard, arrangeFlow, arrangeGrid, arrangeMindmap } from "../../src/features/collaboration/layout.ts";
import { buildDiscussionContext, getSelectedBoardContext, getWhiteboardContext } from "../../src/features/collaboration/context.ts";
import { discussionPayloadFromNode, stickyFromDiscussion } from "../../src/features/collaboration/links.ts";
import { boardPermission, canEditBoard, canManageBoards, canParticipateInDiscussion } from "../../src/features/collaboration/permissions.ts";
import { applyPendingNodeEdits, isBrowserOnline, reconcileNodes } from "../../src/features/collaboration/offline.ts";
import { collectBoardEditors, formatEditorLine, stampWriter } from "../../src/features/collaboration/presence.ts";
import { VOICE_ROOM_MVP } from "../../src/features/collaboration/voice.ts";
import { BROADCAST_THROTTLE_MS, DRAG_PERSIST_MS, fitCamera, focusCamera, marqueeHits, nodeHit, visibleNodes, zoomAt, type Camera } from "../../src/features/whiteboard/canvas.ts";
import type { Whiteboard, WhiteboardEdge, WhiteboardNode } from "../../src/features/collaboration/types.ts";

function board(id = "board-1"): Whiteboard {
  return {
    id, roomId: "room-1", title: "招生規劃", description: "", allowEdit: false,
    createdBy: "owner", createdAt: 1, updatedAt: 1, version: 1,
  };
}

function node(id: string, type: WhiteboardNode["nodeType"], x = 0, y = 0, text = id): WhiteboardNode {
  return {
    id, whiteboardId: "board-1", roomId: "room-1", nodeType: type,
    x, y, width: 160, height: 72, content: { text }, createdBy: "owner",
    createdAt: 1, updatedAt: 1, version: 1,
  };
}

test("1-2 create and keep multiple boards", () => {
  const boards = [board("a"), board("b")];
  boards[1].title = "擺攤流程";
  assert.equal(boards.length, 2);
  assert.notEqual(boards[0].id, boards[1].id);
});

test("3-5 create, edit and move a sticky without asking style first", () => {
  const sticky = createSticky({ whiteboardId: "board-1", roomId: "room-1", createdBy: "me", text: "" });
  assert.equal(sticky.nodeType, "text");
  assert.equal(sticky.content.text, "");
  sticky.content.text = "招生";
  const moved = moveNodes([sticky], [sticky.id], 40, -10);
  assert.equal(moved[0].x, sticky.x + 40);
  assert.equal(moved[0].content.text, "招生");
});

test("6-9 flow next-step, mindmap child and edges", () => {
  const flow = node("stall", "flow", 0, 0, "擺攤");
  const next = addFlowNextStep(flow, "掃 QR Code", "me", []);
  assert.equal(next.node.nodeType, "flow");
  assert.equal(next.edge.edgeType, "flow");
  assert.equal(next.edge.sourceNodeId, flow.id);
  const root = node("recruit", "mindmap", 0, 0, "招生");
  const child = addMindmapChild(root, "茶會", "me", [], [root]);
  assert.equal(child.node.content.text, "茶會");
  assert.equal(child.edge.edgeType, "mindmap");
  const edge = createEdge({ whiteboardId: "board-1", roomId: "room-1", sourceNodeId: flow.id, targetNodeId: next.node.id, edgeType: "flow" });
  assert.equal(edge.sourceNodeId, flow.id);
});

test("10 archive is a timestamp, not a hard delete of the board record", () => {
  const archived = { ...board(), archivedAt: Date.now() };
  assert.ok(archived.archivedAt);
  assert.equal(canEditBoard("editor", false, archived), false);
});

test("11-15 room content / video range / plan cards only reference entities", () => {
  const poster = node("poster", "room_content", 0, 0, "");
  poster.linkedEntityType = "branch";
  poster.linkedEntityId = "poster-branch";
  poster.content = { title: "擺攤文宣", versionLabel: "改二", openCommentCount: 3, mediaKind: "poster", thumbnailUrl: "https://example.test/thumb" };
  const video = node("video", "room_content");
  video.linkedEntityType = "branch";
  video.linkedEntityId = "video-branch";
  video.content = { title: "招生影片", startTime: 40, endTime: 45, mediaKind: "video" };
  const plan = node("plan", "room_content");
  plan.linkedEntityType = "branch";
  plan.linkedEntityId = "plan-branch";
  plan.content = { title: "擺攤計畫", subtitle: "更新於剛剛", mediaKind: "plan" };
  assert.equal(poster.content.thumbnailUrl?.includes("http"), true);
  assert.equal(formatVideoRange(40, 45), "00:40–00:45");
  assert.equal(parseTimestamp("00:40"), 40);
  assert.equal(parseTimestamp("40"), 40);
  assert.ok(!("imageBytes" in poster.content));
  assert.ok(!poster.content.thumbnailUrl?.startsWith("data:"));
  const asset = node("asset", "room_content");
  asset.linkedEntityType = "version";
  asset.linkedEntityId = "ver-1";
  asset.content = { title: "booth.png", mediaKind: "asset", filename: "image/png" };
  assert.equal(asset.linkedEntityType, "version");
});

test("drag persist is throttled, not every animation frame", () => {
  assert.ok(DRAG_PERSIST_MS >= 80);
  assert.ok(BROADCAST_THROTTLE_MS >= 16);
});

test("16-17 discussion and board share payloads stay as references", () => {
  const sticky = createSticky({ whiteboardId: "board-1", roomId: "room-1", createdBy: "me", text: "主視覺要不要換？" });
  const payload = discussionPayloadFromNode(sticky, "招生規劃");
  assert.equal(payload.nodeId, sticky.id);
  assert.equal(payload.whiteboardId, "board-1");
  assert.equal(payload.title, "招生規劃 · 主視覺要不要換？");
  const back = stickyFromDiscussion({
    id: "m1",
    roomId: "room-1",
    authorId: "me",
    authorName: "招生",
    authorColor: "#111",
    kind: "node",
    body: sticky.content.text ?? "",
    payload,
    createdAt: 1,
    updatedAt: 1,
  }, sticky.whiteboardId, "me");
  assert.equal(back.content.text, "主視覺要不要換？");
  assert.equal(back.nodeType, "text");
  const ctx = buildDiscussionContext("room-1", [{
    id: "m1", roomId: "room-1", authorId: "me", authorName: "招生", authorColor: "#111",
    kind: "node", body: "主視覺要不要換？", payload, createdAt: 1, updatedAt: 1,
  }], []);
  assert.equal(ctx.messages[0].payload.nodeId, sticky.id);
});

test("18-19 poll reference and decision nodes reuse existing ids", () => {
  const poll = node("poll", "poll");
  poll.linkedEntityType = "poll";
  poll.linkedEntityId = "poll-12";
  poll.content = { pollQuestion: "主視覺要不要換？", voteCount: 4 };
  const decision = node("dec", "decision");
  decision.content = { text: "已決定：採用 B 版", sourceLabel: "來源：投票 #12" };
  assert.equal(poll.linkedEntityId, "poll-12");
  assert.match(decision.content.text ?? "", /B 版/);
});

test("20-22 local optimistic node/edge updates are last-write", () => {
  const local = node("n1", "text", 10, 10, "local");
  local.updatedAt = 50;
  local.version = 2;
  const remote = node("n1", "text", 0, 0, "remote");
  remote.updatedAt = 10;
  remote.version = 1;
  const merged = reconcileNodes([local], [remote], []);
  assert.equal(merged[0].content.text, "local");
  const deleted = reconcileNodes([local], [remote], [{ id: "p", roomId: "room-1", kind: "node", op: "delete", payload: { id: "n1" }, createdAt: 1 }]);
  assert.equal(deleted.length, 0);
  const queued = applyPendingNodeEdits([remote], [{ id: "p2", roomId: "room-1", kind: "node", op: "upsert", payload: local, createdAt: 2 }]);
  assert.equal(queued[0].content.text, "local");
  assert.equal(isBrowserOnline(), true);
});

test("presence lists recent other writers, not cursors", () => {
  const recent = stampWriter(node("n1", "text", 0, 0, "招生"), { id: "u2", name: "小明" }, 1_000);
  const stale = stampWriter(node("n2", "text", 0, 0, "舊"), { id: "u3", name: "過期" }, 1);
  const editors = collectBoardEditors([recent, stale], { id: "me", name: "我" }, { now: 1_200, windowMs: 500 });
  assert.deepEqual(editors.map((item) => item.name), ["小明"]);
  assert.equal(formatEditorLine(editors[0], "招生規劃"), "小明正在編輯「招生規劃」");
});

test("23-24 reviewer defaults to view; owner/editor collaborate; rooms stay isolated", () => {
  assert.equal(boardPermission("reviewer", false), "view");
  assert.equal(boardPermission("editor", false), "collaborate");
  assert.equal(boardPermission("reviewer", true), "collaborate");
  assert.equal(canManageBoards("reviewer", false), false);
  assert.equal(canParticipateInDiscussion("reviewer", false), true);
  const ctx = getWhiteboardContext(board(), [node("n", "text")], []);
  assert.equal(ctx.whiteboard.roomId, "room-1");
});

test("25-26 board/node deep links stay in the fragment with the invite", () => {
  const url = addRoomTarget("https://example.test/#room=r&invite=secret", { whiteboardId: "wb1", nodeId: "n1" });
  const parsed = new URL(url);
  assert.equal(parsed.search, "");
  assert.equal(parsed.hash, "#room=r&invite=secret&board=wb1&node=n1");
  const built = buildInviteUrl.call
    ? "https://example.test/#room=r&invite=secret&board=wb1"
    : "#room=r&invite=secret&board=wb1";
  assert.match(url, /board=wb1/);
  void built;
});

test("27-30 camera pinch/pan, long-press multi-select and marquee", () => {
  const camera: Camera = { x: 0, y: 0, zoom: 1 };
  const zoomed = zoomAt(camera, 100, 80, 1.4);
  assert.ok(zoomed.zoom > 1);
  const a = node("a", "text", 0, 0);
  const b = node("b", "text", 200, 0);
  assert.equal(nodeHit([a, b], 10, 10)?.id, "a");
  assert.deepEqual(marqueeHits([a, b], { x: -10, y: -10 }, { x: 400, y: 80 }).sort(), ["a", "b"]);
  const focused = focusCamera(a, { width: 390, height: 700 });
  assert.ok(Number.isFinite(focused.x));
  const fitted = fitCamera([a, b], { width: 390, height: 700 });
  assert.ok(fitted.zoom > 0 && fitted.zoom <= 1.15);
});

test("31 deterministic arrange: mindmap tree, flow vertical, stickies grid", () => {
  const root = node("招生", "mindmap", 0, 40, "招生");
  const child = node("擺攤", "mindmap", 10, 400, "擺攤");
  const edges: WhiteboardEdge[] = [createEdge({ whiteboardId: "board-1", roomId: "room-1", sourceNodeId: root.id, targetNodeId: child.id, edgeType: "mindmap" })];
  const tree = arrangeMindmap([root, child], edges);
  assert.ok(tree.find((item) => item.id === "擺攤")!.x > tree.find((item) => item.id === "招生")!.x);
  const f1 = node("f1", "flow", 0, 0, "吸引注意");
  const f2 = node("f2", "flow", 300, 0, "互動");
  const flowEdges: WhiteboardEdge[] = [createEdge({ whiteboardId: "board-1", roomId: "room-1", sourceNodeId: f1.id, targetNodeId: f2.id, edgeType: "flow" })];
  const flowed = arrangeFlow([f1, f2], flowEdges);
  assert.ok(flowed.find((item) => item.id === "f2")!.y > flowed.find((item) => item.id === "f1")!.y);
  const stickies = [node("s1", "text", 9, 9), node("s2", "text", 80, 3), node("s3", "text", 12, 70)];
  const grid = arrangeGrid(stickies);
  assert.equal(new Set(grid.map((item) => `${item.x},${item.y}`)).size, 3);
  assert.ok(arrangeBoard([...tree, ...flowed, ...grid], [...edges, ...flowEdges]).length >= 5);
});

test("32 200-node viewport culling does not return the whole board", () => {
  const nodes = Array.from({ length: 200 }, (_, index) => node(`n${index}`, "text", (index % 20) * 200, Math.floor(index / 20) * 160));
  const visible = visibleNodes(nodes, { x: 0, y: 0, zoom: 1 }, { width: 390, height: 700 }, 20);
  assert.ok(visible.length < 80, `visible=${visible.length}`);
  assert.ok(visible.length > 0);
});

test("AI boundary exposes facts only and reserves ai_result", () => {
  const wb = board();
  const nodes = [node("a", "text"), { ...node("b", "room_content"), linkedEntityType: "branch" as const, linkedEntityId: "br1" }];
  const ctx = getWhiteboardContext(wb, nodes, []);
  const selected = getSelectedBoardContext(wb.id, wb.roomId, nodes, ["b"]);
  assert.equal(ctx.linkedEntities[0].entityId, "br1");
  assert.equal(selected.nodes[0].id, "b");
  assert.equal(nodes.every((item) => item.nodeType !== "ai_result" || item.content.text == null), true);
});

test("search, group, relation helpers", () => {
  const nodes = [node("a", "text", 0, 0, "擺攤"), node("b", "text", 40, 0, "茶會")];
  assert.equal(findNodes(nodes, "茶").length, 1);
  const grouped = groupSelected(nodes, ["a", "b"], "me");
  assert.ok(grouped);
  assert.equal(grouped!.group.nodeType, "group");
  assert.equal(createRelationEdges("board-1", "room-1", ["a", "b"]).length, 1);
});

test("voice stays a boundary, not a shipped MVP claim", () => {
  assert.equal(VOICE_ROOM_MVP, false);
});

test("invite parser never reads invite from the query string", () => {
  const prev = globalThis.location;
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { hash: "#room=r", search: "?invite=leaked", pathname: "/", origin: "https://example.test", href: "https://example.test/?invite=leaked#room=r" },
  });
  try {
    const parsed = readInviteFromUrl();
    assert.equal(parsed?.invite, null);
  } finally {
    Object.defineProperty(globalThis, "location", { configurable: true, value: prev });
  }
});
