import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { acceptBranchInsertAck, isBranchNotCreated } from "../../src/cloud/branchInsertAck";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("zero-row room_branches INSERT is not a created 內容 card", () => {
  assert.throws(() => acceptBranchInsertAck(null), (err: Error & { code?: string }) => err.code === "BRANCH_NOT_CREATED");
  assert.throws(() => acceptBranchInsertAck({}), (err: Error & { code?: string }) => err.code === "BRANCH_NOT_CREATED");
  assert.throws(() => acceptBranchInsertAck({ id: "  " }), (err: Error & { code?: string }) => err.code === "BRANCH_NOT_CREATED");
  assert.deepEqual(acceptBranchInsertAck({ id: "b1" }), { id: "b1" });
  assert.equal(isBranchNotCreated(Object.assign(new Error("BRANCH_NOT_CREATED"), { code: "BRANCH_NOT_CREATED" })), true);
  assert.equal(isBranchNotCreated(new Error("network")), false);
});

test("insertBranch requires a returned id and App reverts a BRANCH_NOT_CREATED write", () => {
  const repo = readFileSync(resolve(ROOT, "src/cloud/roomRepository.ts"), "utf8");
  const hook = readFileSync(resolve(ROOT, "src/cloud/useCloudRoom.ts"), "utf8");
  const app = readFileSync(resolve(ROOT, "src/App.tsx"), "utf8");
  assert.match(repo, /acceptBranchInsertAck/);
  assert.match(repo, /select\("id"\)\s*\.\s*maybeSingle\(\)/);
  assert.match(repo, /insertBranch[\s\S]*acceptBranchInsertAck/);
  assert.match(hook, /isBranchNotCreated/);
  assert.match(hook, /if \(isBranchNotCreated\(err\)\) \{[\s\S]*throw err;/);
  assert.doesNotMatch(hook, /runAndWait\(`branch-insert:\$\{branch\.id\}`/);
  assert.match(app, /isBranchNotCreated\(err\)/);
  assert.match(app, /內容沒有建立/);
});
