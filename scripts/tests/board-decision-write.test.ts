import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { boardDecisionWrite, decisionDraftTitle } from "../../src/features/collaboration/boardDecisionWrite.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function src(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

test("empty or whitespace titles are not decisions", () => {
  assert.equal(decisionDraftTitle(""), null);
  assert.equal(decisionDraftTitle("   "), null);
  assert.equal(boardDecisionWrite(""), null);
  assert.equal(boardDecisionWrite("   "), null);
  assert.deepEqual(boardDecisionWrite("  採用 B 版  "), { title: "採用 B 版", status: "decided" });
  assert.equal(decisionDraftTitle("  主視覺採 B  "), "主視覺採 B");
});

test("whiteboard 寫下決策 opens a draft; does not create a canned 採用 B 版", () => {
  const wb = src("src/features/whiteboard/WhiteboardWorkspace.tsx");
  assert.doesNotMatch(wb, /onCreateDecision\("已決定：採用 B 版"/);
  assert.match(wb, /wb-decision-title/);
  assert.match(wb, /wb-write-decision-save/);
  assert.match(wb, /boardDecisionWrite/);
});

test("discussion 新增待決定 requires a filled title; empty canned 主視覺 is not a decision", () => {
  const ws = src("src/features/room-discussion/RoomDiscussion.tsx");
  assert.doesNotMatch(ws, /待決定：主視覺/);
  assert.match(ws, /decision-draft/);
  assert.match(ws, /decision-draft-open/);
  assert.match(ws, /decisionDraftTitle|boardDecisionWrite/);
});

test("App does not keep an empty-title decision", () => {
  const app = src("src/App.tsx");
  assert.match(app, /boardDecisionWrite|decisionDraftTitle/);
});

test("collaboration e2e fills the decision draft instead of one-clicking a canned title", () => {
  const e2e = src("scripts/e2e/collaboration-workspace.mjs");
  assert.match(e2e, /wb-decision-title/);
  assert.match(e2e, /wb-write-decision-save/);
  assert.doesNotMatch(e2e, /getByTestId\("wb-write-decision"\)\.click\(\);\s*check\("可寫決策節點"/);
});
