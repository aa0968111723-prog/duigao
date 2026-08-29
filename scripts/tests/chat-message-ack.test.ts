import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { acceptMessageInsertAck, isMessageNotSaved } from "../../src/cloud/messageAck";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("zero-row messages INSERT is not a saved chat line", () => {
  assert.throws(() => acceptMessageInsertAck(null), (err: Error & { code?: string }) => err.code === "MESSAGE_NOT_SAVED");
  assert.throws(() => acceptMessageInsertAck({}), (err: Error & { code?: string }) => err.code === "MESSAGE_NOT_SAVED");
  assert.throws(() => acceptMessageInsertAck({ id: "  " }), (err: Error & { code?: string }) => err.code === "MESSAGE_NOT_SAVED");
  assert.deepEqual(acceptMessageInsertAck({ id: "m1" }), { id: "m1" });
  assert.equal(isMessageNotSaved(Object.assign(new Error("MESSAGE_NOT_SAVED"), { code: "MESSAGE_NOT_SAVED" })), true);
  assert.equal(isMessageNotSaved(new Error("network")), false);
});

test("insertMessage requires a returned id and App reverts a MESSAGE_NOT_SAVED write", () => {
  const repo = readFileSync(resolve(ROOT, "src/cloud/roomRepository.ts"), "utf8");
  const hook = readFileSync(resolve(ROOT, "src/cloud/useCloudRoom.ts"), "utf8");
  const app = readFileSync(resolve(ROOT, "src/App.tsx"), "utf8");
  assert.match(repo, /acceptMessageInsertAck/);
  assert.match(repo, /select\("id"\)\s*\.\s*maybeSingle\(\)/);
  assert.match(repo, /insertMessage[\s\S]*acceptMessageInsertAck/);
  assert.match(hook, /isMessageNotSaved/);
  assert.match(hook, /if \(isMessageNotSaved\(err\)\) \{[\s\S]*throw err;/);
  assert.doesNotMatch(hook, /run\(`message:\$\{msg\.id\}`/);
  assert.match(app, /isMessageNotSaved\(err\)/);
  assert.match(app, /這則訊息沒有送出/);
});
