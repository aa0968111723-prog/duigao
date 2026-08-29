import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  acceptDiscussionInsert,
  acceptStorageUpload,
  applyIdempotentInsert,
  honestUploadPercent,
  looksLikeSpaHtml,
  uploadIsComplete,
} from "../../src/cloud/discussionWrite.ts";
import { isolateOutboxForOwner, type OutboxEntry } from "../../src/hooks/discussionOutboxCore.ts";
import type { DiscussionMessage } from "../../src/features/collaboration/types.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function msg(id: string, authorId: string, roomId = "r"): DiscussionMessage {
  return { id, roomId, authorId, authorName: "A", authorColor: "#000", kind: "text", body: id, payload: {}, createdAt: 1, updatedAt: 1 };
}

test("positive: real insert and matching storage path succeed", () => {
  assert.deepEqual(acceptDiscussionInsert({ error: null, data: null }), { ok: true, reason: "inserted" });
  assert.deepEqual(
    acceptStorageUpload({ error: null, data: { path: "rooms/r/attachments/m/a.bin" }, expectedPath: "rooms/r/attachments/m/a.bin" }),
    { ok: true },
  );
  assert.deepEqual(
    acceptStorageUpload({ error: null, data: { Key: "room-assets/rooms/r/attachments/m/a.bin" }, expectedPath: "rooms/r/attachments/m/a.bin" }),
    { ok: true },
  );
  assert.equal(honestUploadPercent("complete", 40), 100);
  assert.equal(uploadIsComplete("complete"), true);
});

test("negative: SPA HTML is never send or upload success", () => {
  const html = "<!doctype html><html><title>duigao</title></html>";
  assert.equal(looksLikeSpaHtml(html, "text/html"), true);
  assert.deepEqual(acceptDiscussionInsert({ error: null, data: html }), { ok: false, code: "SPA_HTML" });
  assert.deepEqual(acceptDiscussionInsert({ error: new Error(html) }), { ok: false, code: "SPA_HTML" });
  assert.deepEqual(
    acceptStorageUpload({ error: null, data: html, expectedPath: "rooms/r/a.bin" }),
    { ok: false, code: "SPA_HTML" },
  );
  assert.deepEqual(
    acceptStorageUpload({ error: new Error(html), expectedPath: "rooms/r/a.bin", contentType: "text/html" }),
    { ok: false, code: "SPA_HTML" },
  );
});

test("negative: failed / incomplete upload is not complete and percent is not 100", () => {
  assert.deepEqual(
    acceptStorageUpload({ error: new Error("network"), expectedPath: "rooms/r/a.bin" }),
    { ok: false, code: "FAILED" },
  );
  assert.deepEqual(
    acceptStorageUpload({ error: null, data: null, expectedPath: "rooms/r/a.bin" }),
    { ok: false, code: "INCOMPLETE" },
  );
  assert.deepEqual(
    acceptStorageUpload({ error: null, data: { path: "other" }, expectedPath: "rooms/r/a.bin" }),
    { ok: false, code: "INCOMPLETE" },
  );
  assert.equal(honestUploadPercent("failed", 100), 0);
  assert.equal(honestUploadPercent("uploading", 100), 99);
  assert.equal(uploadIsComplete("failed"), false);
  assert.equal(uploadIsComplete("uploading"), false);
});

test("negative: missing API / generic failure is not a sent message", () => {
  assert.deepEqual(acceptDiscussionInsert({ error: new Error("JWT expired") }), { ok: false, code: "FAILED" });
  const landed = applyIdempotentInsert(new Set(), "m1", { ok: false, code: "FAILED" });
  assert.equal(landed.created, false);
  assert.equal(landed.landedIds.size, 0);
});

test("idempotent: same client mutation id does not create two server messages", () => {
  const first = applyIdempotentInsert(new Set(), "m1", { ok: true, reason: "inserted" });
  assert.equal(first.created, true);
  const retry = applyIdempotentInsert(first.landedIds, "m1", { ok: true, reason: "duplicate" });
  assert.equal(retry.created, false);
  assert.equal(retry.landedIds.size, 1);
  const other = applyIdempotentInsert(retry.landedIds, "m2", { ok: true, reason: "inserted" });
  assert.equal(other.created, true);
  assert.equal(other.landedIds.size, 2);
});

