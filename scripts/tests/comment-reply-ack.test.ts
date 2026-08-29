import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { acceptReplyInsertAck, isReplyNotSaved } from "../../src/cloud/commentReplyAck";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("zero-row comment_replies INSERT is not a saved reply", () => {
  assert.throws(() => acceptReplyInsertAck(null), (err: Error & { code?: string }) => err.code === "REPLY_NOT_SAVED");
  assert.throws(() => acceptReplyInsertAck({}), (err: Error & { code?: string }) => err.code === "REPLY_NOT_SAVED");
  assert.throws(() => acceptReplyInsertAck({ id: "  " }), (err: Error & { code?: string }) => err.code === "REPLY_NOT_SAVED");
  assert.deepEqual(acceptReplyInsertAck({ id: "r1" }), { id: "r1" });
  assert.equal(isReplyNotSaved(Object.assign(new Error("REPLY_NOT_SAVED"), { code: "REPLY_NOT_SAVED" })), true);
  assert.equal(isReplyNotSaved(new Error("network")), false);
});

test("insertReply requires a returned id and App reverts a REPLY_NOT_SAVED write", () => {
  const repo = readFileSync(resolve(ROOT, "src/cloud/roomRepository.ts"), "utf8");
  const hook = readFileSync(resolve(ROOT, "src/cloud/useCloudRoom.ts"), "utf8");
  const app = readFileSync(resolve(ROOT, "src/App.tsx"), "utf8");
  assert.match(repo, /acceptReplyInsertAck/);
  assert.match(repo, /select\("id"\)\s*\.\s*maybeSingle\(\)/);
  assert.match(repo, /insertReply[\s\S]*acceptReplyInsertAck/);
  assert.match(hook, /isReplyNotSaved/);
  assert.match(hook, /if \(isReplyNotSaved\(err\)\) \{[\s\S]*throw err;/);
  assert.doesNotMatch(hook, /run\(`reply:\$\{reply\.id\}`/);
  assert.match(app, /isReplyNotSaved\(err\)/);
  assert.match(app, /回覆沒有送出/);
});
