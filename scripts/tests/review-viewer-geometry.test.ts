import test from "node:test";
import assert from "node:assert/strict";
import {
  clampTransform,
  containRect,
  focusTransform,
  inverseTransformPoint,
  MAX_VIEWER_SCALE,
  naturalZoomScale,
  normalizedToStagePoint,
  stagePointToNormalized,
  transformPoint,
  zoomScaleForPreset,
} from "../../src/features/image-review/viewerGeometry.ts";

const box = { w: 390, h: 844 };
const natural = { w: 1080, h: 1920 };
const frame = containRect(box, natural);

function closeTo(actual: number, expected: number, tolerance = 0.0001) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
}

test("containRect keeps the natural poster ratio inside the viewer", () => {
  closeTo(frame.width / frame.height, natural.w / natural.h);
  assert.ok(frame.left >= 0);
  assert.ok(frame.top >= 0);
  assert.ok(frame.left + frame.width <= box.w);
  assert.ok(frame.top + frame.height <= box.h);
});

test("normalized annotation coordinates round-trip through zoom and pan", () => {
  const transform = clampTransform({ scale: 3, translateX: -80, translateY: 40 }, box, frame);
  const original = { x: 0.23, y: 0.71 };
  const screen = normalizedToStagePoint(original, frame, box, transform);
  const recovered = stagePointToNormalized(screen, frame, box, transform);
  assert.ok(recovered);
  closeTo(recovered.x, original.x);
  closeTo(recovered.y, original.y);

  const unscaled = inverseTransformPoint(screen, box, transform);
  closeTo(unscaled.x, frame.left + original.x * frame.width);
  closeTo(unscaled.y, frame.top + original.y * frame.height);
});

test("clampTransform prevents the poster from exposing a blank edge", () => {
  const transform = clampTransform({ scale: 3, translateX: 99999, translateY: -99999 }, box, frame);
  const topLeft = transformPoint({ x: frame.left, y: frame.top }, box, transform);
  const bottomRight = transformPoint({ x: frame.left + frame.width, y: frame.top + frame.height }, box, transform);
  assert.ok(topLeft.x <= 0.001);
  assert.ok(topLeft.y <= 0.001);
  assert.ok(bottomRight.x >= box.w - 0.001);
  assert.ok(bottomRight.y >= box.h - 0.001);
  assert.ok(transform.scale <= MAX_VIEWER_SCALE);
});

test("focusTransform centers a point and raises it to an inspectable zoom", () => {
  const point = { x: 0.3, y: 0.6 };
  const focused = focusTransform(point, box, frame, { scale: 1, translateX: 0, translateY: 0 }, 2);
  const screen = normalizedToStagePoint(point, frame, box, focused);
  closeTo(screen.x, box.w / 2, 0.01);
  closeTo(screen.y, box.h / 2, 0.01);
  assert.ok(focused.scale >= 2);
});

test("Fit, 100% and 200% presets stay bounded", () => {
  const oneHundred = zoomScaleForPreset("100", frame, natural);
  const twoHundred = zoomScaleForPreset("200", frame, natural);
  assert.equal(zoomScaleForPreset("fit", frame, natural), 1);
  assert.ok(oneHundred > 1);
  assert.ok(twoHundred > oneHundred);
  assert.ok(twoHundred <= MAX_VIEWER_SCALE);
  assert.ok(naturalZoomScale(frame, natural) > 1);
});
