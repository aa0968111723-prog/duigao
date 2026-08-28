/**
 * WB03：freehand 筆畫幾何 — 抽點、正規化、防禦性讀取。
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { thinStroke, normalizeStroke, strokePath, readStrokePoints } from "../../src/features/whiteboard/freehand";

test("thinStroke：抖動點被抽掉、首尾必留、順序不變", () => {
  const jittery = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },   // < 3px：丟
    { x: 2, y: 0 },   // < 3px：丟
    { x: 10, y: 0 },  // 留
    { x: 11, y: 1 },  // < 3px：丟
    { x: 20, y: 5 },  // 尾：必留
  ];
  const thinned = thinStroke(jittery, 3);
  assert.deepEqual(thinned.map((point) => point.x), [0, 10, 20]);
  // 兩點以下原樣返回
  assert.equal(thinStroke([{ x: 0, y: 0 }]).length, 1);
});

test("normalizeStroke：外接框＋pad、相對點可還原世界座標", () => {
  const world = [{ x: 100, y: 50 }, { x: 160, y: 90 }, { x: 130, y: 120 }];
  const normalized = normalizeStroke(world, 8)!;
  assert.equal(normalized.x, 92);
  assert.equal(normalized.y, 42);
  assert.equal(normalized.width, 76);   // 160-100+16
  assert.equal(normalized.height, 86);  // 120-50+16
  // 相對點 + 節點左上 = 原世界座標（搬節點＝搬筆畫的前提）
  for (let i = 0; i < world.length; i += 1) {
    assert.equal(normalized.points[i][0] + normalized.x, world[i].x);
    assert.equal(normalized.points[i][1] + normalized.y, world[i].y);
  }
});

test("normalizeStroke：單點（誤觸）回 null；極小筆畫仍有最小可點擊框", () => {
  assert.equal(normalizeStroke([{ x: 5, y: 5 }]), null);
  const dot = normalizeStroke([{ x: 5, y: 5 }, { x: 6, y: 6 }], 2)!;
  assert.ok(dot.width >= 24 && dot.height >= 24, `太小的筆畫要撐到可點擊（${dot.width}x${dot.height}）`);
});

test("strokePath：M/L 序列；空點集回空字串", () => {
  assert.equal(strokePath([[0, 0], [10, 5]]), "M 0 0 L 10 5");
  assert.equal(strokePath([]), "");
});

test("readStrokePoints：jsonb 垃圾形狀不炸 — 缺欄、字串、NaN 全過濾", () => {
  assert.deepEqual(readStrokePoints(null), []);
  assert.deepEqual(readStrokePoints("junk"), []);
  assert.deepEqual(readStrokePoints([[1, 2], ["a", 2], [3], [4, Number.NaN], [5, 6]]), [[1, 2], [5, 6]]);
});
