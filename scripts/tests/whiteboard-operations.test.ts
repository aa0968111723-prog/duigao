/**
 * WB01：操作事件純函式層（ADR-014＋Grok wb00 F2 契約）。
 *
 * 三個核心保證各自有反例測試：
 *  1. undo 永不整列還原 — applyMasked 只動 mask 內欄位（F2 repro 3 的
 *     「A 的 move-undo 吃掉 B 的字」在此被機械性排除）。
 *  2. inverse 是 before/after 對調＋op 型別翻轉，round-trip 回到原狀。
 *  3. mask 外的路徑被靜默忽略 — 幽靈/壞 op 傷害面有界。
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import type { WhiteboardNode } from "../../src/features/collaboration/types";
import {
  applyMasked,
  diffMask,
  inverseDraft,
  maskedValues,
  nodeCreateDraft,
  nodeDeleteDraft,
  nodeUpdateDraft,
} from "../../src/features/collaboration/operations";

const node = (over: Partial<WhiteboardNode> = {}): WhiteboardNode => ({
  id: "n1",
  whiteboardId: "b1",
  roomId: "r1",
  nodeType: "text",
  x: 20,
  y: 30,
  width: 180,
  height: 96,
  content: { text: "招生" },
  createdBy: "u1",
  createdAt: 1000,
  updatedAt: 1000,
  version: 3,
  ...over,
});

test("diffMask：位置移動只出 x/y；內容變更出 content.<key> 路徑", () => {
  const before = node();
  const moved = node({ x: 100, y: 200 });
  assert.deepEqual(diffMask(before, moved).sort(), ["x", "y"]);
  const retitled = node({ content: { text: "茶會" } });
  assert.deepEqual(diffMask(before, retitled), ["content.text"]);
});

test("nodeUpdateDraft：move-only 归類 node-move；before/after 只含 mask 欄位", () => {
  const before = node();
  const moved = node({ x: 100, y: 200 });
  const draft = nodeUpdateDraft("op-1", before, moved);
  assert.ok(draft);
  assert.equal(draft!.opType, "node-move");
  assert.deepEqual(draft!.before, { x: 20, y: 30 });
  assert.deepEqual(draft!.after, { x: 100, y: 200 });
  // 內容欄位不在 payload — 有界
  assert.ok(!("content.text" in draft!.before));
  // 無變更 → null（不記空 op）
  assert.equal(nodeUpdateDraft("op-2", before, node()), null);
});

test("inverse round-trip：update/move 的 undo 再 redo 回到原狀；create↔delete 只翻型別（執行層在 WB02/04）", () => {
  const before = node();
  const after = node({ x: 100, content: { text: "茶會" } });
  const draft = nodeUpdateDraft("op-1", before, after)!;
  const undo = inverseDraft(draft, "op-2");
  assert.deepEqual(undo.before, draft.after);
  assert.deepEqual(undo.after, draft.before);
  const redo = inverseDraft(undo, "op-3");
  assert.deepEqual(redo.after, draft.after);
  // create/delete 的 inverse 是「事實描述」：opType 翻轉＋before/after 對調。
  // 它們的**執行**需要 softDeleteNode / upsertNode（WB01 刻意不佈線）—
  // 這裡只驗描述正確，不宣稱 applyMasked 能執行它們（Grok wb01 F5）。
  const createInverse = inverseDraft(nodeCreateDraft("op-4", before), "op-5");
  assert.equal(createInverse.opType, "node-delete");
  assert.deepEqual(createInverse.after, {});
  const deleteInverse = inverseDraft(nodeDeleteDraft("op-6", before), "op-7");
  assert.equal(deleteInverse.opType, "node-create");
  // delete 的 before（=inverse 的 after）帶著重建所需的 masked 欄位
  assert.equal(deleteInverse.after["content.text"], "招生");
});

test("diffMask：content 內非原始值（陣列）以結構相等比較，不因新參照誤報（F6）", () => {
  const a = node({ content: { text: "同", groupIds: ["g1", "g2"] } as never });
  const b = node({ content: { text: "同", groupIds: ["g1", "g2"] } as never });
  assert.deepEqual(diffMask(a, b), []);
  const c = node({ content: { text: "同", groupIds: ["g1"] } as never });
  assert.deepEqual(diffMask(a, c), ["content.groupIds"]);
});

test("applyMasked：頂層必填數值缺值時保留現值，不產生 NaN 節點（F6）", () => {
  const current = node({ x: 50 });
  const out = applyMasked(current, ["x", "frameId"], {});
  assert.equal(out.x, 50);
  assert.equal(out.frameId, undefined);
});

test("applyMasked：只動 mask 內欄位 — B 的並發修改不被 A 的 undo 吃掉（F2 repro）", () => {
  // A 移動了節點（op 記錄 x/y），同時 B 改了字（current 的 content 是 B 的）
  const current = node({ x: 100, y: 200, content: { text: "B 改過的字" }, version: 7 });
  const aUndo = inverseDraft(nodeUpdateDraft("op-1", node(), node({ x: 100, y: 200 }))!, "op-2");
  const restored = applyMasked(current, aUndo.fieldMask, aUndo.after);
  assert.equal(restored.x, 20);
  assert.equal(restored.y, 30);
  // B 的字原封不動 — 整列還原會在這裡露餡
  assert.equal(restored.content.text, "B 改過的字");
  // version 不被 applyMasked 動（呼叫端帶 acked version 走 OCC）
  assert.equal(restored.version, 7);
});

test("applyMasked：content 路徑替換不整包換 content；mask 外路徑被忽略", () => {
  const current = node({ content: { text: "現況", extra: "保留我" } as never });
  const out = applyMasked(current, ["content.text", "evil.path", "createdBy"], {
    "content.text": "回到過去",
    "evil.path": "x",
    createdBy: "attacker",
  });
  assert.equal(out.content.text, "回到過去");
  assert.equal((out.content as Record<string, unknown>).extra, "保留我");
  // createdBy 不在 MASKABLE_FIELDS — 靜默忽略
  assert.equal(out.createdBy, "u1");
});

test("maskedValues：undefined 欄位不入 payload（jsonb 有界）", () => {
  const values = maskedValues(node(), ["x", "frameId", "content.text"]);
  assert.deepEqual(values, { x: 20, "content.text": "招生" });
});
