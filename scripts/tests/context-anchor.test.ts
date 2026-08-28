/**
 * ContextAnchor 契約層 round-trip（PR-02d）。
 *
 * fixture 原則：意見列 fixture 抄真實 DB 列形狀（0003/0006 之後的欄位、
 * 以及 0006 之前的 legacy 列 — 沒有 anchor_type）；寫側輸出逐欄比對
 * roomRepository.anchorColumns 的歷史輸出形狀，證明委派是行為中立的。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  anchorFromComment,
  anchorFromCommentColumns,
  anchorFromDiscussion,
  anchorFromNode,
  anchorToCommentColumns,
  anchorToDiscussionPayload,
  anchorToNodeLink,
  entityAnchor,
  openTarget,
} from "../../src/lib/contextAnchor";

// ---- 機制 1：意見列 -------------------------------------------------------

test("意見列：video-range 列 → 錨 → 欄位，逐欄還原", () => {
  const row = {
    anchor_type: "video-range",
    time_seconds: 3.4,
    end_time_seconds: 7.25,
    region: null,
    x: 0.5,
    y: 0.5,
    version_id: "v1",
  };
  const anchor = anchorFromCommentColumns(row);
  assert.deepEqual(anchor, { type: "video-range", startTime: 3.4, endTime: 7.25, versionId: "v1" });
  assert.deepEqual(anchorToCommentColumns(anchor as never), {
    anchor_type: "video-range",
    time_seconds: 3.4,
    end_time_seconds: 7.25,
  });
});

test("意見列：range 缺可用終點 → 讀成 point（最接近真話的讀法）", () => {
  const anchor = anchorFromCommentColumns({
    anchor_type: "video-range",
    time_seconds: 12,
    end_time_seconds: null, // 存在但沒有可用終點的列
  });
  assert.deepEqual(anchor, { type: "video-point", time: 12, versionId: undefined });
});

test("意見列：宣稱 video 但時間不可用 → 退回 image 語意，不產 NaN", () => {
  const anchor = anchorFromCommentColumns({
    anchor_type: "video-point",
    time_seconds: Number.NaN,
    x: 0.3,
    y: 0.7,
  });
  assert.deepEqual(anchor, { type: "image-point", x: 0.3, y: 0.7, versionId: undefined });
});

test("意見列：0006 之前的 legacy 列（無 anchor_type）從 region 推回", () => {
  // 有圈選的 legacy 列
  const regionRow = {
    region: { x: 0.1, y: 0.2, width: 0.3, height: 0.25 },
    x: 0.25,
    y: 0.325,
  };
  const withRegion = anchorFromCommentColumns(regionRow);
  assert.deepEqual(withRegion, {
    type: "image-region",
    region: { x: 0.1, y: 0.2, width: 0.3, height: 0.25 },
    versionId: undefined,
  });
  // 沒圈選的 legacy 列
  const point = anchorFromCommentColumns({ region: null, x: 0.4, y: 0.6 });
  assert.deepEqual(point, { type: "image-point", x: 0.4, y: 0.6, versionId: undefined });
});

test("意見列：壞 region（負寬）修不回 → 落回 point，與 normalizeRegion 同規則", () => {
  const anchor = anchorFromCommentColumns({
    region: { x: 0.1, y: 0.1, width: -1, height: 0.2 },
    x: 0.1,
    y: 0.1,
  });
  assert.deepEqual(anchor, { type: "image-point", x: 0.1, y: 0.1, versionId: undefined });
});

test("意見 pin 寫側：四種形狀的欄位輸出 = anchorColumns 歷史形狀", () => {
  // video range pin
  assert.deepEqual(
    anchorToCommentColumns(anchorFromComment({ x: 0, y: 0, anchor: { kind: "range", startTime: 1, endTime: 2 } })),
    { anchor_type: "video-range", time_seconds: 1, end_time_seconds: 2 },
  );
  // video point pin
  assert.deepEqual(
    anchorToCommentColumns(anchorFromComment({ x: 0, y: 0, anchor: { kind: "point", time: 5 } })),
    { anchor_type: "video-point", time_seconds: 5, end_time_seconds: null },
  );
  // image region pin
  assert.deepEqual(
    anchorToCommentColumns(
      anchorFromComment({ x: 0.5, y: 0.5, region: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }),
    ),
    { anchor_type: "image-region", time_seconds: null, end_time_seconds: null },
  );
  // image point pin
  assert.deepEqual(anchorToCommentColumns(anchorFromComment({ x: 0.5, y: 0.5 })), {
    anchor_type: "image-point",
    time_seconds: null,
    end_time_seconds: null,
  });
});

// ---- 機制 2：白板節點 -----------------------------------------------------

test("節點：entity link 完整 round-trip", () => {
  const anchor = anchorFromNode({
    id: "n1",
    whiteboardId: "b1",
    linkedEntityType: "poll",
    linkedEntityId: "p1",
    content: {},
  });
  assert.deepEqual(anchor, { type: "entity", entityType: "poll", entityId: "p1" });
  assert.deepEqual(anchorToNodeLink(anchor), { linkedEntityType: "poll", linkedEntityId: "p1" });
});

test("節點：version link＋content 時間 → video 錨（versionId 是真實事實）", () => {
  const anchor = anchorFromNode({
    id: "n1",
    whiteboardId: "b1",
    linkedEntityType: "version",
    linkedEntityId: "v9",
    content: { startTime: 3, endTime: 8 },
  });
  assert.deepEqual(anchor, { type: "video-range", startTime: 3, endTime: 8, versionId: "v9" });
  const link = anchorToNodeLink(anchor);
  assert.deepEqual(link, {
    linkedEntityType: "version",
    linkedEntityId: "v9",
    content: { startTime: 3, endTime: 8 },
  });
});

test("節點：version link 無時間 → entity 臂（不捏造時間）", () => {
  const anchor = anchorFromNode({
    id: "n1",
    whiteboardId: "b1",
    linkedEntityType: "version",
    linkedEntityId: "v9",
    content: {},
  });
  assert.deepEqual(anchor, { type: "entity", entityType: "version", entityId: "v9" });
});

test("節點：無 link → board-node 臂；寫回 node link 為空（節點即錨）", () => {
  const anchor = anchorFromNode({ id: "n1", whiteboardId: "b1", content: {} });
  assert.deepEqual(anchor, { type: "board-node", whiteboardId: "b1", nodeId: "n1" });
  assert.deepEqual(anchorToNodeLink(anchor), {});
});

test("entityAnchor：封閉詞彙；type 或 id 缺一即 null（不產半截 link）", () => {
  assert.deepEqual(entityAnchor("poll", "p1"), { type: "entity", entityType: "poll", entityId: "p1" });
  assert.equal(entityAnchor("poll", ""), null);
  assert.equal(entityAnchor("room", "x"), null); // 不在 LINKED_ENTITY_TYPES
  assert.equal(entityAnchor("", "x"), null);
});

// ---- 機制 3：討論 payload -------------------------------------------------

test("討論：板參照 round-trip（含 links.ts discussionPayloadFromNode 的形狀）", () => {
  const anchor = anchorFromDiscussion({ whiteboardId: "b1", nodeId: "n1" });
  assert.deepEqual(anchor, { type: "board-node", whiteboardId: "b1", nodeId: "n1" });
  assert.deepEqual(anchorToDiscussionPayload(anchor!), { whiteboardId: "b1", nodeId: "n1" });
  // 無 nodeId 的板卡
  assert.deepEqual(anchorToDiscussionPayload({ type: "board-node", whiteboardId: "b1" }), { whiteboardId: "b1" });
});

test("討論：branch＋startTime → video 錨；openTarget 帶 startTime 回 content", () => {
  const anchor = anchorFromDiscussion({ branchId: "br1", startTime: 4.5 });
  assert.deepEqual(anchor, { type: "video-point", time: 4.5, branchId: "br1" });
  assert.deepEqual(openTarget(anchor), { surface: "content", branchId: "br1", startTime: 4.5 });
  assert.deepEqual(anchorToDiscussionPayload(anchor!), { branchId: "br1", startTime: 4.5 });
});

test("討論：branch 無時間 → entity branch；poll/decision/version 各歸各臂", () => {
  assert.deepEqual(anchorFromDiscussion({ branchId: "br1" }), {
    type: "entity",
    entityType: "branch",
    entityId: "br1",
  });
  assert.deepEqual(anchorFromDiscussion({ pollId: "p1" }), { type: "entity", entityType: "poll", entityId: "p1" });
  assert.deepEqual(anchorFromDiscussion({ decisionId: "d1" }), {
    type: "entity",
    entityType: "decision",
    entityId: "d1",
  });
  assert.deepEqual(anchorFromDiscussion({ versionId: "v1" }), {
    type: "entity",
    entityType: "version",
    entityId: "v1",
  });
});

test("討論：純文字/附件卡沒有錨 → null → openTarget none", () => {
  assert.equal(anchorFromDiscussion({}), null);
  assert.equal(anchorFromDiscussion({ path: "rooms/r/attachments/a.png", mime: "image/png" }), null);
  assert.deepEqual(openTarget(null), { surface: "none" });
});

test("討論：優先序 — 板參照勝過 branch（同時存在時）", () => {
  const anchor = anchorFromDiscussion({ whiteboardId: "b1", nodeId: "n1", branchId: "br1" });
  assert.deepEqual(anchor, { type: "board-node", whiteboardId: "b1", nodeId: "n1" });
});

// ---- 導航契約 -------------------------------------------------------------

test("openTarget：board / entity-branch / entity-其他 / 無 branch 的 video", () => {
  assert.deepEqual(openTarget({ type: "board-node", whiteboardId: "b1", nodeId: "n1" }), {
    surface: "board",
    whiteboardId: "b1",
    nodeId: "n1",
  });
  assert.deepEqual(openTarget({ type: "entity", entityType: "branch", entityId: "br1" }), {
    surface: "content",
    branchId: "br1",
  });
  assert.deepEqual(openTarget({ type: "entity", entityType: "poll", entityId: "p1" }), {
    surface: "entity",
    entityType: "poll",
    entityId: "p1",
  });
  // 只有 versionId、沒有 branch 的 video 錨：目前沒有導航面 → none（誠實）
  assert.deepEqual(openTarget({ type: "video-point", time: 3, versionId: "v1" }), { surface: "none" });
  // image 臂：導航不是它的事（意見 pin 由檢視器自己捲動）→ none
  assert.deepEqual(openTarget({ type: "image-point", x: 0.5, y: 0.5 }), { surface: "none" });
});

test("openTarget：video-range 開在起點（range 的導航語意=從頭播這一段）", () => {
  assert.deepEqual(openTarget({ type: "video-range", startTime: 3, endTime: 9, branchId: "br1" }), {
    surface: "content",
    branchId: "br1",
    startTime: 3,
  });
});

test("節點：branch link＋content 時間（placeBranch 影片段落上板）→ video 錨帶 branchId", () => {
  const anchor = anchorFromNode({
    id: "n1",
    whiteboardId: "b1",
    linkedEntityType: "branch",
    linkedEntityId: "br7",
    content: { startTime: 12, endTime: 30 },
  });
  assert.deepEqual(anchor, { type: "video-range", startTime: 12, endTime: 30, branchId: "br7" });
  // 導航：帶 startTime 開 content — 板上「打開內容」按鈕的既有語意
  assert.deepEqual(openTarget(anchor), { surface: "content", branchId: "br7", startTime: 12 });
  // 寫回節點 link：branch 優先、時間進 content
  assert.deepEqual(anchorToNodeLink(anchor), {
    linkedEntityType: "branch",
    linkedEntityId: "br7",
    content: { startTime: 12, endTime: 30 },
  });
});

test("節點：branch link 無時間 → entity branch（不捏造時間）", () => {
  const anchor = anchorFromNode({
    id: "n1",
    whiteboardId: "b1",
    linkedEntityType: "branch",
    linkedEntityId: "br7",
    content: {},
  });
  assert.deepEqual(anchor, { type: "entity", entityType: "branch", entityId: "br7" });
});

test("anchorToNodeLink：video 臂同時有 branch 與 version → branch 優先（單一 link 位）", () => {
  assert.deepEqual(anchorToNodeLink({ type: "video-point", time: 3, branchId: "br1", versionId: "v1" }), {
    linkedEntityType: "branch",
    linkedEntityId: "br1",
    content: { startTime: 3 },
  });
});

// ---- Grok 02d F2：邊界 fixture 補齊 ---------------------------------------

test("意見列：time_seconds=0 是合法時刻（影片開頭），不是 falsy 壞值", () => {
  assert.deepEqual(anchorFromCommentColumns({ anchor_type: "video-point", time_seconds: 0 }), {
    type: "video-point",
    time: 0,
    versionId: undefined,
  });
});

test("意見列：end == start 的 range 讀成 point（零長度段落不是段落）", () => {
  assert.deepEqual(anchorFromCommentColumns({ anchor_type: "video-range", time_seconds: 5, end_time_seconds: 5 }), {
    type: "video-point",
    time: 5,
    versionId: undefined,
  });
});

test("意見列：anchor_type 大小寫敏感 — 'VIDEO-RANGE' 不是 video（與舊 codec 同義）", () => {
  // 大寫列不可能由本程式寫出；讀到就是外來髒資料，與 anchorFromRow 一樣
  // 不認，退回 image 語意。
  assert.deepEqual(
    anchorFromCommentColumns({ anchor_type: "VIDEO-RANGE", time_seconds: 3, end_time_seconds: 9, x: 0.2, y: 0.4 }),
    { type: "image-point", x: 0.2, y: 0.4, versionId: undefined },
  );
});

test("意見列：region 是 JSON 字串（未解析）→ normalizeRegion 不認 → point", () => {
  assert.deepEqual(
    anchorFromCommentColumns({ region: '{"x":0.1,"y":0.1,"width":0.2,"height":0.2}', x: 0.6, y: 0.9 }),
    { type: "image-point", x: 0.6, y: 0.9, versionId: undefined },
  );
});

// ---- WB01：message 與 plan-section 臂 --------------------------------------

test("message 臂：payload round-trip＋node link 用 'discussion' 詞彙＋openTarget", () => {
  const anchor = { type: "message", messageId: "m-1" } as const;
  const payload = anchorToDiscussionPayload(anchor);
  assert.deepEqual(payload, { messageId: "m-1" });
  assert.deepEqual(anchorFromDiscussion(payload), anchor);
  // provenance 缺口的契約半邊：全庫第一個 'discussion' link 生產路徑
  assert.deepEqual(anchorToNodeLink(anchor), { linkedEntityType: "discussion", linkedEntityId: "m-1" });
  assert.deepEqual(openTarget(anchor), { surface: "discussion", messageId: "m-1" });
});

test("plan-section 臂：round-trip、node link 到 plan、openTarget 到 content", () => {
  const anchor = { type: "plan-section", branchId: "br-1", sectionId: "s-2" } as const;
  const payload = anchorToDiscussionPayload(anchor);
  assert.deepEqual(payload, { branchId: "br-1", planSectionId: "s-2" });
  assert.deepEqual(anchorFromDiscussion(payload), anchor);
  assert.deepEqual(anchorToNodeLink(anchor), { linkedEntityType: "plan", linkedEntityId: "br-1" });
  assert.deepEqual(openTarget(anchor), { surface: "content", branchId: "br-1" });
  // 無 sectionId 的退化：payload 只剩 branchId → 讀回是 entity branch（不
  // 捏造 plan-section）— 退化方向永遠往「較少宣稱」走
  const bare = anchorToDiscussionPayload({ type: "plan-section", branchId: "br-1" });
  assert.deepEqual(bare, { branchId: "br-1" });
  assert.deepEqual(anchorFromDiscussion(bare), { type: "entity", entityType: "branch", entityId: "br-1" });
});

test("messageId 優先權：payload 同時有 messageId 與 branchId 時讀成 message 臂", () => {
  assert.deepEqual(
    anchorFromDiscussion({ messageId: "m-9", branchId: "br-1" }),
    { type: "message", messageId: "m-9" },
  );
});

