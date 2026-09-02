import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  canSubmitPin,
  commentAttachKind,
  pinBodyForCommit,
} from "../../src/features/discussion/commentAttach.ts";

const src = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("有檔無字也能送出，內文回退檔名", () => {
  assert.equal(canSubmitPin({ body: "" }), false);
  assert.equal(canSubmitPin({ body: "   " }), false);
  assert.equal(canSubmitPin({ body: "", attachments: [{ id: "a" }] }), true);
  assert.equal(pinBodyForCommit({ body: "", attachments: [{ name: "路線.png" }] }), "路線.png");
  assert.equal(pinBodyForCommit({ body: "日期太小" }), "日期太小");
});

test("mime 判定圖片／影片／檔案", () => {
  assert.equal(commentAttachKind("image/png", "a.png"), "image");
  assert.equal(commentAttachKind("video/mp4", "cut.mp4"), "video");
  assert.equal(commentAttachKind("application/pdf", "brief.pdf"), "file");
});

test("PinFields 有附檔入口，不走 addFiles 加一版", () => {
  const fields = src("src/features/discussion/PinFields.tsx");
  assert.match(fields, /pin-attach/);
  assert.match(fields, /comment-media/);
  assert.doesNotMatch(fields, /addFiles/);
  const intake = src("src/components/UniversalIntake.tsx");
  assert.match(intake, /"comment-media"/);
  assert.match(intake, /image\/\*/);
  const helper = src("src/features/discussion/commentAttach.ts");
  assert.match(helper, /attachments\//);
  assert.doesNotMatch(helper, /versions\//);
});

test("送出鍵看 attachments 而不只看文字", () => {
  const mobile = src("src/features/image-review/MobileWorkspace.tsx");
  const desktop = src("src/features/image-review/DesktopWorkspace.tsx");
  const video = src("src/features/video-review/VideoCommentComposer.tsx");
  for (const file of [mobile, desktop, video]) {
    assert.match(file, /canSubmitPin/);
  }
});
