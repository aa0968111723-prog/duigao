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
  scheduleCloudWrite,
  schedulePersistVersion,
  stampPersistedScheduleEvent,
  weekStart,
} from "../../src/features/schedule/events.ts";
import { acceptScheduleWrite, decideScheduleWriteRetry } from "../../src/features/schedule/honesty.ts";
import { applyDeadlineToNode, eventFromBoardNode, eventFromDiscussion, nodeFromScheduleEvent, sourceOpenTarget } from "../../src/features/schedule/links.ts";
import { decideScheduleProposalWrite, proposalShowsSources } from "../../src/features/schedule/proposals.ts";
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
  assert.equal(edited.version, 1);
  assert.equal(edited.status, "doing");
  assert.equal(stampPersistedScheduleEvent(edited, 2).version, 2);
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

test("weekStart uses Taipei weekday so Monday week starts Monday", () => {
  const monday = Date.parse("2026-08-31T10:00:00+08:00");
  const sunday = Date.parse("2026-09-06T23:00:00+08:00");
  const expected = Date.parse("2026-08-31T00:00:00+08:00");
  assert.equal(weekStart(monday), expected);
  assert.equal(weekStart(sunday), expected);
  const days = agendaDays([], monday);
  assert.equal(days[0]?.dayStart, expected);
  assert.notEqual(days[0]?.dayStart, Date.parse("2026-08-25T00:00:00+08:00"));
});

test("schedule OCC table: insert / content-ack / stale / update eq last-acked version", () => {
  const created = createScheduleEvent({ roomId: "r", createdBy: "u", title: "交稿", startAt: 1 });
  const patched = patchScheduleEvent(created, { title: "交稿定稿" });
  assert.equal(patched.version, 1);
  assert.deepEqual(scheduleCloudWrite(patched, null), { kind: "insert" });

  const acked = stampPersistedScheduleEvent(created, 1);
  const clientA = patchScheduleEvent(acked, { title: "A的標題" });
  const clientB = patchScheduleEvent(acked, { title: "B的標題" });
  assert.equal(clientA.version, 1);
  assert.equal(clientB.version, 1);
  const afterA = stampPersistedScheduleEvent(clientA, 2);
  assert.equal(afterA.version, 2);
  // Different payload against server v2 while B still holds acked v1: conflict, not ack.
  assert.deepEqual(scheduleCloudWrite(clientB, afterA), { kind: "stale-write" });
  assert.notEqual(scheduleCloudWrite(clientB, afterA).kind, "ack");

  assert.deepEqual(scheduleCloudWrite(clientA, clientA), { kind: "ack" });
  const coalesced = patchScheduleEvent(patchScheduleEvent(acked, { title: "一次" }), { title: "兩次" });
  assert.equal(coalesced.version, 1);
  const plan = scheduleCloudWrite(coalesced, acked);
  assert.deepEqual(plan, { kind: "update", expectedVersion: 1 });
  assert.equal(schedulePersistVersion(coalesced, plan), 2);
});

