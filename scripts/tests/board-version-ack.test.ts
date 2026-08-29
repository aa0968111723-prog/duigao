import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { acceptBoardVersionInsertAck, isBoardVersionNotSaved } from "../../src/cloud/boardVersionAck";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("zero-row whiteboard_versions INSERT is not a saved snapshot", () => {
  assert.throws(() => acceptBoardVersionInsertAck(null), (err: Error & { code?: string }) => err.code === "BOARD_VERSION_NOT_SAVED");
  assert.throws(() => acceptBoardVersionInsertAck({}), (err: Error & { code?: string }) => err.code === "BOARD_VERSION_NOT_SAVED");
  assert.throws(() => acceptBoardVersionInsertAck({ id: "  " }), (err: Error & { code?: string }) => err.code === "BOARD_VERSION_NOT_SAVED");
  assert.deepEqual(acceptBoardVersionInsertAck({ id: "bv1" }), { id: "bv1" });
  assert.equal(isBoardVersionNotSaved(Object.assign(new Error("BOARD_VERSION_NOT_SAVED"), { code: "BOARD_VERSION_NOT_SAVED" })), true);
  assert.equal(isBoardVersionNotSaved(new Error("network")), false);
});

test("createBoardVersion requires a returned id; snapshot UI does not claim a zero-row save", () => {
  const repo = readFileSync(resolve(ROOT, "src/cloud/collaborationRepository.ts"), "utf8");
  const app = readFileSync(resolve(ROOT, "src/App.tsx"), "utf8");
  const workspace = readFileSync(resolve(ROOT, "src/features/whiteboard/WhiteboardWorkspace.tsx"), "utf8");
  assert.match(repo, /acceptBoardVersionInsertAck/);
  assert.match(repo, /select\("id"\)\s*\.\s*maybeSingle\(\)/);
  assert.match(repo, /createBoardVersion[\s\S]*acceptBoardVersionInsertAck/);
  assert.match(app, /await createBoardVersion/);
  assert.match(workspace, /已存下這一刻的快照/);
  assert.match(workspace, /快照沒存成功/);
});
