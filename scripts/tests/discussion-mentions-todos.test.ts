/**
 * 0032 discussion @mentions + todo drafts (+ ephemeral typing, no receipt).
 * Positive / negative / permission / cross-room.
 * Run: tsx --test scripts/tests/discussion-mentions-todos.test.ts
 */
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  canCompleteRoomTodo,
  canCompleteTodo,
  canWriteTodo,
  filterMentionableMembers,
  highlightMentions,
  isMemberActor,
  parseMentionQuery,
  todoDraftTitle,
} from "../../src/features/collaboration/discussionHonesty";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");
const MIGRATION = "supabase/migrations/0032_discussion_mentions_todos.sql";

const members = [
  { userId: "u-a", name: "阿哲" },
  { userId: "u-b", name: "嘉怡" },
  { userId: "ai-bot", name: "AI" },
];

test("M-01: 0032 是下一個號碼，mention + todo 都在，沒有 0033 / receipt", () => {
  assert.equal(existsSync(resolve(ROOT, "supabase/migrations/0031_discussion_tombstone_unread.sql")), true);
  assert.equal(existsSync(resolve(ROOT, MIGRATION)), true);
  assert.equal(existsSync(resolve(ROOT, "supabase/migrations/0033_discussion_receipts.sql")), false);
  const sql = src(MIGRATION);
  assert.match(sql, /create table if not exists public\.room_discussion_mentions/i);
  assert.match(sql, /create table if not exists public\.room_todos/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /force row level security/i);
  assert.match(sql, /grant select, insert on public\.room_discussion_mentions to authenticated/i);
  assert.match(sql, /grant select, insert, update on public\.room_todos to authenticated/i);
  assert.doesNotMatch(sql, /room_discussion_receipts/i);
  assert.doesNotMatch(sql, /user_metadata/);
  assert.doesNotMatch(sql, /create table if not exists public\.room_discussion_typing/i);
});

test("M-02: 政策名字、UPDATE USING + WITH CHECK、作者才能寫提及", () => {
  const sql = src(MIGRATION);
  for (const name of [
    "room_discussion_mentions_select",
    "room_discussion_mentions_insert_author",
    "room_todos_select",
    "room_todos_insert_own",
    "room_todos_update_own",
  ]) {
    assert.match(sql, new RegExp(`create policy ${name}`, "i"));
  }
  assert.match(sql, /room_todos_update_own[\s\S]+for update[\s\S]+using \([\s\S]+with check \(/i);
  assert.match(sql, /mentioned_user_id/i);
  assert.match(sql, /author_user_id = \(select auth\.uid\(\)\)/i);
  assert.match(sql, /public\.is_room_member\(room_id\)/i);
});

test("M-03 positive: @ 從房內成員挑，不是第二條聊天", () => {
  assert.deepEqual(parseMentionQuery("先看 @嘉"), { prefix: "先看 ", query: "嘉" });
  assert.equal(parseMentionQuery("沒有圈人"), null);
  const hits = filterMentionableMembers(members, "嘉");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].userId, "u-b");
  assert.equal(filterMentionableMembers(members, "").some((item) => item.userId === "ai-bot"), false);
  const marked = highlightMentions("嘉怡看過了", ["嘉怡"]);
  assert.match(marked, /嘉怡/);
  const ui = src("src/features/room-discussion/RoomDiscussion.tsx");
  assert.match(ui, /mention-picker|discussion-mention/);
  assert.doesNotMatch(ui, /第二條聊天|second chat/i);
});

test("M-04 negative / permission: 不能提及房外的人；AI 不能當成員寫待辦", () => {
  assert.deepEqual(filterMentionableMembers(members, "路人"), []);
  assert.equal(canWriteTodo("u-a"), true);
  assert.equal(canWriteTodo("ai"), false);
  assert.equal(canWriteTodo("agent-gpt"), false);
  assert.equal(canWriteTodo("system"), false);
  assert.equal(canCompleteTodo("u-b"), true);
  assert.equal(canCompleteTodo("ai-bot"), false);
  assert.equal(canCompleteRoomTodo({ createdBy: "u-a" }, "u-a", false), true);
  assert.equal(canCompleteRoomTodo({ createdBy: "u-a" }, "u-b", false), false);
  assert.equal(canCompleteRoomTodo({ createdBy: "u-a" }, "u-b", true), true);
  assert.equal(canCompleteRoomTodo({ createdBy: "u-a" }, "ai", true), false);
  assert.equal(isMemberActor("model-x"), false);
  assert.equal(todoDraftTitle("  印海報  "), "印海報");
  assert.equal(todoDraftTitle("   "), null);
});

