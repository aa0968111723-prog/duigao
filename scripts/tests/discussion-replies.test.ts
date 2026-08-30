import test from "node:test";
import assert from "node:assert/strict";
import { indexMessages, replySnippet, resolveReply, REPLY_SNIPPET_MAX } from "../../src/features/collaboration/replies.ts";
import { mergeDiscussionSnapshot } from "../../src/features/collaboration/offline.ts";
import type { DiscussionMessage } from "../../src/features/collaboration/types.ts";

function message(over: Partial<DiscussionMessage> & { id: string }): DiscussionMessage {
  return {
    roomId: "room-1",
    authorId: "u-a",
    authorName: "阿哲",
    authorColor: "#c45c4a",
    kind: "text",
    body: "",
    payload: {},
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

test("沒有 replyToId → 沒有引用", () => {
  const ref = resolveReply(message({ id: "m1" }), indexMessages([]));
  assert.equal(ref.state, "none");
});

test("回覆一般訊息：引用讀來源現值，帶得出作者與可跳轉的 sourceId", () => {
  const source = message({ id: "src", authorName: "小雨", authorColor: "#3355aa", body: "這週先推茶會那份" });
  const reply = message({ id: "m2", replyToId: "src", payload: { quotedBody: "這週先推茶會那份" } });
  const ref = resolveReply(reply, indexMessages([source, reply]));
  assert.equal(ref.state, "resolved");
  if (ref.state !== "resolved") return;
  assert.equal(ref.sourceId, "src");
  assert.equal(ref.authorName, "小雨");
  assert.equal(ref.authorColor, "#3355aa");
  assert.equal(ref.snippet, "這週先推茶會那份");
  assert.equal(ref.edited, false);
});

test("回覆已編輯訊息：引用顯示來源現值，不是送出當下的舊字", () => {
  // 送出時來源是「先推茶會」，之後作者改成「先推擺攤」。
  const source = message({ id: "src", body: "先推擺攤" });
  const reply = message({ id: "m3", replyToId: "src", payload: { quotedBody: "先推茶會" } });
  const ref = resolveReply(reply, indexMessages([source, reply]));
  assert.equal(ref.state, "resolved");
  if (ref.state !== "resolved") return;
  assert.equal(ref.snippet, "先推擺攤", "引用必須跟著來源走，否則畫面上兩句話對不起來");
  assert.equal(ref.edited, true, "來源改過要標示，讀的人才知道引用曾經長不一樣");
});

test("回覆附件：引用說得出那是什麼檔案，不是空白", () => {
  const source = message({
    id: "att",
    kind: "attachment",
    body: "brief.pdf",
    payload: { path: "rooms/r/attachments/att/x.pdf", mime: "application/pdf", name: "招生簡報.pdf" },
  });
  const reply = message({ id: "m4", replyToId: "att" });
  const ref = resolveReply(reply, indexMessages([source, reply]));
  assert.equal(ref.state, "resolved");
  if (ref.state !== "resolved") return;
  assert.equal(ref.snippet, "📎 招生簡報.pdf");
});

test("回覆連結卡與白板卡：各自讀得懂，不會退成空字串", () => {
  const link = message({ id: "l1", kind: "link", body: "https://example.com/a", payload: { href: "https://example.com/a", title: "example.com" } });
  const board = message({ id: "b1", kind: "node", body: "", payload: { title: "招生流程", whiteboardId: "wb", nodeId: "n" } });
  const index = indexMessages([link, board]);
  const linkRef = resolveReply(message({ id: "m5", replyToId: "l1" }), index);
  const boardRef = resolveReply(message({ id: "m6", replyToId: "b1" }), index);
  assert.equal(linkRef.state === "resolved" && linkRef.snippet, "🔗 example.com");
  assert.equal(boardRef.state === "resolved" && boardRef.snippet, "▦ 招生流程");
});

test("來源不在這份對話裡（被刪除／回覆先於來源到達）→ 誠實說 missing，快照只當快照", () => {
  const reply = message({ id: "m7", replyToId: "gone", payload: { quotedBody: "原本說了什麼" } });
  const ref = resolveReply(reply, indexMessages([reply]));
  assert.equal(ref.state, "missing");
  if (ref.state !== "missing") return;
  assert.equal(ref.sourceId, "gone");
  assert.equal(ref.snapshot, "原本說了什麼");
});

test("來源不在且當初沒留快照 → snapshot 是 null，不得憑空生一句話", () => {
  const ref = resolveReply(message({ id: "m8", replyToId: "gone" }), indexMessages([]));
  assert.equal(ref.state, "missing");
  assert.equal(ref.state === "missing" && ref.snapshot, null);
});

test("回覆先於來源到達，之後來源補進快照 → 同一則回覆自動變成 resolved", () => {
  const reply = message({ id: "m9", replyToId: "late", payload: { quotedBody: "先到的引用" } });
  const before = resolveReply(reply, indexMessages([reply]));
  assert.equal(before.state, "missing");
  const late = message({ id: "late", authorName: "小雨", body: "先到的引用" });
  const after = resolveReply(reply, indexMessages([reply, late]));
  assert.equal(after.state, "resolved");
  assert.equal(after.state === "resolved" && after.authorName, "小雨");
});

test("剛送出、還沒落地的回覆（outbox ghost 在索引裡）就能解析", () => {
  const ghost = message({ id: "ghost", body: "樂觀列" });
  const reply = message({ id: "m10", replyToId: "ghost" });
  assert.equal(resolveReply(reply, indexMessages([ghost, reply])).state, "resolved");
});

test("自我回覆是壞資料，不渲染成無限自指", () => {
  const self = message({ id: "m11", replyToId: "m11" });
  assert.equal(resolveReply(self, indexMessages([self])).state, "none");
});

test("引用摘要壓成一行並截斷，手機上不吃掉整張訊息卡", () => {
  const long = message({ id: "long", body: `${"招生".repeat(120)}` });
  const snippet = replySnippet(long);
  assert.ok(snippet.length <= REPLY_SNIPPET_MAX, `${snippet.length} > ${REPLY_SNIPPET_MAX}`);
  assert.ok(snippet.endsWith("…"));
  const multiline = replySnippet(message({ id: "nl", body: "第一行\n第二行\t第三行" }));
  assert.equal(multiline, "第一行 第二行 第三行");
});

test("完全沒有文字的來源不會產生空白引用", () => {
  assert.equal(replySnippet(message({ id: "empty", body: "   " })), "（沒有文字內容）");
});

// ---------------------------------------------------------------------------
// 快照合併：一次讀取失敗不得清空整條討論串（PR-COMM-00）
// ---------------------------------------------------------------------------

test("伺服器有回答：採用伺服器的討論，即使是空的（空就是真的空）", () => {
  const kept = mergeDiscussionSnapshot(
    { id: "room-1", discussion: [{ id: "m1" }] },
    { id: "room-1", discussion: [] },
  );
  assert.deepEqual(kept, []);
});

test("查詢失敗（快照沒帶討論）：保留畫面上已有的對話，不抹掉", () => {
  const kept = mergeDiscussionSnapshot(
    { id: "room-1", discussion: [{ id: "m1" }, { id: "m2" }] },
    { id: "room-1" },
  );
  assert.deepEqual(kept, [{ id: "m1" }, { id: "m2" }]);
});

test("查詢失敗且換了房：不得把上一間房的訊息畫進這一間", () => {
  const kept = mergeDiscussionSnapshot(
    { id: "room-A", discussion: [{ id: "a1" }] },
    { id: "room-B" },
  );
  assert.equal(kept, undefined);
});

test("第一次載入就失敗：沒有現況可保留，回 undefined 而不是假的空陣列", () => {
  assert.equal(mergeDiscussionSnapshot(null, { id: "room-1" }), undefined);
});

test("伺服器回答時一律採用，不會被同房的舊資料蓋回去", () => {
  const kept = mergeDiscussionSnapshot(
    { id: "room-1", discussion: [{ id: "old" }] },
    { id: "room-1", discussion: [{ id: "new" }] },
  );
  assert.deepEqual(kept, [{ id: "new" }]);
});

test("同 id 較新的本地 edit 不被過期快照蓋掉", () => {
  const local = { id: "m1", body: "先把招生流程攤在白板上（改過）", updatedAt: 200 };
  const stale = { id: "m1", body: "先把招生流程攤在白板上", updatedAt: 100 };
  const kept = mergeDiscussionSnapshot(
    { id: "room-1", discussion: [local] },
    { id: "room-1", discussion: [stale] },
  );
  assert.deepEqual(kept, [local]);
});

test("同 id 較新的伺服器列仍覆蓋本地", () => {
  const local = { id: "m1", body: "先打", updatedAt: 100 };
  const fresh = { id: "m1", body: "雲端已改", updatedAt: 200 };
  const kept = mergeDiscussionSnapshot(
    { id: "room-1", discussion: [local] },
    { id: "room-1", discussion: [fresh] },
  );
  assert.deepEqual(kept, [fresh]);
});
