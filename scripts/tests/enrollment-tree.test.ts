/**
 * 招生樹：討論已在板上的 202609招生 mindmap（截圖），不是空白模板玩具樹。
 * Run: npm run test:enrollment-tree
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ENROLLMENT_TREE_ROOT_LABEL,
  PLANT_ENROLLMENT_TREE_LABEL,
  discussionPayloadFromEnrollmentNode,
  enrollmentColleaguePrompt,
  enrollmentTreePath,
  findEnrollmentTreeRoots,
  isEnrollmentCampaignRootLabel,
  isEnrollmentTree2026,
  messagesForEnrollmentFocus,
  plantEnrollmentTree2026,
  shouldPlantEnrollmentTree,
} from "../../src/features/collaboration/enrollmentTree";
import { createEdge, createNode } from "../../src/features/collaboration/nodes";
import { boardAskContext, emptyBoardVerbs, focusCardFromNode, messagesForFocus } from "../../src/features/whiteboard/boardFocus";
import { FIRST_LAYER_TABS } from "../../src/features/multi-room/roomChrome";
import type { WhiteboardEdge, WhiteboardNode } from "../../src/features/collaboration/types";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function planted() {
  let n = 0;
  return plantEnrollmentTree2026({
    whiteboardId: "wb-enroll",
    roomId: "room-enroll",
    createdBy: "owner",
    idFn: () => `n${++n}`,
  });
}

/** 截圖那種已在房間裡的樹：根 202609招生，書籤下有便利貼＋文宣卡。 */
function existingCampaignTree() {
  const root = createNode({
    id: "root-202609",
    whiteboardId: "wb",
    roomId: "room",
    nodeType: "mindmap",
    createdBy: "owner",
    x: 200,
    y: 20,
    content: { text: "202609招生" },
  });
  const bookmark = createNode({
    id: "n-bookmark",
    whiteboardId: "wb",
    roomId: "room",
    nodeType: "mindmap",
    createdBy: "owner",
    x: 80,
    y: 200,
    content: { text: "書籤" },
  });
  const badge = createNode({
    id: "n-badge",
    whiteboardId: "wb",
    roomId: "room",
    nodeType: "mindmap",
    createdBy: "owner",
    x: 320,
    y: 200,
    content: { text: "胸章" },
  });
  const sticky = createNode({
    id: "n-sticky",
    whiteboardId: "wb",
    roomId: "room",
    nodeType: "text",
    createdBy: "owner",
    x: 80,
    y: 280,
    content: { text: "需要補充師父法語，正面語錄" },
  });
  const asset = createNode({
    id: "n-asset",
    whiteboardId: "wb",
    roomId: "room",
    nodeType: "room_content",
    createdBy: "owner",
    x: 80,
    y: 360,
    linkedEntityType: "version",
    linkedEntityId: "ver-bookmark",
    content: { text: "書籤稿", title: "書籤稿" },
  });
  const nodes: WhiteboardNode[] = [root, bookmark, badge, sticky, asset];
  const edges: WhiteboardEdge[] = [
    createEdge({ whiteboardId: "wb", roomId: "room", sourceNodeId: root.id, targetNodeId: bookmark.id, edgeType: "mindmap" }),
    createEdge({ whiteboardId: "wb", roomId: "room", sourceNodeId: root.id, targetNodeId: badge.id, edgeType: "mindmap" }),
    createEdge({ whiteboardId: "wb", roomId: "room", sourceNodeId: bookmark.id, targetNodeId: sticky.id, edgeType: "mindmap" }),
    createEdge({ whiteboardId: "wb", roomId: "room", sourceNodeId: bookmark.id, targetNodeId: asset.id, edgeType: "relation" }),
  ];
  return { nodes, edges, root, bookmark, badge, sticky, asset };
}

test("空板骨架對齊 202609 截圖支線，不種主視覺／招生短片玩具樹", () => {
  const tree = planted();
  assert.equal(tree.nodes[0].content.text, ENROLLMENT_TREE_ROOT_LABEL);
  assert.equal(ENROLLMENT_TREE_ROOT_LABEL, "202609招生");
  assert.ok(tree.byKey.bookmark);
  assert.ok(tree.nodes.some((node) => node.content.text === "書籤"));
  assert.ok(tree.nodes.some((node) => node.content.text === "胸章"));
  assert.ok(tree.nodes.some((node) => node.content.text === "美食地圖"));
  assert.ok(tree.nodes.every((node) => node.content.text !== "招生短片"));
  assert.ok(tree.nodes.every((node) => node.content.text !== "主視覺"));
  assert.ok(tree.nodes.every((node) => !("imageDataUrl" in node.content)));
  const workspace = readFileSync(resolve(ROOT, "src/features/whiteboard/WhiteboardWorkspace.tsx"), "utf8");
  assert.match(workspace, /wb-start-enrollment-tree/);
  assert.match(workspace, /findEnrollmentTreeRoots/);
  assert.match(workspace, /shouldPlantEnrollmentTree/);
  assert.match(workspace, /wb-tree-path/);
});

test("兩間房各自種樹不會共用固定 enroll-2026 id", () => {
  const a = plantEnrollmentTree2026({ whiteboardId: "wb-a", roomId: "room-a", createdBy: "owner" });
  const b = plantEnrollmentTree2026({ whiteboardId: "wb-b", roomId: "room-b", createdBy: "owner" });
  const ids = new Set([...a.nodes.map((node) => node.id), ...b.nodes.map((node) => node.id)]);
  assert.equal(ids.size, a.nodes.length + b.nodes.length);
});

