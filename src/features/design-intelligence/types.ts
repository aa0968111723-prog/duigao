/**
 * Design Intelligence — domain model（PR-DI-00）
 *
 * 設計原則：
 *
 * 1. **provider-neutral**：這一層不知道 Perplexity、tku-zen-agent 或任何模型
 *    的存在。換 provider 不該動到這裡。
 * 2. **與既有 AiProposal 並存，不取代**：`src/ai/proposals.ts` 的四值 union
 *    是「房間層的一鍵動作」，繼續由它負責；本層處理的是「設計診斷 → 多方案
 *    → 預覽 → 套用 → 可復原」這條更長的流程。兩者最終都落在既有的節點／
 *    討論／企劃管線上。
 * 3. **信任分級是型別的一部分**：外部搜尋來的東西與房內證據**不能是同一個型別**。
 *    基線稽核（BASELINE_AUDIT §5）指出既有 `SafeAsset[]` 是同質陣列，外部文字
 *    一旦混進去就享有同等地位 —— 這是引入外部搜尋最大的結構缺口，所以在這裡
 *    就用型別把它分開。
 */

// ---------------------------------------------------------------------------
// 作品類型與模式
// ---------------------------------------------------------------------------

/** 本層能分析的作品類型（對應任務書的四種模式）。 */
export const DESIGN_TARGET_TYPES = [
  "poster", // 文宣：海報、社群貼文
  "video", // 影片：腳本、分鏡
  "plan", // 企劃：目標、受眾、策略
  "website", // 網站：截圖或 DOM
  "board", // 白板：節點群的整理
] as const;
export type DesignTargetType = (typeof DESIGN_TARGET_TYPES)[number];

/** 分析模式：使用者想要什麼程度的介入。 */
export const DESIGN_MODES = [
  "diagnose", // 只診斷，不改
  "improve", // 診斷 + 改善建議
  "redesign", // 提出方向
  "extract", // 抽出結構（色票／分鏡／企劃骨架）
] as const;
export type DesignMode = (typeof DESIGN_MODES)[number];

// ---------------------------------------------------------------------------
// 診斷
// ---------------------------------------------------------------------------

export const SEVERITIES = ["blocker", "major", "minor", "nit"] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * 一條診斷。
 *
 * 任務書第十三節禁止「可以調整配色」這種話，所以這個型別**強制**要求
 * location／impact／evidence／recommendation 四個欄位都有內容 ——
 * 驗證器會擋掉空字串（見 schema.ts）。
 */
export type Diagnostic = {
  id: string;
  /** 問題在哪裡：具體到元素、區域、時間點或段落。 */
  location: string;
  /** 問題是什麼。 */
  issue: string;
  /** 影響什麼（誰會看不懂／看不到／點不到）。 */
  impact: string;
  /** 憑什麼這樣說：量測值、對比值、尺寸、或引用的知識條目 id。 */
  evidence: string;
  /** 怎麼改：必須含具體數值或角色，不能只有形容詞。 */
  recommendation: string;
  severity: Severity;
  /** 0–1。低於 0.5 的診斷 UI 要標示「需要人確認」。 */
  confidence: number;
  /**
   * 這條診斷是**量出來的**（本地分析器算的）還是模型說的。
   *
   * 由來源決定，不由 payload 宣稱 —— `parseDiagnostics` 一律設成 false，
   * 模型自己填 `measured: true` 沒有用。這跟知識庫的 provenance 是同一個
   * 道理：讓不可信輸入自我認證，等於沒有認證。
   */
  measured: boolean;
  /** 這條診斷屬於哪個改動維度（保守方案要靠它分類，不能靠猜 id 前綴）。 */
  dimension?: ChangeDimension;
  /** 這條診斷引用了哪些知識條目（knowledge.id）。 */
  knowledgeRefs?: string[];
  /** 這條診斷引用了哪些外部來源（research source id）。 */
  sourceRefs?: string[];
};

// ---------------------------------------------------------------------------
// 色票（任務書第五節要求的完整輸出）
// ---------------------------------------------------------------------------

export const COLOR_ROLES = [
  "background",
  "surface",
  "text-primary",
  "text-secondary",
  "border",
  "primary-action",
  "success",
  "warning",
  "danger",
] as const;
export type ColorRole = (typeof COLOR_ROLES)[number];

