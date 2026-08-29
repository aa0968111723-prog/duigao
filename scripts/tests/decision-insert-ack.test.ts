import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { acceptDecisionInsertAck, isDecisionNotSaved } from "../../src/cloud/decisionAck";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("zero-row decision_records INSERT is not a created 待決定 card", () => {
  assert.throws(() => acceptDecisionInsertAck(null), (err: Error & { code?: string }) => err.code === "DECISION_NOT_SAVED");
  assert.throws(() => acceptDecisionInsertAck({}), (err: Error & { code?: string }) => err.code === "DECISION_NOT_SAVED");
  assert.throws(() => acceptDecisionInsertAck({ id: "  " }), (err: Error & { code?: string }) => err.code === "DECISION_NOT_SAVED");
  assert.deepEqual(acceptDecisionInsertAck({ id: "d1" }), { id: "d1" });
  assert.equal(isDecisionNotSaved(Object.assign(new Error("DECISION_NOT_SAVED"), { code: "DECISION_NOT_SAVED" })), true);
  assert.equal(isDecisionNotSaved(new Error("network")), false);
});

test("insertDecision requires a returned id and App reverts a DECISION_NOT_SAVED write", () => {
  const repo = readFileSync(resolve(ROOT, "src/cloud/collaborationRepository.ts"), "utf8");
  const hook = readFileSync(resolve(ROOT, "src/cloud/useCloudRoom.ts"), "utf8");
  const app = readFileSync(resolve(ROOT, "src/App.tsx"), "utf8");
  assert.match(repo, /acceptDecisionInsertAck/);
  assert.match(repo, /select\("id"\)\s*\.\s*maybeSingle\(\)/);
  assert.match(repo, /insertDecision[\s\S]*acceptDecisionInsertAck/);
  assert.match(hook, /isDecisionNotSaved/);
  assert.match(hook, /if \(isDecisionNotSaved\(err\)\) \{[\s\S]*throw err;/);
  assert.doesNotMatch(hook, /run\(`decision-insert:\$\{decision\.id\}`/);
  assert.match(app, /isDecisionNotSaved\(err\)/);
  assert.match(app, /待決定沒有建立/);
});
