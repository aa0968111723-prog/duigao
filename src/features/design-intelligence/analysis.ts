/**
 * Design Intelligence — 分析流程（PR-DI-02）
 *
 * 任務書第十一節的流程，逐步落地：
 *   取得授權脈絡 → 判斷作品類型 → 讀品牌規則 → 本地知識分析 →
 *   （必要時外部研究，PR-DI-03）→ 診斷 → 最多三個方案 → 預覽 → **人類確認**
 *
 * 這個檔案**永遠不會**把提案推到 `applied`。它最多產出 `ready`。
 * 任務書寫得很明白：「不得直接：使用者一句話 → AI 覆蓋原稿」。
 *
 * 兩條貫穿整份實作的原則：
 *
 * 1. **沒有 AI 也要有用**。本地分析器算得出真實數字（對比、尺寸、行長），
 *    provider 掛掉或沒設定時那些診斷照樣送出去，只是把「AI 沒跑成」寫進
 *    風險欄位。graceful degradation 不是空殼，是保留真的算得出來的那一半。
 *
 * 2. **算不出來的不編**。沒有 provider 時只給一個**保守方案**，而且它的每一條
 *    改動都對應到一條診斷。「平衡重設計」與「大膽創意」需要創意判斷 ——
 *    用規則硬湊出來的三個方案就是任務書禁止的「三組不同顏色」。
 */
import { runLocalAnalyzers, type DesignFacts } from "./analyzers";
import { retrieveKnowledge } from "./retrieval";
import { parseAlternatives, parseDiagnostics } from "./schema";
import {
  selectProvider,
  type Capability,
  type CapabilityGap,
  type DesignAnalysisProvider,
} from "./providers";
import type {
  AlternativeStrategy,
  ChangeDimension,
  DesignAlternative,
  DesignMode,
  DesignProposal,
  DesignTargetType,
  Diagnostic,
  KnowledgeEntry,
} from "./types";

/** 使用者主動取消。呼叫端就是按下取消的那一方，所以用例外讓它自己處理。 */
export class AnalysisCancelledError extends Error {
  constructor() {
    super("analysis-cancelled");
    this.name = "AnalysisCancelledError";
  }
}

export type AnalysisInput = {
  roomId: string;
  projectId: string | null;
  targetType: DesignTargetType;
  targetId: string | null;
  mode: DesignMode;
  /** 使用者的原話。不改寫。 */
  goal: string;
  createdBy: string;
  /** 可量測的事實。由各 adapter 從實際作品抽出來。 */
  facts: DesignFacts;
  /** 可用的知識條目（已經過 RLS 過濾）。 */
  knowledge: readonly KnowledgeEntry[];
  /** 這次分析看了什麼（給人看的摘要，不是完整內容）。 */
  contextSummary: string;
};

export type AnalysisDeps = {
  providers?: readonly DesignAnalysisProvider[];
  /** 注入時間與 id，讓整條流程是可測的純函式。 */
  now: () => number;
  newId: (prefix: string) => string;
  signal?: AbortSignal;
};

export type AnalysisOutcome = {
  proposal: DesignProposal;
  /** 這次做不到什麼。UI 要顯示，不能默默吞掉。 */
  gaps: CapabilityGap[];
  /** 模型輸出被退掉的部分與理由。 */
  rejected: string[];
  /** 引用到的知識條目 id（提案要能說出依據）。 */
  knowledgeUsed: string[];
};

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AnalysisCancelledError();
}

/** 各模式需要的能力。diagnose 完全不需要 AI —— 本地分析器就夠。 */
function capabilitiesFor(mode: DesignMode): Capability[] {
  switch (mode) {
    case "diagnose":
      return [];
    case "extract":
      return ["structured-output"];
    case "improve":
      return ["structured-output", "layout-analysis"];
    case "redesign":
      return ["structured-output", "layout-analysis", "color-analysis"];
  }
}

/**
 * 從診斷產生**保守方案**。
 *
 * 每一條改動都直接來自一條診斷的 `recommendation`，所以它的每一句話都有
 * 出處。這是唯一一個不需要 AI 也敢給的方案。
 */
function conservativeAlternative(
  diagnostics: readonly Diagnostic[],
  newId: (prefix: string) => string,
): DesignAlternative | null {
  const changes = diagnostics
    .filter((diagnostic) => diagnostic.confidence >= 0.8)
    .map((diagnostic) => ({
      dimension: dimensionOf(diagnostic),
      target: diagnostic.location,
      change: diagnostic.recommendation,
      reason: diagnostic.evidence,
    }));
  if (!changes.length) return null;
  return {
    id: newId("alt"),
    name: "只修可量測的問題",
    strategy: "conservative",
    changes,
    designTokens: [],
    preview: null,
    advantages: [
      "每一項都對應一個量得出來的問題，改完可以再量一次驗證",
      "不動視覺風格，不需要重新對齊品牌",
    ],
    tradeoffs: ["只解決合規與可讀性，不會讓作品變得更有記憶點"],
  };
}

