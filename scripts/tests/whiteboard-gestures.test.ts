/**
 * WB02：手勢仲裁狀態機＋排序＋undo 執行端 — 稽核四缺陷各一條反例。
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import type { WhiteboardFrame, WhiteboardNode } from "../../src/features/collaboration/types";
import {
  gestureReducer,
  initialGestureState,
  lassoHits,
  LONG_PRESS_SLOP,
  type GestureState,
} from "../../src/features/whiteboard/gestures";
import { hitTest, paintOrder, orderCompare } from "../../src/features/whiteboard/order";
import { emptyHistory, pushHistory, undoStep, redoStep, HISTORY_LIMIT } from "../../src/features/whiteboard/history";
import { applyMasked, nodeDeleteDraft, nodeUpdateDraft } from "../../src/features/collaboration/operations";
import { registeredNodeTypes, rendererFor } from "../../src/features/whiteboard/registry";
import { NODE_TYPES } from "../../src/features/collaboration/types";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const node = (id: string, over: Partial<WhiteboardNode> = {}): WhiteboardNode => ({
  id,
  whiteboardId: "b1",
  roomId: "r1",
  nodeType: "text",
  x: 0,
  y: 0,
  width: 100,
  height: 60,
  content: { text: id },
  createdBy: "u1",
  createdAt: 1,
  updatedAt: 1,
  version: 1,
  ...over,
});

function drive(state: GestureState, inputs: Parameters<typeof gestureReducer>[1][]) {
  const effects: ReturnType<typeof gestureReducer>["effects"] = [];
  for (const input of inputs) {
    const out = gestureReducer(state, input);
    state = out.state;
    effects.push(...out.effects);
  }
  return { state, effects };
}

test("缺陷1：pinch 起手清 drag（cancel-drag 效果），殘指不復活拖曳", () => {
  let state = initialGestureState();
  // 單指按在節點上 → begin-drag
  let out = gestureReducer(state, { type: "down", pointerId: 1, point: { x: 100, y: 100 }, time: 0 });
  state = gestureReducer(out.state, { type: "begin-drag", ids: ["n1"], world: { x: 76, y: 76 } }).state;
  assert.equal(state.mode, "drag");
  // 第二指落下 → 必須發 cancel-drag、進 pinch
  out = gestureReducer(state, { type: "down", pointerId: 2, point: { x: 200, y: 100 }, time: 10 });
  state = out.state;
  assert.equal(state.mode, "pinch");
  assert.ok(out.effects.some((effect) => effect.kind === "cancel-drag"), "pinch 起手必須清 drag");
  // 抬起一指：殘指是平移，不是拖節點
  out = gestureReducer(state, { type: "up", pointerId: 2, point: { x: 200, y: 100 }, time: 20 });
  state = out.state;
  assert.equal(state.mode, "pan");
  assert.equal(state.dragIds.length, 0, "殘指不得繼承 dragIds");
});

test("缺陷2：長按 slop — 8px 內抖動存活、超過取消", () => {
  let state = initialGestureState();
  state = gestureReducer(state, { type: "down", pointerId: 1, point: { x: 50, y: 50 }, time: 0 }).state;
  // slop 內抖動：長按不取消
  let out = gestureReducer(state, { type: "move", pointerId: 1, point: { x: 50 + LONG_PRESS_SLOP - 1, y: 50 }, time: 100, zoom: 1 });
  state = out.state;
  assert.ok(state.longPress, "slop 內位移不得取消長按");
  assert.ok(!out.effects.some((effect) => effect.kind === "long-press-cancelled"));
  // 超過 slop：取消
  out = gestureReducer(state, { type: "move", pointerId: 1, point: { x: 50 + LONG_PRESS_SLOP + 2, y: 50 }, time: 120, zoom: 1 });
  assert.equal(out.state.longPress, null);
  assert.ok(out.effects.some((effect) => effect.kind === "long-press-cancelled"));
});

test("缺陷3：雙指平移 — 中點位移以 midDelta 回報（zoom 不變時也有平移量）", () => {
  let state = initialGestureState();
  state = gestureReducer(state, { type: "down", pointerId: 1, point: { x: 100, y: 100 }, time: 0 }).state;
  state = gestureReducer(state, { type: "down", pointerId: 2, point: { x: 200, y: 100 }, time: 5 }).state;
  // 兩指等距平行右移 40px：scale=1、midDelta.x=40
  state = gestureReducer(state, { type: "move", pointerId: 1, point: { x: 140, y: 100 }, time: 10, zoom: 1 }).state;
  const out = gestureReducer(state, { type: "move", pointerId: 2, point: { x: 240, y: 100 }, time: 15, zoom: 1 });
  const pinchEffects = out.effects.filter((effect) => effect.kind === "pinch-zoom");
  assert.ok(pinchEffects.length >= 1);
  const total = pinchEffects.reduce((sum, effect) => sum + (effect.kind === "pinch-zoom" ? effect.midDelta.x : 0), 0);
  assert.ok(total > 0, `中點位移必須回報（total=${total}）`);
});

test("缺陷4：pointer 雙擊 — 300ms/24px 內兩次 tap 發 double-tap（空白處）", () => {
  let state = initialGestureState();
  const tap = (time: number) => {
    state = gestureReducer(state, { type: "down", pointerId: 1, point: { x: 60, y: 60 }, time }).state;
    const out = gestureReducer(state, { type: "up", pointerId: 1, point: { x: 60, y: 60 }, time: time + 40 });
    state = out.state;
    return out.effects;
  };
  const first = tap(0);
  assert.ok(first.some((effect) => effect.kind === "tap"));
  const second = tap(150);
  assert.ok(second.some((effect) => effect.kind === "double-tap"), "第二次 tap 必須是 double-tap");
  // 超時的第三次：回到單 tap
  const third = tap(1000);
  assert.ok(third.some((effect) => effect.kind === "tap") && !third.some((effect) => effect.kind === "double-tap"));
});

test("Grok F2：節點上（begin-drag 回填）沒真的拖 — 雙擊仍要到達（原測試假綠反例）", () => {
  let state = initialGestureState();
  const tapOnNode = (time: number) => {
    state = gestureReducer(state, { type: "down", pointerId: 1, point: { x: 60, y: 60 }, time }).state;
    // hit-test 命中節點後元件回填 begin-drag（真實路徑；原測試漏了這步才假綠）
    state = gestureReducer(state, { type: "begin-drag", ids: ["n1"], world: { x: 36, y: 36 } }).state;
    const out = gestureReducer(state, { type: "up", pointerId: 1, point: { x: 60, y: 60 }, time: time + 40 });
    state = out.state;
    return out.effects;
  };
  const first = tapOnNode(0);
  assert.ok(first.some((effect) => effect.kind === "tap"), "drag 起手但未位移＝tap");
  const second = tapOnNode(150);
  assert.ok(second.some((effect) => effect.kind === "double-tap"), "節點上的第二次 tap 必須發 double-tap（進入編輯的入口）");
  // 真的拖了（超過 slop）就不是 tap：不得誤發
  state = gestureReducer(state, { type: "down", pointerId: 1, point: { x: 60, y: 60 }, time: 2000 }).state;
  state = gestureReducer(state, { type: "begin-drag", ids: ["n1"], world: { x: 36, y: 36 } }).state;
  state = gestureReducer(state, { type: "move", pointerId: 1, point: { x: 60 + LONG_PRESS_SLOP + 4, y: 60 }, time: 2050, zoom: 1 }).state;
  const dragged = gestureReducer(state, { type: "up", pointerId: 1, point: { x: 60 + LONG_PRESS_SLOP + 4, y: 60 }, time: 2100 });
  state = dragged.state;
  assert.ok(!dragged.effects.some((effect) => effect.kind === "tap"), "位移超過 slop 不得算 tap");
  assert.ok(dragged.effects.some((effect) => effect.kind === "commit-drag"));
});

test("WB03 hover 防護：未按下的滑鼠掠過畫布後，真按下仍是單指（不誤入 pinch）", () => {
  let state = initialGestureState();
  // 桌機 hover：move 事件先到（沒有 down）
  state = gestureReducer(state, { type: "move", pointerId: 1, point: { x: 30, y: 30 }, time: 0, zoom: 1 }).state;
  state = gestureReducer(state, { type: "move", pointerId: 1, point: { x: 60, y: 60 }, time: 10, zoom: 1 }).state;
  assert.equal(state.pointers.size, 0, "hover 不得進 pointers map");
  // 真按下（觸控 id 31）：必須是單指 — 長按要 armed、hit-test 要發
  const down = gestureReducer(state, { type: "down", pointerId: 31, point: { x: 100, y: 100 }, time: 20 });
  state = down.state;
  assert.equal(state.mode, "idle");
  assert.ok(state.longPress, "長按必須 armed（舊 bug：hover 殘影讓這裡變 pinch）");
  assert.ok(down.effects.some((effect) => effect.kind === "hit-test"));
  assert.ok(!down.effects.some((effect) => effect.kind === "long-press-cancelled"));
  // 未追蹤 pointer 的 up 也不得干擾
  const ghostUp = gestureReducer(state, { type: "up", pointerId: 99, point: { x: 0, y: 0 }, time: 30 });
  assert.equal(ghostUp.state.mode, "idle");
  assert.ok(ghostUp.state.longPress, "幽靈 up 不得取消長按");
});

test("Grok F1：pinch scale 是增量比 — 距離不變的 move 回報 1，不重複回報總比", () => {
  let state = initialGestureState();
  state = gestureReducer(state, { type: "down", pointerId: 1, point: { x: 100, y: 100 }, time: 0 }).state;
  state = gestureReducer(state, { type: "down", pointerId: 2, point: { x: 200, y: 100 }, time: 5 }).state; // 起手距離 100
  // 第一次 move：距離 100→200，scale=2
  let out = gestureReducer(state, { type: "move", pointerId: 2, point: { x: 300, y: 100 }, time: 10, zoom: 1 });
  state = out.state;
  const first = out.effects.find((effect) => effect.kind === "pinch-zoom");
  assert.ok(first && first.kind === "pinch-zoom" && Math.abs(first.scale - 2) < 1e-9, "第一次 move：scale=2");
  // 第二次 move：兩指沒再動（距離仍 200）— 增量比必須是 1。
  // 舊實作回報「相對起手的絕對比」2，呼叫端乘當下 zoom → 指數失控（Grok 實抓）。
  out = gestureReducer(state, { type: "move", pointerId: 2, point: { x: 300, y: 100 }, time: 20, zoom: 1 });
  const second = out.effects.find((effect) => effect.kind === "pinch-zoom");
  assert.ok(second && second.kind === "pinch-zoom" && Math.abs(second.scale - 1) < 1e-9,
    `距離未變的 move 必須回報 scale=1（實得 ${second && second.kind === "pinch-zoom" ? second.scale : "無效果"}）`);
});

test("三鍵全序：paint 與 hit 同一把尺 — z 高者蓋住且先命中", () => {
  const low = node("low", { zIndex: 0, x: 0, y: 0 });
  const high = node("high", { zIndex: 5, x: 0, y: 0 });
  const ordered = paintOrder([high, low]);
  assert.deepEqual(ordered.map((item) => item.id), ["low", "high"]);
  assert.equal(hitTest([high, low], 10, 10)?.id, "high", "命中必須是畫在上面的那個");
  // 同 z：created_at、再 id — 決定性
  const a = node("a", { createdAt: 1 });
  const b = node("b", { createdAt: 1 });
  assert.ok(orderCompare(a, b) < 0);
  // frame（z<0）永遠墊底
  const frame: WhiteboardFrame = { id: "f", whiteboardId: "b1", roomId: "r1", title: "", x: 0, y: 0, width: 500, height: 500, kind: "frame", style: {}, zIndex: -1, createdBy: "u", createdAt: 0, updatedAt: 0, version: 1 };
  assert.ok(orderCompare(frame, low) < 0);
});

test("套索：多邊形內的節點中心被選中", () => {
  const inside = node("in", { x: 40, y: 40, width: 20, height: 20 });
  const outside = node("out", { x: 200, y: 200, width: 20, height: 20 });
  const path = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  assert.deepEqual(lassoHits([inside, outside], path), ["in"]);
  assert.deepEqual(lassoHits([inside], [{ x: 0, y: 0 }, { x: 1, y: 1 }]), [], "少於三點不成多邊形");
});

test("undo/redo：move 的 undo 只回位置、redo 復原；上限 50", () => {
  const before = node("n1", { x: 0, y: 0, content: { text: "原文" } });
  const after = node("n1", { x: 100, y: 50, content: { text: "原文" } });
  let stack = pushHistory(emptyHistory(), nodeUpdateDraft("op-1", before, after)!);
  const store = new Map<string, WhiteboardNode>([["n1", { ...after, content: { text: "B 改的字" } }]]);
  const executors = {
    upsert: (item: WhiteboardNode) => { store.set(item.id, item); },
    softDelete: (id: string) => { store.delete(id); },
    // 與 WhiteboardWorkspace 的真實執行端同構（S8）：空白 text 基底 ＋
    // applyMasked。原本直接 node(id) 忽略 draft — 掩蓋了「mask 沒帶
    // nodeType/width/height 導致節點被以預設值重建」的資料損毀。
    recreate: (draft: import("../../src/features/collaboration/operations").OperationDraft) => {
      const base = node(draft.entityId, { nodeType: "text", width: 180, height: 96, content: {} });
      store.set(draft.entityId, applyMasked(base, draft.fieldMask, draft.after));
    },
    findNode: (id: string) => store.get(id),
  };
  const undone = undoStep(stack, executors, "op-2");
  stack = undone.stack;
  assert.equal(store.get("n1")!.x, 0, "undo 回到原位");
  assert.equal(store.get("n1")!.content.text, "B 改的字", "並發修改不被吃掉");
  const redone = redoStep(stack, executors, "op-3");
  stack = redone.stack;
  assert.equal(store.get("n1")!.x, 100, "redo 回去");
  // 節點被別人刪掉：undo 誠實跳過
  store.delete("n1");
  stack = pushHistory(stack, nodeUpdateDraft("op-4", before, after)!);
  const skipped = undoStep(stack, executors, "op-5");
  assert.equal(skipped.skipped, "missing-node");
  // delete 的 undo = recreate
  const gone = node("n2");
  let stack2 = pushHistory(emptyHistory(), nodeDeleteDraft("op-6", gone));
  const undone2 = undoStep(stack2, executors, "op-7");
  assert.ok(store.has("n2"), "delete 的 undo 必須重建節點");
  assert.ok(undone2.applied);
  // 上限
  let capped = emptyHistory();
  for (let i = 0; i < HISTORY_LIMIT + 10; i += 1) {
    capped = pushHistory(capped, nodeUpdateDraft(`op-c${i}`, before, after)!);
  }
  assert.equal(capped.undo.length, HISTORY_LIMIT);
});

test("Grok F8：undo 的欄位已被別人改走（drift）→ conflict-drift 誠實跳過，不蓋字", () => {
  const before = node("n9", { content: { text: "我打的字" } });
  const after = node("n9", { x: 0, y: 0, content: { text: "我改完的字" } });
  const stack = pushHistory(emptyHistory(), nodeUpdateDraft("op-d1", before, after)!);
  // 同事在我 undo 之前又改了同一欄位
  const store = new Map<string, WhiteboardNode>([["n9", { ...after, content: { text: "同事後來改的字" } }]]);
  const executors = {
    upsert: (item: WhiteboardNode) => { store.set(item.id, item); },
    softDelete: (id: string) => { store.delete(id); },
    recreate: () => undefined,
    findNode: (id: string) => store.get(id),
  };
  const result = undoStep(stack, executors, "op-d2");
  assert.equal(result.skipped, "conflict-drift", "欄位 drift 必須誠實跳過");
  assert.equal(store.get("n9")!.content.text, "同事後來改的字", "不得靜默蓋掉別人的字");
});

test("S8：freehand 刪除後 undo 必須連 nodeType/尺寸一起復原（不得變成空白便利貼）", () => {
  const stroke = node("s1", {
    nodeType: "freehand",
    x: 40,
    y: 60,
    width: 320,
    height: 240,
    content: { points: [[0, 0], [10, 12], [30, 8]], color: "#e8c27a", strokeWidth: 3 },
  });
  const store = new Map<string, WhiteboardNode>();
  const executors = {
    upsert: (item: WhiteboardNode) => { store.set(item.id, item); },
    softDelete: (id: string) => { store.delete(id); },
    // 真實執行端：空白 text 基底 ＋ applyMasked
    recreate: (draft: import("../../src/features/collaboration/operations").OperationDraft) => {
      const base = node(draft.entityId, { nodeType: "text", width: 180, height: 96, content: {} });
      store.set(draft.entityId, applyMasked(base, draft.fieldMask, draft.after));
    },
    findNode: (id: string) => store.get(id),
  };
  const stack = pushHistory(emptyHistory(), nodeDeleteDraft("op-1", stroke));
  undoStep(stack, executors, "op-2");
  const restored = store.get("s1")!;
  assert.equal(restored.nodeType, "freehand", "型別必須復原 — 否則筆畫變空白 text 卡並寫回雲端");
  assert.equal(restored.width, 320);
  assert.equal(restored.height, 240);
  assert.deepEqual(restored.content.points, [[0, 0], [10, 12], [30, 8]]);
  assert.equal(restored.content.strokeWidth, 3);
});

test("registry：全部 DB 詞彙都有 renderer 或 fallback；fallback 誠實標注", () => {
  for (const type of NODE_TYPES) {
    assert.ok(typeof rendererFor(type) === "function", `${type} 必須可渲染`);
  }
  assert.ok(registeredNodeTypes().length >= 9);
  // 未知型別（DB 比 client 新）：fallback 函式存在且非 throw
  const fallback = rendererFor("future-type" as never);
  assert.ok(typeof fallback === "function");
});

test("文宣／影片 renderer 畫整張圖或可播影片，企劃仍走卡片", () => {
  const render = (over: Partial<ReturnType<typeof node>["content"]> & { mediaKind?: string; thumbnailUrl?: string; videoUrl?: string; title?: string }) => {
    const Renderer = rendererFor("room_content");
    return renderToStaticMarkup(createElement(() => Renderer({
      node: node("media", { nodeType: "room_content", content: over }),
      editing: false,
      canEdit: true,
      onChangeText: () => undefined,
    })));
  };
  const poster = render({ mediaKind: "poster", title: "擺攤文宣", versionLabel: "改二", thumbnailUrl: "data:image/png;base64,xx" });
  assert.ok(poster.includes('data-testid="wb-media-image"'), poster);
  assert.ok(poster.includes("擺攤文宣"));
  assert.ok(!poster.includes("wb-thumb"), "整張文宣不該再用 52px thumb");
  const video = render({ mediaKind: "video", title: "招生影片", videoUrl: "https://example.test/a.mp4", thumbnailUrl: "https://example.test/p.jpg", startTime: 40 });
  assert.ok(video.includes('data-testid="wb-media-video"'), video);
  assert.ok(video.includes("https://example.test/a.mp4"));
  const plan = render({ mediaKind: "plan", title: "擺攤計畫" });
  assert.ok(plan.includes("wb-thumb-fallback"));
  assert.ok(!plan.includes("wb-media-image"));
});
