/**
 * 分析流程的測試（PR-DI-02）。
 *
 * 重點是**失敗路徑**與紅線，不是 happy path：
 *  - provider 掛掉時，本地算出來的真實診斷不能跟著消失。
 *  - 模型回垃圾時要被擋下，而且要說出退了什麼。
 *  - 三個方案只換顏色時要被指出來。
 *  - 取消要真的停下來。
 *  - 流程**永遠不會**把提案推到 applied。
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
import type {
  ColorToken,
  DesignAlternative,
  KnowledgeEntry,
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
    contextSummary: "一張活動海報，含主標、副標與報名按鈕",
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

// ---------------------------------------------------------------------------
// 沒有 AI 也要有用
// ---------------------------------------------------------------------------

test("完全沒有 provider 時仍然產出可用的提案，並說明少了什麼", async () => {
  const result = await analyzeDesign(input(), deps({ providers: [] }));

  assert.equal(result.proposal.status, "ready", "本地量測就足以給出 ready 的提案");
  assert.ok(result.proposal.diagnostics.length >= 3, "對比、觸控目標、行高都該被抓到");
  assert.ok(
    result.proposal.risks.some((risk) => risk.includes("沒有可用的 AI")),
    "沒有 AI 這件事必須寫在風險裡，不能默默降級",
  );
  assert.ok(result.gaps.length > 0, "能力缺口要回報給 UI");
  assert.ok(
    result.proposal.confidence < 0.8,
    `AI 沒跑成就宣稱高信心會誤導人，實得 ${result.proposal.confidence}`,
  );
  assert.match(result.proposal.rationale, /未使用 AI/, "理由要說清楚這次沒用 AI");
});

test("沒有 provider 時只給一個保守方案，而且說明為什麼只有一個", async () => {
  const result = await analyzeDesign(input(), deps({ providers: [] }));

  assert.equal(result.proposal.alternatives.length, 1, "用規則硬湊三個方向就是編造");
  assert.equal(result.proposal.alternatives[0].strategy, "conservative");
  assert.ok(
    result.proposal.risks.some((risk) => risk.includes("只提供了一個保守方案")),
    "只有一個方案這件事要說出來",
  );
  // 保守方案的每一條改動都必須有出處
  for (const change of result.proposal.alternatives[0].changes) {
    assert.match(change.reason, /\d/, `改動的理由沒有量測值：${change.reason}`);
  }
});

// ---------------------------------------------------------------------------
// provider 失敗
// ---------------------------------------------------------------------------

test("provider 掛掉時，本地算出來的診斷不會跟著消失", async () => {
  const provider = createMockProvider({ behaviour: { kind: "throws", message: "503 上游無回應" } });
  const result = await analyzeDesign(input(), deps({ providers: [provider] }));

  assert.equal(result.proposal.status, "ready", "AI 掛了不代表整個功能沒東西可給");
  assert.ok(result.proposal.diagnostics.length >= 3, "本地診斷必須保留");
  assert.ok(
    result.proposal.risks.some((risk) => risk.includes("503 上游無回應")),
    "失敗原因要照實顯示，不能用假的成功訊息蓋掉",
  );
  assert.ok(result.proposal.confidence < 0.8);
});

test("模型回格式不合的東西時被擋下，而且說得出退了什麼", async () => {
  const provider = createMockProvider({ behaviour: { kind: "garbage" } });
  const result = await analyzeDesign(input(), deps({ providers: [provider] }));

  // 「配色可以更好」這種答案是任務書明文禁止的，必須進不了診斷清單
  const issues = result.proposal.diagnostics.map((diagnostic) => diagnostic.issue);
  assert.ok(!issues.includes("配色可以更好"), "空話診斷不得進入提案");
  assert.ok(result.rejected.length >= 2, `應該記錄被退掉的項目，實得 ${result.rejected.length}`);
  assert.ok(
    result.rejected.some((line) => line.includes("沒有任何具體修改") || line.includes("缺少")),
    `退件理由不夠具體：${result.rejected.join(" / ")}`,
  );
  // 但本地診斷還在
  assert.ok(result.proposal.diagnostics.length >= 3);
});

// ---------------------------------------------------------------------------
// 三個方案必須真的不同
// ---------------------------------------------------------------------------

test("三個方案只換顏色時被指出來", async () => {
  const provider = createMockProvider({ behaviour: { kind: "shallow-alternatives" } });
  const result = await analyzeDesign(input(), deps({ providers: [provider] }));

  assert.equal(result.proposal.alternatives.length, 3);
  assert.ok(
    result.proposal.risks.some((risk) => risk.includes("三組不同顏色")),
    `只改顏色的三個方案必須被指出來，實得風險：${result.proposal.risks.join(" / ")}`,
  );
});

test("真的不同的三個方案通過檢查", async () => {
  const provider = createMockProvider();
  const result = await analyzeDesign(input(), deps({ providers: [provider] }));

  assert.equal(result.proposal.alternatives.length, 3);
  const strategies = result.proposal.alternatives.map((alternative) => alternative.strategy);
  assert.deepEqual(strategies.sort(), ["balanced", "bold", "conservative"]);
  assert.ok(
    !result.proposal.risks.some((risk) => risk.includes("三組不同顏色")),
    "這三個方案改的維度不同，不該被誤判",
  );
  // 強度要是一條光譜
  const dims = (strategy: string) =>
    new Set(
      result.proposal.alternatives
        .find((alternative) => alternative.strategy === strategy)!
        .changes.map((change) => change.dimension),
    ).size;
  assert.ok(dims("bold") > dims("conservative"), "大膽方案碰的維度應該多於保守方案");
});

test("多樣性檢查：逐條反例", () => {
  const alt = (strategy: DesignAlternative["strategy"], dims: string[]): DesignAlternative => ({
    id: `alt-${strategy}`,
    name: strategy,
    strategy,
    changes: dims.map((dimension) => ({
      dimension: dimension as DesignAlternative["changes"][number]["dimension"],
      target: "t",
      change: "c",
      reason: "r",
    })),
    designTokens: [],
    preview: null,
    advantages: [],
    tradeoffs: [],
  });

  // 三個方案維度集合完全一樣 → 退
  assert.ok(
    validateAlternativeDiversity([
      alt("conservative", ["color"]),
      alt("balanced", ["color"]),
      alt("bold", ["color"]),
    ]).some((problem) => problem.includes("三組不同顏色")),
  );

  // 強度倒過來（大膽比平衡碰得少）→ 退
  assert.ok(
    validateAlternativeDiversity([
      alt("balanced", ["color", "layout", "typography"]),
      alt("bold", ["color"]),
    ]).some((problem) => problem.includes("大膽方案")),
  );

  // 沒有改動的方案 → 退
  assert.ok(
    validateAlternativeDiversity([alt("conservative", []), alt("bold", ["color", "layout"])]).some(
      (problem) => problem.includes("沒有任何具體改動"),
    ),
  );

  // 真的不同 → 過
  assert.deepEqual(
    validateAlternativeDiversity([
      alt("conservative", ["color"]),
      alt("balanced", ["color", "layout"]),
      alt("bold", ["imagery", "layout", "typography", "copy"]),
    ]),
    [],
  );

  // 只有一個方案時這條規則不適用
  assert.deepEqual(validateAlternativeDiversity([alt("conservative", ["color"])]), []);
});

// ---------------------------------------------------------------------------
// 取消
// ---------------------------------------------------------------------------

test("取消會真的停下來，而不是跑完才丟掉結果", async () => {
  const controller = new AbortController();
  const provider = createMockProvider({ behaviour: { kind: "hangs" } });
  const pending = analyzeDesign(input(), deps({ providers: [provider], signal: controller.signal }));
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof AnalysisCancelledError);
});

test("一開始就已取消時不會做任何工作", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const provider = createMockProvider();
  const spied = { ...provider, analyze: async (...args: Parameters<typeof provider.analyze>) => {
    called = true;
    return provider.analyze(...args);
  } };
  await assert.rejects(
    analyzeDesign(input(), deps({ providers: [spied], signal: controller.signal })),
    (error: unknown) => error instanceof AnalysisCancelledError,
  );
  assert.equal(called, false, "已取消還去呼叫 provider 等於白花錢");
});

// ---------------------------------------------------------------------------
// 紅線：不得跳過人類確認
// ---------------------------------------------------------------------------

test("分析永遠不會產生已套用的提案，也不會產生套用計畫", async () => {
  for (const mode of ["diagnose", "improve", "redesign", "extract"] as const) {
    const result = await analyzeDesign(
      input({ mode }),
      deps({ providers: [createMockProvider()] }),
    );
    assert.ok(
      ["ready", "needs-context"].includes(result.proposal.status),
      `${mode} 產生了 ${result.proposal.status} —— 分析階段只能到 ready`,
    );
    assert.equal(result.proposal.patch, null, "套用計畫必須等人類確認後才產生");
    assert.equal(result.proposal.appliedAt, null);
    assert.equal(result.proposal.approvedBy, null);
  }
});

test("diagnose 模式不產生方案，也不需要任何 AI", async () => {
  const result = await analyzeDesign(input({ mode: "diagnose" }), deps({ providers: [] }));
  assert.equal(result.proposal.alternatives.length, 0, "只診斷就不該給方案");
  assert.ok(result.proposal.diagnostics.length >= 3);
  assert.deepEqual(result.gaps, [], "diagnose 不需要 AI，就不該回報能力缺口");
});

// ---------------------------------------------------------------------------
// 沒有資料時
// ---------------------------------------------------------------------------

test("完全沒有可量測資料時說 needs-context，不硬生出診斷", async () => {
  const result = await analyzeDesign(
    input({ facts: { colors: [], textBlocks: [], tapTargets: [] } }),
    deps({ providers: [] }),
  );
  assert.equal(result.proposal.status, "needs-context");
  assert.equal(result.proposal.diagnostics.length, 0);
  assert.equal(result.proposal.confidence, 0);
  assert.ok(
    result.proposal.risks.some((risk) => risk.includes("需要作品的色碼")),
    "要說清楚缺什麼才能繼續",
  );
});

// ---------------------------------------------------------------------------
// 知識衝突
// ---------------------------------------------------------------------------

test("設計規範互相矛盾時提出來給人選，不自己挑一邊", async () => {
  const base = (id: string, rule: string, hash: string): KnowledgeEntry => ({
    id,
    category: "typography",
    title: `行高 ${rule}`,
    summary: `內文行高 ${rule}`,
    rules: [`行高 ${rule}`],
    exceptions: [],
    applicableContexts: ["print", "poster"],
    sourceUrl: null,
    sourceTitle: null,
    sourceType: "unknown",
    publisher: null,
    retrievedAt: null,
    reviewedAt: null,
    version: 1,
    trustLevel: "approved",
    projectSpecific: null,
    status: "approved",
    contentHash: hash,
  });

  const result = await analyzeDesign(
    input({ knowledge: [base("a", "1.5", "h-a"), base("b", "1.2", "h-b")] }),
    deps({ providers: [] }),
  );
  assert.ok(
    result.proposal.risks.some((risk) => risk.includes("矛盾")),
    "矛盾的規範必須被指出來讓人決定",
  );
  assert.ok(
    result.proposal.risks.some((risk) => risk.includes("不會替你選")),
    "而且要明說系統不會替使用者選",
  );
});

// ---------------------------------------------------------------------------
// 來源決定可信度：模型不能靠偽造欄位把自己的話包裝成「量出來的」
// ---------------------------------------------------------------------------

test("模型偽造 measured / id 前綴都無法混進保守方案", async () => {
  // 這條對應一個我自己寫出來的洞：保守方案原本用 confidence >= 0.8 過濾，
  // 而 confidence 由模型給；維度原本用 id 字串前綴推，而 id 也由模型給。
  // 模型只要回一條「信心 0.95、id 以 tap- 開頭、measured: true」的憑空建議，
  // 就會混進一個叫「只修可量測的問題」的方案裡，讓那個名字變成謊言。
  const forger = createMockProvider({
    behaviour: { kind: "ok" },
  });
  const lying = {
    ...forger,
    analyze: async () => ({
      provider: "mock" as const,
      model: null,
      satisfied: [],
      gaps: [],
      usage: { inputTokens: null, outputTokens: null },
      raw: {
        diagnostics: [
          {
            id: "tap-cta",              // 想偽造成本地觸控診斷，並撞掉真的那條
            measured: true,             // 想自稱是量出來的
            dimension: "interaction",
            location: "報名按鈕",
            issue: "感覺不夠有吸引力",
            impact: "轉換率可能下降",
            evidence: "根據一般設計經驗",
            recommendation: "把按鈕改成更醒目的樣式",
            severity: "major",
            confidence: 0.95,
          },
        ],
        alternatives: [],
      },
    }),
  };

  const result = await analyzeDesign(input(), deps({ providers: [lying] }));

  const forged = result.proposal.diagnostics.find(
    (diagnostic) => diagnostic.issue === "感覺不夠有吸引力",
  );
  assert.ok(forged, "這條診斷格式合法，應該被收下");
  assert.equal(forged.measured, false, "模型自稱 measured 沒有用，來源才算數");
  assert.ok(forged.id.startsWith("ai-"), `模型的 id 必須被加上命名空間，實得 ${forged.id}`);

  // 而且它不能撞掉本地那條真的觸控診斷
  const localTap = result.proposal.diagnostics.find((diagnostic) => diagnostic.id === "local-tap-cta");
  assert.ok(localTap, "本地的觸控診斷必須還在，沒有被模型的 id 蓋掉");
  assert.equal(localTap.measured, true);

  // 保守方案只收量出來的
  const conservative = result.proposal.alternatives.find(
    (alternative) => alternative.strategy === "conservative",
  );
  if (conservative) {
    assert.ok(
      !conservative.changes.some((change) => change.reason === "根據一般設計經驗"),
      "「只修可量測的問題」裡出現了沒量過的建議，那個名字就變成謊言",
    );
  }
});

test("診斷 id 由內容決定，同一份作品分析兩次得到相同的 id", async () => {
  // 模組級遞增計數器會讓兩次分析拿到不同 id，前後版本就無法比對。
  const first = await analyzeDesign(input(), deps({ providers: [] }));
  const second = await analyzeDesign(input(), deps({ providers: [] }));
  assert.deepEqual(
    first.proposal.diagnostics.map((diagnostic) => diagnostic.id),
    second.proposal.diagnostics.map((diagnostic) => diagnostic.id),
    "同樣的輸入必須得到同樣的診斷 id，否則無法比對兩次分析",
  );
  assert.ok(
    first.proposal.diagnostics.every((diagnostic) => !/\d+$/.test(diagnostic.id.replace(/^local-[a-z-]+-/, "x"))),
    "id 不該包含全域遞增的序號",
  );
});