/** 從診斷 id 的前綴推回它屬於哪個維度。 */
function dimensionOf(diagnostic: Diagnostic): ChangeDimension {
  if (diagnostic.id.startsWith("contrast")) return "color";
  if (diagnostic.id.startsWith("tap")) return "interaction";
  if (diagnostic.id.startsWith("measure") || diagnostic.id.startsWith("leading")) return "layout";
  if (diagnostic.id.startsWith("mobile-type")) return "typography";
  return "structure";
}

/**
 * 三個方案「真的不同」的可檢查定義。
 *
 * 任務書：「三個方案必須真的不同（不能只是三組不同顏色）」。人眼判斷無法
 * 驗證，所以定義成：
 *   a. 每個方案至少要有一項改動。
 *   b. 三個方案碰到的**維度集合**不能完全一樣。
 *   c. 所有方案加起來至少碰到兩個維度。
 *   d. 大膽方案碰的維度不能少於平衡方案，平衡不能少於保守 ——
 *      三個方向要是一條光譜，不是三個隨機點。
 *
 * 回傳被退掉的理由；空陣列代表通過。
 */
export function validateAlternativeDiversity(alternatives: readonly DesignAlternative[]): string[] {
  const problems: string[] = [];
  if (alternatives.length < 2) return problems; // 只有一個方案時這條規則不適用

  const dims = new Map<AlternativeStrategy, Set<ChangeDimension>>();
  for (const alternative of alternatives) {
    if (!alternative.changes.length) {
      problems.push(`「${alternative.name}」沒有任何具體改動`);
      continue;
    }
    dims.set(alternative.strategy, new Set(alternative.changes.map((change) => change.dimension)));
  }

  const signatures = [...dims.values()].map((set) => [...set].sort().join(","));
  if (signatures.length > 1 && new Set(signatures).size === 1) {
    problems.push(
      `三個方案改的都是同一組維度（${signatures[0]}）—— 這就是「三組不同顏色」，不是三個方向`,
    );
  }

  const union = new Set([...dims.values()].flatMap((set) => [...set]));
  if (union.size < 2) {
    problems.push(`所有方案加起來只碰到 ${union.size} 個維度，稱不上三個方向`);
  }

  const size = (strategy: AlternativeStrategy) => dims.get(strategy)?.size ?? 0;
  if (dims.has("bold") && dims.has("balanced") && size("bold") < size("balanced")) {
    problems.push("大膽方案改動的維度比平衡方案還少，方向的強度標錯了");
  }
  if (dims.has("balanced") && dims.has("conservative") && size("balanced") < size("conservative")) {
    problems.push("平衡方案改動的維度比保守方案還少，方向的強度標錯了");
  }
  return problems;
}

/**
 * 跑一次設計分析。
 *
 * **不會**產生 `approved` 以後的任何狀態。套用是另一條路徑，而且要人類按下去。
 */