test("schedule stale-write is dropped, not requeued like a network failure", () => {
  assert.equal(decideScheduleWriteRetry("conflict").queueMemory, false);
  assert.equal(decideScheduleWriteRetry("duplicate").queueMemory, false);
  assert.equal(decideScheduleWriteRetry("success").queueMemory, false);
  assert.equal(decideScheduleWriteRetry("failed").queueMemory, true);
  const cloud = readFileSync(resolve(ROOT, "src/cloud/useCloudRoom.ts"), "utf8");
  assert.match(cloud, /scheduleLatest/);
  const upsert = cloud.slice(cloud.indexOf("upsertScheduleEvent: (event)"));
  assert.match(upsert, /writeAck/);
  assert.match(upsert, /scheduleReload/);
  assert.equal(/run\(`schedule:\$\{event\.id\}`/.test(upsert), false);
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
  const ctx = {
    proposal,
    alreadyApplied: false,
    extraConfirmed: false,
    canTalk: true,
    canManage: true,
    canEditBoard: true,
    roomId: "room-1",
    createdBy: "u1",
  };
  const rejected = decideScheduleProposalWrite({ ...ctx, action: "reject" });
  assert.equal(rejected.wrote, null);
  assert.equal(rejected.reason, "rejected");
  const forbidden = decideScheduleProposalWrite({ ...ctx, action: "adopt", canManage: false });
  assert.equal(forbidden.wrote, null);
  assert.equal(forbidden.reason, "forbidden");
  const already = decideScheduleProposalWrite({ ...ctx, action: "adopt", alreadyApplied: true });
  assert.equal(already.wrote, null);
  const adopted = decideScheduleProposalWrite({ ...ctx, action: "adopt" });
  assert.ok(adopted.wrote);
  assert.equal(adopted.wrote?.sourceType, "ai_proposal");
  assert.equal(adopted.wrote?.title, "交主視覺");
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

test("phone toolbar keeps four planning actions and schedule stays behind 更多", () => {
  const wb = readFileSync(resolve(ROOT, "src/features/whiteboard/WhiteboardWorkspace.tsx"), "utf8");
  assert.match(wb, /wb-compact-toolbar/);
  assert.match(wb, />寫下</);
  assert.match(wb, /這張板要怎麼開始/);
  assert.match(wb, /寫下一步驟/);
  assert.match(wb, /釘上文宣/);
  assert.match(wb, /先點起點，再點終點/);
  assert.match(wb, />加入</);
  assert.match(wb, /wb-set-deadline/);
  assert.match(wb, /wb-deadline-form/);
  assert.doesNotMatch(wb, /wb-tool-material/);
  const room = readFileSync(resolve(ROOT, "src/features/multi-room/MultiBranchRoom.tsx"), "utf8");
  assert.doesNotMatch(room, /schedule-tab/);
  assert.match(room, /open-schedule-pane/);
  assert.match(room, /ScheduleAgenda/);
  assert.match(room, /schedule-split/);
  assert.match(room, /setDiscussPane\("chat"\)/);
  assert.match(room, /setDiscussPane\("board"\)/);
  assert.match(room, /onOpenScheduleSource/);
  const openSource = room.slice(room.indexOf("onOpenSource: (event)"));
  const earlyReturn = /onOpenScheduleSource\?\.?\(event\);\s*return;/.test(openSource);
  assert.equal(earlyReturn, false);
  const discussion = readFileSync(resolve(ROOT, "src/features/room-discussion/RoomDiscussion.tsx"), "utf8");
  assert.match(discussion, /discussion-add-schedule/);
  const agenda = readFileSync(resolve(ROOT, "src/features/schedule/ScheduleAgenda.tsx"), "utf8");
  assert.match(agenda, /schedule-edit-form/);
  assert.match(agenda, /schedule-delete/);
  assert.match(agenda, /schedule-type/);
  assert.match(agenda, /text\/schedule-event/);
  assert.match(agenda, /對話＋日曆/);
  assert.match(agenda, /白板＋日曆/);
  const app = readFileSync(resolve(ROOT, "src/App.tsx"), "utf8");
  assert.match(app, /applyDeadlineToNode/);
  assert.match(app, /decideScheduleProposalWrite/);
  assert.match(app, /action: "reject"/);
  const repo = readFileSync(resolve(ROOT, "src/cloud/collaborationRepository.ts"), "utf8");
  assert.match(repo, /scheduleCloudWrite/);
  assert.match(repo, /select\("\*"\)/);
  assert.match(repo, /schedulePersistVersion/);
  assert.match(repo, /\.eq\("version", plan\.expectedVersion\)/);
  assert.match(repo, /stale-write/);
  const sheet = readFileSync(resolve(ROOT, "src/features/asset-intelligence/RoomAiSheet.tsx"), "utf8");
  assert.match(sheet, /proposalShowsSources/);
  assert.match(sheet, /ai-proposal-sources/);
});

test("old whiteboard node types remain readable", () => {
  const sql = readFileSync(resolve(ROOT, "supabase/migrations/0032_room_schedule.sql"), "utf8");
  assert.match(sql, /'freehand'/);
  assert.match(sql, /'text'/);
  assert.match(sql, /calendar_event/);
});
