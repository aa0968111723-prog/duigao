/**
 * 0031 discussion tombstone + per-member unread watermark.
 * Positive / negative / permission / cross-room / mutation.
 * Run: tsx --test scripts/tests/discussion-tombstone-unread.test.ts
 */
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  canEditDiscussion,
  canTombstoneDiscussion,
  discussionTombstonePatch,
  firstUnreadMessageId,
  messageIsTombstoned,
  nextReadWatermark,
  unreadCount,
} from "../../src/features/collaboration/discussionHonesty";
import { discussionFromRow, type DiscussionRow } from "../../src/cloud/collaborationRepository";
import { applyDiscussionRealtime } from "../../src/cloud/realtimeApply";
import type { DiscussionMessage } from "../../src/features/collaboration/types";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");
const MIGRATION = "supabase/migrations/0031_discussion_tombstone_unread.sql";

function message(over: Partial<DiscussionMessage> = {}): DiscussionMessage {
  return {
    id: "m1",
    roomId: "r1",
    authorId: "u-a",
    authorName: "阿哲",
    authorColor: "#c45c4a",
    kind: "text",
    body: "先推茶會",
    payload: {},
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  };
}

function row(over: Partial<DiscussionRow> = {}): DiscussionRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    room_id: "22222222-2222-4222-8222-222222222222",
    author_user_id: "33333333-3333-4333-8333-333333333333",
    author_name: "阿哲",
    author_color: "#c45c4a",
    kind: "text",
    body: "先推茶會",
    payload: {},
    reply_to_id: null,
    created_at: "2026-08-29T00:00:00.000Z",
    updated_at: "2026-08-29T00:00:00.000Z",
    deleted_at: null,
    deleted_by: null,
    ...over,
  };
}

test("T-01: 0031 是下一個號碼，而且 gravestone + reads 都在", () => {
  assert.equal(existsSync(resolve(ROOT, MIGRATION)), true, "0031_discussion_tombstone_unread.sql must exist");
  assert.equal(existsSync(resolve(ROOT, "supabase/migrations/0032_discussion_mentions.sql")), false);
  assert.equal(existsSync(resolve(ROOT, "supabase/migrations/0032_discussion_receipts.sql")), false);
  const sql = src(MIGRATION);
  assert.match(sql, /alter table public\.room_discussion_messages[\s\S]{0,240}deleted_at/i);
  assert.match(sql, /deleted_by/i);
  assert.match(sql, /create table if not exists public\.room_discussion_reads/i);
  assert.match(sql, /last_read_message_id/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /force row level security/i);
  assert.match(sql, /grant select, insert, update on public\.room_discussion_reads to authenticated/i);
  assert.match(sql, /revoke delete on public\.room_discussion_messages from authenticated/i);
});

