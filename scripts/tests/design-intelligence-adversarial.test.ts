/**
 * 對抗審查（grok）針對 PR-DI-02 提出的反例（PR-DI-02 修正）。
 *
 * 每一條都對應一個「拿掉實作、原本的測試仍然全綠」的假綠，或一個
 * 實際會讓使用者拿到錯結果的輸入。放在獨立檔案是為了讓「這些是被外部審查
 * 打出來的洞」在檔名上就看得見。
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  AnalysisCancelledError,
  analyzeDesign,
  validateAlternativeDiversity,
  type AnalysisInput,
} from "../../src/features/design-intelligence/analysis";
import { createMockProvider } from "../../src/features/design-intelligence/mockProvider";
import { transitionProposal, availableTransitions } from "../../src/features/design-intelligence/lifecycle";
import type {
  ColorToken,
  DesignAlternative,
  DesignProposal,
} from "../../src/features/design-intelligence/types";

function color(role: ColorToken["role"], hex: string): ColorToken {
  return { role, hex, rgb: { r: 0, g: 0, b: 0 }, cssToken: `--di-${role}`, contrastRatio: null, wcag: "none" };
}

let idSeq = 0;
const deps = (over: Partial<Parameters<typeof analyzeDesign>[1]> = {}) => ({
  now: () => 1_700_000_000_000,
  newId: (prefix: string) => `${prefix}-${(idSeq += 1)}`,
  ...over,
});

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

function alternative(
  strategy: DesignAlternative["strategy"],
  changes: Array<{ dimension: string; target: string; change: string }>,
): DesignAlternative {
  return {
    id: strategy,
    name: strategy,
    strategy,
    changes: changes.map((change) => ({
      dimension: change.dimension as DesignAlternative["changes"][number]["dimension"],
      target: change.target,
      change: change.change,
      reason: "理由",
    })),
    designTokens: [],
    preview: null,
    advantages: [],
    tradeoffs: [],
  };
}

// ---------------------------------------------------------------------------
// 多樣性
// ---------------------------------------------------------------------------

test("多樣性：換維度標籤不等於換方向", () => {
  // 模型可以把同一組「改成 #ff0000」分別標成 color／typography／layout，
  // 維度集合就變得不一樣了 —— 但實際上仍是同一件事。
  const same = { target: "主色", change: "改成 #ff0000" };
  const problems = validateAlternativeDiversity([
    alternative("conservative", [{ ...same, dimension: "color" }]),
    alternative("balanced", [{ ...same, dimension: "typography" }]),
    alternative("bold", [{ ...same, dimension: "layout" }]),
  ]);
  assert.ok(
    problems.some((problem) => problem.includes("只有維度標籤不同")),
    `同一組改動換三個標籤應該被抓出來，實得：${problems.join(" / ")}`,
  );
});

test("多樣性：缺了平衡方案時，強度顛倒仍要被抓", () => {
  // 舊版只比相鄰兩級（bold vs balanced、balanced vs conservative），
  // 少了 balanced 就整組跳過，「保守碰五個維度、大膽只碰一個」照樣過關。
  const problems = validateAlternativeDiversity([
    alternative("conservative", [
      { dimension: "color", target: "a", change: "1" },
      { dimension: "layout", target: "b", change: "2" },
      { dimension: "typography", target: "c", change: "3" },
      { dimension: "imagery", target: "d", change: "4" },
      { dimension: "copy", target: "e", change: "5" },
    ]),
    alternative("bold", [{ dimension: "color", target: "f", change: "6" }]),
  ]);
  assert.ok(
    problems.some((problem) => problem.includes("大膽方案")),
    `強度明顯標錯卻沒被抓，實得：${problems.join(" / ")}`,
  );
});

test("正常的光譜不會被誤殺", () => {
  assert.deepEqual(
    validateAlternativeDiversity([
      alternative("conservative", [{ dimension: "color", target: "文字色", change: "#767676" }]),
      alternative("balanced", [
        { dimension: "color", target: "文字色", change: "#1a1a1a" },
        { dimension: "layout", target: "留白", change: "24px → 64px" },
      ]),
      alternative("bold", [
        { dimension: "imagery", target: "主視覺", change: "改為滿版照片" },
        { dimension: "layout", target: "網格", change: "置中改左對齊三欄" },
        { dimension: "typography", target: "主標", change: "26px → 56px" },
      ]),
    ]),
    [],
    "保守 ⊂ 平衡 ⊂ 大膽 是合理的光譜，不該被判為不夠不同",
  );
});

test("多樣性不合格時不給推薦方案", async () => {
  const provider = createMockProvider({ behaviour: { kind: "shallow-alternatives" } });
  const result = await analyzeDesign(input(), deps({ providers: [provider] }));
  assert.equal(
    result.proposal.recommendedAlternativeId,
    null,
    "已知有問題的三個方案不該有一個被標成「推薦」",
  );
});

// ---------------------------------------------------------------------------
// 誠實性與取消
// ---------------------------------------------------------------------------

test("provider 丟例外後，理由不得宣稱 AI 有提供分析", async () => {
  const provider = createMockProvider({ behaviour: { kind: "throws", message: "503 上游無回應" } });
  const result = await analyzeDesign(input(), deps({ providers: [provider] }));
  assert.doesNotMatch(
    result.proposal.rationale,
    /AI 分析由/,
    `risks 說沒完成、rationale 說有提供，自相矛盾：${result.proposal.rationale}`,
  );
  assert.match(result.proposal.rationale, /未使用 AI/);

  // 另一半：成功時 rationale **必須**說出用了哪個 provider。
  // 少了這條，「usedProvider 永遠是 null」也能全綠（變異測試指出的）。
  const okResult = await analyzeDesign(input(), deps({ providers: [createMockProvider()] }));
  assert.match(
    okResult.proposal.rationale,
    /AI 分析由 mock 提供/,
    `成功時要說出是誰做的分析，實得：${okResult.proposal.rationale}`,
  );
  assert.ok(
    okResult.proposal.confidence > 0.6,
    "AI 真的跑成了，信心值不該還停在降級後的水準",
  );
});

test("provider 的 status() 卡住時，取消仍然有效", async () => {
  const stuck = {
    id: "stuck",
    capabilities: () => ["structured-output", "layout-analysis"] as const,
    status: () => new Promise<never>(() => {}),
    analyze: async () => {
      throw new Error("不該走到這裡");
    },
  };
  const controller = new AbortController();
  const pending = analyzeDesign(
    input(),
    deps({ providers: [stuck as never], signal: controller.signal }),
  );
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof AnalysisCancelledError);
});

test("挑完 provider 之後才取消，也不會送出請求", async () => {
  const controller = new AbortController();
  let analyzeCalled = false;
  const late = {
    id: "late",
    capabilities: () => ["structured-output", "layout-analysis"] as const,
    status: async () => {
      controller.abort(); // 在挑 provider 的過程中使用者按了取消
      return { state: "ready" as const };
    },
    analyze: async () => {
      analyzeCalled = true;
      throw new Error("不該走到這裡");
    },
  };
  await assert.rejects(
    analyzeDesign(input(), deps({ providers: [late as never], signal: controller.signal })),
    (error: unknown) => error instanceof AnalysisCancelledError,
  );
  assert.equal(analyzeCalled, false, "已取消還送出請求等於白花錢");
});

// ---------------------------------------------------------------------------
// 本地診斷不得在成功路徑上消失
// ---------------------------------------------------------------------------

test("成功路徑上，本地量測的診斷仍然全部保留", async () => {
  // 反例對象：`diagnostics = modelDiagnostics.length ? modelDiagnostics : local`
  // ——這種寫法在 provider 失敗的路徑上仍然綠，只有成功路徑抓得到。
  const result = await analyzeDesign(input(), deps({ providers: [createMockProvider()] }));
  const ids = result.proposal.diagnostics.map((diagnostic) => diagnostic.id);
  assert.ok(ids.includes("local-tap-cta"), `本地觸控診斷不見了：${ids.join(", ")}`);
  assert.ok(
    ids.some((id) => id.startsWith("local-contrast-")),
    `本地對比診斷不見了：${ids.join(", ")}`,
  );
  assert.ok(ids.some((id) => id.startsWith("ai-")), "模型的診斷也該在");
});

test("模型給的 patch 不會被接進提案", async () => {
  // 反例對象：`patch: (response.raw as any).patch ?? null`
  // mock 沒有 patch 欄位，所以原本的「永遠不會產生套用計畫」測試殺不死它。
  const withPatch = {
    ...createMockProvider(),
    analyze: async () => ({
      provider: "mock",
      model: null,
      satisfied: [],
      gaps: [],
      usage: { inputTokens: null, outputTokens: null },
      raw: {
        diagnostics: [],
        alternatives: [],
        patch: {
          adapter: "board",
          payload: { deleteEverything: true },
          reversible: false,
          revertHint: "沒有",
        },
      },
    }),
  };
  const result = await analyzeDesign(input(), deps({ providers: [withPatch as never] }));
  assert.equal(result.proposal.patch, null, "模型不得直接指定要對使用者的作品做什麼");
});

// ---------------------------------------------------------------------------
// 狀態機不再是死碼
// ---------------------------------------------------------------------------

function proposalAt(status: DesignProposal["status"], over: Partial<DesignProposal> = {}): DesignProposal {
  return {
    id: "p-1",
    roomId: "room-1",
    projectId: "room-1",
    artifactId: null,
    targetType: "poster",
    targetId: "poster-1",
    mode: "improve",
    goal: "目標",
    contextSummary: "摘要",
    diagnostics: [],
    alternatives: [
      alternative("conservative", [{ dimension: "color", target: "文字色", change: "#767676" }]),
    ],
    recommendedAlternativeId: "conservative",
    preview: null,
    patch: null,
    rationale: "理由",
    sources: [],
    risks: [],
    confidence: 0.6,
    status,
    createdBy: "user-1",
    createdAt: 1,
    approvedBy: null,
    approvedAt: null,
    appliedAt: null,
    revertedAt: null,
    baseRevision: null,
    resultRevision: null,
    ...over,
  };
}

const now = () => 1_700_000_000_000;

test("沒有人核准就不能開始套用", () => {
  const ready = proposalAt("ready", {
    patch: { adapter: "board", payload: {}, reversible: true, revertHint: "回到上一版" },
  });
  // ready → applying 本來就不在狀態機裡
  const direct = transitionProposal(ready, "applying", { now, baseRevision: "v1" });
  assert.equal(direct.ok, false);
  assert.match(direct.ok ? "" : direct.reason, /不允許從/);

  // 就算硬把狀態設成 approved，沒有 approvedBy 也不能套用
  const faked = proposalAt("approved", {
    patch: { adapter: "board", payload: {}, reversible: true, revertHint: "回到上一版" },
  });
  const sneaky = transitionProposal(faked, "applying", { now, baseRevision: "v1" });
  assert.equal(sneaky.ok, false);
  assert.match(sneaky.ok ? "" : sneaky.reason, /還沒有人核准/);
});

test("完整的核准到套用路徑會留下稽核痕跡", () => {
  const ready = proposalAt("ready");
  const approved = transitionProposal(ready, "approved", { now, actor: "user-2" });
  assert.equal(approved.ok, true);
  if (!approved.ok) return;
  assert.equal(approved.proposal.approvedBy, "user-2");
  assert.equal(approved.proposal.approvedAt, now());

  const withPatch = {
    ...approved.proposal,
    patch: { adapter: "board" as const, payload: {}, reversible: true, revertHint: "回到 v1" },
  };
  const applying = transitionProposal(withPatch, "applying", { now, baseRevision: "v1" });
  assert.equal(applying.ok, true);
  if (!applying.ok) return;
  assert.equal(applying.proposal.baseRevision, "v1");

  const applied = transitionProposal(applying.proposal, "applied", { now, resultRevision: "v2" });
  assert.equal(applied.ok, true);
  if (!applied.ok) return;
  assert.equal(applied.proposal.resultRevision, "v2");
  assert.equal(applied.proposal.appliedAt, now());

  // 套用完可以復原
  const reverted = transitionProposal(applied.proposal, "reverted", { now });
  assert.equal(reverted.ok, true);
});

test("核准必須記錄是誰核准的", () => {
  const result = transitionProposal(proposalAt("ready"), "approved", { now });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /誰核准/);
});

test("不可逆的 patch 不允許自動套用", () => {
  const approved = proposalAt("approved", {
    approvedBy: "user-2",
    approvedAt: 1,
    patch: { adapter: "board", payload: {}, reversible: false, revertHint: "沒有" },
  });
  const result = transitionProposal(approved, "applying", { now, baseRevision: "v1" });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /不可逆/);
});

test("沒有記錄套用前的版本就不能套用（否則無法復原）", () => {
  const approved = proposalAt("approved", {
    approvedBy: "user-2",
    approvedAt: 1,
    patch: { adapter: "board", payload: {}, reversible: true, revertHint: "回到上一版" },
  });
  const result = transitionProposal(approved, "applying", { now });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /無法復原/);
});

test("終點狀態不能再變", () => {
  for (const terminal of ["rejected", "reverted"] as const) {
    const result = transitionProposal(proposalAt(terminal), "analyzing", { now });
    assert.equal(result.ok, false, `${terminal} 應該是終點`);
  }
  assert.deepEqual(availableTransitions(proposalAt("rejected")), []);
});

test("UI 拿得到的可用動作與狀態機同源", () => {
  assert.deepEqual(availableTransitions(proposalAt("ready")).sort(), ["approved", "rejected"]);
  assert.deepEqual(availableTransitions(proposalAt("approved")).sort(), ["applying", "rejected"]);
  assert.ok(!availableTransitions(proposalAt("ready")).includes("applied"));
});

test("取消訊號要傳給 provider，讓它中止自己的網路請求", async () => {
  // 這是取消在「已經送出請求之後」的唯一防線：analyzeDesign 沒辦法把別人的
  // fetch 停掉，只能把 signal 交給它。沒傳到就等於請求會跑完、費用照算。
  let received: AbortSignal | undefined;
  const spy = {
    id: "spy",
    capabilities: () => ["structured-output", "layout-analysis"] as const,
    status: async () => ({ state: "ready" as const }),
    analyze: async (request: { signal?: AbortSignal }) => {
      received = request.signal;
      return {
        provider: "spy",
        model: null,
        satisfied: [],
        gaps: [],
        usage: { inputTokens: null, outputTokens: null },
        raw: { diagnostics: [], alternatives: [] },
      };
    },
  };
  const controller = new AbortController();
  await analyzeDesign(input(), deps({ providers: [spy as never], signal: controller.signal }));
  assert.equal(received, controller.signal, "provider 沒有拿到取消訊號");
});
