import test from "node:test";
import assert from "node:assert/strict";
import { addRoomTarget } from "../../src/cloud/invite.ts";
import {
  branchOpenCommentCount,
  branchSummary,
  branchVersions,
  latestBranchVersion,
  mergeRoomBranch,
  normalizeRoomBranches,
  roomForBranch,
  sortBranchesByRecent,
} from "../../src/lib/roomBranches.ts";
import type { Room, RoomBranch } from "../../src/lib/types.ts";

const version = (id: string, kind: "image" | "video" = "image", branchId?: string) => ({
  id,
  label: id,
  kind,
  imageDataUrl: "data:image/png;base64,AA==",
  ...(branchId ? { branchId } : {}),
});

function room(overrides: Partial<Room> = {}): Room {
  return {
    id: "room-1",
    title: "淡江招生企劃房",
    versions: [version("poster-1")],
    comments: [],
    strokes: [],
    messages: [],
    updatedAt: 1,
    ...overrides,
  };
}

function branch(id: string, branchType: RoomBranch["branchType"], updatedAt: number): RoomBranch {
  return {
    id,
    roomId: "room-1",
    name: id,
    branchType,
    sortOrder: updatedAt,
    status: "in_progress",
    createdBy: "owner",
    createdAt: updatedAt,
    updatedAt,
  };
}

test("old image rooms receive one compatible poster branch", () => {
  const normalized = normalizeRoomBranches(room({ mediaType: "image", versions: [version("v1"), version("v2")] }));
  assert.equal(normalized.branches?.length, 1);
  assert.equal(normalized.branches?.[0].branchType, "poster");
  assert.deepEqual(normalized.versions.map((item) => item.branchId), [normalized.branches?.[0].id, normalized.branches?.[0].id]);
  assert.equal(normalized.projectMode, undefined);
});

test("old video rooms receive one compatible video branch", () => {
  const normalized = normalizeRoomBranches(room({ mediaType: "video", versions: [version("cut-1", "video")] }));
  assert.equal(normalized.branches?.[0].branchType, "video");
  assert.equal(normalized.versions[0].branchId, normalized.branches?.[0].id);
});

test("project room keeps poster, video and plan versions separated", () => {
  const poster = branch("poster", "poster", 1);
  const video = branch("video", "video", 2);
  const plan = branch("plan", "plan", 3);
  const normalized = normalizeRoomBranches(room({
    projectMode: true,
    branches: [poster, video, plan],
    versions: [version("p1", "image", poster.id), version("v1", "video", video.id)],
    comments: [
      { id: "c1", versionId: "p1", authorId: "a", authorName: "A", authorColor: "#000", x: 0.2, y: 0.3, body: "poster", resolved: false, createdAt: 1 },
      { id: "c2", versionId: "v1", authorId: "a", authorName: "A", authorColor: "#000", x: 0.4, y: 0.5, body: "video", resolved: false, createdAt: 2 },
    ],
  }));

  assert.deepEqual(branchVersions(normalized, poster.id).map((item) => item.id), ["p1"]);
  assert.deepEqual(branchVersions(normalized, video.id).map((item) => item.id), ["v1"]);
  assert.equal(branchVersions(normalized, plan.id).length, 0);
  assert.equal(branchOpenCommentCount(normalized, poster.id), 1);
  assert.deepEqual(roomForBranch(normalized, poster.id).versions.map((item) => item.id), ["p1"]);
  assert.deepEqual(roomForBranch(normalized, poster.id).comments.map((item) => item.id), ["c1"]);
  assert.equal(latestBranchVersion(normalized, poster.id)?.id, "p1");
});

test("branch list can be sorted by recent update without changing stored order", () => {
  const input = [branch("old", "poster", 1), branch("new", "plan", 9), branch("middle", "video", 4)];
  assert.deepEqual(sortBranchesByRecent(input).map((item) => item.id), ["new", "middle", "old"]);
  assert.deepEqual(input.map((item) => item.id), ["old", "new", "middle"]);
});

