/** acceptVideoFile 的收檔契約（PR-01c，Grok 01c F1）。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { acceptVideoFile, MAX_VIDEO_BYTES } from "../../src/features/video-review/media";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const fakeFile = (name: string, type: string, size: number): File => {
  const file = new File([new Uint8Array(1)], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
};

test(".mov 收檔但帶警告；mp4 無警告", () => {
  const mov = acceptVideoFile(fakeFile("a.mov", "video/quicktime", 1024));
  assert.equal(mov.ok, true);
  assert.match((mov as { warning?: string }).warning ?? "", /HEVC/);
  const mp4 = acceptVideoFile(fakeFile("a.mp4", "video/mp4", 1024));
  assert.equal(mp4.ok, true);
  assert.equal((mp4 as { warning?: string }).warning, undefined);
});

test("警告不繞過上限：超大與 0-byte 的 .mov 一樣被拒（Grok 01c F1）", () => {
  const huge = acceptVideoFile(fakeFile("a.mov", "video/quicktime", MAX_VIDEO_BYTES + 1));
  assert.equal(huge.ok, false);
  const empty = acceptVideoFile(fakeFile("a.mov", "video/quicktime", 0));
  assert.equal(empty.ok, false);
});

test("非白名單格式仍拒（警告只給 quicktime）", () => {
  const mkv = acceptVideoFile(fakeFile("a.mkv", "video/x-matroska", 1024));
  assert.equal(mkv.ok, false);
});

test("超過 50MB 仍可上傳，但先警告會最佳化", () => {
  const large = acceptVideoFile(fakeFile("a.mp4", "video/mp4", 60 * 1024 * 1024));
  assert.equal(large.ok, true);
  assert.match((large as { warning?: string }).warning ?? "", /最佳化/);
});

test("playerReady waits 90s for the element or an honest fail card (CI 33268176148)", () => {
  const src = readFileSync(resolve(ROOT, "scripts/e2e/video-flow.mjs"), "utf8");
  const ready = src.slice(src.indexOf("async function playerReady"), src.indexOf("const currentTime"));
  assert.match(ready, /90000/);
  assert.match(ready, /video\.v-video/);
  assert.match(ready, /onboard-card/);
  assert.match(ready, /初始化沒完成|上傳失敗/);
  assert.match(ready, /ignoreFailCard/);
  assert.doesNotMatch(ready, /waitForSelector\("video\.v-video"/);
  assert.match(src, /playerReady\(Q, \{ ignoreFailCard: true/);
});
