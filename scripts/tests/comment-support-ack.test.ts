import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  acceptSupportDeleteAck,
  acceptSupportUpsertAck,
  isSupportNotRemoved,
  isSupportNotSaved,
} from "../../src/cloud/commentSupportAck";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("zero-row comment_supports UPSERT is not a saved support", () => {
  assert.throws(() => acceptSupportUpsertAck(null), (err: Error & { code?: string }) => err.code === "SUPPORT_NOT_SAVED");
  assert.throws(() => acceptSupportUpsertAck({}), (err: Error & { code?: string }) => err.code === "SUPPORT_NOT_SAVED");
  assert.throws(() => acceptSupportUpsertAck({ comment_id: "  " }), (err: Error & { code?: string }) => err.code === "SUPPORT_NOT_SAVED");
  assert.throws(() => acceptSupportUpsertAck({ id: "c1" }), (err: Error & { code?: string }) => err.code === "SUPPORT_NOT_SAVED");
  assert.deepEqual(acceptSupportUpsertAck({ comment_id: "c1" }), { commentId: "c1" });
  assert.equal(isSupportNotSaved(Object.assign(new Error("SUPPORT_NOT_SAVED"), { code: "SUPPORT_NOT_SAVED" })), true);
});

test("zero-row comment_supports DELETE is not a removed support", () => {
  assert.throws(() => acceptSupportDeleteAck(null), (err: Error & { code?: string }) => err.code === "SUPPORT_NOT_REMOVED");
  assert.throws(() => acceptSupportDeleteAck({}), (err: Error & { code?: string }) => err.code === "SUPPORT_NOT_REMOVED");
  assert.deepEqual(acceptSupportDeleteAck({ comment_id: "c1" }), { commentId: "c1" });
  assert.equal(isSupportNotRemoved(Object.assign(new Error("SUPPORT_NOT_REMOVED"), { code: "SUPPORT_NOT_REMOVED" })), true);
  assert.equal(isSupportNotRemoved(new Error("network")), false);
});

test("setSupport requires a returned comment_id and App reverts a failed toggle", () => {
  const repo = readFileSync(resolve(ROOT, "src/cloud/roomRepository.ts"), "utf8");
  const hook = readFileSync(resolve(ROOT, "src/cloud/useCloudRoom.ts"), "utf8");
  const app = readFileSync(resolve(ROOT, "src/App.tsx"), "utf8");
  assert.match(repo, /acceptSupportUpsertAck/);
  assert.match(repo, /acceptSupportDeleteAck/);
  assert.match(repo, /select\("comment_id"\)\s*\.\s*maybeSingle\(\)/);
  assert.match(hook, /isSupportNotSaved/);
  assert.match(hook, /isSupportNotRemoved/);
  assert.doesNotMatch(hook, /run\(`comment-support:\$\{commentId\}`/);
  assert.match(app, /isSupportNotSaved\(err\)/);
  assert.match(app, /isSupportNotRemoved\(err\)/);
  assert.match(app, /「我也覺得」沒有存成/);
  assert.match(app, /「我也覺得」沒有取消/);
});
