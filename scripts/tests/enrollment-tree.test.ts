/**
 * 2026招生樹：怎麼在對稿裡討論（路徑、焦點 feed、空板種樹）。
 * Run: npm run test:enrollment-tree
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ENROLLMENT_TREE_ROOT_LABEL,
  discussionPayloadFromEnrollmentNode,
  enrollmentColleaguePrompt,
  enrollmentTreePath,
  isEnrollmentTree2026,
  messagesForEnrollmentFocus,
  plantEnrollmentTree2026,
} from "../../src/features/collaboration/enrollmentTree";
import { boardAskContext, emptyBoardVerbs, focusCardFromNode, messagesForFocus } from "../../src/features/whiteboard/boardFocus";
import { FIRST_LAYER_TABS } from "../../src/features/multi-room/roomChrome";

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

test("種 2026招生樹：根＋文宣／影片／企劃支線，不碰 versions", () => {
  const tree = planted();
  assert.equal(tree.nodes[0].content.text, ENROLLMENT_TREE_ROOT_LABEL);
  assert.ok(tree.nodes.every((node) => node.nodeType === "mindmap"));
  assert.ok(tree.edges.every((edge) => edge.edgeType === "mindmap"));
  assert.ok(tree.byKey["video-clip"]);
  assert.ok(tree.nodes.some((node) => node.content.text === "招生短片"));
  assert.ok(tree.nodes.every((node) => !("imageDataUrl" in node.content)));
  const workspace = readFileSync(resolve(ROOT, "src/features/whiteboard/WhiteboardWorkspace.tsx"), "utf8");
  assert.match(workspace, /plant-enrollment-tree/);
  assert.match(workspace, /wb-start-enrollment-tree/);
  assert.match(workspace, /plantEnrollmentTree2026/);
  assert.match(workspace, /wb-tree-path/);
});

test("點招生短片：路徑是 2026招生樹 › 影片 › 招生短片", () => {
  const tree = planted();
  const clip = tree.nodes.find((node) => node.id === tree.byKey["video-clip"]);
  assert.ok(clip);
  const path = enrollmentTreePath(clip, tree.nodes, tree.edges);
  assert.equal(path?.text, "2026招生樹 › 影片 › 招生短片");
  assert.equal(isEnrollmentTree2026(path), true);
  const card = focusCardFromNode(clip!, { nodes: tree.nodes, edges: tree.edges });
  assert.equal(card.treePath, "2026招生樹 › 影片 › 招生短片");
  assert.match(card.colleaguePrompt, /2026招生樹 › 影片 › 招生短片/);
  const payload = discussionPayloadFromEnrollmentNode(clip!, tree.nodes, tree.edges, "淡江招生房");
  assert.equal(payload.nodeId, clip!.id);
  assert.equal(payload.treePath, "2026招生樹 › 影片 › 招生短片");
  assert.equal(payload.treeRootId, tree.rootId);
});

test("支線討論吃得到祖先，吃不到旁支；根看整棵樹", () => {
  const tree = planted();
  const clipId = tree.byKey["video-clip"];
  const heroId = tree.byKey["poster-hero"];
  const rootId = tree.rootId;
  const messages = [
    { id: "m-clip", payload: { nodeId: clipId } },
    { id: "m-video", payload: { nodeId: tree.byKey.video } },
    { id: "m-hero", payload: { nodeId: heroId } },
    { id: "m-other", payload: { nodeId: "unrelated" } },
  ];
  const clip = tree.nodes.find((node) => node.id === clipId)!;
  const focused = messagesForEnrollmentFocus(messages, clip, tree.nodes, tree.edges);
  assert.deepEqual((focused ?? []).map((item) => item.id), ["m-clip", "m-video"]);
  const viaBoard = messagesForFocus(messages, clip, { nodes: tree.nodes, edges: tree.edges });
  assert.deepEqual(viaBoard.map((item) => item.id), ["m-clip", "m-video"]);
  const root = tree.nodes.find((node) => node.id === rootId)!;
  const whole = messagesForEnrollmentFocus(messages, root, tree.nodes, tree.edges);
  assert.ok((whole ?? []).some((item) => item.id === "m-hero"));
  assert.ok((whole ?? []).some((item) => item.id === "m-clip"));
  assert.equal((whole ?? []).some((item) => item.id === "m-other"), false);
});

test("問同事卡帶 treePath，旁支不進 focus label", () => {
  const tree = planted();
  const clip = tree.nodes.find((node) => node.id === tree.byKey["video-clip"])!;
  const ask = boardAskContext({ nodes: tree.nodes, edges: tree.edges, focusNode: clip });
  assert.equal(ask.focus?.treePath, "2026招生樹 › 影片 › 招生短片");
  assert.equal(ask.focus?.label, "2026招生樹 › 影片 › 招生短片");
  assert.doesNotMatch(ask.focus?.label ?? "", /主視覺/);
  assert.equal(ask.workLayer?.proposalId, "enrollment-tree");
  assert.equal(enrollmentColleaguePrompt(undefined), "針對這張，我們下一步做什麼？");
});

test("空板動詞含種樹；第一層仍是對話／白板", () => {
  const verbs = emptyBoardVerbs();
  assert.ok(verbs.some((item) => item.id === "plant-enrollment-tree"));
  assert.deepEqual(FIRST_LAYER_TABS, ["對話", "白板"]);
  const chrome = readFileSync(resolve(ROOT, "src/features/multi-room/roomChrome.ts"), "utf8");
  assert.match(chrome, /FIRST_LAYER_TABS = \["對話", "白板"\]/);
});
