import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { acceptRoomTitleAck, isTitleNotSaved } from "../../src/cloud/roomTitleAck";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("zero-row rooms.title UPDATE is not a saved name", () => {
  assert.throws(() => acceptRoomTitleAck(null), (err: Error & { code?: string }) => err.code === "TITLE_NOT_SAVED");
  assert.throws(() => acceptRoomTitleAck({}), (err: Error & { code?: string }) => err.code === "TITLE_NOT_SAVED");
  assert.throws(() => acceptRoomTitleAck({ id: "  " }), (err: Error & { code?: string }) => err.code === "TITLE_NOT_SAVED");
  assert.deepEqual(acceptRoomTitleAck({ id: "room-1" }), { id: "room-1" });
  assert.equal(isTitleNotSaved(Object.assign(new Error("TITLE_NOT_SAVED"), { code: "TITLE_NOT_SAVED" })), true);
  assert.equal(isTitleNotSaved(new Error("network")), false);
});

test("setRoomTitle requires a returned id and App reverts a TITLE_NOT_SAVED write", () => {
  const repo = readFileSync(resolve(ROOT, "src/cloud/roomRepository.ts"), "utf8");
  const hook = readFileSync(resolve(ROOT, "src/cloud/useCloudRoom.ts"), "utf8");
  const app = readFileSync(resolve(ROOT, "src/App.tsx"), "utf8");
  assert.match(repo, /acceptRoomTitleAck/);
  assert.match(repo, /select\("id"\)\s*\.\s*maybeSingle\(\)/);
  assert.match(repo, /setRoomTitle[\s\S]*acceptRoomTitleAck/);
  assert.match(hook, /isTitleNotSaved/);
  assert.match(hook, /if \(isTitleNotSaved\(err\)\) \{[\s\S]*throw err;/);
  assert.doesNotMatch(hook, /isTitleNotSaved[\s\S]{0,80}enqueuePendingWrite/);
  assert.match(app, /applyRoomTitle/);
  assert.match(app, /isTitleNotSaved\(err\)/);
  assert.match(app, /名稱沒有存成/);
  assert.match(app, /r\.title === title \? \{ \.\.\.r, title: previous \}/);
});
