import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { DiscussionMessage } from "../../src/features/collaboration/types.ts";
import { flushOutboxOnOnline, type OutboxEntry } from "../../src/hooks/discussionOutboxCore.ts";
import {
  acceptRealtimePayload,
  applyDiscussionRealtime,
} from "../../src/cloud/realtimeApply.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function msg(id: string, extras: Partial<DiscussionMessage> = {}): DiscussionMessage {
  return {
    id,
    roomId: extras.roomId ?? "room-a",
    authorId: extras.authorId ?? "user-a",
    authorName: "A",
    authorColor: "#000",
    kind: extras.kind ?? "text",
    body: extras.body ?? id,
    payload: extras.payload ?? {},
    createdAt: extras.createdAt ?? 10,
    updatedAt: extras.updatedAt ?? 10,
  };
}

function entry(id: string, state: OutboxEntry["state"], ownerId: string): OutboxEntry {
  return { message: msg(id, { authorId: ownerId }), state, ownerId };
}

test("duplicate realtime event does not create a second discussion row", () => {
  const first = applyDiscussionRealtime([], { op: "upsert", message: msg("m1") });
  assert.equal(first.applied, true);
  assert.equal(first.messages.length, 1);
  const dup = applyDiscussionRealtime(first.messages, { op: "upsert", message: msg("m1") });
  assert.equal(dup.applied, false);
  assert.equal(dup.messages.length, 1);
  assert.equal(dup.messages[0].body, "m1");
});

test("offline enqueue then replay only this owner's failed rows", () => {
  const queued = {
    mine: entry("mine", "failed", "user-a"),
    other: entry("other", "failed", "user-b"),
    flying: entry("flying", "sending", "user-a"),
  };
  const replay = flushOutboxOnOnline(queued, "user-a");
  assert.deepEqual(replay.toFlush.map((item) => item.id), ["mine"]);
  assert.equal(replay.entries.mine.state, "sending");
  assert.equal(replay.entries.other.state, "failed");
  assert.equal(replay.entries.flying.state, "sending");
});

test("account switch must not flush the other account's outbox", () => {
  const mixed = {
    a: entry("a", "failed", "user-a"),
    b: entry("b", "failed", "user-b"),
  };
  const asB = flushOutboxOnOnline(mixed, "user-b");
  assert.deepEqual(asB.toFlush.map((item) => item.id), ["b"]);
  assert.equal(asB.entries.a.state, "failed");
  assert.equal(asB.entries.b.state, "sending");
  const nobody = flushOutboxOnOnline(mixed, null);
  assert.deepEqual(nobody.toFlush, []);
  assert.equal(nobody.entries.a.state, "failed");
  assert.equal(nobody.entries.b.state, "failed");
});

test("SPA HTML / failed realtime must not look like applied", () => {
  const html = "<!doctype html><html><title>duigao</title></html>";
  assert.equal(acceptRealtimePayload(html).ok, false);
  assert.equal(acceptRealtimePayload({ id: "x", room_id: "r" }).ok, true);
  assert.equal(acceptRealtimePayload(null).ok, false);
  assert.equal(acceptRealtimePayload({}).ok, false);
  assert.equal(acceptRealtimePayload({ id: "" }).ok, false);
  const rejected = applyDiscussionRealtime([msg("keep")], { op: "upsert", message: null });
  assert.equal(rejected.applied, false);
  assert.equal(rejected.messages[0].id, "keep");
});

test("older duplicate loses; newer update replaces; delete is idempotent", () => {
  const seed = applyDiscussionRealtime([], { op: "upsert", message: msg("m1", { body: "v1", updatedAt: 20 }) });
  const older = applyDiscussionRealtime(seed.messages, { op: "upsert", message: msg("m1", { body: "old", updatedAt: 5 }) });
  assert.equal(older.applied, false);
  assert.equal(older.messages[0].body, "v1");
  const newer = applyDiscussionRealtime(seed.messages, { op: "upsert", message: msg("m1", { body: "v2", updatedAt: 30 }) });
  assert.equal(newer.applied, true);
  assert.equal(newer.messages[0].body, "v2");
  const del = applyDiscussionRealtime(newer.messages, { op: "delete", id: "m1" });
  assert.equal(del.applied, true);
  assert.equal(del.messages.length, 0);
  const delAgain = applyDiscussionRealtime(del.messages, { op: "delete", id: "m1" });
  assert.equal(delAgain.applied, false);
});

test("attachment kind is the same discussion stream, not a second sync", () => {
  const file = msg("att", { kind: "attachment", body: "brief.pdf", payload: { name: "brief.pdf" } });
  const first = applyDiscussionRealtime([], { op: "upsert", message: file });
  const dup = applyDiscussionRealtime(first.messages, { op: "upsert", message: file });
  assert.equal(first.messages[0].kind, "attachment");
  assert.equal(dup.applied, false);
  assert.equal(dup.messages.length, 1);
});

test("wiring: room sync rejects bad payloads and discussion no longer whole-room reloads", () => {
  const sync = readFileSync(resolve(ROOT, "src/cloud/roomSync.ts"), "utf8");
  const hook = readFileSync(resolve(ROOT, "src/hooks/useDiscussionOutbox.ts"), "utf8");
  const core = readFileSync(resolve(ROOT, "src/hooks/discussionOutboxCore.ts"), "utf8");
  assert.match(sync, /acceptRealtimePayload/);
  assert.match(sync, /onDiscussionUpsert|onDiscussionChange/);
  assert.doesNotMatch(
    sync,
    /room_discussion_messages[\s\S]{0,120}handlers\.onProjectChange/,
  );
  assert.match(hook, /flushOutboxOnOnline/);
  assert.match(core, /flushOutboxOnOnline/);
});
