import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FEATURE_FLAGS,
  answerFromContext,
  buildZenAgentRequest,
  classifyQuery,
  currentVersion,
  extractPlanDocument,
  isFeatureEnabled,
  optionalPhaseMap,
  parseTimestamp,
  rankPhotosForUse,
  retrieveRoomContext,
  understandImage,
  versionsForQuery,
} from "../../src/ai/index.ts";
import type { PlanDocument, Room, RoomBranch, Version } from "../../src/lib/types.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function version(id: string, label: string, kind: "image" | "video" = "image", branchId?: string): Version {
  return {
    id,
    label,
    kind,
    imageDataUrl: "data:image/png;base64,AA==",
    ...(branchId ? { branchId } : {}),
  };
}

function branch(id: string, name: string, branchType: RoomBranch["branchType"]): RoomBranch {
  return {
    id,
    roomId: "room-activity",
    name,
    branchType,
    sortOrder: 0,
    status: "in_progress",
    createdBy: "owner",
    createdAt: 1,
    updatedAt: 1,
  };
}

function stallPlan(): PlanDocument {
  return {
    branchId: "plan",
    title: "擺攤計畫",
    description: "迎新週中庭擺攤",
    blocks: [
      { id: "b1", kind: "checklist", text: "時間地點：週三中庭 12:00", checked: true },
      { id: "b2", kind: "checklist", text: "人員輪班表", checked: false },
      { id: "b3", kind: "checklist", text: "主視覺與文宣", checked: true },
      { id: "b4", kind: "paragraph", text: "攤位互動：品茶小卡" },
      { id: "b5", kind: "list", text: "報名 QR 放桌上" },
    ],
    updatedAt: 1,
  };
}

function activityRoom(): Room {
  const poster = branch("poster", "擺攤文宣", "poster");
  const tea = branch("tea", "茶會文宣", "poster");
  const scenic = branch("scenic", "校園風景", "poster");
  const video = branch("video", "招生影片", "video");
  const plan = branch("plan", "擺攤計畫", "plan");
  return {
    id: "room-activity",
    title: "迎新活動房",
    projectMode: true,
    versions: [
      version("draft", "初稿", "image", poster.id),
      version("v1", "改一", "image", poster.id),
      version("v2", "改二", "image", poster.id),
      version("tea-1", "茶會定稿", "image", tea.id),
      version("scenic-1", "IMG_3819.jpg", "image", scenic.id),
      version("cut-1", "二剪", "video", video.id),
    ],
    comments: [
      {
        id: "c-poster",
        versionId: "v2",
        authorId: "a",
        authorName: "A",
        authorColor: "#000",
        x: 0.2,
        y: 0.3,
        body: "主視覺是中庭擺攤，QR 報名放右下。",
        resolved: false,
        createdAt: 1,
      },
      {
        id: "c-draft",
        versionId: "draft",
        authorId: "a",
        authorName: "A",
        authorColor: "#000",
        x: 0.2,
        y: 0.3,
        body: "初稿還沒有 QR，只有社團名稱。",
        resolved: false,
        createdAt: 1,
      },
      {
        id: "c-video",
        versionId: "cut-1",
        authorId: "a",
        authorName: "A",
        authorColor: "#000",
        x: 0.4,
        y: 0.5,
        body: "學長示範如何掃 QR 報名茶會。",
        anchor: { kind: "range", startTime: 35, endTime: 48 },
        resolved: false,
        createdAt: 2,
      },
    ],
    strokes: [],
    messages: Array.from({ length: 20 }, (_, index) => ({
      id: `m${index}`,
      authorId: "a",
      authorName: "A",
      authorColor: "#000",
      body: `雜訊訊息 ${index}`,
      createdAt: index,
    })),
    updatedAt: 10,
    branches: [poster, tea, scenic, video, plan],
    plans: [stallPlan()],
    relations: [{
      id: "rel-1",
      roomId: "room-activity",
      fromBranchId: plan.id,
      toBranchId: poster.id,
      relationType: "related",
      createdBy: "owner",
      createdAt: 1,
    }],
  };
}

test("unfinished collaboration phases stay disabled and are not fake-implemented", () => {
  assert.equal(isFeatureEnabled("ai.assetIntelligence"), true);
  assert.equal(isFeatureEnabled("collaboration.whiteboard"), false);
  assert.equal(isFeatureEnabled("collaboration.voice"), false);
  assert.equal(isFeatureEnabled("canva.integration"), false);
  assert.deepEqual(optionalPhaseMap(), {
    "canva.integration": "DISABLED",
    "collaboration.voice": "DISABLED",
  });
  assert.equal(FEATURE_FLAGS["collaboration.discussion"], false);
});

test("source tree has no fake whiteboard or voice entry while flags are off", () => {
  const app = readFileSync(resolve(ROOT, "src/App.tsx"), "utf8");
  const multi = readFileSync(resolve(ROOT, "src/features/multi-room/MultiBranchRoom.tsx"), "utf8");
  const ui = `${app}\n${multi}`;
  assert.equal(/whiteboard|白板|collaboration\.voice|進語音/.test(ui), false);
});

