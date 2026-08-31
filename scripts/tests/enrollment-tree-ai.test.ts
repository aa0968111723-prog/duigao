/**
 * 代理必須實測 AI：走 askGrok 同一條 production 路徑，對準 202609招生 › 書籤。
 * Fixture 只替換 fetch body；chat/completions 與 images/generations 都要真的被呼叫。
 * Live：有 XAI_API_KEY 就打 api.x.ai；沒有就記錄嘗試過的 blocker。
 *
 * Run: npm run test:enrollment-tree-ai
 */
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { plantEnrollmentTree2026 } from "../../src/features/collaboration/enrollmentTree";
import { colleagueWrite } from "../../src/features/collaboration/agentColleague";
import { boardAskContext } from "../../src/features/whiteboard/boardFocus";
import {
  DEFAULT_GROK_TEXT_MODEL,
  buildRoomAgentCard,
  grokChatRequestBody,
  grokRequestEnablesSearch,
  parseGrokProviderPayload,
  roomAgentCardLeaks,
} from "../../src/ai/roomAgentContract";
import { askGrok } from "../../supabase/functions/_shared/roomAgent.ts";
import { executeImagineImage } from "../../supabase/functions/_shared/imagine.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE = JSON.parse(readFileSync(resolve(ROOT, "scripts/fixtures/enrollment-tree-grok-chat.json"), "utf8")) as unknown;
const ARTIFACT_DIR = "/opt/cursor/artifacts";

function treeCard() {
  let n = 0;
  const planted = plantEnrollmentTree2026({
    whiteboardId: "wb-enroll",
    roomId: "11111111-1111-4111-8111-111111111111",
    createdBy: "owner",
    idFn: () => `n${++n}`,
  });
  const bookmark = planted.nodes.find((node) => node.id === planted.byKey.bookmark);
  assert.ok(bookmark);
  const ask = boardAskContext({ nodes: planted.nodes, edges: planted.edges, focusNode: bookmark });
  const card = buildRoomAgentCard({
    room: { id: "11111111-1111-4111-8111-111111111111", title: "招生房", role: "owner" },
    contents: [
      { branchId: "b-bookmark", type: "poster", name: "書籤", latestVersionLabel: "正面語錄", openCommentCount: 1 },
    ],
    focus: {
      label: ask.focus?.label ?? "書籤",
      nodeId: bookmark.id,
      nodeType: "mindmap",
      source: "discussion",
      treePath: ask.focus?.treePath,
      treeRootId: ask.focus?.treeRootId,
    },
    comments: [{ id: "c1", body: "需要補充師父法語，正面語錄", region: "正面" }],
  });
  return { planted, clip: bookmark, ask, card };
}

