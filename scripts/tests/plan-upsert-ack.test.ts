import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { acceptPlanUpsertAck, isPlanNotSaved } from "../../src/cloud/planUpsertAck";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("zero-row plan_documents UPSERT is not a saved plan", () => {
  assert.throws(() => acceptPlanUpsertAck(null), (err: Error & { code?: string }) => err.code === "PLAN_NOT_SAVED");
  assert.throws(() => acceptPlanUpsertAck({}), (err: Error & { code?: string }) => err.code === "PLAN_NOT_SAVED");
  assert.throws(() => acceptPlanUpsertAck({ branch_id: "  " }), (err: Error & { code?: string }) => err.code === "PLAN_NOT_SAVED");
  assert.throws(() => acceptPlanUpsertAck({ id: "plan-1" }), (err: Error & { code?: string }) => err.code === "PLAN_NOT_SAVED");
  assert.deepEqual(acceptPlanUpsertAck({ branch_id: "branch-1" }), { branchId: "branch-1" });
  assert.equal(isPlanNotSaved(Object.assign(new Error("PLAN_NOT_SAVED"), { code: "PLAN_NOT_SAVED" })), true);
  assert.equal(isPlanNotSaved(new Error("network")), false);
});

test("upsertPlan requires a returned branch_id and App reverts a PLAN_NOT_SAVED write", () => {
  const repo = readFileSync(resolve(ROOT, "src/cloud/roomRepository.ts"), "utf8");
  const hook = readFileSync(resolve(ROOT, "src/cloud/useCloudRoom.ts"), "utf8");
  const app = readFileSync(resolve(ROOT, "src/App.tsx"), "utf8");
  assert.match(repo, /acceptPlanUpsertAck/);
  assert.match(repo, /select\("branch_id"\)\s*\.\s*maybeSingle\(\)/);
  assert.match(repo, /upsertPlan[\s\S]*acceptPlanUpsertAck/);
  assert.match(hook, /isPlanNotSaved/);
  assert.match(hook, /if \(isPlanNotSaved\(err\)\) \{[\s\S]*throw err;/);
  assert.doesNotMatch(hook, /run\(`plan:\$\{plan\.branchId\}`/);
  assert.match(app, /isPlanNotSaved\(err\)/);
  assert.match(app, /企劃沒有存成/);
  assert.match(app, /current\.updatedAt !== nextPlan\.updatedAt/);
});
