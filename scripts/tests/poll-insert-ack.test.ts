import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { acceptPollInsertAck, isPollNotSaved } from "../../src/cloud/pollInsertAck";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("zero-row room_polls INSERT is not a saved decision", () => {
  assert.throws(() => acceptPollInsertAck(null), (err: Error & { code?: string }) => err.code === "POLL_NOT_SAVED");
  assert.throws(() => acceptPollInsertAck({}), (err: Error & { code?: string }) => err.code === "POLL_NOT_SAVED");
  assert.throws(() => acceptPollInsertAck({ id: "  " }), (err: Error & { code?: string }) => err.code === "POLL_NOT_SAVED");
  assert.deepEqual(acceptPollInsertAck({ id: "poll-1" }), { id: "poll-1" });
  assert.equal(isPollNotSaved(Object.assign(new Error("POLL_NOT_SAVED"), { code: "POLL_NOT_SAVED" })), true);
  assert.equal(isPollNotSaved(new Error("network")), false);
});

test("insertPoll requires a returned id and App reverts a POLL_NOT_SAVED write", () => {
  const repo = readFileSync(resolve(ROOT, "src/cloud/roomRepository.ts"), "utf8");
  const hook = readFileSync(resolve(ROOT, "src/cloud/useCloudRoom.ts"), "utf8");
  const app = readFileSync(resolve(ROOT, "src/App.tsx"), "utf8");
  assert.match(repo, /acceptPollInsertAck/);
  assert.match(repo, /select\("id"\)\s*\.\s*maybeSingle\(\)/);
  assert.match(repo, /insertPoll[\s\S]*acceptPollInsertAck/);
  assert.match(hook, /isPollNotSaved/);
  assert.match(hook, /if \(isPollNotSaved\(err\)\) \{[\s\S]*throw err;/);
  assert.doesNotMatch(hook, /run\(`poll:\$\{poll\.id\}`/);
  assert.match(app, /isPollNotSaved\(err\)/);
  assert.match(app, /待決策沒有加上/);
});
