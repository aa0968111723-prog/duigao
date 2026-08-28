/**
 * History 層協調器：closed/repush/巢狀/程式性關閉/亂序/forward。
 *
 * harness 模擬真實瀏覽器的 history 條目陣列（pushState 截斷 forward、
 * back 非同步送 popstate 並帶那格的 state）。只呼叫 handlePop() 而不給
 * state 是測不出序號語意的 — 那等於「落在基準格」。
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { createLayerStack } from "../../src/lib/historyLayers";

function harness(options: { initialState?: unknown; clock?: { now: () => number; advance: (ms: number) => void } } = {}) {
  const log: string[] = [];
  const entries: unknown[] = [options.initialState ?? null]; // 基準格
  let index = 0;
  const pending: unknown[] = [];
  const history = {
    pushState: (state: unknown) => {
      entries.splice(index + 1); // 前進記錄被截斷（瀏覽器行為）
      entries.push(state);
      index = entries.length - 1;
      log.push(`push:${(state as { __layer: string }).__layer}`);
    },
    back: () => {
      log.push("back");
      if (index > 0) {
        index -= 1;
        pending.push(entries[index]);
      }
    },
  };
  let clockNow = 0;
  const clock = options.clock ?? { now: () => clockNow, advance: (ms: number) => { clockNow += ms; } };
  const stack = createLayerStack({ ...history, getState: () => entries[index] }, () => clock.now());
  /** 派送已排隊的 popstate（模擬瀏覽器非同步送達）。 */
  const flush = () => {
    while (pending.length) stack.handlePop(pending.shift());
  };
  const userBack = () => {
    history.back();
    flush();
  };
  const userForward = () => {
    if (index >= entries.length - 1) return;
    index += 1;
    stack.handlePop(entries[index]);
  };
  /** 模擬「back() 沒有產生 popstate」（已在最舊一格／導覽被取消）。 */
  const swallowNextBack = () => { pending.length = 0; };
  return { log, stack, userBack, userForward, flush, clock, swallowNextBack };
}

test("單層：back → onBack closed → 層消失、外層不受擾", () => {
  const { stack, userBack } = harness();
  let closed = 0;
  stack.push("focus", () => { closed += 1; return "closed"; });
  assert.equal(stack.depth(), 1);
  userBack();
  assert.equal(closed, 1);
  assert.equal(stack.depth(), 0);
  userBack(); // 已在基準格，沒有層可關
  assert.equal(closed, 1);
});

test("repush：層自理內層 UI（白板 sheet）— 第一次 back 關 sheet、第二次退層", () => {
  const { stack, userBack } = harness();
  let sheetOpen = true;
  const responses: string[] = [];
  stack.push("board-focus", () => {
    if (sheetOpen) { sheetOpen = false; responses.push("repush"); return "repush"; }
    responses.push("closed"); return "closed";
  });
  userBack();
  assert.equal(stack.depth(), 1, "repush 後層還活著");
  userBack();
  assert.equal(stack.depth(), 0);
  assert.deepEqual(responses, ["repush", "closed"]);
});

test("巢狀：overlay 疊在 focus 上 — back 只打棧頂，focus 不動", () => {
  const { stack, userBack } = harness();
  const hits: string[] = [];
  stack.push("board-focus", () => { hits.push("focus"); return "closed"; });
  stack.push("content-overlay", () => { hits.push("overlay"); return "closed"; });
  userBack();
  assert.deepEqual(hits, ["overlay"], "focus 不得被 overlay 的 back 誤觸");
  assert.equal(stack.depth(), 1);
  userBack();
  assert.deepEqual(hits, ["overlay", "focus"]);
});

test("程式性關閉棧頂：吃掉自己那格，產生的 pop 不打下層", () => {
  const { log, stack, flush, userBack } = harness();
  const hits: string[] = [];
  stack.push("board-focus", () => { hits.push("focus"); return "closed"; });
  const removeOverlay = stack.push("content-overlay", () => { hits.push("overlay"); return "closed"; });
  removeOverlay(false); // UI 關閉鈕，不是 back
  assert.ok(log.includes("back"), "程式性關閉要消耗自己 push 的格");
  flush();
  assert.deepEqual(hits, [], "消耗自己格的 pop 不得派給任何層");
  assert.equal(stack.depth(), 1);
  userBack();
  assert.deepEqual(hits, ["focus"], "之後的使用者 back 正常關 focus");
});