test("點書籤：路徑是 202609招生 › 書籤", () => {
  const tree = planted();
  const bookmark = tree.nodes.find((node) => node.id === tree.byKey.bookmark);
  assert.ok(bookmark);
  const path = enrollmentTreePath(bookmark, tree.nodes, tree.edges);
  assert.equal(path?.text, "202609招生 › 書籤");
  assert.equal(isEnrollmentTree2026(path), true);
  const card = focusCardFromNode(bookmark!, { nodes: tree.nodes, edges: tree.edges });
  assert.equal(card.treePath, "202609招生 › 書籤");
  assert.equal(card.parentLabel, "202609招生");
  assert.match(card.colleaguePrompt, /202609招生 › 書籤/);
  const rootCard = focusCardFromNode(tree.nodes[0], { nodes: tree.nodes, edges: tree.edges });
  assert.deepEqual(rootCard.childBranches.map((item) => item.label), [
    "招募文案",
    "印製招募文案",
    "美食地圖",
    "擺攤企劃",
    "書籤",
    "胸章",
  ]);
  const payload = discussionPayloadFromEnrollmentNode(bookmark!, tree.nodes, tree.edges, "招生房");
  assert.equal(payload.nodeId, bookmark!.id);
  assert.equal(payload.treePath, "202609招生 › 書籤");
});

test("已在板上的 202609招生：便利貼／文宣卡算書籤支線，胸章旁支不算", () => {
  const campaign = existingCampaignTree();
  const roots = findEnrollmentTreeRoots(campaign.nodes, campaign.edges);
  assert.equal(roots[0]?.id, campaign.root.id);
  assert.equal(shouldPlantEnrollmentTree(campaign.nodes, campaign.edges), false);
  assert.equal(shouldPlantEnrollmentTree([], []), true);
  const path = enrollmentTreePath(campaign.bookmark, campaign.nodes, campaign.edges);
  assert.equal(path?.text, "202609招生 › 書籤");
  const card = focusCardFromNode(campaign.bookmark, { nodes: campaign.nodes, edges: campaign.edges });
  assert.ok(card.childBranches.some((item) => item.label.includes("師父法語")));
  assert.ok(card.childBranches.some((item) => item.label === "書籤稿"));
  const messages = [
    { id: "m-bookmark", payload: { nodeId: campaign.bookmark.id } },
    { id: "m-sticky", payload: { nodeId: campaign.sticky.id } },
    { id: "m-badge", payload: { nodeId: campaign.badge.id } },
    { id: "m-other", payload: { nodeId: "unrelated" } },
  ];
  const focused = messagesForEnrollmentFocus(messages, campaign.bookmark, campaign.nodes, campaign.edges);
  assert.deepEqual((focused ?? []).map((item) => item.id), ["m-bookmark", "m-sticky"]);
  const viaBoard = messagesForFocus(messages, campaign.bookmark, { nodes: campaign.nodes, edges: campaign.edges });
  assert.deepEqual(viaBoard.map((item) => item.id), ["m-bookmark", "m-sticky"]);
  const whole = messagesForEnrollmentFocus(messages, campaign.root, campaign.nodes, campaign.edges);
  assert.ok((whole ?? []).some((item) => item.id === "m-badge"));
  assert.equal((whole ?? []).some((item) => item.id === "m-other"), false);
});

test("根標籤 202609招生／2026招生樹都算招生樹", () => {
  assert.equal(isEnrollmentCampaignRootLabel("202609招生"), true);
  assert.equal(isEnrollmentCampaignRootLabel("2026招生樹"), true);
  assert.equal(isEnrollmentCampaignRootLabel("2026招生"), true);
  assert.equal(isEnrollmentCampaignRootLabel("擺攤企劃"), false);
  assert.equal(isEnrollmentCampaignRootLabel("茶會主視覺"), false);
});

test("問同事卡帶 treePath，旁支不進 focus label", () => {
  const tree = planted();
  const bookmark = tree.nodes.find((node) => node.id === tree.byKey.bookmark)!;
  const ask = boardAskContext({ nodes: tree.nodes, edges: tree.edges, focusNode: bookmark });
  assert.equal(ask.focus?.treePath, "202609招生 › 書籤");
  assert.equal(ask.focus?.label, "202609招生 › 書籤");
  assert.doesNotMatch(ask.focus?.label ?? "", /胸章/);
  assert.equal(ask.workLayer?.proposalId, "enrollment-tree");
  assert.equal(enrollmentColleaguePrompt(undefined), "針對這張，我們下一步做什麼？");
});

test("空板動詞含骨架；已有樹不種；第一層仍是對話／白板", () => {
  const verbs = emptyBoardVerbs();
  assert.ok(verbs.some((item) => item.id === "plant-enrollment-tree"));
  assert.ok(verbs.some((item) => item.label === PLANT_ENROLLMENT_TREE_LABEL));
  assert.deepEqual(FIRST_LAYER_TABS, ["對話", "白板"]);
  const chrome = readFileSync(resolve(ROOT, "src/features/multi-room/roomChrome.ts"), "utf8");
  assert.match(chrome, /FIRST_LAYER_TABS = \["對話", "白板"\]/);
});
