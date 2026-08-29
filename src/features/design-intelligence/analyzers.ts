/**
 * Design Intelligence — 本地分析器（PR-DI-02）
 *
 * 這一層**完全不需要 AI**。它算的是可以量測的事實：對比值、觸控目標尺寸、
 * 行長、字級。所以：
 *
 *  - 沒有設定任何 AI provider 時，功能仍然有用（任務書第十九節的降級要求）。
 *  - 它產出的診斷帶著真的數字，不會是「配色可以更好」這種空話
 *    （任務書第十三節明文禁止）。
 *  - 建議是**算出來的**，不是模型猜的：對比不足時，這裡會算出一個真的達到
 *    4.5:1 的色碼，並在測試裡驗證那個色碼確實達標。
 *
 * 這一層的每一條診斷都必須能回答「憑什麼這樣說」——`evidence` 欄位放的是
 * 量測值，不是修辭。
 */
import { contrastRatio, parseHex, relativeLuminance, wcagLevel } from "./schema";
import type { ColorToken, Diagnostic, Severity } from "./types";

/** 分析器看得到的「作品長什麼樣」。刻意只放**可量測**的東西。 */
export type DesignFacts = {
  colors: ColorToken[];
  /** 文字區塊：字級（px）、行高倍數、每行字元數、是否為主要標題。 */
  textBlocks: Array<{
    id: string;
    label: string;
    fontSizePx: number;
    lineHeight: number;
    charsPerLine: number;
    isHeading: boolean;
    /**
     * 字重。WCAG 的「大字」定義是 **18pt（≈24px）任何字重**，或
     * **14pt（≈18.66px）且粗體**。舊版拿 `isHeading` 當粗體的代理，
     * 於是 19px 的非粗體標題被當成大字用 3:1 門檻 —— 實際上它要 4.5:1
     * （對抗審查實測到的）。標題不等於粗體，所以字重要獨立給。
     * 沒給時視為 400（一般字重），也就是走比較嚴的門檻。
     */
    fontWeight?: number;
    /** 這段文字用的色彩角色（對應 colors 裡的 role）。 */
    colorRole?: ColorToken["role"];
  }>;
  /** 可點擊目標：CSS 像素。 */
  tapTargets: Array<{ id: string; label: string; widthPx: number; heightPx: number }>;
  /** 這件作品預期在什麼尺寸被看到（最小的那個，通常是手機）。 */
  viewportWidthPx?: number;
};

/**
 * 診斷的 id 由**內容**決定，不用模組級遞增計數器。
 *
 * 遞增計數器有兩個問題：跨多次分析會累積（同一份作品分析兩次得到不同 id，
 * 前後版本無法比對），而且需要一個測試專用的 reset 函式 —— 那本身就是
 * 「這個設計很脆」的訊號。內容決定的 id 天生穩定且可比對。
 */
function diagnosticId(kind: string, subjectId: string): string {
  return `local-${kind}-${subjectId}`;
}

/**
 * 把一個色彩調到對指定底色達到目標對比，回傳達標的色碼。
 *
 * 做法：往「變暗」與「變亮」兩個方向各做一次二分搜尋，找出剛好達標的最小
 * 混合比例，再取**改動較小**的那一個 —— 使用者說「對比不夠」時想要的是最小
 * 可行的修正，不是把顏色整個換掉。
 *
 * 回傳 null 表示兩個方向都做不到（底色是中灰時會發生），這時呼叫端必須說
 * 「需要換背景色」而不是給一個沒達標的色碼。
 */