test("duplicate-key retry is success; HTML that mentions 23505 is still rejected", () => {
  assert.deepEqual(acceptDiscussionInsert({ error: new Error("duplicate key value violates unique constraint") }), {
    ok: true,
    reason: "duplicate",
  });
  assert.deepEqual(acceptDiscussionInsert({ error: new Error("<!doctype html>23505") }), { ok: false, code: "SPA_HTML" });
});

test("account switch: other owner's outbox rows stay invisible", () => {
  const entries: Record<string, OutboxEntry> = {
    a1: { message: msg("a1", "user-a"), state: "failed", ownerId: "user-a" },
    b1: { message: msg("b1", "user-b"), state: "sending", ownerId: "user-b" },
  };
  assert.deepEqual(Object.keys(isolateOutboxForOwner(entries, "user-b")), ["b1"]);
  assert.deepEqual(Object.keys(isolateOutboxForOwner(entries, "user-a")), ["a1"]);
  assert.deepEqual(isolateOutboxForOwner(entries, null), {});
});

test("legacy rows without ownerId only surface for matching authorId", () => {
  const entries: Record<string, OutboxEntry> = {
    old: { message: msg("old", "user-a"), state: "failed" },
  };
  assert.equal(isolateOutboxForOwner(entries, "user-a").old?.state, "failed");
  assert.equal(isolateOutboxForOwner(entries, "user-b").old, undefined);
});

test("mutation/negative-control: treating SPA HTML as success would fake a send", () => {
  const html = "<!doctype html><html></html>";
  const honest = acceptDiscussionInsert({ error: null, data: html });
  assert.equal(honest.ok, false);
  // Control: the pre-fix rule (no error ⇒ success) would land a fake message.
  const naive = html && !null ? { ok: true as const, reason: "inserted" as const } : honest;
  const faked = applyIdempotentInsert(new Set(), "ghost", naive);
  assert.equal(faked.created, true, "documents the defect the parser exists to stop");
  const guarded = applyIdempotentInsert(new Set(), "ghost", honest);
  assert.equal(guarded.created, false);
});

test("mutation/negative-control: blob-only / null data must not mark upload complete", () => {
  const naiveComplete = !null; // old uploadAttachment: only checked error
  assert.equal(naiveComplete, true);
  const honest = acceptStorageUpload({ error: null, data: null, expectedPath: "rooms/r/a.bin" });
  assert.equal(honest.ok, false);
  assert.equal(uploadIsComplete("failed"), false);
});

test("wiring: insert and upload paths call the honesty helpers", () => {
  const repo = readFileSync(resolve(ROOT, "src/cloud/collaborationRepository.ts"), "utf8");
  const assets = readFileSync(resolve(ROOT, "src/cloud/assets.ts"), "utf8");
  const hook = readFileSync(resolve(ROOT, "src/hooks/useDiscussionOutbox.ts"), "utf8");
  const store = readFileSync(resolve(ROOT, "src/lib/store.ts"), "utf8");
  assert.match(repo, /acceptDiscussionInsert/);
  assert.match(assets, /acceptStorageUpload/);
  assert.match(hook, /ownerId/);
  assert.match(store, /ownerId/);
});

test("mobile first layer keeps composer; secondary chrome lives behind 更多", () => {
  const shell = readFileSync(resolve(ROOT, "src/features/multi-room/MultiBranchRoom.tsx"), "utf8");
  const discussion = readFileSync(resolve(ROOT, "src/features/room-discussion/RoomDiscussion.tsx"), "utf8");
  assert.match(discussion, /onComposerActive/);
  assert.match(shell, /composerActive/);
  assert.match(shell, /data-testid="room-more"/);
  assert.doesNotMatch(shell, /hideRoomChrome/);
});
