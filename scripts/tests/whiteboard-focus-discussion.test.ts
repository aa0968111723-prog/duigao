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
  FOCUS_SHEET_COMPOSER_MIN,
  FOCUS_SHEET_PEEK_HEIGHT,
  focusSheetSnapHeights,
  incomingFocusAction,
  shouldInlineDiscussionRail,
  shouldMountFocusSheet,
  snapAfterFocusDiscuss,
  snapAfterSelectionOrEdit,
  workLayerItemsFromNodes,
} from "../../src/features/whiteboard/boardFocus";
import {
  discussionPayloadFromFocusNode,
  discussionPayloadFromNode,
  discussionShowsContentActions,
  placeFromDiscussion,
  placeRoomContentFromDiscussion,
  stickyFromDiscussion,
} from "../../src/features/collaboration/links";
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
  const sheetAt = workspace.indexOf('data-testid="wb-focus-sheet"');
  const addAt = workspace.indexOf('data-testid="whiteboard-add"');
  const canvasAt = workspace.indexOf('data-testid="wb-canvas"');
  const sheetEnd = workspace.indexOf("底部：AI 預覽確認列");
  assert.ok(canvasAt > 0 && sheetAt > canvasAt && addAt > sheetAt, "sheet 必須寫在畫布裡、五鍵之前");
  const sheetBlock = workspace.slice(sheetAt, sheetEnd > sheetAt ? sheetEnd : addAt);
  assert.match(sheetBlock, /wb-add-child/);
  assert.match(sheetBlock, /wb-next-step/);
  assert.match(sheetBlock, /打開內容/);
  assert.match(sheetBlock, /wb-node-delete/);
  assert.match(sheetBlock, /wb-lock/);
  assert.match(sheetBlock, /wb-focus-sheet-dismiss/);
  assert.equal((sheetBlock.match(/wb-context-dismiss/g) ?? []).length, 1, "sheet 只能有一顆取消選取，E2E dismiss 會 strict");
  assert.match(workspace, /!phoneFocusSheet \?/);
  const askBlock = workspace.slice(workspace.indexOf("data-testid=\"wb-ai-ask\""));
  assert.match(askBlock, /onAskBoardAi/);
  assert.doesNotMatch(askBlock.slice(0, 900), /if \(api\.onAskColleague\) \{\s*api\.onAskColleague/);
  const mbr = src("src/features/multi-room/MultiBranchRoom.tsx");
  assert.match(mbr, /discussionSlot: !railVisible/);
  // 手機打開原訊息必須關板，不能因為 boardFocused 就留在 overlay
  const openSrc = mbr.slice(mbr.indexOf("openDiscussionMessage"));
  assert.match(openSrc.slice(0, 500), /if \(!railVisible\)/);
  assert.doesNotMatch(openSrc.slice(0, 500), /!boardFocused/);
});