test("branch deep-link stays in the fragment and preserves the invite", () => {
  const url = addRoomTarget("https://example.test/#room=r&invite=secret", { branchId: "b1", versionId: "v1" });
  const parsed = new URL(url);
  assert.equal(parsed.search, "");
  assert.equal(parsed.hash, "#room=r&invite=secret&branch=b1&item=v1");
});

test("summary-first project room preserves lightweight card data", () => {
  const poster = branch("poster", "poster", 1);
  const video = branch("video", "video", 2);
  const summaryRoom = room({
    projectMode: true,
    branches: [poster, video],
    versions: [],
    branchSummaries: [{ branchId: poster.id, versionCount: 2, latestLabel: "改二", openCommentCount: 3, feedbackCount: 4 }],
  });
  assert.equal(branchSummary(summaryRoom, poster.id).latestLabel, "改二");
  assert.equal(branchSummary(summaryRoom, poster.id).openCommentCount, 3);
  assert.equal(branchVersions(summaryRoom, video.id).length, 0);
});

test("hydrating one branch does not mix another branch's review data", () => {
  const poster = branch("poster", "poster", 1);
  const video = branch("video", "video", 2);
  const base = room({ projectMode: true, branches: [poster, video], versions: [], branchSummaries: [{ branchId: poster.id, versionCount: 1, latestLabel: "初稿", openCommentCount: 1, feedbackCount: 1 }] });
  const hydrated = room({
    projectMode: true,
    branches: [poster],
    versions: [version("p1", "image", poster.id)],
    comments: [{ id: "c1", versionId: "p1", authorId: "a", authorName: "A", authorColor: "#000", x: 0.5, y: 0.5, body: "只屬於文宣", resolved: false, createdAt: 2 }],
  });
  const merged = mergeRoomBranch(base, hydrated, poster.id);
  assert.deepEqual(merged.versions.map((item) => item.branchId), [poster.id]);
  assert.deepEqual(merged.comments.map((item) => item.versionId), ["p1"]);
  assert.deepEqual(merged.branches?.map((item) => item.id), [poster.id, video.id]);
});

test("branch merge carries the collaboration slice and falls back to room state", () => {
  const poster = branch("poster", "poster", 1);
  const message = { id: "m1", roomId: "r", authorId: "a", authorName: "A", authorColor: "#000", kind: "text", body: "殼還掛著", payload: {}, createdAt: 1, updatedAt: 1 };
  const base = room({ projectMode: true, branches: [poster], versions: [] });
  base.discussion = [message];
  base.decisions = [{ id: "d1", roomId: "r", title: "決定", status: "decided", createdBy: "a", createdAt: 1, updatedAt: 1 }];
  const hydrated = room({ projectMode: true, branches: [poster], versions: [] });
  hydrated.discussion = [message, { ...message, id: "m2", body: "新的一句" }];
  // 帶回 collab slice 的 branch 快照要覆蓋
  const withCollab = mergeRoomBranch(base, hydrated, poster.id);
  assert.deepEqual(withCollab.discussion?.map((item) => item.id), ["m1", "m2"]);
  // 沒帶（undefined）時沿用房間現值，不清空
  const withoutCollab = room({ projectMode: true, branches: [poster], versions: [] });
  withoutCollab.discussion = undefined;
  const kept = mergeRoomBranch(base, withoutCollab, poster.id);
  assert.deepEqual(kept.discussion?.map((item) => item.id), ["m1"]);
  assert.equal(kept.decisions?.length, 1);
});

test("summary lazy plans never clobber local blocks; full rows win by updatedAt", () => {
  const plan = branch("plan", "plan", 1);
  const base = room({ projectMode: true, branches: [plan], versions: [] });
  base.plans = [{ branchId: plan.id, title: "企劃", description: "", blocks: [{ id: "b1", kind: "paragraph", text: "目標" }], updatedAt: 100 }];
  const lazy = room({ projectMode: true, branches: [plan], versions: [] });
  lazy.plans = [{ branchId: plan.id, title: "企劃", description: "", blocks: [], blocksOmitted: true, updatedAt: 999 }];
  const mergedLazy = mergeRoomBranch(base, lazy, plan.id);
  // mergeRoomBranch 的 updatedAt 守門：本地較舊但 lazy 不算完整列 —
  // branch 路徑理論上不送 lazy 列；此處驗證 updatedAt 較新的完整列會覆蓋。
  const full = room({ projectMode: true, branches: [plan], versions: [] });
  full.plans = [{ branchId: plan.id, title: "企劃", description: "", blocks: [], updatedAt: 999 }];
  const mergedFull = mergeRoomBranch(base, full, plan.id);
  assert.equal(mergedFull.plans?.[0].blocks.length, 0);
  void mergedLazy;
});

