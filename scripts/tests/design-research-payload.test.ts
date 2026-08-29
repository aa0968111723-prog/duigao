/**
 * design-research client honesty.
 *
 * The app must invoke `design-research` (or honestly say not configured).
 * SPA HTML / missing `answer` / no transport must never invent a research answer.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  acceptDesignResearchSuccessBody,
  createCloudResearchProvider,
  createDesignResearchTransport,
  notConfiguredResearchResponse,
} from "../../src/cloud/designResearch.ts";
import { failureOf } from "../../src/features/design-intelligence/research.ts";
import { isResearchDisabled } from "../../src/features/design-intelligence/providers.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPA_HTML = `<!doctype html>
<html lang="zh-Hant">
  <head><meta charset="UTF-8" /><title>對稿</title></head>
  <body><div id="root"></div></body>
</html>`;

const REAL_BODY = {
  query: "對比規範",
  answer: "一般文字與背景對比至少 4.5:1。",
  sources: [],
  provider: "perplexity",
  model: "sonar",
};

function src(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

function fakeClient(impl: (name: string, args?: { body?: unknown }) => Promise<{ data: unknown; error: unknown }>) {
  return {
    functions: {
      invoke: impl,
    },
  };
}

test("source: client invokes design-research and never ships a Perplexity key", () => {
  const client = src("src/cloud/designResearch.ts");
  assert.match(client, /functions\.invoke\("design-research"/);
  assert.doesNotMatch(client, /VITE_PERPLEXITY|PERPLEXITY_API_KEY\s*=/);
  assert.match(client, /RESEARCH_NOT_CONFIGURED/);
  assert.match(src("src/features/design-intelligence/research.ts"), /SPA HTML 或缺欄不得當成成功/);
});

test("acceptDesignResearchSuccessBody rejects SPA HTML and missing answer", () => {
  assert.equal(acceptDesignResearchSuccessBody(SPA_HTML), false);
  assert.equal(acceptDesignResearchSuccessBody(SPA_HTML, "text/html"), false);
  assert.equal(acceptDesignResearchSuccessBody({ ok: true }), false);
  assert.equal(acceptDesignResearchSuccessBody({ answer: SPA_HTML }), false);
  assert.equal(acceptDesignResearchSuccessBody(REAL_BODY), true);
});

test("no transport: 503 RESEARCH_NOT_CONFIGURED, empty answer, not a fake result", async () => {
  const bare = notConfiguredResearchResponse();
  assert.equal(bare.status, 503);
  assert.equal(bare.body.error, "RESEARCH_NOT_CONFIGURED");
  assert.equal(bare.body.answer, undefined);

  const transport = createDesignResearchTransport(null);
  const raw = await transport({ roomId: "room-1", query: "對比規範" });
  assert.equal(raw.status, 503);
  assert.equal(raw.body.error, "RESEARCH_NOT_CONFIGURED");
  assert.equal(typeof raw.body.answer, "undefined");

  const provider = createCloudResearchProvider(null, { roomId: "room-1", now: () => 10 });
  const result = await provider.search("對比規範");
  assert.equal(result.answer, "");
  assert.equal(failureOf(result), "not-configured");
  assert.equal(isResearchDisabled(result), true);
  assert.notEqual(result.provider, "perplexity");
});

test("SPA HTML invoke data is not a research answer", async () => {
  const transport = createDesignResearchTransport(
    fakeClient(async () => ({ data: SPA_HTML, error: null })),
  );
  const raw = await transport({ roomId: "room-1", query: "對比規範" });
  assert.equal(raw.status, 502);
  assert.equal(typeof raw.body.answer, "undefined");

  const provider = createCloudResearchProvider(
    fakeClient(async () => ({ data: SPA_HTML, error: null })),
    { roomId: "room-1", now: () => 11 },
  );
  const result = await provider.search("對比規範");
  assert.equal(result.answer, "");
  assert.equal(failureOf(result), "upstream-error");
  assert.notEqual(result.cacheStatus, "hit");
});

test("SPA HTML content-type on invoke error is not a research answer", async () => {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
  const context = new Response(SPA_HTML, { status: 200, headers });
  const provider = createCloudResearchProvider(
    fakeClient(async () => ({ data: null, error: { message: "FunctionsHttpError", context } })),
    { roomId: "room-1", now: () => 12 },
  );
  const result = await provider.search("對比規範");
  assert.equal(result.answer, "");
  assert.equal(failureOf(result), "upstream-error");
});

test("200 JSON missing answer is not a research answer", async () => {
  const transport = createDesignResearchTransport(
    fakeClient(async () => ({ data: { ok: true, query: "對比規範" }, error: null })),
  );
  const raw = await transport({ roomId: "room-1", query: "對比規範" });
  assert.equal(raw.status, 502);
  assert.equal(raw.body.error, "MISSING_ANSWER");
  assert.equal(typeof raw.body.answer, "undefined");

  const provider = createCloudResearchProvider(
    fakeClient(async () => ({ data: { ok: true, query: "對比規範" }, error: null })),
    { roomId: "room-1", now: () => 13 },
  );
  const result = await provider.search("對比規範");
  assert.equal(result.answer, "");
  assert.equal(failureOf(result), "upstream-error");
  assert.notEqual(result.cacheStatus, "hit");
});

test("real 200 research JSON is accepted and not rewritten", async () => {
  const provider = createCloudResearchProvider(
    fakeClient(async (name, args) => {
      assert.equal(name, "design-research");
      const query = (args?.body as { query?: string })?.query ?? "";
      assert.match(query, /對比規範/);
      return { data: { ...REAL_BODY, query }, error: null };
    }),
    { roomId: "room-1", now: () => 14 },
  );
  const result = await provider.search("對比規範");
  assert.equal(result.answer, REAL_BODY.answer);
  assert.equal(failureOf(result), null);
});