export function adjustToContrast(hex: string, against: string, target: number): string | null {
  const base = parseHex(hex);
  const bg = parseHex(against);
  if (!base || !bg) return null;

  const toHex = (rgb: { r: number; g: number; b: number }) =>
    "#" +
    [rgb.r, rgb.g, rgb.b]
      .map((value) => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, "0"))
      .join("");

  const search = (toward: { r: number; g: number; b: number }): string | null => {
    let lo = 0;
    let hi = 1;
    let found: string | null = null;
    for (let i = 0; i < 24; i += 1) {
      const mid = (lo + hi) / 2;
      const candidate = toHex({
        r: base.r + (toward.r - base.r) * mid,
        g: base.g + (toward.g - base.g) * mid,
        b: base.b + (toward.b - base.b) * mid,
      });
      const ratio = contrastRatio(candidate, against);
      if (ratio !== null && ratio >= target) {
        found = candidate;
        hi = mid; // 達標了，往更小的改動再試
      } else {
        lo = mid;
      }
    }
    return found;
  };

  const darker = search({ r: 0, g: 0, b: 0 });
  const lighter = search({ r: 255, g: 255, b: 255 });
  if (!darker) return lighter;
  if (!lighter) return darker;

  const distance = (candidate: string) => {
    const rgb = parseHex(candidate);
    if (!rgb) return Number.POSITIVE_INFINITY;
    return (rgb.r - base.r) ** 2 + (rgb.g - base.g) ** 2 + (rgb.b - base.b) ** 2;
  };
  return distance(darker) <= distance(lighter) ? darker : lighter;
}

/**
 * WCAG 2.2 的「大字」門檻：18pt（≈24px）任何字重，或 14pt（≈18.66px）粗體。
 *
 * 粗體看的是**字重**，不是「這是不是標題」。19px 的非粗體標題不是大字，
 * 要 4.5:1。
 */
function contrastTargetFor(fontSizePx: number, fontWeight: number): number {
  const isBold = fontWeight >= 700;
  return fontSizePx >= 24 || (isBold && fontSizePx >= 18.66) ? 3 : 4.5;
}

function severityForContrast(actual: number, target: number): Severity {
  if (actual < target * 0.55) return "blocker";
  if (actual < target * 0.8) return "major";
  return "minor";
}

/**
 * 對比診斷。
 *
 * 找不到底色時**不猜** —— 產生一條「缺少資訊」的診斷，而不是假裝算過。
 * 這是任務書第十九節「不假裝分析過」的具體落點。
 */
