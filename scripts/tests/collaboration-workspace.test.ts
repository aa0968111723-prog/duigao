import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { addRoomTarget, buildInviteUrl, readInviteFromUrl } from "../../src/cloud/invite.ts";
import { isStaleWrite } from "../../src/cloud/errors.ts";
import { CloudError } from "../../src/cloud/errors.ts";
import {
  addFlowNextStep,
  addMindmapChild,
  adoptPersistedNode,
  applyNodePatch,
  createEdge,
  createRelationEdges,
  createSticky,
  findNodes,
  formatVideoRange,
  groupSelected,
  moveNodes,
  parseTimestamp,
  stampPersistedNode,
  touchWhiteboardNodeVersion,
} from "../../src/features/collaboration/nodes.ts";
import { arrangeBoard, arrangeFlow, arrangeGrid, arrangeMindmap } from "../../src/features/collaboration/layout.ts";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
import { buildDiscussionContext, getSelectedBoardContext, getWhiteboardContext } from "../../src/features/collaboration/context.ts";
import { discussionPayloadFromNode, stickyFromDiscussion } from "../../src/features/collaboration/links.ts";
import { boardPermission, canEditBoard, canManageBoards, canParticipateInDiscussion, stickyTextInputProps } from "../../src/features/collaboration/permissions.ts";
import { applyBoardPatches, applyPendingCloudWrites, replaceBoardGraph, applyPendingNodeEdits, decideNodeWriteRetry, isBrowserOnline, isCloudWriteAcknowledged, reconcileNodes } from "../../src/features/collaboration/offline.ts";
import {
  collaborationSliceFromRoom,
  collaborationSliceHasRows,
  insertCollaborationSlice,
  remapCollaborationSlice,
} from "../../src/cloud/collaborationRepository.ts";
import type { Room } from "../../src/lib/types.ts";
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
  assert.match(url, /board=wb1/);

  // buildInviteUrl 需要 location（它組的是絕對網址），所以之前這裡寫成
  // `buildInviteUrl.call ? "字串A" : "字串B"` —— 讀函式的 .call 屬性永遠是
  // truthy，函式本身從來沒有被呼叫過，結果還被 `void` 丟掉。這條測試看起來
  // 在測邀請網址，實際上什麼都沒測。改成 stub 掉 location 真的跑一遍，
  // 並且和 readInviteFromUrl 對接成 round-trip：秘密只能待在 fragment，
  // 目標參數要能原封不動被讀回來。
  const priorLocation = (globalThis as { location?: unknown }).location;
  try {
    (globalThis as { location?: unknown }).location = {
      origin: "https://duigao.test",
      pathname: "/",
      hash: "",
      search: "",
    };
    const invite = buildInviteUrl("room-1", "secret-token", { whiteboardId: "wb1", nodeId: "n1" });
    assert.equal(invite, "https://duigao.test/#room=room-1&invite=secret-token&board=wb1&node=n1");
    // 秘密不得落到 query（query 會進伺服器 log 與 referrer）。
    assert.equal(new URL(invite).search, "");

    const parsedInvite = new URL(invite);
    (globalThis as { location?: unknown }).location = {
      origin: parsedInvite.origin,
      pathname: parsedInvite.pathname,
      hash: parsedInvite.hash,
      search: parsedInvite.search,
    };
    const readBack = readInviteFromUrl();
    assert.equal(readBack?.roomId, "room-1");
    assert.equal(readBack?.invite, "secret-token");
    assert.equal(readBack?.whiteboardId, "wb1");
    assert.equal(readBack?.nodeId, "n1");
  } finally {
    (globalThis as { location?: unknown }).location = priorLocation;
  }
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