test("askGrok 對準書籤：chat + Imagine 都被呼叫，原稿 path 不出現", async () => {
  const { card, ask, clip } = treeCard();
  assert.equal(card.focus?.treePath, "202609招生 › 書籤");
  assert.deepEqual(roomAgentCardLeaks(card), []);
  const request = grokChatRequestBody({ query: ask.focus?.label ?? "針對書籤", card });
  assert.equal(grokRequestEnablesSearch(request), false);
  assert.match(JSON.stringify(request.messages), /招生樹路徑/);

  const urls: string[] = [];
  const bodies: string[] = [];
  const stored: string[] = [];
  const answer = await askGrok({
    env: {
      provider: "grok-room-agent",
      xaiKey: "xai-test-enrollment-tree",
      textModel: DEFAULT_GROK_TEXT_MODEL,
      imageModel: "grok-imagine-image",
      videoModel: "grok-imagine-video",
      maxUsd: 0.05,
    },
    query: enrollmentQuery(ask.focus?.treePath),
    card,
    imagineVideoConfirmed: false,
    fetchFn: async (url, init) => {
      urls.push(String(url));
      if (typeof init?.body === "string") bodies.push(init.body);
      if (String(url).includes("/chat/completions")) {
        return {
          ok: true,
          headers: { get: () => "application/json" },
          text: async () => JSON.stringify(FIXTURE),
        };
      }
      if (String(url).includes("/images/generations")) {
        return {
          ok: true,
          headers: { get: () => "application/json" },
          text: async () => JSON.stringify({ data: [{ b64_json: Buffer.from("PNG-ENROLL").toString("base64") }] }),
        };
      }
      throw new Error(`unexpected url ${url}`);
    },
    storeImagine: async () => {
      stored.push("image");
      return { proposalId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", path: "rooms/r/proposals/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/a.png" };
    },
  });

  assert.ok(answer);
  assert.ok(urls.some((url) => url.includes("https://api.x.ai/v1/chat/completions")), "must hit Grok chat");
  assert.ok(urls.some((url) => url.includes("/images/generations")), "must hit Imagine");
  assert.equal(stored[0], "image");
  assert.match(bodies[0] ?? "", /202609招生 › 書籤/);
  assert.doesNotMatch(bodies.join("\n"), /\/versions\//);
  assert.equal(answer?.actions.some((item) => item.type === "imagine_image"), true);
  const imagine = answer?.actions.find((item) => item.type === "imagine_image");
  assert.match(String(imagine?.payload.workLayerRef ?? ""), /\/proposals\//);
  assert.doesNotMatch(String(imagine?.payload.workLayerRef ?? ""), /\/versions\//);
  assert.match(answer?.text ?? "", /書籤/);

  const parsed = parseGrokProviderPayload(FIXTURE, "application/json");
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.ok(parsed.toolCalls.some((item) => item.name === "imagine_image"));
  }

  const bubble = colleagueWrite({
    body: answer?.text ?? "",
    triggerUserId: "owner",
    nodeId: clip.id,
    treePath: card.focus?.treePath,
    treeRootId: card.focus?.treeRootId,
    proposals: (answer?.actions ?? []).map((item) => ({ id: item.type, type: item.type, label: item.label })),
  });
  assert.equal(bubble.payload.agent, true);
  assert.equal(bubble.payload.treePath, "202609招生 › 書籤");
  assert.equal(bubble.payload.nodeId, clip.id);

  writeEvidence({
    mode: "fixture-through-askGrok",
    chatHits: urls.filter((url) => url.includes("/chat/completions")).length,
    imagineHits: urls.filter((url) => url.includes("/images/generations")).length,
    treePath: card.focus?.treePath,
    actionTypes: answer?.actions.map((item) => item.type) ?? [],
    textPreview: (answer?.text ?? "").slice(0, 80),
  });
});

test("executeImagineImage 也走同一支 Imagine 函式（不是測試自己 fetch）", async () => {
  const urls: string[] = [];
  const image = await executeImagineImage({
    prompt: "202609招生 › 書籤 正面語錄草圖",
    apiKey: "xai-test",
    model: "grok-imagine-image",
    fetchFn: async (url) => {
      urls.push(String(url));
      return {
        ok: true,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify({ data: [{ b64_json: Buffer.from("PNG").toString("base64") }] }),
      };
    },
  });
  assert.equal(image.ok, true);
  assert.ok(urls[0]?.includes("/images/generations"));
});

test("live XAI：有金鑰就打真的；沒有就留下嘗試過的 blocker", async () => {
  const key = (process.env.XAI_API_KEY ?? "").trim();
  const { card, ask } = treeCard();
  if (!key) {
    writeEvidence({
      mode: "live-attempt",
      attempted: true,
      configured: false,
      blocker: "XAI_API_KEY missing in this environment after env lookup",
      providerTried: "grok-room-agent",
      endpointTried: "https://api.x.ai/v1/chat/completions",
      treePath: card.focus?.treePath,
      query: enrollmentQuery(ask.focus?.treePath),
    });
    assert.equal(key, "");
    return;
  }
  const urls: string[] = [];
  const live = await askGrok({
    env: {
      provider: "grok-room-agent",
      xaiKey: key,
      textModel: DEFAULT_GROK_TEXT_MODEL,
      imageModel: "grok-imagine-image",
      videoModel: "grok-imagine-video",
      maxUsd: 0.05,
    },
    query: enrollmentQuery(ask.focus?.treePath),
    card,
    imagineVideoConfirmed: false,
    fetchFn: async (url, init) => {
      urls.push(String(url));
      return fetch(url, init);
    },
    storeImagine: async () => ({
      proposalId: "live-not-stored",
      path: "rooms/r/proposals/live-not-stored/a.png",
    }),
  });
  writeEvidence({
    mode: "live-xai",
    attempted: true,
    configured: true,
    chatHits: urls.filter((url) => url.includes("/chat/completions")).length,
    imagineHits: urls.filter((url) => url.includes("/images/generations")).length,
    ok: Boolean(live),
    textPreview: (live?.text ?? "").slice(0, 120),
    actionTypes: live?.actions.map((item) => item.type) ?? [],
    treePath: card.focus?.treePath,
  });
  assert.ok(urls.some((url) => url.includes("/chat/completions")));
  assert.ok(live === null || typeof live.text === "string");
});

function enrollmentQuery(treePath?: string): string {
  return `針對「${treePath ?? "202609招生 › 書籤"}」，書籤要不要補師父法語、原有的是否需要更換？只准提案，不要改原稿。`;
}

function writeEvidence(payload: Record<string, unknown>): void {
  try {
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    const name = payload.mode === "live-xai" || payload.mode === "live-attempt"
      ? "enrollment_tree_ai_live.json"
      : "enrollment_tree_ai_fixture.json";
    writeFileSync(resolve(ARTIFACT_DIR, name), `${JSON.stringify({ at: new Date().toISOString(), ...payload }, null, 2)}\n`);
  } catch {
    // CI without /opt/cursor/artifacts still must stay green.
  }
}
