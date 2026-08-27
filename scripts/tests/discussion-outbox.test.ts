import test from "node:test";
import assert from "node:assert/strict";
import { reconcileOutbox, type OutboxEntry } from "../../src/hooks/discussionOutboxCore.ts";
import type { DiscussionMessage } from "../../src/features/collaboration/types.ts";

function message(id: string, roomId: string): DiscussionMessage {
  return { id, roomId, authorId: "a", authorName: "A", authorColor: "#000", kind: "text", body: id, payload: {}, createdAt: 1, updatedAt: 1 };
}

function entry(id: string, roomId: string, state: OutboxEntry["state"]): [string, OutboxEntry] {
  return [id, { message: message(id, roomId), state }];
}

test("bind re-key 同一次 render 到達：本機 id 的 sending 被遷移並補送，不被刪", () => {
  const { entries, toFlush } = reconcileOutbox(Object.fromEntries([entry("m1", "local_x", "sending")]), {
    prevLocalRoomId: "local_x",
    prevBoundRoomId: null,
    localRoomId: "cloud_y",
    boundRoomId: "cloud_y",
  });
  assert.equal(entries.m1.message.roomId, "cloud_y");
  assert.deepEqual(toFlush.map((m) => m.id), ["m1"]);
});

test("bind 先到、re-key 後到（兩次 render）：兩步之後 entry 仍在且已遷移", () => {
  // step 1: bound 可見、room.id 還是本機 id → 補送、不刪
  const step1 = reconcileOutbox(Object.fromEntries([entry("m1", "local_x", "sending")]), {
    prevLocalRoomId: "local_x",
    prevBoundRoomId: null,
    localRoomId: "local_x",
    boundRoomId: "cloud_y",
  });
  assert.ok(step1.entries.m1, "bind 可見時不得刪 in-flight entry");
  assert.deepEqual(step1.toFlush.map((m) => m.id), ["m1"]);
  // step 2: room.id re-key → 遷移（dispatch 尚未寫回 stamp 的情況）
  const step2 = reconcileOutbox(step1.entries, {
    prevLocalRoomId: "local_x",
    prevBoundRoomId: "cloud_y",
    localRoomId: "cloud_y",
    boundRoomId: "cloud_y",
  });
  assert.equal(step2.entries.m1.message.roomId, "cloud_y");
  // 不重複補送（不是剛綁定）
  assert.deepEqual(step2.toFlush, []);
});

test("re-key 後 insert 失敗：failed entry 屬於本房，重試路徑存在（不會無聲消失）", () => {
  const migrated = reconcileOutbox(Object.fromEntries([entry("m1", "local_x", "failed")]), {
    prevLocalRoomId: "local_x",
    prevBoundRoomId: null,
    localRoomId: "cloud_y",
    boundRoomId: "cloud_y",
  });
  assert.equal(migrated.entries.m1.state, "failed");
  assert.equal(migrated.entries.m1.message.roomId, "cloud_y");
});

test("A→home：A 的 entry 立即被隔離，不殘留", () => {
  const { entries } = reconcileOutbox(Object.fromEntries([entry("m1", "cloud_a", "failed"), entry("m2", "cloud_a", "sending")]), {
    prevLocalRoomId: "cloud_a",
    prevBoundRoomId: "cloud_a",
    localRoomId: null,
    boundRoomId: null,
  });
  assert.deepEqual(Object.keys(entries), []);
});

test("A→B：A 的 entry 不遷移、不補送進 B", () => {
  const { entries, toFlush } = reconcileOutbox(Object.fromEntries([entry("m1", "cloud_a", "sending")]), {
    prevLocalRoomId: "cloud_a",
    prevBoundRoomId: "cloud_a",
    localRoomId: "cloud_b",
    boundRoomId: "cloud_b",
  });
  assert.deepEqual(Object.keys(entries), [], "A 的 sending 不得殘留");
  assert.deepEqual(toFlush, [], "絕不補送進 B");
});

test("剛綁定：只補送屬於本房的 sending，failed/acked 不動", () => {
  const { toFlush } = reconcileOutbox(
    Object.fromEntries([
      entry("s1", "cloud_y", "sending"),
      entry("f1", "cloud_y", "failed"),
      entry("k1", "cloud_y", "acked"),
    ]),
    { prevLocalRoomId: "cloud_y", prevBoundRoomId: null, localRoomId: "cloud_y", boundRoomId: "cloud_y" },
  );
  assert.deepEqual(toFlush.map((m) => m.id), ["s1"]);
});
