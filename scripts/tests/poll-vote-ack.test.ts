import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { acceptPollVoteAck, isVoteNotSaved } from "../../src/cloud/pollVoteAck";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("zero-row room_poll_votes UPSERT is not a saved vote", () => {
  assert.throws(() => acceptPollVoteAck(null), (err: Error & { code?: string }) => err.code === "VOTE_NOT_SAVED");
  assert.throws(() => acceptPollVoteAck({}), (err: Error & { code?: string }) => err.code === "VOTE_NOT_SAVED");
  assert.throws(() => acceptPollVoteAck({ poll_id: "  " }), (err: Error & { code?: string }) => err.code === "VOTE_NOT_SAVED");
  assert.throws(() => acceptPollVoteAck({ id: "vote-1" }), (err: Error & { code?: string }) => err.code === "VOTE_NOT_SAVED");
  assert.deepEqual(acceptPollVoteAck({ poll_id: "poll-1" }), { pollId: "poll-1" });
  assert.equal(isVoteNotSaved(Object.assign(new Error("VOTE_NOT_SAVED"), { code: "VOTE_NOT_SAVED" })), true);
  assert.equal(isVoteNotSaved(new Error("network")), false);
});

test("votePoll requires a returned poll_id and App reverts a VOTE_NOT_SAVED write", () => {
  const repo = readFileSync(resolve(ROOT, "src/cloud/roomRepository.ts"), "utf8");
  const hook = readFileSync(resolve(ROOT, "src/cloud/useCloudRoom.ts"), "utf8");
  const app = readFileSync(resolve(ROOT, "src/App.tsx"), "utf8");
  assert.match(repo, /acceptPollVoteAck/);
  assert.match(repo, /select\("poll_id"\)\s*\.\s*maybeSingle\(\)/);
  assert.match(repo, /votePoll[\s\S]*acceptPollVoteAck/);
  assert.match(hook, /isVoteNotSaved/);
  assert.match(hook, /if \(isVoteNotSaved\(err\)\) \{[\s\S]*throw err;/);
  assert.doesNotMatch(hook, /run\(`vote:\$\{vote\.pollId\}:\$\{vote\.userId\}`/);
  assert.match(app, /isVoteNotSaved\(err\)/);
  assert.match(app, /這一票沒有存成/);
  assert.match(app, /current\.option !== vote\.option/);
  assert.doesNotMatch(app, /setCommentResolved[\s\S]{0,200}已讀/);
});