export async function analyzeDesign(
  input: AnalysisInput,
  deps: AnalysisDeps,
): Promise<AnalysisOutcome> {
  const { signal, now, newId } = deps;
  const rejected: string[] = [];
  const risks: string[] = [];

  checkCancelled(signal);

  // 1. 讀知識（專案規範優先），只帶進與這次提問相關的
  const retrieval = retrieveKnowledge(input.knowledge, {
    goal: input.goal,
    targetType: input.targetType,
    projectId: input.projectId,
  });
  if (retrieval.conflicts.length) {
    risks.push(
      `有 ${retrieval.conflicts.length} 組互相矛盾的設計規範，系統不會替你選 —— 請先確認要遵循哪一邊`,
    );
  }

  checkCancelled(signal);

  // 2. 本地分析。**不需要任何 provider**，所以先跑，跑完就已經有價值。
  const localDiagnostics = runLocalAnalyzers(input.facts);

  checkCancelled(signal);

  // 3. 需要 AI 的部分
  const needs = capabilitiesFor(input.mode);
  let gaps: CapabilityGap[] = [];
  let modelDiagnostics: Diagnostic[] = [];
  let alternatives: DesignAlternative[] = [];
  let usedProvider: string | null = null;

  if (needs.length) {
    const selection = await selectProvider(deps.providers ?? [], needs);
    gaps = selection.gaps;
    if (!selection.provider) {
      risks.push("目前沒有可用的 AI 分析服務，以下只有本地量測得出的結果");
    } else {
      usedProvider = selection.provider.id;
      try {
        const response = await selection.provider.analyze({
          needs,
          goal: input.goal,
          context: {
            targetType: input.targetType,
            contextSummary: input.contextSummary,
            facts: input.facts,
            knowledge: retrieval.hits.map((hit) => ({
              id: hit.entry.id,
              title: hit.entry.title,
              rules: hit.entry.rules,
              trustLevel: hit.entry.trustLevel,
            })),
            localDiagnostics,
          },
          signal,
        });
        gaps = [...gaps, ...response.gaps];

        // 模型輸出一律過驗證。沒過的丟掉並記錄理由 ——
        // 「AI 回了 5 條，3 條格式不符已略過」是使用者有權知道的事。
        const raw = (response.raw ?? {}) as Record<string, unknown>;
        const parsedDiagnostics = parseDiagnostics(raw.diagnostics);
        modelDiagnostics = parsedDiagnostics.value;
        rejected.push(...parsedDiagnostics.rejected);

        if (input.mode !== "diagnose") {
          const parsedAlternatives = parseAlternatives(raw.alternatives);
          alternatives = parsedAlternatives.value;
          rejected.push(...parsedAlternatives.rejected);
        }
      } catch (error) {
        if (error instanceof AnalysisCancelledError) throw error;
        if (signal?.aborted) throw new AnalysisCancelledError();
        // provider 掛掉不該讓本地算出來的真實診斷跟著消失
        risks.push(
          `AI 分析沒有完成（${selection.provider.id}：${error instanceof Error ? error.message : "未知錯誤"}），以下只有本地量測得出的結果`,
        );
      }
    }
  }

  checkCancelled(signal);

  // 4. 合併診斷。本地的排前面 —— 它們的 confidence 是 1，因為是算出來的。
  const diagnostics = [...localDiagnostics, ...modelDiagnostics];

  // 5. 方案。沒有模型方案時只給保守方案，並說清楚為什麼只有一個。
  if (input.mode !== "diagnose" && !alternatives.length) {
    const conservative = conservativeAlternative(diagnostics, newId);
    if (conservative) {
      alternatives = [conservative];
      risks.push(
        "只提供了一個保守方案：平衡重設計與大膽創意需要創意判斷，用規則硬湊出來的方向沒有意義",
      );
    }
  } else if (alternatives.length) {
    const diversityProblems = validateAlternativeDiversity(alternatives);
    if (diversityProblems.length) {
      rejected.push(...diversityProblems);
      // 不是全丟掉 —— 保留方案但把問題寫進風險，讓人自己判斷
      risks.push(...diversityProblems);
    }
  }

  // 6. 狀態
  const hasSomethingToSay = diagnostics.length > 0 || alternatives.length > 0;
  const status: DesignProposal["status"] = hasSomethingToSay ? "ready" : "needs-context";
  if (!hasSomethingToSay) {
    risks.push(
      "沒有取得足以分析的資料：需要作品的色碼、字級或可點擊元素尺寸其中之一",
    );
  }

  // 信心值：本地量測是 1，但整體信心要被「AI 沒跑成」拉低，否則
  // 使用者會以為這是完整的分析。
  const modelRan = usedProvider !== null && modelDiagnostics.length > 0;
  const confidence = !hasSomethingToSay ? 0 : modelRan ? 0.85 : 0.6;

  const proposal: DesignProposal = {
    id: newId("proposal"),
    roomId: input.roomId,
    projectId: input.projectId,
    artifactId: null,
    targetType: input.targetType,
    targetId: input.targetId,
    mode: input.mode,
    goal: input.goal,
    contextSummary: input.contextSummary,
    diagnostics,
    alternatives,
    recommendedAlternativeId: alternatives[0]?.id ?? null,
    preview: null,
    patch: null, // 套用計畫由 adapter 產生，而且要人類確認後才會有
    rationale: buildRationale(diagnostics, alternatives, usedProvider),
    sources: [], // 外部研究是 PR-DI-03
    risks,
    confidence,
    status,
    createdBy: input.createdBy,
    createdAt: now(),
    approvedBy: null,
    approvedAt: null,
    appliedAt: null,
    revertedAt: null,
    baseRevision: null,
    resultRevision: null,
  };

  return {
    proposal,
    gaps,
    rejected,
    knowledgeUsed: retrieval.hits.map((hit) => hit.entry.id),
  };
}

function buildRationale(
  diagnostics: readonly Diagnostic[],
  alternatives: readonly DesignAlternative[],
  provider: string | null,
): string {
  if (!diagnostics.length && !alternatives.length) {
    return "沒有取得足以分析的資料，因此沒有提出任何判斷。";
  }
  const measured = diagnostics.filter((diagnostic) => diagnostic.confidence >= 0.99).length;
  const parts = [`共 ${diagnostics.length} 條診斷，其中 ${measured} 條是直接量測出來的數值。`];
  if (provider) parts.push(`AI 分析由 ${provider} 提供。`);
  else parts.push("本次未使用 AI 分析，全部來自本地量測。");
  if (alternatives.length) parts.push(`提出 ${alternatives.length} 個方向，尚待你確認後才會套用。`);
  return parts.join("");
}
