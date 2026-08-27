import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  answerFromContext,
  applyBackToWhiteboard,
  retrieveRoomContext,
} from "../../src/ai/index.ts";
import { isFeatureEnabled, optionalPhaseMap } from "../../src/ai/featureFlags.ts";
import {
  addPollNode,
  addRoomContentReference,
  addSticky,
  createFlow,
  createMindmap,
  createNode,
  emptyGraph,
} from "../../src/collaboration/whiteboard.ts";
import { discussionTabs, firstScreenLabels, HIDDEN_FIRST_SCREEN, plusMenuItems, voiceIsWorkingRoom } from "../../src/collaboration/discussionShell.ts";
import { searchLibrary, type LibraryAsset } from "../../src/collaboration/library.ts";
import type { Room } from "../../src/lib/types.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function room(): Room {
  return {
    id: "room-activity",
    title: "迎新活動房",
    projectMode: true,
    versions: [{ id: "v2", label: "改二", kind: "image", imageDataUrl: "data:image/png;base64,AA==", branchId: "poster" }],
    comments: [],
    strokes: [],
    messages: Array.from({ length: 30 }, (_, index) => ({
      id: `m${index}`,
      authorId: "a",
      authorName: "A",
      authorColor: "#000",
      body: `雜訊訊息 ${index}`,
      createdAt: index,
    })),
    updatedAt: 1,
    branches: [{
      id: "poster",
      roomId: "room-activity",
      name: "擺攤文宣",
      branchType: "poster",
      sortOrder: 0,
      status: "in_progress",
      createdBy: "owner",
      createdAt: 1,
      updatedAt: 1,
    }],
  };
}

test("mobile first screen is 對話/白板/語音 and extras stay contextual", () => {
  assert.deepEqual(firstScreenLabels(), ["對話", "白板", "語音"]);
  assert.equal(discussionTabs().find((tab) => tab.id === "voice")?.enabled, false);
  assert.equal(voiceIsWorkingRoom(), false);
  for (const hidden of HIDDEN_FIRST_SCREEN) {
    assert.equal(firstScreenLabels().includes(hidden), false, hidden);
  }
  assert.deepEqual(plusMenuItems(), ["便利貼", "流程", "心智圖", "房間內容", "素材"]);
  const shell = readFileSync(resolve(ROOT, "src/features/collaboration/DiscussionWorkspace.tsx"), "utf8");
  assert.match(shell, /data-testid="discussion-shell"/);
  assert.match(shell, /語音尚未開放/);
  assert.doesNotMatch(shell, /Canva/);
});

test("one node+edge model covers sticky, room ref, poll, flow, mindmap without copying media", () => {
  let graph = emptyGraph("room-activity");
  graph = addSticky(graph, "記得帶桌布").graph;
  graph = addRoomContentReference(graph, {
    type: "poster",
    title: "擺攤文宣",
    branchId: "poster",
    versionId: "v2",
  }).graph;
  graph = addPollNode(graph, "這週主推茶會還是擺攤？", "poll-1").graph;
  graph = createFlow(graph, ["招生", "擺攤", "互動", "QR", "茶會"]);
  graph = createMindmap(graph, "招生", ["擺攤", "茶會"]);
  assert.ok(graph.nodes.some((node) => node.type === "sticky"));
  assert.ok(graph.nodes.some((node) => node.type === "poster" && node.linkedVersionId === "v2" && !node.payload?.imageDataUrl));
  assert.ok(graph.nodes.some((node) => node.type === "poll"));
  assert.ok(graph.nodes.filter((node) => node.type === "flow").length >= 5);
  assert.ok(graph.edges.some((edge) => edge.kind === "flow"));
  assert.ok(graph.edges.some((edge) => edge.kind === "mindmap"));
  assert.throws(() => {
    createNode(emptyGraph("room-activity"), {
      type: "poster",
      text: "nope",
      x: 0,
      y: 0,
      payload: { imageDataUrl: "data:image/png;base64,QQ==" },
    });
  });
});

