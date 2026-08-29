import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { acceptBranchUpdateAck, isBranchNotSaved } from "../../src/cloud/branchUpdateAck";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("zero-row room_branches UPDATE is not a saved branch name", () => {
  assert.throws(() => acceptBranchUpdateAck(null), (err: Error & { code?: string }) => err.code === "BRANCH_NOT_SAVED");
  assert.throws(() => acceptBranchUpdateAck({}), (err: Error & { code?: string }) => err.code === "BRANCH_NOT_SAVED");
  assert.throws(() => acceptBranchUpdateAck({ id: "  " }), (err: Error & { code?: string }) => err.code === "BRANCH_NOT_SAVED");
  assert.deepEqual(acceptBranchUpdateAck({ id: "branch-1" }), { id: "branch-1" });
  assert.equal(isBranchNotSaved(Object.assign(new Error("BRANCH_NOT_SAVED"), { code: "BRANCH_NOT_SAVED" })), true);
  assert.equal(isBranchNotSaved(new Error("network")), false);
});

test("updateBranch requires a returned id and App reverts a BRANCH_NOT_SAVED write", () => {
  const repo = readFileSync(resolve(ROOT, "src/cloud/roomRepository.ts"), "utf8");
  const hook = readFileSync(resolve(ROOT, "src/cloud/useCloudRoom.ts"), "utf8");
  const app = readFileSync(resolve(ROOT, "src/App.tsx"), "utf8");
  assert.match(repo, /acceptBranchUpdateAck/);
  assert.match(repo, /select\("id"\)\s*\.\s*maybeSingle\(\)/);
  assert.match(repo, /updateBranch[\s\S]*acceptBranchUpdateAck/);
  assert.match(hook, /isBranchNotSaved/);
  assert.match(hook, /if \(isBranchNotSaved\(err\)\) \{[\s\S]*throw err;/);
  assert.doesNotMatch(hook, /run\(`branch:\$\{branchId\}`/);
  assert.match(app, /isBranchNotSaved\(err\)/);
  assert.match(app, /分支設定沒有存成/);
  assert.match(app, /patch\.name !== undefined \? \{ name: previous\.name \}/);
});
