import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  acceptDiscSupportDeleteAck,
  acceptDiscSupportUpsertAck,
  isDiscSupportNotRemoved,
  isDiscSupportNotSaved,
} from "../../src/cloud/discussionSupportAck";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("zero-row room_discussion_supports UPSERT is not a saved support", () => {
  assert.throws(() => acceptDiscSupportUpsertAck(null), (err: Error & { code?: string }) => err.code === "DISC_SUPPORT_NOT_SAVED");
  assert.throws(() => acceptDiscSupportUpsertAck({}), (err: Error & { code?: string }) => err.code === "DISC_SUPPORT_NOT_SAVED");
  assert.throws(() => acceptDiscSupportUpsertAck({ message_id: "  " }), (err: Error & { code?: string }) => err.code === "DISC_SUPPORT_NOT_SAVED");
  assert.throws(() => acceptDiscSupportUpsertAck({ id: "m1" }), (err: Error & { code?: string }) => err.code === "DISC_SUPPORT_NOT_SAVED");
  assert.deepEqual(acceptDiscSupportUpsertAck({ message_id: "m1" }), { messageId: "m1" });
  assert.equal(isDiscSupportNotSaved(Object.assign(new Error("DISC_SUPPORT_NOT_SAVED"), { code: "DISC_SUPPORT_NOT_SAVED" })), true);
});

test("zero-row room_discussion_supports DELETE is not a removed support", () => {
  assert.throws(() => acceptDiscSupportDeleteAck(null), (err: Error & { code?: string }) => err.code === "DISC_SUPPORT_NOT_REMOVED");
  assert.throws(() => acceptDiscSupportDeleteAck({}), (err: Error & { code?: string }) => err.code === "DISC_SUPPORT_NOT_REMOVED");
  assert.deepEqual(acceptDiscSupportDeleteAck({ message_id: "m1" }), { messageId: "m1" });
  assert.equal(isDiscSupportNotRemoved(Object.assign(new Error("DISC_SUPPORT_NOT_REMOVED"), { code: "DISC_SUPPORT_NOT_REMOVED" })), true);
  assert.equal(isDiscSupportNotRemoved(new Error("network")), false);
});

test("setDiscussionSupport requires a returned message_id and App reverts a failed toggle", () => {
  const repo = readFileSync(resolve(ROOT, "src/cloud/collaborationRepository.ts"), "utf8");
  const hook = readFileSync(resolve(ROOT, "src/cloud/useCloudRoom.ts"), "utf8");
  const app = readFileSync(resolve(ROOT, "src/App.tsx"), "utf8");
  assert.match(repo, /acceptDiscSupportUpsertAck/);
  assert.match(repo, /acceptDiscSupportDeleteAck/);
  assert.match(repo, /select\("message_id"\)\s*\.\s*maybeSingle\(\)/);
  assert.match(hook, /isDiscSupportNotSaved/);
  assert.match(hook, /isDiscSupportNotRemoved/);
  assert.doesNotMatch(hook, /run\(`support:\$\{messageId\}`/);
  assert.match(app, /isDiscSupportNotSaved\(err\)/);
  assert.match(app, /isDiscSupportNotRemoved\(err\)/);
  assert.match(app, /支持沒有存成/);
  assert.match(app, /支持沒有取消/);
});
