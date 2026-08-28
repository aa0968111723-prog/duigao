/**
 * WB03：history 層協調器 — closed/repush/巢狀/程式性關閉/zombie 亂序。
 * 模擬瀏覽器：back() 之後手動呼叫 handlePop()（瀏覽器的 popstate）。
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { createLayerStack, type LayerBackResponse } from "../../src/lib/historyLayers";

function harness() {
  const log: string[] = [];
  const history = {
    pushState: (state: unknown) => log.push(`push:${(state as { layer: string }).layer}`),
    back: () => log.push("back"),
  };
  const stack = createLayerStack(history);
  return { log, stack };
}

test("單層：back → onBack closed → 層消失、外層不受擾", () => {
  const { log, stack } = harness();
  let closed = 0;
  stack.push("focus", () => { closed += 1; return "closed"; });
  assert.equal(stack.depth(), 1);
  stack.handlePop(); // 使用者 back
  assert.equal(closed, 1);
  assert.equal(stack.depth(), 0);
  stack.handlePop(); // 再 back：沒有層 — 不干預（外層導航）
  assert.equal(closed, 1);
  assert.deepEqual(log, ["push:focus"]);
});

test("repush：層自理內層 UI（白板 sheet）— 第一次 back 關 sheet 補格、第二次退層", () => {
  const { log, stack } = harness();
  let sheetOpen = true;
  const responses: LayerBackResponse[] = [];
  stack.push("board-focus", () => {
    if (sheetOpen) { sheetOpen = false; responses.push("repush"); return "repush"; }
    responses.push("closed"); return "closed";
  });
  stack.handlePop();
  assert.equal(stack.depth(), 1, "repush 後層還活著");
  stack.handlePop();
  assert.equal(stack.depth(), 0);
  assert.deepEqual(responses, ["repush", "closed"]);
  assert.deepEqual(log, ["push:board-focus", "push:board-focus"]);
});

test("巢狀：overlay 疊在 focus 上 — back 只打棧頂（overlay），focus 不動", () => {
  const { stack } = harness();
  const hits: string[] = [];
  stack.push("board-focus", () => { hits.push("focus"); return "closed"; });
  stack.push("content-overlay", () => { hits.push("overlay"); return "closed"; });
  stack.handlePop();
  assert.deepEqual(hits, ["overlay"], "focus 的 onBack 不得被 overlay 的 back 誤觸（WB03 修的真 bug）");
  assert.equal(stack.depth(), 1);
  stack.handlePop();
  assert.deepEqual(hits, ["overlay", "focus"]);
});

test("程式性關閉棧頂：back() 消耗自己的格，產生的 pop 不打下層", () => {
  const { log, stack } = harness();
  const hits: string[] = [];
  stack.push("board-focus", () => { hits.push("focus"); return "closed"; });
  const removeOverlay = stack.push("content-overlay", () => { hits.push("overlay"); return "closed"; });
  removeOverlay(false); // UI 關閉鈕，不是 back
  assert.ok(log.includes("back"), "程式性關閉要消耗自己 push 的格");
  stack.handlePop(); // ← 這個 pop 是上面 back() 產生的
  assert.deepEqual(hits, [], "消耗自己格的 pop 不得派給任何層");
  assert.equal(stack.depth(), 1);
  stack.handlePop(); // 真使用者 back
  assert.deepEqual(hits, ["focus"]);
});

test("zombie 亂序：底層被程式性關閉 — 之後的 pop 先打活層、再吃 zombie 格", () => {
  const { stack } = harness();
  const hits: string[] = [];
  const removeFocus = stack.push("board-focus", () => { hits.push("focus"); return "closed"; });
  stack.push("content-overlay", () => { hits.push("overlay"); return "closed"; });
  removeFocus(false); // 亂序：focus 不在棧頂 → zombie
  assert.equal(stack.depth(), 1, "zombie 不算活層");
  stack.handlePop();
  assert.deepEqual(hits, ["overlay"], "活層照常收 back");
  stack.handlePop(); // 這格屬於 zombie — 消耗且不打任何 onBack
  assert.deepEqual(hits, ["overlay"]);
  assert.equal(stack.depth(), 0);
});

test("remove 重複呼叫是 no-op", () => {
  const { log, stack } = harness();
  const remove = stack.push("focus", () => "closed");
  remove(false);
  const backs = log.filter((entry) => entry === "back").length;
  remove(false);
  remove(true);
  assert.equal(log.filter((entry) => entry === "back").length, backs, "重複 remove 不得再 back");
});
