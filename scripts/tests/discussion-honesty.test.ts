/**
 * Discussion extras already typed by 0014/0018/0022.
 * Run: tsx --test scripts/tests/discussion-honesty.test.ts
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  attachmentCiteReply,
  boardDecisionWrite,
  boardPollWrite,
  canEditDiscussion,
  decisionDraftTitle,
  discussionEditPatch,
  isMemberActor,
  messageIsEdited,
  workCiteFromBoard,
  workCiteFromBranch,
} from "../../src/features/collaboration/discussionHonesty";
import { normalizeAiActions } from "../../src/ai/proposals";
import type { DiscussionMessage } from "../../src/features/collaboration/types";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

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

test("D-01: updated_at 明顯晚於 created_at 才標已編輯", () => {
  assert.equal(messageIsEdited(message()), false);
  assert.equal(messageIsEdited(message({ updatedAt: 1_200 })), false);
  assert.equal(messageIsEdited(message({ updatedAt: 4_000 })), true);
  assert.equal(messageIsEdited(message({ payload: { edited: true } })), true);
});

test("D-02: 只有作者能改自己的文字；legacy／附件／failed 不行", () => {
  assert.equal(canEditDiscussion(message(), "u-a"), true);
  assert.equal(canEditDiscussion(message(), "u-b"), false);
  assert.equal(canEditDiscussion(message({ kind: "attachment" }), "u-a"), false);
  assert.equal(canEditDiscussion(message({ payload: { legacy: true } }), "u-a"), false);
  assert.equal(canEditDiscussion(message(), "u-a", "failed"), false);
  assert.deepEqual(discussionEditPatch("  先推擺攤  "), { body: "先推擺攤" });
  assert.equal(discussionEditPatch("   "), null);
});

test("D-03: AI / agent 不得當成員確認決策", () => {
  assert.equal(isMemberActor("u-a"), true);
  assert.equal(isMemberActor("ai"), false);
  assert.equal(isMemberActor("agent-gpt"), false);
  assert.equal(isMemberActor("system"), false);
  assert.equal(isMemberActor(""), false);
  const dropped = normalizeAiActions([
    { type: "finalize_decision", label: "已決定", payload: { id: "d1" } },
    { type: "create_decision", label: "待決定", payload: { title: "主視覺" } },
    { type: "create_comment", label: "留一句", payload: { body: "看過了" } },
  ]);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].type, "create_comment");
});

test("D-04: 待決定草稿要有標題；空字不是決策", () => {
  assert.equal(decisionDraftTitle("  主視覺採 B  "), "主視覺採 B");
  assert.equal(decisionDraftTitle("   "), null);
});

test("D-05: 工作引用用既有 kind／payload，不發明表", () => {
  const poster = workCiteFromBranch({ id: "b1", name: "擺攤文宣", branchType: "poster" });
  assert.equal(poster?.kind, "poster");
  assert.equal(poster?.payload.branchId, "b1");
  assert.equal(workCiteFromBranch({ id: "c1", name: "文案", branchType: "copy" }), null);
  const board = workCiteFromBoard({ id: "wb1", title: "招生規劃" });
  assert.equal(board.kind, "whiteboard");
  assert.equal(board.payload.whiteboardId, "wb1");
});

test("D-06: 附件引用走 reply_to_id，不是假的已讀", () => {
  const cite = attachmentCiteReply(message({
    id: "att1",
    kind: "attachment",
    body: "brief.pdf",
    payload: { path: "rooms/r/attachments/att1/x.pdf", mime: "application/pdf", name: "招生簡報.pdf" },
  }));
  assert.equal(cite?.replyToId, "att1");
  assert.match(cite?.quotedBody ?? "", /招生簡報/);
  assert.equal(attachmentCiteReply(message({ kind: "text" })), null);
});

test("D-07: 未建模的提及／未讀／回條／tombstone 不得假裝存在", () => {
  const ws = src("src/features/room-discussion/RoomDiscussion.tsx");
  assert.doesNotMatch(ws, /雙藍勾|read receipt|(?<!未)已讀/i);
  assert.match(ws, /onEditMessage|discussion-edit|已編輯/);
  assert.match(ws, /composer-cite-work|cite-work/);
  assert.match(ws, /decision-draft/);
  assert.match(ws, /decision-draft-open/);
  assert.doesNotMatch(ws, /待決定：主視覺/);
  const sql = [
    src("supabase/migrations/0014_collaboration_workspace.sql"),
    src("supabase/migrations/0018_discussion_attachments.sql"),
    src("supabase/migrations/0022_discussion_author_integrity.sql"),
  ].join("\n");
  assert.doesNotMatch(sql, /create table if not exists public\.room_discussion_mentions/i);
  assert.doesNotMatch(sql, /create table if not exists public\.room_discussion_receipts/i);
  assert.doesNotMatch(sql, /create table if not exists public\.room_discussion_reads/i);
  assert.doesNotMatch(sql, /alter table public\.room_discussion_messages[\s\S]{0,200}deleted_at/i);
  assert.doesNotMatch(sql, /create table if not exists public\.room_todos/i);
});

test("D-08: 白板寫下決策要人填標題，不能用罐頭採用 B 版", () => {
  assert.equal(boardDecisionWrite(""), null);
  assert.equal(boardDecisionWrite("   "), null);
  assert.deepEqual(boardDecisionWrite("  採用 B 版  "), { title: "採用 B 版", status: "decided" });
  assert.equal(isMemberActor("ai"), false);
  const wb = src("src/features/whiteboard/WhiteboardWorkspace.tsx");
  assert.doesNotMatch(wb, /onCreateDecision\("已決定：採用 B 版"/);
  assert.match(wb, /wb-decision-title/);
  assert.match(wb, /wb-write-decision-save/);
  assert.match(wb, /boardDecisionWrite|decisionDraftTitle/);
});

test("D-09: 白板＋投票要人填題目與至少兩個選項，不能用罐頭主視覺", () => {
  assert.equal(boardPollWrite("", ["贊成", "再想想"]), null);
  assert.equal(boardPollWrite("   ", ["贊成", "再想想"]), null);
  assert.equal(boardPollWrite("主視覺要不要換？", ["贊成"]), null);
  assert.deepEqual(boardPollWrite("  主視覺要不要換？  ", [" 要，換成 B 版 ", "先維持 A 版"]), {
    question: "主視覺要不要換？",
    options: ["要，換成 B 版", "先維持 A 版"],
  });
  assert.equal(isMemberActor("system"), false);
  const wb = src("src/features/whiteboard/WhiteboardWorkspace.tsx");
  assert.doesNotMatch(wb, /onCreatePoll\("主視覺要不要換？"/);
  assert.match(wb, /wb-poll-question/);
  assert.match(wb, /wb-create-poll-save/);
  assert.match(wb, /boardPollWrite/);
});

test("D-10: 討論建立投票要人填題目，空正文不是投票", () => {
  assert.equal(boardPollWrite("", ["贊成", "再想想"]), null);
  assert.equal(isMemberActor("ai"), false);
  const ws = src("src/features/room-discussion/RoomDiscussion.tsx");
  assert.doesNotMatch(ws, /要不要這樣做？/);
  assert.doesNotMatch(ws, /message\.body\s*\|\|/);
  assert.match(ws, /discussion-create-poll/);
  assert.match(ws, /discussion-poll-question/);
  assert.match(ws, /discussion-create-poll-save/);
  assert.match(ws, /boardPollWrite/);
});
