import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { acceptSharePreviewDisableAck } from "../../src/cloud/sharePreviewRotateAck";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("zero-row share preview disable is not 已重新產生預覽連結", () => {
  assert.throws(() => acceptSharePreviewDisableAck(null), (err: Error & { code?: string }) => err.code === "PREVIEW_NOT_REVOKED");
  assert.throws(() => acceptSharePreviewDisableAck({}), (err: Error & { code?: string }) => err.code === "PREVIEW_NOT_REVOKED");
  assert.throws(() => acceptSharePreviewDisableAck({ id: "  " }), (err: Error & { code?: string }) => err.code === "PREVIEW_NOT_REVOKED");
  assert.deepEqual(acceptSharePreviewDisableAck({ id: "preview-1" }), { id: "preview-1" });
});

test("rotateRoomPreview requires a returned id before minting a new preview", () => {
  const src = readFileSync(resolve(ROOT, "src/cloud/sharePreview.ts"), "utf8");
  const app = readFileSync(resolve(ROOT, "src/App.tsx"), "utf8");
  assert.match(src, /acceptSharePreviewDisableAck/);
  assert.match(src, /select\("id"\)\s*\.\s*maybeSingle\(\)/);
  assert.match(src, /rotateRoomPreview[\s\S]*acceptSharePreviewDisableAck[\s\S]*ensureRoomPreview/);
  assert.match(app, /preview\.rotate\([\s\S]*?\.then\(\(preview\) => \{[\s\S]*?已重新產生預覽連結/);
  assert.doesNotMatch(app, /showToast\("已重新產生預覽連結[\s\S]{0,80}preview\.rotate/);
});