test("voice MVP 旗標翻真必須帶機器證據（PR-03：LiveKit 落地）", () => {
  // 這個測試從「不得宣稱」翻面成「宣稱必須有實作」：旗標為 true 時，
  // token edge、連線模組、狀態機 hook 三件缺一不可 — 防止有人只翻旗標。
  assert.equal(VOICE_ROOM_MVP, true);
  const tokenEdge = readFileSync(resolve(ROOT, "supabase/functions/voice-token/index.ts"), "utf8");
  assert.match(tokenEdge, /mintLiveKitToken/);
  assert.match(tokenEdge, /canPublishSources: \[\"microphone\"\]/);
  const live = readFileSync(resolve(ROOT, "src/features/voice/liveVoice.ts"), "utf8");
  assert.match(live, /import\("livekit-client"\)/);
  const hook = readFileSync(resolve(ROOT, "src/hooks/useVoiceRoom.ts"), "utf8");
  assert.match(hook, /voice_session_participants/);
  assert.match(hook, /left_at/);
});

test("persists send last-acked version and adopt the trigger increment", () => {
  const store = new Map<string, number>();
  const touch = (item: WhiteboardNode) => {
    const current = store.get(item.id);
    if (current == null) {
      store.set(item.id, item.version);
      return item.version;
    }
    const next = touchWhiteboardNodeVersion(item.version, current);
    store.set(item.id, next);
    return next;
  };

  let client = node("sticky", "text", 0, 0, "");
  client = stampPersistedNode(client, undefined);
  assert.equal(touch(client), 1);

  const afterFirst = applyNodePatch(client, { content: { text: "招" } });
  assert.equal(afterFirst.version, 1, "patch must not advance the lock before write");
  const write1 = stampPersistedNode(afterFirst, client);
  assert.equal(write1.version, 1);
  const server2 = touch(write1);
  assert.equal(server2, 2);
  client = adoptPersistedNode(afterFirst, { ...write1, version: server2 });
  assert.equal(client.version, 2);
  assert.equal(client.content.text, "招");

  const afterSecond = applyNodePatch(client, { content: { text: "招生" } });
  assert.equal(afterSecond.version, 2);
  const write2 = stampPersistedNode(afterSecond, client);
  assert.equal(write2.version, 2);
  assert.equal(touch(write2), 3);

  const other = applyNodePatch(node("sticky", "text", 0, 0, "別人"), { content: { text: "覆蓋" } });
  assert.throws(() => touch(stampPersistedNode(other, 1)), /stale-write/);
});

test("pre-incrementing both editors to version 2 would silently overwrite", () => {
  assert.equal(touchWhiteboardNodeVersion(2, 1), 2);
  assert.equal(touchWhiteboardNodeVersion(2, 2), 3, "equal version is accepted and overwrites");
  assert.throws(() => touchWhiteboardNodeVersion(1, 2), /stale-write/);
});

test("move keeps last-acked version as the write precondition", () => {
  const original = node("n1", "text", 10, 10, "招生");
  const moved = moveNodes([original], [original.id], 8, 0)[0];
  assert.equal(moved.version, 1);
  const stamped = stampPersistedNode(moved, original);
  assert.equal(stamped.version, 1);
  assert.equal(stamped.x, 18);
});

test("failed node writes retry only via the durable queue", () => {
  assert.deepEqual(decideNodeWriteRetry("success"), { acknowledged: true, queueDurable: false, queueMemory: false });
  assert.deepEqual(decideNodeWriteRetry("unbound"), { acknowledged: false, queueDurable: true, queueMemory: false });
  assert.deepEqual(decideNodeWriteRetry("failed"), { acknowledged: false, queueDurable: true, queueMemory: false });
  // stale-write：舊 payload 不進任何佇列（drop + refetch，audit F10）
  assert.deepEqual(decideNodeWriteRetry("conflict"), { acknowledged: false, queueDurable: false, queueMemory: false });
});

test("first-share remaps local collaboration ids onto the new cloud room", () => {
  const local: Pick<Room, "id" | "whiteboards" | "whiteboardNodes" | "whiteboardEdges" | "discussion" | "discussionSupports" | "decisions" | "allowBoardEdit"> = {
    id: "local-room",
    allowBoardEdit: true,
    whiteboards: [board()],
    whiteboardNodes: [{
      ...node("n1", "room_content", 0, 0, ""),
      roomId: "local-room",
      linkedEntityType: "version",
      linkedEntityId: "ver-old",
    }],
    whiteboardEdges: [{
      id: "e1", whiteboardId: "board-1", roomId: "local-room",
      sourceNodeId: "n1", targetNodeId: "n1", edgeType: "default", label: "", createdAt: 1,
    }],
    discussion: [{
      id: "m1", roomId: "local-room", authorId: "me", authorName: "招生", authorColor: "#111",
      kind: "text", body: "先看白板", payload: { versionId: "ver-old", pollId: "poll-old" }, createdAt: 1, updatedAt: 1,
    }],
    discussionSupports: [{ messageId: "m1", roomId: "local-room", userId: "guest-1" }],
    decisions: [{
      id: "d1", roomId: "local-room", title: "採用 B 版", body: "", status: "decided",
      sourceType: "poll", sourceId: "poll-old", createdBy: "me", createdAt: 1, updatedAt: 1, version: 1,
    }],
  };
  const slice = remapCollaborationSlice(collaborationSliceFromRoom(local), "cloud-room", {
    versionIdMap: new Map([["ver-old", "ver-new"]]),
    pollIdMap: new Map([["poll-old", "poll-new"]]),
  });
  assert.equal(slice.whiteboards[0].roomId, "cloud-room");
  assert.equal(slice.nodes[0].roomId, "cloud-room");
  assert.equal(slice.nodes[0].linkedEntityId, "ver-new");
  assert.equal(slice.discussion[0].payload.versionId, "ver-new");
  assert.equal(slice.discussion[0].payload.pollId, "poll-new");
  assert.equal(slice.decisions[0].sourceId, "poll-new");
  assert.equal(collaborationSliceHasRows(slice), true);
});

test("insertCollaborationSlice uploads boards, nodes, discussion and decisions before a snapshot reload", async () => {
  const calls: Array<{ table: string; rows: unknown }> = [];
  const supabase = {
    from(table: string) {
      return {
        insert(rows: unknown) {
          calls.push({ table, rows });
          return Promise.resolve({ error: null });
        },
        update(row: unknown) {
          calls.push({ table, rows: row });
          return { eq() { return Promise.resolve({ error: null }); } };
        },
      };
    },
  };
  const slice = remapCollaborationSlice({
    allowBoardEdit: true,
    whiteboards: [board()],
    nodes: [node("n1", "text", 0, 0, "招生")],
    edges: [],
    discussion: [{
      id: "m1", roomId: "room-1", authorId: "me", authorName: "招生", authorColor: "#111",
      kind: "text", body: "先看白板", payload: {}, createdAt: 1, updatedAt: 1,
    }],
    discussionSupports: [],
    decisions: [{
      id: "d1", roomId: "room-1", title: "採用 B 版", body: "", status: "decided",
      createdBy: "me", createdAt: 1, updatedAt: 1, version: 1,
    }],
  }, "cloud-room");
  await insertCollaborationSlice(supabase as never, slice);
  assert.deepEqual(calls.map((item) => item.table), [
    "rooms",
    "whiteboards",
    "whiteboard_nodes",
    "room_discussion_messages",
    "decision_records",
  ]);
  const boards = calls.find((item) => item.table === "whiteboards")?.rows as Array<{ room_id: string }>;
  const nodes = calls.find((item) => item.table === "whiteboard_nodes")?.rows as Array<{ room_id: string; content: { text?: string } }>;
  assert.equal(boards[0].room_id, "cloud-room");
  assert.equal(nodes[0].room_id, "cloud-room");
  assert.equal(nodes[0].content.text, "招生");
});

test("pending node edits stay queued until the cloud write is acknowledged", async () => {
  const pending = [{
    id: "p1", roomId: "room-1", kind: "node" as const, op: "upsert" as const,
    payload: node("n1", "text", 0, 0, "招生"), createdAt: 1,
  }];
  const skipped = await applyPendingCloudWrites(pending, {
    upsertNode: () => undefined,
  });
  assert.deepEqual(skipped.acknowledged, []);
  assert.deepEqual(skipped.retained, ["p1"]);

  const queuedOnly = await applyPendingCloudWrites(pending, {
    upsertNode: async () => false,
  });
  assert.deepEqual(queuedOnly.retained, ["p1"]);

  const acked = await applyPendingCloudWrites(pending, {
    upsertNode: async (item) => ({ ...item, version: 2 }),
  });
  assert.deepEqual(acked.acknowledged, ["p1"]);
  assert.deepEqual(acked.retained, []);
  assert.equal(isCloudWriteAcknowledged(undefined), false);
  assert.equal(isCloudWriteAcknowledged(true), true);
});

test("view-only reviewers get a read-only sticky textarea and no change handler", () => {
  let changed = "";
  const viewer = stickyTextInputProps(false, (text) => { changed = text; });
  assert.equal(viewer.readOnly, true);
  assert.equal(viewer.onChange, undefined);
  const editor = stickyTextInputProps(true, (text) => { changed = text; });
  assert.equal(editor.readOnly, false);
  editor.onChange?.({ target: { value: "招生" } });
  assert.equal(changed, "招生");
  assert.equal(canEditBoard("reviewer", false, board()), false);
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

test("discussion shell publishes --kb itself (keyboard contract is real)", () => {
  const source = readFileSync(resolve(ROOT, "src/features/multi-room/MultiBranchRoom.tsx"), "utf8");
  assert.match(source, /useViewport\(\)/);
  const hook = readFileSync(resolve(ROOT, "src/hooks/useViewport.ts"), "utf8");
  assert.match(hook, /kbConsumers/);
});

// ---- PR-02a：自 collaboration.test.ts 移植的存續契約 ----------------------

test("canva 不入庫、語音由 VOICE_ROOM_MVP 單一旗標把關（原型契約移植）", () => {
  const migrations = ["0014_collaboration_workspace.sql", "0016_asset_library.sql", "0018_discussion_attachments.sql"]
    .map((name) => readFileSync(resolve(ROOT, "supabase/migrations", name), "utf8"))
    .join("\n");
  assert.equal(migrations.includes("canva_designs"), false);
  const voice = readFileSync(resolve(ROOT, "src/features/collaboration/voice.ts"), "utf8");
  // 語音仍由單一旗標把關；旗標現為 true（PR-03），且 runtime 可用性
  // 另由 health gate 決定 — 未設定 env 的部署維持誠實文案。
  assert.match(voice, /VOICE_ROOM_MVP = true/);
  assert.match(voice, /voiceUnavailableReason/);
});

test("第一屏契約如今綁在真殼上：討論根＋對話/白板 tabs＋語音一行邊界", () => {
  const shell = readFileSync(resolve(ROOT, "src/features/multi-room/MultiBranchRoom.tsx"), "utf8");
  assert.match(shell, /discuss-workspace/);
  assert.match(shell, />對話</);
  assert.match(shell, />白板</);
  const discussion = readFileSync(resolve(ROOT, "src/features/room-discussion/RoomDiscussion.tsx"), "utf8");
  assert.match(discussion, /voice-boundary/);
});

test("stale-write 的排隊編輯在重放時被清出佇列而不是永遠重試", async () => {
  const pending = [
    { id: "node:a", roomId: "r", kind: "node", op: "upsert", payload: { id: "a", version: 1 }, createdAt: 1 },
    { id: "node:b", roomId: "r", kind: "node", op: "upsert", payload: { id: "b", version: 1 }, createdAt: 1 },
    { id: "node:c", roomId: "r", kind: "node", op: "upsert", payload: { id: "c", version: 1 }, createdAt: 1 },
  ] as never[];
  const result = await applyPendingCloudWrites(pending, {
    upsertNode: async (node: { id: string }) =>
      node.id === "a" ? { id: "a", version: 2 } : node.id === "b" ? "conflict" : false,
  } as never);
  assert.deepEqual(result.acknowledged, ["node:a"]);
  assert.deepEqual(result.dropped, ["node:b"]);
  assert.deepEqual(result.retained, ["node:c"]);
});

test("isStaleWrite 對 CloudError 傳遞鏈成立（Grok pr02b F1）", () => {
  assert.equal(isStaleWrite(new CloudError("stale-write", "storage")), true);
  assert.equal(isStaleWrite(new Error("stale-write")), true);
  assert.equal(isStaleWrite(new Error("revision conflict")), false);
  assert.equal(isStaleWrite({ message: "stale-write", hint: "重新載入" }), true);
});

// ---- PR-02c：白板即時增量合併規則 -----------------------------------------

test("applyBoardPatches：version gate 擋 echo 與亂序、ack 水位無條件推進", () => {
  const node = (id: string, version: number, text = "") => ({
    id, whiteboardId: "b", roomId: "r", nodeType: "text", x: 0, y: 0, width: 100, height: 80,
    content: { text }, version, createdAt: 1, updatedAt: 1,
  }) as never;
  const acked = new Map([["n1", 3]]);
  // echo（version == acked）不覆蓋；更舊的也不覆蓋
  let out = applyBoardPatches([node("n1", 3, "本地")], [], acked, [
    { type: "node-upsert", node: node("n1", 3, "echo") },
    { type: "node-upsert", node: node("n1", 2, "舊事件") },
  ], null);
  assert.equal(out.changed, false);
  assert.equal((out.nodes[0] as { content: { text: string } }).content.text, "本地");
  // 嚴格更新才接受；ack 推到最高
  out = applyBoardPatches(out.nodes, [], acked, [{ type: "node-upsert", node: node("n1", 5, "別人的新版") }], null);
  assert.equal((out.nodes[0] as { content: { text: string } }).content.text, "別人的新版");
  assert.equal(acked.get("n1"), 5);
  // 新節點直接加入
  out = applyBoardPatches(out.nodes, [], acked, [{ type: "node-upsert", node: node("n2", 1, "新增") }], null);
  assert.equal(out.nodes.length, 2);
});

test("applyBoardPatches：護盾讓路且不推進 ack（409 歸 02b）；edge 以 id 去重/移除", () => {
  const node = (id: string, version: number) => ({
    id, whiteboardId: "b", roomId: "r", nodeType: "text", x: 0, y: 0, width: 100, height: 80,
    content: { text: "拖曳中" }, version, createdAt: 1, updatedAt: 1,
  }) as never;
  const edge = (id: string) => ({ id, whiteboardId: "b", roomId: "r", sourceNodeId: "a", targetNodeId: "c", edgeType: "flow", createdAt: 1 }) as never;
  const acked = new Map([["n1", 1]]);
  const out = applyBoardPatches([node("n1", 1)], [edge("e1")], acked, [
    { type: "node-upsert", node: node("n1", 9) }, // 拖曳中：不覆蓋
    { type: "edge-insert", edge: edge("e1") },     // 重複：不重加
    { type: "edge-insert", edge: edge("e2") },
    { type: "edge-delete", id: "e1" },
  ], new Set(["n1"]));
  assert.equal((out.nodes[0] as { version: number }).version, 1);
  // 護盾期間 ack 不推進（Grok pr02c F1）：persist 用舊 acked 去撞 409，
  // 由 02b 的 drop+refetch 誠實接手 — 絕不等版本 LWW 靜默覆蓋別人的內容。
  assert.equal(acked.get("n1"), 1);
  assert.deepEqual(out.edges.map((item) => (item as { id: string }).id), ["e2"]);
});

test("in-flight 的節點：自己的 WAL echo（acked+1）不得覆蓋打字中的內容", () => {
  const node = (id: string, version: number, text: string) => ({
    id, whiteboardId: "b", roomId: "r", nodeType: "text", x: 0, y: 0, width: 100, height: 80,
    content: { text }, version, createdAt: 1, updatedAt: 1,
  }) as never;
  const acked = new Map([["n1", 3]]);
  // 第一鍵已送出（in-flight），echo version=4 先到；本地已打到第二鍵
  const out = applyBoardPatches([node("n1", 3, "第二鍵")], [], acked, [
    { type: "node-upsert", node: node("n1", 4, "第一鍵") },
  ], new Set(["n1"]));
  assert.equal(out.changed, false);
  assert.equal((out.nodes[0] as { content: { text: string } }).content.text, "第二鍵");
  assert.equal(acked.get("n1"), 3); // ack 由 HTTP 結果推進，不由 echo
});

test("replaceBoardGraph：遠端已刪的節點消失、acked 清除；護盾節點保留", () => {
  const node = (id: string, board: string, version: number, text = "") => ({
    id, whiteboardId: board, roomId: "r", nodeType: "text", x: 0, y: 0, width: 100, height: 80,
    content: { text }, version, createdAt: 1, updatedAt: 1,
  }) as never;
  const acked = new Map([["gone", 5], ["stay", 2], ["typing", 2], ["other", 1]]);
  const result = replaceBoardGraph(
    [node("gone", "b1", 5), node("stay", "b1", 2, "舊"), node("typing", "b1", 2, "打字中"), node("other", "b2", 1)],
    [],
    acked,
    "b1",
    { nodes: [node("stay", "b1", 6, "雲端新"), node("typing", "b1", 4, "雲端版")], edges: [] },
    new Set(["typing"]),
  );
  const ids = result.nodes.map((item) => (item as { id: string }).id).sort();
  assert.deepEqual(ids, ["other", "stay", "typing"]); // gone 消失、b2 不動
  assert.equal(acked.has("gone"), false);
  assert.equal(acked.get("stay"), 6);
  assert.equal(acked.get("typing"), 2); // 護盾中不推進
  const typing = result.nodes.find((item) => (item as { id: string }).id === "typing");
  assert.equal((typing as { content: { text: string } }).content.text, "打字中"); // 打字中的內容保留
});
