/**
 * GAP-07 AI honesty on latest main (#114 DI 0029–0030). Does not copy #88 schema.
 *
 * Run: npm run test:ai-external-handoff
 */
import { strict as assert } from "node:assert";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { analyzeDesign, type AnalysisInput } from "../../src/features/design-intelligence/analysis";
import {
  INTEGRATION_NOT_CONFIGURED,
  NO_FAKE_VISION,
  acceptExternalToolSuccess,
  acceptResearchSuccessBody,
  looksLikeSpaHtml,
  needsForAnalysis,
} from "../../src/features/design-intelligence/honesty";
import { createResearchProvider, failureOf } from "../../src/features/design-intelligence/research";
import { transitionProposal } from "../../src/features/design-intelligence/lifecycle";
import { createMockProvider } from "../../src/features/design-intelligence/mockProvider";
import { createCanvaAdapter, cutosAdapter } from "../../src/features/design-intelligence/adapters";
import type { ColorToken, DesignProposal } from "../../src/features/design-intelligence/types";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

function color(role: ColorToken["role"], hex: string): ColorToken {
  return { role, hex, rgb: { r: 0, g: 0, b: 0 }, cssToken: `--di-${role}`, contrastRatio: null, wcag: "none" };
}

function input(over: Partial<AnalysisInput> = {}): AnalysisInput {
  return {
    roomId: "room-1",
    projectId: "room-1",
    targetType: "poster",
    targetId: "poster-1",
    mode: "improve",
    goal: "這張海報看起來不夠專業",
    createdBy: "user-1",
    contextSummary: "一張活動海報",
    knowledge: [],
    facts: {
      colors: [color("surface", "#ffffff"), color("text-primary", "#aaaaaa")],
      textBlocks: [
        { id: "body", label: "活動說明", fontSizePx: 16, lineHeight: 1.2, charsPerLine: 60, isHeading: false },
      ],
      tapTargets: [{ id: "cta", label: "報名按鈕", widthPx: 20, heightPx: 20 }],
      viewportWidthPx: 390,
    },
    ...over,
  };
}

test("G7-01: 海報／影片 improve 必須要 vision；文字模型不得假裝看過圖", async () => {
  assert.ok(needsForAnalysis("improve", "poster").includes("vision-analysis"));
  assert.ok(needsForAnalysis("improve", "video").includes("vision-analysis"));
  assert.ok(!needsForAnalysis("diagnose", "poster").includes("vision-analysis"));
  assert.ok(!needsForAnalysis("improve", "plan").includes("vision-analysis"));

  const textOnly = createMockProvider({ capabilities: ["text-analysis", "structured-output", "layout-analysis"] });
  const result = await analyzeDesign(input(), {
    now: () => 1,
    newId: (prefix) => `${prefix}-1`,
    providers: [textOnly],
  });
  assert.ok(result.gaps.some((gap) => gap.missing === "vision-analysis"), "缺口必須回報");
  assert.ok(
    result.proposal.risks.some((risk) => risk.includes(NO_FAKE_VISION)),
    `風險必須寫明不得假裝視覺分析，實得：${result.proposal.risks.join(" / ")}`,
  );
  assert.doesNotMatch(result.proposal.rationale, /看過這張圖|視覺分析已完成|已分析圖片/);
});

test("G7-02: 提案必須 Preview→人類核准才能 applying；不得直接 applied", () => {
  const proposal: DesignProposal = {
    id: "p1",
    roomId: "r1",
    projectId: "r1",
    artifactId: null,
    targetType: "poster",
    targetId: "t1",
    mode: "improve",
    goal: "g",
    contextSummary: "s",
    diagnostics: [],
    alternatives: [],
    recommendedAlternativeId: null,
    preview: null,
    patch: { adapter: "board", payload: {}, reversible: true, revertHint: "刪便利貼" },
    rationale: "",
    sources: [],
    risks: [],
    confidence: 0.5,
    status: "ready",
    createdBy: "u1",
    createdAt: 1,
    approvedBy: null,
    approvedAt: null,
    appliedAt: null,
    revertedAt: null,
    baseRevision: null,
    resultRevision: null,
    failureReason: null,
  };
  const skip = transitionProposal(proposal, "applied", { now: () => 2, actor: "u1" });
  assert.equal(skip.ok, false, "ready 不得直接 applied");

  const applying = transitionProposal(proposal, "applying", { now: () => 2, actor: "u1", baseRevision: "v0" });
  assert.equal(applying.ok, false, "沒核准不得 applying");

  const approved = transitionProposal(
    { ...proposal, alternatives: [{ id: "a", name: "A", strategy: "conservative", changes: [{ dimension: "color", target: "字", change: "加深", reason: "2.3" }], designTokens: [], preview: null, advantages: [], tradeoffs: [] }] },
    "approved",
    { now: () => 2, actor: "reviewer-1" },
  );
  assert.equal(approved.ok, true);
  assert.equal(approved.ok && approved.proposal.approvedBy, "reviewer-1");
});

