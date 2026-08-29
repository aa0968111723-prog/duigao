import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { acceptVersionInsertAck, isVersionNotSaved } from "../../src/cloud/versionInsertAck";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("zero-row versions INSERT is not a created 文宣／影片 version", () => {
  assert.throws(() => acceptVersionInsertAck(null), (err: Error & { code?: string }) => err.code === "VERSION_NOT_SAVED");
  assert.throws(() => acceptVersionInsertAck({}), (err: Error & { code?: string }) => err.code === "VERSION_NOT_SAVED");
  assert.throws(() => acceptVersionInsertAck({ id: "  " }), (err: Error & { code?: string }) => err.code === "VERSION_NOT_SAVED");
  assert.deepEqual(acceptVersionInsertAck({ id: "v1" }), { id: "v1" });
  assert.equal(isVersionNotSaved(Object.assign(new Error("VERSION_NOT_SAVED"), { code: "VERSION_NOT_SAVED" })), true);
  assert.equal(isVersionNotSaved(new Error("network")), false);
});

test("addVersion and addVideoVersion require a returned id; App reverts a VERSION_NOT_SAVED poster", () => {
  const repo = readFileSync(resolve(ROOT, "src/cloud/roomRepository.ts"), "utf8");
  const hook = readFileSync(resolve(ROOT, "src/cloud/useCloudRoom.ts"), "utf8");
  const app = readFileSync(resolve(ROOT, "src/App.tsx"), "utf8");
  const video = readFileSync(resolve(ROOT, "src/cloud/videoRoom.ts"), "utf8");
  assert.match(repo, /acceptVersionInsertAck/);
  assert.match(repo, /addVersion[\s\S]*select\("id"\)\s*\.\s*maybeSingle\(\)[\s\S]*acceptVersionInsertAck/);
  assert.match(repo, /addVideoVersion[\s\S]*select\("id"\)\s*\.\s*maybeSingle\(\)[\s\S]*acceptVersionInsertAck/);
  assert.match(hook, /isVersionNotSaved/);
  assert.match(hook, /if \(isVersionNotSaved\(err\)\) \{[\s\S]*throw err;/);
  assert.doesNotMatch(hook, /run\(`version:\$\{branchId \?\? "room"\}/);
  assert.match(app, /isVersionNotSaved\(err\)/);
  assert.match(app, /文宣版本沒有建立/);
  assert.match(app, /影片版本沒有建立/);
  assert.match(video, /addVideoVersion/);
});
