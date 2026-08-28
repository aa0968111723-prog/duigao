/**
 * WB03：frame drafts＋history frame 執行端＋雙向連結 provenance。
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import type { WhiteboardFrame, WhiteboardNode } from "../../src/features/collaboration/types";
import {
  frameCreateDraft,
  frameDeleteDraft,
  frameUpdateDraft,
  applyFrameMasked,
} from "../../src/features/collaboration/operations";
import { emptyHistory, pushHistory, undoStep, redoStep, type HistoryExecutors } from "../../src/features/whiteboard/history";
import { stickyFromDiscussion } from "../../src/features/collaboration/links";
import { anchorFromNode, openTarget } from "../../src/lib/contextAnchor";
import type { DiscussionMessage } from "../../src/features/collaboration/types";

const frame = (over: Partial<WhiteboardFrame> = {}): WhiteboardFrame => ({
  id: "f1",
  whiteboardId: "b1",
  roomId: "r1",
  title: "規劃區",
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

function frameHarness(initial: WhiteboardFrame[]) {
  const store = new Map(initial.map((item) => [item.id, item]));
  const executors: HistoryExecutors = {
    upsert: () => undefined,
    softDelete: () => undefined,
    recreate: () => undefined,
    findNode: () => undefined as WhiteboardNode | undefined,
    upsertFrame: (item) => { store.set(item.id, item); },
    deleteFrame: (id) => { store.delete(id); },
    recreateFrame: (draft) => {
      store.set(draft.entityId, applyFrameMasked(frame({ id: draft.entityId }), draft.fieldMask, draft.after));
    },
    findFrame: (id) => store.get(id),
  };
  return { store, executors };
}

test("frameUpdateDraft：只入有變的欄位；無變回 null", () => {
  const before = frame();
  const moved = frame({ x: 100, y: 60 });
  const draft = frameUpdateDraft("op-1", before, moved)!;
  assert.deepEqual([...draft.fieldMask].sort(), ["x", "y"]);
  assert.equal(draft.before.x, 0);
  assert.equal(draft.after.x, 100);
  assert.equal(frameUpdateDraft("op-2", before, frame()), null, "無變化不產 draft");
});

test("frame move 的 undo 回原位、redo 回去；改名同理", () => {
  const before = frame();
  const moved = frame({ x: 100 });
  const { store, executors } = frameHarness([moved]);
  let stack = pushHistory(emptyHistory(), frameUpdateDraft("op-1", before, moved)!);
  stack = undoStep(stack, executors, "op-2").stack;
  assert.equal(store.get("f1")!.x, 0, "undo 回原位");
  stack = redoStep(stack, executors, "op-3").stack;
  assert.equal(store.get("f1")!.x, 100, "redo 回去");
});

test("frame delete 的 undo 重建（含 title/尺寸）；create 的 undo 刪除", () => {
  const target = frame({ title: "招生規劃", width: 600 });
  const { store, executors } = frameHarness([]);
  // delete 的 undo：從 before mask 重建
  let stack = pushHistory(emptyHistory(), frameDeleteDraft("op-1", target));
  const undone = undoStep(stack, executors, "op-2");
  assert.ok(store.has("f1"), "delete 的 undo 必須重建 frame");
  assert.equal(store.get("f1")!.title, "招生規劃");
  assert.equal(store.get("f1")!.width, 600);
  assert.ok(undone.applied);
  // create 的 undo：刪除
  let stack2 = pushHistory(emptyHistory(), frameCreateDraft("op-3", target));
  undoStep(stack2, executors, "op-4");
  assert.ok(!store.has("f1"), "create 的 undo 必須刪掉 frame");
});

test("frame update 的欄位 drift → conflict-drift 誠實跳過", () => {
  const before = frame({ title: "A" });
  const renamed = frame({ title: "B" });
  const { store, executors } = frameHarness([frame({ title: "同事改的 C" })]);
  const stack = pushHistory(emptyHistory(), frameUpdateDraft("op-1", before, renamed)!);
  const result = undoStep(stack, executors, "op-2");
  assert.equal(result.skipped, "conflict-drift");
  assert.equal(store.get("f1")!.title, "同事改的 C", "不得蓋掉別人的改名");
});

test("frame 執行端未提供 → unsupported（node-only 掛載點誠實跳過）", () => {
  const nodeOnly: HistoryExecutors = {
    upsert: () => undefined,
    softDelete: () => undefined,
    recreate: () => undefined,
    findNode: () => undefined,
  };
  const stack = pushHistory(emptyHistory(), frameUpdateDraft("op-1", frame(), frame({ x: 9 }))!);
  assert.equal(undoStep(stack, nodeOnly, "op-2").skipped, "unsupported");
});

test("provenance 雙向 round-trip：訊息→sticky→anchor→discussion surface", () => {
  const message: DiscussionMessage = {
    id: "m-77",
    roomId: "r1",
    authorId: "u2",
    authorName: "小林",
    authorColor: "#abc",
    kind: "text",
    body: "擺攤動線要重排",
    payload: {},
    createdAt: 1,
    updatedAt: 1,
  };
  const sticky = stickyFromDiscussion(message, "b1", "u1");
  assert.equal(sticky.linkedEntityType, "discussion", "sticky 必須帶 discussion link（WB03 斷鏈修復）");
  assert.equal(sticky.linkedEntityId, "m-77");
  assert.equal(sticky.content.text, "擺攤動線要重排");
  assert.ok(sticky.content.sourceLabel?.includes("小林"), "出處標示含作者");
  // 回程：節點 anchor → message 臂 → discussion surface（「打開來源訊息」）
  const target = openTarget(anchorFromNode(sticky));
  assert.equal(target.surface, "discussion");
  assert.ok(target.surface === "discussion" && target.messageId === "m-77");
});