test("S18 forward 幽靈格：關層後按「下一頁」不得把下層關掉", () => {
  const { stack, userBack, userForward } = harness();
  const hits: string[] = [];
  stack.push("board-focus", () => { hits.push("focus"); return "closed"; });
  stack.push("content-overlay", () => { hits.push("overlay"); return "closed"; });
  userBack(); // 關 overlay
  assert.deepEqual(hits, ["overlay"]);
  userForward(); // 落在 overlay 的舊格 — 這是前進，不是返回
  assert.deepEqual(hits, ["overlay"], "forward 不得觸發 onBack（舊計數式會把白板關掉）");
  assert.equal(stack.depth(), 1, "focus 還活著");
});

test("S18 亂序關層：中段層被程式性關掉，之後的 back 照樣正確關棧頂", () => {
  const { stack, userBack } = harness();
  const hits: string[] = [];
  const removeFocus = stack.push("board-focus", () => { hits.push("focus"); return "closed"; });
  stack.push("content-overlay", () => { hits.push("overlay"); return "closed"; });
  removeFocus(false); // 亂序：focus 不在棧頂
  assert.equal(stack.depth(), 1, "只剩 overlay");
  userBack();
  assert.deepEqual(hits, ["overlay"], "活層照常收 back，不得被舊格誤傷");
  assert.equal(stack.depth(), 0);
});

test("長按返回一次跨多格：被跨過的層由上而下全關，不留孤兒", () => {
  const { stack } = harness();
  const hits: string[] = [];
  stack.push("a", () => { hits.push("a"); return "closed"; });
  stack.push("b", () => { hits.push("b"); return "closed"; });
  stack.push("c", () => { hits.push("c"); return "closed"; });
  stack.handlePop(null); // 瀏覽器 go(-3)：一次回到基準格
  assert.deepEqual(hits, ["c", "b", "a"]);
  assert.equal(stack.depth(), 0);
});

test("Escape：只關棧頂一層，且產生的 pop 不打下層", () => {
  const { stack, flush } = harness();
  const hits: string[] = [];
  stack.push("board-focus", () => { hits.push("focus"); return "closed"; });
  stack.push("content-overlay", () => { hits.push("overlay"); return "closed"; });
  stack.handleEscape();
  flush();
  assert.deepEqual(hits, ["overlay"], "一次 Escape 只能關一層");
  assert.equal(stack.depth(), 1);
  stack.handleEscape();
  flush();
  assert.deepEqual(hits, ["overlay", "focus"]);
});

test("Escape：repush 的層（白板有 sheet 開著）不消耗 history、層留著", () => {
  const { log, stack } = harness();
  let sheetOpen = true;
  stack.push("board-focus", () => {
    if (sheetOpen) { sheetOpen = false; return "repush"; }
    return "closed";
  });
  const backsBefore = log.filter((entry) => entry === "back").length;
  stack.handleEscape();
  assert.equal(stack.depth(), 1, "關 sheet 不退層");
  assert.equal(log.filter((entry) => entry === "back").length, backsBefore, "repush 不得動 history");
  stack.handleEscape();
  assert.equal(stack.depth(), 0);
});

test("H1：程式性 back 沒有產生 popstate 時，過期的期待不得吞掉之後真正的返回", () => {
  const { stack, clock, swallowNextBack, userBack } = harness();
  const hits: string[] = [];
  stack.push("board-focus", () => { hits.push("focus"); return "closed"; });
  const removeOverlay = stack.push("content-overlay", () => { hits.push("overlay"); return "closed"; });
  removeOverlay(false);   // 程式性關閉：會 back()
  swallowNextBack();      // 但這次 traversal 沒送出 popstate
  assert.deepEqual(hits, []);
  clock.advance(5000);    // 過了一段時間，使用者真的按返回
  userBack();
  assert.deepEqual(hits, ["focus"], "過期的 selfConsume 不得吞掉真正的 back（舊版兩層都關不掉）");
});

test("H2：重新整理後接續舊序號 — 返回鍵仍然有效（不被誤判成 forward）", () => {
  // 重整前的頁面留下 __seq=5 的那一格
  const { stack, userBack } = harness({ initialState: { __layer: "board-focus", __seq: 5 } });
  const hits: string[] = [];
  stack.push("board-focus", () => { hits.push("focus"); return "closed"; });
  userBack();
  assert.deepEqual(hits, ["focus"], "新層的序號必須大於重整前留下的舊格（舊版從 0 起算 → 被判成 forward、按了沒反應）");
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
