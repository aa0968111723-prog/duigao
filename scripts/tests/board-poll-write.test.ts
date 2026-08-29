import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { boardPollWrite } from "../../src/features/collaboration/boardPollWrite.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function src(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

test("empty or one-option writes are not polls", () => {
  assert.equal(boardPollWrite("", ["贊成", "再想想"]), null);
  assert.equal(boardPollWrite("   ", ["贊成", "再想想"]), null);
  assert.equal(boardPollWrite("主視覺要不要換？", ["贊成"]), null);
  assert.deepEqual(boardPollWrite("  主視覺要不要換？  ", [" 要，換成 B 版 ", "先維持 A 版"]), {
    question: "主視覺要不要換？",
    options: ["要，換成 B 版", "先維持 A 版"],
  });
});

test("whiteboard ＋投票 opens a draft; does not create a canned 主視覺 poll", () => {
  const wb = src("src/features/whiteboard/WhiteboardWorkspace.tsx");
  assert.doesNotMatch(wb, /onCreatePoll\("主視覺要不要換？"/);
  assert.match(wb, /wb-poll-question/);
  assert.match(wb, /wb-create-poll-save/);
  assert.match(wb, /boardPollWrite/);
});

test("discussion create-poll requires a filled question; empty body is not a poll", () => {
  const ws = src("src/features/room-discussion/RoomDiscussion.tsx");
  assert.doesNotMatch(ws, /要不要這樣做？/);
  assert.doesNotMatch(ws, /message\.body\s*\|\|/);
  assert.match(ws, /discussion-create-poll/);
  assert.match(ws, /discussion-poll-question/);
  assert.match(ws, /discussion-create-poll-save/);
  assert.match(ws, /boardPollWrite/);
});

test("App and AI payload do not invent a canned poll title", () => {
  const app = src("src/App.tsx");
  const ai = src("src/ai/proposals.ts");
  assert.match(app, /boardPollWrite/);
  assert.doesNotMatch(ai, /要不要這樣做？/);
});
