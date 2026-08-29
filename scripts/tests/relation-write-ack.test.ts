import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  acceptRelationDeleteAck,
  acceptRelationInsertAck,
  isRelationNotRemoved,
  isRelationNotSaved,
} from "../../src/cloud/relationWriteAck";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("zero-row content_relations INSERT is not a saved relation", () => {
  assert.throws(() => acceptRelationInsertAck(null), (err: Error & { code?: string }) => err.code === "RELATION_NOT_SAVED");
  assert.throws(() => acceptRelationInsertAck({}), (err: Error & { code?: string }) => err.code === "RELATION_NOT_SAVED");
  assert.throws(() => acceptRelationInsertAck({ id: "  " }), (err: Error & { code?: string }) => err.code === "RELATION_NOT_SAVED");
  assert.deepEqual(acceptRelationInsertAck({ id: "rel-1" }), { id: "rel-1" });
  assert.equal(isRelationNotSaved(Object.assign(new Error("RELATION_NOT_SAVED"), { code: "RELATION_NOT_SAVED" })), true);
  assert.equal(isRelationNotSaved(new Error("network")), false);
});

test("zero-row content_relations DELETE is not a removed relation", () => {
  assert.throws(() => acceptRelationDeleteAck(null), (err: Error & { code?: string }) => err.code === "RELATION_NOT_REMOVED");
  assert.throws(() => acceptRelationDeleteAck({}), (err: Error & { code?: string }) => err.code === "RELATION_NOT_REMOVED");
  assert.throws(() => acceptRelationDeleteAck({ id: "  " }), (err: Error & { code?: string }) => err.code === "RELATION_NOT_REMOVED");
  assert.deepEqual(acceptRelationDeleteAck({ id: "rel-1" }), { id: "rel-1" });
  assert.equal(isRelationNotRemoved(Object.assign(new Error("RELATION_NOT_REMOVED"), { code: "RELATION_NOT_REMOVED" })), true);
  assert.equal(isRelationNotRemoved(new Error("network")), false);
});

test("relation writes require a returned id and App reverts a failed chip change", () => {
  const repo = readFileSync(resolve(ROOT, "src/cloud/roomRepository.ts"), "utf8");
  const hook = readFileSync(resolve(ROOT, "src/cloud/useCloudRoom.ts"), "utf8");
  const app = readFileSync(resolve(ROOT, "src/App.tsx"), "utf8");
  assert.match(repo, /acceptRelationInsertAck/);
  assert.match(repo, /acceptRelationDeleteAck/);
  assert.match(repo, /insertRelation[\s\S]*select\("id"\)\s*\.\s*maybeSingle\(\)[\s\S]*acceptRelationInsertAck/);
  assert.match(repo, /deleteRelation[\s\S]*select\("id"\)\s*\.\s*maybeSingle\(\)[\s\S]*acceptRelationDeleteAck/);
  assert.match(hook, /isRelationNotSaved/);
  assert.match(hook, /isRelationNotRemoved/);
  assert.match(hook, /if \(isRelationNotSaved\(err\)\) \{[\s\S]*throw err;/);
  assert.match(hook, /if \(isRelationNotRemoved\(err\)\) \{[\s\S]*throw err;/);
  assert.doesNotMatch(hook, /run\(`relation:\$\{relation\.id\}`/);
  assert.doesNotMatch(hook, /run\(`relation-del:\$\{relationId\}`/);
  assert.match(app, /isRelationNotSaved\(err\)/);
  assert.match(app, /isRelationNotRemoved\(err\)/);
  assert.match(app, /相關內容沒有加上/);
  assert.match(app, /相關內容沒有移除/);
});
