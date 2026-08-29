import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  acceptPrefDeleteAck,
  acceptPrefUpsertAck,
  isPrefNotRemoved,
  isPrefNotSaved,
} from "../../src/cloud/proposalPrefAck";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("zero-row proposal_preferences UPSERT is not a saved take", () => {
  assert.throws(() => acceptPrefUpsertAck(null), (err: Error & { code?: string }) => err.code === "PREF_NOT_SAVED");
  assert.throws(() => acceptPrefUpsertAck({}), (err: Error & { code?: string }) => err.code === "PREF_NOT_SAVED");
  assert.throws(() => acceptPrefUpsertAck({ version_id: "  " }), (err: Error & { code?: string }) => err.code === "PREF_NOT_SAVED");
  assert.throws(() => acceptPrefUpsertAck({ id: "v1" }), (err: Error & { code?: string }) => err.code === "PREF_NOT_SAVED");
  assert.deepEqual(acceptPrefUpsertAck({ version_id: "v1" }), { versionId: "v1" });
  assert.equal(isPrefNotSaved(Object.assign(new Error("PREF_NOT_SAVED"), { code: "PREF_NOT_SAVED" })), true);
});

test("zero-row proposal_preferences DELETE is not a cleared take", () => {
  assert.throws(() => acceptPrefDeleteAck(null), (err: Error & { code?: string }) => err.code === "PREF_NOT_REMOVED");
  assert.throws(() => acceptPrefDeleteAck({}), (err: Error & { code?: string }) => err.code === "PREF_NOT_REMOVED");
  assert.deepEqual(acceptPrefDeleteAck({ version_id: "v1" }), { versionId: "v1" });
  assert.equal(isPrefNotRemoved(Object.assign(new Error("PREF_NOT_REMOVED"), { code: "PREF_NOT_REMOVED" })), true);
  assert.equal(isPrefNotRemoved(new Error("network")), false);
});

test("setPreference requires a returned version_id and App reverts a failed take", () => {
  const repo = readFileSync(resolve(ROOT, "src/cloud/roomRepository.ts"), "utf8");
  const hook = readFileSync(resolve(ROOT, "src/cloud/useCloudRoom.ts"), "utf8");
  const app = readFileSync(resolve(ROOT, "src/App.tsx"), "utf8");
  assert.match(repo, /acceptPrefUpsertAck/);
  assert.match(repo, /acceptPrefDeleteAck/);
  assert.match(repo, /select\("version_id"\)\s*\.\s*maybeSingle\(\)/);
  assert.match(hook, /isPrefNotSaved/);
  assert.match(hook, /isPrefNotRemoved/);
  assert.doesNotMatch(hook, /run\(`pref:\$\{versionId\}`/);
  assert.match(app, /isPrefNotSaved\(err\)/);
  assert.match(app, /isPrefNotRemoved\(err\)/);
  assert.match(app, /這個選擇沒有存成/);
  assert.match(app, /這個選擇沒有取消/);
});