test("Room Context selection is bounded and apply-back inserts real nodes and edges", () => {
  const branches = Array.from({ length: 14 }, (_, index) => ({
    id: `b${index}`,
    roomId: "room-activity",
    name: `內容 ${index}`,
    branchType: "poster" as const,
    sortOrder: index,
    status: "in_progress" as const,
    createdBy: "owner",
    createdAt: index,
    updatedAt: index,
  }));
  const crowded: Room = {
    ...room(),
    branches,
    versions: branches.map((branch, index) => ({
      id: `ver${index}`,
      label: "改二",
      kind: "image",
      imageDataUrl: "data:image/png;base64,AA==",
      branchId: branch.id,
    })),
  };
  const source = createFlow(emptyGraph(crowded.id), ["招生", "擺攤", "互動", "QR", "茶會"]);
  const selected = source.nodes.filter((node) => node.text === "招生" || node.text === "擺攤").map((node) => node.id);
  const context = retrieveRoomContext({
    room: crowded,
    query: "幫我整理目前方向。",
    whiteboard: source,
    selectedNodeIds: selected,
  });
  assert.equal(context.fullRoomDumped, false);
  assert.ok(context.items.length <= 12);
  assert.equal(context.items.some((item) => item.body.includes("雜訊訊息")), false);
  const boardNodes = context.items.filter((item) => item.kind === "whiteboard_node");
  const boardEdges = context.items.filter((item) => item.kind === "whiteboard_edge");
  assert.ok(boardNodes.some((item) => item.title === "招生"), JSON.stringify(context.items.map((item) => item.kind + ":" + item.title)));
  assert.ok(boardNodes.some((item) => item.title === "擺攤"));
  assert.ok(boardEdges.some((item) => item.title.includes("招生") && item.title.includes("擺攤")));
  const reply = answerFromContext("幫我整理目前方向。", context, crowded);
  assert.match(reply, /缺少報名後的追蹤|目前流程/);
  const applied = applyBackToWhiteboard(emptyGraph(crowded.id), context);
  assert.ok(applied.nodes.some((node) => node.text === "招生"));
  assert.ok(applied.nodes.some((node) => node.text === "擺攤"));
  const from = applied.nodes.find((node) => node.text === "招生");
  const to = applied.nodes.find((node) => node.text === "擺攤");
  assert.ok(from && to && applied.edges.some((edge) => edge.fromNodeId === from.id && edge.toNodeId === to.id));
  assert.equal(applied.nodes.some((node) => node.text === "吸引注意"), false);
});

test("library search ranks understood tea poster above filename-only photo", () => {
  const items: LibraryAsset[] = [
    { id: "tea", scope: "room", roomId: "room-activity", title: "茶會文宣", summary: "春季茶會主視覺與報名", topics: ["茶會", "招生"], kind: "poster" },
    { id: "file", scope: "room", roomId: "room-activity", title: "IMG_3819.jpg", filename: "IMG_3819.jpg", summary: "", topics: [], kind: "image" },
    { id: "logo", scope: "shared", title: "社團 Logo", summary: "固定品牌標誌", topics: ["主視覺"], kind: "image" },
  ];
  const ranked = searchLibrary(items, "找適合做茶會宣傳的素材");
  assert.equal(ranked[0].id, "tea");
  assert.equal(ranked.find((item) => item.id === "file")?.score, 0);
  assert.equal(ranked[0].title.includes("IMG_"), false);
});

test("Canva and voice remain DISABLED with no fake implemented UI", () => {
  assert.equal(isFeatureEnabled("canva.integration"), false);
  assert.equal(isFeatureEnabled("collaboration.voice"), false);
  assert.deepEqual(optionalPhaseMap(), { "canva.integration": "DISABLED", "collaboration.voice": "DISABLED" });
  const sql = [
    readFileSync(resolve(ROOT, "supabase/migrations/0015_whiteboard.sql"), "utf8"),
    readFileSync(resolve(ROOT, "supabase/migrations/0016_asset_library.sql"), "utf8"),
  ].join("\n");
  assert.equal(/create table if not exists public\.voice_rooms/.test(sql), false);
  assert.equal(/create table if not exists public\.canva_designs/.test(sql), false);
});
