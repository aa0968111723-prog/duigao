import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  acknowledgePendingWrite,
  enqueuePendingWrite,
  flushPendingWrites,
  type PendingWrite,
} from "../../src/cloud/pendingWrites.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("later write of the same key replaces the stale captured closure", () => {
  const seen: string[] = [];
  let queue: PendingWrite[] = [];
  queue = enqueuePendingWrite(queue, { key: "plan:b1", task: async () => { seen.push("v1"); } });
  queue = enqueuePendingWrite(queue, { key: "plan:b1", task: async () => { seen.push("v2"); } });
  assert.equal(queue.length, 1);
  assert.equal(queue[0].key, "plan:b1");
});

test("a later success drops a queued write for the same resource", () => {
  let queue: PendingWrite[] = [
    { key: "plan:b1", task: async () => { throw new Error("stale"); } },
    { key: "title", task: async () => undefined },
  ];
  queue = acknowledgePendingWrite(queue, "plan:b1");
  assert.deepEqual(queue.map((item) => item.key), ["title"]);
});

test("flush replays only the latest same-key task and keeps unrelated keys", async () => {
  const seen: string[] = [];
  let queue: PendingWrite[] = [];
  queue = enqueuePendingWrite(queue, { key: "plan:b1", task: async () => { seen.push("old"); } });
  queue = enqueuePendingWrite(queue, { key: "plan:b1", task: async () => { seen.push("new"); } });
  queue = enqueuePendingWrite(queue, { key: "title", task: async () => { seen.push("title"); } });
  const retained = await flushPendingWrites(queue, () => false);
  assert.deepEqual(seen, ["new", "title"]);
  assert.equal(retained.length, 0);
});

test("useCloudRoom keys replaceable writes and flushes before snapshot reload", () => {
  const source = readFileSync(resolve(ROOT, "src/cloud/useCloudRoom.ts"), "utf8");
  assert.match(source, /run\(`plan:\$\{plan\.branchId\}`/);
  assert.match(source, /run\("room-title"/);
  assert.match(source, /run\(`proposal:\$\{doc\.id\}`/);
  assert.match(source, /acknowledgePendingWrite/);
  assert.match(source, /await flushPending\(\);\s*\r?\n\s*if \(boundRef\.current\) await reload\(\)/);
});

test("flush re-queues a failed non-duplicate write and drops duplicate-key success", async () => {
  const stale: PendingWrite = { key: "plan:b1", task: async () => { throw new Error("offline"); } };
  const dup: PendingWrite = { key: "comment:c1", task: async () => { throw Object.assign(new Error("dup"), { code: "23505" }); } };
  const retained = await flushPendingWrites([stale, dup], (error) =>
    Boolean(error && typeof error === "object" && "code" in error && (error as { code: string }).code === "23505"),
  );
  assert.deepEqual(retained.map((item) => item.key), ["plan:b1"]);
});
