/**
 * WB05：觸控筆仲裁 — 掌拒與壓感。
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  initialPenState,
  penDown,
  penUp,
  shouldRejectPointer,
  widthForPressure,
  segmentWidths,
  PALM_GRACE_MS,
} from "../../src/features/whiteboard/pen";

test("掌拒：筆按下期間所有 touch 被丟掉，筆與滑鼠照常通過", () => {
  let state = initialPenState();
  assert.equal(shouldRejectPointer(state, "touch", 0), false, "沒有筆在畫時手指正常");
  state = penDown(state, 1);
  assert.equal(shouldRejectPointer(state, "touch", 10), true, "手掌不得中斷筆畫");
  assert.equal(shouldRejectPointer(state, "pen", 10), false);
  assert.equal(shouldRejectPointer(state, "mouse", 10), false, "桌機沒有手掌問題");
});

test("掌拒寬限期：筆抬起後手掌常常比較晚離開", () => {
  let state = penDown(initialPenState(), 1);
  state = penUp(state, 1, 1000);
  assert.equal(shouldRejectPointer(state, "touch", 1000 + PALM_GRACE_MS - 10), true, "寬限期內仍拒絕");
  assert.equal(shouldRejectPointer(state, "touch", 1000 + PALM_GRACE_MS + 10), false, "寬限期後恢復");
});

test("penUp 只認得自己那支筆的 pointerId", () => {
  const state = penDown(initialPenState(), 7);
  const other = penUp(state, 99, 500);
  assert.equal(other.penPointerId, 7, "別的 pointer 抬起不得解除筆狀態");
  assert.equal(penUp(state, 7, 500).penPointerId, null);
});

test("壓感：沒有壓感資料退回基準寬；pressure=0 是「最輕」不是「沒資料」", () => {
  assert.equal(widthForPressure(3, undefined), 3, "手指／滑鼠沒有壓感 → 基準寬");
  // 規格：不支援壓感的筆按下時回報 0.5，所以 0 一定是真實的最小壓力。
  // 把 0 當「沒資料」會讓起收筆的漸細**反過來變最粗**（自審 N8）。
  assert.ok(widthForPressure(3, 0) < widthForPressure(3, 0.5), "最輕必須比中等細");
  assert.ok(widthForPressure(3, 0) > 0, "但不得細到看不見");
  assert.ok(widthForPressure(3, 1) > widthForPressure(3, 0.2), "壓得重要比較粗");
  assert.ok(widthForPressure(3, 1) <= 3 * 1.6);
  assert.ok(widthForPressure(3, 0) >= 3 * 0.35);
});

test("segmentWidths：每段取相鄰兩點平均，長度是點數減一", () => {
  const widths = segmentWidths([0.2, 0.9, 0.9], 4);
  assert.equal(widths.length, 2);
  assert.ok(widths[1] > widths[0], "越壓越粗");
  // 中間缺壓感資料也不炸
  const mixed = segmentWidths([undefined, 0.5, undefined], 4);
  assert.equal(mixed.length, 2);
  assert.ok(mixed.every((width) => Number.isFinite(width) && width > 0));
});
