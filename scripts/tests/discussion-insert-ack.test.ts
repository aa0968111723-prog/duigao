import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { acceptDiscussionInsert } from "../../src/cloud/discussionWrite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("zero-row room_discussion_messages INSERT is not a sent discussion line", () => {
  assert.deepEqual(acceptDiscussionInsert({ error: null, data: null }), { ok: false, code: "ZERO_ROW" });
  assert.deepEqual(acceptDiscussionInsert({ error: null, data: { id: "m1" } }), { ok: true, reason: "inserted" });
  assert.deepEqual(acceptDiscussionInsert({ error: new Error("duplicate key value violates unique constraint") }), {
    ok: true,
    reason: "duplicate",
  });
});

test("insertDiscussion selects a row; ZERO_ROW and transient failures stay outbox-retryable", () => {
  const repo = readFileSync(resolve(ROOT, "src/cloud/collaborationRepository.ts"), "utf8");
  const hook = readFileSync(resolve(ROOT, "src/cloud/useCloudRoom.ts"), "utf8");
  const outbox = readFileSync(resolve(ROOT, "src/hooks/useDiscussionOutbox.ts"), "utf8");
  const app = readFileSync(resolve(ROOT, "src/App.tsx"), "utf8");
  assert.match(repo, /select\("id"\)\s*\.\s*maybeSingle\(\)/);
  assert.match(repo, /accepted\.code === "ZERO_ROW"/);
  assert.match(hook, /insertDiscussion: async \(message\) => \{[\s\S]*return false;/);
  assert.match(outbox, /state: "failed"/);
  assert.match(outbox, /void dispatch\(entry\.message\)/);
  assert.match(app, /discussionOutboxRef\.current\.send/);
});
