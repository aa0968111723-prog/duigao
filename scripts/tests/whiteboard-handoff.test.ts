/**
 * PR-GAP-06 restack：疊在 #116（#78 檔名 0024–0028）之上的 handoff 測試。
 *
 * 不實作 #78 schema。不改 whiteboard/**、operations/types/nodes/links/offline、
 * 也不改 0024–0028 SQL。這裡只釘住：
 *  1. 整房 last-write-wins 覆蓋若被重新引入必須失敗
 *  2. 空白板進場與 conversation↔node 在 #78/#116 樹上已有證據
 *  3. 本批沒有把他們的 schema 複製走、也沒宣告全目標完成
 *  4. 檔名是新的 0024–0028，不是 #78/#103 的舊 0022–0026
 *
 * Run: npx tsx --test scripts/tests/whiteboard-handoff.test.ts
 */
import { strict as assert } from "node:assert";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { WhiteboardNode } from "../../src/features/collaboration/types";
import { applyBoardPatches, reconcileNodes, replaceBoardGraph } from "../../src/features/collaboration/offline";
import { LINKED_ENTITY_TYPES, DISCUSSION_KINDS } from "../../src/features/collaboration/types";
import { discussionPayloadFromNode, stickyFromDiscussion } from "../../src/features/collaboration/links";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function src(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

function node(over: Partial<WhiteboardNode> = {}): WhiteboardNode {
  return {
    id: "n1",
    whiteboardId: "b1",
    roomId: "r1",
    nodeType: "text",
    x: 0,
    y: 0,
    width: 180,
    height: 96,
    content: { text: "本地" },
    createdBy: "u1",
    createdAt: 1,
    updatedAt: 1,
    version: 3,
    ...over,
  };
}

/** 整房 last-write-wins：遠端快照整包蓋掉本地。這是被禁止的回歸。 */
function wholeRoomLastWriteWins(local: WhiteboardNode[], remote: WhiteboardNode[]): WhiteboardNode[] {
  return remote;
}

test("H-01: 整房 last-write-wins 會丟掉他板／他節點；現行合併不得這樣做", () => {
  const localA = node({ id: "a", whiteboardId: "b1", content: { text: "A 本地新" }, version: 5 });
  const localB = node({ id: "b", whiteboardId: "b2", content: { text: "B 他板" }, version: 2 });
  const remoteOnlyA = [node({ id: "a", whiteboardId: "b1", content: { text: "A 遠端舊空房" }, version: 1 })];

  const lww = wholeRoomLastWriteWins([localA, localB], remoteOnlyA);
  assert.equal(lww.some((item) => item.id === "b"), false, "對照組：整房 LWW 必須被證明會丢掉 B");

  const patched = applyBoardPatches([localA, localB], [], new Map(), [
    { type: "node-upsert", node: remoteOnlyA[0] },
  ], null);
  assert.equal(patched.nodes.some((item) => item.id === "b"), true, "增量 patch 不得整房替換");
  assert.equal(patched.nodes.find((item) => item.id === "a")?.content.text, "A 本地新", "較舊遠端不得 LWW 蓋掉較高 version");

  const reconciled = reconcileNodes([localA, localB], remoteOnlyA, []);
  assert.equal(reconciled.some((item) => item.id === "b"), true, "reconcile 必須保留遠端快照沒帶到的本地節點");
  assert.equal(reconciled.find((item) => item.id === "a")?.content.text, "A 本地新");

  const replaced = replaceBoardGraph(
    [localA, localB],
    [],
    new Map(),
    "b1",
    { nodes: remoteOnlyA, edges: [] },
    null,
  );
  assert.equal(replaced.nodes.some((item) => item.id === "b"), true, "板級整替不得動到他板");
});

test("H-01b: 空 snapshot 不得洗掉本地 nodes（applyRemoteRoom 契約）", () => {
  const local = [node({ id: "keep", content: { text: "還在" }, version: 4 })];
  const emptyIncoming: WhiteboardNode[] = [];
  // App.tsx applyRemoteRoom：incoming 空且 current 有內容 → 保留 current
  const kept = emptyIncoming.length === 0 && local.length ? local : emptyIncoming;
  assert.equal(kept, local);

  const app = src("src/App.tsx");
  const applyStart = app.indexOf("const applyRemoteRoom = useCallback");
  assert.ok(applyStart >= 0, "applyRemoteRoom 必須存在");
  const applyFn = app.slice(applyStart, applyStart + 2800);
  assert.match(applyFn, /reconcileNodes\(/, "快照合併必須走 reconcileNodes，不是整包覆寫");
  assert.match(
    applyFn,
    /incomingNodes\.length === 0 && currentNodes\.length/,
    "空 snapshot 必須保留本地 nodes",
  );
  assert.doesNotMatch(
    applyFn,
    /whiteboardNodes:\s*(normalized\.whiteboardNodes|incomingNodes)\s*[,}]/,
    "applyRemoteRoom 不得無條件採用遠端整包 nodes",
  );

  const repo = src("src/cloud/roomRepository.ts");
  assert.match(repo, /entity-level writes \(never overwrite the whole room\)/);
});

test("H-02: 空白板進場在 #78/#116 樹上已誠實（本批不重寫該 UI）", () => {
  const workspace = src("src/features/whiteboard/WhiteboardWorkspace.tsx");
  assert.match(workspace, /wb-empty/);
  assert.match(workspace, /還沒有白板/);
  assert.match(workspace, /建立白板/);
  assert.match(workspace, /招生規劃/);
});

test("H-03: conversation↔node 型別與 UI 已在 #78 樹；本批不重做 schema", () => {
  assert.ok(LINKED_ENTITY_TYPES.includes("discussion"));
  assert.ok(DISCUSSION_KINDS.includes("node"));

  const message = {
    id: "m1",
    roomId: "r1",
    authorId: "u1",
    authorName: "小明",
    kind: "text" as const,
    body: "這段要放到板上",
    createdAt: 1,
  };
  const sticky = stickyFromDiscussion(message as never, "b1", "u1");
  assert.equal(sticky.linkedEntityType, "discussion");
  assert.equal(sticky.linkedEntityId, "m1");

  const payload = discussionPayloadFromNode(node({ id: "n9", whiteboardId: "b1", content: { text: "看這裡" } }), "招生");
  assert.ok(payload);

  const workspace = src("src/features/whiteboard/WhiteboardWorkspace.tsx");
  assert.match(workspace, /wb-open-source-message/);
  assert.match(workspace, /打開來源訊息/);
  assert.match(workspace, /加到白板上/);

  const app = src("src/App.tsx");
  assert.match(app, /stickyFromDiscussion/);
  assert.match(app, /discussionPayloadFromNode/);
  assert.match(app, /shareNodeToDiscussion|addMessageToBoard/);
});

test("H-04: Focus Mode chrome 已在 #78 擁有檔內 — 本批拒絕重寫", () => {
  const workspace = src("src/features/whiteboard/WhiteboardWorkspace.tsx");
  assert.match(workspace, /wb-focus/);
  assert.match(workspace, /wb-focus-top/);
  assert.match(workspace, /wb-focus-bottom/);
  assert.match(workspace, /data-testid="whiteboard-workspace"/);
});

test("H-05: 本批沒有新增 whiteboard SQL，檔名是 0024–0028，也沒宣告全目標完成", () => {
  const migrations = readdirSync(resolve(ROOT, "supabase/migrations")).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(migrations.includes("0024_whiteboard_canonical_columns.sql"), "#116 樹上是新檔名 0024 whiteboard（勿複製到 main）");
  assert.ok(migrations.includes("0025_whiteboard_frames.sql"));
  assert.ok(migrations.includes("0026_whiteboard_operations.sql"));
  assert.ok(migrations.includes("0027_whiteboard_versions.sql"));
  assert.ok(migrations.includes("0028_whiteboard_freehand.sql"));
  assert.equal(
    migrations.includes("0022_whiteboard_canonical_columns.sql"),
    false,
    "舊 #78/#103 檔名 0022_whiteboard_* 不得留在此 restack",
  );
  assert.equal(
    migrations.includes("0026_whiteboard_freehand.sql"),
    false,
    "舊 #78/#103 檔名 0026_whiteboard_freehand 不得留在此 restack",
  );
  assert.equal(
    migrations.includes("0022_discussion_author_integrity.sql"),
    false,
    "本分支不得把 main 的 0022 討論 integrity 混進來假裝已 rebase",
  );

  const handoff = src("docs/cursor-gap-remediation/WHITEBOARD_HANDOFF.md");
  assert.match(handoff, /HANDOFF \/ INCOMPLETE/);
  assert.match(handoff, /編號碰撞/);
  assert.match(handoff, /拒絕重寫/);
  assert.match(handoff, /0024_whiteboard_canonical_columns\.sql/);
  assert.match(handoff, /0028_whiteboard_freehand\.sql/);

  const evidence = src("docs/cursor-gap-remediation/FINAL_EVIDENCE.md");
  assert.match(evidence, /全站目標未完成/);
  assert.doesNotMatch(evidence, /GOAL COMPLETE|目標已完成|mark complete/i);
  assert.match(evidence, /#97/);
  assert.match(evidence, /#116/);
  assert.match(evidence, /#106/);

  assert.equal(existsSync(resolve(ROOT, "docs/cursor-gap-remediation/WHITEBOARD_HANDOFF.md")), true);
});
