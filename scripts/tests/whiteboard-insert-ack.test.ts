import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { acceptWhiteboardInsertAck, isWhiteboardNotSaved } from "../../src/cloud/whiteboardAck";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("zero-row whiteboards INSERT is not a created board", () => {
  assert.throws(() => acceptWhiteboardInsertAck(null), (err: Error & { code?: string }) => err.code === "WHITEBOARD_NOT_SAVED");
  assert.throws(() => acceptWhiteboardInsertAck({}), (err: Error & { code?: string }) => err.code === "WHITEBOARD_NOT_SAVED");
  assert.throws(() => acceptWhiteboardInsertAck({ id: "  " }), (err: Error & { code?: string }) => err.code === "WHITEBOARD_NOT_SAVED");
  assert.deepEqual(acceptWhiteboardInsertAck({ id: "wb1" }), { id: "wb1" });
  assert.equal(isWhiteboardNotSaved(Object.assign(new Error("WHITEBOARD_NOT_SAVED"), { code: "WHITEBOARD_NOT_SAVED" })), true);
  assert.equal(isWhiteboardNotSaved(new Error("network")), false);
});

test("insertWhiteboard requires a returned id and App reverts a WHITEBOARD_NOT_SAVED write", () => {
  const repo = readFileSync(resolve(ROOT, "src/cloud/collaborationRepository.ts"), "utf8");
  const hook = readFileSync(resolve(ROOT, "src/cloud/useCloudRoom.ts"), "utf8");
  const app = readFileSync(resolve(ROOT, "src/App.tsx"), "utf8");
  assert.match(repo, /acceptWhiteboardInsertAck/);
  assert.match(repo, /select\("id"\)\s*\.\s*maybeSingle\(\)/);
  assert.match(repo, /insertWhiteboard[\s\S]*acceptWhiteboardInsertAck/);
  assert.match(hook, /isWhiteboardNotSaved/);
  assert.match(hook, /if \(isWhiteboardNotSaved\(err\)\) \{[\s\S]*throw err;/);
  assert.doesNotMatch(hook, /run\(`whiteboard-insert:\$\{board\.id\}`/);
  assert.match(app, /isWhiteboardNotSaved\(err\)/);
  assert.match(app, /白板沒有建立/);
});
