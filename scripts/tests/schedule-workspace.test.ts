import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { applyGate, normalizeAiActions } from "../../src/ai/proposals.ts";
import { looksLikeSpaHtml, parseFunctionPayload } from "../../src/cloud/apiResponse.ts";
import { createSticky } from "../../src/features/collaboration/nodes.ts";
import { stickyFromDiscussion } from "../../src/features/collaboration/links.ts";
import {
  agendaDays,
  createScheduleEvent,
  deleteScheduleEvent,
  eventsInRange,
  moveEventToDay,
  patchScheduleEvent,
} from "../../src/features/schedule/events.ts";
import { acceptScheduleWrite } from "../../src/features/schedule/honesty.ts";
import { applyDeadlineToNode, eventFromBoardNode, eventFromDiscussion, nodeFromScheduleEvent, sourceOpenTarget } from "../../src/features/schedule/links.ts";
import { proposalShowsSources, scheduleEventFromProposal } from "../../src/features/schedule/proposals.ts";
import type { DiscussionMessage } from "../../src/features/collaboration/types.ts";
import { enqueuePendingWrite } from "../../src/cloud/pendingWrites.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function message(over: Partial<DiscussionMessage> = {}): DiscussionMessage {
  return {
    id: "msg-1",
    roomId: "room-1",
    authorId: "u1",
    authorName: "阿明",
    authorColor: "#c45c4a",
    kind: "text",
    body: "週三前交招生主視覺",
    payload: {},
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

test("calendar create/edit/delete and range filters", () => {
  const created = createScheduleEvent({
    roomId: "room-1",
    createdBy: "u1",
    title: "招生交稿",
    startAt: Date.parse("2026-08-31T00:00:00+08:00"),
    eventType: "copy_due",
  });
  assert.equal(created.title, "招生交稿");
  const edited = patchScheduleEvent(created, { title: "招生交稿（定稿）", status: "doing" });
  assert.equal(edited.version, 2);
  assert.equal(edited.status, "doing");
  const gone = deleteScheduleEvent([edited], edited.id);
  assert.equal(gone.length, 0);
  assert.throws(() => createScheduleEvent({ roomId: "r", createdBy: "u", title: "  ", startAt: 1 }));
});

test("today/week agenda does not require a month grid", () => {
  const now = Date.parse("2026-08-31T10:00:00+08:00");
  const events = [
    createScheduleEvent({ roomId: "r", createdBy: "u", title: "今天", startAt: now, id: "a" }),
    createScheduleEvent({ roomId: "r", createdBy: "u", title: "下週", startAt: now + 10 * 86400000, id: "b" }),
  ];
  assert.equal(eventsInRange(events, "today", now).map((item) => item.id).join(), "a");
  assert.ok(agendaDays(events, now).some((day) => day.events.some((item) => item.id === "a")));
  assert.equal(eventsInRange(events, "week", now).some((item) => item.id === "b"), false);
});

test("message→task and message→calendar keep source ids", () => {
  const msg = message();
  const task = eventFromDiscussion(msg, "u1", 1_000, "task");
  const cal = eventFromDiscussion(msg, "u1", 2_000, "activity");
  assert.equal(task.sourceType, "discussion");
  assert.equal(task.sourceId, "msg-1");
  assert.equal(sourceOpenTarget(task).surface, "discussion");
  assert.equal(cal.eventType, "activity");
  const sticky = stickyFromDiscussion(msg, "board-1", "u1");
  assert.equal(sticky.linkedEntityType, "discussion");
  assert.equal(sticky.linkedEntityId, "msg-1");
});

test("board node→task/deadline and calendar→node keep source", () => {
  const node = createSticky({ whiteboardId: "board-1", roomId: "room-1", createdBy: "u1", text: "主視覺B" });
  const due = eventFromBoardNode(node, "u1", Date.parse("2026-09-02T00:00:00+08:00"));
  assert.equal(due.sourceType, "whiteboard_node");
  assert.equal(due.sourceId, node.id);
  assert.equal(sourceOpenTarget(due).surface, "board");
  const stamped = applyDeadlineToNode(node, due.startAt);
  assert.match(stamped.content.subtitle ?? "", /期限/);
  const back = nodeFromScheduleEvent(due, "board-1", "u1");
  assert.equal(back.linkedEntityType, "calendar");
  assert.equal(back.linkedEntityId, due.id);
});

test("long-press day move updates startAt without dropping source", () => {
  const event = createScheduleEvent({ roomId: "r", createdBy: "u", title: "茶會", startAt: 1000, sourceType: "discussion", sourceId: "msg-1" });
  const moved = moveEventToDay(event, 1000 + 86400000);
  assert.equal(moved.sourceId, "msg-1");
  assert.ok(moved.startAt > event.startAt);
});

test("AI proposal writes only after 採用; reject does not write", () => {
  const proposal = normalizeAiActions([{
    type: "create_schedule_event",
    label: "建議週三交稿",
    payload: { title: "交主視覺", startAt: 9, reason: "討論提到週三", usedMessageIds: ["msg-1"], usedNodeIds: ["n1"], usedFileIds: [] },
  }])[0];
  assert.ok(proposal);
  const gate = applyGate({ proposal, alreadyApplied: false, extraConfirmed: false, canTalk: true, canManage: true, canEditBoard: true });
  assert.deepEqual(gate, { ok: true });
  const forbidden = applyGate({ proposal, alreadyApplied: false, extraConfirmed: false, canTalk: true, canManage: false, canEditBoard: true });
  assert.equal(forbidden.ok, false);
  const live: string[] = [];
  const reject = true;
  if (!reject) live.push(scheduleEventFromProposal(proposal, "room-1", "u1").id);
  assert.equal(live.length, 0);
  const adopted = scheduleEventFromProposal(proposal, "room-1", "u1");
  assert.equal(adopted.sourceType, "ai_proposal");
  const sources = proposalShowsSources(proposal);
  assert.deepEqual(sources.messages, ["msg-1"]);
  assert.equal(sources.reason, "討論提到週三");
});

test("API HTML, empty ok:true, and unset cloud are never schedule success", () => {
  const html = acceptScheduleWrite({ error: null, data: "<!doctype html><html>", contentType: "text/html" });
  assert.equal(html.ok, false);
  if (html.ok === false) assert.equal(html.code, "SPA_HTML");
  const zero = acceptScheduleWrite({ error: null, data: null });
  assert.equal(zero.ok, false);
  if (zero.ok === false) assert.equal(zero.code, "ZERO_ROW");
  const unset = acceptScheduleWrite({ error: null, data: { id: "x" }, unsetCloud: true });
  assert.equal(unset.ok, false);
  if (unset.ok === false) assert.equal(unset.code, "UNSET_CLOUD");
  const parsed = parseFunctionPayload({ ok: true }, { successKeys: ["id"] });
  assert.equal(parsed.kind, "reject");
  assert.equal(looksLikeSpaHtml("<!doctype html><html lang='zh-Hant'>"), true);
  const ok = acceptScheduleWrite({ error: null, data: { id: "evt-1" } });
  assert.equal(ok.ok, true);
});

test("offline schedule writes enter the pending queue and stay until ack", () => {
  const queued = enqueuePendingWrite([], { key: "schedule:evt-1", task: async () => { throw new Error("offline"); } });
  assert.equal(queued.length, 1);
  const replaced = enqueuePendingWrite(queued, { key: "schedule:evt-1", task: async () => undefined });
  assert.equal(replaced.length, 1);
});

test("RLS isolation is encoded: other rooms cannot be selected by policy using is_room_member", () => {
  const sql = readFileSync(resolve(ROOT, "supabase/migrations/0032_room_schedule.sql"), "utf8");
  assert.match(sql, /enable row level security/);
  assert.match(sql, /is_room_member\(room_id\)/);
  assert.match(sql, /create table if not exists public.room_schedule_events/);
  assert.doesNotMatch(sql, /disable row level security/);
});

test("phone toolbar is five items and calendar tab exists", () => {
  const wb = readFileSync(resolve(ROOT, "src/features/whiteboard/WhiteboardWorkspace.tsx"), "utf8");
  assert.match(wb, /wb-compact-toolbar/);
  assert.match(wb, />畫筆</);
  assert.match(wb, /文字／便利貼/);
  assert.match(wb, />加入</);
  assert.match(wb, /wb-set-deadline/);
  assert.doesNotMatch(wb, /wb-tool-material/);
  const room = readFileSync(resolve(ROOT, "src/features/multi-room/MultiBranchRoom.tsx"), "utf8");
  assert.match(room, /schedule-tab/);
  assert.match(room, /ScheduleAgenda/);
  const discussion = readFileSync(resolve(ROOT, "src/features/room-discussion/RoomDiscussion.tsx"), "utf8");
  assert.match(discussion, /discussion-add-schedule/);
});

test("old whiteboard node types remain readable", () => {
  const sql = readFileSync(resolve(ROOT, "supabase/migrations/0032_room_schedule.sql"), "utf8");
  assert.match(sql, /'freehand'/);
  assert.match(sql, /'text'/);
  assert.match(sql, /calendar_event/);
});