test("AI defaults to 改二, not 初稿", () => {
  const room = activityRoom();
  const poster = room.versions.filter((item) => item.branchId === "poster");
  assert.equal(currentVersion(poster)?.label, "改二");
  assert.deepEqual(versionsForQuery(poster, "這張文宣在講什麼？").map((item) => item.label), ["改二"]);
  assert.deepEqual(versionsForQuery(poster, "比較初稿與改二").map((item) => item.label), ["初稿", "改二"]);
});

test("image understanding uses content, not IMG_3819.jpg", () => {
  const understood = understandImage({
    title: "茶會文宣",
    versionLabel: "定稿",
    comments: [{ body: "淡江禪學社春季茶會，3/21 報名。" }],
    analysis: {
      id: "a1",
      assetId: "tea",
      kind: "image",
      status: "ready",
      source: "structured",
      summary: "春季茶會文宣，強調報名日期與品茶體驗。",
      topics: ["茶會", "招生"],
    },
  });
  assert.match(understood.summary, /茶會/);
  assert.equal(understood.summary.includes("IMG_"), false);
  const ranked = rankPhotosForUse(
    [
      { id: "tea", title: "茶會文宣", topics: ["茶會", "招生"], summary: "春季茶會主視覺" },
      { id: "file", title: "IMG_3819.jpg", filename: "IMG_3819.jpg", topics: [], summary: "" },
      { id: "campus", title: "校園風景", topics: ["場景"], summary: "空景，沒有社團活動資訊" },
    ],
    "找適合做茶會宣傳的素材",
  );
  assert.equal(ranked[0].id, "tea");
  assert.equal(ranked.find((item) => item.id === "file")?.score, 0);
});

test("plan extraction reports missing follow-up", () => {
  const extracted = extractPlanDocument(stallPlan());
  assert.ok(extracted.topics.includes("擺攤"));
  assert.ok(extracted.missing.some((item) => item.id === "followup"));
  assert.equal(extracted.missing.some((item) => item.id === "signup"), false);
});

test("temporal query maps 00:40 to the QR signup segment", () => {
  assert.equal(parseTimestamp("這支影片 00:40 在講什麼？"), 40);
  const context = retrieveRoomContext({ room: activityRoom(), query: "這支影片 00:40 在講什麼？" });
  assert.equal(context.intent, "video_at_time");
  assert.equal(context.timeSeconds, 40);
  assert.equal(context.fullRoomDumped, false);
  const answer = answerFromContext("這支影片 00:40 在講什麼？", context);
  assert.match(answer, /QR|報名|茶會/);
});

test("Room Context answers the four phase-1 questions from retrieved slices", () => {
  const room = activityRoom();
  const poster = retrieveRoomContext({ room, query: "這張文宣在講什麼？" });
  assert.equal(poster.intent, "poster_summary");
  assert.equal(poster.currentVersionOnly, true);
  assert.match(answerFromContext("這張文宣在講什麼？", poster), /擺攤|QR/);
  assert.equal(poster.items.some((item) => item.versionLabel === "初稿"), false);

  const photos = retrieveRoomContext({ room, query: "這些照片哪張比較適合做茶會宣傳？" });
  assert.equal(photos.intent, "photo_fit");
  const photoAnswer = answerFromContext("這些照片哪張比較適合做茶會宣傳？", photos);
  assert.match(photoAnswer, /茶會/);
  assert.equal(/IMG_3819\.jpg\s*$/m.test(photoAnswer), false);

  const plan = retrieveRoomContext({ room, query: "這份擺攤計畫還缺什麼？" });
  assert.equal(plan.intent, "plan_gaps");
  assert.match(answerFromContext("這份擺攤計畫還缺什麼？", plan), /追蹤/);
});

test("tku-zen-agent payload is retrieved context, not a second agent or a whole-room dump", () => {
  const room = activityRoom();
  const context = retrieveRoomContext({ room, query: "這張文宣在講什麼？" });
  const payload = buildZenAgentRequest("這張文宣在講什麼？", context);
  assert.equal(payload.agent, "tku-zen-agent");
  assert.equal(payload.notASecondAgent, true);
  assert.equal(payload.roomContext.fullRoomDumped, false);
  assert.ok(payload.roomContext.items.length < room.messages.length);
  assert.equal(payload.roomContext.items.some((item) => item.body.includes("雜訊訊息")), false);
});

test("query classifier does not treat every question as dumping the room", () => {
  assert.equal(classifyQuery("這張文宣在講什麼？").intent, "poster_summary");
  assert.equal(classifyQuery("比較初稿與改二").intent, "version_compare");
  assert.equal(classifyQuery("這裡有哪些可以拿來做茶會宣傳的素材？").intent, "photo_fit");
});