test("390 選卡：half 第一屏看得到討論與輸入框，動作收進 disclosure", () => {
  assert.equal(FOCUS_SHEET_PEEK_HEIGHT >= 72 && FOCUS_SHEET_PEEK_HEIGHT <= 96, true);
  const phone = focusSheetSnapHeights({ usableHeight: 844, keyboardInset: 0, peekHeight: FOCUS_SHEET_PEEK_HEIGHT });
  assert.equal(phone.viewportHeight, 844);
  assert.ok(phone.half < 844 * 0.5, "half 必須讓畫布上半露得出來");
  assert.ok(phone.half > 200, "half 必須裝得下摘要＋討論鈕＋composer");
  const workspace = src("src/features/whiteboard/WhiteboardWorkspace.tsx");
  assert.match(workspace, /useState<SheetSnap>\("half"\)/);
  assert.match(workspace, /snapAfterSelectionOrEdit/);
  assert.equal(snapAfterSelectionOrEdit({ hasSelection: true, editing: false, selectionChanged: true }), "half");
  assert.equal(snapAfterSelectionOrEdit({ hasSelection: true, editing: true, selectionChanged: true }), "peek");
  assert.equal(snapAfterSelectionOrEdit({ hasSelection: true, editing: true, selectionChanged: false }), null);
  assert.equal(snapAfterSelectionOrEdit({ hasSelection: false, editing: true, selectionChanged: true }), null);
  assert.doesNotMatch(workspace, /viewportHeight=\{typeof window === "undefined" \? 640 : window\.innerHeight\}/);
  assert.match(workspace, /viewportHeight=\{sheetSnaps\.viewportHeight\}/);
  assert.match(workspace, /peekHeight=\{sheetSnaps\.peek\}/);
  const sheetAt = workspace.indexOf('data-testid="wb-focus-sheet"');
  const addAt = workspace.indexOf('data-testid="whiteboard-add"');
  const sheetEnd = workspace.indexOf("底部：AI 預覽確認列");
  const sheetBlock = workspace.slice(sheetAt, sheetEnd > sheetAt ? sheetEnd : addAt);
  const discussAt = sheetBlock.indexOf('data-testid="wb-focus-discuss"');
  const feedAt = sheetBlock.indexOf('data-testid="wb-focus-discussion"');
  const actionsAt = sheetBlock.indexOf('data-testid="wb-focus-actions"');
  const composerHint = sheetBlock.indexOf("discussionSlot");
  assert.ok(discussAt > 0 && feedAt > discussAt, "主按鈕在討論 feed 前面");
  assert.ok(composerHint > feedAt, "composer 跟 feed 同槽");
  assert.ok(actionsAt > 0 && sheetBlock.includes("<details"), "八顆動作在 disclosure 裡");
  assert.match(sheetBlock, /這張的操作/);
  assert.equal((sheetBlock.match(/wb-context-dismiss/g) ?? []).length, 1);
  assert.match(sheetBlock, /wb-focus-sheet-dismiss/);
  assert.match(sheetBlock, /snapAfterFocusDiscuss/);
  assert.equal(snapAfterFocusDiscuss("full"), "half");
  assert.equal(snapAfterFocusDiscuss("half"), "half");
  assert.equal(snapAfterFocusDiscuss("peek"), "peek");
  const css = src("src/features/whiteboard/whiteboard.css");
  assert.match(css, /\.wb-focus-sheet-discussion \{[\s\S]*?flex:\s*1/);
  assert.match(css, /\.wb-focus-sheet-discussion \.rd-composer[\s\S]*?position:\s*static/);
  assert.match(css, /\.wb-focus-sheet \.rd-composer[\s\S]*?bottom:\s*auto/);
  assert.match(css, /\.wb-focus-sheet-discussion \.rd-decisions \{ display: none/);
  const room = src("src/features/multi-room/MultiBranchRoom.tsx");
  assert.match(room, /discussionSlot: !railVisible \? renderDiscussion\("chat", \{ compact: true \}/);
  assert.match(room, /showDecisions: opts\?\.compact \? false/);
});

test("鍵盤起來：sheet 用 usableHeight，half／full 都 cap，composer 不再疊 --kb", () => {
  const kb = focusSheetSnapHeights({
    usableHeight: 544,
    keyboardInset: 300,
    safeAreaBottom: 0,
    peekHeight: FOCUS_SHEET_PEEK_HEIGHT,
  });
  const sheetMax = 544 - FOCUS_SHEET_COMPOSER_MIN;
  assert.equal(kb.maxHeight, sheetMax);
  assert.ok(kb.half <= sheetMax && kb.full <= sheetMax);
  assert.ok(kb.half >= FOCUS_SHEET_PEEK_HEIGHT);
  const noKb = focusSheetSnapHeights({ usableHeight: 844, keyboardInset: 0, peekHeight: FOCUS_SHEET_PEEK_HEIGHT });
  assert.equal(noKb.maxHeight, 844);
  const workspace = src("src/features/whiteboard/WhiteboardWorkspace.tsx");
  assert.match(workspace, /maxHeight=\{keyboardInset > 0 \? sheetSnaps\.maxHeight : undefined\}/);
  assert.match(workspace, /useViewport\(\)/);
  const hook = src("src/hooks/useViewport.ts");
  assert.match(hook, /kbConsumers/);
  const sheet = src("src/components/BottomSheet.tsx");
  assert.match(sheet, /maxHeight\?: number/);
  assert.match(sheet, /Math\.min\(cap,/);
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

test("Focus 表面是明亮紙面，不走深色 overlay", () => {
  const css = src("src/features/whiteboard/whiteboard.css");
  assert.doesNotMatch(css, /#12100e|#161310|rgba\(20,\s*18,\s*16|rgba\(22,\s*19,\s*16/);
  assert.match(css, /\.wb-focus \{[\s\S]*?background:\s*#f7f8fc/);
  assert.match(css, /\.wb-focus-canvas \{[\s\S]*?#f7f8fc/);
  assert.match(css, /\.wb-focus-bottom \{[\s\S]*?background:\s*rgba\(255,\s*255,\s*255/);
  assert.match(css, /\.wb-focus-card \{[\s\S]*?background:\s*rgba\(255,\s*255,\s*255/);
  assert.match(css, /\.wb-focus-sheet \.m-sheet \{[\s\S]*?background:\s*rgba\(255,\s*255,\s*255/);
  assert.match(css, /\.wb-empty-board \{[\s\S]*?background:\s*rgba\(255,\s*255,\s*255/);
  assert.match(css, /\.wb-side-rail \{[\s\S]*?background:\s*#fff/);
  const visual = src("scripts/e2e/board-visual.mjs");
  assert.match(visual, /單一明亮主題/);
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

test("討論儲存讀 textarea 的值，不依賴可能還沒跟上的 editDraft", () => {
  const room = src("src/features/room-discussion/RoomDiscussion.tsx");
  assert.match(room, /querySelector\('\[data-testid="discussion-edit-input"\]'\)/);
  assert.match(room, /typed instanceof HTMLTextAreaElement \? typed\.value : editDraft/);
  const e2e = src("scripts/e2e/collaboration-workspace.mjs");
  assert.match(e2e, /先把招生流程攤在白板上（改過）/);
  assert.match(e2e, /\.rd-msg".*hasText/);
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

test("messagesForFocus：version 節點吃得到同 versionId、不同 nodeId 的訊息", () => {
  const poster = node({
    id: "n-poster",
    nodeType: "room_content",
    linkedEntityType: "version",
    linkedEntityId: "v-poster",
    sourceVersionId: "v-poster",
    content: { mediaKind: "poster", title: "擺攤文宣" },
  });
  const related = messagesForFocus([
    message({ id: "m-same", payload: { versionId: "v-poster", nodeId: "other-node" } }),
    message({ id: "m-other", payload: { versionId: "v-other" } }),
    message({ id: "m-plain", payload: {} }),
  ], poster);
  assert.equal(related.length, 1);
  assert.equal(related[0].id, "m-same");
});

test("messagesForFocus：影片區間只吃落在區間內的 startTime；點對點 0.5s", () => {
  const clip = node({
    id: "n-vid",
    nodeType: "room_content",
    linkedEntityType: "branch",
    linkedEntityId: "br-vid",
    content: { mediaKind: "video", title: "招生影片", startTime: 12, endTime: 30 },
  });
  const inRange = messagesForFocus([
    message({ id: "m-in", payload: { branchId: "br-vid", startTime: 15 } }),
    message({ id: "m-out", payload: { branchId: "br-vid", startTime: 40 } }),
  ], clip);
  assert.equal(inRange.length, 1);
  assert.equal(inRange[0].id, "m-in");
  const point = node({
    id: "n-point",
    nodeType: "room_content",
    linkedEntityType: "branch",
    linkedEntityId: "br-vid",
    content: { mediaKind: "video", startTime: 12 },
  });
  assert.equal(messagesForFocus([message({ id: "near", payload: { startTime: 12.4 } })], point).length, 1);
  assert.equal(messagesForFocus([message({ id: "far", payload: { startTime: 12.6 } })], point).length, 0);
});

test("messagesForFocus：planSectionId 對得上才算；別段不算", () => {
  const section = node({
    id: "n-plan",
    nodeType: "room_content",
    linkedEntityType: "plan",
    linkedEntityId: "br-plan",
    anchor: { type: "plan-section", branchId: "br-plan", sectionId: "s1" },
    content: { mediaKind: "plan", subtitle: "受眾是高中生" },
  });
  const related = messagesForFocus([
    message({ id: "m-hit", payload: { branchId: "br-plan", planSectionId: "s1" } }),
    message({ id: "m-miss", payload: { branchId: "br-plan", planSectionId: "s2" } }),
  ], section);
  assert.equal(related.length, 1);
  assert.equal(related[0].id, "m-hit");
});

test("焦點卡來源：poster 不是無來源；討論釘仍含討論", () => {
  const poster = focusCardFromNode(node({
    nodeType: "room_content",
    linkedEntityType: "version",
    linkedEntityId: "v1",
    content: { mediaKind: "poster", title: "擺攤文宣", versionLabel: "改一" },
  }));
  assert.equal(poster.title, "擺攤文宣");
  assert.match(poster.sourceLabel, /文宣/);
  assert.doesNotMatch(poster.sourceLabel, /無來源/);
  const region = focusCardFromNode(node({
    nodeType: "room_content",
    linkedEntityType: "version",
    linkedEntityId: "v1",
    anchor: { type: "image-region", versionId: "v1", region: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
    content: { mediaKind: "poster", title: "擺攤文宣", subtitle: "主標太淡" },
  }));
  assert.equal(region.sourceLabel, "文宣圈選 · 主標太淡");
  const sticky = stickyFromDiscussion(message({ id: "msg-88", authorName: "阿哲", body: "釘這句" }), "b1", "u1");
  const discussion = focusCardFromNode(sticky);
  assert.match(discussion.sourceLabel, /討論/);
  const ctx = boardAskContext({
    nodes: [node({
      id: "n-poster",
      nodeType: "room_content",
      linkedEntityType: "version",
      content: { mediaKind: "poster", title: "擺攤文宣" },
    })],
    focusNode: node({
      id: "n-poster",
      nodeType: "room_content",
      linkedEntityType: "version",
      content: { mediaKind: "poster", title: "擺攤文宣" },
    }),
  });
  assert.equal(ctx.focus?.source, "version");
  assert.match(ctx.focus?.sourceLabel ?? "", /文宣/);
  assert.doesNotMatch(JSON.stringify(ctx), /storage\/v1|room-assets\//);
});

test("placeRoomContentFromDiscussion：文宣／影片落成 room_content；純 text 仍便利貼；同實體不複製", () => {
  const room = {
    versions: [{
      id: "v1",
      branchId: "br-poster",
      label: "改一",
      kind: "image" as const,
      imageDataUrl: "data:image/png;base64,abc",
    }],
    branches: [{ id: "br-poster", name: "擺攤文宣", branchType: "poster" as const }],
    plans: [],
  };
  const posterMsg = message({
    id: "m-poster",
    kind: "poster",
    body: "擺攤文宣",
    payload: { versionId: "v1", title: "擺攤文宣" },
  });
  const first = placeRoomContentFromDiscussion(posterMsg, "b1", "u1", room);
  assert.equal(first.created, true);
  assert.equal(first.node.nodeType, "room_content");
  assert.notEqual(first.node.nodeType, "text");
  assert.equal(first.node.content.mediaKind, "poster");
  assert.ok(first.node.content.thumbnailUrl);
  assert.equal(first.node.anchor?.messageId, "m-poster");
  const second = placeRoomContentFromDiscussion(posterMsg, "b1", "u1", room, [first.node]);
  assert.equal(second.created, false);
  assert.equal(second.node.id, first.node.id);

  const videoMsg = message({
    id: "m-vid",
    kind: "video",
    body: "招生影片",
    payload: { branchId: "br-vid", startTime: 12, endTime: 30, title: "招生影片" },
  });
  const videoRoom = {
    versions: [{
      id: "v-vid",
      branchId: "br-vid",
      label: "A",
      kind: "video" as const,
      imageDataUrl: "https://example.test/poster.jpg",
      videoUrl: "https://example.test/clip.mp4",
    }],
    branches: [{ id: "br-vid", name: "招生影片", branchType: "video" as const }],
    plans: [],
  };
  const video = placeRoomContentFromDiscussion(videoMsg, "b1", "u1", videoRoom);
  assert.equal(video.node.content.mediaKind, "video");
  assert.equal(video.node.content.startTime, 12);
  assert.equal(video.node.nodeType, "room_content");

  const text = placeFromDiscussion(message({ id: "m-text", kind: "text", body: "先推茶會" }), "b1", "u1", room);
  assert.equal(text.node.nodeType, "text");
  assert.equal(text.node.linkedEntityType, "discussion");
});

test("composer 焦點錨帶 versionId／時間／段落；內容卡按鈕不只認 branchId", () => {
  const posterPayload = discussionPayloadFromFocusNode(node({
    id: "n-poster",
    nodeType: "room_content",
    linkedEntityType: "version",
    linkedEntityId: "v1",
    sourceVersionId: "v1",
    content: { mediaKind: "poster", title: "擺攤文宣" },
  }));
  assert.equal(posterPayload.versionId, "v1");
  assert.equal(posterPayload.nodeId, "n-poster");
  const videoPayload = discussionPayloadFromFocusNode(node({
    id: "n-vid",
    nodeType: "room_content",
    linkedEntityType: "branch",
    linkedEntityId: "br-vid",
    content: { mediaKind: "video", startTime: 12, endTime: 30 },
  }));
  assert.equal(videoPayload.startTime, 12);
  assert.equal(videoPayload.branchId, "br-vid");
  const planPayload = discussionPayloadFromFocusNode(node({
    id: "n-plan",
    nodeType: "room_content",
    linkedEntityType: "plan",
    linkedEntityId: "br-plan",
    anchor: { type: "plan-section", branchId: "br-plan", sectionId: "s1" },
    content: { mediaKind: "plan" },
  }));
  assert.equal(planPayload.branchId, "br-plan");
  assert.equal(planPayload.planSectionId, "s1");
  assert.equal(discussionShowsContentActions(message({ kind: "poster", payload: { versionId: "v1" } })), true);
  assert.equal(discussionShowsContentActions(message({ kind: "text", payload: {} })), false);
  const drawer = src("src/features/room-discussion/RoomDiscussion.tsx");
  assert.match(drawer, /discussionShowsContentActions/);
  assert.match(drawer, /discussionPayloadFromFocusNode/);
  assert.match(drawer, /打開內容/);
  assert.doesNotMatch(drawer, /kind === "poster".*&& message\.payload\.branchId/);
  const workspace = src("src/features/whiteboard/WhiteboardWorkspace.tsx");
  assert.match(workspace, /連到相關內容/);
  assert.match(workspace, /wb-relate-content/);
  assert.match(workspace, /openContentFromNode/);
  const app = src("src/App.tsx");
  assert.match(app, /placeFromDiscussion/);
  assert.doesNotMatch(app, /stickyFromDiscussion\(/);
  assert.match(workspace, /incomingFocusAction/);
  assert.match(workspace, /childSourceNode/);
  assert.match(workspace, /stepSourceNode/);
});

test("incoming focus：編輯中的另一張卡不被釘文宣搶走", () => {
  assert.equal(incomingFocusAction({ incomingId: null, appliedId: "poster", editingId: "mind" }), "clear");
  assert.equal(incomingFocusAction({ incomingId: "poster", appliedId: "poster", editingId: "mind" }), "skip");
  assert.equal(incomingFocusAction({ incomingId: "poster", appliedId: null, editingId: "mind" }), "consume");
  assert.equal(incomingFocusAction({ incomingId: "poster", appliedId: null, editingId: null, selectedId: "mind" }), "consume");
  assert.equal(incomingFocusAction({ incomingId: "poster", appliedId: null, editingId: null }), "apply");
  assert.equal(incomingFocusAction({ incomingId: "poster", appliedId: null, editingId: "poster" }), "apply");
});