export type ColorToken = {
  role: ColorRole;
  hex: string;
  rgb: { r: number; g: number; b: number };
  /** CSS 變數名，例如 `--di-surface`。 */
  cssToken: string;
  /** 與哪個角色比對出來的對比值（通常是 background 或 surface）。 */
  contrastAgainst?: ColorRole;
  /** WCAG 對比值。null＝這個角色不需要對比檢查（例如 border）。 */
  contrastRatio: number | null;
  /** 通過哪一級。none＝沒通過。 */
  wcag: "AAA" | "AA" | "AA-large" | "none" | "n/a";
};

// ---------------------------------------------------------------------------
// 方案
// ---------------------------------------------------------------------------

/** 三種方向（任務書第十四節）。 */
export const ALTERNATIVE_STRATEGIES = ["conservative", "balanced", "bold"] as const;
export type AlternativeStrategy = (typeof ALTERNATIVE_STRATEGIES)[number];

/**
 * 改動的維度。
 *
 * 存在的理由只有一個：任務書要求三個方案「必須真的不同，不能只是三組不同
 * 顏色」。「真的不同」如果只靠人眼判斷就無法驗證，所以把它變成可檢查的
 * 結構 —— 三個方案碰的維度集合不能完全一樣（見 `analysis.ts` 的
 * `validateAlternativeDiversity`）。
 */
export const CHANGE_DIMENSIONS = [
  "color",
  "typography",
  "layout",
  "imagery",
  "copy",
  "motion",
  "structure",
  "interaction",
] as const;
export type ChangeDimension = (typeof CHANGE_DIMENSIONS)[number];

export type DesignChange = {
  dimension: ChangeDimension;
  /** 改哪裡。 */
  target: string;
  /** 改成什麼（具體值）。 */
  change: string;
  /** 為什麼。 */
  reason: string;
};

export type DesignAlternative = {
  id: string;
  name: string;
  strategy: AlternativeStrategy;
  changes: DesignChange[];
  /** 這個方案產生的 design token（色票／字級）。 */
  designTokens: ColorToken[];
  /** 預覽的取得方式（見 DesignPreview）。 */
  preview: DesignPreview | null;
  advantages: string[];
  tradeoffs: string[];
};

/**
 * 預覽。
 *
 * **刻意不含任何影像 bytes**：既有的
 * `payloadCopiesOriginalMedia`（src/ai/proposals.ts:64）就是為了擋
 * 「AI 把原始媒體複製一份塞進 payload」，本層沿用同一紀律 —— 預覽只描述
 * 「要怎麼畫」，畫由 UI 端負責。
 */
export type DesignPreview =
  | { kind: "tokens"; tokens: ColorToken[] }
  | { kind: "outline"; sections: Array<{ label: string; note: string }> }
  | { kind: "storyboard"; shots: Array<{ order: number; shot: string; duration: number; caption?: string }> }
  | { kind: "board-nodes"; nodes: Array<{ nodeType: string; text: string; x: number; y: number }> }
  | { kind: "none"; reason: string };

// ---------------------------------------------------------------------------
// 提案（任務書第十二節）
// ---------------------------------------------------------------------------

export const DESIGN_PROPOSAL_STATUSES = [
  "draft",
  "analyzing",
  "ready",
  "needs-context",
  "approved",
  "rejected",
  "applying",
  "applied",
  "failed",
  "reverted",
] as const;
export type DesignProposalStatus = (typeof DESIGN_PROPOSAL_STATUSES)[number];

export type DesignProposal = {
  id: string;
  roomId: string;
  projectId: string | null;
  artifactId: string | null;
  targetType: DesignTargetType;
  targetId: string | null;
  mode: DesignMode;
  /** 使用者想達成什麼（原話）。 */
  goal: string;
  /** 這次分析看了什麼（給人看的摘要，不是完整內容）。 */
  contextSummary: string;
  diagnostics: Diagnostic[];
  alternatives: DesignAlternative[];
  recommendedAlternativeId: string | null;
  /** 整體預覽（通常等於推薦方案的預覽）。 */
  preview: DesignPreview | null;
  /**
   * 套用計畫。**與預覽分開**：預覽是給人看的，patch 是給機器執行的。
   * 型別留給各 adapter 自己定義（board/canva/cutos/website 各自不同），
   * 但一律要能被 adapter 驗證後才執行。
   */
  patch: DesignPatch | null;
  rationale: string;
  /** 外部來源（research）。房內證據不放這裡 —— 見 contextSummary。 */
  sources: ResearchSource[];
  risks: string[];
  confidence: number;
  status: DesignProposalStatus;
  createdBy: string;
  createdAt: number;
  approvedBy: string | null;
  approvedAt: number | null;
  appliedAt: number | null;
  revertedAt: number | null;
  /** 套用前的版本（可回去的那一版）。 */
  baseRevision: string | null;
  /** 套用後產生的版本。 */
  resultRevision: string | null;
};