test("T-02: 政策名字、UPDATE 有 SELECT 語意、USING + WITH CHECK、沒有 user_metadata", () => {
  const sql = src(MIGRATION);
  for (const name of [
    "room_discussion_reads_select_own",
    "room_discussion_reads_insert_own",
    "room_discussion_reads_update_own",
    "room_discussion_update",
  ]) {
    assert.match(sql, new RegExp(`create policy ${name}`, "i"));
  }
  assert.match(sql, /room_discussion_reads_update_own[\s\S]+for update[\s\S]+using \([\s\S]+with check \(/i);
  assert.match(sql, /user_id = \(select auth\.uid\(\)\)/i);
  assert.match(sql, /public\.is_room_member\(room_id\)/i);
  assert.match(sql, /public\.can_manage_media\(room_id\)/i);
  assert.doesNotMatch(sql, /user_metadata/);
  assert.doesNotMatch(sql, /to authenticated;[\s\S]{0,40}create policy room_discussion_reads_update_own[\s\S]{0,80}for update to authenticated\s+using/i);
});

test("T-03: 0031 不加 mention / typing / todo / receipt，也不准已讀回條", () => {
  const sql = src(MIGRATION);
  assert.doesNotMatch(sql, /room_discussion_mentions/i);
  assert.doesNotMatch(sql, /room_discussion_receipts/i);
  assert.doesNotMatch(sql, /room_discussion_typing/i);
  assert.doesNotMatch(sql, /create table if not exists public\.room_todos/i);
  assert.doesNotMatch(sql, /雙藍勾|read receipt|(?<!未)已讀/i);
  const ui = src("src/features/room-discussion/RoomDiscussion.tsx");
  assert.doesNotMatch(ui, /雙藍勾|read receipt|(?<!未)已讀/i);
});

test("T-04 positive: 作者可以 tombstone；墓碑不是消失", () => {
  assert.equal(canTombstoneDiscussion(message(), "u-a", false), true);
  assert.equal(messageIsTombstoned(message()), false);
  assert.equal(messageIsTombstoned(message({ deletedAt: 9_000 })), true);
  assert.equal(canEditDiscussion(message({ deletedAt: 9_000 }), "u-a"), false);
  const patch = discussionTombstonePatch();
  assert.ok(patch.deleted_at);
  assert.equal("room_id" in patch, false, "tombstone patch must not move rooms");
  assert.equal("author_user_id" in patch, false);
  const ui = src("src/features/room-discussion/RoomDiscussion.tsx");
  assert.match(ui, /discussion-tombstone/);
  assert.match(ui, /這則討論已刪除|已刪除/);
  assert.match(ui, /messageIsTombstoned|deletedAt/);
});

test("T-05 negative / permission: 路人與檢視者不能刪別人的；已刪的不能再刪", () => {
  assert.equal(canTombstoneDiscussion(message(), "u-b", false), false);
  assert.equal(canTombstoneDiscussion(message(), "u-b", true), true);
  assert.equal(canTombstoneDiscussion(message({ deletedAt: 4_000 }), "u-a", true), false);
  assert.equal(canTombstoneDiscussion(message(), "u-a", false, "failed"), false);
  assert.equal(canTombstoneDiscussion(message(), "", false), false);
});

test("T-06 cross-room: 寫入路徑必須帶本房 room_id，不能改掛", () => {
  const repo = src("src/cloud/collaborationRepository.ts");
  assert.match(repo, /tombstoneDiscussion/);
  const fn = repo.slice(repo.indexOf("export async function tombstoneDiscussion"));
  const body = fn.slice(0, fn.indexOf("\nexport "));
  assert.match(body, /deleted_at/);
  assert.match(body, /\.eq\(["']id["']/);
  assert.match(body, /\.eq\(["']room_id["']/);
  assert.doesNotMatch(body, /room_id:\s*message\.roomId/);
});

test("T-07 unread: 水位之後的第一則；沒有已讀回條", () => {
  const a = message({ id: "a", createdAt: 10 });
  const b = message({ id: "b", createdAt: 20 });
  const c = message({ id: "c", createdAt: 30 });
  assert.equal(firstUnreadMessageId([a, b, c], null), "a");
  assert.equal(firstUnreadMessageId([a, b, c], { lastReadMessageId: "a" }), "b");
  assert.equal(firstUnreadMessageId([a, b, c], { lastReadMessageId: "c" }), null);
  assert.equal(firstUnreadMessageId([a, b, c], { lastReadAt: 20 }), "c");
  assert.equal(unreadCount([a, b, c], { lastReadMessageId: "a" }), 2);
  const held = nextReadWatermark({ roomId: "r1", lastReadMessageId: "b", lastReadAt: 20 }, a);
  assert.equal(held.lastReadMessageId, "b", "watermark must not move backwards");
  const ui = src("src/features/room-discussion/RoomDiscussion.tsx");
  assert.match(ui, /jump-first-unread/);
  assert.match(ui, /firstUnreadMessageId/);
  assert.match(ui, /shouldMarkLatestFromFeedEnd/, "T-07: 短 feed 滑到底不可把水位刷到最新");
  assert.match(ui, /holdingFirstUnreadRef/, "T-07: 跳到第一則未讀時要按住，不可立刻標最新已讀");
  assert.match(
    ui,
    /holdingFirstUnreadRef\.current = true/,
    "T-07: 跳到第一則未讀時不可維持 pinned-to-latest",
  );
  assert.doesNotMatch(ui, /雙藍勾|(?<!未)已讀/);
});

test("T-08 mutation: 拿掉 deleted_at 對應會讓契約失敗", () => {
  const sql = src(MIGRATION);
  const repo = src("src/cloud/collaborationRepository.ts");
  const ui = src("src/features/room-discussion/RoomDiscussion.tsx");
  const honesty = src("src/features/collaboration/discussionHonesty.ts");
  assert.match(sql, /deleted_at/);
  assert.match(repo, /deletedAt:\s*row\.deleted_at/);
  assert.match(honesty, /messageIsTombstoned/);
  assert.match(ui, /discussion-tombstone/);

  const strippedSql = sql.replace(/deleted_at/g, "removed_at");
  assert.doesNotMatch(strippedSql, /deleted_at/);
  assert.throws(() => {
    assert.match(strippedSql, /alter table public\.room_discussion_messages[\s\S]{0,240}deleted_at/i);
  });

  const fromRow = repo.match(/export function discussionFromRow[\s\S]*?\n\}/);
  assert.ok(fromRow, "discussionFromRow must exist");
  assert.match(fromRow[0], /deletedAt:\s*row\.deleted_at/);
  const strippedMapper = fromRow[0].replace(/deletedAt:\s*row\.deleted_at[^\n]*/, "");
  assert.notEqual(strippedMapper, fromRow[0]);
  assert.doesNotMatch(strippedMapper, /deletedAt:\s*row\.deleted_at/);
  const mapped = discussionFromRow(row({
    deleted_at: "2026-08-29T01:00:00.000Z",
    body: "不該再當正文",
  }));
  assert.ok(mapped);
  assert.equal(mapped!.deletedAt, Date.parse("2026-08-29T01:00:00.000Z"));
  assert.equal(messageIsTombstoned(mapped!), true);
});

test("T-09 realtime: tombstone 是 upsert，硬刪事件也要變成墓碑而不是消失", () => {
  const live = applyDiscussionRealtime([], { op: "upsert", message: message({ id: "m1", updatedAt: 10 }) });
  const tomb = applyDiscussionRealtime(live.messages, {
    op: "upsert",
    message: message({ id: "m1", updatedAt: 20, deletedAt: 20, body: "先推茶會" }),
  });
  assert.equal(tomb.applied, true);
  assert.equal(tomb.messages.length, 1);
  assert.equal(tomb.messages[0].deletedAt, 20);
  const vanished = applyDiscussionRealtime(live.messages, { op: "delete", id: "m1" });
  assert.equal(vanished.applied, true);
  assert.equal(vanished.messages.length, 1, "0031 must not silently drop the row");
  assert.ok(vanished.messages[0].deletedAt);
  const again = applyDiscussionRealtime(tomb.messages, { op: "delete", id: "m1" });
  assert.equal(again.applied, false);
  assert.equal(again.messages.length, 1);
});