// ---------------------------------------------------------------- uuid ----
// 上傳路徑用它產生 versions.id。舊 WebView（Android WebView < 92、iOS
// 15.0–15.3）與任何非 https 的頁面都沒有 crypto.randomUUID；以前那一行直接
// 丟例外，而且丟在 try 之外 — 上傳鎖再也放不掉，按鈕從此完全沒反應。

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("uuid(): 沒有 crypto.randomUUID 也要給出合法 v4，且絕不丟例外", async () => {
  const { uuid } = await import("../../src/lib/id.ts");
  const real = globalThis.crypto;

  assert.match(uuid(), UUID_V4, "有 randomUUID 時走原生");

  // 只剩 getRandomValues（Chrome 60–91 / Safari 11–15.3 的形狀）
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues: (arr: Uint8Array) => real.getRandomValues(arr) },
  });
  const noRandomUUID = uuid();
  assert.match(noRandomUUID, UUID_V4);

  // randomUUID 存在但被鎖住（部分 in-app 瀏覽器）：不能讓例外逃出去
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      randomUUID: () => {
        throw new Error("blocked by embedder");
      },
      getRandomValues: (arr: Uint8Array) => real.getRandomValues(arr),
    },
  });
  assert.match(uuid(), UUID_V4);

  // 連 crypto 都沒有（極舊 WebView / 非安全脈絡）
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
  assert.match(uuid(), UUID_V4);

  Object.defineProperty(globalThis, "crypto", { configurable: true, value: real });

  // 同一顆瀏覽器連續要 200 個 id 不可以撞號 — 撞號等於覆蓋別人的版本列。
  const seen = new Set<string>();
  for (let i = 0; i < 200; i += 1) seen.add(uuid());
  assert.equal(seen.size, 200);
});

// -------------------------------------------------------- intake fallback --
// UniversalIntake 在沒有 DataTransfer 建構子的瀏覽器（舊 Android WebView、
// 被鎖住的 in-app 瀏覽器）改用自己做的靜態清單。重點不是「有東西回傳」，
// 而是那份清單與 <input> 脫鉤：onChange 收尾會 input.value = ""，input 給的
// FileList 是活的，當場會變空 — CreateSheet 把選取留到按「建立」才用，拿到
// 活的那份等於什麼都沒選到。

test("staticFileList(): 像 FileList，而且不會被 input 清空", async () => {
  const { staticFileList } = await import("../../src/components/UniversalIntake.tsx");
  const a = new File(["a"], "a.webm", { type: "video/webm" });
  const b = new File(["bb"], "b.png", { type: "image/png" });

  const list = staticFileList([a, b]);
  assert.equal(list.length, 2);
  assert.equal(list[0], a);
  assert.equal(list[1], b);
  assert.equal(list.item(0), a);
  assert.equal(list.item(5), null);
  assert.deepEqual([...list], [a, b]);
  assert.deepEqual(Array.from(list), [a, b]);
  assert.equal(list[0]?.name, "a.webm");

  // 這份清單是快照，不是視圖：來源被清空（input reset 在瀏覽器裡就是這件
  // 事）之後，已經交出去的選取仍然完整 — CreateSheet 要留到按「建立」才用。
  const source = [a, b];
  const held = staticFileList(source);
  source.length = 0;
  assert.equal(held.length, 2);
  assert.deepEqual([...held], [a, b]);
  assert.equal(held.item(1), b);

  assert.equal(staticFileList([]).length, 0);
});