test("M-05 cross-room: 寫入路徑帶本房 room_id，提及必須是成員", () => {
  const repo = src("src/cloud/collaborationRepository.ts");
  assert.match(repo, /insertDiscussionMentions|insertMentions/);
  const sql = src(MIGRATION);
  assert.match(sql, /discussion-mention-not-member|只能提及這間房的成員/);
  assert.match(sql, /todo-room-immutable|不能把待辦搬到別的房間/);
  const mentionFn = repo.includes("export async function insertDiscussionMentions")
    ? repo.slice(repo.indexOf("export async function insertDiscussionMentions"))
    : repo.slice(repo.indexOf("insertDiscussionMentions"));
  assert.match(mentionFn.slice(0, 800), /room_id/);
  assert.match(mentionFn.slice(0, 800), /mentioned_user_id|mentionedUserId/);
});

test("M-06: typing 走既有 presence，不建表；不准已讀回條", () => {
  const sync = src("src/cloud/roomSync.ts");
  assert.match(sync, /typing/);
  assert.doesNotMatch(src(MIGRATION), /create table if not exists public\.room_discussion_typing/i);
  const ui = src("src/features/room-discussion/RoomDiscussion.tsx");
  assert.match(ui, /discussion-typing|正在輸入/);
  assert.doesNotMatch(ui, /雙藍勾|(?<!未)已讀|read receipt/i);
  assert.match(ui, /discussion-todo|todo-draft/);
});

test("M-07 mutation: 拿掉 mentions / isMemberActor 結案會讓契約失敗", () => {
  const sql = src(MIGRATION);
  const honesty = src("src/features/collaboration/discussionHonesty.ts");
  const ui = src("src/features/room-discussion/RoomDiscussion.tsx");
  assert.match(sql, /room_discussion_mentions/);
  assert.match(sql, /room_todos/);
  assert.match(honesty, /canCompleteTodo/);
  assert.match(honesty, /filterMentionableMembers/);
  assert.match(ui, /canCompleteRoomTodo|canCompleteTodo|isMemberActor/);
  const stripped = honesty.replace(/export function canCompleteTodo[\s\S]*?\n\}/, "export function canCompleteTodo() { return true; }");
  assert.notEqual(stripped, honesty);
  assert.equal(canCompleteTodo("ai"), false);
});

test("M-08 adversarial: 跨房提及、提及不可改、todo 非作者／非成員不能結案、無 0033", () => {
  const sql = src(MIGRATION);
  const e2e = src("scripts/e2e/migrations.mjs");
  assert.match(sql, /discussion-mention-update-forbidden|提及只能新增，不能改/);
  assert.match(sql, /new\.deleted_by := caller/);
  assert.doesNotMatch(sql, /new\.deleted_by := coalesce\(new\.deleted_by, caller\)/);
  assert.match(e2e, /不能在這房提及只屬於另一房的人/);
  assert.match(e2e, /檢視者不能完成別人的待辦/);
  assert.match(e2e, /非成員不能把別房待辦標完成/);
  assert.match(e2e, /不能改別人的未讀水位/);
  assert.match(src("src/features/room-discussion/RoomDiscussion.tsx"), /canCompleteRoomTodo/);
  assert.doesNotMatch(src("src/features/room-discussion/RoomDiscussion.tsx"), /canCompleteTodo\(api\.userId\)/);
  assert.equal(existsSync(resolve(ROOT, "supabase/migrations/0033_discussion_receipts.sql")), false);
  assert.doesNotMatch(src("src/features/room-discussion/RoomDiscussion.tsx"), /雙藍勾|(?<!未)已讀|read receipt/i);
});
