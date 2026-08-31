/**
 * 白板焦點 × 討論釘 × Grok 同事。
 * Run: tsx --test scripts/tests/whiteboard-focus-discussion.test.ts
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  boardAskContext,
  cameraAfterRemount,
  discussionIdFromNode,
  emptyBoardCopyHasLonelyStep,
  emptyBoardVerbs,
  emptyRoomTitle,
  focusCardFromNode,
  focusNodeIdFromSelection,
  isEmptyBoard,
  messagesForFocus,
  nodeFocusSource,
  roomFocusFromPresence,
  shouldInlineDiscussionRail,
  shouldMountFocusSheet,
  workLayerItemsFromNodes,
} from "../../src/features/whiteboard/boardFocus";
import { stickyFromDiscussion } from "../../src/features/collaboration/links";
import { discussionPayloadFromNode } from "../../src/features/collaboration/links";
import { canEditDiscussion, isMemberActor } from "../../src/features/collaboration/discussionHonesty";
import {
  colleagueBubbleClass,
  colleagueWrite,
  createCommentAsColleague,
  GROK_COLLEAGUE_NAME,
  isColleagueMessage,
  lastColleagueForFocus,
  mentionsGrok,
  showsGrokMentionChip,
} from "../../src/features/collaboration/agentColleague";
import { layoutOriginFromFocus } from "../../src/features/whiteboard/aiPreview";
import { FIRST_LAYER_TABS } from "../../src/features/multi-room/roomChrome";
import type { DiscussionMessage, WhiteboardNode } from "../../src/features/collaboration/types";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const src = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

function node(over: Partial<WhiteboardNode> = {}): WhiteboardNode {
  return {
    id: "n1",
    whiteboardId: "b1",
    roomId: "r1",
    nodeType: "text",
    x: 40,
    y: 80,
    width: 180,
    height: 96,
    content: { text: "茶會主視覺" },
    createdBy: "u1",
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    ...over,
  };
}

function message(over: Partial<DiscussionMessage> = {}): DiscussionMessage {
  return {
    id: "m1",
    roomId: "r1",
    authorId: "u-a",
    authorName: "阿哲",
    authorColor: "#c45c4a",
    kind: "text",
    body: "先推茶會",
    payload: {},
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  };
}

test("選節點產生 focusNodeId", () => {
  assert.equal(focusNodeIdFromSelection(["n1", "n2"]), "n1");
  assert.equal(focusNodeIdFromSelection([]), null);
  const workspace = src("src/features/whiteboard/WhiteboardWorkspace.tsx");
  assert.match(workspace, /data-focus-node-id/);
  assert.match(workspace, /focusNodeIdFromSelection/);
});

test("手機寬度 rail 不 inline；sheet 開著", () => {
  assert.equal(shouldInlineDiscussionRail({ width: 390, height: 844 }), false);
  assert.equal(shouldMountFocusSheet({ width: 390, height: 844, hasFocus: true }), true);
  assert.equal(shouldInlineDiscussionRail({ width: 1024, height: 768 }), true);
  assert.equal(shouldMountFocusSheet({ width: 1024, height: 768, hasFocus: true }), false);
  const workspace = src("src/features/whiteboard/WhiteboardWorkspace.tsx");
  assert.match(workspace, /data-focus-sheet/);
  assert.match(workspace, /wb-focus-sheet/);
  assert.match(workspace, /discussionSlot/);
  const sheetBlock = workspace.slice(workspace.indexOf("wb-focus-sheet"));
  assert.match(sheetBlock, /wb-add-child/);
  assert.match(sheetBlock, /wb-next-step/);
  const askBlock = workspace.slice(workspace.indexOf("data-testid=\"wb-ai-ask\""));
  assert.match(askBlock, /onAskBoardAi/);
  assert.doesNotMatch(askBlock.slice(0, 900), /if \(api\.onAskColleague\) \{\s*api\.onAskColleague/);
  const mbr = src("src/features/multi-room/MultiBranchRoom.tsx");
  assert.match(mbr, /discussionSlot: !railVisible/);
});

test("discussion → node 有 linked entity；node → discussion 回得去", () => {
  const sticky = stickyFromDiscussion(message({ id: "msg-88", body: "釘這句" }), "b1", "u1");
  assert.equal(sticky.linkedEntityType, "discussion");
  assert.equal(sticky.linkedEntityId, "msg-88");
  assert.equal(discussionIdFromNode(sticky), "msg-88");
  const payload = discussionPayloadFromNode(node({ id: "n9" }));
  assert.equal(payload.nodeId, "n9");
  const workspace = src("src/features/whiteboard/WhiteboardWorkspace.tsx");
  assert.match(workspace, /打開原訊息/);
  const drawer = src("src/features/room-discussion/RoomDiscussion.tsx");
  assert.match(drawer, /打開白板並聚焦這張/);
});

test("空板文案不含「新步驟」當唯一 CTA", () => {
  const verbs = emptyBoardVerbs();
  assert.equal(verbs.length, 3);
  assert.ok(verbs.every((item) => !item.label.includes("新步驟")));
  const copy = `${emptyRoomTitle("未命名活動房").label}\n${verbs.map((item) => item.label).join("\n")}`;
  assert.equal(emptyBoardCopyHasLonelyStep(copy), false);
  assert.ok(copy.includes("從對話把一句話釘上來"));
  assert.ok(copy.includes("放一張文宣／素材"));
  assert.ok(copy.includes("問 Grok"));
  assert.equal(isEmptyBoard([]), true);
  assert.equal(isEmptyBoard([node({ deletedAt: 9 })]), true);
  const workspace = src("src/features/whiteboard/WhiteboardWorkspace.tsx");
  assert.match(workspace, /wb-empty-board/);
  assert.doesNotMatch(workspace, /wb-empty-board[\s\S]{0,400}新步驟/);
});

test("payload.agent === true：isMemberActor false、canEditDiscussion false、渲染走同事氣泡", () => {
  const grok = message({
    authorId: "u-a",
    authorName: GROK_COLLEAGUE_NAME,
    payload: { agent: true, agentProvider: "grok-room-agent" },
  });
  assert.equal(isMemberActor(grok), false);
  assert.equal(canEditDiscussion(grok, "u-a"), false);
  assert.equal(isColleagueMessage(grok), true);
  assert.equal(colleagueBubbleClass(grok), "colleague");
  const room = src("src/features/room-discussion/RoomDiscussion.tsx");
  assert.match(room, /is-colleague/);
  assert.match(room, /discussion-ai-badge/);
  assert.match(room, /GROK_TOMBSTONE_COPY|Grok 這則已收回/);
});

test("create_comment 採用後不可長出觸發者本人的普通 text 泡泡", () => {
  const write = createCommentAsColleague(
    { payload: { body: "建議先定主視覺" }, label: "留一句" },
    "user-trigger",
  );
  assert.equal(write.authorName, "Grok");
  assert.equal(write.authorId, "user-trigger");
  assert.equal(write.payload.agent, true);
  assert.notEqual(write.authorColor, "#c45c4a");
  const app = src("src/App.tsx");
  assert.match(app, /createCommentAsColleague/);
  assert.match(app, /auditWrite/);
  assert.doesNotMatch(app, /if \(proposal\.type === "create_comment"\) \{\s*sendDiscussion\(\{ kind: "text", body: commentBodyFromAction/);
});

test("讓大家看這個之後重掛載落到同一張，不准重設成預設視角", () => {
  const focused = cameraAfterRemount({
    saved: { x: 24, y: 24, zoom: 1 },
    roomFocus: { x: 400, y: 200, width: 180, height: 96 },
    focusCamera: (item) => ({ x: -item.x, y: -item.y, zoom: 1.15 }),
  });
  assert.ok(focused);
  assert.notDeepEqual(focused, { x: 24, y: 24, zoom: 1 });
  const saved = cameraAfterRemount({
    saved: { x: 88, y: 42, zoom: 1.2 },
    roomFocus: null,
    focusCamera: () => ({ x: 0, y: 0, zoom: 1 }),
  });
  assert.deepEqual(saved, { x: 88, y: 42, zoom: 1.2 });
});

test("焦點來源與 @Grok chip；第一層仍是對話／白板", () => {
  assert.equal(nodeFocusSource(node({ linkedEntityType: "discussion" })), "discussion");
  assert.equal(focusCardFromNode(node()).title, "茶會主視覺");
  assert.equal(mentionsGrok("嗨 @Grok 下一步？"), true);
  assert.equal(showsGrokMentionChip("@"), true);
  assert.deepEqual(FIRST_LAYER_TABS, ["對話", "白板"]);
  const chrome = src("src/features/multi-room/roomChrome.ts");
  assert.match(chrome, /FIRST_LAYER_TABS = \["對話", "白板"\]/);
});

test("房間焦點從 presence 取最新一筆，不含自己較舊的", () => {
  const picked = roomFocusFromPresence([
    { userId: "me", focusNodeId: "n-old", at: 10 },
    { userId: "peer", focusNodeId: "n-shared", at: 20 },
    { userId: "late", focusNodeId: null, at: 30 },
  ], { ignoreUserId: "me" });
  assert.equal(picked?.nodeId, "n-shared");
  assert.equal(roomFocusFromPresence([
    { userId: "peer", focusNodeId: "n-stale", at: 5 },
  ], { minAt: 10 }), null);
  const sync = src("src/cloud/roomSync.ts");
  assert.match(sync, /focusNodeId/);
  assert.match(sync, /不透明/);
  const app = src("src/App.tsx");
  assert.match(app, /roomFocusFromPresence/);
  assert.match(app, /setRoomFocus/);
});

test("boardAskContext 帶焦點與工作層短列，座標只寫約 x,y", () => {
  const ctx = boardAskContext({
    nodes: [node({ id: "n1", content: { text: "茶會主視覺" }, x: 40, y: 80 })],
    focusNode: node({ id: "n1", linkedEntityType: "discussion", content: { text: "茶會主視覺" } }),
  });
  assert.equal(ctx.focus?.nodeId, "n1");
  assert.equal(ctx.focus?.source, "discussion");
  assert.equal(ctx.workLayer?.items.length, 1);
  const items = workLayerItemsFromNodes([node({ x: 24, y: 80 })]);
  assert.equal(items[0].x, 24);
  const app = src("src/App.tsx");
  assert.match(app, /boardAskContext/);
  assert.match(app, /askAiWithBoard/);
  const edge = src("supabase/functions/room-ai-context/index.ts");
  assert.match(edge, /boardFocus/);
  assert.match(edge, /workLayerItems/);
});

test("平板焦點：相關訊息可捲到；沒有關聯顯示針對這張留言", () => {
  const related = messagesForFocus([
    message({ id: "m-a", payload: { nodeId: "n1" } }),
    message({ id: "m-b", payload: {} }),
  ], node({ id: "n1" }));
  assert.equal(related.length, 1);
  assert.equal(related[0].id, "m-a");
  const drawer = src("src/features/room-discussion/RoomDiscussion.tsx");
  assert.match(drawer, /messagesForFocus/);
  assert.match(drawer, /針對這張留言/);
  assert.match(drawer, /focus-discuss-empty/);
});

test("焦點卡看得到同事剛說，稽核句不算", () => {
  const line = lastColleagueForFocus([
    message({
      id: "g1",
      authorName: GROK_COLLEAGUE_NAME,
      body: "目前有三個下一步",
      createdAt: 20,
      payload: { agent: true, nodeId: "n1" },
    }),
    message({
      id: "a1",
      body: "已把 AI 的 2 個建議放上白板",
      createdAt: 30,
      payload: { audit: true, nodeId: "n1" },
    }),
  ], "n1");
  assert.equal(line, "同事剛說…目前有三個下一步");
  assert.equal(lastColleagueForFocus([], "n1"), null);
  const workspace = src("src/features/whiteboard/WhiteboardWorkspace.tsx");
  assert.match(workspace, /wb-colleague-said/);
});

test("預覽 origin 跟焦點；套用失敗預覽留著", () => {
  const origin = layoutOriginFromFocus({ x: 100, y: 50, width: 180, height: 96 }, { x: 10, y: 10 });
  assert.ok(origin.x > 100);
  const workspace = src("src/features/whiteboard/WhiteboardWorkspace.tsx");
  assert.match(workspace, /預覽還在，白板維持原狀/);
});
