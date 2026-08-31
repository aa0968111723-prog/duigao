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
import { applyVisualWorkLayer } from "../../src/ai/applyVisualWorkLayer.ts";
import type { AiProposal } from "../../src/ai/proposals.ts";
import { askGrok } from "../../supabase/functions/_shared/roomAgent.ts";
import {
  executeImagineImage,
  executeImagineVideo,
  storeImagineAsset,
} from "../../supabase/functions/_shared/imagine.ts";

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

test("whiteboard focus fields stay on the card and still leak nothing", () => {
  const built = buildRoomAgentCard({
    room: { id: "r1", title: "茶會房", role: "editor" },
    focus: { label: "茶會主視覺", nodeId: "n-focus", nodeType: "text", source: "discussion" },
    workLayer: {
      proposalId: "wl",
      status: "draft",
      items: [{ id: "n1", type: "text", text: "便利貼內文".repeat(40), x: 24, y: 80 }],
    },
    spendPolicy: { maxUsdThisTurn: 0.05, allowImagineImage: true, allowImagineVideo: false },
  });
  assert.equal(built.focus?.nodeId, "n-focus");
  assert.equal(built.focus?.source, "discussion");
  assert.ok((built.workLayer?.items[0]?.text?.length ?? 0) <= 160);
  assert.match(built.workLayer?.items[0]?.approxPosition ?? "", /約/);
  assert.equal(built.spendPolicy.maxUsdThisTurn, 0.05);
  assert.deepEqual(roomAgentCardLeaks(built), []);
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

test("imagine_video without confirm is refused with a quote; confirmed still respects spend cap", () => {
  const ctx = { card: { ...card(), spendPolicy: { ...card().spendPolicy, allowImagineVideo: true } } };
  const denied = dispatchRoomAgentTool("imagine_video", { prompt: "短影", seconds: 6, resolution: "720p" }, ctx);
  assert.equal(denied.ok, false);
  assert.match(denied.error ?? "", /確認估價/);
  const quote = denied.data as { needsConfirm?: boolean; estimatedUsd?: number; seconds?: number };
  assert.equal(quote.needsConfirm, true);
  assert.equal(quote.seconds, 6);
  assert.ok((quote.estimatedUsd ?? 0) > 0);
  const over = dispatchRoomAgentTool("imagine_video", { prompt: "短影", seconds: 6, resolution: "720p" }, {
    ...ctx,
    imagineVideoConfirmed: true,
  });
  assert.equal(over.ok, false);
  assert.match(over.error ?? "", /上限/);
});

test("imagine_image stays a proposal preview", () => {
  const result = dispatchRoomAgentTool("imagine_image", { prompt: "主視覺", size: "1K" }, { card: card() });
  assert.equal(result.ok, true);
  assert.equal(result.preview, IMAGINE_NOT_VERSION_COPY);
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

function jsonFetch(body: unknown, urlCheck?: (url: string) => void) {
  return async (url: string) => {
    urlCheck?.(url);
    return {
      ok: true,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify(body),
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    };
  };
}

test("executeImagineImage POSTs grok-imagine-image; unconfirmed executeImagineVideo never fetches", async () => {
  const urls: string[] = [];
  const image = await executeImagineImage({
    prompt: "主視覺",
    apiKey: "xai-test",
    model: "grok-imagine-image",
    fetchFn: jsonFetch({ data: [{ b64_json: Buffer.from("PNG").toString("base64") }] }, (url) => urls.push(url)),
  });
  assert.equal(image.ok, true);
  assert.ok(urls.some((url) => url.includes("/images/generations")));
  if (image.ok) assert.equal(image.model, "grok-imagine-image");

  let videoCalls = 0;
  const video = await executeImagineVideo({
    prompt: "短影",
    apiKey: "xai-test",
    confirmed: false,
    fetchFn: async () => {
      videoCalls += 1;
      return { ok: true, headers: { get: () => "application/json" }, text: async () => "{}" };
    },
  });
  assert.equal(video.ok, false);
  assert.equal(video.refused, true);
  assert.equal(videoCalls, 0);
});

test("storeImagineAsset writes proposals path and never versions", async () => {
  const uploads: Array<{ path: string; mime: string }> = [];
  const stored = await storeImagineAsset({
    roomId: "11111111-1111-4111-8111-111111111111",
    bytes: new Uint8Array([9, 8, 7]),
    mime: "image/png",
    idFn: (() => {
      let n = 0;
      return () => `aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee${n++}`;
    })(),
    upload: async (path, _bytes, mime) => {
      uploads.push({ path, mime });
      return {};
    },
  });
  assert.equal(stored.ok, true);
  if (!stored.ok) return;
  assert.match(stored.path, /\/proposals\//);
  assert.doesNotMatch(stored.path, /\/versions\//);
  assert.equal(uploads[0]?.path, stored.path);
});

test("採用 upserts visual_proposals and leaves the version storage path unchanged", async () => {
  const before = "rooms/abc/versions/v1/poster.png";
  const upserts: Array<{ roomId: string; payload: Record<string, unknown>; versionId: string }> = [];
  const proposal: AiProposal = {
    id: "imagine-main",
    type: "imagine_image",
    label: "主視覺",
    requiresExtraConfirm: false,
    source: "agent",
    payload: {
      proposalId: "11111111-2222-4333-8444-555555555555",
      workLayerRef: "rooms/abc/proposals/11111111-2222-4333-8444-555555555555/a1.png",
      preview: IMAGINE_NOT_VERSION_COPY,
    },
  };
  const result = await applyVisualWorkLayer({
    proposal,
    version: { id: "v1", imagePath: before, videoPath: "rooms/abc/videos/v1/original.mp4" },
    roomId: "abc",
    authorName: "主辦",
    upsert: async (roomId, cloudProposal) => {
      upserts.push({ roomId, payload: cloudProposal.payload, versionId: cloudProposal.versionId });
      return 1;
    },
  });
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].roomId, "abc");
  assert.equal(result.versionImagePath, before);
  assert.equal(result.versionVideoPath, "rooms/abc/videos/v1/original.mp4");
  assert.equal(applyMustNotChangeVersionStorage(before, result.versionImagePath), true);
  assert.doesNotMatch(JSON.stringify(upserts[0].payload), /\/versions\//);
  assert.match(String(upserts[0].payload.workLayerRef), /\/proposals\//);
  assert.equal(upserts[0].payload.status, "accepted");
  await assert.rejects(
    () => applyVisualWorkLayer({
      proposal: { ...proposal, payload: { workLayerRef: "rooms/abc/versions/v1/replaced.png" } },
      version: { id: "v1", imagePath: before },
      roomId: "abc",
      authorName: "主辦",
      upsert: async () => 1,
    }),
    /cannot write a version original path/,
  );
});

test("askGrok 只拿到 list_* 時會再問一輪，不再回 null", async () => {
  const grokEnv = {
    provider: "grok-room-agent",
    xaiKey: "xai-test",
    textModel: DEFAULT_GROK_TEXT_MODEL,
    imageModel: "grok-imagine-image",
    videoModel: "grok-imagine-video",
    maxUsd: 0.05,
  };
  let turns = 0;
  const answer = await askGrok({
    env: grokEnv,
    query: "針對書籤下一步？",
    card: card(),
    imagineVideoConfirmed: false,
    fetchFn: async (url) => {
      if (!String(url).includes("/chat/completions")) throw new Error(String(url));
      turns += 1;
      if (turns === 1) {
        return {
          ok: true,
          headers: { get: () => "application/json" },
          text: async () => JSON.stringify({
            choices: [{
              message: {
                content: "",
                tool_calls: [{ id: "t1", function: { name: "list_room_contents", arguments: "{}" } }],
              },
            }],
          }),
        };
      }
      return {
        ok: true,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify({
          choices: [{ message: { content: "書籤這支先補正面法語，不要改原稿。" } }],
        }),
      };
    },
  });
  assert.equal(turns, 2);
  assert.ok(answer);
  assert.match(answer?.text ?? "", /書籤/);
});

test("askGrok calls Imagine for image and only quotes unconfirmed video", async () => {
  const grokEnv = {
    provider: "grok-room-agent",
    xaiKey: "xai-test",
    textModel: DEFAULT_GROK_TEXT_MODEL,
    imageModel: "grok-imagine-image",
    videoModel: "grok-imagine-video",
    maxUsd: 0.05,
  };
  const built = card();
  const urls: string[] = [];
  const stored: string[] = [];
  const imageAnswer = await askGrok({
    env: grokEnv,
    query: "做主視覺",
    card: built,
    imagineVideoConfirmed: false,
    fetchFn: async (url) => {
      urls.push(url);
      if (url.includes("/chat/completions")) {
        return {
          ok: true,
          headers: { get: () => "application/json" },
          text: async () => JSON.stringify({
            choices: [{
              message: {
                content: "這是可審核的提案",
                tool_calls: [{ function: { name: "imagine_image", arguments: JSON.stringify({ prompt: "主視覺" }) } }],
              },
            }],
          }),
        };
      }
      return {
        ok: true,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify({ data: [{ b64_json: Buffer.from("PNG").toString("base64") }] }),
      };
    },
    storeImagine: async () => {
      stored.push("image");
      return { proposalId: "11111111-1111-4111-8111-111111111111", path: "rooms/r/proposals/11111111-1111-4111-8111-111111111111/a.png" };
    },
  });
  assert.ok(urls.some((url) => url.includes("/images/generations")));
  assert.equal(stored[0], "image");
  assert.equal(imageAnswer?.actions[0]?.type, "imagine_image");
  assert.equal(imageAnswer?.actions[0]?.payload.workLayerRef, "rooms/r/proposals/11111111-1111-4111-8111-111111111111/a.png");

  const videoUrls: string[] = [];
  const videoAnswer = await askGrok({
    env: grokEnv,
    query: "做短影",
    card: built,
    imagineVideoConfirmed: false,
    fetchFn: async (url) => {
      videoUrls.push(url);
      return {
        ok: true,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify({
          choices: [{
            message: {
              content: "先確認估價",
              tool_calls: [{ function: { name: "imagine_video", arguments: JSON.stringify({ prompt: "短影", seconds: 6, resolution: "720p" }) } }],
            },
          }],
        }),
      };
    },
    storeImagine: async () => {
      throw new Error("unconfirmed video must not store");
    },
  });
  assert.equal(videoUrls.length, 1);
  assert.ok(videoUrls[0].includes("/chat/completions"));
  assert.equal(videoAnswer?.actions[0]?.type, "imagine_video");
  assert.equal(videoAnswer?.actions[0]?.payload.needsConfirm, true);
  assert.equal(videoAnswer?.actions[0]?.payload.workLayerRef, undefined);
});

test("RoomAiSheet confirm re-asks with imagineVideoConfirmed instead of applying", () => {
  const sheet = readFileSync(resolve(ROOT, "src/features/asset-intelligence/RoomAiSheet.tsx"), "utf8");
  assert.match(sheet, /imagineVideoConfirmed:\s*true/);
  assert.match(sheet, /data-testid="room-ai-imagine-confirm"/);
  assert.doesNotMatch(sheet, /room-ai-imagine-confirm[\s\S]{0,200}apply\(true\)/);
  const app = readFileSync(resolve(ROOT, "src/App.tsx"), "utf8");
  assert.match(app, /applyVisualWorkLayer/);
  assert.match(app, /upsertProposal/);
});