test("G7-03: SPA HTML 與 {ok:true} 缺欄不是 Canva／CUTOS／AI 成功", () => {
  const html = "<!doctype html><html><body>duigao</body></html>";
  assert.equal(looksLikeSpaHtml(html), true);
  assert.equal(acceptExternalToolSuccess(html, ["connected"]).ok, false);
  assert.equal(acceptExternalToolSuccess({ ok: true }, ["connected"]).ok, false);
  assert.equal(acceptExternalToolSuccess({ ok: true, connected: true }, ["connected"]).ok, true);
  assert.equal(acceptResearchSuccessBody(html), false);
  assert.equal(acceptResearchSuccessBody({ ok: true }), false);
  assert.equal(acceptResearchSuccessBody({ answer: "對比至少 4.5:1" }), true);
});

test("G7-04: 研究 transport 回 SPA HTML 不得當成功", async () => {
  const provider = createResearchProvider({
    roomId: "r1",
    now: () => 10,
    transport: async () => ({ status: 200, body: { html: "<!doctype html><html></html>" } as Record<string, unknown> }),
  });
  const result = await provider.search("對比規範");
  assert.equal(result.answer, "");
  assert.notEqual(result.cacheStatus === "hit", true);
  assert.equal(failureOf(result), "upstream-error");
});

test("G7-05: Canva／CUTOS adapter 沒連線就說沒連線；不假裝版本卡", async () => {
  const canva = createCanvaAdapter({ isConnected: async () => false });
  const canvaStatus = await canva.status();
  assert.equal(canvaStatus.state, "unconfigured");
  if (canvaStatus.state === "unconfigured") {
    assert.ok(canvaStatus.missing.length > 0);
  }
  const cutos = await cutosAdapter.status();
  assert.equal(cutos.state, "contract-only");
});

test("G7-06: 金鑰不在前端；不從 client 把房間內容丟給 Perplexity", () => {
  const research = src("src/features/design-intelligence/research.ts");
  assert.match(research, /沒有金鑰|不可能有/);
  assert.doesNotMatch(research, /VITE_PERPLEXITY|PERPLEXITY_API_KEY\s*=/);
  assert.match(research, /design-research/);

  const edge = src("supabase/functions/design-research/index.ts");
  assert.match(edge, /Deno\.env\.get\("PERPLEXITY_API_KEY"\)/);
  assert.match(edge, /RESEARCH_NOT_CONFIGURED/);

  const canva = src("src/cloud/canva.ts");
  assert.doesNotMatch(canva, /VITE_CANVA|CANVA_CLIENT_SECRET/);
  const cutos = src("src/cloud/cutos.ts");
  assert.doesNotMatch(cutos, /CUTOS_API_KEY|VITE_CUTOS/);

  const frontend = [
    "src/features/design-intelligence/research.ts",
    "src/features/design-intelligence/adapters.ts",
    "src/cloud/canva.ts",
    "src/cloud/cutos.ts",
  ]
    .map(src)
    .join("\n");
  assert.doesNotMatch(frontend, /api\.perplexity\.ai/);
});

test("G7-07: 本批沒有複製 #88 SQL；檔名是 main 的 0029–0030；全目標未完成", () => {
  const migrations = readdirSync(resolve(ROOT, "supabase/migrations")).filter((name) => name.endsWith(".sql"));
  assert.ok(migrations.includes("0029_design_knowledge.sql"), "#114 已合 main");
  assert.ok(migrations.includes("0030_design_research_usage.sql"), "#114 已合 main");
  assert.equal(migrations.includes("0027_design_knowledge.sql"), false, "舊 #88 檔名不得出現");
  assert.equal(migrations.includes("0028_design_research_usage.sql"), false, "舊 #88 檔名不得出現");
  assert.ok(migrations.includes("0022_discussion_author_integrity.sql"), "main stack 必須保留 0022");
  assert.ok(migrations.includes("0024_whiteboard_canonical_columns.sql"), "#113 0024–0028 必須在");
  assert.ok(migrations.includes("0028_whiteboard_freehand.sql"));

  assert.equal(existsSync(resolve(ROOT, "src/features/design-intelligence/honesty.ts")), true);
  const honesty = src("src/features/design-intelligence/honesty.ts");
  assert.match(honesty, /looksLikeSpaHtml/);
  assert.match(honesty, /NO_FAKE_VISION/);
  assert.match(src("src/features/design-intelligence/honesty.ts"), /apiResponse/);

  const evidence = src("docs/cursor-gap-remediation/FINAL_EVIDENCE.md");
  assert.match(evidence, /全站目標未完成/);
  assert.doesNotMatch(evidence, /GOAL COMPLETE|目標已完成/);
  void INTEGRATION_NOT_CONFIGURED;
});

test("G7-08: #97 SPA gate 已在 main；honesty 重用它，不另寫 schema", () => {
  assert.equal(existsSync(resolve(ROOT, "src/cloud/apiResponse.ts")), true);
  const canva = src("src/cloud/canva.ts");
  assert.match(canva, /parseFunctionPayload/);
  const honesty = src("src/features/design-intelligence/honesty.ts");
  assert.match(honesty, /from \"\.\.\/\.\.\/cloud\/apiResponse\"/);
  assert.doesNotMatch(honesty, /CREATE TABLE|0027_design_knowledge|0028_design_research/);
});
