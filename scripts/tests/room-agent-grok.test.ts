/**
 * Grok room-agent contract: one card, whitelist tools, honest spend, no secrets.
 * Drives src/ai/roomAgentContract.ts — the functions the edge/UI call.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseFunctionPayload } from "../../src/cloud/apiResponse.ts";
import {
  AGENT_UNCONFIGURED_COPY,
  DEFAULT_GROK_TEXT_MODEL,
  IMAGINE_NOT_VERSION_COPY,
  ROOM_AGENT_FORBIDDEN_TOOLS,
  applyMustNotChangeVersionStorage,
  buildRoomAgentCard,
  dispatchRoomAgentTool,
  grokChatRequestBody,
  grokRequestEnablesSearch,
  grokTextModel,
  parseGrokProviderPayload,
  roomAgentCardLeaks,
  roomAgentHealth,
  type RoomAgentCard,
} from "../../src/ai/roomAgentContract.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function dirtyInput() {
  return {
    room: { id: "11111111-1111-4111-8111-111111111111", title: "招生房", role: "owner" },
    contents: [
      { branchId: "b-poster", type: "poster", name: "擺攤文宣", latestVersionLabel: "改二", openCommentCount: 2 },
      { branchId: "b-plan", type: "plan", name: "招生企劃", latestVersionLabel: "初稿", openCommentCount: 0 },
    ],
    focus: {
      branchId: "b-poster",
      versionId: "v-2",
      label: "擺攤文宣 · 改二",
      width: 1080,
      height: 1350,
      thumbnailPath: "rooms/11111111-1111-4111-8111-111111111111/versions/v-2/poster.png",
      signedUrl: "https://example.supabase.co/storage/v1/object/sign/room-assets/tmp?token=short",
      invite: "secret-invite",
      inviteHash: "deadbeef",
    },
    comments: [
      { id: "c1", versionId: "v-2", body: "右上日期改成 5/20", region: "右上日期", resolved: false },
      { id: "c2", versionId: "v-2", body: "舊討論原文應該被截掉", resolved: false },
      { id: "c3", versionId: "v-1", body: "已解決", resolved: true },
    ],
    discussion: "很長的舊討論 ".repeat(40),
    workLayer: {
      proposalId: "p1",
      status: "draft",
      items: [
        { id: "i1", type: "text", role: "title", text: "五月茶會", x: 12, y: 20, imageDataUrl: "data:image/png;base64,QQ==" },
      ],
    },
  };
}

function card(): RoomAgentCard {
  return buildRoomAgentCard(dirtyInput());
}

test("RoomContext card keeps focus + open comments and drops old discussion / secrets", () => {
  const built = card();
  assert.equal(built.room.title, "招生房");
  assert.equal(built.room.role, "owner");
  assert.equal(built.contents[0].branchId, "b-poster");
  assert.equal(built.contents[0].type, "poster");
  assert.equal(built.focus?.versionId, "v-2");
  assert.equal(built.focus?.thumbnail?.kind, "signed-url");
  assert.equal(built.comments.some((item) => item.id === "c1"), true);
  assert.equal(built.comments.some((item) => item.id === "c3"), false);
  assert.equal(built.truncated, true);
  assert.equal("discussion" in built, false);
  assert.equal(built.workLayer?.items[0] && "imageDataUrl" in built.workLayer.items[0], false);
  assert.deepEqual(roomAgentCardLeaks(built), []);
  const raw = JSON.stringify(built);
  assert.doesNotMatch(raw, /invite/);
  assert.doesNotMatch(raw, /service_role/);
  assert.doesNotMatch(raw, /data:image/);
  assert.doesNotMatch(raw, /rooms\/11111111-1111-4111-8111-111111111111\/versions/);
  assert.match(built.comments[0].regionSummary ?? "", /右上日期/);
});

test("unset grok/tku key yields 尚未設定 and never a flagship default", () => {
  const grok = roomAgentHealth({ provider: "grok-room-agent" });
  assert.equal(grok.configured, false);
  assert.match(grok.copy ?? "", /尚未設定/);
  assert.equal(grok.copy, AGENT_UNCONFIGURED_COPY);
  const tku = roomAgentHealth({ provider: "tku-zen-agent" });
  assert.equal(tku.configured, false);
  assert.match(tku.copy ?? "", /尚未設定/);
  assert.equal(grokTextModel({ GROK_TEXT_MODEL: "grok-4.6" }), DEFAULT_GROK_TEXT_MODEL);
  assert.equal(grokTextModel({ GROK_TEXT_MODEL: "grok-4-5" }), DEFAULT_GROK_TEXT_MODEL);
  assert.match(DEFAULT_GROK_TEXT_MODEL, /grok-4-1-fast/);
  const sheet = readFileSync(resolve(ROOT, "src/features/asset-intelligence/RoomAiSheet.tsx"), "utf8");
  assert.match(sheet, /AGENT_UNCONFIGURED_COPY/);
  assert.match(sheet, /room-ai-unconfigured/);
});

test("overwrite_version and other forbidden tools are refused and recorded", () => {
  const ctx = { card: card() };
  for (const tool of ROOM_AGENT_FORBIDDEN_TOOLS) {
    const result = dispatchRoomAgentTool(tool, {}, ctx);
    assert.equal(result.ok, false, tool);
    assert.equal(result.refused, true, tool);
    assert.equal(result.recorded, true, tool);
  }
});

test("imagine_video without confirm is refused; confirmed still respects spend cap", () => {
  const ctx = { card: { ...card(), spendPolicy: { ...card().spendPolicy, allowImagineVideo: true } } };
  const denied = dispatchRoomAgentTool("imagine_video", { prompt: "短影", seconds: 6, resolution: "720p" }, ctx);
  assert.equal(denied.ok, false);
  assert.match(denied.error ?? "", /確認估價/);
  const over = dispatchRoomAgentTool("imagine_video", { prompt: "短影", seconds: 6, resolution: "720p" }, {
    ...ctx,
    imagineVideoConfirmed: true,
  });
  assert.equal(over.ok, false);
  assert.match(over.error ?? "", /上限/);
});

test("imagine_image stays a proposal preview and apply does not change version storage path", () => {
  const result = dispatchRoomAgentTool("imagine_image", { prompt: "主視覺", size: "1K" }, { card: card() });
  assert.equal(result.ok, true);
  assert.equal(result.preview, IMAGINE_NOT_VERSION_COPY);
  const before = "rooms/abc/versions/v1/poster.png";
  assert.equal(applyMustNotChangeVersionStorage(before, before), true);
  assert.equal(applyMustNotChangeVersionStorage(before, "rooms/abc/versions/v1/replaced.png"), false);
});

test("HTML / missing keys from Grok are reject, not success; search tools stay off", () => {
  const html = parseGrokProviderPayload("<!doctype html><html><title>對稿</title></html>");
  assert.equal(html.ok, false);
  if (html.ok) return;
  assert.equal(html.code, "SPA_HTML");
  const missing = parseGrokProviderPayload({ ok: true, choices: [] }, "application/json");
  assert.equal(missing.ok, false);
  const parsed = parseFunctionPayload("<!doctype html>", { successKeys: ["text"] });
  assert.equal(parsed.kind, "reject");
  const body = grokChatRequestBody({ query: "這間房在幹嘛", card: card() });
  assert.equal(grokRequestEnablesSearch(body), false);
  assert.doesNotMatch(JSON.stringify(body.tools), /web_search|x_search/);
  assert.equal(body.model, DEFAULT_GROK_TEXT_MODEL);
});

test("XAI_API_KEY is never a VITE_ client secret", () => {
  const envExample = readFileSync(resolve(ROOT, ".env.example"), "utf8");
  assert.match(envExample, /XAI_API_KEY=/);
  assert.match(envExample, /GROK_TEXT_MODEL=/);
  assert.doesNotMatch(envExample, /VITE_XAI|VITE_GROK|ik_/);
  const src = [
    readFileSync(resolve(ROOT, "src/ai/roomAgentContract.ts"), "utf8"),
    readFileSync(resolve(ROOT, "src/features/asset-intelligence/RoomAiSheet.tsx"), "utf8"),
    readFileSync(resolve(ROOT, "src/App.tsx"), "utf8"),
  ].join("\n");
  assert.doesNotMatch(src, /VITE_XAI|VITE_GROK_TEXT_MODEL/);
});

test("citations stay bound to content / comment / item ids", () => {
  const built = card();
  assert.ok(built.contents.every((item) => item.branchId));
  assert.ok(built.comments.every((item) => item.id));
  assert.ok(built.workLayer?.items.every((item) => item.id));
});