/** 套用計畫：由哪個 adapter 執行、執行什麼。 */
export type DesignPatch = {
  adapter: "board" | "canva" | "cutos" | "planform-iso" | "website" | "none";
  /** adapter 專屬的 payload，由該 adapter 的 validate() 負責檢查。 */
  payload: Record<string, unknown>;
  /** 這個 patch 是否可逆，以及怎麼逆。 */
  reversible: boolean;
  revertHint: string;
};

// ---------------------------------------------------------------------------
// 外部研究（trust level 從型別層就分開）
// ---------------------------------------------------------------------------

export const SOURCE_TYPES = [
  "official-spec", // W3C／WHATWG／WCAG／平台官方規格
  "vendor-doc", // 廠商官方文件（MDN、Apple HIG、Material）
  "framework-doc", // 套件官方文件
  "article", // 一般文章
  "unknown",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export type ResearchSource = {
  id: string;
  url: string;
  title: string;
  publisher: string;
  sourceType: SourceType;
  /** 取得時間（毫秒）。過期判斷用。 */
  retrievedAt: number;
  /** 頁面上標示的發布或更新日期，沒有就是 null —— 不要用取得時間冒充。 */
  publishedAt: number | null;
  /** 摘錄（有長度上限，不存整頁）。 */
  excerpt: string;
};

/**
 * 研究結果。
 *
 * **注意 `answer` 是不可信文字**：它可能包含 prompt injection。
 * 任何消費端都必須把它當資料而不是指令 —— 型別名刻意不叫 `instruction`。
 */
export type ResearchResult = {
  requestId: string;
  query: string;
  answer: string;
  findings: string[];
  sources: ResearchSource[];
  retrievedAt: number;
  provider: string;
  model: string | null;
  confidence: number;
  /** 來源彼此矛盾時**不自行消除**，列在這裡交給人或規則決定。 */
  conflicts: Array<{ claim: string; sourceIds: string[]; note: string }>;
  usage: { inputTokens: number | null; outputTokens: number | null; requests: number };
  cost: { amount: number | null; currency: string | null; estimated: boolean };
  /**
   * 這次結果從哪裡來。四種狀態對使用者的意義完全不同：
   *   hit    = 用了快取，沒有花錢
   *   miss   = 真的問了一次
   *   dedup  = 有人正在問同一件事，共用那一次（也沒有多花錢）
   *   bypass = 根本沒問（沒設定、被擋下、斷路器開著）
   * 把 bypass 和 miss 混在一起，UI 就沒辦法分辨「查不到」與「沒設定」。
   */
  cacheStatus: "hit" | "miss" | "dedup" | "bypass";
};

// ---------------------------------------------------------------------------
// 設計知識（任務書第六節）
// ---------------------------------------------------------------------------

export const KNOWLEDGE_CATEGORIES = [
  "layout", "typography", "color", "branding", "accessibility",
  "mobile-ux", "tablet-ux", "web-ui", "print", "social-media",
  "video", "presentation", "marketing", "3d-space",
  "project-rules", "brand-rules",
] as const;
export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

export const KNOWLEDGE_STATUSES = [
  "draft",
  "machine-researched",
  "human-reviewed",
  "approved",
  "deprecated",
] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

/**
 * 信任等級。
 *
 * 規則（任務書第六節）：
 * - `project` > `approved` > 其他。
 * - Perplexity 搜尋結果**不能**直接是 `approved` —— 驗證器會擋
 *   `status === "machine-researched" && trustLevel === "approved"`。
 */
export const TRUST_LEVELS = ["project", "approved", "reviewed", "machine", "unverified"] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

export type KnowledgeEntry = {
  id: string;
  category: KnowledgeCategory;
  title: string;
  summary: string;
  /** 可執行的規則（每條要能對應到一個檢查或一個建議）。 */
  rules: string[];
  /** 例外情況 —— 沒有例外的規則通常是還沒想清楚。 */
  exceptions: string[];
  /** 什麼情境適用（例如 "poster"、"mobile"、"zh-Hant"）。 */
  applicableContexts: string[];
  sourceUrl: string | null;
  sourceTitle: string | null;
  sourceType: SourceType;
  publisher: string | null;
  retrievedAt: number | null;
  reviewedAt: number | null;
  version: number;
  trustLevel: TrustLevel;
  /** 屬於哪個專案的自有規範；null＝通用知識。 */
  projectSpecific: string | null;
  status: KnowledgeStatus;
  /** 內容雜湊：用來偵測同一份知識被重複匯入或悄悄改掉。 */
  contentHash: string;
};