export function analyzeContrast(facts: DesignFacts): Diagnostic[] {
  const byRole = new Map(facts.colors.map((token) => [token.role, token]));
  // 取**所有**可能的底色並算最差值，與 schema.ts 的 parseColorTokens 同一套
  // 規則。舊版用 `surface ?? background`，於是 background #ffffff +
  // surface #000000 + text #aaaaaa 只對黑色算出 9.04 而漏報 —— 那個字在白底
  // 上其實是 2.32（對抗審查實測到的，schema.ts 早就記錄過同一個反例）。
  const surfaces = (["background", "surface"] as const)
    .map((role) => byRole.get(role))
    .filter((token): token is NonNullable<typeof token> => Boolean(token));
  const diagnostics: Diagnostic[] = [];

  for (const block of facts.textBlocks) {
    const role = block.colorRole ?? "text-primary";
    const token = byRole.get(role);
    if (!token) {
      // 指定了色彩角色卻找不到對應色票 —— 沉默跳過會讓人以為「檢查過沒問題」。
      diagnostics.push({
        id: diagnosticId("contrast-missing", block.id),
        dimension: "color",
        measured: true,
        location: block.label,
        issue: `找不到「${role}」的色碼，無法計算對比`,
        impact: "這段文字有沒有讀得到，目前無法判斷",
        evidence: `色票裡沒有 ${role}；已宣告的角色：${[...byRole.keys()].join("、") || "（無）"}`,
        recommendation: `補上 ${role} 的色碼，或指定這段文字實際使用的色彩角色`,
        severity: "minor",
        confidence: 1,
      });
      continue;
    }

    if (!surfaces.length) {
      diagnostics.push({
        id: diagnosticId("contrast", block.id),
        dimension: "color",
        measured: true,
        location: block.label,
        issue: "沒有宣告背景色或表面色，無法計算對比",
        impact: "無法判斷這段文字在實際背景上讀不讀得到",
        evidence: `色票裡有 ${token.role}（${token.hex}），但沒有 background 也沒有 surface`,
        recommendation: "補上作品的背景色碼，或指定這段文字疊在哪個面上",
        severity: "minor",
        confidence: 1,
      });
      continue;
    }

    // 這一層不知道每個字實際疊在哪個面上（那要版面資訊），所以取最差情況。
    let worst: { hex: string; role: string; ratio: number } | null = null;
    for (const candidate of surfaces) {
      const ratio = contrastRatio(token.hex, candidate.hex);
      if (ratio === null) continue;
      if (!worst || ratio < worst.ratio) worst = { hex: candidate.hex, role: candidate.role, ratio };
    }
    if (!worst) continue;
    const surface = { hex: worst.hex, role: worst.role };
    const ratio = worst.ratio;
    const target = contrastTargetFor(block.fontSizePx, block.fontWeight ?? 400);
    if (ratio >= target) continue;

    const fixed = adjustToContrast(token.hex, surface.hex, target);
    const fixedRatio = fixed ? contrastRatio(fixed, surface.hex) : null;
    const thresholdNote = target === 3 ? "大字門檻 3:1" : "一般內文門檻 4.5:1";

    diagnostics.push({
      id: diagnosticId("contrast", block.id),
      dimension: "color",
      measured: true,
      location: block.label,
      issue: `文字與背景的對比只有 ${ratio.toFixed(2)}:1，低於${thresholdNote}`,
      impact: block.isHeading
        ? "標題在強光下或縮圖尺寸會讀不到，社群平台的縮圖尤其明顯"
        : "內文在手機上、光線強的環境、或視力較弱的人眼中會讀不清楚",
      evidence: `量測：${token.hex} 疊在最差的底色 ${surface.role}（${surface.hex}）上 = ${ratio.toFixed(2)}:1（字級 ${block.fontSizePx}px、字重 ${block.fontWeight ?? 400}，門檻 ${target}:1，目前等級 ${wcagLevel(ratio)}）`,
      recommendation:
        fixed && fixedRatio !== null
          ? `把 ${token.role} 從 ${token.hex} 改為 ${fixed}（疊在 ${surface.hex} 上是 ${fixedRatio.toFixed(2)}:1，達標）`
          : `${token.hex} 疊在 ${surface.hex} 上無論調亮或調暗都達不到 ${target}:1，必須改背景色`,
      severity: severityForContrast(ratio, target),
      confidence: 1, // 算出來的，不是估的
      knowledgeRefs: ["wcag-contrast-minimum"],
    });
  }
  return diagnostics;
}

/**
 * 觸控目標尺寸（WCAG 2.2 AA：24×24 CSS 像素）。
 *
 * 這條對這個產品特別重要 —— 它是行動優先的，桌機上點得到的東西手指點不到。
 */
export function analyzeTapTargets(facts: DesignFacts): Diagnostic[] {
  const MIN = 24;
  return facts.tapTargets
    .filter((target) => target.widthPx < MIN || target.heightPx < MIN)
    .map((target) => {
      const shortSide = Math.min(target.widthPx, target.heightPx);
      return {
        id: diagnosticId("tap", target.id),
        dimension: "interaction",
        measured: true,
        location: target.label,
        issue: `可點擊區域只有 ${target.widthPx}×${target.heightPx} CSS 像素，短邊低於 24`,
        impact: "手機上手指容易點不到或誤觸旁邊的元素，而行動裝置是主要使用情境",
        evidence: `量測：${target.widthPx}×${target.heightPx}，短邊 ${shortSide}，WCAG 2.2 AA 下限 24×24`,
        recommendation: `把「${target.label}」的點擊區域放大到至少 24×24（視覺大小可以不變，用 padding 或透明的擴大區達成）`,
        severity: shortSide < 16 ? "major" : "minor",
        confidence: 1,
        knowledgeRefs: ["wcag-target-size"],
      } satisfies Diagnostic;
    });
}

