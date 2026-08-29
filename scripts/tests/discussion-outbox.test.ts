import test from "node:test";
import assert from "node:assert/strict";
import { shouldFollowLatest } from "../../src/features/room-discussion/feed.ts";
import { belongsToCurrentRoom, blockedRepliesTo, failedBlockingParentId, isReplyParentReady, reconcileOutbox, type OutboxEntry } from "../../src/hooks/discussionOutboxCore.ts";
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

test("A→home：A 的 entry 保留，回首頁也不丟掉未送出", () => {
  const { entries, toFlush } = reconcileOutbox(Object.fromEntries([entry("m1", "cloud_a", "failed"), entry("m2", "cloud_a", "sending")]), {
    prevLocalRoomId: "cloud_a",
    prevBoundRoomId: "cloud_a",
    localRoomId: null,
    boundRoomId: null,
  });
  assert.deepEqual(Object.keys(entries).sort(), ["m1", "m2"]);
  assert.deepEqual(toFlush, []);
});

test("A→B：A 的 entry 不遷移、不補送進 B，但還在（回 A 可重試）", () => {
  const { entries, toFlush } = reconcileOutbox(Object.fromEntries([entry("m1", "cloud_a", "sending")]), {
    prevLocalRoomId: "cloud_a",
    prevBoundRoomId: "cloud_a",
    localRoomId: "cloud_b",
    boundRoomId: "cloud_b",
  });
  assert.equal(entries.m1.message.roomId, "cloud_a");
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

// ---------------------------------------------------------------------------
// 回覆順序（PR-COMM-00）
//
// (reply_to_id, room_id) 是複合外鍵，來源那一列必須先在資料庫裡。outbox 對
// 每則訊息各發各的 insert，所以「回覆自己剛送出的那則」會賽跑。
// ---------------------------------------------------------------------------

function replyMessage(id: string, roomId: string, replyToId: string): DiscussionMessage {
  return { ...message(id, roomId), replyToId };
}

test("來源還在 sending：回覆先扣住，不送出去撞外鍵", () => {
  const entries = Object.fromEntries([entry("m1", "r", "sending")]);
  const reply = replyMessage("m2", "r", "m1");
  assert.equal(isReplyParentReady(reply, entries, new Set()), false);
});

test("來源已 acked：insert 已被接受，row 存在，回覆送得出去", () => {
  const entries = Object.fromEntries([entry("m1", "r", "acked")]);
  assert.equal(isReplyParentReady(replyMessage("m2", "r", "m1"), entries, new Set()), true);
});

test("來源在伺服器快照裡：本來就在資料庫，送得出去", () => {
  assert.equal(isReplyParentReady(replyMessage("m2", "r", "m1"), {}, new Set(["m1"])), true);
});

test("來源根本不在 outbox：那是既有的伺服器訊息，不扣", () => {
  assert.equal(isReplyParentReady(replyMessage("m2", "r", "old"), {}, new Set()), true);
});

test("沒有 replyToId 的一般訊息永遠不被扣住", () => {
  const entries = Object.fromEntries([entry("m1", "r", "failed")]);
  assert.equal(isReplyParentReady(message("m2", "r"), entries, new Set()), true);
});

test("來源 ack 之後放出被擋住的回覆，且照 createdAt 排序", () => {
  const entries: Record<string, OutboxEntry> = {
    m1: { message: message("m1", "r"), state: "acked" },
    r2: { message: { ...replyMessage("r2", "r", "m1"), createdAt: 20 }, state: "sending" },
    r1: { message: { ...replyMessage("r1", "r", "m1"), createdAt: 10 }, state: "sending" },
    other: { message: replyMessage("other", "r", "zzz"), state: "sending" },
  };
  assert.deepEqual(blockedRepliesTo("m1", entries).map((m) => m.id), ["r1", "r2"]);
});

test("已經 failed 的回覆不會被 ack 路徑偷偷重送（重試是使用者的決定）", () => {
  const entries: Record<string, OutboxEntry> = {
    m1: { message: message("m1", "r"), state: "acked" },
    r1: { message: replyMessage("r1", "r", "m1"), state: "failed" },
  };
  assert.deepEqual(blockedRepliesTo("m1", entries), []);
});

test("來源失敗時回覆一起算失敗 — 不得永遠停在假的「送出中」", () => {
  const entries: Record<string, OutboxEntry> = {
    m1: { message: message("m1", "r"), state: "failed" },
    r1: { message: replyMessage("r1", "r", "m1"), state: "sending" },
  };
  assert.equal(failedBlockingParentId(entries.r1.message, entries, new Set()), "m1");
});

test("來源只是還在飛（sending）不算失敗：那時候「送出中」是誠實的", () => {
  const entries: Record<string, OutboxEntry> = {
    m1: { message: message("m1", "r"), state: "sending" },
    r1: { message: replyMessage("r1", "r", "m1"), state: "sending" },
  };
  assert.equal(failedBlockingParentId(entries.r1.message, entries, new Set()), null);
});

test("別房訊息不屬於目前房，本房訊息算屬於", () => {
  const foreign = message("m1", "cloud_a");
  const local = message("m2", "cloud_b");
  assert.equal(belongsToCurrentRoom(foreign, { localRoomId: "cloud_b", boundRoomId: "cloud_b" }), false);
  assert.equal(belongsToCurrentRoom(local, { localRoomId: "cloud_b", boundRoomId: "cloud_b" }), true);
});

test("打開討論串或停在底部時跟著最新一則；往上讀舊訊息不硬拉", () => {
  assert.equal(shouldFollowLatest({ previousCount: 0, nextCount: 4, pinnedToLatest: true, nextLastId: "d" }), true);
  assert.equal(shouldFollowLatest({ previousCount: 3, nextCount: 4, pinnedToLatest: true, previousLastId: "c", nextLastId: "d" }), true);
  assert.equal(shouldFollowLatest({ previousCount: 3, nextCount: 4, pinnedToLatest: false, previousLastId: "c", nextLastId: "d" }), false);
  assert.equal(shouldFollowLatest({ previousCount: 3, nextCount: 3, pinnedToLatest: true, previousLastId: "c", nextLastId: "c" }), false);
});

test("來源失敗但其實已經在伺服器快照裡：不算擋路", () => {
  const entries: Record<string, OutboxEntry> = {
    m1: { message: message("m1", "r"), state: "failed" },
    r1: { message: replyMessage("r1", "r", "m1"), state: "sending" },
  };
  assert.equal(failedBlockingParentId(entries.r1.message, entries, new Set(["m1"])), null);
});
