import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createImageItem } from "../../src/features/visual-proposal/helpers.ts";
import { normalizeItem, type ProposalImageItem } from "../../src/features/visual-proposal/store.ts";
import {
  CROP_EDGE_MAX,
  IDENTITY_CROP,
  applyCropDrag,
  clampCrop,
  clampCropEdge,
  cropClipPath,
  isIdentityCrop,
  replaceImageKeepingBox,
  resetImageGeometry,
} from "../../src/features/visual-proposal/quickEdit.ts";
import { FIRST_LAYER_TABS } from "../../src/features/multi-room/roomChrome.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
function src(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

const sample = (): ProposalImageItem => ({
  ...createImageItem("data:image/png;base64,QUICKEDITKEEPBOX", "胸章"),
  x: 0.32,
  y: 0.41,
  width: 28,
  rotation: 15,
  crop: { l: 0.1, t: 0.2, r: 0.05, b: 0.08 },
});

test("crop clamp 0–0.45，不會裁空", () => {
  assert.equal(clampCropEdge(-1), 0);
  assert.equal(clampCropEdge(0.9), CROP_EDGE_MAX);
  assert.equal(clampCropEdge(Number.NaN), 0);
  const crop = clampCrop({ l: 0.9, t: -0.2, r: 0.4, b: 0.01 });
  assert.equal(crop.l, CROP_EDGE_MAX);
  assert.equal(crop.t, 0);
  assert.equal(crop.r, 0.4);
  assert.equal(crop.b, 0.01);
  assert.ok(crop.l + crop.r < 1);
  assert.ok(crop.t + crop.b < 1);
  assert.equal(isIdentityCrop(undefined), true);
  assert.equal(isIdentityCrop({ l: 0, t: 0, r: 0, b: 0 }), true);
  assert.match(cropClipPath({ t: 0.1, r: 0, b: 0, l: 0.2 }) ?? "", /inset\(/);
});

test("replaceImageKeepingBox 只換圖，框位與 crop／rotation 保留", () => {
  const item = sample();
  const next = replaceImageKeepingBox(item, {
    imageDataUrl: "data:image/png;base64,REPLACEDPIXELSKEEP",
    name: "新胸章",
  });
  assert.equal(next.imageDataUrl, "data:image/png;base64,REPLACEDPIXELSKEEP");
  assert.equal(next.name, "新胸章");
  assert.equal(next.x, item.x);
  assert.equal(next.y, item.y);
  assert.equal(next.width, item.width);
  assert.equal(next.rotation, item.rotation);
  assert.deepEqual(next.crop, item.crop);
  const empty = replaceImageKeepingBox(item, { imageDataUrl: "", name: "x" });
  assert.equal(empty.imageDataUrl, item.imageDataUrl);
});

test("resetItemPosition 清 crop；normalizeItem 讀得回 crop", () => {
  const item = sample();
  const reset = resetImageGeometry(item);
  assert.equal(reset.x, 0.5);
  assert.equal(reset.y, 0.5);
  assert.equal(reset.rotation, 0);
  assert.equal(reset.crop, undefined);

  const store = src("src/features/visual-proposal/store.ts");
  assert.match(store, /resetImageGeometry/);
  assert.match(store, /replaceSelectedImage/);
  assert.match(store, /parseCrop/);

  const roundTrip = normalizeItem({
    id: "vpi_crop",
    type: "image",
    name: "胸章",
    imageDataUrl: "data:image/png;base64,QUICKEDITKEEPBOX",
    x: 0.2,
    y: 0.3,
    width: 20,
    rotation: 0,
    opacity: 1,
    visible: true,
    crop: { l: 0.8, t: 0.1, r: 0, b: 0 },
  });
  assert.equal(roundTrip?.type, "image");
  if (roundTrip?.type === "image") {
    assert.equal(roundTrip.crop?.l, CROP_EDGE_MAX);
    assert.equal(roundTrip.crop?.t, 0.1);
  }
});

test("overlay 有 quick-edit-bar；FIRST_LAYER_TABS 仍是 對話／白板", () => {
  const overlay = src("src/features/visual-proposal/VisualProposalOverlay.tsx");
  const bar = src("src/features/visual-proposal/QuickEditBar.tsx");
  const stage = src("src/features/image-review/Stage.tsx");
  assert.match(overlay, /QuickEditBar/);
  assert.match(overlay, /data-testid="live-edit-hint"/);
  assert.match(overlay, /setEditing\(true\)/);
  assert.match(overlay, /if \(!canManage\) return/);
  assert.match(overlay, /data-cropping/);
  assert.match(bar, /data-testid="quick-edit-bar"/);
  assert.match(bar, /確認裁剪/);
  assert.match(stage, /canManage=\{api\.canManage\}/);
  assert.match(stage, /data-cropping/);
  assert.deepEqual([...FIRST_LAYER_TABS], ["對話", "白板"]);
  const chrome = src("src/features/multi-room/roomChrome.ts");
  assert.match(chrome, /FIRST_LAYER_TABS = \["對話", "白板"\]/);
});

test("applyCropDrag 八向夾在 0–0.45，不會裁空", () => {
  const start = { l: 0.1, t: 0.1, r: 0.1, b: 0.1 };
  const east = applyCropDrag(start, "e", 0.2, 0);
  assert.ok(east.r < start.r);
  const tooFar = applyCropDrag(start, "w", 0.9, 0);
  assert.equal(tooFar.l, CROP_EDGE_MAX);
  const corner = applyCropDrag(IDENTITY_CROP, "nw", 0.2, 0.2);
  assert.equal(corner.l, 0.2);
  assert.equal(corner.t, 0.2);
  assert.equal(corner.r, 0);
  assert.equal(corner.b, 0);
});