/**
 * 排版：行長與行高。兩者都可量測，所以給的是數字不是形容詞。
 */
export function analyzeTypography(facts: DesignFacts): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const block of facts.textBlocks) {
    if (block.isHeading) continue;

    if (block.charsPerLine > 75) {
      diagnostics.push({
        id: diagnosticId("measure", block.id),
        dimension: "layout",
        measured: true,
        location: block.label,
        issue: `每行 ${block.charsPerLine} 個字元，超過建議上限 75`,
        impact: "行太長時視線從行尾回到下一行的行首容易跳行，長段落會讀不下去",
        evidence: `量測：每行 ${block.charsPerLine} 字元（建議 45–75）`,
        recommendation: `限制文字容器寬度（例如 max-width: 65ch），或把字級從 ${block.fontSizePx}px 加大，讓每行字數自然變少`,
        severity: block.charsPerLine > 100 ? "major" : "minor",
        confidence: 1,
        knowledgeRefs: ["line-length-and-height"],
      });
    }

    if (block.lineHeight < 1.5) {
      diagnostics.push({
        id: diagnosticId("leading", block.id),
        dimension: "layout",
        measured: true,
        location: block.label,
        issue: `行高只有 ${block.lineHeight}，低於建議的 1.5`,
        impact: "行與行擠在一起，閱讀障礙與低視力的人尤其難以逐行掃讀",
        evidence: `量測：line-height ${block.lineHeight}（WCAG 建議內文 ≥ 1.5）`,
        recommendation: `把「${block.label}」的 line-height 從 ${block.lineHeight} 改為 1.5（${block.fontSizePx}px 字級約等於 ${Math.round(block.fontSizePx * 1.5)}px）`,
        severity: block.lineHeight < 1.2 ? "major" : "minor",
        confidence: 1,
        knowledgeRefs: ["line-length-and-height"],
      });
    }
  }
  return diagnostics;
}

/**
 * 行動裝置字級。
 *
 * 小於 14px 的內文在手機上實測難讀；iOS Safari 更會在 <16px 的輸入框上自動
 * 放大整個頁面 —— 那是使用者感受得到的破版，不只是「有點小」。
 */
export function analyzeMobileLegibility(facts: DesignFacts): Diagnostic[] {
  const width = facts.viewportWidthPx ?? 360;
  if (width > 480) return [];
  return facts.textBlocks
    .filter((block) => !block.isHeading && block.fontSizePx < 14)
    .map(
      (block) =>
        ({
          id: diagnosticId("mobile-type", block.id),
          dimension: "typography",
          measured: true,
          location: block.label,
          issue: `內文字級 ${block.fontSizePx}px，在 ${width}px 寬的螢幕上偏小`,
          impact: "手機上要放大才讀得到；放大之後版面會左右捲動，整個體驗會垮掉",
          evidence: `量測：${block.fontSizePx}px @ ${width}px 視窗（行動內文建議 ≥ 14px；輸入框 ≥ 16px，否則 iOS Safari 會自動縮放）`,
          recommendation: `把「${block.label}」的字級從 ${block.fontSizePx}px 提高到 16px`,
          severity: block.fontSizePx < 12 ? "major" : "minor",
          confidence: 1,
          knowledgeRefs: ["mobile-legibility"],
        }) satisfies Diagnostic,
    );
}

/** 跑完所有本地分析器。**不需要任何 AI provider。** */
export function runLocalAnalyzers(facts: DesignFacts): Diagnostic[] {
  return [
    ...analyzeContrast(facts),
    ...analyzeTapTargets(facts),
    ...analyzeTypography(facts),
    ...analyzeMobileLegibility(facts),
  ];
}

/** 亮度（給呼叫端排序色票用，避免各處重複實作）。 */
export function luminanceOf(hex: string): number | null {
  const rgb = parseHex(hex);
  return rgb ? relativeLuminance(rgb) : null;
}
