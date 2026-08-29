import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { acceptEdgeInsertAck, isEdgeNotSaved } from "../../src/cloud/edgeAck";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("zero-row whiteboard_edges INSERT is not a drawn line", () => {
  assert.throws(() => acceptEdgeInsertAck(null), (err: Error & { code?: string }) => err.code === "EDGE_NOT_SAVED");
  assert.throws(() => acceptEdgeInsertAck({}), (err: Error & { code?: string }) => err.code === "EDGE_NOT_SAVED");
  assert.throws(() => acceptEdgeInsertAck({ id: "  " }), (err: Error & { code?: string }) => err.code === "EDGE_NOT_SAVED");
  assert.deepEqual(acceptEdgeInsertAck({ id: "e1" }), { id: "e1" });
  assert.equal(isEdgeNotSaved(Object.assign(new Error("EDGE_NOT_SAVED"), { code: "EDGE_NOT_SAVED" })), true);
  assert.equal(isEdgeNotSaved(new Error("network")), false);
});

test("insertEdge requires a returned id and App reverts an EDGE_NOT_SAVED write", () => {
  const repo = readFileSync(resolve(ROOT, "src/cloud/collaborationRepository.ts"), "utf8");
  const hook = readFileSync(resolve(ROOT, "src/cloud/useCloudRoom.ts"), "utf8");
  const app = readFileSync(resolve(ROOT, "src/App.tsx"), "utf8");
  assert.match(repo, /acceptEdgeInsertAck/);
  assert.match(repo, /select\("id"\)\s*\.\s*maybeSingle\(\)/);
  assert.match(repo, /insertEdge[\s\S]*acceptEdgeInsertAck/);
  assert.match(hook, /isEdgeNotSaved/);
  assert.match(hook, /if \(isEdgeNotSaved\(err\)\) \{[\s\S]*throw err;/);
  assert.doesNotMatch(hook, /run\(`edge:\$\{edge\.id\}`/);
  assert.match(app, /isEdgeNotSaved\(err\)/);
  assert.match(app, /連線沒有建立/);
});
